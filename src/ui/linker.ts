/**
 * Link discovery as the browser sees it: asking the server to scan a node (server/links) after it
 * is written, applying the `auto` tier at once as its own commit (so `u` takes it back), keeping
 * the rest as suggestions drawn in the text, accepting and declining them, the Related list, the
 * background job's progress, and the "nearby" list a model is given before it writes.
 *
 * Nothing here runs on a keystroke: scans are queued after a write is saved and run one at a time.
 */
import type { JobState } from "../../server/links/jobs";
import type { Related as RelatedRow, Suggestion as Sugg } from "../../server/links/scan";
import { applyLinks, nodeRef } from "../core/links";
import type { Mark } from "../core/marks";
import { ancestors, docOf, notesOf, type Doc, type NodeId, type Snap } from "../core/model";
import { describeTarget, sameTarget } from "../core/ref";
import { clip, overlaps, type Range } from "../core/text";
import type { Nearby } from "../llm/prompts";

export type { JobState, Sugg };
export type AutoMode = "on" | "suggest" | "off";

/** What the linker needs from the page's store. */
interface Host {
  doc(): Doc;
  user(): string;
  mode(): AutoMode;
  say(text: string): void;
  emit(...ids: NodeId[]): void;
  /** Whether a node is drawn now (its Related list is fetched only then). */
  rendered(id: NodeId): boolean;
}

/** Who wrote the text being scanned: a person's marks always resolve; a model's follow the mode. */
type Origin = "human" | "model" | "import";

interface Task {
  node: NodeId;
  origin: Origin;
  forced: Mark[];
}

/** Run when the page has nothing better to do (soon, regardless, after a second). */
const idle = (fn: () => void) => (typeof requestIdleCallback === "function" ? requestIdleCallback(fn, { timeout: 1000 }) : setTimeout(fn, 50));

