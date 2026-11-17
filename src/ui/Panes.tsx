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
const key = (p: PaneProps) => `${refKey(p.p)}|${p.t.hue}|${p.index}|${p.kids}|${p.active}|${!!p.t.pinned}|${p.root}|${p.orphan}|${JSON.stringify(p.aux)}`;

/** Redraws a pane only when something drawn in it changed (see `store.paneDirty`). An article pane is cheap to redraw: its HTML is set once. */
class Pane extends Component<PaneProps> {
  shouldComponentUpdate(next: PaneProps) {
    if (key(next) !== key(this.props)) return true;
    if (next.p.kind === "wiki") return true;
    return store.paneDirty(next.p.id) || !!store.targetOf(next.p.id) || store.linkedFrom(next.p.id).length > 0;
  }
  componentDidMount() {
    watchHead(this.props.t.id);
  }
  componentDidUpdate() {
    watchHead(this.props.t.id);
  }
  componentWillUnmount() {
    watched.get(this.props.t.id)?.io.disconnect();
    watched.delete(this.props.t.id);
  }
  render() {
    const p = this.props.p;
    return <PaneCtx.Provider value={this.props.t.id}>{p.kind === "node" ? <NodePane {...this.props} id={p.id} /> : <WikiPane {...this.props} />}</PaneCtx.Provider>;
  }
}

/** Sent when something the curves are drawn from changes without a render or a scroll: a pane's tab coming or going, the selection bar moving. */
export const GEOMETRY = "ie:geometry";

/**
 * A pane scrolled past its title shows its tab at its top, as a folded one does (data-scrolled): an
 * observer on the title's rule, against the pane's own scroll box less the tab, so nothing is done
 * per scroll or per key, and the tab comes exactly as the rule goes under it.
 */
const watched = new Map<number, { io: IntersectionObserver; target: Element }>();
function watchHead(tid: number) {
  const pane = document.querySelector<HTMLElement>(`.strip .pane[data-tid="${tid}"]`);
  if (!pane || typeof IntersectionObserver === "undefined") return;
  const scroll = pane.querySelector<HTMLElement>(":scope > .pane-scroll");
  const head = pane.querySelector<HTMLElement>(HEADS);
  const target = head?.matches(".top") ? head.querySelector("h1") : head;
  const w = watched.get(tid);
  if (w && w.target === target) return;
  w?.io.disconnect();
  watched.delete(tid);
  if (!target || !scroll) return void pane.removeAttribute("data-scrolled");
  const io = new IntersectionObserver(
    (es) => {
      const e = es[es.length - 1];
      const was = pane.hasAttribute("data-scrolled");
      setAttr(pane, "data-scrolled", !e.isIntersecting && !!e.rootBounds && e.boundingClientRect.height > 0 && e.boundingClientRect.bottom <= e.rootBounds.top + 1);
      // The curve into it lands in its tab now, or its title again.
      if (was !== pane.hasAttribute("data-scrolled")) window.dispatchEvent(new Event(GEOMETRY));
    },
    { root: scroll, rootMargin: `-${TAB}px 0px 0px 0px` },
  );
  io.observe(target);
  watched.set(tid, { io, target });
}

