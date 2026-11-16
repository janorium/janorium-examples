# janorium-mcp

[`janorium-mcp`](https://www.npmjs.com/package/janorium-mcp) is the [MCP](https://modelcontextprotocol.io) server for
[Janorium](https://janorium.com), published on npm and in the MCP Registry as `com.janorium/mcp`. It lets Claude
Desktop, Claude Code, Cursor or any other MCP client validate, dry-run and backtest crypto strategies on Binance spot
and USDT-M futures history under your own API key. The assistant writes the strategy as a JSON config, Janorium's
engine runs it, and every saved backtest opens as a full report on janorium.com.

Like Janorium itself, it only backtests: it never places orders or touches an exchange account.

## Setup

You need Node.js 20.9 or newer; `npx` downloads and starts the server.

1. Sign up at [janorium.com](https://janorium.com) (free) and create an API key under **Settings → API keys**, with
   the `read` and `run` scopes. The key starts with `cbk_` and is shown once.
2. Add the server to your MCP client.

   **Claude Desktop** (`claude_desktop_config.json`) or **Cursor** (`~/.cursor/mcp.json`):

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

   If Claude Desktop on Windows cannot start `npx`, use `"command": "cmd"` with `"args": ["/c", "npx", "-y", "janorium-mcp"]`.

   **Claude Code:**

   ```bash
   claude mcp add --env CB_API_KEY=cbk_your_key_here --transport stdio --scope user janorium -- npx -y janorium-mcp
   ```

   Keep `--env` away from the server name: right before it, the CLI reads the name as another variable.

3. Ask, for example: "Backtest a 50/200 EMA golden cross on BTCUSDT 4h since 2020, with fees, and compare it with buy
   and hold."

Each API key can run 300 backtests per day. Give the server a key of its own, and keep it out of files you commit.

The full list of tools, the campaign mode for strategy searches and the environment variables are on the
[npm page](https://www.npmjs.com/package/janorium-mcp).
