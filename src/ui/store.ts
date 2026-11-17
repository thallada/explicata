/**
 * Application state for the browser: the library's replicas, sync with the server, the focus
 * model, and every action the keyboard, the mouse or the command bar can take.
 *
 * There is one library and everything in it is reachable from anywhere: a document is a section
 * of the library root, opened by hoisting to it (the column) or by showing it in the next pane.
 * Nothing is closed to open something else, so model work carries on wherever the reader goes,
 * and writes into the node it was asked about.
 */
import { UndoManager } from "loro-crdt";
import {
  Doc, OpError, SYSTEM_ORIGIN, ancestors, descendants, docOf, documents, isLibraryRoot, isLink, isStale, label, notesOf, sections,
  staleness, type NodeId, type Op, type Snap,
} from "../core/model";
import { FormatError, serializeDoc } from "../core/format";
import { IMPORT_MAX, address, createDoc, deleteDoc, duplicateDoc, importDoc, listDocs, renameDoc, resolve, type DocInfo } from "../core/library";
import {
  Repo, at, decodeVV, healAnchors, history, reopenConflict, resolveConflict, revertDocTo, revertTo, touched, vvIncludes, type Commit,
  type MergeReport,
} from "../core/repo";
import { clip, formFor, plain, rangeAt, sentences, slugify, words, type Form, type Range } from "../core/text";
import { applyLinks, linkIndex, nodeRef, ownerSection, resolveNode } from "../core/links";
import { annotationsOf, articleNodes, inArticles, makeAnchor, reanchor, type ArticleKey } from "../core/article";
import { describeTarget, formatTarget, hostOf, parseTargetLoose, wikiKey, type Ref } from "../core/ref";
import { article as wikiArticle, articleText, cachedExtract, sectionPath, sectionsUnder, sectionTexts, configureWiki, revisionUrl, sensesOf as wikiSenses, wikiUrl, type Article, type WikiConfig } from "./wiki";
import type { ArticleText } from "./articleText";
import { LENSES } from "../llm/prompts";
import {
  cascade, commitArticleNote, commitExpansion, deepen, reconcile, resolveConflicts, runAgent, scanContradictions, streamArticleNote, streamExpansion,
  type AgentEvent, type ExpansionRequest, type WriteHooks,
} from "../llm/tasks";
import type { LLM } from "../llm/types";
import { DEFAULT_LIMITS, wantsResearch } from "../llm/web";
import { idbGet, idbKeys, idbSet } from "./idb";
import { remoteLLM } from "./remote";
import { Session } from "./session";
import { refreshAfterCalls } from "./usage";
import { Linker, type AutoMode, type JobState, type LinkRow, type Status, type Sugg } from "./linker";
import { all, besideInColumn, close as closeIn, columns as columnsOf, reorder, focus as focusIn, focused, open as openIn, path, pin as pinIn, prune, restore as restoreForest, rooted, save as saveTree, setSources, updateIn, withBranch, type Forest, type Placed, type Tree } from "./forks";
import { stripMarks, type Mark } from "../core/marks";

export type Grain = "node" | "sentence" | "word";
export interface Focus {
  node: NodeId;
  grain: Grain;
  range?: Range;
}
export type Mode = "normal" | "edit" | "command" | "history" | "help" | "jump" | "docs" | "link" | "review";

/**
 * A pane of the panes view. The panes are a tree of forks (forks.ts) whose focused branch is the
 * trail: it starts with the path down from the top node, and a link followed from a pane opens its
 * target in the next pane, so it may hold another document's node, a Wikipedia article or a section
 * of one. `from` is where a jump was made from, which h returns to.
 */
export type PaneRef =
  | { kind: "node"; id: NodeId; from?: Back }
  | { kind: "wiki"; title: string; lang: string; sec?: number; from?: Back };
export interface Back {
  focus: Focus;
  aux: Aux | null;
  pane: number;
}
/** A pane in the forest of forks; `seen` is where the reader was when they last left it by [ or ]. */
export type Pane = Tree<PaneRef, Back>;
/** The DOM class that marks, in a pane, what a child pane of it was opened from (a row, a link, words): by what the child shows. */
export const kidClass = (key: string) => {
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h * 33) ^ key.charCodeAt(i)) >>> 0;
  return `k${h.toString(36)}`;
};
/** Whether two panes show the same thing (a node, or an article or one of its sections). */
export const sameRef = (a: PaneRef, b: PaneRef): boolean =>
  a.kind === b.kind && (a.kind === "node" ? a.id === (b as { id: NodeId }).id : a.title === (b as { title: string }).title && a.sec === (b as { sec?: number }).sec);
/** What a pane shows, as a key: `n:<node id>`, or `w:<title>` with `#<section>`. A link's target has the same key as the pane it opens. */
export const refKey = (p: PaneRef): string => (p.kind === "node" ? `n:${p.id}` : `w:${p.title}${p.sec !== undefined ? `#${p.sec}` : ""}`);
const isPaneRef = (r: unknown): r is PaneRef => {
  const o = r as Record<string, unknown> | null;
  return !!o && typeof o === "object" && ((o.kind === "node" && typeof o.id === "string") || (o.kind === "wiki" && typeof o.title === "string" && typeof o.lang === "string"));
};
/** A row of a Wikipedia view: its head (the lead), a section, a sense of a disambiguation page, a "Mentioned in" entry. */
export type WRow = { t: "head" } | { t: "sec"; id: number } | { t: "sense"; i: number } | { t: "back"; i: number };
/**
 * Focus on something that is not a library node: a row of a Wikipedia view (`host` says which:
 * `p<i>` the article in pane i, `n<id>` the article under a node, `col` the article page of the
 * column), or words in the text that row shows (a grain and a range, as in a node's body: a
 * sentence, words, a link or an annotation's words), a node's target, or a "Linked from" row. The
 * node focus stays where it was, so leaving the aux focus returns to it.
 */
export type Aux =
  | { kind: "wiki"; host: string; row: WRow; grain?: "sentence" | "word"; range?: Range }
  | { kind: "target"; of: NodeId }
  | { kind: "back"; of: NodeId; index: number };
/** A row in a pane or in the column: a section, or an aux row. */
export type Row = { node: NodeId } | { aux: Aux };
/** The column's article page, opened from a link, with the way back. */
export interface ColWiki {
  title: string;
  lang: string;
  stack: { title: string; lang: string; aux: Aux | null }[];
  back: { focus: Focus; hoist: NodeId | null; aux: Aux | null };
}
/** The link picker: what is typed, and what it applies to. */
export interface Picker {
  node: NodeId;
  /** The words being linked; none means the node itself gets the target. */
  range?: Range;
  /** An existing link or note on those words, which is retargeted. */
  existing?: NodeId;
  text: string;
}

export const sameAux = (a: Aux | null, b: Aux | null): boolean => JSON.stringify(a) === JSON.stringify(b);
/** The documents menu: its filter, selection, and any title being typed or deletion being confirmed. */
export interface Menu {
  filter: string;
  /** The selected document's node (kept by id, so a changed list does not move the selection). */
  selected: NodeId | null;
  /** Where the keys go: the filter box, or the list (single-key actions). */
  focus: "filter" | "list";
  prompt: { kind: "new" | "rename" | "duplicate"; id?: NodeId; value: string } | null;
  confirm: NodeId | null;
  /** Problems from the last import, shown until the menu closes. */
  problems: string[] | null;
}
/** Page layout: one column with a margin, or panes side by side. Auto picks panes on wide windows. */
export type View = "auto" | "column" | "panes";
/** Where a fork's colour shows in the panes view: along its curves and title rules, across its panes' tops, down their left edges, or nowhere. */
export type Colors = "line" | "top" | "edge" | "off";
const COLORS: Colors[] = ["line", "top", "edge", "off"];
/** The narrowest window, in CSS px, on which `auto` chooses panes. */
export const PANES_MIN_WIDTH = 900;

/** Text being generated that is not in the document yet. */
export interface Pending {
  key: string;
  node: NodeId;
  kind: "note" | "sections" | "rewrite";
  range?: Range;
  /** A note being written on words of an article: which article (its key) and section. */
  art?: { key: string; sec: number };
  form?: Form;
  lens?: string;
  text: string;
}

export interface Sample {
  what: string;
  ms: number;
  /** The key's time stamp, to match the browser's own measure of it. */
  at?: number;
}

/** A replica of a document from before the library, holding edits the server never received. */
interface OldReplica {
  slug: string;
  title: string;
  branch: string;
  bytes: Uint8Array;
}

/** What the server recorded when it built the library from separate documents. */
interface Migrated {
  docs: { slug: string; uid: string | null; title: string; versions: Record<string, string> }[];
}

// ---- store ----

const clientId = Math.random().toString(36).slice(2);
const lsGet = <T>(k: string, d: T): T => {
  try {
    const v = localStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : d;
  } catch {
    return d;
  }
};
const lsSet = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* storage may be unavailable; the app works without it */
  }
};

/**
 * The settings this browser stored. `review` is now the default for links found after an edit; a
 * browser that stored the old default, `suggest`, without choosing it (every setting is stored
 * together) moves to it. A mode chosen with /autolink since is kept.
 */
function storedSettings(): Partial<Store["settings"]> {
  const s = lsGet<Partial<Store["settings"]>>("ie:settings", {});
  if (s.autolink === "suggest" && !lsGet("ie:autolink-chosen", false)) delete s.autolink;
  return s;
}

/** Article text an aux focus is in (Store.auxSpot). */
export interface Spot {
  at: ArticleText;
  /** The section's id; 0 the lead. */
  sec: number;
  article: Article;
  lang: string;
  host: string;
}
/** An article's annotations found again in the revision at hand (Store.annotations). */
export interface Placements {
  at: Map<NodeId, { sec: number; range: Range }>;
  detached: { id: NodeId; sec: number | null }[];
}

/** Lower-cased title and body, remembered per node entry, for searching a large library on every keystroke. */
const lowered = new WeakMap<object, [string, string]>();

class Store {
  ready = false;
  fatal: string | null = null;
  /** The library's replicas and their sync. */
  session!: Session;
  menu: Menu = { filter: "", selected: null, focus: "filter", prompt: null, confirm: null, problems: null };
  user = "you";
  llm: LLM = remoteLLM("off");
  online = false;

  mode: Mode = "normal";
  focus!: Focus;
  open = new Set<NodeId>();
  hoist: NodeId | null = null;
  /** Documents whose own text is unfolded, where it is a prompt that is folded by default. */
  unfolded = new Set<NodeId>();
  /** A past commit being looked at, read-only. */
  preview: { commit: Commit; doc: Doc } | null = null;
  edit: { node: NodeId; field: "title" | "body"; value: string; fresh?: boolean; chosen?: { phrase: string; at: number; target: Ref }[] } | null = null;
  pending = new Map<string, Pending>();
  status = "";
  busy = 0;
  log: { at: number; text: string }[] = [];
  historyIndex = 0;
  /** The history panel shows only what touched the current document. */
  historyFilter = false;
  /** The commit before the editor agent's last run, while `u` can still take it back. */
  agentUndo: { commit: Commit; doc: NodeId | null } | null = null;
  /** Set by "new branch from this commit" until the name has been typed. */
  branchFrom: Commit | null = null;
  /** A note being previewed on hover, and where to draw it. */
  popup: { note: NodeId; x: number; top: number; bottom: number } | null = null;
  settings: { auto: boolean; speculate: boolean; view: View; autolink: AutoMode; curves: boolean; colors: Colors } = { auto: true, speculate: false, view: "auto", autolink: "review", curves: true, colors: "line", ...storedSettings() };
  /** Link discovery: scans after writes, suggestions, Related, the background job. */
  links = new Linker({
    doc: () => this.doc,
    user: () => this.user,
    mode: () => this.settings.autolink,
    generating: () => this.generating,
    say: (t) => this.say(t),
    emit: (...ids) => this.emit(...ids),
    rendered: (id) => this.rendered(id),
  });
  /**
   * The links list (S): every link found or made in the current document, as it stands, under
   * filters by status; the selected row's words are focused in the text.
   */
  review: { ids: NodeId[]; show: Record<Status, boolean>; key: string | null } | null = null;

