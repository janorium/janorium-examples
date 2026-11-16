# Buy the dip after a -5% day, hold 30 days

A strategy config for [Janorium](https://janorium.com), the free crypto backtesting platform. It is public strategy
[#47 on the leaderboard](https://janorium.com/leaderboard/47), where its backtests can be opened without an account.

- **Market:** Binance spot
- **Default instrument:** BTCUSDT, 1d candles (a backtest can run it on another coin)
- **Side:** long only

## Rules

- Enter long at the next open after a daily candle whose close-to-close return (`RETPCT`) is below -5%.
- Exit after 30 daily candles (`maxHoldingBars: 30`).
- Spot, 99% of equity. Fee 0.1% and slippage 0.05% per side.

## What the backtest showed

The day after a dip was better than usual on all 19 coins tested, but buying every dip and selling a month later ended above the random-entry median in only 16 of 38 cases.

Full write-up with every run: [Buy the dip? A backtest of -5% and -10% days on 19 coins](https://janorium.com/articles/buy-the-dip-crypto-backtest).

## Config features used

- candle return `RETPCT`
- time exit `maxHoldingBars`

## Run it

1. Sign up at [janorium.com](https://janorium.com) (free) and create a new strategy.
2. Paste [`config.json`](config.json) into the editor's JSON box and press **Apply**.
3. Save it and start a backtest: pick the coin, timeframe and period. Fees, slippage and (on futures) funding are part of the result.

Field-by-field reference: [schema/README.md](../../schema/README.md). How fills, stops, fees and funding are modelled: [How Janorium backtests](https://janorium.com/guides/how-janorium-backtests).
