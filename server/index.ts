/**
 * The local server. It does three small things:
 *   - relays library updates between replicas (tabs, people, agents) and keeps a copy on disk
 *   - holds the API key and proxies model calls
 *   - exposes the op API over HTTP, so an outside agent can read and edit the tree
 * In development it also hosts Vite; in production it serves the built files.
 *
 * The whole library is one database: /api/tree, /api/ops, /api/sync… act on all of it, and
 * /api/docs lists its documents, with a few routes scoped to one. See README.md for the list.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { userInfo } from "node:os";
import { extname, join, resolve } from "node:path";
import { VersionVector } from "loro-crdt";
import { IMPORT_MAX, createDoc, deleteDoc, duplicateDoc, importDoc, listDocs, renameDoc } from "../src/core/library";
import { Doc, OpError, docOf, findDoc, SLUG, descendants, type NodeId, type Op, type Snap } from "../src/core/model";
import { encodeVV, history } from "../src/core/repo";
import { FormatError, serializeDoc } from "../src/core/format";
import { writeSeed } from "../src/core/seed";
import { mockLLM } from "../src/llm/mock";
import { LLMUnavailable, type JsonReq, type LLM, type Req, type TurnReq } from "../src/llm/types";
import { seed } from "../src/seed/tree";
import { claudeLLM, describeError } from "./claude";
import { LibraryStore, validBranch } from "./library";
import { SubscriptionError, queryPlanUsage, subscriptionLLM } from "./subscription";
import { usage, withMockUsage } from "./usage";
import { HttpError, ROOT as root, abortOnClose, dataDir, readBody, readJson, sendJson as json } from "./util";
import { applyWebPolicy, webConfig } from "./web";
import { WikiClient, validContact, wiki, wikiLang } from "./wiki";
import { makeMockWikiFetch } from "./wikiMock";
import { wikiOff, wikiRoutes } from "./wikiRoutes";
import { embedder } from "./embed";
import { Jobs } from "./links/jobs";
import { NodeIndex } from "./links/nodeIndex";
import { PendingStore } from "./links/pending";
import { linkRoutes } from "./links/routes";
import { Linker } from "./links/scan";

const PORT = Number(process.env.PORT ?? 4747);
const DATA = dataDir();
const PROD = process.env.IE_PROD === "1";
const MODEL = process.env.IE_MODEL ?? "claude-opus-5-5";
const USER = process.env.IE_USER ?? userInfo().username;
const LIBRARY = resolve(process.env.IE_LIBRARY ?? join(root, "library"));

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
const wanted = process.env.IE_LLM ?? (apiKey ? "claude" : process.env.CLAUDE_CODE_OAUTH_TOKEN ? "subscription" : "off");
const llm: LLM | null =
  wanted === "claude" ? claudeLLM(MODEL)
  : wanted === "subscription" ? subscriptionLLM(MODEL)
  : wanted === "mock" ? withMockUsage(mockLLM({ delay: Number(process.env.IE_MOCK_DELAY ?? 12) }))
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

// IE_WEB=off takes web search and fetch away from the agent entirely; IE_WEB_SEARCHES and
// IE_WEB_FETCHES cap each run (default 5 and 5). The browser asks for research; this decides.
const web = webConfig(process.env, Boolean(llm));
if (process.env.IE_WEB && !web.on && web.why) console.warn(`web research is off: ${web.why}.`);

// ---- Wikipedia ----

// IE_WIKI picks where /api/wiki/* gets its answers: the real Wikipedia (live), the fixtures in
// server/wikiMock.ts (mock: tests and offline work, no network at all), or nowhere (off). An
// unrecognised value is treated as off, so a typo never sends requests nobody asked for.
type WikiMode = "live" | "mock" | "off";
const wikiWanted = process.env.IE_WIKI ?? "live";
const wikiMode: WikiMode = wikiWanted === "live" || wikiWanted === "mock" ? wikiWanted : "off";
if (wikiMode !== wikiWanted) console.warn(`IE_WIKI=${wikiWanted} is not live, mock or off; Wikipedia is off.`);
// The mock keeps nothing on disk and never holds itself offline, so one test's "offline" title
// does not leak into the next.
const mockWiki = wikiMode === "mock" ? new WikiClient({ lang: process.env.IE_WIKI_LANG, fetch: makeMockWikiFetch(undefined, Number(process.env.IE_WIKI_MOCK_BULK_MS) || 0), spacingMs: 0, persist: false, offlineHoldMs: 0 }) : null;
const wikiClient = () => (wikiMode === "off" ? null : (mockWiki ?? wiki()));
const handleWiki = wikiMode === "off" ? wikiOff : wikiRoutes(() => wikiClient()!);
/** What the UI may know: the mode, the language, and whether a contact is set (never the contact). */
const wikiState = { mode: wikiMode, lang: wikiLang(process.env.IE_WIKI_LANG), contact: validContact(process.env.IE_WIKI_CONTACT) !== null };

