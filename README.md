# Janorium strategy examples

Example strategy configs for [Janorium](https://janorium.com), a free web platform for backtesting crypto trading
strategies without writing code. Every config in this repository is a real public strategy from the platform. Each one
comes with its rules in plain words, the result of the study it was built for, and links to its runs on the
[leaderboard](https://janorium.com/leaderboard) and to the [article](https://janorium.com/articles) that tested it.

## What Janorium is

- **Backtesting on Binance history.** Strategies run on Binance spot and USDT-M perpetual futures candles from 2020
  on, on timeframes from 1 minute to 1 day.
- **Rules, not code.** A strategy is a declarative JSON config: 100+ indicators, entry and exit conditions, stops and
  take-profits, position sizing, DCA grids and leverage. You build it in a visual editor, or an AI assistant writes it
  from the [published reference](https://janorium.com/ai/strategy-config-reference.md).
- **Costs included.** Fees, slippage, funding payments and liquidation are part of every result.
- **Reports.** Return, win rate, Sharpe, max drawdown, the trade list and the equity curve against buy and hold. On
  top of that: a parameter optimizer with walk-forward checks, Monte Carlo resampling and a public leaderboard.
- **Backtesting only, and free.** Janorium never places orders and never connects to an exchange account. There are
  no paid plans.

## Examples

| Example | Market | Idea |
| --- | --- | --- |
| [Golden cross 50/200 on daily SMAs](examples/golden-cross-50-200-daily/) | Perpetual, 4h | Long while the daily SMA 50 is above the daily SMA 200 |
| [Lump sum: buy once and hold](examples/lump-sum-buy-and-hold/) | Spot, 1d | One buy of 9,880 USDT on the first candle, held to the end |
| [DCA: 52 weekly buys, then hold](examples/dca-52-weekly-buys/) | Spot, 1d | 190 USDT every Monday, 52 times, held to the end |
| [DCA every Monday, 25 USDT](examples/dca-every-monday/) | Spot, 1d | A fixed weekly buy on one weekday; change `day` to test the others |
| [DCA bot: base order + 5 safety orders, take-profit +2%](examples/dca-bot-safety-orders/) | Spot, 1h | Average down every -2%, close the whole deal at +2% from the average |
| [RSI 30/70 reversal](examples/rsi-30-70-reversal/) | Spot, 1d | Buy when RSI(14) climbs back above 30, sell when it crosses 70 |
| [MACD 12/26/9 signal-line cross](examples/macd-signal-line-cross/) | Spot, 1d | Long from a MACD cross above its signal line to the cross back |
| [Bollinger 20/2: lower band back to the middle](examples/bollinger-lower-band-reversion/) | Spot, 1d | Buy a close back above the lower band, sell at the middle band |
| [EMA 9/21 crossover on 4h candles](examples/ema-9-21-crossover/) | Spot, 4h | Long while EMA 9 is above EMA 21 |
| [EMA 50 cross with a 5% stop-loss](examples/ema-50-cross-5pct-stop/) | Spot, 4h | Trend entry on a close above EMA 50, fixed 5% stop |
| [EMA 50 cross with a 3×ATR trailing stop](examples/ema-50-cross-atr-trailing-stop/) | Spot, 4h | The same trend entry, trailing stop 3 × ATR(14) under the highest close |
| [Buy the dip after a -5% day, hold 30 days](examples/buy-the-dip-5pct-day/) | Spot, 1d | Buy after a daily close-to-close drop worse than -5% |
| [Funding fade: long while funding is negative, hold 7 days](examples/funding-fade-long/) | Perpetual, 4h | Go long on a perpetual when shorts are paying funding |
| [Long/short ratio fade: long when the crowd is most short](examples/long-short-ratio-fade/) | Perpetual, 4h | Long when the account long/short ratio is in its 90-day bottom 10% |
| [Hold only 21:00–23:00 UTC above the 200-day SMA](examples/late-utc-hours-above-sma200/) | Perpetual, 1h | Two hours after the US close, only in an uptrend, with maker fees |

Most of these are textbook rules tested as they are, and most did not beat holding the coin. The READMEs say so, with
the numbers from the articles. [examples/README.md](examples/README.md) groups them by type.

## Run an example

1. Sign up at [janorium.com](https://janorium.com). It is free.
2. Create a new strategy, paste the example's `config.json` into the editor's JSON box and press **Apply**.
3. Save it and start a backtest: pick the coin, the timeframe and the period. The symbol and timeframe in the config
   are only defaults.

To see results without an account, open the example's leaderboard page: public strategies show their backtests to
guests.

## Config format

- [schema/README.md](schema/README.md) is a short field-by-field guide: the root shapes, conditions, operators, the
  indicator list, exits and DCA.
- [schema/strategy.schema.json](schema/strategy.schema.json) is the structure as JSON Schema (draft-07), for editor
  autocompletion and quick checks. Janorium also checks cross-field rules that a schema cannot express.
- The complete contract is published as one file written for AI assistants:
  [strategy-config-reference.md](https://janorium.com/ai/strategy-config-reference.md). Give it to ChatGPT or Claude
  with your idea in plain words and it writes the config; the guide
  [Build a strategy with AI](https://janorium.com/guides/build-a-strategy-with-ai) shows the steps.

## MCP server (coming soon)

`janorium-mcp` will let Claude Desktop, Claude Code, Cursor and other MCP clients validate, dry-run and backtest
strategies on Janorium under your own API key, so an assistant answers with numbers from a real backtest. It is not
on npm yet. [mcp/README.md](mcp/README.md) has the planned setup.

## How the backtests work

- Conditions are checked once per candle, after it closes. An order fills at that candle's close plus slippage, or at
  the next candle's open when the strategy asks for it.
- Stops and take-profits are checked against the candle's high and low. When one candle touches both, the stop-loss
  is assumed to fill first.
- Fees are charged on entry and exit. On futures every Binance funding settlement during an open position is charged
  or credited, and liquidation is modelled.
- Not modelled: order book depth beyond the optional volume-based slippage, partial fills, latency, lot and tick
  sizes, and the exchange's own liquidation engine. Real liquidations can come earlier and cost more.

The full methodology: [How Janorium backtests](https://janorium.com/guides/how-janorium-backtests).

## Links

- Website: [janorium.com](https://janorium.com)
- Guides: [janorium.com/guides](https://janorium.com/guides)
- Articles with backtest results: [janorium.com/articles](https://janorium.com/articles)
- Strategy leaderboard: [janorium.com/leaderboard](https://janorium.com/leaderboard)
- X: [@janorium](https://x.com/janorium)

Found a mistake in an example, or want one added? Open an issue.

## License

The configs and documentation in this repository are released under the [MIT License](LICENSE). The Janorium
platform itself is not open source.
