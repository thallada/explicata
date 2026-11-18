import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "preact/hooks";
import { ancestors, isLibraryRoot, label, sections, staleness, type Conflict, type NodeId } from "../core/model";
import { verifyHistory, type Commit } from "../core/repo";
import { clip, plain } from "../core/text";
import { hostOf } from "../core/ref";
import { nodeRef } from "../core/links";
import { HELP, handleKey } from "./keys";
import { DocBar, LibrariesPanel } from "./Menu";
import { LinkCard, LinkPicker, LinksPanel, NodeBacklinks, NodeRelated, TargetRow } from "./Links";
import { NodeBody, Outline, PendingSections, TopMatter } from "./Node";
import { Panes } from "./Panes";
import { PaneMap, Trail } from "./Pages";
import { PANES_MIN_WIDTH, rowId, store, type Aux } from "./store";
import { ArticlePage, ArticleView } from "./Web";
import { Usage } from "./Usage";
import { FirstRun, Hints, Key, MenuHost, SelBar, closeMenu, dragged, hideBar, locate, locateIn, menuAt, pointedPane, setCard, setPrompt, showBar, touch, wtextRow, type Hint } from "./Mouse";
import { press } from "./press";

function Page() {
  if (store.colWiki) return <ArticlePage />;
  const kids = sections(store.snap, store.top);
  return (
    <article class={store.preview ? "preview" : ""}>
      <TopMatter id={store.top} />
      {kids.length > 0 && <Outline ids={kids} />}
      <PendingSections id={store.top} />
      {store.articleUnder(store.top) ? <ArticleView host={`n${store.top}`} /> : <TargetRow id={store.top} />}
      <NodeBacklinks id={store.top} />
      <NodeRelated id={store.top} />
    </article>
  );
}

// ---- panels ----

