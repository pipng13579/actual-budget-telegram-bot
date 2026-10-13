import test from 'node:test';
import assert from 'node:assert/strict';
import { installApiLogRedaction, redactedApi } from './api-logging.js';

test('upstream exceptions and financial payloads are redacted in API async context', async () => {
  const original = console.warn; const output = [];
  console.warn = value => output.push(value);
  const restore = installApiLogRedaction();
  try {
    const api = redactedApi({ async addTransactions() {
      await Promise.resolve();
      console.warn('secret password=123', { amount: 711, notes: 'private' }, new Error('credential'));
    } });
    await api.addTransactions();
    assert.equal(output.length, 1);
    assert.doesNotMatch(output[0], /secret|password|711|private|credential/);
    assert.match(output[0], /actual-api/);
  } finally { restore(); console.warn = original; }
});
