import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import * as api from '@actual-app/api';
import { SubmissionJournal } from './submission-journal.js';
import { createSubmissionService } from './submissions.js';

test('Actual 26.7.0: non-reconciling insertion, persistent identities, rules and deletion', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'telegram-api-test-'));
  try {
    await api.init({ dataDir: directory, verbose: false });
    let account, category;
    await api.runImport('SYNTHETIC TEST ONLY', async () => {
      account = await api.createAccount({ name: 'Synthetic cash' });
      const group = await api.createCategoryGroup({ name: 'Synthetic group' });
      category = await api.createCategory({ name: 'Synthetic food', group_id: group });
    });
    const original = { date: '2026-10-12', amount: -711, category, payee_name: 'hawker', notes: 'synthetic', cleared: true };
    await api.addTransactions(account, [original]);
    const older = (await api.getTransactions(account, original.date, original.date))[0];
    const ids = [randomUUID(), randomUUID()];
    for (const id of ids) {
      assert.equal(await api.addTransactions(account, [{ ...original, id, imported_id: `telegram:test:${id}` }]), 'ok');
    }
    const rows = await api.getTransactions(account, original.date, original.date);
    assert.equal(rows.length, 3);
    assert.equal(rows.find(r => r.id === older.id).notes, older.notes);
    for (const id of ids) assert.equal(rows.find(r => r.id === id).imported_id, `telegram:test:${id}`);
    assert.equal((await api.getPayees()).find(p => p.id === rows[0].payee).name, 'hawker');
    const budgets = await api.getBudgets();
    const localId = budgets.find(b => b.name === 'SYNTHETIC TEST ONLY').id;
    await api.shutdown();
    await api.init({ dataDir: directory, verbose: false });
    await api.loadBudget(localId);
    const recovered = await api.aqlQuery(api.q('transactions').filter({ imported_id: `telegram:test:${ids[0]}` }).select('*').withDead().options({ splits: 'all' }));
    assert.equal(recovered.data[0].id, ids[0]);
    await api.deleteTransaction(ids[0]);
    // 26.7.0's delete wrapper returns before its asynchronous mutation settles.
    for (let attempt = 0; attempt < 20; attempt++) {
      const visible = await api.getTransactions(account, original.date, original.date);
      if (!visible.some(row => row.id === ids[0])) break;
      await delay(25);
    }
    const deleted = await api.aqlQuery(api.q('transactions').filter({ id: ids[0] }).select('*').withDead().options({ splits: 'all' }));
    assert.equal(deleted.data.length, 1);
    assert.equal(Boolean(deleted.data[0].tombstone), true);
    await api.createRule({ stage: 'pre', conditionsOp: 'and', conditions: [
      { field: 'imported_payee', op: 'is', value: 'rule test' },
    ], actions: [{ op: 'set', field: 'notes', value: 'rule changed notes' }] });
    await api.addTransactions(account, [{ ...original, payee_name: 'rule test' }]);
    assert.ok((await api.getTransactions(account, original.date, original.date)).some(r => r.notes === 'rule changed notes'));
    const journal = new SubmissionJournal(join(directory, 'journal'));
    try {
      const service = createSubmissionService({ api: { ...api, sync: async () => {} }, journal,
        withBudget: async (_key, fn) => fn({ categoryMap: { food: category } }),
        identityForBudget: () => 'synthetic', log: () => {} });
      const result = await service.submit({ id: 'synthetic-pipeline', contextKey: 'test',
        budgetKey: 'test', configIdentity: 'synthetic', date: original.date, kind: 'expense',
        legs: [{ account, category: 'Food', description: 'rule test', amount: -711, notes: 'explicit notes' }] });
      assert.equal(result.status, 'verified', result.errorCode);
      const created = (await api.getTransactions(account, original.date, original.date)).find(r => r.id === result.legs[0].id);
      assert.equal(created.notes, 'explicit notes');
      assert.equal((await service.undo(result.id, 'test')).status, 'undone');
    } finally { journal.close(); }
  } finally {
    await api.shutdown();
    rmSync(directory, { recursive: true, force: true });
  }
});
