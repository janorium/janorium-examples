# 22 · Analog Query Reference (LLM-facing)

---

## 22.1. How to use this document

An analog query is **one JSON object**, `POST`ed to `/api/v1/analogs/query`. It does not run a strategy and it does
not predict. It answers one question:

> **What followed bars whose state looked like this one?**

The server reads the chosen features at an **anchor** bar, finds bars in the instrument's own past whose feature
vector was similar (the **neighbourhood**), takes one bar per non-overlapping `H`-bar window (the **episodes**), and
reports what their next `H` bars did — as a **fan** of quantiles in units of ATR, set beside the same fan for random
bars (the **baseline**), with the event-study statistics, a condition that reproduces the neighbourhood (the
**box**), and optionally a **plan** (target, stop, time-stop) run on every episode.

The single load-bearing rule:

> **The answer is a range, not a forecast.** A fan says how wide the future of states like this one has been, and
> `fanWidthRatio` says whether that is any narrower than the future of any bar. Whether the bands mean what they are
> labelled is answered only by a calibration job (§22.17). The track expects the direction to carry no information
> at short horizons; a `pValue` near 0.5 is the normal answer, not a failure of the query.

The response is **synchronous JSON**, sub-second on a warm cache and a few seconds cold. It holds no
permit. Every successful query is **journaled** against
the user and the answer carries `meta.queryId` (§22.17).

Validation is synchronous and fails fast. The layers, in the order a bad request meets them:

| #   | Layer                                                                                      | Failure                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| 0   | `X-User-Id` header (set by the gateway from a JWT)                                         | `401 UNAUTHORIZED`                                                                                                          |
| 1   | Per-user rate limit, bucket `analogs-query`, 30/min (plus the default)                     | `429`                                                                                                                       |
| 2   | JSON parse — including an unknown `marketType` value                                       | `400 VALIDATION_FAILED` `Request body could not be read as JSON`                                                            |
| 3   | Bean validation: `exchange`, `marketType`, `symbol`, `timeframe` not null                  | `400 VALIDATION_FAILED` naming the field                                                                                    |
| 4   | Feature catalog for `(timeframe, marketType)`                                              | `422 VALIDATION_FAILED` for an unsupported timeframe; `502 RESEARCH_UNAVAILABLE` when the preset catalog cannot be read     |
| 5   | `pool`, `scenarios` present                                                                | `422 NOT_SUPPORTED`                                                                                                         |
| 6   | `horizon` required, `≥ 1`, `≤ H_max(timeframe)`                                            | `422 VALIDATION_FAILED`, `422 HORIZON_TOO_LONG`                                                                             |
| 7   | `pctWindow`                                                                                | `422 VALIDATION_FAILED`                                                                                                     |
| 8   | `features[]` — count, keys, duplicates, scales, weights                                    | `422 VALIDATION_FAILED`, `422 UNKNOWN_FEATURE` naming the key                                                               |
| 9   | `weights`, `anchor`                                                                        | `422 VALIDATION_FAILED`; `anchor.mode = STATE` → `422 NOT_SUPPORTED`                                                        |
| 10  | `neighbourhood` — mode, `k`, `maxDistance`, `minEpisodes`, `kernel`, `recencyHalfLifeDays` | `422 VALIDATION_FAILED`                                                                                                     |
| 11  | `gate` — `values` present, family names                                                    | `422 NOT_SUPPORTED`, `422 VALIDATION_FAILED`                                                                                |
| 12  | `costBps`, `costModel`, `resamples`, `plan`                                                | `422 VALIDATION_FAILED`                                                                                                     |
| 13  | Candles from the candle store                                                              | `502 RESEARCH_UNAVAILABLE`, `409 NO_CANDLES`                                                                                |
| 14  | Anchor bar                                                                                 | `422 ANCHOR_OUT_OF_COVERAGE`                                                                                                |

Two things about this table are easy to get wrong. Rule violations the resolver finds are **`422`** with code
`VALIDATION_FAILED`; only a body Jackson cannot bind, or a missing one of the four required fields, is **`400`** with
the same code. And **nothing is empty-answered**: a neighbourhood with no episodes is a `200` carrying `NO_ANALOGS`
(§22.12), not an error.

Before answering, walk the checklist in §22.13.

---

## 22.2. Root object

18 readable fields. Two more are parsed only to be refused (`pool`, `scenarios`, §22.14).

| Field           | Type     | Required | Constraints / default                                                             |
| --------------- | -------- | -------- | --------------------------------------------------------------------------------- |
| `exchange`      | string   | yes      | e.g. `"binance"`                                                                  |
| `marketType`    | string   | yes      | `"spot"` \| `"futures"`                                                           |
| `symbol`        | string   | yes      | raw exchange symbol, upper-case: `"BTCUSDT"`                                      |
| `timeframe`     | string   | yes      | `15m` \| `1h` \| `4h` \| `1d` — §22.3                                             |
| `horizon`       | integer  | **yes**  | `1..H_max(timeframe)`; **no default** — §22.8                                     |
| `features`      | object[] | **yes**  | 2..12 entries; **no default** — §22.4                                             |
| `anchor`        | object   | no       | default `{ "mode": "LATEST" }` — §22.5                                            |
| `pctWindow`     | integer  | no       | default by timeframe (§22.3); range `50..20000`                                   |
| `weights`       | string   | no       | `"CLUSTERED"` (default) \| `"RAW"` — §22.4                                        |
| `history`       | object   | no       | `{ "from": ISO instant }`; omit for "as far back as the candles go" — §22.6       |
| `neighbourhood` | object   | no       | default `{ "mode": "GATE" }` — §22.7                                              |
| `gate`          | object   | no       | `{ "regimes": [...] }`; default under `GATE` is both trend and volatility — §22.7 |
| `costBps`       | number   | no       | default `8`, range `0..1000` — §22.8                                              |
| `costModel`     | object   | no       | doc 20 §20.9; absent means `FLAT` — §22.8                                         |
| `plan`          | object   | no       | `{ "side": "LONG"\|"SHORT"\|"BOTH", "grid": false }`; absent ⇒ no plan — §22.9    |
| `resamples`     | integer  | no       | default `200`, range `0..2000` — §22.10                                           |
| `seed`          | integer  | no       | default `42` — §22.10                                                             |
| `calibrated`    | boolean  | no       | default `false`; **send `true`** — §22.10                                         |

Minimal legal request — every optional field defaulted:

```json
{
  "exchange": "binance",
  "marketType": "futures",
  "symbol": "BTCUSDT",
  "timeframe": "1h",
  "horizon": 24,
  "features": [{ "key": "ATR_14_PCT" }, { "key": "HV_20" }, { "key": "RVOLUME_20" }, { "key": "CHOP_14" }]
}
```

That anchors at the newest bar, gates candidates by the anchor's `TREND_EMA200` and `VOL_ATR_PCT` labels, reads the
whole candle history, and asks for no plan. It also leaves `calibrated` false, which is the one default worth
overriding (§22.10).

---

## 22.3. Instrument and timeframe

- **`timeframe`** is one of four. Below `15m` a trailing-percentile window stops covering a meaningful stretch of
  market. Anything else → `422 VALIDATION_FAILED` `timeframe 'X' is not supported by the analog lab`.
- **`marketType`** decides whether `funding` exists as a feature and a cost (futures only), and which presets the
  catalog offers. There is no position manager here.
- There is **no period field**. The candidate range runs from `history.from` (or the first cached candle) to
  `anchor − H` — the last bar whose full forward path is known (§22.6).

The per-timeframe constants. Neither is a request field except through `pctWindow`, and changing `pctWindow` changes
what every `TRAILING_PCT` coordinate means:

| Timeframe | `pctWindow` default (`W`) | `H_max`      | Default horizon the frontend offers |
| --------- | ------------------------- | ------------ | ----------------------------------- |
| `15m`     | 2000 (≈ 3 weeks)          | 96 (a day)   | 96                                  |
| `1h`      | 1000 (≈ 6 weeks)          | 72 (3 days)  | 24                                  |
| `4h`      | 500 (≈ 3 months)          | 42 (a week)  | 6                                   |
| `1d`      | 250 (≈ a year)            | 30 (a month) | 5                                   |

`H_max` is a statement about how many non-overlapping episodes a history can hold, not about compute. Above it →
`422 HORIZON_TOO_LONG` `horizon N exceeds the maximum of M bars on TF`.

---

## 22.4. `features` — the state vector

Each entry is `{ "key": string, "scaling"?: string, "weight"?: number }`. Between 2 and 12 entries.

### Where keys come from

`GET /api/v1/analogs/features/catalog?timeframe=1h&marketType=futures` is the authoritative list:

```jsonc
{
  "catalogHash": "3f9a1c0d2b7e4a61",
  "pctWindow": 1000,
  "horizonMax": 72,
  "columns": [
    { "key": "RSI_14", "scalingDefault": "NATIVE", "nativeRange": { "min": 0, "max": 100 }, "group": "indicator", "description": "…", "mtf": true } /* … */,
  ],
  "defaultSet": ["ATR_14_PCT", "HV_20", "RVOLUME_20", "CHOP_14"],
  "patterns": ["SHAPE_CLOSE_<M>", "SHAPE_RANGE_<M>"],
}
```

Do not construct keys by guessing parameters. The catalog is the platform's dataset-export presets plus a
few columns the lab derives itself, so every indicator key is **the same string** as the column of `data.csv` in a
dataset export and as `features[].feature` in a research scan (doc 20 §20.4 "Key naming").

| Kind      | Keys                                                                     | Default scale   | Has a condition form (§22.11 box) |
| --------- | ------------------------------------------------------------------------ | --------------- | --------------------------------- |
| base      | `close`, `open`, `high`, `low`, `volume`, `quote_volume`, `trades_count` | `TRAILING_PCT`  | yes (`CLOSE`, `OPEN`, …)          |
| base      | `funding` (futures only)                                                 | `TRAILING_PCT`  | yes (`FUNDING`)                   |
| calendar  | `hour_utc` `0..23`, `day_of_week` `1..7`, `is_weekend` `0..1`            | `NATIVE`        | **no**                            |
| derived   | `ATR_14_PCT` — ATR(14) / close, always computed                          | `TRAILING_PCT`  | **no**                            |
| indicator | every preset `indicatorKey`: `RSI_14`, `EMA_200`, `MACD_12_26_9_hist`, … | by code, below  | yes                               |
| indicator | `KEY#tf` — a higher-timeframe copy                                       | as the base key | yes, but as a raw level (§22.11)  |
| shape     | `SHAPE_CLOSE_M`, `SHAPE_RANGE_M`, `M` in `4..48`                         | `ZWINDOW` only  | **no**                            |

Resolution rules, each with the message it fails with:

- A key that is neither listed nor a resolvable pattern → `422 UNKNOWN_FEATURE` naming it. **Unknown keys are refused,
  never dropped** — unlike the scan's `indicatorKeys`.
- `KEY#tf` needs the preset to be `mtf: true` (`'EMA_20' has no higher-timeframe copy in the catalog`) and `tf` to be
  a strict higher multiple of the base (`'EMA_200#15m': 15m is not a higher multiple of 1h`).
- `SHAPE_*_M` with `M` outside `4..48` → `a shape window must be between 4 and 48 bars`.
- The same key twice → `'RSI_14' is listed twice`.

### `scaling` — how a column becomes a coordinate

| Scale          | Coordinate                                                                                  | Allowed on                    |
| -------------- | ------------------------------------------------------------------------------------------- | ----------------------------- |
| `NATIVE`       | linear map of the indicator's fixed range onto `[0, 1]` — the same in 2020 and in 2024      | keys with a native range only |
| `TRAILING_PCT` | percentile of the value inside the trailing `pctWindow` bars, `[0, 1]`; looks only backward | every non-shape key           |
| `ZWINDOW`      | the last `M` values, z-normalised inside the window — a shape, not a level                  | `SHAPE_*` keys only           |

The codes with a native range: `RSI`, `MFI`, `CHOP`, `UO`, `BODYPCT`, `UPPERWICK`, `LOWERWICK`, `STOCHRSI`, `ADX`
(all three fields), `CRSI` on `0..100`; `CMO` on `-100..100`; `HHLL` and `SUPERTREND`'s `dir` field on `-1..1`;
`CANDLEPOS`, `TTMSQUEEZE`, the candlestick and figure pulses (`ENGULFING`, `PINBAR`, `DOJI`, `INSIDEBAR`, `HARAMI`, …)
and the calendar pulses (`DAYOFWEEK`, `MONTH`, `WEEKOFYEAR`, `QUARTER`, `MONTHDAY`, `SESSION`, `TIME`, `INTERVAL`) on
`0..1`; plus the three calendar columns. Everything else defaults to `TRAILING_PCT` — a percentile of a series with two
or three values would rank its ties by how common each value was in the window.

- `NATIVE` on a key with no range → `NATIVE needs a fixed range, and this key has none — use TRAILING_PCT`. A dollar
  EMA is not a coordinate; its percentile is.
- A shape with any scale but `ZWINDOW`, or `ZWINDOW` on a non-shape → `422 VALIDATION_FAILED`.
- An unknown scale name → `.scaling must be NATIVE, TRAILING_PCT or ZWINDOW`.
- **Omit `scaling` unless you mean to override.** The answer prints the scale each coordinate was actually read on
  (`anchor.state[].scaling`).

### `weight` and `weights`

- `weight` is in `(0, 100]`, default `1`. The frontend offers `0.25, 0.5, 1, 2, 3` and its schema caps at 10; the
  server accepts up to 100.
- **`weights: "CLUSTERED"`** (default): scalar features whose pairwise rank correlation over the history is
  `|rho| ≥ 0.9` are grouped, and each group gets **one member's worth** of weight in total, split equally — so
  `RSI_7`, `RSI_14` and `RSI_28` together vote once, not three times. Groups appear in `neighbourhood.featureClusters`
  and raise `REDUNDANT_FEATURES`.
- **`weights: "RAW"`** uses the weights as given. Clustering is not computed at all, so `REDUNDANT_FEATURES` cannot
  fire and three smoothings of one indicator dominate the distance. Use it only when that is the intent.
- Final weights are normalised to sum to 1 and printed in `anchor.state[].weight`.
- A shape's `M` coordinates weigh as **one** feature.

### Choosing features

- **Start from `defaultSet`** (`ATR_14_PCT`, `HV_20`, `RVOLUME_20`, `CHOP_14`). ANA-0 measured the volatility set as
  the only one of the three it tried that carried information; a momentum set is a hypothesis the spike did not
  support.
- **Eight or fewer.** At 9 features the answer carries `HIGH_DIMENSION`: in a high-dimensional space every bar is
  roughly as far from the anchor as every other, and "nearest" stops meaning "similar".
- **Different things, not the same thing three ways.** A feature set that clusters is a smaller feature set with
  extra compute.

---

## 22.5. `anchor`

| Form                                             | Anchor bar                                                                  |
| ------------------------------------------------ | --------------------------------------------------------------------------- |
| `{ "mode": "LATEST" }` (default, or omitted)     | the newest bar in the cache — which is not "now" while a backfill is behind |
| `{ "mode": "AT", "ts": "2026-08-14T13:00:00Z" }` | the bar whose open time is **exactly** `ts`                                 |

