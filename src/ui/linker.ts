/**
 * Link discovery as the browser sees it: asking the server to scan a node (server/links) after it
 * is written; in `review` mode, having the model reviewer judge what was found there and making
 * the links it approved at once, as their own commit by "reviewer" (so `u` takes them back); with
 * `on`, making the scanner's `auto` tier the same way; keeping the rest as suggestions drawn in the
 * text; accepting and declining them, and removing a link for good; every determination as a row of
 * the links list (S); the Related list, the background job's progress, and the "nearby" list a
 * model is given before it writes.
 *
 * Nothing here runs on a keystroke: scans are queued after a write is saved and run one at a time.
 */
import type { JobState } from "../../server/links/jobs";
import type { ReviewReport } from "../../server/links/review";
import type { Related as RelatedRow, Suggestion as Sugg } from "../../server/links/scan";
import { inArticles } from "../core/article";
import { applyLinks, nodeRef, phraseKey } from "../core/links";
import type { Mark } from "../core/marks";
import { ancestors, isLink, topOf, label, notesOf, type Doc, type NodeId, type Op, type Snap } from "../core/model";
import { describeTarget, sameTarget, type Ref } from "../core/ref";
import { clip, overlaps, type Range } from "../core/text";
import type { Nearby } from "../llm/prompts";

export type { JobState, ReviewReport, Sugg };
/** After an edit: the model reviews what was found and links what it approves (review), the sure tier is linked (on), all is suggested (suggest), nothing is looked for (off). */
export type AutoMode = "review" | "on" | "suggest" | "off";

/** Where a candidate link stands: made, turned down (by the reviewer or a person), or waiting. */
export type Status = "linked" | "rejected" | "pending";

/** A row of the links list: a stored suggestion, a link in the text, or a declined phrase, as it stands now. */
export interface LinkRow {
  key: string;
  node: NodeId;
  /** Where the words are now; null for a declined phrase whose words are not known. */
  range: Range | null;
  quote: string;
  target: Ref | null;
  /** The target's title. */
  title: string;
  status: Status;
  /** Who decided: "reviewer", a person's name, or null when it is not known (a link made by hand, an old decline). */
  by: string | null;
  /** The reviewer's one-line reason, when it gave one. */
  reason: string | null;
  /** What the reviewer said, when it said something different from how things stand (a person overruled it). */
  verdict: boolean | null;
  at: number | null;
  sugg?: Sugg;
  /** The link's own note, when it is linked. */
  note?: NodeId;
}

