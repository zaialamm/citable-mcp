#!/usr/bin/env bun
/**
 * Citable MCP server — lets Claude / Cursor / any MCP client call Citable's paid
 * SEO endpoints. Payments happen automatically over x402 (USDC on Solana) from a local wallet;
 * no Citable account, no API key, no OAuth.
 *
 * Config (env):
 *   CITABLE_WALLET     path to a Solana keypair JSON (default ~/.config/citable/agent.json — created on
 *                     first use if missing, so the agent gets a wallet of its own), or the JSON byte array itself
 *   CITABLE_API        base URL (default https://citable.run)
 *   CITABLE_MAX_PRICE  refuse any single call priced above this many USD (default 0.30,
 *                      the dearest call — the guard is inclusive, so the default allows every endpoint)
 *
 *   Sign-in wallet     citable_connect stores a Para session at ~/.config/citable/para-session.json. It wins over the
 *                     default keypair, never over CITABLE_WALLET. Para's SDK installs to ~/.config/citable/para on first connect.
 *
 * Run:  npx -y citable-mcp        (published bin, Node ≥ 20.18; stdio transport)
 *       bun mcp/server.ts         (from the repo)
 * Build the bin: cd mcp && bun build.ts  → dist/server.js
 */
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { wrapFetchWithPayment, decodePaymentResponseHeader, x402Client } from "@x402/fetch";
import { registerExactSvmScheme } from "@x402/svm/exact/client";
import { toClientSvmSigner } from "@x402/svm";
import { createKeyPairSignerFromBytes, generateKeyPairSigner, writeKeyPairSigner } from "@solana/kit";
import { appConfig, connectPending, ensureParaInstalled, loadParaSigner, readSession, startConnect } from "./para";

const API = (process.env.CITABLE_API ?? "https://citable.run").replace(/\/$/, "");
const MAX_PRICE_USD = Number(process.env.CITABLE_MAX_PRICE ?? "0.30");
const DEFAULT_WALLET = `${homedir()}/.config/citable/agent.json`;
const walletEnv = process.env.CITABLE_WALLET?.trim(); // empty counts as unset
const WALLET = (walletEnv || DEFAULT_WALLET).replace(/^~(?=\/)/, homedir()); // mcp.json env is not shell-expanded
const WALLET_FILE = WALLET.startsWith("[") ? "(inline JSON)" : WALLET;
const VERSION = process.env.CITABLE_MCP_VERSION ?? "dev"; // stamped from package.json by build.ts
const PARA_DIR = `${homedir()}/.config/citable/para`; // Para server SDK, installed by the first citable_connect
const PARA_SESSION = `${homedir()}/.config/citable/para-session.json`;

