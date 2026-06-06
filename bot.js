import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import * as actualApi from '@actual-app/api';
import {
  parseExpenseText,
  BUILTIN_CATEGORIES,
  learnKeyword,
  loadLearnedKeywords,
} from './parser.js';
import { initVision, parseReceipt } from './receipt.js';
import { mkdirSync } from 'fs';
import https from 'https';
import http from 'http';

// ============================================================
// CONFIG
// ============================================================

const {
  TELEGRAM_BOT_TOKEN,
  ACTUAL_SERVER_URL,
  ACTUAL_SERVER_PASSWORD,
  USER1_TELEGRAM_ID,
  USER2_TELEGRAM_ID,
  USER1_NAME = 'User 1',
  USER2_NAME = 'User 2',
  FAMILY_GROUP_CHAT_ID,
  WEEKLY_SUMMARY_CHAT_ID,
  DAILY_NUDGE_CHAT_ID,
} = process.env;

const ACTUAL_DATA_DIR = process.env.ACTUAL_DATA_DIR || '/tmp/actual-data';

function compactObject(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined && value !== ''));
}

function parseList(value) {
  if (!value) return [];
  return value
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseAccounts(value, fallback = {}) {
  const accounts = {};

  for (const item of parseList(value)) {
    const parts = item.split(':');
    const key = parts.shift()?.trim();
    const id = parts.shift()?.trim();
    const label = parts.join(':').trim();

    if (!key || !id) continue;
    accounts[key.toLowerCase()] = {
      id,
      label: label || key,
    };
  }

  return Object.keys(accounts).length > 0 ? accounts : fallback;
}

function getBudgetAccountKeys(budget, userKey) {
  if (!budget) return [];
  const specific = budget.accountKeysByUser?.[userKey];
  return specific && specific.length > 0 ? specific : Object.keys(budget.accounts);
}

function getBudgetPersonalAccountKeys(budget, userKey, defaultAccountKey) {
  if (!budget) return [];
  const specific = budget.personalAccountKeysByUser?.[userKey];
  if (specific && specific.length > 0) return specific;
  return defaultAccountKey ? [defaultAccountKey] : getBudgetAccountKeys(budget, userKey);
}

const legacyUser1Accounts = compactObject({
  savings: process.env.ACCOUNT_USER1_SAVINGS
    ? { id: process.env.ACCOUNT_USER1_SAVINGS, label: 'Savings Account' }
    : undefined,
  credit: process.env.ACCOUNT_USER1_CREDIT
    ? { id: process.env.ACCOUNT_USER1_CREDIT, label: 'Credit Card' }
    : undefined,
});

const legacyUser2Accounts = compactObject({
  savings: process.env.ACCOUNT_USER2_SAVINGS
    ? { id: process.env.ACCOUNT_USER2_SAVINGS, label: 'Savings Account' }
    : undefined,
  her: process.env.ACCOUNT_USER2_SAVINGS
    ? { id: process.env.ACCOUNT_USER2_SAVINGS, label: 'Partner Savings' }
    : undefined,
});

const legacyFamilyAccounts = compactObject({
  joint: process.env.ACCOUNT_JOINT
    ? { id: process.env.ACCOUNT_JOINT, label: 'Joint Account' }
    : undefined,
});

const USERS = compactObject({
  [USER1_TELEGRAM_ID]: USER1_TELEGRAM_ID
    ? { key: 'user1', name: USER1_NAME, personalBudgetKey: 'user1' }
    : undefined,
  [USER2_TELEGRAM_ID]: USER2_TELEGRAM_ID
    ? { key: 'user2', name: USER2_NAME, personalBudgetKey: 'user2' }
    : undefined,
});

const BUDGETS = {
  user1: {
    key: 'user1',
    label: process.env.BUDGET_USER1_LABEL || `${USER1_NAME} Budget`,
    syncId: process.env.BUDGET_USER1_SYNC_ID || process.env.ACTUAL_SYNC_ID,
    encryptionPassword:
      process.env.BUDGET_USER1_ENCRYPTION_PASSWORD || process.env.ACTUAL_ENCRYPTION_PASSWORD,
    accounts: parseAccounts(process.env.BUDGET_USER1_ACCOUNTS, legacyUser1Accounts),
    defaultAccountKey: (process.env.BUDGET_USER1_DEFAULT_ACCOUNT || 'savings').toLowerCase(),
  },
  user2: {
    key: 'user2',
    label: process.env.BUDGET_USER2_LABEL || `${USER2_NAME} Budget`,
    syncId: process.env.BUDGET_USER2_SYNC_ID,
    encryptionPassword: process.env.BUDGET_USER2_ENCRYPTION_PASSWORD,
    accounts: parseAccounts(process.env.BUDGET_USER2_ACCOUNTS, legacyUser2Accounts),
    defaultAccountKey: (
      process.env.BUDGET_USER2_DEFAULT_ACCOUNT ||
      (legacyUser2Accounts.savings ? 'savings' : 'her')
    ).toLowerCase(),
  },
  family: {
    key: 'family',
    label: process.env.BUDGET_FAMILY_LABEL || 'Family Budget',
    syncId: process.env.BUDGET_FAMILY_SYNC_ID,
    encryptionPassword: process.env.BUDGET_FAMILY_ENCRYPTION_PASSWORD,
    accounts: parseAccounts(process.env.BUDGET_FAMILY_ACCOUNTS, legacyFamilyAccounts),
    defaultAccountKey: (process.env.BUDGET_FAMILY_DEFAULT_ACCOUNT || 'joint').toLowerCase(),
    defaultAccountKeyByUser: compactObject({
      user1: (process.env.BUDGET_FAMILY_USER1_DEFAULT_ACCOUNT || process.env.BUDGET_FAMILY_DEFAULT_ACCOUNT || 'joint').toLowerCase(),
      user2: (process.env.BUDGET_FAMILY_USER2_DEFAULT_ACCOUNT || process.env.BUDGET_FAMILY_DEFAULT_ACCOUNT || 'joint').toLowerCase(),
    }),
    accountKeysByUser: compactObject({
      user1: parseList(process.env.BUDGET_FAMILY_USER1_ACCOUNTS).map((key) => key.toLowerCase()),
      user2: parseList(process.env.BUDGET_FAMILY_USER2_ACCOUNTS).map((key) => key.toLowerCase()),
    }),
    personalAccountKeysByUser: compactObject({
      user1: parseList(process.env.BUDGET_FAMILY_USER1_PERSONAL_ACCOUNTS).map((key) => key.toLowerCase()),
      user2: parseList(process.env.BUDGET_FAMILY_USER2_PERSONAL_ACCOUNTS).map((key) => key.toLowerCase()),
    }),
  },
};

function validateConfig() {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN is required.');
  }

  if (Object.keys(USERS).length === 0) {
    console.warn('No Telegram users configured. Set USER1_TELEGRAM_ID and USER2_TELEGRAM_ID.');
  }

  for (const budget of Object.values(BUDGETS)) {
    if (!budget.syncId) {
      console.warn(`${budget.label} has no sync ID; it will run in dry-run mode.`);
    }

    if (Object.keys(budget.accounts).length === 0) {
      console.warn(`${budget.label} has no accounts configured.`);
    }

    const defaults = new Set([
      budget.defaultAccountKey,
      ...Object.values(budget.defaultAccountKeyByUser || {}),
    ]);
    for (const defaultKey of defaults) {
      if (defaultKey && !budget.accounts[defaultKey]) {
        console.warn(`${budget.label} default account "${defaultKey}" is not in its account list.`);
      }
    }
  }
}

