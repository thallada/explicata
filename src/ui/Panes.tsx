/**
 * The panes view: panes side by side, in the manner of Andy Matuschak's notes. It starts as the
 * path down from the top node; a link followed from a pane opens its target in the next pane
 * (a node from anywhere in the library, a Wikipedia article or a web page, a section of one), replacing what was to the
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
import { ancestors, label, sections, staleness, type NodeId } from "../core/model";
import { LANES, LANE_FIRST, LANE_LAST, LANE_PITCH, laneOrder } from "./lanes";
import { ACROSS, DOWN, crowds, fill, fit, folded, mark, offsets, release, resize, reveal, setAttr, share, starts, stick, unmark, whole } from "./stack";
import { NodeBacklinks, NodeRelated, PaneCtx, TargetRow } from "./Links";
import { pageAt, paneOfPage } from "./pages";
import { Close, Pin, U, W } from "./Pages";
import { Abstract, Flags, NodeBody, PendingSections, Row, TitleEditor, TopMatter, isPrompt } from "./Node";
import { kidClass, refKey, store, type Aux, type Pane as PaneNode, type PaneRef } from "./store";
import { WikiView } from "./Wiki";
import { ArticleView, WebView } from "./Web";
import { article } from "./wiki";
import { article as webArticle, siteOf } from "./web";

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
    if (next.p.kind !== "node") return true;
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
    return <PaneCtx.Provider value={this.props.t.id}>{p.kind === "node" ? <NodePane {...this.props} id={p.id} /> : p.kind === "web" ? <WebPane {...this.props} /> : <WikiPane {...this.props} />}</PaneCtx.Provider>;
  }
}

/** Sent when something the curves are drawn from changes without a render or a scroll: a pane's tab coming or going, the selection bar moving. */
export const GEOMETRY = "ie:geometry";

/**
 * A pane scrolled past its title shows its tab at its top, as a folded one does (data-scrolled): an
 * observer on the title's rule, against the pane's own scroll box less the tab, so nothing is done
 * per scroll or per key, and the tab comes exactly as the rule goes under it.
 */
