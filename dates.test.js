import test from 'node:test';
import assert from 'node:assert/strict';
import { localDate, validDate } from './dates.js';
import { parseExpenseText, parseDateInput } from './parser.js';

test('Singapore midnight and calendar date validation', () => {
  process.env.TZ = 'Asia/Singapore';
  assert.equal(localDate(new Date('2026-10-12T15:59:59Z')), '2026-10-12');
  assert.equal(localDate(new Date('2026-10-12T16:00:00Z')), '2026-10-13');
  assert.equal(validDate('2026-02-30'), false);
  assert.equal(validDate('2028-02-29'), true);
  process.env.TZ = 'America/New_York';
  assert.equal(localDate(new Date('2026-10-13T00:00:00Z')), '2026-10-12');
  process.env.TZ = 'Asia/Singapore';
});

test('parser retains amounts, explicit dates, account suffixes and missing-input flags', () => {
  const expense = parseExpenseText('12/10/2026 lunch $7.11 credit notes', 'synthetic');
  assert.equal(expense.amount, 7.11);
  assert.equal(expense.date, '2026-10-12');
  assert.equal(expense.category, 'Food & Drinks');
  assert.match(expense.trailingText, /credit notes/);
  assert.equal(parseExpenseText('lunch', 'synthetic').needsAmount, true);
  assert.equal(parseExpenseText('unknownmerchant 7.11', 'synthetic').needsCategory, true);
  assert.equal(parseDateInput('today'), localDate());
  assert.equal(parseExpenseText('31/2/2026 lunch 7.11', 'synthetic').invalidDate, true);
});
