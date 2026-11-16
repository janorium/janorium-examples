# janorium-mcp (coming soon)

> **Not published yet.** The package is not on npm, so the commands below do not work today. This page will hold the
> server's source and its final instructions once it is released.

`janorium-mcp` is an [MCP](https://modelcontextprotocol.io) server for [Janorium](https://janorium.com). It lets Claude
Desktop, Claude Code, Cursor or any other MCP client validate, dry-run and backtest crypto strategies on Binance spot
and USDT-M futures history under your own API key. The assistant writes the strategy as a JSON config, Janorium's
engine runs it, and every saved backtest opens as a full report on janorium.com.

Like Janorium itself, it only backtests: it never places orders or touches an exchange account.

## Planned setup

1. Sign up at [janorium.com](https://janorium.com) (free) and create an API key under **Settings → API keys**, with
   the `read` and `run` scopes.
2. Add the server to your MCP client. For Claude Desktop (`claude_desktop_config.json`) or Cursor (`~/.cursor/mcp.json`):

   ```json
   {
     "mcpServers": {
       "janorium": {
         "command": "npx",
         "args": ["-y", "janorium-mcp"],
         "env": { "CB_API_KEY": "cbk_your_key_here" }
       }
     }
   }
   ```

   For Claude Code:

   ```bash
   claude mcp add --transport stdio --scope user --env CB_API_KEY=cbk_your_key_here janorium -- npx -y janorium-mcp
   ```

3. Ask: "Backtest a 50/200 EMA golden cross on BTCUSDT 4h since 2020, with fees, and compare it with buy and hold."

Each API key can run 300 backtests per day. Keep the key out of files you commit.

Until the release, an assistant can still write configs for you: give it the
[strategy config reference](https://janorium.com/ai/strategy-config-reference.md) and paste its answer into the
Janorium editor ([guide](https://janorium.com/guides/build-a-strategy-with-ai)).
