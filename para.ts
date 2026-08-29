/**
 * Sign-in wallet: pay from a Para embedded wallet instead of a keypair file.
 *
 * For people who do not use crypto. The user signs in at ${API}/app (Google or email), adds USDC by
 * card, and clicks "Connect to your agent": the page exports the Para session and posts it to a
 * one-shot listener on 127.0.0.1 that this file starts. The session is stored next to the keypair
 * (0600) and, on every start, imported into Para's server SDK to sign x402 USDC transfers.
 *
 * Para's server SDK is ~200 MB of dependencies, so it is not a dependency of citable-mcp: the first
 * connect installs it under ~/.config/citable/para with npm. Keypair users never pay that cost.
 */
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { TransactionPartialSigner } from "@solana/kit";
import { getBase64EncodedWireTransaction } from "@solana/kit";

const SERVER_SDK = "@getpara/server-sdk@3.17.0";
const LISTEN_MINUTES = 15;

export type AppConfig = { paraApiKey: string | null; paraEnv: "PROD" | "BETA" | "SANDBOX"; usdcMint: string; cluster?: string };
export type ParaSession = { session: string; address: string; savedAt: string };

let appConfigCache: Promise<AppConfig> | null = null;
export function appConfig(api: string): Promise<AppConfig> {
  return (appConfigCache ??= fetch(`${api}/api/app-config`).then((r) => {
    if (!r.ok) throw new Error(`${api}/api/app-config answered ${r.status}`);
    return r.json() as Promise<AppConfig>;
  }).catch((err) => { appConfigCache = null; throw err; }));
}

export function readSession(file: string): ParaSession | null {
  if (!existsSync(file)) return null;
  try {
    const d = JSON.parse(readFileSync(file, "utf8")) as Partial<ParaSession>;
    return typeof d.session === "string" && d.session.length > 0 ? { session: d.session, address: String(d.address ?? ""), savedAt: String(d.savedAt ?? "") } : null;
  } catch {
    return null;
  }
}

function writeSession(file: string, data: ParaSession) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
}

// --- install ---------------------------------------------------------------------------------
let installPromise: Promise<void> | null = null;
export function ensureParaInstalled(dir: string): Promise<void> {
  if (existsSync(join(dir, "node_modules/@getpara/server-sdk/package.json"))) return Promise.resolve();
  return (installPromise ??= new Promise<void>((resolve, reject) => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const pkg = join(dir, "package.json");
    if (!existsSync(pkg)) writeFileSync(pkg, JSON.stringify({ name: "citable-para", private: true, description: "Para server SDK for citable-mcp's sign-in wallet" }));
    const args = ["install", "--prefix", dir, "--no-audit", "--no-fund", "--ignore-scripts", "--loglevel=error", SERVER_SDK];
    // Under npx, npm_execpath is npm-cli.js: run it with this very node — works on Windows and in GUI
    // hosts whose PATH has no npm. Otherwise fall back to npm on PATH (a shell on Windows, for npm.cmd).
    const cli = process.env.npm_execpath;
    const win = process.platform === "win32";
    const child =
      cli && /npm-cli\.js$/.test(cli)
        ? spawn(process.execPath, [cli, ...args], { stdio: ["ignore", "ignore", "pipe"] })
        : spawn(win ? "npm.cmd" : "npm", win ? args.map((a) => (a === dir ? `"${a}"` : a)) : args, { stdio: ["ignore", "ignore", "pipe"], shell: win });
    let stderr = "";
    child.stderr.on("data", (b) => { stderr += String(b); });
    const timer = setTimeout(() => { child.kill(); reject(new Error("installing the sign-in wallet support took more than 5 minutes")); }, 5 * 60_000);
    child.on("error", (err) => { clearTimeout(timer); reject(new Error(`could not run npm to install sign-in wallet support: ${err.message}`)); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`npm install of ${SERVER_SDK} failed (exit ${code}): ${stderr.trim().slice(-400)}`));
    });
  }).catch((err) => { installPromise = null; throw err; }));
}

