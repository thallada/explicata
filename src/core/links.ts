/**
 * Links between nodes, and from nodes to Wikipedia and the web: the backlinks index, finding a
 * node target again when its id is gone, and applying a batch of links through the op API.
 *
 * A link is a note with a target and no body, so it is anchored, orphaned, healed, merged, undone
 * and versioned like any note. Nothing here is stored except through ops; the index is derived.
 */
import { Doc, ancestors, notesOf, sections, topOf, type Actor, type NodeId, type NodeSnap, type Op, type Snap } from "./model";
import { sameTarget, wikiKey, type Ref } from "./ref";
import { clip, type Range } from "./text";

// ---- finding a node target ----

/** The nearest section at or above a node: the place a note's text is read in. */
export function ownerSection(snap: Snap, id: NodeId): NodeId {
  let n = snap.nodes[id];
  while (n && n.kind === "note" && n.parent) n = snap.nodes[n.parent];
  return n?.id ?? id;
}

/** A target naming a node, with the hint that finds it again: the titles down to it from the library root. */
export function nodeRef(snap: Snap, id: NodeId): Ref & { kind: "node" } {
  const n = snap.nodes[id];
  const path: string[] = [];
  for (let x = snap.nodes[ownerSection(snap, id)]; x?.parent; x = snap.nodes[x.parent]) path.unshift(x.title);
  const out: Ref & { kind: "node" } = { kind: "node", id, path };
  if (n.kind === "note") out.quote = n.anchors[0]?.text || n.anchors[0]?.quote || "";
  return out;
}

/**
 * The node a target names: by id while it exists, else by its hint (section titles and a note's
 * quote). `here` is where the target is written: a relative path is read from its top, and where
 * two sections share a title, the one `here` is in wins. Null if neither finds it.
 */
export function resolveNode(snap: Snap, ref: Ref & { kind: "node" }, here?: NodeId): NodeId | null {
  if (ref.id && snap.nodes[ref.id]) return ref.id;
  if (!ref.path) return null;
  const from = ref.rel ? (here ? topOf(snap, here) : null) : snap.root;
  return from ? walkTitles(snap, from, ref.path, ref.quote, here) : null;
}

/**
 * Walk section titles down from a node: exact title first, then ignoring case, and among sections
 * sharing a title the one `here` is in. With a quote, the note of the last section on those words.
 */
export function walkTitles(snap: Snap, from: NodeId, path: string[], quote: string | undefined, here?: NodeId): NodeId | null {
  const mine = new Set(here && snap.nodes[here] ? [here, ...ancestors(snap, here)] : []);
  let at = from;
  for (const title of path) {
    const kids = sections(snap, at);
    let same = kids.filter((c) => snap.nodes[c].title === title);
    if (!same.length) same = kids.filter((c) => snap.nodes[c].title.toLowerCase() === title.toLowerCase());
    if (!same.length) return null;
    at = same.find((c) => mine.has(c)) ?? same[0];
  }
  if (quote === undefined) return at;
  return notesOf(snap, at).find((c) => snap.nodes[c].anchors.some((a) => a.text === quote || a.quote === quote)) ?? null;
}

// ---- the backlinks index ----

/**
 * For each node, the nodes that link to it; for each Wikipedia article, the nodes that link to it.
 * Kept current from the snapshot's patches (Doc.onPatch), so a change costs what it touched, and
 * built whole only when the snapshot is read whole (boot, checkout).
 */
export class LinkIndex {
  private byNode = new Map<NodeId, Set<NodeId>>();
  private byWiki = new Map<string, Set<NodeId>>();
  /** Node targets with no id yet (written from a file, waiting for their target to be imported). */
  private unresolved = new Set<NodeId>();

  constructor(private doc: Doc) {
    doc.onPatch((was, nodes) => {
      if (!was) return this.rebuild(nodes);
      for (const [id, before] of was) {
        if (before?.ref) this.file(id, before.ref, false);
        const after = nodes[id];
        if (after?.ref && !articleNode(nodes, after)) this.file(id, after.ref, true);
      }
    });
    this.rebuild(doc.snap().nodes);
  }

