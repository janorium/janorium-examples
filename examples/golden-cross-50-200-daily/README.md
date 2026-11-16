# Golden cross 50/200 on daily SMAs

A strategy config for [Janorium](https://janorium.com), the free crypto backtesting platform. It is public strategy
[#27 on the leaderboard](https://janorium.com/leaderboard/27), where its backtests can be opened without an account.

- **Market:** Binance USDT-M perpetual, 1x isolated
- **Default instrument:** BTCUSDT, 4h candles (a backtest can run it on another coin)
- **Side:** long only

## Rules

- Enter long when the daily SMA 50 is above the daily SMA 200. The strategy runs on 4h candles and reads the daily averages through `timeframe: "1d"`.
- Exit when the SMA 50 falls back below the SMA 200 (the death cross).
- 95% of equity per position, one position at a time; orders fill at the next candle's open.
- Binance USDT-M perpetual, 1x leverage, isolated margin. Fee 0.05% and slippage 0.05% per side, funding charged on every settlement.

## What the backtest showed

On Binance spot in 2020–2025 the rule made money on 9 of 19 large coins and beat holding on only 3 of the 12 that rose; on perpetuals it did worse on every coin.

Full write-up with every run: [Golden cross on the top-20 coins, 2020–2025: what the backtest showed](https://janorium.com/articles/golden-cross-top-20-crypto-2020-2025).

## Config features used

- `compare` of two indicators
- higher-timeframe reference (`timeframe: "1d"`)
- `exit.signal`
- `execution.fillAt: "NEXT_OPEN"`
- `market.futures`

## Run it

1. Sign up at [janorium.com](https://janorium.com) (free) and create a new strategy.
2. Paste [`config.json`](config.json) into the editor's JSON box and press **Apply**.
3. Save it and start a backtest: pick the coin, timeframe and period. Fees, slippage and (on futures) funding are part of the result.

Field-by-field reference: [schema/README.md](../../schema/README.md). How fills, stops, fees and funding are modelled: [How Janorium backtests](https://janorium.com/guides/how-janorium-backtests).