// --- wallet + paying fetch -------------------------------------------------------------
// The agent's wallet: CITABLE_WALLET as a file path or an inline JSON byte array. With nothing set, the
// default file is created when first needed — a fresh keypair only this server uses, so nobody has to hand an
// agent the key to a wallet they keep money in. It starts empty; fund the address with USDC on mainnet.
async function readWallet(raw: string, where: string) {
  try {
    return await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(raw)));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${where} is not a Solana keypair (expected the 64-byte JSON array solana-keygen writes): ${message}`);
  }
}
async function loadOrCreateSigner() {
  if (WALLET.startsWith("[")) return readWallet(WALLET, "CITABLE_WALLET");
  if (existsSync(WALLET)) return readWallet(readFileSync(WALLET, "utf8"), WALLET);
  if (walletEnv) {
    throw new Error(`CITABLE_WALLET=${WALLET} does not exist. Unset it to let citable-mcp create ${DEFAULT_WALLET}, or see ${API}/docs/wallet`);
  }
  // solana-keygen layout (32-byte seed + 32-byte pubkey), mode 0600, parent dirs created. The write refuses
  // to overwrite, so if another MCP client created the file a moment earlier we use that one instead.
  const signer = await generateKeyPairSigner(true);
  try {
    await writeKeyPairSigner(signer, WALLET);
  } catch (err) {
    if (existsSync(WALLET)) return readWallet(readFileSync(WALLET, "utf8"), WALLET);
    throw err;
  }
  console.error(
    `citable mcp: created a new agent wallet at ${WALLET}. Fund ${signer.address} with USDC on Solana mainnet (no SOL needed) — ${API}/docs/wallet` +
      ` (citable-mcp ≤0.3 defaulted to ~/.config/solana/id.json; set CITABLE_WALLET to keep using it)`,
  );
  return signer;
}
// Which wallet pays, resolved on first use so a bare start has no side effects:
//   CITABLE_WALLET set       → that keypair (explicit always wins)
//   sign-in session on disk  → the Para wallet the user connected with citable_connect
//   otherwise                → the default keypair file, created if missing
type Payer = { mode: "keypair" | "sign-in"; address: string; source: string; fetch: ReturnType<typeof wrapFetchWithPayment> };
let payerPromise: Promise<Payer> | null = null;
const resetPayer = () => { payerPromise = null; };
const getPayer = () => {
  if (!payerPromise) {
    const p: Promise<Payer> = resolvePayer().catch((err) => {
      if (payerPromise === p) payerPromise = null; // a rejection must not clobber a payer started after resetPayer()
      throw err;
    });
    payerPromise = p;
  }
  return payerPromise;
};
async function resolvePayer(): Promise<Payer> {
  if (!walletEnv && readSession(PARA_SESSION)) {
    const { address, signer } = await loadParaSigner({ api: API, sessionFile: PARA_SESSION, dir: PARA_DIR });
    return { mode: "sign-in", address, source: PARA_SESSION, fetch: payingFetch(signer) };
  }
  const keypair = await loadOrCreateSigner();
  return { mode: "keypair", address: keypair.address, source: WALLET_FILE, fetch: payingFetch(keypair) };
}
function payingFetch(signer: Parameters<typeof toClientSvmSigner>[0]) {
  const client = registerExactSvmScheme(new x402Client(), { signer: toClientSvmSigner(signer) });
  // Spend guard: drop any payment option above CITABLE_MAX_PRICE (USDC has 6 decimals).
  // If nothing survives the filter the SDK refuses to pay, so an over-priced call fails safely.
  client.registerPolicy((_v, reqs) => reqs.filter((r) => Number(r.amount) / 1e6 <= MAX_PRICE_USD));
  return wrapFetchWithPayment(fetch, client);
}

async function usdcBalance(owner: string): Promise<number | null> {
  try {
    const { usdcMint } = await appConfig(API);
    const r = await fetch(`${API}/api/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTokenAccountsByOwner", params: [owner, { mint: usdcMint }, { encoding: "jsonParsed" }] }),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { error?: unknown; result?: { value?: Array<{ account?: { data?: { parsed?: { info?: { tokenAmount?: { uiAmount?: number | null } } } } } }> } };
    if (j.error || !j.result) return null; // a proxy error (rate limit, upstream down) is "unknown", never "empty"
    return (j.result.value ?? []).reduce((sum, a) => sum + (a.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0), 0);
  } catch {
    return null;
  }
}
// What a funded user can ask for, in their words, with prices — shown by the agent right after funding,
// by citable_prices, and on the "Connected" page in the browser.
export const QUICK_START = [
  "Audit a page for SEO and AI citability — give me a URL ($0.01)",
  "What does example.com rank for, and how big is it? ($0.03 + $0.04)",
  "Is example.com going up or down? Twelve months of rankings, no tracker needed ($0.03)",
  "Keyword ideas with search volumes for a topic, e.g. 'seo api' ($0.06)",
  "Do ChatGPT, Gemini or Perplexity cite my site for '<a question your buyers ask>'? ($0.05 per engine)",
  "What does AI already cite competitor.com for? ($0.25)",
  "Where does my site rank on Google for '<keyword>'? ($0.012)",
];
const quickStart = () => ({
  say: "Ask in plain words, for example:",
  examples: QUICK_START,
  tip: "Every paid call states its price first; failed calls are never charged. citable_prices lists all 17 tools.",
});
// What citable_prices says when the wallet is empty: both ways to fund it, for the agent to put to the user.
function setupOptions(payer: Payer | null, funded: boolean | null) {
  const addr = payer?.address;
  return {
    why:
      funded === null
        ? "The wallet's USDC balance could not be read just now. If the user has not funded it yet, these are the two ways — ask which they want."
        : "Paid tools settle USDC from this wallet and it is empty. Ask the user which way they want to fund it — do not choose for them.",
    signIn:
      payer?.mode === "sign-in"
        ? `Add funds: open ${API}/app (same sign-in) and use Add funds to add a few dollars. The connected wallet is ${addr}.`
        : `No crypto needed: call citable_connect and give the user the link. They sign in at ${API}/app with Google or email, add a few dollars, and click Connect — the agent then pays from that wallet.`,
    keypair:
      payer?.mode === "keypair" && addr
        ? `Already on Solana: send USDC on the Solana network to ${addr} (key file ${payer.source}) from Phantom, Coinbase, Kraken or Binance. No SOL needed. Or set CITABLE_WALLET to a funded keypair file.`
        : "Already on Solana: set CITABLE_WALLET to a funded keypair file, or run citable_connect with reset:true to go back to the default keypair.",
    docs: `${API}/docs/wallet`,
  };
}

