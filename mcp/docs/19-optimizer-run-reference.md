# 19 · Optimizer Run Reference (LLM-facing)

---

## 19.1. How to use this document

An optimization run is **one JSON object**, `POST`ed to `/api/v1/optimizations`. It does not contain a strategy — it
points at one (or carries one inline) and describes **which scalar values inside that config to vary**, over which
walk-forward windows, and how to score the results.

The single load-bearing rule:

> **A run varies values at scalar leaves that already exist in the base config. It never changes the config's shape.**

You cannot add a condition, remove an exit facet, switch the root branch (`entries` / `entry` / `dca`), or introduce a
key that is not already there. Every path in `searchSpace` must resolve, in the base config, to a **number or a
string**.

Validation is synchronous and fails fast. The layers, in the order a bad request meets them:

| # | Layer                                             | Failure                                                                                       |
| - | ------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 0 | `X-User-Id` header (set by the gateway from a JWT) | `401 UNAUTHORIZED`                                                                             |
| 1 | Active-run limit (2 per user)                     | `429 TOO_MANY_ACTIVE_RUNS`                                                                     |
| 2 | Bean validation on the DTO (and a body that is not JSON) | `400 VALIDATION_FAILED`                                                                 |
| 3 | Base-config source resolution                     | `422 INVALID_BASE_CONFIG`, `404 STRATEGY_NOT_FOUND`, `404 STRATEGY_VERSION_NOT_FOUND`          |
| 4 | Run params (market, leverage)                     | `422 INVALID_MARKET_TYPE` / `MISSING_FUTURES_PARAMS` / `INVALID_LEVERAGE`                      |
| 5 | `windowSpec` parse + period bounds + window layout | `422 INVALID_WINDOW_SPEC`                                                                     |
| 6 | `searchSpace` + `sampling` + limits               | `422 INVALID_SEARCH_SPACE` / `INVALID_PARAM_PATH` / `MUTEX_FACET_CONFLICT` / `GRID_TOO_LARGE`  |
| 7 | **Every** materialized variant, against doc 18, with the run's `symbol`/`timeframe` bound onto its `instrument` | `422 CONFIG_CONFLICT` — the first bad variant rejects the whole run |
| 8 | Pre-flight lint on the materialized variants      | `422 UNREACHABLE_MIN_TRADES`, or non-blocking `warnings[]` inside the `201`                    |

Everything after the `201` is asynchronous: the run fans out to the backtesting engine, scores itself, and settles into
a terminal status (§19.10).

Before answering, walk the checklist in §19.12.

---

## 19.2. Root object

17 fields. Nothing else is read.

| Field             | Type    | Required     | Constraints / default                                                       |
| ----------------- | ------- | ------------ | --------------------------------------------------------------------------- |
| `name`            | string  | yes          | `@NotBlank`, max 120 chars                                                  |
| `strategyId`      | integer | conditional  | exactly one of `strategyId` / `baseConfig`, §19.3                           |
| `strategyVersion` | integer | no           | omit = the strategy's **current** version                                   |
| `baseConfig`      | object  | conditional  | inline strategy config (doc 18); exactly one of `strategyId` / `baseConfig` |
| `exchange`        | string  | yes          | `@NotBlank`, e.g. `"binance"`                                               |
| `marketType`      | string  | yes          | `"spot"` \| `"futures"` — case-insensitive in, stored lower-case            |
| `symbol`          | string  | yes          | `@NotBlank`, raw exchange symbol: `ETHUSDT`                                 |
| `timeframe`       | string  | yes          | `@NotBlank`; use one of `1m` `5m` `15m` `1h` `4h` `1d` — §19.3              |
| `initialCapital`  | number  | yes          | `@NotNull @Positive`                                                        |
| `leverage`        | integer | futures only | `1..125`; **rejected on spot**                                              |
| `marginMode`      | string  | futures only | `"ISOLATED"` \| `"CROSS"`; **rejected on spot**                             |
| `applyFunding`    | boolean | futures only | default `true` on futures; forced `null` on spot                            |
| `searchSpace`     | array   | yes          | `@NotNull`, non-empty array of dimensions, §19.4                            |
| `sampling`        | object  | no           | default `{"strategy":"GRID"}`, §19.5                                        |
| `maxVariants`     | integer | no           | default `500`, hard cap `5000`; **GRID only**, §19.6                        |
| `windowSpec`      | object  | yes          | `@NotNull`, §19.7                                                           |
| `scoring`         | object  | no           | every field defaulted server-side, §19.8                                    |

`maxVariants` is a **request-time limit only**. It is not persisted and appears in no response; what actually happened
is visible as `variantsTotal`.

---

## 19.3. Base config, market, instrument, capital

### Base config source — exactly one

| Shape                                       | Effect                                                                                                                                             |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `strategyId` (+ optional `strategyVersion`) | optimizer fetches a snapshot of the saved strategy (ownership enforced there); `promote` can later turn a winner into a new version of that strategy |
| `baseConfig` (inline object)                | an unsaved config, dry-run style; `promote` then fails with `422 NO_SOURCE_STRATEGY` — there is nothing to version                                   |

Both or neither → `422 INVALID_BASE_CONFIG`: `Exactly one of strategyId / baseConfig must be provided`. A `baseConfig`
of JSON `null` counts as absent.

**Prefer `strategyId`.** Inline configs cannot be promoted, and promotion is usually the point of the run.

### Market / instrument / capital

These are **run-level** and are what the engine actually executes with: candle loading, the spot-vs-futures position
manager, funding and the leverage model all read them, **not** the `market` / `instrument` blocks inside the config.
Set them to agree with the base config anyway — a config that says `"type": "futures"` while the run says `spot` is
accepted and then behaves as spot.

- `marketType` must be `spot` or `futures` → `422 INVALID_MARKET_TYPE`: `marketType must be 'spot' or 'futures'`.
- On **futures**, both `leverage` and `marginMode` are required (`422 MISSING_FUTURES_PARAMS`:
  `leverage and marginMode are required for futures`) and `leverage` must be `1..125`
  (`422 INVALID_LEVERAGE`: `leverage must be between 1 and 125, got N`).
- On **spot**, sending either one is an error — same code, other message:
  `leverage and marginMode are not applicable to spot`. Omit all three futures fields entirely.
- `timeframe` is **not** enum-checked at creation. Emit one of the six values doc 18 allows; anything else silently
  skips the window-plausibility lint (§19.9) and then fails per variant run with `NO_CANDLES`.
- The **earliest** period the engine will run is `2020-01-01T00:00:00Z`. Since 2026-10-09 this **is** checked at
  creation: a `windowSpec.optimizeFrom` before it is `422 INVALID_WINDOW_SPEC`, and so is an `optimizeTo` or `oosTo`
  later than now + 24 h 10 min (§19.7).

---

## 19.4. `searchSpace`

A non-empty array of **dimensions**; each dimension is one axis of the grid. Two shapes, discriminated by `path` vs
`paths`. Having both or neither → `422 INVALID_SEARCH_SPACE`:
`A dimension must have exactly one of 'path' (scalar) or 'paths' (group), got: {…}`.

### 19.4.1. Scalar dimension — `path` + exactly one of `values` / `range`