/** The attributes every pane has: which it is, its place in its tree, its id there, and its branch's colour (forks.ts; style.css draws it). */
const paneAttrs = (props: PaneProps, name: string) => ({
  "data-pane": name,
  "data-pane-index": props.index,
  "data-tid": props.t.id,
  "data-hue": props.t.hue,
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
        <span role="button" class="pane-btn more" data-more="pane" aria-haspopup="menu" title="More for this pane (right-click works too)" aria-label="More">
          ⋯
        </span>
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
  // Not under the tab a pane scrolled past its title shows at its top.
  const top = pad + TAB;
  if (r.top < c.top + top) box.scrollTop += r.top - c.top - top;
  else if (r.bottom > c.bottom - pad) box.scrollTop += Math.min(r.bottom - c.bottom + pad, r.top - c.top - top);
}

/**
 * Whether the rule under a pane's title shows (below where its tab would be, above what covers its
 * foot): if not, the pane shows its tab instead, and a curve into it lands in the tab's foot.
 */
function ruleShows(p: HTMLElement, col: DOMRect, next: number): boolean {
  if (p.hasAttribute("data-buried")) return false;
  const head = p.querySelector<HTMLElement>(HEADS);
  const rule = (head?.matches(".top") ? head.querySelector<HTMLElement>("h1") : head)?.getBoundingClientRect();
  if (!rule) return false;
  const r = p.getBoundingClientRect();
  const sc = p.querySelector<HTMLElement>(":scope > .pane-scroll")!.getBoundingClientRect();
  return rule.bottom > Math.max(r.top, col.top, sc.top) + TAB && rule.bottom <= Math.min(next, col.bottom, sc.bottom);
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
        for (const p of ps) if (p.style.height) (p.style.height = ""), (p.style.flex = ""), (p.style.top = ""), (p.style.bottom = "");
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
      /** What the panes after each leave at the column's foot: a tab each, a pinned one its whole height. */
      let below: number[] = [];
      if (!crowded) heights = fill(h, need);
      else {
        // Each pane what its text needs, up to the column less a tab for each other pane; a pinned one, at most a third of it, but its least.
        const pin = need.map((x, i) => (pinned[i] ? Math.min(x, Math.max(PANE_MIN, Math.floor(h / 3))) : 0));
        const free = h - pin.reduce((s, x) => s + x, 0) - (pinned.filter((x) => !x).length - 1) * TAB;
        heights = need.map((x, i) => (pinned[i] ? pin[i] : Math.min(x, Math.max(PANE_MIN, free))));
        tops = offsets(heights, pinned, TAB, h);
        below = heights.map((_, i) => heights.slice(i + 1).reduce((s, x, j) => s + (pinned[i + 1 + j] ? x : TAB), 0));
      }
      c.classList.toggle("crowded", crowded);
      // Only a crowded column is marked (measure): one that has room again is uncovered here.
      if (!crowded) unmark(ps);
      ps.forEach((p, i) => {
        if (p.style.height !== `${heights[i]}px`) (p.style.height = `${heights[i]}px`), (p.style.flex = "none");
      });
      if (crowded) {
        stick(ps, tops, DOWN);
        // Stuck at the foot as well, each a tab above those after it, so every pane shows at least its tab, above or below the one looked at.
        ps.forEach((p, i) => {
          const v = `${below[i] + (pinned[i] ? 0 : TAB - heights[i])}px`;
          if (p.style.bottom !== v) p.style.bottom = v;
        });
      } else for (const p of ps) (p.style.top = ""), (p.style.bottom = "");
      // The pane to show whole: on the focused branch, or the one last on it here.
      const here = tids.find((t) => onBranch.has(t)) ?? (tids.includes(lastIn.current.get(col)!) ? lastIn.current.get(col)! : tids[0]);
      const k = tids.indexOf(here);
      const st = starts(heights);
      const want = crowded ? reveal(c.scrollTop, h - below[k], st[k], heights[k], tops[k], st[st.length - 1] + heights[heights.length - 1] - h) : 0;
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
    for (const c of colEls) {
      const ps = [...c.querySelectorAll<HTMLElement>(":scope > .pane")];
      if (!c.classList.contains("crowded")) {
        for (const p of ps) setAttr(p, "data-tab", false);
        continue;
      }
      mark(c, ps, DOWN, true, TAB);
      // A covered pane shows its tab only when the rule under its title does not show: never both.
      const cb = c.getBoundingClientRect();
      ps.forEach((p, i) => setAttr(p, "data-tab", p.hasAttribute("data-covered") && !ruleShows(p, cb, ps[i + 1]?.getBoundingClientRect().top ?? Infinity)));
    }
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

  /** Where each newly opened pane came from in its parent, down the parent's text (its column's order goes by it). */
  const sources = () => {
    const el = strip.current;
    if (!el) return;
    const srcs = new Map<number, number>();
    const els = paneEls(el);
    for (const x of store.panesPlaced) {
      if (!x.parent || x.node.src !== undefined) continue;
      const pe = els.get(x.parent.id);
      const s = pe?.querySelector<HTMLElement>(`.${kidClass(refKey(x.node.ref))}`);
      const body = pe?.querySelector<HTMLElement>(".pane-body");
      const r = s?.getBoundingClientRect();
      if (r && body && r.height) srcs.set(x.node.id, Math.round(r.top - body.getBoundingClientRect().top));
    }
    if (srcs.size) store.setPaneSources(srcs);
  };

  /** A pane's text growing or shrinking (an article arriving, notes opening) lays the columns out again and redraws the curves. */
  const bodies = useRef<ResizeObserver | null>(null);
  const watchedBodies = useRef(new WeakSet<Element>());

  latest.current = layout;
  useLayoutEffect(() => {
    sources();
    layout();
    follow();
    measure();
    schedule();
    if (typeof ResizeObserver !== "undefined") {
      bodies.current ??= new ResizeObserver(() => {
        latest.current(true);
        measure();
        schedule();
      });
      for (const b of strip.current?.querySelectorAll(".pane-body") ?? []) if (!watchedBodies.current.has(b)) (watchedBodies.current.add(b), bodies.current.observe(b));
    }
  });

  useEffect(() => {
    const el = strip.current!;
    const wrap = el.parentElement!;
    const onScroll = (e: Event) => {
      const t = e.target as HTMLElement;
      // The strip, a crowded column, or a pane in one (whose title's rule may come or go under its tab).
      if (t === el || t.classList?.contains("col") || t.parentElement?.parentElement?.classList.contains("crowded")) measure();
      // A scroll inside what peeks (the wheel over it) keeps it out; any other moves things from under it.
      if (peeked.length && !peeked.some((p) => p !== t && p.contains(t)) && !(t === peeked[0] && peeked.length === 1 && !t.classList.contains("pane"))) hide();
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
    // While anything animates, the curves are drawn every frame, so they follow it.
    let moving = 0;
    const tick = () => {
      if (!moving) return;
      curves(strip.current, svg.current);
      requestAnimationFrame(tick);
    };
    const onRun = () => {
      if (!moving++) requestAnimationFrame(tick);
    };
    const onEnd = () => {
      moving = Math.max(0, moving - 1);
      if (!moving) schedule();
    };
    window.addEventListener(GEOMETRY, schedule);
    wrap.addEventListener("transitionrun", onRun);
    wrap.addEventListener("transitionend", onEnd);
    wrap.addEventListener("transitioncancel", onEnd);
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
    /** What peeks (its column across, the pane down its column, or both) and the pane it is for. */
    let peeked: HTMLElement[] = [];
    let peekedFor: HTMLElement | null = null;
    let pending: HTMLElement | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const lower = (it: HTMLElement) => {
      it.removeAttribute("data-peek");
      it.removeAttribute("data-peek-h");
      it.style.removeProperty("--peek-h");
      it.style.removeProperty("--peek-extra");
      it.style.transform = "";
    };
    function hide() {
      if (!peeked.length) return;
      for (const it of peeked) lower(it);
      peeked = [];
      peekedFor = null;
      schedule();
    }
    function unpeek() {
      clearTimeout(timer);
      pending = null;
      hide();
    }
    /**
     * How tall a pane would be shown whole (what its text needs, up to its column's height), if it is
     * cut off now (0 if not): shown shorter than that for any reason, covered by the pane after it, given
     * too small a share of its column, or running past the column's foot.
     */
    const cutOff = (pane: HTMLElement): number => {
      const col = pane.parentElement as HTMLElement;
      const r = pane.getBoundingClientRect();
      const c = col.getBoundingClientRect();
      const next = col.classList.contains("crowded") ? ((pane.nextElementSibling as HTMLElement | null)?.getBoundingClientRect().top ?? Infinity) : Infinity;
      const shown = Math.max(0, Math.min(r.bottom, c.bottom, next) - Math.max(r.top, c.top));
      const sc = pane.querySelector<HTMLElement>(".pane-scroll")!;
      const cs = getComputedStyle(sc);
      const need = needs.current.get(Number(pane.dataset.tid)) ?? pane.querySelector<HTMLElement>(".pane-body")!.offsetHeight + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + 1;
      const full = Math.min(Math.ceil(need), Math.floor(c.height));
      return shown < full - 2 ? full : 0;
    };
    /** What must come out for a pane to show whole: its column, if later columns cover it; the pane, if it is cut off down its column. */
    const peekable = (pane: HTMLElement): HTMLElement[] => {
      const col = pane.parentElement as HTMLElement;
      const out: HTMLElement[] = [];
      if (col.hasAttribute("data-covered") || (col.nextElementSibling as HTMLElement | null)?.hasAttribute("data-over")) out.push(col);
      if (col.children.length > 1 && cutOff(pane)) out.push(pane);
      return out;
    };
    const peek = (pane: HTMLElement, its: HTMLElement[]) => {
      peekedFor = pane;
      for (const it of its) {
        if (peeked.includes(it)) continue;
        peeked.push(it);
        it.setAttribute("data-peek", "");
        if (it === pane) {
          // As tall as it needs, without moving the panes around it (the extra height takes no room), then lifted into the column.
          const full = cutOff(it);
          if (full) {
            const h = it.offsetHeight;
            it.style.setProperty("--peek-h", `${full}px`);
            it.style.setProperty("--peek-extra", `${Math.max(0, full - h)}px`);
            it.setAttribute("data-peek-h", "");
          }
          const r = it.getBoundingClientRect();
          const c = (it.parentElement as HTMLElement).getBoundingClientRect();
          const dy = Math.max(c.top - r.top, Math.min(0, c.bottom - r.bottom));
          if (dy) it.style.transform = `translateY(${Math.round(dy)}px)`;
        }
      }
      schedule();
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== "mouse" || e.buttons || drag) return;
      const pane = (e.target as HTMLElement).closest<HTMLElement>(".pane");
      if (pane && (pane === peekedFor || pane === pending)) return;
      clearTimeout(timer);
      pending = null;
      const its = pane ? peekable(pane) : [];
      // Within a column that is out already: only the pane part changes.
      const col = pane?.parentElement as HTMLElement | undefined;
      if (col && peeked.includes(col)) {
        for (const it of peeked.filter((x) => x !== col)) lower(it);
        peeked = [col];
        peekedFor = pane;
      } else hide();
      if (!pane || !its.some((x) => !peeked.includes(x))) return;
      pending = pane;
      timer = setTimeout(() => {
        if (pending !== pane) return;
        pending = null;
        const now = peekable(pane);
        if (now.length) peek(pane, now);
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
      const panes = [...drag.col.querySelectorAll<HTMLElement>(":scope > .pane")];
      const mine = panes.findIndex((p) => Number(p.dataset.tid) === drag!.tid);
      const others = panes.filter((_, k) => k !== mine);
      const c = drag.col.getBoundingClientRect();
      const tops = others.map((p) => Math.max(c.top, Math.min(c.bottom, p.getBoundingClientRect().top)));
      const ends = others.map((p, i) => Math.min(tops[i + 1] ?? c.bottom, Math.max(c.top, Math.min(c.bottom, p.getBoundingClientRect().bottom))));
      // The pane under the pointer gives way: one that was below the dragged pane lets it in after
      // itself, one that was above lets it in before. So reaching any part of a pane is enough, in
      // either direction.
      let k = -1;
      while (k + 1 < others.length && tops[k + 1] <= e.clientY) k++;
      const at = k < 0 ? 0 : k >= mine || e.clientY >= ends[k] ? k + 1 : k;
      const i = at < others.length ? at : -1;
      drag.before = i < 0 ? null : Number(others[i].dataset.tid);
      const y = at === 0 ? (tops[0] ?? c.top) : ends[at - 1];
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
    const onPress = (e: PointerEvent) => !peeked.some((p) => p.contains(e.target as Node)) && unpeek();
    const afterClick = () => peeked.length && requestAnimationFrame(unpeek);
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
      window.removeEventListener(GEOMETRY, schedule);
      wrap.removeEventListener("transitionrun", onRun);
      wrap.removeEventListener("transitionend", onEnd);
      wrap.removeEventListener("transitioncancel", onEnd);
      bodies.current?.disconnect();
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
    <div class="panes" data-colors={store.settings.colors}>
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
  /** For a source out of sight in its pane: the point on the pane's edge, over it, where the curve ends turned toward it. */
  hint?: { x: number; y: number };
  /** For a link: its underline, line by line (the last runs on into the curve). */
  lines?: { x0: number; x1: number; y: number }[];
  textRight: number;
  ex: number;
  ey: number;
  on: boolean;
  lost: boolean;
  /** The child's branch colour (forks.ts). */
  hue?: number;
  /** Where the curve runs on into the rule under the child's title (or its tab's foot), drawn here as part of the curve: from x0 to x1 at the arrival's height. */
  rule?: { x0: number; x1: number };
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

/** The links whose underline the curves drew last time. */
let underlined = new Set<HTMLElement>();

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
    for (const p of svg.querySelectorAll("path")) p.remove();
    for (const s of underlined) s.removeAttribute("data-curved");
    underlined = new Set();
    markRuled(paneEls(el), new Map());
    return;
  }
  // The curves' layer covers the window from its corner (style.css), so its pixels are the device's and a hairline set on device pixels lands on them; it shows only over the strip.
  const box = { left: 0, top: 0 };
  // (Clipped inside the drawing: a CSS clip on the layer would have it resampled, softening every hairline.)
  const area = (svg.parentElement as HTMLElement).getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const els = paneEls(el);
  const colEls = [...el.children] as HTMLElement[];
  const branch = new Set(store.branchNodes.map((n) => n.id));
  // Coloured lines: a curve runs on into the rule under its pane's title (or its tab's foot), one line, the rule drawn here
  // with it (the pane's own rule left out, data-ruled) so that the two cannot differ by a pixel.
  const ruled = store.settings.colors === "line";
  // A hairline: one device pixel (two from a ratio of 2), its level runs on device pixels, as the page's borders are.
  const wd = Math.max(1, Math.floor(dpr + 0.01));
  const hair = `${wd / dpr}px`;
  if (svg.style.getPropertyValue("--hair") !== hair) svg.style.setProperty("--hair", hair);
  const level = (y: number) => (Math.round(y * dpr - wd / 2) + wd / 2) / dpr;
  const rules = new Map<number, string>();
  /** Tabs' feet that curves leave from, drawn with them. */
  const feet = new Map<number, { x0: number; x1: number; y: number; hue?: number; on: boolean }>();
  /** The panes whose tab's foot a curve into them draws already. */
  const tabbed = new Set<number>();
  /** The links whose underline a curve draws. */
  const curved = new Set<HTMLElement>();
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
    let ex = left + ARRIVE;
    let lost = false;
    let rule: Edge["rule"];
    // What of the child shows: up to the next column where it covers it, down to the pane after it in a crowded column.
    const nextCol = colEls[colEls.indexOf(ccol) + 1]?.getBoundingClientRect().left ?? Infinity;
    const shownRight = Math.min(cbox.right, nextCol);
    // A pane folded down a crowded column shows its tab, and may still show its title under it.
    // A pane showing its tab (folded down a crowded column, or scrolled past its title): the curve lands in the tab's foot; else in the rule under its title, where that shows (the same test as the tab's, ruleShows, so the two hand over at once).
    const below = ccol.classList.contains("crowded") ? ((ce.nextElementSibling as HTMLElement | null)?.getBoundingClientRect().top ?? Infinity) : Infinity;
    let folded = ce.hasAttribute("data-tab") || ce.hasAttribute("data-scrolled") || ce.hasAttribute("data-buried") || (ce.hasAttribute("data-covered") && !ruleShows(ce, ccolBox, below));
    if (folded) ey = cbox.top + TAB / 2;
    else {
      const scroll = ce.querySelector<HTMLElement>(".pane-scroll")!.getBoundingClientRect();
      const t = ce.querySelector<HTMLElement>(".pane-head h2, .top h1, .wiki-head h2");
      const tr = t?.getBoundingClientRect();
      ey = tr && tr.bottom > scroll.top + 4 ? Math.max(scroll.top + 6, tr.top + Math.min(tr.height, 32) / 2) : scroll.top + 14;
      // The rule: under the pane's own head (a section's, a page's title, an article's), not an article's set under a node; the focused head's too (the heavy rule on top marks the active pane).
      const head = ruled ? ce.querySelector<HTMLElement>(HEADS) : null;
      const ruleEl = head?.matches(".top") ? head.querySelector<HTMLElement>("h1") : head;
      const rr = ruleEl?.getBoundingClientRect();
      // Scrolled past its title (its tab is on its way): its tab's foot.
      if (rr && rr.bottom <= Math.max(cbox.top, scroll.top) + TAB) {
        folded = true;
        ey = cbox.top + TAB / 2;
      } else if (rr && rr.bottom > Math.max(cbox.top, ccolBox.top, scroll.top) + TAB && rr.bottom <= Math.min(below, ccolBox.bottom, scroll.bottom) && rr.left < shownRight) {
        // (ruleShows, from what is measured here already.)
        ey = level(rr.bottom - 0.5);
        ex = Math.max(left + ARRIVE, rr.left);
        rule = { x0: ex, x1: Math.min(rr.right, shownRight) };
        rules.set(x.node.id, "head");
      }
    }
    // Folded or scrolled so far that its title's rule does not show: into its tab's foot.
    if (folded && !rule && ruled) {
      ey = level(cbox.top + TAB - 0.5);
      // From where the curve meets it, on under the tab: the curve becomes the tab's line.
      rule = { x0: ex, x1: Math.round(Math.min(cbox.right - 1, nextCol) * dpr) / dpr };
      rules.set(x.node.id, "tab");
      tabbed.add(x.node.id);
    }
    // Below the column's foot (every pane leaves at least its tab there now, so this is only a pane still being laid out).
    if (ey > ccolBox.bottom) {
      ey = ccolBox.bottom - 4;
      lost = true;
    }
    // Where it starts: the words, row or link it was opened from. The text's edge: the pane's right padding, or the next column where it covers the pane.
    const pbox = pe.getBoundingClientRect();
    let textRight = Math.min(pbox.right - 33, left - 2);
    let sx = textRight;
    let sy: number;
    let under: { x: number; y: number } | undefined;
    let hint: { x: number; y: number } | undefined;
    let lines: { x0: number; x1: number; y: number }[] | undefined;
    // What of the pane shows: its own scroll box (below its tab, if folded), less what the pane after it in a crowded column covers, down to the column's foot.
    const pfolded = pe.hasAttribute("data-tab") || pe.hasAttribute("data-buried");
    const pscroll = pe.querySelector<HTMLElement>(".pane-scroll")!.getBoundingClientRect();
    const nextTop = pcol.classList.contains("crowded") ? (pe.nextElementSibling as HTMLElement | null)?.getBoundingClientRect().top : undefined;
    const sc = { top: pfolded || pe.hasAttribute("data-scrolled") ? Math.max(pscroll.top, pbox.top + TAB) : pscroll.top, bottom: Math.min(pscroll.bottom, nextTop ?? Infinity, pcol.getBoundingClientRect().bottom) };
    const cands = pe.hasAttribute("data-buried") ? [] : pe.querySelectorAll<HTMLElement>(`.${kidClass(refKey(x.node.ref))}`);
    let src: HTMLElement | undefined;
    for (const c of cands) {
      const r = c.getBoundingClientRect();
      if (r.height && r.bottom > sc.top + 2 && r.top < sc.bottom - 2) {
        src = c;
        break;
      }
    }
    // Folded to its tab (no more than a line or so of it showing) with its source out of sight.
    if (pfolded && !src && sc.bottom - sc.top < 48) {
      // Folded with its source out of sight: out of the right end of its tab's foot, carrying that line on (its foot drawn here too, so they join exactly).
      const footRight = Math.round(Math.min(pbox.right - 1, left) * dpr) / dpr;
      sy = level(pbox.top + TAB - 0.5);
      sx = footRight;
      // A few pixels straight on before it turns, so the foot runs on visibly.
      textRight = footRight + 6;
      if (ruled) feet.set(parent.id, { x0: pbox.left - box.left, x1: footRight - box.left, y: sy - box.top, hue: parent.hue, on: branch.has(parent.id) });
    } else {
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
        // A link's underline (solid, not a note's dotted one) is drawn here, as the start of the curve, so the two meet exactly; its own is left out (data-curved).
        if (s.matches(".lnk, .wiki-text a")) lines = [...rects].filter((q) => q.width > 0 && q.bottom > sc.top && q.top < sc.bottom).map((q) => ({ x0: q.left, x1: q.right, y: level(underline(s, q)) }));
      }
      if (sy < sc.top + 2 || sy > sc.bottom - 2 || sx > textRight + 1) {
        lost = true;
        under = undefined;
        const dir = sy > sc.bottom - 2 ? 1 : sy < sc.top + 2 ? -1 : 0;
        if (dir && sc.bottom - sc.top > 40) {
          // Out of sight above or below in its pane: the dotted curve turns at its end toward it, ending at the pane's edge over where it is.
          const hx = Math.max(pbox.left + 40, Math.min(r.right, textRight - 16));
          const edge = dir > 0 ? sc.bottom - 1 : sc.top + 1;
          sy = level(edge - dir * 14);
          hint = { x: hx, y: edge };
          sx = hx + 6;
        } else {
          sx = textRight;
          sy = Math.max(sc.top + 2, Math.min(sc.bottom - 2, sy));
        }
      }
      sy = level(sy);
      if (under) under.y = level(under.y);
      if (under && lines?.length && !lost) {
        under.y = lines[lines.length - 1].y;
        curved.add(s);
      } else lines = undefined;
    }
    if (ruled && feet.has(parent.id) && !rules.get(parent.id)?.includes("tab")) rules.set(parent.id, rules.has(parent.id) ? "head tab" : "tab");
    // A curve that cannot reach its pane (dotted) leaves the pane's own rule as it is.
    if (lost && rule) {
      rule = undefined;
      rules.delete(x.node.id);
      tabbed.delete(x.node.id);
    }
    const gutter = colEls.indexOf(ccol);
    edges.push({ from: parent.id, to: x.node.id, gutter, left: left - box.left, sx: sx - box.left, sy: sy - box.top, under: under && { x: under.x - box.left, y: under.y - box.top }, hint: hint && { x: hint.x - box.left, y: hint.y - box.top }, lines: lines?.map((q) => ({ x0: q.x0 - box.left, x1: q.x1 - box.left, y: q.y - box.top })), textRight: textRight - box.left, ex: ex - box.left, ey: ey - box.top, on: branch.has(x.node.id) && branch.has(parent.id), lost, hue: x.node.hue, rule: rule && { x0: rule.x0 - box.left, x1: rule.x1 - box.left } });
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
  const fx = (n: number) => Math.round(n * 1000) / 1000;
  const out: { key: string; from: number; to: number; lane: number; cls: string; d: string; hue: string }[] = [];
  // The active pane's edges (left, foot, right), where they show: in the stronger ink, a hairline each.
  const act = el.querySelector<HTMLElement>(".pane.active");
  if (act) {
    const r = act.getBoundingClientRect();
    const col = act.parentElement!;
    const c = col.getBoundingClientRect();
    const next = col.classList.contains("crowded") ? ((act.nextElementSibling as HTMLElement | null)?.getBoundingClientRect().top ?? Infinity) : Infinity;
    const cover = (col.nextElementSibling as HTMLElement | null)?.getBoundingClientRect().left ?? Infinity;
    const h = wd / dpr / 2;
    const top = Math.max(r.top, c.top) + 3;
    const bottom = Math.min(r.bottom, next, c.bottom);
    const x0 = Math.round(r.left * dpr) / dpr + h;
    const right = Math.min(r.right, cover);
    const x1 = Math.round(right * dpr) / dpr - h;
    const yb = Math.round(bottom * dpr) / dpr - h;
    if (bottom > top) {
      const d = right < r.right - 1 ? `M${fx(x0 - box.left)} ${fx(top - box.top)}V${fx(yb - box.top)}H${fx(right - box.left)}` : `M${fx(x0 - box.left)} ${fx(top - box.top)}V${fx(yb - box.top)}H${fx(x1 - box.left)}V${fx(top - box.top)}`;
      out.push({ key: "frame", from: Number(act.dataset.tid), to: -1, lane: -1, cls: "frame", d, hue: "" });
    }
  }
  for (const [id, f] of feet) if (!tabbed.has(id)) out.push({ key: `foot:${id}`, from: id, to: -1, lane: -1, cls: f.on ? "foot on" : "foot", d: `M${fx(f.x0)} ${fx(f.y)}H${fx(f.x1)}`, hue: f.hue === undefined ? "" : String(f.hue) });
  edges.sort((a, b) => Number(a.on) - Number(b.on));
  for (const e of edges) {
    const i = lane.get(e)!;
    // Lane 0 is nearest the panes, the last nearest the column's edge.
    const g = e.left + LANE_LAST - i * LANE_PITCH;
    const dy = e.ey - e.sy;
    let d: string;
    // A link's underline, its lines in turn, the last running on into the step down to the lead-out.
    const lastLine = e.lines?.[e.lines.length - 1];
    const underPath = e.under && (lastLine ? e.lines!.slice(0, -1).map((q) => `M${fx(q.x0)} ${fx(q.y)}H${fx(q.x1)}`).join("") + `M${fx(lastLine.x0)} ${fx(e.under.y)}H${fx(e.under.x)}` : `M${fx(e.under.x)} ${fx(e.under.y)}`);
    const join = e.under
      ? `${underPath}C${fx((e.under.x + e.sx) / 2)} ${fx(e.under.y)} ${fx((e.under.x + e.sx) / 2)} ${fx(e.sy)} ${fx(e.sx)} ${fx(e.sy)}`
      : e.hint
        ? `M${fx(e.hint.x)} ${fx(e.hint.y)}V${fx(e.sy + Math.sign(e.hint.y - e.sy) * 6)}Q${fx(e.hint.x)} ${fx(e.sy)} ${fx(e.sx)} ${fx(e.sy)}`
        : `M${fx(e.sx)} ${fx(e.sy)}`;
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
    // On into the rule: one path, so one stroke (where its foot runs back under the turn, a stroke covers once).
    if (e.rule) d += e.rule.x0 < e.ex - 0.01 ? `M${fx(e.rule.x0)} ${fx(e.ey)}H${fx(e.rule.x1)}` : `H${fx(e.rule.x1)}`;
    out.push({ key: `${e.from}>${e.to}`, from: e.from, to: e.to, lane: i, cls: `${e.on ? "on" : ""}${e.lost ? " lost" : ""}`, d, hue: e.hue === undefined ? "" : String(e.hue) });
  }
  // What peeks out, and the selection bar, leave their places clear of the curves (holes in a mask), but for the curves that belong to what peeks.
  const peeked = [...el.querySelectorAll<HTMLElement>("[data-peek]")];
  const local = (r: DOMRect) => ({ x: r.left - box.left, y: r.top - box.top, w: r.width, h: r.height });
  const holes = peeked.map((p) => local(p.getBoundingClientRect()));
  const bar = el.querySelector<HTMLElement>(".pane > .selbar");
  const barHole = bar && bar.style.visibility !== "hidden" ? [local(bar.getBoundingClientRect())] : [];
  const owned = (id: number) => {
    const p = els.get(id);
    return !!p && peeked.some((q) => q.contains(p));
  };
  const { under, over } = layers(svg, area, [...holes, ...barHole], barHole);
  // Each curve keeps its element, changed only where it changed, so only what moved is painted again.
  const had = new Map<string, SVGPathElement>();
  for (const p of svg.querySelectorAll<SVGPathElement>("path")) had.set(p.dataset.key!, p);
  const at = new Map<Element, number>([
    [under, 0],
    [over, 0],
  ]);
  out.forEach((c) => {
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
    if ((p.dataset.hue ?? "") !== c.hue) c.hue ? (p.dataset.hue = c.hue) : delete p.dataset.hue;
    // In drawing order, the focused branch's last, on top; over what peeks if it belongs to it.
    const g = owned(c.from) || owned(c.to) ? over : under;
    const k = at.get(g)!;
    at.set(g, k + 1);
    if (g.children[k] !== p) g.insertBefore(p, g.children[k] ?? null);
  });
  for (const p of had.values()) p.remove();
  for (const s of underlined) if (!curved.has(s)) s.removeAttribute("data-curved");
  for (const s of curved) if (!s.hasAttribute("data-curved")) s.setAttribute("data-curved", "");
  underlined = curved;
  markRuled(els, rules);
}

/**
 * The curves' two layers: those under what peeks (with holes where it is, and where the selection
 * bar is), and those over it (its own; a hole only for the bar). Made once; the holes kept as asked.
 */
function layers(svg: SVGSVGElement, area: DOMRect, holes: { x: number; y: number; w: number; h: number }[], barHoles: { x: number; y: number; w: number; h: number }[]) {
  const NS = "http://www.w3.org/2000/svg";
  let defs = svg.querySelector("defs");
  if (!defs) {
    defs = document.createElementNS(NS, "defs");
    for (const id of ["ie-curve-holes", "ie-curve-bar"]) {
      const m = document.createElementNS(NS, "mask");
      m.id = id;
      m.setAttribute("maskUnits", "userSpaceOnUse");
      defs.appendChild(m);
    }
    const clip = document.createElementNS(NS, "clipPath");
    clip.id = "ie-curve-area";
    clip.appendChild(document.createElementNS(NS, "rect"));
    defs.appendChild(clip);
    svg.prepend(defs);
    const shown = document.createElementNS(NS, "g");
    shown.setAttribute("clip-path", "url(#ie-curve-area)");
    svg.appendChild(shown);
    for (const c of ["under", "over"]) {
      const g = document.createElementNS(NS, "g");
      g.setAttribute("class", c);
      shown.appendChild(g);
    }
  }
  // Only over the strip.
  const r = svg.querySelector("#ie-curve-area rect")!;
  for (const [k, v] of Object.entries({ x: area.left, y: area.top, width: area.width, height: area.height })) if (r.getAttribute(k) !== String(v)) r.setAttribute(k, String(v));
  const under = svg.querySelector<SVGGElement>("g.under")!;
  const over = svg.querySelector<SVGGElement>("g.over")!;
  const fill = (id: string, g: SVGGElement, hs: typeof holes) => {
    const m = svg.querySelector<SVGMaskElement>(`#${id}`)!;
    const key = hs.map((h) => [h.x, h.y, h.w, h.h].map(Math.round).join(",")).join(";");
    if (m.dataset.key === key) return;
    m.dataset.key = key;
    if (!hs.length) {
      g.removeAttribute("mask");
      m.replaceChildren();
      return;
    }
    const all = document.createElementNS(NS, "rect");
    for (const [k, v] of Object.entries({ x: "-10", y: "-10", width: "100000", height: "100000", fill: "white" })) all.setAttribute(k, v);
    const cut = hs.map((h) => {
      const r = document.createElementNS(NS, "rect");
      for (const [k, v] of Object.entries({ x: h.x, y: h.y, width: h.w, height: h.h, fill: "black" })) r.setAttribute(k, String(v));
      r.setAttribute("class", "hole");
      return r;
    });
    m.replaceChildren(all, ...cut);
    g.setAttribute("mask", `url(#${id})`);
  };
  fill("ie-curve-holes", under, holes);
  fill("ie-curve-bar", over, barHoles);
  return { under, over };
}

/** A pane's own head, whose rule a curve into it lands in: a section's, a page's title, an article's (not an article set under a node). */
const HEADS = ":scope > .pane-scroll > .pane-body > .pane-head, :scope > .pane-scroll > .pane-body > .top, :scope > .pane-scroll > .pane-body > .wiki:not(.embedded) > .wiki-head";

/** Which panes' rules a curve draws (head or tab), so that their own are left out. */
function markRuled(els: Map<number, HTMLElement>, rules: Map<number, string>) {
  for (const [id, p] of els) {
    const v = rules.get(id);
    if ((p.getAttribute("data-ruled") ?? undefined) !== v) v ? p.setAttribute("data-ruled", v) : p.removeAttribute("data-ruled");
  }
}
