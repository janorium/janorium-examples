# DCA bot: base order + 5 safety orders, take-profit +2%

A strategy config for [Janorium](https://janorium.com), the free crypto backtesting platform. It is public strategy
[#87 on the leaderboard](https://janorium.com/leaderboard/87), where its backtests can be opened without an account.

- **Market:** Binance spot
- **Default instrument:** BTCUSDT, 1h candles (a backtest can run it on another coin)
- **Side:** long only

## Rules

- Base order of 600 USDT at once.
- Up to five safety orders, each when an hourly close is 2% below the previous fill (`CLOSE` vs the `LAST_FILL` pseudo-series with `LT_PCT`): 600, 900, 1,350, 2,025 and 3,037.5 USDT (volume scale 1.5).
- Take-profit +2% from the average entry closes the whole deal (`exit.scope: "AGGREGATE"`); then a new deal starts. No stop-loss.
- Spot. Fee 0.1% and slippage 0.05% per side.

## What the backtest showed

On BTC since 2020 the bot closed 456 deals in a row and ended at +94.77%, against +170.30% for weekly buys and +1,065.16% for holding: 64.5% of the time every safety order was filled and it sat waiting for a rebound.

Full write-up with every run: [DCA bot with safety orders vs plain DCA: a backtest](https://janorium.com/articles/dca-bot-safety-orders-backtest).

## Config features used

- several entry layers as a ladder
- pseudo-series `LAST_FILL`
- percentage compare `LT_PCT`
- `exit.scope: "AGGREGATE"`

The same grid can also be written with the declarative `dca` block (see the [schema reference](../../schema/README.md#dca)).

## Run it

1. Sign up at [janorium.com](https://janorium.com) (free) and create a new strategy.
2. Paste [`config.json`](config.json) into the editor's JSON box and press **Apply**.
3. Save it and start a backtest: pick the coin, timeframe and period. Fees, slippage and (on futures) funding are part of the result.

Field-by-field reference: [schema/README.md](../../schema/README.md). How fills, stops, fees and funding are modelled: [How Janorium backtests](https://janorium.com/guides/how-janorium-backtests).
