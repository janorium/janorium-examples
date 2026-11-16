# 18 · Strategy Config Reference (LLM-facing)

---

## 18.1. How to use this document

A strategy config is **one JSON object**. It is validated twice, both times before anything runs:

1. **JSON Schema** (draft-07). A failure returns HTTP `422 INVALID_STRATEGY_CONFIG`.
2. **Business rules** in `StrategyConfigValidator`. A failure returns HTTP `400 CONFIG_CONFLICT`.

The status belongs to the caller rather than to the rule: `POST /strategies`, `PUT /strategies/{id}`,
`POST /backtests` and `POST /strategies/dry-run` all report a business-rule violation as `400`, while
`POST /optimizations` reports the same violation on a generated variant as `422 CONFIG_CONFLICT`
(see [19-optimizer-run-reference.md](./19-optimizer-run-reference.md) §19.2).

**Both validations see the run's instrument, not the config's.** A config is authored against one
`instrument`, but a run names its own `symbol`/`timeframe` — and they legitimately differ on every
symbol-matrix batch, every optimizer sweep and every dry-run pointed elsewhere. `POST /backtests`,
`POST /strategies/dry-run` and `POST /optimizations` therefore bind the run's instrument onto the config
before validating it (once per `symbol × timeframe` combo), and the engine reads the same bound config. So a
config that `POST /strategies` accepts can still be refused by a particular run — see §18.5.7 and §18.5.8.

Rules for producing a config:

- Emit **only** the fields listed here. Several blocks are `additionalProperties: false` — an unknown key is a hard
  error, not a warning. These are: `execution`, `timeStop`, `sizing`, `pyramiding`, `trailingStop`, `trailingTakeProfit`, `breakEven`,
  `sourceRef`, `{"ref": …}`, every item of `takeProfits[]` / `stopLosses[]` / `partialSignals[]`, and `dca` with all
  of its sub-objects.
- Indicator `params` are **required**, not defaulted by the engine. The defaults in §18.6 are catalog/UI defaults.
  The validator (`POST /strategies/validate`, save, dry-run, backtest launch) resolves every indicator usage the way
  the engine does and rejects a missing or out-of-range param and an unknown code as `422 INVALID_STRATEGY_CONFIG`
  (`HARAMI: Missing required indicator param 'minPrevBodyPct' — …`). Always spell params out explicitly.
- The strategy config is **self-contained**: it carries its own `market`, `instrument`, `sides` and `risk`. It
  describes exactly one symbol on exactly one timeframe.
- Before answering, walk the checklist in §18.11.

---

## 18.2. Root object

| Field        | Type    | Required    | Constraints                                               |
| ------------ | ------- | ----------- | --------------------------------------------------------- |
| `name`       | string  | yes         | `minLength: 1`                                            |
| `version`    | integer | no          | `minimum: 1`                                              |
| `market`     | object  | yes         | §18.3                                                     |
| `instrument` | object  | yes         | §18.3                                                     |
| `sides`      | array   | yes         | `minItems: 1`, items `"LONG"` / `"SHORT"`                 |
| `risk`       | object  | yes         | §18.4 (the object is required; all of its fields are not) |
| `entries`    | array   | conditional | `minItems: 1`, §18.7                                      |
| `entry`      | object  | conditional | legacy shape, `minProperties: 1`, §18.7.3                 |
| `exit`       | object  | conditional | §18.8                                                     |
| `dca`        | object  | conditional | §18.9                                                     |
| `execution`  | object  | no          | when a decision becomes a fill, §18.10.1                  |
| `pyramiding` | object  | no          | §18.7.5                                                   |
| `defs`       | object  | no          | named sub-conditions, §18.5.6                             |
| `series`     | object  | no          | series defined by an event, §18.5.11                      |
| `params`     | object  | no          | named numbers referenced as `{"$param": …}`, §18.2.1      |

The root has a `oneOf` with exactly three legal shapes:

| #   | Shape                    | Must NOT also contain      |
| --- | ------------------------ | -------------------------- |
| 1   | `entries` **and** `exit` | `dca`                      |
| 2   | `entry` **and** `exit`   | `dca`                      |
| 3   | `dca` alone              | `exit`, `entries`, `entry` |

**Use shape 1 for every new config.** Shape 2 is a legacy single-layer form kept for older strategies. Shape 3 is
the declarative DCA grid, which compiles down to shape 1 internally.

Note that shape 1 and 2 require `exit` to be **present**. A strategy with no exit block is invalid.

The last five fields sit **outside** that `oneOf`: `execution`, `pyramiding`, `defs`, `series` and `params` may accompany
any of the three shapes (`pyramiding` is the one exception — it is rejected together with `dca`, §18.7.5).

### 18.2.1. `params` — named numbers

A root-level object of named numbers, referenced from **any numeric slot** as `{"$param": "name"}`. Before anything
else reads the config, every reference is replaced by its number and the `params` block is dropped, so the config is
literally the one written with numbers: it validates, runs and hashes identically.

```json
"params": { "atrPeriod": 14, "riskPct": 1.0 },
"entries": [ { "id": "long", "side": "LONG",
  "sizing": { "mode": "RISK_PCT", "riskPct": { "$param": "riskPct" } }, … } ],
"exit": { "stopLossAtrMult": 1.5,
  "atrRef": { "indicator": "ATR", "params": { "period": { "$param": "atrPeriod" } } },
  "trailingStop": { "atrMult": 1.5, "atrRef": { "indicator": "ATR", "params": { "period": { "$param": "atrPeriod" } } } } }
```

- Names match `^[A-Za-z][A-Za-z0-9_]{0,31}$`; at most 32 entries; values are finite numbers — else `422`.
- A reference carries **nothing else** (`{"$param": "x", "offset": 1}` is `422`). A name not in `params` is
  `400 CONFIG_CONFLICT` — `Param 'x' names no entry in params [...]`. An unused parameter is allowed.
- The substituted number meets the rule of the slot it lands in: `"stopLossPct": {"$param": "sl"}` with `sl: -1` is
  rejected exactly like `"stopLossPct": -1`. A reference in a string slot (`timeframe`, `op`) fails the schema.
- Only the **root** `params` is this block; an indicator's own `params` object is where most references sit.
- Use it when one idea has several usages — the ATR period of a condition, of `atrRef` and of the trail — and when
  the config will be optimized: sweep `params.atrPeriod` (doc 19 §19.4.4), not each usage.
- Saving a config that differs from the stored one only in spelling (a number moved into `params`) does **not**
  create a new strategy version.

---

## 18.3. `market` and `instrument`

### `market` — required `["type", "exchange"]`; when `type == "futures"`, `futures` is also required

| Field                  | Type    | Required      | Values / constraints                                |
| ---------------------- | ------- | ------------- | --------------------------------------------------- |
| `type`                 | string  | yes           | `"spot"` \| `"futures"` — **lower-case**            |
| `exchange`             | string  | yes           | `minLength: 1`, e.g. `"binance"`                    |
| `futures`              | object  | iff `futures` | required `["contractType","leverage","marginMode"]` |
| `futures.contractType` | string  | yes           | `"USDT_M_PERP"` — the only value                    |
| `futures.leverage`     | integer | yes           | `1..125`                                            |
| `futures.marginMode`   | string  | yes           | `"ISOLATED"` \| `"CROSS"` — **upper-case**          |
| `futures.applyFunding` | boolean | no            | default `true`                                      |

Do not emit a `futures` block for a spot strategy. On spot, leverage is always 1 and only `LONG` positions are ever
opened, so `sides` should be `["LONG"]`.

### `instrument` — required `["symbol", "timeframe"]`

| Field       | Type   | Constraints                                                               |
| ----------- | ------ | ------------------------------------------------------------------------- |
| `symbol`    | string | `minLength: 1`. Raw exchange symbol, uppercase, no separator: `BTCUSDT`   |
| `timeframe` | string | one of `"1m"`, `"5m"`, `"15m"`, `"1h"`, `"4h"`, `"1d"` — **nothing else** |

---

## 18.4. `risk`

No field is individually required, but the `risk` object itself is.

| Field                       | Type    | Constraints                                                                             | Default                 |
| --------------------------- | ------- | --------------------------------------------------------------------------------------- | ----------------------- |
| `maxOpenPositions`          | integer | `minimum: 1`                                                                            | **1**                   |
| `maxOpenPositionsPerSide`   | integer | `minimum: 1`                                                                            | unset = no per-side cap |
| `positionSizePct`           | number  | `> 0`, `maximum: 100`                                                                   | 100 (legacy shape only) |
| `positionSizeAbs`           | number  | `> 0`                                                                                   | — (legacy shape only)   |
| `feesPct`                   | number  | `minimum: 0`                                                                            | `0.0`                   |
| `slippagePct`               | number  | `minimum: 0`                                                                            | `0.0`                   |
| `fees`                      | object  | `{makerPct ≥ 0, takerPct ≥ 0}`, at least one key; **exclusive with `feesPct`**, §18.4.1 | unset = `feesPct`       |
| `slippage`                  | object  | `model` required; **exclusive with `slippagePct`**, §18.4.1                             | unset = `slippagePct`   |
| `maxVolumeParticipationPct` | number  | `> 0`, `maximum: 100`, §18.4.1                                                          | unset = no ceiling      |
| `onExcess`                  | string  | `"CLIP"` \| `"SKIP"`; needs `maxVolumeParticipationPct`                                 | `"CLIP"`                |
| `liquidationBuffer`         | number  | `minimum: 0`                                                                            | `0.0`                   |
| `maxDailyLossPct`           | number  | `> 0`, `maximum: 100`                                                                   | unset = guard off       |
| `maxDrawdownPct`            | number  | `> 0`, `maximum: 100`                                                                   | unset = guard off       |
| `maxConsecutiveLosses`      | object  | `{count ≥ 1, pauseBars ≥ 0}`, both required                                             | unset = guard off       |
| `maxTradesPerDay`           | integer | `minimum: 1`                                                                            | unset = guard off       |
| `equityCurveFilter`         | object  | `{smaBars ≥ 1}`, required                                                               | unset = guard off       |
| `fundingFilter`             | object  | `{maxAbsRatePct > 0}`, required                                                         | unset = guard off       |
| `maxDailyProfitPct`         | number  | `> 0`                                                                                   | unset = guard off       |
| `dailyTrailingDrawdownPct`  | number  | `> 0`, `maximum: 100`                                                                   | unset = guard off       |

The last eight are the **risk contour** (docs/pro-platform/03-risk-sizing-and-guards.md §3.6,
docs/edge/03-strategy-mechanisms.md §3.5.3): rules that stop the strategy trading, evaluated inside the backtest loop.
A non-positive value means "off" exactly as an absent field does, so `maxDailyLossPct: 0` disables the guard rather
than tripping it on every bar.

`maxDailyLossPct`, `maxDrawdownPct` and `dailyTrailingDrawdownPct` flatten the book (a `report.trades` row with
`exit_reason = RISK_GUARD`) and then block entries — until the next 00:00 UTC, until the end of the run, and until the
next 00:00 UTC respectively. The other five only block new entries. Every trip is persisted to
`report.backtest_risk_events` and readable via `GET /backtests/{id}/risk-events`. `fundingFilter` needs a funding
series, so it is a silent no-op on spot and on a futures symbol with no settlements loaded; under
`applyFunding: false` it still reads the rate, which is merely not charged (since 2026-11-03).

The two day guards of EDGE-7, measured on the bar-close mark-to-market equity:

- **`maxDailyProfitPct`** — once the day's gain reaches `X%` of the equity at 00:00 UTC, no entry until the next
  00:00 UTC (`risk_event DAILY_PROFIT_LOCK`). Open positions are left alone, and giving the gain back does not unlock
  the day.
- **`dailyTrailingDrawdownPct`** — once equity falls `X%` below the day's **intraday peak** (day-start equity
  included), the book is flattened and no entry is taken until the next 00:00 UTC
  (`risk_event DAILY_TRAILING_DRAWDOWN`). It differs from `maxDailyLossPct` only in its base: a day that ran up 6% and
  gave back 4% trips a 3% trailing drawdown while never showing a daily loss.

`maxOpenPositions` defaults to **1**, and that default is the single most common cause of a rejected config: a
strategy with two entry layers (e.g. one LONG and one SHORT) must set `maxOpenPositions` to at least 2, otherwise
validation fails with `risk.maxOpenPositions == 1 but entries has N layers`.

`positionSizePct` / `positionSizeAbs` apply **only** to the legacy `entry.long` / `entry.short` shape. In the
`entries[]` shape, sizing is per layer (`sizePct` / `sizeAbs` / `sizing`, §18.7.4) and these two fields are ignored.

Sizing arithmetic for the two margin-budget modes, per opened position:

```
freeEquity = equity - Σ committed        # committed = margin used (futures) or entry notional (spot)
margin     = sizeAbs            OR   freeEquity × sizePct / 100
notional   = margin × leverage           # leverage = 1 on spot
quantity   = notional / fillPrice
```

The three risk-budget modes (`RISK_PCT`, `RISK_ABS`, `VOL_TARGET`) invert this — the quantity is derived first and
the margin follows from it. See §18.7.4.

If the computed margin does not fit into `freeEquity`, the entry is **skipped silently** for that bar (the layer
stays armed) — it is not an error. `feesPct` and `slippagePct` are percentages, not fractions: Binance futures
taker fee 0.04% is `"feesPct": 0.04`.

### 18.4.1. Costs — `fees`, `slippage` and the volume ceiling

Two spellings, and the schema forbids mixing them: `feesPct` **or** `fees`, `slippagePct` **or** `slippage`. The
scalars are the older, simpler halves of the same two knobs — `feesPct` is the taker rate for both sides, and
`slippagePct` _is_ the `CONSTANT` model — so a config that declares neither block is priced exactly as it always was
(docs/pro-platform/04-execution-and-costs.md §4.4–§4.6).

```json
"risk": {
  "fees": { "makerPct": 0.02, "takerPct": 0.05 },
  "slippage": { "model": "VOLUME_IMPACT", "basePct": 0.01, "impact": 0.4 },
  "maxVolumeParticipationPct": 5,
  "onExcess": "CLIP"
}
```

**`fees`.** At least one of `makerPct` / `takerPct`; the missing side falls back to the one given, so
`{"takerPct": 0.05}` means 0.05 either way rather than "free to be a maker". Almost every fill crosses the spread —
market entries, market exits, stop-outs, ladder rungs, liquidations and triggered STOP entry orders are all **taker**.
The one **maker** fill is the entry leg of a filled `LIMIT` entry order (§18.7.6): it is charged `makerPct` and pays
no slippage, and its trade row carries `feeKind: "MAKER"`. Prefer plain `feesPct` unless the strategy rests limit
orders — with `feesPct` the two rates are equal and the distinction buys nothing.

**`slippage`.** `model` is required; the other keys depend on it.

| `model`         | Slippage in percent of the reference price        | Also required     |
| --------------- | ------------------------------------------------- | ----------------- |
| `CONSTANT`      | `basePct`                                         | —                 |
| `ATR_FRACTION`  | `basePct + k × ATR / price × 100`                 | `k` > 0, `atrRef` |
| `VOLUME_IMPACT` | `basePct + impact × notional / quoteVolume × 100` | `impact` > 0      |

Three things this table does not say out loud:

- **The dynamic models add to `basePct`, they do not replace it.** The floor is what stops a quiet bar (or an
  enormous one) from pricing a market order as free. `basePct` defaults to `0`, which makes that floor nothing —
  set it.
- **A model whose input is missing degrades to its floor**, not to zero and not to infinity: a `NaN` ATR, or a bar
  whose `quoteVolume` is unknown, yields exactly `basePct`. A run does not get cheaper on the bars its data is
  worst on.
- **`slippage.atrRef` is the model's own reference**, not the one on `exit` — a cost and a stop distance have no
  reason to be measured in the same ATR, and borrowing the exit's would lock the model out of strategies with no
  ATR exits. It obeys the usual rule: `indicator` must be `"ATR"`.

**`maxVolumeParticipationPct` / `onExcess`.** A ceiling on one order's share of the bar's quote turnover. Above it,
`CLIP` (the default) trims the order to the ceiling and opens the trimmed position; `SKIP` declines the entry
entirely and records the bar's outcome as `SKIPPED_LIQUIDITY`. `onExcess` without the ceiling is rejected — half a
rule is not a rule. Without a ceiling, a backtest on a thin pair happily reports a result nobody could have
executed.

`VOLUME_IMPACT` and the ceiling both read the bar's quote turnover, which the engine only has for candles ingested
with it. That cannot be checked from the config, so it is not a validation error: the model falls back to its floor
and the ceiling goes quiet, rather than silently deleting every trade in the run.

---

## 18.5. Conditions

Entry triggers (`entries[].conditions`, `entry.long`, `entry.short`, `dca.start`) and signal exits
(`exit.signal`, `entries[].exit.signal`) all use the same **condition group** shape.

### 18.5.1. `conditionGroup`

Required: `["operator"]`; `additionalProperties: false` — a group carries **only** the three keys below. In particular a
`holdsFor`/`within` window on a group is a schema error, not a window: it belongs on the `condition`/`compare` node it
qualifies (§18.5.5).

| Field        | Type   | Values                                                      |
| ------------ | ------ | ----------------------------------------------------------- |
| `operator`   | string | `"AND"` \| `"OR"` \| `"NOT"`                                |
| `list`       | array  | child nodes — **preferred key**                             |
| `conditions` | array  | alternative key for the same children (`list` wins if both) |

An empty/absent `AND` group is vacuously **true**; an empty `OR` group is vacuously **false**. `NOT` negates its
child and must have **exactly one** — anything else is a schema error. Note that `NOT` of a warmup bar is **true**:
the inner node is false because its operand is NaN, and the negation of false is true.

Each child is a **`condition`**, a **`compare`**, a nested **`conditionGroup`**, or a **`{"ref": "..."}"`** (§18.5.6).

Nesting is arbitrary, so `(A AND B) OR (C AND D)` is written directly:

```json
{
  "operator": "OR",
  "list": [
    {
      "operator": "AND",
      "list": [
        { "indicator": "RSI", "params": { "period": 14 }, "op": "LT", "value": 30 },
        { "indicator": "EMA", "params": { "period": 50 }, "op": "GT", "value": 100 }
      ]
    },
    {
      "operator": "AND",
      "list": [
        { "indicator": "RSI", "params": { "period": 14 }, "op": "GT", "value": 70 },
        { "indicator": "EMA", "params": { "period": 50 }, "op": "LT", "value": 50 }
      ]
    }
  ]
}
```

### 18.5.2. `condition` — indicator vs numeric constant

Required: `["indicator", "op"]`, plus `value` for every op except `RISING`/`FALLING`, which require `bars` instead.

| Field          | Type    | Required                        | Notes                                            |
| -------------- | ------- | ------------------------------- | ------------------------------------------------ |
| `indicator`    | string  | yes                             | catalog code, §18.6                              |
| `params`       | object  | per indicator                   | indicator params                                 |
| `field`        | string  | multi-line only                 | `macd`/`signal`/`hist`, `upper`/`middle`/`lower` |
| `source`       | object  | no                              | indicator-of-indicator, §18.6.2                  |
| `offset`       | integer | no                              | `0..500`, default `0`                            |
| `timeframe`    | string  | no                              | higher timeframe, §18.5.7                        |
| `symbol`       | string  | no                              | another instrument, §18.5.8                      |
| `op`           | string  | yes                             | §18.5.4                                          |
| `value`        | number  | except `RISING`/`FALLING`       | the constant the indicator is compared against   |
| `value2`       | number  | iff `op` is `BETWEEN`/`OUTSIDE` | upper edge of the band; must be **>** `value`    |
| `bars`         | integer | iff `op` is `RISING`/`FALLING`  | `1..500` monotone steps                          |
| `tolerancePct` | number  | no, `EQ` only                   | `> 0`; without it `EQ` is exact                  |
| `pct`          | number  | iff `op` ends `_PCT`            | `> 0`                                            |
| `holdsFor`     | integer | no                              | `1..500`, §18.5.5; exclusive with `within`       |
| `within`       | integer | no                              | `1..500`, §18.5.5; exclusive with `holdsFor`     |

### 18.5.3. `compare` — indicator vs indicator

Required: `["left", "op", "right"]`. `left` and `right` are `indicatorRef` objects
(`indicator`, `params`, `field`, `source`, `offset`, `timeframe`, `symbol`). `pct` is required iff `op` ends in `_PCT`. A compare also
accepts `tolerancePct` (for `EQ`) and `holdsFor`/`within`, but **not** `BETWEEN`/`OUTSIDE`/`RISING`/`FALLING` —
those need constants, not a second series.

There is **no `offset` on the `compare` node itself** — each side carries its own `offset`.

```json
{
  "left": { "indicator": "EMA", "params": { "period": 50 } },
  "op": "CROSS_UP",
  "right": { "indicator": "EMA", "params": { "period": 200 } }
}
```

### 18.5.4. Operators

Write `x` for the left side, `y` for the constant `value` (in a `condition`) or the right series (in a `compare`).
The first eleven work on both node kinds; the last four are `condition`-only.

| Op           | Meaning                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------ |
| `GT`         | `x > y`                                                                                                |
| `LT`         | `x < y`                                                                                                |
| `GTE`        | `x >= y`                                                                                               |
| `LTE`        | `x <= y`                                                                                               |
| `EQ`         | `x == y` — **exact** double equality by default; add `tolerancePct` for `\|x - y\| <= \|y\| × pct/100` |
| `CROSS_UP`   | `x[i-1] <= y[i-1] && x[i] > y[i]`; always `false` on the first bar                                     |
| `CROSS_DOWN` | `x[i-1] >= y[i-1] && x[i] < y[i]`; always `false` on the first bar                                     |
| `GT_PCT`     | `x > y × (1 + pct/100)` — requires `pct`                                                               |
| `LT_PCT`     | `x < y × (1 - pct/100)` — requires `pct`                                                               |
| `GTE_PCT`    | as `GT_PCT`, boundary inclusive                                                                        |
| `LTE_PCT`    | as `LT_PCT`, boundary inclusive                                                                        |
| `BETWEEN`    | `value <= x <= value2` — edges inclusive; `condition` only                                             |
| `OUTSIDE`    | the exact complement of `BETWEEN` on defined bars; `condition` only                                    |
| `RISING`     | `x[i] > x[i-1] > … > x[i-bars]` — strict; `condition` only, no `value`                                 |
| `FALLING`    | the mirror of `RISING`                                                                                 |

Any NaN operand (a warmup bar) makes the whole node **false** — never true, never an error. That holds for
`OUTSIDE` too: an undefined value is neither inside nor outside the band.

### 18.5.5. `offset`, `holdsFor` and `within`

`offset: N` reads the indicator `N` closed candles back: `0` (default) is the current candle, `1` the previous one.
`RSI[1] < 48` is `{"indicator":"RSI","params":{"period":14},"offset":1,"op":"LT","value":48}`. `CROSS_UP`/
`CROSS_DOWN` shift with the offset (evaluated at the offset bar against the bar before it). Range `0..500`.

`holdsFor: N` requires the node to be true on **each** of the last `N` bars; `within: N` requires it true on **at
least one** of them. They are mutually exclusive on a node, range `1..500`, and `1` means the plain single-bar node.
The window stacks on top of `offset` rather than replacing it, and on a `compare` it shifts both sides together. A
window above `1` — like `RISING`/`FALLING` — is rejected on a node that reads a pseudo-series (§18.6.3) or a setup
anchor (§18.5.10): those have no history, so the lagged copies read `NaN` and the node could never hold.

```json
{ "indicator": "CHOP", "params": { "period": 14 }, "op": "LT", "value": 38.2, "holdsFor": 3 }
{ "indicator": "RSI", "params": { "period": 14 }, "op": "CROSS_UP", "value": 30, "within": 5 }
```

`within` is what expresses a **sequence** without ten copy-pasted `offset` conditions: "RSI crossed 30 no more than
five bars ago AND price is now above EMA" is two nodes.

The deepest lag any node reads — the largest `offset` plus the widest window — is added to the warmup, so large
values consume history.

### 18.5.6. `defs` — named sub-conditions

A root-level object of named `conditionGroup`s, referenced anywhere a condition node may appear and inlined before
the engine runs. Behaviour is identical to writing the group out in place.

```json
"defs": {
  "trendUp": { "operator": "AND", "list": [
    { "left": { "indicator": "EMA", "params": { "period": 50 } }, "op": "GT",
      "right": { "indicator": "EMA", "params": { "period": 200 } } } ] }
},
"entries": [ { "id": "long", "side": "LONG", "sizePct": 20,
  "conditions": { "operator": "AND", "list": [
    { "ref": "trendUp" },
    { "indicator": "RSI", "params": { "period": 14 }, "op": "LT", "value": 30 } ] } } ]
```

Names match `^[A-Za-z0-9_-]{1,32}$`. A `{"ref": …}` node carries **nothing else** — no `offset`, no `params`. A
definition may reference another; an unknown name or a cycle is `CONFIG_CONFLICT`. Definitions nothing references
are dropped before the run and cost no warmup.

Use it when the same filter appears in several layers — a trend filter duplicated across four LONG/SHORT layers is
the case this exists for.

### 18.5.7. `timeframe` — reading a higher timeframe

`timeframe` computes an indicator on bars older than the run's own — "I trade 15m, but only with EMA200 on 4h
behind me". It takes one of the six run timeframe values or one of two **reference-only** ones — `1w` and `1M`
(below) — must be **strictly older** than the **run's** timeframe and a whole multiple of it, and is legal on any
`indicatorRef`: both sides of a `compare`, and `atrRef` /
`stopLossRef` / `trailingStop.indicatorRef` / the sizing references too. The run's, not the config's
`instrument.timeframe` — the two differ on every symbol-matrix batch, optimizer sweep and re-run on another
timeframe, and it is the run's that both the validator and the engine measure against (§18.1). So the same
`#4h` reference is a ratio of 16 under a 15m run, 4 under a 1h run, and a `400 CONFIG_CONFLICT` under a 4h one.

