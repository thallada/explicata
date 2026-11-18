/**
 * The local server. It does three small things:
 *   - relays each library's updates between replicas (tabs, people, agents) and keeps a copy on disk
 *   - holds the API key and proxies model calls
 *   - exposes the op API over HTTP, so an outside agent can read and edit a library
 * In development it also hosts Vite; in production it serves the built files.
 *
 * There are several libraries, each a database of its own (libraries.ts): /api/libraries lists,
 * makes, renames and deletes them, and /api/l/<id>/… acts on one of them (bundle.ts), the same
 * routes without the prefix on the first. See README.md for the list.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { userInfo } from "node:os";
import { extname, join, resolve } from "node:path";
import { writeSeed } from "../src/core/seed";
import { mockLLM } from "../src/llm/mock";
import { LLMUnavailable, type JsonReq, type LLM, type Req, type TurnReq } from "../src/llm/types";
import { seed } from "../src/seed/tree";
import { Bundle, type Shared } from "./bundle";
import { claudeLLM, describeError } from "./claude";
import { CSP } from "./csp";
import { Libraries, NeedsMigration, importStarters } from "./libraries";
import { lockHolder, takeLock } from "./lock";
import { SubscriptionError, queryPlanUsage, subscriptionLLM } from "./subscription";
import { usage, withMockUsage } from "./usage";
import { HttpError, ROOT as root, abortOnClose, dataDir, readJson, sendJson as json } from "./util";
import { PageClient, pages } from "./page";
import { makeMockPageFetch } from "./pageMock";
import { Arranger, arrangeMode, serverBudget } from "./pageArrange";
import { pageOff, pageRoutes } from "./pageRoutes";
import { applyWebPolicy, webConfig } from "./web";
import { WikiClient, validContact, wiki, wikiLang } from "./wiki";
import { makeMockWikiFetch } from "./wikiMock";
import { wikiOff, wikiRoutes } from "./wikiRoutes";
import { embedder } from "./embed";
import { JOB_CALLS } from "./links/review";

const PORT = Number(process.env.PORT ?? 4747);
// Host names the dev server answers to besides localhost. Tailscale names are allowed so that
// `tailscale serve` works; EX_HOSTS adds more (comma-separated; a leading dot matches subdomains).
const ALLOWED_HOSTS = [".ts.net", ...(process.env.EX_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean)];
const DATA = dataDir();
const PROD = process.env.EX_PROD === "1";
const MODEL = process.env.EX_MODEL ?? "claude-opus-5-5";
const USER = process.env.EX_USER ?? userInfo().username;
const LIBRARY = resolve(process.env.EX_LIBRARY ?? join(root, "library"));

// ---- model ----

// A subscription token (from `claude setup-token`) is not an API key. If one was put in
// ANTHROPIC_API_KEY, move it to where Claude Code looks for it, and take it out of
// ANTHROPIC_API_KEY: an API key in the environment would outrank the token.
if (process.env.ANTHROPIC_API_KEY?.startsWith("sk-ant-oat")) {
  process.env.CLAUDE_CODE_OAUTH_TOKEN ??= process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  console.log("ANTHROPIC_API_KEY holds a subscription token; using it as CLAUDE_CODE_OAUTH_TOKEN instead.");
}
const apiKey = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const wanted = process.env.EX_LLM ?? (apiKey ? "claude" : process.env.CLAUDE_CODE_OAUTH_TOKEN ? "subscription" : "off");
const llm: LLM | null =
  wanted === "claude" ? claudeLLM(MODEL)
  : wanted === "subscription" ? subscriptionLLM(MODEL)
  : wanted === "mock" ? withMockUsage(mockLLM({ delay: Number(process.env.EX_MOCK_DELAY ?? 12) }))
  : null;

// Usage: every provider reports into one tracker (server/usage.ts), served at GET /api/usage.
usage.configure(llm ? (wanted === "claude" ? "api" : wanted === "subscription" ? "subscription" : "mock") : null, llm?.model ?? null);
// On the subscription route, ask once for the plan's windows so the footer has them before the
// first call. This is a usage lookup, not a model call.
if (wanted === "subscription") {
  void queryPlanUsage(MODEL).then((r) => {
    if (r?.rate_limits) usage.recordPlanQuery(r.rate_limits);
  });
}

// ---- web research for the editor agent ----

// EX_WEB=off takes web search and fetch away from the agent entirely; EX_WEB_SEARCHES and
// EX_WEB_FETCHES cap each run (default 5 and 5). The browser asks for research; this decides.
const web = webConfig(process.env, Boolean(llm));
if (process.env.EX_WEB && !web.on && web.why) console.warn(`web research is off: ${web.why}.`);

// ---- Wikipedia ----

// EX_WIKI picks where /api/wiki/* gets its answers: the real Wikipedia (live), the fixtures in
// server/wikiMock.ts (mock: tests and offline work, no network at all), or nowhere (off). An
// unrecognised value is treated as off, so a typo never sends requests nobody asked for.
type WikiMode = "live" | "mock" | "off";
const wikiWanted = process.env.EX_WIKI ?? "live";
const wikiMode: WikiMode = wikiWanted === "live" || wikiWanted === "mock" ? wikiWanted : "off";
if (wikiMode !== wikiWanted) console.warn(`EX_WIKI=${wikiWanted} is not live, mock or off; Wikipedia is off.`);
// The mock keeps nothing on disk and never holds itself offline, so one test's "offline" title
// does not leak into the next.
const mockWiki = wikiMode === "mock" ? new WikiClient({ lang: process.env.EX_WIKI_LANG, fetch: makeMockWikiFetch(undefined, Number(process.env.EX_WIKI_MOCK_BULK_MS) || 0), spacingMs: 0, mediaSpacingMs: 0, persist: false, offlineHoldMs: 0 }) : null;
const wikiClient = () => (wikiMode === "off" ? null : (mockWiki ?? wiki()));
const handleWiki = wikiMode === "off" ? wikiOff : wikiRoutes(() => wikiClient()!);
/** What the UI may know: the mode, the language, and whether a contact is set (never the contact). */
const wikiState = { mode: wikiMode, lang: wikiLang(process.env.EX_WIKI_LANG), contact: validContact(process.env.EX_WIKI_CONTACT) !== null };