/** A short reason for a failed model call, whichever provider made it. */
const explain = (err: unknown) => (err instanceof SubscriptionError ? { status: err.status, message: err.message } : describeError(err));

// ---- the library on disk ----

mkdirSync(DATA, { recursive: true });
const started = performance.now();
const store = new LibraryStore(DATA).open();
store.seedFirst((doc) => writeSeed(doc, readFileSync(join(root, "src/seed/prompt.txt"), "utf8"), seed));
store.importLibrary(LIBRARY);
const startMs = Math.round(performance.now() - started);
// Writes are gathered before they go to disk; whatever is waiting goes on the way out.
process.on("exit", () => store.flush());
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(0));

const vvHeader = (doc: Doc) => encodeVV(doc.loro.version().toJSON());

// ---- link discovery (server/links) ----

// The embedding model is loaded on first use, in a worker thread; IE_EMBED=off turns it off, and
// scanning then matches by text alone. Pending suggestions are derived data, kept beside the library.
const embed = process.env.IE_EMBED === "off" ? null : embedder();
const nodeIndex = new NodeIndex(() => store.main, { file: join(DATA, "vectors", "nodes"), embedder: embed });
nodeIndex.watch(store.main);
let linker: Linker | null = null;
const getLinker = () => (linker ??= new Linker({ doc: () => store.main, wiki: wikiClient, embedder: embed, index: nodeIndex }));
const pending = new PendingStore(join(DATA, "links", "pending.json"));
process.on("exit", () => pending.flush());
const jobs = new Jobs({
  snap: () => store.main.snap(),
  linker: getLinker,
  wiki: wikiClient,
  index: nodeIndex,
  pending,
  announce: (state) => announce({ linkJob: state }),
});
const handleLinks = linkRoutes({ main: () => store.main, linker: getLinker, index: nodeIndex, pending, jobs, embedder: embed, wrote: () => wrote("main") });

// ---- live notifications ----

const listeners = new Set<ServerResponse>();
function announce(message: Record<string, unknown>) {
  const line = `data: ${JSON.stringify(message)}\n\n`;
  for (const res of listeners) res.write(line);
}

// ---- http plumbing ----

/** Largest replica update a sync accepts. */
const SYNC_MAX = 256 * 1024 * 1024;
function needLLM(): LLM {
  if (!llm) throw new LLMUnavailable();
  return llm;
}
const titleOf = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, 200) : "");

/** A server-side write to a branch: saved shortly and announced to every replica. */
function wrote(branch: string) {
  store.saveSoon(branch);
  announce({ branch, from: "api" });
}

/** One document's entry in the listing. */
const entry = (snap: Snap, id: NodeId) => listDocs(snap).find((d) => d.node === id)!;

/** A subtree on its own, as the tree route returns the library. */
function subtree(snap: Snap, id: NodeId) {
  const ids = new Set([id, ...descendants(snap, id)]);
  return { root: id, nodes: Object.fromEntries([...ids].map((x) => [x, snap.nodes[x]])) };
}

async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
  const parts = url.pathname.split("/").slice(2).map(decodeURIComponent); // after /api/
  const [a, b] = parts;
  const method = req.method ?? "GET";

  if (a === "state" && method === "GET") {
    return json(res, 200, {
      user: USER,
      llm: llm?.kind ?? "off",
      model: llm?.model ?? null,
      library: store.id,
      branches: [...store.branches].map(([name, doc]) => ({ name, vv: vvHeader(doc) })),
      docs: store.list(),
      migrated: store.migrated(),
      wiki: wikiState,
      embed: embed ? (process.env.IE_EMBED === "fake" ? "fake" : "on") : "off",
      web: { on: web.on, searches: web.searches, fetches: web.fetches },
      linkJob: jobs.current,
    });
  }

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

  if (a === "docs") return docsApi(req, res, url, parts.slice(1));
  if (["events", "branch", "sync", "tree", "ops"].includes(a)) return libraryApi(req, res, url, a, b);
  if (await handleWiki(req, res, url)) return;
  if (url.pathname.startsWith("/api/links/")) nodeIndex.activate();
  if (await handleLinks(req, res, url)) return;

  json(res, 404, { error: "not found" });
}

