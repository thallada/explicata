/**
 * What the mouse can do, by what it points at: the items of the selection bar, of the ⋯ menus and
 * of the right-click menu, built here and only here so the three never drift apart. Every item
 * that has a key runs by pressing it (press.ts), so it does exactly what the key does; the few that
 * have none run a command of the command bar, or copy. Builders are pure: what they need to know
 * about the target comes in a context, and how to act in `Act`, so they can be tested without a page.
 */
import { press } from "./press";

export interface Item {
  t: "item";
  label: string;
  /** The key it presses (as KeyboardEvent.key), shown beside it. */
  key?: string;
  /** What to show for the key when it is not the key itself (⇧⏎, /research, Ctrl C). */
  keyText?: string;
  /** A quiet second line. */
  sub?: string;
  disabled?: boolean;
  /** A setting or a state that is on (shown with a tick). */
  checked?: boolean;
  /** The label on the selection bar, where it differs. */
  short?: string;
  /** Press the key with Shift (Shift+Enter: open in place). */
  shift?: boolean;
  run: () => void;
}
export interface Choice {
  label: string;
  key?: string;
  on?: boolean;
  run: () => void;
}
export type Entry = Item | { t: "sep" } | { t: "head"; text: string } | { t: "choices"; label: string; options: Choice[] };

/** How items act. The page passes the real thing; the tests a recorder. */
export interface Act {
  press(key: string, shift?: boolean): void;
  /** Run a command of the command bar at once (`/view panes`). */
  command(text: string): void;
  /** Open the command bar with this already typed (`/research `). */
  prompt(prefill: string): void;
  copy(text: string): void;
}

const SEP = { t: "sep" } as const;
/** How the system's copy key is written. */
const COPY = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘C" : "Ctrl C";
const head = (text: string): Entry => ({ t: "head", text });

/** An item that presses its key. */
const key = (act: Act, label: string, k: string, more: Partial<Item> = {}): Item => ({ t: "item", label, key: k, run: () => act.press(k, !!more.shift), ...more });

/** Separators only between groups that have something in them, never two together or at an end. */
export function tidy(es: (Entry | false | null | undefined | "")[]): Entry[] {
  const out: Entry[] = [];
  for (const e of es) {
    if (!e) continue;
    if (e.t === "sep" && (!out.length || out[out.length - 1].t === "sep")) continue;
    out.push(e);
  }
  while (out.length && out[out.length - 1].t === "sep") out.pop();
  return out;
}

const quote = (s: string, n = 60) => {
  const t = s.replace(/\s+/g, " ").trim();
  return `“${t.length > n ? `${t.slice(0, n - 1)}…` : t}”`;
};

// ---- words selected ----

export interface SelCtx {
  /** The words, for Copy and the menu's head. */
  text: string;
  /** In Wikipedia's text: no linking by hand, no Related. */
  article: boolean;
  /** A link on exactly these words: where it goes. */
  link?: "wiki" | "node" | "url";
  /** A note (with text of its own) on exactly these words. */
  note?: boolean;
  /** A suggested link on these words: what it would link to. */
  suggestion?: string;
  /** The node's Related list, numbered 1–5, each with where it is. */
  related?: { title: string; where?: string }[];
  panes: boolean;
}

/** The lenses, as the bar shows them and the menus list them. */
function lenses(act: Act): Item[] {
  return [
    key(act, "Expand", "e", { short: "expand" }),
    key(act, "Define", "d", { short: "define" }),
    key(act, "Why?", "y", { short: "why" }),
    key(act, "An example", "x", { short: "example" }),
    key(act, "An objection", "c", { short: "challenge" }),
    key(act, "Ask your own question…", ":", { short: "ask…" }),
  ];
}

/** The selection bar: the lenses, then linking (not in an article). Its ⋯ opens `selectionEntries`. */
export function barItems(c: SelCtx, act: Act): Item[][] {
  const ls = lenses(act);
  return c.article ? [ls] : [ls, [key(act, "Link to…", "w", { short: "link…" })]];
}