async function callPaid(path: string, query: Record<string, string | number | undefined>) {
  const url = new URL(path, API);
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  let res: Response;
  try {
    const payer = await getPayer();
    res = await payer.fetch(url.toString());
  } catch (err) {
    // The x402 client throws when it will not pay: no payment option survived the spend cap,
    // the wallet cannot sign, or the challenge could not be parsed.
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false as const,
      status: 0,
      body: null,
      reason: `payment refused before sending: ${message}. Check CITABLE_MAX_PRICE (currently $${MAX_PRICE_USD}) and the wallet's USDC balance — citable_prices shows both and how to fund.`,
      payment: null,
    };
  }
  const text = await res.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = text; }
  const settlement = res.headers.get("PAYMENT-RESPONSE");
  const payment = settlement ? decodePaymentResponseHeader(settlement) : null;
  if (!res.ok) {
    const reason = res.status === 402 ? "payment was not accepted (insufficient USDC, price above CITABLE_MAX_PRICE, or facilitator error)" : "request failed";
    return { ok: false as const, status: res.status, body, reason, payment };
  }
  return { ok: true as const, status: res.status, body, payment };
}

const asText = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });
const asError = (v: unknown) => ({ ...asText(v), isError: true });

function result(r: Awaited<ReturnType<typeof callPaid>>) {
  if (!r.ok) return asError({ error: r.reason, status: r.status, response: r.body });
  const body = typeof r.body === "object" && r.body ? { ...(r.body as object) } : { data: r.body };
  return asText({ ...body, _payment: r.payment ? { transaction: r.payment.transaction, network: r.payment.network, payer: r.payment.payer } : null });
}

// --- server -------------------------------------------------------------------------------
const INSTRUCTIONS = [
  "Citable is pay-per-call: every tool except citable_prices and citable_connect settles a few cents of USDC on Solana from a wallet on this machine. The price is in each tool's description; failed calls are never charged.",
  "Before the first paid call, run citable_prices and read `funded`. If the wallet is empty, ask the user which setup they want — do not choose for them:",
  "  1. Sign in (no crypto knowledge needed): call citable_connect and give the user the link. They sign in at citable.run with Google or email, add a few dollars, and click Connect; the agent then pays from that wallet.",
  "  2. Keypair (already uses Solana): they send USDC on the Solana network to the address citable_prices shows, or set CITABLE_WALLET to a funded keypair file.",
  "Once the wallet is funded (citable_prices → funded:true, or citable_connect → connected:true), show the user the `quickStart` examples from that response so they know what they can ask for — then wait for them to choose.",
  "State the price before every paid call and the running total after.",
].join("\n");
const server = new McpServer({ name: "citable", version: VERSION }, { instructions: INSTRUCTIONS });

