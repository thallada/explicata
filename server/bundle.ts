/**
 * Everything the server keeps for one library, and the routes that act on it. Each library has its
 * own store, notice stream, node index (vectors), pending links, link reviewer and background jobs,
 * all bound to that library's database alone, so nothing one library holds can reach a request
 * about another: a route finds its library first and is handed only that library's bundle.
 *
 * What is shared holds no library's content: the model, Wikipedia (and its cache) and the embedding
 * model.
 *
 * Routes, after /api/l/<id>/ (or after /api/ for the first library):
 *
 *   GET  state                            what the page needs to start
 *   GET  events                           the library's notice stream (server-sent events)
 *   GET  branch/<b>, POST sync/<b>        what replicas use
 *   GET  tree[/<b>], POST ops[/<b>]       the op API
 *   GET  nodes/<id>/tree|export[/<b>], POST nodes/<id>/import
 *   …    links/*                          link discovery (links/routes.ts)
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { VersionVector } from "loro-crdt";
import { FormatError, serializeDoc } from "../src/core/format";
import { Doc, OpError, descendants, type NodeId, type Op } from "../src/core/model";
import { encodeVV, history } from "../src/core/repo";
import { IMPORT_MAX, importTree } from "../src/core/seed";
import { slugify } from "../src/core/text";
import type { LLM } from "../src/llm/types";
import type { Embedder } from "./embed";
import { LibraryStore, validBranch } from "./library";
import { Jobs } from "./links/jobs";
import { NodeIndex } from "./links/nodeIndex";
import { PendingStore } from "./links/pending";
import { Reviewer } from "./links/review";
import { linkRoutes } from "./links/routes";
import { Linker } from "./links/scan";
import { HttpError, readBody, readJson, sendJson as json } from "./util";
import type { WikiClient } from "./wiki";

/** What every library's bundle is given: shared, and holding no library's content. */
export interface Shared {
  llm: () => LLM | null;
  wiki: () => WikiClient | null;
  embed: Embedder | null;
  reviewCalls: number;
  user: string;
  /** What /state says besides the library's own part. */
  state: () => Record<string, unknown>;
}

/** Largest replica update a sync accepts. */
const SYNC_MAX = 256 * 1024 * 1024;

const vvHeader = (doc: Doc) => encodeVV(doc.loro.version().toJSON());

export class Bundle {
  readonly listeners = new Set<ServerResponse>();
  readonly nodeIndex: NodeIndex;
  readonly pending: PendingStore;
  readonly reviewer: Reviewer;
  readonly jobs: Jobs;
  private linker: Linker | null = null;
  private handleLinks: ReturnType<typeof linkRoutes>;

  constructor(
    readonly store: LibraryStore,
    private shared: Shared,
  ) {
    const main = () => store.main;
    // The embedding model is loaded on first use, in a worker thread shared by every library; each
    // library's vectors are its own. Pending suggestions are derived data, kept beside the library.
    this.nodeIndex = new NodeIndex(main, { file: join(store.dir, "vectors", "nodes"), embedder: shared.embed });
    this.nodeIndex.watch(store.main);
    const getLinker = () => (this.linker ??= new Linker({ doc: main, wiki: shared.wiki, embedder: shared.embed, index: this.nodeIndex }));
    this.pending = new PendingStore(join(store.dir, "links", "pending.json"));
    // The link reviewer asks the configured model (no tools, structured verdicts); IE_REVIEW_CALLS caps a background job's calls.
    this.reviewer = new Reviewer({ llm: shared.llm, wiki: shared.wiki, pending: this.pending, snap: () => store.main.snap() });
    this.jobs = new Jobs({
      snap: () => store.main.snap(),
      linker: getLinker,
      wiki: shared.wiki,
      index: this.nodeIndex,
      pending: this.pending,
      announce: (state) => this.announce({ linkJob: state }),
      reviewer: this.reviewer,
      reviewCalls: shared.reviewCalls,
    });
    this.handleLinks = linkRoutes({ main, linker: getLinker, index: this.nodeIndex, pending: this.pending, jobs: this.jobs, embedder: shared.embed, reviewer: this.reviewer, wrote: () => this.wrote("main") });
  }

  get id() {
    return this.store.id;
  }

  /** A notice to every page open on this library. */
  announce(message: Record<string, unknown>) {
    const line = `data: ${JSON.stringify(message)}\n\n`;
    for (const res of this.listeners) res.write(line);
  }

  /** A server-side write to a branch: saved shortly and announced to every replica. */
  wrote(branch: string) {
    this.store.saveSoon(branch);
    this.announce({ branch, from: "api" });
  }

  /** Write what is waiting, on the way out. */
  flush() {
    this.store.flush();
    this.pending.flush();
  }

  /** The library is being moved aside: stop its job, write what is waiting, tell its pages, and write nothing more. */
  close() {
    this.jobs.cancel();
    this.nodeIndex.close();
    this.pending.close();
    this.store.close();
    this.announce({ library: "deleted" });
    for (const res of this.listeners) res.end();
    this.listeners.clear();
  }