function getDefaultAccountKey(budget, userKey) {
  return (
    budget.defaultAccountKeyByUser?.[userKey] ||
    budget.defaultAccountKey ||
    Object.keys(budget.accounts)[0]
  );
}

function resolveBudgetContext(msg) {
  const userId = String(msg.from?.id || '');
  const chatId = String(msg.chat.id);
  const user = USERS[userId];

  if (!user) {
    return {
      error: `I don't recognize you. Your Telegram ID is ${userId}. Add it to .env.`,
    };
  }

  const isPrivate = msg.chat.type === 'private' || chatId === userId;
  const isFamilyGroup = FAMILY_GROUP_CHAT_ID && chatId === String(FAMILY_GROUP_CHAT_ID);
  const budgetKey = isFamilyGroup ? 'family' : isPrivate ? user.personalBudgetKey : null;

  if (!budgetKey) {
    return {
      error: `This chat is not configured. Chat ID: ${chatId}. Set FAMILY_GROUP_CHAT_ID for the shared family budget group.`,
    };
  }

  const budget = BUDGETS[budgetKey];
  if (!budget) {
    return { error: `Budget "${budgetKey}" is not configured.` };
  }

  const defaultAccountKey = getDefaultAccountKey(budget, user.key);
  const accountKeys = getBudgetAccountKeys(budget, user.key).filter((key) => budget.accounts[key]);
  const personalAccountKeys = getBudgetPersonalAccountKeys(budget, user.key, defaultAccountKey).filter(
    (key) => budget.accounts[key]
  );

  if (!budget.accounts[defaultAccountKey]) {
    return {
      error: `${budget.label} default account "${defaultAccountKey}" is not configured in .env.`,
    };
  }

  if (!accountKeys.includes(defaultAccountKey)) accountKeys.push(defaultAccountKey);
  if (!personalAccountKeys.includes(defaultAccountKey)) personalAccountKeys.push(defaultAccountKey);

  return {
    user,
    userId,
    chatId,
    budgetKey,
    budget,
    accountKeys,
    personalAccountKeys,
    defaultAccountKey,
    isFamilyGroup,
    isPrivate,
  };
}

function pendingKey(context) {
  return `${context.budgetKey}:${context.chatId}:${context.userId}`;
}

function lastExpenseKey(context) {
  return `${context.budgetKey}:${context.chatId}:${context.userId}`;
}

// ============================================================
// ACTUAL BUDGET
// ============================================================

const budgetStates = new Map();
let actualInitialized = false;
let activeBudgetKey = null;
let actualQueue = Promise.resolve();

function getBudgetState(budgetKey) {
  if (!budgetStates.has(budgetKey)) {
    budgetStates.set(budgetKey, {
      ready: false,
      categoryMap: {},
      categoryIdToName: {},
      categoryNames: [],
      error: null,
    });
  }
  return budgetStates.get(budgetKey);
}

async function ensureActualClient() {
  if (actualInitialized) return;

  if (!ACTUAL_SERVER_URL || !ACTUAL_SERVER_PASSWORD) {
    throw new Error('ACTUAL_SERVER_URL and ACTUAL_SERVER_PASSWORD are required for syncing.');
  }

  mkdirSync(ACTUAL_DATA_DIR, { recursive: true });
  await actualApi.init({
    dataDir: ACTUAL_DATA_DIR,
    serverURL: ACTUAL_SERVER_URL,
    password: ACTUAL_SERVER_PASSWORD,
  });

  actualInitialized = true;
}

async function refreshBudgetCategories(state) {
  const categories = await actualApi.getCategories();
  state.categoryMap = {};
  state.categoryIdToName = {};
  state.categoryNames = [];

  for (const cat of categories) {
    if (!cat.name) continue;
    state.categoryMap[cat.name.toLowerCase()] = cat.id;
    state.categoryIdToName[cat.id] = cat.name;
    state.categoryNames.push(cat.name);
  }
}

async function switchToBudget(budgetKey) {
  const budget = BUDGETS[budgetKey];
  if (!budget) throw new Error(`Unknown budget "${budgetKey}".`);
  if (!budget.syncId) throw new Error(`${budget.label} has no sync ID configured.`);

  const state = getBudgetState(budgetKey);
  if (activeBudgetKey === budgetKey && state.ready) return state;

  const downloadOpts = budget.encryptionPassword ? { password: budget.encryptionPassword } : undefined;
  await actualApi.downloadBudget(budget.syncId, downloadOpts);
  await refreshBudgetCategories(state);

  state.ready = true;
  state.error = null;
  activeBudgetKey = budgetKey;
  return state;
}

async function withBudget(budgetKey, operation) {
  const run = async () => {
    await ensureActualClient();
    const state = await switchToBudget(budgetKey);
    return operation(state);
  };

  const result = actualQueue.then(run, run);
  actualQueue = result.catch(() => {});
  return result;
}

