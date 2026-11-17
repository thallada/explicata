/**
 * The mouse and touch: the one menu (a popover, or a sheet from the bottom on touch), the
 * selection bar over words a click or a drag selected, key hints that are buttons, and the line a
 * newcomer sees once. What each offers is built in actions.ts from what is focused, and every item
 * acts by pressing its key (press.ts), so the keyboard and the mouse cannot disagree.
 *
 * A right-click or a ⋯ first focuses what it is on, as a click would (without opening or toggling
 * anything), then shows the menu for what is focused.
 */
import { Fragment, type ComponentChildren } from "preact";
import { createPortal } from "preact/compat";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { isLibraryRoot, label, staleness, topOf, type NodeId } from "../core/model";
import { plain } from "../core/text";
import { articleRowEntries, barItems, nodeEntries, paneEntries, selectionEntries, type Act, type Entry, type Item, type NodeCtx, type SelCtx } from "./actions";
import { press } from "./press";
import { store, type WRow } from "./store";

// ---- where a pointer is, in the text ----

/** The offset in its text of a DOM position inside a piece marked with data-o. */
export function locateIn(node: Node, offset: number): number | null {
  const el = node instanceof Element ? node : node.parentElement;
  const piece = el?.closest<HTMLElement>("[data-o]");
  return piece ? Number(piece.dataset.o) + (node instanceof Text ? offset : 0) : null;
}

/** Map a DOM position inside a body to (node, offset). */
export function locate(node: Node | null, offset: number): { id: NodeId; at: number } | null {
  const el = node instanceof Element ? node : node?.parentElement;
  const piece = el?.closest<HTMLElement>("[data-o]");
  const body = el?.closest<HTMLElement>("[data-body]");
  if (!piece || !body) return null;
  return { id: body.dataset.body as NodeId, at: Number(piece.dataset.o) + (node instanceof Text ? offset : 0) };
}

/** Words dragged over inside one body, as its node and the range. */
export function dragged(sel: Selection | null): { id: NodeId; range: [number, number] } | null {
  if (!sel || sel.isCollapsed) return null;
  const a = locate(sel.anchorNode, sel.anchorOffset);
  const b = locate(sel.focusNode, sel.focusOffset);
  return a && b && a.id === b.id && a.at !== b.at ? { id: a.id, range: [Math.min(a.at, b.at), Math.max(a.at, b.at)] } : null;
}

/**
 * The pane a pointer is in (else the active one), and the article host it is in: an article pane
 * off the branch is named by its place in the tree; on the branch, by its column.
 */
export function pointedPane(target: HTMLElement) {
  const paneEl = target.closest<HTMLElement>("[data-pane-index]");
  const paneIndex = paneEl ? Number(paneEl.dataset.paneIndex) : store.paneAt;
  const tid = paneEl ? Number(paneEl.dataset.tid) : undefined;
  const named = target.closest<HTMLElement>("[data-host]")?.dataset.host;
  return { paneEl, paneIndex, tid, host: named?.startsWith("f") ? `p${paneIndex}` : named };
}

/** The row of an article's text an element is in: its head or a section. */
export const wtextRow = (wtext: HTMLElement) => (wtext.dataset.wtext === "head" ? { t: "head" } : { t: "sec", id: Number(wtext.dataset.wtext) }) as WRow;

/** The text position under a point. */
function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const d = document as Document & { caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null; caretRangeFromPoint?(x: number, y: number): Range | null };
  if (d.caretPositionFromPoint) {
    const p = d.caretPositionFromPoint(x, y);
    return p && { node: p.offsetNode, offset: p.offset };
  }
  const r = d.caretRangeFromPoint?.(x, y);
  return r ? { node: r.startContainer, offset: r.startOffset } : null;
}

/** On a touch screen (no hover): the bar docks at the foot and menus are sheets. */
export const touch = () => typeof matchMedia === "function" && matchMedia("(hover: none)").matches;

// ---- acting ----

