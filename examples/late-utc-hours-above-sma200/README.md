# Hold only 21:00–23:00 UTC above the 200-day SMA

A strategy config for [Janorium](https://janorium.com), the free crypto backtesting platform. It is public strategy
[#102 on the leaderboard](https://janorium.com/leaderboard/102), where its backtests can be opened without an account.

- **Market:** Binance USDT-M perpetual, 1x isolated
- **Default instrument:** BTCUSDT, 1h candles (a backtest can run it on another coin)
- **Side:** long only

## Rules

- Decide on the 20:00 UTC hourly candle (`TIME` with `hour: 20`); the buy fills at the 21:00 UTC open.
- Only while the close is above the 200-day SMA (daily candles built from the hourly ones).
- Flat on the 22:00 UTC candle's close (`flatAtHourUtc: 22`), so the position is held from 21:00 to 23:00 UTC.
- 99% of equity. Binance USDT-M perpetual, 1x leverage, isolated margin. Fee 0.02% per side and no slippage: the maker rate on both legs.

## Read before using

The maker-fee assumption is optimistic. At taker fees (0.05% plus 0.01% slippage) the same rules lost about 71% on BTC over 2020–2026. It ranks high on the leaderboard only under the maker assumption.

## Config features used

- time predicate `TIME`
- session exit `flatAtHourUtc`
- higher-timeframe reference (`timeframe: "1d"`)

## Run it

1. Sign up at [janorium.com](https://janorium.com) (free) and create a new strategy.
2. Paste [`config.json`](config.json) into the editor's JSON box and press **Apply**.
3. Save it and start a backtest: pick the coin, timeframe and period. Fees, slippage and (on futures) funding are part of the result.

Field-by-field reference: [schema/README.md](../../schema/README.md). How fills, stops, fees and funding are modelled: [How Janorium backtests](https://janorium.com/guides/how-janorium-backtests).