// --- signer ----------------------------------------------------------------------------------
type ParaLike = {
  importSession(s: string): Promise<unknown>;
  exportSession(o?: { excludeSigners?: boolean }): Promise<string>;
  isSessionActive(): Promise<boolean>;
  keepSessionAlive(): Promise<boolean>;
  findWalletId(id?: string, o?: { type?: string[] }): string;
  wallets: Record<string, { address?: string }>;
  signMessage(o: { walletId: string; messageBase64: string; canonicalTransaction?: { walletType: string; transactionBase64: string } }): Promise<{ signature?: string; transactionReviewUrl?: string; pendingTransactionId?: string }>;
};

export async function loadParaSigner(opts: { api: string; sessionFile: string; dir: string }): Promise<{ address: string; signer: TransactionPartialSigner }> {
  const saved = readSession(opts.sessionFile);
  if (!saved) throw new Error(`no sign-in session at ${opts.sessionFile}; run citable_connect`);
  await ensureParaInstalled(opts.dir);
  const cfg = await appConfig(opts.api);
  if (!cfg.paraApiKey) throw new Error(`${opts.api} has no sign-in wallet configured`);
  type ParaModule = { Para?: new (env: string, apiKey: string) => ParaLike; default?: new (env: string, apiKey: string) => ParaLike; Environment?: Record<string, string> };
  let mod: ParaModule;
  try {
    mod = (await import(pathToFileURL(join(opts.dir, "node_modules/@getpara/server-sdk/dist/esm/index.js")).href)) as ParaModule;
  } catch (err) {
    throw new Error(`Para's SDK could not load from ${opts.dir} (${err instanceof Error ? err.message : String(err)}). Delete that folder and run citable_connect again`);
  }
  const Para = mod.Para ?? mod.default;
  if (!Para) throw new Error("Para server SDK did not load");
  const env = mod.Environment?.[cfg.paraEnv] ?? cfg.paraEnv;
  const para = new Para(env, cfg.paraApiKey);
  try {
    await para.importSession(saved.session);
  } catch (err) {
    throw new Error(`the saved sign-in session could not be loaded (${err instanceof Error ? err.message : String(err)}) — run citable_connect again`);
  }
  if (!(await para.isSessionActive())) {
    throw new Error("the sign-in session has expired — run citable_connect again (sessions last up to 30 days and renew on use)");
  }
  // Signing already extends a Para session, so explicit renewal is only for long idle stretches:
  // at most once every 12 h, and the renewed export is saved at once so every later start (and any
  // other MCP client sharing the file) picks up the newest session rather than a superseded one.
  let renewedAt = Date.parse(saved.savedAt) || 0;
  const renew = async () => {
    if (Date.now() - renewedAt < 12 * 60 * 60_000) return;
    renewedAt = Date.now();
    try {
      if (await para.keepSessionAlive()) writeSession(opts.sessionFile, { ...saved, session: await para.exportSession(), savedAt: new Date().toISOString() });
    } catch {
      /* renewal is best-effort */
    }
  };
  await renew();
  const walletId = para.findWalletId(undefined, { type: ["SOLANA"] });
  const address = para.wallets[walletId]?.address ?? saved.address;
  if (!address) throw new Error("the signed-in Para account has no Solana wallet");
  // A @solana/kit partial signer over Para's MPC signing — the same calls Para's own kit integration makes.
  const signer = {
    address,
    async signTransactions(transactions: readonly { messageBytes: Uint8Array }[]) {
      await renew();
      const out = [];
      for (const tx of transactions) {
        const res = await para.signMessage({
          walletId,
          messageBase64: Buffer.from(tx.messageBytes).toString("base64"),
          canonicalTransaction: { walletType: "SOLANA", transactionBase64: getBase64EncodedWireTransaction(tx as never) },
        });
        if (!res.signature) throw new Error(`Para held this transfer for review${res.transactionReviewUrl ? ` — approve it at ${res.transactionReviewUrl}` : ""}, then retry`);
        out.push({ [address]: new Uint8Array(Buffer.from(res.signature, "base64")) });
      }
      return out;
    },
  };
  return { address, signer: signer as unknown as TransactionPartialSigner };
}