/** Words selected, by a click, a drag or the keys: the bar's ⋯ and the right-click menu. */
export function selectionEntries(c: SelCtx, act: Act): Entry[] {
  const related = c.article ? [] : (c.related ?? []).slice(0, 5);
  return tidy([
    head(quote(c.text)),
    c.text && { t: "item", label: "Copy", keyText: COPY, run: () => act.copy(c.text) },
    SEP,
    c.link && key(act, c.panes ? "Open the link beside" : "Open the link", "Enter"),
    c.link && c.panes && key(act, "Open it in place", "Enter", { keyText: "⇧⏎", shift: true, sub: "instead of the pane there" }),
    c.link === "wiki" && key(act, "Open on wikipedia.org", "W"),
    c.note && key(act, "Open the note", "Enter"),
    c.suggestion && key(act, `Link to ${c.suggestion}`, "y", { sub: "a suggested link" }),
    c.suggestion && key(act, "Decline the suggestion", "n"),
    (c.link || c.note) && !c.article && key(act, c.link ? "Retarget…" : "Link it…", "w"),
    (c.link || c.note) && key(act, c.link && !c.note ? "Remove the link" : "Delete the note", "D", c.link && !c.note ? { sub: "and do not link these words again here" } : {}),
    c.link && c.note && !c.article && { t: "item", label: "Remove the link, keep the note", keyText: "/unlink", run: () => act.command("/unlink") },
    SEP,
    ...lenses(act),
    SEP,
    !c.article && !c.link && !c.note && key(act, "Link to…", "w"),
    related.length > 0 && head("Link to a related section"),
    ...related.map((r, i) => key(act, r.title, String(i + 1), { sub: r.where })),
    SEP,
    { t: "choices", label: "Select", options: [{ label: "less", key: "H", run: () => act.press("H") }, { label: "more", key: "L", run: () => act.press("L") }] },
  ]);
}

// ---- a node: a section's row, a note's box, a pane's head, a page's head ----

export interface NodeCtx {
  title: string;
  /** Its title and text, for Copy. */
  text: string;
  note: boolean;
  /** Its parent changed, or its sections did. */
  stale?: "parent" | "sections";
  locked: boolean;
  /** It has a target of its own (L opens it). */
  target: boolean;
  /** The library itself: nothing around it to add after, move among, copy or delete it from. */
  library: boolean;
  generating: boolean;
}

/**
 * A node's menu, the same for a row, a pane's head and a page's head. What acts on the node and
 * everything under it (move under, copy, export, import under it, find links) acts on the
 * section, so a note's menu leaves it out.
 */
export function nodeEntries(c: NodeCtx, act: Act): Entry[] {
  const fixed = c.library;
  const tree = !c.note;
  return tidy([
    head(c.stale ? `${c.title} · ${c.stale === "parent" ? "its parent changed" : "its sections changed"}` : c.title),
    c.stale && key(act, "Bring it in line", "R", { sub: c.locked ? "locked: the model will not rewrite it" : "the model rewrites it to match", disabled: c.locked || !c.generating }),
    c.stale && key(act, "Accept as it stands", "b"),
    SEP,
    c.text && { t: "item", label: "Copy", keyText: COPY, sub: "its title and text", run: () => act.copy(c.text) },
    SEP,
    key(act, "Write more", "e"),
    key(act, "Edit text", "c"),
    key(act, "Rename", "r"),
    key(act, "Add a section inside", "a"),
    !fixed && !c.note && key(act, "Add a section after", "A"),
    SEP,
    key(act, "Ask the editor…", ":"),
    c.generating && { t: "item", label: "Research on the web…", keyText: "/research", run: () => act.prompt("/research ") },
    key(act, c.note ? "Link this note to…" : "Link this section to…", "w"),
    c.target && key(act, "Open its target", "L"),
    SEP,
    !fixed && { t: "choices", label: "Move", options: [{ label: "up", key: "K", run: () => act.press("K") }, { label: "down", key: "J", run: () => act.press("J") }, { label: "in", key: ">", run: () => act.press(">") }, { label: "out", key: "<", run: () => act.press("<") }] },
    !fixed && tree && key(act, "Move under…", "M", { sub: "any node in the library, with all under it" }),
    c.note && key(act, "Change its form", "f", { sub: "inline · margin · inset" }),
    key(act, "Open everything below", "o"),
    key(act, "Collapse everything", "O"),
    !fixed && key(act, "Lock", "p", { checked: c.locked, sub: "the model will not rewrite it" }),
    !c.library && key(act, "Show only this", "z", { sub: "hoist it: h or Esc at its top steps out" }),
    SEP,
    tree && { t: "item", label: "Find links here", keyText: "/linkhere", sub: "in it and everything under it", run: () => act.command("/linkhere") },
    tree && !fixed && { t: "item", label: "Save a copy", keyText: "/duplicate", sub: "just after it", run: () => act.command("/duplicate") },
    tree && { t: "item", label: "Export as .md", keyText: "/export", run: () => act.command("/export") },
    tree && { t: "item", label: "Import a .md file into it…", keyText: "/import", run: () => act.command("/import") },
    SEP,
    !fixed && key(act, "Delete", "D", { sub: "u undoes" }),
  ]);
}

