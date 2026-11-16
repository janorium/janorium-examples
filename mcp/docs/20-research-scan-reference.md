# 20 · Research Scan Reference (LLM-facing)

---

## 20.1. How to use this document

A research scan is **one JSON object**, `POST`ed to `/api/v1/research/scan`. It does not run a strategy and it does not
simulate trades. It builds a wide `bar × column` table over one instrument and one period, then answers two questions
over it:

1. **Event study** — given a condition (`event`), what did the market do in the next *N* bars, compared with what it did
   unconditionally? Optional; omit it and the scan runs question 2 alone.
2. **Feature scan** — which of the ~130 columns ordered the future at all, at which horizon, and how much of that
   survives a multiplicity correction?

The single load-bearing rule:

> **The scan reads exactly the table `POST /datasets/export` downloads.** The same body sent to
> `/api/v1/datasets/export` (plus `"includeTargets": true`) returns the CSV every number in the report was computed
> from.

That is a contract, not a coincidence — it is the reason to trust a tool that reports p-values, and it is why the
request is the export's request plus five analysis fields and nothing else. Do not invent a field that only a scan would
have; if it is not in §20.2, the endpoint does not read it.

The response is **synchronous JSON**. There is no polling and no cancel: a scan runs to completion inside the request.

Every scan that succeeds **is** stored, and the response carries a top-level `runId` (§20.17). That buys three things a
report alone does not: `GET /research/runs/{id}` returns it again unchanged, `GET /research/runs/{id}/bundle` renders it
as a ZIP of findings with the methodology beside them, and neither costs an engine permit. Keep the request body beside
any finding you quote all the same — it is what makes the numbers checkable, because the same body sent to
`/api/v1/datasets/export` downloads the table they were computed from.

Validation is synchronous and fails fast. The layers, in the order a bad request meets them:

| #   | Layer                                                | Failure                                                                          |
| --- | ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| 0   | `X-User-Id` header (set by the gateway from a JWT)    | `401 UNAUTHORIZED`                                                               |
| 1   | Per-user rate limit, bucket `research-scan`, 5/min    | `429` — one call holds a global engine permit for its whole duration             |
| 2   | Bean validation on the DTO (the six `@NotNull` fields) | `400 VALIDATION_FAILED`                                                          |
| 3   | Analysis options — `costBps`, `topFindings`, `resamples`, and `event` being an object | `422 INVALID_STRATEGY_CONFIG`                   |
| 4   | `timeframe`, then `profile`                          | `422 INVALID_STRATEGY_CONFIG`                                                    |
| 5   | Period                                               | `422 INVALID_PERIOD`, `422 PERIOD_TOO_EARLY`                                     |
| 6   | `higherTimeframes`, `forwardHorizons`, indicator-key count | `422 INVALID_STRATEGY_CONFIG`                                              |
| 7   | Bar cap, computed from `(to − from) / timeframe`     | `422 DATASET_TOO_LARGE`                                                          |
| 8   | Catalog resolution of `indicatorKeys`                | `422 INVALID_STRATEGY_CONFIG` when nothing resolves                              |
| 9   | Engine permit (2 concurrent dataset builds globally) | `429 DATASET_BUSY` — on a request with nothing wrong with it                     |
| 10  | Candles for the period                               | `404 NO_CANDLES`                                                                 |
| 11  | `event` compiled against the scan's own columns      | `422 UNKNOWN_SERIES` — the message **names** the missing keys                    |
| 12  | Engine transport                                     | `502 RESEARCH_UNAVAILABLE`                                                       |

Engine statuses are **not** collapsed into `502` here, unlike the export, which streams a file and has committed its
response before it could tell them apart. "No candles", "two scans are already running" and "your condition reads a
column you did not include" are three different user actions and arrive as three different codes.

Before answering, walk the checklist in §20.13.

---

## 20.2. Root object

20 fields. Nothing else is read; `includeTargets` in particular is **not a field** (§20.14).

| Field              | Type          | Required | Constraints / default                                                    |
| ------------------ | ------------- | -------- | ------------------------------------------------------------------------ |
| `exchange`         | string        | yes      | `@NotNull`, e.g. `"binance"`; trimmed and lower-cased                    |
| `marketType`       | string        | yes      | `"spot"` \| `"futures"` — case-insensitive in, lower-case out            |
| `symbol`           | string        | yes      | `@NotNull`, raw exchange symbol; trimmed and upper-cased: `BTCUSDT`      |
| `timeframe`        | string        | yes      | one of `1m` `5m` `15m` `1h` `4h` `1d`                                    |
| `from`             | ISO instant   | yes      | `@NotNull`; `>= 2020-01-01T00:00:00Z`, strictly before `to`              |
| `to`               | ISO instant   | yes      | `@NotNull`                                                               |
| `profile`          | string        | no       | `"full"` (default) \| `"compact"` — §20.4                                |
| `indicatorKeys`    | string[]      | no       | omit or empty ⇒ the profile's defaults; at most 250 — §20.4              |
| `higherTimeframes` | string[]      | no       | at most 2, each a strict higher multiple of `timeframe` — §20.5          |
| `forwardHorizons`  | integer[]     | no       | default `[1, 4, 12, 24]`; each `1..500`; de-duplicated and sorted — §20.6 |
| `includeFunding`   | boolean       | no       | futures only, default `true`; ignored on spot — §20.7                    |
| `includeMetrics`   | boolean       | no       | futures only, default `true`; ignored on spot — §20.7                    |
| `event`            | object\|null  | no       | a `conditionGroup` (doc 18 §18.5); omit for the feature sweep alone — §20.8 |
| `costBps`          | number        | no       | default `8`, range `0..1000` — §20.9                                     |
| `topFindings`      | integer       | no       | default `25`, range `0..100` — §20.9                                     |
| `resamples`        | integer       | no       | default `200`, range `1..2000` — §20.9                                   |
| `seed`             | integer       | no       | default `42` — §20.9                                                     |

The first twelve are **field-for-field the `POST /datasets/export` body** ([07-api-contracts.md](./07-api-contracts.md)
§7.5b). The last five are the scan's own.

Minimal legal request — every optional field defaulted:

```json
{
  "exchange": "binance",
  "marketType": "futures",
  "symbol": "BTCUSDT",
  "timeframe": "1h",
  "from": "2023-01-01T00:00:00Z",
  "to": "2024-01-01T00:00:00Z"
}
```

That runs the full profile's ~130 columns against horizons `1, 4, 12, 24`, with no event study.

---

## 20.3. Market, instrument and period

These are the run's own — there is no strategy config here whose `market` block could disagree with them.

- **`marketType`** decides three things: whether `funding` and the four metric columns can exist at all (§20.7), which
  presets the catalog offers (`FUNDING` is dropped on spot), and nothing else. There is no position manager in a scan.
- **`timeframe`** must be one of the six. Anything else → `422 INVALID_STRATEGY_CONFIG`:
  `Unsupported timeframe 'X'; expected one of [1m, 5m, 15m, 1h, 4h, 1d]`.
- **`from` must be before `to`** → `422 INVALID_PERIOD`: `'from' must be before 'to'`.
- **`from` must not precede `2020-01-01T00:00:00Z`** → `422 PERIOD_TOO_EARLY`. That is the earliest period the
  platform stores candles for, shared with dry-run and export.
- The forward tail is read **past `to`**: a horizon of 24 bars needs 24 bars beyond the last row to label it. The
  engine loads them; you do not extend `to` yourself. Rows whose window runs off the end carry an empty label and are
  dropped pairwise by the statistics.

### The bar cap

Checked **before** any candle is loaded, from `(to − from) / timeframe`:

| Profile   | Columns | Bar cap   |
| --------- | ------- | --------- |
| `full`    | ~130    | 150 000   |
| `compact` | ~35     | 500 000   |

Over the cap → `422 DATASET_TOO_LARGE`, and the message names the count, the cap and the `from` that would fit:

```
This range is 412000 bars of 1m; the full profile is capped at 150000.
Start on or after 2025-06-14T00:00:00Z, or pick a coarser timeframe.
```

150 000 bars is 17 years of `1h`, 4 years of `15m`, 17 months of `5m` — it binds on nothing anyone sensibly asks for.
The fix is always a coarser timeframe or a later `from`, never a retry.

### How much period a scan actually needs

Not a validated rule, but the one that decides whether the report says anything. The effective sample size is
`rows / horizon` (§20.10), so a 24-bar horizon over a year of `1h` is ~365 independent observations, not 8760. Below
roughly 30 independent rows a finding is flagged `FEW_INDEPENDENT_ROWS` and should not be read as evidence. Prefer a
year or more of `1h`, or two years of `4h`.

---

## 20.4. `profile` and `indicatorKeys` — choosing the columns

`profile` is not cosmetic. It selects a default preset set, a rounding (8 significant digits vs 6) and the bar cap
above.

- **`full`** (~130 columns) — the search set. Use it unless the period forces `compact`.
- **`compact`** (~35 columns) — the subset that still fits in an LLM context whole, and the profile for very long
  periods on fine timeframes.

`indicatorKeys` overrides the profile's selection entirely: **it is a replacement, not an addition**. Omit it (or send
`[]`) to take the profile's defaults, which is the right choice for an exploratory scan — a hand-picked list is a
hypothesis about where to look, and the feature scan exists precisely because that hypothesis is usually wrong.

Rules:

- At most **250** keys → `422 INVALID_STRATEGY_CONFIG`: `At most 250 indicators can be exported at once; got N`.
- A key that resolves against nothing in the catalog is **silently dropped**. If *none* of them resolve, the request
  fails: `No indicators selected: none of the requested keys resolve against the catalog.`
- The authoritative list for a given `timeframe` + `marketType` is `GET /api/v1/datasets/presets?timeframe=&marketType=`.
  Its `items[].presets[].indicatorKey` values are exactly the strings this field takes. Do not construct keys by
  guessing parameters.

### `crossSymbol.universe` — a point-in-time universe (EDGE-10)

Instead of naming `crossSymbol.symbols`, a job may send
`"universe": { "asOf": "2022-01-01T00:00:00Z", "top": 30, "by": "QUOTEVOL_30D" }` — the symbols that **traded on
`asOf`**, ranked by quote turnover over the 30 days before it on the scan's timeframe, **delisted instruments included**.
Sending both is `422 INVALID_CROSS_SYMBOL_SPEC`; `top` is bounded by the same caps as a named list (12 with lead-lag, 64
without). The universe is resolved once, when the job is created, by the platform (`GET /market/universe`); the
stored job carries its members in `symbols`, so a replay reads the same panel.

The report then drops `SURVIVORSHIP_UNIVERSE`, adds `SYMBOL_DELISTED` when a member has been delisted since, and carries
`crossSymbol.universe = { asOf, top, by, survivorshipFree: true, delisted[] }`. A delisted symbol is simply a series that
ends — it shows up in `meta.coverage` with a partial share. Factors over open interest (`OICHG_24`, `LSRATIO_POSITION`)
make the panel load `market.metrics` for every member; they need the Vision archive loaded for the period.

### `crossSymbol.pooled` — one estimate over every instrument (RES-11)

