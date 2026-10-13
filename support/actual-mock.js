import { submissionId } from '../submissions.js';
export function mockActual() {
  const rows = new Map();
  const calls = { writes: 0, syncs: 0, deletes: 0 };
  const api = {
    init: async () => {}, downloadBudget: async () => {}, shutdown: async () => {},
    getCategories: async () => [{ id: 'cat', name: 'Food & Drinks' }],
    getAccounts: async () => [{ id: 'cash' }, { id: 'bank' }],
    getPayees: async () => [...rows.values()].map(r => ({ id: `payee:${r.payeeName}`, name: r.payeeName })),
    q() { return { filter(value) { this.where = value; return this; }, select() { return this; }, withDead() { return this; }, options() { return this; } }; },
    aqlQuery: async query => ({ data: [...rows.values()].filter(r => query.where.$or.some(c =>
      Object.entries(c).every(([k, v]) => r[k] === v))).map(r => ({ ...r })) }),
    addTransactions: async (account, payloads) => {
      calls.writes++;
      for (const p of payloads) rows.set(p.id, { ...p, account, payee: `payee:${p.payee_name}`,
        payeeName: p.payee_name, tombstone: false, reconciled: false });
      return 'ok';
    },
    sync: async () => { calls.syncs++; },
    deleteTransaction: async id => { calls.deletes++; rows.get(id).tombstone = true; },
    getTransactions: async (account, start, end) => [...rows.values()].filter(r => !r.tombstone && r.account === account && r.date >= start && r.date <= end),
  };
  return { api, rows, calls };
}

export function request(messageId = 1, overrides = {}) {
  const origin = { botId: 'bot', chatId: 'chat', userId: 'user', budgetKey: 'personal', messageId };
  return { id: submissionId(origin), contextKey: 'personal:chat:user', budgetKey: 'personal',
    budgetLabel: 'Synthetic', configIdentity: 'config', date: '2026-10-13', kind: 'expense', accountLabel: 'Cash',
    legs: [{ account: 'cash', amount: -711, description: 'hawker', category: 'Food & Drinks', notes: 'synthetic' }], ...overrides };
}