async function initActualBudgets() {
  try {
    await ensureActualClient();
  } catch (err) {
    console.error('Failed to connect to Actual Budget:', err.message);
    console.log('Bot will run in dry-run mode for all budget files.');
    return;
  }

  for (const budget of Object.values(BUDGETS)) {
    if (!budget.syncId) continue;

    try {
      await withBudget(budget.key, async (state) => state);
      const state = getBudgetState(budget.key);
      console.log(
        `${budget.label} connected. Categories found: ${
          state.categoryNames.length > 0 ? state.categoryNames.join(', ') : 'none'
        }`
      );
    } catch (err) {
      const state = getBudgetState(budget.key);
      state.ready = false;
      state.error = err.message;
      console.error(`Failed to connect ${budget.label}:`, err.message);
    }
  }
}

async function getCategoryNamesForBudget(budgetKey) {
  try {
    return await withBudget(budgetKey, async (state) =>
      state.categoryNames.length > 0 ? state.categoryNames : BUILTIN_CATEGORIES
    );
  } catch {
    const state = getBudgetState(budgetKey);
    return state.categoryNames.length > 0 ? state.categoryNames : BUILTIN_CATEGORIES;
  }
}

function resolveCategoryName(categoryName, categoryNames) {
  if (!categoryName) return null;

  const exact = categoryNames.find((cat) => cat.toLowerCase() === categoryName.toLowerCase());
  if (exact) return exact;

  const lower = categoryName.toLowerCase();
  return (
    categoryNames.find((cat) => {
      const catLower = cat.toLowerCase();
      return catLower.includes(lower) || lower.includes(catLower);
    }) || null
  );
}

function findCategoryId(state, categoryName) {
  const exact = state.categoryMap[categoryName.toLowerCase()];
  if (exact) return exact;

  const lower = categoryName.toLowerCase();
  for (const [name, id] of Object.entries(state.categoryMap)) {
    if (name.includes(lower) || lower.includes(name)) return id;
  }
  return null;
}

async function normalizeExpenseCategory(context, expense) {
  if (!expense.category) return expense;

  const categoryNames = await getCategoryNamesForBudget(context.budgetKey);
  const matched = resolveCategoryName(expense.category, categoryNames);
  if (!matched) {
    return {
      ...expense,
      category: null,
      needsCategory: true,
    };
  }

  return {
    ...expense,
    category: matched,
    needsCategory: false,
  };
}

async function addToActual(context, expense, account) {
  try {
    return await withBudget(context.budgetKey, async (state) => {
      const categoryId = expense.category ? findCategoryId(state, expense.category) : null;
      const amount = Math.round(expense.amount * -100); // cents, negative for expense
      const today = new Date().toISOString().split('T')[0];
      const tagStr = expense.tags?.length
        ? ` | tags: ${expense.tags.map((tag) => '#' + tag).join(' ')}`
        : '';
      const notes = `Added by ${context.user.name} via Telegram to ${context.budget.label}${tagStr}`;

      await actualApi.importTransactions(account.id, [
        {
          date: today,
          amount,
          payee_name: expense.description,
          category: categoryId,
          notes,
        },
      ]);

      await actualApi.sync();

      const txns = await actualApi.getTransactions(account.id, today, today);
      const match = txns
        .slice()
        .reverse()
        .find((txn) => txn.amount === amount && txn.category === categoryId);

      return {
        synced: true,
        budgetKey: context.budgetKey,
        transactionId: match ? match.id : null,
        accountId: account.id,
        accountLabel: account.label,
        amount: expense.amount,
        category: expense.category,
        description: expense.description,
      };
    });
  } catch (err) {
    console.error(`Failed to add transaction to ${context.budget.label}:`, err.message);
    return null;
  }
}

async function getSpendingByCategory(budgetKey, startDate, endDate, accountIds) {
  return withBudget(budgetKey, async (state) => {
    const accounts = await actualApi.getAccounts();
    const categoryTotals = {};
    let grandTotal = 0;

    for (const account of accounts) {
      if (account.closed || account.offbudget) continue;
      if (accountIds && !accountIds.includes(account.id)) continue;

      const txns = await actualApi.getTransactions(account.id, startDate, endDate);
      for (const txn of txns) {
        if (txn.amount < 0) {
          grandTotal += txn.amount;
          const catName = (txn.category && state.categoryIdToName[txn.category]) || 'Uncategorized';
          categoryTotals[catName] = (categoryTotals[catName] || 0) + txn.amount;
        }
      }
    }

    return { categoryTotals, grandTotal };
  });
}

// ============================================================
// TELEGRAM BOT
// ============================================================

validateConfig();
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

const pendingExpenses = new Map();
const lastExpense = new Map();

async function sendContextError(msg, contextOrError) {
  if (contextOrError?.error) {
    await bot.sendMessage(msg.chat.id, contextOrError.error);
    return true;
  }
  return false;
}

async function getContextOrReply(msg) {
  const context = resolveBudgetContext(msg);
  if (await sendContextError(msg, context)) return null;
  return context;
}

