import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { SubmissionJournal } from './submission-journal.js';
import { createSubmissionService, submissionId, outcomeText } from './submissions.js';

import { mockActual, request } from './support/actual-mock.js';

function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'telegram-journal-test-'));
  let journal = new SubmissionJournal(directory);
  const mock = mockActual();
  const events = [];
  const make = () => createSubmissionService({ api: mock.api, journal,
    withBudget: async (_key, fn) => fn({ categoryMap: { 'food & drinks': 'cat' } }),
    identityForBudget: () => 'config', log: e => events.push(e), ...options });
  let service = make();
  t.after(() => { journal.close(); rmSync(directory, { recursive: true, force: true }); });
  return { ...mock, directory, events, get journal() { return journal; }, get service() { return service; },
    restart() { journal.close(); journal = new SubmissionJournal(directory); service = make(); } };
}

test('distinct identical purchases, concurrent redelivery and restart are exactly identified', async t => {
  const f = fixture(t);
  const old = { id: 'unrelated', account: 'cash', amount: -711, category: 'cat', notes: 'old' };
  f.rows.set(old.id, old);
  const outcomes = await Promise.all([f.service.submit(request()), f.service.submit(request()), f.service.submit(request(2))]);
  assert.ok(outcomes.every(r => r.status === 'verified'));
  assert.equal(f.calls.writes, 2);
  assert.deepEqual(f.rows.get('unrelated'), old);
  f.restart();
  await f.service.submit(request());
  assert.equal(f.calls.writes, 2);
  assert.notEqual(outcomes[0].legs[0].id, outcomes[2].legs[0].id);
});

for (const value of [undefined, null, [], {}, { errors: ['error'] }, ['unexpected-id']]) {
  test(`invalid insertion result ${JSON.stringify(value)} never reports success or blindly retries`, async t => {
    const f = fixture(t); const write = f.api.addTransactions;
    f.api.addTransactions = async (...args) => { await write(...args); return value; };
    const result = await f.service.submit(request());
    assert.equal(result.status, 'uncertain');
    assert.match(outcomeText(result), /could not be confirmed/);
    const recovered = await f.service.submit(request());
    assert.equal(recovered.status, 'verified');
    assert.equal(f.calls.writes, 1);
  });
}

test('empty write, missing exact ID and field mismatch never substitute similar entries', async t => {
  const f = fixture(t);
  f.api.addTransactions = async () => { f.calls.writes++; return 'ok'; };
  let result = await f.service.submit(request());
  assert.equal(result.errorCode, 'ORIGIN_NOT_FOUND');
  await f.service.submit(request());
  assert.equal(f.calls.writes, 1);
  assert.equal(result.localConfirmed, false);
});

for (const [field, value] of [['account', 'other'], ['amount', -1], ['date', '2026-10-12'], ['category', 'other'], ['notes', 'changed'], ['payee', 'other']]) {
  test(`stored ${field} mismatch cannot succeed`, async t => {
    const f = fixture(t); const insert = f.api.addTransactions;
    f.api.addTransactions = async (...args) => { await insert(...args); [...f.rows.values()][0][field] = value; return 'ok'; };
    const result = await f.service.submit(request());
    assert.notEqual(result.status, 'verified');
    assert.equal(f.calls.syncs, 0);
  });
}

for (const stage of ['before-write', 'after-write', 'after-local', 'after-sync']) {
  test(`restart after injected crash at ${stage} cannot duplicate a write`, async t => {
    let armed = true;
    const f = fixture(t, { fault: async current => {
      if (armed && current === stage) { armed = false; throw Object.assign(new Error('crash'), { simulatedCrash: true }); }
    } });
    await assert.rejects(f.service.submit(request()), /crash/);
    f.restart();
    const recovered = await f.service.submit(request());
    assert.equal(f.calls.writes, stage === 'before-write' ? 0 : 1);
    assert.equal(recovered.status, stage === 'before-write' ? 'uncertain' : 'verified');
  });
}

test('restart of a durable prepared record uses its original date/account/payload', async t => {
  const f = fixture(t);
  const prepared = { ...request(), status: 'prepared', legs: [{ ...request().legs[0], id: 'prepared-id', origin: 'prepared-origin' }] };
  f.journal.put(prepared); f.restart();
  const result = await f.service.submit(request(1, { date: '2026-10-14', legs: [{ account: 'bank', amount: -999 }] }));
  assert.equal(result.status, 'verified');
  assert.equal(f.rows.get('prepared-id').date, '2026-10-13');
  assert.equal(f.rows.get('prepared-id').account, 'cash');
});

test('sync failure, recovery and post-sync verification have different truthful outcomes', async t => {
  const f = fixture(t); const sync = f.api.sync;
  f.api.sync = async () => { throw Object.assign(new Error('contains secret'), { code: 'ECONNRESET' }); };
  const local = await f.service.submit(request());
  assert.match(outcomeText(local), /Saved locally/);
  assert.ok(local.nextRetryAt);
  f.api.sync = sync;
  assert.equal((await f.service.submit(request())).status, 'verified');
  assert.equal(f.calls.writes, 1);
  f.api.sync = async () => { [...f.rows.values()].at(-1).notes = 'changed after sync'; };
  const failed = await f.service.submit(request(2));
  assert.match(outcomeText(failed), /Sync completed, but verification failed/);
  assert.doesNotMatch(JSON.stringify(f.events), /hawker|synthetic|contains secret|711/);
});