```json
{ "path": "exit.stopLossAtrMult", "values": [1.0, 1.5, 2.0] }
{ "path": "exit.takeProfitAtrMult", "range": { "from": 1.5, "to": 4.0, "step": 0.5 } }
```

| Field    | Type   | Notes                                       |
| -------- | ------ | ------------------------------------------- |
| `path`   | string | §19.4.4                                     |
| `values` | array  | non-empty; every item a number or a string  |
| `range`  | object | `{from, to, step}`, all numeric             |

Both or neither → `Dimension '<path>' must have exactly one of 'values' or 'range'`. An empty `values` →
`'values' of dimension '<path>' must be a non-empty array`. Cardinality is the number of values.

### 19.4.2. `range` expansion

`from + step·i` in `BigDecimal`, **endpoints inclusive**, emitted while `value <= to`:

- `step > 0` → otherwise `range.step must be > 0, got: X`
- `from <= to` → otherwise `range.from X must be <= range.to Y`
- a missing or non-numeric member → `'range' of dimension '<path>' requires numeric from/to/step`
- values are **integers** iff all three of `from` / `to` / `step` are integral JSON numbers, otherwise doubles:
  `{"from": 1, "to": 3, "step": 1}` → `[1, 2, 3]`; `{"from": 1, "to": 3, "step": 0.5}` → `[1.0, 1.5, 2.0, 2.5, 3.0]`
- BigDecimal rather than accumulated doubles, so `1.0 → 2.0 step 0.25` yields exactly `[1.0, 1.25, 1.5, 1.75, 2.0]` —
  the right endpoint is never lost

A `range` trips the per-dimension cap **while producing its 51st value** (`422 GRID_TOO_LARGE`:
`range of dimension '<path>' expands to more than 50 values`), whereas an explicit `values` array of exactly 50 is
accepted. Effectively both are capped at 50.

### 19.4.3. Group dimension — `paths` + `tuples`

For parameters that must move **together** (a Bollinger `period` and `stdDev`; a matched TP/SL pair):

```json
{
  "paths": [
    "entries[0].conditions.list[1].right.params.period",
    "entries[0].conditions.list[1].right.params.stdDev"
  ],
  "tuples": [[20, 1.5], [20, 2.0], [30, 2.0], [30, 2.5]]
}
```

- `paths` — non-empty array of strings (`'paths' must be a non-empty array of path strings`,
  `'paths' entries must be strings, got: X`)
- `tuples` — non-empty array of arrays; every tuple's arity must equal `paths.length`
  (`Tuple [...] arity does not match 'paths' arity N`)
- A group counts as **one** dimension; its cardinality is the tuple count, not a product

This is the only way to explore correlated parameters without multiplying the grid, and — since two dimensions may not
collide on one node — the only way for a single grid point to set two related nodes coherently.

### 19.4.4. Path notation

Dot-separated object fields with `[i]` array indices. **Not** JSON Pointer, not JSONPath:

```
entries[0].conditions.list[3].params.period
exit.takeProfits[1].priceAtrMult
risk.maxOpenPositions
```

Syntax errors raise `422 INVALID_PARAM_PATH` with the message `Invalid parameter path '<raw>': <detail>`, where
`<detail>` is one of: `path is empty`, `index without a preceding field at offset N`, `unclosed '[' at offset N`,
`non-numeric array index 'X'`, `negative array index N`, `empty segment at offset N`, `unexpected ']' in segment 'X'`,
`trailing '.'`, `expected '.' or '[' after ']' at offset N`. The last one rejects a field glued to an index
(`entries[0]sizePct`): it named the same node as `entries[0].sizePct` under a different string, which let two
dimensions target one node. A path's identity is its parsed form — `entries[0].sizePct` has exactly one spelling.

Beyond syntax, four semantic rules:

1. **The path must resolve in the base config.** Resolution never creates nodes →
   `Path '<path>' does not resolve in the base config` (or the friendlier `MUTEX_FACET_CONFLICT`, §19.4.5).
2. **It must land on a scalar** — a JSON **number or string** →
   `Path '<path>' resolves to a non-scalar node (OBJECT|ARRAY|BOOLEAN|NULL)`.
   Consequence: **booleans are not sweepable** (`applyFunding`, `moveStopToBreakEven`, …), and neither are whole
   objects or arrays.
3. **No two dimensions may target the same node** → `Two dimensions target the same node '<path>'`.
4. **Every value must match the node's JSON type** — numeric node takes numbers, textual node takes strings →
   `422 INVALID_SEARCH_SPACE`: `Value X does not match the type of node '<path>' (NUMBER|STRING)`.
   A textual node is how a categorical sweep is expressed:
   `{ "path": "entries[0].reArmOn", "values": ["ALL_LAYERS_CLOSED", "THIS_LAYER_CLOSED"] }`.

**Prefer `params.*` paths.** When the base config declares a root `params` block (doc 18 §18.2.1), sweep the
parameter, not its usages: `{ "path": "params.atrPeriod", "values": [10, 14, 21] }` is **one** dimension that moves every
`{"$param": "atrPeriod"}` in the config at once. Sweeping the usages instead costs one dimension per usage (or a group,
§19.4.3, that must list every one of them) and the complexity penalty charges each — a variant that changes "the ATR
period" pays `1/totalDims` through `params`, `4/totalDims` through four separate paths. A path that lands **on** a
reference (`exit.atrRef.params.period` when that node is `{"$param": "atrPeriod"}`) is an object, not a leaf, and
fails rule 2. If the base config repeats a number you want to sweep in several places and has no `params`, the right
fix is to rewrite the base config with `params` first.

### 19.4.5. Mutually-exclusive facets

Doc 18 §18.8.1 defines exit facets that cannot coexist, and the root has three exclusive branches. Since a dimension
may only touch nodes that already exist, you can never switch a facet on through the grid — and asking for the missing
half returns a specific error instead of a generic "not found". When the first missing segment is a known facet field
whose counterpart **is** present on the same parent → `422 MUTEX_FACET_CONFLICT`:

```
Path '<path>' targets facet '<field>', which is absent from the base config
  and mutually exclusive with its '<counterpart>'
```

| Field you asked for | Counterpart(s) checked on the same parent |
| ------------------- | ----------------------------------------- |
| `takeProfitPct`     | `takeProfitAtrMult`, `takeProfits`        |
| `takeProfitAtrMult` | `takeProfitPct`, `takeProfits`            |
| `takeProfits`       | `takeProfitPct`, `takeProfitAtrMult`      |
| `stopLossPct`       | `stopLossAtrMult`                         |
| `stopLossAtrMult`   | `stopLossPct`                             |
| `pricePct`          | `priceAtrMult`                            |
| `priceAtrMult`      | `pricePct`                                |
| `entries`           | `entry`, `dca`                            |
| `entry`             | `entries`, `dca`                          |
| `dca`               | `entries`, `entry`                        |

**Read the base config before writing paths.** If it exits on `stopLossAtrMult`, sweep `stopLossAtrMult` — not
`stopLossPct`.

### 19.4.6. What a variant is

A variant is a **delta**, not a config: a flat `path → value` map, applied to a deep copy of the base config at
dispatch and at promotion. Three derived quantities matter:

- **`variantIdx`** — the deterministic ordinal. Under `GRID` it is the mixed-radix odometer ordinal: dimensions in
  **declaration order** are the digits and the **last dimension varies fastest**. Under `RANDOM` the drawn points are
  sorted lexicographically and numbered densely `0 … n-1`. Either way, regenerating the run — including after a
  restart — yields the identical list.
- **`paramValues`** — one entry per path; a group dimension contributes one entry per path in the group.
- **`changedDims`** — how many dimensions were assigned a value that actually **differs from the base config**.
  Numeric comparison, so `20` equals `20.0`. This feeds the complexity penalty (§19.8): a grid point that happens to
  pick a dimension's base value does not count that dimension.

The complexity denominator is the number of `searchSpace` **array elements**, so a group dimension counts once on both
sides of the ratio.

---

## 19.5. `sampling`

```json
{ "sampling": { "strategy": "GRID" } }
{ "sampling": { "strategy": "RANDOM", "samples": 400, "seed": 42 } }
```

| Field      | Type    | Notes                                                                |
| ---------- | ------- | -------------------------------------------------------------------- |
| `strategy` | string  | `"GRID"` (default) \| `"RANDOM"` — **case-sensitive**, exact spelling |
| `samples`  | integer | **required** for RANDOM, integral, `> 0`, `<= 5000`                  |
| `seed`     | integer | **required** for RANDOM, integral; same seed → same variants         |

- Omitting the whole block means `{"strategy":"GRID"}`, and that is what is stored on the run.
- `GRID` enumerates the full cartesian product and is **rejected** when that product exceeds `maxVariants` (§19.6).
- `RANDOM` draws `samples` distinct grid points uniformly, without repetition. If `samples >= gridSize` it degrades to
  the full enumeration and the seed stops mattering — the set *is* the grid.
- Errors (all `422 INVALID_SEARCH_SPACE`): `sampling must be an object`,
  `Unknown sampling strategy 'X' (expected GRID or RANDOM)`, `sampling.samples (integer) is required for RANDOM`,
  `sampling.seed (integer) is required for RANDOM — it makes the sample reproducible`,
  `sampling.samples must be > 0, got: N`.

**There is no Bayesian, TPE, genetic, evolutionary or Hyperband sampler.** GRID and RANDOM are the entire set.

---

## 19.6. Limits and size arithmetic

| Limit                  | Value    | Where it bites                                        |
| ---------------------- | -------- | ----------------------------------------------------- |
| `maxVariants` default  | **500**  | GRID grid size                                        |
| `maxVariants` hard cap | **5000** | the request's own `maxVariants`, and RANDOM `samples` |
| Dimensions per run     | **12**   | `searchSpace.length`                                  |
| Values per dimension   | **50**   | tuple/value count, and `range` expansion              |

Arithmetic, all computed **before** anything is generated:

```
gridSize         = Π (cardinality of each dimension)     # a group counts once, as its tuple count
variantsTotal    = GRID ? gridSize : min(samples, gridSize)
windowsTotal     = number of walk-forward windows (§19.7)
variantRunsTotal = variantsTotal × windowsTotal × 2      # TRAIN + TEST per window
```

`variantRunsTotal` is the real cost of the run and comes back in the `201` so it can be judged before work starts.

Fail-fast order — the first violation is the message returned:

1. `maxVariants` above the hard cap → `maxVariants N exceeds the hard cap of 5000`
2. `searchSpace` not a non-empty array → `searchSpace must be a non-empty array of dimensions`
3. per-dimension parse (shape, `values` / `range`, tuple arity, range expansion)
4. more than 12 dimensions → `N dimensions exceed the limit of 12 per run`
5. a dimension over 50 values → `Dimension [<paths>] has N values, more than the limit of 50`
6. path resolution: duplicates, non-resolving, non-scalar, per-value type match
7. GRID only → `Grid size N exceeds maxVariants M — switch to RANDOM sampling or shrink the search space`
8. RANDOM only → `sampling.samples N exceeds the hard cap of 5000`

**`maxVariants` gates GRID only.** Under `RANDOM` it is never consulted — the sample size is bounded by `samples`
against the 5000 hard cap. So `RANDOM` with `samples: 400` over a 2268-point grid needs no `maxVariants` at all, while
the same grid under `GRID` needs `"maxVariants": 2268` or higher.

Three ways out of `GRID_TOO_LARGE`, in order of preference:

1. switch to `RANDOM` with a `samples` you are willing to pay for (plus a `seed`);
2. drop or coarsen a dimension — halving one axis halves the whole product;
3. raise `maxVariants` (up to 5000), and only when you really intend to run the full grid.

---

## 19.7. `windowSpec`

```json
{
  "mode": "ROLLING",
  "optimizeFrom": "2024-01-01T00:00:00Z",
  "optimizeTo": "2026-01-01T00:00:00Z",
  "trainMonths": 6,
  "testMonths": 2,
  "stepMonths": 2,
  "oosFrom": "2026-01-01T00:00:00Z",
  "oosTo": "2026-07-01T00:00:00Z"
}
```

| Field          | Type    | Required | Constraints                                                           |
| -------------- | ------- | -------- | --------------------------------------------------------------------- |
| `mode`         | string  | no       | `"ROLLING"` (default) \| `"ANCHORED"`, case-insensitive               |
| `optimizeFrom` | string  | yes      | ISO-8601 **instant** (`2024-01-01T00:00:00Z`), not a bare date        |
| `optimizeTo`   | string  | yes      | ISO-8601 instant, after `optimizeFrom`                                |
| `trainMonths`  | integer | yes      | `>= 1`                                                                |
| `testMonths`   | integer | yes      | `>= 1`                                                                |
| `stepMonths`   | integer | yes      | `>= 1`, and `<= testMonths`                                           |
| `oosFrom`      | string  | no       | ISO-8601 instant; both or neither with `oosTo`; `>= optimizeTo`       |
| `oosTo`        | string  | no       | ISO-8601 instant, after `oosFrom`                                     |

`ROLLING` — a fixed-length train window slides with the test window; recent regimes dominate.
`ANCHORED` — train always starts at `optimizeFrom` and only grows.

Layout, in **UTC calendar months** (`plusMonths`, so day-of-month clamps: Jan 31 + 1 month = Feb 28/29):

```
window i:  testFrom = optimizeFrom + trainMonths + i × stepMonths
           testTo   = testFrom + testMonths
           trainFrom = ROLLING ? testFrom − trainMonths : optimizeFrom
           trainTo   = testFrom
windows are emitted while testTo <= optimizeTo
```

The windows are half-open, and the engine reads a period's `to` **inclusively** — so each phase is dispatched with
`to − 1 bar` of the run's timeframe (`WfWindow.inclusiveEnd`): a 1h window `[2024-01-01, 2024-03-01)` is simulated up to
`2024-02-29T23:00:00Z`. TRAIN and TEST of one window, neighbouring TEST slices, and the last TEST slice and the OOS
period therefore share no bar. Warm-up is unaffected: the engine takes it from the bars before `from`.

Every rejection is `422 INVALID_WINDOW_SPEC`:

| Rule                                                        | Message                                                                                              |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| block present and an object                                 | `windowSpec is required`                                                                             |
| known mode                                                  | `windowSpec.mode must be ROLLING or ANCHORED, got 'X'`                                                |
| `optimizeFrom` / `optimizeTo` present                       | `windowSpec.<field> is required`                                                                     |
| parseable instants                                          | `windowSpec.<field> must be an ISO-8601 instant, got 'X'`                                            |
| positive month counts                                       | `windowSpec.<field> must be a positive integer`                                                      |
| `optimizeFrom >= 2020-01-01T00:00:00Z` (creation only)      | `optimizeFrom must not be earlier than 2020-01-01T00:00:00Z — no market data before it`              |
| `optimizeTo <= now + 24h10m` (creation only)                | `optimizeTo must not be later than <instant> (now + 24h)`                                            |
| `oosTo <= now + 24h10m` (creation only)                     | `oosTo must not be later than <instant> (now + 24h)`                                                 |
| `optimizeFrom < optimizeTo`                                 | `optimizeFrom must be before optimizeTo`                                                             |
| `stepMonths <= testMonths` (test slices tile without gaps)  | `stepMonths (N) must not exceed testMonths (M) — test slices must tile the perimeter without gaps`   |
| perimeter `>= trainMonths + testMonths + 3 × stepMonths`    | `optimization perimeter must span at least trainMonths + testMonths + 3 × stepMonths (N months)`     |
| `oosFrom` / `oosTo` set together                            | `oosFrom and oosTo must be set together`                                                             |
| `oosFrom >= optimizeTo`                                     | `oosFrom must be at or after optimizeTo — the OOS period must stay out-of-sample`                    |
| `oosFrom < oosTo`                                           | `oosFrom must be before oosTo`                                                                       |
| at least **4** windows                                      | `windowSpec yields N window(s); at least 4 are required for per-window statistics`                   |

The perimeter rule and the 4-window rule are the same constraint from two directions: satisfying the perimeter
guarantees exactly 4 windows at the minimum, so the 4-window message only appears for specs that fail arithmetic in
some other way.

The three "creation only" rows run when the run is created, before the layout rules; they are not re-checked when the
windows of an already-stored run are recomputed at dispatch, so a run created before 2026-10-09 is not failed by them.

Worked layout — `trainMonths 6, testMonths 2, stepMonths 2`, perimeter 2024-01 … 2026-01 → **9 windows**, test slices
tiling 2024-07 … 2025-12:

```
                2024                      2025
      J F M A M J J A S O N D | J F M A M J J A S O N D
W0    [====train====][test]
W1        [====train====][test]
W2            [====train====][test]
...
W8                                    [====train====][test]
                                                          | 2026 = OOS, never touched by the sweep
```

**OOS is not part of the sweep.** `[oosFrom, oosTo)` is run exactly once, as a full backtest, at promotion (§19.10),
with the same `oosTo − 1 bar` on the wire as every window above.
Omitting the pair is legal — promotion then creates only a strategy version and answers `oosBacktestId: null`. Include
it whenever you intend to promote: it is the only honest final check, and re-tuning against it destroys its value.

---

## 19.8. `scoring`

Fully optional; the server expands it with defaults and stores the **effective** object, which `GET /optimizations/{id}`
echoes back.

```json
{
  "weights": { "profitFactor": 0.25, "sharpe": 0.2, "sortino": 0.15, "maxDrawdown": 0.2, "expectancy": 0.2 },
  "kappa": 0.5,
  "complexityLambda": 0.1,
  "guards": { "minTradesPerWindow": 20, "minProfitFactor": 1.1, "minWindowsPassingPct": 0.7 },
  "topK": 10,
  "plateau": { "topN": 10, "calmarIqrPct": 0.1, "returnSpreadRatio": 2.0, "minSampleSize": 5 }
}
```

Those are exactly the defaults. Merge semantics: `weights`, `guards` and `plateau` are **shallow-merged** over the
defaults (send only the keys you change); `kappa`, `complexityLambda` and `topK` are overwritten when present. Unknown
keys are kept in storage and ignored by the scorer — they are not an error, and they are not a feature.

### 19.8.1. Metrics

Exactly five, all in "higher is better" orientation. The `weights` keys are fixed:

| Key            | Metric                         | Null policy | Meaning of null                                     |
| -------------- | ------------------------------ | ----------- | --------------------------------------------------- |
| `profitFactor` | profit factor                  | **BEST**    | no losing trades — the variant never lost            |
| `sharpe`       | Sharpe ratio                   | **WORST**   | fewer than 2 daily points — not enough data to win   |
| `sortino`      | Sortino ratio                  | **WORST**   | as Sharpe                                            |
| `maxDrawdown`  | max drawdown, entered **negated** | **WORST** | defensive only; the engine's value is never null    |
| `expectancy`   | expected PnL per trade         | **WORST**   | no trades — same logic as Sharpe                     |

No other metric may appear in `weights`, and there is **no `direction` field**: the objective is always this weighted
blend, always maximized.

### 19.8.2. The score

```
norm_w(v, m)  = midrank(v among the window's cohort by m) / (N − 1)      # best = 1; N = 1 → 1.0
S(v, w)       = Σ weight(m) × norm_w(v, m)                               # weights normalized to sum 1
R(v)          = mean_w S(v, w) − κ × std_w S(v, w) − λ × changedDims / totalDims
robustnessScore(v) = max(0, R(v))
```

Fixed implementation choices, all load-bearing:

- **Only TEST windows** feed the score. TRAIN windows exist solely as the reference for the `DEGRADATION` flag.
- **Ties get the midrank** (the group's average rank). Any other rule would make the score depend on traversal order,
  i.e. on `variantIdx`.
- **`std` is population** (divided by `n`): the windows are a complete deterministic enumeration, not a sample.
- **The cohort is survivors only.** `FAILED` and `DISCARDED` variants are removed *before* ranking, which changes the
  survivors' ranks on purpose. **Consequence: `robustnessScore` is comparable only within one run.** Never compare it
  across runs.
- A window a variant has no result for (possible only on a cancelled run) is excluded from that window's ranking and
  from the variant's own mean/std, rather than scored worst.

`totalDims` is the number of `searchSpace` array elements. `complexityLambda: 0` disables the complexity penalty.

Bad `scoring` values are **coerced, not rejected** — there is no 422 here:

- `minWindowsPassingPct` is clamped to `[0, 1]`
- weights `<= 0` are dropped, the rest normalized to sum 1; all-non-positive falls back to the defaults with a warning
- `minTradesPerWindow` and `topK` are read as doubles and truncated to int

### 19.8.3. Guards — hard thresholds, evaluated before scoring

A variant that fails a guard becomes `DISCARDED` with a `discardReason` and leaves the ranking cohort (it is still
visible on the leaderboard with `includeDiscarded=true`).

```
required = max(1, ceil(minWindowsPassingPct × testWindowCount))    # 7 of 9 at the default 0.7
```

| Reason            | Condition                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------ |
| `NO_TEST_WINDOWS` | no test results at all — reachable only on a cancelled run                                                     |
| `TOO_FEW_TRADES`  | fewer than `required` test windows had `tradesCount >= minTradesPerWindow`                                     |
| `PF_BELOW_FLOOR`  | fewer than `required` test windows had `profitFactor >= minProfitFactor` (a **null** PF counts as passing)      |

The thresholds are per-window significance thresholds aggregated by **coverage**, not by minimum: one thin window out
of nine no longer kills a variant. `minWindowsPassingPct: 1.0` restores the old strict behaviour.

Separately, any variant with **any** failed variant run (train or test) becomes `FAILED` and leaves the cohort.

### 19.8.4. Soft flags

They never discard; they mark a survivor for attention.

| Flag          | Condition                                                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `DEGRADATION` | `mean(S over test) / mean(S over train) < 0.5` — top of the train cohort, tail of the test cohort. Overfitting.             |
| `PF_WATCH`    | mean of the non-null test `profitFactor` values `< 1.3`. All-null PF does not raise it — that is the opposite condition.    |
| `LOW_TRADES`  | any test window under `minTradesPerWindow`, **or** average test trades `< 2 × minTradesPerWindow`                          |

Both thresholds are strict `<`: exactly 1.3, or exactly `2 × minTradesPerWindow`, does not flag. `DEGRADATION` is
skipped when there are no train results or the train mean is 0.

### 19.8.5. `plateau` — thresholds of the post-run verdict

These four numbers do **not** touch scoring, ranking or the choice of finalists. They configure the verdict the run
gets *after* ranking (§19.11): "your grid found one strategy at fifteen bet sizes, not fifteen strategies". They sit
inside `scoring` so a run stays self-contained and its verdict is reproducible from stored configuration rather than
from whatever the code defaults to today.

| Key                 | Default | Meaning                                                                            |
| ------------------- | ------- | ----------------------------------------------------------------------------------- |
| `topN`              | `10`    | How many best-by-`robustnessScore` survivors are examined. A plateau is a statement about the top of the grid, not about all of it |
| `calmarIqrPct`      | `0.1`   | "The shape is the same for all of them": `IQR(calmar) < calmarIqrPct × median(calmar)` |
| `returnSpreadRatio` | `2.0`   | "…but the scale differs": `max(returnPct) / min(returnPct) > returnSpreadRatio`      |
| `minSampleSize`     | `5`     | Below this many usable variants the verdict is `INSUFFICIENT_DATA` — an IQR over three points measures noise |

Both conditions must hold for a `PLATEAU` verdict; either alone means nothing. Variants whose average test drawdown
is `0` are dropped from the sample (a drawdown-free variant almost always means one or two trades, and one such point
drags the IQR through any threshold), and a sample whose median calmar is `≤ 0` is never called a plateau — a grid
whose top is unprofitable has no signal to have exhausted.

---

## 19.9. Pre-flight lint

Before a single variant run is dispatched, every **materialized** variant is checked cheaply. Only provable failure
blocks; heuristics warn, because a 422 on a heuristic would be unpassable for a client without the wizard.

| Code                                | Severity                      | Condition                                                                                                                                                     |
| ----------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UNREACHABLE_MIN_TRADES`            | **422, blocks the run**       | **Every** variant's resolved exit (layer exit inherited from the strategy-level `exit`, per doc 18 §18.7.2) declares no take-profit, stop-loss, trailing stop, time exit *or* `signal`, and `risk.maxOpenPositions < guards.minTradesPerWindow` |
| `SIGNAL_ONLY_EXIT_TRADE_CAP`        | warning in the `201`          | Some variant exits by `signal` only (no TP/SL/trailing/time exit) with `risk.maxOpenPositions < minTradesPerWindow`. The signal *might* fire, so it does not block. |
| `IMPLAUSIBLE_MIN_TRADES_FOR_WINDOW` | warning in the `201`          | `minTradesPerWindow × 10 > barsPerTestWindow`, where `barsPerTestWindow = round(testMonths × 30.44 × barsPerDay(timeframe))`                                    |

`barsPerDay`: `1m` 1440, `5m` 288, `15m` 96, `1h` 24, `4h` 6, `1d` 1. An unrecognized `timeframe` skips the check
entirely.

Why `maxOpenPositions` is the trade ceiling: an open position occupies a slot, and once the slots run out the engine
stops opening until the end of the window; whatever is still open is closed on the last bar as `EOD`. An absent
`risk.maxOpenPositions` means **one** position, not unlimited.

What to do about each:

- `UNREACHABLE_MIN_TRADES` — give the config a way out (a take-profit, a stop-loss, a trailing stop, a time exit
  such as `maxHoldingBars`, or an exit `signal`), raise `risk.maxOpenPositions`, or lower
  `guards.minTradesPerWindow`. Sweeping `exit.takeProfitPct` or
  `risk.maxOpenPositions` also lifts the block, since it only fires when *every* variant is hopeless.
- `SIGNAL_ONLY_EXIT_TRADE_CAP` — the run will start, but expect `TOO_FEW_TRADES` discards. Same three remedies.
- `IMPLAUSIBLE_MIN_TRADES_FOR_WINDOW` — lower the guard or widen `windowSpec.testMonths`. Twenty trades per month of
  `1d` candles is not a realistic ask.

---

## 19.10. What happens after the `201`

```json
{
  "optimizationRunId": 7,
  "status": "PENDING",
  "variantsTotal": 450,
  "windowsTotal": 9,
  "variantRunsTotal": 8100,
  "wsChannel": "/ws/notifications?topic=optimization.7",
  "warnings": [{ "code": "SIGNAL_ONLY_EXIT_TRADE_CAP", "message": "…" }]
}
```

Run lifecycle: `PENDING → RUNNING → RANKING → FINALISTS → DONE`, with terminal branches `FAILED` and `CANCELLED`.
`PENDING`, `RUNNING`, `RANKING` and `FINALISTS` count as **active** — they consume one of the two active-run slots and
are the only statuses `cancel` accepts.

Variant statuses: `PENDING` → `RUNNING` → one of `DONE` / `DISCARDED` / `FAILED`.

Asynchronous failure codes (they arrive as `optimization.failed`, never as an HTTP response):

| Code                        | Cause                                                                     |
| --------------------------- | ------------------------------------------------------------------------- |
| `GENERATION_FAILED`         | variant generation blew up after the run row was created                   |
| `TOO_MANY_VARIANT_FAILURES` | more than **20 %** of variant runs failed — usually a data problem         |
| `SCORING_FAILED`            | the ranking pass threw                                                     |

Per-variant-run failures carry their own vocabulary: `NO_CANDLES`, `INSUFFICIENT_HISTORY`, `UNKNOWN_INDICATOR`,
`INVALID_STRATEGY_CONFIG`, `NO_FUNDING_DATA`, `INVALID_LEVERAGE`, `PERIOD_TOO_EARLY`. Cancelling is not a failure: it produces a terminal
`CANCELLED` status and no `optimization.failed` event.

Ranking is the last thing a run does: it marks the top `topK` variants as finalists and the run reaches `DONE`.
Those finalists used to be re-run as full backtests over the whole `[optimizeFrom, optimizeTo)` perimeter; that was
dropped — the runs cost K full backtests each and changed nothing about the leaderboard, which is final the moment
ranking ends. The drilldown returns a variant's whole strategy config instead (`effectiveConfig`), and the
leaderboard offers a one-click copy of it, so a full run is a paste away when you actually want one.

Other endpoints, all under `/api/v1/optimizations` with `X-User-Id` supplied by the gateway:

| Endpoint                                            | Notes                                                                                                          |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `GET /optimizations`                                | `status`, `symbol`, `sort` (`createdAt` default desc, `name`, `status`, `variantsTotal`), `page` (0, clamped `≥ 0`), `size` (20, clamped `[1,100]`); a non-numeric `page`/`size` is `400 VALIDATION_FAILED` |
| `GET /optimizations/{id}`                           | full spec snapshot + progress; the polling source of truth (WS is only a push duplicate)                          |
| `GET /optimizations/{id}/leaderboard`               | `limit` (50, clamped `[1,200]`), `offset`, `sort` (`robustnessScore` default desc, `windowScoreMean`, `windowScoreStd`), `includeDiscarded` (false) |
| `GET /optimizations/{id}/variants/{variantIdx}`     | per-window drilldown                                                                                            |
| `GET /optimizations/{id}/export?format=csv`         | the whole run as a ZIP: `variants.csv`, `windows.csv`, `meta.json`, `README.md`. `format` is optional and only `csv` exists (anything else is `400 INVALID_EXPORT_FORMAT`); allowed from `RANKING` onwards, else `409 RUN_NOT_SCORED` |
| `POST /optimizations/{id}/variants/{idx}/promote`   | `200`; new strategy version + the single OOS backtest                                                            |
| `POST /optimizations/{id}/cancel`                   | active runs only, else `409 RUN_NOT_ACTIVE`                                                                      |
| `DELETE /optimizations/{id}`                        | `204`, terminal runs only, else `409 RUN_NOT_TERMINAL`; OOS (and legacy finalist) backtests survive                |

Unknown `sort` values fall back to the default **silently** on both list and leaderboard.

**Promotion** materializes the variant's config, creates a new version of the source strategy, and starts one full
backtest over `[oosFrom, oosTo)`. It is *resumable, not transactional*: repeating an interrupted call finishes what is
missing, and `409 ALREADY_PROMOTED` comes back only when everything the run's spec called for is done. It requires
`status = DONE` (`409 RUN_NOT_DONE`), a variant in status `DONE` (`422 VARIANT_NOT_PROMOTABLE`) and a source strategy
(`422 NO_SOURCE_STRATEGY`).

---

## 19.11. Reading a finished run

Leaderboard envelope:

```json
{
  "items": [ … ],
  "total": 450, "discarded": 261, "failed": 4, "finalists": 10,
  "discardedByReason": { "TOO_FEW_TRADES": 233, "PF_BELOW_FLOOR": 28 }
}
```

`total` is every variant of the run, not the filtered page; `discarded` / `failed` / `finalists` are its subsets.

| Item field                                                    | Meaning                                                                    |
| ------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `variantIdx`                                                  | the variant's ordinal — the key for the drilldown and for promote           |
| `paramValues`                                                 | the delta: `path → value`                                                  |
| `robustnessScore`, `windowScoreMean`, `windowScoreStd`, `complexityPenalty` | the four parts of §19.8.2                                    |
| `guardFlags`                                                  | `DEGRADATION` / `PF_WATCH` / `LOW_TRADES`                                  |
| `status`, `discardReason`                                     | `DONE` / `DISCARDED` (+ reason) / `FAILED`                                 |
| `isFinalist`                                                  | in the top `topK` by robustness score                                       |
| `isPareto`                                                    | on the Pareto front by `(return ↑, max drawdown ↓, trades ↑)` — see below. Independent of `isFinalist`: the front is not a ranking |
| `finalistBacktestId`, `finalistBacktestStatus`                | legacy — both `null` since finalists stopped being backtested automatically |
| `testAggregates`                                              | means over successful test windows: PF, Sharpe, Sortino, max DD, expectancy, avg trades |

The drilldown (`/variants/{variantIdx}`) adds `baseParamValues` (the same paths' values in the base config — the
"before" side of a param diff; an unresolvable path arrives as `null`), `effectiveConfig` (the variant's whole
strategy config: the base config with its `paramValues` substituted — what the leaderboard's copy button hands you),
`oosBacktestId`, `promotedStrategyVersion`, and a `windows[]` array with full `train` / `test` metrics and the
window score for each.

### Run-level verdicts

`GET /optimizations/{id}` carries, next to the progress counters and the stored spec, three verdicts — five fields —
computed once in the `RANKING` phase. None of them touches `robustnessScore`, `isFinalist` or the choice of winner — they are what is
*said about* the grid, not how it is ranked, which is why adding them left every terminal run's scores untouched.

| Field                             | Values / type                       | What it says                                                                              |
| --------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------- |
| `diagnosis`                       | `NONE` / `PLATEAU` / `INSUFFICIENT_DATA` | The plateau verdict of §19.8.5: `PLATEAU` = the top of the grid is one strategy at different bet sizes |
| `diagnosisDetail`                 | `{sampleSize, calmarMedian, calmarIqr, returnSpreadRatio}` | The numbers behind it — returned for `NONE` too, because "why not a plateau" is as fair a question |
| `paretoDiagnosis`                 | `NONE` / `DEGENERATE` / `INSUFFICIENT_DATA` | The shape of the Pareto front: `DEGENERATE` = all of its points sit on one ray, i.e. the same return/drawdown ratio at different scales |
| `paretoDetail`                    | `{frontSize, ratioMedian, ratioIqr}` | Same, with numbers                                                                        |
| `wfe`                             | number or `null`                    | Walk-forward efficiency: the **median** of `testReturn / trainReturn` across variants        |

Four notes that decide how to read them:

- **The front is built over surviving variants** (status `DONE` with a score), from their means over successful
  **test** windows. It is a set of trade-offs to pick from by hand, not a second ranking — the leaderboard still
  sorts by `robustnessScore`. Fewer than 5 points on it, or fewer than 5 with a defined return/drawdown ratio,
  yields `INSUFFICIENT_DATA`.
- **`DEGENERATE` and `PLATEAU` are the same fact seen from two sides.** A front of fifteen points reads as fifteen
  strategies to choose between; the verdict is what says it is one strategy at fifteen sizes.
- **`wfe` is a median, deliberately not the winner's.** The winner is selected *by* its test result, so its own WFE
  is biased upward by construction. Variants with a non-positive train return are excluded (there was nothing to
  survive), and fewer than 3 usable variants yields `null`. It measures something different from the `DEGRADATION`
  flag: WFE is an absolute ratio of returns, `DEGRADATION` a relative fall between rank cohorts.
- **`null` in any of the five is legitimate** — a run ranked before these existed is never recomputed, since a
  terminal run's stored numbers are immutable. The plateau verdict is the one exception: for a run that predates it,
  it is computed **on read**, from the same stored aggregates.

Diagnosing a run with **zero finalists** — read `discardedByReason` first:

| Dominant reason / flag | What it means                                    | Next run                                                                           |
| ---------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `TOO_FEW_TRADES`       | the strategy trades too rarely for the window     | lower `guards.minTradesPerWindow`, widen `windowSpec.testMonths`, loosen entry conditions, or raise `risk.maxOpenPositions` |
| `PF_BELOW_FLOOR`       | the edge is not there at this threshold           | lower `guards.minProfitFactor` to see the shape, or change the search space — not the same thing as fixing it |
| `NO_TEST_WINDOWS`      | the run was cancelled mid-flight                  | re-run; the leaderboard of a cancelled run is indicative only                        |
| many `FAILED`          | data or config problem, not a strategy problem    | check the variant-run error codes before touching the search space                   |
| `DEGRADATION` on the survivors | train-fit that does not carry to test     | shrink the search space; fewer degrees of freedom, raise `complexityLambda`           |
| `PF_WATCH` on the survivors | technically alive, not worth trusting        | treat the leader as a hypothesis, not a result; check OOS before promoting            |

Remember that `robustnessScore` is cohort-relative: a leader at `0.81` in one run and `0.81` in another say nothing
about each other.

---

## 19.12. Validation checklist

Walk this before emitting. Each line is a real rejection with the code and the message text produced.

**Envelope**

1. `name` present, non-blank, `<= 120` chars — `400 VALIDATION_FAILED`: `Field 'name' <constraint message>`.
2. `exchange`, `marketType`, `symbol`, `timeframe` non-blank; `initialCapital` present and `> 0`;
   `searchSpace` and `windowSpec` present — same `400`.
3. At most 2 active runs for the user — `429 TOO_MANY_ACTIVE_RUNS`: `At most 2 active optimization runs per user`.

**Base config and market**

4. Exactly one of `strategyId` / `baseConfig` — `422 INVALID_BASE_CONFIG`:
   `Exactly one of strategyId / baseConfig must be provided`.
5. The strategy and version exist and are owned — `404 STRATEGY_NOT_FOUND` / `404 STRATEGY_VERSION_NOT_FOUND`.
6. `marketType` is `spot` or `futures` — `422 INVALID_MARKET_TYPE`: `marketType must be 'spot' or 'futures'`.
7. Futures carry `leverage` **and** `marginMode`; spot carries neither — `422 MISSING_FUTURES_PARAMS`
   (`leverage and marginMode are required for futures` / `… are not applicable to spot`).
8. `leverage` in `1..125` — `422 INVALID_LEVERAGE`: `leverage must be between 1 and 125, got N`.

**Windows** (all `422 INVALID_WINDOW_SPEC`, messages in §19.7)

9. Instants parse; month counts positive; `optimizeFrom < optimizeTo`.
10. `stepMonths <= testMonths`.
11. Perimeter `>= trainMonths + testMonths + 3 × stepMonths`, yielding `>= 4` windows.
12. `oosFrom` / `oosTo` set together, `oosFrom >= optimizeTo`, `oosFrom < oosTo`.
13. `optimizeFrom >= 2020-01-01T00:00:00Z`, and `optimizeTo` / `oosTo` not later than now + 24 h 10 min — enforced
    at creation since 2026-10-09 (checked right after the instants parse, before `optimizeFrom < optimizeTo` and
    rules 10–12).

**Search space**

14. Non-empty array; each item an object with exactly one of `path` / `paths`.
15. A scalar dimension has exactly one of `values` / `range`; a group dimension has non-empty `tuples` of matching
    arity.
16. `range` has numeric `from`/`to`/`step`, `step > 0`, `from <= to`.
17. Every path parses (§19.4.4), resolves in the base config, lands on a **number or string**, and is unique across
    dimensions.
18. Every value's JSON type matches its target node — `Value X does not match the type of node '<path>' (…)`.
19. No path targets the absent side of a mutex facet — `422 MUTEX_FACET_CONFLICT` (§19.4.5).
20. `<= 12` dimensions, `<= 50` values per dimension, and — under `GRID` — `gridSize <= maxVariants`;
    under `RANDOM`, `samples <= 5000`. All `422 GRID_TOO_LARGE`.

**Sampling**

21. `strategy` is exactly `"GRID"` or `"RANDOM"`; `RANDOM` carries integral `samples > 0` **and** `seed`.

**Every generated variant**

22. Each materialized config passes doc 18's JSON Schema and business rules — `422 CONFIG_CONFLICT`:
    `Variant N failed strategy validation (culprit dimension: <paths>): <underlying message>`.
    The commonest causes when sweeping: a `takeProfits[]` ladder that stops being **strictly increasing**, a ladder
    `sizePct` sum over 100, `risk.maxOpenPositions` dropping below the layer count or below the DCA grid size, and an
    `*AtrMult` swept into a config whose `exit.atrRef` is absent.
    Validation uses the **run's** instrument, not the base config's: the request's `symbol`/`timeframe` are bound
    onto `instrument` first (`RunInstrument`, doc 18 §18.1), the same thing `POST /backtests` does. So a sweep of a
    strategy authored for `ETHUSDT 15m` but run on `4h`, or on the very instrument one of its `CORR` references
    names, is refused here rather than one variant at a time in the engine.

**Pre-flight**

23. Not every variant is exit-less — `422 UNREACHABLE_MIN_TRADES` (§19.9). Warnings do not block but should be read.

---

## 19.13. Not supported — do not emit

- **No sampler beyond GRID and RANDOM.** No Bayesian/TPE, no genetic or evolutionary search, no Hyperband, no
  successive halving, no early stopping or pruning of unpromising variants.
- **No scale on a `range`.** There is no `logScale`, `scale`, `distribution`, `mean`, `sigma` or `prior`. A range is
  linear `from + step·i`; anything else must be spelled out in `values`.
- **No objective selector and no multi-objective.** There is no `direction`, `objective`, `metric` or `maximize`:
  the objective is the fixed five-metric weighted rank blend, always maximized. The Pareto front of §19.11 is
  **reported**, as a per-variant flag and a verdict on the run, but it cannot be selected as the objective — nothing
  in the request configures it, and it changes no score and no finalist.
- **No metrics in `weights` other than** `profitFactor`, `sharpe`, `sortino`, `maxDrawdown`, `expectancy`. In
  particular there is no `winRate`, `totalReturnPct`, `calmar`, `omega` or custom expression.
- **No boolean, object or array sweeps.** Only number and string leaves.
- **No structural optimization.** You cannot add or remove conditions, entry layers or ladder rungs, switch between
  `entries` / `entry` / `dca`, or turn an exit facet on. Values only.
- **No conditional or dependent dimensions.** Use a group dimension's `tuples` to couple parameters; there is no
  `when`, `if`, or nested space.
- **No constraints block.** Filtering happens after the fact via `guards`; there is no way to exclude grid points up
  front beyond not listing them.
- **No multi-symbol, multi-timeframe or portfolio runs.** One run = one `symbol` + one `timeframe`.
- **No JSON Pointer / JSONPath** in `path`, and no wildcards (`entries[*]`).
- **No `maxVariants` above 5000**, and no per-dimension sampling budget.
- **No walk-forward "winner per window".** Every variant is evaluated on every window; the per-window winner is a UI
  projection of the same data, not a mode.
- **No re-optimization, scheduling or continuation** of an existing run. `cancel` and `DELETE` are the only mutations
  besides `promote`.

---

## 19.14. Worked examples

### 19.14.1. Minimal spot GRID run

Base config: a spot BTCUSDT 1h strategy with one entry layer on `RSI < 15`, `risk.maxOpenPositions: 3` and a scalar
`exit` of `takeProfitPct: 5` / `stopLossPct: 2`.

Grid: `3 × 3 × 5 = 45` variants ≤ 500, so `GRID` is allowed. Windows: `6 / 2 / 2` over 2024-01 … 2026-01 → **9**.
Variant runs: `45 × 9 × 2 = 810`.

```json
{
  "name": "BTC 1h RSI dip — TP/SL sweep",
  "strategyId": 42,
  "exchange": "binance",
  "marketType": "spot",
  "symbol": "BTCUSDT",
  "timeframe": "1h",
  "initialCapital": 10000,
  "searchSpace": [
    { "path": "entries[0].conditions.list[0].value", "values": [10, 15, 20] },
    { "path": "exit.takeProfitPct", "values": [3, 5, 7] },
    { "path": "exit.stopLossPct", "range": { "from": 1, "to": 3, "step": 0.5 } }
  ],
  "sampling": { "strategy": "GRID" },
  "windowSpec": {
    "mode": "ROLLING",
    "optimizeFrom": "2024-01-01T00:00:00Z",
    "optimizeTo": "2026-01-01T00:00:00Z",
    "trainMonths": 6,
    "testMonths": 2,
    "stepMonths": 2
  }
}
```

No `leverage` / `marginMode` / `applyFunding` — this is spot. No `scoring` — the defaults are sensible. No
`maxVariants` — 45 is under 500.

### 19.14.2. Futures RANDOM run with a coupled pair and custom scoring

Base config: the ATR-denominated ETHUSDT 15m strategy of doc 18 §18.13.2 — two layers, `exit.stopLossAtrMult`, a
two-rung `takeProfits[]` ladder in ATR units, `breakEven`, `trailingStop`, one `atrRef`.

Dimension cardinalities: `3 × 4 × 7 × 3 × 3 × 3` = **2268** grid points. That is over the 500 default, so the run uses
`RANDOM` — where `maxVariants` is not consulted at all and `samples` only has to clear the 5000 cap.

Windows: `9 / 3 / 3` over 2023-01 … 2025-07. Perimeter needed: `9 + 3 + 3×3 = 21` months ≤ 30 available. Windows:
`i = 0…6` → **7**. Variant runs: `400 × 7 × 2 = 5600`. OOS is the isolated 2025-07 … 2026-01.

Every ladder combination stays strictly increasing (`{1.0, 1.5, 2.0}` before `{2.5, 3.0, 4.0}`), so no variant trips
`CONFIG_CONFLICT`.

```json
{
  "name": "ETH 15m ATP — ATR levels, BB pair, 7 windows",
  "strategyId": 77,
  "strategyVersion": 3,
  "exchange": "binance",
  "marketType": "futures",
  "symbol": "ETHUSDT",
  "timeframe": "15m",
  "initialCapital": 10000,
  "leverage": 3,
  "marginMode": "ISOLATED",
  "applyFunding": true,
  "searchSpace": [
    { "path": "entries[0].conditions.list[0].left.params.period", "values": [30, 50, 80] },
    {
      "paths": [
        "entries[0].conditions.list[1].right.params.period",
        "entries[0].conditions.list[1].right.params.stdDev"
      ],
      "tuples": [[20, 1.5], [20, 2.0], [30, 2.0], [30, 2.5]]
    },
    { "path": "exit.stopLossAtrMult", "range": { "from": 1.0, "to": 2.5, "step": 0.25 } },
    { "path": "exit.takeProfits[0].priceAtrMult", "values": [1.0, 1.5, 2.0] },
    { "path": "exit.takeProfits[1].priceAtrMult", "values": [2.5, 3.0, 4.0] },
    { "path": "exit.trailingStop.atrMult", "values": [1.0, 1.5, 2.0] }
  ],
  "sampling": { "strategy": "RANDOM", "samples": 400, "seed": 42 },
  "windowSpec": {
    "mode": "ROLLING",
    "optimizeFrom": "2023-01-01T00:00:00Z",
    "optimizeTo": "2025-07-01T00:00:00Z",
    "trainMonths": 9,
    "testMonths": 3,
    "stepMonths": 3,
    "oosFrom": "2025-07-01T00:00:00Z",
    "oosTo": "2026-01-01T00:00:00Z"
  },
  "scoring": {
    "weights": { "profitFactor": 0.3, "sharpe": 0.2, "sortino": 0.1, "maxDrawdown": 0.25, "expectancy": 0.15 },
    "kappa": 0.75,
    "complexityLambda": 0.05,
    "guards": { "minTradesPerWindow": 12, "minProfitFactor": 1.2, "minWindowsPassingPct": 0.6 },
    "topK": 8
  }
}
```

`kappa: 0.75` punishes window-to-window variance harder than the default; `minWindowsPassingPct: 0.6` requires
`max(1, ceil(0.6 × 7)) = 5` of 7 test windows to clear both thresholds.

### 19.14.3. Recovering from `GRID_TOO_LARGE`

Submitting §19.14.2's search space with `{"sampling": {"strategy": "GRID"}}` and no `maxVariants` returns:

```json
{
  "status": 422,
  "error": "GRID_TOO_LARGE",
  "message": "Grid size 2268 exceeds maxVariants 500 — switch to RANDOM sampling or shrink the search space"
}
```

Three fixes, cheapest first:

| Fix                                              | Result                                    | When                                                      |
| ------------------------------------------------ | ----------------------------------------- | ---------------------------------------------------------- |
| `"sampling": {"strategy":"RANDOM","samples":400,"seed":42}` | 400 variants, 5600 variant runs  | default choice — a random 18 % of the grid finds the plateau |
| coarsen `exit.stopLossAtrMult` to `step 0.5` (4 values) and drop `exit.trailingStop.atrMult` | `3×4×4×3×3 = 432` under GRID | when the full grid genuinely matters                        |
| `"maxVariants": 2500`                            | 2268 variants, 31 752 variant runs        | rarely — this is roughly 4× the work of the RANDOM option    |

Note the third row is legal (2268 ≤ the 5000 hard cap) but expensive: cost scales with
`variants × windows × 2`, not with variants alone.

---

## 19.15. Output contract

When asked to produce an optimization run request:

1. Emit **one** JSON object and nothing else — no comments, no trailing commas, no wrapper keys such as
   `{"request": …}`.
2. **Read the base config first.** Every `path` must be traceable to a real scalar leaf in it, and every facet you
   sweep must be the one the config actually uses (§19.4.5).
3. Compute `gridSize` and `variantRunsTotal` before answering, and choose `sampling` / `maxVariants` accordingly
   (§19.6). State the numbers alongside the JSON.
4. Use only the fields, enum values and metric keys defined above. If a requested capability appears in §19.13, say so
   plainly instead of inventing a field.
5. Re-read §19.12 and confirm every applicable line — in particular the perimeter and `stepMonths <= testMonths` rules,
   futures-vs-spot field presence, and the ladder-ordering trap in item 22.
