// ============================================================
// RECEIPT PARSER
// Uses Google Cloud Vision OCR to extract text from receipt
// photos, then finds the total amount and store name.
// Free tier: 1,000 requests/month (more than enough).
// ============================================================

import vision from '@google-cloud/vision';
import { parseExpenseText } from './parser.js';

let client;

export function initVision() {
  try {
    // Uses GOOGLE_APPLICATION_CREDENTIALS env var automatically
    // (path to your service account JSON key file)
    client = new vision.ImageAnnotatorClient();
    console.log('Google Cloud Vision connected.');
    return true;
  } catch (err) {
    console.error('Failed to init Google Vision:', err.message);
    console.log('Receipt scanning will be disabled.');
    return false;
  }
}

// ------------------------------------------------------------
// EXTRACT TEXT FROM IMAGE
// Sends the image buffer to Google Vision OCR
// ------------------------------------------------------------

async function ocrImage(imageBuffer) {
  const [result] = await client.textDetection({
    image: { content: imageBuffer.toString('base64') },
  });

  const annotations = result.textAnnotations;
  if (!annotations || annotations.length === 0) return null;

  // First annotation contains the full text block
  return annotations[0].description;
}

// ------------------------------------------------------------
// FIND TOTAL AMOUNT FROM RECEIPT TEXT
// Looks for patterns like "TOTAL", "GRAND TOTAL", "AMOUNT DUE"
// followed by a number. Falls back to largest number if no
// total keyword found.
// ------------------------------------------------------------

function extractTotal(ocrText) {
  const lines = ocrText.split('\n').map((l) => l.trim());
  const totalPatterns = [
    /(?:grand\s*total|total\s*(?:due|amount|payable|paid)?|amount\s*(?:due|payable)|nett\s*total|net\s*total|subtotal|sub\s*total)\s*[:\s]*\$?\s*(\d+(?:\.\d{1,2})?)/i,
    /\$\s*(\d+(?:\.\d{1,2})?)\s*(?:total|due|paid)/i,
  ];

  // Try to find a total keyword + amount on the same line
  for (const line of lines) {
    for (const pattern of totalPatterns) {
      const match = line.match(pattern);
      if (match) {
        const amount = parseFloat(match[1]);
        if (amount > 0 && amount < 100000) return amount;
      }
    }
  }

  // Fallback: find lines with total-like keywords nearby
  for (let i = 0; i < lines.length; i++) {
    if (/total|amount|due|paid|nett|net/i.test(lines[i])) {
      // Check this line and the next line for a number
      for (let j = i; j <= Math.min(i + 1, lines.length - 1); j++) {
        const numMatch = lines[j].match(/\$?\s*(\d+(?:\.\d{1,2})?)/);
        if (numMatch) {
          const amount = parseFloat(numMatch[1]);
          if (amount > 0 && amount < 100000) return amount;
        }
      }
    }
  }

  // Last resort: find the largest reasonable number on the receipt
  const allNumbers = ocrText.match(/\$?\s*(\d+\.\d{2})/g) || [];
  const amounts = allNumbers
    .map((n) => parseFloat(n.replace(/[^0-9.]/g, '')))
    .filter((n) => n > 0 && n < 100000);

  if (amounts.length > 0) {
    return Math.max(...amounts);
  }

  return null;
}

// ------------------------------------------------------------
// FIND STORE NAME FROM RECEIPT TEXT
// Usually the first few lines contain the store name
// ------------------------------------------------------------

function extractStoreName(ocrText) {
  const lines = ocrText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 1);

  // The store name is typically in the first 3 lines
  // Skip lines that are just numbers, dates, or addresses
  for (let i = 0; i < Math.min(lines.length, 5); i++) {
    const line = lines[i];
    // Skip lines that are mostly numbers or look like addresses/dates
    if (/^\d+[\s\-\/]/.test(line)) continue;
    if (/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/.test(line)) continue;
    if (/^(tel|fax|phone|address|blk|#)/i.test(line)) continue;
    if (line.length < 3) continue;

    return line;
  }

  return null;
}

// ------------------------------------------------------------
// MAIN RECEIPT PARSE FUNCTION
// Takes an image buffer, returns a structured expense
// ------------------------------------------------------------

export async function parseReceipt(imageBuffer, budgetKey = 'default') {
  if (!client) {
    return { error: 'Google Vision not configured' };
  }

  try {
    const ocrText = await ocrImage(imageBuffer);

    if (!ocrText) {
      return { error: 'Could not read any text from the image' };
    }

    const total = extractTotal(ocrText);
    const storeName = extractStoreName(ocrText);

    // Use the keyword parser to detect category from store name + full text
    const searchText = `${storeName || ''} ${ocrText}`.substring(0, 200);
    const parsed = parseExpenseText(searchText, budgetKey);

    return {
      amount: total,
      category: parsed.category,
      description: storeName || 'receipt',
      currency: 'USD', // Change to your currency,
      needsCategory: parsed.category === null,
      needsAmount: total === null,
      ocrPreview: ocrText.substring(0, 300), // for debugging
    };
  } catch (err) {
    console.error('Receipt parse error:', err.message);
    return { error: `Failed to process receipt: ${err.message}` };
  }
}