test('validation/open failure has no write and leaves the queue usable', async t => {
  const f = fixture(t);
  const bad = await f.service.submit(request(1, { date: '2026-02-30' }));
  assert.match(outcomeText(bad), /Not added/);
  assert.equal(f.calls.writes, 0);
  assert.equal((await f.service.submit(request(2))).status, 'verified');
});

test('undo protects provenance, external edits, reconciled entries, and repeated delivery', async t => {
  const f = fixture(t);
  const first = await f.service.submit(request());
  const id = first.legs[0].id;
  f.rows.get(id).notes = 'external edit';
  await f.service.undo(first.id, first.contextKey);
  assert.equal(f.calls.deletes, 0);
  f.rows.get(id).notes = 'synthetic';
  f.rows.get(id).reconciled = true;
  await f.service.undo(first.id, first.contextKey);
  assert.equal(f.calls.deletes, 0);
  f.rows.get(id).reconciled = false;
  assert.equal((await f.service.undo(first.id, first.contextKey)).status, 'undone');
  await f.service.undo(first.id, first.contextKey);
  f.restart(); await f.service.submit(request());
  assert.equal(f.calls.deletes, 1); assert.equal(f.calls.writes, 1);
  await assert.rejects(f.service.undo(first.id, 'another-user'), /UNDO_UNPROVEN/);
});

test('undo sync failure is durable and resumes without resurrecting or deleting twice', async t => {
  const f = fixture(t); const first = await f.service.submit(request());
  const sync = f.api.sync; f.api.sync = async () => { throw new Error('offline'); };
  assert.equal((await f.service.undo(first.id, first.contextKey)).status, 'undo_pending');
  f.restart(); f.api.sync = sync;
  assert.equal((await f.service.submit(request())).status, 'undone');
  assert.equal(f.calls.writes, 1); assert.equal(f.calls.deletes, 1);
});

test('transfer partial failure and restart never recreate a completed or ambiguous leg', async t => {
  const f = fixture(t); const write = f.api.addTransactions;
  f.api.addTransactions = async (...args) => { const result = await write(...args); if (f.calls.writes === 2) throw new Error('timeout after commit'); return result; };
  const transfer = request(1, { kind: 'transfer', legs: [request().legs[0], { ...request().legs[0], account: 'bank', amount: 711 }] });
  assert.equal((await f.service.submit(transfer)).status, 'uncertain');
  f.restart();
  assert.equal((await f.service.submit(transfer)).status, 'verified');
  assert.equal(f.calls.writes, 2);
});

test('single writer lock rejects a second writer', t => {
  const f = fixture(t);
  assert.throws(() => new SubmissionJournal(f.directory), /WRITER_LOCKED/);
});

test('corrupt journal fails closed instead of initializing an empty deduplication store', () => {
  const directory = mkdtempSync(join(tmpdir(), 'telegram-corrupt-test-'));
  try {
    writeFileSync(join(directory, 'submissions.json'), '{broken');
    assert.throws(() => new SubmissionJournal(directory));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Linux PID reuse after container restart can reclaim the dead writer lock', { skip: process.platform !== 'linux' }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'telegram-pid-test-'));
  try {
    writeFileSync(join(directory, 'writer.lock'), JSON.stringify({ pid: process.pid, host: hostname(), start: 'previous-boot:1' }));
    const journal = new SubmissionJournal(directory);
    journal.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('journal failure before write causes no insertion; after write remains uncertain', async t => {
  const f = fixture(t);
  const save = f.journal.put.bind(f.journal);
  f.journal.put = () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
  const before = await f.service.submit(request());
  assert.equal(before.status, 'not_added'); assert.equal(f.calls.writes, 0);
  f.journal.put = record => { if (record.localConfirmed) throw new Error('disk full'); save(record); };
  const after = await f.service.submit(request(2));
  assert.equal(after.writeAttempted, true); assert.notEqual(after.status, 'verified');
  assert.equal(f.calls.writes, 1);
  f.restart();
  assert.equal((await f.service.submit(request(2))).status, 'verified');
  assert.equal(f.calls.writes, 1);
});

test('target configuration drift never redirects recovery', async t => {
  let identity = 'config'; const f = fixture(t, { identityForBudget: () => identity });
  f.api.sync = async () => { throw new Error('offline'); };
  await f.service.submit(request()); identity = 'different-server-or-budget';
  const result = await f.service.submit(request());
  assert.equal(result.errorCode, 'TARGET_CONFIGURATION_CHANGED');
  assert.equal(f.calls.writes, 1);
});

test('expired payloads compact to permanent replay tombstones and cannot be undone', async t => {
  const f = fixture(t); const result = await f.service.submit(request());
  f.journal.compact(Date.now() + 91 * 86400_000); f.restart();
  const replay = await f.service.submit(request());
  assert.equal(replay.compacted, true);
  assert.equal(f.calls.writes, 1);
  assert.equal(f.service.latest(result.contextKey), undefined);
  assert.doesNotMatch(JSON.stringify(replay), /hawker|synthetic|711/);
});

for (const mutation of [r => r.legs[0].account = 'unknown', r => r.legs[0].category = 'unknown',
  r => r.legs[0].amount = NaN, r => r.legs[0].amount = Infinity]) {
  test('invalid account/category/non-finite amount fails before write', async t => {
    const f = fixture(t); const input = request(); mutation(input);
    const result = await f.service.submit(input);
    assert.equal(result.status, 'not_added'); assert.equal(f.calls.writes, 0);
  });
}