async function downloadFile(fileId) {
  const fileLink = await bot.getFileLink(fileId);

  return new Promise((resolve, reject) => {
    const getter = fileLink.startsWith('https') ? https : http;
    getter.get(fileLink, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
  });
}

async function categoryKeyboard(context) {
  const categories = await getCategoryNamesForBudget(context.budgetKey);
  const buttons = categories.map((cat) => [{ text: cat }]);
  return { reply_markup: { keyboard: buttons, one_time_keyboard: true, resize_keyboard: true } };
}

function removeKeyboard() {
  return { reply_markup: { remove_keyboard: true } };
}

function accountKeyboard(context) {
  const buttons = context.accountKeys.map((key) => {
    const account = context.budget.accounts[key];
    return [{ text: `${account.label} (${key})` }];
  });
  return { reply_markup: { keyboard: buttons, one_time_keyboard: true, resize_keyboard: true } };
}

function extractAccount(text, context) {
  const words = text.trim().split(/\s+/);
  const lastWord = words[words.length - 1]?.toLowerCase();

  if (lastWord && context.accountKeys.includes(lastWord) && context.budget.accounts[lastWord]) {
    return {
      accountKey: lastWord,
      account: context.budget.accounts[lastWord],
      cleanText: words.slice(0, -1).join(' '),
    };
  }

  return {
    accountKey: context.defaultAccountKey,
    account: context.budget.accounts[context.defaultAccountKey],
    cleanText: text,
  };
}

function extractTags(text) {
  const tags = [];
  const tagRegex = /#([a-zA-Z0-9_]+)/g;
  let match;
  while ((match = tagRegex.exec(text)) !== null) {
    tags.push(match[1].toLowerCase());
  }
  const cleanText = text.replace(/#[a-zA-Z0-9_]+/g, '').replace(/\s+/g, ' ').trim();
  return { tags, cleanText };
}

function parseTransfer(text, context) {
  const lower = text.toLowerCase().trim();
  if (!lower.startsWith('transfer')) return null;

  const parts = lower.replace('transfer', '').trim().split(/\s+/);
  if (parts.length < 3) return null;

  const amount = parseFloat(parts[0]);
  if (isNaN(amount) || amount <= 0) return null;

  const fromKey = parts[1];
  const toKey = parts[2];
  const from = context.budget.accounts[fromKey];
  const to = context.budget.accounts[toKey];

  if (!from || !to || fromKey === toKey) return null;
  if (!context.accountKeys.includes(fromKey) || !context.accountKeys.includes(toKey)) {
    return { error: 'That transfer uses an account you do not have access to in this chat.' };
  }

  return { amount, from, fromKey, to, toKey };
}

async function confirmExpense(context, expense, account) {
  const result = await addToActual(context, expense, account);
  const synced = result && result.synced;
  const icon = synced ? 'OK' : 'Draft';
  const syncNote = synced ? '' : '\n(Not synced to Actual Budget)';

  if (result?.transactionId) {
    lastExpense.set(lastExpenseKey(context), result);
  }

  const tagLine = expense.tags?.length
    ? `\nTags: ${expense.tags.map((tag) => '#' + tag).join(' ')}`
    : '';

  await bot.sendMessage(
    context.chatId,
    `${icon} Logged, ${context.user.name}!\n\n` +
      `Budget: ${context.budget.label}\n` +
      `Amount: $${expense.amount.toFixed(2)} ${expense.currency}\n` +
      `Category: ${expense.category}\n` +
      `Account: ${account.label}\n` +
      `What: ${expense.description}${tagLine}${syncNote}`,
    removeKeyboard()
  );
}

// ============================================================
// DATE HELPERS
// ============================================================

function getMonthRanges() {
  const now = new Date();
  const thisMonthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const today = now.toISOString().split('T')[0];

  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthStart = `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, '0')}-01`;
  const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
  const lastMonthEndStr = lastMonthEnd.toISOString().split('T')[0];
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  return {
    thisMonth: { start: thisMonthStart, end: today, label: monthNames[now.getMonth()] },
    lastMonth: { start: lastMonthStart, end: lastMonthEndStr, label: monthNames[lastMonth.getMonth()] },
  };
}

function getWeekRange() {
  const now = new Date();
  const day = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1));

  return {
    start: monday.toISOString().split('T')[0],
    end: now.toISOString().split('T')[0],
    label: 'this week',
  };
}

// ============================================================
// QUERY HELPERS
// ============================================================

const QUERY_SIGNALS = [
  'how much',
  'what did',
  'what do',
  "what's",
  'whats',
  'show me',
  'tell me',
  'total',
  'spending',
  'spent',
  'summary',
  'breakdown',
  'biggest',
  'top',
  'highest',
  'compare',
  'versus',
  'vs',
];

const PERSONAL_WORDS = ['i ', "i've", 'my ', 'me ', 'mine'];

function detectPeriod(text) {
  if (/today|tonight/i.test(text)) {
    const today = new Date().toISOString().split('T')[0];
    return { start: today, end: today, label: 'today' };
  }
  if (/this week|past week|last 7/i.test(text)) return getWeekRange();
  if (/last month|previous month/i.test(text)) return getMonthRanges().lastMonth;
  return getMonthRanges().thisMonth;
}

async function detectQueryCategory(context, text) {
  const lower = text.toLowerCase();
  const categories = await getCategoryNamesForBudget(context.budgetKey);

  for (const cat of categories) {
    if (lower.includes(cat.toLowerCase())) return cat;
  }

  for (const cat of categories) {
    const words = cat.toLowerCase().split(/[\s&]+/);
    for (const word of words) {
      if (word.length > 3 && lower.includes(word)) return cat;
    }
  }

  return null;
}

function getAccountIds(context, keys) {
  return keys.map((key) => context.budget.accounts[key]?.id).filter(Boolean);
}

async function handleNaturalQuery(context, text) {
  const lower = text.toLowerCase();
  const isQuery = QUERY_SIGNALS.some((signal) => lower.includes(signal));
  if (!isQuery) return false;

  const isPersonal = PERSONAL_WORDS.some((word) => lower.includes(word));
  const accountIds = isPersonal ? getAccountIds(context, context.personalAccountKeys) : null;
  const who = isPersonal ? context.user.name : context.budget.label;
  const period = detectPeriod(lower);
  const category = await detectQueryCategory(context, lower);
  const wantsBiggest = /biggest|top|highest|most|largest/i.test(lower);
  const wantsComparison = /vs|versus|compare|compared|last month/i.test(lower);

  try {
    const data = await getSpendingByCategory(context.budgetKey, period.start, period.end, accountIds);

    if (Object.keys(data.categoryTotals).length === 0) {
      await bot.sendMessage(context.chatId, `No spending found for ${who} (${period.label}).`);
      return true;
    }

    if (category) {
      const amt = Math.abs((data.categoryTotals[category] || 0) / 100);

      if (wantsComparison) {
        const { lastMonth } = getMonthRanges();
        const lastData = await getSpendingByCategory(context.budgetKey, lastMonth.start, lastMonth.end, accountIds);
        const lastAmt = Math.abs((lastData.categoryTotals[category] || 0) / 100);
        const diff = amt - lastAmt;
        const arrow = diff > 0 ? 'up' : diff < 0 ? 'down' : 'same';

        await bot.sendMessage(
          context.chatId,
          `${who} - ${category}:\n\n` +
            `${period.label}: $${amt.toFixed(2)} (${arrow} $${Math.abs(diff).toFixed(2)})\n` +
            `Last month: $${lastAmt.toFixed(2)}`
        );
      } else {
        await bot.sendMessage(context.chatId, `${who} - ${category} (${period.label}): $${amt.toFixed(2)}`);
      }
      return true;
    }

    if (wantsBiggest) {
      const top3 = Object.entries(data.categoryTotals)
        .sort((a, b) => a[1] - b[1])
        .slice(0, 3)
        .map(([cat, amt], index) => `${index + 1}. ${cat}: $${(Math.abs(amt) / 100).toFixed(2)}`);

      await bot.sendMessage(context.chatId, `${who} - biggest expenses (${period.label}):\n\n${top3.join('\n')}`);
      return true;
    }

    const lines = Object.entries(data.categoryTotals)
      .sort((a, b) => a[1] - b[1])
      .map(([cat, amt]) => `- ${cat}: $${(Math.abs(amt) / 100).toFixed(2)}`);

    await bot.sendMessage(
      context.chatId,
      `${who} - spending (${period.label}):\n\n${lines.join('\n')}\n\nTotal: $${(
        Math.abs(data.grandTotal) / 100
      ).toFixed(2)}`
    );
    return true;
  } catch (err) {
    console.error(`NLQ error for ${context.budget.label}:`, err.message);
    await bot.sendMessage(context.chatId, `Failed to fetch spending data for ${context.budget.label}.`);
    return true;
  }
}