let promptHook: (prefill: string) => void = () => {};
/** The page's command bar, to open with text already typed (App.tsx). */
export const setPrompt = (fn: (prefill: string) => void) => (promptHook = fn);
let cardHook: (note: NodeId) => ComponentChildren = () => null;
/** What a link's card is drawn with, above a menu on touch (App.tsx: the hover preview's body). */
export const setCard = (fn: (note: NodeId) => ComponentChildren) => (cardHook = fn);
/** The page's own `Act`: keys through the key handler, commands through the command bar's handler. */
export const act: Act = {
  press,
  command: (t) => store.command(t),
  prompt: (p) => promptHook(p),
  copy(text) {
    if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    else fallbackCopy(text);
  },
};

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

// ---- what is focused, for the menus ----

function nodeCtx(id: NodeId): NodeCtx {
  const s = store.snap;
  const n = s.nodes[id];
  const st = staleness(s, id);
  return {
    title: label(s, id),
    text: [n.title, plain(n.body)].filter((x) => x.trim()).join("\n\n"),
    note: n.kind === "note",
    stale: st.down ? "parent" : st.up ? "sections" : undefined,
    locked: n.pinned,
    target: !!store.targetOf(id),
    library: isLibraryRoot(s, id),
    generating: store.generating,
  };
}

function selCtx(): SelCtx {
  const text = plain(store.selectedText() ?? "");
  const s = store.snap;
  const a = store.aux;
  if (a?.kind === "wiki") return { text, article: true, link: store.auxLink(a) ? "wiki" : undefined, note: !!store.articleNoteHere(), panes: store.panes, pages: store.pages };
  const f = store.focus;
  const id = store.noteAt(f.range);
  const r = id ? store.targetOf(id) : undefined;
  return {
    text,
    article: false,
    link: r?.kind,
    note: !!id && !!s.nodes[id].body.trim(),
    suggestion: store.focusedSuggestion()?.title,
    related: store.relatedOf(f.node).map((x) => {
      const t = s.nodes[x.node] ? topOf(s, x.node) : null;
      return { title: x.title, where: t && t !== x.node ? s.nodes[t].title : undefined };
    }),
    panes: store.panes,
    pages: store.pages,
  };
}

/** Which menu a place asks for: what is focused there, or the pane it is in. */
type Where = "auto" | "pane";

/** The menu for what is focused now. */
function menuHere(where: Where): Entry[] {
  if (store.mode !== "normal") return [];
  if (store.selectedText() !== null) return selectionEntries(selCtx(), act);
  const a = store.aux;
  const pinned = !!store.branchNodes[store.paneAt]?.pinned;
  const moves = store.paneMoves();
  if (a?.kind === "wiki") {
    const h = store.wikiHost(a.host);
    if (store.panes && (where === "pane" || a.row.t === "head")) return paneEntries(a.host.startsWith("n") ? { node: nodeCtx(a.host.slice(1) as NodeId), pinned, ...moves } : { article: h?.title, pinned, ...moves }, act);
    if (a.row.t === "sec" || a.row.t === "sense") return articleRowEntries(h?.title ?? "Wikipedia", store.panes, act, store.pages);
    return [];
  }
  if (a) return [];
  const id = store.focus.node;
  if (!store.snap.nodes[id]) return [];
  if (where === "pane" && store.panes) return paneEntries({ node: nodeCtx(id), pinned, ...moves }, act);
  return nodeEntries(nodeCtx(id), act);
}

/**
 * Focus what a right-click or a ⋯ is on, as a click would but opening nothing: the words under it
 * (the selection if it is in it, the words dragged over, a link's or a note's words, else the
 * sentence), a row, a note's box, a pane's head or the pane, an article's row or text. Returns
 * which menu to show, or null where the browser's own menu belongs.
 */