const ago = (t: number) => {
  const s = Math.max(0, Date.now() / 1000 - t);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

function ConflictCard({ c, selected }: { c: Conflict; selected: boolean }) {
  const kind = { "edit-edit": "both sides rewrote this", "edit-delete": "edited on one side, deleted on the other", contradiction: "contradicts another node" }[c.type];
  const other = c.other && store.snap.nodes[c.other] ? label(store.snap, c.other) : null;
  return (
    <div class={`item conflict ${c.status}${selected ? " selected" : ""}`}>
      <div class="line">
        <b>{c.title || "(untitled)"}</b>
        <span class="chip">{c.status}</span>
      </div>
      <div class="sub">
        {kind}
        {other ? `: “${other}”` : ""}
      </div>
      {selected && (
        <div class="sides">
          {c.type !== "contradiction" && <Side name="before" text={c.base} />}
          <Side name={c.type === "contradiction" ? "the other node says" : "side A (1)"} text={c.a} />
          {c.type === "edit-delete" ? <Side name="side B (2)" text="(deleted the node)" /> : <Side name={c.type === "contradiction" ? "this node said" : "side B (2)"} text={c.b} />}
          {c.type === "edit-edit" && <Side name="mechanical merge (3)" text={c.merged} />}
          {c.status === "resolved" && <Side name={`resolved by ${c.resolvedBy}`} text={c.resolved || "(left deleted)"} strong />}
          {c.rationale && <div class="why">{c.rationale}</div>}
          <div class="actions">
            {c.status === "open" ? (
              <>
                <button onClick={() => store.settle(c.id, "a")}>take A</button>
                {c.type !== "contradiction" && <button onClick={() => store.settle(c.id, "b")}>{c.type === "edit-delete" ? "keep deleted" : "take B"}</button>}
                {store.generating && <button onClick={() => store.resolveAll()}>ask the model</button>}
              </>
            ) : (
              <button onClick={() => store.reopen(c.id)}>reopen (x)</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Side({ name, text, strong }: { name: string; text: string; strong?: boolean }) {
  return (
    <div class={`side${strong ? " strong" : ""}`}>
      <span class="name">{name}</span>
      <span class="text">{text}</span>
    </div>
  );
}

function HistoryPanel({ verdict }: { verdict: string }) {
  const items = store.panel();
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    ref.current?.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
  });
  const heads = new Set<string>();
  const live = store.doc.snap();
  const filter = store.historyFilter && live.nodes[store.historyFilter] ? store.historyFilter : null;
  const onRoot = isLibraryRoot(live, store.activeNode);
  return (
    <aside class="panel" ref={ref}>
      <div class="panel-head">
        <span>History{filter ? ` · ${clip(label(live, filter), 30)}` : " · the library"}</span>
        <span class="keys">
          <Hints hint={["j k", ["Enter", "view"], ["r", `revert ${onRoot ? "the library" : "this node"}`], ["n", "branch"], ["m", "merge"], ["f", filter ? "everything" : "this node"], ["v", "verify"], ["Escape", "close"]]} />
        </span>
      </div>
      {verdict && <div class="verdict">{verdict}</div>}
      {items.map((it, i) => {
        const selected = i === store.historyIndex;
        const head = !heads.has(it.type) ? ({ conflict: "Conflicts", branch: "Branches", commit: "Commits" } as const)[it.type] : null;
        heads.add(it.type);
        const pick = () => {
          store.historyIndex = i;
          store.emit();
        };
        return (
          <div key={it.type === "commit" ? it.commit.id : it.type === "branch" ? `b:${it.branch}` : `c:${it.conflict.id}`} onClick={pick}>
            {head && <h3>{head}</h3>}
            {it.type === "conflict" && <ConflictCard c={it.conflict} selected={selected} />}
            {it.type === "branch" && (
              <div class={`item branch${selected ? " selected" : ""}`}>
                <span class="line">
                  {it.branch === store.repo.current ? "● " : "○ "}
                  {it.branch}
                </span>
                {it.branch === store.repo.current ? <span class="sub">current</span> : <span class="sub">Enter switch · m merge into {store.repo.current}</span>}
              </div>
            )}
            {it.type === "commit" && <CommitRow c={it.commit} selected={selected} />}
          </div>
        );
      })}
    </aside>
  );
}

function CommitRow({ c, selected }: { c: Commit; selected: boolean }) {
  const viewing = store.preview?.commit.id === c.id;
  const snap = store.doc.snap();
  const under = store.touchedTops(c).map((d) => snap.nodes[d]?.title ?? "");
  return (
    <div class={`item commit${selected ? " selected" : ""}${viewing ? " viewing" : ""}`}>
      <div class="line">
        <code class="hash">{c.hash ? c.hash.slice(0, 7) : "·······"}</code>
        <span class="msg">{c.message}</span>
      </div>
      <div class="sub">
        {c.by}
        {c.actor === "llm" ? " (model)" : ""} · {ago(c.time)}
        {c.parents.length > 1 ? " · merge" : ""}
        {c.tag ? ` · ${c.tag}` : ""}
        {viewing ? " · viewing" : ""}
      </div>
      {under.length > 0 && (
        <div class="under" title={under.join(", ")}>
          under: {under.length > 3 ? `${under.slice(0, 3).map((t) => clip(t, 24)).join(" · ")} · and ${under.length - 3} more` : under.map((t) => clip(t, 30)).join(" · ")}
        </div>
      )}
    </div>
  );
}

function Help() {
  return (
    <div class="overlay" onClick={() => store.setMode("normal")}>
      <div class="help" onClick={(e) => e.stopPropagation()}>
        <h2>Keys</h2>
        <p class="lede">
          Focus is a node and a grain. Start on a section, press <kbd>i</kbd> to move by sentence, <kbd>i</kbd> again by word, and <kbd>e</kbd> on
          anything to go deeper. Text with a dotted underline already has an expansion; anything else is written on request. With a mouse, click a
          sentence; every menu names the key that does the same.
        </p>
        <div class="cols">
          {HELP.map(([head, rows]) => (
            <section key={head}>
              <h3>{head}</h3>
              <dl>
                {rows.map(([keys, what]) => (
                  <div key={keys}>
                    <dt>
                      {!keys ? null : keys.length > 1 && keys.startsWith("/") ? <code>{keys}</code> : keys.split(" ").map((k) => <kbd key={k}>{k}</kbd>)}
                    </dt>
                    <dd>{what}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * The jump box (/): sections anywhere in the library, by title and text. The same box is the
 * picker of Move under… (M), where it offers the library root too and never the node being moved.
 */
function Jump({ move }: { move?: boolean }) {
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const hits = move ? store.moveTargets(q) : store.search(q);
  const snap = store.snap;
  const close = () => (move ? store.cancelMove() : store.setMode("normal"));
  const pick = (id: NodeId) => (move ? store.moveUnder(id) : store.jumpTo(id));
  const moving = move && store.moving && snap.nodes[store.moving] ? label(snap, store.moving) : "";
  return (
    <div class="overlay" onClick={close}>
      <div class={`jump${move ? " move" : ""}`} onClick={(e) => e.stopPropagation()}>
        {move && <div class="jump-head">Move “{clip(moving, 50)}” and everything under it under…</div>}
        <input
          autoFocus
          ref={(el) => el?.focus()}
          placeholder={move ? "The node to move it under…" : "Jump to a section, anywhere in the library…"}
          value={q}
          onInput={(e) => (setQ((e.target as HTMLInputElement).value), setI(0))}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") close();
            else if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) (e.preventDefault(), setI(Math.min(hits.length - 1, i + 1)));
            else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) (e.preventDefault(), setI(Math.max(0, i - 1)));
            else if (e.key === "Enter" && hits[i]) pick(hits[i]);
          }}
        />
        <ul>
          {hits.map((id, k) => {
            // Where it is: the titles down to it from the library root, the first of them bold.
            const path = ancestors(snap, id).reverse().slice(1);
            return (
              <li key={id} class={k === i ? "selected" : ""} data-hit={id} onClick={() => pick(id)}>
                <span class="t">{label(snap, id)}</span>
                <span class="p">
                  {isLibraryRoot(snap, id) ? (
                    <b class="in">the library root</b>
                  ) : path.length ? (
                    <>
                      <b class="in">{snap.nodes[path[0]].title}</b>
                      {path.length > 1 ? ` › ${path.slice(1).map((a) => snap.nodes[a].title).join(" › ")}` : ""}
                    </>
                  ) : (
                    <b class="in">{label(snap, snap.root)}</b>
                  )}
                </span>
              </li>
            );
          })}
          {!hits.length && <li class="none">Nothing matches.</li>}
        </ul>
      </div>
    </div>
  );
}

function CommandBar({ prefill }: { prefill: string }) {
  const f = store.focus;
  const snap = store.snap;
  const words = store.selectedText();
  const about = words !== null ? `ask about “${clip(plain(words), 48)}”` : `tell the editor · ${clip(label(snap, f.node), 40)}`;
  return (
    <div class="command">
      <span class="prompt">{about}</span>
      <input
        ref={(el) => {
          if (el && document.activeElement !== el) {
            el.focus();
            el.setSelectionRange(el.value.length, el.value.length);
          }
        }}
        defaultValue={prefill}
        placeholder={words !== null ? "why? · example · how does this fail? …" : "add a section on… · tighten this · /branch name · /merge name"}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") {
            store.branchFrom = null;
            store.setMode("normal");
          } else if (e.key === "Enter") {
            e.preventDefault();
            store.command((e.target as HTMLInputElement).value);
          }
        }}
        onBlur={() => store.mode === "command" && store.setMode("normal")}
      />
    </div>
  );
}

/** What a popup shows for a note: its text; for a link, its target's card; for a note that links, both. */
function PopupBody({ note }: { note: NodeId }) {
  const n = store.snap.nodes[note];
  return (
    <>
      {n.body.trim() && <NodeBody id={note} inline inNote />}
      {n.ref && <LinkCard r={n.ref} compact />}
    </>
  );
}

const place = (x: number, top: number, bottom: number): Record<string, string> => ({
  left: `${Math.max(12, Math.min(window.innerWidth - 452, x - 40))}px`,
  ...(top < 260 ? { top: `${bottom + 8}px` } : { bottom: `${window.innerHeight - top + 8}px` }),
});

/** The hover preview: shown after a pause on a marked span, gone when the pointer leaves it or a key is pressed. */
function Popup() {
  const p = store.popup;
  const snap = store.snap;
  if (!p || !snap.nodes[p.note] || store.open.has(p.note)) return null;
  return (
    <div class="popup" style={place(p.x, p.top, p.bottom)}>
      <PopupBody note={p.note} />
    </div>
  );
}

/**
 * The keyboard's preview: while the selection is exactly a link's words, its card shows beside
 * them. It is drawn from the focus, so it moves and goes with the focus in the same frame and can
 * never outlive it.
 */
function FocusPopup() {
  const f = store.focus;
  // Not on touch: a long press shows the card above its menu, and a tap only opens the link.
  const note = f.grain !== "node" && store.mode === "normal" && !store.popup && !store.aux && !touch() ? store.noteAt(f.range) : undefined;
  const n = note ? store.snap.nodes[note] : undefined;
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const sel = [...document.querySelectorAll<HTMLElement>(".sel")].find((x) => x.offsetParent);
    if (!sel) return void (el.style.visibility = "hidden");
    const r = sel.getBoundingClientRect();
    Object.assign(el.style, { left: "", top: "", bottom: "", ...place(r.left + 40, r.top, r.bottom), visibility: "visible" });
  });
  if (!note || !n?.ref || store.open.has(note)) return null;
  return (
    <div class="popup focus-popup" ref={ref} style={{ visibility: "hidden" }}>
      <PopupBody note={note} />
    </div>
  );
}

/**
 * A research run of the editor, above the status line: each search, page read and edit as it
 * happens, then the summary and the sources it linked. Esc stops the run, or puts the panel away.
 */
function AgentPanel() {
  const run = store.agentRun;
  if (!run?.research) return null;
  const all = run.steps;
  const steps = all.slice(-8);
  return (
    <div class="agent-panel" data-agent={run.running ? "running" : "done"}>
      <div class="agent-head">
        <span class="agent-label">editor</span>
        {run.running ? "researching on the web · " : "done · "}
        <Key k="Escape" what={run.running ? "stop" : "close"} />
      </div>
      <ol class="agent-steps">
        {all.length > steps.length && <li class="agent-more">{all.length - steps.length} earlier steps</li>}
        {steps.map((s, i) => (
          <li key={all.length - steps.length + i}>{s}</li>
        ))}
      </ol>
      {!run.running && run.summary && <div class="agent-summary">{run.summary}</div>}
      {!run.running && run.sources && (
        <div class="agent-sources">
          {run.sources.length ? "Sources: " : "No sources were linked."}
          {run.sources.map((s, i) => (
            <span key={s.url}>
              {i ? " · " : ""}
              <a href={s.url} target="_blank" rel="noopener noreferrer">
                {s.title || hostOf(s.url)}
              </a>{" "}
              <span class="agent-host">{hostOf(s.url)}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function StatusLine() {
  const f = store.focus;
  const snap = store.snap;
  const n = snap.nodes[f.node];
  const st = staleness(snap, f.node);
  const path = [...ancestors(snap, f.node).reverse(), f.node].map((id) => clip(label(snap, id), 28)).join(" › ");
  const selecting = f.grain !== "node";
  const lensHint: Hint = [["e", `expand${store.generating ? "" : " (no model)"}`], ["d", "define"], ["y", "why"], ["x", "example"], ["c", "challenge"], [":", "ask"]];
  const sugg = selecting && store.focusedSuggestion();
  const commentary = selecting && store.commentaryAt(f.range);
  const noteHere = selecting && store.noteAt(f.range);
  // The links list: where it is, and its keys as buttons (unless something has just been said).
  const row = store.mode === "review" && !store.status ? store.reviewRow() : undefined;
  const reviewing: Hint | null =
    store.mode === "review" && !store.status
      ? row
        ? [`${store.reviewRows().findIndex((x) => x.key === row.key) + 1}/${store.reviewRows().length} ${row.status}`, ...(row.status !== "linked" ? [["y", "link"] as [string, string]] : []), ...(row.status !== "rejected" ? [["n", row.status === "linked" ? "remove" : "decline"] as [string, string]] : []), ["j", "next"], ["Enter", "go"], ["Escape", "close"]]
        : ["links list", ["1", "linked"], ["2", "rejected"], ["3", "pending"], ["Escape", "close"]]
      : null;
  // The libraries panel: its keys, or the question a deletion waits on.
  const lp = store.libs;
  const libsHint: Hint | null =
    lp && !store.status
      ? lp.confirm
        ? [`delete “${clip(store.libraries.find((l) => l.id === lp.confirm)?.title ?? "", 40)}”?`, ["y", "delete"], ["n", "keep"]]
        : lp.edit
          ? [lp.edit.kind === "new" ? "the new library's name" : "the library's new name", "⏎ keeps it", ["Escape", "leave it"]]
          : ["j k", ["Enter", "open"], ["n", "new"], ["r", "rename"], ["D", "delete"], ["Escape", "close"]]
      : null;
  const auxTo = store.aux ? store.auxTarget(store.aux) : null;
  // Where a focused link in an article's text goes, as Enter's hint names it: the article, or the page's host.
  const auxToName = !auxTo ? "" : auxTo.kind === "wiki" ? `“${clip(auxTo.title, 40)}”` : clip(hostOf(auxTo.kind === "url" ? auxTo.url : ""), 40);
  const hint: Hint = store.aux
    ? store.aux.kind === "wiki"
      ? store.inArticleText
        ? store.articleNoteHere()
          ? [["Enter", "open/enter the note"], ["e", "toggle"], ["D", "delete note"], ["Tab", "next"]]
          : auxTo
            ? [["Enter", `opens ${auxToName}`], "e d y x c annotate", ["W", auxTo.kind === "wiki" ? "on wikipedia.org" : "the original"]]
            : [...lensHint, ["Escape", "widen"]]
        : [store.onWeb ? "web page · j k rows" : "Wikipedia · j k rows", ["l", "open"], ["h", "back"], ["i", "select words"], ["Tab", "links and notes"], ["W", store.onWeb ? "the original" : "on wikipedia.org"], ...(store.panes ? [["q", "close"] as [string, string]] : [])]
      : store.aux.kind === "target" ? [["Enter", "opens what this is about"]]
      : [["Enter", "goes to the linking note"]]
    : store.preview
    ? ["read-only", ["r", "revert to this"], ["n", "branch from this"], ["Escape", "back to now"]]
    : sugg
      ? [`suggested link → ${clip(sugg.title, 40)}`, ["y", "link"], ["n", "decline"], ["Tab", "next"], ["S", "list all"]]
    : selecting
      ? commentary
        ? [["Enter", `opens the note with ${store.targetOf(commentary)!.kind === "wiki" ? "its article" : "what it links to"}`], ["e", "shows the note here"], ["D", "delete note"], ["w", "retarget"]]
      : noteHere
        ? store.snap.nodes[noteHere].ref
          ? [["Enter", "open the link"], ["w", "retarget"], ["D", "remove"], ...(store.snap.nodes[noteHere].ref!.kind === "wiki" ? [["W", "on Wikipedia"] as [string, string]] : store.snap.nodes[noteHere].ref!.kind === "url" ? [["W", "the original"] as [string, string]] : [])]
          : [["Enter", "open/enter"], ["e", "toggle"], ["D", "delete note"], ["w", "link it"]]
        : [...lensHint, ["w", "link"]]
      : st.up || st.down
        ? ["stale", ...((n.pinned ? [["b", "accept"], ["p", "unlock"]] : [["R", "reconcile"], ["b", "accept"]]) as [string, string][])]
        : [];
  return (
    <footer class="status">
      <span class={`grain ${lp || store.aux ? "aux" : f.grain}`}>{lp ? "libraries" : store.preview ? "history" : store.mode === "review" ? "review" : store.aux ? (store.aux.kind === "wiki" ? "article" : store.aux.kind === "back" ? "linked" : "target") : f.grain}</span>
      <span class="path">{path}</span>
      <span class="message">{libsHint ? <Hints hint={libsHint} /> : reviewing ? <Hints hint={reviewing} /> : store.status || (hint.length ? <Hints hint={hint} /> : <FirstRun />)}</span>
      <span class="right">
        {store.links.job?.state === "running" && (
          <span class="job" title={store.jobText(store.links.job)}>
            links {store.links.job.done}/{store.links.job.total} · :/linkcancel
          </span>
        )}
        {store.busy > 0 && <span class="spin" />}
        <Usage />
        <span title="branch">{store.repo.current}</span>
        <span title="model">{store.llm.kind === "off" ? "no model" : store.llm.model}</span>
        <span class={`dot ${store.online ? "on" : "off"}`} title={store.online ? "synced with the local server" : "offline: changes are kept locally"} />
        <span class="q">
          <Key k="?" what="keys" />
        </span>
      </span>
    </footer>
  );
}

// ---- the app ----

let hover: ReturnType<typeof setTimeout> | undefined;
/** A press or a click: a preview waiting to show does not, and one showing goes. */
function dropPopup() {
  clearTimeout(hover);
  if (!store.popup) return;
  store.popup = null;
  store.emit(store.top);
}
/** The active pane when last drawn: a preview does not outlive a move to another. */
let shownPane = "";
/** The focus last scrolled into view (App's layout effect). */
let shownFocus = "";

export function App() {
  const [, tick] = useReducer((x: number) => x + 1, 0);
  const [prefill, setPrefill] = useState("");
  const [verdict, setVerdict] = useState("");
  useEffect(() => store.subscribe(() => tick(0)), []);

  useEffect(() => {
    const openCommand = (text = "") => {
      setPrefill(text);
      store.setMode("command");
    };
    setPrompt(openCommand);
    // A long press on a link (touch) shows what it opens above its menu.
    setCard((note) => <PopupBody note={note} />);
    const onKey = (e: KeyboardEvent) => {
      clearTimeout(hover);
      // Esc puts the map of panes away first.
      if (e.key === "Escape" && store.paneMap) {
        e.preventDefault();
        return store.showMap(false);
      }
      // The keys take over from the pointer: its bar and menu go (not for a modifier, or the copy key).
      if (!e.ctrlKey && !e.metaKey && !e.altKey && !["Shift", "Control", "Alt", "Meta"].includes(e.key)) {
        hideBar();
        closeMenu(false);
      }
      dropPopup();
      handleKey(e, {
        openCommand,
        verify() {
          const t = performance.now();
          const v = verifyHistory(store.doc);
          setVerdict(
            v.mismatches.length
              ? `${v.mismatches.length} of ${v.checked} commits do NOT reproduce their recorded hash.`
              : `Verified: all ${v.checked} hashed commits reproduce byte-for-byte${v.unhashed ? ` (${v.unhashed} undo/redo steps carry no hash)` : ""}. ${Math.round(performance.now() - t)} ms.`,
          );
        },
      });
    };
    // The copy key copies the words selected, when the browser has none of its own selected.
    const onCopy = (e: ClipboardEvent) => {
      const words = store.mode === "normal" && window.getSelection()?.isCollapsed !== false ? store.selectedText() : null;
      if (!words || !e.clipboardData) return;
      e.clipboardData.setData("text/plain", plain(words));
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("copy", onCopy);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("copy", onCopy);
    };
  }, []);

  // `auto` picks the layout from the window's width, so follow the width.
  useEffect(() => {
    const onResize = () => {
      const wide = window.innerWidth >= PANES_MIN_WIDTH;
      if (wide === store.wide) return;
      store.wide = wide;
      store.paneMap = false;
      if (store.settings.view === "auto") store.emit();
    };
    window.addEventListener("resize", onResize);
    // An on-screen keyboard covers the foot of the screen without resizing the page (iOS): what sits
    // at the foot (the status line, the command line, the selection bar) is raised above it.
    const vv = window.visualViewport;
    const onViewport = () => {
      if (!vv) return;
      const typing = (document.activeElement as HTMLElement | null)?.matches?.("input, textarea, [contenteditable]");
      const kb = typing && Math.abs(vv.scale - 1) < 0.01 ? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) : 0;
      const v = `${kb}px`;
      if (document.documentElement.style.getPropertyValue("--kb") !== v) document.documentElement.style.setProperty("--kb", v);
    };
    vv?.addEventListener("resize", onViewport);
    window.addEventListener("focusin", onViewport);
    window.addEventListener("focusout", onViewport);
    return () => {
      window.removeEventListener("resize", onResize);
      vv?.removeEventListener("resize", onViewport);
      window.removeEventListener("focusin", onViewport);
      window.removeEventListener("focusout", onViewport);
    };
  }, []);

  // Keep the focused thing in view, and time keypress → paint.
  useLayoutEffect(() => {
    if (!store.ready) return;
    const f = store.focus;
    // Only when the focus, the page or the mode has changed: a render for something that arrived
    // in the background (a list fetched, a scan's suggestions) leaves the page where the reader
    // scrolled it. The panes keep their own focus in view (Panes.tsx).
    const key = JSON.stringify([f, store.aux, store.mode, store.panes, store.top, store.colWiki?.title, store.colWiki?.url]);
    const moved = key !== shownFocus;
    shownFocus = key;
    // Another pane opened or gone to (as pages, another page): no preview stays over it.
    const pane = store.panes ? `${store.paneAt}|${store.branchNodes[store.paneAt]?.id}` : "";
    if (pane !== shownPane) (shownPane = pane), dropPopup();
    const el =
      moved &&
      !store.panes &&
      ((f.grain !== "node" && document.querySelector(".sel")) ||
        document.querySelector(`[data-row="${CSS.escape(f.node)}"]`) ||
        document.querySelector(`[data-node="${CSS.escape(f.node)}"]`));
    if (el && store.mode !== "edit") el.scrollIntoView({ block: "nearest" });
    store.clean();
    const t = store.t0;
    if (t) {
      store.t0 = null;
      requestAnimationFrame(() => {
        const ch = new MessageChannel();
        ch.port1.onmessage = () => store.addSample(t, performance.now() - t.at);
        ch.port2.postMessage(0);
      });
    }
  });

  if (store.fatal) return <div class="fatal">{store.fatal}</div>;
  if (!store.ready) return <div class="loading">Loading…</div>;

  const panes = store.panes;
  // A click opens beside what is open (so do Ctrl-, Cmd- and middle clicks); a Shift-click in its place.
  const onClick = (e: MouseEvent) => (dropPopup(), store.withReplace(e.shiftKey, () => click(e)));
  const click = (e: MouseEvent) => {
    if (store.mode === "edit") return;
    const target = e.target as HTMLElement;
    // The selection bar sits in its pane in the panes view: its own buttons act.
    if (target.closest(".selbar")) return;
    // A ⋯ (a row's, a pane's, the page's, a note's): its menu, for what it is on.
    const more = target.closest<HTMLElement>("[data-more]");
    if (more) return void menuAt(more, more);
    // A pane's × and pin act on that pane, wherever the focus is.
    const ctl = target.closest<HTMLElement>("[data-close], [data-pin]");
    if (ctl) return ctl.dataset.close ? store.closePane(Number(ctl.dataset.close)) : store.togglePanePin(Number(ctl.dataset.pin));
    const { paneEl, paneIndex, tid, host } = pointedPane(target);
    // A pane in another fork: that fork becomes the focused branch first, then the click does what it would there.
    if (tid !== undefined && store.branchNodes[paneIndex]?.id !== tid) store.enterFork(tid);
    // A covered pane's spine brings that pane back by focusing it.
    const spine = target.closest<HTMLElement>("[data-spine]");
    if (spine) return store.land(Number(spine.dataset.spine));
    // Article text: a link to another article opens it next (in the link's own language, a web
    // page's links say theirs), as does a web page's link to another page; a link out leaves in a
    // new tab (the HTML says so); nothing else navigates.
    const a = target.closest<HTMLAnchorElement>("a");
    if (a && host) {
      if (a.dataset.wiki) {
        e.preventDefault();
        store.paneAt = paneIndex;
        const h = store.wikiHost(host);
        return store.follow({ kind: "wiki", title: a.dataset.wiki, lang: a.dataset.wikiLang ?? h?.lang ?? store.wiki.lang });
      }
      if (a.dataset.url && target.closest(".wiki-text")) {
        e.preventDefault();
        store.paneAt = paneIndex;
        return store.follow({ kind: "url", url: a.dataset.url });
      }
      if (!/^https?:/.test(a.getAttribute("href") ?? "")) e.preventDefault();
      return;
    }
    // A figure: what its data-full names, in a new tab: a web page's image itself, a Wikipedia
    // picture's File page (its author and licence). A video's facade plays instead (Wiki.tsx).
    const img = host ? target.closest<HTMLImageElement>(".wiki-text img[data-full]") : null;
    if (img) {
      e.preventDefault();
      window.open(img.dataset.full!, "_blank", "noopener,noreferrer");
      return;
    }
    if (a && target.closest(".wattr")) return;
    const wrow = target.closest<HTMLElement>("[data-wrow], [data-sense]");
    if (wrow && host) {
      store.paneAt = paneIndex;
      const id = rowId(wrow.dataset.wrow);
      const ss = wrow.dataset.sense;
      if (ss) return store.follow({ kind: "wiki", title: ss, lang: store.wikiHost(host)?.lang ?? store.wiki.lang });
      store.setFocus(store.focus, { kind: "wiki", host, row: { t: "sec", id } } as Aux);
      return store.auxActivate();
    }
    const linking = target.closest<HTMLElement>("[data-linking]");
    if (linking) {
      store.paneAt = paneIndex;
      return store.openLinking(linking.dataset.linking as NodeId);
    }
    const related = target.closest<HTMLElement>("[data-related]");
    if (related) {
      store.paneAt = paneIndex;
      return store.follow(nodeRef(store.snap, related.dataset.related as NodeId));
    }
    const targetRow = target.closest<HTMLElement>("[data-target]");
    if (targetRow) {
      store.paneAt = paneIndex;
      const r = store.targetOf(targetRow.dataset.target as NodeId);
      return r && store.follow(r);
    }
    if (host && target.closest(".wiki-head")) {
      store.paneAt = paneIndex;
      return store.setFocus(store.focus, { kind: "wiki", host, row: { t: "head" } });
    }
    const selection = window.getSelection();
    // In an article's text: a drag selects words, an annotation's words open it, a click selects the sentence.
    const wtext = target.closest<HTMLElement>("[data-wtext]");
    if (host && wtext && !target.closest("[data-node]")) {
      store.paneAt = paneIndex;
      const row = wtextRow(wtext);
      const at = (n: Node | null, o: number) => (n && wtext.contains(n) ? locateIn(n, o) : null);
      const a = selection && !selection.isCollapsed ? at(selection.anchorNode, selection.anchorOffset) : null;
      const b = selection && !selection.isCollapsed ? at(selection.focusNode, selection.focusOffset) : null;
      if (a !== null && b !== null && a !== b) {
        selection!.removeAllRanges();
        store.selectInArticle(host, row, [Math.min(a, b), Math.max(a, b)], "word");
        return showBar();
      }
      const note = target.closest<HTMLElement>("[data-note]")?.dataset.note as NodeId | undefined;
      if (note) return store.toggleAnnotation(host, row, note);
      const o = selection ? at(selection.anchorNode, selection.anchorOffset) : null;
      if (o !== null) return store.selectInArticle(host, row, [o, o], "sentence"), showBar();
      return;
    }
    // A drag selection inside one body becomes the focus range.
    const d = store.replacing ? null : dragged(selection);
    if (d) {
      store.go(d.id, "word", d.range);
      selection!.removeAllRanges();
      return showBar();
    }
    const anchor = target.closest<HTMLElement>("[data-note]");
    if (anchor?.dataset.note) {
      const id = anchor.dataset.note as NodeId;
      const n = store.snap.nodes[id];
      const a = n.anchors[0];
      store.popup = null;
      // Words with a note and a target open as one page: the note's text, then the article.
      const both = store.commentaryAt([a.start, a.end], n.parent!);
      if (both) {
        store.paneAt = paneIndex;
        store.go(n.parent!, "word", [a.start, a.end]);
        return store.openCommentary(both);
      }
      if (n.ref && (store.panes || store.open.has(id)) && !n.body.trim()) {
        // A link: in panes it opens next to its pane; in the column, once its preview is open.
        store.paneAt = paneIndex;
        store.go(n.parent!, "word", [a.start, a.end]);
        return store.follow(n.ref);
      }
      if (store.open.has(id)) store.open.delete(id);
      else store.open.add(id);
      store.go(n.parent!, "word", [a.start, a.end]);
      if (!store.open.has(id)) store.saveView();
      return;
    }
    const row = target.closest<HTMLElement>("[data-row]");
    if (row) {
      const id = row.dataset.row as NodeId;
      if (panes && id !== store.top) {
        // In panes a click shows the row's pane: focus it and open it next (or focus it where it is open).
        store.paneAt = paneIndex;
        store.go(id);
        store.open.add(id);
        const holder = store.trail[paneIndex];
        if (store.snap.nodes[id]?.kind === "section" && holder?.kind === "node" && store.snap.nodes[id].parent === holder.id) {
          store.openPane(paneIndex, { kind: "node", id });
          // As pages, a tap on a row goes to its pane: the next page.
          if (store.pages) store.land(paneIndex + 1);
        }
        return;
      }
      store.go(id);
      if (id !== store.top) store.toggle(id);
      return;
    }
    const at = selection && locate(selection.anchorNode, selection.anchorOffset);
    // A click in a node's text selects the sentence, and the bar offers what can be done with it.
    const hit = at && store.sentenceAt(at.id, at.at);
    if (at && hit) return store.go(at.id, "sentence", hit), showBar();
    const node = target.closest<HTMLElement>("[data-node]");
    if (!node) {
      // Anywhere else in a pane (its margins, under its text, a list's gaps): that pane becomes the active one, and any selection goes.
      if (panes && paneEl) return store.land(paneIndex);
      // Anywhere else on the page: the selection goes.
      for (let i = 0; i < 3 && (store.focus.grain !== "node" || store.inArticleText); i++) press("Escape");
      return;
    }
    // Anything else of a node in a pane makes that pane the active one.
    if (panes && paneEl) store.paneAt = paneIndex;
    store.go(node.dataset.node as NodeId);
  };

  // A right-click on a node, words, a row, a link or a pane: the app's menu for it, Copy first where there is text. Shift+right-click is the browser's.
  const onContext = (e: MouseEvent) => {
    const t = e.target as HTMLElement;
    if (e.shiftKey || store.mode === "edit" || t.closest("input, textarea, [contenteditable]") || !t.closest(".page")) return;
    if (menuAt(t, { x: e.clientX, y: e.clientY })) e.preventDefault();
  };

  /*
   * The hover preview is the mouse's: a finger's tap also sends pointerover (and the browser's
   * compatibility mouseover and mousemove after it, sometimes late), and a card from it would open
   * over the pane the tap opened. So only a mouse pointer's over counts; a long press shows the card
   * on touch (Mouse.tsx menuAt).
   */
  const onOver = (e: PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    const anchor = (e.target as HTMLElement).closest<HTMLElement>("[data-note]");
    clearTimeout(hover);
    if (!anchor?.dataset.note || store.open.has(anchor.dataset.note as NodeId)) {
      if (store.popup) hover = setTimeout(() => ((store.popup = null), store.emit(store.top)), 150);
      return;
    }
    const r = anchor.getBoundingClientRect();
    const note = anchor.dataset.note as NodeId;
    hover = setTimeout(() => ((store.popup = { note, x: e.clientX, top: r.top, bottom: r.bottom }), store.emit(store.top)), 450);
  };

  return (
    <div class={`app mode-${store.mode}${store.mode === "history" || store.mode === "review" ? " with-panel" : ""}${store.libs ? " with-left" : ""}${panes ? " view-panes" : ""}${store.pages ? " view-pages" : ""}`} onPointerOver={onOver} onPointerDown={dropPopup} onContextMenu={onContext}>
      <main
        class="page"
        onClick={onClick}
        onAuxClick={(e) => e.button === 1 && (e.preventDefault(), onClick(e))}
        // A Shift-click would extend the text selection, and a middle press scrolls or pastes: neither, when they open a fork.
        onMouseDown={(e) => ((e.shiftKey && e.button === 0) || e.button === 1) && !(e.target as HTMLElement).closest("input, textarea") && e.preventDefault()}
      >
        <DocBar />
        {store.preview && (
          <div class="banner">
            Viewing “{clip(store.preview.commit.message, 70)}” by {store.preview.commit.by}, {ago(store.preview.commit.time)}. Read-only.
          </div>
        )}
        {panes ? <Panes /> : <Page />}
        {store.pages && <Trail />}
      </main>
      <LibrariesPanel />
      <PaneMap />
      {store.mode === "history" && <HistoryPanel verdict={verdict} />}
      {store.mode === "review" && <LinksPanel />}
      {store.mode === "help" && <Help />}
      {store.mode === "jump" && <Jump />}
      {store.mode === "move" && <Jump move />}
      {store.mode === "command" && <CommandBar prefill={prefill} />}
      {store.mode === "link" && store.picker && <LinkPicker />}
      <Popup />
      <FocusPopup />
      <SelBar />
      <MenuHost />
      <AgentPanel />
      <StatusLine />
    </div>
  );
}