```json
{ "left": { "indicator": "CLOSE" }, "op": "GT", "right": { "indicator": "EMA", "params": { "period": 200 }, "timeframe": "4h" } }
```

The higher bars are **aggregated from the run's own candles**, not loaded natively. The series is then projected back onto the run's bars, each carrying the last higher bar
that **closed before it opened** — so on a 15m run a 4h value first appears on the 15m bar starting at 04:00, never
on the one that completes the 04:00 period, and holds for the next sixteen bars. That is also what a chart shows: a
staircase on the run's grid.

Three consequences worth knowing before writing one:

- **`offset`, `holdsFor`, `within` and `bars` count in bars of _that_ timeframe.** `EMA_200#4h` with `offset: 2` is
  two 4h bars back. `CROSS_UP`/`CROSS_DOWN` are the exception: they still compare against the previous **run** bar,
  which is what makes a higher-timeframe cross fire once, on the bar where the value changes.
- **Warmup is `(warmup + 1) × ratio` bars of the run's timeframe** — the indicator's own history plus the bar that
  has to close. `EMA(200)` on 4h under a 15m run costs 3216 candles.
- **A lag is capped at 500 bars of the run's timeframe, after conversion.** `offset: 21` on a 1d reference under a
  1h run is 504 and rejected.

**Weeks and months: `1w` and `1M`.** Two timeframes exist only for references — no run is ever on them, and
`instrument.timeframe` still takes the six. They are what "the 200-week SMA", "the 50/100-week death cross" and
"monthly RSI" are written on:

```json
{ "left": { "indicator": "SMA", "params": { "period": 50 }, "timeframe": "1w" }, "op": "CROSS_DOWN",
  "right": { "indicator": "SMA", "params": { "period": 100 }, "timeframe": "1w" } }
```

```json
{ "indicator": "RSI", "params": { "period": 14 }, "timeframe": "1M", "op": "LT", "value": 30 }
```

- **`1w`** is a week opening **Monday 00:00 UTC**, the way the exchange stamps its weekly klines. It has a fixed
  length, so everything above holds unchanged: 7 bars under a `1d` run, 42 under `4h`, and `offset`/`holdsFor`/
  `within`/`bars` count weeks.
- **`1M`** is a **calendar month** (1st, 00:00 UTC). **Case matters** — `1m` is a minute, and a lower-case month is
  therefore rejected as below the run's timeframe. A month has no fixed number of run bars, so a `1M` reference
  **may not carry `offset`, `holdsFor`, `within` or `bars`** (`400 CONFIG_CONFLICT`): "one month back" compiled to
  31 daily bars lands two months back from 1 March. Compare its current value instead, or use `1w`. Its warmup is
  charged as 31 days per month — `RSI(14)` on `1M` under a `1d` run costs `(14 + 1) × 31 = 465` bars.
- Both are aggregated from the run's own candles like any other reference, so they need no stored weekly or
  monthly data; a 200-week SMA under a `1d` run costs `201 × 7 = 1407` bars of warmup, which a backtest loads
  **before** `from` (§18.10, "Warmup") — so on spot `BTCUSDT 1d`, whose candles start in 2017-08, it is already
  defined on the first bar of any window starting from mid-2021, and on earlier windows the shortfall comes out of
  their first bars.

Rejected with `400 CONFIG_CONFLICT`: a timeframe equal to or below the run's; one on a pseudo-series
(`AVG_ENTRY`/`LAST_FILL`) or a time predicate (`TIME`/`INTERVAL`/`SESSION`/`DAYOFWEEK`/`MONTHDAY`/`MONTH`/`WEEKOFYEAR`/`QUARTER`); a
`holdsFor`/`within` on a `compare` whose two sides name different timeframes; and the lag cap above. A `source` may
not carry its own `timeframe` — it inherits the outer one, so `SMA(ATR(14), 50)` on 4h runs end to end on 4h bars
and keys as `SMA_50@ATR_14#4h`.

See [pro-platform/07-conditions-mtf-cross-symbol.md](./pro-platform/07-conditions-mtf-cross-symbol.md) §7.4.

### 18.5.8. `symbol` — reading another instrument

`symbol` points a reference at an instrument other than the one being traded — "I trade ETHUSDT, but only while
BTCUSDT is above its 200 EMA". It is a plain ticker (`BTCUSDT`), must exist on the run's own exchange, market type
and timeframe, and is legal on any `indicatorRef`: both sides of a `compare`, and `atrRef` / `stopLossRef` /
`trailingStop.indicatorRef` / the sizing references too. Absent means the instrument **the run is on**; writing
that one out explicitly is legal and means the same thing — it collapses to nothing and does not consume one of
the three cross-symbol slots. Which makes the field run-dependent in both directions: `EMA_200!BTCUSDT` is a
foreign series on an ETHUSDT run and the run's own series on a BTCUSDT one, and a pairwise `CORR!BTCUSDT` that
is valid on the first is `400 CONFIG_CONFLICT` on the second (§18.1).

```json
{ "left": { "indicator": "CLOSE", "symbol": "BTCUSDT" }, "op": "GT", "right": { "indicator": "EMA", "params": { "period": 200 }, "symbol": "BTCUSDT" } }
```

**The field means two different things, decided by the indicator, not by the config.** On an ordinary code it
**relocates** the computation: `EMA_200!BTCUSDT` is BTCUSDT's own EMA, and the traded instrument does not enter into
it. On one of the four pairwise codes — `CORR`, `BETA`, `RATIO`, `SPREADZ` — it names the **second leg**:
`CORR_20!BTCUSDT` correlates the traded instrument _with_ BTCUSDT, and there the field is **required**.

The other instrument's series is forward-filled onto the run's bars: each bar reads the reference bar that closed at
or before it, so a gap in the reference holds the previous value rather than skipping ahead, and no bar can ever read
data stamped after it. Two instruments on the same timeframe share a grid, so in the normal case that is the bar of
the very same timestamp.

Three consequences worth knowing before writing one:

- **At most 3 different instruments per config.** The limit counts distinct instruments, not references — twenty
  conditions on BTCUSDT cost one.
- **Warmup is the maximum across all of them**, unscaled: a referenced instrument runs on the run's own timeframe, so
  one of its bars is one of the run's. Unlike §18.5.7, nothing is multiplied.

Rejected with `400 CONFIG_CONFLICT`: more than 3 distinct instruments; a `symbol` on a pseudo-series
(`AVG_ENTRY`/`LAST_FILL`) or a time predicate (`TIME`/`INTERVAL`/`SESSION`/`DAYOFWEEK`/`MONTHDAY`/`MONTH`/`WEEKOFYEAR`/`QUARTER`); one of the four
pairwise codes written **without** a `symbol`, or pointed at the traded instrument (comparing an instrument with
itself is constant). An instrument with no candles on this exchange/market type/timeframe fails the run with
`NO_CANDLES` naming it. A `source` may not carry its own `symbol` — it inherits the outer one, so
`SMA(ATR(14), 50)` on BTCUSDT runs end to end on BTCUSDT and keys as `SMA_50@ATR_14!BTCUSDT`.

The `!SYMBOL` segment is the **last** of the key's four, so it composes with §18.5.7 as `EMA_200#4h!BTCUSDT`.

See [pro-platform/07-conditions-mtf-cross-symbol.md](./pro-platform/07-conditions-mtf-cross-symbol.md) §7.5.

### 18.5.9. `latch` — a condition that holds (Stateful conditions)

Every node above describes **one bar**. A `latch` remembers: it switches on when `set` holds and stays on until
`reset` holds — "the trend regime is on from `CHOP < 38` until `CHOP > 61`", with no chatter around a single
threshold.

```json
{ "latch": { "set":   { "indicator": "CHOP", "params": { "period": 14 }, "op": "LT", "value": 38 },
             "reset": { "indicator": "CHOP", "params": { "period": 14 }, "op": "GT", "value": 61 },
             "initial": false } }
```

On each bar: `false` if `reset` holds; otherwise `true` if `set` holds; otherwise the value from the previous bar.
**`reset` wins** when both hold. `initial` (default `false`) is the value held until `set` or `reset` first decides
it. `set` and `reset` are any condition nodes — a leaf, a group, a `{"ref"}`, another `latch`.

- Allowed anywhere a condition node is: entry conditions, `exit.signal`, `partialSignals`, `defs`, `dca.start`, and a
  research `event` or custom slice (where it is the way to define a regime with hysteresis).
- The latch is updated **once per bar, on every bar** from the run's warmup bar on — also on bars where its layer is
  in cooldown, a position is open, or an `AND` sibling is false. A traced bar (`/signals`, near-miss) reads the state
  and never moves it.
- Inside a `holdsFor`/`within` window each lag reads the latch's own state that many bars back.
- The node carries only `latch` — no `offset`, `holdsFor` or `within` of its own (put those on its children).
- In the trace the node is `kind: LATCH` with `result` = the held state, followed by its `SET[0]` and `RESET[0]`
  children with what they evaluated to on that bar.
- **State depends on where the history starts.** A backtest starts the latch at its warmup bar, a scan at the first
  bar of the dataset. After the first bar where `set` or `reset`
  holds they agree; before it, each holds `initial`.

Rejected with `400 CONFIG_CONFLICT`: a pseudo-series (`AVG_ENTRY`, `LAST_FILL`, `POS_*`, `BARS_IN_POS`, `EQUITY_DD`)
anywhere inside a latch — those change within a bar and depend on which side and position asks, so there is no one
value to latch. See [edge/03-strategy-mechanisms.md](./edge/03-strategy-mechanisms.md) §3.2.1.

### 18.5.10. `setup` → `trigger` → `invalidate` on an entry layer

A same-bar `AND` cannot say "first the pullback, then the reclaim, unless the pullback's low breaks". A layer can:

```json
{ "id": "pullback-long", "side": "LONG", "sizePct": 10,
  "setup":      { "operator": "AND", "list": [ { "ref": "uptrend" }, { "indicator": "RSI", "params": { "period": 14 }, "op": "LT", "value": 40 } ] },
  "trigger":    { "left": { "indicator": "CLOSE" }, "op": "CROSS_UP", "right": { "indicator": "EMA", "params": { "period": 20 } } },
  "invalidate": { "left": { "indicator": "CLOSE" }, "op": "LT", "right": { "anchor": "setup", "take": "LOW" } },
  "armedForBars": 12,
  "anchors": [ { "indicator": "ATR", "params": { "period": 14 } } ],
  "exit": { "stopLossRef": { "anchor": "setup", "take": "LOW" } } }
```

The layer is `IDLE` until `setup` holds; on that bar it becomes `ARMED` and freezes the bar's `OPEN/HIGH/LOW/CLOSE`
and every series in `anchors`. While armed, on each bar: `invalidate` (back to `IDLE`) → `armedForBars` exceeded
(back to `IDLE`) → `trigger` (enter — with every usual gate: sizing, caps, the structural stop). A fill spends the
setup (back to `IDLE`, and `cooldownBars`/`reArmOn` apply as always).

| Field | Default | Meaning |
| --- | --- | --- |
| `setup` | — | Any condition node. Needs `trigger` and `armedForBars`. May not read anchors. |
| `trigger` | — | Replaces `conditions` (a layer has exactly one of the two). Without `setup` it is just `conditions`. |
| `invalidate` | none | Any condition node; may read anchors. |
| `armedForBars` | — | `1..500`. The trigger is eligible on bars `bar0+1 … bar0+armedForBars`; the setup expires on the next bar. |
| `allowSameBar` | `false` | Let the trigger fire on `bar0` itself (then the order on that bar is `setup` → `trigger`). |
| `setupCooldownBars` | `0` | Bars after an invalidation or expiry before the setup may arm again. |
| `anchors` | `[]` | Up to 8 `indicatorRef`s frozen at arming, read as `{"anchor": "setup", "take": "<indicatorKey>"}`. |

`{"anchor": "setup", "take": "LOW"}` is a compare operand (either side) or an `exit.stopLossRef`. `take` is
`OPEN/HIGH/LOW/CLOSE` or the key of one of the layer's `anchors` (`ATR_14`). It has no `offset`, and `CROSS_*`
against it is always false (a frozen value has no previous bar). A multi-param key matches its anchor **whatever the
order of its param tokens**: write it in catalog order (`DOUBLE_TOP_5_5_0.5_1.5_100_neckline`) — the stored config comes
back from storage with its params re-ordered (by key length, then bytewise), so the engine keys the anchor as
`DOUBLE_5_TOP_5_0.5_100_1.5_neckline` and matches the take by code plus the sorted tokens (`AnchorRefs.canonicalTake`).
Until 2026-09-23 such a take silently read `NaN` and the trigger never fired; one-param anchors were never affected.

- The setup machine runs on **every** bar, before the entry step and whatever it skips — a setup expires on time
  even through a risk-guard block. A layer in cooldown cannot arm; an armed setup is not disarmed by cooldown.
- Per bar, `bars.csv` has `layer_<id>_state` (`IDLE`/`ARMED`) for each setup layer, and `/signals` carries
  `layerState`, `armedBars`, `anchors`. Outcomes `NOT_ARMED_SETUP`, `SETUP_INVALIDATED`, `SETUP_EXPIRED`.

Rejected with `400 CONFIG_CONFLICT`: an anchor anywhere but a setup layer's `trigger`, `invalidate` or
`exit.stopLossRef` (including `setup` itself, `defs` and the strategy-level exit); a `take` that is neither a candle
value nor one of the layer's `anchors`; an anchored `stopLossRef` whose series is not price-scale. Schema errors:
`setup` without `trigger`/`armedForBars`; `conditions` together with `trigger`; `invalidate`/`armedForBars`/
`allowSameBar`/`setupCooldownBars`/`anchors` without `setup`.

### 18.5.11. `series` — values defined by an event (Series)

A condition says whether something holds **now**. Some levels are the value of a series **at an event**: "the high of
the bar that broke out", "bars since the last cross", "closes above VWAP among the last five". The root `series` block
names them, and `{"series": "<name>"}` reads them wherever an indicator operand goes:

```json
"defs": { "breakout": { "operator": "AND", "list": [
  { "left": { "indicator": "CLOSE" }, "op": "CROSS_UP",
    "right": { "indicator": "HIGHEST", "params": { "period": 20 }, "source": { "indicator": "HIGH" }, "offset": 1 } } ] } },
"series": {
  "breakoutHigh":    { "kind": "VALUEWHEN", "when": { "ref": "breakout" }, "take": { "indicator": "HIGH" } },
  "sinceBreakout":   { "kind": "BARSSINCE", "when": { "ref": "breakout" } },
  "closesAboveVwap": { "kind": "COUNT", "window": 5,
                       "when": { "left": { "indicator": "CLOSE" }, "op": "GT", "right": { "indicator": "VWAP", "params": { "anchor": "DAY" } } } }
}
```

| `kind` | Value on bar `i` | Before it is defined | Fields |
| --- | --- | --- | --- |
| `VALUEWHEN` | `take` on the most recent bar `≤ i` where `when` held; `occurrence: k` — on the (k+1)-th most recent | NaN until the (k+1)-th event | `take` (required), `occurrence` `0..50`, default 0 |
| `BARSSINCE` | `i − j` for the most recent `j ≤ i` where `when` held (`0` on the event bar) | NaN until the first event | — |
| `COUNT` | how many of the last `window` bars (`i` included) `when` held on | NaN while fewer than `minBars` bars were seen | `window` `2..500` (required), `minBars` `1..window`, default `window` |

- Names match `^[A-Za-z][A-Za-z0-9_]{0,31}$`, at most 16 series. `when` is any condition node (a `{"ref"}`, a group,
  a `latch`); `take` is any `indicatorRef`, read at its own `offset` on the event bar.
- **An event on the current bar counts.** "Strictly before this bar" is `offset: 1` on the reference.
- The reference is `{"series": "breakoutHigh", "offset": 1}` — an `offset` and nothing else (no `params`, `field`,
  `source`, `timeframe`, `symbol`). It may be the left side of a `condition` (`{"series": "closesAboveVwap", "op": "GTE",
  "value": 3}` is a 3-of-5 quorum — stricter than `within: 5`, looser than `holdsFor: 5`), either side of a `compare`,
  and an `exit.stopLossRef` when it is a `VALUEWHEN` of a price-scale `take` ("stop under the breakout bar's low"). It
  has history, so `holdsFor`/`within` and `CROSS_*` work on it; it can be read inside a `latch`.
- **Computed from the first bar of the data**, once per bar, before any condition — in a backtest from the first
  loaded (warmup) bar, in a scan from the first row.
- **Warmup.** `COUNT` adds `window − 1` bars on top of its `when`'s own warmup, so the first traded bar has a full
  window. The onset of `VALUEWHEN`/`BARSSINCE` depends on when the data first prints an event, so for them warmup is a
  lower bound, as for the anchored codes (§18.6).
- Not an indicator: a series is not in `GET /backtests/{id}/indicators` and not on the chart. Per bar, `bars.csv`
  has a `series__<name>` column, `/signals` a `series` object on every bar, and a trace leaf names it `series__<name>`.

Rejected with `400 CONFIG_CONFLICT`: a `{"series"}` naming no entry of the block; a series whose `when`/`take` reads a
series (directly or through `defs`), a pseudo-series or a setup anchor; `minBars` above `window`; a series
`stopLossRef` that is not a `VALUEWHEN` of a price-scale `take`. Schema errors: `take`/`occurrence` on anything but
`VALUEWHEN`, `window`/`minBars` on anything but `COUNT`, a missing `take` or `window`, a condition with both
`indicator` and `series`. See [edge/03-strategy-mechanisms.md](./edge/03-strategy-mechanisms.md) §3.3.

---

## 18.6. Indicator catalog

These 114 codes are the **entire** set. An unknown code fails the run.

