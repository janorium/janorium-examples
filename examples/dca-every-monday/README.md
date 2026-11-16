# DCA every Monday, 25 USDT

A strategy config for [Janorium](https://janorium.com), the free crypto backtesting platform. It is public strategy
[#37 on the leaderboard](https://janorium.com/leaderboard/37), where its backtests can be opened without an account.

- **Market:** Binance spot
- **Default instrument:** BTCUSDT, 1d candles (a backtest can run it on another coin)
- **Side:** long only

## Rules

- Buy 25 USDT of the coin at the close of every Monday daily candle and hold to the end.
- Set `params.day` of `DAYOFWEEK` to 2…7 to buy on another weekday (ISO numbering, Monday = 1).
- Spot. Fee 0.1% and slippage 0.05% per side.

## What the backtest showed

Over 351 weeks of BTC, the best weekday (Monday) ended 2.08 percentage points ahead of the worst (Wednesday) on a +170% result; on ETH the gap was 3.42 points, and the winner changed from year to year.

Full write-up with every run: [The best day of the week to buy Bitcoin: a DCA backtest](https://janorium.com/articles/best-day-to-buy-bitcoin-dca-backtest).

## Config features used

- time predicate `DAYOFWEEK`
- fills at the signal candle's close (the default)

## Run it

1. Sign up at [janorium.com](https://janorium.com) (free) and create a new strategy.
2. Paste [`config.json`](config.json) into the editor's JSON box and press **Apply**.
3. Save it and start a backtest: pick the coin, timeframe and period. Fees, slippage and (on futures) funding are part of the result.

Field-by-field reference: [schema/README.md](../../schema/README.md). How fills, stops, fees and funding are modelled: [How Janorium backtests](https://janorium.com/guides/how-janorium-backtests).