// ---- web pages ----

// EX_PAGES picks where /api/page/* reads pages from: the web (live), the fixtures in
// server/pageMock.ts (mock: tests and offline work, no network at all), or nowhere (off). As with
// EX_WIKI, an unrecognised value is off. Only a page a person opens is ever read.
type PageMode = "live" | "mock" | "off";
const pagesWanted = process.env.EX_PAGES ?? "live";
const pageMode: PageMode = pagesWanted === "live" || pagesWanted === "mock" ? pagesWanted : "off";
if (pageMode !== pagesWanted) console.warn(`EX_PAGES=${pagesWanted} is not live, mock or off; reading web pages is off.`);
// The mock keeps its snapshots in memory only, so each run starts from nothing read.
const mockPages = pageMode === "mock" ? new PageClient({ fetch: makeMockPageFetch(), spacingMs: 0, persist: false }) : null;
// Arranging a page with a model: at the reader's request (s on a page), and by itself, once, for a
// page with no headings of its own (divided by length) when it is first read. Through the shared
// model, within EX_PAGE_CALLS calls a day for the whole server (default 20, counted in
// <EX_DATA>/page-calls.json), and never while the plan's limits are nearly used.
// EX_PAGES_ARRANGE=manual leaves it to s alone; EX_PAGES_ARRANGE=off turns it off.
const { on: arrangeOn, auto: arrangeAuto } = arrangeMode(process.env);
const arranger = new Arranger({ pages: () => mockPages ?? pages(), llm: () => llm, on: arrangeOn, auto: arrangeAuto, budget: serverBudget(process.env, DATA), plan: () => usage.summary().plan });
const handlePages = pageMode === "off" ? pageOff : pageRoutes(() => mockPages ?? pages(), () => arranger);

/** A short reason for a failed model call, whichever provider made it. */
const explain = (err: unknown) => (err instanceof SubscriptionError ? { status: err.status, message: err.message } : describeError(err));

// ---- the libraries on disk ----

mkdirSync(DATA, { recursive: true });
const started = performance.now();
// A data directory in an older layout is never opened, nor migrated without being asked: the
// migration (npm run migrate) has a dry run and verifies what it writes.
const held = lockHolder(DATA);
if (held) {
  console.error(`Another server (pid ${held.pid}${held.port ? `, port ${held.port}` : ""}) has ${DATA} open; stop it first, or set EX_DATA to another directory.`);
  process.exit(1);
}
const libraries = new Libraries(DATA);
try {
  libraries.open((doc) => {
    writeSeed(doc, readFileSync(join(root, "src/seed/prompt.txt"), "utf8"), seed);
    console.log("seeded the first tree from src/seed");
    importStarters(doc, LIBRARY);
  });
} catch (err) {
  if (!(err instanceof NeedsMigration)) throw err;
  console.error(err.message);
  process.exit(1);
}
takeLock(DATA, PORT);
const startMs = Math.round(performance.now() - started);

// ---- each library's link discovery, notices and routes (server/bundle.ts) ----