| Code           | Params (in this order)                                                                                                                                 | `field` values                          | Default `field`            | Warmup bars                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------- |
| `RSI`          | `period` int, catalog default 14, 1..500                                                                                                               | `value`                                 | —                          | `period`                                                                                       |
| `CRSI`         | `rsiPeriod` int 3, `streakPeriod` int 2 (both 1..500), `rankPeriod` int 100 (1..5000)                                                                  | `value`                                 | —                          | `max(rsiPeriod, streakPeriod, rankPeriod + 1)`                                                 |
| `STOCHRSI`     | `rsiPeriod` int 14 (1..500), `stochPeriod` int 14 (2..500), `k` int 3, `d` int 3 (both 1..100)                                                         | `k`, `d`                                | `k`                        | `rsiPeriod + stochPeriod + k - 2`, `+ d - 1` for `d`                                           |
| `EMA`          | `period` int, default 50, 1..1000                                                                                                                      | `value`                                 | —                          | `period - 1`                                                                                   |
| `SMA`          | `period` int, default 50, 1..1000                                                                                                                      | `value`                                 | —                          | `period - 1`                                                                                   |
| `WMA`          | `period` int, default 9, 1..1000                                                                                                                       | `value`                                 | —                          | `period - 1`                                                                                   |
| `MACD`         | `fast` 12, `slow` 26, `signal` 9 (all int, 1..500)                                                                                                     | `macd`, `signal`, `hist`                | `macd`                     | `max(fast,slow)-1`, `+ signal-1` for `signal`/`hist`                                           |
| `BB`           | `period` int 20 (1..1000), `stdDev` number 2 (0.1..10)                                                                                                 | `upper`, `middle`, `lower`              | `middle`                   | `period - 1`                                                                                   |
| `ATR`          | `period` int, default 14, 1..500                                                                                                                       | `value`                                 | —                          | `period`                                                                                       |
| `OPEN`         | none                                                                                                                                                   | `value`                                 | —                          | 0                                                                                              |
| `HIGH`         | none                                                                                                                                                   | `value`                                 | —                          | 0                                                                                              |
| `LOW`          | none                                                                                                                                                   | `value`                                 | —                          | 0                                                                                              |
| `CLOSE`        | none                                                                                                                                                   | `value`                                 | —                          | 0                                                                                              |
| `CANDLEPOS`    | none                                                                                                                                                   | `value`                                 | —                          | 0                                                                                              |
| `DISTEMA`      | `emaPeriod` int 20 (1..1000), `atrPeriod` int 14 (1..500)                                                                                              | `value`                                 | —                          | `max(emaPeriod-1, atrPeriod)`                                                                  |
| `INTERVAL`     | `everyBars` int, default 24, 1..10000                                                                                                                  | `value`                                 | —                          | 1                                                                                              |
| `TIME`         | `hour` int, default 0, **0..23**; optional `minute` int **0..59**                                                                                      | `value`                                 | —                          | 0                                                                                              |
| `SESSION`      | `startHour` int 8, `endHour` int 16 (both **0..23**, must differ)                                                                                      | `value`                                 | —                          | 0                                                                                              |
| `DAYOFWEEK`    | `day` int, default 1, **1..7** (ISO, Mon=1)                                                                                                            | `value`                                 | —                          | 0                                                                                              |
| `MONTHDAY`     | `day` int, default 1, **1..31**                                                                                                                        | `value`                                 | —                          | 0                                                                                              |
| `MONTH`        | `month` int, default 1, **1..12** (UTC, Jan=1); 1 on every bar of the month                                                                            | `value`                                 | —                          | 0                                                                                              |
| `WEEKOFYEAR`   | `week` int, default 1, **1..53**, **ISO 8601** (Mon start, UTC). X posts often differ: Mon 2026-10-19 is ISO 43, not 42. For dates: `MONTH`+`MONTHDAY` | `value`                                 | —                          | 0                                                                                              |
| `QUARTER`      | `quarter` int, default 1, **1..4** (UTC, Q1 = Jan–Mar); 1 on every bar of the quarter                                                                  | `value`                                 | —                          | 0                                                                                              |
| `HL2`          | none                                                                                                                                                   | `value`                                 | —                          | 0                                                                                              |
| `HLC3`         | none                                                                                                                                                   | `value`                                 | —                          | 0                                                                                              |
| `OHLC4`        | none                                                                                                                                                   | `value`                                 | —                          | 0                                                                                              |
| `VOLUME`       | none                                                                                                                                                   | `value`                                 | —                          | 0                                                                                              |
| `QUOTEVOL`     | none                                                                                                                                                   | `value`                                 | —                          | 0                                                                                              |
| `TRADES`       | none                                                                                                                                                   | `value`                                 | —                          | 0                                                                                              |
| `AVGTRADESIZE` | none                                                                                                                                                   | `value`                                 | —                          | 0                                                                                              |
| `RVOLUME`      | `period` int, default 240, 24..5000                                                                                                                    | `value`                                 | —                          | `period`                                                                                       |
| `OBV`          | none                                                                                                                                                   | `value`                                 | —                          | 0                                                                                              |
| `VWAP`         | `anchor` **string** `"DAY"`\|`"WEEK"`, default `"DAY"`                                                                                                 | `value`                                 | —                          | 0                                                                                              |
| `MFI`          | `period` int, default 14, 1..500                                                                                                                       | `value`                                 | —                          | `period`                                                                                       |
| `CMF`          | `period` int, default 20, 1..500                                                                                                                       | `value`                                 | —                          | `period - 1`                                                                                   |
| `FUNDING`      | none — **futures only, backtest only**                                                                                                                 | `value`                                 | —                          | 0                                                                                              |
| `HIGHEST`      | `period` int, default 20, 2..5000                                                                                                                      | `value`                                 | —                          | `period - 1`                                                                                   |
| `LOWEST`       | `period` int, default 20, 2..5000                                                                                                                      | `value`                                 | —                          | `period - 1`                                                                                   |
| `DONCHIAN`     | `period` int, default 20, 2..5000                                                                                                                      | `upper`, `middle`, `lower`              | `middle`                   | `period - 1`                                                                                   |
| `KELTNER`      | `period` int 20 (2..5000), `atrPeriod` int 14 (2..5000), `mult` number 2 (0.1..10)                                                                     | `upper`, `middle`, `lower`              | `middle`                   | `max(period-1, atrPeriod)`                                                                     |
| `PARKINSON`    | `period` int, default 20, 2..5000                                                                                                                      | `value`                                 | —                          | `period - 1`                                                                                   |
| `GARMANKLASS`  | `period` int, default 20, 2..5000                                                                                                                      | `value`                                 | —                          | `period - 1`                                                                                   |
| `YANGZHANG`    | `period` int, default 20, 2..5000                                                                                                                      | `value`                                 | —                          | `period`                                                                                       |
| `HV`           | `period` int, default 20, 2..5000                                                                                                                      | `value`                                 | —                          | `period`                                                                                       |
| `CHOP`         | `period` int, default 14, 2..5000                                                                                                                      | `value`                                 | —                          | `period`                                                                                       |
| `TTMSQUEEZE`   | `bbPeriod` int 20 (2..5000), `bbStdDev` number 2 (0.1..10), `kcPeriod` int 20 (2..5000), `kcAtrPeriod` int 14 (2..5000), `kcMult` number 1.5 (0.1..10) | `value`                                 | —                          | `max(bbPeriod-1, kcPeriod-1, kcAtrPeriod)`                                                     |
| `CHANDELIER`   | `period` int 22 (2..5000), `atrPeriod` int 22 (2..5000), `mult` number 3 (0.1..10)                                                                     | `long`, `short`                         | `long`                     | `max(period-1, atrPeriod)`                                                                     |
| `POC`          | `period` int 100 (2..5000), `bins` int 24 (4..200)                                                                                                     | `poc`, `vah`, `val`                     | `poc`                      | `period - 1`                                                                                   |
| `BODYPCT`      | none                                                                                                                                                   | `value`                                 | —                          | 0                                                                                              |
| `UPPERWICK`    | none                                                                                                                                                   | `value`                                 | —                          | 0                                                                                              |
| `LOWERWICK`    | none                                                                                                                                                   | `value`                                 | —                          | 0                                                                                              |
| `GAPPCT`       | none                                                                                                                                                   | `value`                                 | —                          | 1                                                                                              |
| `RETPCT`       | none                                                                                                                                                   | `value`                                 | —                          | 1                                                                                              |
| `ROC`          | `period` int, default 9, 1..5000                                                                                                                       | `value`                                 | —                          | `period`                                                                                       |
| `STREAK`       | none                                                                                                                                                   | `value`                                 | —                          | 0                                                                                              |
| `RANGEATR`     | `atrPeriod` int, default 14, 1..500                                                                                                                    | `value`                                 | —                          | `atrPeriod`                                                                                    |
| `ENGULFING`    | none                                                                                                                                                   | `bull`, `bear`                          | `bull`                     | 1                                                                                              |
| `PINBAR`       | `wickRatio` number, default 2, 1..10                                                                                                                   | `value`                                 | —                          | 0                                                                                              |
| `INSIDEBAR`    | none                                                                                                                                                   | `value`                                 | —                          | 1                                                                                              |
| `DOJI`         | `bodyMaxPct` number, default 10, 1..50                                                                                                                 | `value`                                 | —                          | 0                                                                                              |
| `HARAMI` | `minPrevBodyPct` number 50 (1..100), `maxBodyRatio` number 0.5 (0.05..1) | `bull`, `bear` | `bull` | 1 |
| `PIERCING` | `minBodyPct` number, default 50, 1..100 | `bull`, `bear` | `bull` | 1 |
| `STAR` | `minBodyPct` number 50 (1..100), `starMaxBodyPct` number 30 (1..100) | `bull`, `bear` | `bull` | 2 |
| `SOLDIERS` | `minBodyPct` number 50 (1..100), `maxWickPct` number 30 (1..100) | `bull`, `bear` | `bull` | 2 |
| `TWEEZER` | `tolAtr` number 0.1 (0.01..1), `atrPeriod` int 14 (1..500) | `bull`, `bear` | `bull` | `atrPeriod` |
| `NRN` | `period` int, default 7, 2..100 | `value` | — | `period - 1` |
| `PPO`          | `fast` 12, `slow` 26, `signal` 9 (all int, 1..500)                                                                                                     | `ppo`, `signal`, `hist`                 | `ppo`                      | `max(fast,slow)-1`, `+ signal-1` for `signal`/`hist`                                           |
| `TSI`          | `long` int 25 (1..500), `short` int 13 (1..500)                                                                                                        | `value`                                 | —                          | `long + short - 1`                                                                             |
| `TRIX`         | `period` int, default 15, 1..500                                                                                                                       | `value`                                 | —                          | `3*(period-1) + 1`                                                                             |
| `UO`           | `fast` 7, `medium` 14, `slow` 28 (all int, 1..500)                                                                                                     | `value`                                 | —                          | `max(fast, medium, slow)`                                                                      |
| `CMO`          | `period` int, default 14, 1..500                                                                                                                       | `value`                                 | —                          | `period`                                                                                       |
| `DPO`          | `period` int, default 20, 2..1000                                                                                                                      | `value`                                 | —                          | `period - 1 + (period/2 + 1)`                                                                  |
| `VORTEX`       | `period` int, default 14, 1..500                                                                                                                       | `plus`, `minus`                         | `plus`                     | `period`                                                                                       |
| `ADX`          | `diPeriod` int 14, `adxPeriod` int 14 (both 1..500)                                                                                                    | `adx`, `plusDi`, `minusDi`              | `adx`                      | `diPeriod` for `plusDi`/`minusDi`, `diPeriod + adxPeriod - 1` for `adx`                        |
| `SUPERTREND`   | `atrPeriod` int 10 (1..500), `mult` number 3 (0.1..10)                                                                                                 | `line`, `dir`                           | `line`                     | `atrPeriod`                                                                                    |
| `ICHIMOKU`     | `tenkan` 9, `kijun` 26, `senkouB` 52, `displacement` 26 (all int, 1..500)                                                                              | `tenkan`, `kijun`, `senkouA`, `senkouB` | `kijun`                    | per field: `tenkan-1`; `kijun-1`; `max(tenkan,kijun)-1+displacement`; `senkouB-1+displacement` |
| `PDH`          | none                                                                                                                                                   | `value`                                 | —                          | see note ⚑                                                                                     |
| `PDL`          | none                                                                                                                                                   | `value`                                 | —                          | see note ⚑                                                                                     |
| `PDC`          | none                                                                                                                                                   | `value`                                 | —                          | see note ⚑                                                                                     |
| `PWH`          | none                                                                                                                                                   | `value`                                 | —                          | see note ⚑                                                                                     |
| `PWL`          | none                                                                                                                                                   | `value`                                 | —                          | see note ⚑                                                                                     |
| `DAYOPEN`      | none                                                                                                                                                   | `value`                                 | —                          | 0                                                                                              |
| `AVWAP`        | `anchor` **string** `"DAY"`                                                                                                                            | `"WEEK"`                                | `"MONTH"`, default `"DAY"` | `value`                                                                                        | —                | 0   |
| `IBHIGH`       | `minutes` int, default 60, 15..480                                                                                                                     | `value`                                 | —                          | see note ⚑                                                                                     |
| `IBLOW`        | `minutes` int, default 60, 15..480                                                                                                                     | `value`                                 | —                          | see note ⚑                                                                                     |
| `PIVOTHIGH`    | `left` int 3 (1..500), `right` int 3 (1..500)                                                                                                          | `value`                                 | —                          | `left + right` ⚑                                                                               |
| `PIVOTLOW`     | `left` int 3 (1..500), `right` int 3 (1..500)                                                                                                          | `value`                                 | —                          | `left + right` ⚑                                                                               |
| `HHLL`         | `left` int 3 (1..500), `right` int 3 (1..500)                                                                                                          | `value`                                 | —                          | `left + right` ⚑                                                                               |
| `SWINGRANGE`   | `left` int 3 (1..500), `right` int 3 (1..500)                                                                                                          | `value`                                 | —                          | `left + right` ⚑                                                                               |
| `FIBRETR`      | `left` int 3 (1..500), `right` int 3 (1..500)                                                                                                          | `value`                                 | —                          | `left + right` ⚑                                                                               |
| `DOUBLE`       | `side` **string** `"TOP"` \| `"BOTTOM"`, `left` int 5 (1..500), `right` int 5 (1..500), `tolAtr` number 0.5 (0.05..5), `minDepthAtr` number 1.5 (0.1..20), `maxBars` int 100 (1..1000) | `value` (0/1), `neckline`, `target`, `invalid` (prices) | `value` | `left + right` ⚑ (levels: NaN until the first figure) |
| `TRIANGLE`     | `kind` **string** `"SYM"` \| `"ASC"` \| `"DESC"` \| `"WEDGEUP"` \| `"WEDGEDOWN"` \| `"ANY"`, `left` int 5, `right` int 5, `flatTolAtr` number 0.25 (0.01..5), `maxBars` int 60 (1..1000) | `bull`, `bear` (0/1), `upper`, `lower` (prices) | `bull` | `left + right` ⚑ (lines: NaN unless armed) |
| `FLAG`         | `side` **string** `"BULL"` \| `"BEAR"`, `poleBars` int 10 (2..500), `poleAtr` number 3 (0.5..20), `flagBars` int 15 (3..500), `maxRetrace` number 0.5 (0.05..1) | `value` (0/1), `upper`, `lower`, `target` (prices) | `value` | `max(poleBars − 1, 14)` ⚑ (levels: NaN until the first flag arms) |
| `BOX`          | `period` int 20 (2..500), `maxWidthAtr` number 2.5 (0.1..20) | `bull`, `bear` (0/1), `upper`, `lower` (prices) | `bull` | `max(period, 15)` ⚑ (edges: NaN unless the box qualifies) |
| `BARSSINCE`    | `left` int 3 (1..500), `right` int 3 (1..500), `which` **string** `"HIGH"`                                                                             | `"LOW"` default `"HIGH"`                | `value`                    | —                                                                                              | `left + right` ⚑ |
| `CORR`         | `period` int, default 20, 2..5000                                                                                                                      | `value`                                 | —                          | `period` ✱                                                                                     |
| `BETA`         | `period` int, default 60, 2..5000                                                                                                                      | `value`                                 | —                          | `period` ✱                                                                                     |
| `RATIO`        | —                                                                                                                                                      | `value`                                 | —                          | `0` ✱                                                                                          |
| `SPREADZ`      | `period` int, default 100, 2..5000                                                                                                                     | `value`                                 | —                          | `period - 1` ✱                                                                                 |
| `PCTRANK`      | `window` int, default 1000, 2..20000                                                                                                                   | `value`                                 | —                          | `window - 1`                                                                                   |
| `STDDEV`       | `period` int, default 20, 2..5000                                                                                                                      | `value`                                 | —                          | `period - 1`                                                                                   |
| `ZSCORE`       | `period` int, default 20, 2..5000                                                                                                                      | `value`                                 | —                          | `period - 1`                                                                                   |
| `OI`           | none — **futures only, backtest only**                                                                                                                 | `value`                                 | —                          | 0                                                                                              |
| `OIVALUE`      | none — **futures only, backtest only**                                                                                                                 | `value`                                 | —                          | 0                                                                                              |
| `OICHG`        | `period` int, default 24, 1..5000 — **futures only, backtest only**                                                                                    | `value`                                 | —                          | `period`                                                                                       |
| `LSRATIO`      | `kind` **string** `"ACCOUNT"`\|`"POSITION"`\|`"TOP_ACCOUNT"`, default `"POSITION"` — **futures only, backtest only**                                   | `value`                                 | —                          | 0                                                                                              |
| `TAKERRATIO`   | none — **futures only, backtest only**                                                                                                                 | `value`                                 | —                          | 0                                                                                              |
| `VOLDELTA`     | `period` int, default 24, 1..5000 — **backtest only** (spot too)                                                                                       | `value`                                 | —                          | `period - 1`                                                                                   |
| `CVD`          | `anchor` **string** `"DAY"`\|`"WEEK"`\|`"MONTH"`, default `"DAY"` — **backtest only** (spot too)                                                 | `value`                                 | —                          | 0                                                                                              |
| `MARK`         | none — **futures only, backtest only, flagged symbols only** ✦                                                                                          | `value`                                 | —                          | 0                                                                                              |
| `INDEX`        | none — **futures only, backtest only, flagged symbols only** ✦                                                                                          | `value`                                 | —                          | 0                                                                                              |
| `BASIS`        | none — **futures only, backtest only, flagged symbols only** ✦                                                                                          | `value`                                 | —                          | 0                                                                                              |
| `DEPTH`        | `pct` int, default 1, 1..5; `side` `TOTAL\|BID\|ASK\|IMBALANCE`, default `TOTAL` — **futures only, backtest only, flagged symbols only** ✦             | `value`                                 | —                          | 0                                                                                              |
| `DEPTHSHAPE`   | `inner` int, default 1, 1..4; `outer` int, default 5, 2..5, `inner < outer` — **futures only, backtest only, flagged symbols only** ✦                   | `value`                                 | —                          | 0                                                                                              |

**✱ These four require a `symbol`** (§18.5.8): their value is a function of **two** instruments, so a reference
without one has no second leg and is rejected with `400 CONFIG_CONFLICT`. `CORR` is the rolling correlation of the two
instruments' returns (−1…1), `BETA` the OLS slope of the run's returns on the reference's (unbounded — above 1 means
it amplifies the leader), `RATIO` the plain price quotient `close / referenceClose`, and `SPREADZ` the z-score of
`ln(close / referenceClose)` over `period` bars. `CORR` and `BETA` need `period` **return pairs**, hence one bar more
than `SPREADZ`, whose window holds levels. All four are `NaN` where the window is constant — a flat series has no
direction to agree with and no slope to measure — rather than reporting a fabricated ±1.

**⚑ Warmup for the anchored and structural codes is a _lower bound_, not an exact count.** These thirteen become
defined when the calendar or the data says so, not when a bar count elapses: `PDH` is undefined until the first UTC day
completes — 24 bars on 1h, 96 on 15m, and longer if the series starts mid-day — and `PIVOTHIGH` until the market
actually prints a swing, which on a one-way move is never. Treat "no value yet" as normal for them well past the number
in the table. Everything else in this table is exact.

Formulas for the non-obvious ones:

- `CANDLEPOS = (Close - Low) / (High - Low)` — where the close sits inside the bar's range, `0..1`. A zero-range bar
  reads `0.5`. Use it as a candle-strength filter: `CANDLEPOS GT 0.65` = strong bullish close.
- `DISTEMA = |Close - EMA(emaPeriod)| / ATR(atrPeriod)` — distance from the mean in ATR units. `DISTEMA LT 1.0`
  keeps entries from chasing an extended move.
- `INTERVAL = 1` on every `everyBars`-th bar (`floorDiv(ts, barMillis) % everyBars == 0`), else `0`.
- `TIME = 1` when the bar's UTC hour equals `hour`, else `0`.
- `HL2 = (high + low) / 2`, `HLC3 = (high + low + close) / 3`, `OHLC4 = (open + high + low + close) / 4`. These exist
  to be used as a **`source`** (§18.6.2): `EMA` over `HLC3` keys as `EMA_20@HLC3`. `OHLC4` is also the Heikin-Ashi
  close, so there is no separate `ha_close` code.
- `AVGTRADESIZE = quote_volume / trades_count` — average size of one print, in quote currency. A bar with no trades
  reads no value.
- `RVOLUME = volume / mean(volume of the same UTC hour over the previous `period` bars)`. A window containing no bar
  of that hour falls back to the mean of the whole window. A window of `period` holds roughly `period / 24` samples per
  hour on **any** timeframe, so the default 240 gives about ten.
- `OBV[0] = 0`; `OBV[i] = OBV[i-1] + sign(close[i] - close[i-1]) * volume[i]`; an unchanged close adds nothing. Its
  absolute level depends on where the series starts, so compare it against a moving average of itself
  (`OBV CROSS_UP SMA_20@OBV`), never against a constant.
- `VWAP = Σ(HLC3 × volume) / Σ(volume)` accumulated since the last UTC day or week boundary (weeks start Monday
  00:00 UTC). The grid is a function of the timestamp.
- `MFI` is RSI applied to volume-weighted typical-price moves: `100 − 100/(1 + posFlow/negFlow)` over the last
  `period` **changes** (hence warmup `period`, like RSI); an unchanged typical price counts for neither side, and a
  window with no down-flow reads `100`.
- `CMF = Σ(mfm × volume) / Σ(volume)` over `period` bars, where `mfm = ((close − low) − (high − close)) / (high − low)`
  and a zero-range bar contributes `0`. Normalized to `−1..+1`, so a threshold transfers between instruments.
- `FUNDING` = the last **settled** perpetual funding rate as a fraction (`0.0001` = 0.01%), forward-filled onto the
  bars. Never the _next_ rate — that would be lookahead. It is there whatever `applyFunding` says: the flag decides
  whether funding is **charged**, not whether it can be read, so a carry rule can be measured without its own funding
  bill (since 2026-11-03; before, `applyFunding: false` left the column empty and every condition on it silently
  false). A run whose config reads `FUNDING` fails with `NO_FUNDING_DATA` when the symbol has no settlements for the
  period, under either value of the flag, rather than trading on an empty column.
- **The four volatility estimators are not annualized.** `HV` = the sample standard deviation of `period` log returns
  `ln(close/close[1])`, in percent. `PARKINSON` = `sqrt( (1/(4·ln2·n)) · Σ ln(high/low)² ) × 100`. `GARMANKLASS` adds
  the direction of the bar: `sqrt( mean( 0.5·ln(h/l)² − (2·ln2−1)·ln(c/o)² ) ) × 100`. `YANGZHANG` =
  `sqrt( var(overnight) + k·var(openClose) + (1−k)·mean(RogersSatchell) ) × 100` with `k = 0.34/(1.34 + (n+1)/(n−1))`,
  the only one of the three that sees the gap between bars. All four return **σ per bar**: the usual `sqrt(barsPerYear)`
  factor is a property of the timeframe, which an indicator never sees, so a threshold on these transfers between
  instruments but **not** between timeframes.
- `CHOP = 100 · log10( Σ TR(n) / (HIGHEST(high,n) − LOWEST(low,n)) ) / log10(n)` — distance walked against distance
  travelled, on a fixed 0..100 scale. Above ~61.8 is choppy, below ~38.2 trending. Warmup is `n`, not `n-1`: the first
  bar has no true range here, so it starts one bar later than a platform that defines `TR[0] = high − low`.
- `TTMSQUEEZE = 1` while `BB(bbPeriod, bbStdDev)` lies entirely inside `KC(kcPeriod, kcAtrPeriod, kcMult)`, else `0`.
- `CHANDELIER`: `long = HIGHEST(high, period) − mult × ATR(atrPeriod)`, `short = LOWEST(low, period) + mult × ATR`.
  Unlike `HIGHEST`/`LOWEST` (which read the **close** because they are source-capable) this one reads high/low, and it
  is the intended target of `trailingStop.indicatorRef`.
- `POC` builds a volume histogram over the last `period` bars in `bins` buckets spanning `min(low)..max(high)`; each
  bar's volume is spread evenly over its own `low..high`, a bucket receiving the share of the bar's range it overlaps
  (a bar with no range lands whole in the bucket of its price). `poc` is the midpoint of the heaviest bucket — the
  lowest of a tie, and buckets covered end to end by the same bars do tie exactly; `vah`/`val`
  bound the smallest contiguous band around it holding 70% of the window's volume, grown to the heavier neighbour with
  ties going upward.
- `BODYPCT = |close−open| / (high−low) × 100`; `UPPERWICK = (high − max(open,close)) / (high−low) × 100`;
  `LOWERWICK = (min(open,close) − low) / (high−low) × 100`. The three sum to 100 on any bar with a range; a zero-range
  bar reads `0` for all three (unlike `CANDLEPOS`, which reads `0.5`).
- `GAPPCT = (open − close[1]) / close[1] × 100` — only the part of the move that happened _between_ bars.
  `RETPCT = (close − close[1]) / close[1] × 100`.
- `STREAK` = the signed run of closes: `+n` after `n` higher closes in a row, `−n` after `n` lower ones, `0` on a close
  equal to the previous one — and on the first bar, which has nothing to compare with (a value, not a warmup). A
  reversal starts the new run at `±1`. `STREAK LTE -3` is three down closes running; its main use is as a `source`:
  `RSI_2@STREAK` is the middle term of Connors' RSI.
- `CRSI` = Connors' RSI, `(RSI(close, rsiPeriod) + RSI(STREAK, streakPeriod) + rank) / 3`, in `0..100`, with
  QuantConnect/LEAN semantics. Both RSIs are Wilder's, exactly as `RSI` computes them, so the first two terms equal
  `RSI_3` and `RSI_2@STREAK`. `rank` is the share of the **previous** `rankPeriod` one-bar percent changes that lie
  **strictly** below the current one, × 100: the current change is not in its own window and ties do not count. That is
  not `PCTRANK`, which includes the bar, mid-ranks ties and reads `0..1`. The rank needs `rankPeriod` real changes before
  the bar, hence warmup `rankPeriod + 1`. LEAN pads its first window with a placeholder `0` and reports one bar earlier;
  from there on the two agree. The classic setting is `(3, 2, 100)`: `CRSI GT 90` is a stretched rally, `CRSI LT 10` a
  stretched sell-off.
- `STOCHRSI` = TradingView's Stoch RSI: `stoch = 100 · (RSI − lowest RSI) / (highest RSI − lowest RSI)` over the last
  `stochPeriod` RSI values, `k = SMA(stoch, k)`, `d = SMA(k, d)`, both `0..100`. The RSI is `RSI_<rsiPeriod>` exactly
  (Wilder, SMA seed). A window whose RSI did not move at all — a run of unchanged closes, or a short RSI pinned at 100/0
  by an unbroken run before the first opposite close — has no range: that bar, and every `k`/`d` whose window holds it,
  reads **no value** (TradingView's `na`), then the line resumes by itself. Read it as a pair: `k CROSS_UP d` with
  `k LT 20` is the oversold turn, `k CROSS_DOWN d` above 80 the overbought one. It is not
  `PCTRANK_<n>@RSI_<n>` (unsmoothed, single line, `0..1`). Not source-capable (two lines of its own).
- `ADX` = Wilder's directional movement as TradingView's DMI computes it: `+DM = high − high[1]` when that beats
  `low[1] − low` and is positive, else 0 (`−DM` mirrored); `plusDi = 100 · RMA(+DM, diPeriod) / RMA(TR, diPeriod)`,
  `minusDi` likewise; `adx = 100 · RMA(|plusDi − minusDi| / (plusDi + minusDi), adxPeriod)`, a zero sum dividing by 1.
  All three `0..100`. `RMA(TR, diPeriod)` **is** `ATR_<diPeriod>` (TradingView's DMI also leaves the first bar without a
  true range). `ADX GT 25` is the usual "there is a trend" filter, direction-blind; `plusDi CROSS_UP minusDi` gives the
  direction. A series that starts with flat bars has no true range to divide by and reads no value until price moves.
- `SUPERTREND` = TradingView's `ta.supertrend`: bands `hl2 ± mult · ATR(atrPeriod)`; the lower band only rises (unless
  the previous close fell below it), the upper only falls (unless the previous close rose above it); the trend flips up
  when the close crosses above the upper band and down when it crosses below the lower one (down on the first bar).
  `line` is the band in force — **a price**, the default field, so `{"indicator": "SUPERTREND", "params": {…}}` is a legal
  `stopLossRef` / `trailingStop.indicatorRef` and is drawn over the candles. `dir` is `+1` in an up trend and `−1` in a
  down trend — the **opposite sign of Pine's `direction`** (where `−1` means up): port `direction < 0` as `dir GT 0`.
  `dir` is a regime, not a pulse: `dir CROSS_UP 0` is the flip to up and is legal, and `dir` is not a price (not a legal
  `stopLossRef`). The ATR is the platform's `ATR` (seeded on `TR_1…TR_atrPeriod`), so the first value is one bar later
  than TradingView's and the two converge as the ATR does.
- `ROC = (close / close[period] − 1) × 100` (TradingView `ta.roc`); `ROC_1` is `RETPCT`. A past value of exactly `0`
  (only reachable over a `source`) reads no value. Source-capable: `ROC_24@OI` is how far open interest moved in 24 bars.
- `WMA` = TradingView's `ta.wma`: weights `1, 2, …, period` from the oldest of the last `period` values to the newest,
  divided by `period · (period + 1) / 2`. Turns sooner than an `SMA` of the same length and, unlike an `EMA`, forgets a
  bar completely after `period` bars. An overlay (a price, a legal `stopLossRef`) and source-capable: `WMA_20@HLC3`.
- `RANGEATR = (high − low) / ATR(atrPeriod)` — "was this an unusually big bar", normalized so the threshold carries.
- `PCTRANK` = where the bar's own value sits inside the `window` values ending at it, in `0..1`:
  `(below + (equal − 1)/2) / (window − 1)` over the present values of the window — **mid-rank**, so a unique maximum is
  `1`, a unique minimum `0` and an all-tied window `0.5` (the naive `below/count` would put a flat stretch at zero,
  which is exactly what a quiet volatility series does). A **full** window is required, hence warmup `window − 1`: a
  percentile of 200 bars and a percentile of 1000 bars are different features, and the engine must not serve the first
  while the report describes the second. Over the close it is dull; its reach is as a `source` holder —
  `PCTRANK_1000@ATR_14 GTE 0.9` is "volatility in its top decile **for this market**", a statement that survives a
  change of price level where `ATR_14 GTE 420` does not. It is the form an Analog Lab box travels in
  ([analogs/03-forward-paths-and-fan.md](analogs/03-forward-paths-and-fan.md) §3.7).
- `STDDEV` = the **population** standard deviation of the `period` values ending at the bar,
  `sqrt(Σ(x − mean)² / period)` — the same σ `BB` multiplies, so `BB_20_2.upper − BB_20_2.middle = 2 × STDDEV_20`. It is
  in the units of its input (price, over the close), so it re-levels with the market. `ZSCORE = (x − SMA(x, period)) /
  STDDEV(x, period)` over the same window, current bar included — unitless, bounded by `±(period − 1)/sqrt(period)`, and
  `ZSCORE_20 GT 2` is exactly "close above `BB_20_2.upper`". A flat window has σ exactly `0`: `STDDEV` reads `0`,
  `ZSCORE` reads no value (never ±Infinity). Both are source-capable: `ZSCORE_100@FUNDING` is how extreme funding is
  against its own recent history (EDGE-7).
