/**
 * The panes view: a trail of panes, side by side, in the manner of Andy Matuschak's notes. It
 * starts as the path down from the top node; a link followed from a pane opens its target in the
 * next pane (another document's node, a Wikipedia article, a section of one), replacing what was
 * to the right. Moving back left closes nothing: the trail stays until something else is opened
 * from an earlier pane, or q closes panes. Earlier panes stay pinned at the left as narrow spines
 * when later ones slide over them.
 *
 * The trail is `store.trail`; which pane holds the focus is `store.paneAt`. Clicks are handled by
 * the page (App.tsx), exactly as in the column view.
 */
import { Component } from "preact";
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import { docOf, label, sections, staleness, type NodeId } from "../core/model";
import { NodeBacklinks, NodeRelated, TargetRow } from "./Links";
import { Flags, NodeBody, PendingSections, Row, TitleEditor, TopMatter } from "./Node";
import { store, type Aux, type PaneRef } from "./store";
import { WikiView } from "./Wiki";
import { article } from "./wiki";

interface PaneProps {
  p: PaneRef;
  index: number;
  /** The child whose pane is open to the right of this one, if any. */
  showing?: NodeId;
  /** The aux focus, when this pane holds it. */
  aux: Aux | null;
  active: boolean;
}

const key = (p: PaneProps) => `${p.p.kind === "node" ? p.p.id : `${p.p.title}#${p.p.sec ?? ""}`}|${p.index}|${p.showing ?? ""}|${p.active}|${JSON.stringify(p.aux)}`;

/** Redraws a pane only when something drawn in it changed (see `store.paneDirty`). An article pane is cheap to redraw: its HTML is set once. */
class Pane extends Component<PaneProps> {
  shouldComponentUpdate(next: PaneProps) {
    if (key(next) !== key(this.props)) return true;
    if (next.p.kind === "wiki") return true;
    return store.paneDirty(next.p.id) || !!store.snap.nodes[next.p.id]?.ref || store.linkedFrom(next.p.id).length > 0;
  }
  render() {
    const p = this.props.p;
    return p.kind === "node" ? <NodePane {...this.props} id={p.id} /> : <WikiPane {...this.props} />;
  }
}

function NodePane({ id, index, showing, active }: PaneProps & { id: NodeId }) {
  const snap = store.snap;
  const n = snap.nodes[id];
  if (!n) return null;
  const top = id === store.top && index === 0;
  // A document's pane is a page of its own, headed like one.
  const page = top || docOf(snap, id) === id;
  const kids = sections(snap, id);
  const focused = active && !store.aux && store.focus.node === id;
  const editing = store.edit?.node === id && store.edit.field === "title";
  const jump = index > 0 && !store.continues(index);
  return (
    <article
      class={`pane${top ? " root" : ""}${page && !top ? " doc" : ""}${jump ? " jumped" : ""}${n.kind === "note" ? " note-pane" : ""}${store.preview ? " preview" : ""}`}
      data-pane={id}
      data-pane-index={index}
      style={{ left: `calc(${index} * var(--spine))` }}
    >
      <div class="spine" data-spine={index} title={label(snap, id)}>
        <span>{label(snap, id)}</span>
      </div>
      <div class="pane-scroll">
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
              <PaneRow key={k} id={k} showing={k === showing} active={active} />
            ))}
          </ul>
        )}
        <PendingSections id={id} />
        {n.ref?.kind === "wiki" ? <WikiView host={`n${id}`} /> : <TargetRow id={id} />}
        <NodeBacklinks id={id} />
        <NodeRelated id={id} />
      </div>
    </article>
  );
}

