/**
 * HTTP routes for link discovery. Wired into server/index.ts before the 404.
 *
 *   POST /api/links/scan        { node, text?, title?, doc?, docTitle?, ancestors?, occupied?, rejected?, forced?, within?, save?, review? }
 *                               → { suggestions, related, unresolved, degraded, stats, entries?, apply?, review? }; save (default
 *                               true) records the suggestions as pending for the node, and `entries` is then everything
 *                               stored for it, with determinations. review ("all", or "unmarked" to leave out [[marks]],
 *                               which a person typed) has the model reviewer judge what is undecided; `apply` is then the
 *                               approved links handed to the caller to make, and `review` the reviewer's report
 *   GET  /api/links/pending     ?doc=<slug|id>&node=<id>&tier=auto|suggest&limit=&offset=&all=1&claim=1
 *                               → { total, suggestions: [{ …, nodeTitle, document, docSlug, path, sentence }], apply? };
 *                               all=1 lists every entry whatever was decided, with its determinations; claim=1 hands
 *                               out the approved links no page has made yet (in `apply`), to be made by the caller
 *   POST /api/links/accept      { ids, author? } → applied with applyLinks as one commit by "linker"
 *   POST /api/links/reject      { ids, author? } → the phrases recorded in each node's `nolink` (one commit)
 *   POST /api/links/decide      { ids, link, by } → a person's decision, made in their own replica, recorded
 *   GET  /api/links/related     ?node=<id> → { related, degraded }; or POST { node, text, title, doc, docTitle, ancestors }
 *   GET  /api/links/nearby      ?node=<id>&k=5 → { nearby: [{ handle, title, document }] } (hybrid search on the node);
 *                               or POST { node, text, title, ancestors }
 *   POST /api/links/jobs        { scope: "doc" | "library", doc?, review? } → the job's state; it runs in the background
 *                               (with review, the model reviewer judges what it finds, within IE_REVIEW_CALLS calls)
 *   GET  /api/links/jobs        → { job } (the current or last one)
 *   DELETE /api/links/jobs      → cancel the running job
 *   GET  /api/links/status      → embeddings, the node index, the pending count, the job
 *
 * Job progress is also announced on /api/events as { linkJob: state }.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { applyLinks, type LinkSpec } from "../../src/core/links";
import { descendants, docOf, documents, findDoc, isLibraryRoot, type Doc, type NodeId, type Op, type Snap } from "../../src/core/model";
import type { Embedder } from "../embed";
import { HttpError, abortOnClose, readJson as readBody, sendJson as send } from "../util";
import type { Jobs } from "./jobs";
import type { NodeIndex } from "./nodeIndex";
import type { PendingStore } from "./pending";
import { SCAN_CALLS, describe, type Reviewer } from "./review";
import type { Linker, ScanInput, Suggestion } from "./scan";

interface LinkDeps {
  main: () => Doc;
  linker: () => Linker;
  index: NodeIndex;
  pending: PendingStore;
  jobs: Jobs;
  embedder: Embedder | null;
  reviewer?: Reviewer;
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
        const input = await readJson<ScanInput & { save?: boolean; review?: "all" | "unmarked" }>(req);
        if (typeof input.node !== "string" || !input.node) throw new Bad("give the node's id");
        if (input.text !== undefined && typeof input.text !== "string") throw new Bad("text must be a string");
        if ((input.text?.length ?? 0) > 200_000) throw new Bad("text is too long");
        const signal = abortOnClose(res);
        // What the reviewer rejected here is not looked for again, any more than what a person declined.
        const reviewed = deps.pending.rejectedKeys(input.node);
        const rejected = reviewed.length ? [...(input.rejected ?? snap.nodes[input.node]?.nolink ?? []), ...reviewed] : input.rejected;
        const r = await deps.linker().scan({ ...input, rejected, trace: undefined }, signal);
        if (input.save === false) return send(res, 200, r), true;
        deps.pending.put(input.node, r.suggestions);
        if (!input.review) return send(res, 200, { ...r, entries: deps.pending.of(input.node) }), true;
        // The reviewer sees what this scan found that nobody has judged yet (a person's [[marks]] are
        // theirs, not its), within the scan's budget. Found against the text the caller sent, which
        // may be ahead of the server's copy.
        const found = new Set(r.suggestions.map((s) => s.id));
        const mine = deps.pending.of(input.node).filter((s) => found.has(s.id));
        const todo = mine.filter((s) => !s.review && !s.decided && (input.review === "all" || s.kind !== "forced"));
        const report = deps.reviewer ? await deps.reviewer.review(todo, { calls: 0, max: SCAN_CALLS }, signal, { node: input.node, text: input.text, title: input.title, doc: input.doc }) : { approved: 0, rejected: 0, calls: 0, left: todo.length, fallback: "no reviewer" };
        const apply = deps.pending.handOut(mine);
        return send(res, 200, { ...r, entries: deps.pending.of(input.node), apply, review: report }), true;
      }
      if (route === "pending" && method === "GET") {
        const docId = docArg(snap, url.searchParams.get("doc"));
        if (url.searchParams.get("doc") && !docId) throw new Bad(`no document ${url.searchParams.get("doc")}`);
        const node = url.searchParams.get("node") as NodeId | null;
        const scope = node ? new Set([node]) : docId ? new Set(scopeNodes(snap, docId)) : undefined;
        const tier = url.searchParams.get("tier");
        const all = url.searchParams.get("all") === "1";
        const apply = url.searchParams.get("claim") === "1" ? deps.pending.claim(snap, scope ?? scopeNodes(snap, null)) : undefined;
        let list = deps.pending.list(snap, scope, all);
        if (tier) list = list.filter((s) => s.tier === tier);
        const order = new Map((scope ? [...scope] : scopeNodes(snap, null)).map((id, i) => [id, i]));
        list.sort((a, b) => (order.get(a.node) ?? 1e9) - (order.get(b.node) ?? 1e9) || a.range[0] - b.range[0]);
        const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
        const limit = Math.min(5000, Math.max(1, Number(url.searchParams.get("limit") ?? 1000) || 1000));
        return send(res, 200, { total: list.length, suggestions: list.slice(offset, offset + limit).map((s) => describe(snap, s)), ...(apply ? { apply } : {}) }), true;
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
          deps.pending.decide(found.map((s) => s.id), true, author);
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
        deps.pending.decide(found.map((s) => s.id), false, author);
        return send(res, 200, { rejected: found.length, unknown: input.ids.length - found.length }), true;
      }
      if (route === "decide" && method === "POST") {
        const input = await readJson<{ ids?: unknown; link?: unknown; by?: unknown }>(req);
        if (!Array.isArray(input.ids) || !input.ids.every((x) => typeof x === "string") || typeof input.link !== "boolean") throw new Bad("give { ids: [...], link: true | false, by }");
        const by = typeof input.by === "string" && input.by.trim() ? input.by.trim().slice(0, 100) : "someone";
        return send(res, 200, { decided: deps.pending.decide(input.ids as string[], input.link, by) }), true;
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
          const input = await readJson<{ scope?: string; doc?: string; review?: boolean }>(req);
          if (input.scope !== "doc" && input.scope !== "library") throw new Bad('scope is "doc" or "library"');
          const docId = input.scope === "doc" ? docArg(snap, input.doc ?? null) : null;
          if (input.scope === "doc" && !docId) throw new Bad(`no document ${input.doc ?? ""}`);
          const nodes = scopeNodes(snap, docId);
          const title = docId ? snap.nodes[docId].title : "the library";
          return send(res, 202, { job: deps.jobs.start(input.scope, nodes, title, docId ?? undefined, input.review === true) }), true;
        }
      }
      if (route === "status" && method === "GET") {
        return send(res, 200, {
          embeddings: deps.embedder ? { state: deps.embedder.state, model: deps.embedder.spec.id, error: deps.embedder.error } : { state: "off" },
          index: deps.index.status,
          pending: deps.pending.size,
          reviewer: deps.reviewer?.available ?? false,
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
