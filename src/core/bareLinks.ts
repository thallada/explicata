/**
 * Bare web addresses typed into a node's text, made into titled links (Store.commitEdit, once an
 * edit of a node's text is finished, never while typing). Three steps, each one commit of its own
 * that undo takes back on its own:
 *
 *   1. linkAddresses: each http(s) address new in this edit (not in the text before it, not inside
 *      a code span or words already linked, not declined in the node's `nolink`) is linked as typed,
 *      as selecting it and using w would: a page's address to the page, a Wikipedia article's
 *      address to the article (wikiRefOf). A section whose whole text is one such address, with no
 *      target and no sections, becomes a section that is only that link (its text cleared,
 *      model.ts linkOnly), and so opens straight as the page.
 *   2. The caller reads each page's title (the article's title is in its address).
 *   3. titleLink: the address in the text is replaced by the title, the link's words with it, only
 *      while those words are still the address exactly as typed (a concurrent edit of them, here or
 *      on another replica, drops this step). titleWhole names a section made a link in step 1 by
 *      its page, only while its title is empty or a placeholder.
 *
 * Undoing step 3 brings the address back, still linked; it is then in the text before any later
 * edit, so it is never taken for new and converted again.
 */
import { applyLinks, phraseKey } from "./links";
import { isLibraryRoot, label, notesOf, retitleOps, sections, type Doc, type NodeId, type Op } from "./model";
import { describeTarget, sameTarget, validateRef, wikiRefOf, type Ref } from "./ref";
import { clip, overlaps, type Range } from "./text";

/** An address in a text, where it is. */
export interface Bare {
  range: Range;
  url: string;
}