server.registerTool(
  "citable_prices",
  {
    title: "Citable — endpoints and prices",
    description:
      "Free. Lists Citable's SEO endpoints with current per-call USDC prices, plus the wallet that pays: address (the one to fund), " +
      "walletMode (keypair or sign-in), balanceUsdc and funded. When it is empty, `setup` gives the two ways to fund it — put them to the user. Call this first.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async () => {
    try {
      const res = await fetch(`${API}/api`);
      const index = (await res.json()) as Record<string, unknown>;
      let payer: Payer | null = null;
      let walletError: string | undefined;
      try {
        payer = await getPayer();
      } catch (err) {
        walletError = err instanceof Error ? err.message : String(err);
      }
      const balance = payer ? await usdcBalance(payer.address) : null;
      const funded = balance === null ? null : balance > 0;
      return asText({
        api: API,
        wallet: payer?.address ?? null,
        walletMode: payer?.mode ?? null,
        walletFile: payer?.source ?? null,
        ...(walletError ? { walletError } : {}),
        balanceUsdc: balance,
        funded,
        maxPricePerCallUsd: MAX_PRICE_USD,
        ...(funded === true ? { quickStart: quickStart() } : { setup: setupOptions(payer, funded) }),
        ...index,
      });
    } catch (err) {
      return asError({ error: `Could not reach ${API}/api: ${err instanceof Error ? err.message : String(err)}` });
    }
  },
);

