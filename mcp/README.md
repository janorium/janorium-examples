# janorium-mcp

The MCP server for [Janorium](https://janorium.com), a free platform for backtesting crypto trading strategies. It lets
Claude Desktop, Claude Code, Cursor or any other MCP client run a real backtest when you ask a question, instead of
guessing the numbers.

Ask your assistant things like:

- "Backtest a 50/200 EMA golden cross on BTCUSDT 4h since 2020, with fees, and compare it with buy and hold."
- "Why does my strategy #42 barely trade? Show me which entry condition blocks it most."
- "Run a Monte Carlo on that backtest and tell me the 5th-percentile drawdown."

The assistant writes the strategy as a declarative JSON config, validates it, saves it to your Janorium account and runs
it on Binance spot or USDT-M futures history. Every number in its answer comes from Janorium's engine, and every saved
backtest also opens as a full report on janorium.com.

Janorium is a backtesting platform only: nothing here places orders or touches an exchange account. It is free to use.

## Get an API key

1. Sign up at [janorium.com](https://janorium.com) (free).
2. Open **Settings → API keys** and click **Create key**.
3. Pick the scopes: `read` and `run` cover strategies and backtests. Add `optimize` for the optimizer tools and
   `research` for `research_*` and `analogs_query`. Add `publish` only if the assistant may make a strategy public when
   you ask it to.
4. Copy the key (it starts with `cbk_`). It is shown once.

Each key has its own quota of **300 backtest runs per day**, separate from what you run on the website. Give the MCP
server a key of its own, so you can revoke it without breaking anything else.

## Set it up

You need Node.js 20.9 or newer. `npx` downloads and starts the server; there is nothing else to install.

### Claude Desktop

Add the server to `claude_desktop_config.json` and restart Claude Desktop. The file is at
`%APPDATA%\Claude\claude_desktop_config.json` on Windows and
`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS.

```json
{
  "mcpServers": {
    "janorium": {
      "command": "npx",
      "args": ["-y", "janorium-mcp"],
      "env": {
        "CB_API_KEY": "cbk_your_key_here"
      }
    }
  }
}
```

If Claude Desktop on Windows cannot start `npx`, use `"command": "cmd"` with
`"args": ["/c", "npx", "-y", "janorium-mcp"]`.

### Claude Code

```bash
claude mcp add --env CB_API_KEY=cbk_your_key_here --transport stdio --scope user janorium -- npx -y janorium-mcp
```

The options go before the server name, and `--env` must not come right before it: the CLI would read the name as
another variable. `--scope user` makes the server available in every project. Run `claude mcp list`, or `/mcp`
inside Claude Code, to check that it connected.

### Cursor

Add the server to `~/.cursor/mcp.json`, or to `.cursor/mcp.json` in one project:

```json
{
  "mcpServers": {
    "janorium": {
      "command": "npx",
      "args": ["-y", "janorium-mcp"],
      "env": {
        "CB_API_KEY": "cbk_your_key_here"
      }
    }
  }
}
```

Other MCP clients take the same command (`npx -y janorium-mcp`) and the `CB_API_KEY` variable.

## One-off questions and campaigns

A one-off question ("how did this strategy do in 2024?") just runs: any period, no setup.

Searching for a strategy is different. An assistant that tries dozens of variants and keeps the best one will find
something that fits the history by chance. For that work the server has **campaigns**. `campaign_start` declares the
period and locks its last part as a holdout. The assistant can try as many variants as it likes on the rest.
`campaign_finalize` then runs the chosen strategy on the holdout exactly once and reports a Deflated Sharpe ratio that
accounts for every attempt.

Without a campaign, the server counts the different configs it runs. From the fifth one on, every run answer carries a
`campaignNotice`: the numbers of the best variant are optimistic, and the assistant should confirm it in a campaign.

To make every run go through a campaign, set `MCP_REQUIRE_CAMPAIGN=true` in `env`. A run without one is then refused
with `NO_CAMPAIGN`, and the assistant starts a campaign first.

## Tools

| Tool                      | What it does                                                                                    |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| `strategy_validate`       | Checks a strategy config with the platform validator, without saving or running it.             |
| `strategy_save`           | Creates a strategy or saves a new version of one of yours. New strategies are private.          |
| `strategy_get`            | Reads a strategy config: the current version or a past one.                                     |
| `strategy_versions`       | Version history, with the structural diff between two versions.                                 |
| `strategy_dry_run`        | Runs a config once without saving a backtest and returns the full summary.                      |
| `strategy_set_visibility` | Makes one of your strategies public or private again, only when you ask for it.                 |
| `backtest_run`            | Launches saved backtests of a strategy, one per symbol × timeframe, up to 30 per call.          |
| `backtest_get`            | The summary of a finished backtest: metrics, exits by reason, what blocked entries.             |
| `backtest_trades`         | One page of trades: entry and exit, PnL, fees, funding, exit reason, MAE/MFE.                   |
| `backtest_near_miss`      | Bars where all entry conditions but a few held, and which condition blocks most often.          |
| `backtest_signals`        | The entry condition tree evaluated bar by bar, with the operand values.                         |
| `backtest_monte_carlo`    | Resamples the trades: percentiles of final equity, return and max drawdown.                     |
| `backtest_compare`        | Metrics of several runs side by side, with comparability warnings and config diffs.             |
| `backtest_risk_scaling`   | The position-size multiplier that turns a run's max drawdown into a target drawdown.            |
| `optimization_create`     | Starts a parameter search with walk-forward windows and robustness scoring.                     |
| `optimization_get`        | Optimizer status and the top variants with their robustness diagnostics.                        |
| `optimization_promote`    | Saves an optimizer variant as a new strategy version and runs its out-of-sample backtest.       |
| `research_scan`           | Tests many signal hypotheses over the history and reports what holds up.                        |
| `research_job_create`     | A research scan with validation across windows or symbols, run as a background job.             |
| `research_job_get`        | Status of a research job and its results once done.                                             |
| `research_draft`          | Builds a strategy config from a research finding.                                               |
| `analogs_query`           | Finds historical market states like a given one and the forward returns that followed them.     |
| `market_symbols`          | Symbols with candle history, per market type.                                                   |
| `market_coverage`         | First and last candle per symbol and timeframe, plus funding coverage.                          |
| `wait`                    | Waits for dry runs, backtests, optimizations and research jobs to finish.                       |
| `campaign_start`          | Starts a campaign: declares the period and locks its holdout.                                   |
| `campaign_status`         | The active campaign: locked region, number of attempts, their Sharpe distribution.              |
| `campaign_finalize`       | Runs the chosen strategy on the holdout once and reports the Deflated Sharpe over all attempts. |

The server also exposes references the assistant reads before it writes a config (`docs://strategy-config-reference`,
`docs://optimizer-run-reference`, `docs://research-scan-reference`, `docs://analog-query-reference`), the indicator
catalog, strategy templates, market coverage and campaign ledgers as resources, and three prompts:
`iterate_strategy`, `plan_optimization` and `read_research_report`.

## Limits

- **300 backtest runs per day per API key.** A run refused for the quota comes back as an error with `status: 429`; a
  launch is never repeated automatically.
- Up to 30 backtests per `backtest_run` call and at most 2 active optimizer runs at a time.
- Answers are kept under 64 KB; longer lists are cut and marked `TRUNCATED`.

## Environment variables

| Variable               | Default                           | Meaning                                                                         |
| ---------------------- | --------------------------------- | ------------------------------------------------------------------------------- |
| `CB_API_KEY`           | required                          | Your `cbk_…` key. Never logged; masked in everything returned to the assistant. |
| `CB_BASE_URL`          | `https://janorium.com/api/v1`     | REST API base. Leave it unset.                                                  |
| `MCP_REQUIRE_CAMPAIGN` | `false`                           | `true` refuses every run outside a campaign (see above).                        |
| `CB_CAMPAIGNS_DIR`     | `~/.crypto-backtesting/campaigns` | Where campaign ledgers are stored on your machine.                              |

## Keep the key safe

The key sits in plain text in your client's config file, where any program running as you can read it.

- Use a dedicated key with only the scopes you need.
- Keep the config file private: do not commit it, share it or paste it into an issue.
- If the key may have leaked, revoke it in **Settings → API keys**. The server notices within minutes and stops.

The server sends the key only to `CB_BASE_URL` over HTTPS, refuses redirects, and treats strategy names and other text
written by users as data, never as instructions.

## Source

The source is on GitHub in [janorium/janorium-examples](https://github.com/janorium/janorium-examples/tree/main/mcp)
(`mcp/`), together with the tests and the four references the server serves. It is exported from Janorium's own
repository with every release, and the npm package is built from it. Bug reports and questions go to the
[issues](https://github.com/janorium/janorium-examples/issues).

To build and test it yourself (Node.js 20.9 or newer):

```bash
npm ci
npm test
npm run build
```

## License

MIT
