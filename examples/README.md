# Examples

Each folder holds one strategy config (`config.json`) and a README with its rules, the result of the study it was
built for and a link to its runs on the [Janorium leaderboard](https://janorium.com/leaderboard). The configs are copied unchanged
from public strategies on janorium.com; only the key order was tidied for reading.

## Trend following

| Example | Market | Idea | Article |
| --- | --- | --- | --- |
| [Golden cross 50/200 on daily SMAs](golden-cross-50-200-daily/) | Perpetual, 4h | Long while the daily SMA 50 is above the daily SMA 200 | [read](https://janorium.com/articles/golden-cross-top-20-crypto-2020-2025) |
| [EMA 9/21 crossover on 4h candles](ema-9-21-crossover/) | Spot, 4h | Long while EMA 9 is above EMA 21 | [read](https://janorium.com/articles/moving-average-crossover-crypto-backtest) |
| [EMA 50 cross with a 5% stop-loss](ema-50-cross-5pct-stop/) | Spot, 4h | Trend entry on a close above EMA 50, fixed 5% stop | [read](https://janorium.com/articles/stop-loss-crypto-backtest) |
| [EMA 50 cross with a 3×ATR trailing stop](ema-50-cross-atr-trailing-stop/) | Spot, 4h | The same trend entry, trailing stop 3 × ATR(14) under the highest close | [read](https://janorium.com/articles/stop-loss-crypto-backtest) |

## Buy and hold, DCA

| Example | Market | Idea | Article |
| --- | --- | --- | --- |
| [Lump sum: buy once and hold](lump-sum-buy-and-hold/) | Spot, 1d | One buy of 9,880 USDT on the first candle, held to the end | [read](https://janorium.com/articles/dca-vs-lump-sum-btc-eth-backtest) |
| [DCA: 52 weekly buys, then hold](dca-52-weekly-buys/) | Spot, 1d | 190 USDT every Monday, 52 times, held to the end | [read](https://janorium.com/articles/dca-vs-lump-sum-btc-eth-backtest) |
| [DCA every Monday, 25 USDT](dca-every-monday/) | Spot, 1d | A fixed weekly buy on one weekday; change `day` to test the others | [read](https://janorium.com/articles/best-day-to-buy-bitcoin-dca-backtest) |
| [DCA bot: base order + 5 safety orders, take-profit +2%](dca-bot-safety-orders/) | Spot, 1h | Average down every -2%, close the whole deal at +2% from the average | [read](https://janorium.com/articles/dca-bot-safety-orders-backtest) |

## Oscillators and mean reversion

| Example | Market | Idea | Article |
| --- | --- | --- | --- |
| [RSI 30/70 reversal](rsi-30-70-reversal/) | Spot, 1d | Buy when RSI(14) climbs back above 30, sell when it crosses 70 | [read](https://janorium.com/articles/rsi-30-70-crypto-backtest) |
| [MACD 12/26/9 signal-line cross](macd-signal-line-cross/) | Spot, 1d | Long from a MACD cross above its signal line to the cross back | [read](https://janorium.com/articles/macd-bollinger-bands-crypto-backtest) |
| [Bollinger 20/2: lower band back to the middle](bollinger-lower-band-reversion/) | Spot, 1d | Buy a close back above the lower band, sell at the middle band | [read](https://janorium.com/articles/macd-bollinger-bands-crypto-backtest) |

## Event-driven

| Example | Market | Idea | Article |
| --- | --- | --- | --- |
| [Buy the dip after a -5% day, hold 30 days](buy-the-dip-5pct-day/) | Spot, 1d | Buy after a daily close-to-close drop worse than -5% | [read](https://janorium.com/articles/buy-the-dip-crypto-backtest) |

## Derivatives data

| Example | Market | Idea | Article |
| --- | --- | --- | --- |
| [Funding fade: long while funding is negative, hold 7 days](funding-fade-long/) | Perpetual, 4h | Go long on a perpetual when shorts are paying funding | [read](https://janorium.com/articles/funding-rate-signal-backtest) |
| [Long/short ratio fade: long when the crowd is most short](long-short-ratio-fade/) | Perpetual, 4h | Long when the account long/short ratio is in its 90-day bottom 10% | [read](https://janorium.com/articles/long-short-ratio-open-interest-backtest) |

## Time of day

| Example | Market | Idea | Article |
| --- | --- | --- | --- |
| [Hold only 21:00–23:00 UTC above the 200-day SMA](late-utc-hours-above-sma200/) | Perpetual, 1h | Two hours after the US close, only in an uptrend, with maker fees | — |

The numbers in the READMEs come from the linked articles and are fixed at the time they were written. The leaderboard
pages show every run made since.