// ---- a pane ----

export interface PaneCtx {
  /** A node's pane: its node; none for an article's. */
  node?: NodeCtx;
  /** An article's pane: its title. */
  article?: string;
  pinned: boolean;
}

export function paneEntries(c: PaneCtx, act: Act): Entry[] {
  const own = c.node ? nodeEntries(c.node, act) : [head(c.article ?? "Wikipedia"), key(act, "Open on wikipedia.org", "W")];
  return tidy([
    ...own,
    SEP,
    {
      t: "choices",
      label: "Go to the pane",
      options: [
        { label: "left", key: "A-h", run: () => act.press("A-h") },
        { label: "right", key: "A-l", run: () => act.press("A-l") },
        { label: "above", key: "A-k", run: () => act.press("A-k") },
        { label: "below", key: "A-j", run: () => act.press("A-j") },
      ],
    },
    key(act, "Pin this pane", "P", { checked: c.pinned, sub: "it stays when what opened it closes" }),
    key(act, "Close this pane", "q", { sub: "with what was opened from it" }),
    key(act, "Show as one column", "v"),
  ]);
}

/** A row of an article (a section, a sense): open it. */
export function articleRowEntries(title: string, panes: boolean, act: Act): Entry[] {
  return tidy([
    head(title),
    key(act, panes ? "Open beside" : "Open", "Enter"),
    panes && key(act, "Open in place", "Enter", { keyText: "⇧⏎", shift: true, sub: "instead of the pane there" }),
    key(act, "Open on wikipedia.org", "W"),
  ]);
}

// ---- the top bar's menu ----

export interface TopCtx {
  view: "auto" | "column" | "panes";
  autolink: "review" | "suggest" | "on" | "off";
  auto: boolean;
  speculate: boolean;
  curves: boolean;
  /** Where each fork's colour shows in the panes view (`/colors`). */
  colors: "line" | "top" | "edge" | "off";
  panes: boolean;
  canRedo: boolean;
}

export function topEntries(c: TopCtx, act: Act): Entry[] {
  const view = (v: TopCtx["view"]): Choice => ({ label: v, on: c.view === v, run: () => act.command(`/view ${v}`) });
  const auto = (v: TopCtx["autolink"], label: string): Choice => ({ label, on: c.autolink === v, run: () => act.command(`/autolink ${v}`) });
  const setting = (label: string, name: string, on: boolean, sub?: string): Item => ({ t: "item", label, sub, keyText: `/${name}`, checked: on, run: () => act.command(`/${name} ${on ? "off" : "on"}`) });
  return tidy([
    key(act, "Jump to a section…", "/"),
    key(act, "History and branches", "g"),
    SEP,
    key(act, "Undo", "u"),
    key(act, "Redo", "U", { disabled: !c.canRedo }),
    SEP,
    key(act, "Links found: review and reverse", "S", { sub: "in the node you are on and under it; on the root, the library" }),
    { t: "item", label: "Find links in the whole library", keyText: "/linkall", run: () => act.command("/linkall") },
    { t: "item", label: "Find links here", keyText: "/linkhere", sub: "in the node you are on and everything under it", run: () => act.command("/linkhere") },
    SEP,
    { t: "choices", label: "Layout", options: [view("auto"), view("column"), view("panes")] },
    { t: "choices", label: "Links found", options: [auto("review", "review"), auto("suggest", "suggest"), auto("on", "link sure"), auto("off", "off")] },
    setting("Reconcile after edits", "auto", c.auto),
    setting("Write ahead while reading", "speculate", c.speculate),
    c.panes && setting("Curves between panes", "curves", c.curves),
    c.panes && { t: "choices", label: "Fork colours", options: (["line", "top", "edge", "off"] as const).map((v): Choice => ({ label: v, on: c.colors === v, run: () => act.command(`/colors ${v}`) })) },
    SEP,
    key(act, "Command line…", ":"),
    key(act, "Keys and help", "?"),
  ]);
}

/** The page's own `Act`: keys through the key handler, commands through the command bar's handler. */
export function pageAct(hooks: { command(text: string): void; prompt(prefill: string): void }): Act {
  return {
    press,
    command: hooks.command,
    prompt: hooks.prompt,
    copy(text) {
      if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
      else fallbackCopy(text);
    },
  };
}

function fallbackCopy(text: string) {
  const t = document.createElement("textarea");
  t.value = text;
  t.style.position = "fixed";
  t.style.opacity = "0";
  document.body.appendChild(t);
  t.select();
  try {
    document.execCommand("copy");
  } finally {
    t.remove();
  }
}