- `AT` without `ts` → `422 VALIDATION_FAILED` `anchor.ts is required for anchor.mode = AT`.
- `AT` whose `ts` is not a bar open of this instrument → `422 ANCHOR_OUT_OF_COVERAGE`. Align it to the timeframe
  grid: `13:00:00Z` on `1h`, not `13:05:00Z`.
- `AT` inside the **last `H` bars** → `422 ANCHOR_OUT_OF_COVERAGE` `…whose path is not finished yet — use LATEST for
the current bar`. The guard is about intent: a hand-picked recent bar is `LATEST`'s question. It does **not** apply
  to a replay of a journal row (§22.17).
- An anchor at which any feature is still in warmup or undefined → `422 ANCHOR_OUT_OF_COVERAGE`
  `the state vector is undefined at …`. Common with long-window features on a short history.
- `STATE` (an anchor given as feature values rather than a bar) → `422 NOT_SUPPORTED`. Removed by ANA-0.

**A picked `AT` anchor is how an analog query is back-checked by hand.** The candles after it exist, so the frontend
draws what actually happened beside the fan that said what usually does. That is one anecdote; the calibration job
(§22.17) is the same check over hundreds of anchors.

---

## 22.6. `history`

`{ "from": "2021-01-01T00:00:00Z" }` — the earliest bar a candidate may be. There is no `to`: it is always `anchor − H`,
so no candidate's forward path overlaps the anchor's future.

- Omit it to use every cached candle. That is the default and usually right: more history is more episodes.
- A later `from` is **a different answer, not a faster one**. Use it only to exclude a regime you can name (a listing
  period, a pre-2021 market structure) — and say so beside the answer.
- The range actually used comes back as `meta.historyFrom` / `meta.historyTo`.
- `from` is part of the key a stored correction is looked up by: with it set, `calibrated: true` finds only a
  correction calibrated on the same `history.from` (§22.17).

---

## 22.7. `neighbourhood` and `gate`

```jsonc
"neighbourhood": {
  "mode": "GATE",             // UNCONDITIONAL | GATE (default) | KNN
  "k": 300,                   // 30..2000, default 300 — used by KNN
  "maxDistance": null,        // > 0 — KNN only
  "minEpisodes": 30,          // >= 2, default 30 — all modes: below it the answer carries FEW_ANALOGS
  "kernel": "GAUSSIAN",       // GAUSSIAN | UNIFORM — KNN only
  "recencyHalfLifeDays": null // > 0 — KNN only
},
"gate": { "regimes": ["TREND_EMA200", "VOL_ATR_PCT"] }
```

### The three modes

| Mode            | Candidate pool                                        | Episodes                                                              | Weights                |
| --------------- | ----------------------------------------------------- | --------------------------------------------------------------------- | ---------------------- |
| `UNCONDITIONAL` | every valid bar in the history range                  | left to right, one per non-overlapping `H` window                     | all 1                  |
| `GATE`          | bars sharing the anchor's label in every gated family | left to right, one per non-overlapping `H` window                     | all 1                  |
| `KNN`           | the gated pool (or all bars with no gate)             | the `k` nearest by distance, then nearest-first de-duplication by `H` | Gaussian kernel (or 1) |

- **`GATE` is the default and the recommendation.** ANA-0 found that the regime gate alone carries most of what a
  neighbourhood adds over "any bar", at none of kNN's cost in dimensionality. `UNCONDITIONAL` is the baseline to
  compare against; `KNN` is for when the calibration report (`skillVsGate`, §22.17) says it earns its keep.
- `features` still matter under `GATE` and `UNCONDITIONAL`: they define `anchor.state`, the box, and `REDUNDANT_FEATURES`
  — but they do **not** select the episodes. Only `KNN` ranks by distance.
- **`k` is validated in every mode.** An out-of-range `k` under `GATE` is still a `422`; omit it rather than send a
  placeholder.
- **Episodes are never more than `k`** under `KNN`, and usually fewer: of two nearest candidates less than `H` bars
  apart, only the nearer is kept. `neighbourhood.nRaw` is `k`; `nEpisodes` is what survived.
- `maxDistance` cuts the ranked list before de-duplication. It can empty the neighbourhood (`NO_ANALOGS`).
- `kernel: GAUSSIAN` weighs an episode by `exp(−½ (d / h)²)` with `h` the median episode distance (`bandwidth`).
- `recencyHalfLifeDays` multiplies each weight by `2^(−age / halfLife)`. It is a statement that the market changed; it
  also lowers `nEff`.

### `gate.regimes`

The families a candidate must share with the anchor. Labels are **trailing** — known at that bar — so a gated
neighbourhood is expressible as an entry condition.

| Family         | Label at a bar                                         | Values                                        |
| -------------- | ------------------------------------------------------ | --------------------------------------------- |
| `TREND_EMA200` | sign of `EMA_200[i] / EMA_200[i−20] − 1`               | `up`, `down` (exactly flat: none)             |
| `VOL_ATR_PCT`  | percentile of `ATR / close` over the trailing 200 bars | `low` `≤ 0.25`, `mid`, `high` `≥ 0.75`        |
| `TREND_CHOP`   | `CHOP(14)` at its canonical cut points                 | `trending` `< 38.2`, `mid`, `choppy` `> 61.8` |

- Under `GATE`, an absent or empty `regimes` means `["TREND_EMA200", "VOL_ATR_PCT"]`.
- Under `KNN` and `UNCONDITIONAL`, an absent gate gates nothing — but **a named gate is applied in every mode**. Under
  `UNCONDITIONAL` that makes the query a `GATE` query under another name; omit `gate` there (the frontend does).
