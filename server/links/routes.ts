/**
 * HTTP routes for link discovery. Wired into server/index.ts before the 404.
 *
 *   POST /api/links/scan        { node, text?, title?, doc?, docTitle?, ancestors?, occupied?, rejected?, forced?, within?, save? }
 *                               → { suggestions, related, unresolved, degraded, stats }; save (default true) records
 *                               the suggestions as pending for the node
 *   GET  /api/links/pending     ?doc=<slug|id>&node=<id>&tier=auto|suggest&limit=&offset=
 *                               → { total, suggestions: [{ …, nodeTitle, document, docSlug, path, sentence }] }
 *   POST /api/links/accept      { ids, author? } → applied with applyLinks as one commit by "linker"
 *   POST /api/links/reject      { ids, author? } → the phrases recorded in each node's `nolink` (one commit)
 *   GET  /api/links/related     ?node=<id> → { related, degraded }; or POST { node, text, title, doc, docTitle, ancestors }
 *   GET  /api/links/nearby      ?node=<id>&k=5 → { nearby: [{ handle, title, document }] } (hybrid search on the node);
 *                               or POST { node, text, title, ancestors }
 *   POST /api/links/jobs        { scope: "doc" | "library", doc? } → the job's state; it runs in the background
 *   GET  /api/links/jobs        → { job } (the current or last one)
 *   DELETE /api/links/jobs      → cancel the running job
 *   GET  /api/links/status      → embeddings, the node index, the pending count, the job
 *
 * Job progress is also announced on /api/events as { linkJob: state }.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { applyLinks, type LinkSpec } from "../../src/core/links";
import { descendants, docOf, documents, findDoc, isLibraryRoot, label, type Doc, type NodeId, type Op, type Snap } from "../../src/core/model";
import { clip, plain, sentences } from "../../src/core/text";
import type { Embedder } from "../embed";
import { HttpError, abortOnClose, readJson as readBody, sendJson as send } from "../util";
import type { Jobs } from "./jobs";
import type { NodeIndex } from "./nodeIndex";
import type { PendingStore } from "./pending";
import type { Linker, ScanInput, Suggestion } from "./scan";

interface LinkDeps {
  main: () => Doc;
  linker: () => Linker;
  index: NodeIndex;
  pending: PendingStore;
  jobs: Jobs;
  embedder: Embedder | null;
  /** A server-side write: saved soon and announced to every replica. */
  wrote: () => void;
}

class Bad extends HttpError {
  constructor(message: string) {
    super(400, message);
  }
}

const readJson = <T>(req: IncomingMessage) => readBody<T>(req, 4 * 1024 * 1024);

/** A document by slug or node id. */
function docArg(snap: Snap, v: string | null): NodeId | null {
  if (!v) return null;
  return findDoc(snap, v) ?? (snap.nodes[v as NodeId] && docOf(snap, v as NodeId) === v ? (v as NodeId) : null);
}

/** Everything a reviewer needs to judge a suggestion without the page. */
function describe(snap: Snap, s: Suggestion) {
  const n = snap.nodes[s.node];
  const d = docOf(snap, s.node);
  const sent = sentences(n.body).find(([a, b]) => s.range[0] >= a && s.range[0] < b) ?? [0, n.body.length];
  const path: string[] = [];
  for (let x: NodeId | null = s.node; x && x !== d && snap.nodes[x]; x = snap.nodes[x].parent) path.unshift(label(snap, x));
  return {
    ...s,
    nodeTitle: label(snap, s.node),
    document: d ? snap.nodes[d].title : null,
    docSlug: d ? snap.nodes[d].slug ?? null : null,
    path: path.join(" › "),
    sentence: clip(plain(n.body.slice(sent[0], sent[1])).trim(), 400),
  };
}

/** The nodes of a document (or of the library), in reading order: sections and notes with text. */
export function scopeNodes(snap: Snap, doc: NodeId | null): NodeId[] {
  const roots = doc ? [doc] : documents(snap);
  const out: NodeId[] = [];
  for (const r of roots) for (const id of [r, ...descendants(snap, r)]) if (snap.nodes[id].body.trim() && !isLibraryRoot(snap, id)) out.push(id);
  return out;
}

