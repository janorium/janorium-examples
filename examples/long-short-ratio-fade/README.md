# Long/short ratio fade: long when the crowd is most short

A strategy config for [Janorium](https://janorium.com), the free crypto backtesting platform. It is public strategy
[#90 on the leaderboard](https://janorium.com/leaderboard/90), where its backtests can be opened without an account.

- **Market:** Binance USDT-M perpetual, 1x isolated
- **Default instrument:** BTCUSDT, 4h candles (a backtest can run it on another coin)
- **Side:** long only

## Rules

- Enter long when Binance's all-accounts long/short ratio (`LSRATIO`) sits in the bottom 10% of its last 540 four-hour values (90 days), measured with `PCTRANK` over `LSRATIO`.
- Exit after 42 four-hour candles (7 days).
- 95% of equity. Binance USDT-M perpetual, 1x leverage, isolated margin. Fee 0.05% and slippage 0.05% per side, funding charged on every settlement.

## What the backtest showed

On BTC from 2020-09 to 2026-10 the long fade made +103.56% over 100 trades, against +615.67% for holding; no long/short-ratio test survived a correction over all 180 tests.

Full write-up with every run: [Long/short ratio and open interest: do crowds predict?](https://janorium.com/articles/long-short-ratio-open-interest-backtest).

## Config features used

- indicator over another indicator (`source`)
- percentile rank `PCTRANK`
- long/short ratio `LSRATIO` (futures only)

## Run it

1. Sign up at [janorium.com](https://janorium.com) (free) and create a new strategy.
2. Paste [`config.json`](config.json) into the editor's JSON box and press **Apply**.
3. Save it and start a backtest: pick the coin, timeframe and period. Fees, slippage and (on futures) funding are part of the result.

Field-by-field reference: [schema/README.md](../../schema/README.md). How fills, stops, fees and funding are modelled: [How Janorium backtests](https://janorium.com/guides/how-janorium-backtests).