// ============================================================
// COMMANDS
// ============================================================

bot.onText(/\/start/, async (msg) => {
  const context = await getContextOrReply(msg);
  if (!context) return;

  await bot.sendMessage(
    msg.chat.id,
    `Hey! I'm your budget bot.\n\n` +
      `This chat routes to: ${context.budget.label}\n\n` +
      `Text expenses like:\n` +
      `"lunch 12.50"\n` +
      `"uber to office 8"\n` +
      `"groceries 45.30"\n\n` +
      `Add an account keyword at the end:\n` +
      `"lunch 12.50 credit"\n\n` +
      `Private chats update personal budget files. The configured family group updates the shared family file.\n\n` +
      `Commands: /today, /month, /spend, /fixed, /tag, /undo, /accounts, /categories, /help`
  );
});

bot.onText(/\/categories/, async (msg) => {
  const context = await getContextOrReply(msg);
  if (!context) return;

  const categories = await getCategoryNamesForBudget(context.budgetKey);
  await bot.sendMessage(msg.chat.id, `${context.budget.label} categories:\n\n${categories.map((c) => '- ' + c).join('\n')}`);
});

bot.onText(/\/accounts/, async (msg) => {
  const context = await getContextOrReply(msg);
  if (!context) return;

  const lines = context.accountKeys.map((key) => {
    const account = context.budget.accounts[key];
    const isDefault = key === context.defaultAccountKey ? ' (default)' : '';
    return `- "${key}" -> ${account.label}${isDefault}`;
  });

  await bot.sendMessage(
    msg.chat.id,
    `${context.budget.label} accounts for ${context.user.name}:\n\n${lines.join('\n')}\n\n` +
      `Add the keyword at the end of your message to pick an account. No keyword uses your default.`
  );
});

bot.onText(/\/help/, async (msg) => {
  const context = await getContextOrReply(msg);
  if (!context) return;

  await bot.sendMessage(
    msg.chat.id,
    `This chat updates ${context.budget.label}.\n\n` +
      `Examples:\n` +
      `"coffee 5.50"\n` +
      `"uber home 15 credit"\n` +
      `"dinner 45 #date"\n` +
      `"transfer 500 savings credit"\n\n` +
      `Ask questions like "what did I spend today?" or "how much did we spend this week?"`
  );
});

bot.onText(/\/today/, async (msg) => {
  const context = await getContextOrReply(msg);
  if (!context) return;

  try {
    const today = new Date().toISOString().split('T')[0];
    await withBudget(context.budgetKey, async () => {
      const accounts = await actualApi.getAccounts();
      let total = 0;
      const entries = [];

      for (const account of accounts) {
        if (account.closed || account.offbudget) continue;
        const txns = await actualApi.getTransactions(account.id, today, today);
        for (const txn of txns) {
          if (txn.amount < 0) {
            total += txn.amount;
            entries.push(`- ${txn.imported_payee || txn.payee_name || 'Unknown'}: $${(Math.abs(txn.amount) / 100).toFixed(2)}`);
          }
        }
      }

      if (entries.length === 0) {
        await bot.sendMessage(msg.chat.id, `No expenses today yet in ${context.budget.label}.`);
      } else {
        await bot.sendMessage(
          msg.chat.id,
          `${context.budget.label} today's expenses:\n\n${entries.join('\n')}\n\nTotal: $${(Math.abs(total) / 100).toFixed(2)}`
        );
      }
    });
  } catch (err) {
    console.error('Error fetching today:', err.message);
    await bot.sendMessage(msg.chat.id, `Failed to fetch today's expenses for ${context.budget.label}.`);
  }
});

bot.onText(/\/month/, async (msg) => {
  const context = await getContextOrReply(msg);
  if (!context) return;

  try {
    const { thisMonth } = getMonthRanges();
    const data = await getSpendingByCategory(context.budgetKey, thisMonth.start, thisMonth.end);

    if (data.grandTotal === 0) {
      await bot.sendMessage(msg.chat.id, `No expenses this month yet in ${context.budget.label}.`);
      return;
    }

    const breakdown = Object.entries(data.categoryTotals)
      .sort((a, b) => a[1] - b[1])
      .map(([cat, amt]) => `- ${cat}: $${(Math.abs(amt) / 100).toFixed(2)}`)
      .join('\n');

    await bot.sendMessage(
      msg.chat.id,
      `${context.budget.label} ${thisMonth.label} spending:\n\n${breakdown}\n\nTotal: $${(
        Math.abs(data.grandTotal) / 100
      ).toFixed(2)}`
    );
  } catch (err) {
    console.error('Error fetching month:', err.message);
    await bot.sendMessage(msg.chat.id, `Failed to fetch this month's expenses for ${context.budget.label}.`);
  }
});