export function linkRoutes(deps: LinkDeps) {
  return async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (!url.pathname.startsWith("/api/links/")) return false;
    const route = url.pathname.slice("/api/links/".length).replace(/\/$/, "");
    const method = req.method ?? "GET";
    try {
      const snap = deps.main().snap();
      if (route === "scan" && method === "POST") {
        const input = await readJson<ScanInput & { save?: boolean }>(req);
        if (typeof input.node !== "string" || !input.node) throw new Bad("give the node's id");
        if (input.text !== undefined && typeof input.text !== "string") throw new Bad("text must be a string");
        if ((input.text?.length ?? 0) > 200_000) throw new Bad("text is too long");
        const r = await deps.linker().scan({ ...input, trace: undefined }, abortOnClose(res));
        if (input.save !== false) deps.pending.put(input.node, r.suggestions);
        return send(res, 200, r), true;
      }
      if (route === "pending" && method === "GET") {
        const docId = docArg(snap, url.searchParams.get("doc"));
        if (url.searchParams.get("doc") && !docId) throw new Bad(`no document ${url.searchParams.get("doc")}`);
        const node = url.searchParams.get("node") as NodeId | null;
        const scope = node ? new Set([node]) : docId ? new Set(scopeNodes(snap, docId)) : undefined;
        const tier = url.searchParams.get("tier");
        let list = deps.pending.list(snap, scope);
        if (tier) list = list.filter((s) => s.tier === tier);
        const order = new Map((scope ? [...scope] : scopeNodes(snap, null)).map((id, i) => [id, i]));
        list.sort((a, b) => (order.get(a.node) ?? 1e9) - (order.get(b.node) ?? 1e9) || a.range[0] - b.range[0]);
        const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
        const limit = Math.min(5000, Math.max(1, Number(url.searchParams.get("limit") ?? 1000) || 1000));
        return send(res, 200, { total: list.length, suggestions: list.slice(offset, offset + limit).map((s) => describe(snap, s)) }), true;
      }
      if ((route === "accept" || route === "reject") && method === "POST") {
        const input = await readJson<{ ids?: unknown; author?: unknown }>(req);
        if (!Array.isArray(input.ids) || !input.ids.every((x) => typeof x === "string")) throw new Bad("give { ids: [...] }");
        const found = (input.ids as string[]).map((id) => deps.pending.get(snap, id)).filter((s): s is Suggestion => !!s);
        const author = typeof input.author === "string" && input.author.trim() ? input.author.trim().slice(0, 100) : "linker";
        const main = deps.main();
        if (route === "accept") {
          const specs: LinkSpec[] = found.map((s) => ({ node: s.node, range: s.range, target: s.target }));
          const r = applyLinks(main, specs, { author, actor: "llm", tag: "autolink", message: `Link ${specs.length} phrase${specs.length === 1 ? "" : "s"} (reviewed suggestions)` });
          deps.pending.drop(found.map((s) => s.id));
          if (r.created.length || r.merged.length) deps.wrote();
          return send(res, 200, { accepted: found.length, unknown: input.ids.length - found.length, ...r }), true;
        }
        const byNode = new Map<NodeId, Set<string>>();
        for (const s of found) byNode.set(s.node, (byNode.get(s.node) ?? new Set()).add(s.key));
        const ops: Op[] = [...byNode].map(([id, keys]) => ({ op: "update", id, nolink: [...keys] }));
        if (ops.length) {
          main.as(author, () => main.apply(ops, `Decline ${found.length} link suggestion${found.length === 1 ? "" : "s"}`, { actor: "human", tag: "nolink" }));
          deps.wrote();
        }
        deps.pending.drop(found.map((s) => s.id));
        return send(res, 200, { rejected: found.length, unknown: input.ids.length - found.length }), true;
      }
      if (route === "related" && (method === "GET" || method === "POST")) {
        // GET ?node=<id> for a node the server has; POST { node, text, title, doc, docTitle, ancestors } for one it may not have yet.
        const input = method === "POST" ? await readJson<ScanInput>(req) : { node: url.searchParams.get("node") as NodeId };
        if (!input.node || (!snap.nodes[input.node] && typeof input.text !== "string")) throw new Bad("give an existing node, or its text");
        const r = await deps.linker().related(input.node, 5, input);
        return send(res, 200, r), true;
      }
      if (route === "nearby" && (method === "GET" || method === "POST")) {
        const input = method === "POST" ? await readJson<ScanInput>(req) : { node: url.searchParams.get("node") as NodeId };
        if (!input.node || (!snap.nodes[input.node] && typeof input.text !== "string")) throw new Bad("give an existing node, or its text");
        const k = Math.min(10, Math.max(1, Number(url.searchParams.get("k") ?? 5) || 5));
        return send(res, 200, { nearby: await deps.linker().nearby(input.node, k, input) }), true;
      }
      if (route === "jobs") {
        if (method === "GET") return send(res, 200, { job: deps.jobs.current }), true;
        if (method === "DELETE") return send(res, 200, { cancelled: deps.jobs.cancel(), job: deps.jobs.current }), true;
        if (method === "POST") {
          const input = await readJson<{ scope?: string; doc?: string }>(req);
          if (input.scope !== "doc" && input.scope !== "library") throw new Bad('scope is "doc" or "library"');
          const docId = input.scope === "doc" ? docArg(snap, input.doc ?? null) : null;
          if (input.scope === "doc" && !docId) throw new Bad(`no document ${input.doc ?? ""}`);
          const nodes = scopeNodes(snap, docId);
          const title = docId ? snap.nodes[docId].title : "the library";
          return send(res, 202, { job: deps.jobs.start(input.scope, nodes, title, docId ?? undefined) }), true;
        }
      }
      if (route === "status" && method === "GET") {
        return send(res, 200, {
          embeddings: deps.embedder ? { state: deps.embedder.state, model: deps.embedder.spec.id, error: deps.embedder.error } : { state: "off" },
          index: deps.index.status,
          pending: deps.pending.size,
          job: deps.jobs.current,
        }), true;
      }
      send(res, 404, { error: `no route ${method} /api/links/${route}` });
      return true;
    } catch (e) {
      if (e instanceof HttpError) send(res, e.status, { error: e.message });
      else {
        console.error("links:", e);
        send(res, 500, { error: (e as Error).message ?? String(e) });
      }
      return true;
    }
  };
}
