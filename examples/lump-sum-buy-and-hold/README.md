# Lump sum: buy once and hold

A strategy config for [Janorium](https://janorium.com), the free crypto backtesting platform. It is public strategy
[#35 on the leaderboard](https://janorium.com/leaderboard/35), where its backtests can be opened without an account.

- **Market:** Binance spot
- **Default instrument:** BTCUSDT, 1d candles (a backtest can run it on another coin)
- **Side:** long only

## Rules

- Buy 9,880 USDT of the coin on the first daily candle (`CLOSE > 0` is always true; with `maxOpenPositions: 1` it fires once).
- Hold to the end of the backtest window: the exit signal `CLOSE < 0` never fires, so the position closes on the last candle.
- Spot. Fee 0.1% and slippage 0.05% per side. Fills at the next open.

## What the backtest showed

Across 136 twelve-month windows on BTC and ETH since 2020, the lump sum ended ahead of 52 weekly buys 93 times; DCA had the smaller drawdown in all 136.

Full write-up with every run: [DCA or lump sum: a backtest of BTC and ETH](https://janorium.com/articles/dca-vs-lump-sum-btc-eth-backtest).

## Config features used

- fixed-size entry (`sizeAbs`)
- always-true entry and never-true exit (a buy-and-hold baseline)

## Run it

1. Sign up at [janorium.com](https://janorium.com) (free) and create a new strategy.
2. Paste [`config.json`](config.json) into the editor's JSON box and press **Apply**.
3. Save it and start a backtest: pick the coin, timeframe and period. Fees, slippage and (on futures) funding are part of the result.

Field-by-field reference: [schema/README.md](../../schema/README.md). How fills, stops, fees and funding are modelled: [How Janorium backtests](https://janorium.com/guides/how-janorium-backtests).