- **Order flow (EDGE-10)** — Binance futures metrics, forward-filled onto the bars: a bar reads the last sample known by
  its **open**, and bars before the first sample (or a symbol whose history was never loaded) read no value, so every
  condition on them is false. `OI` = open interest in contracts, `OIVALUE` = in USDT (it carries the price, so it rises in
  a rally with no new positions — read positioning off `OI`/`OICHG`). `OICHG = (OI / OI[period] − 1) × 100` over
  `period` **bars** — `OICHG_24 GT 5` on 1h is "positions grew 5% in a day"; the portable form, since a level of `OI`
  means nothing across two instruments. `LSRATIO` = long/short ratio: `ACCOUNT` all accounts, `POSITION` top-trader
  position size, `TOP_ACCOUNT` top-trader accounts; keys as `LSRATIO_POSITION`. `TAKERRATIO` = taker buy / taker sell
  volume of the last **completed** metrics period (Binance stamps it at the period's start, so it is filled 15 minutes
  late — never lookahead). `VOLDELTA = Σ(2·takerBuy − volume) / Σ volume` over `period` bars, in `−1…+1`; it reads the
  candle's taker volume, so it works on spot too. `CVD(anchor)` is the same taker delta **summed, not normalized**: the
  running `Σ(2·takerBuy − volume)` since the start of the UTC day, week (Monday 00:00) or calendar month — `anchor`
  `DAY` (default), `WEEK` or `MONTH`, keys `CVD_DAY`/`CVD_WEEK`/`CVD_MONTH`, the same calendar as `AVWAP`. It is in
  base-asset units, so its level re-bases per instrument and by session: read its direction or a divergence from price
  (`CVD_DAY` with `RISING`/`FALLING` and `bars`, `CVD_DAY CROSS_UP SMA_12@CVD_DAY`), or `GT 0` for "buyers ahead since
  the open" — not a fixed threshold. Like `AVWAP` it is defined from the session's first bar (warmup 0, no ⚑) and a backtest loads one whole
  anchor period before `from`; on a timeframe as long as the anchor (`DAY` on `1d`) every bar is its own session and the
  value is that bar's delta. A bar whose taker volume was never loaded leaves the **rest of its session** without a
  value (the sum would be short by an unknown amount); the next session starts clean. None of the seven
  may name a `symbol` (§18.5.8) — another instrument's candles are loaded without it. `OICHG#4h` and `SMA_24@OI` are fine.
- **Reference candles and book depth (EDGE-9 level 2)** ✦ — the four codes that exist only for the symbols flagged
  `reference` / `depth` in `market.watchlist_symbol` (`GET /market/features`; BTCUSDT and ETHUSDT today). Naming one
  anywhere else is `422 CONFIG_CONFLICT` at save time, not an all-NaN series: the condition builder greys them out and
  the platform refuses the config, both from that endpoint. `MARK` is Binance's mark price at the bar close (what
  positions are liquidated against, anchored to the index rather than the last trade), `INDEX` the weighted spot basket
  it is anchored to, and `BASIS` the **premium index in percent** — Binance's own premium × 100, not
  `(MARK − INDEX) / INDEX`, because mark price is itself a smoothed, clamped function of the premium. `BASIS GT 0.2` is
  "twenty basis points rich". `DEPTH(pct, side)` is the resting notional within ±`pct` of mid, USDT, averaged over the
  bar; `side` picks the reading — `TOTAL` (default, bids + asks, what `DEPTH` meant before `side` existed), `BID`, `ASK`,
  or `IMBALANCE` = `(bid − ask) / (bid + ask)`, −1..+1, positive when the book leans to the bids (keys
  `DEPTH_1_BID`, `DEPTH_1_IMBALANCE`). Both sides are averaged over the same quoted minutes, so `TOTAL` is exactly
  `BID + ASK`. `pct` starts at 1 because the archive quotes no narrower band, and history starts 2023-01.
  `DEPTHSHAPE(inner, outer)` is the book's shape, `DEPTH(inner) / DEPTH(outer)` (both `TOTAL`), in (0, 1]: how much of what
  rests within ±`outer`% stands within ±`inner`% — high when liquidity is pressed against the price, low when it is spread
  thin; key `DEPTHSHAPE_1_5`. Unlike the notional it does not grow with the market or the year. On a UTC day the
  archive left a side of a band stuck (e.g. all bands 2025-04-16…05-19, the ±1 % asks 2026-09-03…11) that band reads NaN
  all day, so a comparison on it is false (and a `NOT` around one true) rather than firing on a book that only seems to
  have lost a side; `capacityUsdt` skips those bars. A shorter lapse — the archive repeating one snapshot for minutes
  (BTCUSDT 2026-09-08: the ±1 % asks held for 17 minutes, an hour's imbalance of 0.98) — is masked minute by minute: a
  value seen twice in a column on one UTC day is not a real quote, and every minute holding it leaves its band's average
  (since 2026-10-28). The masks date from 2026-10-27/28: a run stored before them read those values and may not
  reproduce there. Reference candles are stored **per timeframe** and are not
  resampled, so a run on a timeframe nobody loaded is refused too.
- **The four pattern codes are flags, and the validator rejects `CROSS_*` on them** (and rejects them as a `source`) —
  compare with `GT 0`. `ENGULFING` has `bull`/`bear` lines and compares **bodies**; `INSIDEBAR` compares **ranges**;
  `DOJI = 1` when `BODYPCT <= bodyMaxPct`; `PINBAR` is signed — `+1` when the lower shadow is at least `wickRatio` times
  the body and longer than the upper, `-1` mirrored, `0` otherwise. The same rule applies to `TTMSQUEEZE` and to the
  six candlestick figures of §18.6.5 (`HARAMI`, `PIERCING`, `STAR`, `SOLDIERS`, `TWEEZER`, `NRN`), which is where they
  are defined.
- `PPO = 100 × (EMA(fast) − EMA(slow)) / EMA(slow)` with `signal = EMA(ppo, signal)` and `hist = ppo − signal` — MACD
  in percent, so one threshold works across instruments. `TSI = 100 × EMA(EMA(m,long),short) / EMA(EMA(|m|,long),short)`
  where `m = close − close[1]`. `TRIX` = the one-bar percent change of `EMA(EMA(EMA(close,period),period),period)`.
  `UO` weights `Σbp/Σtr` over the three windows 4:2:1, where `bp = close − min(low, close[1])`.
  `CMO = 100 × (Σup − Σdown) / (Σup + Σdown)` over `period` changes with **simple** sums, not Wilder's.
  `DPO = close − SMA(period)[t − (period/2 + 1)]` — causal, despite the usual chart drawing it shifted forward; its
  units are the instrument's, so compare it to zero rather than to a constant.
  `VORTEX`: `plus = Σ|high − low[1]| / Σ TR`, `minus = Σ|low − high[1]| / Σ TR`, both over `period`.
- **Previous-session levels** read the last **completed** session and step only on its boundary, so they are flat
  through the session they are inside and never revise. `PDH`/`PDL`/`PDC` are the previous UTC day's high, low and
  close; `PWH`/`PWL` the previous UTC week's, weeks starting Monday 00:00.
- `DAYOPEN` is the open of the **current** UTC day, held until the next 00:00 — defined from the first bar, since the
  first bar of a session is that session's open. `AVWAP` is `VWAP` with a `MONTH` anchor added; both are defined from
  bar zero off the in-progress session (a one-bar VWAP is noisy, not undefined), which is why neither carries the ⚑.
- `IBHIGH`/`IBLOW` are the high and low of the bars whose **open time** falls in the first `minutes` of the UTC day,
  held for the rest of it. They publish the running extreme while the window is still forming and stop moving when it
  closes. A series that starts after the window has already closed reads no value until the next 00:00.
- **The six structure codes share one definition of a swing**: bar `j` is a pivot high when its high is _strictly_
  above the `left` bars before and the `right` after, so a plateau produces no pivot at all. A pivot is knowable only
  `right` bars after it forms, and is published then and never revised — the lag is in the definition, which is what
  makes `NoLookaheadPropertyTest` pass and what gives BOS/CHoCH without a state machine.
  `PIVOTHIGH`/`PIVOTLOW` are the price of the most recent confirmed pivot — unlike `HIGHEST` they step only when a new
  swing confirms, so a break of one is an event.
  `HHLL` is `+1` when the last two confirmed highs **and** the last two lows are both rising, `-1` when both fall, `0`
  when they disagree; a market making higher highs on lower lows is expanding, not trending. It **is** crossable —
  the value persists across bars, so `HHLL CROSS_DOWN 0` is a real change of character.
  `SWINGRANGE = |lastPivotHigh − lastPivotLow|`, a magnitude: the two pivots sit at different times and the signed
  difference can invert.
  `FIBRETR = (close − lastPivotLow) / (lastPivotHigh − lastPivotLow)`, **unclamped** — above `1` the swing high has
  been taken out, below `0` the low has — and no value when the last high is not above the last low.
  `BARSSINCE` counts from the **pivot bar**, not from its confirmation, so it is never below `right`. It is "bars
  since the last swing", not TradingView's `ta.barssince(condition)`: a condition is a tree, not a value that can be
  rendered into an `indicatorKey`.
- `ICHIMOKU`: `tenkan`/`kijun` are `(HIGHEST(high,n) + LOWEST(low,n)) / 2` over their periods; `senkouA` is
  `(tenkan + kijun)/2` and `senkouB` the same midpoint over `senkouB` bars, both **read from `displacement` bars ago**
  (the chart draws them that far forward, which is the same series). The cloud is displaced by exactly `displacement`
  bars — one bar later than TradingView, which displaces by `displacement − 1` — so a `senkouA`/`senkouB` cross prints
  one bar after it does on a TV chart. **There is no `chikou` field** — it is the close
  displaced _backwards_, i.e. `close[i + displacement]`, which is lookahead. For what chikou is used for, write
  `CLOSE GT CLOSE` with `offset: 26` on the right-hand side.

**Param order matters** for the internal series key (`MACD_12_26_9_hist`, `DISTEMA_20_14`), so write params in the
order given above. The key renders the parameter **values in the order they appear in the JSON object**, so the same
reference with its params spelled in another order keys a second, identical series. Params are read positionally into
the key, but by name into the indicator — a wrong name throws `Missing required indicator param '<name>'`, and a
fractional value for an integer param is refused rather than truncated — `Indicator param 'period' must be an integer,
got: 14.7`.

Indicators with no params take no `params` object at all: `{ "indicator": "CLOSE" }`.

### 18.6.1. Multi-line indicators

`MACD`, `BB`, `DONCHIAN`, `KELTNER`, `CHANDELIER`, `POC`, `PPO`, `VORTEX`, `ENGULFING`, `ICHIMOKU`, `STOCHRSI` (`k`/`d`),
`ADX` (`adx`/`plusDi`/`minusDi`), `SUPERTREND` (`line`/`dir`) and the five sided
figures of §18.6.5 (`HARAMI`, `PIERCING`, `STAR`, `SOLDIERS`, `TWEEZER` — `bull`/`bear`) emit several lines. Select one with `field`. Omitting `field` resolves to the default line given in the table above, but be
explicit. **Each field is its own persisted series** (`report.backtest_indicators`) and its own row in the Indicator
Analyzer, so reference only the lines you use.

```json
{ "indicator": "BB", "params": { "period": 20, "stdDev": 2 }, "field": "lower" }
```

### 18.6.2. `source` — indicator over another indicator

`source` computes the outer indicator over another series instead of the candle close, e.g. `SMA(ATR(14), 50)`:

```json
{ "indicator": "SMA", "params": { "period": 50 }, "source": { "indicator": "ATR", "params": { "period": 14 } } }
```

The rule is: **an indicator accepts a `source` iff it reads exactly one series.** That is exactly these eighteen:

```
SMA  EMA  RSI  HIGHEST  LOWEST  HV  RETPCT  TSI  TRIX  CMO  DPO  PCTRANK  STDDEV  ZSCORE  STREAK  CRSI  ROC  WMA
```

Everything else reads several candle columns at once (`ATR`, `CANDLEPOS`, `VWAP`, `MFI`, `CMF`, `PARKINSON`, `CHOP`,
`UO`, `POC`, `ADX`, `SUPERTREND`), emits several of its own lines (`MACD`, `BB`, `PPO`, `VORTEX`, `ICHIMOKU`,
`STOCHRSI`), owns its inputs (`DISTEMA`,
`KELTNER`, `CHANDELIER`, `TTMSQUEEZE`, `RANGEATR`), reads the timestamp rather than a series (`INTERVAL`, `TIME`,
`SESSION`, `DAYOFWEEK`, `MONTHDAY`, `MONTH`, `WEEKOFYEAR`, `QUARTER`), anchors to the calendar (`PDH`/`PDL`/`PDC`, `PWH`/`PWL`, `DAYOPEN`, `AVWAP`,
`IBHIGH`/`IBLOW`) or reads a swing structure rather than a series (`PIVOTHIGH`/`PIVOTLOW`, `HHLL`, `SWINGRANGE`,
`FIBRETR`, `BARSSINCE`), is a per-bar flag whose average is a hit rate rather than a series (`ENGULFING`,
`PINBAR`, `INSIDEBAR`, `DOJI`, `HARAMI`, `PIERCING`, `STAR`, `SOLDIERS`, `TWEEZER`, `NRN`), or _is_ a column (`OPEN`/`HIGH`/`LOW`/`CLOSE`, `HL2`/`HLC3`/`OHLC4`,
`VOLUME`/`QUOTEVOL`/`TRADES`/`AVGTRADESIZE`, `FUNDING`, `BODYPCT`/`UPPERWICK`/`LOWERWICK`/`GAPPCT`) — those are what
you point a source **at**.

Useful combinations this unlocks with no new code:

```json
{ "indicator": "SMA", "params": { "period": 20 }, "source": { "indicator": "VOLUME" } }
{ "indicator": "EMA", "params": { "period": 20 }, "source": { "indicator": "HLC3" } }
{ "indicator": "RSI", "params": { "period": 14 }, "source": { "indicator": "OHLC4" } }
{ "indicator": "PCTRANK", "params": { "window": 1000 }, "source": { "indicator": "ATR", "params": { "period": 14 } } }
{ "indicator": "ZSCORE", "params": { "period": 100 }, "source": { "indicator": "FUNDING" } }
{ "indicator": "RSI", "params": { "period": 2 }, "source": { "indicator": "STREAK" } }
```

keying as `SMA_20@VOLUME` ("volume above its average"), `EMA_20@HLC3`, `RSI_14@OHLC4`, `PCTRANK_1000@ATR_14`
("volatility in its top decile for this market"), `ZSCORE_100@FUNDING` and `RSI_2@STREAK` (the streak term of Connors'
RSI on its own).

Hard constraints:

- Anything outside the sixteen source-capable codes →
  `Indicator 'X' does not accept a source series; only [...] can be computed over another indicator` — the
  bracketed list is the sixteen codes above, rendered from the server’s own constant.
- Nesting is **exactly one level**: `sourceRef` is `additionalProperties: false` with only `indicator`, `field`,
  `params` — no `source` inside a `source`, and **no `offset`** (the lag belongs to the outer reference).
- The key is uppercase on both sides of the `@`: `EMA_20@HLC3`, not `EMA_20@hlc3`.
- A cross-symbol code (`CORR`/`BETA`/`RATIO`/`SPREADZ`, §18.5.8) is never a `source`: it needs a `symbol` of its own,
  which a `source` cannot carry. Reference it directly instead.

**A `NaN` inside the source is skipped, not propagated.** Every source-capable indicator treats a `NaN` in its input
the same way, whether it is the source's own warmup prefix or a hole inside the series (`AVGTRADESIZE` on a bar with
no trades, `OI`/`LSRATIO`/`TAKERRATIO` across a metrics gap, `ZSCORE` on a flat window, `FIBRETR` with no swing): the
bar reads `NaN`, the value is skipped, and the recurrence carries on from the state it had over the **defined** values.
This is the rule the backtest applies, so `SMA_50@AVGTRADESIZE`
is `NaN` on a tradeless bar and defined again on the next one, its window spanning the last 50 _defined_ values
rather than the last 50 bars. The only known residual: `PCTRANK` counts its window in defined values, while the analog
lab's own trailing percentile counts bars, so on the `window − 1` bars after a hole the two read different numbers
(the lab's columns carry no interior holes, so nothing it computes is affected).

### 18.6.3. Pseudo-series — prices, position state and trade history

Not indicators — they resolve from open-position state at evaluation time, so they have no catalog row, cost no
warmup, and are never persisted or charted. `NaN` (so every condition using them is `false`) when the value is not
defined. They have **no history**: a read one or more bars back is `NaN`, so `offset` must be `0`, `holdsFor`/`within`
must be `1`, and `RISING`/`FALLING`/`CROSS_*` over them are rejected (`… has no history — …`) rather than left to
never fire. Unlike catalog codes they **may contain `_`**, precisely because they never pass through the
first-underscore prefix rule.

| Series         | Value                                                                                        |
| -------------- | -------------------------------------------------------------------------------------------- |
| `AVG_ENTRY`    | Quantity-weighted average entry price of the side's open positions; `NaN` while flat         |
| `LAST_FILL`    | Entry price of the side's most recently opened, still-open position; `NaN` while flat        |
| `POS_MFE`      | Peak unrealized profit since entry, in % of the entry fill (`>= 0`)                          |
| `POS_MAE`      | Deepest unrealized loss since entry, in % of the entry fill (`<= 0`)                         |
| `POS_GIVEBACK` | `(POS_MFE - current) / POS_MFE`, clamped to `0..1`; `NaN` until the trade has been in profit |
| `POS_R`        | Current unrealized PnL in initial risks. **Requires a stop** — `NaN` without one             |
| `BARS_IN_POS`  | Bars elapsed since the entry bar                                                             |
| `EQUITY_DD`    | The strategy's drawdown from its equity peak, in % (`>= 0`)                                  |
| `LAST_TRADE_R` | R multiple of the side's last closed trade row; `NaN` when that trade had no stop            |
| `LAST_EXIT_SL` | `1` when the side's last closed row exited on a stop (`SL`, `SL_TRAILING`, `SL_BREAK_EVEN`, `SL<k>`), else `0` |
| `LOSSES_IN_ROW` | Losing rows in a row on the side, ending with its last closed row                           |
| `WINS_IN_ROW`  | Winning rows in a row on the side, ending with its last closed row                           |
| `BARS_SINCE_EXIT` | Bars since the side's last closed row                                                     |

`POS_GIVEBACK` exists as its own series because the comparison it stands for cannot be written: `GT_PCT`/`LT_PCT`
compare a series with a **constant**, not with another series, so `POS_R` against `POS_MFE` is inexpressible.

Three things worth knowing about how they resolve:

- **`POS_*` and `BARS_IN_POS` are per-position; the two prices are per-side.** An exit signal names the position it
  is evaluating. An entry condition does not, so it resolves against the side's most recently opened still-open
  position — the same choice `LAST_FILL` makes.
- **The excursion covers `(entry bar, current bar]`.** The entry bar's own range is never in `POS_MFE`/`POS_MAE`;
  the current bar's high and low already are.
- **`EQUITY_DD` is mark-to-market and lags one bar.** It counts unrealized giveback on open positions, the same
  basis as `maxDrawdownPct`, and reads the equity point recorded at the previous bar's close — the current bar's
  equity is only known after entries have been decided. Before the first point it reads `0`, not `NaN`.
- **The five trade-history series (EDGE-7) are per-side and count trade rows.** They read the closed trades of the
  evaluating layer's side, and are `NaN` until that side has closed one. A take-profit ladder closes one position in
  several rows, so it adds several wins — the same row convention as `maxConsecutiveLosses` and the report's
  `maxConsecutiveLosses`. A break-even row (`pnl == 0`) ends both streaks. `LIQUIDATION` and `RISK_GUARD` are not
  stops for `LAST_EXIT_SL`.

Allowed **only** inside: `entry.long`, `entry.short`, `exit.signal`, `dca.start`, `entries[].conditions`,
`entries[].setup`/`trigger`/`invalidate`, `entries[].entryOrder.cancelIf`, `entries[].sizing.multipliers[].when`,
`entries[].exit.signal`, and `defs`. Anywhere else (`atrRef`, `trailingStop.indicatorRef`, a `source`, a `series`
input, inside a `latch`) is rejected.

They carry **no `params`, no `field`, no `source`**, and `offset` must be `0`. They cannot be used with
`CROSS_UP` / `CROSS_DOWN` (there is no previous value).

```json
{ "left": { "indicator": "CLOSE" }, "op": "LT_PCT", "right": { "indicator": "AVG_ENTRY" }, "pct": 2 }
```

Giveback exit — "leave once half the best move is gone":

```json
"exit": { "signal": { "operator": "AND", "list": [ { "indicator": "POS_GIVEBACK", "op": "GT", "value": 0.5 } ] } }
```

### 18.6.4. Time predicates — `INTERVAL`, `TIME`, `SESSION`, `DAYOFWEEK`, `MONTHDAY`, `MONTH`, `WEEKOFYEAR`, `QUARTER`

Real indicators, but they emit a 0/1 pulse. They accept `params` and `offset` and may appear in any condition
group, but: no `field`, cannot be computed over a `source`, cannot be another indicator's `source`, and cannot
anchor `CROSS_UP` / `CROSS_DOWN`. Compare the pulse with `GT 0`:

```json
{ "indicator": "TIME", "params": { "hour": 8 }, "op": "GT", "value": 0 }
```

All of them are UTC and are pure functions of the candle's own timestamp.

- **`TIME`** without `minute` fires on **every bar inside the hour** — on 15m candles that is four bars, which is
  why it is usually paired with the layer's cooldown/re-arm. With `minute` it fires on the single bar opening at
  `hour:minute`, which is what "buy at 08:30" normally means.
- **`SESSION`** covers the half-open range `[startHour, endHour)`, so adjacent sessions tile without overlapping.
  It **wraps past midnight** when `startHour > endHour`: `SESSION(22, 4)` is hours 22, 23, 0, 1, 2, 3. Equal hours
  are rejected. This wrap is why it is not just two `TIME` conditions.
- **`DAYOFWEEK`** uses ISO numbering, Monday = 1 … Sunday = 7. `NOT ( DAYOFWEEK(6) OR DAYOFWEEK(7) )` excludes the
  weekend.
- **`MONTHDAY`** fires on every bar of that calendar day. Days 29–31 are absent from some months, so such a
  schedule simply trades in fewer months — it is not rejected.
- **`MONTH`**, **`WEEKOFYEAR`** and **`QUARTER`** are seasonal **filters**: 1 on **every** bar of that month, week or
  quarter, not on one bar — on 1d, `MONTH(10)` is every October day; on 1h, `WEEKOFYEAR(43)` is 168 bars. As an entry
  they keep firing all period long, so "buy once at the open of ISO week 43" needs the layer's cooldown/re-arm or a
  `maxHoldingBars` (§18.8.8); "hold all of October" is `MONTH(10) GT 0` as the entry and `MONTH(10) EQ 0` as
  `exit.signal`. `MONTH` is 1 = January … 12 = December. `QUARTER` is the calendar quarter (1 = Jan–Mar … 4 = Oct–Dec),
  exactly `MONTH(10) OR MONTH(11) OR MONTH(12)` for Q4.
- **`WEEKOFYEAR` is the ISO 8601 week, which is often not the week number in a post.** ISO weeks start on Monday
  00:00 UTC, and week 1 is the week holding the year's first Thursday. Posts on X often count from 1 January (or
  start weeks on Sunday), and the two disagree by one in many years: a post on Monday 2026-10-19 called it week 42,
  ISO says 43, because 2026's ISO week 1 began on Monday 29 December 2025. Read the claim's dates, not its number. The
  ISO week also belongs to the ISO year, not the calendar year: Monday 30 December 2024 is week 1 of 2025, and
  1–3 January 2021 are week 53 of 2020. Week 53 exists only in some years (2015, 2020, 2026, …), so `WEEKOFYEAR(53)`
  trades in fewer years — it is not rejected.
- **A date range is `MONTH` + `MONTHDAY`, not a week number.** `MONTHDAY` takes a single day, so "16–22 October" is
  `MONTH(10)` ANDed with an `OR` of `MONTHDAY(16)` … `MONTHDAY(22)`, below; the same group wrapped in `NOT` as
  `exit.signal` holds the range as one trade. A fixed date range lands on different weekdays every year, an ISO week
  on different dates — pick the one the claim actually means.

```json
{ "operator": "AND", "list": [
  { "indicator": "MONTH", "params": { "month": 10 }, "op": "GT", "value": 0 },
  { "operator": "OR", "list": [
    { "indicator": "MONTHDAY", "params": { "day": 16 }, "op": "GT", "value": 0 },
    { "indicator": "MONTHDAY", "params": { "day": 17 }, "op": "GT", "value": 0 },
    { "indicator": "MONTHDAY", "params": { "day": 18 }, "op": "GT", "value": 0 },
    { "indicator": "MONTHDAY", "params": { "day": 19 }, "op": "GT", "value": 0 },
    { "indicator": "MONTHDAY", "params": { "day": 20 }, "op": "GT", "value": 0 },
    { "indicator": "MONTHDAY", "params": { "day": 21 }, "op": "GT", "value": 0 },
    { "indicator": "MONTHDAY", "params": { "day": 22 }, "op": "GT", "value": 0 } ] } ] }
```

### 18.6.5. Chart patterns — `HARAMI`, `PIERCING`, `STAR`, `SOLDIERS`, `TWEEZER`, `NRN`, `DOUBLE`, `TRIANGLE`, `FLAG`, `BOX`, and recipes

Candlestick figures come in two kinds here, and the split is deliberate. A figure gets a **code** only when the
condition DSL cannot express it (it needs arithmetic between two bars, an ATR tolerance, or a parametric look-back).
Everything else is a **recipe** — a `conditionGroup` you can read and change — and gets no code.

Every code is a **0/1 pulse on the bar that completes the figure**: a three-bar figure pulses on its third bar, at
that bar's close, and never earlier. The side is a `field` (`bull`/`bear`), as on `ENGULFING`. Compare with `GT 0`;
`CROSS_*` and use as a `source` are rejected (§18.11, 10a–10b). **No definition asks for a gap** — on a 24/7 market
`open[i] ≈ close[i-1]`, so the classical "opens below the prior low" clauses would never fire. Thresholds are part of
the definition (`optimizeHint: "fixed"` in the catalog): do not put them into an optimizer's search space.

