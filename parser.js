// ============================================================
// KEYWORD PARSER
// Parses text messages like "uber 12.50" or "lunch 8"
// into structured expense objects. No AI, no API calls.
//
// LEARNING: When the bot asks for a category and the user picks
// one, the keyword is saved to learned-keywords.json. Next time
// the same word appears, it auto-categorizes.
// ============================================================

import { readFileSync, writeFileSync, existsSync } from 'fs';

const LEARNED_FILE = '/tmp/actual-data/learned-keywords.json';

// Load learned keywords from disk
let learnedKeywords = {};

export function loadLearnedKeywords() {
  try {
    if (existsSync(LEARNED_FILE)) {
      learnedKeywords = JSON.parse(readFileSync(LEARNED_FILE, 'utf-8'));
      const count = Object.keys(learnedKeywords).length;
      if (count > 0) console.log(`Loaded ${count} learned keywords.`);
    }
  } catch (err) {
    console.error('Failed to load learned keywords:', err.message);
    learnedKeywords = {};
  }
}

// Save a new keyword -> category mapping
export function learnKeyword(keyword, category) {
  const key = keyword.toLowerCase().trim();
  if (!key || key.length < 2) return; // skip tiny/empty words

  learnedKeywords[key] = category;

  try {
    writeFileSync(LEARNED_FILE, JSON.stringify(learnedKeywords, null, 2));
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
// AMOUNT EXTRACTION
// Finds numbers in the message. Handles formats like:
// "12", "12.50", "$12.50", "USD 12.50", "12.5"
// Supports: $, USD, EUR, GBP, SGD, INR, AUD, CAD
// ------------------------------------------------------------

function extractAmount(text) {
  // Match currency patterns first: $12.50, USD12.50, EUR 12.50
  const currencyMatch = text.match(/(?:\$|USD|EUR|GBP|SGD|INR|AUD|CAD)\s*(\d+(?:\.\d{1,2})?)/i);
  if (currencyMatch) return parseFloat(currencyMatch[1]);

  // Match standalone numbers (not part of a longer word)
  const numbers = text.match(/\b(\d+(?:\.\d{1,2})?)\b/g);
  if (!numbers) return null;

  // If multiple numbers, take the one that looks most like a price
  // (filter out things that look like dates, times, etc.)
  const prices = numbers
    .map(Number)
    .filter((n) => n > 0 && n < 100000); // reasonable expense range

  if (prices.length === 0) return null;

  // Return the last number in the message (people usually type "thing amount")
  return prices[prices.length - 1];
}

// ------------------------------------------------------------
// CATEGORY DETECTION
// Checks the message against keyword lists
// ------------------------------------------------------------

function detectCategory(text) {
  const lower = text.toLowerCase();

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

function buildDescription(text, amount) {
  let desc = text
    .replace(/(?:\$|USD|EUR|GBP|SGD|INR|AUD|CAD)\s*\d+(?:\.\d{1,2})?/gi, '') // remove currency + amount
    .replace(/\b\d+(?:\.\d{1,2})?\b/g, '')                     // remove standalone numbers
    .replace(/\s+/g, ' ')                                        // collapse whitespace
    .trim();

  // Cap at 5 words
  const words = desc.split(' ').slice(0, 5);
  desc = words.join(' ');

  return desc || 'expense';
}

// ------------------------------------------------------------
// MAIN PARSE FUNCTION
// Takes a raw text message, returns a structured expense or null
// ------------------------------------------------------------

export function parseExpenseText(text) {
  const amount = extractAmount(text);
  const category = detectCategory(text);
  const description = buildDescription(text, amount);

  return {
    amount,
    category,
    description,
    currency: 'USD', // Change to your currency,
    needsCategory: category === null,
    needsAmount: amount === null,
  };
}

// Export the category list for Telegram keyboard buttons
export const ALL_CATEGORIES = Object.keys(KEYWORD_MAP);
