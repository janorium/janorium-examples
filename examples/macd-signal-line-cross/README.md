# MACD 12/26/9 signal-line cross

A strategy config for [Janorium](https://janorium.com), the free crypto backtesting platform. It is public strategy
[#70 on the leaderboard](https://janorium.com/leaderboard/70), where its backtests can be opened without an account.

- **Market:** Binance spot
- **Default instrument:** BTCUSDT, 1d candles (a backtest can run it on another coin)
- **Side:** long only

## Rules

- Enter long when the MACD(12,26,9) line crosses above its signal line.
- Exit when it crosses back below. No stop-loss.
- Spot, 95% of equity, fills at the next open. Fee 0.1% and slippage 0.05% per side.

## What the backtest showed

On 10 large coins in 2020–2026 the cross made money in 14 of 20 runs but beat buy and hold in 3; against random entries with the same holding time it came out ahead in 16 of 20.

Full write-up with every run: [MACD and Bollinger Bands on crypto: a backtest](https://janorium.com/articles/macd-bollinger-bands-crypto-backtest).

## Config features used

- multi-line indicator (`field: "macd"` / `"signal"`)
- `CROSS_UP` / `CROSS_DOWN` between two series

## Run it

1. Sign up at [janorium.com](https://janorium.com) (free) and create a new strategy.
2. Paste [`config.json`](config.json) into the editor's JSON box and press **Apply**.
3. Save it and start a backtest: pick the coin, timeframe and period. Fees, slippage and (on futures) funding are part of the result.

Field-by-field reference: [schema/README.md](../../schema/README.md). How fills, stops, fees and funding are modelled: [How Janorium backtests](https://janorium.com/guides/how-janorium-backtests).
