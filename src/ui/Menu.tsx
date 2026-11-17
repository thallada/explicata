/**
 * The top bar: where the reader is (the library's name, which opens the libraries panel) and
 * whether it is saved, with undo and the menu; and the libraries panel, on the left.
 */
import { useLayoutEffect, useRef } from "preact/hooks";
import { libraryEntries, topEntries } from "./actions";
import { nodeCount } from "./libraries";
import { Hints, Key, act, showMenu, type Hint } from "./Mouse";
import { press } from "./press";
import { store } from "./store";

/** A press on a tool keeps the focus where it was (the keys stay with the page). */
const keep = (e: MouseEvent) => e.preventDefault();

const SAVE_LABEL = { saved: "saved", saving: "saving…", offline: "offline · kept in this browser", foreign: "not saved · reload the page", deleted: "deleted · not saved" };
const SAVE_TITLE = {
  saved: "Every edit is saved as you make it. The server has all of them.",
  saving: "Every edit is saved as you make it. The latest are on their way to the server.",
  offline: "The server cannot be reached. Edits are kept in this browser and sent when it can.",
  foreign: "The server now holds a different library than this page.",
  deleted: "The server no longer has this library: it was deleted, and its files moved aside. Open another from the libraries (m).",
};


export function DocBar() {
  const state = store.saveState();
  const snap = store.snap;
  return (
    <nav class="docbar">
      <button
        type="button"
        class="tool lib-name"
        data-libs-trigger
        aria-haspopup="dialog"
        aria-expanded={store.libs ? "true" : "false"}
        title="The libraries: open, make, rename or delete one (m)"
        onMouseDown={keep}
        onClick={(e) => {
          e.stopPropagation();
          store.toggleLibraries();
        }}
      >
        <span class="lib-title">{snap.nodes[snap.root].title || "Library"}</span>
        <span class={`chev${store.libs ? " up" : ""}`} />
      </button>
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

// ---- the libraries panel ----

/**
 * The libraries, on the left: each a tree of its own, with its name, its size and which one this
 * page holds. j k move, Enter opens (a page load), n names a new one, r renames, D deletes after a
 * y; Esc, m or the library's name in the top bar closes it, and so does a press anywhere outside it
 * (that press does nothing else). It hangs below the top bar, so the name that opened it stays
 * where it was; beside it the page makes room (the column moves over, the panes narrow), and on a
 * phone it covers the page.
 */
export function LibrariesPanel() {
  const p = store.libs;
  const ref = useRef<HTMLElement>(null);
  // Below the top bar, wherever the view puts it.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const place = () => {
      const bar = document.querySelector(".docbar")?.getBoundingClientRect();
      el.style.top = `${Math.max(0, Math.round(bar?.bottom ?? 0))}px`;
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  });
  useLayoutEffect(() => {
    ref.current?.querySelector(".lib-row.selected")?.scrollIntoView({ block: "nearest" });
  });
  // A press outside closes it, as a press outside closes a menu; the click it begins does nothing
  // else (so a press on the library's name closes it, and its click does not open it again).
  useLayoutEffect(() => {
    if (!p) return;
    const outside = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (ref.current?.contains(t) || t.closest?.(".menu, .overlay, .help")) return;
      store.closeLibraries();
      const swallow = (c: MouseEvent) => (c.stopPropagation(), c.preventDefault());
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 800);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [p]);
  if (!p) return null;
  const rows = store.libRows();
  const only = store.libraries.length <= 1;
  const menuFor = (id: string, at: HTMLElement | { x: number; y: number }) => {
    store.libSelect(id);
    const l = rows.find((x) => x.id === id);
    if (!l) return;
    showMenu(libraryEntries({ title: l.title, current: id === store.library && !store.gone, last: only }, act), at);
  };
  const head: Hint = [["n", "new"], ["Escape", "close"]];
  return (
    <aside class="panel left libraries" ref={ref} data-libraries data-loading={p.loading ? "1" : undefined} aria-label="Libraries">
      <div class="panel-head">
        <span>Libraries{p.loading ? " …" : ""}</span>
        <span class="keys">
          <Hints hint={head} />
        </span>
      </div>
      {store.gone && <div class="verdict lib-gone">This library was deleted on the server, and its files moved aside; what was edited here since is not saved. Open another:</div>}
      {p.note && <div class="lib-note">{p.note}</div>}
      <div class="lib-list" role="listbox" aria-label="Libraries">
        {rows.map((l) => {
          const current = l.id === store.library;
          const selected = l.id === p.sel;
          const renaming = p.edit?.kind === "rename" && p.edit.id === l.id;
          const confirming = p.confirm === l.id;
          return (
            <div
              key={l.id}
              class={`item lib-row${selected ? " selected" : ""}${current ? " current" : ""}`}
              role="option"
              aria-selected={selected}
              data-lib={l.id}
              onClick={(e) => {
                e.stopPropagation();
                if (renaming || confirming || (e.target as HTMLElement).closest("button, input")) return;
                store.libSelect(l.id);
                press("Enter");
              }}
              onContextMenu={(e) => {
                if (e.shiftKey || renaming) return;
                e.preventDefault();
                menuFor(l.id, { x: e.clientX, y: e.clientY });
              }}
            >
              <div class="line">
                <span class="lib-mark">{current ? "●" : "○"}</span>
                {renaming ? <NameBox initial={l.title} /> : <span class="lib-t">{l.title}</span>}
                {!renaming && (
                  <button type="button" class="more" data-lib-more title="Open, rename or delete (right-click works too)" aria-haspopup="menu" onMouseDown={keep} onClick={(e) => (e.stopPropagation(), menuFor(l.id, e.currentTarget as HTMLElement))}>
                    ⋯
                  </button>
                )}
              </div>
              <div class="sub">
                {nodeCount(l.nodes)}
                {current ? (store.gone ? " · deleted" : " · open here") : ""}
              </div>
              {confirming && (
                <div class="lib-confirm" role="alertdialog" aria-label={`Delete ${l.title}?`}>
                  <p>
                    Delete “{l.title}”{current ? ", the library open here" : ""}? Its files are moved, unchanged, to <code>libraries/.deleted/</code> in the server's data folder,
                    from where it can be restored by hand; <kbd>u</kbd> cannot bring it back.
                  </p>
                  <Hints hint={[["y", "delete"], ["n", "keep"]]} />
                </div>
              )}
            </div>
          );
        })}
        {!rows.length && <p class="lempty">{p.loading ? "Asking the server…" : "No other library."}</p>}
        {p.edit?.kind === "new" ? (
          <div class="item lib-row lib-new selected">
            <div class="line">
              <span class="lib-mark">+</span>
              <NameBox initial="" />
            </div>
            <div class="sub">a new library, its root alone; it opens once made</div>
          </div>
        ) : (
          <div class="lib-add">
            <Key k="n" what="new library…" />
          </div>
        )}
      </div>
    </aside>
  );
}

/** The name being typed in the panel: Enter keeps it (a new library is made and opened), Esc leaves it. */
function NameBox({ initial }: { initial: string }) {
  return (
    <input
      class="title-editor lib-input"
      aria-label={initial ? "The library's new name" : "The new library's name"}
      placeholder="Name of the new library"
      defaultValue={initial}
      maxLength={200}
      ref={(el) => {
        if (el && document.activeElement !== el) {
          el.focus();
          el.select();
        }
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") (e.preventDefault(), store.libCancel());
        else if (e.key === "Enter") (e.preventDefault(), void store.libSubmit((e.target as HTMLInputElement).value));
      }}
      onClick={(e) => e.stopPropagation()}
    />
  );
}
