import { createHash, randomUUID } from 'node:crypto';
import { validDate } from './dates.js';
import { setTimeout as delay } from 'node:timers/promises';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const submissionId = ({ botId, chatId, userId, budgetKey, messageId }) => {
  if (![botId, chatId, userId, budgetKey, messageId].every(v => v !== undefined && v !== null && v !== '')) {
    throw new Error('ORIGIN_REQUIRED');
  }
  return hash([String(botId), String(chatId), String(userId), budgetKey, messageId]);
};
export const configIdentity = (endpoint, budget) => hash([endpoint, budget.key, budget.syncId]);
const fail = code => { throw Object.assign(new Error(code), { safeCode: code }); };
const transientCodes = new Set(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED']);
const internalCodes = new Set(['INVALID_QUERY_RESULT', 'ORIGIN_COLLISION', 'ORIGIN_NOT_FOUND',
  'IDENTITY_MISMATCH', 'TRANSACTION_DELETED', 'STORED_FIELDS_MISMATCH', 'TARGET_CONFIGURATION_CHANGED',
  'INVALID_DATE', 'INVALID_PAYLOAD', 'INVALID_ACCOUNT', 'INVALID_AMOUNT', 'INVALID_PAYEE',
  'INVALID_CATEGORY', 'UNEXPECTED_ORIGIN', 'INVALID_INSERT_RESULT', 'UNSUPPORTED_RULE_RESULT',
  'INVALID_SYNC_RESULT', 'TRANSACTION_CHANGED', 'UNDO_UNPROVEN', 'UNDO_EXTERNALLY_CHANGED', 'DELETE_NOT_VERIFIED']);
export function safeCode(error) {
  if (internalCodes.has(error?.safeCode)) return error.safeCode;
  if (transientCodes.has(error?.code)) return error.code;
  if (transientCodes.has(error?.cause?.code)) return error.cause.code;
  const message = String(error?.message || '');
  const networkCode = message.match(/\b(ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED)\b/)?.[1];
  if (networkCode) return networkCode;
  if (error?.response?.statusCode === 409) return 'TELEGRAM_CONFLICT';
  if (error?.response?.statusCode === 429) return 'TELEGRAM_RATE_LIMIT';
  if (/^(BOT_DATA_DIR_REQUIRED|WRITER_LOCKED|JOURNAL_INVALID)$/.test(message)) return message;
  if (/encrypt|decrypt|key-test/i.test(message)) return 'ENCRYPTION_ERROR';
  if (/password|unauthorized|authentication/i.test(message)) return 'AUTHENTICATION_ERROR';
  if (/sync.id|budget.*not found/i.test(message)) return 'INVALID_SYNC_ID';
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return 'STORAGE_PERMISSION';
  if (/required|not configured/i.test(message)) return 'CONFIGURATION_REQUIRED';
  return 'API_ERROR';
}
const fields = ['id', 'account', 'date', 'amount', 'payee', 'category', 'notes', 'imported_id',
  'imported_payee', 'cleared', 'reconciled', 'transfer_id', 'is_parent', 'is_child'];
const fingerprint = row => hash(fields.map(k => row[k] ?? null));

export function outcomeText(record) {
  const ref = `Reference: ${record.id}`;
  if (record.compacted) return `This submission was already ${record.status === 'undone' ? 'undone' : 'completed'}. Its details have expired; it will not be submitted again. ${ref}`;
  if (record.status === 'verified') return `${record.kind === 'transfer' ? 'Transfer completed' : 'OK Logged'} in ${record.budgetLabel}.\nAccount: ${record.accountLabel}\nDate: ${record.date}\nAmount: $${(Math.abs(record.legs[0].amount) / 100).toFixed(2)}\n${ref}`;
  if (record.status === 'undone') return `Deletion synced and verified. ${ref}`;
  if (record.status === 'undo_pending') return `Deletion is not confirmed complete. Do not repeat the expense. ${ref}`;
  if (record.syncAcknowledged) return `Sync completed, but verification failed (${record.errorCode}). Do not resend; ${ref}`;
  if (record.localConfirmed) return `Saved locally${record.legs.length > 1 ? ' (transfer may be partial)' : ''}; server sync is not confirmed (${record.errorCode}). Do not resend. ${ref}`;
  if (record.writeAttempted) return `Submission outcome could not be confirmed (${record.errorCode}). Do not resend; ${ref}`;
  return `Not added: ${record.errorCode || 'validation failed'}. Check the configured budget/account or input. ${ref}`;
}

// All client operations, including recovery and undo, execute in withBudget's queue.
export function createSubmissionService({ api, journal, withBudget, identityForBudget,
  check = () => {}, commit = () => {}, now = Date.now, log = event => console.log(JSON.stringify(event)),
  fault = async () => {} }) {
  let queue = Promise.resolve();
  const serialize = fn => {
    const result = queue.then(fn, fn); queue = result.catch(() => {}); return result;
  };
  const save = record => { record.updatedAt = now(); journal.put(record); };
  async function rowsFor(leg) {
    const result = await api.aqlQuery(api.q('transactions').filter({ $or: [
      { id: leg.id }, { imported_id: leg.origin },
    ] }).select('*').withDead().options({ splits: 'all' }));
    if (!Array.isArray(result?.data)) fail('INVALID_QUERY_RESULT');
    return result.data;
  }
  async function find(leg) {
    const rows = await rowsFor(leg);
    if (rows.length !== 1) fail(rows.length ? 'ORIGIN_COLLISION' : 'ORIGIN_NOT_FOUND');
    const row = rows[0];
    if (row.id !== leg.id || row.imported_id !== leg.origin || row.account !== leg.account) fail('IDENTITY_MISMATCH');
    if (row.tombstone) fail('TRANSACTION_DELETED');
    return row;
  }
  async function verify(leg) {
    const row = await find(leg);
    const payees = await api.getPayees();
    const payee = payees.find(p => p.id === row.payee);
    if (row.amount !== leg.payload.amount || row.date !== leg.payload.date ||
        (row.category ?? null) !== leg.payload.category || row.notes !== leg.payload.notes ||
        row.imported_payee !== leg.payload.imported_payee ||
        (leg.normalizedPayee ? row.payee !== leg.normalizedPayee.id || payee?.name !== leg.normalizedPayee.name
          : payee?.name?.toLowerCase() !== leg.payload.payee_name.toLowerCase()) ||
        !row.cleared || row.transfer_id || row.is_parent || row.is_child) {
      fail('STORED_FIELDS_MISMATCH');
    }
    return row;
  }
  async function validate(record, state) {
    if (record.configIdentity !== identityForBudget(record.budgetKey)) fail('TARGET_CONFIGURATION_CHANGED');
    const accounts = await api.getAccounts();
    const categories = await api.getCategories();
    if (!validDate(record.date)) fail('INVALID_DATE');
    if (record.kind === 'expense' ? record.legs.length !== 1 || record.legs[0].amount >= 0
      : record.kind !== 'transfer' || record.legs.length !== 2 ||
        record.legs[0].account === record.legs[1].account || record.legs[0].amount >= 0 ||
        record.legs[0].amount + record.legs[1].amount !== 0) fail('INVALID_PAYLOAD');
    for (const leg of record.legs) {
      if (!accounts.some(a => a.id === leg.account && !a.closed)) fail('INVALID_ACCOUNT');
      if (!Number.isSafeInteger(leg.amount) || leg.amount === 0) fail('INVALID_AMOUNT');
      if (!leg.description?.trim()) fail('INVALID_PAYEE');
      if (!leg.payload) {
        const category = leg.category ? state.categoryMap[leg.category.toLowerCase()] : null;
        if (record.kind === 'expense' && !category) fail('INVALID_CATEGORY');
        leg.payload = { id: leg.id, imported_id: leg.origin, date: record.date,
          amount: leg.amount, category, payee_name: leg.description.trim(),
          imported_payee: leg.description.trim(), notes: leg.notes, cleared: true };
      }
      if (leg.payload.category && !categories.some(c => c.id === leg.payload.category)) fail('INVALID_CATEGORY');
    }
    save(record);
  }
  async function execute(record) {
    if (['verified', 'undone', 'cancelled'].includes(record.status)) return record;
    const started = now();
    record.attempt = (record.attempt || 0) + 1;
    record.nextRetryAt = null;
    let stage = 'open';
    try {
      check();
      if (record.configIdentity !== identityForBudget(record.budgetKey)) fail('TARGET_CONFIGURATION_CHANGED');
      await withBudget(record.budgetKey, async state => {
        stage = 'validate';
        await validate(record, state);
        for (const leg of record.legs) {
          let insertedNow = false;
          check();
          stage = 'resolve-origin';
          if (!leg.attempted) {
            const existing = await rowsFor(leg);
            if (existing.length) fail('UNEXPECTED_ORIGIN');
            check(); commit();
            leg.attempted = true; record.writeAttempted = true; record.status = 'writing';
            save(record); // fsync BEFORE entering the API write boundary
            await fault('before-write', record);
            stage = 'insert';
            const result = await api.addTransactions(leg.account, [leg.payload], { runTransfers: false, learnCategories: false });
            await fault('after-write', record);
            // 26.7.0 returns exactly "ok", not IDs. Identity is independently read below.
            if (result !== 'ok') fail('INVALID_INSERT_RESULT');
            insertedNow = true;
          }
          // An attempted write is NEVER repeated, even if no row is visible.
          stage = 'local-identity';
          const stored = await find(leg);
          leg.localConfirmed = true;
          record.localConfirmed = true;
          save(record);
          if (insertedNow) {
            // addTransactions runs rules even with runTransfers=false. Preserve
            // payee normalization, but explicit user fields take precedence.
            const payee = (await api.getPayees()).find(p => p.id === stored.payee);
            if (!payee || payee.transfer_acct || stored.reconciled || stored.is_parent || stored.is_child || stored.transfer_id) {
              fail('UNSUPPORTED_RULE_RESULT');
            }
            leg.normalizedPayee = { id: payee.id, name: payee.name };
            save(record);
            const explicit = { amount: leg.payload.amount, date: leg.payload.date,
              category: leg.payload.category, notes: leg.payload.notes,
              imported_payee: leg.payload.imported_payee, cleared: true };
            if (Object.entries(explicit).some(([k, v]) => (stored[k] ?? null) !== v)) {
              stage = 'restore-explicit-fields';
              // Only normalize the just-created row, never rewrite on recovery.
              await api.updateTransaction(leg.id, explicit);
              for (let attempt = 0; attempt < 20; attempt++) {
                const row = await find(leg);
                if (Object.entries(explicit).every(([k, v]) => (row[k] ?? null) === v)) break;
                if (attempt === 19) fail('STORED_FIELDS_MISMATCH');
                await delay(25);
              }
            }
          }
          stage = 'local-verification';
          const row = await verify(leg);
          leg.fingerprint ||= fingerprint(row);
          save(record);
          await fault('after-local', record);
        }
        stage = 'sync';
        const result = await api.sync();
        if (result !== undefined) fail('INVALID_SYNC_RESULT');
        record.syncAcknowledged = true;
        save(record);
        await fault('after-sync', record);
        stage = 'verification';
        for (const leg of record.legs) {
          const row = await verify(leg);
          if (fingerprint(row) !== leg.fingerprint) fail('TRANSACTION_CHANGED');
        }
        record.status = 'verified'; record.errorCode = null;
        save(record);
      });
    } catch (error) {
      if (error.simulatedCrash) throw error;
      record.errorCode = error.code === 'CANCELLED' ? 'CANCELLED' : safeCode(error);
      record.status = record.writeAttempted ? 'uncertain' : record.errorCode === 'CANCELLED' ? 'cancelled' : 'not_added';
      // Only known transient errors schedule bounded, durable retries.
      if (transientCodes.has(record.errorCode) && record.attempt < 4) {
        record.nextRetryAt = now() + 30_000 * 2 ** (record.attempt - 1);
      }
      save(record);
    }
    log({ stage, submission: record.id, route: record.budgetKey, attempt: record.attempt,
      ids: record.legs.filter(l => l.localConfirmed).map(l => l.id), outcome: record.status,
      code: record.errorCode, durationMs: now() - started });
    return record;
  }
  async function undoRecord(record) {
    if (record.status === 'undone') return record;
    if (record.kind !== 'expense' || !record.legs.every(l => l.localConfirmed && l.fingerprint)) fail('UNDO_UNPROVEN');
    try {
      if (record.configIdentity !== identityForBudget(record.budgetKey)) fail('TARGET_CONFIGURATION_CHANGED');
      await withBudget(record.budgetKey, async () => {
        for (const leg of record.legs) {
          const rows = await rowsFor(leg);
          const live = rows.filter(r => !r.tombstone);
          if (live.length) {
            const row = await verify(leg);
            if (row.reconciled || fingerprint(row) !== leg.fingerprint) fail('UNDO_EXTERNALLY_CHANGED');
            commit();
            record.status = 'undo_pending'; leg.deleteAttempted = true; save(record);
            await api.deleteTransaction(leg.id);
            // This API version returns before deletion settles. Read-only polling
            // is bounded; never acknowledge or sync before local deletion is visible.
            for (let attempt = 0; attempt < 20; attempt++) {
              if (!(await rowsFor(leg)).some(row => !row.tombstone)) break;
              if (attempt === 19) fail('DELETE_NOT_VERIFIED');
              await delay(25);
            }
          } else if (!leg.deleteAttempted) {
            // Already removed elsewhere: retain a tombstone, never resurrect it.
            record.status = 'undo_pending'; leg.deleteAttempted = true; save(record);
          }
        }
        if (await api.sync() !== undefined) fail('INVALID_SYNC_RESULT');
        for (const leg of record.legs) {
          if ((await rowsFor(leg)).some(row => !row.tombstone)) fail('DELETE_NOT_VERIFIED');
        }
        record.status = 'undone'; record.errorCode = null; save(record);
      });
    } catch (error) {
      record.errorCode = safeCode(error);
      save(record);
      // Do not turn a rejected undo into a normal submission success response.
      return { ...record, status: 'undo_pending' };
    }
    return record;
  }
  return {
    submit: request => serialize(async () => {
      check();
      try {
        let record = journal.get(request.id);
        if (!record) {
          record = { ...structuredClone(request), status: 'prepared', createdAt: now(),
            writeAttempted: false, localConfirmed: false, syncAcknowledged: false,
            legs: request.legs.map((leg, index) => ({ ...leg, id: randomUUID(), origin: `telegram:${request.id}:${index}` })) };
          save(record);
        }
        if (record.status === 'undo_pending') return await undoRecord(record);
        return await execute(record);
      } catch (error) {
        if (error.simulatedCrash || error.code === 'CANCELLED') throw error;
        // If durable outcome storage fails after insertion, the last durable
        // write-ahead record still prevents reinsertion on restart.
        const previous = journal.get(request.id);
        return { ...(previous || request), status: previous?.writeAttempted ? 'uncertain' : 'not_added',
          errorCode: 'JOURNAL_WRITE_FAILED' };
      }
    }),
    undo: (id, contextKey) => serialize(async () => {
      const record = journal.get(id);
      if (!record || record.contextKey !== contextKey) fail('UNDO_UNPROVEN');
      return undoRecord(record);
    }),
    latest: contextKey => journal.all().filter(r => !r.compacted && r.contextKey === contextKey && r.kind === 'expense' &&
      r.legs.every(l => l.localConfirmed && l.fingerprint)).sort((a, b) => b.createdAt - a.createdAt)[0],
    recover: ({ startup = false } = {}) => serialize(async () => {
      for (const record of journal.all()) {
        if (record.status === 'undo_pending') { if (startup) await undoRecord(record); continue; }
        if (['verified', 'undone', 'cancelled'].includes(record.status)) continue;
        if (record.status === 'not_added' && !record.nextRetryAt) continue;
        if (startup || (record.nextRetryAt && record.nextRetryAt <= now())) await execute(record);
      }
    }),
    drain: () => queue,
  };
}