  /** A request about this library; `parts` is the path after its prefix, `url` rewritten to /api/<parts>. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL, parts: string[]): Promise<boolean> {
    const [a, b] = parts;
    const method = req.method ?? "GET";
    if (a === "state" && method === "GET") {
      const store = this.store;
      json(res, 200, {
        ...this.shared.state(),
        library: store.id,
        title: store.title,
        branches: [...store.branches].map(([name, doc]) => ({ name, vv: vvHeader(doc) })),
        linkJob: this.jobs.current,
      });
      return true;
    }
    if (a === "nodes") return (await this.nodeApi(req, res, url, parts.slice(1)), true);
    if (a && ["events", "branch", "sync", "tree", "ops"].includes(a)) return (await this.libraryApi(req, res, url, a, b), true);
    if (a === "links") {
      this.nodeIndex.activate();
      return this.handleLinks(req, res, url);
    }
    return false;
  }

  /** The library as a whole: what replicas use, and the op API. */
  private async libraryApi(req: IncomingMessage, res: ServerResponse, url: URL, action: string, b: string | undefined) {
    const method = req.method ?? "GET";
    const store = this.store;
    const name = b || "main";
    if (!validBranch(name)) return json(res, 400, { error: "not a branch name" });

    if (action === "events" && method === "GET") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(": connected\n\n");
      this.listeners.add(res);
      req.on("close", () => this.listeners.delete(res));
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
    // directory, a page of another library) would add a second root to this one. A beacon cannot
    // send headers, so it names the library in the query.
    if (action === "sync" && method === "POST") {
      if ((req.headers["x-library"] ?? url.searchParams.get("library")) !== store.id) {
        return json(res, 409, { error: "This page belongs to a different library than the server has here. Reload the page.", library: store.id });
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
        this.announce({ branch: name, from: String(req.headers["x-client"] ?? "") });
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
      return json(res, 200, { ...doc.snap(), library: store.id, conflicts: doc.conflicts(), history: history(doc).slice(0, 50) });
    }

    // …and write to it with the same ops everyone else uses. Node ids are the library's, so one
    // batch can work anywhere in it (moving a node from one place to another is a move).
    if (action === "ops" && method === "POST") return this.opsApi(req, res, name);

    json(res, 404, { error: "not found" });
  }

  private async opsApi(req: IncomingMessage, res: ServerResponse, name: string) {
    const doc = this.store.branches.get(name);
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
      this.wrote(name);
    }
  }

  /**
   * One node and everything under it, by its id: the subtree as JSON with its conflicts, the text
   * format as a download, or a file in the text format imported under it. An import is an ordinary
   * commit on main; the browser makes the same commits in its own replica.
   */
  private async nodeApi(req: IncomingMessage, res: ServerResponse, url: URL, parts: string[]) {
    const method = req.method ?? "GET";
    const [id, action, branch] = parts as [NodeId, string | undefined, string | undefined];
    const name = branch || "main";
    if (!validBranch(name)) return json(res, 400, { error: "not a branch name" });
    const doc = this.store.branches.get(name);
    if (!doc) return json(res, 404, { error: `no such branch: ${name}` });
    const snap = doc.snap();
    if (!id || !snap.nodes[id]) return json(res, 404, { error: `no such node: ${id ?? ""}` });

    // GET nodes/<id>/tree[/<branch>]: the subtree, as tree returns the library.
    if (action === "tree" && method === "GET") {
      const ids = new Set([id, ...descendants(snap, id)]);
      return json(res, 200, { root: id, nodes: Object.fromEntries([...ids].map((x) => [x, snap.nodes[x]])), conflicts: doc.conflicts().filter((c) => [c.node, c.parent].some((x) => x && ids.has(x))) });
    }
    // GET nodes/<id>/export[/<branch>]: the text format, as a download.
    if (action === "export" && method === "GET") {
      const { text, skipped } = serializeDoc(snap, id);
      res.writeHead(200, {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename="${slugify(snap.nodes[id].title) || "untitled"}${name === "main" ? "" : `-${encodeURIComponent(name)}`}.md"`,
        "x-skipped": JSON.stringify(skipped),
      });
      return res.end(text);
    }
    // POST nodes/<id>/import?name=file.md, with the file as the body: a new last child of the node (on main).
    if (action === "import" && !branch && method === "POST") {
      const file = (url.searchParams.get("name") ?? "").replace(/^.*[\\/]/, "").slice(0, 200) || "import.md";
      let text: string;
      try {
        text = (await readBody(req, IMPORT_MAX)).toString("utf8");
      } catch (err) {
        if (err instanceof HttpError && err.status === 413) return json(res, 413, { error: `the file is too large to import (the limit is ${IMPORT_MAX / 1024 / 1024} MB)` });
        throw err;
      }
      const main = this.store.main;
      if (!main.snap().nodes[id]) return json(res, 404, { error: `no such node on main: ${id}` });
      try {
        const top = importTree(main, text, file, { creator: this.shared.user, parent: id });
        this.wrote("main");
        return json(res, 201, { node: top, title: main.snap().nodes[top].title });
      } catch (err) {
        if (err instanceof FormatError) return json(res, 422, { error: err.message, problems: err.problems });
        throw err;
      }
    }
    json(res, 404, { error: "not found" });
  }
}
