// ============================================================
// KEYWORD PARSER
// Parses text messages like "uber 12.50" or "lunch 8"
// into structured expense objects. No AI, no API calls.
//
// LEARNING: When the bot asks for a category and the user picks
// one, the keyword is saved to a learned-keywords file scoped
// to the active budget. Next time it appears in that budget, it
// auto-categorizes without leaking into other budget files.
// ============================================================

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const LEARNED_DIR = process.env.ACTUAL_DATA_DIR || '/tmp/actual-data';

// Load learned keywords from disk
const learnedKeywordsByBudget = new Map();

function safeBudgetKey(budgetKey = 'default') {
  return String(budgetKey).replace(/[^a-zA-Z0-9_-]/g, '_') || 'default';
}

function learnedFileForBudget(budgetKey) {
  return join(LEARNED_DIR, `learned-keywords-${safeBudgetKey(budgetKey)}.json`);
}

function getLearnedKeywords(budgetKey) {
  const key = safeBudgetKey(budgetKey);
  if (!learnedKeywordsByBudget.has(key)) {
    loadLearnedKeywords(key);
  }
  return learnedKeywordsByBudget.get(key) || {};
}

export function loadLearnedKeywords(budgetKey = 'default') {
  const key = safeBudgetKey(budgetKey);
  const learnedFile = learnedFileForBudget(key);

  try {
    if (existsSync(learnedFile)) {
      const learnedKeywords = JSON.parse(readFileSync(learnedFile, 'utf-8'));
      learnedKeywordsByBudget.set(key, learnedKeywords);
      const count = Object.keys(learnedKeywords).length;
      if (count > 0) console.log(`Loaded ${count} learned keywords for ${key}.`);
    } else {
      learnedKeywordsByBudget.set(key, {});
    }
  } catch (err) {
    console.error(`Failed to load learned keywords for ${key}:`, err.message);
    learnedKeywordsByBudget.set(key, {});
  }
}

// Save a new keyword -> category mapping
export function learnKeyword(budgetKey, keyword, category) {
  const safeKey = safeBudgetKey(budgetKey);
  const key = keyword.toLowerCase().trim();
  if (!key || key.length < 2) return; // skip tiny/empty words

  const learnedKeywords = { ...getLearnedKeywords(safeKey) };
  learnedKeywords[key] = category;
  learnedKeywordsByBudget.set(safeKey, learnedKeywords);

  try {
    mkdirSync(LEARNED_DIR, { recursive: true });
    writeFileSync(learnedFileForBudget(safeKey), JSON.stringify(learnedKeywords, null, 2));
  } catch (err) {
    console.error('Failed to save learned keyword:', err.message);
  }
}

// ------------------------------------------------------------
// CATEGORY KEYWORDS
// Add your own keywords here. The parser checks each word in
// the message against these lists and picks the first match.
// Put more specific keywords first.
// ------------------------------------------------------------

const KEYWORD_MAP = {
  'Transportation': [
    'uber', 'lyft', 'taxi', 'cab', 'bus', 'train', 'subway',
    'metro', 'parking', 'petrol', 'gas', 'fuel', 'toll',
    'ride', 'commute', 'transit', 'grab', 'bolt',
  ],
  'Groceries': [
    'grocery', 'groceries', 'supermarket', 'market', 'walmart',
    'costco', 'trader joe', 'whole foods', 'aldi', 'kroger',
    'target', 'safeway', 'tesco', 'lidl',
  ],
  'Food & Drinks': [
    'lunch', 'dinner', 'breakfast', 'brunch', 'supper',
    'restaurant', 'cafe', 'coffee', 'starbucks', 'mcdonald',
    'mcd', 'kfc', 'subway', 'burger', 'pizza', 'sushi',
    'doordash', 'ubereats', 'grubhub', 'deliveroo',
    'snack', 'dessert', 'bakery', 'eat', 'meal', 'drinks',
    'beer', 'wine', 'bar', 'pub', 'alcohol',
  ],
  'Subscriptions': [
    'netflix', 'spotify', 'youtube', 'disney', 'hbo', 'hulu',
    'apple music', 'amazon prime', 'chatgpt', 'claude',
    'notion', 'figma', 'github', 'icloud', 'google one',
    'vpn', 'subscription', 'adobe', 'canva', 'dropbox',
    'plex', 'crunchyroll',
  ],
  'Utilities': [
    'electricity', 'electric', 'water', 'internet', 'wifi',
    'phone bill', 'mobile bill', 'utility', 'utilities',
  ],
  'Rent': [
    'rent', 'rental', 'lease', 'mortgage',
  ],
  'Health & Personal Care': [
    'doctor', 'clinic', 'hospital', 'dental', 'dentist',
    'pharmacy', 'medicine', 'medication', 'medical', 'health',
    'gym', 'fitness', 'yoga', 'physio',
    'haircut', 'barber', 'salon', 'facial', 'spa', 'massage',
    'skincare', 'grooming',
  ],
  'Shopping': [
    'amazon', 'clothes', 'shoes', 'shirt', 'pants', 'jacket',
    'bag', 'watch', 'electronics', 'gadget', 'ikea',
    'uniqlo', 'zara', 'h&m', 'shopping',
  ],
  'Entertainment': [
    'movie', 'cinema', 'concert', 'show', 'tickets', 'game',
    'ps5', 'playstation', 'nintendo', 'steam', 'museum',
    'bowling', 'arcade', 'zoo', 'karaoke',
  ],
  'Travel': [
    'flight', 'hotel', 'hostel', 'airbnb', 'booking',
    'travel', 'airport', 'luggage', 'passport',
  ],
  'Insurance': [
    'insurance', 'premium',
  ],
  'Home': [
    'furniture', 'repair', 'plumber', 'electrician',
    'cleaning', 'laundry', 'household', 'renovation',
    'handyman', 'paint',
  ],
  'Education': [
    'course', 'udemy', 'coursera', 'book', 'books', 'tuition',
    'class', 'workshop', 'training',
  ],
  'Gifts': [
    'gift', 'present', 'birthday', 'anniversary', 'wedding',
    'flowers',
  ],
};