`crossSymbol` runs three sweeps, and this is the one RES-11 made load-bearing. Omit the flag (or send
`true`) and the panel produces one estimate per `(column, horizon)` over every instrument at once, in
`crossSymbol.panel[]`. Ranks are taken **inside** each symbol and then pooled, so raw scales cannot leak in.

Three things about it are worth knowing before reading a row:

- **The label is market-neutral** — each instrument's forward return minus the panel's mean return on that
  bar — so a finding says the column *picks which instruments outperform the rest*, not that it precedes a
  rise. The `PANEL_MARKET_NEUTRAL` caveat is on every report that carries the block. Pooling raw returns
  was measured and rejected: it values seven instruments at 1.55 and sixty at 1.68, because almost all of
  a crypto panel is one market (docs/research/12-cross-symbol.md §12.11 has the table).
- **There is no `independentPairs` field**, and its absence is deliberate. No way of turning pooled
  observations into a sample size calibrated against a correlated panel; the p-value is a rotation over the
  whole panel instead — one shared circular shift, so the cross-sectional structure survives it. `pairs` is
  published as "how much data went in" and is not a sample size. `meanPairwiseCorrelation` is what a reader
  should look at instead: near `-1/(N-1)` after the demeaning, and near zero or above if the instruments
  really were one market.
- **The family does not grow with the universe.** `meta.panelHypotheses = factors × horizons` whatever the
  size of the basket, corrected in its own BH family. On a real seven-symbol panel that is 4 against the
  same panel's 336 lead-lag hypotheses.

Under four instruments the sweep does not run and says so with `PANEL_POOLED_UNIVERSE_TOO_THIN`: with two,
each symbol's market-neutral label is the exact negative of the other's, so the coefficient is pinned near
zero by arithmetic rather than by evidence.

Each row carries `symbolEffects[]` — every contributing instrument's own coefficient — plus
`agreementShare`, and `PANEL_AGREEMENT_NARROW` flags a pooled effect fewer than 60% of instruments share
the sign of. It is a flag, never a gate: a gate on agreement would be the replication sign vote again under
a new name.

### A narrowed request loads a shorter warmup, and recursive columns notice

The load window is measured from the deepest indicator in the request, so asking for fewer columns starts the loaded
history later. For a stateless column (`RETPCT`, `hour_utc`, an OHLC projection) that changes nothing at all. For a
recursively smoothed one it changes the values: `RSI` is Wilder smoothing seeded from a simple average at the start of
the loaded window, so a recursion begun 200 bars earlier and one begun 14 bars earlier converge without ever being
equal.

Measured on BTCUSDT futures 1h, 2023-01 → 2023-03, full profile against `indicatorKeys: ["RSI_14"]`:

| Row | Difference in `RSI_14` |
| --- | --- |
| 0 | **3.46** |
| 50 | 3.0·10⁻² |
| 100 | 2.7·10⁻⁴ |
| 250+ | 0 — bit-identical |

**What follows from it.** Two exports of the same symbol and window are comparable column-by-column only when they
asked for the same columns; `meta.json` reports `warmupBars`, which is what makes the difference auditable rather
than mysterious. A scan and its export agree by construction, because a scan downloads with its own body.

The one place this was a defect rather than a property was the cross-symbol panel, which narrows its refs internally to
avoid computing a hundred indicators per instrument — and so read a table nobody could download. That is fixed by
`warmupRefs` on the internal request (docs/research/12-cross-symbol.md §12.10): narrow what is computed, keep the
window of the table the request is a subset of.

### Key naming

An `indicatorKey` is the engine's own key, rendered by `IndicatorParams.key`, and it is also the column header in
`data.csv` and the name a finding carries in `features[].feature`:

| Shape                     | Example                | Meaning                                                       |
| ------------------------- | ---------------------- | ------------------------------------------------------------- |
| `CODE_p1_p2…`             | `RSI_14`, `EMA_200`    | params in the catalog's declared order                        |
| `CODE_p1…_field`          | `MACD_12_26_9_hist`    | one output line of a multi-line indicator, field rendered last |
| `CODE_…@SOURCE`           | `SMA_50@ATR_14`        | computed over another series rather than price                 |
| `CODE_…#tf`               | `EMA_200#4h`           | computed on a higher timeframe and carried down (§20.5)        |

The code is always the prefix before the first `_`. Do not split a key on underscores to recover its params —
`MACD_12_26_9_hist` and `SMA_50@ATR_14` do not survive that.

### Columns the table always carries

Beyond the selected indicators, and available to `event` and to the feature scan without being asked for:

| Group      | Columns                                                                       | Notes                                         |
| ---------- | ----------------------------------------------------------------------------- | --------------------------------------------- |
| `time`     | `ts`                                                                          | excluded from the feature scan                |
| `ohlcv`    | `open`, `high`, `low`, `close`, `volume`, `quote_volume`, `trades_count`       | always                                        |
| `calendar` | `hour_utc`, `day_of_week`, `day_of_month`, `is_weekend`                        | always                                        |
| `market`   | `funding`, `oi`, `lsr_account`, `lsr_position`, `taker_ratio`, `oi_value`, `lsr_top_account` | futures only, §20.7                           |
| `target`   | `target__fwd_ret_N`, `target__fwd_mfe_H`, `target__fwd_mae_H`                  | the labels; never features                    |

A ticked `OPEN`/`HIGH`/`LOW`/`CLOSE`/`VOLUME`/`QUOTEVOL`/`TRADES` preset is deliberately excluded from every profile —
it would duplicate a base column verbatim. `CORR`/`BETA`/`RATIO`/`SPREADZ` are excluded structurally: they need a second
instrument, and a scan covers one.

---

## 20.5. `higherTimeframes`

At most two, each a **strict higher multiple** of the base:

```json
{ "timeframe": "1h", "higherTimeframes": ["4h", "1d"] }
```

- Violations → `422 INVALID_STRATEGY_CONFIG`:
  `Higher timeframe 'X' is not a strict higher multiple of the base timeframe 'Y'`, or
  `At most 2 higher timeframes are supported; got N`.
- On a `1d` base there is nothing above it — send `[]` or omit the field.
- Only presets marked `mtf: true` get a higher-timeframe copy — `EMA_50`, `EMA_200`, `RSI_14`, `ATR_14`, `HV_20`,
  `CHOP_14`, `HHLL_3_3`, `RETPCT`. It is a property of the preset, not of the code: a 4h `EMA_200` is a regime filter, a
  4h `EMA_20` is noise seen from further away.
- An `#tf` column holds **the last higher-timeframe bar that CLOSED before this bar opened**. It is forward-filled and
  therefore repeats across the base bars inside one higher bar — which is exactly why its effective sample size is
  smaller than its row count, and why the correction in §20.10 matters more for it, not less.

---

## 20.6. `forwardHorizons`

The forward windows every statistic is computed over, in **bars of the base timeframe**.

- Default `[1, 4, 12, 24]`; on `1h` that reads as "next bar, a third of a session, half a day, a day".
- Each value `1..500` → `422 INVALID_STRATEGY_CONFIG`:
  `Forward horizon must be between 1 and 500 bars; got N`.
- De-duplicated and sorted server-side. Two identical horizons would be the same hypothesis counted twice and would
  inflate the multiplicity correction with a question asked once.
- Emit a **spread**, not one horizon. A signal that appears at 24 bars and not at 1 is a different animal from one that
  appears at both, and a single-horizon scan cannot tell the reader which they have.
- Every horizon multiplies the hypothesis count (`featureColumns × horizons`) and therefore the q-values. Four to six
  is the sensible range; the frontend caps its own input at 8.

**The excursion pair is measured on one horizon only.** `target__fwd_mfe_H` / `target__fwd_mae_H` use `H = 24` when 24
is in the list, otherwise the deepest horizon requested. `meta.excursionHorizon` reports which — an event finding's
`meanMfe`/`meanMae` describe *that* window, not the row's own `horizon`.

---

## 20.7. `includeFunding` and `includeMetrics`

Futures-only, both defaulting to `true`. On spot they are accepted and ignored — the columns do not exist there.

