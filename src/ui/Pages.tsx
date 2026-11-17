/**
 * What the pages layout adds to the panes (pages.ts): the trail at the foot of the screen, where a
 * thumb reaches, naming the focused branch pane by pane in each pane's colour, the one on screen
 * marked; a tap on a step goes to that pane. Its last button opens the map: every open pane, as an
 * outline of the forest of forks, each with its colour, to go to, pin or close.
 */
import { useLayoutEffect, useRef } from "preact/hooks";
import { label } from "../core/model";
import { store, type PaneRef } from "./store";
import { mapStep, rails, type Rail } from "./pages";
import { article } from "./wiki";

/** What a pane is called: its node's title, or its article's (a section of one by its heading). */
export function paneTitle(p: PaneRef): string {
  if (p.kind === "node") return store.snap.nodes[p.id] ? label(store.snap, p.id) : "…";
  const a = article(p.title, p.lang);
  const sec = p.sec !== undefined && a.state === "ready" ? a.value.sections.find((x) => x.id === p.sec) : undefined;
  return sec ? sec.heading : a.state === "ready" ? a.value.title : p.title;
}

const W = () => <b class="wmark">W</b>;

/** Up to this many panes in a column, a trail step shows a dot for each; beyond, their number. */
export const STACK_DOTS = 4;

/**
 * How many panes the page of a step holds, when more than one: a dot for each, top to bottom as they
 * stand down the page, the step's own filled in its colour; beyond STACK_DOTS, their number.
 */
function Stack({ i, n }: { i: number; n: number }) {
  if (n < 2) return null;
  if (n > STACK_DOTS) return <span class="trail-count" aria-hidden="true">{n}</span>;
  return (
    <span class="trail-stack" aria-hidden="true">
      {Array.from({ length: n }, (_, j) => (
        <i key={j} class={j === i ? "on" : undefined} />
      ))}
    </span>
  );
}

/** The trail: the focused branch, a step per pane, and the map's button. */
export function Trail() {
  const ref = useRef<HTMLDivElement>(null);
  const nodes = store.branchNodes;
  const at = store.paneAt;
  const here = nodes[at]?.id;
  // The step on screen is kept in view along the trail (only when it changes, never as anything scrolls).
  useLayoutEffect(() => {
    const row = ref.current;
    const el = row?.querySelector<HTMLElement>(".trail-step.here");
    if (!row || !el) return;
    const l = el.offsetLeft - row.offsetLeft;
    if (l < row.scrollLeft + 8) row.scrollLeft = Math.max(0, l - 24);
    else if (l + el.offsetWidth > row.scrollLeft + row.clientWidth - 8) row.scrollLeft = l + el.offsetWidth - row.clientWidth + 24;
  }, [here, nodes.length]);
  const count = store.panesPlaced.length;
  /** Each pane's place down its column, and how many the column holds. */
  const down = new Map<number, { i: number; n: number }>();
  for (const ps of store.paneColumns.values()) ps.forEach((x, i) => down.set(x.node.id, { i, n: ps.length }));
  return (
    <nav class="trail" aria-label="The panes on the way to this one">
      <div class="trail-steps" ref={ref}>
        {nodes.map((n, i) => {
          const d = down.get(n.id);
          const t = paneTitle(n.ref);
          const name = d && d.n > 1 ? `${t} · ${d.i + 1} of ${d.n} panes on its page` : t;
          return (
            <button
              key={n.id}
              type="button"
              class={`trail-step${i === at ? " here" : ""}${i > at ? " ahead" : ""}`}
              data-trail={n.id}
              data-hue={n.hue}
              data-col-panes={d && d.n > 1 ? d.n : undefined}
              aria-current={i === at ? "page" : undefined}
              aria-label={name}
              title={name}
              onClick={(e) => {
                e.stopPropagation();
                store.showMap(false);
                store.toPane(n.id);
              }}
            >
              {n.ref.kind === "wiki" && <W />}
              <span class="trail-t">{t}</span>
              {d && <Stack i={d.i} n={d.n} />}
            </button>
          );
        })}
      </div>
      <button
        type="button"
        class="trail-map"
        data-map-open
        aria-haspopup="dialog"
        aria-expanded={store.paneMap ? "true" : "false"}
        title="Every open pane: go to one, pin it or close it"
        onClick={(e) => {
          e.stopPropagation();
          store.showMap();
        }}
      >
        map <span class="trail-n">{count}</span>
      </button>
    </nav>
  );
}

const Pin = () => (
  <svg viewBox="0 0 12 12" aria-hidden="true">
    <path d="M4 1.5h4M4.6 1.5v3.6L2.8 7.2h6.4L7.4 5.1V1.5M6 7.2V11" />
  </svg>
);
const Close = () => (
  <svg viewBox="0 0 12 12" aria-hidden="true">
    <path d="M3 3l6 6M9 3l-6 6" />
  </svg>
);

