# Funding fade: long while funding is negative, hold 7 days

A strategy config for [Janorium](https://janorium.com), the free crypto backtesting platform. It is public strategy
[#46 on the leaderboard](https://janorium.com/leaderboard/46), where its backtests can be opened without an account.

- **Market:** Binance USDT-M perpetual, 1x isolated
- **Default instrument:** BTCUSDT, 4h candles (a backtest can run it on another coin)
- **Side:** long only

## Rules

- Enter long when the last settled funding rate (`FUNDING`) is below 0.
- Exit after 42 four-hour candles (7 days).
- 95% of equity. Binance USDT-M perpetual, 1x leverage, isolated margin. Fee 0.05% and slippage 0.05% per side, funding charged on every settlement.

## What the backtest showed

Across 20 Binance perpetuals since 2020, buying negative funding made money on 9 of 20 coins. Only on BTC did it hold up statistically, and not in the last two years.

Full write-up with every run: [Funding as a signal: does it work? A backtest on 20 coins](https://janorium.com/articles/funding-rate-signal-backtest).

## Config features used

- funding rate `FUNDING` (futures only)
- time exit `maxHoldingBars`

## Run it

1. Sign up at [janorium.com](https://janorium.com) (free) and create a new strategy.
2. Paste [`config.json`](config.json) into the editor's JSON box and press **Apply**.
3. Save it and start a backtest: pick the coin, timeframe and period. Fees, slippage and (on futures) funding are part of the result.

Field-by-field reference: [schema/README.md](../../schema/README.md). How fills, stops, fees and funding are modelled: [How Janorium backtests](https://janorium.com/guides/how-janorium-backtests).