  private rebuild(nodes: Record<NodeId, NodeSnap>) {
    this.byNode.clear();
    this.byWiki.clear();
    this.unresolved.clear();
    for (const id in nodes) {
      const r = nodes[id as NodeId].ref;
      if (r && !articleNode(nodes, nodes[id as NodeId])) this.file(id as NodeId, r, true);
    }
  }

  private file(id: NodeId, r: Ref, add: boolean) {
    if (r.kind === "url") return;
    if (r.kind === "node" && !r.id) {
      if (add) this.unresolved.add(id);
      else this.unresolved.delete(id);
      return;
    }
    const map = r.kind === "node" ? this.byNode : this.byWiki;
    const key = r.kind === "node" ? r.id! : wikiKey(r.lang, r.title);
    let set = map.get(key);
    if (add) {
      if (!set) map.set(key, (set = new Set()));
      set.add(id);
    } else if (set) {
      set.delete(id);
      if (!set.size) map.delete(key);
    }
  }

  /** The nodes whose target is this node. */
  linksTo(id: NodeId): NodeId[] {
    this.doc.snap();
    return [...(this.byNode.get(id) ?? [])];
  }

  /** The nodes whose target is this article. */
  mentions(lang: string, title: string): NodeId[] {
    this.doc.snap();
    return [...(this.byWiki.get(wikiKey(lang, title)) ?? [])];
  }

  /** Nodes whose node target is gone or was never found: what healing tries to find again. */
  broken(): NodeId[] {
    const snap = this.doc.snap();
    const out = [...this.unresolved];
    for (const [target, from] of this.byNode) if (!snap.nodes[target]) out.push(...from);
    return out;
  }

  /** Every Wikipedia article linked from the library, with how many nodes link to it. */
  articles(): { key: string; count: number }[] {
    this.doc.snap();
    return [...this.byWiki].map(([key, s]) => ({ key, count: s.size }));
  }
}

/** An article's own node in the Wikipedia container (article.ts) is where its annotations hang, not a mention of it. */
const articleNode = (nodes: Record<NodeId, NodeSnap>, n: NodeSnap) => !!n.parent && !!nodes[n.parent]?.articles;

const indexes = new WeakMap<Doc, LinkIndex>();
/** The backlinks index of a library, made on first use and kept current from then on. */
export function linkIndex(doc: Doc): LinkIndex {
  let ix = indexes.get(doc);
  if (!ix) indexes.set(doc, (ix = new LinkIndex(doc)));
  return ix;
}

// ---- healing ----

/**
 * Find node targets again whose node is gone (undoing a delete brings nodes back under new ids)
 * or was never found (a file linking to a text imported later), from the hint each carries.
 * One system commit, which undo steps over. Returns how many were found.
 */
export function healLinks(doc: Doc): number {
  const snap = doc.snap();
  const ops: Op[] = [];
  for (const id of linkIndex(doc).broken()) {
    const n = snap.nodes[id];
    if (!n || n.ref?.kind !== "node") continue;
    const found = resolveNode(snap, n.ref, id);
    if (found && found !== n.ref.id) ops.push({ op: "update", id, ref: nodeRef(snap, found) });
  }
  if (ops.length) doc.apply(ops, `Find ${ops.length} link target${ops.length > 1 ? "s" : ""} again`, { actor: "llm", tag: "regen" });
  return ops.length;
}

// ---- applying links ----

export interface LinkSpec {
  /** The node whose text is linked. */
  node: NodeId;
  /** The linked words: the first occurrence of this text in the node's body… */
  quote?: string;
  /** …or these offsets into it. */
  range?: Range;
  target: Ref;
}