/** The library as a whole: what replicas use, and the op API. */
async function libraryApi(req: IncomingMessage, res: ServerResponse, url: URL, action: string, b: string | undefined) {
  const method = req.method ?? "GET";
  const name = b || "main";
  if (!validBranch(name)) return json(res, 400, { error: "not a branch name" });

  if (action === "events" && method === "GET") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(": connected\n\n");
    listeners.add(res);
    req.on("close", () => listeners.delete(res));
    return;
  }

  // A replica fetches a branch whole.
  if (action === "branch" && method === "GET") {
    const doc = store.branches.get(name);
    if (!doc) return json(res, 404, { error: `no such branch: ${name}` });
    res.writeHead(200, { "content-type": "application/octet-stream", "x-vv": vvHeader(doc), "x-library": store.id });
    return res.end(doc.snapshotBytes());
  }

  // A replica pushes what it has and gets back what it lacks. Request header x-vv is the
  // replica's version; the response carries the server's. A replica must name the library it
  // belongs to: bytes from another library (an old tab, a browser that outlived its data
  // directory) would add a second root to this one. A beacon cannot send headers, so it names
  // the library in the query.
  if (action === "sync" && method === "POST") {
    if ((req.headers["x-library"] ?? url.searchParams.get("library")) !== store.id) {
      return json(res, 409, { error: "This page belongs to a different library than the server has now. Reload the page.", library: store.id });
    }
    const bytes = await readBody(req, SYNC_MAX);
    let doc = store.branches.get(name);
    const before = doc ? vvHeader(doc) : "";
    if (!doc) {
      if (!bytes.length) return json(res, 404, { error: `no such branch: ${name}` });
      doc = Doc.load(bytes, "server");
      if (doc.libraryId !== store.id) return json(res, 409, { error: "that branch is not of this library" });
      store.addBranch(name, doc);
    } else if (bytes.length) {
      doc.loro.import(bytes);
      doc.touch();
    }
    if (vvHeader(doc) !== before) {
      store.saveSoon(name);
      announce({ branch: name, from: String(req.headers["x-client"] ?? "") });
    }
    const theirs = req.headers["x-vv"] ? new Map(JSON.parse(String(req.headers["x-vv"]))) : new Map();
    const update = doc.loro.export({ mode: "update", from: new VersionVector(theirs as never) });
    res.writeHead(200, { "content-type": "application/octet-stream", "x-vv": vvHeader(doc) });
    return res.end(update);
  }

  // For outside agents: read the library as JSON…
  if (action === "tree" && method === "GET") {
    const doc = store.branches.get(name);
    if (!doc) return json(res, 404, { error: `no such branch: ${name}` });
    return json(res, 200, { ...doc.snap(), conflicts: doc.conflicts(), history: history(doc).slice(0, 50) });
  }

  // …and write to it with the same ops everyone else uses. Node ids are the library's, so one
  // batch can work across documents (moving a node from one to another is a move).
  if (action === "ops" && method === "POST") return opsApi(req, res, name);

  json(res, 404, { error: "not found" });
}

async function opsApi(req: IncomingMessage, res: ServerResponse, name: string) {
  const doc = store.branches.get(name);
  if (!doc) return json(res, 404, { error: `no such branch: ${name}` });
  const input = await readJson<{ ops: Op[]; message?: string; author?: string; actor?: "human" | "llm" }>(req);
  if (!Array.isArray(input.ops)) return json(res, 400, { error: "expected { ops: [...] }" });
  const author = typeof input.author === "string" ? input.author.slice(0, 100) : "api";
  try {
    return json(res, 200, doc.as(author, () => doc.apply(input.ops, input.message ?? "Edit over HTTP", { actor: input.actor ?? "llm", tag: "api" })));
  } catch (err) {
    if (err instanceof OpError) return json(res, 422, { error: err.message });
    throw err;
  } finally {
    wrote(name);
  }
}

/**
 * /api/docs: the library's documents, by slug. Creating, renaming, copying and deleting one are
 * ordinary commits on main, made here for agents that think in documents; the browser makes the
 * same commits in its own replica.
 */
