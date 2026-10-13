// Invoked only by crash.integration.test.js with a freshly created synthetic directory.
import * as api from '@actual-app/api';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SubmissionJournal } from '../submission-journal.js';
import { createSubmissionService } from '../submissions.js';

const [directory, phase] = process.argv.slice(2);
const metadata = join(directory, 'synthetic.json');
await api.init({ dataDir: directory, verbose: false });
let config;
if (phase !== 'recover') {
  config = {};
  await api.runImport('SYNTHETIC CRASH TEST', async () => {
    config.account = await api.createAccount({ name: 'Synthetic account' });
    const group = await api.createCategoryGroup({ name: 'Synthetic group' });
    config.category = await api.createCategory({ name: 'Food', group_id: group });
  });
  config.budget = (await api.getBudgets()).find(b => b.name === 'SYNTHETIC CRASH TEST').id;
  writeFileSync(metadata, JSON.stringify(config));
} else {
  config = JSON.parse(readFileSync(metadata));
  await api.loadBudget(config.budget);
}
const journal = new SubmissionJournal(join(directory, 'journal'));
const service = createSubmissionService({ api: { ...api, sync: async () => {} }, journal,
  withBudget: async (_key, fn) => fn({ categoryMap: { food: config.category } }),
  identityForBudget: () => 'synthetic', log: () => {},
  fault: async boundary => { if (boundary === phase) process.exit(86); } });
const result = await service.submit({ id: 'crash-origin', contextKey: 'synthetic', budgetKey: 'synthetic',
  configIdentity: 'synthetic', date: '2026-10-13', kind: 'expense',
  legs: [{ account: config.account, amount: -711, category: 'Food', description: 'Synthetic purchase', notes: 'test' }] });
const rows = await api.getTransactions(config.account, '2026-10-13', '2026-10-13');
console.log(JSON.stringify({ status: result.status, count: rows.length,
  identityMatches: rows.length === 1 && rows[0].id === result.legs[0].id && rows[0].imported_id === result.legs[0].origin }));
journal.close();
await api.shutdown();