Notation: `[k]` is `k` bars back; `body = |close − open|`, `top = max(open, close)`, `bot = min(open, close)`,
`mid = (open + close) / 2`; a bar is bullish when `close > open`; `BODYPCT`, `UPPERWICK`, `LOWERWICK` as in §18.6.

| Code       | `bull` = 1 when | `bear` |
| ---------- | --------------- | ------ |
| `HARAMI`   | `[1]` bearish with `BODYPCT ≥ minPrevBodyPct`; `[0]` bullish; `top[0] ≤ top[1]` and `bot[0] ≥ bot[1]`; `body[0] ≤ maxBodyRatio × body[1]` | colours swapped |
| `PIERCING` | piercing line: `[1]` bearish, `[0]` bullish, both `BODYPCT ≥ minBodyPct`; `close[0] > mid[1]` and `close[0] < open[1]` (at or past the open it is `ENGULFING`) | dark cloud cover: colours swapped, `close[0] < mid[1]` and `close[0] > open[1]` |
| `STAR`     | morning star: `[2]` bearish with `BODYPCT ≥ minBodyPct`; `[1]` with `BODYPCT ≤ starMaxBodyPct` (either colour); `[0]` bullish with `close[0] > mid[2]` | evening star: colours swapped, `close[0] < mid[2]` |
| `SOLDIERS` | three white soldiers: `[2]`, `[1]`, `[0]` bullish, each `BODYPCT ≥ minBodyPct` and `UPPERWICK ≤ maxWickPct`; `close` strictly rising; `open[k] ≥ bot[k+1]` | three black crows: bearish, `LOWERWICK ≤ maxWickPct`, `close` strictly falling, `open[k] ≤ top[k+1]` |
| `TWEEZER`  | tweezer bottom: `[1]` bearish, `[0]` bullish, `abs(low[0] − low[1]) ≤ tolAtr × ATR(atrPeriod)[0]` | tweezer top: colours swapped, the same on the highs |
| `NRN`      | no side (`field` is `value`): `high − low` of `[0]` **strictly** below each of the previous `period − 1` ranges — NR4 at `period: 4`, NR7 at `7` | — |

```json
{ "indicator": "STAR", "params": { "minBodyPct": 50, "starMaxBodyPct": 30 }, "field": "bull", "op": "GT", "value": 0 }
```

A figure alone is rarely a strategy; it is a trigger inside a context. "Morning star in a downtrend":

```json
{
  "operator": "AND",
  "conditions": [
    { "indicator": "STAR", "params": { "minBodyPct": 50, "starMaxBodyPct": 30 }, "field": "bull", "op": "GT", "value": 0 },
    { "indicator": "HHLL", "params": { "left": 3, "right": 3 }, "op": "EQ", "value": -1 }
  ]
}
```

**Recipes — figures that are NOT codes.** Build them from existing nodes; mirror for the other side.

| Figure | `conditionGroup` (AND of) |
| ------ | ------------------------- |
| Outside bar | `compare HIGH GT HIGH[offset 1]`, `compare LOW LT LOW[offset 1]` |
| Marubozu | `BODYPCT GT 90`, `compare CLOSE GT OPEN` (bearish: `CLOSE LT OPEN`) |
| Hammer / shooting star | `PINBAR GT 0` plus a context — `HHLL EQ -1` or `compare CLOSE LT EMA(50)`; shooting star: `PINBAR LT 0` with `HHLL EQ 1` |
| Inside bar after NR | `INSIDEBAR GT 0`, `NRN GT 0` |
| Spring / upthrust (SFP) | `compare LOW LT PIVOTLOW`, `compare CLOSE GT PIVOTLOW` (upthrust: `HIGH GT PIVOTHIGH`, `CLOSE LT PIVOTHIGH`); once per swing: `within` plus the layer's `reArmOn` |
| Break of structure (BOS) | `compare CLOSE CROSS_UP PIVOTHIGH` (down: `CLOSE CROSS_DOWN PIVOTLOW`) |

The spring, written out — a sweep of the last confirmed swing low that closes back above it:

```json
{
  "operator": "AND",
  "conditions": [
    { "left": { "indicator": "LOW" }, "op": "LT", "right": { "indicator": "PIVOTLOW", "params": { "left": 3, "right": 3 } } },
    { "left": { "indicator": "CLOSE" }, "op": "GT", "right": { "indicator": "PIVOTLOW", "params": { "left": 3, "right": 3 } } }
  ]
}
```

**Event-study verdicts.** Every code and recipe above goes through the same gate before anything is built on top of it: an event study at the **default params** on a point-in-time panel of 52 USDT-M
perpetuals, `1h` and `4h`, horizons 1/4/12/24 bars, in-sample 2021-09…2025-08, one-shot holdout 2025-09…2026-08,
Benjamini–Hochberg across the whole family `m` of the level. A verdict measures the **unconditional** effect of the
bare figure; a context (trend, level, volume) is the strategy's job and the campaign's. Read the verdict before
spending a campaign on a figure — and note that "no edge" leaves the code in the catalog: a negative result is
information, and saved strategies depend on the code.

**Level-1 gate, run 2026-09-19/20** — 21 events × 2 timeframes × 4 horizons, family `m = 168`; 52 symbols in-sample
(18 since delisted), 40 of them still trading in the holdout year. Edges are mean forward return minus the unconditional
baseline, gross of costs. **Read the whole picture before any single line:** 40 of 168 cells passed in-sample, and only
**25 of those 40 kept their sign on holdout (62 %; a coin gives 50 %)**. The panel test treats symbols as independent,
which crypto is not, so in-sample significance here is optimistic — and the largest in-sample effects
(`SOLDIERS.bull` on 4h, bullish marubozu) are exactly the ones that reversed. "Kept sign" below is a licence to
investigate inside a campaign, not evidence of an edge. *Against side* means the effect points the other way from the
figure's name.

| Event | Verdict |
| ----- | ------- |
| `HARAMI.bull` | Event study 2026-09: −0.033 % at h=4 on 1h, q=0.026, holdout kept sign (−0.013 %) — against side, far below costs |
| `HARAMI.bear` | Event study 2026-09: no edge at default params (m=168) |
| `PIERCING.bull` | Event study 2026-09: +0.127 % at h=1 on 4h, q=0.006, holdout kept sign (+0.074 %); its h=12 cell reversed |
| `PIERCING.bear` | Event study 2026-09: no edge at default params (m=168) |
| `STAR.bull` | Event study 2026-09: no edge at default params (m=168) |
| `STAR.bear` | Event study 2026-09: +0.022 % at h=1 on 1h, q=0.021, holdout kept sign (+0.016 %; h=4 and h=12 too) — against side, below costs |
| `SOLDIERS.bull` | Event study 2026-09: +0.108 % at h=4 on 1h, q=0.017, holdout kept sign (+0.208 %). All three 4h cells (+0.8…+1.2 % in-sample) **reversed** on holdout |
| `SOLDIERS.bear` | Event study 2026-09: +0.238 % at h=1 on 4h, q=0.007, holdout kept sign (+0.498 %; h=4 +0.246 → +0.912 %) — against side: a bounce after three crows; only 989 events |
| `TWEEZER.bull` | Event study 2026-09: −0.212 % at h=12 on 4h, q<0.001, holdout kept sign (−0.073 %) — against side; the h=1 cell is with side (+0.048 → +0.028 %) |
| `TWEEZER.bear` | Event study 2026-09: in-sample edge did not keep its sign on holdout (m=168) |
| `NRN` | Event study 2026-09: −0.146 % at h=12 on 4h, q=0.007, holdout kept sign (−0.117 %; h=24 on 1h and 4h too) — mild negative drift after compression |
| Outside bar | Event study 2026-09: +0.032 % at h=1 on 4h, q=0.003, holdout kept sign (+0.005 %) — nothing left of it; the h=12 cell reversed |
| Marubozu · bull | Event study 2026-09: in-sample edge did not keep its sign on holdout — all five cells reversed (+0.54 % → −0.14 % at h=4 on 4h) |
| Marubozu · bear | Event study 2026-09: no edge at default params (m=168) |
| Hammer (`PINBAR GT 0` + `HHLL EQ -1`) | Event study 2026-09: +0.097 % at h=24 on 1h, q=0.008, holdout kept sign (+0.132 %); the 4h cell reversed |
| Shooting star (`PINBAR LT 0` + `HHLL EQ 1`) | Event study 2026-09: +0.017 % at h=1 on 1h, q<0.001, holdout kept sign (+0.020 %) — against side, below costs |
| Inside bar after NR | Event study 2026-09: −0.204 % at h=12 on 4h, q=0.008, holdout kept sign (−0.288 %) |
| Spring (SFP · bull) | Event study 2026-09: no edge at default params (m=168) |
| Upthrust (SFP · bear) | Event study 2026-09: −0.082 % at h=24 on 1h, q=0.033, holdout kept sign (−0.053 %) — with side |
| BOS up | Event study 2026-09: +0.107 % at h=1 on 4h, q=0.001, holdout kept sign (+0.119 %) — with side; on 1h at h=24 it faded to zero |
| BOS down | Event study 2026-09: −0.179 % at h=4 on 4h, q<0.001, holdout kept sign (−0.176 %; h=1 −0.072 → −0.143 %) — with side, the most stable cell of the level. On 1h the sign is the opposite (+0.138 % at h=24, kept) |

**Level 2 — figures on two swings: `DOUBLE`, `TRIANGLE`** (EDGE-26, [edge/11-chart-patterns.md](./edge/11-chart-patterns.md)
§11P.5). Built on the same confirmed pivots as `PIVOTHIGH`/`PIVOTLOW` (§18.6.4): a pivot is known `right` bars after
it forms and never revised, so every pulse below is causal. Both codes carry **mixed fields** — a 0/1 pulse *and* the
figure's price levels under one code, so that a stop, a target and a retest refer to the same figure that produced the
entry. ATR here is always ATR(14); it is not a param.

| Code | Pulse field(s) | Level fields | Definition |
| ---- | -------------- | ------------ | ---------- |
| `DOUBLE` | `value` | `neckline`, `target`, `invalid` | `side: TOP`: the two most recent confirmed pivot highs `H1`, `H2` with a confirmed pivot low `N` between them (the lowest, if several); `abs(H2 − H1) ≤ tolAtr × ATR` and `min(H1, H2) − N ≥ minDepthAtr × ATR`, both read on the bar `H2` confirms — that bar **arms** the figure. `value = 1` on the first bar whose close is below `N`, no later than `maxBars` after the `H2` pivot bar (the arming bar itself counts); a close above `max(H1, H2)` first invalidates it. `neckline = N`, `invalid = max(H1, H2)`, `target = N − (max(H1, H2) − N)` — the levels of the figure armed **last**, kept after it fired or lapsed, NaN before the first. A later high that does not qualify leaves an armed figure alone (the classic lower high on the way to the neckline); a later pair that qualifies replaces it. `BOTTOM` mirrors everything on the lows |
| `TRIANGLE` | `bull`, `bear` | `upper`, `lower` | The upper line through the two most recent confirmed pivot highs, the lower through the two most recent pivot lows, both extended to the current bar and **re-fitted on every confirmed pivot**. A line is *flat* when its two touches are within `flatTolAtr × ATR`. `SYM`: upper falling, lower rising; `ASC`: upper flat, lower rising; `DESC`: lower flat, upper falling; `WEDGEUP`: both rising and converging; `WEDGEDOWN`: both falling and converging; `ANY`: any of the five. Armed while the fit matches `kind`; `bull = 1` on the first close above the upper line, `bear = 1` on the first below the lower; the apex (lines meet) or `maxBars` after arming ends it silently. `upper`/`lower` are the lines' values while armed (breakout bar included), NaN otherwise |

Field-aware rules (§18.11, 10c): `CROSS_*` and `source` are refused on the pulse fields and allowed on the level
fields (`CLOSE CROSS_UP TRIANGLE.upper` is a line break and legal); `stopLossRef` / `takeProfitRef` / `priceRef` and
a setup anchor used as one of those accept the level fields and refuse the pulse (`DOUBLE.value` — or a bare
`DOUBLE`, whose default field is the pulse — as a `stopLossRef` is `CONFIG_CONFLICT`; `DOUBLE.invalid` is accepted).
The catalog spells the same fact as `params.fieldPanes` (doc 07 §7.3).

**Double top + neckline retest** — the figure as the setup (EDGE-4 §18.5.10), its levels frozen as anchors, the retest
as the trigger, the stop on the anchored invalidation level and the target on the anchored target (EDGE-6 §18.7.6):

```json
{
  "id": "double-top-retest", "side": "SHORT", "sizePct": 10,
  "setup":      { "indicator": "DOUBLE", "params": { "side": "TOP", "left": 5, "right": 5, "tolAtr": 0.5, "minDepthAtr": 1.5, "maxBars": 100 }, "op": "GT", "value": 0 },
  "anchors":    [ { "indicator": "DOUBLE", "params": { "side": "TOP", "left": 5, "right": 5, "tolAtr": 0.5, "minDepthAtr": 1.5, "maxBars": 100 }, "field": "neckline" },
                  { "indicator": "DOUBLE", "params": { "side": "TOP", "left": 5, "right": 5, "tolAtr": 0.5, "minDepthAtr": 1.5, "maxBars": 100 }, "field": "invalid" },
                  { "indicator": "DOUBLE", "params": { "side": "TOP", "left": 5, "right": 5, "tolAtr": 0.5, "minDepthAtr": 1.5, "maxBars": 100 }, "field": "target" } ],
  "trigger":    { "left": { "indicator": "HIGH" }, "op": "GTE", "right": { "anchor": "setup", "take": "DOUBLE_TOP_5_5_0.5_1.5_100_neckline" } },
  "invalidate": { "left": { "indicator": "CLOSE" }, "op": "GT", "right": { "anchor": "setup", "take": "DOUBLE_TOP_5_5_0.5_1.5_100_invalid" } },
  "armedForBars": 10,
  "exit": { "stopLossRef":   { "anchor": "setup", "take": "DOUBLE_TOP_5_5_0.5_1.5_100_invalid" },
            "takeProfitRef": { "anchor": "setup", "take": "DOUBLE_TOP_5_5_0.5_1.5_100_target" } }
}
```

The pulse arms the layer on the neckline break; the anchors freeze that figure's levels on the same bar, so the retest
compares `HIGH` with *that* neckline (`take` is the anchor's key — code, params and field, §18.5.10) and every entry
of the layer is on a bar where `HIGH ≥ neckline` of the figure that fired. The anchor key spells the params in catalog
order (`side, left, right, tolAtr, minDepthAtr, maxBars`); the pulse's own key has no field suffix, since `value` is
the default line.

**Level-2 gate, run 2026-09-23**: four
events (`DOUBLE` TOP and BOTTOM, `TRIANGLE.bull`/`bear` at `ANY`) × 2 timeframes × 4 horizons, family `m = 32`, the
same 52-symbol panel and periods as level 1. In-sample 7 of 32 cells passed; on holdout **4 of those 7 kept their sign**,
all of them on 4h and all *with* the figure's side: `TRIANGLE.bear` at h=1/4/12 (−0.096 → −0.049 %, −0.170 → −0.195 %,
−0.491 → −0.159 %) and `DOUBLE` BOTTOM at h=1 (+0.220 → +0.239 %). The two 1h cells that passed in-sample
(`TRIANGLE.bull` h=24, `DOUBLE` BOTTOM h=24) pointed against their side and reversed on holdout. `DOUBLE` TOP has no cell
at all. The panel caveat of level 1 stands (symbols treated as independent; sign agreement is the guard).

| Event | Verdict |
| ----- | ------- |
| `DOUBLE` · TOP | Event study 2026-09: no edge at default params (m=32) |
| `DOUBLE` · BOTTOM | Event study 2026-09: +0.220 % at h=1 on 4h, q=0.047, holdout kept sign (+0.239 %; 46 symbols, 1757 events) — with side; its 1h h=24 cell (−0.274 %, against side) reversed |
| `TRIANGLE.bull` (ANY) | Event study 2026-09: in-sample edge did not keep its sign on holdout (m=32) — the 1h h=24 cell (−0.164 %, against side) came back +0.025 % |
| `TRIANGLE.bear` (ANY) | Event study 2026-09: −0.491 % at h=12 on 4h, q<0.001, holdout kept sign (−0.159 %; h=1 −0.096 → −0.049 %, h=4 −0.170 → −0.195 %) — with side, 80 % sign agreement, the strongest cell of both levels so far |

**Level 3 — figures in a window: `FLAG`, `BOX`** (EDGE-27, [edge/11-chart-patterns.md](./edge/11-chart-patterns.md)
§11P.6). No pivots: both are defined on a sliding window of bars. Mixed fields as on level 2 — a 0/1 pulse and the
figure's price levels under one code — and ATR is again ATR(14), not a param.

| Code | Pulse field(s) | Level fields | Definition |
| ---- | -------------- | ------------ | ---------- |
| `FLAG` | `value` | `upper`, `lower`, `target` | `side: BULL`: the **pole** is the rise from the lowest low of the last `poleBars` bars (the bar itself included) to that bar's high `P`, and it qualifies when `P − base ≥ poleAtr × ATR` read on that bar. Every bar outside a flag is judged as a peak, so a pole that keeps rising moves its peak forward. The **flag** is the run of bars after `P` with `high ≤ P`; from **3** of them the figure is armed and their running extremes are its box — `upper` = the highest flag high, `lower` = the lowest flag low. `value = 1` on the first close above `upper` (the breakout bar is not a flag bar and may exceed `P`). `target = upper + (P − base)`. The figure dissolves silently when a flag bar's low goes under `P − maxRetrace × (P − base)`, when a bar **closes** under the box's floor (`lower` as of the previous bar), when a high above `P` comes before the third flag bar (that bar is judged as the new peak), or when the flag runs past `flagBars` bars. The levels are those of the figure armed **last**: they follow the box while it forms, are kept after it fired or dissolved, NaN before the first. `BEAR` mirrors everything — a fall to a trough `T`, a box over it, `value = 1` on the first close under `lower`, `target = lower − (base − T)` |
| `BOX` | `bull`, `bear` | `upper`, `lower` | On bar `i` the box is the previous `period` bars, the bar itself excluded: `upper = HIGHEST(period)[1]` of the highs, `lower = LOWEST(period)[1]` of the lows, qualifying when `upper − lower ≤ maxWidthAtr × ATR[1]` — all three read one bar back, so the box is a fact about completed bars. `bull = 1` when the box qualifies and `close > upper`, `bear = 1` when `close < lower`; `upper`/`lower` are the edges while the box qualifies, NaN otherwise. No state machine: a slow grind inside a narrow band can pulse on consecutive bars. This is `DONCHIAN` plus a condition on its width, which the condition DSL cannot spell |

`FLAG` is the **box** variant of the flag, and its floor rule is strict by design: a close under the lowest low so far
ends the figure even inside the retrace budget, so a pullback that drifts down in a channel — closes stepping under the
prior lows — does not qualify. The sloped channel and the pennant (`shape: BOX | CHANNEL | PENNANT`) are the second
iteration, built only if the box variant passes the gate (§11P.6).

**Flag breakout** — the pulse as the entry, the stop on the flag's floor and the target on the measured move. No
anchors are needed here: the levels outlive the break, so on the entry bar `lower` and `target` are those of the flag
that fired (compare the double top of level 2, whose retest needs the neckline frozen by an anchor):

```json
{
  "id": "flag-breakout", "side": "LONG", "sizePct": 10,
  "conditions": { "operator": "AND", "list": [
    { "indicator": "FLAG", "params": { "side": "BULL", "poleBars": 10, "poleAtr": 3, "flagBars": 15, "maxRetrace": 0.5 }, "op": "GT", "value": 0 }
  ] },
  "exit": { "stopLossRef":   { "indicator": "FLAG", "params": { "side": "BULL", "poleBars": 10, "poleAtr": 3, "flagBars": 15, "maxRetrace": 0.5 }, "field": "lower" },
            "takeProfitRef": { "indicator": "FLAG", "params": { "side": "BULL", "poleBars": 10, "poleAtr": 3, "flagBars": 15, "maxRetrace": 0.5 }, "field": "target" } }
}
```

Context is the strategy's job, not a param (§11P.3, §11P.6). The two recipes the design names, both plain
`conditionGroup`s over the pulse:

| Recipe | Definition |
| ------ | ---------- |
| Flag with volume compression | `FLAG GT 0 AND RVOLUME LT 0.8 holdsFor 3` — the last three bars (the flag) traded under 0.8 of their hour's baseline; use `RVOLUME LT 0.8` without `holdsFor` for a quiet breakout bar instead, which is the opposite bet |
| Flag in a trend | `FLAG GT 0 AND HHLL EQ 1` (`left` 5, `right` 5) — the pole extends a structure of higher highs and higher lows; the bear side is `FLAG(side: BEAR) GT 0 AND HHLL EQ -1` |
| Box breakout after a squeeze | `BOX GT 0 AND TTMSQUEEZE GT 0 offset 1` — the bar before the breakout was still inside the Bollinger-in-Keltner squeeze |

**Level-3 gate, run 2026-09-23**: four
events (`FLAG` BULL as the code at its defaults, `FLAG` BEAR as a recipe since the side is a param, `BOX.bull`,
`BOX.bear`) × 2 timeframes × 4 horizons, family `m = 32`, the same 52-symbol panel and periods as levels 1–2. In-sample
3 of 32 cells passed, all three *against* the figure's side; on holdout (40 symbols with candles, 12 delisted without)
**1 of the 3 kept its sign**: `BOX.bull` at h=24 on 1h (−0.478 % → −0.545 %) — a box breakout that fades within a day.
`BOX.bull` h=1 (−0.078 %) and `FLAG` BEAR 4h h=12 (+0.288 %) reversed. The bull flag has no cell (its best, 4h h=24
+0.950 % *with* side, sits at q=0.065); on 4h the box qualifies too rarely to test (281 / 315 events over 7–12 symbols).
The panel caveat of levels 1–2 stands.

| Event | Verdict |
| ----- | ------- |
| `FLAG` · BULL | Event study 2026-09: no edge at default params (m=32); the best cell, 4h h=24 +0.950 % with side, is just outside the rule (q=0.065) |
| `FLAG` · BEAR | Event study 2026-09: in-sample edge did not keep its sign on holdout (m=32) — the 4h h=12 cell (+0.288 %, against side, q=0.027) came back −0.011 % |
| `BOX.bull` | Event study 2026-09: −0.478 % at h=24 on 1h, q=0.044, holdout kept sign (−0.545 %; 375 events, 40 symbols) — against side, 67 % sign agreement: the breakout fades; the h=1 cell (−0.078 %, q=0.022) reversed |
| `BOX.bear` | Event study 2026-09: no edge at default params (m=32); on 4h only 315 events over 11 symbols, too few to say anything |

---

## 18.7. `entries[]` — entry layers

An array of independent entry layers, each with its own side, size, trigger and optional exit override. Each item
requires `["id", "side", "conditions"]` **and exactly one of** `sizePct` / `sizeAbs` / `sizing`.

| Field          | Type    | Required    | Constraints                                                            |
| -------------- | ------- | ----------- | ---------------------------------------------------------------------- |
| `id`           | string  | yes         | `minLength: 1`, unique across `entries[]`                              |
| `side`         | string  | yes         | `"LONG"` \| `"SHORT"` (should also appear in root `sides`)             |
| `sizePct`      | number  | exactly one | `> 0`, `maximum: 100` — percent of free equity used as margin          |
| `sizeAbs`      | number  | exactly one | `> 0` — fixed margin in quote currency (USDT)                          |
| `sizing`       | object  | exactly one | the long form of the two above plus the two risk-budget modes, §18.7.4 |
| `cooldownBars` | integer | no          | `minimum: 0`, default `0` — the layer fires at most once every N bars (`1` = no cooldown, same as `0`) |
| `reArmOn`      | string  | no          | `"ALL_LAYERS_CLOSED"` (default) \| `"THIS_LAYER_CLOSED"` \| `"ALWAYS"` |
| `reArmStepPct` | number  | no          | `> 0`, `< 100`; only with `reArmOn: "ALWAYS"` — the price step, §18.7.1 |
| `reArmStepRef` | string  | no          | `"LAST_FILL"` (default) \| `"AVG_ENTRY"`; requires `reArmStepPct`       |
| `conditions`   | object  | yes         | conditionGroup, §18.5                                                  |
| `exit`         | object  | no          | per-layer exit override, §18.7.2                                       |
| `entryOrder`   | object  | no          | rest a STOP/LIMIT order instead of taking the market, §18.7.6          |

Layers are evaluated **in array order** within a bar, and a later layer sees an earlier layer's same-bar fill —
this is what makes an averaging-down ladder of layers work.

### 18.7.1. `reArmOn`

| Value               | The layer may fire again once…                             |
| ------------------- | ---------------------------------------------------------- |
| `ALL_LAYERS_CLOSED` | every position of the strategy is closed (default, safest) |
| `THIS_LAYER_CLOSED` | this layer's own position is closed                        |
| `ALWAYS`            | immediately, subject to `cooldownBars` and position caps   |

`ALWAYS` and `THIS_LAYER_CLOSED` open several concurrent positions, so `risk.maxOpenPositions` must be raised
accordingly.

**The price step — `reArmStepPct` / `reArmStepRef`.** `ALWAYS` alone re-opens on every bar the conditions hold (after
`cooldownBars`). The step adds a price gate: while the layer holds open positions of its own, it opens another beside
them only once the decision bar's `close` has moved **at least** `reArmStepPct` percent **against** them — below the
reference for LONG (averaging down), above it for SHORT.

