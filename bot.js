import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import * as actualApi from '@actual-app/api';
import { parseExpenseText, ALL_CATEGORIES, learnKeyword, loadLearnedKeywords } from './parser.js';
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
  ACTUAL_SYNC_ID,
  ACTUAL_ENCRYPTION_PASSWORD,
  USER1_TELEGRAM_ID,
  USER2_TELEGRAM_ID,
  // Account IDs from Actual Budget
  ACCOUNT_USER1_SAVINGS,
  ACCOUNT_USER1_CREDIT,
  ACCOUNT_USER2_SAVINGS,
  ACCOUNT_JOINT,
} = process.env;

// ------------------------------------------------------------
// ACCOUNT ROUTING
//
// Configure your accounts here. Each entry needs:
// - A short keyword (typed at the end of a message to select it)
// - The Actual Budget account ID (from your .env)
// - A display label
//
// Customize these to match your household's bank accounts
// and credit cards.
// ------------------------------------------------------------

const ACCOUNTS = {
  'savings': { id: ACCOUNT_USER1_SAVINGS, label: 'Savings Account' },
  'credit':  { id: ACCOUNT_USER1_CREDIT,  label: 'Credit Card' },
  'her':     { id: ACCOUNT_USER2_SAVINGS, label: 'Partner Savings' },
  'joint':   { id: ACCOUNT_JOINT,         label: 'Joint Account' },
};

// ------------------------------------------------------------
// USER MAPPING
//
// Map each household member's Telegram user ID to:
// - name: Display name used in bot replies
// - defaultAccount: Which account keyword to use when none specified
// - accounts: Which account keywords this person can use
// ------------------------------------------------------------

const USER_MAP = {
  [USER1_TELEGRAM_ID]: {
    name: 'User 1',
    defaultAccount: 'savings',
    accounts: ['savings', 'credit', 'joint'],
  },
  [USER2_TELEGRAM_ID]: {
    name: 'User 2',
    defaultAccount: 'her',
    accounts: ['her', 'joint'],
  },
};

// Detect and strip account keyword from end of message
function extractAccount(text, user) {
  const words = text.trim().split(/\s+/);
  const lastWord = words[words.length - 1].toLowerCase();

  // Check if last word matches an account keyword the user has access to
  if (user.accounts.includes(lastWord) && ACCOUNTS[lastWord]) {
    return {
      accountKey: lastWord,
      account: ACCOUNTS[lastWord],
      cleanText: words.slice(0, -1).join(' '),
    };
  }

  // No keyword found, use default
  const defaultKey = user.defaultAccount;
  return {
    accountKey: defaultKey,
    account: ACCOUNTS[defaultKey],
    cleanText: text,
  };
}

// Extract #tags from message and return cleaned text + tags array
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

// Detect transfer command: "transfer 500 savings credit"
function parseTransfer(text) {
  const lower = text.toLowerCase().trim();
  if (!lower.startsWith('transfer')) return null;

  const parts = lower.replace('transfer', '').trim().split(/\s+/);
  if (parts.length < 3) return null;

  // Find the amount
  const amount = parseFloat(parts[0]);
  if (isNaN(amount) || amount <= 0) return null;

  // Find source and destination account keywords
  const fromKey = parts[1];
  const toKey = parts[2];

  if (!ACCOUNTS[fromKey] || !ACCOUNTS[toKey]) return null;
  if (fromKey === toKey) return null;

  return {
    amount,
    from: ACCOUNTS[fromKey],
    fromKey,
    to: ACCOUNTS[toKey],
    toKey,
  };
}

// Temporary storage for expenses waiting for user input (category/amount)
const pendingExpenses = new Map();

// Track last added transaction per user (for /undo)
const lastExpense = new Map();

// ============================================================
// ACTUAL BUDGET
// ============================================================

let actualReady = false;
let categoryMap = {}; // name (lowercase) -> id
let categoryIdToName = {}; // id -> name (for transaction lookups)

async function initActual() {
  try {
    mkdirSync('/tmp/actual-data', { recursive: true });

    await actualApi.init({
      dataDir: '/tmp/actual-data',
      serverURL: ACTUAL_SERVER_URL,
      password: ACTUAL_SERVER_PASSWORD,
    });

    const downloadOpts = ACTUAL_ENCRYPTION_PASSWORD
      ? { password: ACTUAL_ENCRYPTION_PASSWORD }
      : undefined;

    await actualApi.downloadBudget(ACTUAL_SYNC_ID, downloadOpts);

    const categories = await actualApi.getCategories();
    for (const cat of categories) {
      if (cat.name) {
        categoryMap[cat.name.toLowerCase()] = cat.id;
        categoryIdToName[cat.id] = cat.name;
      }
    }

    actualReady = true;
    console.log('Actual Budget connected.');
    console.log('Categories found:', Object.keys(categoryMap).join(', '));
  } catch (err) {
    console.error('Failed to connect to Actual Budget:', err.message);
    console.log('Bot will run in dry-run mode (expenses shown but not synced).');
  }
}