function focusAt(target: HTMLElement, x: number, y: number): Where | null {
  if (store.mode !== "normal") return null;
  const more = !!target.closest("[data-more]");
  const { paneEl, paneIndex, tid, host } = pointedPane(target);
  const intoPane = () => {
    if (!paneEl) return;
    if (tid !== undefined && store.branchNodes[paneIndex]?.id !== tid) store.enterFork(tid);
    store.paneAt = paneIndex;
  };
  if (!more) {
    // In the selection: keep it.
    if (target.closest(".sel") && store.selectedText() !== null) return "auto";
    // Words dragged over, not yet taken (a long press on a touch screen selects a word this way).
    const sel = window.getSelection();
    const d = dragged(sel);
    if (d) {
      intoPane();
      store.go(d.id, "word", d.range);
      sel!.removeAllRanges();
      return "auto";
    }
    // An article's text: the sentence there.
    const wtext = target.closest<HTMLElement>("[data-wtext]");
    if (host && wtext && !target.closest("[data-node]")) {
      const row = wtextRow(wtext);
      const at = caretAt(x, y);
      const o = at && wtext.contains(at.node) ? locateIn(at.node, at.offset) : null;
      if (o === null) return null;
      intoPane();
      store.selectInArticle(host, row, [o, o], "sentence");
      return "auto";
    }
    const wrow = target.closest<HTMLElement>("[data-wrow]");
    if (host && wrow) {
      intoPane();
      store.setFocus(store.focus, { kind: "wiki", host, row: { t: "sec", id: Number(wrow.dataset.wrow) } });
      return "auto";
    }
    // A link's or a note's words.
    const anchor = target.closest<HTMLElement>("[data-note]");
    const n = anchor?.dataset.note ? store.snap.nodes[anchor.dataset.note as NodeId] : undefined;
    if (n?.parent && n.anchors[0] && !anchor!.closest("[data-wtext]")) {
      intoPane();
      store.go(n.parent, "word", [n.anchors[0].start, n.anchors[0].end]);
      return "auto";
    }
    // A node's text: the sentence there.
    if (target.closest("[data-body]")) {
      const at = caretAt(x, y);
      const p = at && locate(at.node, at.offset);
      const hit = p && store.sentenceAt(p.id, p.at);
      if (p && hit) {
        intoPane();
        store.go(p.id, "sentence", hit);
        return "auto";
      }
    }
  }
  const row = target.closest<HTMLElement>("[data-row]");
  if (row) {
    intoPane();
    store.go(row.dataset.row as NodeId);
    return row.closest(".top") && paneEl ? "pane" : "auto";
  }
  if (host && target.closest(".wiki-head")) {
    intoPane();
    store.setFocus(store.focus, { kind: "wiki", host, row: { t: "head" } });
    return "pane";
  }
  const node = target.closest<HTMLElement>("[data-node]");
  if (node?.dataset.node && store.snap.nodes[node.dataset.node as NodeId]) {
    intoPane();
    store.go(node.dataset.node as NodeId);
    return node.matches(".pane-head") || (paneEl && node.matches(".top")) ? "pane" : "auto";
  }
  if (paneEl && (more || target.closest(".pane-scroll, .pane-ctl"))) {
    intoPane();
    if (paneEl.classList.contains("wiki-pane")) store.setFocus(store.focus, { kind: "wiki", host: `p${paneIndex}`, row: { t: "head" } });
    else if (store.snap.nodes[paneEl.dataset.pane as NodeId]) store.go(paneEl.dataset.pane as NodeId);
    return "pane";
  }
  return null;
}

/** A right-click or a ⋯: focus what it is on, and show its menu. Returns whether it did (else the browser's menu shows). */
export function menuAt(target: HTMLElement, at: { x: number; y: number } | HTMLElement): boolean {
  const p = at instanceof HTMLElement ? at.getBoundingClientRect() : null;
  const where = focusAt(target, p ? p.left + p.width / 2 : (at as { x: number }).x, p ? p.top + p.height / 2 : (at as { y: number }).y);
  if (!where) return false;
  const entries = menuHere(where);
  if (!entries.length) return false;
  // On touch there is no hover to preview a link: a long press on one shows what it opens above its menu.
  const note = touch() && !store.aux && store.selectedText() !== null ? store.noteAt(store.focus.range) : undefined;
  showMenu(entries, at, note && store.snap.nodes[note]?.ref ? note : undefined);
  return true;
}

// ---- the one menu ----

interface Shown {
  entries: Entry[];
  at: { x: number; y: number } | HTMLElement;
  /** A link whose card shows above the items (a long press on it, on touch). */
  card?: NodeId;
  /** Where the focus was, to go back to when the menu closes. */
  restore: HTMLElement | null;
}
let shown: Shown | null = null;
const watchers = new Set<() => void>();
const changed = () => watchers.forEach((f) => f());

