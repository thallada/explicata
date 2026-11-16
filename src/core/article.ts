/**
 * Annotations on Wikipedia articles.
 *
 * An article is never copied into the library: it stays in the server's cache and is fetched as it
 * is. What the library keeps is a node per annotated article, under one container (a section of
 * the library root flagged `articles`, created with the first annotation), and under it the
 * annotations: ordinary notes, written, edited, versioned and undone like any other, except that
 * where a note is anchored by CRDT cursors into its parent's text, an annotation is anchored by a
 * WikiAnchor into the article's: the section's headings, the exact words, a little text either
 * side, and the revision it was made against. When the article is shown, each anchor is found
 * again in the revision at hand (`reanchor`); one whose words are gone is shown as detached, never
 * moved onto other words.
 *
 * Two replicas annotating the same new article at once each create its node (a tree CRDT cannot
 * make two creates one node). Both are kept; every reader takes the article's annotations from all
 * of its nodes, and writes new ones under the first in library order, which every replica agrees
 * on. So they read as one, with nothing rewritten.
 */
import { docOf, type NodeId, type Op, type Snap } from "./model";
import { wikiTitle } from "./ref";
import type { Range } from "./text";

export interface WikiAnchor {
  /** The headings down to the section the words are in; [] for the lead. */
  sec: string[];
  /** The words, exactly as they were. */
  q: string;
  /** Up to CONTEXT characters before and after them in the section, to tell repeats apart. */
  pre: string;
  post: string;
  /** The revision of the article the anchor was made against. */
  rev: number;
}

export const CONTEXT = 32;

export function makeAnchor(text: string, range: Range, sec: string[], rev: number): WikiAnchor {
  return { sec, q: text.slice(range[0], range[1]), pre: text.slice(Math.max(0, range[0] - CONTEXT), range[0]), post: text.slice(range[1], range[1] + CONTEXT), rev };
}

/** A section's text, as the page shows it (see src/ui/articleText.ts), with its headings. */
export interface SectionText {
  path: string[];
  text: string;
}

/** Where an anchor is in the article as it now reads: a section (an index into the list given) and a range, or detached. */
export type Placed = { sec: number; range: Range } | { detached: true; sec: number | null };

const WORD = /[\p{L}\p{N}]/u;

/**
 * Find an anchor's words again: in its own section first, then anywhere in the article, exactly;
 * then the same tolerantly (ignoring case, punctuation and spacing), again its own section first.
 * Among several matches the one whose surroundings best agree with the recorded ones wins. A match
 * must start and end on word boundaries wherever the original did, so words are never matched
 * inside other words. Nothing found: detached, with its section if that still exists.
 */
export function reanchor(a: WikiAnchor, secs: SectionText[]): Placed {
  const home = homeOf(a.sec, secs);
  const all = secs.map((_, i) => i);
  const order = home >= 0 ? [home, ...all.filter((i) => i !== home)] : all;
  const startsMid = WORD.test(a.pre.slice(-1)) && WORD.test(a.q[0] ?? "");
  const endsMid = WORD.test(a.post[0] ?? "") && WORD.test(a.q.slice(-1));
  const bounded = (t: string, s: number, e: number) => (startsMid || !WORD.test(t[s - 1] ?? "") || !WORD.test(t[s] ?? "")) && (endsMid || !WORD.test(t[e] ?? "") || !WORD.test(t[e - 1] ?? ""));
  for (const tolerant of [false, true]) {
    for (const i of order) {
      const t = secs[i].text;
      const hits = (tolerant ? tolerantHits(t, a.q) : exactHits(t, a.q)).filter(([s, e]) => bounded(t, s, e));
      if (hits.length) return { sec: i, range: best(t, hits, a) };
    }
  }
  return { detached: true, sec: home >= 0 ? home : null };
}

/** The section an anchor was made in: by its headings, else by its last heading alone. */
function homeOf(path: string[], secs: SectionText[]): number {
  const key = JSON.stringify(path);
  const exact = secs.findIndex((s) => JSON.stringify(s.path) === key);
  if (exact >= 0 || !path.length) return exact;
  const last = path[path.length - 1].toLowerCase();
  return secs.findIndex((s) => s.path.length > 0 && s.path[s.path.length - 1].toLowerCase() === last);
}