// --- connect listener -------------------------------------------------------------------------
type Pending = { url: string; port: number; state: string; startedAt: number; close: () => void };
let pending: Pending | null = null;

const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px/1.5 system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1 style="font-size:1.25rem">${title}</h1><p>${body}</p></body>`;

/** Start (or reuse) the one-shot listener the console posts the session to. */
export function startConnect(opts: { api: string; sessionFile: string; examples?: string[]; onSession: (s: ParaSession) => void }): Promise<{ url: string; expiresInMinutes: number }> {
  if (pending && Date.now() - pending.startedAt < LISTEN_MINUTES * 60_000) {
    return Promise.resolve({ url: pending.url, expiresInMinutes: Math.max(1, Math.round(LISTEN_MINUTES - (Date.now() - pending.startedAt) / 60_000)) });
  }
  pending?.close();
  return new Promise((resolve, reject) => {
    const state = randomBytes(16).toString("hex");
    let self: Pending | null = null;
    const server = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/session") {
        let body = "";
        req.on("data", (b) => { body += String(b); if (body.length > 1_000_000) req.destroy(); });
        req.on("end", () => {
          const form = new URLSearchParams(body);
          if (form.get("state") !== state) {
            res.writeHead(403, { "content-type": "text/html; charset=utf-8" });
            return res.end(page("Not connected", "This link has expired or did not come from your agent. Ask the agent to run citable_connect again."));
          }
          const session = form.get("session") ?? "";
          const address = form.get("address") ?? "";
          if (!session || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
            res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
            return res.end(page("Not connected", "The page sent no session or an invalid wallet address. Try again from citable.run/app."));
          }
          const data: ParaSession = { session, address, savedAt: new Date().toISOString() };
          try {
            writeSession(opts.sessionFile, data);
          } catch (err) {
            res.writeHead(500, { "content-type": "text/html; charset=utf-8" });
            return res.end(page("Not connected", `Could not save the session on this computer: ${err instanceof Error ? err.message : String(err)}`));
          }
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
          const examples = (opts.examples ?? []).map((e) => `<li>${esc(e)}</li>`).join("");
          res.end(
            page(
              "Connected ✓",
              `Your agent will now pay from wallet <code>${address.slice(0, 4)}…${address.slice(-4)}</code>. Go back to your agent and ask in plain words — for example:` +
                (examples ? `<ul style="margin:1rem 0;padding-left:1.25rem;line-height:1.7">${examples}</ul>` : "") +
                `<span style="color:#666">Every paid call states its price first; nothing is charged if it fails. You can close this tab.</span>`,
            ),
          );
          opts.onSession(data);
          const done = self;
          if (pending === self) pending = null;
          setTimeout(() => done?.close(), 500);
          return;
        });
        return;
      }
      res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      res.end(page("Waiting", `Waiting for citable.run to connect. Open the link your agent gave you.`));
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const url = `${opts.api}/app?connect=${port}&state=${state}`;
      const timer = setTimeout(() => { server.close(); if (pending?.port === port) pending = null; }, LISTEN_MINUTES * 60_000);
      timer.unref();
      self = pending = { url, port, state, startedAt: Date.now(), close: () => { clearTimeout(timer); server.close(); } };
      resolve({ url, expiresInMinutes: LISTEN_MINUTES });
    });
    server.unref();
  });
}

export function connectPending(): { url: string; expiresInMinutes: number } | null {
  if (!pending) return null;
  const left = LISTEN_MINUTES - (Date.now() - pending.startedAt) / 60_000;
  return left > 0 ? { url: pending.url, expiresInMinutes: Math.max(1, Math.round(left)) } : null;
}
