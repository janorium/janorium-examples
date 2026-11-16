# DCA: 52 weekly buys, then hold

A strategy config for [Janorium](https://janorium.com), the free crypto backtesting platform. It is public strategy
[#36 on the leaderboard](https://janorium.com/leaderboard/36), where its backtests can be opened without an account.

- **Market:** Binance spot
- **Default instrument:** BTCUSDT, 1d candles (a backtest can run it on another coin)
- **Side:** long only

## Rules

- Buy 190 USDT of the coin on every Monday daily candle (`DAYOFWEEK` with `day: 1`); the order fills at the next open.
- `reArmOn: "ALWAYS"` lets the layer buy again while earlier buys are still open; `maxOpenPositions: 52` stops it after 52 buys (9,880 USDT in total).
- Every buy is held to the end of the window (the exit signal never fires).
- Spot. Fee 0.1% and slippage 0.05% per side.

## What the backtest showed

DCA won the 12-month windows that started near the 2021 top and had the smaller drawdown in every one of the 136 windows, but the lump sum ended ahead in 93 of them.

Full write-up with every run: [DCA or lump sum: a backtest of BTC and ETH](https://janorium.com/articles/dca-vs-lump-sum-btc-eth-backtest).

## Config features used

- time predicate `DAYOFWEEK`
- `reArmOn: "ALWAYS"` for repeated buys
- `maxOpenPositions` as a cap on the number of buys

## Run it

1. Sign up at [janorium.com](https://janorium.com) (free) and create a new strategy.
2. Paste [`config.json`](config.json) into the editor's JSON box and press **Apply**.
3. Save it and start a backtest: pick the coin, timeframe and period. Fees, slippage and (on futures) funding are part of the result.

Field-by-field reference: [schema/README.md](../../schema/README.md). How fills, stops, fees and funding are modelled: [How Janorium backtests](https://janorium.com/guides/how-janorium-backtests).