/** The button whose menu a press on it just closed: the click that follows that press is not one to open it again. */
let closedBy: { el: HTMLElement; at: number } | null = null;

export function showMenu(entries: Entry[], at: Shown["at"], card?: NodeId) {
  if (at instanceof HTMLElement && closedBy?.el === at && performance.now() - closedBy.at < 1000) return void (closedBy = null);
  closedBy = null;
  if (shown?.at instanceof HTMLElement) shown.at.removeAttribute("aria-expanded");
  const active = document.activeElement as HTMLElement | null;
  shown = { entries, at, card, restore: active && active !== document.body && !active.closest(".menu") ? active : shown?.restore ?? null };
  if (at instanceof HTMLElement) at.setAttribute("aria-expanded", "true");
  changed();
}

export function closeMenu(refocus = true) {
  if (!shown) return;
  const was = shown;
  shown = null;
  if (was.at instanceof HTMLElement) was.at.removeAttribute("aria-expanded");
  changed();
  if (refocus && was.restore?.isConnected) was.restore.focus({ preventScroll: true });
  else if (document.activeElement?.closest(".menu")) (document.activeElement as HTMLElement).blur();
}


const KEY_TEXT: Record<string, string> = { Enter: "⏎", Escape: "Esc" };
/** How a key is written beside what it does. */
const keyText = (k: string) => KEY_TEXT[k] ?? (k.startsWith("A-") ? `Alt+${k.slice(2)}` : k);

/**
 * A menu: a small list of text, every item with its key. A popover by the pointer or the button it
 * hangs from; on touch, a sheet from the foot of the screen. ↑ ↓ (and Home End) move, Enter runs,
 * Esc closes and puts the focus back where it was; a press outside closes it too.
 */
function Menu({ entries, at, sheet, card, onClose }: { entries: Entry[]; at: Shown["at"]; sheet: boolean; card?: NodeId; onClose: (refocus: boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current!;
    if (!sheet) {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const foot = window.innerHeight - 28;
      // Below what it hangs from, or above where only that fits; where neither does, as low as it fits.
      const r = at instanceof HTMLElement ? at.getBoundingClientRect() : { left: at.x, right: at.x, top: at.y, bottom: at.y };
      const gap = at instanceof HTMLElement ? 4 : 0;
      const left = at instanceof HTMLElement ? r.right - w : r.left;
      const top = r.bottom + gap + h <= foot ? r.bottom + gap : r.top - gap - h >= 8 ? r.top - gap - h : foot - h;
      el.style.left = `${Math.round(Math.max(8, Math.min(window.innerWidth - w - 8, left)))}px`;
      el.style.top = `${Math.round(Math.max(8, Math.min(foot - h, top)))}px`;
    }
    el.focus({ preventScroll: true });
  }, [entries, at, sheet]);
  // Registered as it is drawn (an effect after paint can come late, and a press outside would be missed).
  useLayoutEffect(() => {
    const outside = (e: Event) => {
      if (ref.current?.contains(e.target as Node)) return;
      // A press on the button the menu hangs from closes it, and the click after it does not open it again.
      if (at instanceof HTMLElement && at.contains(e.target as Node) && e.type === "pointerdown") closedBy = { el: at, at: performance.now() };
      onClose(false);
    };
    // A scroll closes it too, but not the one that brought what it is about into view as it opened.
    const opened = performance.now();
    const scrolled = (e: Event) => performance.now() - opened > 250 && outside(e);
    const away = () => onClose(false);
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("scroll", scrolled, true);
    window.addEventListener("resize", away);
    window.addEventListener("blur", away);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("resize", away);
      window.removeEventListener("blur", away);
    };
  }, [onClose, at]);
  const cells = () => [...ref.current!.querySelectorAll<HTMLElement>("[data-mi]:not([aria-disabled='true'])")];
  const onKey = (e: KeyboardEvent) => {
    // The menu has the keys while it is open: none reach the page's handler.
    e.stopPropagation();
    const all = cells();
    const i = all.indexOf(document.activeElement as HTMLElement);
    const go = (j: number) => (e.preventDefault(), all[(j + all.length) % all.length]?.focus());
    if (e.key === "Escape" || e.key === "Tab") return e.preventDefault(), onClose(true);
    if (e.key === "ArrowDown" || (e.key === "ArrowRight" && i >= 0 && all[i].closest(".choices"))) return go(i + 1);
    if (e.key === "ArrowUp" || (e.key === "ArrowLeft" && i >= 0 && all[i].closest(".choices"))) return go(i < 0 ? -1 : i - 1);
    if (e.key === "Home") return go(0);
    if (e.key === "End") return go(-1);
    if ((e.key === "Enter" || e.key === " ") && i < 0) e.preventDefault();
  };
  const run = (it: { disabled?: boolean; run: () => void }) => (e: MouseEvent) => {
    e.stopPropagation();
    if (it.disabled) return;
    onClose(true);
    it.run();
  };
  return (
    <div class={`menu${sheet ? " sheet" : ""}`} role="menu" tabIndex={-1} ref={ref} onKeyDown={onKey} onContextMenu={(e) => e.preventDefault()} onMouseDown={(e) => e.preventDefault()}>
      {card && store.snap.nodes[card] && <div class="menu-card">{cardHook(card)}</div>}
      {entries.map((x, i) => {
        if (x.t === "sep") return <div key={i} class="sep" role="separator" />;
        if (x.t === "head") return <div key={i} class="mh">{x.text}</div>;
        if (x.t === "choices")
          return (
            <div key={i} class="choices" role="group" aria-label={x.label}>
              <span class="lbl">{x.label}</span>
              {x.options.map((o) => (
                <button key={o.label} type="button" data-mi role="menuitemradio" aria-checked={o.on ?? false} class={o.on ? "on" : undefined} tabIndex={-1} title={o.key ? `${o.label} (${o.key})` : undefined} onClick={run(o)}>
                  {o.label}
                  {o.key && <span class="k">{keyText(o.key)}</span>}
                </button>
              ))}
            </div>
          );
        return <MenuItem key={i} it={x} onClick={run(x)} />;
      })}
    </div>
  );
}