bot.onText(/\/spend(.*)/, async (msg, match) => {
  const context = await getContextOrReply(msg);
  if (!context) return;

  const query = (match[1] || '').trim().toLowerCase();
  const { thisMonth, lastMonth } = getMonthRanges();

  try {
    const thisData = await getSpendingByCategory(context.budgetKey, thisMonth.start, thisMonth.end);
    const lastData = await getSpendingByCategory(context.budgetKey, lastMonth.start, lastMonth.end);
    const categories = await getCategoryNamesForBudget(context.budgetKey);

    if (query) {
      const matchedCat =
        Object.keys(thisData.categoryTotals).find((cat) => cat.toLowerCase().includes(query)) ||
        Object.keys(lastData.categoryTotals).find((cat) => cat.toLowerCase().includes(query)) ||
        categories.find((cat) => cat.toLowerCase().includes(query));

      if (!matchedCat) {
        await bot.sendMessage(msg.chat.id, `No category matching "${query}". Type /categories to see available categories.`);
        return;
      }

      const thisAmt = Math.abs((thisData.categoryTotals[matchedCat] || 0) / 100);
      const lastAmt = Math.abs((lastData.categoryTotals[matchedCat] || 0) / 100);

      if (thisAmt === 0 && lastAmt === 0) {
        await bot.sendMessage(msg.chat.id, `${matchedCat}: no spending logged this month or last month.`);
        return;
      }

      const diff = thisAmt - lastAmt;
      const arrow = diff > 0 ? 'up' : diff < 0 ? 'down' : 'same';
      const diffStr = diff !== 0 ? ` (${arrow} $${Math.abs(diff).toFixed(2)})` : '';

      await bot.sendMessage(
        msg.chat.id,
        `${context.budget.label} - ${matchedCat}:\n\n` +
          `${thisMonth.label}: $${thisAmt.toFixed(2)}${diffStr}\n` +
          `${lastMonth.label}: $${lastAmt.toFixed(2)}`
      );
      return;
    }

    if (Object.keys(thisData.categoryTotals).length === 0) {
      await bot.sendMessage(msg.chat.id, `No expenses this month yet in ${context.budget.label}.`);
      return;
    }

    const lines = Object.entries(thisData.categoryTotals)
      .sort((a, b) => a[1] - b[1])
      .map(([cat, amt]) => {
        const thisAmt = Math.abs(amt / 100);
        const lastAmt = Math.abs((lastData.categoryTotals[cat] || 0) / 100);
        const diff = thisAmt - lastAmt;
        const arrow = diff > 0 ? 'up' : diff < 0 ? 'down' : '';
        return `- ${cat}: $${thisAmt.toFixed(2)} ${arrow}`.trim();
      });

    await bot.sendMessage(
      msg.chat.id,
      `${context.budget.label} ${thisMonth.label} spending (vs ${lastMonth.label}):\n\n${lines.join('\n')}\n\nTotal: $${(
        Math.abs(thisData.grandTotal) / 100
      ).toFixed(2)}\n\nDrill into any category: /spend grocery`
    );
  } catch (err) {
    console.error('Error in /spend:', err.message);
    await bot.sendMessage(msg.chat.id, `Failed to fetch spending data for ${context.budget.label}.`);
  }
});

const FIXED_CATEGORIES = ['Rent', 'Utilities', 'Insurance'];

bot.onText(/\/fixed/, async (msg) => {
  const context = await getContextOrReply(msg);
  if (!context) return;

  try {
    const { thisMonth } = getMonthRanges();
    const data = await getSpendingByCategory(context.budgetKey, thisMonth.start, thisMonth.end);
    let fixedTotal = 0;
    const lines = [];

    for (const cat of FIXED_CATEGORIES) {
      const matched = Object.keys(data.categoryTotals).find((name) => name.toLowerCase() === cat.toLowerCase());
      const amt = matched ? Math.abs(data.categoryTotals[matched] / 100) : 0;
      fixedTotal += amt;
      lines.push(`- ${cat}: $${amt.toFixed(2)}${amt === 0 ? ' (not logged yet)' : ''}`);
    }

    await bot.sendMessage(
      msg.chat.id,
      `${context.budget.label} fixed monthly expenses (${thisMonth.label}):\n\n${lines.join('\n')}\n\nFixed total: $${fixedTotal.toFixed(2)}`
    );
  } catch (err) {
    console.error('Error in /fixed:', err.message);
    await bot.sendMessage(msg.chat.id, `Failed to fetch fixed expenses for ${context.budget.label}.`);
  }
});

bot.onText(/\/undo/, async (msg) => {
  const context = await getContextOrReply(msg);
  if (!context) return;

  const key = lastExpenseKey(context);
  const last = lastExpense.get(key);

  if (!last?.transactionId) {
    await bot.sendMessage(msg.chat.id, 'Nothing to undo. I can only undo the last expense you added in this chat this session.');
    return;
  }

  try {
    await withBudget(last.budgetKey, async () => {
      await actualApi.deleteTransaction(last.transactionId);
      await actualApi.sync();
    });

    lastExpense.delete(key);
    await bot.sendMessage(
      msg.chat.id,
      `Deleted from ${context.budget.label}: $${last.amount.toFixed(2)} | ${last.category} | ${last.description} (${last.accountLabel})`
    );
  } catch (err) {
    console.error('Error in /undo:', err.message);
    await bot.sendMessage(msg.chat.id, `Failed to delete the last entry from ${context.budget.label}.`);
  }
});

bot.onText(/\/tag(.*)/, async (msg, match) => {
  const context = await getContextOrReply(msg);
  if (!context) return;

  const query = (match[1] || '').trim().toLowerCase().replace('#', '');
  if (!query) {
    await bot.sendMessage(msg.chat.id, 'Which tag? Example: /tag bali');
    return;
  }

  try {
    await withBudget(context.budgetKey, async (state) => {
      const accounts = await actualApi.getAccounts();
      const entries = [];
      let total = 0;
      const now = new Date();
      const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 6, 1);
      const startDate = sixMonthsAgo.toISOString().split('T')[0];
      const endDate = now.toISOString().split('T')[0];

      for (const account of accounts) {
        if (account.closed) continue;
        const txns = await actualApi.getTransactions(account.id, startDate, endDate);
        for (const txn of txns) {
          if (txn.notes && txn.notes.toLowerCase().includes(`#${query}`)) {
            const amt = Math.abs(txn.amount / 100);
            total += amt;
            const catName = (txn.category && state.categoryIdToName[txn.category]) || '';
            entries.push(`- ${txn.date} | $${amt.toFixed(2)} | ${catName} | ${txn.imported_payee || txn.payee_name || ''}`);
          }
        }
      }

      if (entries.length === 0) {
        await bot.sendMessage(msg.chat.id, `No expenses tagged #${query} in ${context.budget.label}.`);
        return;
      }

      await bot.sendMessage(
        msg.chat.id,
        `${context.budget.label} #${query} expenses:\n\n${entries.join('\n')}\n\nTotal: $${total.toFixed(2)} (${entries.length} entries)`
      );
    });
  } catch (err) {
    console.error('Error in /tag:', err.message);
    await bot.sendMessage(msg.chat.id, `Failed to fetch tagged expenses for ${context.budget.label}.`);
  }
});

