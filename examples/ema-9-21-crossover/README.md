# EMA 9/21 crossover on 4h candles

A strategy config for [Janorium](https://janorium.com), the free crypto backtesting platform. It is public strategy
[#78 on the leaderboard](https://janorium.com/leaderboard/78), where its backtests can be opened without an account.

- **Market:** Binance spot
- **Default instrument:** BTCUSDT, 4h candles (a backtest can run it on another coin)
- **Side:** long only

## Rules

- Long while EMA 9 is above EMA 21 on 4h candles; flat when it falls below.
- Spot, 95% of equity, fills at the next open. Fee 0.1% and slippage 0.05% per side.

## What the backtest showed

Of six common crossovers on six large coins, five beat holding on only 1 or 2 of 6; on 4h candles the fast pairs traded more than 300 times per coin and paid for it in fees.

Full write-up with every run: [Which moving-average crossover works best on crypto?](https://janorium.com/articles/moving-average-crossover-crypto-backtest).

## Config features used

- `compare` of two moving averages
- state-based entry (`GT`) instead of a one-bar cross

## Run it

1. Sign up at [janorium.com](https://janorium.com) (free) and create a new strategy.
2. Paste [`config.json`](config.json) into the editor's JSON box and press **Apply**.
3. Save it and start a backtest: pick the coin, timeframe and period. Fees, slippage and (on futures) funding are part of the result.

Field-by-field reference: [schema/README.md](../../schema/README.md). How fills, stops, fees and funding are modelled: [How Janorium backtests](https://janorium.com/guides/how-janorium-backtests).