const post = (path: string, body: unknown, signal?: AbortSignal) =>
  fetch(`/api/links/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });

/** A suggestion as it applies to a node's text now: its words where they are, or null if they are gone or taken. */
function place(snap: Snap, s: Sugg): Sugg | null {
  const n = snap.nodes[s.node];
  if (!n || n.nolink?.includes(s.key)) return null;
  let range = s.range;
  if (n.body.slice(range[0], range[1]) !== s.quote) {
    const at = n.body.indexOf(s.quote);
    if (at < 0) return null;
    range = [at, at + s.quote.length];
  }
  for (const c of notesOf(snap, s.node)) {
    const note = snap.nodes[c];
    for (const a of note.anchors) {
      if (!overlaps([a.start, a.end], range)) continue;
      // A plain note on exactly these words may take the target; anything else in the way blocks it.
      if (note.ref || a.start !== range[0] || a.end !== range[1]) return null;
    }
    if (note.ref && sameTarget(note.ref, s.target)) return null;
  }
  return range === s.range ? s : { ...s, range };
}

export class Linker {
  /** Pending suggestions by node, as the scanner gave them (placed again whenever read). */
  private byNode = new Map<NodeId, Sugg[]>();
  private related = new Map<NodeId, { body: string; rows: RelatedRow[] | null; done: boolean }>();
  private queue: Task[] = [];
  private running = false;
  job: JobState | null = null;
  /** Documents whose pending list has been fetched since the page loaded. */
  private fetched = new Set<NodeId>();
  /** Scans in flight or queued: the page waits on this in tests (`idle`). */
  busy = 0;

  constructor(private host: Host) {}

  // ---- reading ----

  /** The suggestions on a node, placed in its current text, in text order. */
  forNode(id: NodeId, snap: Snap): Sugg[] {
    const list = this.byNode.get(id);
    if (!list?.length) return [];
    const out: Sugg[] = [];
    for (const s of list) {
      const p = place(snap, s);
      if (p && !out.some((o) => overlaps(o.range, p.range))) out.push(p);
    }
    return out.sort((a, b) => a.range[0] - b.range[0]);
  }

  /** The suggestion on exactly these words, if any. */
  at(id: NodeId, range: Range | undefined, snap: Snap): Sugg | undefined {
    if (!range) return;
    return this.forNode(id, snap).find((s) => s.range[0] === range[0] && s.range[1] === range[1]);
  }

  /** Every pending suggestion under some nodes, in reading order. */
  under(ids: NodeId[], snap: Snap): Sugg[] {
    return ids.flatMap((id) => this.forNode(id, snap));
  }

  // ---- scanning ----

  /** Queue a scan of a node that was just written. Off the keystroke: it runs after the write is saved. */
  scan(node: NodeId, origin: Origin, forced: Mark[] = []) {
    if (this.host.mode() === "off" && !(origin === "human" && forced.length)) return;
    const had = this.queue.find((t) => t.node === node);
    if (had) {
      had.forced = forced.length ? forced : had.forced;
      return;
    }
    this.queue.push({ node, origin, forced });
    this.busy++;
    void this.pump();
  }

  private async pump() {
    if (this.running) return;
    this.running = true;
    try {
      for (let t; (t = this.queue.shift()); ) {
        try {
          await this.run(t);
        } catch (e) {
          if (e instanceof TypeError) this.host.say("Could not reach the server to look for links.");
          else this.host.say(`Looking for links failed: ${e instanceof Error ? e.message : e}`);
        } finally {
          this.busy--;
        }
      }
    } finally {
      this.running = false;
      this.host.emit();
    }
  }

  /** The request a scan sends: the node's own text and context, from this replica, which may be ahead of the server's. */
  private request(snap: Snap, id: NodeId, forced: Mark[]) {
    const n = snap.nodes[id];
    const d = docOf(snap, id);
    return {
      node: id,
      text: n.body,
      title: n.title,
      doc: d,
      docTitle: d ? snap.nodes[d].title : "",
      ancestors: ancestors(snap, id),
      occupied: notesOf(snap, id).flatMap((c) => snap.nodes[c].anchors.map((a) => [a.start, a.end, !!snap.nodes[c].ref])),
      rejected: n.nolink ?? [],
      forced,
    };
  }

  private async run(t: Task) {
    const doc = this.host.doc();
    const snap = doc.snap();
    if (!snap.nodes[t.node]) return;
    const res = await post("scan", this.request(snap, t.node, t.forced));
    if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? `the server answered ${res.status}`);
    const r = (await res.json()) as { suggestions: Sugg[]; unresolved: string[]; degraded: string[] };
    this.take(doc, t.node, r.suggestions, t.origin, r.unresolved, r.degraded);
  }

  /**
   * What a scan found, applied as the mode says: with `on`, the auto tier (and verified marks) at
   * once, as one commit by "linker"; everything else waits, drawn in the text.
   */
  private take(doc: Doc, node: NodeId, list: Sugg[], origin: Origin, unresolved: string[], degraded: string[]) {
    const mode = this.host.mode();
    const snap = doc.snap();
    const marked = (s: Sugg) => s.kind === "forced";
    const now = list.filter((s) => (marked(s) && (origin === "human" || mode === "on")) || (s.tier === "auto" && mode === "on"));
    const later = list.filter((s) => !now.includes(s) && !(marked(s) && mode === "off"));
    const placed = this.applyAuto(now, doc);
    this.byNode.set(node, later);
    if (unresolved.length && origin === "human") this.host.say(`Found nothing to link for ${unresolved.map((u) => `“${clip(u, 40)}”`).join(", ")}; the brackets were taken out.`);
    else if (!placed.length && later.length && origin !== "import") this.host.say(`${later.length} link suggestion${later.length > 1 ? "s" : ""}: Tab reaches ${later.length > 1 ? "them" : "it"}, y links, n declines${degraded.length ? ` (${degraded[0]})` : ""}`);
    this.host.emit(node);
  }

  /** Apply suggestions without asking, as one commit by "linker" (an ordinary commit: `u` takes it back). */
  applyAuto(list: Sugg[], doc = this.host.doc()): Sugg[] {
    const snap = doc.snap();
    const placed = list.map((s) => place(snap, s)).filter((s): s is Sugg => !!s);
    if (!placed.length) return [];
    const r = applyLinks(doc, placed.map((s) => ({ node: s.node, range: s.range, target: s.target })), {
      author: "linker",
      actor: "llm",
      tag: "autolink",
      message: `Link ${placed.length === 1 ? `“${clip(placed[0].quote, 40)}”` : `${placed.length} phrases`} automatically`,
    });
    if (r.created.length + r.merged.length) {
      this.host.say(`Linked ${placed.map((s) => `“${clip(s.quote, 30)}” → ${clip(s.title, 40)}`).slice(0, 3).join(", ")}${placed.length > 3 ? ` and ${placed.length - 3} more` : ""} · u undoes`);
    }
    this.forget(placed);
    return placed;
  }

  /** The pending list of a document from the server (what a background job found), once per page load or on demand. */
  async loadDoc(docId: NodeId, force = false): Promise<Sugg[]> {
    if (!force && this.fetched.has(docId)) return [];
    this.fetched.add(docId);
    try {
      const res = await fetch(`/api/links/pending?doc=${encodeURIComponent(docId)}`);
      if (!res.ok) return [];
      const r = (await res.json()) as { suggestions: Sugg[] };
      const by = new Map<NodeId, Sugg[]>();
      for (const s of r.suggestions) by.set(s.node, [...(by.get(s.node) ?? []), s]);
      for (const [id, list] of by) this.byNode.set(id, list);
      // Nothing to draw, nothing to redraw: a document opened is not repainted for an empty list.
      if (by.size) this.host.emit(...by.keys());
      return r.suggestions;
    } catch {
      return [];
    }
  }

  // ---- the writer's decisions ----

  /** y: link these suggestions, as the writer's own commit. */
  accept(list: Sugg[]): number {
    const doc = this.host.doc();
    const snap = doc.snap();
    const placed = list.map((s) => place(snap, s)).filter((s): s is Sugg => !!s);
    if (!placed.length) return 0;
    const r = applyLinks(doc, placed.map((s) => ({ node: s.node, range: s.range, target: s.target })), {
      author: this.host.user(),
      actor: "human",
      message: placed.length === 1 ? `Link “${clip(placed[0].quote, 40)}” to ${clip(describeTarget(placed[0].target), 50)}` : `Link ${placed.length} suggested phrases`,
    });
    this.forget(placed);
    return r.created.length + r.merged.length;
  }

  /** n: decline these, remembered in each node (so a later scan does not offer them again, here or on another replica). */
  reject(list: Sugg[]): number {
    const doc = this.host.doc();
    const byNode = new Map<NodeId, Set<string>>();
    for (const s of list) if (doc.snap().nodes[s.node]) byNode.set(s.node, (byNode.get(s.node) ?? new Set()).add(s.key));
    if (!byNode.size) return 0;
    const ops = [...byNode].map(([id, keys]) => ({ op: "update" as const, id, nolink: [...keys] }));
    doc.as(this.host.user(), () => doc.apply(ops, list.length === 1 ? `Decline linking “${clip(list[0].quote, 40)}”` : `Decline ${list.length} link suggestions`, { tag: "nolink" }));
    this.forget(list);
    return list.length;
  }

  private forget(list: Sugg[]) {
    const gone = new Set(list.map((s) => s.id));
    for (const [id, l] of this.byNode) this.byNode.set(id, l.filter((s) => !gone.has(s.id) && !list.some((x) => x.node === s.node && x.key === s.key)));
    this.host.emit(...new Set(list.map((s) => s.node)));
  }

  // ---- Related ----

  /** The Related list of a node: fetched when first drawn and again when its text changes. Null while unknown. */
  relatedOf(id: NodeId, snap: Snap): RelatedRow[] | null {
    const n = snap.nodes[id];
    if (!n) return null;
    const cur = this.related.get(id);
    if (cur && cur.body === n.body && cur.done) {
      // Rows that are now linked from this node drop out.
      const linked = new Set(notesOf(snap, id).map((c) => snap.nodes[c].ref).flatMap((r) => (r?.kind === "node" && r.id ? [r.id] : [])));
      return cur.rows?.filter((r) => snap.nodes[r.node] && !linked.has(r.node)) ?? null;
    }
    if (!cur || cur.body !== n.body) this.related.set(id, { body: n.body, rows: cur?.rows ?? null, done: false });
    // Fetched a few at a time, newest first, when the page is idle: opening everything must not
    // send a request per node at once, nor redraw between the keystrokes that opened them.
    this.relatedQueue = [id, ...this.relatedQueue.filter((x) => x !== id)].slice(0, 30);
    idle(() => void this.pumpRelated());
    return cur?.rows ?? null;
  }

  private relatedQueue: NodeId[] = [];
  private relatedBusy = 0;
  private async pumpRelated() {
    while (this.relatedBusy < 2 && this.relatedQueue.length) {
      const id = this.relatedQueue.shift()!;
      const entry = this.related.get(id);
      const snap = this.host.doc().snap();
      if (!entry || !snap.nodes[id]) continue;
      this.relatedBusy++;
      const { node, text, title, doc, docTitle, ancestors: up } = this.request(snap, id, []);
      void post("related", { node, text, title, doc, docTitle, ancestors: up })
        .then(async (res) => {
          const r = res.ok ? ((await res.json()) as { related: RelatedRow[] }) : { related: [] };
          if (this.related.get(id)?.body === entry.body) {
            entry.rows = r.related;
            entry.done = true;
            if (r.related.length) idle(() => this.host.emit(id));
          }
        })
        .catch(() => (entry.done = true))
        .finally(() => {
          this.relatedBusy--;
          void this.pumpRelated();
        });
    }
  }

  /** Turn a Related row into a link on words of the node (the writer's selection there). */
  linkRelated(node: NodeId, range: Range, target: NodeId): boolean {
    const doc = this.host.doc();
    const snap = doc.snap();
    if (!snap.nodes[target] || !snap.nodes[node]) return false;
    const r = applyLinks(doc, [{ node, range, target: nodeRef(snap, target) }], { author: this.host.user(), actor: "human", message: `Link “${clip(snap.nodes[node].body.slice(range[0], range[1]), 40)}” to ${clip(snap.nodes[target].title, 50)}` });
    return r.created.length + r.merged.length > 0;
  }

  // ---- background jobs ----

  async startJob(scope: "doc" | "library", doc?: NodeId): Promise<JobState | string> {
    const res = await post("jobs", { scope, doc });
    const r = await res.json().catch(() => ({}));
    if (!res.ok) return r.error ?? `the server answered ${res.status}`;
    this.job = r.job;
    return r.job;
  }

  async cancelJob(): Promise<boolean> {
    const res = await fetch("/api/links/jobs", { method: "DELETE" });
    const r = await res.json().catch(() => ({}));
    if (r.job) this.job = r.job;
    return !!r.cancelled;
  }

  // ---- for the model ----

  /** The few library nodes near a node, for a model's prompt. Never waits long: a prompt is not held up for it. */
  async nearby(node: NodeId, ms = 400): Promise<Nearby[]> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ms);
    try {
      const snap = this.host.doc().snap();
      if (!snap.nodes[node]) return [];
      const { text, title, ancestors: up } = this.request(snap, node, []);
      const res = await post("nearby?k=5", { node, text, title, ancestors: up }, ac.signal);
      if (!res.ok) return [];
      return ((await res.json()) as { nearby: Nearby[] }).nearby;
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  /** What a scan finds for a node of some replica (the editor agent's fork), without recording it as pending. */
  async peek(doc: Doc, node: NodeId): Promise<Sugg[] | null> {
    const snap = doc.snap();
    if (!snap.nodes[node]) return null;
    try {
      const res = await post("scan", { ...this.request(snap, node, []), save: false });
      if (!res.ok) return null;
      return ((await res.json()) as { suggestions: Sugg[] }).suggestions;
    } catch {
      return null;
    }
  }
}