function findCategoryId(categoryName) {
  const exact = categoryMap[categoryName.toLowerCase()];
  if (exact) return exact;

  const lower = categoryName.toLowerCase();
  for (const [name, id] of Object.entries(categoryMap)) {
    if (name.includes(lower) || lower.includes(name)) return id;
  }
  return null;
}

async function addToActual(expense, user, account) {
  if (!actualReady) return null;

  try {
    const categoryId = findCategoryId(expense.category);
    const amount = Math.round(expense.amount * -100); // cents, negative for expense
    const today = new Date().toISOString().split('T')[0];

    // Build notes with tags if present
    const tagStr = expense.tags && expense.tags.length > 0
      ? ` | tags: ${expense.tags.map((t) => '#' + t).join(' ')}`
      : '';
    const notes = `Added by ${user.name} via Telegram${tagStr}`;

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

    // Find the transaction we just added to get its ID (for /undo)
    const txns = await actualApi.getTransactions(account.id, today, today);
    const match = txns.find(
      (t) => t.amount === amount && t.category === categoryId
    );

    return {
      synced: true,
      transactionId: match ? match.id : null,
      accountId: account.id,
      accountLabel: account.label,
      amount: expense.amount,
      category: expense.category,
      description: expense.description,
    };
  } catch (err) {
    console.error('Failed to add transaction:', err.message);
    return null;
  }
}

// ============================================================
// TELEGRAM BOT
// ============================================================

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// Helper: download a file from Telegram
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

// Helper: build category keyboard
function categoryKeyboard() {
  const buttons = ALL_CATEGORIES.map((cat) => [{ text: cat }]);
  return { reply_markup: { keyboard: buttons, one_time_keyboard: true, resize_keyboard: true } };
}

// Helper: remove keyboard
function removeKeyboard() {
  return { reply_markup: { remove_keyboard: true } };
}

// Helper: confirm and log expense
async function confirmExpense(chatId, userId, expense, account) {
  const user = USER_MAP[String(userId)];
  const result = await addToActual(expense, user, account);

  const synced = result && result.synced;
  const icon = synced ? '✅' : '📝';
  const syncNote = synced ? '' : '\n(Not synced to Actual Budget)';

  // Store for /undo
  if (result && result.transactionId) {
    lastExpense.set(String(userId), result);
  }

  const tagLine = expense.tags && expense.tags.length > 0
    ? `\nTags: ${expense.tags.map((t) => '#' + t).join(' ')}`
    : '';

  bot.sendMessage(
    chatId,
    `${icon} Logged, ${user.name}!\n\n` +
      `Amount: $${expense.amount.toFixed(2)} ${expense.currency}\n` +
      `Category: ${expense.category}\n` +
      `Account: ${account.label}\n` +
      `What: ${expense.description}${tagLine}${syncNote}`,
    removeKeyboard()
  );
}

// ------ COMMANDS ------

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `Hey! I'm your budget bot.\n\n` +
      `Just text me expenses like:\n` +
      `"lunch 12.50"\n` +
      `"uber to office 8"\n` +
      `"groceries 45.30"\n\n` +
      `Add a card keyword at the end to pick the account:\n` +
      `"lunch 12.50 credit"\n` +
      `"groceries 67 joint"\n\n` +
      `Or snap a photo of a receipt and I'll read it.\n\n` +
      `Add #tags to track trips or projects:\n` +
      `"dinner 45 #bali"\n` +
      `"flights 300 #bali"\n\n` +
      `Transfer between accounts:\n` +
      `"transfer 500 savings credit"\n\n` +
      `Ask me questions like:\n` +
      `"how much on food this month?"\n` +
      `"what did I spend today?"\n\n` +
      `Commands:\n` +
      `/today - today's expenses\n` +
      `/month - this month's spending\n` +
      `/spend - all categories ranked\n` +
      `/spend grocery - drill into one category\n` +
      `/fixed - recurring costs (rent, help, utilities, insurance)\n` +
      `/tag bali - see all expenses with a tag\n` +
      `/undo - delete your last added expense\n` +
      `/accounts - your accounts and keywords\n` +
      `/categories - see all categories\n` +
      `/help - how to use me`
  );
});

bot.onText(/\/categories/, (msg) => {
  bot.sendMessage(msg.chat.id, `Categories:\n\n${ALL_CATEGORIES.map((c) => '- ' + c).join('\n')}`);
});

