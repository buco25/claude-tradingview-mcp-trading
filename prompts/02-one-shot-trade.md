# One-Shot Trading Setup Prompt

Paste this entire prompt into your Claude Code terminal. It will read your strategy,
pull live data from TradingView, run a safety check, and execute a trade if everything lines up.

---

You are setting up an automated trading system connected to TradingView via the MCP.
Work through the following steps in order. Show your work at each step.

---

## STEP 1 — Load strategy

Read the file `rules.json` in this directory.
Confirm you have loaded:
- The strategy name and sources
- The indicators being used
- The bias criteria (what makes it bullish/bearish)
- The entry rules for long trades
- The risk rules

---

## STEP 2 — Pull live market data from TradingView

Using the TradingView MCP tools:

1. Call `quote_get` — get the current price (last, OHLC, volume)
2. Call `data_get_study_values` — get current EMA 21, EMA 50, EMA 200, and RSI values from the chart
3. Call `data_get_ohlcv` with `count: 100` and `summary: false` — get the last 100 4H bars (close prices needed for MACD calculation)

---

## STEP 3 — Calculate MACD from raw price data

Using the close prices from Step 2, calculate the MACD manually:

- **MACD line** = 12-period EMA of close minus 26-period EMA of close
- **Signal line** = 9-period EMA of the MACD line
- **Current state**: is the MACD line above or below the signal line right now?

Use standard EMA formula: EMA = (close × multiplier) + (previous EMA × (1 − multiplier))
where multiplier = 2 / (period + 1)

Show the current MACD line value, signal line value, and whether momentum is bullish or bearish.

---

## STEP 4 — Determine market bias

Using the bias_criteria from rules.json and the live data from Steps 2 and 3, determine whether
the current market bias is BULLISH, BEARISH, or NEUTRAL.

Show your reasoning for each condition.

---

## STEP 5 — Run the safety check

Based on the bias determined in Step 4, evaluate the appropriate entry_rules from rules.json.

For a LONG trade, check each condition:

| Condition | Required | Actual | Result |
|-----------|----------|--------|--------|
| Price above EMA 200 | Yes | [live value] | PASS / FAIL |
| EMA 21 above EMA 50 | Yes | [live values] | PASS / FAIL |
| Price pulled back into EMA 21–50 zone | Yes | [live values] | PASS / FAIL |
| RSI between 35 and 58 | Yes | [live value] | PASS / FAIL |
| MACD line above signal line | Yes | [live values] | PASS / FAIL |

**VERDICT:**
- If ALL conditions show PASS → print: `✅ ALL CONDITIONS MET — READY TO EXECUTE`
- If ANY condition shows FAIL → print: `🚫 TRADE BLOCKED` and list exactly which conditions failed with the actual values. Stop here. Do not proceed to Step 6.

---

## STEP 6 — Execute the trade (only if Step 5 = ALL PASS)

Load the BitGet credentials from the `.env` file in this directory.

Place a LONG order on BTCUSDT with the following parameters:
- **Symbol:** BTCUSDT
- **Side:** buy
- **Order type:** market
- **Size:** calculate using the risk_rules from rules.json — risk 1% of the portfolio value provided in the .env file
- **Stop loss:** place at the 0.786 Fibonacci level below the most recent swing low (identify this from the OHLCV data)

Use the BitGet REST API v2:
- Endpoint: `POST https://api.bitget.com/api/v2/mix/order/placeOrder`
- Product type: `USDT-FUTURES`
- Sign the request using HMAC-SHA256 with your secret key

After placing the order, confirm the order ID and status. Print:
`✅ ORDER PLACED — [order ID] — [symbol] [side] [size] at market`

---

## STEP 7 — Save the safety check log

Save a JSON file called `safety-check-log.json` in this directory with:
- Timestamp
- Symbol and timeframe
- All indicator values used
- Each condition and its result (PASS/FAIL)
- Final verdict
- Order details (if a trade was placed)

This log is your audit trail. Every trade decision is recorded here.