```json
{ "id": "grid", "side": "LONG", "sizeAbs": 200, "reArmOn": "ALWAYS", "cooldownBars": 3,
  "reArmStepPct": 5, "reArmStepRef": "LAST_FILL",
  "conditions": { "operator": "AND", "list": [ { "indicator": "RSI", "params": { "period": 14 }, "op": "LT", "value": 30 } ] } }
```

| `reArmStepRef`        | Measured from                                                                     |
| --------------------- | --------------------------------------------------------------------------------- |
| `LAST_FILL` (default) | entry price of **this layer's** newest still-open position — a grid: −5%, −10%, … |
| `AVG_ENTRY`           | quantity-weighted average entry of **this layer's** open positions                |

- **Per layer, not per side.** Unlike the `LAST_FILL`/`AVG_ENTRY` pseudo-series (§18.6.3), the reference is the
  layer's own positions, so two LONG layers each step from their own fills.
- **A flat layer is not gated.** The first entry, and the first one after every position of the layer has closed, fire
  on the conditions alone — even above the old fill.
- **Everything else still applies:** the layer's conditions, `cooldownBars`, `risk.maxOpenPositions` and the sizing.
  Every re-entry is its own position with its own exits, not an add (that is `pyramiding`, §18.7.5).
- **Recorded as `REARM_STEP_NOT_REACHED`.** The step is checked after the conditions, so a bar where the signal held but
  price had not stepped far enough says so in `/signals`, near-miss and `bars.csv`, and the layer stays armed.
- **Rejected** (`CONFIG_CONFLICT`): under `reArmOn` other than `ALWAYS` (the layer only re-arms once its positions are
  closed, so there is nothing to step from), and together with `pyramiding`.

### 18.7.2. Per-layer `exit` and inheritance

A layer without an `exit` inherits the strategy-level `exit` wholesale. A layer **with** an `exit` inherits
**per facet**, and a facet resolves as a **unit**: touch any field of it and the whole facet stops inheriting.

| Facet              | Fields that make it up                                                                     | Resolution |
| ------------------ | ------------------------------------------------------------------------------------------ | ---------- |
| take-profit        | `takeProfitPct`, `takeProfitAtrMult`, `takeProfitR`, `takeProfitRef` (+ buffer, dynamic), `takeProfits[]` | as a unit  |
| stop-loss          | `stopLossPct`, `stopLossAtrMult`, `stopLossRef` (+ `stopLossRefAtrBuffer`), `stopLosses[]` | as a unit  |
| time and session   | `maxHoldingBars`, `timeStop`, `flatAtHourUtc`, `flatBeforeFunding` (§18.8.8)               | as a unit  |
| `atrRef`           | —                                                                                          | on its own |
| `breakEven`        | —                                                                                          | on its own |
| `trailingStop`     | —                                                                                          | on its own |
| `signal`           | —                                                                                          | on its own |
| `partialSignals[]` | —                                                                                          | on its own |

So a layer that sets `stopLossAtrMult` replaces an inherited `stopLossPct` outright, a layer's `takeProfits[]`
ladder replaces an inherited scalar take-profit, and a layer that declares `timeStop` does **not** pick up the
strategy's `flatAtHourUtc`. An absent facet means _inherit_, not _disabled_ — there is no way to switch one off for
a single layer once the strategy-level `exit` defines it.

When present, a layer `exit` must specify at least one of `takeProfitPct`, `takeProfitR`, `takeProfitAtrMult`,
`takeProfitRef`, `takeProfits`, `stopLossPct`, `stopLossAtrMult`, `stopLossRef`, `stopLosses`, `trailingStop`,
`partialSignals`, `maxHoldingBars`, `timeStop`, `flatAtHourUtc`, `flatBeforeFunding` or `signal`, and obeys all the
§18.8 rules.

### 18.7.3. Legacy `entry` shape

`entry` is an object with optional `long` and `short` condition groups (at least one). It is compiled into layers
with ids `entry-long` / `entry-short`, `cooldownBars: 0`, `reArmOn: ALL_LAYERS_CLOSED`, sized from
`risk.positionSizePct` (default 100) or `risk.positionSizeAbs`. Do not generate this shape for new strategies.

### 18.7.4. `sizing` — the five modes and the size multipliers

`additionalProperties: false`, requires `mode`. Mutually exclusive with the layer's own `sizePct` / `sizeAbs`,
which are shorthands for its first two modes — a layer that needs neither a risk budget nor a notional cap should
keep using them. See [pro-platform/03-risk-sizing-and-guards.md](pro-platform/03-risk-sizing-and-guards.md) §3.2 and
[edge/03-strategy-mechanisms.md](edge/03-strategy-mechanisms.md) §3.5.1–§3.5.2.

| `mode`       | Required value            | Formula                                                          |
| ------------ | ------------------------- | ---------------------------------------------------------------- |
| `PCT_EQUITY` | `sizePct`                 | `margin = freeEquity × sizePct/100` — identical to the shorthand |
| `ABS`        | `sizeAbs`                 | `margin = sizeAbs` — identical to the shorthand                  |
| `RISK_PCT`   | `riskPct`                 | `qty = equity × riskPct/100 ÷ \|entryFill − stopLevel\|`         |
| `VOL_TARGET` | `targetVolPct` + `atrRef` | `qty = equity × targetVolPct/100 ÷ (ATR × atrMult)`              |
| `RISK_ABS`   | `riskAbs`                 | `qty = riskAbs ÷ \|entryFill − stopLevel\|` — a fixed 1R in USDT |

| Field            | Type   | Constraints                                                                                                   |
| ---------------- | ------ | ------------------------------------------------------------------------------------------------------------- |
| `mode`           | string | `"PCT_EQUITY"` \| `"ABS"` \| `"RISK_PCT"` \| `"VOL_TARGET"` \| `"RISK_ABS"`                                   |
| `riskAbs`        | number | `> 0` — USDT risked to the stop, whatever the equity                                                          |
| `multipliers`    | array  | `minItems: 1`, items `{when: conditionNode, factor > 0}`, both required                                       |
| `factorClamp`    | array  | exactly `[min, max]`, both `> 0`, `min ≤ max`; only together with `multipliers`                               |
| `riskPct`        | number | `> 0`, `maximum: 100` — percent of **equity** (not free equity) risked to the stop                            |
| `targetVolPct`   | number | `> 0` — percent of equity per unit of expected move                                                           |
| `atrMult`        | number | `> 0`, default `1` — the `k` of the `VOL_TARGET` denominator                                                  |
| `atrRef`         | object | an `indicatorRef` whose `indicator` **must be** `"ATR"`; the sizing block's own, independent of `exit.atrRef` |
| `maxNotionalPct` | number | `> 0`, `≤ 100 × leverage` — notional ceiling as a percent of equity                                           |
| `maxNotionalAbs` | number | `> 0` — the same ceiling in USDT; when both are set the tighter binds                                         |

Both ceilings **trim** the size; neither cancels the entry. They are applied after the mode's formula and before the
margin check, so a capped entry still opens — smaller than the risk budget asked for. An entry whose margin does not
fit into free equity even after trimming is skipped for that bar, exactly as an oversized `sizeAbs` is.

`riskPct` deliberately measures against **equity**, not free equity: "I risk 1% per trade" has to keep meaning that
while a scale-in layer holds margin. The margin-budget modes keep measuring against free equity, so `Σ sizePct`
across layers still cannot overspend the deposit.

No lot/step rounding is applied — the backtest engine works in raw quantities end to end.

**Size multipliers.** `multipliers[]` scale the size the mode derives, on the decision bar:

```json
"sizing": {
  "mode": "RISK_ABS", "riskAbs": 50,
  "multipliers": [
    { "when": { "indicator": "EQUITY_DD", "op": "GT", "value": 5 }, "factor": 0.5 },
    { "when": { "ref": "strongTrend" },                              "factor": 1.5 }
  ],
  "factorClamp": [0.1, 3.0]
}
```

- The **size factor** is the product of the `factor`s whose `when` holds, clamped to `factorClamp` (unbounded when
  absent); `1` when none holds. `when` is any condition node read on the layer's side exactly like the layer's own
  entry conditions — indicators, `defs`, series, pseudo-series (`EQUITY_DD`, `LOSSES_IN_ROW`, …).
- Applied **after** the mode's formula and **before** `maxNotionalPct`/`maxNotionalAbs`, so a ceiling still binds a
  scaled-up size. For the margin modes the margin is scaled, and a scaled margin that no longer fits free equity is
  skipped like any oversized entry.
- Each trade row carries it as `report.trades.size_factor` (`sizeFactor` in `GET /backtests/{id}/trades`, the
  `size_factor` column of `trades.csv`); `null` for a layer without multipliers. The run summary's `sizeFactors`
  reports the distribution. A pyramiding add is scaled by the multipliers on its own bar; the trade row keeps the
  factor of the first leg.

Rules that JSON Schema cannot express, enforced as `CONFIG_CONFLICT`:

| Rule                                                                                                          | Why it is not a schema rule          |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `RISK_PCT` / `RISK_ABS` require a defined stop on the layer's exit **or** the strategy exit it inherits from | crosses the layer/strategy boundary  |
| `RISK_PCT` / `RISK_ABS` are incompatible with `exit.scope: "AGGREGATE"`                                       | depends on the root `exit`           |
| `VOL_TARGET`'s `atrRef.indicator` must be `"ATR"`                                                             | same check as `exit.atrRef`          |
| `maxNotionalPct ≤ 100 × leverage`                                                                             | depends on `market.futures.leverage` |
| `factorClamp[0] ≤ factorClamp[1]`                                                                             | compares two items of one array      |
| pseudo-series in `multipliers[].when` follow the pseudo-series rules of §18.6.3                               | same checks as entry conditions      |

---

### 18.7.5. `pyramiding` — adding to a working position

Root-level block (§5.7). A layer whose own position is still open **adds to it** instead of opening a second one
beside it — so the add skips both the re-arm gate and `risk.maxOpenPositions`, which is the point of the feature.

| Field                | Type                      | Meaning                                                                                                    |
| -------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `maxAdds`            | integer ≥ 1, **required** | How many times one position may be added to                                                                |
| `onlyIfInProfit`     | boolean                   | Add only while the position is above its average entry (below, for SHORT)                                  |
| `minProfitR`         | number > 0                | Add only past this many initial risks. Requires a defined stop; reads the same R as `POS_R`                |
| `sizeScale`          | number in (0, 1]          | Add _n_ is `sizeScale^n` of the layer's **base** size — geometric, like `dca.safetyOrders.volumeScale`     |
| `moveStopToAvgEntry` | boolean                   | Pull the stop to the new average after each add; where `breakEven` already tightened it, the stricter wins |

Three things worth knowing:

- **`sizeAbs` is a notional**, so an add's _quantity_ is re-sized at the add bar's price. Add _n_ commits exactly
  `sizeAbs × sizeScale^n` USDT, whatever the price did.
- **The layer's `cooldownBars` survives an add** — adding is not re-arming, so the cooldown is not restarted.
- **The analytics basis moves with the average.** After an add, `mae_pct`/`mfe_pct` restart from the new average and
  `r_multiple` measures against the new stop; `bars_held` still counts from the first fill.
- **On futures an add reserves its own margin** (its notional at its fill, divided by leverage), and the liquidation
  level moves to the one for the new average entry — adding to a winning long pulls the liquidation level up with it.
- **Under `execution.fillAt: NEXT_OPEN`** an add is decided on the close (profit test, `minProfitR`, `sizeScale`,
  `maxAdds`) and fills at the next bar's open on the same position, like every other NEXT_OPEN fill. No add is raised for
  a position whose exit was decided on the same close. The decision stands at the fill: if the open gaps under water
  the add still fills, and with `moveStopToAvgEntry` the new stop then sits above (LONG) the price, so the whole
  position stops out on that bar at about the open.

Rejected: `pyramiding` with `exit.scope: AGGREGATE` (no per-position referent), with `dca` (already an averaging
mechanism), with a layer's `reArmStepPct` (§18.7.1 — that steps new positions, not adds), and `minProfitR` without a
stop.

### 18.7.6. `entryOrder` — resting STOP and LIMIT entries

Without it a signalling layer takes the market at the bar's close (or the next open, §18.10.1). With it the layer
**rests an order** at a level derived from a price-scale reference and leaves it working for `ttlBars` bars.
`additionalProperties: false`.

```json
"entryOrder": {
  "type": "STOP",
  "priceRef": { "indicator": "HIGHEST", "params": { "period": 20, "source": { "indicator": "HIGH" } }, "offset": 1 },
  "atrOffset": 0.1, "atrRef": { "indicator": "ATR", "params": { "period": 14 } },
  "ttlBars": 6,
  "cancelIf": { "left": { "indicator": "CLOSE" }, "op": "LT", "right": { "indicator": "EMA", "params": { "period": 50 } } }
}
```

| Field          | Type    | Required | Constraints                                                                                          |
| -------------- | ------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `type`         | string  | yes      | `"STOP"` \| `"LIMIT"`                                                                                |
| `priceRef`     | object  | yes      | a **price-scale** `indicatorRef`, a `VALUEWHEN` series of a price-scale take, or (setup layers only) a setup anchor |
| `atrOffset`    | number  | no       | `> 0` — the level sits this many ATRs beyond `priceRef`; requires `atrRef`                            |
| `atrRef`       | object  | with `atrOffset` | `indicator` must be `"ATR"`                                                                  |
| `offsetPct`    | number  | no       | `0 < offsetPct < 100` — the level sits this many percent of `priceRef` beyond it; no `atrRef`. Not with `atrOffset` |
| `ttlBars`      | integer | yes      | `1..500` — bars the order works, counted from the bar after the decision bar                         |
| `cancelIf`     | object  | no       | any condition node — withdraws the order on the close of a waiting bar where it holds                |
| `fillRule`     | string  | no       | `"TRADE_THROUGH"` (default) \| `"TOUCH"` — LIMIT only                                                |
| `reservesSlot` | boolean | no       | default `true` — the resting order counts against `risk.maxOpenPositions`                            |

**Level.** A LONG `STOP` rests **above** the reference (`ref + atrOffset × ATR`, or `ref × (1 + offsetPct / 100)`), a
LONG `LIMIT` **below** it (`ref − atrOffset × ATR`, or `ref × (1 − offsetPct / 100)`); SHORT is mirrored. With neither
offset the level is the reference itself. "Sell short on a limit 3 % above the signal bar's close, for one bar" is
`{ "type": "LIMIT", "priceRef": { "indicator": "CLOSE" }, "offsetPct": 3, "ttlBars": 1 }` on a SHORT layer. The level must sit on its own side of the decision bar's close — a LONG stop at or below the close, or a
LONG limit at or above it, would fill at once as a market order in disguise. Such a bar, and a bar whose reference
has not printed, record `INVALID_ORDER_LEVEL`; nothing is placed and the layer stays armed. The size is computed at the
level, on the decision bar.

**Fill** — at the start of a later bar, before liquidation and the protective exits:

| Order      | Fills when                                  | at                  |
| ---------- | ------------------------------------------- | ------------------- |
| STOP LONG  | `high ≥ level`                              | `max(level, open)`  |
| LIMIT LONG | `low < level` (`TOUCH`: `low ≤ level`)      | `min(level, open)`  |

SHORT mirrored. A `STOP` then pays the slippage model and `fees.takerPct`; a `LIMIT` fills at its price with **no
slippage** and pays `fees.makerPct` (trade `feeKind: "MAKER"`). `TRADE_THROUGH` is the default because a touch without
a print beyond the level does not always fill on a real book. On the fill bar the order is re-checked like a
`NEXT_OPEN` intent — equity, the risk contour, the position cap, a structural stop inverted by the fill price — and a
failed check cancels it (`ORDER_CANCELLED` with a reason). **The fill bar is read conservatively:** the position's stop
can take it out on that same bar, its take-profit cannot (which extreme came after the fill is unknown).

**Lifetime.** Unfilled on bar `placed + ttlBars` → `ORDER_EXPIRED`. `cancelIf` true on a waiting bar's close →
`ORDER_CANCELLED`. While it rests the layer is not evaluated (`ORDER_WORKING`); once it ends, the layer may place a
new one — on that same bar. Cooldown and re-arm count from the placement.

**Slots.** With `reservesSlot: true` a resting order takes a slot of `maxOpenPositions` from the bar it is placed on,
so other layers — market ones included — see the book as fuller. With `false` it takes no slot and the cap is checked
only at the fill, where the order is cancelled if the book is full.

**Not with** `execution.fillAt: "NEXT_OPEN"` (the order already decides when and where the entry fills) and **not
with** `pyramiding` — both `CONFIG_CONFLICT`. A `dca` block has no `entries[]` to carry one. The run's
`metrics.orderFillRatePct` is filled / placed × 100.

## 18.8. `exit`