// The embedding model is loaded on first use, in a worker thread shared by every library;
// EX_EMBED=off turns it off, and scanning then matches by text alone.
const embed = process.env.EX_EMBED === "off" ? null : embedder();
const shared: Shared = {
  llm: () => llm,
  wiki: wikiClient,
  embed,
  reviewCalls: Math.max(1, Number(process.env.EX_REVIEW_CALLS) || JOB_CALLS),
  user: USER,
  state: () => ({
    user: USER,
    llm: llm?.kind ?? "off",
    model: llm?.model ?? null,
    wiki: wikiState,
    pages: { mode: pageMode, arrange: arrangeOn && !!llm },
    embed: embed ? (process.env.EX_EMBED === "fake" ? "fake" : "on") : "off",
    web: { on: web.on, searches: web.searches, fetches: web.fetches },
    libraries: libraries.list(),
  }),
};
const bundles = new Map<string, Bundle>();
for (const [id, store] of libraries.stores) bundles.set(id, new Bundle(store, shared));
// Writes are gathered before they go to disk; whatever is waiting goes on the way out.
process.on("exit", () => {
  for (const b of bundles.values()) b.flush();
});
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(0));

// ---- http plumbing ----

function needLLM(): LLM {
  if (!llm) throw new LLMUnavailable();
  return llm;
}

async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
  const parts = url.pathname.split("/").slice(2).map(decodeURIComponent); // after /api/
  const [a, b] = parts;
  const method = req.method ?? "GET";

  // One library: /api/l/<id>/…, everything that reads or writes a library's content.
  if (a === "l") {
    const bundle = b ? bundles.get(b) : undefined;
    if (!bundle) return json(res, 404, { error: `no library ${b ?? ""}` });
    const rest = parts.slice(2);
    if (await bundle.handle(req, res, rebased(url, rest), rest)) return;
    return json(res, 404, { error: "not found" });
  }

  if (a === "libraries") return librariesApi(req, res, parts.slice(1));

  if (a === "usage" && method === "GET") return json(res, 200, usage.summary());

  if (a === "llm" && method === "POST") {
    const input = await readJson<unknown>(req);
    const signal = abortOnClose(res);
    if (b === "stream") {
      const model = needLLM();
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache", "x-accel-buffering": "no" });
      try {
        await model.stream(input as Req, (delta) => res.write(delta), signal);
      } catch (err) {
        // The status line has gone out already, so a failure is reported in-band after a NUL.
        if (!signal.aborted) {
          const { status, message } = explain(err);
          console.error(`model call failed (${status}): ${message}`);
          res.write(`\u0000${message}`);
        }
      }
      return res.end();
    }
    if (b === "json") return json(res, 200, await needLLM().json(input as JsonReq, signal));
    if (b === "turn") {
      const model = needLLM();
      const req = applyWebPolicy(input as TurnReq, web);
      if (url.searchParams.get("steps") !== "1") return json(res, 200, await model.turn(req, signal));
      // Newline-delimited JSON: each search or page read as it happens, then the turn (or an error).
      res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache", "x-accel-buffering": "no" });
      try {
        const turn = await model.turn(req, signal, (step) => res.write(`${JSON.stringify({ step })}\n`));
        res.write(`${JSON.stringify({ turn })}\n`);
      } catch (err) {
        if (!signal.aborted) {
          const { status, message } = explain(err);
          console.error(`model call failed (${status}): ${message}`);
          res.write(`${JSON.stringify({ error: message, status })}\n`);
        }
      }
      return res.end();
    }
  }

  if (await handleWiki(req, res, url)) return;
  if (await handlePages(req, res, url)) return;

  // Without a library named, the first one: so `curl /api/tree` still reads a library.
  const first = bundles.get(libraries.first().id)!;
  if (await first.handle(req, res, url, parts)) return;

  json(res, 404, { error: "not found" });
}

/** The URL a library's routes see: /api/<rest>, its query kept. */
function rebased(url: URL, rest: string[]): URL {
  const out = new URL(url);
  out.pathname = `/api/${rest.map(encodeURIComponent).join("/")}`;
  return out;
}

/**
 * The libraries:
 *   GET    /api/libraries              → { libraries: [{ id, title, created, nodes, branches }] }, in order
 *   POST   /api/libraries { title }    → 201 { library }: a new library, its root alone, at the end
 *   PATCH  /api/libraries/<id> { title } → { library }: renamed (a commit on its root's title)
 *   DELETE /api/libraries/<id>         → { deleted, movedTo }: moved aside whole; never the last one
 */