bot.onText(/\/accounts/, (msg) => {
  const userId = String(msg.from.id);
  const user = USER_MAP[userId];

  if (!user) {
    bot.sendMessage(msg.chat.id, 'I don\'t recognize you.');
    return;
  }

  const lines = user.accounts.map((key) => {
    const isDefault = key === user.defaultAccount ? ' (default)' : '';
    return `- "${key}" -> ${ACCOUNTS[key].label}${isDefault}`;
  });

  bot.sendMessage(
    msg.chat.id,
    `Your accounts, ${user.name}:\n\n${lines.join('\n')}\n\n` +
      `Add the keyword at the end of your message to pick an account.\n` +
      `Example: "lunch 12.50 credit"\n\n` +
      `No keyword = logs to your default.`
  );
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `Text me expenses naturally:\n\n` +
      `"coffee 5.50" -> Food & Drinks (default account)\n` +
      `"uber home 15 credit" -> Transportation (Credit Card)\n` +
      `"groceries 67 joint" -> Groceries (Joint Account)\n` +
      `"netflix 16.98" -> Subscriptions (default account)\n` +
      `"dinner 45 #date" -> Food & Drinks, tagged #date\n\n` +
      `Transfers: "transfer 500 savings credit"\n\n` +
      `Ask me questions:\n\n` +
      `"how much on food this month?"\n` +
      `"what did I spend today?"\n` +
      `"what's our biggest expense?"\n` +
      `"how much did we spend this week?"\n\n` +
      `Receipt photos, /tag, /undo, /accounts all work too.`
  );
});

bot.onText(/\/today/, async (msg) => {
  if (!actualReady) {
    bot.sendMessage(msg.chat.id, 'Actual Budget is not connected.');
    return;
  }

  try {
    const today = new Date().toISOString().split('T')[0];
    const accounts = await actualApi.getAccounts();
    let total = 0;
    let entries = [];

    for (const account of accounts) {
      if (account.closed || account.offbudget) continue;
      const txns = await actualApi.getTransactions(account.id, today, today);
      for (const t of txns) {
        if (t.amount < 0) {
          total += t.amount;
          entries.push(
            `- ${t.imported_payee || t.payee_name || 'Unknown'}: $${(Math.abs(t.amount) / 100).toFixed(2)}`
          );
        }
      }
    }

    if (entries.length === 0) {
      bot.sendMessage(msg.chat.id, 'No expenses today yet!');
    } else {
      bot.sendMessage(
        msg.chat.id,
        `Today's expenses:\n\n${entries.join('\n')}\n\nTotal: $${(Math.abs(total) / 100).toFixed(2)}`
      );
    }
  } catch (err) {
    console.error('Error fetching today:', err.message);
    bot.sendMessage(msg.chat.id, 'Failed to fetch today\'s expenses.');
  }
});

bot.onText(/\/month/, async (msg) => {
  if (!actualReady) {
    bot.sendMessage(msg.chat.id, 'Actual Budget is not connected.');
    return;
  }

  try {
    const now = new Date();
    const startOfMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const today = now.toISOString().split('T')[0];
    const accounts = await actualApi.getAccounts();
    let categoryTotals = {};
    let grandTotal = 0;

    for (const account of accounts) {
      if (account.closed || account.offbudget) continue;
      const txns = await actualApi.getTransactions(account.id, startOfMonth, today);
      for (const t of txns) {
        if (t.amount < 0) {
          grandTotal += t.amount;
          const catName = (t.category && categoryIdToName[t.category]) || 'Uncategorized';
          categoryTotals[catName] = (categoryTotals[catName] || 0) + t.amount;
        }
      }
    }

    if (grandTotal === 0) {
      bot.sendMessage(msg.chat.id, 'No expenses this month yet.');
    } else {
      const breakdown = Object.entries(categoryTotals)
        .sort((a, b) => a[1] - b[1])
        .map(([cat, amt]) => `- ${cat}: $${(Math.abs(amt) / 100).toFixed(2)}`)
        .join('\n');

      bot.sendMessage(
        msg.chat.id,
        `This month's spending:\n\n${breakdown}\n\nTotal: $${(Math.abs(grandTotal) / 100).toFixed(2)}`
      );
    }
  } catch (err) {
    console.error('Error fetching month:', err.message);
    bot.sendMessage(msg.chat.id, 'Failed to fetch this month\'s expenses.');
  }
});

// Helper: get all expenses in a date range grouped by category
// Optional: accountIds array to filter by specific accounts (for per-person queries)
async function getSpendingByCategory(startDate, endDate, accountIds) {
  const accounts = await actualApi.getAccounts();
  const categoryTotals = {};
  let grandTotal = 0;

  for (const account of accounts) {
    if (account.closed || account.offbudget) continue;
    // If accountIds provided, only include those accounts
    if (accountIds && !accountIds.includes(account.id)) continue;
    const txns = await actualApi.getTransactions(account.id, startDate, endDate);
    for (const t of txns) {
      if (t.amount < 0) {
        grandTotal += t.amount;
        const catName = (t.category && categoryIdToName[t.category]) || 'Uncategorized';
        categoryTotals[catName] = (categoryTotals[catName] || 0) + t.amount;
      }
    }
  }

  return { categoryTotals, grandTotal };
}

// Helper: get this month and last month date ranges
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

// Helper: get this week's date range (Monday to today)
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
// NATURAL LANGUAGE QUERY PARSER
// Detects questions about spending and answers them.
// Returns true if the message was a query, false if not.
// ============================================================

// Words that signal "this is a question, not an expense"
const QUERY_SIGNALS = [
  'how much', 'what did', 'what do', 'what\'s', 'whats',
  'show me', 'tell me', 'total', 'spending', 'spent',
  'summary', 'breakdown', 'biggest', 'top', 'highest',
  'compare', 'versus', 'vs',
];