| Field                  | Type    | Constraints                                                                                                                                                          |
| ---------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scope`                | string  | `"PER_POSITION"` (default) \| `"AGGREGATE"`                                                                                                                          |
| `takeProfitPct`        | number  | `> 0` — percent from the entry fill                                                                                                                                  |
| `takeProfitR`          | number  | `> 0` — multiples of the initial risk `\|entryFill − stopLoss\|`; requires a stop, §18.8.1                                                                           |
| `stopLossPct`          | number  | `> 0` — percent from the entry fill                                                                                                                                  |
| `takeProfitAtrMult`    | number  | `> 0` — multiples of ATR at the entry bar; requires `atrRef`                                                                                                         |
| `stopLossAtrMult`      | number  | `> 0` — multiples of ATR at the entry bar; requires `atrRef`                                                                                                         |
| `stopLossRef`          | object  | Structural stop (§5.2): an `indicatorRef` on a **price-scale** code. The stop is placed at its value on the entry bar and never moves. `offset` reads it N bars back |
| `stopLossRefAtrBuffer` | number  | `> 0` — push the structural stop this many ATRs beyond the reference. Requires `stopLossRef` and `atrRef`                                                            |
| `takeProfitRef`        | object  | Reference target (EDGE-6): a price-scale `indicatorRef`, a `VALUEWHEN` price series or (setup layer exit only) a setup anchor. The target sits at its value on the decision bar |
| `takeProfitRefAtrBuffer` | number | `> 0` — pull the reference target this many ATRs back toward the position. Requires `takeProfitRef` and `atrRef`                                                   |
| `takeProfitRefDynamic` | boolean | re-price the reference target after every bar (it follows the channel). Requires `takeProfitRef`; not with an anchor                                                |
| `atrRef`               | object  | an `indicatorRef` whose `indicator` **must be** `"ATR"`                                                                                                              |
| `takeProfits`          | array   | take-profit ladder, `minItems: 1`, `maxItems: 10`, §18.8.2                                                                                                           |
| `stopLosses`           | array   | stop-loss ladder, `minItems: 1`, `maxItems: 10`, §18.8.6                                                                                                             |
| `partialSignals`       | array   | partial exits by condition, `minItems: 1`, `maxItems: 10`, §18.8.7                                                                                                   |
| `breakEven`            | object  | §18.8.3                                                                                                                                                              |
| `trailingStop`         | object  | §18.8.4                                                                                                                                                              |
| `trailingTakeProfit`   | object  | **root `exit` only, `scope: "AGGREGATE"` only** — trailing take from the side's average entry, §18.8.9                                                               |
| `maxHoldingBars`       | integer | `minimum: 1` — hard ceiling on holding time, §18.8.8                                                                                                                 |
| `timeStop`             | object  | `{afterBars ≥ 1, ifNotInProfit}`, `afterBars` required, §18.8.8                                                                                                      |
| `flatAtHourUtc`        | integer | `0..23` — session flat at this UTC hour, §18.8.8                                                                                                                     |
| `flatBeforeFunding`    | boolean | futures only — flat before the next funding, §18.8.8                                                                                                                 |
| `signal`               | object  | conditionGroup — close at the bar close when it becomes true                                                                                                         |

Levels are measured from the **entry fill price** (slippage already applied). LONG take-profit is
`entry × (1 + pct/100)`, `entry + mult × atr[entryBar]` or `entry + R × |entry − stopLoss|`; SHORT is mirrored. The
mirror is why a percent level is bounded on one side only: `stopLossPct` must be below `100` on a block that can go
LONG and `takeProfitPct` below `100` on a block that can go SHORT (the level would sit at or below zero and never
fill), while a LONG take-profit of `150` or a SHORT stop of `150` is legal. "Can go" is read from the layer's own
`side`, or for the root exit from every side the layers declare.

The stop is resolved **before** the take-profit, which is what makes the R unit possible: `takeProfitR: 2` is "two
risks away", so it only exists once there is a risk to measure. A stop that cannot resolve (an ATR stop on a bar with
no ATR) leaves the R take-profit unset rather than inventing one, the same fail-soft an ATR level already has.

#### The structural stop has to be on the losing side of the entry

`stopLossRef` is the one stop facet whose level does **not** come from the entry fill: it is whatever the indicator
reads on the decision bar. So it can resolve on the wrong side — a LONG whose last confirmed swing low sits _above_ the
price it enters at, which is the ordinary shape of a pullback entry, because `PIVOTLOW` confirms a swing only `right`
bars after it forms and price keeps falling in the meantime.

Such a stop cannot lose: the next bar takes it out for a profit, booked as `SL`. **The engine declines the entry
instead.** The bar records the outcome `INVALID_STOP`, the layer stays armed, and the next bar whose reference is back
below the fill trades normally. A SHORT is mirrored (reference below the fill), and a reference landing exactly on the
fill counts the same way — it is the zero-risk case, which already left `takeProfitR` unset and sized `RISK_PCT` to
nothing.

This is a **runtime** rule, not a config one: nothing is wrong with the file, so §18.8.1 does not reject it. If a
strategy suddenly trades far less than expected, `INVALID_STOP` in the signals view is where to look.

### 18.8.1. `exitUnitExclusivity` — illegal combinations

| Combination in one exit block                                                     | Result |
| --------------------------------------------------------------------------------- | ------ |
| `takeProfitPct` + `takeProfitAtrMult`                                             | reject |
| `takeProfitPct` + `takeProfitR`                                                   | reject |
| `takeProfitAtrMult` + `takeProfitR`                                               | reject |
| `stopLossPct` + `stopLossAtrMult`                                                 | reject |
| `stopLossPct` + `stopLossRef`                                                     | reject |
| `stopLossAtrMult` + `stopLossRef`                                                 | reject |
| `stopLossRefAtrBuffer` without `stopLossRef` or without `atrRef`                  | reject |
| `stopLossRef` on a non-price-scale code (e.g. `RSI`)                              | reject |
| `stopLossRef` with `exit.scope: AGGREGATE`                                        | reject |
| `stopLosses` + `stopLossPct` / `stopLossAtrMult` / `stopLossRef`                  | reject |
| `stopLosses[]` rungs mixing `pct` and `atrMult`                                   | reject |
| `stopLosses[]` not strictly increasing in distance                                | reject |
| `takeProfits[]` + `stopLosses[]` + `partialSignals[]` `sizePct` summing above 100 | reject |
| `trailingStop.activateAfterPct` + `activateAfterR`                                | reject |
| `activateAfterR` with no stop on this block or the strategy exit                  | reject |
| `takeProfits` + `takeProfitPct`                                                   | reject |
| `takeProfits` + `takeProfitAtrMult`                                               | reject |
| `takeProfits` + `takeProfitR`                                                     | reject |
| `takeProfitRef` + `takeProfitPct` / `takeProfitAtrMult` / `takeProfitR` / `takeProfits` | reject |
| `takeProfitRefAtrBuffer` without `takeProfitRef` or without `atrRef`              | reject |
| `takeProfitRefDynamic` without `takeProfitRef`                                    | reject |
| `takeProfitRef` or a `priceRef` rung on a non-price-scale code                    | reject |
| `takeProfitRef` or a `priceRef` rung with `exit.scope: AGGREGATE`                 | reject |
| `takeProfitRefDynamic: true` on a setup anchor                                    | reject |
| `takeProfitR` or a `priceR` rung with no stop on this block or the strategy exit  | reject |
| `takeProfitR` or a `priceR` rung with `scope: "AGGREGATE"`                        | reject |
| any `*AtrMult` (scalar, ladder rung, or `trailingStop.atrMult`) without `atrRef`  | reject |
| `atrRef.indicator` that is not `"ATR"`                                            | reject |
| `timeStop.afterBars` above `maxHoldingBars`                                       | reject |
| `maxHoldingBars` or `timeStop` with `exit.scope: AGGREGATE`                       | reject |
| `flatBeforeFunding: true` on `market.type: "spot"`                                | reject |
| `trailingTakeProfit` without `exit.scope: AGGREGATE`, or on an `entries[].exit`   | reject |
| `trailingTakeProfit` + `takeProfitPct`                                            | reject |
| `trailingTakeProfit.callbackAtrMult` without an ATR `exit.atrRef`                 | reject |
| `takeProfitPct` / `stopLossPct` on an `entries[].exit` with `exit.scope: AGGREGATE` | reject |
| `stopLossRefAtrBuffer` or a `stopLosses[].atrMult` rung with a non-ATR `atrRef`    | reject |
| `stopLossPct ≥ 100` where the block can go LONG; `takeProfitPct ≥ 100` where SHORT | reject |
| `breakEven.afterTp` naming a rung no ladder the block ends up with carries         | reject |

`stopLossPct` **plus** `takeProfitAtrMult` is fine — the exclusivity is per facet, not across facets.

### 18.8.2. `takeProfits[]` — the ladder

Closes the position in slices instead of all at once. Each item is `additionalProperties: false`, requires
`sizePct`, and requires **exactly one** of `pricePct` / `priceAtrMult` / `priceR` / `priceRef`.

| Field                 | Type    | Constraints                                                                          |
| --------------------- | ------- | ------------------------------------------------------------------------------------ |
| `id`                  | string  | `^[A-Za-z0-9_-]{1,16}$`, unique; defaults to `TP1`, `TP2`, … by position; uppercased |
| `pricePct`            | number  | `> 0` — distance from the entry fill in percent                                      |
| `priceAtrMult`        | number  | `> 0` — distance in ATR multiples; requires `exit.atrRef`                            |
| `priceR`              | number  | `> 0` — distance in multiples of the initial risk; requires a stop, §18.8.1          |
| `priceRef`            | object  | the rung sits **at** a price-scale `indicatorRef` or `VALUEWHEN` price series, read on the decision bar (EDGE-6) |
| `sizePct`             | number  | `> 0`, `maximum: 100` — share of the **initial** quantity closed                     |
| `moveStopToBreakEven` | boolean | default `false`; requires an `exit.breakEven` block                                  |

Ladder rules: all rungs use **one unit** (never mix `pricePct`, `priceAtrMult`, `priceR` and `priceRef`); levels must be
**strictly increasing** in that unit; ids unique; `Σ sizePct ≤ 100` (a shorter sum leaves a remainder for the stop / signal /
end-of-data exit); incompatible with `scope: "AGGREGATE"`. A `priceRef` ladder is the exception to the ordering rule —
its prices exist only per bar, so rungs fill in array order; a rung whose reference has not printed, or sits on the
losing side of the entry, drops the whole ladder for that position.

#### `takeProfitRef` — a target at a level

The take-profit twin of `stopLossRef`: the target **is** a price-scale reference — `PDH`, `KELTNER` `upper`, a
`VALUEWHEN` series, a setup anchor on a setup layer's exit. It is read on the decision bar and fixed there, fills
intrabar like any level (a gap through it fills at the open) with `exit_reason` `TP`. `takeProfitRefAtrBuffer` pulls it
that many ATRs back toward the position, so it fills in front of the level rather than on it. A target that resolves
on the **losing** side of the entry fill is dropped — the position keeps its stop / signal exits, the entry is not
declined. `takeProfitRefDynamic: true` re-prices the target after every bar from the reference's current value (it
follows the channel), matched from the next bar on; there is no side check then — a channel that comes down to the
price is a target the price reached.

### 18.8.3. `breakEven`

`additionalProperties: false`. A **one-shot** relocation of the stop, not a trailing stop.

| Field       | Type   | Constraints                                                           |
| ----------- | ------ | --------------------------------------------------------------------- |
| `offsetPct` | number | `minimum: 0`, default `0`; LONG stop at `entry × (1 + offsetPct/100)` |
| `afterTp`   | string | `^[A-Za-z0-9_-]{1,16}$`; the id of the rung that arms the move        |

Arm it either by flagging a rung with `moveStopToBreakEven: true` or by naming a rung in `afterTp`. Either way a
`breakEven` block must exist **on the exit the layer ends up with**: `breakEven` inherits from the root exit
independently of the ladder (§18.7.2), so a layer ladder flagged `moveStopToBreakEven` may rely on a root `breakEven`.
Conversely an `afterTp` must name a rung of a ladder that break-even actually applies to — a root `afterTp` that no
ladder anywhere carries is rejected rather than left dead. A small positive `offsetPct` (e.g. `0.1`) covers fees and
slippage.

### 18.8.4. `trailingStop`

`additionalProperties: false`; requires `atrMult` and/or `indicatorRef`. The only exit level recomputed every bar.

| Field              | Type   | Meaning                                                                                                                                   |
| ------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `atrMult`          | number | `> 0`. ATR offset of the level from its anchor, measured in `exit.atrRef` on the **current** bar. Required when `indicatorRef` is absent. |
| `indicatorRef`     | object | Anchor the level to this indicator series instead of the running extreme, e.g. `EMA(20)`.                                                 |
| `activateAfterPct` | number | `> 0` — arm the trail only once the trade is this many percent ahead (§5.5). Mutually exclusive with `activateAfterR`                     |
| `activateAfterR`   | number | `> 0` — the same threshold in initial risks. Requires a defined stop on this block or the strategy exit                                   |

Without `indicatorRef` the level trails the most favourable close since entry (LONG: `highestClose - atrMult × ATR`).
The level only ever tightens, coexists with the fixed stop-loss (the tighter one binds), and is recorded as
`exit_reason = SL_TRAILING`. Incompatible with `scope: "AGGREGATE"`.

**Activation.** Until the threshold is met the trail publishes no level and the fixed stop governs — a trail active from
the first bar stops good trades out on entry noise. The threshold is measured on the **most favourable close since
entry**, not the current one, so a spike arms the trail for good rather than arming and disarming it bar by bar. The
entry fill and the initial risk are both snapshotted at open: a `breakEven` or trailing move later changes the stop, so
an R recomputed afterwards would drift.

### 18.8.5. `scope`

`PER_POSITION` (default) — every position carries its own TP/SL from its own entry price.
`AGGREGATE` — TP/SL are computed once from the side's weighted-average entry and close the **whole side** at once.

Under `AGGREGATE`, ATR-based levels, `takeProfits[]` and `stopLosses[]` ladders, `partialSignals[]`, `stopLossRef`,
`trailingStop`, the **per-position** time exits (`maxHoldingBars`, `timeStop`) and root `pyramiding` are all rejected.
What is left: `takeProfitPct` **or** `trailingTakeProfit` (§18.8.9 — the side-wide trailing take), `stopLossPct`,
`signal` and the two session flats — and the percent levels **on the root exit only**: a per-layer `takeProfitPct` /
`stopLossPct` is rejected under `AGGREGATE`, because the engine reads the side-wide levels from the root exit alone and
would silently ignore a layer's (a layer `signal` still applies per position). The common reason for the
rejections: each of those features is priced from, or slices, **one position** — under `AGGREGATE` there is only a
side-wide weighted average, which has no entry bar to read and closes whole.

`flatAtHourUtc` and `flatBeforeFunding` are the deliberate exception (§18.8.8): they are calendar facts, not
per-position ones, so every position of a side meets them on the same bar at the same price — closing them one by
one is indistinguishable from closing the side together.

### 18.8.6. `stopLosses[]` — the stop ladder

The stop-side twin of §18.8.2 (docs/pro-platform/05-exits.md §5.3): stop out in slices at rising distances _against_
the trade instead of all at once. Each item is `additionalProperties: false`, requires `sizePct`, and requires
**exactly one** of `pct` / `atrMult`.

| Field     | Type   | Constraints                                                                                                             |
| --------- | ------ | ----------------------------------------------------------------------------------------------------------------------- |
| `id`      | string | `^[A-Za-z0-9_-]{1,16}$`; written verbatim (uppercased) to `trades.exit_reason`. Defaults to `SL1`, `SL2`, … by position |
| `pct`     | number | `> 0` — distance against the trade in percent. LONG: `entry × (1 − pct/100)`, SHORT mirrored                            |
| `atrMult` | number | `> 0` — the same distance in ATRs of the entry bar. Requires `atrRef`                                                   |
| `sizePct` | number | `> 0`, `≤ 100` — share of the **initial** quantity closed at this rung                                                  |

Distances are unsigned and strictly increasing down the ladder; all rungs use the same unit; the engine walks them in
array order and never re-sorts, so an out-of-order rung would be unreachable and is rejected rather than mis-executed.
Sizes are cumulative shares of the initial quantity, so a ladder summing to 100 closes to exactly zero. Mutually
exclusive with `stopLossPct` / `stopLossAtrMult` / `stopLossRef`, and unsupported under `scope: "AGGREGATE"`.

A ladder can still sit behind a `trailingStop`, or behind a stop that `breakEven` or `pyramiding.moveStopToAvgEntry`
moved. Both are on the losing side, so price reaches the nearer one first. Only the rungs nearer than that binding stop
fill; the binding stop closes whatever is left (`SL_TRAILING`, `SL_BREAK_EVEN` or `SL`), and the rungs beyond it never
fill. On a tie the binding stop closes everything at that price. Until 2026-10-22 the engine filled every rung the bar
reached before it looked at a tighter trail, so those runs booked worse fills.

### 18.8.7. `partialSignals[]` — partial exits by condition

Bank a slice when a condition becomes true rather than when price reaches a level (§5.4) — "take half off when RSI goes
above 70". Each item is `additionalProperties: false` and requires `sizePct` and `signal`.

| Field     | Type   | Constraints                                                                                                                |
| --------- | ------ | -------------------------------------------------------------------------------------------------------------------------- |
| `id`      | string | `^[A-Za-z0-9_-]{1,16}$`, unique within the list; becomes that slice's `exit_reason`. Defaults to `PARTIAL1`, `PARTIAL2`, … |
| `sizePct` | number | `> 0`, `≤ 100` — share of the **initial** quantity                                                                         |
| `signal`  | object | conditionGroup, **required** — the same shape as `exit.signal`                                                             |

Each rule fires **at most once per position**, in declaration order, and is evaluated in the signal slot of the bar
order in §18.10 — after the stop and the take-profit, before the time exits of §18.8.8. Like `signal`, it defers
under `execution.fillAt: NEXT_OPEN`. Unsupported under `scope: "AGGREGATE"`.

**One rule spans all three slicing mechanisms.** `takeProfits[]`, `stopLosses[]` and `partialSignals[]` are all shares
of the same initial quantity, so their `sizePct` **together** must not exceed 100 — a ladder that looks fine alone can
still overrun once the partials are counted.

### 18.8.8. Time and session exits

Four rules that close a position because of **when** it is, not because of a price
(docs/pro-platform/05-exits.md §5.1). They inherit as one unit (§18.7.2) and each closes the whole position at that
bar's `close`.

| Field                    | Type    | Constraints                                                                          | `exit_reason` |
| ------------------------ | ------- | ------------------------------------------------------------------------------------ | ------------- |
| `maxHoldingBars`         | integer | `≥ 1` — close once the position has been held this many bars                         | `TIME`        |
| `timeStop.afterBars`     | integer | `≥ 1`, **required** inside `timeStop`                                                | `TIME`        |
| `timeStop.ifNotInProfit` | boolean | default `false`; when `true`, a position in profit at that bar's close is left alone | `TIME`        |
| `flatAtHourUtc`          | integer | `0..23` — close on any bar falling in this UTC hour. `0` is midnight, not "off"      | `FLAT`        |
| `flatBeforeFunding`      | boolean | futures only — close on the last bar before the next funding settlement              | `FLAT`        |

```json
"exit": {
  "stopLossPct": 1.5,
  "maxHoldingBars": 48,
  "timeStop": { "afterBars": 12, "ifNotInProfit": true },
  "flatAtHourUtc": 23
}
```

`timeStop` is the useful one: "if it has not gone anywhere in twelve bars, get out". `maxHoldingBars` is the blunt
ceiling above it, which is why `timeStop.afterBars` above `maxHoldingBars` is rejected rather than accepted as dead
configuration.

Five things that decide how they behave:

- **Bars are counted from the entry bar, which is bar `0`.** `maxHoldingBars: 1` closes on the bar after the entry.
- **Profit is measured against the entry fill**, so a trade up only by the slippage it paid is not in profit.
- **They fire after the stop, the take-profit and the signal, and before the risk contour** (§18.10). On a bar where
  the stop also fires, the stop wins and the position is already gone — otherwise the exit-reason breakdown would
  drift towards `TIME`.
- **They do not defer under `execution.fillAt: NEXT_OPEN`** (§18.10.1). "We are done holding this" is a statement
  about the bar that just closed; deferring it would hold the position through the very bar the rule named.
- **Rules are checked in the order of the table and the first match wins**, so a bar that satisfies both
  `maxHoldingBars` and `flatAtHourUtc` is recorded as `TIME`.

`flatBeforeFunding` is rejected on spot rather than ignored — a spot strategy must not claim a protection it cannot
get. On futures with `applyFunding: false` it still flattens before every settlement: the flag switches off the
**charge**, not the funding series (since 2026-11-03; before, the series was absent there and the rule a silent
no-op). Flipping `applyFunding` therefore changes the funding bill, and what money moves (equity-sized positions, an
`ISOLATED` liquidation level, equity guards), but never which rules can see the settlements. It is a no-op only where a
futures symbol has no settlements loaded at all.

### 18.8.9. `trailingTakeProfit` — trailing take from the average (AGGREGATE)

The take-profit of a ladder that should ride a rally instead of banking a fixed `+X%` from the average: dormant while
the ladder averages down, armed once the side is far enough in profit, then it trails the peak and closes the **whole
side** on a give-back. **Root `exit` only, and only under `scope: "AGGREGATE"`** — per position the same idea is
`trailingStop` with `activateAfterPct` (§18.8.4). `additionalProperties: false`.

```json
"exit": {
  "scope": "AGGREGATE",
  "stopLossPct": 25,
  "trailingTakeProfit": { "activationRef": "AVG_ENTRY", "activationPct": 15, "callbackPct": 5 }
}
```

| Field             | Type   | Constraints                                                                                                   |
| ----------------- | ------ | ------------------------------------------------------------------------------------------------------------- |
| `activationRef`   | string | `"AVG_ENTRY"` (default, the only value) — the side's quantity-weighted average entry                          |
| `activationPct`   | number | **required**, `> 0` — arm once the peak is this many percent beyond the average                               |
| `callbackPct`     | number | `> 0`, `< 100` — close once price gives back this many percent **of the peak**                                |
| `callbackAtrMult` | number | `> 0` — the give-back in ATRs of `exit.atrRef` on the **current** bar; requires an ATR `exit.atrRef`          |

Exactly one of `callbackPct` / `callbackAtrMult`. The basis field is `activationRef`, **not** `ref`: an object with a
`ref` is a `defs` condition reference (§18.5.6), and the schema rejects `ref` here by name.

Per side (LONG and SHORT are separate books), LONG shown, SHORT mirrored:

- **Activation.** Dormant until the peak reaches `avg × (1 + activationPct/100)` — boundary-inclusive. Until then the
  side has no take-profit at all; the ladder keeps averaging down and only `stopLossPct`, a signal, a session flat or
  the end of data can close it.
- **Peak.** The highest **high** since the trail (re)started — the exchange-style "activation price + callback rate"
  order watches every price, not closes (unlike `trailingStop`, which tracks closes). The bar the side gained a
  position on counts only from its **close**: its high came before the fill.
- **Level.** `peak × (1 − callbackPct/100)`, never below the floor `avg × (1 + (activationPct − callbackPct)/100)`;
  in ATR mode `peak − callbackAtrMult × ATR` (no level while ATR is not yet defined). The level only ever tightens.
  With `callbackPct ≥ activationPct` the floor sits at or below the average, so an armed trail can close at a loss.
- **Timing.** The peak and the level are updated at the end of the bar (after its entries) and matched from the
  **next** bar on — the same no-lookahead rule as every trailing level. Hit intrabar it fills at the level; a bar that
  opens through it fills at the `open`. The fixed `stopLossPct` level stays in force; the bar trades against the
  tighter of the two (both sit below a LONG, so price reaches the higher first), and `exit_reason` says which:
  `TP_TRAILING` or `SL`. Not deferred under `execution.fillAt: NEXT_OPEN` — it is a price event.
- **Restart.** Any new fill on the side — a ladder add — restarts the trail against the **new** average: dormant again,
  peak at that bar's close, no level. An add made after activation has to earn the activation again. A position
  leaving the side by its own layer `signal` is not a fill: the average moves, the activation and the level stand.
  When the side goes flat everything resets.

`trailingTakeProfit` **replaces** `takeProfitPct` — both is `CONFIG_CONFLICT` (a fixed target below the activation
would close every deal before the trail arms). A `dca` config has no root `exit`, so it cannot use it. Each parameter is an ordinary numeric slot, so
`{ "$param": … }` (§18.2.1) and the optimizer's search space reach `activationPct` / `callbackPct` directly.

---

## 18.9. `dca` — declarative averaging-down grid

Root shape 3. `additionalProperties: false`, required `["side", "start", "baseOrder", "safetyOrders", "takeProfit"]`.

| Field                      | Type    | Required | Constraints                                                                |
| -------------------------- | ------- | -------- | -------------------------------------------------------------------------- |
| `side`                     | string  | yes      | `"LONG"` \| `"SHORT"`; must appear in root `sides`                         |
| `start`                    | object  | yes      | conditionGroup opening the base order                                      |
| `baseOrder.sizeAbs`        | number  | yes      | `> 0` — base-order margin in USDT. Fixed-quote sizing only                 |
| `safetyOrders.maxCount`    | integer | yes      | `1..25` — grid is `1 + maxCount` positions                                 |
| `safetyOrders.sizeAbs`     | number  | yes      | `> 0` — margin of the **first** safety order                               |
| `safetyOrders.volumeScale` | number  | no       | `> 0`, default `1.0` — order `k` is `sizeAbs × volumeScale^(k-1)`          |
| `safetyOrders.stepPct`     | number  | yes      | `> 0` — deviation of the **first** safety order from `priceRef`            |
| `safetyOrders.stepScale`   | number  | no       | `> 0`, default `1.0` — order `k` triggers at `stepPct × stepScale^(k-1)`   |
| `safetyOrders.priceRef`    | string  | no       | `"AVG_ENTRY"` (default) \| `"LAST_FILL"`                                   |
| `takeProfit.fromAvgPct`    | number  | yes      | `> 0` — TP distance from the weighted-average entry; closes the whole deal |
| `stopLoss.fromAvgPct`      | number  | no       | `> 0` — optional deal stop-loss from the weighted-average entry            |
| `reArm`                    | string  | no       | `"AFTER_DEAL_CLOSED"` — the only value                                     |

`baseOrder`, `safetyOrders`, `takeProfit` and `stopLoss` are each `additionalProperties: false`.

`dca` compiles into ordinary entry layers `dca-base`, `dca-safety-1` … `dca-safety-<maxCount>`, all with
`reArmOn: ALL_LAYERS_CLOSED`, and an exit forced to `scope: AGGREGATE`. Therefore:

- **`risk.maxOpenPositions` must be ≥ `1 + safetyOrders.maxCount`** — the default of 1 would silently cut the grid
  to its base order, so an insufficient (or absent) cap is rejected.
- If `risk.maxOpenPositionsPerSide` is set, it must be ≥ `1 + safetyOrders.maxCount` too.
- Do not emit a root `exit`, `entries` or `entry` alongside `dca`.

---

## 18.10. Execution semantics to assume

These determine what a _sensible_ config looks like, so generate against them:

- **Bar close, no lookahead.** All conditions read the current **closed** candle. `offset: 0` is that candle.
- **Fills.** By default (`execution.fillAt: CLOSE`) entries and `signal` exits fill at the bar's `close`; under
  `NEXT_OPEN` they fill at the next bar's `open` (§18.10.1). Take-profit, stop-loss, ladder rungs, trailing stops,
  time exits and liquidations fill **at the level price** (or that bar's `close`, for the time exits) under both
  models. End-of-data closes at the final `close`. A layer with `entryOrder` (§18.7.6) rests a STOP/LIMIT order
  instead, which fills at its level on a later bar.
- **Order within one bar:** deferred fills at the `open` (only under `NEXT_OPEN`) → resting entry-order fills →
  funding → liquidation (unless a stop is crossed first, see **Futures** below) → stop / take-profit / partials /
  signal → time and session exits → risk-contour flat →
  `cancelIf` on resting orders → entries (and new orders) → trailing-stop advance → AGGREGATE trailing-take advance →
  dynamic `takeProfitRef` re-price → equity record. A trailing level or dynamic target derived from bar `i` is only
  matched from bar `i+1` onward.
- **Exit priority.** With scalar levels: **SL → TP → signal** (pessimistic — the stop wins when one bar spans
  both). With a ladder: `stopLosses[]` rungs nearer than the binding stop first, then take-profit rungs in ascending
  order (one bar may fill several), then the possibly-moved binding stop closes the rest, then the signal (§18.8.6).
- **Costs.** Slippage moves the fill against you on both sides; the fee is charged on open **and** close, at the
  taker rate. `slippagePct`/`feesPct` are the scalar spellings of §18.4.1.
- **Warmup is loaded before `from`.** `max(warmup of every referenced indicator) + max offset` bars (capped at
  50 000) are read from the history **before** the period, so the first bar of the period is already warm and the
  run, its equity curve, its statistics and its buy-and-hold benchmark all start at `from`. Only when that history
  does not exist — the instrument listed later, or the platform's candles start later (spot `1d` from 2017-08, most
  futures from 2019-09) — is the shortfall taken out of the period's first bars, and the run fails with
  `INSUFFICIENT_HISTORY` when nothing of the period is left. EDGE-4 latches are updated from the first warm bar,
  before `from` included. Runs made before 2026-10-16 spent the whole
  warmup inside the period, so their numbers can differ from a re-run.
- **Futures.** Funding is applied on schedule when `applyFunding` is true; `false` stops the charge only, and
  `FUNDING`, `fundingFilter` and `flatBeforeFunding` read the settlements either way. Liquidation is checked before exits
  using a 0.4% maintenance margin rate plus `risk.liquidationBuffer`. The one exception is stops that price must
  cross first. If the bar opens short of the liquidation level and the position's stops close all of it before that
  level, they fill: each at its level, or at the open when the bar opened past it. That holds when every level a stop
  could fill at lies short of the liquidation level. Those levels are the fixed, break-even or trailing stop, and with a
  `stopLosses[]` ladder its rungs nearer than that stop (§18.8.6). Under `AGGREGATE` the side's stop counts:
  `stopLossPct` on the average entry, or the trailing take when it is tighter. Under `CROSS` the book must be one-sided
  and every position (under `AGGREGATE`, the side stop) must stop out before the account level. Liquidation still wins
  when the bar opens at or past its level, when the stops do not close the whole position before it (a ladder whose full
  rung lies past it included), and for a hedged `CROSS` book. Runs made before 2026-10-22 booked `LIQUIDATION` on those
  bars. Under `ISOLATED` margin funding settles into
  the position's own margin, so paid funding moves the liquidation level towards the price (received funding moves it
  away) — a long held for months at 1× can still be liquidated once funding has eaten its margin. A liquidation fills
  at its level and loses at most the position's margin plus fees and slippage. Under `CROSS` funding comes out of the shared
  account balance, which the account-level liquidation check already counts.
- **`exit_reason` values** written per trade: `TP`, `TP_TRAILING`, `SL`, `SL_BREAK_EVEN`, `SL_TRAILING`, `SIGNAL`, `TIME`, `FLAT`,
  `RISK_GUARD`, `EOD`, `LIQUIDATION`, plus ladder rung ids (`TP1`, `TP2`, …) and `partialSignals[]` ids
  (`PARTIAL1`, …).

### 18.10.1. `execution` — when a decision becomes a fill, and in what order levels print

`additionalProperties: false`; at least one of `fillAt` and `intrabar` must be present.

| `fillAt`    | Semantics                                                                               |
| ----------- | --------------------------------------------------------------------------------------- |
| `CLOSE`     | **Default.** Entries and `signal` exits fill at the `close` of the bar that raised them |
| `NEXT_OPEN` | The decision is queued on bar `i` and fills at `open[i+1]`, plus slippage               |

```json
"execution": { "fillAt": "NEXT_OPEN", "intrabar": { "source": "5m" } }
```

**`intrabar.source`** (EDGE-11 step 2) — `"1m"` or `"5m"`, and it must be **finer** than `instrument.timeframe`
(422 CONFIG_CONFLICT otherwise; sub-bars of the same length are the same bar again). A bar that covers more than one
level — stop and target, or a ladder rung and the stop — says nothing about which printed first, and without this block
the engine assumes the stop (rungs before the stop on a ladder). With it, the first sub-bar to touch a level decides;
a sub-bar covering both keeps the assumption, as does a bar the finer series does not reach. What the sub-bars settled
is `ambiguousBarsResolved`, what they could not is `ambiguousBarTrades` — and the pair `totalReturnPct` /
`pnlIfOptimisticPct` brackets what is still undecided. Every other
bar is priced exactly as it is without the block, so adding it never moves a run that had no ambiguous bars.

Omitting the block is identical to `CLOSE`, which is how every config written before this existed is priced.

**Why `NEXT_OPEN` is the honest one.** Filling at the `close` that _produced_ the signal pays a price that became
known at the very instant the decision was made. Trading for real, a strategy reacts to the closed candle, sends a
market order, and gets filled nearer the next bar's open. `NEXT_OPEN` models exactly that.

Four consequences worth knowing before setting it:

- **Only decisions defer.** Take-profit, stop-loss, ladder rungs, trailing stops, the time exits of §18.8.8 and
  liquidation are price or calendar events, not choices — they keep filling intra-bar at their own prices under
  both models. Entry conditions, `exit.signal` and `partialSignals[]` are the three things that queue.
- **A queued entry is re-checked on its fill bar**, against the open-positions caps and the risk contour of §18.4.
  A contour that blocks entries on the fill bar cancels the intent — no trade opens, and no second attempt is made.
- **A gap wider than the stop is honest, not a bug.** If `open[i+1]` is already past the level, the position opens
  and stops out on that same bar.
- **An exit intent still queued when the data ends is not lost:** the position closes at the last `close` as `EOD`
  rather than hanging. An entry intent simply expires — there is no bar left to fill it on.

The bar that _decided_ records `PENDING_FILL` in the per-bar entry outcomes; the trade row carries the next bar's
timestamp.

---

## 18.11. Validation checklist

Run through this before emitting. Each line is a real rejection, with the message text produced.

**Structure**

1. Root contains exactly one of the three shapes in §18.2 — `entries`+`exit`, `entry`+`exit`, or `dca` alone.
2. `name`, `market`, `instrument`, `sides`, `risk` are all present.
3. `market.type` is lower-case; `marginMode`, `sides[]`, `side` are upper-case.
4. `market.futures` present iff `market.type == "futures"`, with all three of `contractType`, `leverage`,
   `marginMode`.
5. `instrument.timeframe` is one of the six allowed values.
   5a. Every `{"$param": name}` names an entry of the root `params` — `Param '<name>' names no entry in params [...]`;
   the reference has no other key, `params` holds at most 32 finite numbers under `^[A-Za-z][A-Za-z0-9_]{0,31}$`, and
   the rest of this checklist applies to the config **after** substitution (§18.2.1).

**Entries and risk**

6. More than one `entries[]` layer needs `risk.maxOpenPositions` above its default of `1` —
   `risk.maxOpenPositions == 1 but entries has N layers`. That is the whole check: `2` with three layers passes, and
   the cap then simply limits how many of them can be open at once (§18.4).
7. `entries[].id` unique — `Duplicate entries[].id: <id>`.
8. Each layer sets exactly one of `sizing` / `sizePct` / `sizeAbs` —
   `entries[].id <id> must set exactly one of sizing / sizePct / sizeAbs (got none|2|3)`.
   8a. `sizing.mode: RISK_PCT` (and `RISK_ABS`, same message with its own mode name) needs a stop on the layer exit or the strategy exit —
   `entries[].id <id>.sizing uses mode RISK_PCT, which requires a defined stop (stopLossPct / stopLossAtrMult / stopLossRef) on this layer's exit or the strategy exit`;
   and is rejected under AGGREGATE — `... uses mode RISK_PCT, which is not supported with exit.scope = AGGREGATE`.
   `RISK_ABS` carries `riskAbs` — schema.
   8b. `sizing.mode: VOL_TARGET` needs an ATR reference —
   `entries[].id <id>.sizing.atrRef must reference the ATR indicator, got 'X'`.
   8c. `sizing.maxNotionalPct` is bounded by leverage —
   `entries[].id <id>.sizing.maxNotionalPct X exceeds 100 × leverage (L)`.
   8c'. `sizing.factorClamp` is `[min, max]` with `min ≤ max` and only beside `multipliers` —
   `entries[].id <id>.sizing.factorClamp [a, b] has min above max` (the rest is schema); every multiplier carries
   `when` and a `factor > 0` — schema.

