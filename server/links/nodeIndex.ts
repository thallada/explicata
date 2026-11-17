/**
 * The library's sections as vectors, for "closely matching nodes under other tops": a VectorIndex
 * (server/embed.ts) of each section's title and text, kept current from the snapshot's patches.
 * A patch only marks the nodes it touched; they are re-embedded later, a batch at a time, off the
 * request that made the edit (a section whose text is unchanged is skipped by its hash). Without a
 * model the index still holds the texts, so BM25 search works and "related" is text-only.
 */
import { inArticles } from "../../src/core/article";
import { Doc, isLibraryRoot, topOf, type NodeId, type Snap } from "../../src/core/model";
import { plain } from "../../src/core/text";
import { VectorIndex, type Embedder, type Hit, type HybridHit } from "../embed";

/** What a section is embedded as. */
const nodeText = (snap: Snap, id: NodeId) => {
  const n = snap.nodes[id];
  return `${n.title}\n${plain(n.body)}`.trim();
};

/** Sections (the root's children too) worth indexing: not the library root, not notes, not the Wikipedia container's, and with some text. */
const indexable = (snap: Snap, id: NodeId) => {
  const n = snap.nodes[id];
  return !!n && n.kind === "section" && !isLibraryRoot(snap, id) && !inArticles(snap, id) && (n.body.trim().length > 0 || n.title.trim().length > 0);
};

interface IndexStatus {
  size: number;
  pending: number;
  /** Embeddings are unavailable: the index holds texts only. */
  degraded: boolean;
  lastMs: number | null;
}

export class NodeIndex {
  readonly vectors: VectorIndex;
  private dirty = new Set<NodeId>();
  private all = true;
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  degraded = false;
  lastMs: number | null = null;

  constructor(
    private doc: () => Doc,
    o: { file: string | null; embedder: Embedder | null; delayMs?: number },
  ) {
    this.vectors = new VectorIndex(o.file, o.embedder);
    this.delay = o.delayMs ?? 2000;
  }
  private delay: number;

  /** Follow a library's patches. Marking is all a patch costs; the embedding happens later. */
  watch(doc: Doc) {
    doc.onPatch((was) => {
      if (!was) this.all = true;
      else for (const id of was.keys()) this.dirty.add(id);
      this.schedule();
    });
    this.schedule();
  }

  /** Start keeping the index current (and so load the model): on the first request that needs it. */
  activate() {
    if (this.active) return;
    this.active = true;
    this.schedule();
  }
  private active = false;

  private schedule() {
    if (this.timer || !this.delay || !this.active) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh();
    }, this.delay);
    this.timer.unref?.();
  }

  get status(): IndexStatus {
    return { size: this.vectors.size, pending: this.all ? -1 : this.dirty.size, degraded: this.degraded, lastMs: this.lastMs };
  }

  /** Bring the index up to date with the library: the marked nodes, or all of them after a whole read. */
  refresh(): Promise<void> {
    if (this.running) return this.running.then(() => (this.all || this.dirty.size ? this.refresh() : undefined));
    this.running = (async () => {
      const t0 = performance.now();
      const snap = this.doc().snap();
      const ids = this.all ? (Object.keys(snap.nodes) as NodeId[]) : [...this.dirty];
      const whole = this.all;
      this.all = false;
      this.dirty.clear();
      const items = ids.filter((id) => indexable(snap, id)).map((id) => ({ id, text: nodeText(snap, id) }));
      const gone = whole ? this.vectors.ids().filter((id) => !indexable(snap, id as NodeId)) : ids.filter((id) => !indexable(snap, id));
      this.vectors.remove(gone, false);
      const report = await this.vectors.upsert(items);
      if (report.degraded) this.degraded = true;
      else if (report.embedded) this.degraded = false;
      if (gone.length && !report.embedded && !report.withoutVector) this.vectors.save();
      this.lastMs = Math.round(performance.now() - t0);
    })().finally(() => (this.running = null));
    return this.running;
  }

  /**
   * Sections close in meaning to a text, from under other tops than `top`, best first. Excludes the
   * node, its ancestors and its descendants. Null if there is no model.
   */
  async near(text: string, o: { exclude: Set<NodeId>; top: NodeId | null; k?: number; snap: Snap; vector?: Float32Array | null }): Promise<Hit[] | null> {
    const k = o.k ?? 8;
    // Never built (a first start): build it now rather than answer from nothing.
    if (!this.vectors.size && (this.all || this.running)) await this.refresh();
    const filter = (id: string) => !o.exclude.has(id as NodeId) && !!o.snap.nodes[id as NodeId] && topOf(o.snap, id as NodeId) !== o.top;
    if (o.vector) return this.vectors.searchVector(o.vector, k, filter);
    const v = await this.vectors.vector(text);
    return v ? this.vectors.searchVector(v, k, filter) : null;
  }

  /** Text and meaning fused (BM25 alone without a model): for the model's "nearby" list. */
  async hybrid(query: string, k: number, filter?: (id: string) => boolean): Promise<HybridHit[]> {
    if (!this.vectors.size && (this.all || this.running)) await this.refresh();
    return this.vectors.hybrid(query, k, filter);
  }
}