// Words that mean "just me"
const PERSONAL_WORDS = ['i ', 'i\'ve', 'my ', 'me ', 'mine'];

// Words that mean "everybody"
const SHARED_WORDS = ['we ', 'we\'ve', 'our ', 'us '];

// Time period detection
function detectPeriod(text) {
  if (/today|tonight/i.test(text)) {
    const today = new Date().toISOString().split('T')[0];
    return { start: today, end: today, label: 'today' };
  }
  if (/this week|past week|last 7/i.test(text)) {
    return getWeekRange();
  }
  if (/last month|previous month/i.test(text)) {
    return getMonthRanges().lastMonth;
  }
  // Default: this month
  return getMonthRanges().thisMonth;
}

// Detect which category is being asked about
function detectQueryCategory(text) {
  const lower = text.toLowerCase();
  // Check against all known categories
  for (const cat of ALL_CATEGORIES) {
    if (lower.includes(cat.toLowerCase())) return cat;
  }
  // Check partial matches (e.g., "food" matches "Food & Drinks")
  for (const cat of ALL_CATEGORIES) {
    const words = cat.toLowerCase().split(/[\s&]+/);
    for (const word of words) {
      if (word.length > 3 && lower.includes(word)) return cat;
    }
  }
  return null;
}

// Get account IDs for a specific user
function getUserAccountIds(user) {
  return user.accounts.map((key) => ACCOUNTS[key]?.id).filter(Boolean);
}

async function handleNaturalQuery(chatId, text, user) {
  if (!actualReady) return false;

  const lower = text.toLowerCase();

  // Check if this looks like a question
  const isQuery = QUERY_SIGNALS.some((signal) => lower.includes(signal));
  if (!isQuery) return false;

  // Detect: personal or shared?
  const isPersonal = PERSONAL_WORDS.some((w) => lower.includes(w));
  const accountIds = isPersonal ? getUserAccountIds(user) : null;
  const who = isPersonal ? user.name : 'Household';

  // Detect time period
  const period = detectPeriod(lower);

  // Detect category
  const category = detectQueryCategory(lower);

  // Detect query type
  const wantsBiggest = /biggest|top|highest|most|largest/i.test(lower);
  const wantsComparison = /vs|versus|compare|compared|last month/i.test(lower);

  try {
    const data = await getSpendingByCategory(period.start, period.end, accountIds);

    // No spending found
    if (Object.keys(data.categoryTotals).length === 0) {
      bot.sendMessage(chatId, `No spending found for ${who} (${period.label}).`);
      return true;
    }

    // Specific category query
    if (category) {
      const amt = Math.abs((data.categoryTotals[category] || 0) / 100);

      if (wantsComparison) {
        const { lastMonth } = getMonthRanges();
        const lastData = await getSpendingByCategory(lastMonth.start, lastMonth.end, accountIds);
        const lastAmt = Math.abs((lastData.categoryTotals[category] || 0) / 100);
        const diff = amt - lastAmt;
        const arrow = diff > 0 ? '↑' : diff < 0 ? '↓' : '→';

        bot.sendMessage(
          chatId,
          `${who} - ${category}:\n\n` +
            `${period.label}: $${amt.toFixed(2)} (${arrow} $${Math.abs(diff).toFixed(2)})\n` +
            `Last month: $${lastAmt.toFixed(2)}`
        );
      } else {
        bot.sendMessage(chatId, `${who} - ${category} (${period.label}): $${amt.toFixed(2)}`);
      }
      return true;
    }

    // Biggest expense query
    if (wantsBiggest) {
      const sorted = Object.entries(data.categoryTotals).sort((a, b) => a[1] - b[1]);
      const [topCat, topAmt] = sorted[0];
      const top3 = sorted.slice(0, 3).map(
        ([cat, amt], i) => `${i + 1}. ${cat}: $${(Math.abs(amt) / 100).toFixed(2)}`
      );

      bot.sendMessage(
        chatId,
        `${who} - biggest expenses (${period.label}):\n\n${top3.join('\n')}`
      );
      return true;
    }

    // General spending query
    const lines = Object.entries(data.categoryTotals)
      .sort((a, b) => a[1] - b[1])
      .map(([cat, amt]) => `- ${cat}: $${(Math.abs(amt) / 100).toFixed(2)}`);

    bot.sendMessage(
      chatId,
      `${who} - spending (${period.label}):\n\n${lines.join('\n')}\n\nTotal: $${(Math.abs(data.grandTotal) / 100).toFixed(2)}`
    );
    return true;
  } catch (err) {
    console.error('NLQ error:', err.message);
    return false;
  }
}

// ============================================================
// WEEKLY AUTO-SUMMARY
// Sends a spending summary to the group every Sunday at 8 PM
// ============================================================

const WEEKLY_SUMMARY_CHAT_ID = process.env.WEEKLY_SUMMARY_CHAT_ID;

