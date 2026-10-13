// Fresh synthetic cache only; no server, credentials, Telegram, or network access.
import assert from 'node:assert/strict';
import * as api from '@actual-app/api';

const [directory, mode = 'shutdown'] = process.argv.slice(2);
let client = await api.init({ dataDir: directory, verbose: false });
let account, payee;
await api.runImport('SYNTHETIC SCHEDULE SOURCE', async () => {
  account = await api.createAccount({ name: 'Synthetic source account' });
  payee = await api.createPayee({ name: 'Synthetic scheduled payee' });
});
const sourceId = (await api.getBudgets()).find(b => b.name === 'SYNTHETIC SCHEDULE SOURCE').id;
let targetId;
if (mode === 'switch') {
  await api.runImport('SYNTHETIC SCHEDULE TARGET', async () => {
    await api.createAccount({ name: 'Synthetic target account' });
  });
  targetId = (await api.getBudgets()).find(b => b.name === 'SYNTHETIC SCHEDULE TARGET').id;
  await api.loadBudget(sourceId);
}
const date = new Date().toLocaleDateString('en-CA');
const schedule = await api.createSchedule({ name: 'Synthetic due schedule', account,
  payee, amount: -711, amountOp: 'is', date, posts_transaction: true });
// The real offline sync still emits Actual's success event and starts its scheduler.
await client.send('sync');
if (mode === 'switch') {
  await api.loadBudget(targetId);
  assert.equal((await api.aqlQuery(api.q('transactions').select('*'))).data.length, 0,
    'Scheduled transaction must never leak into the next budget');
  await api.loadBudget(sourceId);
} else {
  await api.shutdown();
  client = await api.init({ dataDir: directory, verbose: false });
  await api.loadBudget(sourceId);
}
const rows = await api.getTransactions(account, date, date);
assert.equal(rows.length, 1, 'Scheduled transaction must finish before closing');
assert.equal(rows[0].schedule, schedule);
assert.equal(rows[0].amount, -711);
await client.send('sync');
await api.shutdown();
await api.init({ dataDir: directory, verbose: false });
await api.loadBudget(sourceId);
assert.equal((await api.getTransactions(account, date, date)).length, 1,
  'Repeated sync and reopen must not post the schedule twice');
await api.shutdown();
console.log('SCHEDULE_LIFECYCLE_OK');