// ============================================================
// AUTOMATED MESSAGES
// ============================================================

function resolveScheduledBudgetKey(chatId, configuredBudgetKey) {
  if (configuredBudgetKey && BUDGETS[configuredBudgetKey]) return configuredBudgetKey;
  if (FAMILY_GROUP_CHAT_ID && String(chatId) === String(FAMILY_GROUP_CHAT_ID)) return 'family';

  const matchingUser = Object.entries(USERS).find(([userId]) => String(userId) === String(chatId));
  if (matchingUser) return matchingUser[1].personalBudgetKey;

  return 'family';
}

function startWeeklySummary() {
  if (!WEEKLY_SUMMARY_CHAT_ID) {
    console.log('Weekly summary disabled (WEEKLY_SUMMARY_CHAT_ID not set).');
    return;
  }

  const budgetKey = resolveScheduledBudgetKey(WEEKLY_SUMMARY_CHAT_ID, process.env.WEEKLY_SUMMARY_BUDGET_KEY || process.env.WEEKLY_SUMMARY_BUDGET);
  let lastSummaryDate = '';

  setInterval(async () => {
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    if (now.getDay() !== 0 || now.getHours() !== 20) return;
    if (lastSummaryDate === todayStr) return;

    lastSummaryDate = todayStr;

    try {
      const week = getWeekRange();
      const data = await getSpendingByCategory(budgetKey, week.start, week.end);
      if (Object.keys(data.categoryTotals).length === 0) return;

      const lines = Object.entries(data.categoryTotals)
        .sort((a, b) => a[1] - b[1])
        .map(([cat, amt]) => `- ${cat}: $${(Math.abs(amt) / 100).toFixed(2)}`);

      await bot.sendMessage(
        WEEKLY_SUMMARY_CHAT_ID,
        `${BUDGETS[budgetKey].label} weekly spending summary (${week.start} to ${week.end}):\n\n${lines.join('\n')}\n\nTotal: $${(
          Math.abs(data.grandTotal) / 100
        ).toFixed(2)}`
      );
    } catch (err) {
      console.error('Weekly summary error:', err.message);
    }
  }, 60 * 60 * 1000);

  console.log(`Weekly summary enabled for ${BUDGETS[budgetKey]?.label || budgetKey} (Sunday 8 PM).`);
}

function startDailyNudge() {
  const chatId = DAILY_NUDGE_CHAT_ID || WEEKLY_SUMMARY_CHAT_ID;
  if (!chatId) {
    console.log('Daily nudge disabled (DAILY_NUDGE_CHAT_ID or WEEKLY_SUMMARY_CHAT_ID not set).');
    return;
  }

  const budgetKey = resolveScheduledBudgetKey(chatId, process.env.DAILY_NUDGE_BUDGET_KEY || process.env.DAILY_NUDGE_BUDGET);
  let lastNudgeDate = '';

  setInterval(async () => {
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    if (now.getHours() !== 22) return;
    if (lastNudgeDate === todayStr) return;

    lastNudgeDate = todayStr;

    try {
      const todayStats = await withBudget(budgetKey, async () => {
        const accounts = await actualApi.getAccounts();
        let todayTotal = 0;
        let todayCount = 0;

        for (const account of accounts) {
          if (account.closed || account.offbudget) continue;
          const txns = await actualApi.getTransactions(account.id, todayStr, todayStr);
          for (const txn of txns) {
            if (txn.amount < 0) {
              todayTotal += txn.amount;
              todayCount++;
            }
          }
        }

        return { todayTotal, todayCount };
      });

      const { thisMonth } = getMonthRanges();
      const monthData = await getSpendingByCategory(budgetKey, thisMonth.start, thisMonth.end);
      const monthTotal = Math.abs(monthData.grandTotal / 100);

      if (todayStats.todayCount === 0) {
        await bot.sendMessage(chatId, `${BUDGETS[budgetKey].label}: no expenses logged today. Month so far: $${monthTotal.toFixed(2)}`);
      } else {
        const todayAmt = Math.abs(todayStats.todayTotal / 100);
        await bot.sendMessage(
          chatId,
          `${BUDGETS[budgetKey].label}: today $${todayAmt.toFixed(2)} across ${todayStats.todayCount} expense${todayStats.todayCount > 1 ? 's' : ''}. Month so far: $${monthTotal.toFixed(2)}`
        );
      }
    } catch (err) {
      console.error('Daily nudge error:', err.message);
    }
  }, 15 * 60 * 1000);

  console.log(`Daily nudge enabled for ${BUDGETS[budgetKey]?.label || budgetKey} (10 PM).`);
}

// ============================================================
// PHOTO HANDLER
// ============================================================

bot.on('photo', async (msg) => {
  const context = await getContextOrReply(msg);
  if (!context) return;

  await bot.sendMessage(context.chatId, `Reading your receipt for ${context.budget.label}...`);

  try {
    const photo = msg.photo[msg.photo.length - 1];
    const imageBuffer = await downloadFile(photo.file_id);
    let result = await parseReceipt(imageBuffer, context.budgetKey);

    if (result.error) {
      await bot.sendMessage(context.chatId, `Could not read receipt: ${result.error}`);
      return;
    }

    result = await normalizeExpenseCategory(context, result);
    const defaultAccount = context.budget.accounts[context.defaultAccountKey];
    pendingExpenses.set(pendingKey(context), {
      ...result,
      step: result.needsAmount ? 'amount' : result.needsCategory ? 'category' : 'account',
      accountKey: context.defaultAccountKey,
      account: defaultAccount,
    });

    if (result.needsAmount) {
      await bot.sendMessage(context.chatId, `I found "${result.description}" but could not read the total.\n\nHow much was it?`);
      return;
    }

    if (result.needsCategory) {
      await bot.sendMessage(
        context.chatId,
        `Got $${result.amount.toFixed(2)} from "${result.description}" but not sure about the category.\n\nPick one:`,
        await categoryKeyboard(context)
      );
      return;
    }

    await bot.sendMessage(
      context.chatId,
      `Got $${result.amount.toFixed(2)} | ${result.category} | "${result.description}"\n\nWhich account?`,
      accountKeyboard(context)
    );
  } catch (err) {
    console.error('Photo handler error:', err.message);
    await bot.sendMessage(context.chatId, 'Something went wrong reading that receipt. Try again or type the expense manually.');
  }
});