function startWeeklySummary() {
  if (!WEEKLY_SUMMARY_CHAT_ID) {
    console.log('Weekly summary disabled (WEEKLY_SUMMARY_CHAT_ID not set).');
    return;
  }

  // Check every hour if it's Sunday 8 PM
  setInterval(async () => {
    const now = new Date();
    if (now.getDay() === 0 && now.getHours() === 20) {
      try {
        const week = getWeekRange();
        const data = await getSpendingByCategory(week.start, week.end);

        if (Object.keys(data.categoryTotals).length === 0) return;

        const lines = Object.entries(data.categoryTotals)
          .sort((a, b) => a[1] - b[1])
          .map(([cat, amt]) => `- ${cat}: $${(Math.abs(amt) / 100).toFixed(2)}`);

        bot.sendMessage(
          WEEKLY_SUMMARY_CHAT_ID,
          `📊 Weekly spending summary (${week.start} to ${week.end}):\n\n${lines.join('\n')}\n\nTotal: $${(Math.abs(data.grandTotal) / 100).toFixed(2)}`
        );
      } catch (err) {
        console.error('Weekly summary error:', err.message);
      }
    }
  }, 60 * 60 * 1000); // check every hour

  console.log('Weekly summary enabled (Sunday 8 PM).');
}

// ============================================================
// DAILY NUDGE
// Sends a one-liner at 10 PM with today's spending
// ============================================================

const DAILY_NUDGE_CHAT_ID = process.env.DAILY_NUDGE_CHAT_ID || WEEKLY_SUMMARY_CHAT_ID;

function startDailyNudge() {
  if (!DAILY_NUDGE_CHAT_ID) {
    console.log('Daily nudge disabled (DAILY_NUDGE_CHAT_ID or WEEKLY_SUMMARY_CHAT_ID not set).');
    return;
  }

  let lastNudgeDate = '';

  // Check every 15 minutes if it's 10 PM
  setInterval(async () => {
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];

    // Only send once per day, at 10 PM (hour 22)
    if (now.getHours() !== 22) return;
    if (lastNudgeDate === todayStr) return;
    if (!actualReady) return;

    lastNudgeDate = todayStr;

    try {
      const accounts = await actualApi.getAccounts();
      let todayTotal = 0;
      let todayCount = 0;

      for (const account of accounts) {
        if (account.closed || account.offbudget) continue;
        const txns = await actualApi.getTransactions(account.id, todayStr, todayStr);
        for (const t of txns) {
          if (t.amount < 0) {
            todayTotal += t.amount;
            todayCount++;
          }
        }
      }

      // Get month-to-date total
      const { thisMonth } = getMonthRanges();
      const monthData = await getSpendingByCategory(thisMonth.start, thisMonth.end);
      const monthTotal = Math.abs(monthData.grandTotal / 100);

      if (todayCount === 0) {
        bot.sendMessage(
          DAILY_NUDGE_CHAT_ID,
          `No expenses logged today. Month so far: $${monthTotal.toFixed(2)}`
        );
      } else {
        const todayAmt = Math.abs(todayTotal / 100);
        bot.sendMessage(
          DAILY_NUDGE_CHAT_ID,
          `Today: $${todayAmt.toFixed(2)} across ${todayCount} expense${todayCount > 1 ? 's' : ''}. Month so far: $${monthTotal.toFixed(2)}`
        );
      }
    } catch (err) {
      console.error('Daily nudge error:', err.message);
    }
  }, 15 * 60 * 1000); // check every 15 minutes

  console.log('Daily nudge enabled (10 PM).');
}