function MenuItem({ it, onClick }: { it: Item; onClick: (e: MouseEvent) => void }) {
  const k = it.keyText ?? (it.key ? keyText(it.key) : "");
  return (
    <button type="button" class="mi" data-mi role={it.checked !== undefined ? "menuitemcheckbox" : "menuitem"} aria-checked={it.checked} aria-disabled={it.disabled || undefined} tabIndex={-1} onClick={onClick} data-key={it.key}>
      {it.checked !== undefined && <span class="chk">{it.checked ? "✓" : ""}</span>}
      <span class="lbl">{it.label}</span>
      {it.sub && <span class="sub">{it.sub}</span>}
      {k && <span class="k">{k}</span>}
    </button>
  );
}

/** Where the open menu is drawn (App.tsx). */
export function MenuHost() {
  const [, tick] = useState(0);
  useEffect(() => {
    const f = () => tick((x) => x + 1);
    watchers.add(f);
    return () => void watchers.delete(f);
  }, []);
  if (!shown) return null;
  return <Menu entries={shown.entries} at={shown.at} sheet={touch()} card={shown.card} onClose={closeMenu} />;
}

// ---- the selection bar ----

/** The focus the bar was shown for: it shows while the focus is still that, and goes when anything else is focused. */
let barFor: string | null = null;
const focusKey = () => JSON.stringify([store.focus, store.aux, store.paneAt]);
/** A click or a drag has just selected words: show the bar by them (and the status line's hints for them, not an old message). */
export const showBar = () => {
  barFor = focusKey();
  store.status = "";
};
export const hideBar = () => void (barFor = null);