// ============================================================
// TEXT MESSAGE HANDLER
// ============================================================

bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  if (msg.photo) return;

  const context = await getContextOrReply(msg);
  if (!context) return;

  const key = pendingKey(context);
  const pending = pendingExpenses.get(key);

  if (pending) {
    const cancelWords = ['cancel', 'nevermind', 'never mind', 'forget it', 'forget', 'nvm', 'stop', 'skip', 'nah', 'no'];
    if (cancelWords.includes(msg.text.trim().toLowerCase())) {
      pendingExpenses.delete(key);
      await bot.sendMessage(context.chatId, 'Cancelled.', removeKeyboard());
      return;
    }

    if (pending.step === 'account') {
      const selectedKey = context.accountKeys.find((accountKey) => {
        const account = context.budget.accounts[accountKey];
        const label = `${account.label} (${accountKey})`;
        const text = msg.text.trim().toLowerCase();
        return text === label.toLowerCase() || text === accountKey;
      });

      if (selectedKey) pending.account = context.budget.accounts[selectedKey];
      pendingExpenses.delete(key);
      await confirmExpense(context, pending, pending.account);
      return;
    }

    if (pending.step === 'amount') {
      const amount = parseFloat(msg.text.replace(/[^0-9.]/g, ''));
      if (isNaN(amount) || amount <= 0) {
        await bot.sendMessage(context.chatId, 'That does not look like a number. How much was it?');
        return;
      }

      pending.amount = amount;
      pending.needsAmount = false;

      if (pending.needsCategory) {
        pending.step = 'category';
        await bot.sendMessage(context.chatId, `Got $${amount.toFixed(2)}. What category?`, await categoryKeyboard(context));
        return;
      }

      if (pending.ocrPreview !== undefined) {
        pending.step = 'account';
        await bot.sendMessage(context.chatId, 'Which account?', accountKeyboard(context));
        return;
      }

      pendingExpenses.delete(key);
      await confirmExpense(context, pending, pending.account);
      return;
    }

    if (pending.step === 'category') {
      const categories = await getCategoryNamesForBudget(context.budgetKey);
      const selected = resolveCategoryName(msg.text.trim(), categories);

      if (!selected) {
        await bot.sendMessage(context.chatId, 'Pick a category from the list:', await categoryKeyboard(context));
        return;
      }

      pending.category = selected;
      pending.needsCategory = false;

      if (pending.description && pending.description !== 'expense') {
        learnKeyword(context.budgetKey, pending.description, selected);
        console.log(`Learned for ${context.budget.label}: "${pending.description}" -> ${selected}`);
      }

      if (pending.needsAmount) {
        pending.step = 'amount';
        await bot.sendMessage(context.chatId, `Category: ${selected}. How much was it?`, removeKeyboard());
        return;
      }

      if (pending.ocrPreview !== undefined) {
        pending.step = 'account';
        await bot.sendMessage(context.chatId, 'Which account?', accountKeyboard(context));
        return;
      }

      pendingExpenses.delete(key);
      await confirmExpense(context, pending, pending.account);
      return;
    }
  }

  const wasQuery = await handleNaturalQuery(context, msg.text);
  if (wasQuery) return;

  const transfer = parseTransfer(msg.text, context);
  if (transfer?.error) {
    await bot.sendMessage(context.chatId, transfer.error);
    return;
  }

  if (transfer) {
    try {
      await withBudget(context.budgetKey, async () => {
        const today = new Date().toISOString().split('T')[0];
        const amountCents = Math.round(transfer.amount * 100);

        await actualApi.importTransactions(transfer.from.id, [
          {
            date: today,
            amount: -amountCents,
            payee_name: `Transfer to ${transfer.to.label}`,
            notes: `Transfer by ${context.user.name} via Telegram to ${context.budget.label}`,
          },
        ]);

        await actualApi.importTransactions(transfer.to.id, [
          {
            date: today,
            amount: amountCents,
            payee_name: `Transfer from ${transfer.from.label}`,
            notes: `Transfer by ${context.user.name} via Telegram to ${context.budget.label}`,
          },
        ]);

        await actualApi.sync();
      });

      await bot.sendMessage(
        context.chatId,
        `Transferred $${transfer.amount.toFixed(2)} in ${context.budget.label}\n\n` +
          `From: ${transfer.from.label}\n` +
          `To: ${transfer.to.label}`
      );
    } catch (err) {
      console.error('Transfer error:', err.message);
      await bot.sendMessage(context.chatId, `Failed to process transfer in ${context.budget.label}.`);
    }
    return;
  }

  const { tags, cleanText: textWithoutTags } = extractTags(msg.text);
  const { account, cleanText } = extractAccount(textWithoutTags, context);
  let expense = parseExpenseText(cleanText, context.budgetKey);
  expense = await normalizeExpenseCategory(context, expense);
  expense.tags = tags;

  if (expense.needsAmount && expense.needsCategory) {
    pendingExpenses.set(key, { ...expense, account, step: 'category' });
    await bot.sendMessage(
      context.chatId,
      `I couldn't match a category for "${expense.description}". Pick one from ${context.budget.label}:`,
      await categoryKeyboard(context)
    );
    return;
  }

  if (expense.needsAmount) {
    pendingExpenses.set(key, { ...expense, account, step: 'amount' });
    await bot.sendMessage(context.chatId, `Got it, "${expense.description}" under ${expense.category} (${account.label}). How much?`);
    return;
  }

  if (expense.needsCategory) {
    pendingExpenses.set(key, { ...expense, account, step: 'category' });
    await bot.sendMessage(
      context.chatId,
      `$${expense.amount.toFixed(2)} for "${expense.description}" (${account.label}). What category?`,
      await categoryKeyboard(context)
    );
    return;
  }

  await confirmExpense(context, expense, account);
});

// ============================================================
// STARTUP
// ============================================================

async function main() {
  console.log('Starting Budget Bot...');
  console.log('---');

  const visionOk = initVision();
  if (!visionOk) console.log('Receipt scanning disabled. Set GOOGLE_APPLICATION_CREDENTIALS to enable.');

  for (const budgetKey of Object.keys(BUDGETS)) {
    loadLearnedKeywords(budgetKey);
  }

  await initActualBudgets();

  startWeeklySummary();
  startDailyNudge();

  console.log('---');
  console.log('Bot is running. Private chats use personal budgets; the configured group uses the family budget.');
}

main().catch(console.error);
