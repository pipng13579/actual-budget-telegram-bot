// Host/operator-only. Never uses the running bot's cache or calls sync().
import 'dotenv/config';
import { EventEmitter } from 'node:events';
import { accessSync, constants, readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import * as defaultApi from '@actual-app/api';
import { redactedApi, installApiLogRedaction } from './api-logging.js';
import { createBotRuntime } from './bot.js';
import { safeCode } from './submissions.js';

const require = createRequire(import.meta.url);
installApiLogRedaction();
const api = redactedApi(defaultApi);
const installed = JSON.parse(readFileSync(join(require.resolve('@actual-app/api'), '..', '..', 'package.json'))).version;
const fakeBot = Object.assign(new EventEmitter(), { options: { polling: { interval: 1000 } },
  getUpdates: async () => [], sendMessage: async () => {}, onText: () => {} });
const { budgets } = createBotRuntime({ bot: fakeBot, validateConfiguration: false });
const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
const route = args.includes('--route') ? value('--route') : null;
const selected = route ? [budgets[route]].filter(Boolean) : Object.values(budgets);
if (route && !selected.length) throw new Error('Unknown route; use user1, user2, or family.');
const journalDirectory = process.env.BOT_DATA_DIR || (process.env.ACTUAL_DATA_DIR && join(process.env.ACTUAL_DATA_DIR, 'bot-data'));
const cacheDirectory = process.env.ACTUAL_BUDGET_DATA_DIR || join(process.env.ACTUAL_DATA_DIR || '/tmp/actual-data', 'budgets');
const accessibility = path => {
  if (!path || !existsSync(path)) return 'missing';
  try { accessSync(path, constants.R_OK | constants.W_OK); return 'read-write'; }
  catch { return 'permission-error'; }
};
let records = [];
let journalState = 'missing';
try {
  if (journalDirectory) {
    const data = JSON.parse(readFileSync(join(journalDirectory, 'submissions.json'), 'utf8'));
    if (data.version !== 1 || !data.records) throw new Error('invalid journal');
    records = Object.values(data.records); journalState = 'readable';
  }
} catch (error) { if (error.code !== 'ENOENT') journalState = 'invalid-or-unreadable'; }
const report = { node: process.version, installedApi: installed, timezone: process.env.TZ,
  configPresent: { telegramToken: !!process.env.TELEGRAM_BOT_TOKEN,
    serverEndpoint: !!process.env.ACTUAL_SERVER_URL, serverPassword: !!process.env.ACTUAL_SERVER_PASSWORD },
  cache: accessibility(cacheDirectory), journalStorage: accessibility(journalDirectory), journalState,
  routes: selected.map(budget => ({ route: budget.key, syncIdPresent: !!budget.syncId,
    encryptionPasswordPresent: !!budget.encryptionPassword, configuredAccounts: Object.keys(budget.accounts).length,
    defaultAccountValid: !!budget.accounts[budget.defaultAccountKey],
    restrictedDefaultsValid: Object.entries(budget.accountKeysByUser || {}).every(([user, keys]) =>
      !keys.length || keys.includes(budget.defaultAccountKeyByUser?.[user] || budget.defaultAccountKey)),
    journalStates: records.filter(r => r.budgetKey === budget.key).reduce((counts, r) => {
      counts[r.status] = (counts[r.status] || 0) + 1; return counts;
    }, {}) })) };

if (args.includes('--remote')) {
  if (!route) throw new Error('--remote requires --route user1|user2|family to limit access.');
  if (!process.env.ACTUAL_SERVER_URL || !process.env.ACTUAL_SERVER_PASSWORD || !budgets[route].syncId) {
    throw new Error('Server configuration and route Sync ID are required.');
  }
  const directory = mkdtempSync(join(tmpdir(), 'telegram-readonly-diagnostic-'));
  try {
    await api.init({ dataDir: directory, serverURL: process.env.ACTUAL_SERVER_URL,
      password: process.env.ACTUAL_SERVER_PASSWORD, verbose: false });
    const version = await api.getServerVersion();
    report.serverVersion = version?.version || 'unavailable';
    const budget = budgets[route];
    await api.downloadBudget(budget.syncId, budget.encryptionPassword ? { password: budget.encryptionPassword } : undefined);
    const accounts = await api.getAccounts();
    const categories = await api.getCategories();
    report.remote = { route, configuredAccountsValid: Object.values(budget.accounts).every(configured =>
      accounts.some(a => a.id === configured.id && !a.closed)), availableCategories: categories.length,
      source: 'fresh isolated cache; no writes or explicit sync' };
    if (args.includes('--reference')) {
      const record = records.find(r => r.id === value('--reference') && r.budgetKey === route);
      if (!record) throw new Error('Reference not found for this route.');
      const ids = record.compacted ? record.transactionIds : record.legs.map(l => l.id);
      report.remote.exactTransactions = [];
      for (const id of ids) {
        const result = await api.aqlQuery(api.q('transactions').filter({ id }).select('*').withDead());
        const row = result.data?.[0];
        const leg = record.legs.find(l => l.id === id);
        report.remote.exactTransactions.push({ id, state: !row ? 'absent' : row.tombstone ? 'deleted' : 'present',
          originMatches: leg ? row?.imported_id === leg.origin : null,
          accountMatches: leg ? row?.account === leg.account : null });
      }
    }
  } catch (error) { report.remote = { route, errorCode: safeCode(error) }; process.exitCode = 1; }
  finally { await api.shutdown(); rmSync(directory, { recursive: true, force: true }); }
}
console.log(JSON.stringify(report, null, 2));
