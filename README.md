<div align="center">

# 💰 Actual Budget Telegram Bot

**Log household expenses by texting. No LLMs. No AI costs. Fully private.**

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22+-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Telegram Bot API](https://img.shields.io/badge/Telegram-Bot_API-26A5E4?logo=telegram&logoColor=white)](https://core.telegram.org/bots/api)
[![Actual Budget](https://img.shields.io/badge/Actual_Budget-Open_Source-5B21B6)](https://actualbudget.org)

---

*Text `lunch 12.50` and it's categorized, assigned to the right account, and synced to Actual Budget. Snap a receipt and it reads the total. Ask `how much on food this month?` and get an instant answer.*

</div>

## 🤔 The problem

Budget apps either cost $10-15/month or they're clunky and limited. [Actual Budget](https://actualbudget.org) is an excellent open-source alternative with great dashboards, but manually entering every expense gets old fast.

This bot solves the input problem. Your daily interaction is just **texting a Telegram group**. Dashboards and reports stay in Actual Budget where they belong.

**No AI/LLM APIs.** The bot uses a keyword parser that learns from you. Your financial data never touches any third-party AI service.


## ✨ Features

| Feature | How it works |
|---|---|
| 💬 **Text-based entry** | Type `coffee 5.50` or `uber 15 credit` |
| 📸 **Receipt scanning** | Snap a photo, OCR reads total + store |
| 👥 **Multi-user** | Shared Telegram group, expenses route to the right person |
| 💳 **Multi-account** | Add a keyword to pick the bank/card |
| 🧠 **Auto-learning** | Asks once for unknown words, remembers forever |
| 🏷️ **Tags** | `dinner 45 #bali` then `/tag bali` to see trip totals |
| 🔄 **Transfers** | `transfer 500 savings credit` moves money between accounts |
| ❓ **Natural language** | `how much on food this month?` or `what did I spend today?` |
| 👤 **Personal queries** | "I" = your spending, "we" = household total |
| 🔔 **Daily nudge** | Auto-sends tonight's spending + month total at 10 PM |
| 📊 **Weekly summary** | Category breakdown every Sunday |
| ↩️ **Undo** | `/undo` deletes your last entry |


## 🏗️ Architecture

```
You text: "uber to office 12.50"
     ↓
Keyword parser → { amount: 12.50, category: "Transportation" }
     ↓
Actual Budget API → transaction logged
     ↓
Bot: "✅ Logged! $12.50 | Transportation | Savings Account"
```

| Component | Purpose | Cost |
|---|---|---|
| Telegram Bot | Input interface | Free |
| Keyword Parser | Categorizes expenses | Free |
| Google Cloud Vision | Receipt OCR | Free (1,000/month) |
| Actual Budget | Dashboards + reports | ~$1-2/month |
| Fly.io | Hosts the bot 24/7 | Free tier |
| **Total** | | **~$1-2/month** |


## 🚀 Quick start

### Prerequisites

- [Actual Budget](https://actualbudget.org) on [PikaPods](https://pikapods.com) or self-hosted
- Node.js 22+
- Telegram account
- Google Cloud account (optional, for receipts)

### Setup

```bash
# Clone
git clone https://github.com/yourusername/actual-budget-telegram-bot.git
cd actual-budget-telegram-bot

# Configure
cp .env.example .env
# Edit .env with your tokens, IDs, and account mappings

# Customize categories in parser.js and accounts in bot.js

# Run
npm install
node bot.js
```

### Get your IDs

| What | Where |
|---|---|
| Telegram bot token | @BotFather on Telegram → `/newbot` |
| Telegram user IDs | @userinfobot on Telegram |
| Actual Budget Sync ID | Settings → Show advanced settings |
| Account IDs | Click an account in Actual, check the URL |
| Google Vision key | [Cloud Console](https://console.cloud.google.com) → Vision API → Service Account → JSON key |

### Create a Telegram group

Create a group → add household members + the bot → make bot admin → start texting.


## 📱 Usage

### Logging expenses

```
lunch 12.50                    → Food & Drinks, default account
lunch 12.50 credit             → Food & Drinks, Credit Card
uber home 15                   → Transportation, default account
groceries 67.30 joint          → Groceries, Joint Account
dinner 45 #date                → Food & Drinks, tagged #date
[receipt photo]                → OCR reads total, asks which account
```

### Transfers

```
transfer 500 savings credit    → -$500 Savings, +$500 Credit Card
```

### Tags

```
flights 300 #bali              → tagged
hotel 150 #bali                → tagged
/tag bali                      → shows all #bali expenses + total
```

### Natural language queries

```
"how much on food this month?"          → Food spending, this month
"what did I spend today?"               → Your personal total today
"what did we spend this week?"          → Household total, this week
"what's our biggest expense?"           → Top 3 categories
"how much on groceries vs last month?"  → Comparison with difference
```

**"I/my/me"** = your spending only. **"We/our"** = combined household.

### Commands

| Command | Description |
|---|---|
| `/today` | Today's expenses |
| `/month` | Monthly breakdown |
| `/spend` | All categories ranked vs last month |
| `/spend food` | Drill into one category |
| `/fixed` | Recurring costs |
| `/tag bali` | Tagged expenses |
| `/undo` | Delete last entry |
| `/accounts` | Your accounts + keywords |
| `/categories` | All categories |
| `/help` | Quick reference |

### Cancel anytime

Say `cancel`, `nevermind`, `nvm`, `forget it`, `stop`, `skip`, `nah`, or `no`.


## 🚢 Deployment

The bot needs to run 24/7 to receive messages.

### Fly.io (free tier)

```bash
fly launch
fly secrets set TELEGRAM_BOT_TOKEN=xxx ACTUAL_SERVER_URL=xxx ...
fly secrets set GCP_KEY_BASE64="$(cat gcp-key.json | base64 | tr -d '\n')"
fly deploy
fly scale count 1
```

### Docker

```bash
docker build -t budget-bot .
docker run -d --name budget-bot --restart unless-stopped \
  --env-file .env \
  -v $(pwd)/gcp-key.json:/app/gcp-key.json:ro \
  budget-bot
```

### Home server

Run the Docker container on any always-on machine (NAS, Raspberry Pi, old laptop).


## 🔔 Automated messages

| When | What |
|---|---|
| Every night 10 PM | "Today: $45.50 across 3 expenses. Month so far: $1,230" |
| Every Sunday 8 PM | Full weekly spending breakdown by category |

Set `WEEKLY_SUMMARY_CHAT_ID` in your environment. Daily nudge uses the same chat ID by default.


## 🧠 Auto-learning

The bot starts with built-in keywords (uber → Transportation, netflix → Subscriptions, etc).

When it encounters something new like "acai", it asks you to pick a category. Your choice is **saved permanently**. Next time "acai" appears, it auto-categorizes instantly.

Learned keywords persist across bot restarts in `learned-keywords.json`.


## 🛠️ Customization

**Categories:** Edit `KEYWORD_MAP` in `parser.js`. Names must match your Actual Budget categories exactly.

**Accounts:** Edit `ACCOUNTS` and `USER_MAP` in `bot.js` to match your household.

**Fixed expenses:** Edit `FIXED_CATEGORIES` in `bot.js` for the `/fixed` command.

**Currency:** Change `currency: 'USD'` in `parser.js` and `receipt.js`.


## 💵 Monthly cost

| Item | Cost |
|---|---|
| Actual Budget (PikaPods) | ~$1-2 |
| Google Cloud Vision | $0 |
| Telegram | $0 |
| Fly.io | $0 |
| LLM / AI APIs | **$0** |
| **Total** | **$1-2/month** |


## 📁 Project structure

```
bot.js          Main bot (Telegram + Actual Budget + NLQ + transfers)
parser.js       Keyword parser with auto-learning
receipt.js      Google Cloud Vision receipt scanner
.env.example    Config template
Dockerfile      Docker / Fly.io deployment
fly.toml        Fly.io config
```


## 🤝 Contributing

PRs welcome. Ideas:

- 🚨 Budget alerts (warn when a category exceeds a threshold)
- 📋 Monthly report card (auto-sent on the 1st)
- 📤 CSV export via Telegram
- 🔥 No-spend day streak tracker
- 💱 Multi-currency support
- 🏦 Bank CSV auto-import
- ⏰ Recurring expense auto-entry


## 📄 License

MIT