  /** Whether the window is wide enough for `auto` to mean panes. Kept current by the page. */
  wide = typeof window !== "undefined" && window.innerWidth >= PANES_MIN_WIDTH;
  samples: Sample[] = [];
  /**
   * Keypress → paint, as the browser itself measures it (the Event Timing API: from a key's event to
   * the next paint after its handlers), by the key's time stamp. Under a steady stream of keys an
   * ordinary task posted after a frame can wait behind many later frames, so where the browser has
   * measured a key, its figure is the sample's.
   */
  private painted = new Map<number, number>();
  private paintObserver = (() => {
    try {
      const o = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) if (e.name === "keydown") this.notePaint(e.startTime, e.duration);
      });
      o.observe({ type: "event", durationThreshold: 16 } as PerformanceObserverInit);
      return o;
    } catch {
      return null;
    }
  })();
  private notePaint(at: number, ms: number) {
    const s = this.samples.find((x) => x.at !== undefined && Math.abs(x.at - at) < 1);
    if (s) s.ms = Math.min(s.ms, ms);
    else this.painted.set(at, ms);
  }
  /** Record a keypress → paint sample (App.tsx), taking the browser's own figure for it where there is one. */
  addSample(t: { what: string; at: number }, ms: number) {
    for (const r of this.paintObserver?.takeRecords() ?? []) if (r.name === "keydown") this.notePaint(r.startTime, r.duration);
    const by = [...this.painted].find(([at]) => Math.abs(at - t.at) < 1);
    if (by) this.painted.delete(by[0]);
    this.samples.push({ what: t.what, ms: by ? Math.min(ms, by[1]) : ms, at: t.at });
    if (this.painted.size > 200) this.painted.clear();
  }
  /** Set at a keypress; cleared when the resulting frame has been painted. */
  t0: { what: string; at: number } | null = null;
  /** Replicas of pre-library documents whose edits never reached the server. */
  oldReplicas: OldReplica[] = [];

  /** The panes as a forest of forks (forks.ts); its focused branch is `trail`, and `paneAt` is the pane on it that holds the focus: the active pane. */
  forest: Forest<PaneRef, Back> = { trees: [], at: 0 };
  paneAt = 0;
  /** The focused tree. */
  get tree(): Pane | null {
    return focused(this.forest);
  }
  /** Set while a Shift open (Shift+Enter, Shift-click) runs: it opens in place of what is in the next column instead of beside it. */
  replacing = false;
  private toldReplace = false;
  private memo: { forest: Forest<PaneRef, Back> | null; nodes: Pane[]; trail: PaneRef[]; placed?: Placed<PaneRef, Back>[]; cols?: Map<number, Placed<PaneRef, Back>[]>; index?: Map<number, Placed<PaneRef, Back>>; ids?: Set<NodeId> } = { forest: null, nodes: [], trail: [] };
  private get branch() {
    if (this.memo.forest !== this.forest) {
      const nodes = path(this.tree);
      this.memo = { forest: this.forest, nodes, trail: nodes.map((n) => n.ref) };
    }
    return this.memo;
  }
  /** Every pane, with its column, tree by tree, depth first. */
  get panesPlaced(): Placed<PaneRef, Back>[] {
    const m = this.branch;
    return (m.placed ??= all(this.forest));
  }
  /** The panes of each column, top to bottom (forks.ts `columns`). */
  get paneColumns(): Map<number, Placed<PaneRef, Back>[]> {
    const m = this.branch;
    return (m.cols ??= columnsOf(this.forest));
  }
  /** The focused branch: the panes the keys move along, left to right. */
  get trail(): PaneRef[] {
    return this.branch.trail;
  }
  /** The focused branch as nodes of the tree. */
  get branchNodes(): Pane[] {
    return this.branch.nodes;
  }
  aux: Aux | null = null;
  colWiki: ColWiki | null = null;
  /** Sections of the column's article page that are open. */
  colOpen = new Set<number>();
  /** Nodes whose article is unfolded beneath them in their pane. */
  expanded = new Set<NodeId>();
  picker: Picker | null = null;
  wiki: WikiConfig = { mode: "live", lang: "en", contact: false };
  /** Whether the server lets the editor agent search the web, and its per-request caps. */
  web: { on: boolean; searches: number; fetches: number } = { on: false, searches: 0, fetches: 0 };
  /**
   * The editor agent's current or last run, for the panel above the status line: its steps (each
   * search, page read and edit) while it works, then its summary and the sources it linked. Esc
   * stops a run; on a finished one, Esc puts the panel away.
   */
  agentRun: { research: boolean; steps: string[]; running: boolean; summary?: string; sources?: { url: string; title?: string }[]; ac: AbortController } | null = null;

  private listeners = new Set<() => void>();
  private undo = new WeakMap<Doc, UndoManager>();
  private queue: Promise<unknown> = Promise.resolve();
  private seq = 0;
  private spec: { key: string; text: string; done: Promise<string>; ac: AbortController; onText?: (d: string) => void } | null = null;
  private specTimer: ReturnType<typeof setTimeout> | undefined;
  private addressTimer: ReturnType<typeof setTimeout> | undefined;
  private historyCache: { key: string; doc: Doc; commits: Commit[] } | null = null;
  private touchedCache = new Map<string, NodeId[]>();
  private walker: { of: Doc; version: string; doc: Doc } | null = null;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  /**
   * Ask for a re-render. With node ids, only those nodes and their ancestors are redrawn (a
   * keystroke that moves focus touches two subtrees, not the page). With none, everything is.
   */
  emit = (...ids: NodeId[]) => this.redraw(ids, true);
  /**
   * Like emit(id), for a change that shows only in the node's own text, such as the selection
   * moving within it: its row in the parent's pane is left alone. The column view treats both alike.
   */
  emitText = (id: NodeId) => this.redraw([id], false);
  private redraw(ids: NodeId[], rows: boolean) {
    if (!ids.length || !this.ready) this.dirtyAll = true;
    else {
      const s = this.snap;
      for (const id of ids) {
        if (!s.nodes[id]) {
          this.dirtyAll = true;
          break;
        }
        this.dirty.add(id);
        for (const a of ancestors(s, id)) this.dirty.add(a);
        this.markNear(id, rows);
      }
    }
    for (const fn of this.listeners) fn();
  }
  private dirtyAll = true;
  private dirty = new Set<NodeId>();
  isDirty(id: NodeId) {
    return this.dirtyAll || this.dirty.has(id);
  }
  /**
   * The panes a change shows up in. A pane draws its node's title and body (with the notes on it,
   * and anything inside those notes) and one row per child section. So a change to a node touches
   * the node's own pane, its parent's pane (its row, or the note in the parent's text), and, if it
   * sits inside a note, the pane that note is drawn in. Ancestors further up are not touched.
   */
  private near = new Set<NodeId>();
  private markNear(id: NodeId, rows: boolean) {
    const s = this.snap;
    this.near.add(id);
    for (let c = id, p = s.nodes[id].parent; p; c = p, p = s.nodes[p].parent) {
      if ((rows && c === id) || s.nodes[c].kind === "note") this.near.add(p);
    }
  }
  /** Whether the pane showing this node needs redrawing. */
  paneDirty(id: NodeId) {
    return this.dirtyAll || this.near.has(id);
  }
  /** Called once a render has been committed. */
  clean() {
    this.dirtyAll = false;
    this.dirty.clear();
    this.near.clear();
  }

  // ---- derived ----

  get repo(): Repo {
    return this.session.repo;
  }
  /** The library on the current branch. */
  get doc(): Doc {
    return this.repo.doc;
  }
  /** What is on screen: the live library, or a past commit. */
  get shown(): Doc {
    return this.preview?.doc ?? this.doc;
  }
  get snap(): Snap {
    return this.shown.snap();
  }
  get top(): NodeId {
    const s = this.snap;
    return this.hoist && s.nodes[this.hoist] ? this.hoist : s.root;
  }
  get generating() {
    return this.llm.kind !== "off";
  }

  /** The layout on screen now. */
  get panes(): boolean {
    const v = this.settings.view;
    return v === "panes" || (v === "auto" && this.wide);
  }

  /**
   * The document the reader is in: the one the focus is in. On the column's library page, where
   * documents are rows to be opened, none.
   */
  get currentDoc(): NodeId | null {
    const s = this.snap;
    if (!this.panes && isLibraryRoot(s, this.top)) return null;
    return docOf(s, this.focus.node);
  }

  /** The library page in the column: documents are opened by hoisting to them, never unfolded in the list. */
  private listing(id: NodeId): boolean {
    const s = this.snap;
    return !this.panes && isLibraryRoot(s, this.top) && s.nodes[id]?.parent === s.root;
  }

  /**
   * The panes, left to right: the top node, then at each step the child section that is open and
   * on the way to the focused node. Derived from focus and the open set; nothing else is stored.
   */
  panePath(): NodeId[] {
    const s = this.snap;
    const path = [this.top];
    const f = this.focus.node;
    if (!s.nodes[f]) return path;
    const chain = new Set([f, ...ancestors(s, f)]);
    if (!chain.has(this.top)) return path;
    for (let cur = this.top; ; ) {
      const next = s.nodes[cur].children.find((c) => chain.has(c));
      if (!next || s.nodes[next].kind !== "section" || !this.open.has(next)) return path;
      path.push(next);
      cur = next;
    }
  }

  // ---- the trail of panes ----

  /** Whether a node is the head of the pane holding the focus (a note opened as a pane of its own is one). */
  paneHead(id: NodeId): boolean {
    const p = this.panes ? this.trail[this.paneAt] : undefined;
    return p?.kind === "node" && p.id === id;
  }

  /** Whether pane i continues the one before it (a section opened from its row) rather than being a jump. */
  continues(i: number): boolean {
    return this.continuesFrom(this.trail[i], this.trail[i - 1]);
  }
  /** Whether pane p continues pane q, the one it was opened from. */
  continuesFrom(p: PaneRef | undefined, q: PaneRef | undefined): boolean {
    if (!p || !q || p.from) return false;
    if (p.kind === "node") return q.kind === "node" && this.snap.nodes[p.id]?.parent === q.id && this.snap.nodes[p.id].kind === "section";
    return p.sec !== undefined && (q.kind === "wiki" ? q.title === p.title : this.targetOf(q.id)?.kind === "wiki");
  }

  /** Pane i of the focused branch holds a focus (see holdsIn); a continuation's head only while it is the active pane. */
  private holds(i: number, f: Focus): boolean {
    return this.holdsIn(this.trail[i], this.trail[i - 1], i === 0 || i === this.paneAt, `p${i}`, f);
  }

  /**
   * Whether a pane (p, opened from q; host: how its article is named) holds a focus: its node's
   * text (a selection, a note in it), one of its rows, or its head when it is not a continuation (a
   * continuation's node is focused as the row it was opened from, in the pane before), or when
   * `head` says it may (the first pane, or the active pane, landed on by [ ] or a click).
   */
  private holdsIn(p: PaneRef | undefined, q: PaneRef | undefined, head: boolean, host: string, f: Focus): boolean {
    const s = this.snap;
    const n = s.nodes[f.node];
    // An annotation is held by the pane showing its article.
    if (p && n && inArticles(s, f.node)) return this.shows(p.kind === "wiki" ? host : `n${p.id}`, f.node);
    if (!p || p.kind !== "node" || !n) return false;
    if (f.grain !== "node" || n.kind === "note") return ownerSection(s, f.node) === p.id || f.node === p.id;
    if (f.node === p.id) return head || !this.continuesFrom(p, q);
    return n.parent === p.id;
  }

  /** A pane off the focused branch that holds a focus: the forest with it on the branch, and its depth. */
  private forkHolding(f: Focus): { forest: Forest<PaneRef, Back>; depth: number } | null {
    const on = new Set(this.branchNodes.map((n) => n.id));
    const hit = this.panesPlaced.find((x) => !on.has(x.node.id) && this.holdsIn(x.node.ref, x.parent?.ref, x.depth === 0, `f${x.node.id}`, f));
    return hit ? { forest: focusIn(this.forest, hit.node.id), depth: hit.depth } : null;
  }

  private setForest(next: Forest<PaneRef, Back>) {
    this.forest = next;
  }

  /** The panes as a plain trail down to the focus (open sections on the way). */
  private pathRefs(): PaneRef[] {
    return this.panePath().map((id) => ({ kind: "node" as const, id }));
  }

  /**
   * Keep the trail holding the focus. Moving within the panes (back left, along a pane's rows)
   * leaves the trail as it is. When the focus lands somewhere the focused branch does not hold, a
   * fork that holds it becomes the focused branch (Back to a pane in it, a click in it); failing
   * that (a jump from the search box, a reload at an address) the branch is made again as the path
   * down to it, keeping whatever forks are off that path. Panes of deleted nodes close, in any fork.
   */
  syncTrail() {
    if (!this.panes || !this.session) return;
    const s = this.snap;
    let f = prune(this.forest, (p) => p.kind === "wiki" || !!s.nodes[p.id]);
    if (!rooted(f, { kind: "node", id: this.top }, sameRef)) f = withBranch(f, this.pathRefs(), sameRef);
    if (f !== this.forest) this.setForest(f);
    this.paneAt = Math.max(0, Math.min(this.paneAt, this.trail.length - 1));
    if (this.aux) return;
    const n = this.trail.length;
    const order = [this.paneAt, this.paneAt + 1, this.paneAt - 1, ...Array.from({ length: n }, (_, i) => i)];
    for (const i of order) if (i >= 0 && i < n && this.holds(i, this.focus)) return void (this.paneAt = i);
    const fork = this.forkHolding(this.focus);
    if (fork) {
      this.setForest(fork.forest);
      this.paneAt = fork.depth;
      return;
    }
    this.setForest(withBranch(this.forest, this.pathRefs(), sameRef));
    const at = this.trail.findIndex((_, i) => this.holds(i, this.focus));
    this.paneAt = at >= 0 ? at : this.trail.length - 1;
  }

  /**
   * Open something to the right of pane i. If it is already open there, as any fork, that fork is
   * focused. Otherwise it opens beside what is there, a new pane in the next column; a Shift open
   * (`replacing`) opens it in place of the focused branch's pane there instead (a pinned pane stays
   * beside it). Returns the pane it is in.
   */
  openPane(i: number, ref: PaneRef): number {
    this.setForest(openIn(this.forest, i, ref, !this.replacing, sameRef));
    this.saveView();
    this.emit();
    return Math.min(i + 1, this.trail.length - 1);
  }

  /** Close the pane that shows this node to the right of pane i (whichever fork it is). */
  closeRow(i: number, id: NodeId) {
    const kid = this.branchNodes[i]?.kids.find((k) => k.ref.kind === "node" && k.ref.id === id);
    if (!kid) return;
    this.closePane(kid.id);
  }

  /** Run an open beside what is there, or in its place (Shift). In the column there is only the one way, and the status line says so once. */
  withReplace<T>(replace: boolean, fn: () => T): T {
    if (replace && !this.panes && !this.toldReplace) {
      this.toldReplace = true;
      this.say("Shift+Enter and Shift-click open in place of the pane to the right in the panes view; in one column this opens as usual.");
    }
    const was = this.replacing;
    this.replacing = replace && this.panes;
    try {
      return fn();
    } finally {
      this.replacing = was;
    }
  }

  /** A pane of the forest by its id: its node, depth in its tree, column, tree and parent. */
  forkNode(id: number): Placed<PaneRef, Back> | undefined {
    const m = this.branch;
    if (!m.index) m.index = new Map(this.panesPlaced.map((x) => [x.node.id, x]));
    return m.index.get(id);
  }

  /** Whether any pane shows this node. */
  private paneShows(id: NodeId): boolean {
    const m = this.branch;
    if (!m.ids) m.ids = new Set(this.panesPlaced.flatMap((x) => (x.node.ref.kind === "node" ? [x.node.ref.id] : [])));
    return m.ids.has(id);
  }

  /**
   * For a pane with children: its children by what they show (refKey), each with whether it is the
   * picked one and whether there are several (forks, marked as such).
   */
  forkMarks(tid: number | undefined): Map<string, { picked: boolean; many: boolean }> | null {
    const n = tid === undefined ? undefined : this.forkNode(tid)?.node;
    if (!n || !n.kids.length) return null;
    return new Map(n.kids.map((k, j) => [refKey(k.ref), { picked: j === n.pick, many: n.kids.length > 1 }]));
  }

  /** A link's target by the key of the pane it opens (refKey); none for a web page or a node that is gone. */
  targetKey(r: Ref): string | undefined {
    if (r.kind === "wiki") return `w:${r.title}`;
    if (r.kind !== "node") return undefined;
    const id = resolveNode(this.snap, r);
    return id ? `n:${id}` : undefined;
  }

  /** How a child is marked in the pane it was opened from: "showing" (the picked child), "forked" (another fork), or not open; with the class that names it. */
  kidMark(tid: number | undefined, match: (r: PaneRef) => boolean): string | undefined {
    const n = tid === undefined ? undefined : this.forkNode(tid)?.node;
    const k = n ? n.kids.findIndex((c) => match(c.ref)) : -1;
    return k < 0 ? undefined : `${k === n!.pick ? "showing" : "forked"} ${kidClass(refKey(n!.kids[k].ref))}`;
  }

  /**
   * Put the focus on pane c of the focused branch, making it the active pane: on its node (its head;
   * a continuation's too, while it is active), or on an article's head.
   */
  land(c: number) {
    const p = this.trail[c];
    if (!p) return;
    this.paneAt = c;
    if (p.kind === "node") this.setFocus({ node: p.id, grain: "node" });
    else this.setFocus(this.focus, { kind: "wiki", host: `p${c}`, row: { t: "head" } });
  }

  /** A click in a pane off the focused branch (or a tab): that pane comes onto the focused branch, with the focus on it. */
  enterFork(id: number) {
    const f = focusIn(this.forest, id);
    const hit = this.forkNode(id);
    if (!hit || f === this.forest) return;
    this.setForest(f);
    this.land(hit.depth);
  }

  /**
   * [ and ] (Alt+k, Alt+j): the pane above or below the active one in its column (whichever fork or
   * tree it is in). The focus goes back where it was when that pane was last left, or to its head.
   */
  focusFork(delta: number) {
    if (!this.panes) return this.say("Forks are side by side in the panes view (v); one column shows one page.");
    this.syncTrail();
    const here = this.branchNodes[this.paneAt];
    const next = here && besideInColumn(this.forest, here.id, delta);
    if (next === null || next === undefined) {
      const alone = here && besideInColumn(this.forest, here.id, -delta) === null;
      return this.say(alone ? "This is the only pane in its column. Shift+Enter, or a Shift- or Ctrl-click, opens a fork below the pane to the right." : `No pane ${delta < 0 ? "above" : "below"} this one in its column.`);
    }
    this.goPane(next);
  }

  /** Make a pane the active one, from the active one: the focus goes back where it was when that pane was last left, or to its head. */
  private goPane(id: number) {
    const here = this.branchNodes[this.paneAt];
    const seen = this.backHere();
    this.setForest(focusIn(here ? updateIn(this.forest, here.id, (n) => ({ ...n, seen })) : this.forest, id));
    const hit = this.forkNode(id)!;
    const b = hit.node.seen;
    if (b && b.pane === hit.depth && this.snap.nodes[b.focus.node] && (b.aux ? this.auxValid(b.aux) : this.holds(b.pane, b.focus))) return this.restore(b);
    this.land(hit.depth);
  }

  /**
   * Alt+h and Alt+l: the pane the active one was opened from (left), or one opened from it (right):
   * the one opened from the focused row or link if it is open, else the one last visited there.
   * Left then right comes back to the same pane.
   */
  paneSide(delta: number) {
    if (!this.panes) return this.say("Panes are side by side in the panes view (v).");
    this.syncTrail();
    const here = this.branchNodes[this.paneAt];
    if (!here) return;
    if (delta < 0) {
      const parent = this.branchNodes[this.paneAt - 1];
      if (!parent) return this.say(this.paneAt === 0 && this.forest.at > 0 ? "This pane's source has closed; nothing to its left." : "Nothing to the left of this pane.");
      return this.goPane(parent.id);
    }
    if (!here.kids.length) return this.say("Nothing opened from this pane yet: Enter or l on a row or link opens it to the right.");
    const f = this.focus;
    const a = this.aux;
    const key =
      a?.kind === "wiki" && a.row.t === "sec" ? refKey({ kind: "wiki", title: this.wikiHost(a.host)?.title ?? "", lang: "", sec: a.row.id }) : !a && f.grain === "node" ? refKey({ kind: "node", id: f.node }) : this.selectionTargetKey();
    const k = here.kids.find((c) => refKey(c.ref) === key) ?? here.kids[here.pick];
    this.goPane(k.id);
  }

  /** What the selected words link to, as a pane's key (refKey), if they link. */
  private selectionTargetKey(): string | undefined {
    const f = this.focus;
    if (f.grain === "node" || !f.range) return undefined;
    const n = this.snap.nodes[f.node];
    const note = n?.children.map((c) => this.snap.nodes[c]).find((c) => c?.kind === "note" && c.ref && c.anchors[0] && c.anchors[0].start <= f.range![0] && c.anchors[0].end >= f.range![1]);
    if (!note?.ref) return undefined;
    return this.targetKey(note.ref);
  }

  /** Whether the focus is a row whose pane is open next to it (so that pane is the one the reader is looking at). */
  showingFocus(): boolean {
    const next = this.trail[this.paneAt + 1];
    return !this.aux && this.focus.grain === "node" && next?.kind === "node" && next.id === this.focus.node && this.continues(this.paneAt + 1);
  }

  /**
   * q (on the active pane) or a pane's ×: close the pane and everything opened from it, except
   * pinned panes, which stay where they are. If the focus was in what closed, it goes back to where
   * the pane was opened from (its row, its link, the article section) in the pane before.
   */
  closePane(id = this.branchNodes[this.paneAt]?.id) {
    const hit = id === undefined ? undefined : this.forkNode(id);
    if (!hit) return;
    if (hit.ti === 0 && hit.depth === 0) return this.say("The first pane stays; h or Esc at its top steps out of it.");
    const active = this.branchNodes[this.paneAt];
    const wasAt = this.paneAt;
    const r = closeIn(this.forest, hit.node.id, active.id);
    this.setForest(r.forest);
    this.saveView();
    const now = this.forkNode(r.active)!;
    this.paneAt = now.depth;
    if (r.active === active.id) {
      // Still open; an article pane that became an orphan's root is named by its new place.
      const a = this.aux;
      if (now.depth !== wasAt && a?.kind === "wiki" && a.host === `p${wasAt}`) this.aux = { ...a, host: `p${now.depth}` };
      return this.emit();
    }
    if (hit.parent && r.active === hit.parent.id) return this.toSource(hit.node.ref, now.depth);
    this.land(now.depth);
  }

  /** Back in pane i to where a pane (shown by ref, opened from pane i) was opened from: the jump's place, the row it continues, or the article's section row. */
  private toSource(ref: PaneRef, i: number) {
    const q = this.trail[i];
    if (ref.from && ref.from.pane === i) return this.restore(ref.from);
    this.paneAt = i;
    if (ref.kind === "node" && q?.kind === "node" && this.continuesFrom(ref, q) && this.snap.nodes[ref.id]) return this.setFocus({ node: ref.id, grain: "node" });
    if (ref.kind === "wiki" && ref.sec !== undefined && q) {
      const host = q.kind === "wiki" ? `p${i}` : `n${q.id}`;
      return this.setFocus(q.kind === "node" ? { node: q.id, grain: "node" } : this.focus, { kind: "wiki", host, row: { t: "sec", id: ref.sec } });
    }
    this.land(i);
  }

  /** A pane dragged up or down its column, to just above another (or to the bottom). */
  /** The page has measured where panes were opened from in their parents: their columns stand in that order (forks.ts columns). */
  setPaneSources(srcs: Map<number, number>) {
    const f = setSources(this.forest, srcs);
    if (f === this.forest) return;
    this.setForest(f);
    this.saveView();
    this.emit();
  }

  reorderPane(id: number, before: number | null) {
    const f = reorder(this.forest, id, before);
    if (f === this.forest) return;
    this.setForest(f);
    this.saveView();
    this.emit();
  }

  /** P (on the active pane) or a pane's pin: pin or unpin it. */
  togglePanePin(id = this.branchNodes[this.paneAt]?.id) {
    if (!this.panes) return this.say("Panes are pinned in the panes view (v).");
    const hit = id === undefined ? undefined : this.forkNode(id);
    if (!hit) return;
    const on = !hit.node.pinned;
    this.setForest(pinIn(this.forest, hit.node.id, on));
    this.saveView();
    this.say(on ? "Pinned: this pane stays open when what it was opened from closes, and never folds away. P again unpins it." : "Unpinned.");
  }

  /** Go back to where a jump was made from. */
  restore(b: Back) {
    this.paneAt = Math.min(b.pane, this.trail.length - 1);
    const f = this.snap.nodes[b.focus.node] ? b.focus : this.focus;
    this.setFocus(f, b.aux && this.auxValid(b.aux) ? b.aux : null);
  }

  /** Where the reader is now, to come back to. */
  backHere(): Back {
    return { focus: this.focus, aux: this.aux, pane: this.paneAt };
  }

  /** The rows of pane i, in the order j and k walk them. A node pane's head is not a row; an article's is. */
  paneRows(i: number): Row[] {
    const p = this.trail[i];
    if (!p) return [];
    if (p.kind === "wiki") return this.wikiRows(`p${i}`).map((row) => ({ aux: { kind: "wiki", host: `p${i}`, row } }));
    const s = this.snap;
    if (!s.nodes[p.id]) return [];
    const rows: Row[] = sections(s, p.id).map((node) => ({ node }));
    return [...rows, ...this.auxRows(p.id)];
  }

  /** Under a node: its target (in panes a Wikipedia target is the article itself, unfolded on l), then "Linked from". */
  private auxRows(id: NodeId): Row[] {
    const r = this.targetOf(id);
    const rows: Row[] = [];
    if (this.articleUnder(id)) rows.push(...this.wikiRows(`n${id}`).map((row): Row => ({ aux: { kind: "wiki", host: `n${id}`, row } })));
    else if (r) rows.push({ aux: { kind: "target", of: id } });
    this.linkedFrom(id).forEach((_, index) => rows.push({ aux: { kind: "back", of: id, index } }));
    return rows;
  }

  /**
   * Whether a node's Related list is drawn: under the node being read (the focused one, the page's
   * top, a pane's node), not under every open node, which would fill the page with lists.
   */
  relatedShown(id: NodeId): boolean {
    if (this.panes) return this.paneShows(id);
    return id === this.focus.node || id === this.top;
  }

  /** A node's Related list: sections of other documents close in meaning (fetched when it is drawn). */
  relatedOf(id: NodeId) {
    if (this.preview || !this.snap.nodes[id] || isLibraryRoot(this.snap, id)) return [];
    return this.links.relatedOf(id, this.snap) ?? [];
  }

  /** The column's rows: sections in reading order, each open one followed by its target and "Linked from" rows. */
  columnRows(): Row[] {
    if (this.colWiki) return this.wikiRows("col").map((row) => ({ aux: { kind: "wiki", host: "col", row } }));
    const s = this.snap;
    const out: Row[] = [];
    const listing = isLibraryRoot(s, this.top);
    const visit = (id: NodeId) => {
      out.push({ node: id });
      if (!this.isOpen(id)) return;
      sections(s, id).forEach(visit);
      if (!(listing && id === this.top)) out.push(...this.auxRows(id));
    };
    visit(this.top);
    return out;
  }

  /** Which row of a list the focus is on, or -1. */
  rowIndex(rows: Row[]): number {
    if (this.aux) return rows.findIndex((r) => "aux" in r && sameAux(r.aux, this.aux));
    if (this.focus.grain !== "node") return -1;
    return rows.findIndex((r) => "node" in r && r.node === this.focus.node);
  }

  /** Focus a row: a section, or an aux row (the node focus then stays on the node it belongs to). */
  focusRow(row: Row, pane = this.paneAt) {
    this.paneAt = pane;
    if ("node" in row) return this.setFocus({ node: row.node, grain: "node" });
    const a = row.aux;
    const of = a.kind === "wiki" ? (a.host.startsWith("n") ? (a.host.slice(1) as NodeId) : this.focus.node) : a.of;
    this.setFocus({ node: this.snap.nodes[of] ? of : this.focus.node, grain: "node" }, a);
  }

  /** Whether an aux focus still points at something that exists. */
  auxValid(a: Aux): boolean {
    if (a.kind !== "wiki") return !!this.snap.nodes[a.of];
    if (a.host === "col") return !!this.colWiki;
    if (a.host.startsWith("p")) return this.trail[+a.host.slice(1)]?.kind === "wiki";
    if (a.host.startsWith("f")) return false;
    return !!this.snap.nodes[a.host.slice(1) as NodeId];
  }

  /**
   * The article a Wikipedia host shows, and how. `p<i>` is the article pane at column i of the
   * focused branch, `f<id>` an article pane off it (by its id in the tree of forks).
   */
  wikiHost(host: string): { title: string; lang: string; sec: number; embedded?: NodeId; nested?: boolean; mentions?: boolean } | null {
    if (host === "col") return this.colWiki ? { title: this.colWiki.title, lang: this.colWiki.lang, sec: 0, nested: true, mentions: true } : null;
    if (host.startsWith("p") || host.startsWith("f")) {
      const p = host.startsWith("p") ? this.trail[+host.slice(1)] : this.forkNode(+host.slice(1))?.node.ref;
      return p?.kind === "wiki" ? { title: p.title, lang: p.lang, sec: p.sec ?? 0, mentions: p.sec === undefined } : null;
    }
    const id = host.slice(1) as NodeId;
    const r = this.targetOf(id);
    // In the column its sections open in place, as on the article page.
    return r?.kind === "wiki" ? { title: r.title, lang: r.lang, sec: 0, embedded: id, nested: !this.panes } : null;
  }

  /**
   * Whether the article under a node is folded to its summary. A section about an article opens on
   * its own text, with the article folded until l; a note's text is a commentary on the article, so
   * the article is there in full beneath it.
   */
  folded(id: NodeId | undefined): boolean {
    return !!id && this.snap.nodes[id]?.kind === "section" && !this.expanded.has(id);
  }

  /** Whether a node shows its Wikipedia target as the article itself: always in a pane; in the column, under a note opened as a page. */
  articleUnder(id: NodeId): boolean {
    return this.targetOf(id)?.kind === "wiki" && (this.panes || (id === this.top && this.snap.nodes[id].kind === "note"));
  }

  /**
   * What a node is about: its own target, or, for a note with text of its own, the target of a link
   * on exactly the same words. Two notes on one span read as one: the note's text, then where the
   * link goes.
   */
  targetOf(id: NodeId): Ref | undefined {
    const s = this.snap;
    const n = s.nodes[id];
    if (!n || n.ref || n.kind !== "note" || !n.parent || !n.body.trim() || !n.anchors[0]) return n?.ref;
    const a = n.anchors[0];
    return notesOf(s, n.parent).map((c) => s.nodes[c]).find((c) => c.ref && !c.body.trim() && c.anchors.some((b) => b.start === a.start && b.end === a.end))?.ref;
  }

  /** On these words, the note to open as a commentary with its target: one with text and a target, its own or a link's on the same words. */
  commentaryAt(range: Range | undefined, node = this.focus.node): NodeId | undefined {
    const s = this.snap;
    if (!range || !s.nodes[node]) return;
    const texts = notesOf(s, node).filter((id) => s.nodes[id].body.trim() && s.nodes[id].anchors.some((a) => a.start === range[0] && a.end === range[1]));
    const note = texts.find((id) => s.nodes[id].ref) ?? texts[0];
    return note && this.targetOf(note) ? note : undefined;
  }

  /**
   * Open a note that has text and a target as one page: the note's text, the library's commentary,
   * then what it is about (an article in full; a card for a node or a web page). In panes it is
   * the next pane; in the column the note is hoisted, and h at its top returns to its words.
   */
  openCommentary(note: NodeId) {
    if (this.panes) {
      const from = this.backHere();
      this.paneAt = this.openPane(this.paneAt, { kind: "node", id: note, from });
      return this.setFocus({ node: note, grain: "node" });
    }
    this.colWiki = null;
    this.colOpen.clear();
    this.setHoist(note);
  }

  /**
   * The rows of a Wikipedia view: its head, then its sections (in a pane, the sections directly
   * under what it shows, since a section opens as the next pane; on the column's page, nested and
   * opened in place), a disambiguation page's senses, and "Mentioned in".
   */
  wikiRows(host: string): WRow[] {
    const h = this.wikiHost(host);
    if (!h) return [];
    const rows: WRow[] = [{ t: "head" }];
    if (this.folded(h.embedded)) return rows;
    const a = wikiArticle(h.title, h.lang);
    if (a.state === "ready") {
      if (a.value.disambiguation && h.sec === 0) {
        const ss = wikiSenses(a.value.title, h.lang);
        if (ss.state === "ready") ss.value.forEach((_, i) => rows.push({ t: "sense", i }));
      }
      const visit = (parent: number) => {
        for (const x of sectionsUnder(a.value, parent)) {
          rows.push({ t: "sec", id: x.id });
          if (h.nested && this.colOpen.has(x.id)) visit(x.id);
        }
      };
      visit(h.sec);
    }
    if (h.mentions) this.mentionsOf(h.lang, a.state === "ready" ? a.value.title : h.title).forEach((_, i) => rows.push({ t: "back", i }));
    return rows;
  }

  /** The nodes that link to a node, in library order. */
  linkedFrom(id: NodeId): NodeId[] {
    return this.inOrder(linkIndex(this.shown).linksTo(id));
  }

  /** The nodes that link to an article, in library order. */
  mentionsOf(lang: string, title: string): NodeId[] {
    return this.inOrder(linkIndex(this.shown).mentions(lang, title));
  }

  private inOrder(ids: NodeId[]): NodeId[] {
    if (ids.length < 2) return ids;
    const s = this.snap;
    const docs = documents(s);
    const key = (id: NodeId) => [docs.indexOf(docOf(s, id) ?? s.root), label(s, ownerSection(s, id))] as const;
    return [...ids].sort((a, b) => {
      const [da, la] = key(a);
      const [db, lb] = key(b);
      return da - db || la.localeCompare(lb) || (a < b ? -1 : 1);
    });
  }

  // ---- following targets ----

  /**
   * Open a target. In panes it opens in the next pane and the focus goes into it; in the column a
   * node is gone to (Back returns) and an article opens as a page of its own (h or Back returns).
   * A web page opens in a new tab.
   */
  follow(r: Ref) {
    if (r.kind === "url") {
      window.open(r.url, "_blank", "noopener,noreferrer");
      return this.say(`Opened ${r.url} in a new tab.`);
    }
    if (r.kind === "node") {
      const id = resolveNode(this.snap, r);
      if (!id) return this.say(`The node this links to is gone${r.path?.length ? ` (it was “${r.path.join(" › ")}”)` : ""}, and nothing at its old place was found.`);
      if (this.panes) {
        const from = this.backHere();
        this.paneAt = this.openPane(this.paneAt, { kind: "node", id, from });
        // Not reveal: that would unhoist, and the trail starts at the top node. A jump pane can show anything.
        for (const a of ancestors(this.snap, id)) this.open.add(a);
        this.setFocus({ node: id, grain: "node" });
        return this.remember(true);
      }
      this.reveal(id);
      this.setFocus({ node: id, grain: "node" });
      return this.remember(true);
    }
    if (this.panes) {
      const from = this.backHere();
      this.paneAt = this.openPane(this.paneAt, { kind: "wiki", title: r.title, lang: r.lang, from });
      return this.setFocus(this.focus, { kind: "wiki", host: `p${this.paneAt}`, row: { t: "head" } });
    }
    this.openColWiki(r.title, r.lang, true);
  }

  /** The column's article page. A further article from it stacks on it; h goes back one. */
  openColWiki(title: string, lang: string, push: boolean) {
    if (this.colWiki) this.colWiki.stack.push({ title: this.colWiki.title, lang: this.colWiki.lang, aux: this.aux });
    else this.colWiki = { title, lang, stack: [], back: { focus: this.focus, hoist: this.hoist, aux: this.aux } };
    this.colWiki.title = title;
    this.colWiki.lang = lang;
    this.colOpen.clear();
    this.aux = { kind: "wiki", host: "col", row: { t: "head" } };
    if (push && this.ready) window.history.pushState(null, "", this.here());
    this.setTitle();
    this.emit();
  }

  /** h at the top of the column's article page: the article before it, or back to where it was opened from. */
  closeColWiki() {
    const c = this.colWiki;
    if (!c) return;
    const prev = c.stack.pop();
    if (prev) {
      c.title = prev.title;
      c.lang = prev.lang;
      this.colOpen.clear();
      this.aux = prev.aux ?? { kind: "wiki", host: "col", row: { t: "head" } };
    } else {
      this.colWiki = null;
      this.hoist = c.back.hoist && this.snap.nodes[c.back.hoist] ? c.back.hoist : this.hoist;
      this.focus = this.snap.nodes[c.back.focus.node] ? c.back.focus : { node: this.top, grain: "node" };
      this.aux = c.back.aux && this.auxValid(c.back.aux) ? c.back.aux : null;
    }
    window.history.replaceState(null, "", this.here());
    this.setTitle();
    this.emit();
  }

  isOpen(id: NodeId) {
    return id === this.top || (this.open.has(id) && !this.listing(id));
  }

  /** On screen right now: every ancestor up to the top is open. */
  rendered = (id: NodeId): boolean => {
    const s = this.snap;
    if (!s.nodes[id]) return false;
    for (let p = s.nodes[id].parent, c = id; ; c = p, p = s.nodes[p].parent) {
      if (c === this.top) return true;
      if (!p) return false;
      if (!this.isOpen(p)) return false;
      if (s.nodes[c].kind === "note" && !this.open.has(c)) return false;
    }
  };

  /** Sections in reading order, for j and k. */
  visible(): NodeId[] {
    const s = this.snap;
    const out: NodeId[] = [];
    const visit = (id: NodeId) => {
      out.push(id);
      if (this.isOpen(id)) sections(s, id).forEach(visit);
    };
    visit(this.top);
    return out;
  }

  setMode(mode: Mode) {
    this.mode = mode;
    this.emit();
  }

  say(text: string) {
    this.status = text;
    this.log.push({ at: Date.now(), text });
    if (this.log.length > 200) this.log.shift();
    this.emit();
  }

  // ---- boot, sync ----

  async boot() {
    try {
      let state: { user: string; llm: LLM["kind"]; model: string | null; library?: string; branches?: { name: string }[]; migrated?: Migrated | null; wiki?: WikiConfig; linkJob?: JobState | null; web?: { on: boolean; searches: number; fetches: number } } | null = null;
      try {
        const res = await fetch("/api/state");
        if (res.ok) state = await res.json();
      } catch {
        /* offline: fall back to what is stored locally */
      }
      if (state && !state.library) throw new Error("This page is newer than the server it came from. Restart the server (npm run dev) and reload.");
      this.online = !!state;
      if (state?.wiki) this.wiki = state.wiki;
      this.web = state?.web ?? { on: false, searches: 0, fetches: 0 };
      if (state?.linkJob?.state === "running") this.links.job = state.linkJob;
      configureWiki(state?.wiki, () => (this.replayHeld(), this.emit()), () => {
        // Once per browser: why Wikipedia is slow, and what makes it fast.
        if (lsGet("ie:wiki-hint", false)) return;
        lsSet("ie:wiki-hint", true);
        this.say("Wikipedia is answering slowly: without a contact address the server may only ask it a few times a minute. Start the server with IE_WIKI_CONTACT set (an email address, an https:// URL or User:Name) to lift that.");
      });
      this.user = lsGet("ie:user", state?.user ?? "you");
      if (state) this.llm = refreshAfterCalls(remoteLLM(state.llm, state.model ?? undefined));
      const library = state?.library ?? lsGet<string | null>("ie:library", null);
      if (!library) throw new Error("Could not load the library: the server is not reachable and nothing is stored in this browser.");
      lsSet("ie:library", library);

      this.session = new Session(library, this.user, clientId, {
        changed: (doc) => doc === this.shown && this.emit(),
        synced: (name, ok, report) => {
          this.online = ok;
          if (report?.conflicts.length && name === this.repo.current) {
            this.say(`${report.conflicts.length} semantic conflict${report.conflicts.length > 1 ? "s" : ""} from a concurrent edit: g to review`);
          }
          this.repairView();
          this.emit();
        },
        connection: (up) => {
          this.online = up;
          this.emit();
        },
        foreign: () => this.say("The server now holds a different library than this page. Edits here are no longer sent; reload the page."),
        message: (msg) => {
          if (msg.linkJob) this.jobUpdate(msg.linkJob as JobState);
        },
      });
      await this.session.load((state?.branches ?? []).map((b) => b.name), this.online);
      const branch = lsGet("ie:branch", "main");
      this.repo.current = this.repo.branches.has(branch) ? branch : "main";
      this.restoreView();
      this.undoManager();
      this.navigate(location.pathname, "replace");
      this.ready = true;
      this.emit();
      // The first commit hashes the whole library once (later ones only the path to what they
      // changed); do that while the page is idle rather than on the reader's first edit.
      const warm = () => this.doc.stateHash();
      if (typeof requestIdleCallback === "function") requestIdleCallback(warm);
      else setTimeout(warm, 500);

      if (state) {
        // On the way out, hand the server anything it has not seen.
        addEventListener("pagehide", () => this.session.flush());
        document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && this.session.flush());
        this.session.connect();
      }
      // Back and forward move between places in the library.
      addEventListener("popstate", () => this.navigate(location.pathname, "none"));
      if (state?.migrated) void this.checkOldReplicas(state.migrated);
    } catch (err) {
      this.fatal = err instanceof Error ? err.message : String(err);
      this.emit();
    }
  }

  /**
   * The version that kept each document separately stored its replicas under `doc:<uid>:…` (and
   * the single-document version under bare `branch:<name>` keys). They are never loaded into the
   * library, but one may hold edits made offline that never reached the server: compare each with
   * what the server had when it built the library, and say so if it is ahead.
   */
  private async checkOldReplicas(migrated: Migrated) {
    const flag = `lib:${this.session.library}:old-checked`;
    if (await idbGet(flag)) return;
    const keys = await idbKeys();
    const found: OldReplica[] = [];
    const check = async (key: string, entry: Migrated["docs"][number] | undefined, branch: string) => {
      const bytes = await idbGet<Uint8Array>(key);
      if (!bytes || !entry) return;
      const had = entry.versions[branch];
      const mine = Doc.load(bytes, this.user).loro.version().toJSON();
      if (!had || !vvIncludes(decodeVV(had) as never, mine)) found.push({ slug: entry.slug, title: entry.title, branch, bytes });
    };
    for (const key of keys) {
      const m = /^doc:([0-9a-f]+):branch:(.+)$/.exec(key);
      if (m) await check(key, migrated.docs.find((d) => d.uid === m[1]), m[2]);
    }
    if (!(await idbGet("adopted"))) {
      for (const key of keys) {
        const m = /^branch:(.+)$/.exec(key);
        if (m) await check(key, migrated.docs.find((d) => d.slug === "infinite-expand"), m[1]);
      }
    }
    this.oldReplicas = found;
    if (!found.length) return void idbSet(flag, true);
    const names = found.map((r) => `“${clip(r.title, 30)}”${r.branch === "main" ? "" : ` (${r.branch})`}`).join(", ");
    this.say(`This browser holds edits made before the library existed that never reached the server: ${names}. They were not merged. :/recover saves each as a .md file.`);
  }

  /** :/recover: save each old replica that is ahead of the server as a file, then stop mentioning them. */
  recover() {
    if (!this.oldReplicas.length) return this.say("Nothing to recover: no old replica in this browser holds unsent edits.");
    for (const r of this.oldReplicas) {
      const { text } = serializeDoc(Doc.load(r.bytes, this.user).snap());
      download(`${r.slug}${r.branch === "main" ? "" : `-${r.branch.replace(/[^\w-]+/g, "-")}`}-unsent.md`, text);
    }
    this.say(`Saved ${this.oldReplicas.length} file${this.oldReplicas.length > 1 ? "s" : ""}; m then i imports one as a document.`);
    this.oldReplicas = [];
    void idbSet(`lib:${this.session.library}:old-checked`, true);
  }

  /** The current document's title, or the library's. */
  docTitle(): string {
    const s = this.snap;
    const d = this.currentDoc;
    return d ? s.nodes[d].title : s.nodes[s.root].title;
  }

  /** The window's title: the article on the column's article page, else the document. */
  private setTitle() {
    document.title = this.colWiki ? `${this.colWiki.title} · Wikipedia` : this.docTitle() || "Infinispand";
  }

  /** Every edit is saved as it is made; this says whether the server has it yet. */
  saveState(): "saved" | "saving" | "offline" | "foreign" {
    if (this.session.foreign) return "foreign";
    if (!this.online) return "offline";
    return this.session.synced() ? "saved" : "saving";
  }

  /** True when the server has everything this browser has. */
  synced(): boolean {
    return this.session.synced();
  }

  private viewKey(branch = this.repo.current) {
    return `ie:view:${branch}`;
  }
  private restoreView() {
    const s = this.doc.snap();
    const v = lsGet<{ open: NodeId[]; focus: Focus | null; hoist: NodeId | null; forest?: unknown; at?: number; hues?: number; forks?: unknown; trail?: PaneRef[]; paneAt?: number }>(this.viewKey(), { open: [], focus: null, hoist: null });
    this.open = new Set(v.open.filter((id) => s.nodes[id]));
    this.hoist = v.hoist && s.nodes[v.hoist] ? v.hoist : null;
    this.focus = v.focus && s.nodes[v.focus.node] ? v.focus : { node: this.top, grain: "node" };
    // The forest of forks; a view saved before orphans has one tree, and before forks only its trail, which loads as one branch.
    this.forest = prune(restoreForest<PaneRef, Back>(v, isPaneRef), (p) => p.kind === "wiki" || !!s.nodes[p.id]);
    this.paneAt = Math.min(v.paneAt ?? 0, Math.max(0, this.trail.length - 1));
    this.aux = null;
    this.repairView();
  }
  saveView() {
    const bare = (p: PaneRef): PaneRef => ({ ...p, from: undefined });
    // The trail too, for a build from before forks.
    lsSet(this.viewKey(), { open: [...this.open], focus: this.focus, hoist: this.hoist, forest: this.forest.trees.map((t) => saveTree(t, bare)), at: this.forest.at, hues: this.forest.hues ?? 0, trail: this.trail.map(bare), paneAt: this.paneAt });
  }
  /** Keep focus on something that exists and is on screen. */
  private repairView() {
    const s = this.snap;
    if (this.hoist && !s.nodes[this.hoist]) this.hoist = null;
    if (!s.nodes[this.focus.node]) this.focus = { node: this.top, grain: "node" };
    // An annotation is on screen only with its article; with none showing it, back to the top.
    if (inArticles(s, this.focus.node) && !this.hostOf(this.focus.node)) this.focus = { node: this.top, grain: "node" };
    const n = s.nodes[this.focus.node];
    if (this.focus.range && this.focus.range[1] > n.body.length) this.focus = { node: n.id, grain: "node" };
    if (!this.rendered(this.focus.node) && !inArticles(s, n.id)) this.reveal(this.focus.node);
    if (this.aux && !this.auxValid(this.aux)) this.aux = null;
    this.syncTrail();
  }

  // ---- addresses ----

  /**
   * The address of what is on screen. On the column's library page it is the library; otherwise
   * it is the focused node, so a reload, a link or Back lands on it again.
   */
  here(): string {
    if (!this.panes && this.colWiki) return `/w/${this.colWiki.lang}/${encodeURIComponent(this.colWiki.title.replace(/ /g, "_"))}`;
    const s = this.snap;
    if (!this.panes && isLibraryRoot(s, this.top)) return "/";
    // An annotation has no address of its own: the address stays on what shows its article.
    if (inArticles(s, this.focus.node)) return location.pathname;
    return address(s, this.focus.node);
  }

  /**
   * Put the address in the bar. Moving the focus replaces the entry (after a pause: browsers
   * throttle a page that rewrites its address on every keystroke); opening a document or
   * jumping makes a new one, so Back returns to where the reader was.
   */
  private remember(push = false) {
    clearTimeout(this.addressTimer);
    if (this.preview || !this.ready) return;
    const write = () => {
      const path = this.here();
      this.setTitle();
      if (location.pathname === path) return;
      if (push) window.history.pushState(null, "", path);
      else window.history.replaceState(null, "", path);
    };
    if (push) write();
    else this.addressTimer = setTimeout(write, 250);
  }

  /** Show what a path names: on boot, and on Back and Forward. */
  navigate(path: string, history: "replace" | "none") {
    const s = this.snap;
    // An article page of the column has an address of its own, so Back returns to it and from it.
    const w = /^\/w\/([a-z][a-z0-9-]{1,15})\/(.+)$/.exec(path);
    if (w && !this.panes) {
      let title = w[2];
      try {
        title = decodeURIComponent(title);
      } catch {
        /* keep it as it came */
      }
      title = title.replace(/_/g, " ");
      if (this.colWiki?.title !== title) this.openColWiki(title, w[1], false);
      if (history === "replace") window.history.replaceState(null, "", this.here());
      return this.emit();
    }
    if (this.colWiki) {
      this.colWiki = null;
      this.aux = null;
    }
    const named = w ? ({ node: s.root } as const) : resolve(s, path);
    const found = "node" in named && inArticles(s, named.node) ? ({ node: s.root } as const) : named;
    if ("missing" in found) {
      this.say(`There is no ${found.missing.replace(/^no /, "")} here. Showing the library.`);
      this.hoist = null;
      this.focus = { node: s.root, grain: "node" };
    } else if (isLibraryRoot(s, found.node)) {
      // The library page: in the column, on the row of the document the reader was in; in
      // panes, the library alone.
      const from = docOf(s, this.focus.node);
      this.hoist = null;
      this.focus = { node: (!this.panes && from) || s.root, grain: "node" };
    } else {
      if (!this.panes && found.node === docOf(s, found.node)) this.hoist = found.node;
      this.reveal(found.node);
      // In panes, the node an address names is shown in its own pane: the trail keeps it if it
      // already shows it (Back to a pane of the trail), and is made again as the path to it if not.
      if (this.panes && s.nodes[found.node].kind === "section") this.open.add(found.node);
      this.focus = { node: found.node, grain: "node" };
      this.aux = null;
      // A pane in another fork that shows it brings that fork onto the branch.
      const at = this.trail.findIndex((p) => p.kind === "node" && p.id === found.node);
      const fork = at < 0 && this.panes ? this.panesPlaced.find((x) => x.node.ref.kind === "node" && x.node.ref.id === found.node) : undefined;
      if (fork) {
        this.setForest(focusIn(this.forest, fork.node.id));
        this.paneAt = fork.depth;
      } else if (this.panes && at < 0) this.setForest(withBranch(this.forest, this.pathRefs(), sameRef));
      else if (at >= 0) this.paneAt = at;
    }
    this.repairView();
    this.saveView();
    if (history === "replace") window.history.replaceState(null, "", this.here());
    this.setTitle();
    this.emit();
  }

  // ---- navigation ----

  setFocus(f: Focus, aux: Aux | null = null) {
    const was = this.focus.node;
    this.focus = f;
    this.aux = aux;
    this.syncTrail();
    this.saveView();
    this.scheduleSpeculation();
    this.remember();
    if (was === f.node) this.emitText(f.node);
    else this.emit(was, f.node);
  }

  /**
   * Open whatever needs opening for a node to be on screen. The column shows one document at a
   * time, so a node in another one is shown by hoisting to its document; a document itself is a
   * row of the library page until it is opened.
   */
  reveal(id: NodeId) {
    const s = this.snap;
    // An annotation is shown with its article, wherever that is; the Wikipedia container is never a page.
    if (!s.nodes[id] || inArticles(s, id)) return;
    const chain = ancestors(s, id);
    const under = this.hoist && (id === this.hoist || chain.includes(this.hoist));
    if (!this.panes) {
      if (isLibraryRoot(s, id)) this.hoist = null;
      else if (!under && !(this.hoist === null && s.nodes[id].parent === s.root)) this.hoist = s.library ? docOf(s, id) : null;
    } else if (this.hoist && !under) this.hoist = null;
    for (const a of chain) this.open.add(a);
    if (s.nodes[id].kind === "note") this.open.add(id);
  }

  go(id: NodeId, grain: Grain = "node", range?: Range) {
    const hoist = this.hoist;
    this.reveal(id);
    this.setFocus({ node: id, grain, range });
    if (this.hoist !== hoist) this.remember(true);
  }

  /** Open a document: hoist to it in the column, show it in the next pane in panes. */
  /** Open a document: from its row in the library, beside what is open; from the menu, a command or an address (`nav`), in place of it. */
  openDoc(id: NodeId, nav = false) {
    const s = this.doc.snap();
    if (!s.nodes[id]) return;
    void this.links.loadDoc(id);
    this.preview = null;
    this.mode = "normal";
    this.aux = null;
    this.colWiki = null;
    if (this.panes) {
      if (this.hoist && this.hoist !== id && !ancestors(s, this.hoist).includes(id)) this.hoist = null;
      this.open.add(id);
      this.focus = { node: id, grain: "node" };
      this.syncTrail();
      if (s.nodes[id].parent === this.top) this.withReplace(nav || this.replacing, () => this.openPane(this.paneAt, { kind: "node", id }));
    } else this.hoist = id;
    this.focus = { node: id, grain: "node" };
    this.saveView();
    this.remember(true);
    this.emit();
  }

  /**
   * Step out of the hoisted node: to its document if it is deeper, else to the library. The
   * focus stays on what was the top, now a row of the page it opened from.
   */
  stepOut() {
    this.aux = null;
    const s = this.snap;
    const was = this.hoist;
    if (!was) return;
    const d = docOf(s, was);
    this.hoist = d && d !== was ? d : null;
    // A note opened as a page steps back out to its words.
    const a = s.nodes[was].kind === "note" ? s.nodes[was].anchors[0] : undefined;
    this.focus = a ? { node: s.nodes[was].parent!, grain: "word", range: [a.start, a.end] } : { node: was, grain: "node" };
    if (a) this.reveal(this.focus.node);
    this.saveView();
    this.remember(true);
    this.emit();
  }

  move(delta: number) {
    const s = this.snap;
    const f = this.focus;
    const n = s.nodes[f.node];
    const sel = this.selecting();
    if (sel && sel.grain !== "node") {
      const units = sel.grain === "sentence" ? sentences(sel.text) : words(sel.text);
      if (!units.length) return;
      const i = Math.max(0, Math.min(units.length - 1, rangeAt(units, sel.range?.[0] ?? 0) + delta));
      return sel.set(sel.grain, units[i]);
    }
    if (n.wanchor && !this.aux) return this.moveAnnotation(n.id, delta);
    if (n.kind === "note" && !this.aux && !this.paneHead(n.id) && n.id !== this.top) {
      // Among the open notes of the same parent, in the order their anchors appear.
      const sibs = notesOf(s, n.parent!).filter((id) => this.open.has(id)).sort((a, b) => (s.nodes[a].anchors[0]?.start ?? 0) - (s.nodes[b].anchors[0]?.start ?? 0));
      const next = sibs[sibs.indexOf(n.id) + delta];
      if (next) this.setFocus({ node: next, grain: "node" });
      return;
    }
    if (this.panes) {
      // Among the rows of the pane that holds the focus: its sections, then its target and
      // "Linked from" rows. A head is above the rows: j enters them; nothing is above it.
      this.syncTrail();
      const rows = this.paneRows(this.paneAt);
      const i = this.rowIndex(rows);
      const next = i < 0 ? (delta > 0 ? 0 : -1) : Math.max(0, Math.min(rows.length - 1, i + delta));
      if (next >= 0 && next !== i && rows[next]) this.focusRow(rows[next]);
      return;
    }
    const rows = this.columnRows();
    const i = this.rowIndex(rows);
    const next = rows[Math.max(0, Math.min(rows.length - 1, (i < 0 ? 0 : i) + delta))];
    if (next) this.focusRow(next);
  }

  /** Grow or shrink the selection by one unit at its far end. */
  extend(delta: number) {
    const sel = this.selecting();
    if (!sel || sel.grain === "node" || !sel.range) return;
    const units = sel.grain === "sentence" ? sentences(sel.text) : words(sel.text);
    const last = rangeAt(units, sel.range[1] - 1);
    const first = rangeAt(units, sel.range[0]);
    const target = Math.max(first, Math.min(units.length - 1, last + delta));
    sel.set(sel.grain, [sel.range[0], units[target][1]]);
  }

  /** l: open, or step into the first child. On a selection: step into the note anchored there. */
  into() {
    const s = this.snap;
    const f = this.focus;
    if (f.grain !== "node" || this.inArticleText) return this.move(1);
    if (this.listing(f.node)) return this.openDoc(f.node);
    if (this.panes && (s.nodes[f.node].kind === "section" || this.paneHead(f.node))) {
      this.syncTrail();
      const i = this.paneAt;
      const p = this.trail[i];
      if (p?.kind === "node" && p.id !== f.node) {
        // A row: show its pane next; if it is showing, step into it.
        const next = this.trail[i + 1];
        if (next?.kind === "node" && next.id === f.node && this.continues(i + 1)) {
          const rows = this.paneRows(i + 1);
          // Into its first row; with none, onto its head, which makes it the active pane.
          if (rows[0]) this.focusRow(rows[0], i + 1);
          else this.land(i + 1);
          return;
        }
        this.open.add(f.node);
        this.openPane(i, { kind: "node", id: f.node });
        this.remember();
        return this.onOpened(f.node);
      }
      // A head: into its first row.
      const rows = this.paneRows(i);
      if (rows[0]) this.focusRow(rows[0], i);
      return;
    }
    if (!this.isOpen(f.node)) return this.setOpen(f.node, true);
    const kids = sections(s, f.node);
    if (kids.length) this.setFocus({ node: kids[0], grain: "node" });
  }

  /** Enter on a selection: open the note anchored there, step into it if it is open, or ask for one. */
  enterOrExpand() {
    if (this.inArticleText) return this.enterArticle();
    // Words with a note and a target (the note's own, or a link's on the same words) open as one
    // page: the note's text above, the article (or target) beneath.
    const both = this.commentaryAt(this.focus.range);
    if (both) return this.openCommentary(both);
    const note = this.noteAt(this.focus.range);
    if (!note) return this.expand();
    const n = this.snap.nodes[note];
    // A link opens its target: in panes at once, in the column after a preview under its paragraph.
    if (n.ref && !n.body.trim() && (this.panes || this.open.has(note))) return this.follow(n.ref);
    if (this.open.has(note)) return this.setFocus({ node: note, grain: "node" });
    this.open.add(note);
    this.saveView();
    this.emit(note);
  }

  /** h: close, or step out to the parent; at the top of a hoisted page, step out of it. */
  out() {
    const s = this.snap;
    const f = this.focus;
    const n = s.nodes[f.node];
    if (f.grain !== "node" || this.inArticleText) return this.move(-1);
    if (n.wanchor) return this.leaveAnnotation(n.id);
    if (n.kind === "note" && !this.paneHead(n.id) && n.id !== this.top) {
      const a = n.anchors[0];
      return this.setFocus({ node: n.parent!, grain: a ? "word" : "node", range: a ? [a.start, a.end] : undefined });
    }
    if (this.panes) {
      // Back left, never closing anything: from a row to its pane's node, from a jump to where it was made.
      this.syncTrail();
      const i = this.paneAt;
      const p = this.trail[i];
      // From a row to its pane's node: for a continuation, that is its row in the pane before.
      if (p?.kind === "node" && (p.id !== f.node || (i > 0 && this.continues(i)))) {
        if (i > 0 && this.continues(i)) this.paneAt = i - 1;
        return this.setFocus({ node: p.id, grain: "node" });
      }
      if (i > 0) {
        const from = this.trail[i].from;
        if (from && from.pane < i) return this.restore(from);
        this.paneAt = i - 1;
        const q = this.trail[i - 1];
        return q.kind === "node" ? this.setFocus({ node: q.id, grain: "node" }) : this.setFocus(this.focus, { kind: "wiki", host: `p${i - 1}`, row: { t: "head" } });
      }
      return this.hoist ? this.stepOut() : undefined;
    }
    if (f.node === this.top) return this.hoist ? this.stepOut() : undefined;
    if (this.isOpen(f.node)) return this.setOpen(f.node, false);
    if (n.parent) this.setFocus({ node: n.parent, grain: "node" });
  }

  /** In panes, a row opened is a pane opened next to the pane listing it (and one closed, closed). */
  private rowPane(id: NodeId, open: boolean) {
    if (!this.panes) return;
    this.syncTrail();
    const p = this.trail[this.paneAt];
    if (open && p?.kind === "node" && this.snap.nodes[id]?.parent === p.id && this.snap.nodes[id].kind === "section") this.openPane(this.paneAt, { kind: "node", id });
    else if (!open) this.closeRow(this.paneAt, id);
  }

  setOpen(id: NodeId, open: boolean) {
    if (id === this.top) return;
    if (open) this.open.add(id);
    else this.open.delete(id);
    this.rowPane(id, open);
    this.saveView();
    this.remember();
    this.emit(id);
    if (open) this.onOpened(id);
  }

  toggle(id = this.focus.node) {
    if (id === this.top) return this.toggleFold(id);
    if (this.listing(id)) return this.openDoc(id);
    // The head of a pane other than the first: Enter steps into its rows, as l does.
    if (this.panes && this.paneAt > 0 && this.paneHead(id)) return this.into();
    // In panes a row opens its pane, or focuses it where it is open already: closing is q's, or the pane's x.
    if (this.panes) {
      this.syncTrail();
      return this.setOpen(id, true);
    }
    this.setOpen(id, !this.isOpen(id));
  }

  /** Unfold or fold a document's own text where it is a prompt. */
  toggleFold(id: NodeId) {
    if (this.unfolded.has(id)) this.unfolded.delete(id);
    else this.unfolded.add(id);
    this.emit();
  }

  /** A node opened lazily may have gone stale while it was closed. */
  private onOpened(id: NodeId) {
    if (this.preview || !this.settings.auto || !this.generating) return;
    const s = this.snap;
    for (const c of [id, ...s.nodes[id].children]) {
      const n = s.nodes[c];
      if (!n.pinned && staleness(s, c).down && !staleness(s, c).orphan && this.rendered(c)) {
        const doc = this.doc;
        this.enqueue(`revising “${clip(label(s, c), 30)}”`, () => reconcile(this.llm, doc, c, undefined, undefined, this.writeHooks()));
      }
    }
  }

  /** i: narrow the grain. Node → sentence → word. */
  descend() {
    const s = this.snap;
    const f = this.focus;
    const n = s.nodes[f.node];
    const a = this.aux;
    if (a?.kind === "wiki") {
      // In an article: into its text, as in a node's body.
      if (a.row.t === "sec" && this.wikiHost(a.host)?.nested && !this.colOpen.has(a.row.id)) this.colOpen.add(a.row.id);
      const sel = this.selecting();
      if (!sel && a.row.t === "head" && this.auxArticle(a)?.state === "loading") {
        this.held = { aux: a, keys: [...(this.held && sameAux(this.held.aux, a) ? this.held.keys : []), "i"] };
        return this.say("The article is still loading; i selects in it when it arrives.");
      }
      if (!sel) return this.say(a.row.t === "sec" ? "l opens the section; i then selects in its text." : a.row.t !== "head" ? "Nothing to select here." : this.folded(this.wikiHost(a.host)?.embedded) ? "l unfolds the article; i then selects in it." : "The article is still loading.");
      const unit = sel.grain === "node" ? sentences(sel.text)[0] : sel.grain === "sentence" ? words(sel.text, sel.range)[0] : undefined;
      if (unit) sel.set(sel.grain === "node" ? "sentence" : "word", unit);
      else if (sel.grain === "node") this.say("This part of the article has no text to select.");
      return;
    }
    if (f.grain === "node") {
      if (!this.isOpen(f.node) && n.kind === "section" && !this.listing(f.node)) this.open.add(f.node);
      if (n.kind === "section") this.rowPane(f.node, true);
      const first = sentences(n.body)[0];
      if (first) this.setFocus({ node: f.node, grain: "sentence", range: first });
    } else if (f.grain === "sentence") {
      const first = words(n.body, f.range)[0];
      if (first) this.setFocus({ node: f.node, grain: "word", range: first });
    }
  }

  /** Esc: widen the grain. Word → sentence → node; at the top of a hoisted page, step out of it. */
  ascend() {
    const f = this.focus;
    const sel = this.selecting();
    if (sel?.grain === "word") {
      const all = sentences(sel.text);
      sel.set("sentence", all[rangeAt(all, sel.range?.[0] ?? 0)]);
    } else if (sel?.grain === "sentence") sel.set("node");
    else if (this.hoist && f.node === this.hoist && !this.aux) this.stepOut();
  }

  /** Tab: jump between the spans that already carry a note. */
  nextAnchor(delta: number) {
    if (this.aux?.kind === "wiki") return this.auxTab(delta);
    const s = this.snap;
    const f = this.focus;
    const spans = notesOf(s, f.node)
      .flatMap((id) => s.nodes[id].anchors.filter((a) => a.end > a.start).map((a): Range => [a.start, a.end]))
      .concat(this.preview ? [] : this.links.forNode(f.node, s).map((x) => x.range))
      .sort((a, b) => a[0] - b[0]);
    if (!spans.length) return;
    if (!this.isOpen(f.node)) this.open.add(f.node);
    if (f.grain === "node" && s.nodes[f.node].kind === "section") this.rowPane(f.node, true);
    const at = f.range?.[0] ?? (delta > 0 ? -1 : Infinity);
    const next = delta > 0 ? spans.find((r) => r[0] > at) ?? spans[0] : [...spans].reverse().find((r) => r[0] < at) ?? spans[spans.length - 1];
    this.setFocus({ node: f.node, grain: "word", range: next });
  }

  /** The sentence of a node's text at an offset (where a click or a right-click lands). */
  sentenceAt(id: NodeId, at: number): Range | undefined {
    const n = this.snap.nodes[id];
    return n ? sentences(n.body).find((r) => at >= r[0] && at <= r[1]) : undefined;
  }

  noteAt(range: Range | undefined, node = this.focus.node): NodeId | undefined {
    if (!range) return;
    const s = this.snap;
    return notesOf(s, node).find((id) => s.nodes[id].anchors.some((a) => a.start === range[0] && a.end === range[1]));
  }

  /** z: make a node the whole page; on the top of a hoisted page, step out of it. */
  setHoist(id: NodeId | null) {
    this.aux = null;
    if (id === null || (this.hoist && id === this.hoist) || isLibraryRoot(this.snap, id)) return this.stepOut();
    this.hoist = id;
    this.focus = { node: id, grain: "node" };
    this.saveView();
    this.remember(true);
    this.emit();
  }

  expandAll(id = this.focus.node) {
    const s = this.snap;
    // On the library, opening everything would mean every document; open the documents only.
    const under = isLibraryRoot(s, id) ? documents(s) : descendants(s, id);
    this.open.add(id);
    for (const d of under) if (s.nodes[d].kind === "section") this.open.add(d);
    this.saveView();
    this.emit();
  }

  collapseAll() {
    this.aux = null;
    this.open.clear();
    this.focus = { node: this.top, grain: "node" };
    this.saveView();
    this.remember();
    this.emit();
  }

  // ---- writing ----

  private writable(): boolean {
    if (this.preview) {
      this.say("Viewing history (read-only). Esc returns to now.");
      return false;
    }
    return true;
  }

  private apply(ops: Op[], message: string): NodeId[] {
    this.agentUndo = null;
    try {
      return this.doc.as(this.user, () => this.doc.apply(ops, message).created);
    } catch (err) {
      if (!(err instanceof OpError)) throw err;
      this.say(err.message);
      return [];
    }
  }

  /** Run a write that may refuse with an OpError, reporting the refusal. */
  private attempt(fn: () => void) {
    try {
      fn();
    } catch (err) {
      if (!(err instanceof OpError)) throw err;
      this.say(err.message);
    }
  }

  /** Run model work one job at a time, so regenerations never race each other. */
  private enqueue<T>(what: string, job: () => Promise<T>): Promise<T | undefined> {
    const run = async () => {
      this.busy++;
      this.say(`${what}…`);
      try {
        return await job();
      } catch (err) {
        this.say(err instanceof Error ? err.message : String(err));
        return undefined;
      } finally {
        this.busy--;
        this.emit();
      }
    };
    const p = this.queue.then(run);
    this.queue = p;
    return p;
  }

  /**
   * What model tasks get from the page: the nearby list for their prompts, and the marks they wrote,
   * which become forced candidates of a scan of the node.
   */
  private writeHooks(): WriteHooks {
    return {
      nearby: (node) => this.links.nearby(node),
      marks: (node, marks) => this.links.scan(node, "model", marks),
    };
  }

  /** After a human edit, let the model reconcile what the edit made stale. */
  private afterEdit(id: NodeId, what: string) {
    if (!this.settings.auto || !this.generating) return;
    const doc = this.doc;
    void this.enqueue("reconciling", async () => {
      const events = await cascade(this.llm, doc, id, what, {
        rendered: this.rendered,
        hooks: this.writeHooks(),
        onEvent: (e) => this.say(`${clip(label(doc.snap(), e.node), 30)}: ${e.text}`),
      });
      if (!events.length) this.status = "";
    });
  }

  startEdit(field: "title" | "body", fresh = false) {
    if (!this.writable()) return;
    const n = this.snap.nodes[this.focus.node];
    if (field === "body" && !this.isOpen(n.id) && !this.listing(n.id)) this.open.add(n.id);
    if (field === "body") this.rowPane(n.id, true);
    this.edit = { node: n.id, field, value: n[field], fresh };
    this.mode = "edit";
    this.emit();
  }

  commitEdit(value: string) {
    const e = this.edit;
    this.edit = null;
    this.mode = "normal";
    if (e) {
      const s = this.snap;
      const n = s.nodes[e.node];
      value = e.field === "title" ? value.replace(/\s+/g, " ").trim() : value.replace(/\n{3,}/g, "\n\n").trim();
      // [[marks]] never reach the stored text: they are asked of the scanner once the edit is saved.
      let marks: Mark[] = [];
      if (e.field === "body") ({ text: value, marks } = stripMarks(value));
      const links = e.field === "body" ? this.chosenLinks(e.node, value, e.chosen ?? []) : [];
      if (n && (value !== n[e.field] || links.length)) {
        const op: Op = { op: "update", id: e.node, [e.field]: value };
        this.apply([...(value !== n[e.field] ? [op] : []), ...links], `${e.field === "title" ? "Rename" : "Edit"} “${clip(e.field === "title" ? value : label(s, e.node), 40)}”`);
        if (value !== n[e.field]) this.afterEdit(e.node, `the ${e.field} of “${n.title}” was edited by a person`);
        if (e.field === "body") this.links.scan(e.node, "human", marks);
      } else if (n && marks.length) {
        this.links.scan(e.node, "human", marks);
      } else if (n && e.fresh && !n.title && !n.body) {
        this.apply([{ op: "delete", id: e.node }], "Discard empty node");
        this.focus = { node: n.parent ?? this.top, grain: "node" };
      }
    }
    this.focus = { node: this.snap.nodes[this.focus.node] ? this.focus.node : this.top, grain: "node" };
    this.remember();
    this.emit();
  }

  /**
   * Links chosen in the [[ completer while editing: each phrase found again in the saved text (the
   * occurrence nearest where it was typed) and linked in the same commit as the edit.
   */
  private chosenLinks(node: NodeId, text: string, chosen: { phrase: string; at: number; target: Ref }[]): Op[] {
    const ops: Op[] = [];
    const taken: Range[] = [];
    for (const c of chosen) {
      let best = -1;
      for (let i = text.indexOf(c.phrase); i >= 0; i = text.indexOf(c.phrase, i + 1)) if (best < 0 || Math.abs(i - c.at) < Math.abs(best - c.at)) best = i;
      if (best < 0) continue;
      const r: Range = [best, best + c.phrase.length];
      if (taken.some((t) => t[0] < r[1] && r[0] < t[1])) continue;
      taken.push(r);
      const s = this.snap;
      const target = c.target.kind === "node" && c.target.id && s.nodes[c.target.id] ? nodeRef(s, c.target.id) : c.target;
      ops.push({ op: "create", parent: node, kind: "note", anchors: [r], ref: target });
    }
    return ops;
  }

  /** a: a new section inside the focused node. A: a new section after it. On the library, a section is a document. */
  add(where: "child" | "after") {
    if (!this.writable()) return;
    const s = this.snap;
    const n = s.nodes[this.focus.node];
    const asChild = where === "child" || !n.parent || n.id === this.top || n.kind === "note";
    const parent = asChild ? n.id : n.parent!;
    const index = asChild ? undefined : s.nodes[parent].children.indexOf(n.id) + 1;
    const [id] = this.apply([{ op: "create", parent, index, kind: "section", title: "", body: "" }], isLibraryRoot(s, parent) ? "Add document" : "Add section");
    if (!id) return;
    if (!this.listing(id)) this.open.add(parent);
    this.focus = { node: id, grain: "node" };
    this.startEdit("title", true);
  }

  remove() {
    if (!this.writable()) return;
    const s = this.snap;
    const sel = this.articleSelection();
    if (sel) {
      const note = this.annotationAt(sel.spot, sel.range);
      if (!note) return this.say("No annotation on these words to delete; Wikipedia's text itself cannot be deleted.");
      this.apply([{ op: "delete", id: note }], `Delete note on “${clip(s.nodes[note].wanchor!.q, 40)}”`);
      this.open.delete(note);
      return this.say("Note deleted. u to undo.");
    }
    if (this.focus.grain !== "node") {
      // On a selection, D removes the note anchored there; a link goes for good (its words are declined).
      const note = this.noteAt(this.focus.range);
      if (!note) return this.say("No note on this selection to delete. Esc to the node first to delete the node.");
      if (isLink(s.nodes[note])) return this.removeLink(note);
      this.apply([{ op: "delete", id: note }], `Delete note on “${clip(label(s, note), 40)}”`);
      this.open.delete(note);
      return this.say("Note deleted. u to undo.");
    }
    const n = s.nodes[this.focus.node];
    if (!n.parent) return this.say("The library itself cannot be deleted.");
    if (n.wanchor) {
      // An annotation: back to its words in the article, then away with it.
      this.leaveAnnotation(n.id);
      this.apply([{ op: "delete", id: n.id }], `Delete note on “${clip(n.wanchor.q, 40)}”`);
      return this.say("Note deleted. u to undo.");
    }
    const order = this.visible();
    const i = order.indexOf(n.id);
    const sibs = sections(s, n.parent);
    const j = sibs.indexOf(n.id);
    const next =
      n.kind === "note" ? n.parent
        : this.panes ? sibs[j + 1] ?? sibs[j - 1] ?? n.parent
        : order[i + 1 + descendants(s, n.id).filter((d) => order.includes(d)).length] ?? order[i - 1] ?? n.parent;
    this.apply([{ op: "delete", id: n.id }], `Delete “${clip(label(s, n.id), 40)}”`);
    if (this.hoist === n.id || (this.hoist && ancestors(s, this.hoist).includes(n.id))) this.hoist = docOf(s, n.parent) === n.parent ? n.parent : null;
    this.focus = { node: this.snap.nodes[next] ? next : n.parent, grain: "node" };
    this.remember();
    this.say(`Deleted “${clip(label(s, n.id), 40)}”. u to undo.`);
    if (n.kind === "section") this.afterEdit(n.parent, `the subsection “${n.title}” was deleted`);
  }

  /** J and K: reorder among sibling sections. */
  shift(delta: number) {
    if (!this.writable()) return;
    const s = this.snap;
    const n = s.nodes[this.focus.node];
    if (!n.parent || n.kind !== "section") return;
    const sibs = sections(s, n.parent);
    const target = sibs[sibs.indexOf(n.id) + delta];
    if (!target) return;
    this.apply([{ op: "move", id: n.id, parent: n.parent, index: s.nodes[n.parent].children.indexOf(target) }], `Move “${clip(n.title, 40)}” ${delta < 0 ? "up" : "down"}`);
    this.afterEdit(n.parent, `the subsections were reordered`);
  }

  /** >: make it a child of the section above. <: lift it out beside its parent. Either may carry it into another document. */
  indent(delta: number) {
    if (!this.writable()) return;
    const s = this.snap;
    const n = s.nodes[this.focus.node];
    if (!n.parent || n.kind !== "section") return;
    if (delta > 0) {
      const sibs = sections(s, n.parent);
      const prev = sibs[sibs.indexOf(n.id) - 1];
      if (!prev) return;
      this.apply([{ op: "move", id: n.id, parent: prev }], `Indent “${clip(n.title, 40)}”`);
      this.open.add(prev);
      this.afterEdit(prev, `the subsection “${n.title}” was moved in`);
    } else {
      const p = s.nodes[n.parent];
      if (!p.parent) return;
      this.apply([{ op: "move", id: n.id, parent: p.parent, index: s.nodes[p.parent].children.indexOf(p.id) + 1 }], `Outdent “${clip(n.title, 40)}”`);
      this.afterEdit(p.id, `the subsection “${n.title}” was moved out`);
    }
    this.repairView();
    this.emit();
  }

  /** p: lock or unlock a node. A locked node is never rewritten by a model (stored as `pinned`, its old name). */
  toggleLock() {
    if (!this.writable()) return;
    const n = this.snap.nodes[this.focus.node];
    this.apply([{ op: "update", id: n.id, pinned: !n.pinned }], `${n.pinned ? "Unlock" : "Lock"} “${clip(label(this.snap, n.id), 40)}”`);
    this.say(n.pinned ? "Unlocked: the model may rewrite this node." : "Locked: the model will not rewrite this node.");
  }

  /** b: accept a stale node as it stands. */
  bless() {
    if (!this.writable()) return;
    const s = this.snap;
    const id = this.focus.node;
    if (!isStale(s, id)) return this.say("Nothing to accept: this node is not stale.");
    this.apply([{ op: "bless", id }], `Accept “${clip(label(s, id), 40)}” as it stands`);
  }

  /** R: have the model bring a stale node back in line. */
  reconcileFocus() {
    if (!this.writable()) return;
    const s = this.snap;
    const id = this.focus.node;
    if (!this.generating) return this.say("No model configured.");
    if (!isStale(s, id)) return this.say("This node is not stale.");
    if (s.nodes[id].pinned) return this.say("Locked nodes are not rewritten. p unlocks; b accepts it as it stands.");
    const doc = this.doc;
    void this.enqueue(`reconciling “${clip(label(s, id), 30)}”`, async () => {
      if (await reconcile(this.llm, doc, id, undefined, undefined, this.writeHooks())) this.status = "";
    });
  }

  cycleForm() {
    if (!this.writable()) return;
    const n = this.snap.nodes[this.focus.node];
    if (n.kind !== "note") return;
    const forms: Form[] = ["gloss", "note", "passage"];
    this.apply([{ op: "update", id: n.id, form: forms[(forms.indexOf(n.form ?? "note") + 1) % 3] }], "Change note form");
  }

  private undoManager(): UndoManager {
    let u = this.undo.get(this.doc);
    if (!u) {
      u = new UndoManager(this.doc.loro, { mergeInterval: 0, maxUndoSteps: 200, excludeOriginPrefixes: [SYSTEM_ORIGIN] });
      this.undo.set(this.doc, u);
      // One commit can be stored as several changes; for undo they are a single step.
      const manager = u;
      this.doc.group = { start: () => manager.groupStart(), end: () => manager.groupEnd() };
    }
    return u;
  }
  /** Whether U would redo something (the top bar offers redo only then). */
  canRedo(): boolean {
    return !this.preview && this.undoManager().canRedo();
  }
  /** u: undo the last edit made in this tab, wherever in the library it was. */
  undoLast(redo = false) {
    if (!this.writable()) return;
    // The agent's work arrives by merge, which the undo stack does not see. If it was the last
    // thing to happen, undo means going back to the commit before it.
    if (!redo && this.agentUndo) {
      const { commit, doc } = this.agentUndo;
      this.agentUndo = null;
      this.attempt(() => (doc ? revertDocTo(this.doc, commit, doc) : revertTo(this.doc, commit)));
      this.repairView();
      return this.say("Undid the editor's changes (as a revert commit).");
    }
    const u = this.undoManager();
    const ok = redo ? u.redo() : u.undo();
    this.doc.touch();
    healAnchors(this.doc);
    this.repairView();
    this.say(ok ? (redo ? "Redone." : "Undone.") : `Nothing to ${redo ? "redo" : "undo"}.`);
  }

  // ---- expansion ----

  /**
   * e: go deeper. On a selection, a note (pre-generated if one is anchored there, generated
   * otherwise). On a node: open it, then open its sections, then generate sections it lacks.
   */
  expand(lens = "elaborate", question?: string) {
    if (this.aux?.kind === "wiki") return this.expandArticle(lens, question);
    const s = this.snap;
    const f = this.focus;
    const n = s.nodes[f.node];
    if (f.grain === "node") {
      if (this.listing(n.id)) return this.openDoc(n.id);
      if (!this.isOpen(n.id)) return this.setOpen(n.id, true);
      const kids = sections(s, n.id);
      const closed = kids.filter((k) => !this.open.has(k));
      if (closed.length && !isLibraryRoot(s, n.id)) {
        closed.forEach((k) => this.open.add(k));
        this.saveView();
        // In panes a child's pane only shows once it is focused, so say what changed.
        if (this.panes) this.status = `opened ${closed.length} section${closed.length > 1 ? "s" : ""} · l steps in, e again writes more only on a leaf`;
        return this.emit(n.id);
      }
      if (kids.length) return;
      return this.generateSections(n.id);
    }
    const range = f.range!;
    const existing = this.noteAt(range);
    if (existing && lens === "elaborate" && !question) {
      if (this.open.has(existing)) this.open.delete(existing);
      else this.open.add(existing);
      this.saveView();
      return this.emit(existing);
    }
    this.generateNote(n.id, range, lens, question);
  }

  private specKey(r: Pick<ExpansionRequest, "node" | "quote" | "lens" | "question">) {
    return [r.node, r.quote, r.lens, r.question ?? ""].join("\u0000");
  }

  private generateNote(node: NodeId, range: Range, lens: string, question?: string) {
    if (!this.writable()) return;
    if (!this.generating) return this.say("Nothing pre-generated here, and no model is configured. Start the server with ANTHROPIC_API_KEY set.");
    const snap = this.doc.snap();
    const quote = snap.nodes[node].body.slice(range[0], range[1]);
    if (!quote.trim()) return;
    const req: ExpansionRequest = { node, range, quote, form: formFor(quote), lens, question };
    const p: Pending = { key: `p${++this.seq}`, node, kind: "note", range, form: req.form, lens: question ?? lens, text: "" };
    // The note goes into the branch it was asked on, even if the reader has switched since.
    const doc = this.doc;
    this.pending.set(p.key, p);
    this.busy++;
    const started = performance.now();
    let first = true;
    const onText = (d: string) => {
      p.text += d;
      if (first) {
        first = false;
        this.t0 = { what: "first-token", at: started };
      }
      this.emit(node);
    };
    this.emit(node);
    const spec = this.spec?.key === this.specKey(req) ? this.spec : null;
    if (spec) {
      // Already being written speculatively: adopt it.
      this.spec = null;
      if (spec.text) onText(spec.text);
      spec.onText = onText;
    }
    // Words linked to an article are written about with its summary at hand, if the server has it
    // cached; never waiting on Wikipedia for it.
    const linked = notesOf(snap, node).map((c) => snap.nodes[c]).find((c) => c.ref?.kind === "wiki" && c.anchors.some((a) => a.start === range[0] && a.end === range[1]))?.ref;
    const grounded = !spec && linked?.kind === "wiki" ? cachedExtract(linked.title).then((g) => g ?? undefined) : Promise.resolve(undefined);
    const nearby = spec ? Promise.resolve([]) : this.links.nearby(node);
    (spec ? spec.done : Promise.all([grounded, nearby]).then(([grounding, near]) => streamExpansion(this.llm, snap, { ...req, grounding, nearby: near }, onText)))
      .then((text) => {
        let marks: Mark[] = [];
        const id = commitExpansion(doc, req, text, (_, m) => (marks = m));
        this.open.add(id);
        this.saveView();
        this.links.scan(id, "model", marks);
      })
      .catch((err) => this.say(err instanceof Error ? err.message : String(err)))
      .finally(() => {
        this.pending.delete(p.key);
        this.busy--;
        this.emit();
      });
  }

  private generateSections(id: NodeId) {
    if (!this.writable()) return;
    if (!this.generating) return this.say("This is as deep as the pre-generated tree goes, and no model is configured. Start the server with ANTHROPIC_API_KEY set.");
    const p: Pending = { key: `p${++this.seq}`, node: id, kind: "sections", text: "" };
    this.pending.set(p.key, p);
    this.busy++;
    const started = performance.now();
    let first = true;
    this.emit();
    const marked = new Set<NodeId>();
    const hooks = this.writeHooks();
    deepen(this.llm, this.doc, id, (d) => {
      p.text += d;
      if (first) {
        first = false;
        this.t0 = { what: "first-token", at: started };
      }
      this.emit(id);
    }, undefined, { ...hooks, marks: (node, marks) => (marked.add(node), hooks.marks!(node, marks)) })
      .then((created) => {
        created.forEach((c) => this.open.add(c));
        // Model-written nodes are scanned like any other writing, marks or not.
        for (const c of created.length ? created : [id]) if (!marked.has(c)) this.links.scan(c, "model");
      })
      .catch((err) => this.say(err instanceof Error ? err.message : String(err)))
      .finally(() => {
        this.pending.delete(p.key);
        this.busy--;
        this.saveView();
        this.emit();
      });
  }

  /** With speculation on, start writing the focused sentence's expansion before it is asked for. */
  private scheduleSpeculation() {
    clearTimeout(this.specTimer);
    if (!this.settings.speculate || !this.generating || this.preview) return;
    const f = this.focus;
    if (f.grain !== "sentence" || !f.range || this.noteAt(f.range)) return;
    this.specTimer = setTimeout(() => {
      const snap = this.doc.snap();
      const n = snap.nodes[f.node];
      if (!n || this.focus !== f) return;
      const quote = n.body.slice(f.range![0], f.range![1]);
      const req: ExpansionRequest = { node: f.node, range: f.range!, quote, form: formFor(quote), lens: "elaborate" };
      const key = this.specKey(req);
      if (this.spec?.key === key) return;
      this.spec?.ac.abort();
      const ac = new AbortController();
      const entry: NonNullable<Store["spec"]> = { key, text: "", ac, done: Promise.resolve("") };
      entry.done = streamExpansion(this.llm, snap, req, (d) => ((entry.text += d), entry.onText?.(d)), ac.signal);
      entry.done.catch(() => {});
      this.spec = entry;
    }, 350);
  }

  // ---- the command bar ----

  command(text: string) {
    this.mode = "normal";
    text = text.trim();
    this.emit();
    if (!text) return;
    const [verb, ...rest] = text.split(/\s+/);
    const arg = rest.join(" ");
    const here = this.currentDoc;
    const needDoc = (fn: (id: NodeId) => void) => () => (here ? fn(here) : this.say("Open a document first (m), or name it in the menu."));
    const builtin: Record<string, () => void> = {
      branch: () => {
        this.newBranch(arg, this.branchFrom ?? undefined);
        this.branchFrom = null;
      },
      switch: () => this.switchBranch(arg),
      merge: () => this.mergeFrom(arg),
      user: () => {
        this.user = arg || this.user;
        lsSet("ie:user", this.user);
        this.say(`You are ${this.user}.`);
      },
      auto: () => this.set("auto", arg !== "off"),
      speculate: () => this.set("speculate", arg !== "off"),
      curves: () => (this.set("curves", arg !== "off"), this.emit()),
      colors: () => this.setColors(arg),
      view: () => (["auto", "column", "panes"].includes(arg) ? this.setView(arg as View) : this.say(`/view auto, column or panes (now ${this.settings.view}, showing ${this.panes ? "panes" : "column"})`)),
      resolve: () => this.resolveAll(),
      new: () => (arg ? this.newDoc(arg) : this.openMenu("new")),
      open: () => this.openByName(arg),
      rename: needDoc((id) => (arg ? this.renameDocument(id, arg) : this.say("Give the new title: /rename <title>"))),
      duplicate: needDoc((id) => this.duplicateDocument(id, arg || `${this.snap.nodes[id].title} (copy)`)),
      export: needDoc((id) => this.exportDocument(id)),
      import: () => this.pickFile(),
      recover: () => this.recover(),
      link: () => this.linkTo(arg),
      unlink: () => this.unlink(),
      autolink: () => this.setAutolink(arg),
      linkdoc: needDoc((id) => void this.linkJob("doc", id)),
      linkall: () => void this.linkJob("library"),
      linkcancel: () => void this.cancelLinkJob(),
      research: () => this.agent(arg, { research: true }),
    };
    if (verb.startsWith("/") && builtin[verb.slice(1)]) return builtin[verb.slice(1)]();
    if (this.inArticleText) {
      const lens = LENSES.find((l) => l === text.toLowerCase());
      return this.expandArticle(lens ?? "elaborate", lens ? undefined : text);
    }
    if (this.aux?.kind === "wiki") return this.say("Select words of the article first (i), then : asks about them. The editor works on your own nodes.");
    if (this.focus.grain !== "node") {
      // A question about the selection becomes a note answering it.
      const lens = LENSES.find((l) => l === text.toLowerCase());
      return this.generateNote(this.focus.node, this.focus.range!, lens ?? "elaborate", lens ? undefined : text);
    }
    this.agent(text);
  }

  // ---- keys on aux rows: Wikipedia views, targets, "Linked from" ----

  /** The article text an aux focus is in: the lead or the section its row shows, with the article. None while it loads, or on a row that shows no text. */
  auxSpot(a: Aux | null = this.aux): Spot | null {
    if (a?.kind !== "wiki") return null;
    const h = this.wikiHost(a.host);
    const art = h ? wikiArticle(h.title, h.lang) : null;
    if (!h || art?.state !== "ready") return null;
    const sec = a.row.t === "head" ? (this.folded(h.embedded) ? -1 : h.sec) : a.row.t === "sec" && h.nested && this.colOpen.has(a.row.id) ? a.row.id : -1;
    const html = sec === 0 ? art.value.lead : art.value.sections.find((x) => x.id === sec)?.html;
    return sec < 0 || html === undefined ? null : { at: articleText(html), sec, article: art.value, lang: h.lang, host: a.host };
  }

  /** Tab on a Wikipedia view: the next (or previous) annotation or link in the text the focus is on, selected as words. */
  auxTab(delta: number) {
    const a = this.aux;
    if (!a || a.kind !== "wiki") return;
    // The article is still arriving: its links are not known yet. Hold the key (and an Enter after
    // it) until it has, rather than answer "no links" and let the Enter fall on something else.
    const art = this.auxArticle(a);
    if (art?.state === "loading" && (a.row.t === "head" || a.row.t === "sec")) {
      this.held = { aux: a, keys: [...(this.held && sameAux(this.held.aux, a) ? this.held.keys : []), delta > 0 ? "Tab" : "S-Tab"] };
      return this.say("The article is still loading; Tab goes to its first link when it arrives.");
    }
    if (art?.state === "failed") return this.say(`The article could not be loaded: ${art.message}`);
    const spot = this.auxSpot(a);
    const spans = spot ? this.spansIn(spot) : [];
    if (!spans.length) return this.say(a.row.t === "head" || a.row.t === "sec" ? "No links to other articles or notes here." : "");
    const at = a.range?.[0] ?? (delta > 0 ? -1 : Infinity);
    const next = delta > 0 ? spans.find((r) => r[0] > at) ?? spans[0] : [...spans].reverse().find((r) => r[0] < at) ?? spans[spans.length - 1];
    this.setFocus(this.focus, { ...a, grain: "word", range: next });
  }

  /** The article a focused link inside an article names: the link whose words are exactly the selection. */
  auxLink(a: Aux): { title: string; lang: string } | null {
    if (a.kind !== "wiki" || !a.range) return null;
    const spot = this.auxSpot(a);
    const l = spot?.at.links.find((x) => x.range[0] === a.range![0] && x.range[1] === a.range![1]);
    return l && spot ? { title: l.title, lang: spot.lang } : null;
  }

  // ---- annotating articles (src/core/article.ts) ----

  private placed = new WeakMap<Article, { entries: unknown[]; value: Placements }>();
  /**
   * An article's annotations, found again in the revision at hand: where each is (a section's id
   * and a range in its text), and those whose words are gone. Worked out again only when the
   * article or one of its annotations changes.
   */
  annotations(article: Article, lang: string): Placements {
    const s = this.snap;
    const ids = annotationsOf(s, { lang, title: article.title, pageId: article.pageId });
    const entries = ids.map((id) => s.nodes[id]);
    const had = this.placed.get(article);
    if (had && had.entries.length === entries.length && had.entries.every((e, i) => e === entries[i])) return had.value;
    const value: Placements = { at: new Map(), detached: [] };
    if (ids.length) {
      const { ids: secIds, secs } = sectionTexts(article);
      for (const id of ids) {
        const p = reanchor(s.nodes[id].wanchor!, secs);
        if ("detached" in p) value.detached.push({ id, sec: p.sec === null ? null : secIds[p.sec] });
        else value.at.set(id, { sec: secIds[p.sec], range: p.range });
      }
    }
    this.placed.set(article, { entries, value });
    return value;
  }

  /** What Tab stops at in a piece of article text: its annotations' words and its links, in reading order. */
  private spansIn(spot: Spot): Range[] {
    const notes = [...this.annotations(spot.article, spot.lang).at.values()].filter((p) => p.sec === spot.sec).map((p) => p.range);
    const seen = new Set<string>();
    return [...notes, ...spot.at.links.map((l) => l.range)].sort((a, b) => a[0] - b[0] || a[1] - b[1]).filter((r) => !seen.has(r.join()) && !!seen.add(r.join()));
  }

  /** The annotation on exactly these words of a piece of article text. */
  private annotationAt(spot: Spot, range: Range | undefined): NodeId | undefined {
    if (!range) return;
    for (const [id, p] of this.annotations(spot.article, spot.lang).at) if (p.sec === spot.sec && p.range[0] === range[0] && p.range[1] === range[1]) return id;
  }

  /** The selection in article text, when the focus is one: where it is, and its range. */
  private articleSelection(): { a: Aux & { kind: "wiki" }; spot: Spot; range: Range; grain: "sentence" | "word" } | null {
    const a = this.aux;
    if (a?.kind !== "wiki" || !a.grain || !a.range) return null;
    const spot = this.auxSpot(a);
    return spot ? { a, spot, range: a.range, grain: a.grain } : null;
  }

  /** Whether the focus is a selection in an article's text. */
  get inArticleText(): boolean {
    return this.aux?.kind === "wiki" && !!this.aux.grain;
  }

  /** The text the focus selects in and how to move the selection: a node's body, or an article's text under the aux focus. */
  private selecting(): { text: string; grain: Grain; range?: Range; set: (grain: Grain, range?: Range) => void } | null {
    const a = this.aux;
    if (a?.kind === "wiki") {
      const spot = this.auxSpot(a);
      if (!spot) return null;
      return {
        text: spot.at.text,
        grain: a.grain ?? "node",
        range: a.range,
        set: (grain, range) => this.setFocus(this.focus, grain === "node" ? { kind: "wiki", host: a.host, row: a.row } : { kind: "wiki", host: a.host, row: a.row, grain, range }),
      };
    }
    if (a) return null;
    const f = this.focus;
    return { text: this.snap.nodes[f.node].body, grain: f.grain, range: f.range, set: (grain, range) => this.setFocus({ node: f.node, grain, range }) };
  }

  /** e d y x c and : on words of an article: open the annotation already there, or have one written. */
  private expandArticle(lens: string, question?: string) {
    const sel = this.articleSelection();
    if (!sel) return this.say("Select words first: i, then e d y x c or :. An article itself is never deepened or rewritten.");
    const existing = this.annotationAt(sel.spot, sel.range);
    if (existing && lens === "elaborate" && !question) {
      if (this.open.has(existing)) this.open.delete(existing);
      else this.open.add(existing);
      this.saveView();
      return this.emit();
    }
    this.generateArticleNote(sel.spot, sel.range, lens, question);
  }

  /** Enter on words of an article: an annotation opens, and Enter again steps into it; a link opens its article; anything else is expanded. */
  private enterArticle() {
    const sel = this.articleSelection()!;
    const note = this.annotationAt(sel.spot, sel.range);
    if (!note) {
      const link = this.auxLink(sel.a);
      return link ? this.follow({ kind: "wiki", title: link.title, lang: link.lang }) : this.expandArticle("elaborate");
    }
    if (this.open.has(note)) return this.setFocus({ node: note, grain: "node" });
    this.open.add(note);
    this.saveView();
    this.emit();
  }

  private generateArticleNote(spot: Spot, range: Range, lens: string, question?: string) {
    if (!this.writable()) return;
    if (!this.generating) return this.say("No model is configured to write a note. Start the server with ANTHROPIC_API_KEY set.");
    const quote = spot.at.text.slice(range[0], range[1]);
    if (!quote.trim()) return;
    const a = spot.article;
    const form = formFor(quote);
    const req = {
      article: { lang: spot.lang, title: a.title, pageId: a.pageId },
      anchor: makeAnchor(spot.at.text, range, sectionPath(a, spot.sec), a.revisionId),
      form,
      lens,
      question,
      context: this.articleContext(spot, range),
    };
    const p: Pending = { key: `p${++this.seq}`, node: "" as NodeId, kind: "note", range, form, lens: question ?? lens, text: "", art: { key: wikiKey(spot.lang, a.title), sec: spot.sec } };
    const doc = this.doc;
    this.pending.set(p.key, p);
    this.busy++;
    this.emit();
    streamArticleNote(this.llm, req, (d) => ((p.text += d), this.emit()))
      .then((text) => {
        this.open.add(commitArticleNote(doc, req, text));
        this.saveView();
      })
      .catch((err) => this.say(err instanceof Error ? err.message : String(err)))
      .finally(() => {
        this.pending.delete(p.key);
        this.busy--;
        this.emit();
      });
  }

  /** What a note on words of an article is written from: the lead, the section around the words (trimmed), and the reader's own sentence if the article was opened from one. */
  private articleContext(spot: Spot, range: Range) {
    const a = spot.article;
    const text = spot.at.text;
    const from = Math.max(0, range[0] - 3000);
    return {
      title: a.title,
      lead: clip(articleText(a.lead).text, spot.sec ? 2000 : 6000),
      heading: spot.sec ? sectionPath(a, spot.sec).join(" › ") : null,
      section: spot.sec ? `${from ? "… " : ""}${text.slice(from, range[1] + 3000)}${range[1] + 3000 < text.length ? " …" : ""}` : "",
      selection: text.slice(range[0], range[1]),
      from: this.fromSentence(spot.host),
    };
  }

  /** The sentence of the reader's own text an article view was opened from, if it was opened from words. */
  private fromSentence(host: string): string | undefined {
    const s = this.snap;
    let f: Focus | undefined;
    const n = host.startsWith("n") ? s.nodes[host.slice(1) as NodeId] : undefined;
    if (n?.kind === "note" && n.parent && n.anchors[0]) f = { node: n.parent, grain: "word", range: [n.anchors[0].start, n.anchors[0].end] };
    else if (host.startsWith("p")) {
      const b = this.trail[+host.slice(1)]?.from;
      if (b && !b.aux) f = b.focus;
    } else if (host === "col" && this.colWiki && !this.colWiki.stack.length && !this.colWiki.back.aux) f = this.colWiki.back.focus;
    const body = f?.range ? s.nodes[f.node]?.body : undefined;
    const sent = body ? sentences(body).find(([x, y]) => f!.range![0] >= x && f!.range![0] < y) : undefined;
    return sent ? plain(body!.slice(sent[0], sent[1])) : undefined;
  }

  /** The node of the article an annotation (or a note inside one) belongs to. */
  private articleOf(id: NodeId): NodeId | undefined {
    const s = this.snap;
    for (let x: NodeId | null = id; x && s.nodes[x]; x = s.nodes[x].parent) if (s.nodes[x].parent && s.nodes[s.nodes[x].parent!].articles) return x;
  }

  /** The article a host shows, keyed as the library files it: by its loaded title and page id when it has arrived. */
  private hostArticle(host: string): ArticleKey | null {
    const h = this.wikiHost(host);
    if (!h) return null;
    const art = wikiArticle(h.title, h.lang);
    return art.state === "ready" ? { lang: h.lang, title: art.value.title, pageId: art.value.pageId } : { lang: h.lang, title: h.title };
  }

  /** The views that could show an annotation: the article page, a pane's article, the article under a pane's node or the column's top. */
  private hosts(): string[] {
    if (!this.panes) return this.colWiki ? ["col"] : this.articleUnder(this.top) ? [`n${this.top}`] : [];
    return this.trail.flatMap((p, i) => (p.kind === "wiki" ? [`p${i}`] : this.articleUnder(p.id) ? [`n${p.id}`] : []));
  }

  /** Whether a view shows the article an annotation (or a note inside one) is on. */
  private shows(host: string, id: NodeId): boolean {
    const art = this.articleOf(id);
    const k = art && this.hostArticle(host);
    return !!k && articleNodes(this.snap, k).includes(art!);
  }

  /** The view showing the article an annotation is on, the focused pane's first. */
  private hostOf(id: NodeId): string | undefined {
    const p = this.panes ? this.trail[this.paneAt] : undefined;
    const mine = p ? (p.kind === "wiki" ? `p${this.paneAt}` : `n${p.id}`) : undefined;
    return mine && this.shows(mine, id) ? mine : this.hosts().find((h) => this.shows(h, id));
  }

  /** h on an annotation: back to its words in the article. */
  private leaveAnnotation(id: NodeId) {
    const host = this.hostOf(id);
    const k = host ? this.hostArticle(host) : null;
    const art = k ? wikiArticle(k.title, k.lang) : null;
    const p = k && art?.state === "ready" ? this.annotations(art.value, k.lang).at.get(id) : undefined;
    if (!host) return this.say("Its article is not on screen.");
    if (host.startsWith("p")) this.paneAt = +host.slice(1);
    const node = this.focusFor(host);
    // A detached annotation has no words to return to: back to the article.
    if (!p) return this.setFocus(node, { kind: "wiki", host, row: { t: "head" } });
    const h = this.wikiHost(host)!;
    const row: WRow = p.sec === h.sec ? { t: "head" } : { t: "sec", id: p.sec };
    if (row.t === "sec") this.colOpen.add(p.sec);
    this.setFocus(node, { kind: "wiki", host, row, grain: "word", range: p.range });
  }

  /** j k on an annotation: the next or previous open annotation of the same article, in reading order. */
  private moveAnnotation(id: NodeId, delta: number) {
    const host = this.hostOf(id);
    const k = host ? this.hostArticle(host) : null;
    const art = k ? wikiArticle(k.title, k.lang) : null;
    if (!k || art?.state !== "ready") return;
    const order = sectionTexts(art.value).ids;
    const list = [...this.annotations(art.value, k.lang).at].filter(([x]) => this.open.has(x)).sort(([, a], [, b]) => order.indexOf(a.sec) - order.indexOf(b.sec) || a.range[0] - b.range[0]);
    const next = list[list.findIndex(([x]) => x === id) + delta];
    if (next) this.setFocus({ node: next[0], grain: "node" });
  }

  /** The selected words, in a node's body or an article's text; null when nothing smaller than a node is selected. */
  selectedText(): string | null {
    const sel = this.selecting();
    return sel && sel.grain !== "node" && sel.range ? sel.text.slice(sel.range[0], sel.range[1]) : null;
  }

  /** The annotation on exactly the selected words of an article, if any. */
  articleNoteHere(): NodeId | undefined {
    const sel = this.articleSelection();
    return sel ? this.annotationAt(sel.spot, sel.range) : undefined;
  }

  /** The node focus to keep under an aux focus on an article view: the node it is under, else where it was, if that is not an annotation. */
  private focusFor(host: string): Focus {
    if (host.startsWith("n")) return { node: host.slice(1) as NodeId, grain: "node" };
    return inArticles(this.snap, this.focus.node) ? { node: this.top, grain: "node" } : this.focus;
  }

  /** A click or a drag in an article's text: the sentence at a point, or the words dragged over. */
  selectInArticle(host: string, row: WRow, range: Range, grain: "sentence" | "word") {
    const a: Aux = { kind: "wiki", host, row };
    const spot = this.auxSpot(a);
    if (!spot) return this.setFocus(this.focus, a);
    const all = sentences(spot.at.text);
    const r: Range = grain === "sentence" ? all.find((x) => range[0] >= x[0] && range[0] <= x[1]) ?? all[rangeAt(all, range[0])] : range;
    if (r) this.setFocus(this.focusFor(host), { ...a, grain, range: r });
  }

  /** A click on an annotation's words: it opens or closes, and the words are selected. */
  toggleAnnotation(host: string, row: WRow, id: NodeId) {
    const k = this.hostArticle(host);
    const art = k ? wikiArticle(k.title, k.lang) : null;
    const p = k && art?.state === "ready" ? this.annotations(art.value, k.lang).at.get(id) : undefined;
    if (this.open.has(id)) this.open.delete(id);
    else this.open.add(id);
    this.saveView();
    if (p) this.selectInArticle(host, row, p.range, "word");
    else this.emit();
  }

  /** Why a key that works on a node does nothing on Wikipedia's text, for the status line; null for a key that does work there. */
  articleRefuses(k: string, selecting: boolean): string | null {
    const own = "Wikipedia's text is shown as it is: it cannot be edited, renamed, moved, locked, reconciled or rewritten here. Annotations on it can: i selects words, e d y x c writes one.";
    if (["r", "a", "A", "J", "K", ">", "<", "p", "R", "b", "o", "O", "z"].includes(k) && !(selecting && (k === "J" || k === "K"))) return own;
    if (k === "c" && !selecting) return "Wikipedia's text cannot be edited here. Select words (i) and press c to challenge them, or e d y x to annotate them.";
    if (["e", "d", "y", "x"].includes(k) && !selecting) return "Select words first: i, then e d y x c or :. An article itself is never deepened or rewritten.";
    if (k === "D" && !selecting) return "An article cannot be deleted. D on an annotation's words deletes the annotation.";
    if (k === "w") return "Words of an article cannot be linked from here; W opens it on wikipedia.org.";
    if (k === "f") return "f changes an annotation's form: Enter on its words, Enter again, then f.";
    if (k === "S" || k === "n") return "Link suggestions are for your own text, not Wikipedia's.";
    if (/^[1-5]$/.test(k)) return "Related is listed under your own nodes, not under an article.";
    return null;
  }

  /** The article an aux focus shows, as loaded so far. */
  private auxArticle(a: Aux) {
    if (a.kind !== "wiki") return null;
    const h = this.wikiHost(a.host);
    return h ? wikiArticle(h.title, h.lang) : null;
  }

  /** Keys pressed on an article that was still loading, to be done once it has (Tab, then perhaps Enter). */
  held: { aux: Aux; keys: string[] } | null = null;

  /** Whether a key on the aux focus is to wait for a held Tab. Any other key drops what was held. */
  holdKey(k: string, shift = false): boolean {
    const h = this.held;
    if (!h) return false;
    if ((k === "Enter" || k === "i") && sameAux(h.aux, this.aux)) {
      h.keys.push(k === "Enter" && shift ? "S-Enter" : k);
      return true;
    }
    if (k !== "Tab") this.held = null;
    return false;
  }

  /** The article has arrived (or anything else from Wikipedia did): do the keys that waited for it. */
  private replayHeld() {
    const h = this.held;
    if (!h) return;
    if (!sameAux(h.aux, this.aux)) return void (this.held = null);
    const art = this.auxArticle(h.aux);
    if (art?.state === "loading") return;
    this.held = null;
    if (art?.state !== "ready") return;
    for (const k of h.keys) {
      if (k === "Enter" || k === "S-Enter") this.withReplace(k === "S-Enter", () => (this.inArticleText ? this.enterArticle() : this.auxActivate()));
      else if (k === "i") this.descend();
      else this.auxTab(k === "Tab" ? 1 : -1);
    }
  }

  /** l, Enter: open what an aux row is: a section (as a pane, or in place on the column's page), a sense, a link, a target, a linking node. */
  auxActivate() {
    const a = this.aux;
    if (!a) return;
    const s = this.snap;
    if (a.kind === "target") {
      const r = this.targetOf(a.of);
      return r ? this.follow(r) : undefined;
    }
    if (a.kind === "back") return this.openLinking(this.linkedFrom(a.of)[a.index]);
    const h = this.wikiHost(a.host);
    if (!h) return;
    const link = this.auxLink(a);
    if (link) return this.follow({ kind: "wiki", title: link.title, lang: link.lang });
    const row = a.row;
    if (row.t === "back") return this.openLinking(this.mentionsOf(h.lang, wikiArticle(h.title, h.lang).state === "ready" ? (wikiArticle(h.title, h.lang) as { value: { title: string } }).value.title : h.title)[row.i]);
    if (row.t === "sense") {
      const ss = wikiSenses(h.title, h.lang);
      if (ss.state === "ready" && ss.value[row.i]) this.follow({ kind: "wiki", title: ss.value[row.i].title, lang: h.lang });
      return;
    }
    if (row.t === "head") {
      if (this.folded(h.embedded)) {
        this.expanded.add(h.embedded!);
        return this.emit();
      }
      return this.move(1);
    }
    // A section: in a pane it opens as the next pane (l again steps into it); on the column's page, in place.
    if (h.nested) {
      if (!this.colOpen.has(row.id)) {
        this.colOpen.add(row.id);
        return this.emit();
      }
      return this.move(1);
    }
    const i = this.paneAt;
    const next = this.trail[i + 1];
    if (next?.kind === "wiki" && next.title === h.title && next.sec === row.id) {
      this.paneAt = i + 1;
      return this.setFocus(this.focus, { kind: "wiki", host: `p${i + 1}`, row: { t: "head" } });
    }
    this.openPane(i, { kind: "wiki", title: h.title, lang: h.lang, sec: row.id });
  }

  /** h on an aux row: up to its head, then out of the view, back to where it was opened from. */
  auxLeave() {
    const a = this.aux;
    if (!a) return;
    if (a.kind !== "wiki") return this.setFocus({ node: a.of, grain: "node" });
    const h = this.wikiHost(a.host);
    if (a.row.t !== "head") {
      // On the column's page an open section's subsection steps out to the section first.
      const art = h ? wikiArticle(h.title, h.lang) : null;
      const sec = a.row.t === "sec" && art?.state === "ready" ? art.value.sections.find((x) => x.id === (a.row as { id: number }).id) : undefined;
      const row: WRow = h?.nested && sec?.parent ? { t: "sec", id: sec.parent } : { t: "head" };
      return this.setFocus(this.focus, { ...a, row });
    }
    if (a.host === "col") return this.closeColWiki();
    if (a.host.startsWith("n")) return this.setFocus({ node: a.host.slice(1) as NodeId, grain: "node" });
    // The head of an article pane: back where it was opened from, or to the row it continues.
    const i = +a.host.slice(1);
    const p = this.trail[i];
    if (p?.from && p.from.pane < i) return this.restore(p.from);
    if (i === 0) return;
    this.paneAt = i - 1;
    const q = this.trail[i - 1];
    if (p?.kind === "wiki" && p.sec !== undefined) {
      const host = q.kind === "wiki" ? `p${i - 1}` : `n${q.id}`;
      return this.setFocus(q.kind === "node" ? { node: q.id, grain: "node" } : this.focus, { kind: "wiki", host, row: { t: "sec", id: p.sec } });
    }
    if (q.kind === "node") this.setFocus({ node: q.id, grain: "node" });
    else this.setFocus(this.focus, { kind: "wiki", host: `p${i - 1}`, row: { t: "head" } });
  }

  /** W: the focused article (or the article a focused link names) on Wikipedia itself, in a new tab. */
  openOnWikipedia() {
    const a = this.aux;
    let target: { title: string; lang: string } | null = a ? this.auxLink(a) : null;
    if (!target && a?.kind === "wiki") {
      const h = this.wikiHost(a.host);
      const art = h && wikiArticle(h.title, h.lang);
      if (h) target = { title: art?.state === "ready" ? art.value.title : h.title, lang: h.lang };
    }
    if (!target) {
      const f = this.focus;
      const note = f.grain !== "node" ? this.noteAt(f.range) : undefined;
      const r = this.targetOf(note ?? (a?.kind === "target" ? a.of : f.node));
      if (r?.kind === "wiki") target = { title: r.title, lang: r.lang };
    }
    if (!target) return this.say("No Wikipedia article here.");
    window.open(wikiUrl(target.title, target.lang), "_blank", "noopener,noreferrer");
    this.say(`Opened “${target.title}” on Wikipedia in a new tab.`);
  }

  /** Go to a node that links here: the linked words in their own text (in panes, as the next pane). */
  openLinking(id: NodeId | undefined) {
    const s = this.snap;
    if (!id || !s.nodes[id]) return;
    const owner = ownerSection(s, id);
    const a = s.nodes[id].kind === "note" ? s.nodes[id].anchors[0] : undefined;
    const focus: Focus = a ? { node: s.nodes[id].parent!, grain: "word", range: [a.start, a.end] } : { node: id, grain: "node" };
    if (this.panes) for (const x of ancestors(s, focus.node)) this.open.add(x);
    else this.reveal(focus.node);
    if (this.panes) {
      const from = this.backHere();
      this.paneAt = this.openPane(this.paneAt, { kind: "node", id: owner, from });
    } else this.colWiki = null;
    this.setFocus(focus);
    this.remember(true);
  }

  // ---- linking by hand ----

  /** What a link made now applies to: the selected words (and the note already on them), or the focused node itself. */
  linkSpot(): Picker | null {
    const f = this.focus;
    const s = this.snap;
    const n = s.nodes[f.node];
    if (this.aux || !n) return null;
    if (f.grain !== "node" && f.range) return { node: f.node, range: f.range, existing: this.noteAt(f.range), text: plain(n.body.slice(f.range[0], f.range[1])).trim() };
    return { node: f.node, text: n.title || plain(label(s, f.node)).replace(/^“|”$/g, "") };
  }

  /** w: the link picker, filled in with the selected words. On words that already link somewhere, it retargets them. */
  openPicker() {
    if (!this.writable()) return;
    if (this.aux?.kind === "wiki") return this.say(this.articleRefuses("w", true)!);
    const spot = this.linkSpot();
    if (!spot) return this.say("Select words to link (i, then H L to widen), or press w on a node to give the node itself a target.");
    if (isLibraryRoot(this.snap, spot.node) && !spot.range) return this.say("The library itself has no target.");
    this.picker = spot;
    this.mode = "link";
    this.emit();
  }

  closePicker() {
    this.picker = null;
    this.mode = "normal";
    this.emit();
  }

  /** Give the spot a target: a new link on the words, the existing note on them retargeted, or the node's own target. */
  applyTarget(spot: Picker, ref: Ref) {
    if (!this.writable()) return;
    const s = this.snap;
    if (ref.kind === "node" && ref.id && s.nodes[ref.id]) ref = nodeRef(s, ref.id);
    const what = describeTarget(ref);
    if (spot.range && !spot.existing) {
      this.agentUndo = null;
      const r = applyLinks(this.doc, [{ node: spot.node, range: spot.range, target: ref }], { author: this.user, actor: "human", message: `Link “${clip(spot.text, 40)}” to ${clip(what, 50)}` });
      this.say(r.created.length || r.merged.length ? `Linked to ${what}. Enter opens it; D removes the link.` : "Those words already link there.");
    } else {
      const id = spot.existing ?? spot.node;
      this.apply([{ op: "update", id, ref }], `${spot.existing ? "Retarget" : "Target"} “${clip(spot.text || label(s, id), 40)}”: ${clip(what, 50)}`);
      this.say(`${spot.range ? "Linked" : "This node is about"} ${what}.`);
    }
    this.emit();
  }

  /** /link target: link the selection (or the node) to a target typed in the text form, or to a Wikipedia title. */
  linkTo(text: string) {
    const spot = this.linkSpot();
    if (!spot) return this.say("Select words first (i, then H L), or focus a node.");
    const parsed = parseTargetLoose(text);
    if (typeof parsed === "string") return this.say(parsed);
    let ref: Ref = parsed;
    if (ref.kind === "node") {
      const id = resolveNode(this.snap, ref, docOf(this.snap, spot.node) ?? undefined);
      if (!id) return this.say(`No node at ${text}.`);
      ref = nodeRef(this.snap, id);
    }
    this.applyTarget(spot, ref);
  }

  /** /unlink: a link on the selection goes (for good: its words are declined); a note there, or the node itself, loses its target and keeps its text. */
  unlink() {
    if (!this.writable()) return;
    const spot = this.linkSpot();
    const s = this.snap;
    const id = spot?.range ? spot.existing : spot?.node;
    const n = id ? s.nodes[id] : undefined;
    if (!id || !n?.ref) return this.say("Nothing here links anywhere.");
    // A link on words (or a note that also links) goes for good: its words are declined in the node.
    if (n.kind === "note") return this.removeLink(id);
    this.apply([{ op: "update", id, ref: null }], `Remove the target of “${clip(label(s, id), 40)}”`);
    this.say("Unlinked. u to undo.");
  }

  /** L on a node: open its own target (a section about an article, a note that also links). */
  followOwn() {
    const r = this.targetOf(this.focus.node);
    if (!r) return this.say("This node has no target. w gives it one.");
    this.follow(r);
  }

  setView(view: View) {
    this.settings = { ...this.settings, view };
    this.aux = null;
    this.colWiki = null;
    lsSet("ie:settings", this.settings);
    this.repairView();
    this.say(
      view === "auto" ? `view: auto (${this.panes ? "panes" : "one column"} at this width)`
        : view === "panes" ? "view: panes (v for one column)"
        : "view: one column (v for panes)",
    );
  }
  /** v: switch to whichever layout is not on screen. */
  cycleView() {
    this.setView(this.panes ? "column" : "panes");
  }

  private set(key: "auto" | "speculate" | "curves", on: boolean) {
    this.settings = { ...this.settings, [key]: on };
    lsSet("ie:settings", this.settings);
    this.say(`${key} ${on ? "on" : "off"}`);
  }

  /**
   * Hand an instruction to the editor agent. It edits a fork and merges back. With research (from
   * /research, or a request that plainly asks to look something up or find sources) it may also
   * search the web and read pages first, within the server's caps.
   */
  agent(instruction: string, opts: { research?: boolean } = {}) {
    if (!this.writable()) return;
    if (!this.generating) return this.say("No model configured, so there is no editor to ask.");
    if (opts.research && !instruction.trim()) return this.say("Say what to research: /research <question>. The editor writes what it finds into the focused node.");
    if (opts.research && !this.web.on) return this.say("Web research is off on this server (IE_WEB=off). : on a node still asks the editor, without the web.");
    if (this.agentRun?.running) return this.say("The editor is still working: Esc stops it.");
    const research = (opts.research ?? wantsResearch(instruction)) && this.web.on;
    const focus = this.focus.node;
    const doc = this.doc;
    const ac = new AbortController();
    const run: NonNullable<Store["agentRun"]> = { research, steps: [], running: true, ac };
    this.agentRun = run;
    // The panel lists what it did (searches, pages, edits, refusals); what it says goes to the status line.
    const step = (e: AgentEvent) => {
      if (e.kind !== "say") run.steps.push(e.text);
      this.say(`editor: ${clip(e.text, 120)}`);
    };
    void this.enqueue(research ? "editor researching (Esc stops)" : "editor working", async () => {
      try {
        if (ac.signal.aborted) throw new DOMException("stopped", "AbortError");
        const before = this.commits()[0];
        const result = await runAgent(
          this.llm,
          doc,
          instruction,
          focus,
          step,
          ac.signal,
          {
            suggest: async (fork, id) => {
              const list = await this.links.peek(fork, id);
              return list?.map((x) => ({ quote: x.quote, target: formatTarget(x.target), tier: x.tier, score: x.score, why: x.why })) ?? null;
            },
          },
          { research, limits: { searches: this.web.searches || DEFAULT_LIMITS.searches, fetches: this.web.fetches || DEFAULT_LIMITS.fetches } },
        );
        this.repairView();
        run.summary = result.summary || "done";
        run.sources = result.sources;
        const sources = result.sources.length ? ` · sources: ${result.sources.map((s) => (s.title ? `${clip(s.title, 40)} (${hostOf(s.url)})` : hostOf(s.url))).join(", ")}` : "";
        this.say(`editor: ${clip(run.summary, 160)}${result.commits ? ` (${result.commits} change${result.commits > 1 ? "s" : ""}; u undoes, g reviews)` : ""}${sources}`);
        if (result.commits) {
          this.agentUndo = { commit: before, doc: docOf(doc.snap(), focus) };
          await this.afterMerge(result.report);
        }
      } catch (err) {
        if (!ac.signal.aborted) throw err;
        // Its work was on a fork, which is dropped: nothing it did reaches the document.
        run.summary = "Stopped. Nothing it did was kept.";
        this.say("editor: stopped; nothing it did was kept");
      } finally {
        run.running = false;
        if (!research && this.agentRun === run) this.agentRun = null;
        this.emit();
      }
    });
  }

  /** Esc while the editor works: stop it. On a finished research run's panel: put the panel away. */
  escAgent() {
    const run = this.agentRun;
    if (!run) return;
    if (run.running) {
      run.ac.abort();
      this.say("editor: stopping…");
    } else this.agentRun = null;
    this.emit();
  }

  // ---- link suggestions, and the links list ----

  /** The suggestion the focus is on (its words exactly), if any. */
  focusedSuggestion(): Sugg | undefined {
    const f = this.focus;
    if (this.preview || this.aux || f.grain === "node") return undefined;
    return this.links.at(f.node, f.range, this.snap);
  }

  /** y on a suggestion: link it. */
  acceptSuggestion(sg = this.focusedSuggestion()) {
    if (!sg || !this.writable()) return;
    this.agentUndo = null;
    const made = this.links.accept([sg]);
    this.say(made ? `Linked “${clip(sg.quote, 40)}” to ${clip(describeTarget(sg.target), 50)} · u undoes` : "Those words could not be linked any more.");
  }

  /** n on a suggestion: decline it, remembered in the node (and so on every replica). */
  rejectSuggestion(sg = this.focusedSuggestion()) {
    if (!sg || !this.writable()) return;
    this.agentUndo = null;
    this.links.reject([sg]);
    this.say(`Declined “${clip(sg.quote, 40)}”: it will not be suggested here again · u undoes`);
  }

  /** D on a link (or /unlink): remove it, and decline its words in the node so it is not made again. */
  removeLink(note: NodeId) {
    if (!this.writable()) return;
    this.agentUndo = null;
    const s = this.snap;
    const quote = s.nodes[note]?.parent ? s.nodes[s.nodes[note].parent!].body.slice(s.nodes[note].anchors[0]?.start ?? 0, s.nodes[note].anchors[0]?.end ?? 0) : "";
    const deleted = isLink(s.nodes[note]);
    if (!this.links.removeLink(note)) return this.say("Nothing here links anywhere.");
    if (deleted) this.open.delete(note);
    this.say(`Removed the link on “${clip(quote, 40)}”; it will not be made again here · u undoes`);
  }

  /** S: the links list of the current document (or, on the library, of the focused node). It opens at once; what the server has is fetched fresh behind it. */
  startReview() {
    if (!this.writable()) return;
    const s = this.snap;
    const d = this.currentDoc;
    const ids = d ? [d, ...descendants(s, d)] : [this.focus.node];
    const review = { ids, show: { linked: true, pending: true, rejected: false } as Record<Status, boolean>, key: null as string | null };
    this.review = review;
    this.mode = "review";
    // The first row waiting for a decision, else the first shown.
    const first = () => {
      if (this.review !== review || review.key) return;
      const rows = this.reviewRows();
      review.key = (rows.find((r) => r.status === "pending") ?? rows[0])?.key ?? null;
      if (review.key) this.reviewShow();
    };
    first();
    this.emit();
    if (d) void this.links.loadDoc(d, true).then(() => (first(), this.emit()));
  }

  /** Every row of the links list, whatever the filters. */
  reviewAll(): LinkRow[] {
    const r = this.review;
    return r ? this.links.rows(r.ids, this.snap) : [];
  }

  /** The rows the filters show. */
  reviewRows(): LinkRow[] {
    const r = this.review;
    return r ? this.reviewAll().filter((x) => r.show[x.status]) : [];
  }

  /** The selected row, if it is still shown. */
  reviewRow(): LinkRow | undefined {
    const r = this.review;
    return r ? this.reviewRows().find((x) => x.key === r.key) : undefined;
  }

  /** Select a row (a click on it). */
  reviewSelect(key: string) {
    if (!this.review) return;
    this.review.key = key;
    this.reviewShow();
  }

  /** j k s Tab: move through the shown rows. */
  reviewStep(delta: number) {
    const r = this.review;
    if (!r) return;
    const rows = this.reviewRows();
    if (!rows.length) return this.reviewShow();
    const at = rows.findIndex((x) => x.key === r.key);
    r.key = rows[Math.max(0, Math.min(rows.length - 1, at < 0 ? 0 : at + delta))].key;
    this.reviewShow();
  }

  /** 1 2 3: show or hide the linked, the turned down, the waiting. */
  reviewFilter(status: Status) {
    const r = this.review;
    if (!r) return;
    const keep = this.reviewRow();
    r.show = { ...r.show, [status]: !r.show[status] };
    const rows = this.reviewRows();
    r.key = (keep && r.show[keep.status] ? keep : rows[0])?.key ?? null;
    this.reviewShow();
  }

  /** After a row was decided: it may have left the filter; keep the place in the list. */
  private reviewAfter(before: LinkRow[], key: string | null) {
    const r = this.review;
    if (!r) return;
    const rows = this.reviewRows();
    if (!rows.some((x) => x.key === key)) {
      const at = before.findIndex((x) => x.key === key);
      const next = before.slice(at + 1).find((x) => rows.some((y) => y.key === x.key)) ?? rows[rows.length - 1];
      r.key = next?.key ?? null;
    }
    this.reviewShow(false);
  }

  /** y in the list: link the selected row (waiting, or turned down: a person overrules). */
  reviewAccept() {
    const row = this.reviewRow();
    if (!row || !this.writable()) return;
    if (row.status === "linked") return this.say("That is linked already. n removes it.");
    if (!row.sugg) return this.say(`No target was kept for “${clip(row.quote, 40)}”, declined before targets were kept: Enter goes to it, and w links it by hand.`);
    const before = this.reviewRows();
    this.agentUndo = null;
    const made = this.links.accept([row.sugg], row.status === "rejected");
    this.say(made ? `Linked “${clip(row.quote, 40)}” to ${clip(row.title, 50)}${row.status === "rejected" ? `, over the ${row.by === "reviewer" ? "reviewer's" : "earlier"} no` : ""} · u undoes` : "Those words could not be linked any more.");
    this.reviewAfter(before, row.key);
  }

  /** n (or D) in the list: decline the selected row if it waits; remove its link, for good, if it is linked. */
  reviewReject() {
    const row = this.reviewRow();
    if (!row || !this.writable()) return;
    if (row.status === "rejected") return this.say("That is rejected already. y links it.");
    const before = this.reviewRows();
    this.agentUndo = null;
    if (row.status === "linked" && row.note) this.removeLink(row.note);
    else if (row.sugg) {
      this.links.reject([row.sugg]);
      this.say(`Declined “${clip(row.quote, 40)}”: it will not be suggested here again · u undoes`);
    }
    this.reviewAfter(before, row.key);
  }

  /** Y in the list: link every waiting row it shows, as one commit. */
  reviewAcceptAll() {
    if (!this.review || !this.writable()) return;
    const list = this.reviewRows().flatMap((x) => (x.status === "pending" && x.sugg ? [x.sugg] : []));
    if (!list.length) return this.say("Nothing shown is waiting to be linked.");
    const before = this.reviewRows();
    const key = this.review.key;
    const made = this.links.accept(list);
    this.say(`Linked ${made} phrase${made === 1 ? "" : "s"} · u undoes`);
    this.reviewAfter(before, key);
  }

  /** Enter in the list: put it away and stay at the selected row's words. */
  reviewGo() {
    const row = this.reviewRow();
    this.endReview();
    if (row && !row.range) this.go(row.node, "node");
  }

  /** Focus the selected row's words in the text, and say where the list is. */
  private reviewShow(clear = true) {
    const row = this.reviewRow();
    if (row?.range && this.snap.nodes[row.node]) this.go(row.node, "word", row.range);
    else if (row && this.snap.nodes[row.node]) this.go(row.node, "node");
    // Moving clears what was said; after a decision, what was said stays.
    if (clear) this.status = "";
    this.emit();
  }

  endReview(message = "") {
    this.review = null;
    this.mode = "normal";
    if (message) this.say(message);
    else this.emit();
  }

  /**
   * 1–5: the Related rows of the focused node (numbered on screen). With words selected, link them
   * to that section; on the node itself, go there.
   */
  relatedKey(n: number) {
    const f = this.focus;
    const row = this.relatedOf(f.node)[n - 1];
    const s = this.snap;
    if (!row || !s.nodes[row.node]) return this.say(this.relatedOf(f.node).length ? `There is no Related row ${n}.` : "Nothing is listed as Related to this node.");
    if (f.grain === "node" || !f.range) return this.follow(nodeRef(s, row.node));
    if (!this.writable()) return;
    this.agentUndo = null;
    if (this.links.linkRelated(f.node, f.range, row.node)) this.say(`Linked “${clip(s.nodes[f.node].body.slice(f.range[0], f.range[1]), 40)}” to ${clip(row.title, 50)} · u undoes`);
    else this.say("Those words already carry a link.");
  }

  setAutolink(arg: string) {
    if (!["review", "on", "suggest", "off"].includes(arg)) return this.say(`/autolink review|suggest|on|off (now ${this.settings.autolink}): review has the model judge what is found and links what it approves, suggest leaves all to you, on links the scanner's sure ones unreviewed, off looks for nothing`);
    this.settings = { ...this.settings, autolink: arg as AutoMode };
    lsSet("ie:settings", this.settings);
    lsSet("ie:autolink-chosen", true);
    this.say(
      arg === "review" ? `autolink review: the model judges what is found and links what it approves (u undoes); S lists every decision${this.generating ? "" : " · no model on this server, so for now links are only suggested"}`
        : arg === "on" ? "autolink on: the scanner's sure links are made at once, unreviewed (u undoes); the rest are suggested"
        : arg === "suggest" ? "autolink suggest: links are only suggested; y takes one, S lists them"
        : "autolink off: nothing is scanned automatically",
    );
  }

  /** /colors: where each fork's colour shows in the panes view. */
  setColors(arg: string) {
    const c = COLORS.find((x) => x === arg);
    if (!c) return this.say(`/colors line|top|edge|off (now ${this.settings.colors}): each fork's colour along its curves and title rules, across its panes' tops, down their left edges, or none`);
    this.settings = { ...this.settings, colors: c };
    lsSet("ie:settings", this.settings);
    this.say(c === "off" ? "colors off: forks in plain ink" : `colors ${c}`);
  }

  /** /linkdoc, /linkall: scan in the background on the server; progress shows in the status line. */
  async linkJob(scope: "doc" | "library", doc?: NodeId, quiet = false) {
    const r = await this.links.startJob(scope, doc);
    if (typeof r === "string") return this.say(`Could not start looking for links: ${r}`);
    // Already over (a short job announced its end first): that has been said.
    if (r.state === "running" && (!quiet || r.slow)) this.say(this.jobText(r));
  }

  async cancelLinkJob() {
    const ok = await this.links.cancelJob();
    this.say(ok ? "Stopped looking for links. What was found and reviewed so far is kept: S lists it." : "No link search is running.");
  }

  /** The status line's account of a job; `made`, once it is over, the links the reviewer approved that this page made. */
  jobText(j: JobState, made?: number): string {
    const eta = j.etaSec ? ` · about ${j.etaSec < 90 ? `${j.etaSec} s` : `${Math.round(j.etaSec / 60)} min`} left` : "";
    const slow = j.slow && j.state === "running" ? " · Wikipedia is asked once every 6.5 s without a contact: start the server with IE_WIKI_CONTACT (an email, https:// URL or User:Name) for about 6× faster" : "";
    const r = j.review;
    const fell = r?.fallback ? ` · ${this.links.fallbackText(r.fallback)}: ${r.left} left for you` : "";
    if (j.state === "running") {
      const rev = r ? ` · reviewer ${r.calls}/${r.max} calls, ${r.approved} approved, ${r.rejected} rejected` : "";
      return `looking for links in ${clip(j.title, 40)}: ${j.done}/${j.total}${eta}${rev}${fell} · :/linkcancel stops${slow}`;
    }
    const verdicts = r ? `${made ?? r.approved} linked by the reviewer, ${r.rejected} rejected${r.left ? `, ${r.left} to review` : ""} · ${r.calls} model call${r.calls === 1 ? "" : "s"}${r.fallback ? ` · ${this.links.fallbackText(r.fallback)}` : ""}${made ? " · u undoes" : ""}` : "";
    if (j.state === "done") return `Looked for links in ${clip(j.title, 40)}: ${r ? verdicts : `${j.auto} sure, ${j.suggest} to review`} · S lists them`;
    if (j.state === "cancelled") return `Stopped looking for links in ${clip(j.title, 40)} at ${j.done}/${j.total}${r ? `: ${verdicts}` : "."}`;
    return `Looking for links failed: ${j.message ?? "unknown error"}`;
  }

  /**
   * A job's progress, from the server's notices. When it ends (or is stopped), what it found is
   * fetched; in review mode the links the reviewer approved are made, as one commit by "reviewer";
   * with autolink on, the sure ones, by "linker" (u undoes either).
   */
  jobUpdate(j: JobState) {
    const before = this.links.job;
    this.links.job = j;
    if (j.state === "running") {
      this.status = this.jobText(j);
      return this.emit();
    }
    if (before?.id === j.id && before.state !== "running") return;
    void (async () => {
      const docs = j.doc ? [j.doc] : documents(this.doc.snap());
      const claim = !!j.review && this.links.effective() === "review";
      const got = await Promise.all(docs.map((d) => this.links.loadDoc(d, true, claim)));
      let made: number | undefined;
      if (claim) made = this.links.applyAuto(got.flatMap((g) => g.apply), this.doc, "reviewer").length;
      else if (j.state === "done" && this.settings.autolink === "on") {
        const sure = got.flatMap((g) => g.found).filter((x) => x.tier === "auto" && !x.review && !x.decided);
        if (sure.length) this.links.applyAuto(sure);
      }
      this.say(this.jobText(j, made));
    })();
  }

  /** Wait (a little) until the server has every edit this page made. */
  private async whenSynced(ms = 5000) {
    const until = Date.now() + ms;
    void this.session.sync(this.repo.current);
    while (!this.session.synced() && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  }

  // ---- documents: the menu (m) and what it does ----

  openMenu(prompt?: "new") {
    const items = this.menuItems("");
    const here = this.currentDoc;
    this.menu = { filter: "", selected: items.find((d) => d.node === here)?.node ?? items[0]?.node ?? null, focus: "filter", prompt: null, confirm: null, problems: null };
    this.mode = "docs";
    if (prompt) this.menuPrompt(prompt);
    this.emit();
  }

  closeMenu() {
    this.mode = "normal";
    this.emit();
  }

  /** The menu's rows: the documents matching the filter, in library order. */
  menuItems(filter = this.menu.filter): DocInfo[] {
    const terms = filter.toLowerCase().split(/\s+/).filter(Boolean);
    const rows = listDocs(this.doc.snap());
    return terms.length ? rows.filter((d) => terms.every((t) => `${d.title} ${d.slug} ${d.excerpt}`.toLowerCase().includes(t))) : rows;
  }

  menuSelected(): DocInfo | undefined {
    const items = this.menuItems();
    return items.find((d) => d.node === this.menu.selected) ?? items[0];
  }

  menuMove(delta: number) {
    const items = this.menuItems();
    if (!items.length) return;
    const i = items.findIndex((d) => d.node === this.menuSelected()?.node);
    this.menu.selected = items[Math.max(0, Math.min(items.length - 1, i + delta))].node;
    this.emit();
  }

  menuFilter(text: string) {
    this.menu.filter = text;
    this.menu.selected = this.menuItems()[0]?.node ?? null;
    this.emit();
  }

  /** Ask for a title in the menu: for a new document, or to rename or duplicate the selected one. */
  menuPrompt(kind: "new" | "rename" | "duplicate") {
    const d = this.menuSelected();
    if (kind !== "new" && !d) return;
    this.menu.prompt = { kind, id: d?.node, value: kind === "new" ? "" : kind === "rename" ? d!.title : `${d!.title} (copy)` };
    this.menu.confirm = null;
    this.emit();
  }

  menuSubmit(value: string) {
    const p = this.menu.prompt;
    this.menu.prompt = null;
    this.menu.focus = "list";
    this.emit();
    if (!p) return;
    if (p.kind === "new") this.newDoc(value);
    else if (p.kind === "rename") this.renameDocument(p.id!, value);
    else this.duplicateDocument(p.id!, value);
  }

  /** A document command on the replica on screen: refused while viewing history, reported if refused. */
  private docWrite(fn: () => void) {
    if (!this.writable()) return;
    this.agentUndo = null;
    this.attempt(fn);
  }

  newDoc(title: string) {
    title = title.replace(/\s+/g, " ").trim();
    if (!title) return this.say("A new document needs a title: /new <title>");
    this.docWrite(() => {
      const id = createDoc(this.doc, title, this.user);
      this.openDoc(id, true);
      this.say(`Created “${clip(title, 60)}”: c writes its opening text, a adds a section.`);
    });
  }

  /** Links keep working (they go by node id); on this branch, and u undoes it. */
  renameDocument(id: NodeId, title: string) {
    title = title.replace(/\s+/g, " ").trim();
    if (!title) return this.say("A document needs a title.");
    this.docWrite(() => {
      renameDoc(this.doc, id, title, this.user);
      this.remember();
      this.say(`Renamed to “${clip(title, 60)}”.`);
    });
  }

  /** Save as: a copy of the whole document, placed after it, which then opens. */
  duplicateDocument(id: NodeId, title: string) {
    title = title.replace(/\s+/g, " ").trim();
    if (!title) return this.say("The copy needs a title.");
    this.docWrite(() => {
      const copy = duplicateDoc(this.doc, id, title, this.user);
      this.openDoc(copy, true);
      this.say(`Saved a copy as “${clip(title, 60)}”; this is the copy.`);
    });
  }

  /** Delete (after the menu has asked): an ordinary delete, which u undoes. */
  deleteDocument(id: NodeId) {
    this.menu.confirm = null;
    const s = this.doc.snap();
    const title = s.nodes[id]?.title ?? "";
    this.docWrite(() => {
      const leaving = this.currentDoc === id || (this.hoist && docOf(s, this.hoist) === id);
      deleteDoc(this.doc, id, this.user);
      if (leaving) {
        this.hoist = null;
        this.focus = { node: s.root, grain: "node" };
        this.remember(true);
      }
      this.repairView();
      this.say(`Deleted “${clip(title, 50)}”. u brings it back.`);
    });
  }

  /** Save to a file: the text format, written from this replica, so unsynced edits are included. */
  exportDocument(id: NodeId) {
    const s = this.doc.snap();
    const n = s.nodes[id];
    if (!n) return;
    const { text, skipped } = serializeDoc(s, id);
    const base = slugify(n.title) || "untitled";
    const name = this.repo.current === "main" ? `${base}.md` : `${base}-${this.repo.current.replace(/[^\w-]+/g, "-")}.md`;
    download(name, text);
    const left = [skipped.orphans && `${skipped.orphans} orphaned note${skipped.orphans > 1 ? "s" : ""}`, skipped.inNotes && `${skipped.inNotes} section${skipped.inNotes > 1 ? "s" : ""} inside notes`].filter(Boolean);
    this.say(`Saved “${clip(n.title, 50)}” to ${name}${left.length ? `. Left out: ${left.join(" and ")} (the format has no place for them)` : ""}.`);
  }

  /** Open a file: a file picker, whose choice is imported. */
  pickFile() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".md,.markdown,.txt,text/markdown,text/plain";
    input.style.display = "none";
    input.onchange = () => {
      const file = input.files?.[0];
      input.remove();
      if (file) void this.importFile(file);
    };
    document.body.append(input);
    input.click();
  }

  /** A .md file as a new document at the end of the library. */
  async importFile(file: File) {
    if (file.size > IMPORT_MAX) return this.say(`${file.name} is too large to import (the limit is ${IMPORT_MAX / 1024 / 1024} MB).`);
    if (!this.writable()) return;
    const text = await file.text();
    try {
      const id = importDoc(this.doc, text, file.name, { creator: this.user });
      this.openDoc(id, true);
      this.say(`Imported ${file.name} as “${clip(this.doc.snap().nodes[id].title, 60)}”.`);
      // Imported text is scanned like any other writing: by a background job, once the server has it.
      if (this.settings.autolink !== "off") void this.whenSynced().then(() => this.linkJob("doc", id, true));
    } catch (err) {
      if (!(err instanceof FormatError)) return this.say(`Could not import ${file.name}: ${err instanceof Error ? err.message : err}`);
      if (this.mode !== "docs") this.openMenu();
      this.menu.problems = err.problems;
      this.say(`Could not import ${file.name}: ${err.problems.length} problem${err.problems.length > 1 ? "s" : ""}, listed in the menu.`);
    }
  }

  /** /open name: by slug, then by title (exact, then its start, then anywhere). */
  openByName(name: string) {
    const q = name.trim().toLowerCase();
    if (!q) return this.openMenu();
    const all = this.menuItems("");
    const d =
      all.find((x) => x.slug === q) ?? all.find((x) => x.title.toLowerCase() === q) ?? all.find((x) => x.title.toLowerCase().startsWith(q)) ??
      all.find((x) => `${x.title} ${x.slug}`.toLowerCase().includes(q));
    if (!d) return this.say(`No document matches “${name}”. m lists them.`);
    this.openDoc(d.node, true);
    this.say(`Opened “${clip(d.title, 60)}”.`);
  }

  // ---- history, branches, merge ----

  /** The library's history on this branch, newest first (worked out again only when it has grown). */
  commits(): Commit[] {
    const doc = this.doc;
    const key = JSON.stringify(doc.loro.frontiers());
    if (this.historyCache?.doc !== doc || this.historyCache.key !== key) this.historyCache = { key, doc, commits: history(doc) };
    return this.historyCache.commits;
  }

  /**
   * The documents a commit wrote to, derived from the containers its ops changed (the commit
   * itself does not record them), placed by where those nodes are now. A node deleted since
   * cannot be placed without checking out the past, which costs the size of the library, so a
   * commit that only deleted names no document.
   */
  touchedDocs(c: Commit): NodeId[] {
    const key = `${this.repo.current}:${c.id}`;
    let out = this.touchedCache.get(key);
    if (out) return out;
    const s = this.doc.snap();
    const docs = new Set<NodeId>();
    for (const id of touched(this.doc, c.spans).nodes) {
      const d = s.nodes[id] ? docOf(s, id) : null;
      if (d) docs.add(d);
    }
    out = [...docs];
    this.touchedCache.set(key, out);
    return out;
  }

  /** Items of the history panel, in the order j and k walk them. */
  panel() {
    const here = this.historyFilter ? this.currentDoc : null;
    const s = this.doc.snap();
    const conflicts = this.doc.conflicts().filter((c) => !here || [c.node, c.parent].some((x) => x && s.nodes[x] && docOf(s, x) === here));
    const branches = [...this.repo.branches.keys()];
    const commits = here ? this.commits().filter((c) => this.touchedDocs(c).includes(here)) : this.commits();
    return [
      ...conflicts.map((c) => ({ type: "conflict" as const, conflict: c })),
      ...branches.map((b) => ({ type: "branch" as const, branch: b })),
      ...commits.map((c) => ({ type: "commit" as const, commit: c })),
    ];
  }

  /** f in history: show only what touched the current document, or everything. */
  toggleHistoryFilter() {
    if (!this.historyFilter && !this.currentDoc) return this.say("Open a document first: the filter shows what touched the current one.");
    this.historyFilter = !this.historyFilter;
    this.historyIndex = 0;
    this.emit();
  }

  openHistory() {
    this.mode = "history";
    this.historyIndex = Math.min(this.historyIndex, this.panel().length - 1);
    const firstCommit = this.panel().findIndex((i) => i.type === "commit");
    if (!this.doc.conflicts().some((c) => c.status === "open")) this.historyIndex = Math.max(this.historyIndex, firstCommit);
    this.emit();
  }

  closeHistory() {
    this.mode = "normal";
    if (this.preview) this.setPreview(null);
    this.emit();
  }

  /**
   * Show the library as it was at a commit, read-only. One detached replica is kept and checked
   * out at each commit in turn: stepping through history with j and k moves it a commit at a
   * time, where a fresh checkout would replay the library's whole history at every step. If it
   * does not reproduce the commit's recorded hash (an anchor on text deleted later can resolve
   * differently there), a fresh checkout is shown instead.
   */
  setPreview(commit: Commit | null) {
    if (!commit) this.preview = null;
    else {
      const version = JSON.stringify(this.doc.loro.frontiers());
      if (this.walker?.of !== this.doc || this.walker.version !== version) this.walker = { of: this.doc, version, doc: this.doc.fork() };
      this.walker.doc.loro.checkout(commit.frontiers);
      this.walker.doc.reread();
      const exact = !commit.hash || this.walker.doc.stateHash() === commit.hash;
      this.preview = { commit, doc: exact ? this.walker.doc : at(this.doc, commit) };
    }
    this.repairView();
    this.emit();
  }

  /**
   * r in history: roll the current document back to the commit, leaving the rest of the library
   * as it is. On the library itself, the whole library goes back.
   */
  revert(commit: Commit) {
    this.preview = null;
    const here = this.currentDoc;
    this.attempt(() => {
      if (here) revertDocTo(this.doc, commit, here);
      else revertTo(this.doc, commit);
      this.repairView();
      this.say(here ? `Reverted “${clip(this.snap.nodes[here]?.title ?? "", 40)}” to “${clip(commit.message, 50)}” as a new commit; the rest of the library is unchanged.` : `Reverted the library to “${clip(commit.message, 50)}” as a new commit.`);
    });
    this.repairView();
    this.emit();
  }

  newBranch(name: string, from?: Commit) {
    name = name.trim().replace(/\s+/g, "-");
    if (!name) return this.say("Give the branch a name: /branch <name>");
    try {
      const doc = this.repo.branch(name, from);
      doc.author = this.user;
      this.session.watch(name, doc, true);
      this.switchBranch(name);
    } catch (err) {
      this.say(err instanceof Error ? err.message : String(err));
    }
  }

  switchBranch(name: string) {
    if (!this.repo.branches.has(name)) return this.say(`No branch named ${name}.`);
    this.preview = null;
    this.repo.switch(name);
    lsSet("ie:branch", name);
    this.restoreView();
    // Undo covers everything done on this branch from here on.
    this.undoManager();
    this.remember();
    this.say(`On branch ${name}.`);
    void this.session.sync(name);
  }

  mergeFrom(name: string) {
    if (!this.writable()) return;
    if (name === this.repo.current) return this.say("That is the branch you are on.");
    try {
      const report = this.repo.merge(name);
      this.repairView();
      const n = report.conflicts.length;
      this.say(
        report.kind === "nothing" ? `Already contains ${name}.`
          : report.kind === "forward" ? `Fast-forwarded to ${name}.`
          : n ? `Merged ${name}: ${n} semantic conflict${n > 1 ? "s" : ""} to review.` : `Merged ${name} cleanly.`,
      );
      void this.afterMerge(report);
    } catch (err) {
      this.say(err instanceof Error ? err.message : String(err));
    }
  }

  /** After an explicit merge, let the model propose resolutions and look for contradictions. */
  private async afterMerge(report: MergeReport) {
    if (report.kind !== "merge" || !this.generating || !this.settings.auto) return;
    const doc = this.doc;
    await this.enqueue("checking the merge for conflicts in meaning", async () => {
      const resolved = report.conflicts.length ? await resolveConflicts(this.llm, doc) : 0;
      const found = await scanContradictions(this.llm, doc, report);
      this.say(resolved + found ? `The model resolved ${resolved + found} conflict${resolved + found > 1 ? "s" : ""}. g to review each; any can be overruled.` : "Merge checked: nothing contradicts.");
    });
  }

  resolveAll() {
    if (!this.generating) return this.say("No model configured. Choose a side by hand in the history panel (g).");
    const doc = this.doc;
    void this.enqueue("resolving conflicts", async () => {
      const n = await resolveConflicts(this.llm, doc);
      this.say(n ? `Resolved ${n} conflict${n > 1 ? "s" : ""}. g to review.` : "No open conflicts.");
    });
  }

  settle(id: string, side: "a" | "b" | "merged") {
    const c = this.doc.conflicts().find((x) => x.id === id);
    if (!c) return;
    resolveConflict(this.doc, id, c[side], { by: this.user, rationale: side === "merged" ? "kept the mechanical merge" : "chosen by hand" });
    this.repairView();
  }

  reopen(id: string) {
    reopenConflict(this.doc, id);
    this.repairView();
  }

  /** Sections matching a query, across the whole library, for the jump box. */
  search(q: string): NodeId[] {
    const s = this.snap;
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    const all = Object.values(s.nodes).filter((n) => n.kind === "section" && n.id !== s.root && !inArticles(s, n.id));
    if (!terms.length) return documents(s).slice(0, 12);
    const low = (n: (typeof all)[number]) => {
      let l = lowered.get(n);
      if (!l) lowered.set(n, (l = [n.title.toLowerCase(), n.body.toLowerCase()]));
      return l;
    };
    const score = (n: (typeof all)[number]) => {
      const [title, body] = low(n);
      let total = 0;
      for (const t of terms) {
        if (title.startsWith(t)) total += 4;
        else if (title.includes(t)) total += 3;
        else if (body.includes(t)) total += 1;
        else return 0;
      }
      return total;
    };
    // Between equally good matches, the document the reader is in comes first.
    const here = this.currentDoc;
    const near = (id: NodeId) => (here && docOf(s, id) === here ? 0.5 : 0);
    return all.map((n) => [n.id, score(n)] as const).filter(([, sc]) => sc > 0).map(([id, sc]) => [id, sc + near(id)] as const).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([id]) => id);
  }

  /** Enter in the jump box: a document opens; anything else is gone to, in whichever document it is. */
  jumpTo(id: NodeId) {
    this.mode = "normal";
    this.aux = null;
    this.colWiki = null;
    const s = this.snap;
    if (s.library && s.nodes[id]?.parent === s.root) return this.openDoc(id, true);
    this.reveal(id);
    this.focus = { node: id, grain: "node" };
    this.saveView();
    this.remember(true);
    this.emit();
  }
}

/** Hand the reader a file. */
function download(name: string, text: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

export const store = new Store();
// Exposed for the scripted keyboard run, which reads timings and state from here.
(globalThis as unknown as { __ie: Store }).__ie = store;