export interface LinkResult {
  created: NodeId[];
  /** Existing notes on the same span that took the target. */
  merged: NodeId[];
  /** Spans that already had this target. */
  same: number;
  /** Spans that already had a different target: left alone, so a person's link is never replaced. */
  occupied: number;
  /** Specs whose node or words could not be found. */
  missing: number;
}

/**
 * Link spans of text to targets, as one commit through the op API: a span that already carries
 * the target is skipped, a span that carries a note without a target gives that note the target
 * (one node, not two stacked on the same words), and a span that already links elsewhere is left
 * alone. Running the same batch twice changes nothing the second time. Made for bulk use: link
 * discovery calls this with whatever it found.
 */
export function applyLinks(doc: Doc, specs: LinkSpec[], meta: { message?: string; actor?: Actor; author?: string; tag?: string } = {}): LinkResult {
  const snap = doc.snap();
  const out: LinkResult = { created: [], merged: [], same: 0, occupied: 0, missing: 0 };
  const ops: Op[] = [];
  const claimed = new Map<string, Ref>();
  for (const s of specs) {
    const n = snap.nodes[s.node];
    let range = s.range;
    if (n && !range && s.quote) {
      const at = n.body.indexOf(s.quote);
      if (at >= 0) range = [at, at + s.quote.length];
    }
    if (!n || !range || range[1] <= range[0] || range[1] > n.body.length) {
      out.missing++;
      continue;
    }
    const key = `${s.node}:${range[0]}:${range[1]}`;
    const earlier = claimed.get(key);
    const onSpan = notesOf(snap, s.node).filter((c) => snap.nodes[c].anchors.some((a) => a.start === range![0] && a.end === range![1]));
    const current = earlier ?? onSpan.map((c) => snap.nodes[c].ref).find(Boolean);
    if (current) {
      if (sameTarget(current, s.target)) out.same++;
      else out.occupied++;
      continue;
    }
    claimed.set(key, s.target);
    const plain = onSpan.find((c) => !snap.nodes[c].ref);
    if (plain) {
      ops.push({ op: "update", id: plain, ref: s.target });
      out.merged.push(plain);
    } else ops.push({ op: "create", parent: s.node, kind: "note", anchors: [range], ref: s.target });
  }
  if (!ops.length) return out;
  const first = specs.find((s) => s.target)?.target;
  const message = meta.message ?? (ops.length === 1 && first ? `Link to ${clip(first.kind === "wiki" ? first.title : first.kind === "url" ? first.url : (first.path ?? []).join(" › ") || "a node", 50)}` : `Add ${ops.length} links`);
  out.created = doc.as(meta.author ?? doc.author, () => doc.apply(ops, message, { actor: meta.actor ?? "human", tag: meta.tag ?? "link" }).created);
  return out;
}

/** What a target is, for telling one from another: an article by title, a node by id, a page by address. */
export const targetKey = (r: Ref) => (r.kind === "wiki" ? wikiKey(r.lang, r.title) : r.kind === "node" ? `node:${r.id}` : r.url);

// ---- phrases ----

/** A light English singular: enough for "cephalopods", "octopuses", "theories", "boxes". */
export function singular(w: string): string {
  if (w.length <= 3) return w;
  if (/ies$/i.test(w) && w.length > 4) return w.slice(0, -3) + (w[w.length - 1] === "S" ? "Y" : "y");
  if (/(uses|sses|shes|ches|xes|zes)$/i.test(w)) return w.slice(0, -2);
  if (/s$/i.test(w) && !/(ss|us|is|ous)$/i.test(w) && !/ies$/i.test(w)) return w.slice(0, -1);
  return w;
}

/**
 * Normalised form of a phrase, for comparing phrases with each other and with titles: what link
 * discovery matches titles with and what a declined link records in its node's `nolink`.
 */
export function phraseKey(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/['’]s\b/g, "")
    .replace(/[-–‑_/]/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .split(/\s+/)
    .filter(Boolean)
    .filter((w, i, all) => !(i === 0 && all.length > 1 && (w === "the" || w === "a" || w === "an")))
    .map(singular)
    .join(" ");
}
