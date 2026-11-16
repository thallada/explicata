/**
 * The panes view: panes side by side, in the manner of Andy Matuschak's notes. It starts as the
 * path down from the top node; a link followed from a pane opens its target in the next pane
 * (another document's node, a Wikipedia article, a section of one), replacing what was to the
 * right. Moving back left closes nothing: the panes stay until something else is opened from an
 * earlier pane, or q or a pane's × closes them. Earlier columns stay at the left as narrow spines
 * when later ones slide over them.
 *
 * A modified open (Shift+Enter, Shift- or Ctrl-click) makes a fork instead: the new pane opens
 * below what was in the next column. The panes are a forest (forks.ts) and the screen is laid out
 * by column: column d holds every open pane at depth d, top to bottom in tree order, and divides
 * its own height among them; when they do not fit, all but the pane on the focused branch (and any
 * pinned one) fold into one-line tabs. A faint curve runs from what each pane was opened from to
 * its title. The focused branch is `store.trail`, and the pane on it holding the focus, the active
 * pane, is `store.paneAt`. Clicks are handled by the page (App.tsx), exactly as in the column
 * view; a click in a pane off the branch first brings it onto the branch.
 */
import { Component, type ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import { docOf, label, sections, staleness, type NodeId } from "../core/model";
import { LANES, LANE_FIRST, LANE_LAST, LANE_PITCH, laneOrder } from "./lanes";
import { ACROSS, DOWN, mark, offsets, reveal, starts, stick, unmark, whole } from "./stack";
import { NodeBacklinks, NodeRelated, PaneCtx, TargetRow } from "./Links";
import { Flags, NodeBody, PendingSections, Row, TitleEditor, TopMatter } from "./Node";
import { kidClass, refKey, store, type Aux, type Pane as PaneNode, type PaneRef } from "./store";
import { WikiView } from "./Wiki";
import { article } from "./wiki";

interface PaneProps {
  t: PaneNode;
  p: PaneRef;
  /** The pane it was opened from, the one to its left. */
  parent?: PaneRef;
  /** Its depth in its tree: its place on the focused branch, when its tree is focused. */
  index: number;
  /** Its children, and which is picked, as a key (redraw when they change). */
  kids: string;
  /** Off the focused branch: drawn, but the keys are elsewhere; a click brings it onto the branch (App.tsx). Only an article pane draws differently (how its article is named). */
  off: boolean;
  /** The aux focus, when this pane holds it. */
  aux: Aux | null;
  /** The pane the keys act on. */
  active: boolean;
  /** The first tree's root: the top node's pane. */
  root: boolean;
  /** An orphan's root: a pinned pane whose source has closed. */
  orphan: boolean;
}

// `off` is left out: a node pane draws the same on the branch or off it, and moving between forks should redraw only what changed.
const key = (p: PaneProps) => `${refKey(p.p)}|${p.index}|${p.kids}|${p.active}|${!!p.t.pinned}|${p.root}|${p.orphan}|${JSON.stringify(p.aux)}`;

/** Redraws a pane only when something drawn in it changed (see `store.paneDirty`). An article pane is cheap to redraw: its HTML is set once. */
class Pane extends Component<PaneProps> {
  shouldComponentUpdate(next: PaneProps) {
    if (key(next) !== key(this.props)) return true;
    if (next.p.kind === "wiki") return true;
    return store.paneDirty(next.p.id) || !!store.targetOf(next.p.id) || store.linkedFrom(next.p.id).length > 0;
  }
  render() {
    const p = this.props.p;
    return <PaneCtx.Provider value={this.props.t.id}>{p.kind === "node" ? <NodePane {...this.props} id={p.id} /> : <WikiPane {...this.props} />}</PaneCtx.Provider>;
  }
}

/** The attributes every pane has: which it is, its place in its tree, and its id there. */
const paneAttrs = (props: PaneProps, name: string) => ({
  "data-pane": name,
  "data-pane-index": props.index,
  "data-tid": props.t.id,
});
const paneClass = (props: PaneProps) => `${props.active ? " active" : ""}${props.t.pinned ? " pinned" : ""}${props.orphan ? " orphaned" : ""}`;

/**
 * What every pane carries besides its text: its spine (its title set vertically, shown when later
 * columns cover it), its tab (one line, shown when its column folds it), and, top right, its pin
 * and its ×. Clicks on them are handled by the page (App.tsx).
 */
function Chrome({ props, title, mark }: { props: PaneProps; title: string; mark?: ComponentChildren }) {
  const tid = props.t.id;
  const pinned = !!props.t.pinned;
  return (
    <>
      <div class="spine" data-spine={props.index} title={title}>
        <span role="button" class="pane-btn close" data-close={tid} title="Close this pane and what was opened from it (q)" aria-label="Close">
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3 3l6 6M9 3l-6 6" />
          </svg>
        </span>
        <span class="spine-title">
          {mark}
          {mark && " "}
          {title}
        </span>
      </div>
      <div class="grip" data-grip={tid} title="Drag to move this pane up or down its column" />
      <div class="tabline" data-spine={props.index} title={title}>
        {mark}
        <span class="tabtitle">{title}</span>
      </div>
      <div class="pane-ctl">
        <span role="button" class={`pane-btn pin${pinned ? " on" : ""}`} data-pin={tid} title={pinned ? "Unpin this pane (P)" : "Pin this pane: it stays when what opened it closes, and never folds away (P)"} aria-label={pinned ? "Unpin" : "Pin"}>
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M4 1.5h4M4.6 1.5v3.6L2.8 7.2h6.4L7.4 5.1V1.5M6 7.2V11" />
          </svg>
        </span>
        <span role="button" class="pane-btn close" data-close={tid} title="Close this pane and what was opened from it (q)" aria-label="Close">
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3 3l6 6M9 3l-6 6" />
          </svg>
        </span>
      </div>
    </>
  );
}

/** An orphan says, quietly, that what it was opened from has closed. */
const Orphaned = ({ on }: { on: boolean }) => (on ? <div class="pane-from orphan-note">opened from a pane since closed</div> : null);

function NodePane(props: PaneProps & { id: NodeId }) {
  const { id, active, t, parent } = props;
  const snap = store.snap;
  const n = snap.nodes[id];
  if (!n) return null;
  const top = props.root && id === store.top;
  // A document's pane is a page of its own, headed like one.
  const page = top || docOf(snap, id) === id;
  const kids = sections(snap, id);
  const focused = active && !store.aux && store.focus.node === id;
  const editing = store.edit?.node === id && store.edit.field === "title";
  const jump = !props.root && !props.orphan && !store.continuesFrom(props.p, parent);
  // Its children open to the right: the picked one's row is marked as showing; other forks' rows as forked.
  const kid = t.kids[t.pick];
  const showing = kid?.ref.kind === "node" && store.continuesFrom(kid.ref, props.p) ? kid.ref.id : undefined;
  const forked = new Set(t.kids.flatMap((k, j) => (j !== t.pick && k.ref.kind === "node" && store.continuesFrom(k.ref, props.p) ? [k.ref.id] : [])));
  return (
    <article
      class={`pane${top ? " root" : ""}${page && !top ? " doc" : ""}${jump ? " jumped" : ""}${n.kind === "note" ? " note-pane" : ""}${store.preview ? " preview" : ""}${paneClass(props)}`}
      {...paneAttrs(props, id)}
    >
      <Chrome props={props} title={label(snap, id)} />
      <div class="pane-scroll">
        <div class="pane-body">
          <Orphaned on={props.orphan} />
          {page ? (
            <TopMatter id={id} />
          ) : (
            <>
              {jump && <div class="pane-from">{docOf(snap, id) ? snap.nodes[docOf(snap, id)!].title : "the library"}</div>}
              <header class={`pane-head${focused ? " focused" : ""}`} data-node={id}>
                {editing ? <TitleEditor id={id} /> : <h2>{n.title || (n.kind === "note" ? label(snap, id) : <i class="untitled">untitled</i>)}</h2>}
                <Flags id={id} />
              </header>
              <NodeBody id={id} />
            </>
          )}
          {kids.length > 0 && (
            <ul class="outline rows">
              {kids.map((k) => (
                <PaneRow key={k} id={k} showing={k === showing} forked={forked.has(k)} active={active} />
              ))}
            </ul>
          )}
          <PendingSections id={id} />
          {store.articleUnder(id) ? <WikiView host={`n${id}`} /> : <TargetRow id={id} />}
          <NodeBacklinks id={id} />
          <NodeRelated id={id} />
        </div>
      </div>
    </article>
  );
}

function WikiPane(props: PaneProps) {
  const { p, index } = props;
  if (p.kind !== "wiki") return null;
  const a = article(p.title, p.lang);
  const sec = p.sec && a.state === "ready" ? a.value.sections.find((x) => x.id === p.sec) : undefined;
  const title = sec ? `${sec.heading} · ${p.title}` : a.state === "ready" ? a.value.title : p.title;
  return (
    <article class={`pane wiki-pane${p.from ? " jumped" : ""}${paneClass(props)}`} {...paneAttrs(props, `w:${p.title}${p.sec ? `#${p.sec}` : ""}`)}>
      <Chrome props={props} title={title} mark={<b class="wmark">W</b>} />
      <div class="pane-scroll">
        <div class="pane-body">
          <Orphaned on={props.orphan} />
          {/* On the focused branch an article pane is named by its column; off it, by its place in the tree. */}
          <WikiView host={props.off ? `f${props.t.id}` : `p${index}`} />
        </div>
      </div>
    </article>
  );
}

function PaneRow({ id, showing, forked, active }: { id: NodeId; showing: boolean; forked: boolean; active: boolean }) {
  const snap = store.snap;
  const n = snap.nodes[id];
  const open = store.isOpen(id);
  const leaf = !sections(snap, id).length && !n.body.trim();
  const focused = active && !store.aux && store.focus.node === id;
  const st = staleness(snap, id);
  // While its pane is showing, the title is edited at the head of that pane instead.
  const editing = !showing && store.edit?.node === id && store.edit.field === "title";
  return (
    <li
      class={`node d${Math.min(n.depth - (snap.library ? 1 : 0), 6)}${open ? " open" : ""}${focused ? " focused" : ""}${showing ? " showing" : ""}${forked ? " forked" : ""}${showing || forked ? ` ${kidClass(`n:${id}`)}` : ""}${st.up || st.down ? " stale" : ""}`}
      data-node={id}
    >
      <Row id={id} open={open} leaf={leaf} editing={editing} />
    </li>
  );
}

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Scroll a pane vertically, as little as possible, so that an element in it is in view. */
function nearestY(el: Element | null | false) {
  const box = el && el.closest<HTMLElement>(".pane-scroll");
  if (!el || !box) return;
  const r = el.getBoundingClientRect();
  const c = box.getBoundingClientRect();
  const pad = 28;
  if (r.top < c.top + pad) box.scrollTop += r.top - c.top - pad;
  else if (r.bottom > c.bottom - pad) box.scrollTop += Math.min(r.bottom - c.bottom + pad, r.top - c.top - pad);
}

const setAttr = (el: Element | undefined, name: string, on: boolean) => {
  if (el && el.hasAttribute(name) !== on) on ? el.setAttribute(name, "") : el.removeAttribute(name);
};

/** The least height a pane keeps in a column while all its panes fit; below it, the column stacks them. */
export const PANE_MIN = 260;
/** A covered pane's tab, the strip a pane leaves down a crowded column (as a spine does across). */
export const TAB = 30;
/** How long the mouse rests on a covered pane before it peeks out. */
export const PEEK_MS = 200;

/**
 * Heights for the panes of one column of height h, from what each needs to show all it holds:
 * each gets that, or an equal share of what is left, whichever is less; what no pane needs goes to
 * the one that needs most. So short panes are no taller than their text, and long ones share the rest.
 */
export function fill(h: number, needs: number[]): number[] {
  const out = needs.map(() => 0);
  const order = needs.map((_, i) => i).sort((a, b) => needs[a] - needs[b]);
  let rest = h;
  order.forEach((i, k) => {
    const share = rest / (order.length - k);
    out[i] = Math.floor(k === order.length - 1 ? rest : Math.min(needs[i], share));
    rest -= out[i];
  });
  return out;
}

/** The panes drawn, by their id in the forest. */
const paneEls = (el: HTMLElement) => {
  const m = new Map<number, HTMLElement>();
  for (const e of el.querySelectorAll<HTMLElement>(".pane[data-tid]")) m.set(Number(e.dataset.tid), e);
  return m;
};

const kidsKey = (t: PaneNode) => `${t.pick}:${t.kids.map((k) => refKey(k.ref)).join(",")}`;

export function Panes() {
  store.syncTrail();
  const strip = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const followed = useRef("");
  /** Per column, the pane last on the focused branch there: the one a crowded column shows whole when the branch is elsewhere. */
  const lastIn = useRef(new Map<number, number>());
  /** Each column's sticky left edge, in px, as last set. */
  const lefts = useRef<number[]>([]);
  const frame = useRef(0);
  /** A pending reveal in the columns other than the active pane's. */
  const later = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** What each pane last needed to show all it holds. */
  const needs = useRef(new Map<number, number>());
  /** The pane each crowded column was last scrolled to show whole. */
  const shown = useRef(new Map<HTMLElement, number>());
  /** Each column's panes when last laid out. */
  const laid = useRef(new Map<HTMLElement, string>());
  /** The layout of the latest render (a pending one uses it). */
  const latest = useRef<(all?: boolean) => void>(() => {});
  /** The active pane's column when the strip last followed it. */
  const lastCol = useRef(-1);

  const branch = store.branchNodes;
  const onBranch = new Set(branch.map((n) => n.id));
  const activeId = branch[store.paneAt]?.id;
  const cols = store.paneColumns;
  const order = [...cols.keys()].sort((a, b) => a - b);

  /**
   * Lay out the stacks (stack.ts). Across: each column stuck a spine after the one before (a pinned
   * pane's column, its whole width). Down: a column with several panes divides its height among
   * them, a pane taking what its text needs; when they do not all fit, it becomes a stack of its
   * own, each pane stuck a tab below the one before (a pinned one, its height) and the column
   * scrolled to show whole the pane on the focused branch, or the one last on it there.
   */
  const layout = (all = false) => {
    const el = strip.current;
    if (!el) return;
    const colEls = [...el.children].filter((c): c is HTMLElement => c.classList.contains("col"));
    if (!colEls.length) return;
    clearTimeout(later.current);
    const activeCol = activeId === undefined ? null : paneEls(el).get(activeId)?.parentElement;
    const w = colEls[0].offsetWidth;
    const spine = colEls[0].querySelector<HTMLElement>(".spine")?.offsetWidth ?? 0;
    // With no scrollbar under the panes (none needed, or one drawn over them) their last bottom edge meets the status line's: one line, not two.
    setAttr(el, "data-flush", el.offsetHeight - el.clientHeight < 1);
    lefts.current = offsets(
      colEls.map(() => w),
      colEls.map((c) => c.hasAttribute("data-pinned")),
      spine,
      el.clientWidth,
    );
    stick(colEls, lefts.current, ACROSS);
    let deferred = false;
    for (const c of colEls) {
      const ps = [...c.children].filter((p): p is HTMLElement => p.classList.contains("pane"));
      if (ps.length < 2) {
        for (const p of ps) if (p.style.height) (p.style.height = ""), (p.style.flex = ""), (p.style.top = "");
        c.classList.remove("crowded");
        unmark(ps);
        continue;
      }
      const h = c.clientHeight;
      const col = Number(c.dataset.col);
      const sc = ps[0].querySelector<HTMLElement>(".pane-scroll")!;
      const cs = getComputedStyle(sc);
      const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + 1;
      const tids = ps.map((p) => Number(p.dataset.tid));
      // What each pane needs to show all it holds; a buried pane is not laid out, so it keeps what it last needed.
      const need = ps.map((p, i) => {
        if (p.hasAttribute("data-buried") && needs.current.has(tids[i])) return needs.current.get(tids[i])!;
        const n = p.querySelector<HTMLElement>(".pane-body")!.offsetHeight + pad;
        needs.current.set(tids[i], n);
        return n;
      });
      const pinned = ps.map((p) => p.classList.contains("pinned"));
      const crowded = need.reduce((s, x) => s + Math.min(x, PANE_MIN), 0) > h;
      let heights: number[];
      let tops: number[] = [];
      if (!crowded) heights = fill(h, need);
      else {
        // Each pane what its text needs, up to the column less a tab for each other pane; a pinned one, at most a third of it, but its least.
        const pin = need.map((x, i) => (pinned[i] ? Math.min(x, Math.max(PANE_MIN, Math.floor(h / 3))) : 0));
        const free = h - pin.reduce((s, x) => s + x, 0) - (pinned.filter((x) => !x).length - 1) * TAB;
        heights = need.map((x, i) => (pinned[i] ? pin[i] : Math.min(x, Math.max(PANE_MIN, free))));
        tops = offsets(heights, pinned, TAB, h);
      }
      c.classList.toggle("crowded", crowded);
      ps.forEach((p, i) => {
        if (p.style.height !== `${heights[i]}px`) (p.style.height = `${heights[i]}px`), (p.style.flex = "none");
      });
      if (crowded) stick(ps, tops, DOWN);
      else for (const p of ps) p.style.top = "";
      // The pane to show whole: on the focused branch, or the one last on it here.
      const here = tids.find((t) => onBranch.has(t)) ?? (tids.includes(lastIn.current.get(col)!) ? lastIn.current.get(col)! : tids[0]);
      const k = tids.indexOf(here);
      const st = starts(heights);
      const want = crowded ? reveal(c.scrollTop, h, st[k], heights[k], tops[k], st[st.length - 1] + heights[heights.length - 1] - h) : 0;
      // As the focus moves, the active pane's column scrolls at once and the others once the keys pause (each brings whole panes into view, which costs a frame's painting); any other change, at once.
      const sig = tids.map((t, i) => `${t}${pinned[i] ? "^" : ""}`).join();
      const same = laid.current.get(c) === sig;
      laid.current.set(c, sig);
      const moved = shown.current.get(c) !== here;
      if (Math.abs(c.scrollTop - want) > 1 && !all && same && moved && c !== activeCol) deferred = true;
      else {
        if (Math.abs(c.scrollTop - want) > 1) c.scrollTop = want;
        shown.current.set(c, here);
      }
    }
    if (deferred)
      later.current = setTimeout(() => {
        latest.current(true);
        measure();
        schedule();
      }, 150);
    // The focused branch's panes, marked without redrawing them.
    for (const [id, p] of paneEls(el)) p.classList.toggle("on-branch", onBranch.has(id));
    for (const [col, ps] of cols) for (const x of ps) if (onBranch.has(x.node.id)) lastIn.current.set(col, x.node.id);
  };

  /**
   * Mark how far each item is covered by the next, across the strip and down each crowded column
   * (stack.ts): an overlapped item gives the one over it a shadow edge (data-over); one with too
   * little left to read its heading shows its spine or tab (data-covered).
   */
  const measure = () => {
    const el = strip.current;
    if (!el) return;
    const colEls = [...el.querySelectorAll<HTMLElement>(":scope > .col")];
    mark(el, colEls, ACROSS, false, colEls[0]?.querySelector<HTMLElement>(".spine")?.offsetWidth ?? 0);
    for (const c of colEls) if (c.classList.contains("crowded")) mark(c, [...c.querySelectorAll<HTMLElement>(":scope > .pane")], DOWN, true, TAB);
  };

  /**
   * Keep the focus in view. Vertically, the pane holding the focus scrolls to its focused row,
   * selection or link. Horizontally, the strip scrolls as little as it can so that pane's column is
   * whole and, when there is room, so is the column beside it: for a row whose pane is showing,
   * that pane's; otherwise the one before. Up and down a column it stays still while the pane looked
   * at is whole.
   */
  const follow = () => {
    const el = strip.current;
    if (!el) return;
    const f = store.focus;
    const at = store.paneAt;
    const nodes = store.branchNodes;
    const key = `${f.node}|${f.grain}|${f.range?.join()}|${JSON.stringify(store.aux)}|${at}|${nodes.map((n) => n.id).join(",")}|${el.clientWidth}|${el.clientHeight}|${store.mode === "edit"}|${lefts.current.join(",")}`;
    if (key === followed.current) return;
    followed.current = key;
    const els = paneEls(el);
    const panes = nodes.flatMap((n) => els.get(n.id) ?? []);
    if (!panes.length) return;
    const next = store.trail[at + 1];
    const a0 = store.aux;
    const showing = store.showingFocus() || (a0?.kind === "wiki" && a0.row.t === "sec" && next?.kind === "wiki" && next.sec === a0.row.id);
    if (store.mode !== "edit") {
      const pane = panes[at];
      nearestY(pane?.querySelector(".sel, .wfocus, .node.focused > .row, .wrow.focused > .row, .backlinks li.focused, .target-row.focused, .wiki-head.focused, .pane-head.focused, .focused"));
    }
    const colEls = [...el.querySelectorAll<HTMLElement>(":scope > .col")];
    const colOf = (p: HTMLElement | undefined) => (p ? colEls.indexOf(p.parentElement as HTMLElement) : -1);
    const w = colEls[0].offsetWidth;
    const view = el.clientWidth;
    const max = el.scrollWidth - view;
    const L = lefts.current;
    const b = colOf(panes[Math.min(panes.length - 1, showing ? at + 1 : at)]);
    if (b < 0) return;
    const here = colOf(panes[at]);
    const was = lastCol.current;
    lastCol.current = here;
    if (here === was && whole(el.scrollLeft, view, b * w, w, L[b] ?? 0)) return;
    // Column i starts at i·w: show b whole, and the one before it too when both fit.
    const a = b > 0 && (showing || f.grain === "node") ? b - 1 : b;
    const both = reveal(el.scrollLeft, view, a * w, (b + 1 - a) * w, L[a] ?? 0, max);
    const target = whole(both, view, b * w, w, L[b] ?? 0) && whole(both, view, a * w, w, L[a] ?? 0) ? both : reveal(el.scrollLeft, view, b * w, w, L[b] ?? 0, max);
    if (Math.abs(target - el.scrollLeft) > 1) el.scrollTo({ left: target, behavior: reducedMotion() ? "auto" : "smooth" });
  };

  /** Draw the curves on the next frame (after the layout this frame settles). */
  const schedule = () => {
    if (!frame.current)
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        curves(strip.current, svg.current);
      });
  };

  latest.current = layout;
  useLayoutEffect(() => {
    layout();
    follow();
    measure();
    schedule();
  });

  useEffect(() => {
    const el = strip.current!;
    const wrap = el.parentElement!;
    const onScroll = (e: Event) => {
      const t = e.target as HTMLElement;
      if (t === el || t.classList?.contains("col")) measure();
      // What peeks is placed for where things were: put it back (one waiting to peek still may).
      if (peeked) hide();
      schedule();
    };
    const onResize = () => {
      latest.current(true);
      followed.current = "";
      follow();
      measure();
      schedule();
    };
    // Panes and crowded columns scroll on their own: their scroll events are caught on the way down.
    wrap.addEventListener("scroll", onScroll, { passive: true, capture: true });
    // The strip changes size with the window and when the history panel opens or closes.
    const sizes = new ResizeObserver(onResize);
    sizes.observe(el);
    document.fonts?.ready.then(onResize);

    /*
     * Peeking: a pane the stacks have covered, wholly or in part (its column across the strip, or
     * the pane down a crowded column), slides out over its neighbours while the mouse rests on it
     * (after PEEK_MS, so passing across does not flicker), raised and, if it runs past the column's
     * foot, lifted into view; nothing else moves. A click makes it the active pane, which uncovers
     * it for good. Not for touch, the keyboard, or while dragging.
     */
    let peeked: HTMLElement | null = null;
    let pending: HTMLElement | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function hide() {
      if (!peeked) return;
      peeked.removeAttribute("data-peek");
      peeked.style.transform = "";
      peeked = null;
    }
    function unpeek() {
      clearTimeout(timer);
      pending = null;
      hide();
    }
    const peekable = (pane: HTMLElement): HTMLElement | null => {
      const col = pane.parentElement as HTMLElement;
      if (col.hasAttribute("data-covered") || (col.nextElementSibling as HTMLElement | null)?.hasAttribute("data-over")) return col;
      if (!col.classList.contains("crowded")) return null;
      const r = pane.getBoundingClientRect();
      const c = col.getBoundingClientRect();
      if (pane.hasAttribute("data-covered") || (pane.nextElementSibling as HTMLElement | null)?.hasAttribute("data-over") || r.bottom > c.bottom + 1) return pane;
      return null;
    };
    const peek = (it: HTMLElement) => {
      peeked = it;
      it.setAttribute("data-peek", "");
      if (it.classList.contains("pane")) {
        const r = it.getBoundingClientRect();
        const c = (it.parentElement as HTMLElement).getBoundingClientRect();
        const dy = Math.max(c.top - r.top, Math.min(0, c.bottom - r.bottom));
        if (dy) it.style.transform = `translateY(${Math.round(dy)}px)`;
      }
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== "mouse" || e.buttons || drag) return;
      const pane = (e.target as HTMLElement).closest<HTMLElement>(".pane");
      const it = pane && (pane === peeked || pane.parentElement === peeked ? peeked : peekable(pane));
      if (it === peeked && it) return;
      if (it === pending && it) return;
      unpeek();
      if (!it) return;
      pending = it;
      timer = setTimeout(() => {
        if (pending !== it) return;
        pending = null;
        const pane = it.classList.contains("pane") ? it : it.querySelector<HTMLElement>(".pane");
        if (pane && peekable(pane)) peek(it);
      }, PEEK_MS);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerleave", unpeek);
    window.addEventListener("keydown", unpeek, true);

    /*
     * Dragging a pane up or down its column, by its grip (the band above its title, beside the pin
     * and the x) or its tab: a line shows where it will go; Esc cancels. The column's order is then
     * its own (forks.ts `reorder`), kept with the panes.
     */
    let drag: { tid: number; col: HTMLElement; y0: number; on: boolean; before: number | null; line: HTMLElement | null } | null = null;
    let swallow = false;
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const t = e.target as HTMLElement;
      if (t.closest("[data-close], [data-pin]")) return;
      const handle = t.closest<HTMLElement>("[data-grip], .tabline");
      const pane = handle?.closest<HTMLElement>(".pane");
      const col = pane?.parentElement as HTMLElement | undefined;
      if (!handle || !pane || !col || col.children.length < 2) return;
      drag = { tid: Number(pane.dataset.tid), col, y0: e.clientY, on: false, before: null, line: null };
      handle.setPointerCapture(e.pointerId);
    };
    const onDrag = (e: PointerEvent) => {
      if (!drag) return;
      if (!drag.on) {
        if (Math.abs(e.clientY - drag.y0) < 5) return;
        drag.on = true;
        unpeek();
        wrap.classList.add("dragging");
        drag.line = document.createElement("div");
        drag.line.className = "drop-line";
        wrap.appendChild(drag.line);
      }
      const others = [...drag.col.querySelectorAll<HTMLElement>(":scope > .pane")].filter((p) => Number(p.dataset.tid) !== drag!.tid);
      const c = drag.col.getBoundingClientRect();
      const tops = others.map((p) => Math.max(c.top, Math.min(c.bottom, p.getBoundingClientRect().top)));
      const ends = others.map((p, i) => Math.min(tops[i + 1] ?? c.bottom, Math.max(c.top, Math.min(c.bottom, p.getBoundingClientRect().bottom))));
      const i = others.findIndex((_, k) => e.clientY < (tops[k] + ends[k]) / 2);
      drag.before = i < 0 ? null : Number(others[i].dataset.tid);
      const y = i < 0 ? (ends[ends.length - 1] ?? c.top) : tops[i];
      const box = wrap.getBoundingClientRect();
      Object.assign(drag.line!.style, { left: `${c.left - box.left}px`, width: `${c.width}px`, top: `${y - box.top - 1}px` });
    };
    const end = (keep: boolean) => {
      if (!drag) return;
      const d = drag;
      drag = null;
      d.line?.remove();
      wrap.classList.remove("dragging");
      if (d.on) {
        swallow = true;
        setTimeout(() => (swallow = false), 0);
        if (keep) store.reorderPane(d.tid, d.before);
      }
    };
    const onUp = () => end(true);
    const onCancel = () => end(false);
    const onKey = (e: KeyboardEvent) => {
      if (drag?.on && e.key === "Escape") {
        e.stopImmediatePropagation();
        e.preventDefault();
        end(false);
      }
    };
    // The click that ends a drag is not a click on the pane.
    const onClick = (e: MouseEvent) => {
      if (!swallow) return;
      swallow = false;
      e.stopPropagation();
      e.preventDefault();
    };
    // A press elsewhere puts a peeking pane back; on it, the click goes through to it (and makes it the active pane), and then it goes back.
    const onPress = (e: PointerEvent) => !(peeked && peeked.contains(e.target as Node)) && unpeek();
    const afterClick = () => peeked && requestAnimationFrame(unpeek);
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerdown", onPress);
    el.addEventListener("click", afterClick);
    el.addEventListener("pointermove", onDrag);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("click", onClick, true);
    return () => {
      cancelAnimationFrame(frame.current);
      clearTimeout(later.current);
      clearTimeout(timer);
      wrap.removeEventListener("scroll", onScroll, { capture: true });
      sizes.disconnect();
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerleave", unpeek);
      window.removeEventListener("keydown", unpeek, true);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerdown", onPress);
      el.removeEventListener("click", afterClick);
      el.removeEventListener("pointermove", onDrag);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("click", onClick, true);
    };
  }, []);

  return (
    <div class="panes">
      <div class="strip" ref={strip}>
        {order.map((c) => {
          const items = cols.get(c)!;
          return (
            <div key={c} class={`col${items.length > 1 ? " split" : ""}`} data-col={c} data-pinned={items.some((x) => x.node.pinned) || undefined}>
              {items.map((x) => {
                const off = !onBranch.has(x.node.id);
                const active = x.node.id === activeId;
                return (
                  <Pane
                    key={x.node.id}
                    t={x.node}
                    p={x.node.ref}
                    parent={x.parent?.ref}
                    index={x.depth}
                    kids={kidsKey(x.node)}
                    off={off}
                    active={active}
                    aux={active ? store.aux : null}
                    root={x.ti === 0 && x.depth === 0}
                    orphan={x.ti > 0 && x.depth === 0}
                  />
                );
              })}
            </div>
          );
        })}
      </div>
      <svg class="curves" ref={svg} aria-hidden="true" />
    </div>
  );
}