/** Put the bar over the selection's first line (under its last, where there is no room above), centred on it. */
function placeBar(el: HTMLElement | null, shown = false) {
  if (!el) return;
  const sels = [...document.querySelectorAll<HTMLElement>(".sel")].filter((x) => x.offsetParent);
  if (el.classList.contains("docked")) {
    // Docked at the foot: the words it is about are not left under it.
    const r = sels[0]?.getBoundingClientRect();
    const top = el.getBoundingClientRect().top;
    if (shown && r && r.bottom > top - 8) (sels[0].closest(".pane-scroll") ?? document.scrollingElement)?.scrollBy({ top: r.bottom - top + 48 });
    return;
  }
  if (!sels.length) return void (el.style.visibility = "hidden");
  const rects = sels.flatMap((s) => [...s.getClientRects()]).filter((r) => r.width);
  if (!rects.length) return void (el.style.visibility = "hidden");
  const first = rects[0];
  const last = rects[rects.length - 1];
  const left = Math.min(...rects.map((r) => r.left));
  const right = Math.max(...rects.map((r) => r.right));
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const bar = document.querySelector(".docbar")?.getBoundingClientRect().bottom ?? 0;
  // In the panes view it is set in its pane (so whatever covers the pane covers it), placed from the pane's box.
  const pane = el.parentElement?.classList.contains("pane") ? el.parentElement : null;
  const host = pane ? pane.getBoundingClientRect() : null;
  // The room it has: below the top bar, and in a pane below its tab when the tab shows (folded, or scrolled past its title) and above what covers its foot.
  const tabbed = pane && (pane.hasAttribute("data-scrolled") || pane.hasAttribute("data-covered"));
  const roof = Math.max(bar, host ? host.top + (tabbed ? (pane.querySelector<HTMLElement>(":scope > .tabline")?.offsetHeight ?? 30) : 0) : 0) + 4;
  const next = pane?.parentElement?.classList.contains("crowded") ? (pane.nextElementSibling as HTMLElement | null)?.getBoundingClientRect().top : undefined;
  const floor = Math.min(window.innerHeight - 28, host?.bottom ?? Infinity, next ?? Infinity) - 4;
  // Over the words if it fits there, else under them; never on them.
  const above = first.top - 9 - roof;
  const under = floor - (last.bottom + 9);
  const below = above < h && (under >= h || under > above);
  const top = below ? last.bottom + 9 : first.top - h - 9;
  const mid = (left + right) / 2;
  const x = Math.round(Math.max((host?.left ?? 0) + 8, Math.min((host?.right ?? window.innerWidth) - w - 8, mid - w / 2)));
  el.classList.toggle("below", below);
  el.style.left = `${x - (host?.left ?? 0)}px`;
  el.style.top = `${Math.round(top - (host?.top ?? 0))}px`;
  el.style.setProperty("--tick", `${Math.round(Math.max(10, Math.min(w - 10, mid - x)))}px`);
  // Scrolled out of its pane or the window: out of sight with it.
  const clip = sels[0].closest(".pane-scroll")?.getBoundingClientRect();
  const gone = top < bar || top + h > window.innerHeight - 28 || (clip && (last.bottom < clip.top || first.top > clip.bottom));
  el.style.visibility = gone ? "hidden" : "visible";
  // The curves leave its place clear (Panes.tsx): they are drawn again for where it is now.
  if (pane) window.dispatchEvent(new Event("ie:geometry"));
}

/**
 * The selection bar: shown by words a click (a sentence) or a drag (the words dragged over)
 * selected, in a node's text or an article's; each item shows its key quietly, so it teaches the
 * keys. On touch it is docked at the foot of the screen, with a way to put it away.
 */
