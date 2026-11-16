# RSI 30/70 reversal

A strategy config for [Janorium](https://janorium.com), the free crypto backtesting platform. It is public strategy
[#69 on the leaderboard](https://janorium.com/leaderboard/69), where its backtests can be opened without an account.

- **Market:** Binance spot
- **Default instrument:** BTCUSDT, 1d candles (a backtest can run it on another coin)
- **Side:** long only

## Rules

- Enter long when RSI(14) crosses up through 30.
- Exit when RSI(14) crosses up through 70. No stop-loss, no time limit.
- Spot, 95% of equity, fills at the next open. Fee 0.1% and slippage 0.05% per side.

## What the backtest showed

On 10 large coins, Binance spot 2020–2026, the rule made money in 12 of 20 coin × timeframe runs but beat buy and hold in only 2, and random entries with the same holding time in 7.

Full write-up with every run: [RSI 30/70 on crypto: does it work? A 10-coin backtest](https://janorium.com/articles/rsi-30-70-crypto-backtest).

## Config features used

- `condition` against a constant
- `CROSS_UP`

## Run it

1. Sign up at [janorium.com](https://janorium.com) (free) and create a new strategy.
2. Paste [`config.json`](config.json) into the editor's JSON box and press **Apply**.
3. Save it and start a backtest: pick the coin, timeframe and period. Fees, slippage and (on futures) funding are part of the result.

Field-by-field reference: [schema/README.md](../../schema/README.md). How fills, stops, fees and funding are modelled: [How Janorium backtests](https://janorium.com/guides/how-janorium-backtests).
