/**
 * What the pages layout adds to the panes (pages.ts): the trail at the foot of the screen, where a
 * thumb reaches, naming the focused branch pane by pane in each pane's colour, the one on screen
 * marked; a tap on a step goes to that pane. Its last button opens the map: every open pane, as an
 * outline of the forest of forks, each with its colour, to go to, pin or close.
 */
import { useLayoutEffect, useRef } from "preact/hooks";
import { label } from "../core/model";
import { store, type PaneRef } from "./store";
import { article } from "./wiki";

/** What a pane is called: its node's title, or its article's (a section of one by its heading). */
export function paneTitle(p: PaneRef): string {
  if (p.kind === "node") return store.snap.nodes[p.id] ? label(store.snap, p.id) : "…";
  const a = article(p.title, p.lang);
  const sec = p.sec !== undefined && a.state === "ready" ? a.value.sections.find((x) => x.id === p.sec) : undefined;
  return sec ? sec.heading : a.state === "ready" ? a.value.title : p.title;
}

const W = () => <b class="wmark">W</b>;

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
  return (
    <nav class="trail" aria-label="The panes on the way to this one">
      <div class="trail-steps" ref={ref}>
        {nodes.map((n, i) => (
          <button
            key={n.id}
            type="button"
            class={`trail-step${i === at ? " here" : ""}${i > at ? " ahead" : ""}`}
            data-trail={n.id}
            data-hue={n.hue}
            aria-current={i === at ? "page" : undefined}
            title={paneTitle(n.ref)}
            onClick={(e) => {
              e.stopPropagation();
              store.showMap(false);
              store.toPane(n.id);
            }}
          >
            {n.ref.kind === "wiki" && <W />}
            <span class="trail-t">{paneTitle(n.ref)}</span>
          </button>
        ))}
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

/**
 * The map: every open pane, tree by tree, each indented by its column under the pane it was
 * opened from, with its colour; the active pane marked, the focused branch in the text's ink. A
 * tap on a pane goes to it; its pin and × act on it where it is. A press outside, Esc or the
 * trail's map button puts it away.
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
        {placed.map((x) => {
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
              style={{ "--depth": Math.min(x.col, 8) }}
            >
              <button type="button" class="map-go" aria-current={id === active ? "page" : undefined} onClick={() => (store.showMap(false), store.toPane(id))}>
                <span class="map-dash" aria-hidden="true" />
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