server.registerTool(
  "citable_connect",
  {
    title: "Citable — connect a sign-in wallet (no crypto needed)",
    description:
      "Free. For people who do not use crypto. Returns a link to open in a browser: sign in at Citable with Google or email, " +
      "add a few dollars of USDC, click Connect — the agent then pays from that wallet. The link works for 15 minutes; when the user says " +
      "it is done, call citable_prices to confirm (walletMode becomes sign-in). {status:true} only reports; {reset:true} disconnects " +
      "and returns to the keypair. The first connect installs Para's SDK under ~/.config/citable/para (about 200 MB, once).",
    inputSchema: {
      status: z.boolean().optional().describe("Only report the current state; do not start a new connection"),
      reset: z.boolean().optional().describe("Forget the sign-in session and pay from the keypair again"),
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  async ({ status, reset }) => {
    if (reset) {
      if (existsSync(PARA_SESSION)) unlinkSync(PARA_SESSION);
      resetPayer();
      return asText({ connected: false, note: "Sign-in session removed. Paid calls use the keypair again; run citable_prices to see it." });
    }
    if (walletEnv) return asText({ connected: false, note: "CITABLE_WALLET is set, so that keypair always pays. Unset it to use a sign-in wallet." });
    const saved = readSession(PARA_SESSION);
    if (saved) {
      // Prove the saved session still loads; a stale one (expired, or Para could not import it) is dropped so a fresh connect can start.
      try {
        const payer = await getPayer();
        return asText({
          connected: true,
          address: payer.address,
          since: saved.savedAt,
          note: "Connected. Pass reset:true to disconnect, then call again to connect a different account.",
          quickStart: quickStart(),
        });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        if (status) return asText({ connected: false, stale: true, error });
        unlinkSync(PARA_SESSION);
        resetPayer();
      }
    }
    if (status) {
      const p = connectPending();
      return asText(p ? { connected: false, pending: true, ...p } : { connected: false, pending: false });
    }
    ensureParaInstalled(PARA_DIR).catch(() => {}); // warm up while the user signs in; a failure resurfaces on first use
    try {
      const { url, expiresInMinutes } = await startConnect({ api: API, sessionFile: PARA_SESSION, examples: QUICK_START, onSession: () => resetPayer() });
      return asText({
        connected: false,
        url,
        expiresInMinutes,
        tellTheUser: `Open ${url} — sign in with Google or email, add a few dollars of USDC, then click "Connect to your agent". Come back here when the page says Connected.`,
        then: "Call citable_prices: walletMode will be sign-in and balanceUsdc the amount added.",
        note: "The browser must be on this same computer. Para's SDK (about 200 MB) installs in the background meanwhile; if the first paid call afterwards takes up to a minute, that is why.",
      });
    } catch (err) {
      return asError({ error: `Could not start the connect listener: ${err instanceof Error ? err.message : String(err)}` });
    }
  },
);

server.registerTool(
  "citable_keyword_suggest",
  {
    title: "Citable — keyword suggestions",
    description:
      "Paid ($0.005 USDC per call). Expands a seed keyword into autocomplete suggestions, related queries and questions, " +
      "deduped and ranked across Google, YouTube and Bing. Returns `suggestions[]` and `questions[]` with a 0–1 " +
      "prominence score, the sources each came from, and whether the keyword still contains the seed.",
    inputSchema: {
      seed: z.string().min(1).max(80).describe("Seed keyword — a topic or phrase people type, e.g. 'solana rpc'. Not a domain: for the keywords a site ranks for use citable_domain_keywords"),
      lang: z.string().regex(/^[a-z]{2}(-[a-z]{2,4})?$/i).optional().describe("Language code (default en)"),
      country: z.string().length(2).optional().describe("Country code (default us)"),
      depth: z.number().int().min(0).max(2).optional().describe("0 seed only · 1 + questions/modifiers · 2 (default) + a–z sweep"),
      limit: z.number().int().min(1).max(300).optional().describe("Max keywords per list (default 100)"),
      sources: z.string().optional().describe("Comma list of google,youtube,bing (default all)"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (args) => result(await callPaid("/v1/keyword-suggest", args)),
);

server.registerTool(
  "citable_onpage_audit",
  {
    title: "Citable — on-page SEO audit",
    description:
      "Paid ($0.01 USDC per call). Fetches one URL and returns a scored on-page audit: title, meta description, canonical, " +
      "robots, viewport, lang, heading counts and text, word count, internal/external links, image alt coverage, " +
      "Open Graph, JSON-LD types, HTTP details, and 15 weighted checks with a 0–100 score. Not charged if the page cannot be fetched.",
    inputSchema: {
      url: z.string().min(3).describe("Absolute http(s) URL of one page to audit — not a bare domain; for a domain-level view use citable_domain_overview or citable_citability_report"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ url }) => result(await callPaid("/v1/onpage-audit", { url })),
);

server.registerTool(
  "citable_ai_visibility",
  {
    title: "Citable — AI-visibility check",
    description:
      "Paid ($0.05 USDC per engine asked; $0.20 for all four). Asks the AI answer engines (Perplexity, Gemini, OpenAI, Claude — whichever the deployment has " +
      "configured) a prompt through their official APIs and reports which ones cite the domain: `mentioned`, 1-based " +
      "`position` in each engine's citation list, and the full cited-domain list per engine. One run per engine — answers " +
      "vary between runs, so call 2–3 times for signal. Not charged if no engine answers.",
    inputSchema: {
      prompt: z.string().min(3).max(400).describe("The question a buyer would ask, supplied by the user — never invented (citable_cited_prompts returns observed ones), e.g. 'best solana rpc provider'"),
      domain: z.string().min(4).max(253).describe("Hostname to look for in the citations, e.g. example.com"),
      engines: z.string().optional().describe("Comma list of perplexity,gemini,openai,anthropic (default: all configured)"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (args) => result(await callPaid("/v1/ai-visibility", args)),
);

server.registerTool(
  "citable_rank_check",
  {
    title: "Citable — Google rank check",
    description:
      "Paid ($0.012 USDC per call). Google organic position of a domain for a keyword via a licensed SERP feed: 1-based " +
      "`position` (null if outside the checked window), the ranking URL and title, plus the top-10 result list. " +
      "Not charged if the feed is unavailable.",
    inputSchema: {
      keyword: z.string().min(1).max(120).describe("Search query, e.g. 'solana rpc'"),
      domain: z.string().min(4).max(253).describe("Hostname to find, e.g. example.com"),
      gl: z.string().length(2).optional().describe("Country code (default us)"),
      hl: z.string().regex(/^[a-z]{2}(-[a-z]{2,4})?$/i).optional().describe("Language code (default en)"),
      num: z.number().int().min(10).max(50).optional().describe("Results window to check (default 20)"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (args) => result(await callPaid("/v1/rank-check", args)),
);

server.registerTool(
  "citable_keyword_research",
  {
    title: "Citable — everything about one keyword, in one call",
    description:
      "Paid ($0.06 USDC per call). One seed returns keywords AND questions, merged from public " +
      "autocomplete and the paid keyword index, with search volume, CPC, difficulty and intent " +
      "attached. Each row says which sources found it — both is the strongest signal. Cheaper than " +
      "citable_keyword_ideas plus citable_keyword_metrics separately; reach for those only when you " +
      "want to control exactly what you pay for. Not charged on failure.",
    inputSchema: {
      seed: z.string().min(1).max(80).describe("Keyword to research — a topic, not a domain, e.g. 'reksadana'"),
      country: z.string().length(2).optional().describe("Country code (default us)"),
      lang: z.string().length(2).optional().describe("Language code (default en)"),
      limit: z.number().int().min(1).max(200).optional().describe("Rows per list (default 100)"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (args) => result(await callPaid("/v1/keyword-research", args)),
);

server.registerTool(
  "citable_keyword_ideas",
  {
    title: "Citable — keyword research from a seed",
    description:
      "Paid ($0.05 USDC per call). Keyword research: one seed returns up to 100 keywords that contain it, each " +
      "with search volume, CPC, competition, difficulty and intent, ordered by volume. Full-text matched, so " +
      "results stay on topic. Use citable_keyword_suggest for the exact phrasings people type (no volume), and " +
      "citable_keyword_metrics when you already have a shortlist. Not charged on failure.",
    inputSchema: {
      seed: z.string().min(1).max(80).describe("Keyword to research — a topic, not a domain, e.g. 'seo api'"),
      limit: z.number().int().min(1).max(100).optional().describe("Ideas to return (default 50)"),
      country: z.string().length(2).optional().describe("Country code (default us)"),
      lang: z.string().length(2).optional().describe("Language code (default en)"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (args) => result(await callPaid("/v1/keyword-ideas", args)),
);

server.registerTool(
  "citable_keyword_metrics",
  {
    title: "Citable — keyword volume & difficulty",
    description:
      "Paid ($0.03 USDC per call, covers the whole batch). Search volume, CPC, competition, keyword difficulty and " +
      "search intent for 1–20 keywords — licensed clickstream-derived estimates. Answers in request order; unknown " +
      "keywords return null metrics. Pair with citable_keyword_suggest: expand a seed there, price the shortlist here. " +
      "Not charged if the metrics feed is unavailable.",
    inputSchema: {
      keywords: z.string().min(1).describe("Comma list of 1–20 keywords, e.g. 'solana rpc,best launchpad'"),
      country: z.string().length(2).optional().describe("Country code (default us)"),
      lang: z.string().length(2).optional().describe("Language code (default en)"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (args) => result(await callPaid("/v1/keyword-metrics", args)),
);

server.registerTool(
  "citable_top_cited_pages",
  {
    title: "Citable — top AI-cited pages of a domain",
    description:
      "Paid ($0.22 USDC per call). Which pages of a domain AI engines cite most, from an aggregated index of AI " +
      "answers — per-page mentions, AI search volume, per-engine and per-language splits, plus domain totals. " +
      "Answers 'what already works on this site — write more of that'. Not charged if the index is unavailable.",
    inputSchema: {
      domain: z.string().min(3).describe("Domain to inventory, e.g. example.com"),
      limit: z.number().int().min(1).max(25).optional().describe("Pages to return (default 10)"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (args) => result(await callPaid("/v1/top-cited-pages", args)),
);

server.registerTool(
  "citable_citability_report",
  {
    title: "Citable — full citability report (bundle)",
    description:
      "Paid ($0.30 USDC per call; $0.43 bought separately). One call bundles the on-page citability audit, " +
      "AI visibility across all configured engines, and the domain's top AI-cited pages. Answers: can AI read " +
      "this site, who cites it today, and which pages already work. Not charged on failure.",
    inputSchema: {
      domain: z.string().min(3).describe("Domain to report on, e.g. example.com"),
      prompt: z.string().min(3).max(400).describe("REQUIRED: the buyer question to ask the engines — supplied by the user, never invented"),
      limit: z.number().int().min(1).max(25).optional().describe("Top cited pages to include (default 10)"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (args) => result(await callPaid("/v1/citability-report", args)),
);

server.registerTool(
  "citable_cited_prompts",
  {
    title: "Citable — prompts a domain is already cited for",
    description:
      "Paid ($0.25 USDC per call). The real questions AI answer engines cite a domain for, from an aggregated " +
      "index of AI answers — question, answer snippet, AI search volume, and the exact URL cited. These are " +
      "observed prompts, never generated ones, so use this to discover what to track instead of inventing " +
      "them. Repeated observations of one question are collapsed, with `observations` counting them. " +
      "Point it at a competitor's domain to get the prompts they win and you do not. Not charged on failure.",
    inputSchema: {
      domain: z.string().min(3).describe("Domain to look up, e.g. example.com — or a competitor's"),
      limit: z.number().int().min(1).max(50).optional().describe("Prompts to return (default 10)"),
      platform: z.enum(["chat_gpt", "google"]).optional().describe("Restrict to one engine (default: both)"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (args) => result(await callPaid("/v1/cited-prompts", args)),
);

server.registerTool(
  "citable_ai_mentions_trend",
  {
    title: "Citable — monthly AI-mention trend for a domain",
    description:
      "Paid ($0.18 USDC per call). Stateless prompt tracking: monthly AI mentions and AI search volume for a " +
      "domain with month-over-month deltas and a direction summary. No tracker to create and nothing to poll — " +
      "one call returns the whole series. The index starts 2025-08-01. Not charged on failure.",
    inputSchema: {
      domain: z.string().min(3).describe("Domain to track, e.g. example.com"),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Start date yyyy-mm-dd (clamped to 2025-08-01)"),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("End date yyyy-mm-dd"),
      platform: z.enum(["chat_gpt", "google"]).optional().describe("Restrict to one engine (default: both)"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (args) => result(await callPaid("/v1/ai-mentions-trend", args)),
);

server.registerTool(
  "citable_ai_share_of_voice",
  {
    title: "Citable — AI share of voice across a competitive set",
    description:
      "Paid ($0.18 USDC per call, whatever the set size). Compare 2–10 domains inside the AI-answer index: " +
      "mentions, AI search volume, and each domain's share of the compared set, with per-engine and per-language " +
      "splits. Share is of the set you asked about, not of the whole index. Not charged on failure.",
    inputSchema: {
      domains: z.string().min(5).describe("Comma list of 2–10 hostnames, e.g. you.com,rival.com,other.com"),
      platform: z.enum(["chat_gpt", "google"]).optional().describe("Restrict to one engine (default: both)"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (args) => result(await callPaid("/v1/ai-share-of-voice", args)),
);

server.registerTool(
  "citable_domain_overview",
  {
    title: "Citable — domain organic footprint",
    description:
      "Paid ($0.03 USDC per call). One domain's organic footprint from a ranking index: keywords ranked, " +
      "top-3/top-10 counts, estimated monthly traffic and its ad value, plus the paid-search side. " +
      "The first call for any domain question; then citable_domain_keywords for what it ranks for. Not charged on failure.",
    inputSchema: {
      domain: z.string().min(3).describe("Hostname to profile, e.g. example.com"),
      country: z.string().length(2).optional().describe("Country code (default us)"),
      lang: z.string().length(2).optional().describe("Language code (default en)"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (args) => result(await callPaid("/v1/domain-overview", args)),
);

server.registerTool(
  "citable_domain_keywords",
  {
    title: "Citable — the keywords a domain ranks for",
    description:
      "Paid ($0.04 USDC per call). The keywords a domain actually ranks for — volume, CPC, position, month-over-month movement (previousPosition, change, status) and the " +
      "ranking URL, highest volume first, with the index's total count. Point it at a competitor for their " +
      "playbook. Not charged on failure.",
    inputSchema: {
      domain: z.string().min(3).describe("Hostname to inventory, e.g. example.com — a competitor's works too"),
      limit: z.number().int().min(1).max(100).optional().describe("Keywords to return (default 25)"),
      country: z.string().length(2).optional().describe("Country code (default us)"),
      lang: z.string().length(2).optional().describe("Language code (default en)"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (args) => result(await callPaid("/v1/domain-keywords", args)),
);

server.registerTool(
  "citable_domain_history",
  {
    title: "Citable — a domain's footprint month by month",
    description:
      "Paid ($0.03 USDC per call). How a domain's organic footprint has moved, month by month (up to `months`; the current month may be partial), from the ranking index: keywords ranked, " +
      "top-10 count, estimated traffic and value, and how many keywords were new, up, down or lost each month, plus a first-to-last trend. " +
      "The stateless way to track rankings — nothing is stored, the index keeps the history. Monthly resolution; for one keyword's position today use citable_rank_check. Not charged on failure.",
    inputSchema: {
      domain: z.string().min(3).describe("Hostname to track, e.g. example.com"),
      months: z.number().int().min(2).max(24).optional().describe("Calendar months of history, 2–24 (default 12)"),
      country: z.string().length(2).optional().describe("Country code (default us)"),
      lang: z.string().length(2).optional().describe("Language code (default en)"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (args) => result(await callPaid("/v1/domain-history", args)),
);

server.registerTool(
  "citable_serp",
  {
    title: "Citable — raw Google results page",
    description:
      "Paid ($0.008 USDC per call). The raw Google results page for a keyword: organic results with snippets, " +
      "plus People-Also-Ask questions and related searches when present. rank-check answers where am I; " +
      "this answers what the page looks like. Not charged on failure.",
    inputSchema: {
      keyword: z.string().min(1).max(120).describe("Search query — a phrase people type, not a domain"),
      gl: z.string().length(2).optional().describe("Country code (default us)"),
      hl: z.string().optional().describe("Language code (default en)"),
      num: z.number().int().min(10).max(50).optional().describe("Results depth (default 10)"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (args) => result(await callPaid("/v1/serp", args)),
);

server.registerTool(
  "citable_backlinks",
  {
    title: "Citable — backlink profile and top referring domains",
    description:
      "Paid ($0.10 USDC per call). Link profile in one call: total backlinks, referring domains, domain rank, " +
      "broken links and nofollow share, plus the top referring domains with first-seen dates. The " +
      "link-prospecting starting point. Not charged on failure.",
    inputSchema: {
      domain: z.string().min(3).describe("Hostname to profile, e.g. example.com"),
      limit: z.number().int().min(1).max(25).optional().describe("Referring domains to return (default 10)"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (args) => result(await callPaid("/v1/backlinks", args)),
);

await server.connect(new StdioServerTransport());
// Exit when the client closes stdin. Para's SDK keeps timers alive once a sign-in session is loaded,
// so without this the process would outlive a client that only closes the pipe.
server.server.onclose = () => process.exit(0);
console.error(`citable mcp ${VERSION}: api=${API} wallet=${walletEnv ? WALLET_FILE : readSession(PARA_SESSION) ? `sign-in (${PARA_SESSION})` : WALLET_FILE} maxPrice=$${MAX_PRICE_USD}`);