function exactHits(text: string, q: string): Range[] {
  const out: Range[] = [];
  if (!q) return out;
  for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + 1)) out.push([i, i + q.length]);
  return out;
}

/** Text folded for a tolerant match: lower case, every run of anything but letters and digits one space; with where each character came from. */
export function fold(text: string): { s: string; at: number[] } {
  let s = "";
  const at: number[] = [];
  for (let i = 0; i < text.length; ) {
    const ch = String.fromCodePoint(text.codePointAt(i)!);
    if (WORD.test(ch)) {
      for (const c of ch.toLowerCase()) (s += c), at.push(i);
    } else if (s && !s.endsWith(" ")) (s += " "), at.push(i);
    i += ch.length;
  }
  if (s.endsWith(" ")) (s = s.slice(0, -1)), at.pop();
  return { s, at };
}

function tolerantHits(text: string, q: string): Range[] {
  const fq = fold(q).s;
  if (!fq) return [];
  const ft = fold(text);
  return exactHits(ft.s, fq).map(([s, e]): Range => [ft.at[s], ft.at[e - 1] + 1]);
}

/** The hit whose surroundings agree longest with the recorded ones. */
function best(text: string, hits: Range[], a: WikiAnchor): Range {
  let top = hits[0];
  let score = -1;
  for (const h of hits) {
    let p = 0;
    while (p < a.pre.length && h[0] - p - 1 >= 0 && text[h[0] - p - 1] === a.pre[a.pre.length - p - 1]) p++;
    let n = 0;
    while (n < a.post.length && h[1] + n < text.length && text[h[1] + n] === a.post[n]) n++;
    if (p + n > score) (score = p + n), (top = h);
  }
  return top;
}

// ---- the container and the article nodes ----

/** The Wikipedia containers (one, unless two replicas made one each at once), in library order. */
export function containers(snap: Snap): NodeId[] {
  return snap.library ? snap.nodes[snap.root].children.filter((c) => snap.nodes[c].articles) : [];
}

/** Whether a node is the Wikipedia container or anything in it: never a document's text. */
export function inArticles(snap: Snap, id: NodeId): boolean {
  const d = docOf(snap, id);
  return !!d && !!snap.nodes[d].articles;
}

/** An article as the library files it: its language, its title, and its page id when known (which survives a rename). */
export interface ArticleKey {
  lang: string;
  title: string;
  pageId?: number;
}

/** The nodes of an article, in library order: what its annotations hang from. Usually one; see the top of this file. */
export function articleNodes(snap: Snap, a: ArticleKey): NodeId[] {
  const title = wikiTitle(a.title);
  return containers(snap).flatMap((c) =>
    snap.nodes[c].children.filter((id) => {
      const r = snap.nodes[id].ref;
      return r?.kind === "wiki" && r.lang === a.lang && (a.pageId && r.pageId ? r.pageId === a.pageId : r.title === title);
    }),
  );
}

/** An article's annotations: the notes under its nodes. */
export function annotationsOf(snap: Snap, a: ArticleKey): NodeId[] {
  return articleNodes(snap, a).flatMap((id) => snap.nodes[id].children.filter((c) => snap.nodes[c].kind === "note" && snap.nodes[c].wanchor));
}

/**
 * The ops that create whatever is missing for a first annotation on an article (the container, the
 * article's node) and the parent to give the annotation: an existing node's id, or "$n" for one
 * created earlier in the same batch (see Doc.apply).
 */
export function articleParent(snap: Snap, a: ArticleKey): { ops: Op[]; parent: NodeId } {
  const have = articleNodes(snap, a)[0];
  if (have) return { ops: [], parent: have };
  const ops: Op[] = [];
  let box = containers(snap)[0];
  if (!box) {
    ops.push({ op: "create", parent: snap.root, kind: "section", title: "Wikipedia", body: "", articles: true });
    box = "$0" as NodeId;
  }
  ops.push({ op: "create", parent: box, kind: "section", title: wikiTitle(a.title), body: "", ref: { kind: "wiki", lang: a.lang, title: wikiTitle(a.title), ...(a.pageId ? { pageId: a.pageId } : {}) } });
  return { ops, parent: `$${ops.length - 1}` as NodeId };
}
