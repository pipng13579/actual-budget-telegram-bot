import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBotRuntime } from './bot.js';
import { SubmissionJournal } from './submission-journal.js';
import { mockActual } from './support/actual-mock.js';

function fixture(t, options = {}) {
  Object.assign(process.env, { TELEGRAM_BOT_TOKEN: '123:synthetic', USER1_TELEGRAM_ID: '1', USER2_TELEGRAM_ID: '2',
    ACTUAL_SERVER_URL: 'http://synthetic.invalid', ACTUAL_SERVER_PASSWORD: 'synthetic', FAMILY_GROUP_CHAT_ID: '-1',
    BUDGET_USER1_SYNC_ID: 'personal1', BUDGET_USER2_SYNC_ID: 'personal2', BUDGET_FAMILY_SYNC_ID: 'family',
    BUDGET_USER1_ACCOUNTS: 'cash:cash:Cash', BUDGET_USER1_DEFAULT_ACCOUNT: 'cash',
    BUDGET_USER2_ACCOUNTS: 'cash:cash:Cash', BUDGET_USER2_DEFAULT_ACCOUNT: 'cash',
    BUDGET_FAMILY_ACCOUNTS: 'cash:cash:Cash;bank:bank:Bank', BUDGET_FAMILY_DEFAULT_ACCOUNT: 'cash' });
  const directory = mkdtempSync(join(tmpdir(), 'telegram-handler-test-'));
  process.env.ACTUAL_DATA_DIR = directory;
  const journal = new SubmissionJournal(join(directory, 'journal'));
  const mock = mockActual(); const messages = []; const commands = [];
  const bot = Object.assign(new EventEmitter(), { options: { polling: { interval: 1000 } },
    getUpdates: async () => [], stopPolling: async () => {}, onText: (regex, handler) => commands.push({ regex, handler }),
    sendMessage: async (chat, text, options) => { messages.push({ chat, text, options }); },
  });
  const runtime = createBotRuntime({ bot, actualApi: mock.api, journal,
    rateLimitOptions: { now: () => 0, wait: async () => {}, warn: () => {} }, ...options });
  const dispatch = async (text, id, extra = {}) => {
    const msg = { chat: { id: 1, type: 'private' }, from: { id: 1 }, message_id: id, text, ...extra };
    const results = bot.listeners('message').map(fn => fn(msg));
    if (msg.photo) results.push(...bot.listeners('photo').map(fn => fn(msg)));
    for (const { regex, handler } of commands) if (text?.match(regex)) results.push(handler(msg, text.match(regex)));
    await Promise.all(results);
  };
  t.after(async () => { await runtime.shutdown('test'); rmSync(directory, { recursive: true, force: true }); });
  return { ...mock, runtime, messages, dispatch, bot, journal };
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('complete text immediately submits; duplicate Telegram update and reply timeout never duplicate', async t => {
  const f = fixture(t);
  await f.dispatch('lunch 7.11', 1);
  assert.equal(f.calls.writes, 1);
  assert.match(f.messages.at(-1).text, /OK Logged/);
  assert.doesNotMatch(f.messages.at(-1).text, /Draft/);
  await f.dispatch('lunch 7.11', 1);
  assert.equal(f.calls.writes, 1);
});

test('amount/category follow-up retains original identity and complete receipt needs no approval', async t => {
  const f = fixture(t, { downloadReceipt: async () => Buffer.from('synthetic'), parseReceipt: async () => ({
    amount: 7.11, category: 'Food & Drinks', description: 'hawker', needsAmount: false, needsCategory: false, ocrPreview: 'synthetic',
  }) });
  await f.dispatch('lunch', 1);
  assert.equal(f.calls.writes, 0);
  await f.dispatch('7.11', 2);
  assert.equal(f.calls.writes, 1);
  await f.dispatch('7.11', 2); // follow-up replay must not create a new conversation
  assert.equal(f.runtime.pendingExpenses.size, 0);
  await f.dispatch('lunch 7.11', 1);
  assert.equal(f.calls.writes, 1);
  await f.dispatch(undefined, 3, { photo: [{ file_id: 'synthetic' }] });
  assert.equal(f.calls.writes, 2);
});

test('a duplicate undo cannot delete a newer expense', async t => {
  const f = fixture(t);
  await f.dispatch('lunch 7.11', 1);
  await f.dispatch('/undo', 2);
  await f.dispatch('lunch 8.00', 3);
  await f.dispatch('/undo', 2);
  assert.equal(f.calls.deletes, 1);
  assert.equal([...f.rows.values()].filter(r => !r.tombstone).length, 1);
});

test('Telegram reply failure leaves a durable completed submission; replay only replies', async t => {
  const f = fixture(t); const send = f.bot.sendMessage;
  let fail = true;
  f.bot.sendMessage = async (...args) => {
    if (fail && /OK Logged/.test(args[1])) { fail = false; throw new Error('reply timed out'); }
    return send(...args);
  };
  await f.dispatch('lunch 7.11', 1);
  await f.dispatch('lunch 7.11', 1);
  assert.equal(f.calls.writes, 1);
  assert.match(f.messages.at(-1).text, /OK Logged/);
});

test('receipt reply failure never tells the user to resend an already written expense', async t => {
  const f = fixture(t, { downloadReceipt: async () => Buffer.from('synthetic'), parseReceipt: async () => ({
    amount: 7.11, category: 'Food & Drinks', description: 'hawker' }) });
  const send = f.bot.sendMessage; let failed = false;
  f.bot.sendMessage = async (...args) => {
    if (!failed && /OK Logged/.test(args[1])) { failed = true; throw new Error('reply timeout'); }
    return send(...args);
  };
  await f.dispatch(undefined, 1, { photo: [{ file_id: 'synthetic' }], date: Date.parse('2026-10-12T16:00:00Z') / 1000 });
  assert.equal(f.calls.writes, 1);
  assert.equal([...f.rows.values()][0].date, '2026-10-13');
  assert.ok(f.messages.every(m => !/Try again or type/.test(m.text)));
  assert.match(f.messages.at(-1).text, /OK Logged/);
});

for (const command of ['/cancel', '/reset', 'cancel', 'nvm']) {
  test(`${command} cancels only unfinished work; next complete expense submits`, async t => {
    const f = fixture(t);
    await f.dispatch('lunch', 1); await f.dispatch(command, 2);
    assert.equal(f.runtime.pendingExpenses.size, 0);
    await f.dispatch('lunch 7.11', 3);
    assert.equal(f.calls.writes, 1);
  });
}

test('redelivered cancellation cannot abandon a newer unfinished conversation', async t => {
  const f = fixture(t);
  await f.dispatch('lunch', 1); await f.dispatch('/cancel', 2);
  await f.dispatch('lunch', 3); await f.dispatch('/cancel', 2);
  assert.equal(f.runtime.pendingExpenses.size, 1);
  await f.dispatch('7.11', 4);
  assert.equal(f.calls.writes, 1);
});

test('cancel during receipt processing prevents stale state, prompt, and money write', async t => {
  const gate = deferred(); const entered = deferred();
  const f = fixture(t, { downloadReceipt: async () => Buffer.from('synthetic'), parseReceipt: async () => {
    entered.resolve(); await gate.promise;
    return { amount: 7.11, category: 'Food & Drinks', description: 'hawker' };
  } });
  const photo = f.dispatch(undefined, 1, { photo: [{ file_id: 'synthetic' }] });
  await entered.promise; await f.dispatch('cancel', 2); await f.dispatch('/cancel', 3);
  const afterCancel = f.messages.length; gate.resolve(); await photo;
  assert.equal(f.calls.writes, 0); assert.equal(f.runtime.pendingExpenses.size, 0);
  assert.equal(f.messages.length, afterCancel);
  await f.dispatch('lunch 7.11', 4); assert.equal(f.calls.writes, 1);
});

test('cancel while categories are delayed stops submission and queued follow-ups', async t => {
  const f = fixture(t); const gate = deferred(); const entered = deferred();
  const categories = f.api.getCategories;
  f.api.getCategories = async () => { entered.resolve(); await gate.promise; return categories(); };
  const expense = f.dispatch('lunch 7.11', 1); await entered.promise;
  const queued = f.dispatch('8.00', 2);
  await f.dispatch('/cancel', 3); gate.resolve();
  await Promise.all([expense, queued]);
  assert.equal(f.calls.writes, 0); assert.equal(f.runtime.pendingExpenses.size, 0);
  await f.dispatch('lunch 9.00', 4); assert.equal(f.calls.writes, 1);
});

test('cancel after commit boundary explicitly refuses to promise reversal', async t => {
  const f = fixture(t); const gate = deferred(); const entered = deferred(); const write = f.api.addTransactions;
  f.api.addTransactions = async (...args) => { const result = await write(...args); entered.resolve(); await gate.promise; return result; };
  const expense = f.dispatch('lunch 7.11', 1); await entered.promise;
  await f.dispatch('/cancel', 2);
  assert.match(f.messages.at(-1).text, /cannot guarantee reversal/);
  gate.resolve(); await expense; assert.equal(f.calls.writes, 1);
  assert.match(f.messages.at(-1).text, /OK Logged/);
});

test('failed budget switch does not leak execution across routes; later queue work recovers', async t => {
  const f = fixture(t); let active;
  f.api.downloadBudget = async id => { active = null; if (id === 'family') throw new Error('encryption failure'); active = id; };
  const write = f.api.addTransactions;
  f.api.addTransactions = (...args) => { assert.ok(['personal1', 'personal2'].includes(active)); return write(...args); };
  await Promise.all([
    f.dispatch('lunch 7.11', 1),
    f.dispatch('lunch 7.11', 2, { chat: { id: -1, type: 'group' } }),
    f.dispatch('lunch 7.11', 3, { chat: { id: 2, type: 'private' }, from: { id: 2 } }),
  ]);
  assert.equal(f.calls.writes, 2);
  assert.ok(f.messages.some(m => m.chat === '-1' && /Not added/.test(m.text)));
});