// /spend - category breakdown with optional specific category
// Usage: /spend (all categories) or /spend grocery or /spend food
bot.onText(/\/spend(.*)/, async (msg, match) => {
  if (!actualReady) {
    bot.sendMessage(msg.chat.id, 'Actual Budget is not connected.');
    return;
  }

  const query = (match[1] || '').trim().toLowerCase();
  const { thisMonth, lastMonth } = getMonthRanges();

  try {
    const thisData = await getSpendingByCategory(thisMonth.start, thisMonth.end);
    const lastData = await getSpendingByCategory(lastMonth.start, lastMonth.end);

    // If a specific category is requested
    if (query) {
      // Find matching category - check transaction data AND Actual Budget's category list
      const matchedCat = Object.keys(thisData.categoryTotals).find(
        (c) => c.toLowerCase().includes(query)
      ) || Object.keys(lastData.categoryTotals).find(
        (c) => c.toLowerCase().includes(query)
      ) || ALL_CATEGORIES.find(
        (c) => c.toLowerCase().includes(query)
      );

      if (!matchedCat) {
        bot.sendMessage(msg.chat.id, `No category matching "${query}". Type /categories to see available categories.`);
        return;
      }

      const thisAmt = Math.abs((thisData.categoryTotals[matchedCat] || 0) / 100);
      const lastAmt = Math.abs((lastData.categoryTotals[matchedCat] || 0) / 100);

      if (thisAmt === 0 && lastAmt === 0) {
        bot.sendMessage(msg.chat.id, `${matchedCat}: no spending logged yet this month or last month.`);
        return;
      }

      const diff = thisAmt - lastAmt;
      const arrow = diff > 0 ? '↑' : diff < 0 ? '↓' : '→';
      const diffStr = diff !== 0 ? ` (${arrow} $${Math.abs(diff).toFixed(2)})` : '';

      bot.sendMessage(
        msg.chat.id,
        `${matchedCat}:\n\n` +
          `${thisMonth.label}: $${thisAmt.toFixed(2)}${diffStr}\n` +
          `${lastMonth.label}: $${lastAmt.toFixed(2)}`
      );
      return;
    }

    // No specific category - show all ranked
    if (Object.keys(thisData.categoryTotals).length === 0) {
      bot.sendMessage(msg.chat.id, 'No expenses this month yet.');
      return;
    }

    const lines = Object.entries(thisData.categoryTotals)
      .sort((a, b) => a[1] - b[1])
      .map(([cat, amt]) => {
        const thisAmt = Math.abs(amt / 100);
        const lastAmt = Math.abs((lastData.categoryTotals[cat] || 0) / 100);
        const diff = thisAmt - lastAmt;
        const arrow = diff > 0 ? '↑' : diff < 0 ? '↓' : '';
        return `- ${cat}: $${thisAmt.toFixed(2)} ${arrow}`;
      });

    bot.sendMessage(
      msg.chat.id,
      `${thisMonth.label} spending (vs ${lastMonth.label}):\n\n${lines.join('\n')}\n\nTotal: $${(Math.abs(thisData.grandTotal) / 100).toFixed(2)}\n\n` +
        `Drill into any category: /spend grocery`
    );
  } catch (err) {
    console.error('Error in /spend:', err.message);
    bot.sendMessage(msg.chat.id, 'Failed to fetch spending data.');
  }
});

// /fixed - show recurring fixed expenses
const FIXED_CATEGORIES = ['Rent', 'Utilities', 'Insurance'];

bot.onText(/\/fixed/, async (msg) => {
  if (!actualReady) {
    bot.sendMessage(msg.chat.id, 'Actual Budget is not connected.');
    return;
  }

  try {
    const { thisMonth } = getMonthRanges();
    const data = await getSpendingByCategory(thisMonth.start, thisMonth.end);
    let fixedTotal = 0;
    const lines = [];

    for (const cat of FIXED_CATEGORIES) {
      const matched = Object.keys(data.categoryTotals).find(
        (c) => c.toLowerCase() === cat.toLowerCase()
      );
      const amt = matched ? Math.abs(data.categoryTotals[matched] / 100) : 0;
      fixedTotal += amt;
      lines.push(`- ${cat}: $${amt.toFixed(2)}${amt === 0 ? ' (not logged yet)' : ''}`);
    }

    bot.sendMessage(
      msg.chat.id,
      `Fixed monthly expenses (${thisMonth.label}):\n\n${lines.join('\n')}\n\nFixed total: $${fixedTotal.toFixed(2)}`
    );
  } catch (err) {
    console.error('Error in /fixed:', err.message);
    bot.sendMessage(msg.chat.id, 'Failed to fetch fixed expenses.');
  }
});

// /undo - delete the last expense you added
bot.onText(/\/undo/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  const user = USER_MAP[userId];

  if (!user) {
    bot.sendMessage(chatId, 'I don\'t recognize you.');
    return;
  }

  if (!actualReady) {
    bot.sendMessage(chatId, 'Actual Budget is not connected.');
    return;
  }

  const last = lastExpense.get(userId);

  if (!last || !last.transactionId) {
    bot.sendMessage(chatId, 'Nothing to undo. I can only undo the last expense you added this session.');
    return;
  }

  try {
    await actualApi.deleteTransaction(last.transactionId);
    await actualApi.sync();

    lastExpense.delete(userId);

    bot.sendMessage(
      chatId,
      `Deleted: $${last.amount.toFixed(2)} | ${last.category} | ${last.description} (${last.accountLabel})`
    );
  } catch (err) {
    console.error('Error in /undo:', err.message);
    bot.sendMessage(chatId, 'Failed to delete the last entry.');
  }
});

// /tag - show all expenses with a specific tag
bot.onText(/\/tag(.*)/, async (msg, match) => {
  if (!actualReady) {
    bot.sendMessage(msg.chat.id, 'Actual Budget is not connected.');
    return;
  }

  const query = (match[1] || '').trim().toLowerCase().replace('#', '');

  if (!query) {
    bot.sendMessage(msg.chat.id, 'Which tag? Example: /tag bali');
    return;
  }

  try {
    const accounts = await actualApi.getAccounts();
    let entries = [];
    let total = 0;

    // Search last 6 months for tagged transactions
    const now = new Date();
    const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 6, 1);
    const startDate = sixMonthsAgo.toISOString().split('T')[0];
    const endDate = now.toISOString().split('T')[0];

    for (const account of accounts) {
      if (account.closed) continue;
      const txns = await actualApi.getTransactions(account.id, startDate, endDate);
      for (const t of txns) {
        if (t.notes && t.notes.toLowerCase().includes(`#${query}`)) {
          const amt = Math.abs(t.amount / 100);
          total += amt;
          const catName = (t.category && categoryIdToName[t.category]) || '';
          entries.push(`- ${t.date} | $${amt.toFixed(2)} | ${catName} | ${t.imported_payee || t.payee_name || ''}`);
        }
      }
    }

    if (entries.length === 0) {
      bot.sendMessage(msg.chat.id, `No expenses tagged #${query}.`);
      return;
    }

    bot.sendMessage(
      msg.chat.id,
      `#${query} expenses:\n\n${entries.join('\n')}\n\nTotal: $${total.toFixed(2)} (${entries.length} entries)`
    );
  } catch (err) {
    console.error('Error in /tag:', err.message);
    bot.sendMessage(msg.chat.id, 'Failed to fetch tagged expenses.');
  }
});