// ------------------------------------------------------------
// DATE EXTRACTION
// Supports front/back dates like:
// "30/5", "30/05/26", "30 May", "30 May 2026"
// "today", "yesterday", "5 days ago"
// ------------------------------------------------------------

const MONTHS = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

function normalizeYear(yearText) {
  if (!yearText) return new Date().getFullYear();

  const year = Number(yearText);
  if (yearText.length === 2) return 2000 + year;
  return year;
}

function formatDate(year, month, day) {
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }

  return [
    String(year).padStart(4, '0'),
    String(month).padStart(2, '0'),
    String(day).padStart(2, '0'),
  ].join('-');
}

function formatDateObject(date) {
  return [
    String(date.getFullYear()).padStart(4, '0'),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function daysAgo(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return formatDateObject(date);
}

function parseRelativeDateMatch(match, type) {
  if (type === 'today') return formatDateObject(new Date());
  if (type === 'yesterday') return daysAgo(1);
  if (type === 'daysAgo') return daysAgo(Number(match[1]));
  return null;
}

function parseDateMatch(match, type) {
  if (type === 'numeric') {
    const day = Number(match[1]);
    const month = Number(match[2]);
    const year = normalizeYear(match[3]);
    return formatDate(year, month, day);
  }

  const day = Number(match[1]);
  const month = MONTHS[match[2].toLowerCase()];
  const year = normalizeYear(match[3]);
  return formatDate(year, month, day);
}

function extractDate(text) {
  const patterns = [
    {
      type: 'today',
      relative: true,
      front: /^\s*(today)\b\s*/i,
      back: /\s+\b(today)\s*$/i,
    },
    {
      type: 'yesterday',
      relative: true,
      front: /^\s*(yesterday)\b\s*/i,
      back: /\s+\b(yesterday)\s*$/i,
    },
    {
      type: 'daysAgo',
      relative: true,
      front: /^\s*(\d+)\s+days?\s+ago\b\s*/i,
      back: /\s+\b(\d+)\s+days?\s+ago\s*$/i,
    },
    {
      type: 'numeric',
      front: /^\s*(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b\s*/i,
      back: /\s+\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\s*$/i,
    },
    {
      type: 'month',
      front: /^\s*(\d{1,2})\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+(\d{2,4}))?\b\s*/i,
      back: /\s+\b(\d{1,2})\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+(\d{2,4}))?\s*$/i,
    },
  ];

  for (const pattern of patterns) {
    const front = text.match(pattern.front);
    if (front) {
      const date = pattern.relative
        ? parseRelativeDateMatch(front, pattern.type)
        : parseDateMatch(front, pattern.type);
      if (date) {
        return {
          date,
          text: text.slice(front[0].length).replace(/\s+/g, ' ').trim(),
        };
      }
    }
  }

  for (const pattern of patterns) {
    const back = text.match(pattern.back);
    if (back) {
      const date = pattern.relative
        ? parseRelativeDateMatch(back, pattern.type)
        : parseDateMatch(back, pattern.type);
      if (date) {
        return {
          date,
          text: text.slice(0, back.index).replace(/\s+/g, ' ').trim(),
        };
      }
    }
  }

  return { date: null, text: text.trim() };
}

// ------------------------------------------------------------
// AMOUNT EXTRACTION
// Finds numbers in the message. Handles formats like:
// "12", "12.50", "$12.50", "USD 12.50", "12.5"
// Supports: $, USD, EUR, GBP, SGD, INR, AUD, CAD
// ------------------------------------------------------------

function extractAmount(text) {
  const candidates = [];
  const currencyRegex = /(?:\$|USD|EUR|GBP|SGD|INR|AUD|CAD)\s*(\d+(?:\.\d{1,2})?)/gi;
  const numberRegex = /\b(\d+(?:\.\d{1,2})?)\b/g;

  let match;
  while ((match = currencyRegex.exec(text)) !== null) {
    const amount = parseFloat(match[1]);
    if (amount > 0 && amount < 100000) {
      candidates.push({
        amount,
        index: match.index,
        end: match.index + match[0].length,
        type: 'currency',
      });
    }
  }

  while ((match = numberRegex.exec(text)) !== null) {
    const amount = parseFloat(match[1]);
    if (amount > 0 && amount < 100000) {
      candidates.push({
        amount,
        index: match.index,
        end: match.index + match[0].length,
        type: match[1].includes('.') ? 'decimal' : 'integer',
      });
    }
  }

  if (candidates.length === 0) return null;

  const currency = candidates.filter((candidate) => candidate.type === 'currency');
  if (currency.length > 0) return currency.sort((a, b) => a.index - b.index)[0];

  const decimals = candidates.filter((candidate) => candidate.type === 'decimal');
  if (decimals.length > 0) return decimals.sort((a, b) => a.index - b.index)[0];

  return candidates.sort((a, b) => b.index - a.index)[0];
}

// ------------------------------------------------------------
// CATEGORY DETECTION
// Checks the message against keyword lists
// ------------------------------------------------------------

function detectCategory(text, budgetKey = 'default') {
  const lower = text.toLowerCase();
  const learnedKeywords = getLearnedKeywords(budgetKey);

  // Check learned keywords first (user-taught mappings)
  for (const [keyword, category] of Object.entries(learnedKeywords)) {
    if (keyword.length <= 3) {
      const regex = new RegExp(`\\b${keyword}\\b`, 'i');
      if (regex.test(lower)) return category;
    } else {
      if (lower.includes(keyword)) return category;
    }
  }

  // Then check built-in keywords
  for (const [category, keywords] of Object.entries(KEYWORD_MAP)) {
    for (const keyword of keywords) {
      if (keyword.length <= 3) {
        const regex = new RegExp(`\\b${keyword}\\b`, 'i');
        if (regex.test(lower)) return category;
      } else {
        if (lower.includes(keyword)) return category;
      }
    }
  }

  return null; // no match found
}

// ------------------------------------------------------------
// BUILD DESCRIPTION
// Clean up the message to create a short description
// Removes the amount and common filler words
// ------------------------------------------------------------

function cleanDescription(text) {
  const desc = text
    .replace(/\s+/g, ' ')                                        // collapse whitespace
    .trim();

  return desc || 'expense';
}

// ------------------------------------------------------------
// MAIN PARSE FUNCTION
// Takes a raw text message, returns a structured expense or null
// ------------------------------------------------------------

export function parseExpenseText(text, budgetKey = 'default') {
  const dateResult = extractDate(text);
  const amountMatch = extractAmount(dateResult.text);
  const amount = amountMatch ? amountMatch.amount : null;
  const beforeAmount = amountMatch ? dateResult.text.slice(0, amountMatch.index) : dateResult.text;
  const afterAmount = amountMatch ? dateResult.text.slice(amountMatch.end) : '';
  const description = cleanDescription(beforeAmount);
  const category = detectCategory(`${beforeAmount} ${afterAmount}`, budgetKey);

  return {
    amount,
    date: dateResult.date,
    category,
    description,
    trailingText: afterAmount.replace(/\s+/g, ' ').trim(),
    currency: 'USD', // Change to your currency,
    needsCategory: category === null,
    needsAmount: amount === null,
  };
}

// Export the built-in category list as a fallback when Actual categories are unavailable.
export const BUILTIN_CATEGORIES = Object.keys(KEYWORD_MAP);