/** Addresses longer than this are left alone (the server reads none longer). */
const MAX_URL = 2000;
/** A start of an address: not in the middle of a word or of another address. */
const ADDRESS = /(?<![\w@/.:-])https?:\/\/[^\s<>"`]+/gi;
/** What may end a sentence after an address and is not part of it. */
const TRAILING = /[.,;:!?'"’”*_…]/;

/** The code spans of a text: fenced blocks and `inline` spans. */
function codeSpans(text: string): Range[] {
  const out: Range[] = [];
  for (const m of text.matchAll(/```[\s\S]*?(```|$)|`[^`\n]*`/g)) out.push([m.index!, m.index! + m[0].length]);
  return out;
}

const count = (s: string, c: string) => s.split(c).length - 1;

/**
 * The bare http(s) addresses in a text, in order: trailing punctuation left out (a closing bracket
 * only when it does not close one opened inside the address), none inside a code span, and only
 * what reads as an address (a host with a dot in it).
 */
export function bareAddresses(text: string): Bare[] {
  const code = codeSpans(text);
  const out: Bare[] = [];
  for (const m of text.matchAll(ADDRESS)) {
    let url = m[0];
    for (;;) {
      const last = url[url.length - 1];
      if (TRAILING.test(last)) url = url.slice(0, -1);
      else if (last === ")" && count(url, ")") > count(url, "(")) url = url.slice(0, -1);
      else if (last === "]" && count(url, "]") > count(url, "[")) url = url.slice(0, -1);
      else break;
    }
    const range: Range = [m.index!, m.index! + url.length];
    if (url.length > MAX_URL || code.some((c) => overlaps(c, range))) continue;
    try {
      const x = new URL(url);
      if (!/^https?:$/.test(x.protocol) || !x.hostname.includes(".") || x.hostname.endsWith(".")) continue;
    } catch {
      continue;
    }
    out.push({ range, url });
  }
  return out;
}

/** The addresses of `now` that `before` did not have (an address already in the text before the edit is never new). */
export function newAddresses(before: string, now: string): Bare[] {
  const had = new Set(bareAddresses(before).map((b) => b.url));
  return bareAddresses(now).filter((b) => !had.has(b.url));
}

/** What an address links to: a Wikipedia article's address is the article; any other, the page. */
export function addressTarget(url: string): Ref {
  return wikiRefOf(url) ?? validateRef({ kind: "url", url });
}

/** Whether a title says nothing yet: empty, a stand-in, or the address itself. */
export function placeholderTitle(title: string, url: string): boolean {
  const t = title.trim();
  return !t || t === url || /^\(?(untitled|new section|section)\)?$/i.test(t);
}

/** A title as words in a node's text: one line, and nothing the text would read as markup. */
export const titleWords = (title: string) =>
  title
    .replace(/[`*]|\[\[|\]\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);

/** One address linked in step 1: its link (a note on the address), the address, and what it links to. */
export interface AddressLink {
  note: NodeId;
  url: string;
  target: Ref;
}
export interface Linked {
  links: AddressLink[];
  /** A section made a link to the address that was its whole text. */
  whole: { node: NodeId; url: string; target: Ref } | null;
}

/**
 * Step 1, after an edit of a node's text from `before` to what it now reads: link the addresses
 * new in it, in one commit. Returns the links made (or the section made a link), for steps 2 and 3.
 */
export function linkAddresses(doc: Doc, node: NodeId, before: string, meta: { author: string }): Linked {
  const none: Linked = { links: [], whole: null };
  const s = doc.snap();
  const n = s.nodes[node];
  if (!n) return none;
  const declined = new Set(n.nolink ?? []);
  const fresh = newAddresses(before, n.body).flatMap((b) => {
    if (declined.has(phraseKey(b.url))) return [];
    try {
      return [{ ...b, target: addressTarget(b.url) }];
    } catch {
      return [];
    }
  });
  if (!fresh.length) return none;
  // A section that is nothing but the address: a section that is only the link.
  const only = fresh[0];
  if (fresh.length === 1 && n.body.trim() === only.url && n.kind === "section" && !n.ref && !isLibraryRoot(s, node) && !sections(s, node).length) {
    doc.as(meta.author, () => doc.apply([{ op: "update", id: node, body: "", ref: only.target }], `Make “${clip(label(s, node), 40)}” a link to ${clip(describeTarget(only.target), 50)}`, { tag: "link" }));
    return { links: [], whole: { node, url: only.url, target: only.target } };
  }
  // Words already linked keep their link.
  const linked = notesOf(s, node).flatMap((c) => (s.nodes[c].ref ? s.nodes[c].anchors : []));
  const todo = fresh.filter((b) => !linked.some((a) => a.start < b.range[1] && b.range[0] < a.end));
  if (!todo.length) return none;
  const message = todo.length === 1 ? `Link “${clip(todo[0].url, 50)}” to ${clip(describeTarget(todo[0].target), 50)}` : `Link ${todo.length} addresses typed in “${clip(label(s, node), 40)}”`;
  applyLinks(doc, todo.map((b) => ({ node, range: b.range, target: b.target })), { author: meta.author, actor: "human", message });
  const after = doc.snap();
  const links: AddressLink[] = [];
  for (const b of todo) {
    const note = notesOf(after, node).find((c) => {
      const x = after.nodes[c];
      return x.anchors.length === 1 && x.anchors[0].start === b.range[0] && x.anchors[0].end === b.range[1] && sameTarget(x.ref, b.target);
    });
    if (note) links.push({ note, url: b.url, target: b.target });
  }
  return { links, whole: null };
}

/**
 * Step 3: the address a link was made on, replaced in the text by the page's title, the link's
 * words with it (and a page's link keeping the title, as w keeps it), in one commit. Only while the
 * words are still the address as typed and the link still goes where it went: otherwise nothing is
 * done, and false is returned.
 */
export function titleLink(doc: Doc, link: AddressLink, title: string, meta: { author: string }): boolean {
  const s = doc.snap();
  const c = s.nodes[link.note];
  const p = c?.parent ? s.nodes[c.parent] : undefined;
  const a = c?.anchors[0];
  const words = titleWords(title);
  if (!c || !p || !a || c.anchors.length !== 1 || !sameTarget(c.ref, link.target)) return false;
  // Still the whole address as typed: not changed, and not run on into a longer one.
  if (!words || words === link.url || !bareAddresses(p.body).some((b) => b.url === link.url && b.range[0] === a.start && b.range[1] === a.end)) return false;
  const ref = c.ref!.kind === "url" && !c.ref!.title ? { ...c.ref!, title: words } : undefined;
  // The address out, then the title in: never a diff that keeps letters the two share, so the
  // link's old ends are gone with the address, and undo puts them back on it (repo.ts healAnchors).
  const ops: Op[] = [
    { op: "update", id: p.id, body: p.body.slice(0, a.start) + p.body.slice(a.end) },
    { op: "update", id: p.id, body: p.body.slice(0, a.start) + words + p.body.slice(a.end) },
    { op: "update", id: c.id, anchors: [[a.start, a.start + words.length]], ...(ref ? { ref } : {}) },
  ];
  doc.as(meta.author, () => doc.apply(ops, `Title the link “${clip(link.url, 40)}”: “${clip(words, 50)}”`, { tag: "link" }));
  return true;
}

/**
 * Step 3 for a section made a link to its whole text: named by its page while its title is empty
 * or a placeholder (a title of the writer's own is kept), and its target keeping the page's title.
 * Only while it still links there; false when nothing was done.
 */
export function titleWhole(doc: Doc, whole: NonNullable<Linked["whole"]>, title: string, meta: { author: string }): boolean {
  const s = doc.snap();
  const n = s.nodes[whole.node];
  const words = titleWords(title);
  if (!n || !words || !sameTarget(n.ref, whole.target) || !placeholderTitle(n.title, whole.url)) return false;
  const ops: Op[] = [...retitleOps(s, n.id, words), ...(n.ref!.kind === "url" && !n.ref!.title ? [{ op: "update" as const, id: n.id, ref: { ...n.ref!, title: words } }] : [])];
  doc.as(meta.author, () => doc.apply(ops, `Name “${clip(words, 50)}” after its page`, { tag: "link" }));
  return true;
}