function WikiPane({ p, index }: PaneProps) {
  if (p.kind !== "wiki") return null;
  const a = article(p.title, p.lang);
  const sec = p.sec && a.state === "ready" ? a.value.sections.find((x) => x.id === p.sec) : undefined;
  const title = sec ? `${sec.heading} · ${p.title}` : a.state === "ready" ? a.value.title : p.title;
  return (
    <article class={`pane wiki-pane${p.from ? " jumped" : ""}`} data-pane={`w:${p.title}${p.sec ? `#${p.sec}` : ""}`} data-pane-index={index} style={{ left: `calc(${index} * var(--spine))` }}>
      <div class="spine" data-spine={index} title={`Wikipedia: ${title}`}>
        <span>
          <b class="wmark">W</b> {title}
        </span>
      </div>
      <div class="pane-scroll">
        <WikiView host={`p${index}`} />
      </div>
    </article>
  );
}

function PaneRow({ id, showing, active }: { id: NodeId; showing: boolean; active: boolean }) {
  const snap = store.snap;
  const n = snap.nodes[id];
  const open = store.isOpen(id);
  const leaf = !sections(snap, id).length && !n.body.trim();
  const focused = active && !store.aux && store.focus.node === id;
  const st = staleness(snap, id);
  // While its pane is showing, the title is edited at the head of that pane instead.
  const editing = !showing && store.edit?.node === id && store.edit.field === "title";
  return (
    <li class={`node d${Math.min(n.depth - (snap.library ? 1 : 0), 6)}${open ? " open" : ""}${focused ? " focused" : ""}${showing ? " showing" : ""}${st.up || st.down ? " stale" : ""}`} data-node={id}>
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

export function Panes() {
  store.syncTrail();
  const trail = store.trail;
  const strip = useRef<HTMLDivElement>(null);
  const followed = useRef("");

  /**
   * Mark how far each pane is covered by the next. Any overlap gives the upper pane a shadow edge
   * (data-over); once too little of the pane is left to read its own heading, it shows as a spine
   * with its title (data-covered).
   */
  const measure = () => {
    const el = strip.current;
    if (!el) return;
    const panes = Array.from(el.children) as HTMLElement[];
    if (!panes.length) return;
    const w = panes[0].offsetWidth;
    const lefts = panes.map((p) => p.getBoundingClientRect().left);
    for (let i = 0; i < panes.length; i++) {
      const visible = i + 1 < panes.length ? lefts[i + 1] - lefts[i] : w;
      setAttr(panes[i], "data-covered", visible < w * 0.4);
      setAttr(panes[i + 1], "data-over", visible < w - 1);
    }
  };

  /**
   * Keep the focus in view. Vertically, the pane holding the focus scrolls to its focused row,
   * selection or link. Horizontally, the strip scrolls as little as it can so that pane is fully
   * visible and, when there is room, so is the pane beside it: for a row whose pane is showing,
   * that pane; otherwise the pane before.
   */
  const follow = () => {
    const el = strip.current;
    if (!el) return;
    const f = store.focus;
    const at = store.paneAt;
    const key = `${f.node}|${f.grain}|${f.range?.join()}|${JSON.stringify(store.aux)}|${at}|${store.trail.length}|${el.clientWidth}|${store.mode === "edit"}`;
    if (key === followed.current) return;
    followed.current = key;
    const panes = Array.from(el.children) as HTMLElement[];
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
    if (Math.abs(target - el.scrollLeft) > 1) el.scrollTo({ left: target, behavior: reducedMotion() ? "auto" : "smooth" });
  };

  useLayoutEffect(() => {
    follow();
    measure();
  });

  useEffect(() => {
    const el = strip.current!;
    let frame = 0;
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(() => ((frame = 0), measure()));
    };
    const onResize = () => {
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

  return (
    <div class="strip" ref={strip}>
      {trail.map((p, i) => {
        const next = trail[i + 1];
        const showing = p.kind === "node" && next?.kind === "node" && store.continues(i + 1) ? next.id : undefined;
        return <Pane key={`${i}:${p.kind === "node" ? p.id : `${p.title}#${p.sec ?? ""}`}`} p={p} index={i} showing={showing} active={store.paneAt === i} aux={store.paneAt === i ? store.aux : null} />;
      })}
    </div>
  );
}
