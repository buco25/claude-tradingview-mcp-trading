# Claude + TradingView MCP — Automated Trading

Connect Claude Code to TradingView and BitGet to execute trades automatically.
Built as a follow-up to the "How To Connect Claude to TradingView (Insanely Cool)" video.

**Requires:** The TradingView MCP from the first video already set up and connected.

---

## What This Does

1. Reads your trading strategy from `rules.json`
2. Pulls live indicator data from your TradingView chart via MCP
3. Calculates MACD from raw price data (works on free TradingView accounts)
4. Runs a safety check — all conditions from your strategy must pass
5. Executes a trade via BitGet API only if every condition is met
6. Logs every decision to `safety-check-log.json`

---

## Setup

### 1. Clone this repo

```bash
git clone https://github.com/jackson-video-resources/claude-tradingview-mcp-trading
cd claude-tradingview-mcp-trading
```

### 2. Add your BitGet API credentials

Copy `.env.example` to `.env` and fill in your details:

```bash
cp .env.example .env
```

Get your API key from BitGet:
- Go to API Management in your BitGet account
- Create a new API key
- **Withdrawals: OFF** — always
- **IP whitelist: ON** — add your own IP address
- Copy the key, secret, and passphrase into your `.env` file

Add your portfolio value so position sizing works:
```
PORTFOLIO_VALUE_USD=1000
```

### 3. Make sure TradingView MCP is running

From the first video — TradingView Desktop should be open and your MCP connected.
Check with: `tv_health_check` in Claude Code.

### 4. Set your chart

- Symbol: BTCUSDT (or whatever you're trading)
- Timeframe: 4H
- Indicators on chart: your strategy's backtest + RSI 14

### 5. Build your strategy (optional — skip if using the example)

If you want to build your own strategy from trader transcripts:
1. Scrape transcripts using Apify (link in video description)
2. Paste the output into `prompts/01-extract-strategy.md`
3. Run that prompt in Claude Code — it will generate your `rules.json`

---

## Run a Trade

Open Claude Code in this directory and paste the contents of `prompts/02-one-shot-trade.md`.

That's it. Claude will:
- Read your strategy
- Check every condition live
- Show you exactly what passed and what failed
- Execute only if everything lines up

---

## Files

| File | What it does |
|------|-------------|
| `rules.json` | Your strategy — indicators, entry rules, risk rules |
| `.env` | Your BitGet credentials (never commit this) |
| `prompts/01-extract-strategy.md` | Build rules.json from trader transcripts |
| `prompts/02-one-shot-trade.md` | The one-shot prompt — run this to trade |
| `safety-check-log.json` | Auto-generated audit trail of every decision |

---

## Safety

- The safety check blocks trades that don't meet every condition
- Position sizing is calculated from your rules — default max 1-2% risk per trade
- Stop loss is placed automatically based on your rules
- All decisions are logged

**This is not financial advice.** Build your strategy properly. Backtest it. Paper trade before going live.

---

## Resources

- [TradingView MCP (first video)](https://github.com/jackson-video-resources/tradingview-mcp-jackson)
- [Apify transcript scraper](https://apify.com?fpr=3ly3yd)
- BitGet: link in video description