async function docsApi(req: IncomingMessage, res: ServerResponse, url: URL, parts: string[]) {
  const method = req.method ?? "GET";
  const [slug, action, branch] = parts;
  const main = store.main;
  if (!slug) {
    if (method === "GET") return json(res, 200, store.list());
    if (method === "POST") {
      const title = titleOf((await readJson<{ title?: string }>(req)).title);
      if (!title) return json(res, 400, { error: "a new document needs a title" });
      const id = createDoc(main, title, USER);
      wrote("main");
      return json(res, 201, entry(main.snap(), id));
    }
  }
  // POST /api/docs/import?name=file.md, with the file as the body.
  if (slug === "import" && !action && method === "POST") {
    const name = (url.searchParams.get("name") ?? "").replace(/^.*[\\/]/, "").slice(0, 200) || "import.md";
    let text: string;
    try {
      text = (await readBody(req, IMPORT_MAX)).toString("utf8");
    } catch (err) {
      if (err instanceof HttpError && err.status === 413) return json(res, 413, { error: `the file is too large to import (the limit is ${IMPORT_MAX / 1024 / 1024} MB)` });
      throw err;
    }
    try {
      const id = importDoc(main, text, name, { creator: USER });
      wrote("main");
      return json(res, 201, entry(main.snap(), id));
    } catch (err) {
      if (err instanceof FormatError) return json(res, 422, { error: err.message, problems: err.problems });
      throw err;
    }
  }
  if (!SLUG.test(slug)) return json(res, 400, { error: `not a document slug: ${slug}` });
  const name = branch || "main";
  if (!validBranch(name)) return json(res, 400, { error: "not a branch name" });
  const doc = store.branches.get(name);
  if (!doc) return json(res, 404, { error: `no such branch: ${name}` });
  const id = findDoc(doc.snap(), slug);
  if (!id) return json(res, 404, { error: `no such document: ${slug}`, missing: "document" });

  if (!action) {
    if (method === "GET") return json(res, 200, entry(doc.snap(), id));
    if (method === "PATCH") {
      const title = titleOf((await readJson<{ title?: string }>(req)).title);
      if (!title) return json(res, 400, { error: "a title is needed" });
      renameDoc(main, id, title, USER);
      wrote("main");
      return json(res, 200, entry(main.snap(), id));
    }
    if (method === "DELETE") {
      deleteDoc(main, id, USER);
      wrote("main");
      return json(res, 200, { deleted: slug });
    }
  }
  if (action === "duplicate" && method === "POST") {
    const title = titleOf((await readJson<{ title?: string }>(req)).title) || `${main.snap().nodes[id].title} (copy)`;
    const copy = duplicateDoc(main, id, title, USER);
    wrote("main");
    return json(res, 201, entry(main.snap(), copy));
  }
  // GET /api/docs/<slug>/export[/<branch>]: the text format, as a download.
  if (action === "export" && method === "GET") {
    const { text, skipped } = serializeDoc(doc.snap(), id);
    res.writeHead(200, {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="${slug}${name === "main" ? "" : `-${encodeURIComponent(name)}`}.md"`,
      "x-skipped": JSON.stringify(skipped),
    });
    return res.end(text);
  }
  if (action === "tree" && method === "GET") {
    const snap = doc.snap();
    return json(res, 200, { ...subtree(snap, id), conflicts: doc.conflicts().filter((c) => [c.node, c.parent].some((x) => x && snap.nodes[x] && docOf(snap, x) === id)) });
  }
  if (action === "ops" && method === "POST") return opsApi(req, res, name);
  json(res, 404, { error: "not found" });
}

// ---- static files / vite ----

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm",
  ".svg": "image/svg+xml", ".json": "application/json", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
};
/**
 * Sent with the page in production. The page injects sanitised Wikipedia HTML; this is the second
 * line of defence should anything get past the sanitiser: no scripts, frames, plugins, forms or
 * remote loads but our own. 'wasm-unsafe-eval' lets Loro compile its WebAssembly; inline styles
 * are allowed because Preact sets style attributes.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

function serveStatic(res: ServerResponse, path: string) {
  // IE_DIST: another build to serve (the browser tests build one per port, so runs side by side do not collide).
  const dist = resolve(root, process.env.IE_DIST ?? "dist");
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
  : await (await import("vite")).createServer({ root, server: { middlewareMode: true, hmr: { port: PORT + 1 } }, appType: "spa" });

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
  const nodes = Object.keys(store.main.snap().nodes).length;
  console.log(`Infinispand  http://localhost:${PORT}   model: ${llm ? `${llm.kind}${llm.model ? `: ${llm.model}` : ""}` : "off (set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN to generate)"}   data: ${DATA}`);
  console.log(`library: ${store.list().length} documents, ${nodes} nodes, opened in ${startMs} ms`);
  console.log(`web research: ${web.on ? `on (at most ${web.searches} searches and ${web.fetches} pages read per request)` : `off${web.why ? ` (${web.why})` : ""}`}`);
  console.log(
    `wikipedia: ${wikiMode === "live" ? `live (${wikiState.lang}.wikipedia.org, ${wikiState.contact ? "with" : "without"} a contact)` : wikiMode === "mock" ? "mock (fixtures, no network)" : "off"}`,
  );
});