**Costs and execution** (§18.4.1, §18.10.1)

8d. Never both spellings of a knob: `risk.feesPct` with `risk.fees`, or `risk.slippagePct` with `risk.slippage` —
schema (`422 INVALID_STRATEGY_CONFIG`).
8e. `risk.slippage` carries `model`; `ATR_FRACTION` also carries `k` and `atrRef`; `VOLUME_IMPACT` also carries
`impact` — schema. `risk.fees` carries at least one of `makerPct` / `takerPct`.
8f. `risk.slippage.atrRef` names ATR —
`risk.slippage.atrRef must reference the ATR indicator, got 'X'`.
8g. `risk.onExcess` never appears alone —
`risk.onExcess configures nothing without risk.maxVolumeParticipationPct`.
8h. `execution` carries exactly `fillAt`, valued `CLOSE` or `NEXT_OPEN` — schema.
8i. `entryOrder` carries `type`, `priceRef` and `ttlBars` (`1..500`); `atrOffset` needs `atrRef`; `offsetPct` lies in
`(0, 100)` and never beside `atrOffset` — schema. Not under
`NEXT_OPEN` — `entries[].id <id>.entryOrder cannot be combined with execution.fillAt = NEXT_OPEN — …`; not beside
`pyramiding` — `… cannot be combined with pyramiding — resting add orders are not supported`.
8j. `entryOrder.priceRef` is a price — `<where>.priceRef must reference a price-scale indicator (…), got 'X'`, or for a
series `<where>.priceRef reads series 'X', which is not a VALUEWHEN of a price-scale series — a level is a price`; a
setup anchor only on a layer with a `setup`. `entryOrder.atrRef` names ATR —
`<where>.atrRef must reference the ATR indicator, got 'X'`.
8k. `takeProfitRef` and `priceRef` rungs follow the same price rule; neither under `AGGREGATE` —
`<where> uses a reference take-profit (takeProfitRef / priceRef rungs), which is not supported with exit.scope = AGGREGATE`;
`takeProfitRefDynamic` never on an anchor — `<where>.takeProfitRefDynamic cannot follow a setup anchor — …`.

**Indicators**

9. Only the sixteen source-capable codes of §18.6.2 carry a `source` —
   `Indicator 'X' does not accept a source series; only [...] can be computed over another indicator`.
10. `source` has no `offset` and no nested `source` (`additionalProperties: false`).
    10a. Binary pattern flags (`ENGULFING`, `PINBAR`, `INSIDEBAR`, `DOJI`, `TTMSQUEEZE`, and the §18.6.5 figures
    `HARAMI`, `PIERCING`, `STAR`, `SOLDIERS`, `TWEEZER`, `NRN`) take no `CROSS_*` and cannot be a `source` —
    `CROSS_UP/CROSS_DOWN cannot involve binary signal 'X' — it is already the edge; compare it with GT 0 instead`
    and `'X' cannot be used as a source series — averaging a 0/1 pattern flag gives a hit rate, not a series`.
    Their `field` is fine (`ENGULFING` has `bull`/`bear`) — that is where this differs from the time predicates.
    10c. **Mixed-field codes are judged per field** (EDGE-26/27, §18.6.5): on `DOUBLE` the pulse is `value` and the
    levels are `neckline`/`target`/`invalid`; on `TRIANGLE` the pulses are `bull`/`bear` and the lines
    `upper`/`lower`; on `FLAG` the pulse is `value` and the box `upper`/`lower`/`target`; on `BOX` the pulses are
    `bull`/`bear` and the edges `upper`/`lower`. Rules 10a and the price-scale rules of `stopLossRef`/`takeProfitRef`/`priceRef`/setup anchors
    (§18.7.2, §18.7.6, §18.5.10) read the code **and** the field; a reference without a `field` is the default line
    (`value` / `bull`), i.e. the pulse. Messages name the pair: `… got 'DOUBLE.value' — a stop level is a price …`.
    `SUPERTREND` (PRO-6b) is mixed the other way round: its default `line` **is** the price (legal as a `stopLossRef`
    with or without `"field": "line"`), and `dir` is a ±1 trend regime — neither a price (rejected as a stop level) nor a
    pulse (`CROSS_*` on it is legal: `dir CROSS_UP 0` is the flip to an up trend).
    10b. **Compare a pulse with `GT 0` — never with `EQ 1`, never with a cross.** A figure code is `1` on exactly the
    bar that completes the figure and `0` on every other bar, so `GT 0` is the whole reading. Pick the side with
    `field` (`"field": "bear"`), not with `LT 0` — only the historical `PINBAR` is signed. A pulse lasts one bar: for
    "a morning star within the last 3 bars" use `within`, and to avoid re-entering on a fourth soldier use the
    layer's `reArmOn` or cooldown.
11. Pseudo-series (`AVG_ENTRY`, `LAST_FILL`, `POS_*`, `BARS_IN_POS`, `EQUITY_DD`, `LAST_TRADE_R`, `LAST_EXIT_SL`,
    `LOSSES_IN_ROW`, `WINS_IN_ROW`, `BARS_SINCE_EXIT`) only inside entry conditions, `sizing.multipliers[].when` and exit signals —
    `Pseudo-series 'X' is only allowed inside entry conditions and exit signals`; and no `params`
    (`pseudo-series 'X' takes no params`), no `field` (`... has no fields`), no `source`
    (`... cannot be computed over a source series`), `offset` 0 (`... has no history — offset must be 0`), and no
    `CROSS_*` (`CROSS_UP/CROSS_DOWN cannot involve pseudo-series 'X' (it has no previous value)`); no lag window and
    no slope either — `<where>: pseudo-series 'X' has no history — holdsFor/within must be 1, got N` /
    `... has no history — RISING reads the previous bars, which it does not have`. A setup anchor (§18.5.10) follows
    the same two rules — `<where>: setup anchor 'HIGH' has no history — …`.
12. `INTERVAL` / `TIME` / `SESSION` / `DAYOFWEEK` / `MONTHDAY` / `MONTH` / `WEEKOFYEAR` / `QUARTER` have no `field` (`Time predicate 'X' has no fields`),
    no `source` (`Time predicate 'X' cannot be computed over a source series`), are never a `source`
    (`'X' cannot be used as a source series — averaging a 0/1 time predicate is meaningless`), and never anchor
    `CROSS_*` (`CROSS_UP/CROSS_DOWN cannot involve time predicate 'X' — compare the 0/1 pulse with GT 0 instead`).
13. `pct` is present exactly when `op` ends in `_PCT`; `offset` is within `0..500`.

**Conditions (PRO-7)**

13a. `NOT` has exactly one child; `holdsFor`/`within` are within `1..500`, never both on one node and never on a
`conditionGroup` (the group is closed, `additionalProperties: false`) — all schema errors (`422`).
13b. `BETWEEN`/`OUTSIDE` carry `value2` (schema), and `value2` is strictly above `value` —
`BETWEEN needs value2 above value, got value=X value2=Y`.
13c. `RISING`/`FALLING` carry `bars`; every other operator carries `value` — schema.
13d. Every `{"ref": …}` names a declared definition —
`Condition ref 'X' names no entry in defs [...]`; and the definitions form no cycle —
`Cyclic condition ref: a -> b -> a`. Both are checked over the whole config, definitions included, so a cycle
between two definitions nothing references yet is still rejected.

13e. Every `{"series": …}` names an entry of the root `series` block — `Series ref 'X' names no entry in series [...]`;
a series reads no series — `series.X reads series [Y] — a series cannot be computed from another series` (checked after
`defs` are inlined); no pseudo-series or setup anchor inside a `when`/`take`; `series.X.minBars N exceeds its window M`;
a series `stopLossRef` is a `VALUEWHEN` of a price-scale `take` —
`<where>.stopLossRef reads series 'X', which is not a VALUEWHEN of a price-scale series` (§18.5.11).

**Cross-symbol (PRO-13, §18.5.8)** — checked wherever an `indicatorRef` appears, conditions and exits alike

13e. At most 3 **distinct** other instruments per config —
`A strategy may reference at most 3 other instruments, but this one names 4: ...`. Naming the traded instrument
is legal and counts for nothing.
13f. No `symbol` on a pseudo-series or a time predicate —
`Pseudo-series 'X' cannot name a symbol [...]` / `Time predicate 'X' cannot name a symbol [...]`.
13g. `CORR`/`BETA`/`RATIO`/`SPREADZ` **require** one —
`'CORR' compares two instruments and needs a 'symbol' naming the other one, e.g. "symbol": "BTCUSDT"` — and it
must not be the traded instrument (`... which is the instrument being traded ...`), since an instrument compared
with itself is constant.
13h. `symbol` matches `^[A-Z0-9]{2,20}$` (schema). Whether that instrument has candles is answered at run time, by
`NO_CANDLES` naming it, not here.

**Exits** (checked for the strategy `exit` and every `entries[].exit`)

14. Any `*AtrMult` requires `atrRef`, and `<where>.atrRef must reference the ATR indicator, got 'X'` — checked for
    every ATR facet: the scalar multiples, `takeProfits[].priceAtrMult`, `stopLosses[].atrMult`, `trailingStop.atrMult`,
    `takeProfitRefAtrBuffer` and `stopLossRefAtrBuffer`.
15. Under `scope: "AGGREGATE"`, none of: ATR levels
    (`<where> uses ATR-based levels, which are not supported with exit.scope = AGGREGATE`), a ladder
    (`... uses a takeProfits[] ladder, ...`), a trailing stop (`... uses a trailingStop, ...`), R levels
    (`... uses R-denominated levels, ...`).
    15b. Under `AGGREGATE` a layer carries no percent level of its own —
    `<where> declares takeProfitPct, which is not supported with exit.scope = AGGREGATE — the side-wide levels are read from the root exit only, so a per-layer percent would be silently ignored`
    (same for `stopLossPct`).
    15a. An R take-profit (`takeProfitR` or a `priceR` rung) needs a stop —
    `<where> uses an R-denominated take-profit, which requires a defined stop (stopLossPct / stopLossAtrMult / stopLossRef) on this block or the strategy exit`.
16. `trailingStop` defines `atrMult` and/or `indicatorRef` —
    `<where>.trailingStop must define atrMult (trail from the running extreme) and/or indicatorRef (trail an indicator)`.
17. Ladder rung ids unique — `<where>.takeProfits[] has duplicate id 'TPn'`.
18. Ladder uses one unit — `<where>.takeProfits[] mixes <a> and <b> rungs — a ladder must use one unit throughout`.
19. Ladder levels strictly increasing — `<where>.takeProfits[] must be strictly increasing in pricePct|priceAtrMult|priceR, got X after Y`.
20. `Σ sizePct ≤ 100` — `<where>.takeProfits[] sizePct sums to X%, which is more than the position`.
21. `breakEven.afterTp` names a rung of a ladder the break-even applies to, judged on the exit each layer **ends up
    with** (§18.8.3) — `<where>.breakEven.afterTp references 'X', which is not one of [...]`; and arming break-even
    needs a block on this exit or the root exit —
    `<where> arms a break-even stop but declares no exit.breakEven block (on this block or the strategy exit)`.
22. Per-facet unit exclusivity, §18.8.1.
    22e. `stopLossPct` below `100` where the block can go LONG, `takeProfitPct` below `100` where it can go SHORT —
    `<where>.stopLossPct 100.0 puts a LONG stop at or below zero — a LONG cannot lose more than 100% of the entry, so the stop could never fill`
    / `<where>.takeProfitPct 100.0 puts a SHORT take-profit at or below zero — …`.
    22a. `timeStop.afterBars` does not exceed `maxHoldingBars` when both are set —
    `<where>.timeStop.afterBars (X) must not exceed maxHoldingBars (Y) — the ceiling would always close the position first`.
    22b. No `maxHoldingBars` / `timeStop` under `AGGREGATE` —
    `<where> uses a per-position time exit (maxHoldingBars / timeStop), which is not supported with exit.scope = AGGREGATE`.
    The two session flats are allowed there (§18.8.5).
    22c. `flatBeforeFunding` only on futures —
    `<where> uses flatBeforeFunding, which requires market.type = futures`.
    22d. `trailingTakeProfit` (§18.8.9) only under `AGGREGATE` —
    `exit.trailingTakeProfit requires exit.scope = AGGREGATE (it trails the side's average entry); per position use exit.trailingStop with activateAfterPct`;
    not beside `takeProfitPct` — `exit.trailingTakeProfit replaces exit.takeProfitPct — declare one of them, not both`;
    an ATR callback needs an ATR reference —
    `exit.trailingTakeProfit.callbackAtrMult requires exit.atrRef referencing the ATR indicator, got 'X'`;
    never on a layer — `<where> declares trailingTakeProfit, which belongs on the root exit only — …`.

**DCA**

23. `dca.side` ∈ `sides` — `dca.side <side> is not listed in sides`.
24. `risk.maxOpenPositions ≥ 1 + safetyOrders.maxCount` —
    `risk.maxOpenPositions N (absent, default 1) is less than the DCA grid size G (base + safetyOrders.maxCount)`;
    same for `maxOpenPositionsPerSide` when set.

---

## 18.12. Not supported — do not emit

- **Order types only through `entryOrder`.** A layer may rest a STOP or LIMIT **entry** (§18.7.6) — that is the whole
  vocabulary. No `orderType`, `limitPrice`, `postOnly`, `stopMarket`, no limit or stop **exits** and no
  `takeProfitAsLimit`: every exit is priced at its level or the close as before, and pays the taker rate.
- **One traded instrument, one run timeframe.** A config still opens positions on exactly one `instrument.symbol` at
  one `instrument.timeframe`. What it may _read_ is wider: a reference can name a higher `timeframe` (§18.5.7) or
  another `symbol` (§18.5.8), so `EMA_200#4h!BTCUSDT` is expressible. Those two fields read data; they never make a
  second instrument tradable, and there is no basket, no rotation and no per-leg sizing.
- **No arithmetic expressions.** You cannot write `EMA(50) * 1.02` or `Close - Open`. Use `GT_PCT`/`LT_PCT` for a
  percentage margin, `source` (§18.6.2) to run an indicator over another series, and `DISTEMA` / `CANDLEPOS` /
  `AVGTRADESIZE` for the derived quantities that exist.
- **No order-book or open-interest indicators.** Volume and funding are in the catalog; depth and OI are not.
- **No user code, expressions, or scripts** of any kind.
- **No `field` or `params` on any pseudo-series** (`AVG_ENTRY`, `LAST_FILL`, `POS_MFE`, `POS_MAE`, `POS_GIVEBACK`,
  `POS_R`, `BARS_IN_POS`, `EQUITY_DD`, `LAST_TRADE_R`, `LAST_EXIT_SL`, `LOSSES_IN_ROW`, `WINS_IN_ROW`,
  `BARS_SINCE_EXIT`), and no `offset` other than 0.
- **No `entries[]` alongside `dca`**, and no root `exit` alongside `dca`.
- **No indicator outside the 114 codes of §18.6**, which is the authoritative list — this bullet deliberately does not
  repeat it, because a second copy is a second thing to forget. In particular there is still no `STOCH`, `HMA`, `PSAR`,
  `CCI` or `WILLR` (`PCTRANK` arrived in ANA-6, `STDDEV` and `ZSCORE` in EDGE-7, `STREAK` and `CRSI` with ConnorsRSI,
  `STOCHRSI`, `SUPERTREND`, `ADX`, `ROC` and `WMA` with the first PRO-6b batch).
- **`FUNDING` only on `market.type: "futures"`**.
- **`OI`, `OIVALUE`, `OICHG`, `LSRATIO`, `TAKERRATIO` only on `market.type: "futures"`**; those five, `VOLDELTA` and `CVD`
  compute only in a backtest, and none of the seven may carry a `symbol` (EDGE-10).
- **`MARK`, `INDEX`, `BASIS`, `DEPTH` only on `market.type: "futures"`, and only on a symbol (and, for the first three,
  a timeframe) that `GET /market/features` lists** — the data is loaded per watchlist flag, so the config is refused
  where it would compute to nothing (EDGE-9 level 2).
- **No `ha_close` price source.** Heikin-Ashi close is `(O+H+L+C)/4` of the raw bar, which is `OHLC4`. The HA series
  that differ (`ha_open`/`ha_high`/`ha_low`) do not exist yet.

---

## 18.13. Worked examples

### 18.13.1. Minimal spot long — EMA golden cross, scalar TP/SL

```json
{
  "name": "BTC 4h EMA Golden Cross",
  "version": 1,
  "market": { "type": "spot", "exchange": "binance" },
  "instrument": { "symbol": "BTCUSDT", "timeframe": "4h" },
  "sides": ["LONG"],
  "risk": { "maxOpenPositions": 1, "feesPct": 0.1, "slippagePct": 0.02 },
  "entries": [
    {
      "id": "golden-cross",
      "side": "LONG",
      "sizePct": 100,
      "reArmOn": "ALL_LAYERS_CLOSED",
      "conditions": {
        "operator": "AND",
        "list": [
          {
            "left": { "indicator": "EMA", "params": { "period": 50 } },
            "op": "CROSS_UP",
            "right": { "indicator": "EMA", "params": { "period": 200 } }
          },
          { "indicator": "RSI", "params": { "period": 14 }, "op": "LT", "value": 70 }
        ]
      }
    }
  ],
  "exit": { "scope": "PER_POSITION", "takeProfitPct": 12, "stopLossPct": 5 }
}
```

### 18.13.2. Futures, both sides — ATR ladder, break-even, trailing stop

Two layers, so `maxOpenPositions` is 2 and `maxOpenPositionsPerSide` is 1. Every level is ATR-denominated, so a
single `atrRef` is declared once on the exit block. `TP1` arms the break-even move; the ladder closes 70% and the
trailing stop takes the remaining 30%. It also fills at the next open (§18.10.1) and carries the two exits a futures
config normally wants: a 24-hour holding ceiling on 15m bars, and a flat before every funding settlement.

```json
{
  "name": "ETHUSDT 15m Adaptive Trend Pullback",
  "version": 1,
  "market": {
    "type": "futures",
    "exchange": "binance",
    "futures": { "contractType": "USDT_M_PERP", "leverage": 3, "marginMode": "ISOLATED", "applyFunding": true }
  },
  "instrument": { "symbol": "ETHUSDT", "timeframe": "15m" },
  "sides": ["LONG", "SHORT"],
  "risk": {
    "maxOpenPositions": 2,
    "maxOpenPositionsPerSide": 1,
    "feesPct": 0.04,
    "slippagePct": 0.02,
    "liquidationBuffer": 0.5
  },
  "entries": [
    {
      "id": "long-pullback",
      "side": "LONG",
      "sizePct": 10,
      "cooldownBars": 4,
      "reArmOn": "ALL_LAYERS_CLOSED",
      "conditions": {
        "operator": "AND",
        "list": [
          {
            "left": { "indicator": "EMA", "params": { "period": 50 } },
            "op": "GT",
            "right": { "indicator": "EMA", "params": { "period": 200 } }
          },
          {
            "left": { "indicator": "LOW" },
            "op": "LTE",
            "right": { "indicator": "BB", "params": { "period": 20, "stdDev": 2 }, "field": "middle" }
          },
          { "indicator": "RSI", "params": { "period": 14 }, "offset": 1, "op": "LT", "value": 48 },
          { "indicator": "RSI", "params": { "period": 14 }, "op": "GT", "value": 50 },
          {
            "left": { "indicator": "ATR", "params": { "period": 14 } },
            "op": "GT",
            "right": {
              "indicator": "SMA",
              "params": { "period": 50 },
              "source": { "indicator": "ATR", "params": { "period": 14 } }
            }
          },
          { "indicator": "CANDLEPOS", "op": "GT", "value": 0.65 },
          { "indicator": "DISTEMA", "params": { "emaPeriod": 20, "atrPeriod": 14 }, "op": "LT", "value": 1.0 }
        ]
      }
    },
    {
      "id": "short-pullback",
      "side": "SHORT",
      "sizePct": 10,
      "cooldownBars": 4,
      "reArmOn": "ALL_LAYERS_CLOSED",
      "conditions": {
        "operator": "AND",
        "list": [
          {
            "left": { "indicator": "EMA", "params": { "period": 50 } },
            "op": "LT",
            "right": { "indicator": "EMA", "params": { "period": 200 } }
          },
          {
            "left": { "indicator": "HIGH" },
            "op": "GTE",
            "right": { "indicator": "BB", "params": { "period": 20, "stdDev": 2 }, "field": "middle" }
          },
          { "indicator": "RSI", "params": { "period": 14 }, "offset": 1, "op": "GT", "value": 52 },
          { "indicator": "RSI", "params": { "period": 14 }, "op": "LT", "value": 50 },
          { "indicator": "CANDLEPOS", "op": "LT", "value": 0.35 },
          { "indicator": "DISTEMA", "params": { "emaPeriod": 20, "atrPeriod": 14 }, "op": "LT", "value": 1.0 }
        ]
      }
    }
  ],
  "execution": { "fillAt": "NEXT_OPEN" },
  "exit": {
    "scope": "PER_POSITION",
    "stopLossAtrMult": 1.5,
    "takeProfits": [
      { "id": "TP1", "priceAtrMult": 1.5, "sizePct": 30, "moveStopToBreakEven": true },
      { "id": "TP2", "priceAtrMult": 3.0, "sizePct": 40 }
    ],
    "breakEven": { "offsetPct": 0.1 },
    "trailingStop": { "atrMult": 1.5 },
    "maxHoldingBars": 96,
    "flatBeforeFunding": true,
    "atrRef": { "indicator": "ATR", "params": { "period": 14 } }
  }
}
```

### 18.13.3. DCA grid

Grid size is `1 + 5 = 6`, so both position caps are 6. No root `exit` / `entries`.

```json
{
  "name": "SOL 1h RSI DCA Grid",
  "version": 1,
  "market": { "type": "spot", "exchange": "binance" },
  "instrument": { "symbol": "SOLUSDT", "timeframe": "1h" },
  "sides": ["LONG"],
  "risk": { "maxOpenPositions": 6, "maxOpenPositionsPerSide": 6, "feesPct": 0.1, "slippagePct": 0.02 },
  "dca": {
    "side": "LONG",
    "start": {
      "operator": "AND",
      "list": [
        { "indicator": "RSI", "params": { "period": 14 }, "op": "LT", "value": 35 },
        {
          "left": { "indicator": "CLOSE" },
          "op": "GT",
          "right": { "indicator": "EMA", "params": { "period": 200 } }
        }
      ]
    },
    "baseOrder": { "sizeAbs": 100 },
    "safetyOrders": {
      "maxCount": 5,
      "sizeAbs": 100,
      "volumeScale": 1.5,
      "stepPct": 1.5,
      "stepScale": 1.3,
      "priceRef": "AVG_ENTRY"
    },
    "takeProfit": { "fromAvgPct": 2.0 },
    "stopLoss": { "fromAvgPct": 20.0 },
    "reArm": "AFTER_DEAL_CLOSED"
  }
}
```

---

## 18.14. Output contract

When asked to produce a strategy config:

1. Emit **one** JSON object and nothing else — no comments, no trailing commas, no `//` annotations, no wrapper
   keys such as `{"config": …}`.
2. Use only the fields, codes, enum values and operators defined above. If a requested feature is in §18.12, say
   so plainly instead of inventing a field.
3. Always spell out indicator `params` explicitly.
4. Re-read §18.11 and confirm every applicable line before answering — in particular `maxOpenPositions` against
   the layer count, `atrRef` wherever an `*AtrMult` appears, and the ladder ordering/sum rules.