/** One curve, measured: where it leaves its source (y, and x where the lead-out starts), the edge of the source's text, where it arrives, and the gutter it runs down. */
interface Edge {
  from: number;
  to: number;
  /** The child's column: the gutter, just inside its left edge. */
  gutter: number;
  left: number;
  sx: number;
  sy: number;
  /** For words: the right end of their underline, which a short step joins to the lead-out. */
  under?: { x: number; y: number };
  textRight: number;
  ex: number;
  ey: number;
  on: boolean;
  lost: boolean;
}

/** A font's descent, by its CSS font string: where its baseline sits above the bottom of an inline box. */
const descents = new Map<string, number>();
let measurer: CanvasRenderingContext2D | null | undefined;
/** Where the underline of linked or annotated words runs, given their last line's box: a link's under the baseline by its offset; a note's dotted rule at the box's foot. */
function underline(s: HTMLElement, r: DOMRect): number {
  const cs = getComputedStyle(s);
  const fs = parseFloat(cs.fontSize) || 16;
  if (s.matches(".anchor")) return r.bottom - 0.08 * fs - 0.5;
  const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  let d = descents.get(font);
  if (d === undefined) {
    measurer ??= document.createElement("canvas").getContext("2d");
    if (measurer) measurer.font = font;
    d = measurer?.measureText("x").fontBoundingBoxDescent ?? 0.3 * fs;
    // Kept once the face has arrived; measured before, it is the fallback's.
    if (document.fonts?.check(font) !== false) descents.set(font, d);
  }
  const off = parseFloat(cs.textUnderlineOffset);
  return r.bottom - d + (Number.isFinite(off) ? off : 0.1 * fs) + 0.5;
}

