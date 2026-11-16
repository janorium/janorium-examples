# Bollinger 20/2: lower band back to the middle

A strategy config for [Janorium](https://janorium.com), the free crypto backtesting platform. It is public strategy
[#71 on the leaderboard](https://janorium.com/leaderboard/71), where its backtests can be opened without an account.

- **Market:** Binance spot
- **Default instrument:** BTCUSDT, 1d candles (a backtest can run it on another coin)
- **Side:** long only

## Rules

- Enter long when the close crosses back above the lower Bollinger band (20, 2).
- Exit when the close reaches the middle band. No stop-loss.
- Spot, 95% of equity, fills at the next open. Fee 0.1% and slippage 0.05% per side.

## What the backtest showed

On 10 large coins in 2020–2026 the rule made money in 4 of 20 runs and beat holding in 1.

Full write-up with every run: [MACD and Bollinger Bands on crypto: a backtest](https://janorium.com/articles/macd-bollinger-bands-crypto-backtest).

## Config features used

- band indicator fields (`lower`, `middle`)
- price pseudo-series `CLOSE` in a `compare`

## Run it

1. Sign up at [janorium.com](https://janorium.com) (free) and create a new strategy.
2. Paste [`config.json`](config.json) into the editor's JSON box and press **Apply**.
3. Save it and start a backtest: pick the coin, timeframe and period. Fees, slippage and (on futures) funding are part of the result.

Field-by-field reference: [schema/README.md](../../schema/README.md). How fills, stops, fees and funding are modelled: [How Janorium backtests](https://janorium.com/guides/how-janorium-backtests).
