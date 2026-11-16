/**
 * The panes view: panes side by side, in the manner of Andy Matuschak's notes. It starts as the
 * path down from the top node; a link followed from a pane opens its target in the next pane
 * (another document's node, a Wikipedia article, a section of one), replacing what was to the
 * right. Moving back left closes nothing: the panes stay until something else is opened from an
 * earlier pane, or q closes them. Earlier panes stay pinned at the left as narrow spines when later
 * ones slide over them.
 *
 * A modified open (Shift+Enter, Shift- or Ctrl-click) makes a fork instead: the new pane opens
 * beside what was to the right, and the space right of the pane divides into rows, one per fork,
 * each continuing its own trail (forks.ts). The panes are `store.tree`; its focused branch is
 * `store.trail`, and which pane on it holds the focus is `store.paneAt`. Clicks are handled by the
 * page (App.tsx), exactly as in the column view; a click in another fork first makes it the
 * focused branch.
 */
import { Component, type ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { docOf, label, sections, staleness, type NodeId } from "../core/model";
import { leaves } from "./forks";
import { NodeBacklinks, NodeRelated, PaneCtx, TargetRow } from "./Links";
import { Flags, NodeBody, PendingSections, Row, TitleEditor, TopMatter } from "./Node";
import { refKey, store, type Aux, type Pane as PaneNode, type PaneRef } from "./store";
import { WikiView } from "./Wiki";
import { article } from "./wiki";

interface PaneProps {
  t: PaneNode;
  p: PaneRef;
  /** The pane it was opened from, the one to its left. */
  parent?: PaneRef;
  index: number;
  /** Its children, and which is picked, as a key (redraw when they change). */
  kids: string;
  /** Off the focused branch: drawn, but the keys are elsewhere; a click brings its fork onto the branch (App.tsx). Only an article pane draws differently (how its article is named). */
  off: boolean;
  /** In the narrow layout, where only the focused branch is drawn: which fork of how many this pane starts, if it starts one. */
  forkOf?: [number, number];
  /** The aux focus, when this pane holds it. */
  aux: Aux | null;
  active: boolean;
}

// `off` is left out: a node pane draws the same on the branch or off it, and moving between forks should redraw only what changed.
const key = (p: PaneProps) => `${refKey(p.p)}|${p.index}|${p.kids}|${p.active}|${p.forkOf ?? ""}|${JSON.stringify(p.aux)}`;

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

/** The attributes every pane has: which it is, its column, and its place in the tree. */
const paneAttrs = (props: PaneProps, name: string) => ({
  "data-pane": name,
  "data-pane-index": props.index,
  "data-tid": props.t.id,
  style: { left: `calc(${props.index} * var(--spine))` },
});

/** In the narrow layout, a pane that starts a fork says so, and how to get to the others. */
function ForkNote({ of }: { of?: [number, number] }) {
  if (!of) return null;
  return (
    <div class="fork-note">
      fork {of[0] + 1} of {of[1]} · <kbd>[</kbd> <kbd>]</kbd> for the others
    </div>
  );
}

function NodePane(props: PaneProps & { id: NodeId }) {
  const { id, index, active, t, parent } = props;
  const snap = store.snap;
  const n = snap.nodes[id];
  if (!n) return null;
  const top = id === store.top && index === 0;
  // A document's pane is a page of its own, headed like one.
  const page = top || docOf(snap, id) === id;
  const kids = sections(snap, id);
  const focused = active && !store.aux && store.focus.node === id;
  const editing = store.edit?.node === id && store.edit.field === "title";
  const jump = index > 0 && !store.continuesFrom(props.p, parent);
  // Its children open to the right: the picked one's row is marked as showing; other forks' rows as forked.
  const kid = t.kids[t.pick];
  const showing = kid?.ref.kind === "node" && store.continuesFrom(kid.ref, props.p) ? kid.ref.id : undefined;
  const forked = new Set(t.kids.flatMap((k, j) => (j !== t.pick && k.ref.kind === "node" && store.continuesFrom(k.ref, props.p) ? [k.ref.id] : [])));
  return (
    <article
      class={`pane${top ? " root" : ""}${page && !top ? " doc" : ""}${jump ? " jumped" : ""}${n.kind === "note" ? " note-pane" : ""}${store.preview ? " preview" : ""}`}
      {...paneAttrs(props, id)}
    >
      <div class="spine" data-spine={index} title={label(snap, id)}>
        <span>{label(snap, id)}</span>
      </div>
      <div class="pane-scroll">
        <ForkNote of={props.forkOf} />
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
    <article class={`pane wiki-pane${p.from ? " jumped" : ""}`} {...paneAttrs(props, `w:${p.title}${p.sec ? `#${p.sec}` : ""}`)}>
      <div class="spine" data-spine={index} title={`Wikipedia: ${title}`}>
        <span>
          <b class="wmark">W</b> {title}
        </span>
      </div>
      <div class="pane-scroll">
        <ForkNote of={props.forkOf} />
        {/* On the focused branch an article pane is named by its column; off it, by its place in the tree. */}
        <WikiView host={props.off ? `f${props.t.id}` : `p${index}`} />
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
    <li class={`node d${Math.min(n.depth - (snap.library ? 1 : 0), 6)}${open ? " open" : ""}${focused ? " focused" : ""}${showing ? " showing" : ""}${forked ? " forked" : ""}${st.up || st.down ? " stale" : ""}`} data-node={id}>
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

const setAttr = (el: HTMLElement | undefined, name: string, on: boolean) => {
  if (el && el.hasAttribute(name) !== on) on ? el.setAttribute(name, "") : el.removeAttribute(name);
};

/** The least height a fork's row gets, on any window; below it the rows scroll. */
const ROW_FLOOR = 220;
/** Rows share the strip's height equally down to a third of it each (never below ROW_FLOOR); past that the stack of rows scrolls. */
const rowMin = (h: number) => Math.max(ROW_FLOOR, Math.floor(h / 3));
/** Whether forks can be drawn as rows: room for two rows, and for a fork's pane beside the pane it came from. */
const roomy = (w: number, h: number, pane: number) => h >= 2 * ROW_FLOOR && w >= 2 * pane;

const kidsKey = (t: PaneNode) => `${t.pick}:${t.kids.map((k) => refKey(k.ref)).join(",")}`;

/** The panes drawn, by their id in the tree. */
const paneEls = (el: HTMLElement) => {
  const m = new Map<number, HTMLElement>();
  for (const e of el.querySelectorAll<HTMLElement>(".pane[data-tid]")) m.set(Number(e.dataset.tid), e);
  return m;
};

export function Panes() {
  store.syncTrail();
  const tree = store.tree;
  const strip = useRef<HTMLDivElement>(null);
  const followed = useRef("");
  const [room, setRoom] = useState(true);
  // Forks are drawn as rows when there is room; otherwise only the focused branch is.
  const rows = room && store.hasForks();

  /**
   * Mark how far each pane is covered by the next. Any overlap gives the upper pane a shadow edge
   * (data-over); once too little of the pane is left to read its own heading, it shows as a spine
   * with its title (data-covered). A pane's forks all start at the same column.
   */
  const measure = () => {
    const el = strip.current;
    const t = store.tree;
    if (!el || !t) return;
    const els = paneEls(el);
    const first = els.get(t.id);
    if (!first) return;
    const w = first.offsetWidth;
    const marks: [HTMLElement, number, HTMLElement[]][] = [];
    const visit = (n: PaneNode) => {
      const e = els.get(n.id);
      if (!e) return;
      const kids = n.kids.flatMap((k) => els.get(k.id) ?? []);
      const next = els.get(n.kids[n.pick]?.id) ?? kids[0];
      marks.push([e, next ? next.getBoundingClientRect().left - e.getBoundingClientRect().left : w, kids]);
      n.kids.forEach(visit);
    };
    visit(t);
    for (const [e, visible, kids] of marks) {
      setAttr(e, "data-covered", visible < w * 0.4);
      for (const k of kids) setAttr(k, "data-over", visible < w - 1);
    }
  };

  /**
   * Keep the focus in view. Vertically, the pane holding the focus scrolls to its focused row,
   * selection or link. Horizontally, the strip scrolls as little as it can so that pane is fully
   * visible and, when there is room, so is the pane beside it: for a row whose pane is showing,
   * that pane; otherwise the pane before. With forks, the strip also scrolls down or up as little
   * as it can to show the focused branch's row.
   */
  const follow = () => {
    const el = strip.current;
    if (!el) return;
    const f = store.focus;
    const at = store.paneAt;
    const nodes = store.branchNodes;
    const key = `${f.node}|${f.grain}|${f.range?.join()}|${JSON.stringify(store.aux)}|${at}|${nodes.map((n) => n.id).join(",")}|${el.clientWidth}|${el.clientHeight}|${store.mode === "edit"}`;
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
    const w = panes[0].offsetWidth;
    const spine = (panes[0].querySelector(".spine") as HTMLElement | null)?.offsetWidth ?? 0;
    const view = el.clientWidth;
    const b = Math.min(panes.length - 1, showing ? at + 1 : at);
    let a = b > 0 && (showing || f.grain === "node") ? b - 1 : b;
    // Pane i starts at i·w. It is uncovered while scrollLeft ≤ i·(w − spine), and its right edge is in view while scrollLeft ≥ (i+1)·w − view.
    const lo = (b + 1) * w - view;
    if (lo > a * (w - spine)) a = b;
    const hi = a * (w - spine);
    const target = Math.max(0, Math.min(el.scrollWidth - view, Math.min(Math.max(el.scrollLeft, lo), hi)));
    // The row the branch ends in holds every pane of the branch (a pane with forks stays at the top while its rows scroll).
    let top = el.scrollTop;
    const row = panes[panes.length - 1].closest<HTMLElement>(".fork");
    if (row) {
      const r = row.getBoundingClientRect();
      const c = el.getBoundingClientRect().top;
      if (r.top < c) top += r.top - c;
      else if (r.bottom > c + el.clientHeight) top += Math.min(r.bottom - c - el.clientHeight, r.top - c);
    }
    // Down or up to another row at once: a smooth scroll that way repaints every row's panes on each frame, which costs frames on a slow machine.
    if (Math.abs(top - el.scrollTop) > 1) el.scrollTop = top;
    if (Math.abs(target - el.scrollLeft) > 1) el.scrollTo({ left: target, behavior: reducedMotion() ? "auto" : "smooth" });
  };

  /** The rows' sizes follow the strip's height; whether there is room for rows at all, its size and a pane's width. */
  const size = () => {
    const el = strip.current;
    if (!el) return;
    el.style.setProperty("--strip-h", `${el.clientHeight}px`);
    el.style.setProperty("--row-min", `${rowMin(el.clientHeight)}px`);
    const pane = el.querySelector<HTMLElement>(".pane")?.offsetWidth ?? 0;
    setRoom(roomy(el.clientWidth, el.clientHeight, pane));
  };

  useLayoutEffect(() => {
    follow();
    measure();
  });

  useLayoutEffect(size, []);

  useEffect(() => {
    const el = strip.current!;
    let frame = 0;
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(() => ((frame = 0), measure()));
    };
    const onResize = () => {
      size();
      followed.current = "";
      follow();
      measure();
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    // The strip changes width with the window and when the history panel opens or closes.
    const sizes = new ResizeObserver(onResize);
    sizes.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener("scroll", onScroll);
      sizes.disconnect();
    };
  }, []);

  const onBranch = new Set(store.branchNodes.map((n) => n.id));
  /**
   * A pane and what is right of it. A plain trail is a flat run of panes, as before; to the right of
   * a pane with forks, a stack of rows, one per fork in the order they were opened, each holding
   * that fork's panes (and perhaps a stack of its own). Without room for rows, only the picked fork.
   */
  const draw = (t: PaneNode, depth: number, parent?: PaneRef, forkOf?: [number, number]): ComponentChildren[] => {
    const off = !onBranch.has(t.id);
    const active = !off && store.paneAt === depth;
    const out: ComponentChildren[] = [
      <Pane key={t.id} t={t} p={t.ref} parent={parent} index={depth} kids={kidsKey(t)} off={off} forkOf={forkOf} active={active} aux={active ? store.aux : null} />,
    ];
    if (!t.kids.length) return out;
    if (t.kids.length === 1 || !rows) return [...out, ...draw(t.kids[t.pick], depth + 1, t.ref, t.kids.length > 1 ? [t.pick, t.kids.length] : undefined)];
    out.push(
      <div key={`f${t.id}`} class="forks" style={`--leaves:${leaves(t)}`}>
        {t.kids.map((k) => (
          <div key={k.id} class={`fork${onBranch.has(k.id) ? " on" : ""}`} style={`--leaves:${leaves(k)}`}>
            {draw(k, depth + 1, t.ref)}
          </div>
        ))}
      </div>,
    );
    return out;
  };

  return (
    <div class={`strip${rows ? " forked" : ""}`} ref={strip}>
      {tree && draw(tree, 0)}
    </div>
  );
}
