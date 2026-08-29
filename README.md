# citable-mcp

MCP server for [Citable](https://citable.run) — SEO and AI-visibility data an agent can buy
by the call. Each tool pays for itself in USDC on Solana over [x402](https://x402.org) from a
wallet on your machine: no account, no API key, no subscription. $0.005–0.30 per call, and a
failed call is never charged.

The code that signs those payments is in this repo — `server.ts` is the whole server.

## Install

```bash
claude mcp add citable -- npx -y citable-mcp     # Claude Code
codex mcp add citable -- npx -y citable-mcp      # Codex
```

Cursor, Claude Desktop, or any MCP client — `mcp.json`:

```json
{
  "mcpServers": {
    "citable": {
      "command": "npx",
      "args": ["-y", "citable-mcp"],
      "env": { "CITABLE_MAX_PRICE": "0.30" }
    }
  }
}
```

Node ≥ 20.18, or `bunx citable-mcp`.

## Wallet

Start with `citable_prices` — it reports the wallet, its balance, and how to fund it. Two ways:

- **Sign in, no crypto needed.** `citable_connect` returns a link: sign in at citable.run with
  Google or email, add a few dollars, click Connect. The agent then pays from that wallet.
- **Keypair, if you already use Solana.** With nothing configured the server creates
  `~/.config/citable/agent.json` on first need and shows the address. Send it USDC on Solana —
  no SOL required, the x402 facilitator covers the network fee — or point `CITABLE_WALLET` at
  a funded keypair.

Walkthrough: https://citable.run/docs/wallet

## Config

| Env | Default | Meaning |
|---|---|---|
| `CITABLE_WALLET` | `~/.config/citable/agent.json` | keypair JSON path, or the JSON byte array itself, holding mainnet USDC. Created when first needed |
| `CITABLE_MAX_PRICE` | `0.30` | refuse any single call priced above this many USD; nothing is signed |
| `CITABLE_API` | `https://citable.run` | base URL |

## Tools

| Tool | Price | Returns |
|---|---|---|
| `citable_prices` | free | endpoints, prices, wallet, balance, spend cap — call this first |
| `citable_connect` | free | a sign-in link for funding without touching crypto |
| `citable_keyword_suggest` | $0.005 | autocomplete expansions and questions for a seed |
| `citable_serp` | $0.008 | the Google results page for a keyword |
| `citable_onpage_audit` | $0.01 | citability score for one URL, 20 checks, ordered fixes |
| `citable_rank_check` | $0.012 | where a domain ranks on Google for a keyword, plus the top 10 |
| `citable_keyword_metrics` | $0.03 | volume, CPC, competition, difficulty and intent for 1–20 keywords |
| `citable_domain_overview` | $0.03 | a domain's organic footprint: keywords ranked, top positions, traffic |
| `citable_domain_history` | $0.03 | that footprint month by month |
| `citable_domain_keywords` | $0.04 | the keywords a domain ranks for, with month-over-month movement |
| `citable_keyword_ideas` | $0.05 | related keywords for a seed, with volume and difficulty |
| `citable_ai_visibility` | $0.05/engine | which AI engines cite a domain for your question, and who they cite instead |
| `citable_keyword_research` | $0.06 | one seed → keywords and questions, merged and priced |
| `citable_backlinks` | $0.10 | backlink totals, referring domains, domain rank |
| `citable_ai_mentions_trend` | $0.18 | monthly AI mentions for a domain, with the trend |
| `citable_ai_share_of_voice` | $0.18 | 2–10 domains compared inside the AI-answer index |
| `citable_top_cited_pages` | $0.22 | the domain's pages AI answers cite most |
| `citable_cited_prompts` | $0.25 | the real questions AI engines already cite a domain for |
| `citable_citability_report` | $0.30 | audit + AI visibility + top cited pages in one call ($0.43 apart) |

Every paid result carries `_payment.transaction`, the on-chain settlement. A call above the
cap, or without funds, returns a structured error and pays nothing.

## How a call works

1. The tool requests the endpoint. Citable answers `402` with the price, the USDC mint and
   the pay-to address.
2. The server signs a USDC transfer for exactly that amount — only if it is at or below
   `CITABLE_MAX_PRICE` — and retries with the payment header.
3. The facilitator settles on Solana in about 400 ms and the endpoint returns `200`.

The keypair is read from disk and used only to sign these transfers. Nothing else leaves
your machine, and Citable stores nothing about you: the wallet is the only identity.

## Build

```bash
bun install
bun build.ts        # → dist/server.js, the published bin
```

MIT.