- An unknown family → `422 VALIDATION_FAILED` naming it and the allowed list. Repeats are collapsed.
- `gate.values` (forcing a label other than the anchor's) → `422 NOT_SUPPORTED`.
- **An anchor with no label in a gated family gates to nothing.** On a history too short for `EMA_200` plus 20 bars,
  `TREND_EMA200` is undefined at the anchor, the pool is empty, and the answer is `NO_ANALOGS` — not a silent
  fallback to no gate. `anchor.regimes` prints `"undefined"` for such a family.
- `GATE_TOO_NARROW` fires when the anchor's regime cell keeps under half of what an average cell of the same gate keeps
  (`gated × cells < 0.5 × candidates`, the cells being the label combinations the candidates occupy). The default
  two-family gate keeps about a sixth of the history on an ordinary anchor and stays quiet; the flag means a rare
  combination.

---

## 22.8. `horizon` and costs

### `horizon`

The number of bars the fan is drawn for and the study is measured at, in bars of `timeframe`. Required, `1..H_max`.

- It is also the **episode spacing**: episodes are at least `H` bars apart. Doubling `H` roughly halves `nEpisodes`.
- The study reports four horizons, derived from it: `{1, round(H/4), round(H/2), H}`, de-duplicated and sorted — so
  `H = 24` yields `[1, 6, 12, 24]` and `H = 2` yields `[1, 2]`. There is no field to choose them.
- The answer's top-level flags and `pAdjusted` are read **at `H`**, the last of those.

### `costBps` and `costModel`

Identical to the research scan (doc 20 §20.9): `costBps` is a round-trip cost in basis points, default 8, `0..1000`;
`costModel` optionally replaces it with a structured taker fee + slippage + funding, charged per horizon. An unknown
`mode` or `assumedSide`, or a fee outside `0..1000`, is refused.

In this lab the cost enters four places:

- `study.byHorizon[].netEdge` — the edge less the round trip.
- **`c`, the cost threshold** — the round trip divided by the anchor's ATR (`costThresholdAtr`). A terminal move
  inside `±c` is `FLAT`; `pUp` is the share of episodes that ended **above `+c`**, not above zero.
- The plan's run (§22.9), charged per episode in that episode's ATR, funding included on futures when `applyFunding`.
- The draft's fees (§22.17).

`meta.costModel` echoes the model **as charged**. As in the scan: **do not send `costBps: 0`.**

---

## 22.9. `plan` — a trade plan, run on the episodes

```json
{ "plan": { "side": "LONG", "grid": false } }
```

Absent means no plan, and that is the default: a plan is a second question about the same neighbourhood. `side` is
`LONG`, `SHORT` or `BOTH` (anything else → `422`); `BOTH` computes the two legs **independently**, because the paths'
distributions are skewed and a mirrored short would quote quantiles no episode produced. `grid: true` adds a 5 × 5
sweep (below).

Per leg, in this order:

1. **Time stop `h*`.** The step at which the net median path (median signed return minus cost) peaks, searched only up
   to the first point where it failed to grow three steps running.
2. **Target** — the weighted **median** favourable excursion at `h*` (half the episodes reached it). **Stop** — the
   weighted **75th percentile** adverse excursion at `h*` (three quarters never touched it). Both in ATR, rounded to
   two significant digits **before** anything is run, so the run is reproducible from the printed levels.
3. **Run.** Every episode is walked bar by bar with levels set in **its own** ATR. A bar touching both levels is a
   stop — the engine's pessimistic rule. Outcome `TP`, `SL`, or `TIME` at `h*`; costs charged per episode.
4. **Interval.** A weighted bootstrap of the mean over episodes, 500 draws, 5th–95th percentile.
5. **Sizing hint.** Quarter-Kelly `E[R] / E[R²]` over every episode's net outcome in units of the stop
   (`R = net / stop`, time exits and costs included), shrunk by `n / (n + 50)`. Its sign is the sign of the expectation,
   so a plan flagged `PLAN_COST_EXCEEDS_EDGE` always reads "no position". **Nothing on the platform reads it.**

If the median episode never traded above the entry within `h*` (or none traded below), there is no target or stop to
name: the leg comes back with `timeStop` and `PLAN_NOT_EXPRESSIBLE`, and no levels, run or sizing.

`grid: true` sweeps targets over the 25/37.5/50/62.5/75th percentiles of favourable excursion and stops over the
50/60/70/80/90th of adverse excursion, and reports the expectation of each pair. **Its best cell is overfitted by
construction** — twenty-five plans on the same episodes always produce a maximum — so every grid carries
`PLAN_GRID_IS_IN_SAMPLE`, and the default plan is the rule above, never the best cell.

**An expectation interval containing zero is the typical result** and is not a defect. The product is measured risk
geometry — where a stop sat that most comparable paths survived, how long moves lasted — not a signal.

---

## 22.10. `resamples`, `seed`, `calibrated`

| Field        | Default | Range     | What it changes                                                                                                                    |
| ------------ | ------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `resamples`  | `200`   | `0..2000` | Rotation draws behind `rotationP` on each study horizon and on `boxStudy`. `0` skips the rotation test; `rotationP` is then absent |
| `seed`       | `42`    | any long  | Fixes the baseline draws, the rotation, the plan bootstrap and the `KNN` looseness sample                                          |
| `calibrated` | `false` | boolean   | Apply the stored conformal correction for this exact question, if one exists                                                       |

- **Send `calibrated: true`.** Without a stored correction it is a no-op; with one, there is no reading of the fan for
  which the raw bands — measured too narrow — are the better answer. The frontend always sends it. When a correction
  is applied the `EMPIRICAL_BANDS` caveat disappears and `fan.calibrationMultipliers` appears (§22.12).
- **Do not change `seed` between queries you intend to compare.**
- `resamples` is the most expensive thing in the answer (~150 ms at 200). `0` is fine for browsing; keep 200 for a
  number you will quote.

---

## 22.11. What the query computes

Enough of the method to read the numbers correctly. Rationale (RU): [analogs/02-similarity.md](./analogs/02-similarity.md),
[03-forward-paths-and-fan.md](./analogs/03-forward-paths-and-fan.md).

### Candidates and episodes

A **candidate** is a bar in `[history.from, anchor − H]` with every feature defined and a complete forward path.
`nCandidatesTotal` counts them; `nCandidatesGated` counts those the gate kept. An **episode** is a candidate accepted
into the neighbourhood with no other episode within `H` bars. Episodes are the sample size — overlapping forward
windows would count one move many times.

### Distance

Weighted Euclidean over the scaled coordinates: `d = √Σ w_c (x_anchor,c − x_bar,c)²`, where scalar coordinates are in
`[0, 1]` and a shape's `M` z-scores share one feature's weight. Only `KNN` ranks by it; the block
`neighbourhood.distance` exists only under `KNN`:

| Field        | Meaning                                                                                                                |
| ------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `min`        | distance to the nearest episode                                                                                        |
| `median`     | median episode distance — also `bandwidth`, the kernel's `h`                                                           |
| `kth`        | distance to the `k`-th nearest candidate, before de-duplication                                                        |
| `random`     | median distance to 512 random candidates                                                                               |
| `looseness`  | `kth / random`. **Above 0.8 the neighbourhood is not closer than chance** → `LOOSE_NEIGHBOURHOOD`                      |
| `nearestP95` | 95th percentile of "distance to one's own nearest candidate" over 64 random candidates. `min` above it → `NOVEL_STATE` |

### `nEff`

Kish's effective size of the kernel weights, `(Σw)² / Σw²`. Equal to `nEpisodes` when weights are uniform; always read
it rather than `nEpisodes` under `KNN`. `pUpCi` is computed on `min(nEpisodes, nEff)`.

### The fan

For each step `i = 1…H`, the seven weighted quantiles `p5, p10, p25, p50, p75, p90, p95` of the episodes' return
`(close[t+i] / close[t] − 1) / ATR%[t]` — **in each episode's own ATR at its own entry**. That is what makes a 2021
episode and a 2025 episode comparable. `fan.price` projects the same quantiles through the **anchor's** close and ATR:
`close_anchor · (1 + q · ATR%_anchor)`.

### The baselines — never optional

A fan without a baseline describes the instrument, not the state.

| Baseline               | What it is                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `baselineFan.atr` (B1) | quantiles of a **random** `H`-spaced sample of the same size from all valid candidates, averaged over 10 draws — "any bar"      |
| `baselineFan.b2`       | normal quantiles from the anchor's EWMA volatility, `√i`-scaled — "a random walk with today's vol"                              |
| `baselineFan.b3`       | as B1, but drawn from candidates sharing the anchor's regime labels — "any bar in this regime". Absent when no such draw exists |

**`fanWidthRatio[i]` = (p95 − p5 of the fan) / (p95 − p5 of B1)** at step `i`. Below 1, the state narrowed the range
of outcomes; around 1, the features bought nothing. It is computed on **raw** quantiles on both sides and is never
touched by the conformal correction — correcting one side of a ratio would improve it for free.

### The study — `study.byHorizon[]`

The research scan's event study (doc 20 §20.10) with the neighbourhood as the event mask, kernel weights applied, and
the unconditional baseline taken over the same candidate range. Returns here are **fractions of price**, not ATR:
`mean: 0.0011` is +0.11%. Per horizon: `nEvents`, `independent`, the conditional distribution, `hitRate` (0…1),
`meanMfe`/`meanMae` over `H`, `baseMean`, `edge`, `netEdge`, `tStat`, `pValue`, `rotationP`, `split` (each half's edge
over `baseMean`, with its count), plus the lab's own direction numbers:

- `pUp` — weighted share of episodes whose terminal return (in ATR) exceeds `+c`; `pUpBase` — the same over B1;
  `pUpCi` — Wilson 90% interval on `min(nEpisodes, nEff)`. **`pUp` inside `[pUpCi]` of `pUpBase` is no direction.**
- `costThresholdAtr` — `c`.

`study.queriesTried` is the number of **distinct feature sets** (keys, scales, weights, mode, `k`, kernel, gate,
horizon, window — not anchor, not seed) this user queried on this instrument in the last 30 days, this one included.
`study.pAdjusted = min(1, pValue at H × queriesTried)`. **Browsing feature sets until a fan looks right is a search, and
`pAdjusted` is its price**: quote it, not `pValue`, whenever `queriesTried > 1`.

### Agreement

At `H`: the weighted shares of episodes ending `up` (`> +c`), `down` (`< −c`) and `flat`; `index = 1 − entropy / ln 3`
(0 for three equal shares, 1 for unanimity); `base` the same index averaged over B1; `lift = index − base`. A positive
`lift` says the neighbourhood agrees with itself more than random bars do — about magnitude class, not necessarily
about sign.

### The box

The neighbourhood rewritten as a `conditionGroup` (doc 18 §18.5) — `AND` of `GTE lo` / `LTE hi` per feature, where
`[lo, hi]` is the weighted **10th–90th percentile** of the episodes' coordinate:

| `bounds[].unit` | When                                                               | Condition reads                                                                        |
| --------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `NATIVE`        | the feature is scaled `NATIVE`                                     | the indicator in its own units — exact                                                 |
| `TRAILING_PCT`  | a percentile feature with a `PCTRANK` form                         | `PCTRANK(window = pctWindow)` of the source, `lo`/`hi` in `0…1` (also `pctLo`/`pctHi`) |
| `RAW_AT_ANCHOR` | a higher-timeframe copy, or a history too short to fill the window | a price-level bound translated at the anchor — approximate → `BOX_USES_RAW_BOUNDS`     |

Shapes, `ATR_14_PCT` and the calendar columns have no condition form and land in `box.unmapped[]`. **The box is
therefore always wider than the neighbourhood**: a rectangle around a cloud, projected onto fewer dimensions.

`boxStudy` is the event study of the box's own mask over the candidate range at `H`, unweighted. Its `nEvents` is the
number to compare a dry-run of a drafted strategy with — **never `nEpisodes`**. The same `box.conditionGroup` sent to
`POST /research/scan` as `event` over the same range reproduces `boxStudy.nEvents`.

---

## 22.12. Reading the answer

`200 application/json`. Top-level keys in reading order:

```jsonc
{
  "formatVersion": 1,
  "flags": [],
  "caveats": [],
  "anchor": {},
  "neighbourhood": {},
  "fan": {},
  "baselineFan": {},
  "fanWidthRatio": [],
  "study": {},
  "agreement": {},
  "box": {},
  "boxStudy": {},
  "plan": {},
  "episodes": [],
  "meta": {},
}
```

`scenarios` is never present (removed by ANA-0; `NO_DISTINCT_SCENARIOS` says so). **Keys are serialised `NON_NULL`:
a block that was not computed is absent, not `null`.**

### When the neighbourhood is empty

With `NO_ANALOGS`, the answer carries only `formatVersion`, `flags`, `caveats`, `anchor`, `neighbourhood` (zeros,
candidate counts, clusters), `episodes: []` and `meta`. `fan`, `baselineFan`, `fanWidthRatio`, `study`, `agreement`,
`box`, `boxStudy` and `plan` are all absent. Loosen the gate, drop `maxDistance`, or lengthen the history.

### `anchor`

| Field             | Meaning                                                                                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`            | `LATEST` or `AT` as requested                                                                                                                                   |
| `ts`              | the bar the answer is about — **the resolved bar**, even under `LATEST`                                                                                         |
| `close`, `atrPct` | the anchor's close and ATR(14) / close as a fraction (`0.0142` = 1.42%)                                                                                         |
| `state[]`         | per feature: `key`, `scaling` as applied, `native` (raw value), `scaled` (coordinate), `shape` (z-scores, shapes only), `weight` (final, normalised), `cluster` |
| `regimes`         | the anchor's label in every gated family plus `TREND_EMA200` and `VOL_ATR_PCT`; `"undefined"` where none                                                        |

### `neighbourhood`

`nEpisodes`, `nEff`, `nRaw` (`k`, KNN only), `nCandidatesTotal`, `nCandidatesGated`, `distance` (KNN only, §22.11),
`bandwidth` (KNN only), `featureClusters[]` (`members`, `rho` = median `|rho|`, `sharedWeight`; groups of two or more
only), `episodesByYear`, `episodesBySymbol`.

### `fan`

`steps` (`1…H`), `quantiles` (`["p5","p10","p25","p50","p75","p90","p95"]`), `atr` (`H × 7`), `price` (`H × 7`), and
`calibrationMultipliers` when a correction was applied:

| Field                      | Meaning                                                                                                          |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `m50`, `m90`               | the multipliers: `p25/p75` scaled by `m50`, `p5/p95` by `m90`, `p10/p90` interpolated, around an unchanged `p50` |
| `coverage50`, `coverage90` | what the bands covered on the journal **before** the correction — the size of the gap it closes                  |
| `regime`                   | the `TREND_EMA200` label whose own multipliers were used, or absent for the un-split row                         |
| `nAnchors`, `jobId`        | how many anchors the fit stood on, and the calibration job it came from                                          |
| `validUntil`, `stale`      | 90 days from the fit; a stale correction is still applied and raises `CALIBRATION_STALE`                         |

`baselineFan` and `fanWidthRatio` are never corrected (§22.11).

### `study`, `agreement`, `box`, `boxStudy`, `plan`

As §22.11 and §22.9. `plan` is `{ sides, long?, short? }` — named legs, never one leg with a switching shape. A leg:

| Field                    | Meaning                                                                                                                                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `side`, `timeStop`       | the side, and `h*` in bars                                                                                                                                                                                                                                   |
| `takeProfit`, `stopLoss` | `{ atr, pct, price }` — one level in three units; `pct` is **percent** of the anchor price, two significant digits                                                                                                                                           |
| `simulation`             | `nEpisodes`, `counts` (`tp`, `sl`, `time` episode counts; `tpShare`, `slShare`, `timeShare` kernel weight), `expectationAtr`, `expectationPct` (**a fraction**, not percent), `expectationCi` (ATR), `payoff`, `meanBars`, `winnerMaeAtr`, `resamples` (500) |
| `sizing`                 | `kelly`, `riskPct` (**a fraction of equity**), `verdict` — the words to quote                                                                                                                                                                                |
| `grid`                   | `takeProfitAtr[5]`, `stopLossAtr[5]`, `expectationAtr[tp][sl]`, `flags` — only with `grid: true`                                                                                                                                                             |
| `flags`                  | `PLAN_NOT_EXPRESSIBLE`, `PLAN_COST_EXCEEDS_EDGE`, `PLAN_GRID_IS_IN_SAMPLE`                                                                                                                                                                                   |

Mind the three unit traps in that table: `takeProfit.pct` is percent, `expectationPct` is a fraction, `riskPct` is a
fraction.

### `episodes[]`

At most 2000. Ordered nearest first under `KNN`, newest first otherwise.

| Field                             | Meaning                                                                           |
| --------------------------------- | --------------------------------------------------------------------------------- |
| `symbol`, `ts`, `year`            | the episode's entry bar                                                           |
| `distance`                        | KNN only                                                                          |
| `weight`                          | kernel weight (1 when uniform)                                                    |
| `terminalAtr`, `mfeAtr`, `maeAtr` | return, max favourable and max adverse excursion at `H`, in the episode's own ATR |
| `outcome`                         | `UP` (`terminalAtr > c`), `DOWN` (`< −c`), `FLAT`                                 |

### `meta`

| Field                       | Meaning                                                                                                     |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `catalogHash`               | digest of the feature catalog the answer was built on — stored with the journal row                         |
| `pctWindow`, `horizonMax`   | as applied                                                                                                  |
| `neighbourhoodMode`, `gate` | the mode, and the gate **as resolved** (the default pair appears here when `gate` was omitted under `GATE`) |
| `costModel`                 | as charged                                                                                                  |
| `seed`, `computeMs`         | as applied; wall time of the request                                                                        |
| `queryId`                   | the journal row id, **a string**                                                                            |
| `excursionSide`             | always `"LONG"`: `meanMfe` is the upside                                                                    |
| `historyFrom`, `historyTo`  | the candidate range actually used; `historyTo` is `anchor − H`, absent when the range is empty              |

### Numbers that cannot be computed

A statistic that has no value is **absent** (records) or `null` (e.g. `payoff` with no losing episode). Inside the
fan matrices, the plan grid and `fanWidthRatio`, which are plain number arrays, an undefined cell may serialise as the
**string** `"NaN"`. Either way it means "not computed" — never zero.

---

## 22.13. Flags and caveats

`flags[]` sits on the answer and changes what the numbers beside it mean. Plan and study flags are also copied up.

| Flag                     | Condition                                                                                   | What to do                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `NO_ANALOGS`             | the neighbourhood is empty                                                                  | §22.12 — loosen the gate, drop `maxDistance`, lengthen `history`        |
| `FEW_ANALOGS`            | `nEpisodes < minEpisodes`                                                                   | read nothing but the counts; the fan is noise                           |
| `GATE_TOO_NARROW`        | the anchor's regime cell kept under half of an average cell of the same gate                | fewer gate families, or accept a thin sample knowingly                  |
| `REDUNDANT_FEATURES`     | two or more features correlate at `                                                         | rho                                                                     | ≥ 0.9` (CLUSTERED only) | drop the duplicates; they were already down-weighted |
| `HIGH_DIMENSION`         | 9 or more features                                                                          | cut to eight or fewer                                                   |
| `LOOSE_NEIGHBOURHOOD`    | KNN: `looseness > 0.8`                                                                      | the "nearest" are not nearer than chance; smaller `k` or fewer features |
| `NOVEL_STATE`            | KNN: the nearest episode is farther than the 95th percentile of nearest-neighbour distances | the market has not been here; the fan describes somewhere else          |
| `ERA_DOMINATED`          | one calendar year holds over 60% of the kernel weight (with more than one year present)     | the answer is about that year                                           |
| `NO_DISTINCT_SCENARIOS`  | always, whenever there are episodes                                                         | informational: scenario clustering was removed                          |
| `BOX_USES_RAW_BOUNDS`    | a box bound is a price level at the anchor                                                  | the box means something else once the market re-levels                  |
| `COST_EXCEEDS_EDGE`      | at `H`: `netEdge ≤ 0`                                                                       | there is no edge after costs                                            |
| `FEW_INDEPENDENT_EVENTS` | at `H`: `independent < 10`                                                                  | the `pValue` stands on almost nothing                                   |
| `SPLIT_DISAGREES`        | at `H`: the two halves of the history have opposite-signed edges                            | the edge is an episode of history, not a relation                       |
| `PLAN_NOT_EXPRESSIBLE`   | a leg has no positive target or stop                                                        | no plan to quote for that side                                          |
| `PLAN_COST_EXCEEDS_EDGE` | a leg's run expectation is `≤ 0` after costs                                                | the plan loses money on its own episodes                                |
| `PLAN_GRID_IS_IN_SAMPLE` | a grid was computed                                                                         | never quote the grid's best cell as the plan                            |
| `CALIBRATION_STALE`      | the applied correction is past `validUntil`                                                 | re-run a calibration job                                                |

`study.byHorizon[].flags` carries the three study flags per horizon; the top-level ones are those at `H`.

`caveats[]` applies to everything in the answer:

| Caveat              | Meaning                                                                                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IN_SAMPLE`         | always: the neighbourhood, the study and the plan are all measured on the history they came from                                                                              |
| `SINGLE_INSTRUMENT` | always: one symbol's past                                                                                                                                                     |
| `EMPIRICAL_BANDS`   | no conformal correction was applied: the 50/90 bands are raw quantiles, which calibration measured as too narrow. Absent exactly when `fan.calibrationMultipliers` is present |

---

## 22.14. Errors

| Code                     | Status | When                                                                                                          |
| ------------------------ | ------ | ------------------------------------------------------------------------------------------------------------- |
| `UNAUTHORIZED`           | 401    | no `X-User-Id`                                                                                                |
| `VALIDATION_FAILED`      | 400    | body is not JSON, a value cannot bind (e.g. `marketType: "perp"`), or one of the four required fields is null |
| `VALIDATION_FAILED`      | 422    | any resolver rule — the message names the field                                                               |
| `UNKNOWN_FEATURE`        | 422    | a key the catalog cannot resolve; the message names it                                                        |
| `NOT_SUPPORTED`          | 422    | `pool`, `scenarios`, `anchor.mode = STATE`, `gate.values`                                                     |
| `HORIZON_TOO_LONG`       | 422    | `horizon > H_max(timeframe)`; the message names the ceiling                                                   |
| `ANCHOR_OUT_OF_COVERAGE` | 422    | `AT.ts` not a bar, in the last `H` bars, or at a bar where the state is undefined                             |
| `NO_CANDLES`             | 409    | `market.candles` holds no rows for the instrument                                                             |
| `RESEARCH_UNAVAILABLE`   | 502    | The candle store or the preset catalog could not be read                                                      |
| —                        | 429    | the `analogs-query` bucket (30/min) or the default bucket                                                     |

`NO_ANALOGS` and `FEW_ANALOGS` are **flags on a `200`**, never errors.

---

## 22.15. Validation checklist

Walk this before answering.

1. The four identity fields present: `exchange`, `marketType` (`spot`|`futures`), `symbol` (upper-case), `timeframe`.
2. `timeframe` is one of `15m 1h 4h 1d`.
3. `horizon` present, integer, `1..H_max`: 96 on `15m`, 72 on `1h`, 42 on `4h`, 30 on `1d`.
4. `features` has 2..12 entries — **8 or fewer** to avoid `HIGH_DIMENSION` — with no repeated key.
5. Every key comes from `GET /analogs/features/catalog` for this timeframe and market, or is `KEY#tf` of an `mtf`
   preset on a strict higher multiple, or `SHAPE_CLOSE_M` / `SHAPE_RANGE_M` with `M` in `4..48`. No `funding` on spot.
6. `scaling` omitted, or: `NATIVE` only on a key with a native range; `ZWINDOW` on shapes and only on shapes.
7. `weight`, if present, in `(0, 100]`.
8. `anchor` omitted or `LATEST`; if `AT`, `ts` is present, aligned to the timeframe grid, and at least `H` bars before
   the newest candle. Never `STATE`.
9. `neighbourhood.mode` one of `UNCONDITIONAL GATE KNN`; `k`, if sent at all, in `30..2000`; `minEpisodes ≥ 2`;
   `maxDistance` and `recencyHalfLifeDays` positive or absent; `kernel` `GAUSSIAN` or `UNIFORM`.
10. `gate.regimes` only from `TREND_EMA200 VOL_ATR_PCT TREND_CHOP`; no `gate` under `UNCONDITIONAL`; never
    `gate.values`.
11. `pctWindow` omitted unless there is a reason, and then in `50..20000`.
12. `costBps` in `0..1000` and not 0 without a reason; `costModel` per doc 20 §20.9 or absent.
13. `plan`, if present, is an object with `side` `LONG`/`SHORT`/`BOTH`; `grid` only when the in-sample sweep is wanted.
14. `resamples` in `0..2000`; `seed` fixed for queries meant to be compared.
15. `calibrated: true`.
16. No `pool`, `scenarios`, `period`, `from`/`to` at the root, `strategyId`, `event` or `indicatorKeys`.
17. When quoting a direction: `pUp` with `pUpCi` against `pUpBase` — and `pAdjusted` whenever `queriesTried > 1`.
18. When quoting the fan: `fanWidthRatio` at `H`, and whether `EMPIRICAL_BANDS` is still in `caveats`.
19. When quoting a count: `nEff` under `KNN`, `nEpisodes` otherwise — never `nCandidatesGated`.
20. When quoting a plan: its `expectationCi`, and say plainly when it contains zero.

---

## 22.16. Not supported — do not emit

- **No `pool`** (querying several symbols' histories at once) → `422 NOT_SUPPORTED`. One instrument's own past.
- **No `scenarios`** (k-medoids scenario clustering) → `422 NOT_SUPPORTED`. ANA-0 found no stable clusters; the answer
  carries `NO_DISTINCT_SCENARIOS` instead.
- **No `anchor.mode = STATE`** (an anchor given as feature values) → `422 NOT_SUPPORTED`.
- **No `gate.values`** (gating on a label other than the anchor's) → `422 NOT_SUPPORTED`.
- **No period and no end of history.** The candidate range always ends at `anchor − H`; move the anchor instead.
- **No choice of study horizons or quantiles.** Horizons are `{1, H/4, H/2, H}`; quantiles are the fixed seven.
- **No feature search.** The lab does not look for the feature set with the best-looking fan — and `queriesTried`
  charges you for doing it by hand.
- **No prediction field.** There is no `signal`, `direction` or `confidence`. `pUp` is a share of the past with an
  interval, and the calibration job is what says whether it is worth anything.
- **No sizing that anything reads.** `plan.*.sizing` is a hint in words.
- **No custom distance, kernel bandwidth, cluster threshold or box percentiles.** Constants, not knobs: `|rho| 0.9`,
  box `p10–p90`, looseness `0.8`, era `60%`, gate-narrow `20%`.
- **No pagination.** `episodes[]` is capped at 2000; everything else is bounded by `H`.

Known differences from [analogs/07-api.md](./analogs/07-api.md), where the code wins:

- `gate` is **not** mandatory under `GATE`: absent means the default pair.
- `NO_CANDLES` is raised for an instrument with no candles at all. A history too short for the features surfaces
  instead as `ANCHOR_OUT_OF_COVERAGE` (state undefined at the anchor) or as `NO_ANALOGS`/`FEW_ANALOGS`.
- The four required identity fields fail as `400`, not `422`.

---

## 22.17. The journal, calibration and the draft

### The journal

Every successful `POST /analogs/query` writes one row; `meta.queryId` is its id.

| Endpoint                                                                         | Answers                                                                                                                                                                          | Bucket          |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `GET /api/v1/analogs/queries?symbol=&marketType=&timeframe=&pinned=&page=&size=` | `{ content, page, size, totalElements, totalPages }`, newest first. `size` `1..100` (default 20), `page` from 0; otherwise `422`. `pinned=true` narrows, `pinned=false` does not | default         |
| `GET /api/v1/analogs/queries/{id}`                                               | `{ query, request, response }` — the stored request and the answer **recomputed**                                                                                                | `analogs-query` |
| `POST` / `DELETE /api/v1/analogs/queries/{id}/pin`                               | the list row                                                                                                                                                                     | default         |
| `PATCH /api/v1/analogs/queries/{id}` `{ "label": "…" }`                          | the list row; `label` ≤ 120 characters (`400`), blank or `null` clears it                                                                                                        | default         |

- **Recomputed, not stored.** The answer is a deterministic function of the request, the anchor bar and the seed.
- **The anchor is pinned to the row's bar** even for a `LATEST` row, so an id always names the same answer; and the
  "last `H` bars" guard does not apply to a replay.
- Opening a row does **not** write a second row and does not raise `queriesTried`.
- A row of another user answers `404 ANALOG_QUERY_NOT_FOUND`, exactly like a missing one.
- A saved `request` pasted back as a new `POST /analogs/query` body is valid as it stands.

### Calibration — whether the bands mean what they say

`POST /api/v1/analogs/calibration` → `202`. Bucket `analogs-calibration`, 3/min; at most two active jobs per user
across scans and calibrations (`429 TOO_MANY_ACTIVE_JOBS`). The body is the query body **minus `anchor`** (present →
`422 VALIDATION_FAILED`), plus:

```jsonc
"evaluation": { "from": "2025-01-01T00:00:00Z", "to": "2026-01-01T00:00:00Z",
                "stride": null, "historyMode": "EXPANDING", "historyBars": null },
"sweep": { "mode": ["UNCONDITIONAL", "GATE", "KNN"], "k": [300] },
"persistCalibration": false
```

- The job anchors at every `stride`-th bar of `[from, to)` and journals the answer at each. `stride` defaults to `H`
  (non-overlapping, honest `n`); below `H` every count is discounted by `stride / H`.
- `from`/`to` required, `to > from`, inside the candle coverage, and holding **at least 100 anchors** — else
  `422 INVALID_EVALUATION_SPEC`. `historyMode: ROLLING` requires `historyBars ≥ 1000` and refuses
  `persistCalibration: true` (interactive queries see the whole history, not a rolling window).
- **Omit `history` in a calibration body.** If you send it, `history.from` must be at least 1000 bars before
  `evaluation.from` (`422 INVALID_EVALUATION_SPEC` otherwise): every anchor's candidates start there, and a later
  start leaves most anchors with no analogs at all. A correction persisted with `history.from` set applies only to
  queries with that same `history.from` — it is part of the key.
- `resamples` defaults to **0** here: no calibration metric reads the rotation `p`.
- `sweep` journals extra neighbourhoods on the same anchors: one cell per mode, per `k` under `KNN`, `k` in
  `30..2000`, at most 12 cells including cell 0 (the request's own).
- `persistCalibration: true` writes conformal multipliers from cell 0 (when ≥ 100 anchors scored), valid 90 days,
  **shared with every user** asking the same question with `calibrated: true`.

Progress, cancel and listing ride `/api/v1/research/jobs/**` (`kind: ANALOG_CALIBRATION`).
`GET /api/v1/analogs/calibration/{jobId}` is the report — only `job` until `DONE`; `…/journal` is the raw rows.

**Read `verdict` first.** Three separate answers:

| `verdict` field | Values and rule                                                                                                                                          |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bands`         | `CALIBRATED` when `coverage90 ∈ [0.85, 0.95]`, `coverage50 ∈ [0.44, 0.56]` and PIT deviation `≤ 0.08`; else `TOO_NARROW`, `TOO_WIDE` or `MISCALIBRATED`  |
| `width`         | `BETTER` when pinball skill vs B1 has `t > 2`; `WORSE` when the skill is negative; else `NEUTRAL`                                                        |
| `direction`     | `OVERCONFIDENT` when the Brier reliability term `> 0.01`; `NONE` when Brier `≥ 0.248` or within 0.002 of climatology; `WEAK` within 0.01; else `PRESENT` |
| `passes`        | bands `CALIBRATED` and width not `WORSE`                                                                                                                 |
| `text`          | one sentence per question — quote it                                                                                                                     |

`direction: NONE` with `passes: true` is the outcome the lab was designed around: calibrated ranges, no promise about
the sign. `skillVsGate` on a `KNN` sweep cell is what the distance ranking adds over the `GATE` cell on the same
anchors — the number that justifies `KNN` or does not.

### The draft — a plan as a strategy config

`POST /api/v1/analogs/queries/{id}/draft` (bucket `analogs-query`):

```json
{ "side": "LONG", "takeProfitAtr": null, "stopLossAtr": null, "target": { "initialCapital": 10000, "leverage": 1, "marginMode": "ISOLATED" } }
```

- **The query is addressed, not sent**: the row is replayed at its anchor and seed with a plan forced on for `side`.
- `side` `LONG` (default) or `SHORT`; `BOTH` → `422 VALIDATION_FAILED` — a draft is one strategy.
- `takeProfitAtr` + `stopLossAtr` together or neither (`422`); giving them picks a grid cell by hand and writes an
  in-sample limitation.
- **Entry is the box, exit is the plan.** No box, no target/stop, or levels that round to 0% → `422 PLAN_NOT_DRAFTABLE`.
- The answer is the research draft's shape — `{ config, provenance, run, limitations[] }` — with `run.from`/`run.to`
  set to the query's candidate range. A dry-run over that range should open about **`boxStudy.nEvents`** positions,
  not `nEpisodes`. Nothing is saved; `POST /strategies` is the caller's step.
- Read `limitations[]` aloud: unmapped coordinates, raw bounds, an expectation interval containing zero, and
  `queriesTried` all appear there.

---

## 22.18. Worked examples

### 22.18.1. The default question — "what usually follows a state like now"

```json
{
  "exchange": "binance",
  "marketType": "futures",
  "symbol": "BTCUSDT",
  "timeframe": "1h",
  "anchor": { "mode": "LATEST" },
  "features": [{ "key": "ATR_14_PCT" }, { "key": "HV_20" }, { "key": "RVOLUME_20" }, { "key": "CHOP_14" }],
  "weights": "CLUSTERED",
  "neighbourhood": { "mode": "GATE", "minEpisodes": 30 },
  "gate": { "regimes": ["TREND_EMA200", "VOL_ATR_PCT"] },
  "horizon": 24,
  "costBps": 8,
  "resamples": 200,
  "seed": 42,
  "calibrated": true
}
```

Six years of `1h` is ~52 000 candidates; the two-family gate keeps a fifth to a half of them, and at `H = 24` a
left-to-right pass leaves a few hundred episodes. Study horizons `[1, 6, 12, 24]`. Expect `IN_SAMPLE`,
`SINGLE_INSTRUMENT`, `NO_DISTINCT_SCENARIOS`, very often `COST_EXCEEDS_EDGE`, and `EMPIRICAL_BANDS` unless this exact
question has been calibrated with `persistCalibration`. Read `fanWidthRatio[23]` first, then `pUp` against `pUpBase`.

### 22.18.2. A historical bar, nearest neighbours, a shape, and a plan on both sides

```json
{
  "exchange": "binance",
  "marketType": "futures",
  "symbol": "ETHUSDT",
  "timeframe": "4h",
  "anchor": { "mode": "AT", "ts": "2025-03-10T08:00:00Z" },
  "features": [{ "key": "RSI_14" }, { "key": "ATR_14_PCT" }, { "key": "funding", "weight": 0.5 }, { "key": "SHAPE_CLOSE_12" }],
  "history": { "from": "2021-01-01T00:00:00Z" },
  "neighbourhood": { "mode": "KNN", "k": 300, "kernel": "GAUSSIAN", "minEpisodes": 30 },
  "horizon": 12,
  "costModel": { "mode": "STRUCTURED", "takerFeeBps": 4, "slippageBps": 2, "applyFunding": true, "assumedSide": "LONG_ONLY" },
  "plan": { "side": "BOTH", "grid": false },
  "resamples": 200,
  "seed": 42,
  "calibrated": true
}
```

`RSI_14` is read `NATIVE`, `ATR_14_PCT` and `funding` `TRAILING_PCT` over 500 bars, the shape `ZWINDOW`. No gate is
named, so under `KNN` none applies. `08:00Z` is on the `4h` grid and the bar is far more than 12 bars old. Study
horizons `[1, 3, 6, 12]`. The box will list `ATR_14_PCT` and `SHAPE_CLOSE_12` in `unmapped` — a strategy drafted from
this enters on `RSI_14` and `funding` alone, so its dry-run should be compared with `boxStudy.nEvents`. Check
`LOOSE_NEIGHBOURHOOD` and `NOVEL_STATE` before reading the fan; the candles after the anchor show what actually
happened.

### 22.18.3. Calibrating the first question, with a sweep

```json
{
  "exchange": "binance",
  "marketType": "futures",
  "symbol": "BTCUSDT",
  "timeframe": "1h",
  "features": [{ "key": "ATR_14_PCT" }, { "key": "HV_20" }, { "key": "RVOLUME_20" }, { "key": "CHOP_14" }],
  "neighbourhood": { "mode": "GATE" },
  "horizon": 24,
  "costBps": 8,
  "seed": 42,
  "evaluation": { "from": "2025-01-01T00:00:00Z", "to": "2026-01-01T00:00:00Z", "stride": null, "historyMode": "EXPANDING" },
  "sweep": { "mode": ["UNCONDITIONAL", "GATE", "KNN"], "k": [300] },
  "persistCalibration": true
}
```

No `anchor`, no `calibrated`, no `resamples` (defaults to 0). A year of `1h` at stride 24 is 365 anchors, above the
floor of 100. Cells: `GATE` (cell 0), `UNCONDITIONAL`, `KNN k=300` — the repeated `GATE` is not journaled twice.
`persistCalibration` makes later `calibrated: true` queries on this exact question use cell 0's multipliers.

---

## 22.19. Output contract

When asked to produce an analog query:

1. Emit **one** JSON object and nothing else — no comments, no trailing commas, no wrapper keys.
2. Use only the fields of §22.2. If a requested capability appears in §22.16, say so plainly instead of inventing a
   field.
3. Always include `horizon` and `features` (they have no defaults) and `calibrated: true`.
4. Never guess a feature key. Take it from `GET /analogs/features/catalog`, or start from its `defaultSet`.
5. State the horizon ceiling for the timeframe, and for an `AT` anchor confirm it is on the grid and at least `H` bars
   old.
6. Re-read §22.15 and confirm every applicable line.

When asked to **interpret an answer**:

1. Read `flags[]` and `caveats[]` first and say what each changes. `NO_ANALOGS`, `FEW_ANALOGS`, `NOVEL_STATE` and
   `LOOSE_NEIGHBOURHOOD` mean the rest of the answer is not worth quoting.
2. Quote the width before the direction: `fanWidthRatio` at `H`, and whether the bands are corrected
   (`EMPIRICAL_BANDS` absent, `calibrationMultipliers` present) or raw.
3. Quote direction only as `pUp` with `pUpCi` beside `pUpBase`, and `pAdjusted` with `queriesTried` — never `pValue`
   alone after several feature sets were tried.
4. Quote `nEff` (KNN) or `nEpisodes` beside every number, and `netEdge`, not `edge`.
5. For a plan: `timeStop`, both levels in ATR and percent, the outcome shares, `expectationCi` — say when it contains
   zero — and the `sizing.verdict` words, not the Kelly number.
6. Treat an absent field, `null` or `"NaN"` as "not computed", never as zero.
7. State the standing caveats: one instrument's past, in-sample, and — unless a calibration report says otherwise — no
   evidence the bands cover what they claim. The honest check is `POST /analogs/calibration`.