// Helper: build account keyboard for a user
function accountKeyboard(user) {
  const buttons = user.accounts.map((key) => [{ text: `${ACCOUNTS[key].label} (${key})` }]);
  return { reply_markup: { keyboard: buttons, one_time_keyboard: true, resize_keyboard: true } };
}

// ------ PHOTO HANDLER (RECEIPTS) ------

bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  const user = USER_MAP[userId];

  if (!user) {
    bot.sendMessage(chatId, `I don't recognize you. Your Telegram ID is ${userId}. Add it to .env.`);
    return;
  }

  bot.sendMessage(chatId, 'Reading your receipt...');

  try {
    // Telegram sends multiple sizes; grab the largest one
    const photo = msg.photo[msg.photo.length - 1];
    const imageBuffer = await downloadFile(photo.file_id);
    const result = await parseReceipt(imageBuffer);

    if (result.error) {
      bot.sendMessage(chatId, `Could not read receipt: ${result.error}`);
      return;
    }

    // For receipts, always ask which account (no keyword to detect from)
    const defaultAccount = ACCOUNTS[user.defaultAccount];
    pendingExpenses.set(userId, {
      ...result,
      step: result.needsAmount ? 'amount' : result.needsCategory ? 'category' : 'account',
      accountKey: user.defaultAccount,
      account: defaultAccount,
    });

    if (result.needsAmount) {
      bot.sendMessage(
        chatId,
        `I found "${result.description}" but could not read the total.\n\nHow much was it?`
      );
      return;
    }

    if (result.needsCategory) {
      bot.sendMessage(
        chatId,
        `Got $${result.amount.toFixed(2)} from "${result.description}" but not sure about the category.\n\nPick one:`,
        categoryKeyboard()
      );
      return;
    }

    // Got everything, ask which account
    bot.sendMessage(
      chatId,
      `Got $${result.amount.toFixed(2)} | ${result.category} | "${result.description}"\n\nWhich account? (or tap to use default)`,
      accountKeyboard(user)
    );
  } catch (err) {
    console.error('Photo handler error:', err.message);
    bot.sendMessage(chatId, 'Something went wrong reading that receipt. Try again or type the expense manually.');
  }
});

// ------ TEXT MESSAGE HANDLER ------

bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  if (msg.photo) return; // handled by photo handler

  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  const user = USER_MAP[userId];

  if (!user) {
    bot.sendMessage(chatId, `I don't recognize you. Your Telegram ID is ${userId}. Add it to .env.`);
    return;
  }

  // Check if there's a pending expense waiting for input
  const pending = pendingExpenses.get(userId);

  if (pending) {
    // Cancel words - clear pending expense and stop asking
    const cancelWords = ['cancel', 'nevermind', 'never mind', 'forget it', 'forget', 'nvm', 'stop', 'skip', 'nah', 'no'];
    if (cancelWords.includes(msg.text.trim().toLowerCase())) {
      pendingExpenses.delete(userId);
      bot.sendMessage(chatId, 'Cancelled.', removeKeyboard());
      return;
    }

    // Waiting for account selection (from receipt flow)
    if (pending.step === 'account') {
      // Check if the reply matches an account
      const selectedKey = user.accounts.find((key) => {
        const label = `${ACCOUNTS[key].label} (${key})`;
        return msg.text.trim().toLowerCase() === label.toLowerCase() ||
               msg.text.trim().toLowerCase() === key;
      });

      if (selectedKey) {
        pending.account = ACCOUNTS[selectedKey];
      }
      // If no match, use default account (already set)

      pendingExpenses.delete(userId);
      await confirmExpense(chatId, msg.from.id, pending, pending.account);
      return;
    }

    // Waiting for amount
    if (pending.step === 'amount') {
      const amount = parseFloat(msg.text.replace(/[^0-9.]/g, ''));
      if (isNaN(amount) || amount <= 0) {
        bot.sendMessage(chatId, 'That does not look like a number. How much was it?');
        return;
      }
      pending.amount = amount;
      pending.needsAmount = false;

      // If we also need a category, ask for it now
      if (pending.needsCategory) {
        pending.step = 'category';
        bot.sendMessage(chatId, `Got $${amount.toFixed(2)}. What category?`, categoryKeyboard());
        return;
      }

      // For receipt flow, ask account next
      if (pending.ocrPreview !== undefined) {
        pending.step = 'account';
        bot.sendMessage(chatId, `Which account?`, accountKeyboard(user));
        return;
      }

      // Otherwise we're done (text flow - account already set)
      pendingExpenses.delete(userId);
      await confirmExpense(chatId, msg.from.id, pending, pending.account);
      return;
    }

    // Waiting for category selection
    if (pending.step === 'category') {
      const selected = ALL_CATEGORIES.find(
        (c) => c.toLowerCase() === msg.text.trim().toLowerCase()
      );

      if (!selected) {
        bot.sendMessage(chatId, 'Pick a category from the list:', categoryKeyboard());
        return;
      }

      pending.category = selected;
      pending.needsCategory = false;

      // Learn this keyword for next time
      if (pending.description && pending.description !== 'expense') {
        learnKeyword(pending.description, selected);
        console.log(`Learned: "${pending.description}" -> ${selected}`);
      }

      // If we also need an amount, ask for it
      if (pending.needsAmount) {
        pending.step = 'amount';
        bot.sendMessage(chatId, `Category: ${selected}. How much was it?`, removeKeyboard());
        return;
      }

      // For receipt flow, ask account next
      if (pending.ocrPreview !== undefined) {
        pending.step = 'account';
        bot.sendMessage(chatId, `Which account?`, accountKeyboard(user));
        return;
      }

      // Otherwise we're done (text flow - account already set)
      pendingExpenses.delete(userId);
      await confirmExpense(chatId, msg.from.id, pending, pending.account);
      return;
    }
  }

  // No pending expense - check if it's a natural language query first
  const wasQuery = await handleNaturalQuery(chatId, msg.text, user);
  if (wasQuery) return;

  // Check if it's a transfer command: "transfer 500 savings credit"
  const transfer = parseTransfer(msg.text);
  if (transfer) {
    if (!actualReady) {
      bot.sendMessage(chatId, 'Actual Budget is not connected.');
      return;
    }

    try {
      const today = new Date().toISOString().split('T')[0];
      const amountCents = Math.round(transfer.amount * 100);

      // Deduct from source
      await actualApi.importTransactions(transfer.from.id, [
        {
          date: today,
          amount: -amountCents,
          payee_name: `Transfer to ${transfer.to.label}`,
          notes: `Transfer by ${user.name} via Telegram`,
        },
      ]);

      // Add to destination
      await actualApi.importTransactions(transfer.to.id, [
        {
          date: today,
          amount: amountCents,
          payee_name: `Transfer from ${transfer.from.label}`,
          notes: `Transfer by ${user.name} via Telegram`,
        },
      ]);

      await actualApi.sync();

      bot.sendMessage(
        chatId,
        `✅ Transferred $${transfer.amount.toFixed(2)}\n\n` +
          `From: ${transfer.from.label}\n` +
          `To: ${transfer.to.label}`
      );
    } catch (err) {
      console.error('Transfer error:', err.message);
      bot.sendMessage(chatId, 'Failed to process transfer.');
    }
    return;
  }

  // Not a query or transfer - parse as an expense
  // Extract tags first (e.g., #bali #trip)
  const { tags, cleanText: textWithoutTags } = extractTags(msg.text);
  // Extract account keyword from end of message
  const { account, cleanText } = extractAccount(textWithoutTags, user);
  const expense = parseExpenseText(cleanText);

  // Attach tags to expense
  expense.tags = tags;

  // Missing both amount and category - not an expense either
  if (expense.needsAmount && expense.needsCategory) {
    bot.sendMessage(
      chatId,
      `Not sure what to do with that. Try "lunch 12.50" or ask me "how much on food this month?".\n\nType /help for tips.`
    );
    return;
  }

  // Missing amount only
  if (expense.needsAmount) {
    pendingExpenses.set(userId, { ...expense, account, step: 'amount' });
    bot.sendMessage(chatId, `Got it, "${expense.description}" under ${expense.category} (${account.label}). How much?`);
    return;
  }

  // Missing category only
  if (expense.needsCategory) {
    pendingExpenses.set(userId, { ...expense, account, step: 'category' });
    bot.sendMessage(
      chatId,
      `$${expense.amount.toFixed(2)} for "${expense.description}" (${account.label}). What category?`,
      categoryKeyboard()
    );
    return;
  }

  // Got everything - confirm and log
  await confirmExpense(chatId, msg.from.id, expense, account);
});

// ============================================================
// STARTUP
// ============================================================

async function main() {
  console.log('Starting Budget Bot v2...');
  console.log('---');

  // Init Google Vision
  const visionOk = initVision();
  if (!visionOk) console.log('Receipt scanning disabled. Set GOOGLE_APPLICATION_CREDENTIALS to enable.');

  // Init Actual Budget
  await initActual();

  // Load learned keywords
  loadLearnedKeywords();

  // Start weekly auto-summary
  startWeeklySummary();

  // Start daily nudge
  startDailyNudge();

  console.log('---');
  console.log('Bot is running! Send expenses to your Telegram bot.');
}

main().catch(console.error);
