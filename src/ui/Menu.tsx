/** The top bar: where the reader is (the library's name) and whether it is saved, with undo and the menu. */
import { topEntries } from "./actions";
import { act, showMenu } from "./Mouse";
import { press } from "./press";
import { store } from "./store";

/** A press on a tool keeps the focus where it was (the keys stay with the page). */
const keep = (e: MouseEvent) => e.preventDefault();

const SAVE_LABEL = { saved: "saved", saving: "saving…", offline: "offline · kept in this browser", foreign: "not saved · reload the page" };
const SAVE_TITLE = {
  saved: "Every edit is saved as you make it. The server has all of them.",
  saving: "Every edit is saved as you make it. The latest are on their way to the server.",
  offline: "The server cannot be reached. Edits are kept in this browser and sent when it can.",
  foreign: "The server now holds a different library than this page.",
};

export function DocBar() {
  const state = store.saveState();
  const snap = store.snap;
  return (
    <nav class="docbar">
      <span class="lib-name" title="The library">
        {snap.nodes[snap.root].title || "Library"}
      </span>
      <span class={`save-state ${state}`} title={SAVE_TITLE[state]}>
        {SAVE_LABEL[state]}
      </span>
      <span class="tools">
        <button type="button" class="tool" title="Undo the last edit made in this tab (u)" onMouseDown={keep} onClick={(e) => (e.stopPropagation(), press("u"))}>
          undo
        </button>
        {store.canRedo() && (
          <button type="button" class="tool" title="Redo (U)" onMouseDown={keep} onClick={(e) => (e.stopPropagation(), press("U"))}>
            redo
          </button>
        )}
        <button
          type="button"
          class="tool"
          aria-haspopup="menu"
          title="Jump, history, links, layout and settings"
          onMouseDown={keep}
          onClick={(e) => {
            e.stopPropagation();
            const s = store.settings;
            showMenu(topEntries({ view: s.view, autolink: s.autolink, auto: s.auto, speculate: s.speculate, curves: s.curves, colors: s.colors, panes: store.panes, canRedo: store.canRedo() }, act), e.currentTarget as HTMLElement);
          }}
        >
          menu<span class="chev" />
        </button>
      </span>
    </nav>
  );
}
