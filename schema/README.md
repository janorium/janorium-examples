# Janorium strategy config: a short reference

A Janorium strategy is one JSON object. This page covers the parts most strategies use. The complete contract, with
every field, every indicator parameter and the full list of validation rules, is the reference Janorium publishes for
AI assistants: [strategy-config-reference.md](https://janorium.com/ai/strategy-config-reference.md).

[strategy.schema.json](strategy.schema.json) is the same structure as JSON Schema (draft-07). Janorium checks every
config twice before it runs anything:

1. against the schema, which rejects a wrong shape or value with `422 INVALID_STRATEGY_CONFIG`;
2. against cross-field rules the schema cannot express, which reject a config with `400 CONFIG_CONFLICT` (for example,
   two entry layers with `risk.maxOpenPositions` left at 1).

The schema in this repository is a snapshot; when it and the platform disagree, the platform's validator wins.

## Root object

| Field | Required | What it is |
| --- | --- | --- |
| `name` | yes | Strategy name |
| `version` | no | Integer ≥ 1 |
| `market` | yes | Spot or futures, exchange, futures settings |
| `instrument` | yes | Default symbol and timeframe |
| `sides` | yes | `["LONG"]`, `["SHORT"]` or both |
| `risk` | yes | Costs, position caps, risk guards (the object is required, its fields are not) |
| `entries` | one of the shapes below | Entry layers |
| `exit` | one of the shapes below | Exit rules |
| `dca` | one of the shapes below | A declarative averaging-down grid |
| `execution` | no | When a decision becomes a fill |
| `defs` | no | Named sub-conditions, used as `{"ref": "name"}` |
| `params` | no | Named numbers, used as `{"$param": "name"}` in any numeric slot |
| `series` | no | Values defined by an event (advanced) |

Exactly one of three shapes is allowed: `entries` + `exit` (use this one), the older `entry` + `exit`, or `dca` on
its own. A strategy without an `exit` block is invalid unless it is a `dca` grid.

## Market and instrument

```json
"market": {
  "type": "futures",
  "exchange": "binance",
  "futures": { "contractType": "USDT_M_PERP", "leverage": 3, "marginMode": "ISOLATED", "applyFunding": true }
},
"instrument": { "symbol": "BTCUSDT", "timeframe": "4h" }
```

- `type` is `"spot"` or `"futures"` (lower case). `futures` is required for futures and must be absent for spot.
- `leverage` is an integer from 1 to 125; `marginMode` is `"ISOLATED"` or `"CROSS"`; `applyFunding` defaults to `true`.
- Spot opens only long positions, so a spot strategy uses `"sides": ["LONG"]`.
- `timeframe` is one of `1m`, `5m`, `15m`, `1h`, `4h`, `1d`. The symbol and timeframe are defaults: a backtest names
  its own and can run the same config on another coin.

## Risk and costs

| Field | Meaning |
| --- | --- |
| `maxOpenPositions` | Positions open at once, default **1**. Raise it for several layers, both sides or repeated buys |
| `maxOpenPositionsPerSide` | Optional cap per side |
| `feesPct` | Fee per side in percent: Binance spot taker 0.1% is `0.1` |
| `slippagePct` | Slippage per side in percent |
| `fees` | `{ "makerPct", "takerPct" }` instead of `feesPct` |
| `slippage` | A model instead of `slippagePct`: `CONSTANT`, `ATR_FRACTION` or `VOLUME_IMPACT` |
| `maxDailyLossPct`, `maxDrawdownPct`, `maxTradesPerDay`, `maxConsecutiveLosses`, … | Optional guards that stop the strategy trading |

Omitted fees and slippage count as zero in the engine. The Janorium editor fills realistic defaults for a new
strategy; when you write a config by hand, set them yourself.

## Entry layers

```json
"entries": [
  {
    "id": "golden-cross",
    "side": "LONG",
    "sizePct": 95,
    "reArmOn": "ALL_LAYERS_CLOSED",
    "conditions": { "operator": "AND", "list": [ ... ] }
  }
]
```

| Field | Meaning |
| --- | --- |
| `id`, `side`, `conditions` | Required. `side` is `"LONG"` or `"SHORT"` |
| `sizePct` / `sizeAbs` / `sizing` | Exactly one: percent of free equity, a fixed USDT amount, or the long form with risk-based modes (`RISK_PCT`, `RISK_ABS`, `VOL_TARGET`) |
| `reArmOn` | When the layer may fire again: `"ALL_LAYERS_CLOSED"` (default), `"THIS_LAYER_CLOSED"` or `"ALWAYS"` |
| `cooldownBars` | Fire at most once every N candles |
| `exit` | A per-layer exit that overrides the root one |
| `entryOrder` | Rest a STOP or LIMIT order instead of buying at the market |

Layers are evaluated in array order, and a later layer sees an earlier layer's fill on the same candle. That is how a
ladder of averaging-down layers works (see the [DCA bot example](../examples/dca-bot-safety-orders/)).

## Conditions

Entry conditions and signal exits use the same tree. A **group** combines children:

```json
{ "operator": "AND", "list": [ child, child ] }
```

`operator` is `AND`, `OR` or `NOT` (`NOT` takes exactly one child). A child is a group, a `condition`, a `compare` or
a `{"ref": "name"}` pointing into `defs`.

A **condition** compares an indicator with a number:

```json
{ "indicator": "RSI", "params": { "period": 14 }, "op": "CROSS_UP", "value": 30 }
```

A **compare** compares two series:

```json
{
  "left": { "indicator": "EMA", "params": { "period": 50 } },
  "op": "GT",
  "right": { "indicator": "SMA", "params": { "period": 200 }, "timeframe": "1d" }
}
```

Operators:

| Op | True when |
| --- | --- |
| `GT`, `LT`, `GTE`, `LTE` | x > y, x < y, x ≥ y, x ≤ y |
| `EQ` | x equals y, optionally within `tolerancePct` |
| `CROSS_UP`, `CROSS_DOWN` | x crosses above / below y on this candle |
| `GT_PCT`, `LT_PCT`, `GTE_PCT`, `LTE_PCT` | x is more than `pct` percent above / below y |
| `BETWEEN`, `OUTSIDE` | x is inside / outside `value`…`value2` (condition only) |
| `RISING`, `FALLING` | x rose / fell on each of the last `bars` candles (condition only) |

Useful extras on a condition or on each side of a compare:

- `params` are required. Spell every indicator parameter out; the engine does not fill defaults.
- `field` picks a line of a multi-line indicator: `macd` / `signal` / `hist` for `MACD`, `upper` / `middle` / `lower`
  for `BB`, `DONCHIAN` and `KELTNER`.
- `offset` reads N closed candles back.
- `holdsFor: N` needs the node true on each of the last N candles; `within: N` on at least one of them.
- `timeframe` reads a higher timeframe (`"1d"` on a 4h strategy, also `"1w"` and `"1M"`); `symbol` reads another
  instrument (`"BTCUSDT"` as a filter for an altcoin strategy).
- `source` runs an indicator over another indicator, for example `PCTRANK` over `LSRATIO` in the
  [long/short ratio example](../examples/long-short-ratio-fade/).

A candle where an indicator is still warming up makes the node false, never true.

## Indicators

114 codes. Their parameters, ranges and fields are in the
[full reference](https://janorium.com/ai/strategy-config-reference.md) and in the strategy editor.

| Group | Codes |
| --- | --- |
| Moving averages and trend | `SMA`, `EMA`, `WMA`, `SUPERTREND`, `ICHIMOKU`, `ADX`, `VORTEX`, `DISTEMA`, `CHANDELIER` |
| Momentum and oscillators | `RSI`, `CRSI`, `STOCHRSI`, `MACD`, `PPO`, `TSI`, `TRIX`, `UO`, `CMO`, `DPO`, `ROC`, `MFI` |
| Volatility and bands | `ATR`, `BB`, `KELTNER`, `DONCHIAN`, `HV`, `PARKINSON`, `GARMANKLASS`, `YANGZHANG`, `CHOP`, `TTMSQUEEZE`, `RANGEATR`, `STDDEV`, `ZSCORE` |
| Price and candles | `OPEN`, `HIGH`, `LOW`, `CLOSE`, `HL2`, `HLC3`, `OHLC4`, `HIGHEST`, `LOWEST`, `CANDLEPOS`, `BODYPCT`, `UPPERWICK`, `LOWERWICK`, `GAPPCT`, `RETPCT`, `STREAK` |
| Candlestick and chart patterns | `ENGULFING`, `PINBAR`, `INSIDEBAR`, `DOJI`, `HARAMI`, `PIERCING`, `STAR`, `SOLDIERS`, `TWEEZER`, `NRN`, `DOUBLE`, `TRIANGLE`, `FLAG`, `BOX` |
| Levels and market structure | `PDH`, `PDL`, `PDC`, `PWH`, `PWL`, `DAYOPEN`, `VWAP`, `AVWAP`, `IBHIGH`, `IBLOW`, `PIVOTHIGH`, `PIVOTLOW`, `HHLL`, `SWINGRANGE`, `FIBRETR`, `POC`, `BARSSINCE` |
| Volume and order flow | `VOLUME`, `QUOTEVOL`, `TRADES`, `AVGTRADESIZE`, `RVOLUME`, `OBV`, `CMF`, `VOLDELTA`, `CVD` |
| Derivatives (futures only) | `FUNDING`, `OI`, `OIVALUE`, `OICHG`, `LSRATIO`, `TAKERRATIO`, `MARK`, `INDEX`, `BASIS`, `DEPTH`, `DEPTHSHAPE` |
| Time and calendar | `TIME`, `SESSION`, `INTERVAL`, `DAYOFWEEK`, `MONTHDAY`, `MONTH`, `WEEKOFYEAR`, `QUARTER` |
| Cross-asset and statistics | `CORR`, `BETA`, `RATIO`, `SPREADZ`, `PCTRANK` |

Besides the codes, a few pseudo-series describe the open position and past trades, for example `AVG_ENTRY`,
`LAST_FILL`, `BARS_IN_POS` and `LOSSES_IN_ROW`. They take no `params`.

## Exit

```json
"exit": {
  "scope": "PER_POSITION",
  "stopLossPct": 5,
  "takeProfitPct": 12,
  "signal": { "operator": "AND", "list": [ ... ] }
}
```

| Field | Meaning |
| --- | --- |
| `scope` | `"PER_POSITION"` (default) or `"AGGREGATE"`: levels measured from the side's average entry |
| `stopLossPct`, `takeProfitPct` | Percent from the entry fill |
| `stopLossAtrMult`, `takeProfitAtrMult` + `atrRef` | Multiples of ATR at the entry candle; `atrRef` is an `ATR` reference |
| `takeProfitR` | Multiples of the initial risk; needs a stop |
| `stopLossRef`, `takeProfitRef` | A level taken from an indicator, such as a swing low |
| `takeProfits`, `stopLosses` | Ladders of up to 10 partial exits |
| `breakEven`, `trailingStop` | Move the stop to entry, or trail it by a multiple of ATR or along an indicator |
| `partialSignals` | Partial exits by condition |
| `maxHoldingBars`, `timeStop`, `flatAtHourUtc`, `flatBeforeFunding` | Time and session exits |
| `signal` | A condition group: close at the candle close when it becomes true |

When one candle touches both the stop and the take-profit, the stop fills first.

## DCA

The `dca` block is a whole strategy on its own: a base order, safety orders that average down, and a take-profit from
the average entry.

```json
"dca": {
  "side": "LONG",
  "start": { "operator": "AND", "list": [ { "indicator": "RSI", "params": { "period": 14 }, "op": "LT", "value": 40 } ] },
  "baseOrder": { "sizeAbs": 100 },
  "safetyOrders": { "maxCount": 5, "sizeAbs": 100, "volumeScale": 1.5, "stepPct": 2, "stepScale": 1.0, "priceRef": "AVG_ENTRY" },
  "takeProfit": { "fromAvgPct": 2 }
}
```

`risk.maxOpenPositions` must be at least `1 + safetyOrders.maxCount`. An optional `stopLoss.fromAvgPct` closes the deal
at a loss. A `dca` config has no `entries` and no root `exit`.

## Execution

```json
"execution": { "fillAt": "NEXT_OPEN" }
```

Conditions are read on each closed candle. By default (`"CLOSE"`) entries and signal exits fill at that candle's close
plus slippage. With `"NEXT_OPEN"` they fill at the next candle's open. Stops, take-profits and liquidations fill at
their level either way. Indicators warm up on the history before the backtest period where Binance has it.

## What a config cannot do

- Trade more than one symbol or timeframe at once. Other symbols and higher timeframes can only be read as filters.
- Use arithmetic expressions such as `EMA(50) * 1.02`; use `GT_PCT` / `LT_PCT`, `source` or a derived indicator.
- Run user code or scripts of any kind.
- Place limit or stop exits; only entries can rest as STOP or LIMIT orders.

## Using the schema in an editor

In VS Code, map the schema to your config files in `settings.json`:

```json
"json.schemas": [
  {
    "fileMatch": ["**/janorium/**/*.json"],
    "url": "https://raw.githubusercontent.com/janorium/janorium-examples/main/schema/strategy.schema.json"
  }
]
```

Do not add a `$schema` key to a config you paste into Janorium; keep the config to the fields described here.
