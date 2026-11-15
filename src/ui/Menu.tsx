/** The top bar (where the reader is, and whether it is saved) and the documents menu it opens (m). */
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { clip } from "../core/text";
import { store } from "./store";

const SAVE_LABEL = { saved: "saved", saving: "saving…", offline: "offline · kept in this browser", foreign: "not saved · reload the page" };
const SAVE_TITLE = {
  saved: "Every edit is saved as you make it. The server has all of them.",
  saving: "Every edit is saved as you make it. The latest are on their way to the server.",
  offline: "The server cannot be reached. Edits are kept in this browser and sent when it can.",
  foreign: "The server now holds a different library than this page.",
};

export function DocBar() {
  const state = store.saveState();
  const here = store.currentDoc;
  const snap = store.snap;
  return (
    <nav class="docbar">
      <button
        class="doc-title"
        title="Documents (m)"
        onClick={(e) => {
          e.stopPropagation();
          if (store.mode === "docs") store.closeMenu();
          else store.openMenu();
        }}
      >
        <span class="name">{here ? snap.nodes[here]?.title || "Untitled" : snap.nodes[snap.root].title}</span>
        <span class="chev" />
      </button>
      <span class={`save-state ${state}`} title={SAVE_TITLE[state]}>
        {SAVE_LABEL[state]}
      </span>
    </nav>
  );
}

function TitlePrompt() {
  const p = store.menu.prompt!;
  const label = { new: "New document, titled", rename: "Rename to", duplicate: "Save a copy as" }[p.kind];
  return (
    <label class="prompt">
      <span>{label}</span>
      <input
        ref={(el) => {
          if (el && document.activeElement !== el) (el.focus(), el.select());
        }}
        defaultValue={p.value}
        placeholder="Title"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            store.menuSubmit((e.target as HTMLInputElement).value);
          } else if (e.key === "Escape") {
            e.preventDefault();
            store.menu.prompt = null;
            store.menu.focus = "list";
            store.emit();
          }
        }}
      />
    </label>
  );
}

export function DocsPanel() {
  const m = store.menu;
  const items = store.menuItems();
  const sel = store.menuSelected();
  const current = store.currentDoc;
  const ref = useRef<HTMLElement>(null);
  const [dropping, setDropping] = useState(false);
  useLayoutEffect(() => {
    ref.current?.querySelector(".doc.selected")?.scrollIntoView({ block: "nearest" });
  });
  const typing = m.focus === "filter" && !m.prompt && !m.confirm;
  const act = (fn: () => void) => (e: MouseEvent) => {
    e.stopPropagation();
    fn();
  };
  return (
    <aside
      class={`panel docs${dropping ? " dropping" : ""}`}
      ref={ref}
      onDragOver={(e) => (e.preventDefault(), setDropping(true))}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDropping(false);
        const file = e.dataTransfer?.files[0];
        if (file) void store.importFile(file);
      }}
    >
      <div class="panel-head">
        <span>Documents</span>
        <span class="keys">
          {typing ? "type to filter · ↑ ↓ · Enter open · Esc for actions" : "j k · Enter open · n new · r rename · s save as · D delete · x export · i import · / filter · Esc"}
        </span>
      </div>
      <input
        class="filter"
        ref={(el) => {
          if (el && typing && document.activeElement !== el) el.focus();
        }}
        value={m.filter}
        placeholder="Filter by title or text…"
        onFocus={() => m.focus !== "filter" && ((m.focus = "filter"), store.emit())}
        onInput={(e) => store.menuFilter((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          const k = e.key;
          if (k === "ArrowDown" || (e.ctrlKey && (k === "n" || k === "j"))) (e.preventDefault(), store.menuMove(1));
          else if (k === "ArrowUp" || (e.ctrlKey && (k === "p" || k === "k"))) (e.preventDefault(), store.menuMove(-1));
          else if (k === "Enter") {
            e.preventDefault();
            // The selection as it is now: the filter may have changed since this was drawn.
            const now = store.menuSelected();
            if (now) store.openDoc(now.node);
          } else if (k === "Escape" || k === "Tab") {
            e.preventDefault();
            m.focus = "list";
            (e.target as HTMLInputElement).blur();
            store.emit();
          }
        }}
      />
      {m.prompt && <TitlePrompt />}
      {m.confirm && (
        <div class="confirm">
          Delete “{clip(items.find((d) => d.node === m.confirm)?.title ?? "", 60)}” and everything in it? u brings it back.
          <div class="actions">
            <button onClick={act(() => store.deleteDocument(m.confirm!))}>delete (y)</button>
            <button onClick={act(() => ((m.confirm = null), store.emit()))}>keep (n)</button>
          </div>
        </div>
      )}
      {m.problems && (
        <div class="problems">
          <b>The file was not imported:</b>
          <ul>
            {m.problems.slice(0, 30).map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      <ul class="doclist">
        {items.map((d) => {
          const selected = d.node === sel?.node;
          return (
            <li
              key={d.node}
              class={`item doc${selected ? " selected" : ""}${d.node === current ? " current" : ""}`}
              data-doc={d.slug}
              onClick={() => {
                // A click in the list hands the keys to the list.
                m.selected = d.node;
                m.focus = "list";
                (document.activeElement as HTMLElement | null)?.blur();
                store.emit();
              }}
              onDblClick={() => store.openDoc(d.node)}
            >
              <div class="line">
                <span class="title">{d.title || "Untitled"}</span>
                <span class="when">{d.node === current ? `open · ${SAVE_LABEL[store.saveState()]}` : `/doc/${d.slug}`}</span>
              </div>
              <div class="sub">{d.excerpt || "No text yet."}</div>
              {selected && (
                <div class="actions">
                  {d.node !== current && <button onClick={act(() => store.openDoc(d.node))}>open</button>}
                  <button onClick={act(() => store.menuPrompt("rename"))}>rename</button>
                  <button onClick={act(() => store.menuPrompt("duplicate"))}>save as</button>
                  <button onClick={act(() => store.exportDocument(d.node))}>export .md</button>
                  <button onClick={act(() => ((m.confirm = d.node), store.emit()))}>delete</button>
                </div>
              )}
            </li>
          );
        })}
        {!items.length && <li class="none">No document matches.</li>}
      </ul>
      <div class="panel-foot">
        <button onClick={act(() => store.menuPrompt("new"))}>new document (n)</button>
        <button onClick={act(() => store.pickFile())}>import .md (i)</button>
        <span>or drop a .md file here</span>
      </div>
    </aside>
  );
}