/** Where a level's line runs down the map, and where a row's mark starts and ends (px from the row's left). */
const MAP_LEFT = 10;
const MARK = 14;
const markAt = (level: number, step: number) => MAP_LEFT + level * step;
const lineAt = (level: number, step: number) => markAt(level, step) + 3;

/** One stroke of the tree lines (pages.ts `rails`), as a box with borders: crisp on any screen. */
function RailLine({ r, step, hue, on }: { r: Rail; step: number; hue?: number; on: boolean }) {
  const x = lineAt(r.level, step);
  const style =
    r.kind === "dash"
      ? { left: `${markAt(r.level, step)}px`, width: `${MARK}px`, top: 0, height: "50%" }
      : r.kind === "elbow"
        ? { left: `${x}px`, width: `${markAt(r.level + 1, step) + MARK - x}px`, top: 0, height: "50%" }
        : r.kind === "pass"
          ? { left: `${x}px`, top: 0, bottom: 0 }
          : { left: `${r.kind === "down" ? lineAt(r.level, step) : x}px`, top: "50%", bottom: 0 };
  return <span class={`rail r-${r.kind}${on ? " strong" : ""}`} data-hue={hue} data-rail={r.kind} data-to={r.tid} style={style} aria-hidden="true" />;
}

/**
 * The map: every open pane, tree by tree, as a tree: each indented by its column under the pane it
 * was opened from, a line from the parent's mark down and across into each child's, in the child's
 * colour (stronger along the focused branch), as the curves run on a wide screen; the active pane
 * marked, the focused branch in the text's ink. A tap on a pane goes to it; its pin and × act on it
 * where it is. A press outside, Esc or the trail's map button puts it away.
 */
export function PaneMap() {
  const ref = useRef<HTMLDivElement>(null);
  const on = store.paneMap && store.pages;
  useLayoutEffect(() => {
    if (!on) return;
    ref.current?.querySelector<HTMLElement>(".map-row.here")?.scrollIntoView({ block: "nearest" });
    const outside = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (ref.current?.contains(t) || t.closest?.("[data-map-open]")) return;
      store.showMap(false);
      // The press that puts it away does nothing else.
      const swallow = (c: MouseEvent) => (c.stopPropagation(), c.preventDefault());
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 800);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [on]);
  if (!on) return null;
  const placed = store.panesPlaced;
  const branch = new Set(store.branchNodes.map((n) => n.id));
  const active = store.branchNodes[store.paneAt]?.id;
  const lines = rails(placed);
  const step = mapStep(placed.reduce((m, x) => Math.max(m, x.col), 0));
  const hues = new Map(placed.map((x) => [x.node.id, x.node.hue]));
  return (
    <div
      class="pane-map"
      role="dialog"
      aria-label="Open panes"
      ref={ref}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        e.preventDefault();
        store.showMap(false);
      }}
    >
      <div class="map-head">
        Open panes · {placed.length}
        <span class="map-hint">swipe sideways to go from pane to pane</span>
      </div>
      <ul class="map-rows">
        {placed.map((x, i) => {
          const id = x.node.id;
          const first = x.ti === 0 && x.depth === 0;
          const orphan = x.ti > 0 && x.depth === 0;
          const pinned = !!x.node.pinned;
          return (
            <li
              key={id}
              class={`map-row${id === active ? " here" : ""}${branch.has(id) ? " on-branch" : ""}${pinned ? " pinned" : ""}`}
              data-map={id}
              data-hue={x.node.hue}
              data-level={x.col}
              style={{ paddingLeft: `${markAt(x.col, step) + MARK + 2}px` }}
            >
              {lines[i].map((r, k) => (
                <RailLine key={k} r={r} step={step} hue={hues.get(r.tid)} on={branch.has(r.tid)} />
              ))}
              <button type="button" class="map-go" aria-current={id === active ? "page" : undefined} onClick={() => (store.showMap(false), store.toPane(id))}>
                {x.node.ref.kind === "wiki" && <W />}
                <span class="map-t">{paneTitle(x.node.ref)}</span>
                {orphan && <span class="map-sub">its source closed</span>}
              </button>
              <button type="button" class={`map-btn pin${pinned ? " on" : ""}`} data-map-pin={id} aria-label={pinned ? "Unpin" : "Pin"} title={pinned ? "Unpin this pane" : "Pin this pane: it stays when what opened it closes"} onClick={() => store.togglePanePin(id)}>
                <Pin />
              </button>
              {first ? (
                <span class="map-btn none" />
              ) : (
                <button type="button" class="map-btn close" data-map-close={id} aria-label="Close" title="Close this pane and what was opened from it" onClick={() => store.closePane(id)}>
                  <Close />
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
