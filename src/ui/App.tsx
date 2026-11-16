import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "preact/hooks";
import { ancestors, ancestorsInDoc, docOf, label, sections, staleness, type Conflict, type NodeId } from "../core/model";
import { verifyHistory, type Commit } from "../core/repo";
import { clip, plain } from "../core/text";
import { hostOf } from "../core/ref";
import { nodeRef } from "../core/links";
import { HELP, handleKey } from "./keys";
import { DocBar, DocsPanel } from "./Menu";
import { LinkCard, LinkPicker, LinksPanel, NodeBacklinks, NodeRelated, TargetRow } from "./Links";
import { NodeBody, Outline, PendingSections, TopMatter } from "./Node";
import { Panes } from "./Panes";
import { PANES_MIN_WIDTH, store, type Aux, type WRow } from "./store";
import { WikiPage, WikiView } from "./Wiki";
import { Usage } from "./Usage";
import { FirstRun, Hints, Key, MenuHost, SelBar, closeMenu, hideBar, locate, locateIn, menuAt, menuShown, setPrompt, showBar, type Hint } from "./Mouse";

function Page() {
  if (store.colWiki) return <WikiPage />;
  const kids = sections(store.snap, store.top);
  const listing = store.snap.library && store.top === store.snap.root;
  return (
    <article class={store.preview ? "preview" : ""}>
      <TopMatter id={store.top} />
      {kids.length > 0 && <Outline ids={kids} />}
      <PendingSections id={store.top} />
      {!listing && (store.articleUnder(store.top) ? <WikiView host={`n${store.top}`} /> : <TargetRow id={store.top} />)}
      {!listing && <NodeBacklinks id={store.top} />}
      {!listing && <NodeRelated id={store.top} />}
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
    <div class={`item conflict ${c.status}${selected ? " selected" : ""}`} data-conflict={c.id}>
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
  let lastType = "";
  return (
    <aside class="panel" ref={ref}>
      <div class="panel-head">
        <span>History{store.historyFilter && store.currentDoc ? ` · ${clip(store.snap.nodes[store.currentDoc]?.title ?? "", 30)}` : " · the library"}</span>
        <span class="keys">
          <Hints hint={["j k", ["Enter", "view"], ["r", `revert${store.currentDoc ? " this document" : ""}`], ["n", "branch"], ["m", "merge"], ["f", store.historyFilter ? "everything" : "this document"], ["v", "verify"], ["Escape", "close"]]} />
        </span>
      </div>
      {verdict && <div class="verdict">{verdict}</div>}
      {items.map((it, i) => {
        const selected = i === store.historyIndex;
        const head = it.type !== lastType && !heads.has(it.type) ? ({ conflict: "Conflicts", branch: "Branches", commit: "Commits" } as const)[it.type] : null;
        lastType = it.type;
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
  const docs = store.touchedDocs(c).map((d) => snap.nodes[d]?.title ?? "");
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
      {docs.length > 0 && (
        <div class="docs" title={docs.join(", ")}>
          {docs.length > 3 ? `${docs.slice(0, 3).map((t) => clip(t, 24)).join(" · ")} · and ${docs.length - 3} more` : docs.map((t) => clip(t, 30)).join(" · ")}
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

function Jump() {
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const hits = store.search(q);
  const snap = store.snap;
  const close = () => store.setMode("normal");
  return (
    <div class="overlay" onClick={close}>
      <div class="jump" onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus
          ref={(el) => el?.focus()}
          placeholder="Jump to a section, in any document…"
          value={q}
          onInput={(e) => (setQ((e.target as HTMLInputElement).value), setI(0))}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") close();
            else if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) (e.preventDefault(), setI(Math.min(hits.length - 1, i + 1)));
            else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) (e.preventDefault(), setI(Math.max(0, i - 1)));
            else if (e.key === "Enter" && hits[i]) store.jumpTo(hits[i]);
          }}
        />
        <ul>
          {hits.map((id, k) => {
            const d = docOf(snap, id);
            const within = ancestorsInDoc(snap, id).reverse().slice(1);
            return (
              <li key={id} class={k === i ? "selected" : ""} onClick={() => store.jumpTo(id)}>
                <span class="t">{label(snap, id)}</span>
                <span class="p">
                  {d && d !== id ? <b class="in">{snap.nodes[d].title}</b> : <b class="in">document</b>}
                  {within.length ? ` › ${within.map((a) => snap.nodes[a].title).join(" › ")}` : ""}
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
  const n = snap.nodes[f.node];
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
    <div class="popup" style={place(p.x, p.top, p.bottom)} data-popup={p.note}>
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
  const note = f.grain !== "node" && store.mode === "normal" && !store.popup && !store.aux ? store.noteAt(f.range) : undefined;
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
    <div class="popup focus-popup" ref={ref} data-popup={note} style={{ visibility: "hidden" }}>
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
              <a href={s.url} target="_blank" rel="noopener noreferrer" data-source={s.url}>
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
  const hint: Hint = store.aux
    ? store.aux.kind === "wiki"
      ? store.inArticleText
        ? store.articleNoteHere()
          ? [["Enter", "open/enter the note"], ["e", "toggle"], ["D", "delete note"], ["Tab", "next"]]
          : store.auxLink(store.aux)
            ? [["Enter", `opens “${clip(store.auxLink(store.aux)!.title, 40)}”`], "e d y x c annotate", ["W", "on wikipedia.org"]]
            : [...lensHint, ["Escape", "widen"]]
        : ["Wikipedia · j k rows", ["l", "open"], ["h", "back"], ["i", "select words"], ["Tab", "links and notes"], ["W", "on wikipedia.org"], ...(store.panes ? [["q", "close"] as [string, string]] : [])]
      : store.aux.kind === "target" ? [["Enter", "opens what this is about"]]
      : [["Enter", "goes to the linking note"]]
    : store.preview
    ? ["read-only", ["r", "revert to this"], ["n", "branch from this"], ["Escape", "back to now"]]
    : sugg
      ? [`suggested link → ${clip(sugg.title, 40)}`, ["y", "link"], ["n", "decline"], ["Tab", "next"], ["S", "review all"]]
    : selecting
      ? commentary
        ? [["Enter", `opens the note with ${store.targetOf(commentary)!.kind === "wiki" ? "its article" : "what it links to"}`], ["e", "shows the note here"], ["D", "delete note"], ["w", "retarget"]]
      : noteHere
        ? store.snap.nodes[noteHere].ref
          ? [["Enter", "open the link"], ["w", "retarget"], ["D", "remove"], ...(store.snap.nodes[noteHere].ref!.kind === "wiki" ? [["W", "on Wikipedia"] as [string, string]] : [])]
          : [["Enter", "open/enter"], ["e", "toggle"], ["D", "delete note"], ["w", "link it"]]
        : [...lensHint, ["w", "link"]]
      : st.up || st.down
        ? ["stale", ...((n.pinned ? [["b", "accept"], ["p", "unlock"]] : [["R", "reconcile"], ["b", "accept"]]) as [string, string][])]
        : [];
  return (
    <footer class="status">
      <span class={`grain ${store.aux ? "aux" : f.grain}`}>{store.preview ? "history" : store.mode === "review" ? "review" : store.aux ? (store.aux.kind === "wiki" ? "article" : store.aux.kind === "back" ? "linked" : "target") : f.grain}</span>
      <span class="path">{path}</span>
      <span class="message">{reviewing ? <Hints hint={reviewing} /> : store.status || (hint.length ? <Hints hint={hint} /> : <FirstRun />)}</span>
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

export function App() {
  const [, tick] = useReducer((x: number) => x + 1, 0);
  const [prefill, setPrefill] = useState("");
  const [verdict, setVerdict] = useState("");
  useEffect(() => store.subscribe(() => tick(0)), []);

  useEffect(() => {
    setPrompt((text) => {
      setPrefill(text);
      store.setMode("command");
    });
    const onKey = (e: KeyboardEvent) => {
      clearTimeout(hover);
      // The keys take over from the pointer: its bar and menu go (not for a modifier, or the copy key).
      if (!e.ctrlKey && !e.metaKey && !e.altKey && !["Shift", "Control", "Alt", "Meta"].includes(e.key)) {
        hideBar();
        if (menuShown()) closeMenu(false);
      }
      if (store.popup) {
        store.popup = null;
        store.emit(store.top);
      }
      handleKey(e, {
        openCommand(text = "") {
          setPrefill(text);
          store.setMode("command");
        },
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
      if (store.settings.view === "auto") store.emit();
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Keep the focused thing in view, and time keypress → paint.
  useLayoutEffect(() => {
    if (!store.ready) return;
    const f = store.focus;
    // The panes keep their own focus in view (Panes.tsx).
    const el =
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
  const onClick = (e: MouseEvent) => store.withReplace(e.shiftKey, () => click(e));
  const click = (e: MouseEvent) => {
    if (store.mode === "edit") return;
    const target = e.target as HTMLElement;
    // A ⋯ (a row's, a pane's, the page's, a note's): its menu, for what it is on.
    const more = target.closest<HTMLElement>("[data-more]");
    if (more) return void menuAt(more, more);
    // A pane's × and pin act on that pane, wherever the focus is.
    const ctl = target.closest<HTMLElement>("[data-close], [data-pin]");
    if (ctl) return ctl.dataset.close ? store.closePane(Number(ctl.dataset.close)) : store.togglePanePin(Number(ctl.dataset.pin));
    const paneEl = target.closest<HTMLElement>("[data-pane-index]");
    const paneIndex = paneEl ? Number(paneEl.dataset.paneIndex) : store.paneAt;
    // A pane in another fork: that fork becomes the focused branch first, then the click does what it would there.
    const tid = paneEl ? Number(paneEl.dataset.tid) : undefined;
    if (tid !== undefined && store.branchNodes[paneIndex]?.id !== tid) store.enterFork(tid);
    // A covered pane's spine brings that pane back by focusing it.
    const spine = target.closest<HTMLElement>("[data-spine]");
    if (spine) return store.land(Number(spine.dataset.spine));
    // Article text: a link to another article opens it next; a link out leaves in a new tab (the HTML says so); nothing else navigates.
    const named = target.closest<HTMLElement>("[data-host]")?.dataset.host;
    // An article pane off the branch is named by its place in the tree; on the branch, by its column.
    const host = named?.startsWith("f") ? `p${paneIndex}` : named;
    const a = target.closest<HTMLAnchorElement>("a");
    if (a && host) {
      if (a.dataset.wiki) {
        e.preventDefault();
        store.paneAt = paneIndex;
        const h = store.wikiHost(host);
        return store.follow({ kind: "wiki", title: a.dataset.wiki, lang: h?.lang ?? store.wiki.lang });
      }
      if (!/^https?:/.test(a.getAttribute("href") ?? "")) e.preventDefault();
      return;
    }
    if (a && target.closest(".wattr")) return;
    const wrow = target.closest<HTMLElement>("[data-wrow], [data-sense]");
    if (wrow && host) {
      store.paneAt = paneIndex;
      const id = Number(wrow.dataset.wrow);
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
      const row = (wtext.dataset.wtext === "head" ? { t: "head" } : { t: "sec", id: Number(wtext.dataset.wtext) }) as WRow;
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
    if (selection && !selection.isCollapsed && !store.replacing) {
      const a = locate(selection.anchorNode, selection.anchorOffset);
      const b = locate(selection.focusNode, selection.focusOffset);
      if (a && b && a.id === b.id && a.at !== b.at) {
        store.go(a.id, "word", [Math.min(a.at, b.at), Math.max(a.at, b.at)]);
        selection.removeAllRanges();
        return showBar();
      }
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
        if (store.snap.nodes[id]?.kind === "section" && holder?.kind === "node" && store.snap.nodes[id].parent === holder.id) store.openPane(paneIndex, { kind: "node", id });
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
    if (!node) return;
    // A pane's head makes that pane the active one.
    if (panes && paneEl && node.matches(".pane-head, .top")) store.paneAt = paneIndex;
    store.go(node.dataset.node as NodeId);
  };

  // A right-click on a node, words, a row, a link or a pane: the app's menu for it, Copy first where there is text. Shift+right-click is the browser's.
  const onContext = (e: MouseEvent) => {
    const t = e.target as HTMLElement;
    if (e.shiftKey || store.mode === "edit" || t.closest("input, textarea, [contenteditable]") || !t.closest(".page")) return;
    if (menuAt(t, { x: e.clientX, y: e.clientY })) e.preventDefault();
  };

  const onOver = (e: MouseEvent) => {
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
    <div class={`app mode-${store.mode}${store.mode === "history" || store.mode === "docs" || store.mode === "review" ? " with-panel" : ""}${panes ? " view-panes" : ""}`} onMouseOver={onOver} onContextMenu={onContext}>
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
      </main>
      {store.mode === "history" && <HistoryPanel verdict={verdict} />}
      {store.mode === "docs" && <DocsPanel />}
      {store.mode === "review" && <LinksPanel />}
      {store.mode === "help" && <Help />}
      {store.mode === "jump" && <Jump />}
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