/** What the linker needs from the page's store. */
interface Host {
  doc(): Doc;
  user(): string;
  mode(): AutoMode;
  /** Whether the server has a model (without one, review falls back to suggesting). */
  generating(): boolean;
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

/** Turned down: declined by a person, or rejected by the reviewer and not linked by a person since. */
const turnedDown = (snap: Snap, s: Sugg) => !!snap.nodes[s.node]?.nolink?.includes(s.key) || s.decided?.link === false || (s.review?.link === false && !s.decided?.link);

/** A suggestion as it applies to a node's text now: its words where they are, or null if they are gone, taken or turned down. */
function place(snap: Snap, s: Sugg, overrule = false): Sugg | null {
  const n = snap.nodes[s.node];
  if (!n || (!overrule && turnedDown(snap, s))) return null;
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

/** Where a stored suggestion's words are now, or null if they are gone. */
function locate(body: string, s: Sugg): Range | null {
  if (body.slice(s.range[0], s.range[1]) === s.quote) return s.range;
  const at = body.indexOf(s.quote);
  return at < 0 ? null : [at, at + s.quote.length];
}

/** A target's title, for a row. */
function titleOf(snap: Snap, r: Ref): string {
  if (r.kind === "node") return r.id && snap.nodes[r.id] ? label(snap, r.id) : (r.path ?? []).join(" › ") || "a note";
  return r.kind === "wiki" ? r.title : (r.title ?? r.url);
}

/** A stored suggestion as a row, as things stand in the text now; null if its words are gone or carry another link. */
function rowOf(snap: Snap, s: Sugg): LinkRow | null {
  const n = snap.nodes[s.node];
  if (!n) return null;
  const range = locate(n.body, s);
  if (!range) return null;
  const base = { key: s.id, node: s.node, range, quote: s.quote, target: s.target, title: s.title, reason: s.review?.reason ?? null, sugg: s };
  for (const c of notesOf(snap, s.node)) {
    const note = snap.nodes[c];
    if (!note.ref || !note.anchors.some((a) => overlaps([a.start, a.end], range))) continue;
    if (!sameTarget(note.ref, s.target)) return null;
    const by = s.decided?.link ? s.decided.by : s.review?.link ? "reviewer" : null;
    return { ...base, status: "linked", by, verdict: s.review && by !== "reviewer" ? s.review.link : null, at: s.decided?.at ?? s.review?.at ?? null, note: c };
  }
  if (n.nolink?.includes(s.key) || s.decided?.link === false) {
    const by = s.decided?.link === false ? s.decided.by : null;
    return { ...base, status: "rejected", by, verdict: s.review ? s.review.link : null, at: s.decided?.at ?? null };
  }
  if (s.review?.link === false && !s.decided?.link) return { ...base, status: "rejected", by: "reviewer", verdict: null, at: s.review.at };
  return { ...base, status: "pending", by: null, verdict: s.review ? s.review.link : null, at: s.review?.at ?? null };
}

export class Linker {
  /** Suggestions by node, as the server stores them, with what was decided about each (placed again whenever read). */
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

  /**
   * The links list: under these nodes (in reading order), every stored suggestion as it stands, every
   * link in the text that no suggestion accounts for (made by hand, or before determinations were
   * kept), and every declined phrase no suggestion accounts for (its target was not kept).
   */
  rows(ids: NodeId[], snap: Snap): LinkRow[] {
    const out: LinkRow[] = [];
    for (const id of ids) {
      const n = snap.nodes[id];
      if (!n) continue;
      const mine: LinkRow[] = [];
      const seen = new Set<string>();
      for (const s of this.byNode.get(id) ?? []) {
        const r = rowOf(snap, s);
        if (!r) continue;
        if (r.note && mine.some((x) => x.note === r.note)) continue;
        if (r.status === "pending" && mine.some((x) => x.status === "pending" && x.range && overlaps(x.range, r.range!))) continue;
        mine.push(r);
        seen.add(r.quote ? phraseKey(r.quote) : "");
      }
      for (const c of notesOf(snap, id)) {
        const note = snap.nodes[c];
        const a = note.anchors[0];
        if (!note.ref || !a || mine.some((x) => x.note === c)) continue;
        const quote = n.body.slice(a.start, a.end);
        mine.push({ key: `note:${c}`, node: id, range: [a.start, a.end], quote, target: note.ref, title: titleOf(snap, note.ref), status: "linked", by: null, reason: null, verdict: null, at: null, note: c });
        seen.add(phraseKey(quote));
      }
      for (const k of n.nolink ?? []) {
        if (seen.has(k) || (this.byNode.get(id) ?? []).some((s) => s.key === k)) continue;
        mine.push({ key: `nolink:${id}:${k}`, node: id, range: null, quote: k, target: null, title: "", status: "rejected", by: null, reason: null, verdict: null, at: null });
      }
      out.push(...mine.sort((a, b) => (a.range?.[0] ?? 1e9) - (b.range?.[0] ?? 1e9)));
    }
    return out;
  }

  // ---- scanning ----

  /** Queue a scan of a node that was just written. Off the keystroke: it runs after the write is saved. */
  scan(node: NodeId, origin: Origin, forced: Mark[] = []) {
    if (this.host.mode() === "off" && !(origin === "human" && forced.length)) return;
    // Annotations on Wikipedia articles are not a document's text: nothing in them is linked.
    const snap = this.host.doc().snap();
    if (snap.nodes[node] && inArticles(snap, node)) return;
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
    const d = topOf(snap, id);
    return {
      node: id,
      text: n.body,
      title: n.title,
      top: d,
      topTitle: d ? snap.nodes[d].title : "",
      ancestors: ancestors(snap, id),
      occupied: notesOf(snap, id).flatMap((c) => snap.nodes[c].anchors.map((a) => [a.start, a.end, !!snap.nodes[c].ref])),
      rejected: n.nolink ?? [],
      forced,
    };
  }

  /** The mode in effect: review needs a model, and without one is suggest. */
  effective(): AutoMode {
    const m = this.host.mode();
    return m === "review" && !this.host.generating() ? "suggest" : m;
  }

  private async run(t: Task) {
    const doc = this.host.doc();
    const snap = doc.snap();
    if (!snap.nodes[t.node]) return;
    const review = this.effective() === "review" ? (t.origin === "human" ? "unmarked" : "all") : undefined;
    const res = await post("scan", { ...this.request(snap, t.node, t.forced), ...(review ? { review } : {}) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? `the server answered ${res.status}`);
    const r = (await res.json()) as { suggestions: Sugg[]; entries?: Sugg[]; apply?: Sugg[]; review?: ReviewReport; unresolved: string[]; degraded: string[] };
    this.take(doc, t.node, r, t.origin);
  }

  /**
   * What a scan found, applied as the mode says: with `review`, the links the reviewer approved, as
   * one commit by "reviewer"; with `on`, the auto tier, as one commit by "linker"; a person's own
   * [[marks]] always, by "linker". Everything still pending waits, drawn in the text; what the
   * reviewer rejected waits behind the links list's filter.
   */
  private take(doc: Doc, node: NodeId, r: { suggestions: Sugg[]; entries?: Sugg[]; apply?: Sugg[]; review?: ReviewReport; unresolved: string[]; degraded: string[] }, origin: Origin) {
    const mode = this.effective();
    const marked = (s: Sugg) => s.kind === "forced";
    const list = r.suggestions;
    const now = list.filter((s) => (marked(s) && (origin === "human" || mode === "on")) || (s.tier === "auto" && mode === "on"));
    // Marks are offered only while something is looked for.
    const stored = (r.entries ?? list).filter((s) => !(marked(s) && mode === "off") && !now.some((x) => x.id === s.id));
    this.byNode.set(node, stored);
    const placed = this.applyAuto(now, doc);
    const approved = this.applyAuto(r.apply ?? [], doc, "reviewer");
    const later = this.forNode(node, doc.snap());
    const rep = r.review;
    const rejected = rep?.rejected ?? 0;
    if (r.unresolved.length && origin === "human") this.host.say(`Found nothing to link for ${r.unresolved.map((u) => `“${clip(u, 40)}”`).join(", ")}; the brackets were taken out.`);
    else if (approved.length) this.host.say(`${this.linkedText(approved)} · u undoes${rejected ? ` · ${rejected} rejected` : ""}${later.length ? ` · ${later.length} to review` : ""} · S lists them`);
    else if (rep?.fallback && later.length) this.host.say(`${this.fallbackText(rep.fallback)}: ${later.length} link suggestion${later.length > 1 ? "s" : ""} for you · Tab reaches ${later.length > 1 ? "them" : "it"}, y links, n declines`);
    else if (rejected && !placed.length) this.host.say(`The reviewer rejected ${rejected} link${rejected > 1 ? "s" : ""} here${later.length ? `; ${later.length} left to review` : ""} · S lists them`);
    else if (!placed.length && later.length && origin !== "import") this.host.say(`${later.length} link suggestion${later.length > 1 ? "s" : ""}: Tab reaches ${later.length > 1 ? "them" : "it"}, y links, n declines${r.degraded.length ? ` (${r.degraded[0]})` : ""}`);
    this.host.emit(node);
  }

  /** "Reviewer unavailable (why)", for the status line. */
  fallbackText(why: string): string {
    return `Not reviewed (${why})`;
  }

  private linkedText(placed: Sugg[]): string {
    return `Linked ${placed.map((s) => `“${clip(s.quote, 30)}” → ${clip(s.title, 40)}`).slice(0, 3).join(", ")}${placed.length > 3 ? ` and ${placed.length - 3} more` : ""}`;
  }

  /**
   * Make links without asking, as one commit (an ordinary commit: `u` takes it back): by "linker"
   * for the scanner's sure tier and a person's marks, by "reviewer" for what the reviewer approved.
   */
  applyAuto(list: Sugg[], doc = this.host.doc(), by: "linker" | "reviewer" = "linker"): Sugg[] {
    const snap = doc.snap();
    const placed = list.map((s) => place(snap, s)).filter((s): s is Sugg => !!s);
    if (!placed.length) return [];
    const one = placed.length === 1 ? `“${clip(placed[0].quote, 40)}”` : `${placed.length} phrases`;
    const r = applyLinks(doc, placed.map((s) => ({ node: s.node, range: s.range, target: s.target })), {
      author: by,
      actor: "llm",
      tag: by === "reviewer" ? "review" : "autolink",
      message: by === "reviewer" ? `Link ${one} (approved by the reviewer)` : `Link ${one} automatically`,
    });
    if (by === "linker" && r.created.length + r.merged.length) this.host.say(`${this.linkedText(placed)} · u undoes`);
    return placed;
  }

  /**
   * A document's stored suggestions from the server, with what was decided about each (what a
   * background job found, and the reviewer's verdicts), once per page load or on demand. With
   * `claim`, also the links the reviewer approved that no page has made yet, handed to this one.
   */
  async loadDoc(docId: NodeId, force = false, claim = false): Promise<{ found: Sugg[]; apply: Sugg[] }> {
    if (!force && this.fetched.has(docId)) return { found: [], apply: [] };
    this.fetched.add(docId);
    try {
      const res = await fetch(`/api/links/pending?doc=${encodeURIComponent(docId)}&all=1${claim ? "&claim=1" : ""}`);
      if (!res.ok) return { found: [], apply: [] };
      const r = (await res.json()) as { suggestions: Sugg[]; apply?: Sugg[] };
      const by = new Map<NodeId, Sugg[]>();
      for (const s of r.suggestions) by.set(s.node, [...(by.get(s.node) ?? []), s]);
      for (const [id, list] of by) this.byNode.set(id, list);
      // Nothing to draw, nothing to redraw: a document opened is not repainted for an empty list.
      if (by.size) this.host.emit(...by.keys());
      return { found: r.suggestions, apply: r.apply ?? [] };
    } catch {
      return { found: [], apply: [] };
    }
  }

  // ---- the writer's decisions ----

  /** y: link these suggestions, as the writer's own commit. `overrule`: even ones turned down (by the reviewer, or a person earlier). */
  accept(list: Sugg[], overrule = false): number {
    const doc = this.host.doc();
    const snap = doc.snap();
    const placed = list.map((s) => place(snap, s, overrule)).filter((s): s is Sugg => !!s);
    if (!placed.length) return 0;
    const r = applyLinks(doc, placed.map((s) => ({ node: s.node, range: s.range, target: s.target })), {
      author: this.host.user(),
      actor: "human",
      message: placed.length === 1 ? `Link “${clip(placed[0].quote, 40)}” to ${clip(describeTarget(placed[0].target), 50)}` : `Link ${placed.length} suggested phrases`,
    });
    this.decide(placed, true);
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
    this.decide(list, false);
    return list.length;
  }

  /**
   * Remove a link for good: the link goes (a note that also links keeps its text and loses its
   * target), and its words' phrase is declined in its node, in one commit, so neither the scanner nor
   * the reviewer makes it again. Returns the phrase declined, or null if this is not a link.
   */
  removeLink(note: NodeId): string | null {
    const doc = this.host.doc();
    const snap = doc.snap();
    const n = snap.nodes[note];
    const parent = n?.parent ? snap.nodes[n.parent] : undefined;
    const a = n?.anchors[0];
    if (!n?.ref || n.kind !== "note" || !parent || !a) return null;
    const quote = parent.body.slice(a.start, a.end);
    const key = phraseKey(quote);
    const ops: Op[] = [isLink(n) ? { op: "delete", id: note } : { op: "update", id: note, ref: null }];
    if (key) ops.push({ op: "update", id: parent.id, nolink: [key] });
    doc.as(this.host.user(), () => doc.apply(ops, `Remove the link on “${clip(quote, 40)}” (not to be made again here)`, { tag: "nolink" }));
    const ref = n.ref;
    this.decide((this.byNode.get(parent.id) ?? []).filter((s) => s.key === key && sameTarget(s.target, ref)), false);
    return key || quote;
  }

  /** Record a person's decision here and on the server, so the list says who decided and the reviewer never judges it again. */
  private decide(list: Sugg[], link: boolean) {
    if (!list.length) return;
    const by = this.host.user();
    const at = Date.now();
    const ids = new Set(list.map((s) => s.id));
    for (const [, l] of this.byNode) for (const s of l) if (ids.has(s.id)) s.decided = { link, by, at };
    void post("decide", { ids: [...ids], link, by }).catch(() => {});
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
      const { node, text, title, top, topTitle, ancestors: up } = this.request(snap, id, []);
      void post("related", { node, text, title, top, topTitle, ancestors: up })
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
    const res = await post("jobs", { scope, doc, review: this.effective() === "review" });
    const r = await res.json().catch(() => ({}));
    if (!res.ok) return r.error ?? `the server answered ${res.status}`;
    // A short job's end can be announced before this answer arrives: keep the later news.
    const had = this.job;
    if (had && had.id === r.job.id && had.state !== "running") return had;
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