/** Where a curve arrives, from its column's left edge: just short of the title. */
const ARRIVE = 36;

/** The lane order last used in each gutter, by the curves' keys. */
const lanesUsed = new Map<number, string[]>();

/**
 * The curves: one per pane opened from another, from what it was opened from to its title. A
 * curve leaves its source sideways, through the gap under the line (an extended
 * underline, for words) to the edge of the text, turns into a lane of the gutter just inside the
 * next column, and turns again into the child's title. Curves through one gutter run side by side
 * in lanes, like a ribbon cable, ordered so they cross as little as they can; past the lanes there
 * is room for, the rest share the outermost. On the focused branch a curve is drawn in a stronger
 * ink, last. A source scrolled out of its pane, folded into a tab or under the next column is held
 * at the pane's edge and the curve dotted; a curve into or out of a column covered down to its
 * spines is not drawn.
 */
function curves(el: HTMLElement | null, svg: SVGSVGElement | null) {
  if (!el || !svg) return;
  if (!store.settings.curves) {
    if (svg.firstChild) svg.replaceChildren();
    return;
  }
  const box = svg.getBoundingClientRect();
  const els = paneEls(el);
  const colEls = [...el.children] as HTMLElement[];
  const branch = new Set(store.branchNodes.map((n) => n.id));
  const edges: Edge[] = [];
  for (const x of store.panesPlaced) {
    const parent = x.parent;
    if (!parent) continue;
    const pe = els.get(parent.id);
    const ce = els.get(x.node.id);
    const pcol = pe?.parentElement;
    const ccol = ce?.parentElement;
    if (!pe || !ce || !pcol || !ccol || pcol.hasAttribute("data-covered") || ccol.hasAttribute("data-covered")) continue;
    const ccolBox = ccol.getBoundingClientRect();
    const left = ccolBox.left;
    // Where it arrives: just before the child's title, or its tab's; below a crowded column's foot, at the foot.
    const cbox = ce.getBoundingClientRect();
    let ey: number;
    let lost = false;
    if (ce.hasAttribute("data-covered")) ey = cbox.top + TAB / 2;
    else {
      const scroll = ce.querySelector<HTMLElement>(".pane-scroll")!.getBoundingClientRect();
      const tr = ce.querySelector<HTMLElement>(".pane-head h2, .top h1, .wiki-head h2")?.getBoundingClientRect();
      ey = tr && tr.bottom > scroll.top + 4 ? Math.max(scroll.top + 6, tr.top + Math.min(tr.height, 32) / 2) : scroll.top + 14;
    }
    if (ey > ccolBox.bottom - 4) {
      ey = ccolBox.bottom - 4;
      lost = true;
    }
    // Where it starts: the words, row or link it was opened from. The text's edge: the pane's right padding, or the next column where it covers the pane.
    const pbox = pe.getBoundingClientRect();
    const textRight = Math.min(pbox.right - 33, left - 2);
    let sx = textRight;
    let sy: number;
    let under: { x: number; y: number } | undefined;
    if (pe.hasAttribute("data-covered")) {
      sy = pbox.top + TAB / 2;
      lost = true;
    } else {
      // What of the pane shows: its own scroll box, less what the pane after it in a crowded column covers, down to the column's foot.
      const box = pe.querySelector<HTMLElement>(".pane-scroll")!.getBoundingClientRect();
      const nextTop = pcol.classList.contains("crowded") ? (pe.nextElementSibling as HTMLElement | null)?.getBoundingClientRect().top : undefined;
      const sc = { top: box.top, bottom: Math.min(box.bottom, nextTop ?? Infinity, pcol.getBoundingClientRect().bottom) };
      const cands = pe.querySelectorAll<HTMLElement>(`.${kidClass(refKey(x.node.ref))}`);
      let src: HTMLElement | undefined;
      for (const c of cands) {
        const r = c.getBoundingClientRect();
        if (r.height && r.bottom > sc.top && r.top < sc.bottom) {
          src = c;
          break;
        }
      }
      src ??= cands[0];
      const head = pe.querySelector<HTMLElement>(".pane-head h2, .top h1, .wiki-head h2");
      const s = src ?? head;
      if (!s) continue;
      const row = s.matches("li") ? s.querySelector<HTMLElement>(":scope > .row") : null;
      const rects = (row ?? s).getClientRects();
      const r = rects[rects.length - 1] ?? (row ?? s).getBoundingClientRect();
      if (row || s === head) {
        // A row is left from its right end, mid-height.
        sy = r.top + r.height / 2;
        sx = Math.min(r.right + 4, textRight);
      } else {
        // Words: from just under their last line, in the gap before the next, joined by a short step to the end of their underline.
        sy = r.bottom + 1;
        const uy = underline(s, r);
        const j = Math.max(2, sy - uy);
        under = { x: r.right, y: uy };
        sx = r.right + 2 * j;
      }
      if (sy < sc.top + 2 || sy > sc.bottom - 2 || sx > textRight + 1) {
        lost = true;
        under = undefined;
        sx = textRight;
        sy = Math.max(sc.top + 2, Math.min(sc.bottom - 2, sy));
      }
    }
    const gutter = colEls.indexOf(ccol);
    edges.push({ from: parent.id, to: x.node.id, gutter, left: left - box.left, sx: sx - box.left, sy: sy - box.top, under: under && { x: under.x - box.left, y: under.y - box.top }, textRight: textRight - box.left, ex: left + ARRIVE - box.left, ey: ey - box.top, on: branch.has(x.node.id) && branch.has(parent.id), lost });
  }
  // Lanes, gutter by gutter.
  const lane = new Map<Edge, number>();
  const gutters = new Map<number, Edge[]>();
  for (const e of edges) gutters.set(e.gutter, [...(gutters.get(e.gutter) ?? []), e]);
  for (const [g, es] of gutters) {
    const keyed = es.map((e) => ({ e, key: `${e.from}>${e.to}`, sy: e.sy, ey: e.ey }));
    const order = laneOrder(keyed, lanesUsed.get(g));
    lanesUsed.set(
      g,
      order.map((o) => o.key),
    );
    order.forEach((o, i) => lane.set(o.e, Math.min(i, LANES - 1)));
  }
  for (const g of [...lanesUsed.keys()]) if (!gutters.has(g)) lanesUsed.delete(g);
  const fx = (n: number) => Math.round(n * 2) / 2;
  const out: { key: string; from: number; to: number; lane: number; cls: string; d: string }[] = [];
  edges.sort((a, b) => Number(a.on) - Number(b.on));
  for (const e of edges) {
    const i = lane.get(e)!;
    // Lane 0 is nearest the panes, the last nearest the column's edge.
    const g = e.left + LANE_LAST - i * LANE_PITCH;
    const dy = e.ey - e.sy;
    let d: string;
    const join = e.under ? `M${fx(e.under.x)} ${fx(e.under.y)}C${fx((e.under.x + e.sx) / 2)} ${fx(e.under.y)} ${fx((e.under.x + e.sx) / 2)} ${fx(e.sy)} ${fx(e.sx)} ${fx(e.sy)}` : `M${fx(e.sx)} ${fx(e.sy)}`;
    if (Math.abs(dy) < 1.5) d = `${join}H${fx(e.ex)}`;
    else {
      // A lead-out to the lane, a quarter turn, the lane, a quarter turn into the title. Each turn's radius grows by a pitch per lane outwards, so a bundle turning together stays parallel; a turn never starts inside the text.
      const sg = Math.sign(dy);
      const r1 = Math.max(1, Math.min(Math.abs(dy) / 2, g - Math.max(e.sx, e.textRight), 8 + (LANE_LAST - LANE_FIRST) - i * LANE_PITCH));
      const r2 = Math.max(1, Math.min(Math.abs(dy) / 2, e.ex - g - 1));
      const k = 0.552;
      d =
        `${join}H${fx(g - r1)}` +
        `C${fx(g - r1 + k * r1)} ${fx(e.sy)} ${fx(g)} ${fx(e.sy + sg * r1 * (1 - k))} ${fx(g)} ${fx(e.sy + sg * r1)}` +
        `V${fx(e.ey - sg * r2)}` +
        `C${fx(g)} ${fx(e.ey - sg * r2 * (1 - k))} ${fx(g + r2 - k * r2)} ${fx(e.ey)} ${fx(g + r2)} ${fx(e.ey)}` +
        `H${fx(e.ex)}`;
    }
    out.push({ key: `${e.from}>${e.to}`, from: e.from, to: e.to, lane: i, cls: `${e.on ? "on" : ""}${e.lost ? " lost" : ""}`, d });
  }
  // Each curve keeps its element, changed only where it changed, so only what moved is painted again.
  const had = new Map<string, SVGPathElement>();
  for (const p of svg.querySelectorAll<SVGPathElement>("path")) had.set(p.dataset.key!, p);
  out.forEach((c, k) => {
    let p = had.get(c.key);
    had.delete(c.key);
    if (!p) {
      p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.dataset.key = c.key;
      p.dataset.from = String(c.from);
      p.dataset.to = String(c.to);
    }
    if (p.getAttribute("d") !== c.d) p.setAttribute("d", c.d);
    if (p.getAttribute("class") !== c.cls) p.setAttribute("class", c.cls);
    if (p.dataset.lane !== String(c.lane)) p.dataset.lane = String(c.lane);
    // In drawing order: the focused branch's last, on top.
    if (svg.children[k] !== p) svg.insertBefore(p, svg.children[k] ?? null);
  });
  for (const p of had.values()) p.remove();
}