| Flag              | Columns                                          | Source                                        |
| ----------------- | ------------------------------------------------ | --------------------------------------------- |
| `includeFunding`  | `funding`                                        | last **settled** rate as of the bar's open, forward-filled, empty before the first settlement |
| `includeMetrics`  | `oi`, `lsr_account`, `lsr_position`, `taker_ratio`, `oi_value`, `lsr_top_account` | Binance futures metrics, forward-filled onto the bar grid; `taker_ratio` is shifted 15 minutes (stamped at its period's start). Also feeds the `OICHG_*` / `LSRATIO_*` indicator columns (EDGE-10) |

A metric column whose forward-filled coverage is under **1%** of the rows is dropped entirely, and `meta.warnings`
records that it was. This matters when reading the report: Binance serves roughly the **last 30 days** of open interest,
so on a one-year period `oi` covers ~8% of the bars. It is not dropped, it is sparse — its IC is computed on that 8%,
its `independentPairs` collapses accordingly, and it will carry `FEW_INDEPENDENT_ROWS`. Findings on `oi` and `lsr_*`
over long periods are the single most common way to misread this report.

---

## 20.8. `event` — the optional condition

A `conditionGroup`, **the same node a strategy's entry layer carries** (doc 18 §18.5), compiled by the same
`RuleEngine`. That is deliberate and load-bearing: a finding expressed in a research-only dialect would have to be
translated to become a strategy, and every translation is a place where `RSI_14 < 25` in the report and `RSI_14 < 25` in
an entry layer can come to mean different things.

```json
{
  "event": {
    "operator": "AND",
    "conditions": [
      { "indicator": "RSI", "params": { "period": 14 }, "op": "LT", "value": 25 },
      {
        "left": { "indicator": "CLOSE" },
        "op": "GT",
        "right": { "indicator": "EMA", "params": { "period": 200 } }
      }
    ]
  }
}
```

Consequences of it being a real condition node:

- Everything doc 18 §18.5 allows works here: `AND`/`OR`/`NOT` groups, `CROSS_UP`/`CROSS_DOWN`, `BETWEEN`, `compare`
  nodes (`left`/`op`/`right`, indicator vs indicator), `offset`, `holdsFor`, `within`, `defs`. Nothing had to be written
  for the scanner, and nothing is scanner-specific.
- Children go in `list` (doc 18's preferred key) or in `conditions` (the alternative key for the same array; `list`
  wins if both are present). The frontend's picker and every example in the research docs emit `conditions`.
- Must be a **JSON object**, not an array and not a bare condition. Otherwise `422 INVALID_STRATEGY_CONFIG`:
  `event must be a conditionGroup object`. Wrap a single condition in a group of one — that is the shape a second
  condition would be added to.
- `null` is legal and means "no event".

### Which series a condition may read

Only what the scan's own table carries — this is the one real restriction:

1. **Every selected indicator, under its `indicatorKey`.** A compiled node's lookup key and the column name are the
   same string, so `{"indicator": "RSI", "params": {"period": 14}}` finds `RSI_14` with no mapping table. If you did
   not select `RSI_14` (by profile or by hand), the condition cannot read it.
2. **Base-column aliases**, always available: `CLOSE`, `OPEN`, `HIGH`, `LOW`, `VOLUME`, `QUOTEVOL`, `TRADES`, and
   `FUNDING` on futures. So `CLOSE > EMA_200` needs only `EMA_200` to be selected.
3. **Nothing else.** Pseudo-series that describe an open position — `AVG_ENTRY`, `POS_*`, `BARS_IN_TRADE` — are
   rejected: a scan has no position, so there is no honest value to give them.

Anything missing is reported up front as `422 UNKNOWN_SERIES` with the keys named. The fix is to add the key to
`indicatorKeys`, not to rewrite the condition.

### What the event study reports

One finding **per horizon** (so `forwardHorizons.length` findings), each carrying the conditional distribution, the
unconditional baseline over the same horizon, and the difference. All of them get the expensive treatment — there are
only a handful — so `rotationPValue` is present on every event finding that fired at least once.

If the condition never fires, the findings are still returned with `events: 0` and the report adds the caveat
`NO_EVENTS_MATCHED`. That is an answer, not an error.

### `episodes` — the same mask, counted the way a claim is made

`events` counts **bars**: "RSI below 30" holding for twelve days in a row is twelve events. A post saying "higher a month
later in 8 of 9 cases" counts **episodes** — runs of consecutive bars on which the condition held, each dated by its
first bar. Every report with an `event` carries both (absent on a sweep-only scan and on reports saved before
2026-10-16):

```jsonc
"episodes": {
  "count": 9,                 // every episode over the period
  "truncated": false,         // true when `items` keeps fewer than `count`
  "horizons": [7, 30, 90],    // the order of every `returns` list — meta.horizons
  "summary": [ { "horizon": 30, "withReturn": 8, "upPct": 87.5, "median": 0.13, "worst": -0.08, "best": 0.41 } ],
  "items": [ { "ts": "2020-03-13T00:00:00Z", "close": 5000.0, "returns": [0.10, 0.21, null] } ]
}
```

- A return is read off the same forward-return column the study reads — `close[t + h] / close[t] − 1` of the
  episode's **first** bar — so nothing here is a new statistic. `null` where the window runs past the data; such an
  episode is left out of that horizon's `summary` (`withReturn` < `count`).
- `upPct` is a percent, `median`/`worst`/`best` are fractions. `summary` covers **all** episodes; `items` keeps the
  500 most recent.
- **No p-value is computed on episodes.** Quote them as what happened ("up in 8 of 8 dated episodes"), and the event
  finding beside them for whether it beat the baseline.

---

## 20.9. Analysis options

The four fields the export knows nothing about. Each is bounded rather than merely defaulted, because each is a direct
multiplier on engine work — the rotation test runs `resamples` sweeps of the series for each of `topFindings` findings,
and one call holds a global permit for its whole duration.

| Field         | Default | Range    | What it changes                                                                     |
| ------------- | ------- | -------- | ----------------------------------------------------------------------------------- |
| `costBps`     | `8`     | `0..1000` | Round-trip cost subtracted from every edge: `netEdge`, `netDecileSpread`, and the flags `COST_EXCEEDS_EDGE` / `COST_EXCEEDS_SPREAD`. What `costModel: FLAT` charges, and `FLAT` is the default |
| `topFindings` | `25`    | `0..100`  | Size of the shortlist that gets decile profiles and rotation p-values               |
| `resamples`   | `200`   | `1..2000` | Rotation draws; the floor of a rotation p-value is `1 / (1 + resamples)`             |
| `seed`        | `42`    | any long  | Fixes the rotation draws so the report reproduces                                    |

Out of range → `422 INVALID_STRATEGY_CONFIG` naming the field and the value.

Guidance:

- **Do not send `costBps: 0`.** Zero is the number that makes a scan look best and is almost never true. The default 8
  is a taker round trip on Binance USDT-M futures, doubled for entry and exit. Raise it for illiquid symbols, lower it
  only with a maker-only execution plan you can defend.
- **Do not raise `resamples` to buy significance.** More draws lower the floor of a rotation p-value; they do not make
  a finding truer. 200 is enough to separate 0.02 from 0.4, which is the question being asked.
- **Do not change `seed` between runs you intend to compare.** A p-value that moves when nothing else did is a p-value
  the reader cannot check.
- `topFindings: 0` is legal and returns every finding with `deciles`, `decileSpread`, `netDecileSpread`,
  `monotonicity` and `rotationPValue` all absent. Useful only for a fast, cheap sweep. Since RES-8 it also means
  **nothing can be admitted** — step 2 of the gate is unanswerable without a decile spread, so every row comes back
  `admission: SPREAD_NOT_MEASURED`, which is "never priced" rather than "priced and found worthless".

### `costModel` — what the round trip is made of (RES-8)

One flat number is wrong in three independent ways, each of which moves the answer by a multiple rather than a
percent: the horizon (a 24-bar position on USDT-M futures pays funding, a 1-bar one barely does), the turnover (a
finding at h=1 pays the fee twenty-four times as often as one at h=24), and the instrument. `costModel` charges each
finding on **its own horizon** instead.

```jsonc
"costModel": {
  "mode": "STRUCTURED",      // FLAT (default) | STRUCTURED
  "takerFeeBps": 4,          // one-way commission, doubled for the round trip
  "slippageBps": 2,          // one-way, on top
  "applyFunding": true,      // futures: the settlements the forward window actually crosses
  "assumedSide": "SIGN_OF_IC" // SIGN_OF_IC | LONG_ONLY — funding has a sign, so the side is stated
}
```

- **Omit it and nothing changes.** Absent means `FLAT`, which is `costBps` and nothing else, and reproduces every
  number the report produced before this field existed. Do not send `{"mode": "FLAT"}` to mean "default" — it is
  accepted, but an absent key says the same thing and is what a v1 body looks like.
- **`applyFunding` can come back false on a request that set it.** `meta.costModel` echoes what was *charged*: spot
  has no funding rate, and neither does a scan that did not download the column. Read the echo, not the request.
- **Funding is counted by settlements crossed, not by summing the column.** `funding` is the last *settled* rate
  forward-filled onto every bar (§20.7); adding it up over 24 bars of `1h` would charge each of the three
  settlements eight times. It is charged as an expectation per trade, so a one-bar window pays an eighth of a
  settlement rather than nothing.
- An unknown `mode` or `assumedSide` is **refused**, never quietly treated as `FLAT`: a caller who asked for a
  structured model and silently got a v1 report would have nothing in the response to tell them so.

---

## 20.9a. Slice options — reporting the sweep by regime

Three more fields, and they are **off by default**. Omit them and the report is what it always was, but for
`formatVersion: 2`. Ask for them and the whole feature sweep runs again separately inside each slice, which
multiplies the hypothesis count and is corrected as its own family (§20.10).

| Field               | Default         | Range                  | What it changes                                                       |
| ------------------- | --------------- | ---------------------- | --------------------------------------------------------------------- |
| `slices`            | absent          | ≤ 16 total, no repeats | Built-in families to cut the sweep by                                 |
| `customSlices`      | absent          | ≤ 8                    | `{ name, condition }`; `condition` is a `conditionGroup` like `event` |
| `fundingWindowBars` | ~1 hour of bars | `1..500`               | Half-width of the two `FUNDING_WINDOW` windows                        |
| `series`            | absent          | ≤ 16                   | Series by event (doc 18 §18.5.11) → one `series__<name>` column each  |
| `defs`              | absent          | object                 | Named groups for `{"ref"}` inside a `series` `when`                   |

`series` has the shape of a strategy's root `series` block (`VALUEWHEN`/`BARSSINCE`/`COUNT`), computed over the scan
table from its first row. Each becomes a feature column `series__<name>` (group `series`) and is readable from `event`
and `customSlices` as `{"series": "<name>"}`. Its `when`/`take` may read only columns the scan carries and no other
series; a name that collides with an existing column is rejected.

### The built-in families

| Family | Needs | Slices it emits | Notes |
| --- | --- | --- | --- |
| `TREND_CHOP` | a `CHOP*` column | `trending` (`< 38.2`), `choppy` (`> 61.8`) | The indicator's own canonical cut points. The middle band is deliberately unlabelled — it is neither regime. **`CHOP` stays the regime tagger**, for the reason it was chosen: it is directionless by construction and already on a fixed scale, so a threshold transfers between instruments, and it comes with a published cut point on each side. `ADX` is in the catalog since PRO-6b and exports as an ordinary column, but this family does not read it. |
| `TREND_EMA200` | `EMA_200` | `up`, `down` | Slope as a **ratio** over 20 bars (`ema[i]/ema[i-20] - 1`), so it is price-scale invariant. Not `close > EMA_200`, which is a position rather than a trend. No dead band: the single bar whose slope is exactly flat belongs to neither side. |
| `VOL_ATR_PCT` | an `ATR*` column **and** `close` | `low` (`<= 0.25`), `high` (`>= 0.75`) | ATR is normalised by price first, then percentiled over a **trailing** 200 bars — never the full sample, or the regime label would read the future and the finding could not be carried into an entry layer. |
| `SESSION` | `hour_utc` | `asia` `[0,8)`, `europe` `[8,13)`, `us_overlap` `[13,17)`, `us_late` `[17,24)` | Half-open, UTC, exhaustive. Collapses on `1d`, where every bar opens at hour 0, and is skipped. |
| `WEEKEND` | `is_weekend` | `weekend` only | Weekday is the exact complement, so it is already `contrast.complementIc`; emitting both would report one contrast twice with the roles swapped. |
| `FUNDING_SIGN` | `funding` (futures only) | `negative` only | The rare, informative side; positive funding covers most of the period and would be a near-copy of the full sample. Its defined domain excludes bars before the first settlement. |
| `FUNDING_WINDOW` | `ts` | `before`, `after` | Derived from the timestamps alone — settlements are every 8h from an epoch that is itself one. **`funding` is the last SETTLED rate carried forward, not the rate the market is trading into**: this family conditions on timing, not on expected funding. Skipped on `4h` and `1d`. |
| `OI_REGIME` | an `OICHG*` column (futures, `includeMetrics`) | `unwinding` (`<= 1/3`), `building` (`>= 2/3`) | EDGE-10. Open interest change percentiled over a **trailing** 200 bars — the `VOL_ATR_PCT` construction on a flow series; the middle tertile is unlabelled. No condition form, so a finding on it cannot be drafted into a strategy. Needs `market.metrics` history for the period (Vision archive, EDGE-9). |
| `BASIS_SIGN` | a `BASIS` column (futures) | `discount` only | EDGE-9 level 2. Bars where the perpetual traded **below** its index. Only the discount side, for the reason `FUNDING_SIGN` gives — the premium is the ordinary state and its slice would be the full sample again. Drafts into a strategy as `BASIS LT 0`. Needs `market.reference_candles`, which exists only for the symbols `GET /market/features` lists. |

A family whose source column is not in the scan set comes back in `meta.slicesSkipped` with a reason — never
silently dropped. A slice is also skipped when it or its complement holds fewer than 200 bars, or when it
selects everything or nothing. The complement floor is structural rather than fussy: **a slice with no
complement cannot carry the contrast every slice finding is required to carry.**

A custom slice is compiled by the same rule engine an entry layer uses, so a regime that looks promising in
the report is the identical predicate when it reaches a strategy. It may only read series the scan carries;
otherwise `422 UNKNOWN_SERIES`, naming them.

**Its family literal is `CUSTOM`**, so a custom slice keys as `CUSTOM:<name>` everywhere a built-in one keys as
`FAMILY:name` — in `slices[].slice`, in `meta.slices`, in `meta.slicesSkipped`, and in the `slice` column of
`slices.csv` and `deciles.csv`. Its `sliceLabel` is the compiled predicate in words, its `source` names the series the
condition reads, and those series are withheld from its own sweep exactly as a built-in family's source column is. The
condition itself is not repeated per row: `meta.json` `request.customSlices` carries it verbatim.

Guidance:

- **Ask for the families whose columns you actually selected.** `TREND_CHOP` without a `CHOP` key in
  `indicatorKeys` returns a skip, not a slice.
- **Never read a slice q-value against a feature q-value.** Separate families drawn from the same rows —
  that is what `SLICE_SUBSET_OF_FULL_SAMPLE` is warning about.
- **Read `COMPLEMENT_AGREES` before anything else on a slice row.** It means the effect is at least half as
  strong outside the slice: not a regime, just the column.
- **A slice `rotationPValue` answers a different question from a feature one.** It rotates the slice mask
  against untouched data and asks whether the relation is specific to those bars, centred on the column's
  full-sample coefficient rather than on zero.

---

## 20.10. What the scan computes

Enough of the method to read the numbers correctly. Full rationale: [research/02-methodology.md](./research/02-methodology.md).

### Effective sample size — the number that is not the row count

Adjacent rows of `target__fwd_ret_24` share 23 of their 24 forward bars. **Rows are not observations.**

- **Event study**: the largest subset of events whose forward windows do not overlap, taken greedily left to right →
  `independentEvents`. Far-apart events keep their full count; a solid run of consecutive events collapses to
  `span / horizon`.
- **Feature scan**: `rows / horizon` → `independentPairs`.

The feature-scan rule was **chosen by measurement, and the textbook answer lost**. Against a random walk, where 5% of
hypotheses belong under `p < 0.05` by definition:

| Correction                                              | Share of `p < 0.05` |
| ------------------------------------------------------- | ------------------- |
| none                                                    | 44.6 %              |
| Bartlett, both autocorrelations estimated               | 8.7 %               |
| Bartlett, label ACF taken analytically (`1 − k/h`)      | 7.9 %               |
| **rows / horizon**                                      | **5.2 %**           |

Bartlett assumes independent processes; a feature and a forward return are built from one price path and literally share
`close[i]`. No autocorrelation-based correction can see that. Do not "improve" this back to Bartlett.

`pValue` is then the two-sided t-test on the **effective** count, and it is `NaN` when there are fewer than 4
independent observations. A (column × horizon) pair whose IC cannot be computed at all — a constant column, or too few
rows shared with the label — produces no finding rather than a finding full of blanks.

### Multiplicity — Benjamini–Hochberg, in separate families

`qValue` is a false-discovery rate, not a p-value. **A q-value is uninterpretable without the number of hypotheses it
was corrected over**, which is why `meta.eventHypotheses` and `meta.featureHypotheses` are reported separately: the
event study tests a question the user brought, the feature scan sweeps several hundred nobody chose, and correcting them
together would punish the deliberate question for the sweep's multiplicity. Hypotheses that could not be tested carry
`NaN` and are excluded from `m`.

When slices are asked for there is a **third** family, `meta.sliceHypotheses`, corrected once over every
`(column x horizon x slice)` together rather than per slice — correcting each slice on its own would make adding a
slice free while the expected number of false discoveries in the union grew with the slice count. **A slice q-value and
a feature q-value are not comparable**: the two families are corrected separately and are drawn from the same rows,
which is what `SLICE_SUBSET_OF_FULL_SAMPLE` warns about. The overlap discount inside a slice is a greedy
non-overlapping sweep rather than `rows / horizon`, because a slice's rows are not contiguous.

The frontend calls a finding a **discovery** at `q < 0.10`, not 0.05 — the output is a shortlist of hypotheses to test
properly, not a verdict.

### Rotation test — the shortlist's second opinion

The event mask (or the feature's ranks) is rotated circularly against an untouched return series, the statistic is
recomputed `resamples` times, and the observed value is compared with that distribution. Rotation preserves the
dependence **exactly** — the return series is never resampled, so its autocorrelation, volatility clustering and fat
tails stay in place — unlike a block bootstrap, which approximates it and needs a block length nobody can justify. The
minimum shift is the horizon, so rotated windows do not overlap the originals.

`rotationPValue = (1 + exceedances) / (1 + resamples)`, so it can never be 0.

### Decile profile — the cheapest defence there is

For each shortlisted feature finding: 10 **equally populated** buckets (not equally wide — nearly every column here is
fat-tailed), each with its bounds, count, mean forward return and hit rate.

- `monotonicity` — rank correlation between bucket index and bucket mean. Below `|0.6|` the finding is flagged
  `NOT_MONOTONE`. This is the field that separates a real relationship, which climbs across the buckets, from an
  artefact that sits in one of them.
- `decileSpread` — top bucket's mean minus bottom bucket's: **the only number in the report denominated in money**, and
  therefore the only one comparable to a cost. An IC of 0.1 says nothing about whether the move it orders is bigger than
  the spread you pay to trade it.
- `netDecileSpread` = `|decileSpread| − costOfFinding(horizon)`, which under the default `FLAT` model is `costBps/10000` and nothing else. Non-positive → `COST_EXCEEDS_SPREAD`. Also published as `economics.netSpread` (§20.9).
- Buckets thinner than 20 rows are excluded from both — a bucket packed with ties (every 0/1 predicate produces them)
  says nothing about order.

**Read `netDecileSpread` before `qValue`.** On a real BTCUSDT 1h run the scan's most significant finding by far
(`CANDLEPOS` at h=1, `q ≈ 2·10⁻¹⁶`) had a decile spread of 0.041% against an 8 bps round trip: overwhelming and
worthless. Three of four shortlisted discoveries were in that position.

---

## 20.11. Reading the report

`200 application/json`.

```jsonc
{ "meta": { … }, "events": [ … ], "episodes": { … }, "features": [ … ], "slices": [ … ], "pairs": [ … ], "clusters": [ … ], "caveats": [ … ] }
```

`episodes` is present only when the request carried an `event` (§20.8); it is additive and did not move
`meta.formatVersion`.

`slices[]` is empty unless a slice family was asked for, `pairs[]` unless `clusterPairs` was (RES-13, §21.7), and
`clusters[]` is always there since RES-7. **A job's report carries two more**, `crossSymbol` and `crossSymbolHoldout`,
each the whole cross-symbol report of one panel (§12).

### `meta` — what the scan actually did

| Field                                  | Meaning                                                                 |
| -------------------------------------- | ----------------------------------------------------------------------- |
| `formatVersion`                        | `5` since RES-13, which added `pairs[]` and `pairHypotheses`; `4` was RES-8's `economics` and `admission`. Bumped when the shape changes in a way a reader could notice. A job carrying RES-5 transfer blocks reports one higher |
| `generatedAt`                          | ISO instant                                                              |
| `exchange` `marketType` `symbol` `timeframe` `from` `to` | echoed, normalised                                     |
| `bars`                                 | rows actually analysed                                                   |
| `featureHypotheses`                    | **what the correction was computed over**, which is not always the number of tests: with `thresholdGrid` the run declares the nine decile boundaries a draft chooses among and this is `tests × 9` (RES-13, §21.7). The printed count and the count BH used are the same number by construction |
| `pairHypotheses`                       | the pair family's own size (RES-13). `0` when the sweep was not asked for. **Never comparable with `featureHypotheses`**: a different question, corrected apart (§2.4) |
| `featureColumns`                       | non-target, non-time columns — the width of the sweep                    |
| `horizons`                             | as used, sorted                                                          |
| `excursionHorizon`                     | the single horizon `meanMfe`/`meanMae` describe (§20.6)                  |
| `eventHypotheses`, `featureHypotheses` | the `m`s the q-values were corrected over — **quote them beside any q** |
| `sliceHypotheses`                      | the third `m`, `0` when no slicing was asked for. **Not comparable with `featureHypotheses`** |
| `featureClusters`                      | groups of mutually indistinguishable columns at `clusteringThreshold` — the honest denominator beside `featureHypotheses` |
| `effectiveFindings`                    | how many of those groups hold a discovery. **This is the count to state**, not the number of rows with a low `q` |
| `clusteringThreshold`, `clusteringBars` | the `|rho|` at which two columns are called the same thing (a constant, never a request field), and the rows the similarity matrix read. No reported statistic is computed from that sample |
| `costBps`, `resamples`, `seed`         | as applied, defaults resolved                                            |
| `costModel`                            | the cost model **as charged**, not as requested — `applyFunding` reads false where there was no `funding` column to charge (RES-8, §20.9) |
| `expectedSelectionBias`                | how much the best of `featureHypotheses` rows is expected to overstate itself by pure selection, on the scale of `ic`. A disclaimer rather than a correction, and deliberately crude: the hypotheses are not independent, so read it as a ceiling. Deflated Sharpe is **not** used — it is defined for a strategy's Sharpe ratio, and a scan has neither a strategy nor an equity curve |
| `shortlisted`, `sliceShortlisted`      | how many findings of each family got the expensive treatment             |
| `slices`                               | what each analysed slice selected: `family`, `name`, `label`, `source`, `bars`, `sharePct`, `definedBars`, `excludedColumns` |
| `slicesSkipped`                        | every requested slice that could not be built, with `reason` and a `detail` naming the column or number that failed |
| `warnings`                             | columns dropped for sparseness and similar; read them before the tables  |

### `events[]` — one per horizon

| Field                                   | Notes                                                                |
| --------------------------------------- | -------------------------------------------------------------------- |
| `label`                                 | human caption of the condition                                        |
| `horizon`                               | bars                                                                  |
| `events`, `independentEvents`           | fired bars, and the sample size `pValue` was actually computed against |
| `conditional`, `baseline`               | `{count, mean, median, p05, p25, p75, p95, hitRatePct}` — **baseline is never optional**: a conditional mean without an unconditional one describes the year, not a finding |
| `edge`, `netEdge`                       | `edge` = conditional mean − baseline mean. `netEdge` = `sign(edge) · (|edge| − cost)`, the cost being the round trip (`costBps`, or the structured model) plus funding on the side the sign claims. It keeps the sign of `edge`; when the cost exceeds `|edge|` it crosses zero against the claim — read `COST_EXCEEDS_EDGE`, not the sign |
| `meanMfe`, `meanMae`                    | mean favourable / adverse excursion over `meta.excursionHorizon` — a take-profit and a stop, read straight off |
| `tStat`, `pValue`, `rotationPValue`, `qValue` | §20.10                                                          |
| `split`                                 | the same metric on each half of the period, always both               |
| `flags`                                 | §20.12                                                                |

Ordered by horizon.

### `features[]` — one per (column × horizon)

| Field                            | Notes                                                                     |
| -------------------------------- | ------------------------------------------------------------------------- |
| `feature`, `group`, `unit`       | column name, family (`ohlcv`, `calendar`, `market`, `indicator`, `indicator_mtf`), and unit (`price`, `ratio`, `percent`, `count`, `bars`, `signed_flag`, `utc_hour`) |
| `horizon`                        | bars                                                                      |
| `clusterId`                      | the `clusters[]` group this column belongs to. **Count distinct ids, not rows** |
| `clusterRepresentative`          | `true` on the one row per cluster that leads it — the row to quote for its group, and the one the deciles were spent on |
| `ic`                             | Spearman's rho. Small is normal — 0.05 sustained is a serious signal       |
| `pairs`, `independentPairs`      | complete rows, and `pairs / horizon`                                      |
| `pValue`, `rotationPValue`, `qValue` | §20.10                                                                |
| `monotonicity`, `decileSpread`, `netDecileSpread`, `deciles` | **shortlist only**; absent when not computed, never zero |
| `admission`                      | which step of the gate this row cleared or fell at — **the field that explains the order** (RES-8). Since RES-12 the ladder is a **pre-filter**: it decides what deserves an expensive run, while the real verdict is the equity of a backtest over the same window (§21.6) |
| `economics`                      | what it is worth after costs, charged on **this row's horizon**: `grossSpread`, `costTotal`, `netSpread`, `costRatio`, `fundingCost`, `tradesPerYear`, `breakEvenCostBps`, `assumedSide`. Present wherever a decile spread is; **absent, never zeroed**, elsewhere. `netPerYearPct` was removed by RES-12 — the real PnL comes from a backtest now |
| `split`, `flags`                 | as above                                                                  |

### `pairs[]` — two cluster representatives read together (RES-13)

One row per (representative × representative × horizon), corrected over a family of its own. The signal is the
**mean of the two columns' ranks**, each turned to point the way its own single-column coefficient does — ranks
because the whole track is rank-based, the mean because a weight would be a hypothesis nobody priced.

| Field | Notes |
| --- | --- |
| `featureA`, `featureB` | the two cluster representatives. Unordered: a pair is asked once |
| `ic`, `icA`, `icB` | the composite's coefficient, and what each half scored alone at this horizon |
| `lift` | `\|ic\|` minus the better half. **The number that decides whether the row is a finding**: a composite inherits whatever its stronger half had, so `ic` alone cannot separate an interaction from a passenger. `NO_LIFT` flags a pair that did not clear it. Absent when neither half produced a coefficient |
| `pValue`, `rotationPValue`, `qValue` | as for a column finding; the `qValue` is over the **pair family alone** |
| `monotonicity`, `decileSpread`, `netDecileSpread`, `economics` | shortlist only, charged **one** leg — a composite is one position |
| `split`, `flags` | as above |

Ordered by **admission, then rank** (RES-8): rows that cleared all three steps first, ranked by `robustnessScore`
where a job measured one and by `netDecileSpread` otherwise; then the rest, grouped by the step each fell at and
keeping the old `qValue` key inside each group. **Rows that failed are printed, never dropped** — the endpoint still
returns every tested pair (§20.14).

| Step | Rule | `admission` when it fails |
| --- | --- | --- |
| 1 | `qValue < 0.1` | `Q_ABOVE_THRESHOLD` |
| 2 | a decile spread exists at all | `SPREAD_NOT_MEASURED` — **not a failure**: it was never priced, which is what "outside the shortlist" means |
| 2 | `economics.netSpread > 0` | `NET_SPREAD_NOT_POSITIVE` — real, and costs more than it pays |
| 3 | `independentPairs >= 30` | `TOO_FEW_INDEPENDENT_ROWS` |

**Why not `qValue`.** A q-value is the price of believing "there is a relationship"; it answers the statistician's
question, and the reader's is "what do I carry into a backtest". On the real run this endpoint was built against,
sorting by q put a finding with q ≈ 2e-16 and a decile spread of 0.041% against a 0.08% round trip at the top of the
table. The shortlist is still *selected* on the old key (`qValue`, then `|ic|`) and must be: step 2 reads a number
that only the expensive half of the pass computes. Ranking the report and choosing the shortlist are two different
sorts.

### `slices[]` — one per (slice × column × horizon)

Present and empty unless slicing was asked for. Every field `features[]` has, plus the slice it belongs to and the
contrast that makes it readable.

| Field                                     | Notes                                                                |
| ----------------------------------------- | -------------------------------------------------------------------- |
| `slice`, `sliceFamily`, `sliceLabel`      | `family:name`, the family, and the predicate in words — the same key `meta.slices` lists the definition under |
| `clusterId`                               | the same numbering `features[]` uses — column similarity is a property of the columns, not of the regime |
| `ic`, `pairs`, `independentPairs`         | inside the slice. `independentPairs` is the greedy non-overlapping count, not `pairs / horizon` |
| `contrast`                                | `sliceIc` / `complementIc` / `fullSampleIc`, the independent-pair count on both sides, and `delta` |
| `rotationPValue`                          | rotates the **slice mask**, centred on `fullSampleIc`: is the relation specific to these bars? Shortlist only |
| `split`                                   | the halves of the period, measured inside the slice's own bars        |
| `monotonicity`, `decileSpread`, `netDecileSpread`, `deciles` | **shortlist only**, computed on the slice's rows      |

Ordered like `features[]`: `qValue` ascending, ties by `|ic|` descending, untestable last.

**`contrast` is never optional**, for the reason `baseline` is never optional on an event finding. "IC 0.09 in the
trending regime" is a description of the column unless the number outside the regime is printed beside it. If
`COMPLEMENT_AGREES` is set, the effect is at least half as strong outside the slice — that is not a regime.

### `clusters[]` — groups of columns that say the same thing

The block that stops the report being miscounted. Sixteen rows with a low `q` over three clusters are **three**
findings: `RSI_7`, `RSI_14` and `RSI_28` are one indicator at three smoothings, `MACD_hist` and `PPO_hist` differ by a
normalisation, and a rank correlation cannot tell any column from a monotone transform of itself.

| Field            | Notes                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| `id`             | joins to `clusterId` on `features[]` and `slices[]`; stable within one report only                 |
| `size`           | columns in the group; equals `members.length`                                                      |
| `representative` | the group's best-ranked column — the one carrying `clusterRepresentative` and the deciles. Absent when no column of the group produced a testable pair |
| `members`        | every column in the group, **including** the representative                                        |
| `medianAbsRho`   | median within-group `\|rho\|`; absent for a group of one, which has no pair to take a median of      |
| `label`          | assembled mechanically from the representative — family, sign of the IC, span of horizons. **Not an interpretation**: naming what a group means is your work |

Every group is emitted, singletons included, so the array's length equals `meta.featureClusters`. Ids are assigned by
descending size and then by first member name — deliberately by no statistic, because the same id appears in two arrays
and an order derived from one sweep's ranking would mean different things in each.

**The correction is unchanged by any of this.** BH still runs over every tested pair; under positive dependence it stays
valid and merely turns conservative, so setting `m` to the cluster count would be a claim about a search that did not
happen. Clustering decides only which findings were worth the expensive half of the pass, and how the result reads.

### Absent-field semantics

`rotationPValue`, `monotonicity`, `decileSpread`, `netDecileSpread` and `deciles` are serialized `NON_NULL`: when they
were not computed — outside the shortlist, or too few rows to bucket — **the key is absent from the JSON entirely**
rather than present as `null`. Either way it means "not computed". It never means zero, and a reader that renders a
missing `netDecileSpread` as 0 is reporting a number nobody calculated.

`pValue` and `qValue` are always present and can be `NaN`, which means the same thing: the hypothesis could not be
tested, and it was excluded from the multiplicity correction's `m`.

---

## 20.12. Flags and caveats

`flags[]` sits on a finding and changes what the number beside it means. Never collapse one into a tooltip.

| Flag                     | On       | Condition                                            |
| ------------------------ | -------- | ---------------------------------------------------- |
| `COST_EXCEEDS_EDGE`      | event    | `|edge| − cost <= 0`, on either side — equivalently `netEdge` and `edge` have opposite signs, or `netEdge` is 0 |
| `FEW_INDEPENDENT_EVENTS` | event    | `independentEvents < 10`                             |
| `FEW_INDEPENDENT_ROWS`   | feature  | `independentPairs < 30`                              |
| `SPLIT_DISAGREES`        | both     | the two halves of the period have opposite signs     |
| `NOT_MONOTONE`           | feature  | `|monotonicity| < 0.6` (shortlist only)              |
| `COST_EXCEEDS_SPREAD`    | feature  | `netDecileSpread <= 0` (shortlist only). Since RES-8 the same finding also reads `admission: NET_SPREAD_NOT_POSITIVE`, which is what moves it out of the ranked block |
| `COMPLEMENT_AGREES`      | slice    | same sign and `|complementIc| >= 0.5 * |ic|` — **not a regime, just the column** |
| `CONTRAST_UNTESTABLE`    | slice    | the complement produced no coefficient to compare against |
| `SLICE_THIN`             | slice    | the slice covers under 5% of the period                   |
| `HOLDOUT_DISAGREES`      | feature  | opposite sign on the held-out tail (RES-5, only on a job that asked for one) |
| `HOLDOUT_WEAK`           | feature  | same sign, but `|holdoutIc| < 0.5 * |ic|`                 |
| `HOLDOUT_UNTESTABLE`     | feature  | the tail held under 4 independent pairs. **Not tested, which is not "not confirmed"** — nothing was measured, so nothing failed |
| `SINGLE_WINDOW_EFFECT`   | feature  | one walk-forward window's `|ic|` exceeds every other window's summed — an episode, not a relation |

`caveats[]` sits on the report and applies to everything in it. The first three are **always** present:

| Caveat                | Meaning                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------- |
| `OVERLAPPING_WINDOWS` | labels overlap; §20.10 discounts for it but does not abolish it                                 |
| `SINGLE_INSTRUMENT`   | one symbol over one window — the easiest thing there is to overfit                              |
| `IN_SAMPLE`           | found and reported on the same data; the second half took part in the selection, so `split` is not out-of-sample |
| `NO_EVENT_CONDITION`  | no `event` was given — this is the feature sweep alone                                          |
| `NO_EVENTS_MATCHED`   | the condition never fired over this period                                                      |
| `SLICE_SUBSET_OF_FULL_SAMPLE` | slice findings use rows the full-sample findings used too; the families are corrected separately and their q-values are not comparable |
| `NO_SLICES_BUILT`     | slicing was asked for and nothing survived admission — `meta.slicesSkipped` says why, one line per slice |
| `OUT_OF_SAMPLE_TAIL`  | **replaces `IN_SAMPLE`**: a tail was held back from the selection and scanned exactly once (RES-5) |
| `REPLICATION_BASKET_FIXED` | **replaces `SINGLE_INSTRUMENT`**: the basket was named by the requester, never chosen by the server — and choosing it was itself a decision |
| `PARTIAL_JOB`         | a task of the job failed, so a cell of the (symbol × window) grid is missing; the counts report what was measured |

The honest verification of any finding is a run on other instruments and on data it has not seen. **A synchronous scan
cannot do that** — send the same body to `POST /research/jobs` with a `validation` block and it will (§20.12a).

---

## 20.12a. `validation` — the three transfers (RES-5)

Add `validation` to the body and it runs as a job instead: one engine scan per (symbol × window), minutes rather than
seconds, finishing into an ordinary saved run. Sent to `POST /research/scan` it answers `422 VALIDATION_REQUIRES_JOB`.

```jsonc
"validation": {
  "holdout":     { "mode": "TAIL_FRACTION", "fraction": 0.3 },              // 0.1…0.5, or EXPLICIT / NONE
  "replication": { "symbols": ["ETHUSDT", "SOLUSDT"] },   // ≤ 12, never the scanned symbol
  "windows":     { "mode": "ROLLING", "trainMonths": 6, "stepMonths": 3 }   // ≥ 4 windows must fit
}
```

Each sub-block is independent; omit one and its finding fields are absent and the v1 caveat stays. Findings then carry:

| Field | What it answers |
| --- | --- |
| `holdout` | `{from, to, tested, ic, independentPairs, agrees}` — does it hold on data the selection never saw |
| `replication` | `{symbolsTested, symbolsAgreeing, medianIc, worstIc, perSymbol[]}` — how it looks on other instruments. **Nothing here is a gate since RES-12**: the threshold, the flag and the rank contribution were the sign vote, and `symbolsAgreeing` survives only as a reading aid over `perSymbol` |
| `windows` | `{count, agreeing, medianIc, iqrIc, perWindow[]}` — does it hold in **every** sub-period, or in one |
| `robustnessScore` | 0…1, the weighted share of transfers survived: **0.40 holdout / 0.25 windows**, renormalised over the ones requested. RES-12 removed the third term with the sign vote that produced it, so **a job with only a basket gets no score at all** — the basket runs on the period the finding was found on, and both remaining terms are out-of-sample |

Five rules for reading these, each of which is a mistake worth not making:

1. **`agrees` means "same sign AND at least half the effect" everywhere** — the same threshold `COMPLEMENT_AGREES` uses.
2. **The basket is ranked, never pooled.** Bars of different symbols on one timestamp move together, so a coefficient
   over the pooled basket carries a confidently anti-conservative p-value. Count agreement; do not merge the rows.
3. **An absent `robustnessScore` is not a zero.** It means the finding did not clear the gate — read `admission`
   for the step it fell at — which in practice restricts it to the shortlist, because `netDecileSpread` is computed
   nowhere else. Never rank an unranked finding last; leave it out of the ranking. Since RES-8 this is also the sort
   key **inside** the admitted block, so the top of `features[]` is the best-transferring tradable finding rather
   than the most significant one.
4. **The score is comparable only within one report.** Its weights were renormalised over whatever that job asked for.
5. **`HOLDOUT_UNTESTABLE` is not a failure.** It says the tail was too small to reject anything.

The selection period ends `max(horizon) + 1` bars before the holdout begins — an embargo, without which the forward labels
of the last selection bars would be computed from the first held-out bars. Those bars belong to neither period. The `+ 1`
is the engine's inclusive `to`: the last selection bar sits on the boundary itself, so a gap of exactly `max(horizon)` would
still let its deepest label read the first holdout bar.

---

## 20.13. Validation checklist

Walk this before answering.

1. All six required fields present: `exchange`, `marketType`, `symbol`, `timeframe`, `from`, `to`.
2. `timeframe` is one of `1m 5m 15m 1h 4h 1d`.
3. `from < to`, and `from >= 2020-01-01T00:00:00Z`.
4. `(to − from) / timeframe` is within the profile's cap (150 000 full / 500 000 compact).
5. The period leaves enough **independent** observations: `bars / max(horizon)` comfortably above 30.
6. `profile` is `"full"` or `"compact"` if present.
7. `indicatorKeys`, if present, are real `indicatorKey` values from `GET /datasets/presets` — not guessed, not
   constructed by splitting names — and number at most 250.
8. `higherTimeframes` has at most 2 entries, each a strict higher multiple of `timeframe`; empty on a `1d` base.
9. `forwardHorizons` are integers `1..500`, distinct, and a spread rather than a single value.
10. `includeFunding` / `includeMetrics` only meaningful on futures; on spot, omit them.
11. `event`, if present, is a `conditionGroup` **object** with `operator` and a non-empty `conditions[]`.
12. Every indicator the `event` reads is in the scan's column set — selected explicitly, preselected by the profile, or
    one of the base aliases (`CLOSE`, `OPEN`, `HIGH`, `LOW`, `VOLUME`, `QUOTEVOL`, `TRADES`, `FUNDING`).
13. The `event` reads no position pseudo-series (`AVG_ENTRY`, `POS_*`).
14. `costBps` in `0..1000` and **not 0 without a reason**; `topFindings` in `0..100`; `resamples` in `1..2000`.
15. `seed` stated explicitly if the report is to be compared with another.
16. No `includeTargets`, and no field outside §20.2.
17. When quoting a q-value, quote `meta.featureHypotheses` (or `eventHypotheses`) with it.
18. When calling a feature finding actionable, state `netDecileSpread` — a correlation without a number in money is not
    a result.
19. `slices`, if present, holds only names from §20.9a, with no repeats, and at most 18 slices are asked for in total (the built-in families expand to at most 16 — EDGE-10's `OI_REGIME` and EDGE-9 level 2's `BASIS_SIGN` fit inside that bound).
20. `customSlices` has at most 8 entries, each with a non-empty unique `name` under 60 characters and a
    `conditionGroup` **object** for `condition`, reading only series the scan carries.
21. `fundingWindowBars`, if present, is in `1..500` — and only matters when `FUNDING_WINDOW` was asked for.
21a. `series`, if present, holds at most 16 entries whose `when`/`take` read only scan columns and never another series.
22. When quoting a **slice** q-value, quote `meta.sliceHypotheses` with it, and never set it beside a feature q-value
    as if the two ranked the same thing.
23. When calling a slice finding a regime, check `COMPLEMENT_AGREES` is absent — otherwise it is the column behaving
    the way it behaves everywhere.
24. When stating how much the scan found, state `meta.effectiveFindings` — **never a count of rows** with a low `q`.
    Distinct `clusterId`s are things; rows are views of them.
25. When quoting one finding on behalf of a group, quote the row with `clusterRepresentative: true` and name the
    others from `clusters[].members` rather than presenting them as separate discoveries.
26. `validation`, if present, goes to `POST /research/jobs` — never to `/research/scan`. Its basket holds at most 12
    symbols, none of them the scanned one; `holdout.fraction` is in `0.1..0.5`; the window spec must yield at least 4
    windows **inside the selection period**, which is shorter than the requested one when a holdout was asked for.
27. When quoting `robustnessScore`, say which transfers it was composed of (`meta.job.robustnessWeights`) and never
    compare one report's score with another's.
28. When a finding carries `HOLDOUT_UNTESTABLE`, say the tail could not test it. Do not report it as having failed the
    holdout, and do not treat the absent `robustnessScore` as a low one.

---

## 20.14. Not supported — do not emit

- **No `includeTargets`.** A scan always computes its labels; the flag would only be a way to ask for an empty report.
  Its presence is the tell of a body copied from `POST /datasets/export`.
- **No `id`, `name`, `strategyId` or `baseConfig` in the request.** A scan does not reference a strategy, and it is not
  named or addressed by the caller: the id under which it is stored is assigned by the server and comes back on the
  response (§20.17). There is no `GET /research/scan/{id}` and no cancel.
- **No threshold search.** The scan does not sweep cut points for a column; the decile profile already shows the shape,
  in a form that cannot be read as one lucky corner. The built-in slice families (§20.9a) use **fixed, documented,
  non-tunable** thresholds — they are constants, not a search, and no request field moves them.
- **No column combinations.** One column at a time. There is no interaction, no pair sweep, no regression block. A
  slice is not an exception to this: the statistic is still one column, and the slice is a *conditioning event* rather
  than a second regressor.
- **No slice search.** The families are a fixed list. The endpoint does not look for the best-performing partition of
  the bars, and it does not restrict the sliced sweep to columns that did well on the full sample — that would be a
  second, uncorrected selection on the same data and would make `sliceHypotheses` a statement about a search that did
  not happen.
- **No PCA and no synthetic columns.** Clusters group the columns the export actually carries; a principal component
  is a new column absent from `data.csv`, so a finding on one could be neither re-checked by exporting the table nor
  carried into an entry layer — the two properties the whole track rests on. The clustering threshold is likewise a
  constant, not a request field: a tunable one would be a knob for turning `effectiveFindings` into a desired number.
- **No custom statistic.** No `metric`, `statistic`, `method` or `correction` field: the pair is Spearman's rho plus
  Benjamini–Hochberg, and the rotation test is the only resampling scheme.
- **No `alpha` / `fdr` / significance threshold in the request.** Every finding is returned with its q-value; the cutoff
  is the reader's.
- **No multi-timeframe or portfolio scan.** One base `timeframe`, one period.
- **Multi-symbol: the one exception, and it is deliberate.** `POST /research/scan` remains single-symbol; a body carrying
  `crossSymbol` is refused with `422 CROSS_SYMBOL_REQUIRES_JOB`. A cross-symbol **panel** exists only on
  `POST /research/jobs` (RES‑3, [research/12-cross-symbol.md](research/12-cross-symbol.md)), over a **fixed universe the
  caller names** — there is no symbol search and the server never picks the members. Its two families report under
  `crossSymbol` and are corrected separately from everything else.

  **What this exception costs, stated plainly:** a lead-lag finding pairs one symbol's column with another symbol's
  forward return, so **no single dataset export reproduces it** — it takes two exports and a join on the timestamp.
  Every such report carries `PANEL_NOT_ONE_EXPORT`. This is the first and only place in the track where the "recompute it
  from the downloaded table" guarantee does not reach a finding, and it must be quoted whenever one is.

  It is **not** an exception to the synthetic-column rule below: a cross-sectional spread is a *statistic over exported
  columns*, not a new column fed back into the sweep, and every input to it is a column `data.csv` carries.
- **No out-of-sample split control.** `split` is a fixed halving of the period, and it is `IN_SAMPLE` by construction.
  On a slice finding the same halving is measured inside that slice's own bars.
- **No labels other than forward return and the excursion pair.** No triple-barrier, no volatility-scaled target, no
  classification labels.
- **No block bootstrap or permutation alternatives**, and no block-length parameter.
- **No pagination.** `topFindings` bounds the expensive half, not the response; every tested pair is returned. A slice
  request whose sweep would exceed 7000 hypotheses is **refused** with the arithmetic named, not truncated.
- **No draft strategy in the response.** Turning a finding into a config is a separate, deliberate step.

---

## 20.15. Worked examples

### 20.15.1. Feature sweep alone — "what should I even be looking at"

The mode to start in. No event, full profile, one year of hourly BTCUSDT futures.

```json
{
  "exchange": "binance",
  "marketType": "futures",
  "symbol": "BTCUSDT",
  "timeframe": "1h",
  "from": "2023-01-01T00:00:00Z",
  "to": "2024-01-01T00:00:00Z",
  "profile": "full",
  "forwardHorizons": [1, 4, 12, 24],
  "includeFunding": true,
  "includeMetrics": true,
  "costBps": 8,
  "topFindings": 25,
  "resamples": 200,
  "seed": 42
}
```

8760 bars, ~130 feature columns, ~520 hypotheses. Expect `caveats` to contain `NO_EVENT_CONDITION` plus the three
standing ones, and expect the `oi` / `lsr_*` rows to carry `FEW_INDEPENDENT_ROWS` — Binance serves ~30 days of those.

### 20.15.2. Event study — an oversold condition, cross-checked in pandas

```json
{
  "exchange": "binance",
  "marketType": "futures",
  "symbol": "ETHUSDT",
  "timeframe": "1h",
  "from": "2023-01-01T00:00:00Z",
  "to": "2024-06-01T00:00:00Z",
  "profile": "full",
  "indicatorKeys": ["RSI_14", "EMA_200", "ATR_14", "HV_20", "RVOLUME_20"],
  "forwardHorizons": [1, 4, 12, 24],
  "includeFunding": true,
  "includeMetrics": true,
  "event": {
    "operator": "AND",
    "conditions": [
      { "indicator": "RSI", "params": { "period": 14 }, "op": "LT", "value": 25 },
      {
        "left": { "indicator": "CLOSE" },
        "op": "GT",
        "right": { "indicator": "EMA", "params": { "period": 200 } }
      }
    ]
  },
  "costBps": 8,
  "topFindings": 25,
  "resamples": 500,
  "seed": 42
}
```

Note that `RSI_14` and `EMA_200` are **in `indicatorKeys`** — the condition reads them, and a hand-picked selection
replaces the profile's defaults rather than adding to them. Drop either and the answer is `422 UNKNOWN_SERIES` naming
it. `CLOSE` needs no entry: it is a base alias.

To fetch the exact table these numbers came from, send the same body to `POST /api/v1/datasets/export` with `event`,
`costBps`, `topFindings`, `resamples` and `seed` removed and `"includeTargets": true` added.

### 20.15.3. A long period on a coarse timeframe

Three years of `4h` is 6570 bars — inside either cap — but the interesting constraint is the effective sample size:
at a 24-bar horizon that is ~270 independent observations, near the floor of what is worth reading.

```json
{
  "exchange": "binance",
  "marketType": "spot",
  "symbol": "BTCUSDT",
  "timeframe": "4h",
  "from": "2020-01-01T00:00:00Z",
  "to": "2025-01-01T00:00:00Z",
  "profile": "compact",
  "higherTimeframes": ["1d"],
  "forwardHorizons": [1, 3, 6, 12],
  "costBps": 10,
  "topFindings": 40,
  "resamples": 500,
  "seed": 7
}
```

Spot, so `includeFunding` / `includeMetrics` are omitted entirely. `compact` keeps the report readable end to end, the
`1d` copies of the mtf presets arrive as `EMA_200#1d`, `RSI_14#1d`, `ATR_14#1d`, and the horizons are shallower because
a 24-bar window on `4h` is four days.

---

## 20.16. Output contract

When asked to produce a research scan request:

1. Emit **one** JSON object and nothing else — no comments, no trailing commas, no wrapper keys such as
   `{"request": …}`.
2. Use only the 17 fields of §20.2. If a requested capability appears in §20.14, say so plainly instead of inventing a
   field.
3. Compute the bar count (`(to − from) / timeframe`) and the effective sample size (`bars / max(horizon)`) before
   answering, and state them alongside the JSON.
4. Never guess an `indicatorKey`. Take it from `GET /datasets/presets`, or leave `indicatorKeys` out and let the profile
   decide.
5. If the request carries an `event`, list the series it reads and confirm each is selected or is a base alias.
6. Re-read §20.13 and confirm every applicable line.

When asked to **interpret a report**:

1. Quote `qValue` with the hypothesis count it was corrected over, never alone.
2. Quote a feature finding's `netDecileSpread` — the number in money — beside its `ic`. A correlation without one is not
   a result.
3. Read `flags[]` and `meta.warnings` out loud; they are the reasons to doubt the number next to them, not footnotes.
4. Treat an absent field (or `NaN`) as "not computed", never as zero.
5. State the standing caveats: this is one instrument, one window, in-sample, with overlapping labels. The real test of
   a finding is other instruments and data it has not seen.

---

## 20.17. Saved runs and the research bundle

Every scan that succeeds is stored against the calling user and the response gains one field:

```jsonc
{ "meta": { … }, "events": [ … ], "features": [ … ], "caveats": [ … ], "runId": 41 }
```

`runId` is the **only** thing Strategy Service adds to the engine's report, and it is a documented exception to the
"proxied untouched" rule. It is not part of the report, it is the handle to it, so it sits outside `meta.formatVersion`
and the engine knows nothing about it. It is **optional**: a scan that computed but could not be saved comes back in
full without it, because a report already paid for with one of the engine's two permits is not worth discarding over a
storage fault. Absent `runId` means "this one cannot be downloaded or reopened", nothing else.

| Endpoint | Answers |
| --- | --- |
| `GET /api/v1/research/runs` | A flat array of run headers, newest first. No paging: the list is capped at 50 private runs per user, plus the published ones |
| `GET /api/v1/research/runs/{id}` | `{ run, request, report }` — the request and report exactly as stored |
| `DELETE /api/v1/research/runs/{id}` | `204` |
| `GET /api/v1/research/runs/{id}/bundle` | `200 application/zip` — see below |
| `PATCH /api/v1/research/runs/{id}/visibility` | `{ "visibility": "PUBLIC" \| "PRIVATE" }` → the updated run header. Owner only; `422 RESEARCH_RUN_NOT_PUBLISHABLE` for a scan without an event |
| `GET /api/v1/research/runs/{id}/public` | The claim-check page — sign-in optional; see below |
| `GET /api/v1/research/runs/public?limit=N` | Published runs, newest publication first: `[{ id, symbol, timeframe, marketType, eventLabel, publishedAt }]`. Sign-in optional; `limit` defaults to 100 and is clamped to 1…500 |

A run header carries the scope (`exchange`, `marketType`, `symbol`, `timeframe`, `from`, `to`, `profile`, `bars`,
`featureColumns`), both hypothesis counts, `discoveries` (findings with a finite q below 0.1, counted at save time),
`hasEvent`, `eventLabel` and `createdAt`. Two of those need care:

- **`discoveries` is meaningless without `featureHypotheses`.** It is a q-value threshold applied, and the threshold is
  the reader's business — the report itself applies none. Quote the pair.
- **`hasEvent` and `eventLabel` are not the same question.** A condition that never fired produces a report with no
  event findings and therefore no label, which is indistinguishable from a scan that asked nothing. `hasEvent` is what
  separates "the answer was never" from "no question was asked".

A foreign or missing id answers `404 RESEARCH_RUN_NOT_FOUND`, never `403`.

### Publishing a claim check

The owner can make one run's **event study** public — a page that says "when this condition held, here is what
followed". Only a scan whose request carried an `event` may be published (`hasEvent: true`; a condition that never fired
is still publishable, since "it never happened" is an answer), because a feature sweep alone makes no claim. The header
now also carries `visibility` (`PUBLIC | PRIVATE`, default `PRIVATE`) and `publishedAt` — the **first** publication,
kept through an unpublish and not moved by a republish. Published runs sit outside the 50-run cap: they are never
pruned and do not count towards it, so the run list can hold up to 100 headers. Publishing from an API key needs the
`publish` scope, not `research`.

`GET /research/runs/{id}/public` answers a `PUBLIC` run to anyone (`access: "READ"`) and the owner's own run at any
visibility (`access: "OWNER"`, the preview); anyone else gets `404`. It is an allow-list of the stored artefacts, every
block passed through as stored, never recomputed:

```jsonc
{ "run": { "id", "exchange", "marketType", "symbol", "timeframe", "from", "to", "bars", "eventLabel",
           "visibility", "publishedAt", "createdAt" },
  "access": "READ",
  "event": { … },          // the request's event condition group, verbatim
  "horizons": [ … ], "costBps": 8, "eventHypotheses": 4,   // from report.meta
  "events": [ … ],         // report.events (§20.11)
  "episodes": { … },       // report.episodes, or null for reports saved before the engine wrote it
  "caveats": [ … ] }
```

The feature sweep, slices, pairs, clusters, the rest of the request and the owner's id are never on this page; the
full run (`GET /research/runs/{id}`) and the bundle stay owner-only whatever the visibility.

### The bundle

`GET /research/runs/{id}/bundle` returns a ZIP with a real `Content-Length` and
`Content-Disposition: attachment; filename="research-41-btcusdt-1h.zip"`.

**This is the artefact meant for you.** The dataset export (§20.1) hands over the raw `bar × column` matrix, which does
not fit in a context window and which a language model computes over badly; the bundle hands over the findings with the
cost of confidence attached, and a `README.md` that states how many hypotheses were swept to produce them.

| Entry | Contents |
| --- | --- |
| `README.md` | First in the archive. The methodology, **every hypothesis count**, the slice definitions and the slices that could not be built, the flag and caveat tables, and eight rules for reading the sheets. Numbers substituted from this run |
| `pairs.csv` | One row per (representative × representative × horizon) — RES-13's pair family. Two clustered columns read as one composite (the mean of their ranks, each turned to its own sign), corrected over a family of their own. **Read `lift` before `ic`**: it is the pair against its own stronger half, and `NO_LIFT` says it did not beat it. Header only when the sweep was not asked for |
| `findings.csv` | One row per (column × horizon), **ordered by admission then tradability** — not by `q_value` (RES-8); the `admission` column names the step each row fell at. Carries `cluster_id`, `is_cluster_representative`, nine `economics_*` columns, and the thirteen RES-5 transfer columns (`robustness_score`, `holdout_ic`, `holdout_independent_pairs`, `holdout_tested`, `holdout_agrees`, `symbols_tested`, `symbols_agreeing`, `replication_median_ic`, `replication_worst_ic`, `windows_count`, `windows_agreeing`, `windows_median_ic`, `windows_iqr_ic`). `holdout.from`/`holdout.to` are deliberately **not** columns: they are the same two timestamps on every row and `meta.json` `scan.job.holdout` carries them once |
| `clusters.csv` | One row per group of columns the scan cannot tell apart, largest first. **Read it before counting the rows of `findings.csv`**: sixteen rows carrying three cluster ids are three findings. Header only for a report produced before RES-7 |
| `events.csv` | One row per horizon of the event study; header only when no condition was scanned |
| `slices.csv` | One row per (slice × column × horizon), ordered by `q_value`; header only when no slice family was requested. Carries the contrast — `slice_ic`, `complement_ic`, `full_sample_ic`, `delta` — and, since `7`, the whole nine-column `economics_*` block, on every row. A custom slice's key is `CUSTOM:<name>` (§20.9) |
| `deciles.csv` | The shortlist's decile profile, long format, for **both** single-symbol sweeps; join on `(feature, horizon)`, or on `(slice, feature, horizon)` for a slice row |
| `lead_lag.csv` | One row per (leader → follower × factor × horizon × lag), RES-3 family four. **Both panels sit here**, told apart by the leading `panel` column. Carries the three reference coefficients, `monotonicity`, both `split` counts and the nine `economics_*` columns. Header only when no cross-symbol panel ran |
| `lead_lag_deciles.csv` | The decile profile of the shortlisted lead-lag rows — the evidence behind their `decile_spread` and `monotonicity`. Join on `(panel, leader, follower, factor, horizon, lag)` |
| `pooled.csv` | One row per (factor × horizon): the estimate pooled over every instrument at once, **and what ranking the universe on it was worth** — RES-12 merged the cross-sectional family into this one (§21.9). Both panels again under `panel`. Carries the pooled statistics, the eight `bar_spread_*` columns (the distribution `mean_spread` summarises), the `economics_*` columns and both `split` counts. Header only when no panel ran |
| `pooled_groups.csv` | One row per rank group — the cross-symbol answer to `deciles.csv` and the evidence behind `monotonicity`. **Thirds, not deciles**: `group` runs 0..2 and `mean_symbols` says how many instruments were in each |
| `pooled_symbols.csv` | One row per instrument inside a pooled estimate — the distribution `agreement_share` summarises. Nothing is gated on it: a gate on agreement would be the replication sign vote again under another name |
| `replication.csv` | One row per (finding × basket symbol) — the basis of `symbols_agreeing`. Header only when no basket was requested (RES-5) |
| `windows.csv` | One row per (finding × walk-forward window) — what the two `split` numbers cannot show. Header only when no windows were requested (RES-5) |
| `outcomes.csv` | **What the findings earned** — the only sheet not derived from the report, read from `finding_outcomes` (RES-12, RES-14). One row per finding that ever left the lab as a draft, **including the ones nobody ran**: a table of the finished ones is the survivorship bias the track is written against. The prediction is frozen at draft time; `train_*` is the period the finding was *found* on and is not evidence; `holdout_*` is the only out-of-sample number and is spent once. Read `train_deflated_sharpe` beside the return — a probability, not a ratio, and the number that says how much of the return is the search |
| `columns.csv` | `sheet, name, report_field, description` for every column of the fourteen sheets |
| `meta.json` | The request verbatim — including the `validation` block — the report's `meta` (with `slices` and `slicesSkipped`), each panel's own `meta` and `caveats` under `panel.selection` / `panel.holdout` (`null` for a panel that did not run), the bundle's own `bundleFormatVersion`, and **`files`: the manifest** (§ below). `panel.*.meta` is the only place the universe, the per-symbol `coverage`, the skipped symbols and the two panel hypothesis counts appear |

Nothing is recomputed and the engine is not called, so this cannot answer `DATASET_BUSY` and does not consume a permit.

Nine things to know before parsing it:

0. **Count effects, not rows.** Join `findings.csv` to `clusters.csv` on `cluster_id` before you say how much the scan
   found, and quote the row with `is_cluster_representative` on behalf of its group. `meta.json`'s
   `scan.effectiveFindings` has already done the counting.

1. **Headers are `snake_case`; `columns.csv` gives the report's own `camelCase` field beside each.** `q_value` in the
   CSV is `qValue` in the JSON. Both are published so neither has to be guessed.
2. **An empty cell means "not computed", never zero.** This covers the shortlist-only columns
   (`rotation_p_value`, `monotonicity`, `decile_spread`, `net_decile_spread`) and an untestable `p_value`/`q_value`
   alike. In JSON the same thing appears as an absent key or the **string** `"NaN"` — Jackson quotes non-numeric
   doubles — so a parser that coerces silently will read `0.0` and report a number nobody calculated.
3. **The one exception is the `slice` column of `deciles.csv`, where empty means the full sample.** It is the
   discriminator between the two sweeps' profiles, not a missing value. The archive's other discriminator, `panel`, is
   **never** empty — an empty one is a corrupt row.
4. **`flags` is `|`-separated**, so it survives a naive split and never needs quoting.
5. **A column you do not find in `columns.csv` does not exist in this bundle format.** Columns the engine added later
   are appended after the documented ones and described as such, so a trailing unknown column is a newer engine, not a
   corrupt file. Since `7` this holds for the flattened sheets too — `deciles.csv`, `lead_lag_deciles.csv`,
   `pooled_groups.csv`, `replication.csv`, `windows.csv` — where the rule previously did not run at all.
6. **A cell holding a structure is compact JSON, not a blank.** Only an undocumented key can produce one, and a blank
   would have said "not computed" about something that was.

7. **Quote replication as a fraction, never as a verdict.** `symbols_agreeing` beside `symbols_tested` is "3 of 4
   symbols agree"; "it replicates" is a claim the report does not make, and the difference between three of four and
   four of four is the whole reason the column exists.
8. **A `HOLDOUT` row is a re-run, not a verdict.** On the four cross-symbol sheets, pair it with its `SELECTION` twin on
   the key columns and compare `ic` for sign and size. **Never compare, pool or re-rank `q_value` across panels** —
   each panel was corrected over its own family and the tail is a smaller search — and do not read a missing twin as a
   failure: each panel shortlists on its own evidence.

**`meta.json` carries a manifest.** `files` is one entry per sheet — `{ name, rows }` — and `rows` is the data rows that
sheet actually holds, header excluded. Every sheet is written whether or not it has any, so a reader never branches on
which files exist; the price of that rule is an archive where nine of seventeen files can be headers, and until the
manifest the only way to learn that was to open all seventeen. **Read it first**: it says where the data is in one read,
and a count of `0` is the honest answer for a sweep that was not asked for.

`bundleFormatVersion` is `12`: `11` had neither `outcomes.csv` nor the `files` manifest — the archive could say what looked
promising and not what any of it earned, because the equity verdict RES-12 judges by was kept only in the database;
`10` had no `pairs.csv` (RES-13 added the pair family); `9` still carried `min_agreeing` and the `NOT_REPLICATED` flag,
which went with the replication sign vote RES-12 deleted; `8` had `cross_sectional.csv` and `cross_sectional_groups.csv` where `pooled.csv`,
`pooled_groups.csv` and `pooled_symbols.csv` now sit — RES-12 deleted the cross-sectional family and moved its money
onto the pooled finding, which until then had no sheet at all; `7` still carried the four
`economics_net_per_year_pct` columns, which RES-12 removed along with the field itself; `6` dropped the holdout panel
entirely and had no `panel` column, no
`lead_lag_deciles.csv` or the panel groups sheet, no `economics_*` on either cross-symbol sheet, no
`bar_spread_*`, and rendered an undocumented object as a blank cell; `5` had neither `lead_lag.csv` nor
the cross-symbol ranking sheet and was ten files; `4` had no `replication.csv` or `windows.csv` and none of the RES-5 transfer
columns; `3` had none of RES-8's `admission` and `economics_*`; `2` had no `clusters.csv` and no `cluster_id`; `1` had
no `slices.csv` and no `slice` column on `deciles.csv`. It is the bundle's own number and is not the report's
`formatVersion`, which travels beside it under `scan` — nor either panel's, which travels under `panel.*.meta`.

### Running a finding, and spending the tail (RES-12)

`POST /api/v1/research/runs/{runId}/findings/check` drafts the finding **and asks the engine what it earns**, in one
call. The difference from `/draft` is who runs it: the draft hands a config back for a person to save and dry-run
themselves, which stays; this one goes to the engine directly, because §21.6 makes an equity curve part of judging a
finding rather than something done afterwards — and a shortlist of twenty-five findings is not twenty-five gestures.

`202`, and **nothing is created**: no strategy, no backtest, no row to clean up. The config travels inside the command
and the engine persists nothing for it. What the call writes is the link from the frozen prediction to the run that
will test it; the measurements arrive on the engine's own event seconds later and land in `finding_outcomes` —
`outcomes.csv` in the bundle, `GET /research/outcomes/calibration` on the wire.

`?phase=TRAIN` (the default) runs the period the finding was found on. `?phase=HOLDOUT` runs the held-out tail, and
four rules make that number worth having:

- **The window comes from the report, never from the caller** (`meta.job.holdout`). A window a client could choose is a
  window a client could choose *again*, and the whole value of a tail is that nobody picked it after seeing anything.
- **A run with no tail is refused** — `422 NO_HOLDOUT_TO_RUN` — rather than quietly re-run on its own period. That
  substitution is the worst thing this endpoint could do, because the number would look exactly like a real result.
- **The tail is spent once.** A second holdout run on a finding whose tail already carries a measurement answers
  `422 HOLDOUT_ALREADY_SPENT`: run it, dislike the number, adjust and run again, and the tail has silently become a
  second training set with the retries uncorrected and invisible.
- **A run that took no positions has not spent it.** Zero trades measured nothing — most often a draft whose threshold
  is a price level the tail never revisited — so the retry is allowed. Read `holdout_trades` before
  `holdout_net_profit_pct`: `0.00%` on zero trades is *untestable*, not falsified.

**Only an `ADMITTED` column finding gets a run** (`422 FINDING_NOT_ADMITTED`, and the message names the step it fell
at). The scan's ladder is a pre-filter since RES-12: it decides what deserves an expensive pass, not what is true. An
event finding and a slice finding carry no `admission` at all — the ladder is written on numbers they do not have — and
are not refused for lacking a verdict they never get.

**`train_deflated_sharpe` is the number to read beside the return.** §10.6 refused the Deflated Sharpe while the lab had
no equity of its own; RES-12 gave it one and the refusal was cancelled rather than inherited. It is a **probability**,
not a ratio: how likely the edge is real once the search that found it is charged for, against the run's own declared
hypothesis count. A three-figure TRAIN return with a deflated Sharpe of 0.07 is the correction saying, in the only
language it has, that almost all of that return is the search.

### Turning a finding into a strategy

`POST /api/v1/research/runs/{runId}/findings/draft` answers the strategy config one finding becomes — the last step of
the track (RES-9, docs/research/11-finding-to-strategy.md). It is a separate, deliberate call rather than a field on
the report, which is what §20.14's "no draft strategy in the response" means.

The finding is **addressed, not sent**: the body is `{kind, feature, horizon, slice, target}` and the server reads the
numbers out of the report it stored. Nothing is persisted — the answer is a config to open in an editor, and saving it
is the caller's own `POST /strategies`.

Three things about the answer that matter when reading it:

- **The threshold is quoted, never searched.** A feature draft's entry condition is the boundary of the extreme decile,
  character for character, and `provenance.thresholdSource` names the field it came out of. A finding with no decile
  profile answers `422 FINDING_NOT_SHORTLISTED` rather than receiving an invented cut point.
- **The entry layer mirrors the study, not a strategy.** It re-arms every bar and holds up to `maxHoldingBars + 1`
  positions, because an event study scores every bar the condition fired on. `limitations[]` says so; do not describe
  the draft as a tuned strategy.
- **`run.to` is earlier than the scan's `to`**, by the finding's horizon — the bars whose forward label the study never
  had. That is what makes "scan events" and "dry-run entries" comparable.