const watched = new Map<number, { io: IntersectionObserver; target: Element; tab: number }>();
function watchHead(tid: number) {
  const pane = document.querySelector<HTMLElement>(`.strip .pane[data-tid="${tid}"]`);
  if (!pane || typeof IntersectionObserver === "undefined") return;
  const scroll = pane.querySelector<HTMLElement>(":scope > .pane-scroll");
  const target = ruleOf(pane);
  const w = watched.get(tid);
  if (w && w.target === target && w.tab === TAB) return;
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
  watched.set(tid, { io, target, tab: TAB });
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
  const close = () => (
    <span role="button" class="pane-btn close" data-close={tid} title="Close this pane and what was opened from it (q)" aria-label="Close">
      <Close />
    </span>
  );
  return (
    <>
      <div class="spine" data-spine={props.index} title={title}>
        {close()}
        <span class="spine-title">
          {mark}
          {mark && " "}
          {title}
        </span>
      </div>
      <div class="grip" data-grip={tid} title="Drag to move this pane up or down its column (on a phone, hold it first; dragged at once, it resizes the pane)" onTouchMove={onHandleMove} />
      <div class="tabline" data-spine={props.index} title={title} onTouchMove={onHandleMove}>
        {mark}
        <span class="tabtitle">{title}</span>
      </div>
      <div class="pane-ctl">
        <span role="button" class="pane-btn more" data-more="pane" aria-haspopup="menu" title="More for this pane (right-click works too)" aria-label="More">
          ⋯
        </span>
        <span role="button" class={`pane-btn pin${pinned ? " on" : ""}`} data-pin={tid} title={pinned ? "Unpin this pane (P)" : "Pin this pane: it stays when what opened it closes, and never folds away (P)"} aria-label={pinned ? "Unpin" : "Pin"}>
          <Pin />
        </span>
        {close()}
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
  // The first pane is the page, headed like the column's page (crumbs, byline, its ⋯); every other
  // pane has a section's head, whatever node it shows.
  const top = props.root && id === store.top;
  const kids = sections(snap, id);
  const focused = active && !store.aux && store.focus.node === id;
  const editing = store.edit?.node === id && store.edit.field === "title";
  const jump = !props.root && !props.orphan && !store.continuesFrom(props.p, parent);
  // Its children open to the right: the picked one's row is marked as showing; other forks' rows as forked.
  const kid = t.kids[t.pick];
  const showing = kid?.ref.kind === "node" && store.continuesFrom(kid.ref, props.p) ? kid.ref.id : undefined;
  const forked = new Set(t.kids.flatMap((k, j) => (j !== t.pick && k.ref.kind === "node" && store.continuesFrom(k.ref, props.p) ? [k.ref.id] : [])));
  // A section that is only a link is shown as its article: the pane reads as an article pane (one
  // head, the article's; its ground), and the node's own commands are on that head and on its row.
  if (!top && store.linkOnly(id)) {
    const web = store.isWeb(`n${id}`);
    return (
      <article class={`pane link-pane${web ? " web" : ""}${jump ? " jumped" : ""}${store.preview ? " preview" : ""}${paneClass(props)}`} {...paneAttrs(props, id)}>
        <Chrome props={props} title={label(snap, id)} mark={web ? <U /> : <W />} />
        <div class="pane-scroll">
          <div class="pane-body">
            <Orphaned on={props.orphan} />
            {jump && <div class="pane-from">{ancestors(snap, id).reverse().map((a) => label(snap, a)).join(" › ")}</div>}
            {editing && (
              <div class="link-rename" data-node={id}>
                <TitleEditor id={id} />
              </div>
            )}
            <ArticleView host={`n${id}`} own headFocused={focused} />
            <NodeBacklinks id={id} />
            <NodeRelated id={id} />
          </div>
        </div>
      </article>
    );
  }
  return (
    <article
      class={`pane${top ? " root" : ""}${jump ? " jumped" : ""}${n.kind === "note" ? " note-pane" : ""}${store.preview ? " preview" : ""}${paneClass(props)}`}
      {...paneAttrs(props, id)}
    >
      <Chrome props={props} title={label(snap, id)} />
      <div class="pane-scroll">
        <div class="pane-body">
          <Orphaned on={props.orphan} />
          {top ? (
            <TopMatter id={id} />
          ) : (
            <>
              {/* A pane opened by a jump (a link, a search) says where its node is: the titles above it. */}
              {jump && <div class="pane-from">{ancestors(snap, id).reverse().map((a) => label(snap, a)).join(" › ")}</div>}
              <header class={`pane-head${focused ? " focused" : ""}`} data-node={id}>
                {editing ? <TitleEditor id={id} /> : <h2>{n.title || (n.kind === "note" ? label(snap, id) : <i class="untitled">untitled</i>)}</h2>}
                <Flags id={id} />
              </header>
              {isPrompt(snap, id) ? <Abstract id={id} /> : <NodeBody id={id} />}
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
          {store.articleUnder(id) ? <ArticleView host={`n${id}`} /> : <TargetRow id={id} />}
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
      <Chrome props={props} title={title} mark={<W />} />
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

/** A web page's pane: an article pane with the page's view in it (Web.tsx). */
function WebPane(props: PaneProps) {
  const { p, index } = props;
  if (p.kind !== "web") return null;
  const a = webArticle(p.url);
  const sec = p.sec && a.state === "ready" ? a.value.sections.find((x) => x.id === p.sec) : undefined;
  const page = a.state === "ready" ? a.value.title : siteOf(p.url);
  const title = sec ? `${sec.heading} · ${page}` : page;
  return (
    <article class={`pane wiki-pane web${p.from ? " jumped" : ""}${paneClass(props)}`} {...paneAttrs(props, refKey(p))}>
      <Chrome props={props} title={title} mark={<U />} />
      <div class="pane-scroll">
        <div class="pane-body">
          <Orphaned on={props.orphan} />
          <WebView host={props.off ? `f${props.t.id}` : `p${index}`} />
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

/**
 * As pages, how long the strip takes to glide to a page the page itself goes to (a tap on a row or
 * a link, the trail, the map, Back): short, easing out. The browser's smooth scroll takes twice as
 * long or more, at its own pace; a finger's swipe keeps the browser's own snapping.
 */
const GLIDE_MS = 140;
/** The strip's glide under way: its frame. */
const glides = new WeakMap<HTMLElement, number>();
/** Whether the strip is gliding (its scroll events are its own, not a finger's). */
const gliding = (el: HTMLElement) => glides.has(el);
/** Stop a glide where it is (a finger has touched the strip): the snapping is the browser's again. */
function stopGlide(el: HTMLElement) {
  const f = glides.get(el);
  if (f === undefined) return;
  cancelAnimationFrame(f);
  glides.delete(el);
  el.removeAttribute("data-gliding");
}
/** Glide the strip to a scroll offset, easing out (a cubic), without snapping on the way (data-gliding), landing exactly there. */
function glideTo(el: HTMLElement, to: number, done: () => void) {
  stopGlide(el);
  const from = el.scrollLeft;
  if (Math.abs(to - from) < 1) return void ((el.scrollLeft = to), done());
  el.setAttribute("data-gliding", "");
  let t0 = -1;
  const step = (now: number) => {
    if (t0 < 0) t0 = now - 1000 / 60;
    const p = Math.min(1, (now - t0) / GLIDE_MS);
    el.scrollLeft = from + (to - from) * (1 - (1 - p) ** 3);
    if (p < 1) return void glides.set(el, requestAnimationFrame(step));
    glides.delete(el);
    el.removeAttribute("data-gliding");
    done();
  };
  glides.set(el, requestAnimationFrame(step));
}

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
  const rule = ruleOf(p)?.getBoundingClientRect();
  if (!rule) return false;
  const r = p.getBoundingClientRect();
  const sc = p.querySelector<HTMLElement>(":scope > .pane-scroll")!.getBoundingClientRect();
  return rule.bottom > Math.max(r.top, col.top, sc.top) + TAB && rule.bottom <= Math.min(next, col.bottom, sc.bottom);
}

/** The least height a pane keeps in a column while all its panes fit; below it, the column stacks them. */
const PANE_MIN = 260;
/** A covered pane's tab, the strip a pane leaves down a crowded column (as a spine does across): as pages, a finger's height (PAGE_TAB). Set as the panes are drawn. */
let TAB = 30;
const DESK_TAB = 30;
const PAGE_TAB = 44;
/** As pages, how long a finger is held still on a pane's tab or the band above its title to pick the pane up. */
const HOLD_MS = 380;
/** The touch drag's move handler (Panes' effect sets it); the handles call it from their own, blocking, touchmove listeners. */
let handleMove: ((e: TouchEvent) => void) | null = null;
const onHandleMove = (e: TouchEvent) => handleMove?.(e);
/** How long the mouse rests on a covered pane before it peeks out. */
const PEEK_MS = 200;

/** As pages, how far a finger moves on a pane's handle before its direction is known: up or down resizes the pane, sideways is the browser's (the page turns). */
const LOCK_PX = 8;
/** A pane sized by hand left less than this much taller than its tab folds to it when the finger lifts (side by side, the mouse lets go). */
const FOLD_SNAP = 40;
/** How long a released edge takes to come to rest at a fold, easing out. */
const SNAP_MS = 120;
/** As pages, two taps on a pane's handle this close together put its page back to the automatic sizes. */
const DOUBLE_TAP_MS = 320;

/**
 * As pages, a page sized by hand (Panes' touch handlers, stack.ts `resize`): each pane's height
 * by its id, the panes it holds (their ids, sorted), and the pane looked at there. By column. The
 * sizes hold while the same panes are on the page and the pane looked at is one shown open; when
 * another pane there becomes the one looked at while folded to its tab (a tap on its tab, the trail,
 * the map, the keys), when a pane opens or closes there, or on a double tap on a handle, the page
 * is laid out automatically again.
 */
interface Hand {
  set: string;
  sizes: Map<number, number>;
  here: number | undefined;
}
/**
 * The columns sized by hand, as pages and as panes side by side (by the mouse, an edge between two
 * panes dragged; there `here` is the active pane when they were sized, and the rule is `deskSizes`'s).
 * Kept apart, so a phone turned wide and back finds its pages as it left them.
 */
const handsBy = { pages: new Map<number, Hand>(), panes: new Map<number, Hand>() };
const hands = () => (store.pages ? handsBy.pages : handsBy.panes);
/** The page (side by side, the column) whose released edge is easing to rest: laid out by its animation alone meanwhile. */
let easing: HTMLElement | null = null;
const setOf = (tids: number[]) => [...tids].sort((a, b) => a - b).join();

/** Sizes by hand fitted to a column of height h (and kept so); null if a tab each does not fit. */
function fitHand(m: Hand, tids: number[], h: number): number[] | null {
  const hs = tids.map((t) => m.sizes.get(t) ?? TAB);
  if (Math.abs(hs.reduce((a, b) => a + b, 0) - h) < 0.5) return hs;
  const f = fit(hs, h, TAB);
  if (f) tids.forEach((t, i) => m.sizes.set(t, f[i]));
  return f;
}

/** As pages, a column's sizes by hand, fitted to its height, if they hold (else they are dropped). */
function handSizes(col: number, tids: number[], here: number | undefined, h: number): number[] | null {
  const m = handsBy.pages.get(col);
  if (!m) return null;
  const drop = () => (handsBy.pages.delete(col), null);
  if (m.set !== setOf(tids)) return drop();
  if (here !== m.here) {
    if (here === undefined || folded(m.sizes.get(here) ?? 0, TAB)) return drop();
    m.here = here;
  }
  return fitHand(m, tids, h) ?? drop();
}

/**
 * As panes side by side, a column's sizes by hand: only a pinned pane's size sticks. Once another
 * pane is the active one, or a pane opens or closes in the column, the sizes of its unpinned panes
 * are the layout's again (undefined here: `share` gives them what the pinned ones leave) and, with
 * no pinned pane sized there, so is the column (null). Fitted to its height while they hold.
 */
function deskSizes(col: number, tids: number[], pinned: boolean[], active: number | undefined, h: number): (number | undefined)[] | null {
  const m = handsBy.panes.get(col);
  if (!m) return null;
  const drop = () => (handsBy.panes.delete(col), null);
  if (m.here !== active || m.set !== setOf(tids)) {
    m.here = active;
    m.set = setOf(tids);
    for (const t of [...m.sizes.keys()]) if (!pinned[tids.indexOf(t)]) m.sizes.delete(t);
    if (!m.sizes.size) return drop();
  }
  if (tids.some((t) => !m.sizes.has(t))) return tids.map((t) => m.sizes.get(t));
  return fitHand(m, tids, h) ?? drop();
}

/**
 * As panes side by side, columns sized by hand (the edge between two dragged, stack.ts `resize`
 * across): each column's width by its number, and the active pane when they were set. A column
 * holding a pinned pane keeps its width; the others' are the layout's again once another pane is
 * the active one.
 */
const widths = { sizes: new Map<number, number>(), here: undefined as number | undefined };
/** The least width a column is dragged to. */
const COL_MIN = 240;
/** As panes side by side, how near an edge between two panes, or two columns, the mouse takes it (each side). */
const EDGE_PX = 4;

/** Set the panes' heights, and show the tab of each folded to it. Only heights: nothing is measured. */
function setHeights(ps: HTMLElement[], hs: number[]) {
  ps.forEach((p, i) => {
    const v = `${hs[i]}px`;
    if (p.style.height !== v) p.style.height = v;
    setAttr(p, "data-tab", folded(hs[i], TAB));
  });
}

/** Lay a column out by hand: its panes one under another at these heights, filling it; nothing stacked, nothing stuck. */
function sizeBy(c: HTMLElement, ps: HTMLElement[], hs: number[]) {
  if (!c.classList.contains("sized")) {
    c.classList.add("sized");
    c.classList.remove("crowded");
    unmark(ps);
  }
  for (const p of ps) {
    if (p.style.top) p.style.top = "";
    if (p.style.bottom) p.style.bottom = "";
    if (p.style.flex !== "none") p.style.flex = "none";
  }
  setHeights(ps, hs);
  if (c.scrollTop) c.scrollTop = 0;
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
  /** As pages (pages.ts): one column at a time, each a page as wide as the strip, swiped from one to the next. */
  const pages = store.pages;
  TAB = pages ? PAGE_TAB : DESK_TAB;
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
  /** As pages: the strip is being scrolled to the active pane's page by the page itself, not a finger. */
  const programmatic = useRef(false);
  /** As pages: the next scroll to the active pane's page is at once (the window changed size, or the layout became pages). */
  const instant = useRef(true);
  /** The follow of the latest render (the swipe handlers use it). */
  const followNow = useRef<() => void>(() => {});
  /** As pages: a finger is on the strip. */
  const fingers = useRef(false);
  /** The layout last drawn: pages or side by side. */
  const wasPages = useRef<boolean | null>(null);

  const branch = store.branchNodes;
  const onBranch = new Set(branch.map((n) => n.id));
  const activeId = branch[store.paneAt]?.id;
  const cols = store.paneColumns;
  const order = [...cols.keys()].sort((a, b) => a - b);

  /**
   * Lay out the stacks (stack.ts). Across: each column stuck a spine after the one before (a pinned
   * pane's column, its whole width). Down: a column with several panes divides its height among
   * them, a pane taking what its text needs; when they do not all fit, or a share would cut short
   * the active pane (as pages, the pane looked at on the page), it becomes a stack of its own, each
   * pane stuck a tab below the one before (a pinned one, its height) and the column scrolled to
   * show whole the pane on the focused branch, or the one last on it there.
   */
  const layout = (all = false) => {
    const el = strip.current;
    if (!el) return;
    const colEls = [...el.children].filter((c): c is HTMLElement => c.classList.contains("col"));
    if (!colEls.length) return;
    clearTimeout(later.current);
    const activeCol = activeId === undefined ? null : paneEls(el).get(activeId)?.parentElement;
    const spine = colEls[0].querySelector<HTMLElement>(".spine")?.offsetWidth ?? 0;
    // With no scrollbar under the panes (none needed, or one drawn over them) their last bottom edge meets the status line's: one line, not two.
    setAttr(el, "data-flush", el.offsetHeight - el.clientHeight < 1);
    if (pages) {
      // As pages nothing is stacked across: each column is a page of its own, as wide as the screen.
      lefts.current = colEls.map(() => 0);
      for (const c of colEls) {
        if (c.style.left) c.style.left = "";
        if (c.style.width) c.style.width = "";
      }
    } else {
      // Widths by hand: a column holding a pinned pane keeps its own; the others', once another pane is the active one, are the layout's again.
      const at = new Set(colEls.map((c) => Number(c.dataset.col)));
      const keep = new Set(colEls.filter((c) => c.hasAttribute("data-pinned")).map((c) => Number(c.dataset.col)));
      const moved = widths.here !== activeId;
      widths.here = activeId;
      for (const k of [...widths.sizes.keys()]) if (!at.has(k) || (moved && !keep.has(k))) widths.sizes.delete(k);
      for (const c of colEls) {
        const by = widths.sizes.get(Number(c.dataset.col));
        const v = by === undefined ? "" : `${by}px`;
        if (c.style.width !== v) c.style.width = v;
      }
      lefts.current = offsets(
        colEls.map((c) => c.offsetWidth),
        colEls.map((c) => c.hasAttribute("data-pinned")),
        spine,
        el.clientWidth,
      );
      stick(colEls, lefts.current, ACROSS);
    }
    let deferred = false;
    for (const c of colEls) {
      const ps = [...c.children].filter((p): p is HTMLElement => p.classList.contains("pane"));
      const col = Number(c.dataset.col);
      if (ps.length < 2) {
        for (const p of ps) if (p.style.height) (p.style.height = ""), (p.style.flex = ""), (p.style.top = ""), (p.style.bottom = "");
        c.classList.remove("crowded", "sized", "tight");
        unmark(ps);
        // Side by side, a pane alone in its column has no edge to have been sized by.
        if (!pages) handsBy.panes.delete(col);
        continue;
      }
      const h = c.clientHeight;
      const tids = ps.map((p) => Number(p.dataset.tid));
      // The pane to show whole: on the focused branch, or the one last on it here.
      const here = paneOfPage(tids, onBranch, lastIn.current.get(col))!;
      const pinned = ps.map((p) => p.classList.contains("pinned"));
      const sig = tids.map((t, i) => `${t}${pinned[i] ? "^" : ""}`).join();
      // As pages, a page too short for a tab for each of its panes is never sized by hand (its handles scroll it).
      c.classList.toggle("tight", pages && ps.length * TAB > h);
      /** What each pane needs to show all it holds; a buried pane is not laid out, so it keeps what it last needed. */
      const measureNeeds = () => {
        const cs = getComputedStyle(ps[0].querySelector<HTMLElement>(".pane-scroll")!);
        const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + 1;
        return ps.map((p, i) => {
          if (p.hasAttribute("data-buried") && needs.current.has(tids[i])) return needs.current.get(tids[i])!;
          const n = p.querySelector<HTMLElement>(".pane-body")!.offsetHeight + pad;
          needs.current.set(tids[i], n);
          return n;
        });
      };
      // The pane looked at, which a share must not cut short: as pages the page's; side by side the active pane, in its column (elsewhere none: those columns share as they will).
      const k = tids.indexOf(here);
      const first = pages || here === activeId ? k : undefined;
      // Sized by hand (as pages a pane's handle dragged, side by side an edge): those sizes, while they hold; side by side, the panes not pinned share what the pinned ones leave, the active one first.
      const by: (number | undefined)[] | null = pages ? handSizes(col, tids, here, h) : deskSizes(col, tids, pinned, activeId, h);
      const hand = by?.includes(undefined) ? share(by, measureNeeds(), h, TAB, first) : (by as number[] | null);
      if (by && !hand) handsBy.panes.delete(col);
      if (hand) {
        if (easing !== c) sizeBy(c, ps, hand);
        laid.current.set(c, sig);
        shown.current.set(c, here);
        continue;
      }
      c.classList.remove("sized");
      const need = measureNeeds();
      // The pane looked at has the column's height whenever a share would cut it short (as pages, the screen's): the others fold to their tabs.
      const crowded = crowds(h, need, PANE_MIN, first);
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
      const st = starts(heights);
      const want = crowded ? reveal(c.scrollTop, h - below[k], st[k], heights[k], tops[k], st[st.length - 1] + heights[heights.length - 1] - h) : 0;
      // As the focus moves, the active pane's column scrolls at once and the others once the keys pause (each brings whole panes into view, which costs a frame's painting); any other change, at once.
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
      later.current = setTimeout(relayout, 150);
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
    if (store.pages) unmark(colEls);
    else mark(el, colEls, ACROSS, false, colEls[0]?.querySelector<HTMLElement>(".spine")?.offsetWidth ?? 0);
    for (const c of colEls) {
      const ps = [...c.querySelectorAll<HTMLElement>(":scope > .pane")];
      // Sized by hand: its tabs are those panes folded (sizeBy).
      if (c.classList.contains("sized")) continue;
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
    const showing = store.showingFocus() || (a0?.kind === "wiki" && a0.row.t === "sec" && !!next && next.kind !== "node" && next.sec === a0.row.id);
    if (store.mode !== "edit") {
      const pane = panes[at];
      nearestY(pane?.querySelector(".sel, .wfocus, .node.focused > .row, .wrow.focused > .row, .backlinks li.focused, .target-row.focused, .wiki-head.focused, .pane-head.focused, .focused"));
    }
    const colEls = [...el.querySelectorAll<HTMLElement>(":scope > .col")];
    const colOf = (p: HTMLElement | undefined) => (p ? colEls.indexOf(p.parentElement as HTMLElement) : -1);
    if (store.pages) {
      // As pages: the page on screen is the active pane's column, whole.
      const c = colOf(panes[at]);
      lastCol.current = c;
      if (c < 0) return;
      const target = Math.min(c * el.clientWidth, el.scrollWidth - el.clientWidth);
      const now = instant.current;
      instant.current = false;
      if (Math.abs(target - el.scrollLeft) > 1) {
        // Not under a finger: where the strip comes to rest decides (the swipe's handlers).
        if (fingers.current) return;
        programmatic.current = !now;
        if (now || reducedMotion()) (stopGlide(el), (el.scrollLeft = target));
        // Landed where it was sent: the scroll was the page's, and is over.
        else glideTo(el, target, () => (programmatic.current = false));
      }
      return;
    }
    // Each column's width (one sized by hand has its own), and where it starts when nothing is stuck.
    const w = colEls.map((c) => c.offsetWidth);
    const x = starts(w);
    const view = el.clientWidth;
    const max = el.scrollWidth - view;
    const L = lefts.current;
    const b = colOf(panes[Math.min(panes.length - 1, showing ? at + 1 : at)]);
    if (b < 0) return;
    const here = colOf(panes[at]);
    const was = lastCol.current;
    lastCol.current = here;
    if (here === was && whole(el.scrollLeft, view, x[b], w[b], L[b] ?? 0)) return;
    // Show b whole, and the one before it too when both fit.
    const a = b > 0 && (showing || f.grain === "node") ? b - 1 : b;
    const both = reveal(el.scrollLeft, view, x[a], x[b] + w[b] - x[a], L[a] ?? 0, max);
    const target = whole(both, view, x[b], w[b], L[b] ?? 0) && whole(both, view, x[a], w[a], L[a] ?? 0) ? both : reveal(el.scrollLeft, view, x[b], w[b], L[b] ?? 0, max);
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
  /** Lay out every column again, measure, and draw. */
  const relayout = () => {
    latest.current(true);
    measure();
    schedule();
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
  followNow.current = follow;
  useLayoutEffect(() => {
    if (wasPages.current !== pages) {
      // The layout changed (the window crossed PANES_MIN_WIDTH): the same panes, laid out again, the active pane's column shown at once.
      wasPages.current = pages;
      instant.current = true;
      followed.current = "";
      lastCol.current = -1;
    }
    sources();
    layout();
    follow();
    measure();
    schedule();
    if (typeof ResizeObserver !== "undefined") {
      bodies.current ??= new ResizeObserver(relayout);
      for (const b of strip.current?.querySelectorAll(".pane-body") ?? []) if (!watchedBodies.current.has(b)) (watchedBodies.current.add(b), bodies.current.observe(b));
    }
    // As pages, a step from pane to pane is a step in the browser's history.
    if (pages) store.trackPane();
  });

  useEffect(() => {
    const el = strip.current!;
    const wrap = el.parentElement!;
    // Every listener added below goes when the panes do.
    const ac = new AbortController();
    const signal = ac.signal;
    /*
     * As pages, a swipe ends on a page: its pane becomes the active one (the one on the focused
     * branch there, else the one last on it, else the first), so the page on screen is always the
     * active pane's column. Read once the scroll has come to rest (scrollend, or a pause where the
     * browser has none), never per frame.
     */
    let rest: ReturnType<typeof setTimeout> | undefined;
    const settle = () => {
      clearTimeout(rest);
      if (!store.pages || gliding(el)) return;
      if (fingers.current) return void (rest = setTimeout(settle, 120));
      const colEls = [...el.querySelectorAll<HTMLElement>(":scope > .col")];
      const c = colEls[pageAt(el.scrollLeft, el.clientWidth, colEls.length)];
      const ours = programmatic.current;
      programmatic.current = false;
      if (!c) return;
      const ids = [...c.querySelectorAll<HTMLElement>(":scope > .pane")].map((p) => Number(p.dataset.tid));
      const active = store.branchNodes[store.paneAt]?.id;
      if (active !== undefined && ids.includes(active)) return;
      // A scroll the page made that ended elsewhere (the active pane changed meanwhile): to the active pane's page.
      if (ours) {
        followed.current = "";
        return followNow.current();
      }
      const id = paneOfPage(ids, new Set(store.branchNodes.map((n) => n.id)), lastIn.current.get(Number(c.dataset.col)));
      if (id !== undefined) store.toPane(id);
    };
    const ends = "onscrollend" in window;
    const onTouch = (e: TouchEvent) => {
      fingers.current = e.type === "touchstart" || e.touches.length > 0;
      // A finger on the strip takes it from a glide, where it is.
      if (e.type === "touchstart") (stopGlide(el), (programmatic.current = false));
    };
    el.addEventListener("touchstart", onTouch, { passive: true, signal });
    // Its end heard on the window: a touch whose target leaves the page (a pane that closed) ends there too.
    window.addEventListener("touchend", onTouch, { passive: true, capture: true, signal });
    window.addEventListener("touchcancel", onTouch, { passive: true, capture: true, signal });
    if (ends) el.addEventListener("scrollend", settle, { signal });
    const onScroll = (e: Event) => {
      const t = e.target as HTMLElement;
      if (t === el && store.pages) {
        // Only when the swipe has ended; nothing is measured while it moves.
        if (!ends) (clearTimeout(rest), (rest = setTimeout(settle, 150)));
        return;
      }
      // The strip, a crowded column, or a pane in one (whose title's rule may come or go under its tab).
      if (t === el || t.classList?.contains("col") || t.parentElement?.parentElement?.classList.contains("crowded")) measure();
      // A scroll inside what peeks (the wheel over it) keeps it out; any other moves things from under it.
      if (peeked.length && !peeked.some((p) => p !== t && p.contains(t)) && !(t === peeked[0] && peeked.length === 1 && !t.classList.contains("pane"))) hide();
      schedule();
    };
    const onResize = () => {
      latest.current(true);
      followed.current = "";
      instant.current = true;
      followNow.current();
      measure();
      schedule();
    };
    // Panes and crowded columns scroll on their own: their scroll events are caught on the way down.
    wrap.addEventListener("scroll", onScroll, { passive: true, capture: true, signal });
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
    window.addEventListener(GEOMETRY, schedule, { signal });
    wrap.addEventListener("transitionrun", onRun, { signal });
    wrap.addEventListener("transitionend", onEnd, { signal });
    wrap.addEventListener("transitioncancel", onEnd, { signal });
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
    /** Where in its column a pane may peek while the others keep their tabs: below a tab for each pane above it, above a tab for each below. */
    const tabRoom = (pane: HTMLElement) => {
      const col = pane.parentElement as HTMLElement;
      const c = col.getBoundingClientRect();
      const ps = [...col.children].filter((p) => p.classList.contains("pane"));
      const i = ps.indexOf(pane);
      return { top: c.top + i * TAB, bottom: c.bottom - (ps.length - 1 - i) * TAB };
    };
    /**
     * How tall a pane would be shown at its fullest, if it is cut off now (0 if not): what its text
     * needs, if that fits in its column; if not (it scrolls however tall it is), the column less a tab
     * for each other pane, so a pane given that already does not cover the others' tabs for a few more
     * lines. Cut off: shown shorter than that for any reason, covered by the pane after it, given too
     * small a share of its column, or running past the column's foot.
     */
    const cutOff = (pane: HTMLElement): number => {
      const col = pane.parentElement as HTMLElement;
      const r = pane.getBoundingClientRect();
      const c = col.getBoundingClientRect();
      const next = col.classList.contains("crowded") ? ((pane.nextElementSibling as HTMLElement | null)?.getBoundingClientRect().top ?? Infinity) : Infinity;
      const shown = Math.max(0, Math.min(r.bottom, c.bottom, next) - Math.max(r.top, c.top));
      const sc = pane.querySelector<HTMLElement>(".pane-scroll")!;
      const cs = getComputedStyle(sc);
      const need = Math.ceil(needs.current.get(Number(pane.dataset.tid)) ?? pane.querySelector<HTMLElement>(".pane-body")!.offsetHeight + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + 1);
      const room = tabRoom(pane);
      const full = need <= Math.floor(c.height) ? need : Math.floor(room.bottom - room.top);
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
          // (Never shorter: a covered pane may be laid out as tall already, and its column's scroll must not move.)
          const full = cutOff(it);
          const h = it.offsetHeight;
          if (full > h) {
            it.style.setProperty("--peek-h", `${full}px`);
            it.style.setProperty("--peek-extra", `${full - h}px`);
            it.setAttribute("data-peek-h", "");
          }
          // Clear of the other panes' tabs, if it fits between them; else anywhere in its column.
          const r = it.getBoundingClientRect();
          const room = tabRoom(it);
          const c = r.height <= room.bottom - room.top + 1 ? room : (it.parentElement as HTMLElement).getBoundingClientRect();
          const dy = Math.max(c.top - r.top, Math.min(0, c.bottom - r.bottom));
          if (dy) it.style.transform = `translateY(${Math.round(dy)}px)`;
        }
      }
      schedule();
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== "mouse" || e.buttons || drag) return;
      // On an edge between panes (below): it is pressed to resize, not peeked through.
      if (wrap.dataset.edge) return unpeek();
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
    el.addEventListener("pointerleave", unpeek, { signal });
    window.addEventListener("keydown", unpeek, { capture: true, signal });

    /*
     * Dragging a pane up or down its column, by its grip (the band above its title, beside the pin
     * and the x) or its tab: a line shows where it will go; Esc cancels. The column's order is then
     * its own (forks.ts `reorder`), kept with the panes. With the mouse (or a pen, or a finger on a
     * wide screen's panes) by pointer events; as pages, by touch, below.
     */
    let drag: { tid: number; col: HTMLElement; y0: number; on: boolean; before: number | null; line: HTMLElement | null; touch?: boolean } | null = null;
    let swallow = false;
    /** The grip or tab pressed, its pane and its column, when the column has other panes to move among. */
    const handleAt = (t: EventTarget | null) => {
      const handle = (t as HTMLElement).closest<HTMLElement>("[data-grip], .tabline");
      const pane = handle?.closest<HTMLElement>(".pane");
      const col = pane?.parentElement;
      return handle && pane && col && col.children.length > 1 ? { handle, pane, col } : null;
    };
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || (e.pointerType === "touch" && store.pages) || edging) return;
      const h = handleAt(e.target);
      if (!h) return;
      const { handle, pane, col } = h;
      drag = { tid: Number(pane.dataset.tid), col, y0: e.clientY, on: false, before: null, line: null };
      handle.setPointerCapture(e.pointerId);
    };
    const startDrag = () => {
      drag!.on = true;
      unpeek();
      wrap.classList.add("dragging");
      drag!.line = document.createElement("div");
      drag!.line.className = "drop-line";
      wrap.appendChild(drag!.line);
    };
    /** Where the dragged pane would go with the pointer at y: the line drawn there. */
    const dropAt = (y0: number) => {
      if (!drag) return;
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
      while (k + 1 < others.length && tops[k + 1] <= y0) k++;
      const at = k < 0 ? 0 : k >= mine || y0 >= ends[k] ? k + 1 : k;
      const i = at < others.length ? at : -1;
      drag.before = i < 0 ? null : Number(others[i].dataset.tid);
      const y = at === 0 ? (tops[0] ?? c.top) : ends[at - 1];
      const box = wrap.getBoundingClientRect();
      Object.assign(drag.line!.style, { left: `${c.left - box.left}px`, width: `${c.width}px`, top: `${Math.round(Math.max(c.top, Math.min(c.bottom - 3, y)) - box.top - 1)}px` });
      // The carried tab rides just above the finger, where it is not under it.
      if (ghost) ghost.style.top = `${Math.round(Math.max(c.top, Math.min(c.bottom - PAGE_TAB, y0 - PAGE_TAB - 18)) - box.top)}px`;
    };
    const onDrag = (e: PointerEvent) => {
      if (!drag || drag.touch) return;
      if (!drag.on) {
        if (Math.abs(e.clientY - drag.y0) < 5) return;
        startDrag();
      }
      dropAt(e.clientY);
    };
    const end = (keep: boolean) => {
      cancelHold();
      if (!drag) return;
      const d = drag;
      drag = null;
      d.line?.remove();
      wrap.classList.remove("dragging");
      ghost?.remove();
      ghost = null;
      cancelAnimationFrame(edge);
      edge = 0;
      for (const p of d.col.querySelectorAll(":scope > .pane[data-lifted]")) p.removeAttribute("data-lifted");
      if (d.on) {
        // The click a mouse's drag ends with is not a click on the pane (a touch drag's end sends none: its touchend is held back).
        swallow = !d.touch;
        setTimeout(() => (swallow = false), 0);
        if (keep) store.reorderPane(d.tid, d.before);
      }
    };
    const onUp = () => !drag?.touch && end(true);
    const onCancel = () => !drag?.touch && end(false);

    /*
     * As pages, by touch: a press held still on a pane's tab, or on the band above its title
     * (HOLD_MS, never moving more than a few pixels, so a swipe still turns the page and a drag up
     * or down still resizes, below) picks the pane up: it fades where it is, its tab rides with the
     * finger, and the line shows where it will go. Near the column's top or foot a crowded column
     * scrolls on its own. Lifting the finger puts it there; a second finger, or the touch being
     * cancelled, puts it back. Only the handles listen to touchmove blocking (Chrome `onTouchMove`),
     * and only a lifted pane's moves, or an edge's, are held from the browser.
     */
    let hold: { timer: ReturnType<typeof setTimeout>; x: number; y: number; id: number; pane: HTMLElement; col: HTMLElement } | null = null;
    let ghost: HTMLElement | null = null;
    let edge = 0;
    let lastY = 0;
    function cancelHold() {
      if (!hold) return;
      clearTimeout(hold.timer);
      hold = null;
    }
    const lift = () => {
      const h = hold;
      hold = null;
      if (!h || !store.pages || !h.pane.isConnected) return;
      drag = { tid: Number(h.pane.dataset.tid), col: h.col, y0: h.y, on: false, before: null, line: null, touch: true };
      startDrag();
      h.pane.setAttribute("data-lifted", "");
      ghost = document.createElement("div");
      ghost.className = "drag-ghost";
      if (h.pane.dataset.hue !== undefined) ghost.dataset.hue = h.pane.dataset.hue;
      ghost.innerHTML = h.pane.querySelector(":scope > .tabline")?.innerHTML ?? "";
      const c = h.col.getBoundingClientRect();
      const box = wrap.getBoundingClientRect();
      Object.assign(ghost.style, { left: `${c.left - box.left}px`, width: `${c.width}px` });
      wrap.appendChild(ghost);
      lastY = h.y;
      dropAt(h.y);
      try {
        navigator.vibrate?.(8);
      } catch {
        /* no vibration here */
      }
    };
    /** Near a crowded column's top or foot, it scrolls under the lifted pane, faster the nearer. */
    const edgeScroll = () => {
      edge = 0;
      if (!drag?.touch) return;
      const c = drag.col.getBoundingClientRect();
      const zone = 56;
      const v = lastY < c.top + zone ? -(c.top + zone - lastY) / zone : lastY > c.bottom - zone ? (lastY - (c.bottom - zone)) / zone : 0;
      if (!v || !drag.col.classList.contains("crowded")) return;
      const was = drag.col.scrollTop;
      drag.col.scrollTop += Math.round(Math.max(-1, Math.min(1, v)) * 14);
      dropAt(lastY);
      if (drag.col.scrollTop !== was) edge = requestAnimationFrame(edgeScroll);
    };
    /*
     * As pages, by touch, a pane's handle (its tab, or the band above its title) moved up or down at
     * once, before the hold picks the pane up, drags the pane's top edge with the finger, as a
     * splitter (stack.ts `resize`): the pane grows or shrinks, the pane above it takes the
     * difference, a tab is pushed along at the limit. The direction is known after LOCK_PX: up or
     * down resizes (the handles' touch-action leaves only sideways to the browser, so nothing
     * scrolls first), sideways is the browser's, a swipe that turns the page. During the drag only
     * the panes' heights are set. When the finger lifts, a pane left barely taller than its tab
     * folds (SNAP_MS). The sizes hold as `handSizes` says; a double tap on a handle drops them.
     * Side by side, the mouse drags the same edge (below), and the sizes hold as `deskSizes` says.
     */
    /** An edge being dragged, by a finger or the mouse: the pane below it (i, in ps), the sizes the drag began with, those now, and how far it has moved. */
    type Resizing = { pane: HTMLElement; col: HTMLElement; i: number; start: number[]; ps: HTMLElement[]; now: number[]; dy: number };
    /** A finger on a handle: where it went down, and whether it has turned into a resize (lock). */
    type Press = Resizing & { x: number; y: number; id: number; lock: "v" | null };
    let press: Press | null = null;
    let lastTap: { col: HTMLElement; t: number; x: number; y: number } | null = null;
    let snapping = 0;
    /** The handle's page (side by side, the edge's column) laid out by hand from what shows of each pane now (no jump): false if it cannot be (a tab each does not fit). */
    const startResize = (r: Resizing): boolean => {
      const ps = [...r.col.querySelectorAll<HTMLElement>(":scope > .pane")];
      const h = r.col.clientHeight;
      if (r.i < 1 || ps.length * TAB > h || !ps.includes(r.pane)) return false;
      const c = r.col.getBoundingClientRect();
      const crowded = r.col.classList.contains("crowded");
      const tops = ps.map((p) => p.getBoundingClientRect());
      const vis = ps.map((_, k) => Math.max(0, Math.min(tops[k].bottom, c.bottom, crowded ? (tops[k + 1]?.top ?? Infinity) : Infinity) - Math.max(tops[k].top, c.top)));
      const start = fit(vis, h, TAB);
      if (!start) return false;
      cancelAnimationFrame(snapping);
      easing = null;
      unpeek();
      const tids = ps.map((p) => Number(p.dataset.tid));
      const was = hands().get(Number(r.col.dataset.col));
      // As pages, the pane looked at on the page; side by side, the active pane (deskSizes).
      const here = store.pages ? (was?.here ?? shown.current.get(r.col)) : store.branchNodes[store.paneAt]?.id;
      hands().set(Number(r.col.dataset.col), { set: setOf(tids), sizes: new Map(tids.map((t, k) => [t, start[k]])), here });
      sizeBy(r.col, ps, start);
      Object.assign(r, { ps, start, now: start, i: ps.indexOf(r.pane) });
      wrap.classList.add("resizing");
      return true;
    };
    const moveResize = (r: Resizing, dy: number) => {
      r.dy = dy;
      r.now = resize(r.start, r.i, dy, TAB);
      setHeights(r.ps, r.now);
      const m = hands().get(Number(r.col.dataset.col));
      if (m) r.ps.forEach((p, k) => m.sizes.set(Number(p.dataset.tid), r.now[k]));
    };
    /** The finger lifted (the mouse let go): the edge comes to rest, at a fold if a pane is left barely taller than its tab; as pages, a pane looked at folded away hands that to the pane across the edge. */
    const endResize = (r: Resizing) => {
      wrap.classList.remove("resizing");
      const to = release(r.start, r.i, r.dy, TAB, FOLD_SNAP);
      const tids = r.ps.map((p) => Number(p.dataset.tid));
      const col = Number(r.col.dataset.col);
      const m = hands().get(col);
      // Dropped while the finger was down (its panes changed): laid out automatically.
      if (!m) return relayout();
      tids.forEach((t, k) => m.sizes.set(t, to[k]));
      const from = r.now;
      cancelAnimationFrame(snapping);
      easing = null;
      if (reducedMotion() || from.every((x, k) => Math.abs(x - to[k]) < 0.5)) setHeights(r.ps, to);
      else {
        let t0 = -1;
        easing = r.col;
        const step = (now: number) => {
          if (t0 < 0) t0 = now - 1000 / 60;
          const p = Math.min(1, (now - t0) / SNAP_MS);
          const e = 1 - (1 - p) ** 3;
          // Its panes changed meanwhile: the layout has it now.
          if (!r.ps.every((x) => x.isConnected) || !hands().has(col)) return void (easing = null, latest.current(true));
          setHeights(r.ps, p < 1 ? from.map((x, k) => x + (to[k] - x) * e) : to);
          // Side by side, the curves go with the edge.
          if (!store.pages) schedule();
          if (p < 1) snapping = requestAnimationFrame(step);
          else easing = null;
        };
        snapping = requestAnimationFrame(step);
      }
      // Side by side a pane folded to its tab stays where the keys are: nothing has to be looked at whole.
      if (!store.pages) return;
      const active = store.branchNodes[store.paneAt]?.id;
      const a = active === undefined ? -1 : tids.indexOf(active);
      if (a < 0 || !folded(to[a], TAB)) return;
      const across = a === r.i ? r.i - 1 : a === r.i - 1 ? r.i : -1;
      const k = across >= 0 && !folded(to[across], TAB) ? across : to.indexOf(Math.max(...to));
      m.here = tids[k];
      store.toPane(tids[k]);
    };
    /** A double tap on a handle (a double click on an edge): the page, or column, laid out automatically again. */
    const unsize = (col: HTMLElement) => {
      if (!hands().delete(Number(col.dataset.col))) return;
      cancelAnimationFrame(snapping);
      easing = null;
      relayout();
    };
    const onHoldStart = (e: TouchEvent) => {
      if (!store.pages) return;
      // A second finger: whatever was being picked up or carried goes back; an edge being dragged stays where it is.
      if (e.touches.length > 1) {
        if (press?.lock) endResize(press);
        press = null;
        return void (hold || drag?.touch ? end(false) : undefined);
      }
      press = null;
      const h = handleAt(e.target);
      if (!h) return;
      const { pane, col } = h;
      const ps = [...col.querySelectorAll<HTMLElement>(":scope > .pane")];
      const p = e.changedTouches[0];
      cancelHold();
      press = { x: p.clientX, y: p.clientY, id: p.identifier, pane, col, i: ps.indexOf(pane), lock: null, start: [], ps: [], now: [], dy: 0 };
      hold = { timer: setTimeout(lift, HOLD_MS), x: p.clientX, y: p.clientY, id: p.identifier, pane, col };
    };
    const touchOf = (e: TouchEvent, id: number) => [...e.touches].find((x) => x.identifier === id);
    // Passive, on the strip: a press that moves before it is held long enough is a swipe, a scroll or a resize, and picks nothing up.
    const onHoldMove = (e: TouchEvent) => {
      if (!hold) return;
      const p = touchOf(e, hold.id);
      if (!p || Math.hypot(p.clientX - hold.x, p.clientY - hold.y) > 8) cancelHold();
    };
    // Blocking, on the handles only (Chrome's onTouchMove): a lifted pane follows the finger, and the page does not scroll.
    handleMove = (e: TouchEvent) => {
      if (drag?.touch) {
        e.preventDefault();
        const p = [...e.touches][0];
        if (!p) return;
        lastY = p.clientY;
        dropAt(lastY);
        if (!edge) edge = requestAnimationFrame(edgeScroll);
        return;
      }
      const r = press;
      const p = r && touchOf(e, r.id);
      if (!r || !p) return;
      const dx = p.clientX - r.x;
      const dy = p.clientY - r.y;
      if (!r.lock) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < LOCK_PX) return;
        // Sideways: a swipe, the browser's. Up or down on the first pane's handle: it has no edge above it to move.
        if (Math.abs(dy) <= Math.abs(dx) || !startResize(r)) return void (press = null);
        r.lock = "v";
        cancelHold();
      }
      // Held from the browser: the page neither turns nor scrolls under the edge.
      if (e.cancelable) e.preventDefault();
      moveResize(r, dy);
    };
    const onHoldEnd = (e: TouchEvent) => {
      if (drag?.touch) {
        // No click after it: the drop is all it does.
        if (e.cancelable) e.preventDefault();
        press = null;
        return end(e.type === "touchend");
      }
      cancelHold();
      const r = press;
      if (!r || [...e.touches].some((x) => x.identifier === r.id)) return;
      press = null;
      if (r.lock) {
        // No click after it either: the edge is all it moved.
        if (e.cancelable) e.preventDefault();
        return endResize(r);
      }
      // A tap: the browser's click selects the pane. A second soon after on a handle of the same page: the automatic sizes again.
      const p = e.changedTouches[0];
      const now = performance.now();
      if (e.type === "touchend" && lastTap && lastTap.col === r.col && now - lastTap.t < DOUBLE_TAP_MS && p && Math.hypot(p.clientX - lastTap.x, p.clientY - lastTap.y) < 40) {
        lastTap = null;
        return unsize(r.col);
      }
      lastTap = e.type === "touchend" && p ? { col: r.col, t: now, x: p.clientX, y: p.clientY } : null;
    };
    // The browser's own long press (a menu, a callout) has nothing to offer while a pane is held or carried.
    const onLongPress = (e: Event) => {
      if (!hold && !drag?.touch) return;
      e.preventDefault();
      e.stopPropagation();
    };
    /*
     * As panes side by side, by the mouse (or a pen): near an edge between two panes of a column, or
     * between two columns side by side, the pointer takes the edge (EDGE_PX each side; data-edge on
     * the panes sets the cursor, row-resize or col-resize, and keeps a press there from selecting
     * text). Pressed and moved, it drags that edge as a finger drags a pane's top edge as pages:
     * down a column the same splitter (startResize, moveResize, endResize: the pane below the edge
     * and the one above give and take, a tab pushed along at the limit, a pane left barely taller
     * than its tab folding), across the strip the columns' widths (stack.ts `resize`: the column
     * after the edge gives what the one before takes, one at COL_MIN pushed along; nothing folds).
     * A press there is never a click on a pane; a double click on an edge lays its column, or the
     * strip, out automatically again; Esc puts the edge back. An outer edge, or one a column covers
     * (stuck over the one before it), is no edge. The sizes hold as `deskSizes` and `widths` say: a
     * pinned pane's size, and the width of a column holding one, stick; the others' are the
     * layout's again once another pane is the active one.
     */
    type EdgeAt = { axis: "row"; col: HTMLElement; pane: HTMLElement; i: number } | { axis: "col"; i: number };
    type Edging = { at: EdgeAt; x: number; y: number; d: number; on: boolean; dead?: boolean; r?: Resizing; was?: Hand; widths?: Map<number, number>; start?: number[]; cols?: HTMLElement[] };
    let edging: Edging | null = null;
    /** The edge the pointer is near, if any: between two panes of the column under it, or between that column and one beside it where they meet. */
    const edgeAt = (x: number, y: number, t: EventTarget | null): EdgeAt | null => {
      const target = t as HTMLElement | null;
      if (store.pages || !target?.closest || target.closest(".pane-ctl, .selbar, [data-peek]")) return null;
      const col = target.closest<HTMLElement>(".strip > .col");
      if (!col) return null;
      const cols = [...el.querySelectorAll<HTMLElement>(":scope > .col")];
      const k = cols.indexOf(col);
      let best: EdgeAt | null = null;
      let near = EDGE_PX + 1;
      // Across: its left edge against the column before, its right against the one after, only where they meet.
      for (const j of [k, k + 1]) {
        if (j < 1 || j >= cols.length) continue;
        const a = cols[j - 1].getBoundingClientRect();
        const b = cols[j].getBoundingClientRect();
        const d = Math.abs(x - b.left);
        if (Math.abs(a.right - b.left) <= 1 && d < near) (best = { axis: "col", i: j }), (near = d);
      }
      // Down: the top of each pane but the first, where it shows in the column (in a crowded one, where it covers the pane before).
      const ps = [...col.querySelectorAll<HTMLElement>(":scope > .pane")];
      const c = col.getBoundingClientRect();
      for (let i = 1; i < ps.length; i++) {
        const top = ps[i].getBoundingClientRect().top;
        const d = Math.abs(y - top);
        if (top > c.top + 1 && top < c.bottom - 1 && d < near) (best = { axis: "row", col, pane: ps[i], i }), (near = d);
      }
      return best;
    };
    const showEdge = (at: EdgeAt | null) => {
      const v = at?.axis;
      if (wrap.dataset.edge !== v) v ? (wrap.dataset.edge = v) : delete wrap.dataset.edge;
    };
    const onEdgeHover = (e: PointerEvent) => {
      if (edging || e.pointerType === "touch") return;
      showEdge(e.buttons || drag ? null : edgeAt(e.clientX, e.clientY, e.target));
    };
    const onEdgeDown = (e: PointerEvent) => {
      if (e.button !== 0 || e.pointerType === "touch") return;
      const at = edgeAt(e.clientX, e.clientY, e.target);
      if (!at) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      unpeek();
      showEdge(at);
      edging = { at, x: e.clientX, y: e.clientY, d: 0, on: false };
    };
    /** The edge's column, or the strip's columns, laid out by hand from where they are now; false if they cannot be. */
    const startEdge = (g: Edging): boolean => {
      const at = g.at;
      if (at.axis === "row") {
        const m = handsBy.panes.get(Number(at.col.dataset.col));
        const was = m && { ...m, sizes: new Map(m.sizes) };
        const r: Resizing = { pane: at.pane, col: at.col, i: at.i, start: [], ps: [], now: [], dy: 0 };
        if (!startResize(r)) return false;
        Object.assign(g, { r, was });
      } else {
        const cols = [...el.querySelectorAll<HTMLElement>(":scope > .col")];
        Object.assign(g, { cols, start: cols.map((c) => c.offsetWidth), widths: new Map(widths.sizes) });
        wrap.classList.add("resizing");
      }
      return (g.on = true);
    };
    /** The columns' widths as the edge between column i - 1 and column i, moved by dx, leaves them (whole pixels); only those that changed, or were set by hand already, are kept. */
    const widen = (g: Edging, dx: number) => {
      const now = release(g.start!, g.at.i, dx, COL_MIN, 0);
      g.cols!.forEach((c, k) => {
        const n = Number(c.dataset.col);
        if (now[k] !== g.start![k] || widths.sizes.has(n)) widths.sizes.set(n, now[k]);
      });
      relayout();
    };
    const onEdgeMove = (e: PointerEvent) => {
      const g = edging;
      if (!g || g.dead) return;
      const d = g.at.axis === "row" ? e.clientY - g.y : e.clientX - g.x;
      if (!g.on && (Math.abs(d) < 2 || !startEdge(g))) return;
      g.d = d;
      if (g.r) (moveResize(g.r, d), schedule());
      else widen(g, d);
    };
    /** The edge let go (keep) or put back where the drag began (Esc, a cancelled pointer). */
    const endEdge = (g: Edging, keep: boolean) => {
      wrap.classList.remove("resizing");
      if (keep && g.r) return void (endResize(g.r), schedule());
      if (keep) return widen(g, g.d);
      if (!g.r) widths.sizes = g.widths!;
      else {
        const col = Number(g.r.col.dataset.col);
        g.was ? handsBy.panes.set(col, g.was) : handsBy.panes.delete(col);
      }
      relayout();
    };
    const onEdgeUp = (e: PointerEvent) => {
      const g = edging;
      if (!g) return;
      edging = null;
      // The click this press ends with is not a click on a pane.
      swallow = true;
      setTimeout(() => (swallow = false), 0);
      if (g.on && !g.dead) endEdge(g, e.type === "pointerup");
    };
    // A double click on an edge: its column (or, across, the strip) laid out automatically again. (The pointer was held by the strip, so what is under it is asked for.)
    const onEdgeDouble = (e: MouseEvent) => {
      const at = edgeAt(e.clientX, e.clientY, document.elementFromPoint(e.clientX, e.clientY));
      if (!at) return;
      e.preventDefault();
      if (at.axis === "row") unsize(at.col);
      else if (widths.sizes.size) (widths.sizes.clear(), relayout());
    };
    const onKey = (e: KeyboardEvent) => {
      const g = edging?.on && !edging.dead ? edging : null;
      if (e.key !== "Escape" || !(drag?.on || g)) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      if (drag?.on) end(false);
      else if (g) {
        endEdge(g, false);
        g.dead = true;
      }
    };
    // The click that ends a drag is not a click on the pane.
    const onClick = (e: MouseEvent) => {
      if (!swallow) return;
      swallow = false;
      e.stopPropagation();
      e.preventDefault();
    };
    el.addEventListener("touchstart", onHoldStart, { passive: true, signal });
    el.addEventListener("touchmove", onHoldMove, { passive: true, signal });
    el.addEventListener("touchend", onHoldEnd, { signal });
    el.addEventListener("touchcancel", onHoldEnd, { signal });
    window.addEventListener("contextmenu", onLongPress, { capture: true, signal });
    // A press elsewhere puts a peeking pane back; on it, the click goes through to it (and makes it the active pane), and then it goes back.
    const onPress = (e: PointerEvent) => !peeked.some((p) => p.contains(e.target as Node)) && unpeek();
    const afterClick = () => peeked.length && requestAnimationFrame(unpeek);
    // The edges first: a press on one is not a grip's, and the peek goes from under it.
    el.addEventListener("pointermove", onEdgeHover, { signal });
    el.addEventListener("pointermove", onMove, { signal });
    el.addEventListener("pointerleave", () => !edging && showEdge(null), { signal });
    el.addEventListener("pointerdown", onEdgeDown, { signal });
    el.addEventListener("pointermove", onEdgeMove, { signal });
    el.addEventListener("pointerup", onEdgeUp, { signal });
    el.addEventListener("pointercancel", onEdgeUp, { signal });
    el.addEventListener("dblclick", onEdgeDouble, { signal });
    el.addEventListener("pointerdown", onDown, { signal });
    el.addEventListener("pointerdown", onPress, { signal });
    el.addEventListener("click", afterClick, { signal });
    el.addEventListener("pointermove", onDrag, { signal });
    el.addEventListener("pointerup", onUp, { signal });
    el.addEventListener("pointercancel", onCancel, { signal });
    window.addEventListener("keydown", onKey, { capture: true, signal });
    window.addEventListener("click", onClick, { capture: true, signal });
    return () => {
      stopGlide(el);
      cancelAnimationFrame(frame.current);
      clearTimeout(later.current);
      clearTimeout(timer);
      clearTimeout(rest);
      ac.abort();
      bodies.current?.disconnect();
      sizes.disconnect();
      end(false);
      handleMove = null;
    };
  }, []);

  return (
    <div class="panes" data-layout={pages ? "pages" : undefined} data-colors={store.settings.colors} data-curves={store.settings.curves ? undefined : "off"}>
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
  if (store.pages) return pageMarks(el, svg);
  if (tinted.size) untint();
  if (!store.settings.curves) return uncurve(paneEls(el), svg);
  // The curves' layer covers the window from its corner (style.css), so its pixels are the device's and a hairline set on device pixels lands on them; it shows only over the strip.
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
      const rr = ruled ? ruleOf(ce)?.getBoundingClientRect() : undefined;
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
    // Below the column's foot (every pane leaves at least its tab there, so this is only a pane still being laid out).
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
      if (ruled) feet.set(parent.id, { x0: pbox.left, x1: footRight, y: sy, hue: parent.hue, on: branch.has(parent.id) });
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
    edges.push({ from: parent.id, to: x.node.id, gutter, left, sx, sy, under, hint, lines, textRight, ex, ey, on: branch.has(x.node.id) && branch.has(parent.id), lost, hue: x.node.hue, rule });
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
      const d = right < r.right - 1 ? `M${fx(x0)} ${fx(top)}V${fx(yb)}H${fx(right)}` : `M${fx(x0)} ${fx(top)}V${fx(yb)}H${fx(x1)}V${fx(top)}`;
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
  const local = (r: DOMRect) => ({ x: r.left, y: r.top, w: r.width, h: r.height });
  const holes = peeked.map((p) => local(p.getBoundingClientRect()));
  const bar = el.querySelector<HTMLElement>(".pane > .selbar");
  const barHole = bar && bar.style.visibility !== "hidden" ? [local(bar.getBoundingClientRect())] : [];
  /** Whether a curve's pane is in what peeks: in a pane that peeks (it is that pane), or only in a column that peeks (another pane in it). */
  const owner = (id: number): "pane" | "col" | null => {
    const p = els.get(id);
    if (!p) return null;
    const by = peeked.filter((q) => q.contains(p));
    return by.some((q) => q.classList.contains("pane")) ? "pane" : by.length ? "col" : null;
  };
  // A column peeking with one of its panes: its other panes' curves are over the column but not over that pane, which may cover their tabs.
  const paneHoles = peeked.flatMap((p, i) => (p.classList.contains("pane") ? [holes[i]] : []));
  const { under, mid, over } = layers(svg, area, [...holes, ...barHole], [...paneHoles, ...barHole], barHole);
  // Each curve keeps its element, changed only where it changed, so only what moved is painted again.
  const had = new Map<string, SVGPathElement>();
  for (const p of svg.querySelectorAll<SVGPathElement>("path")) had.set(p.dataset.key!, p);
  const at = new Map<Element, number>([
    [under, 0],
    [mid, 0],
    [over, 0],
  ]);
  out.forEach((c) => {
    let p = had.get(c.key);
    had.delete(c.key);
    if (!p) {
      p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.dataset.key = c.key;
    }
    if (p.dataset.from !== String(c.from)) p.dataset.from = String(c.from);
    if (p.dataset.to !== String(c.to)) p.dataset.to = String(c.to);
    if (p.getAttribute("d") !== c.d) p.setAttribute("d", c.d);
    if (p.getAttribute("class") !== c.cls) p.setAttribute("class", c.cls);
    if (p.dataset.lane !== String(c.lane)) p.dataset.lane = String(c.lane);
    if ((p.dataset.hue ?? "") !== c.hue) c.hue ? (p.dataset.hue = c.hue) : delete p.dataset.hue;
    // In drawing order, the focused branch's last, on top; over what peeks if it belongs to it.
    const by = [owner(c.from), owner(c.to)];
    const g = by.includes("pane") ? over : by.includes("col") ? mid : under;
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
 * The curves' three layers: those under what peeks (with holes where it is, and where the selection
 * bar is); those of a peeking column's other panes, over the column but under a pane of it that
 * peeks too (holes where that pane is, and the bar); and those over it all (what peeks' own; a hole
 * only for the bar). Made once; the holes kept as asked.
 */
function layers(svg: SVGSVGElement, area: DOMRect, holes: { x: number; y: number; w: number; h: number }[], midHoles: { x: number; y: number; w: number; h: number }[], barHoles: { x: number; y: number; w: number; h: number }[]) {
  const NS = "http://www.w3.org/2000/svg";
  let defs = svg.querySelector("defs");
  if (!defs) {
    defs = document.createElementNS(NS, "defs");
    const clip = document.createElementNS(NS, "clipPath");
    clip.id = "ie-curve-area";
    clip.appendChild(document.createElementNS(NS, "rect"));
    defs.appendChild(clip);
    svg.prepend(defs);
    const shown = document.createElementNS(NS, "g");
    shown.setAttribute("clip-path", "url(#ie-curve-area)");
    svg.appendChild(shown);
  }
  // Each part made if missing (a drawing an earlier build of the page began has fewer layers).
  for (const id of ["ie-curve-holes", "ie-curve-mid", "ie-curve-bar"]) {
    if (defs.querySelector(`#${id}`)) continue;
    const m = document.createElementNS(NS, "mask");
    m.id = id;
    m.setAttribute("maskUnits", "userSpaceOnUse");
    defs.appendChild(m);
  }
  const shown = svg.querySelector<SVGGElement>("g[clip-path]")!;
  ["under", "mid", "over"].forEach((c, i) => {
    let g = shown.querySelector<SVGGElement>(`:scope > g.${c}`);
    if (!g) {
      g = document.createElementNS(NS, "g");
      g.setAttribute("class", c);
    }
    if (shown.children[i] !== g) shown.insertBefore(g, shown.children[i] ?? null);
  });
  // Only over the strip.
  const r = svg.querySelector("#ie-curve-area rect")!;
  for (const [k, v] of Object.entries({ x: area.left, y: area.top, width: area.width, height: area.height })) if (r.getAttribute(k) !== String(v)) r.setAttribute(k, String(v));
  const under = svg.querySelector<SVGGElement>("g.under")!;
  const mid = svg.querySelector<SVGGElement>("g.mid")!;
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
  fill("ie-curve-mid", mid, midHoles);
  fill("ie-curve-bar", over, barHoles);
  return { under, mid, over };
}

/** The words, rows and links the panes were opened from, coloured as pages (pageMarks). */
let tinted = new Set<HTMLElement>();

/**
 * As pages, the panes are not side by side, so no curve runs between them: what each pane was
 * opened from (the words, a row, a link) takes that pane's colour instead, the colour of the rule
 * under its title, of its tab and of its place in the trail (style.css, data-src-hue). Drawn when
 * the panes change, not as anything scrolls.
 */
function pageMarks(el: HTMLElement, svg: SVGSVGElement) {
  const els = paneEls(el);
  uncurve(els, svg);
  const branch = new Set(store.branchNodes.map((n) => n.id));
  const now = new Set<HTMLElement>();
  for (const x of store.panesPlaced) {
    const pe = x.parent && els.get(x.parent.id);
    if (!pe) continue;
    const hue = x.node.hue === undefined ? "none" : String(x.node.hue);
    for (const s of pe.querySelectorAll<HTMLElement>(`.${kidClass(refKey(x.node.ref))}`)) {
      now.add(s);
      if (s.dataset.srcHue !== hue) s.dataset.srcHue = hue;
      setAttr(s, "data-src-on", branch.has(x.node.id));
    }
  }
  untint(now);
}

/** No curves drawn: every link's underline and pane's rule its own. */
function uncurve(els: Map<number, HTMLElement>, svg: SVGSVGElement) {
  for (const p of svg.querySelectorAll("path")) p.remove();
  for (const s of underlined) s.removeAttribute("data-curved");
  underlined = new Set();
  markRuled(els, new Map());
}

/** Take the colour off what no longer opens a pane (all of it, when the panes are side by side again). */
function untint(keep = new Set<HTMLElement>()) {
  for (const s of tinted)
    if (!keep.has(s)) {
      delete s.dataset.srcHue;
      s.removeAttribute("data-src-on");
    }
  tinted = keep;
}

/** A pane's own head, whose rule a curve into it lands in: a section's, a page's title, an article's (not an article set under a node). */
const HEADS = ":scope > .pane-scroll > .pane-body > .pane-head, :scope > .pane-scroll > .pane-body > .top, :scope > .pane-scroll > .pane-body > .wiki:not(.embedded) > .wiki-head";
/** The element under which a pane's own head draws its rule (a page's title is its h1). */
function ruleOf(p: HTMLElement): HTMLElement | null {
  const head = p.querySelector<HTMLElement>(HEADS);
  return head?.matches(".top") ? head.querySelector<HTMLElement>("h1") : head;
}

/** Which panes' rules a curve draws (head or tab), so that their own are left out. */
function markRuled(els: Map<number, HTMLElement>, rules: Map<number, string>) {
  for (const [id, p] of els) {
    const v = rules.get(id);
    if ((p.getAttribute("data-ruled") ?? undefined) !== v) v ? p.setAttribute("data-ruled", v) : p.removeAttribute("data-ruled");
  }
}