export function SelBar() {
  const ref = useRef<HTMLDivElement>(null);
  const on = barFor !== null && store.mode === "normal" && barFor === focusKey() && store.selectedText() !== null;
  const docked = touch();
  const was = useRef(false);
  /** Docked, the actions are one row that scrolls sideways, its ⋯ and × kept at its end: which ends have more beyond them (a fade says so). */
  const acts = useRef<HTMLDivElement>(null);
  const edges = () => {
    const a = acts.current;
    if (!a) return;
    const more = a.scrollWidth - a.clientWidth > 1;
    a.toggleAttribute("data-before", more && a.scrollLeft > 1);
    a.toggleAttribute("data-after", more && a.scrollLeft < a.scrollWidth - a.clientWidth - 1);
  };
  useLayoutEffect(() => {
    if (on) placeBar(ref.current, !was.current);
    if (on && docked) {
      // A new selection starts the row from its first action.
      if (!was.current && acts.current) acts.current.scrollLeft = 0;
      edges();
    }
    was.current = on;
  });
  useLayoutEffect(() => {
    let frame = 0;
    const again = () => {
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          placeBar(ref.current);
        });
    };
    document.addEventListener("scroll", again, true);
    window.addEventListener("resize", again);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("scroll", again, true);
      window.removeEventListener("resize", again);
    };
  }, []);
  if (!on) return null;
  const c = selCtx();
  const groups = barItems(c, act);
  // In the panes view, inside the pane holding the selection: covered with it by what covers it.
  const host = store.panes && !docked ? document.querySelector<HTMLElement>(`.strip .pane[data-tid="${store.branchNodes[store.paneAt]?.id}"]`) : null;
  const go = (it: Item) => () => {
    hideBar();
    it.run();
  };
  const bar = (
    <div class={`selbar${docked ? " docked" : ""}`} role="toolbar" aria-label="Ask about the selected words" ref={ref} style={docked ? undefined : { visibility: "hidden" }} onMouseDown={(e) => e.preventDefault()} onContextMenu={(e) => e.preventDefault()}>
      <div class="bar-acts" ref={acts} onScroll={edges}>
        {groups.map((g, i) => (
          <Fragment key={i}>
            {i > 0 && <span class="bar-sep" />}
            {g.map((it) => (
              <button key={it.key} type="button" title={`${it.label} (${keyText(it.key!)})`} data-key={it.key} onClick={go(it)}>
                {it.short ?? it.label}
                <span class="k">{keyText(it.key!)}</span>
              </button>
            ))}
          </Fragment>
        ))}
      </div>
      <button type="button" class="bar-more" title="More: copy, select less or more, related sections (right-click works too)" aria-haspopup="menu" onClick={(e) => showMenu(selectionEntries(selCtx(), act), e.currentTarget as HTMLElement)}>
        ⋯
      </button>
      {docked && (
        <button
          type="button"
          class="bar-done"
          aria-label="Done"
          title="Done (Esc)"
          onClick={() => {
            hideBar();
            press("Escape");
          }}
        >
          ×
        </button>
      )}
    </div>
  );
  return host ? createPortal(bar, host) : bar;
}

// ---- key hints as buttons ----

/** A hint: words, or a key and what it does. */
export type Hint = (string | [key: string, what: string])[];

/** A key hint that is a button: a click does what the key does. */
export function Key({ k, what }: { k: string; what: ComponentChildren }) {
  return (
    <button type="button" class="key" data-key={k} title={keyText(k)} onMouseDown={(e) => e.preventDefault()} onClick={(e) => {
        e.stopPropagation();
        // A box being typed in (the jump box, the command line) gives the key back to the page.
        if ((document.activeElement as HTMLElement | null)?.matches?.("input, textarea")) (document.activeElement as HTMLElement).blur();
        press(k);
      }}
    >
      <kbd>{keyText(k)}</kbd>
      <span class="lbl">{what}</span>
    </button>
  );
}

/** Hints, joined by middle dots: each key a button. */
export function Hints({ hint }: { hint: Hint }) {
  return (
    <span class="hints">
      {hint.map((h, i) => (
        <Fragment key={i}>
          {i > 0 && <span class="hsep"> · </span>}
          {typeof h === "string" ? <span>{h}</span> : <Key k={h[0]} what={h[1]} />}
        </Fragment>
      ))}
    </span>
  );
}

// ---- the first visit ----

const FIRST = "ie:firstrun";
const seen = () => {
  try {
    return localStorage.getItem(FIRST) === "done";
  } catch {
    return true;
  }
};
let firstRun = typeof window !== "undefined" && !seen();
if (firstRun) {
  const done = () => {
    firstRun = false;
    try {
      localStorage.setItem(FIRST, "done");
    } catch {
      /* storage may be unavailable: it shows again next time */
    }
    window.removeEventListener("pointerdown", done, true);
    window.removeEventListener("keydown", done, true);
  };
  window.addEventListener("pointerdown", done, true);
  window.addEventListener("keydown", done, true);
}

/** The one line a newcomer sees, in the status line, until they first click or press a key. */
export function FirstRun() {
  if (!firstRun) return null;
  return (
    <span class="firstrun">
      {touch() ? (store.pages ? "Tap a sentence for what you can do with it · swipe, or tap the trail below, to go from pane to pane" : "Tap a sentence for what you can do with it") : <>Click a sentence for what you can do with it · <Key k="?" what="lists every key" /></>}
    </span>
  );
}