async function librariesApi(req: IncomingMessage, res: ServerResponse, parts: string[]) {
  const method = req.method ?? "GET";
  const [id] = parts;
  const info = (lib: string) => libraries.list().find((l) => l.id === lib);
  if (!id && method === "GET") return json(res, 200, { libraries: libraries.list() });
  if (!id && method === "POST") {
    const input = await readJson<{ title?: unknown }>(req);
    const store = libraries.create(input.title as string);
    bundles.set(store.id, new Bundle(store, shared));
    console.log(`libraries: made “${store.title}” (${store.id})`);
    return json(res, 201, { library: info(store.id) });
  }
  if (id && parts.length === 1 && method === "PATCH") {
    const input = await readJson<{ title?: unknown }>(req);
    const store = libraries.rename(id, input.title as string);
    bundles.get(id)?.announce({ branch: "main", from: "api" });
    return json(res, 200, { library: info(store.id) });
  }
  if (id && parts.length === 1 && method === "DELETE") {
    const bundle = bundles.get(id);
    if (!bundle) return json(res, 404, { error: `no library ${id}` });
    if (libraries.stores.size <= 1) return json(res, 409, { error: "the last library cannot be deleted" });
    bundle.close();
    const movedTo = libraries.remove(id);
    bundles.delete(id);
    console.log(`libraries: deleted ${id}; its files are in ${movedTo}`);
    return json(res, 200, { deleted: id, movedTo });
  }
  json(res, 404, { error: "not found" });
}

// ---- static files / vite ----

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm",
  ".svg": "image/svg+xml", ".json": "application/json", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
};

/** A built file; the page itself goes with the Content-Security-Policy of server/csp.ts. */
function serveStatic(res: ServerResponse, path: string) {
  // EX_DIST: another build to serve (the browser tests build one per port, so runs side by side do not collide).
  const dist = resolve(root, process.env.EX_DIST ?? "dist");
  let file = resolve(dist, "." + path);
  if (!file.startsWith(dist) || !existsSync(file) || path === "/") file = join(dist, "index.html");
  res.writeHead(200, {
    "content-type": MIME[extname(file)] ?? "application/octet-stream",
    "cache-control": path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    ...(extname(file) === ".html" ? { "content-security-policy": CSP } : {}),
  });
  res.end(readFileSync(file));
}

const vite = PROD
  ? null
  : await (await import("vite")).createServer({ root, server: { middlewareMode: true, hmr: { port: PORT + 1 }, allowedHosts: ALLOWED_HOSTS }, appType: "spa" });

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const path = url.pathname;
  if (path.startsWith("/api/")) {
    try {
      await api(req, res, url);
    } catch (err) {
      const { status, message } =
        err instanceof LLMUnavailable ? { status: 503, message: err.message }
        : err instanceof HttpError ? { status: err.status, message: err.message }
        : err instanceof SyntaxError ? { status: 400, message: `bad JSON: ${err.message}` }
        : explain(err);
      if (!res.headersSent) json(res, status, { error: message });
      else res.end();
      if (!(err instanceof LLMUnavailable)) console.error(`request failed (${status}): ${message}`);
      if (status >= 500 && !(err instanceof LLMUnavailable)) console.error(err);
    }
  } else if (vite) {
    vite.middlewares(req, res);
  } else {
    serveStatic(res, path);
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`Explicata  http://localhost:${PORT}   model: ${llm ? `${llm.kind}${llm.model ? `: ${llm.model}` : ""}` : "off (set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN to generate)"}   data: ${DATA}`);
  for (const l of libraries.list()) console.log(`library “${l.title}” (/l/${l.id}): ${libraries.get(l.id)!.titles().length} top-level sections, ${l.nodes} nodes`);
  console.log(`${libraries.stores.size} librar${libraries.stores.size === 1 ? "y" : "ies"} opened in ${startMs} ms`);
  console.log(`web research: ${web.on ? `on (at most ${web.searches} searches and ${web.fetches} pages read per request)` : `off${web.why ? ` (${web.why})` : ""}`}`);
  console.log(
    `wikipedia: ${wikiMode === "live" ? `live (${wikiState.lang}.wikipedia.org, ${wikiState.contact ? "with" : "without"} a contact)` : wikiMode === "mock" ? "mock (fixtures, no network)" : "off"}`,
  );
  console.log(`web pages: ${pageMode === "live" ? "live (only pages you open)" : pageMode === "mock" ? "mock (fixtures, no network)" : "off"}${pageMode !== "off" ? `; arranged by a model: ${arrangeOn && llm ? `${arranger.automatic ? "pages without headings by themselves, and " : ""}on request, at most ${arranger.budgetMax} calls a day` : "off"}` : ""}`);
});
