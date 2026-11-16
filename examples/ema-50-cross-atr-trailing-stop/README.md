# EMA 50 cross with a 3×ATR trailing stop

A strategy config for [Janorium](https://janorium.com), the free crypto backtesting platform. It is public strategy
[#77 on the leaderboard](https://janorium.com/leaderboard/77), where its backtests can be opened without an account.

- **Market:** Binance spot
- **Default instrument:** BTCUSDT, 4h candles (a backtest can run it on another coin)
- **Side:** long only

## Rules

- Enter long when a 4h close crosses above EMA 50.
- Exit when a close falls back below EMA 50, or at a trailing stop 3 × ATR(14) below the highest close since entry.
- Spot, 95% of equity, fills at the next open. Fee 0.1% and slippage 0.05% per side.

## What the backtest showed

In the same study a trailing stop lowered drawdown more often than a fixed stop, and took most of the return with it.

Full write-up with every run: [Does a stop-loss help? A backtest on 6 coins, 2020–2026](https://janorium.com/articles/stop-loss-crypto-backtest).

## Config features used

- `exit.trailingStop` with `atrMult`
- `exit.atrRef`

## Run it

1. Sign up at [janorium.com](https://janorium.com) (free) and create a new strategy.
2. Paste [`config.json`](config.json) into the editor's JSON box and press **Apply**.
3. Save it and start a backtest: pick the coin, timeframe and period. Fees, slippage and (on futures) funding are part of the result.

Field-by-field reference: [schema/README.md](../../schema/README.md). How fills, stops, fees and funding are modelled: [How Janorium backtests](https://janorium.com/guides/how-janorium-backtests).
