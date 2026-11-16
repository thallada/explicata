/** The keymap. Modal, in the manner of vim: focus is a (node, grain) pair and most keys are one stroke. */
import { inArticles } from "../core/article";
import { store } from "./store";

export const HELP: [string, [string, string][]][] = [
  [
    "Move",
    [
      ["j k", "next / previous (section, sentence or word, by grain)"],
      ["l", "open, or step into the first child"],
      ["h", "close, or step out to the parent"],
      ["i", "narrow the grain: node → sentence → word"],
      ["Esc", "widen the grain; leave a note; close a panel; stop the editor while it works"],
      ["Tab", "jump between spans that carry a note or a link; in an article, between its links and the notes on it"],
      ["/", "jump to a section by name, in any document"],
      ["z", "hoist: make this node the whole page (again, or h or Esc at its top, to step out)"],
      ["v", "view: one column ↔ panes side by side (in panes, j k move among siblings)"],
      ["q", "in panes: close the active pane (the one under the heavy rule, whatever it shows) and every pane opened from it, except pinned ones; the focus goes back to where it was opened from. A pane's x does the same. Moving left never closes anything"],
      ["P", "in panes: pin or unpin the active pane (or its pin, top right). A pinned pane stays where it is when a pane it came from closes, is never replaced by a Shift open, and is never covered, in its column or along the strip"],
      ["Enter l", "in panes: open into the next column, beside what is open there (so does a click, and a Ctrl-, Cmd- or middle click); on something open already, focus it"],
      ["Shift+Enter", "in panes: open in place of the focused branch's pane in the next column (so does a Shift-click)"],
      ["[ ]", "in panes: the pane above / below in the same column (back where you were in it, or at its head); at the top or bottom nothing moves. A crowded column stacks its panes as the strip stacks columns, covered to a tab; resting the mouse on a covered pane peeks it out; its grip or tab drags it up or down. A faint curve runs from where each pane was opened to its title"],    ],
  ],
  [
    "Links",
    [
      ["", "W marks a Wikipedia link, § another note in the library, ↗ a web page; a dotted underline is a note, both together a note that also links"],
      ["Enter", "on a link: open it (panes: the next pane; column: a preview, Enter again opens it). On a note that also links, or a note and a link on the same words: one page, the note's text above the article"],
      ["w", "on a selection: link it (library, Wikipedia or an address); on a link: retarget it; on a node: give the node a target"],
      ["L", "on a node: open its own target"],
      ["W", "open the focused article on wikipedia.org, in a new tab"],
      ["D", "on a link: remove it (u undoes)"],
      ["y n", "on a suggested link (a faint dashed underline; Tab reaches it): link it / decline it (a declined phrase is not suggested again in that node)"],
      ["S", "review the suggested links of this document one by one: y link · n decline · s skip · Y link all the rest · Esc stop"],
      ["1–5", "the node's Related list (sections of other documents close in meaning, numbered under its text): with words selected, link them to that one; on the node, go there"],
      ["l h j k", "in an article: sections are rows, as in a node; l opens one, h goes back"],
      ["i e d y x c :", "in an article: select words of its text as in a node, and write a note on them; the note belongs to the article and shows wherever it is opened (one whose words are gone from a newer revision is listed as detached)"],
    ],
  ],
  [
    "Expand",
    [
      ["e", "go deeper: open → open children → generate"],
      ["Enter", "on a section: toggle (in panes: open its pane, or focus it where it is open). On a selection: open its note, or step into it"],
      ["H L", "shrink / grow the selection by one unit"],
      ["d y x c", "on a selection: define · why · example · challenge"],
      [":", "on a selection: ask your own question about it"],
      ["o O", "open everything below / collapse everything"],
    ],
  ],
  [
    "Edit",
    [
      ["c", "edit the body (Esc saves). In it, [[ links a phrase: library titles first, then Wikipedia; a bare [[term]] left in the text is looked up when saved"],
      ["r", "rename"],
      ["a A", "add a section inside / after (on the library: a document)"],
      ["D", "delete (no confirmation; u undoes)"],
      ["J K", "move down / up among siblings"],
      ["> <", "indent / outdent (a document's sections can be moved into another this way, or over HTTP)"],
      ["p", "pin or unpin: pinned nodes are never rewritten by the model"],
      ["f", "on a note: cycle its form (inline · margin · inset)"],
      [":", "on a node: tell the editor agent what to change"],
      ["u U", "undo / redo: the last edit made in this tab, in whichever document it was"],
    ],
  ],
  [
    "Keep consistent",
    [
      ["R", "reconcile: have the model bring a stale node back in line"],
      ["b", "bless: accept a stale node as it stands"],
      ["g", "history: commits, branches, conflicts"],
      ["?", "this help"],
    ],
  ],
  [
    "Documents (m)",
    [
      ["", "every document is a section of one library: the library is the first page (h or Esc steps out to it), and a document opens in place"],
      ["m", "the documents menu (or click the title in the top bar). Type to filter; ↑ ↓ select; Enter opens"],
      ["Esc", "in the filter: go to the list, where single keys act. In the list: close"],
      ["j k Enter", "in the list: select / open"],
      ["n", "new blank document (asks for a title)"],
      ["r", "rename the selected document"],
      ["s", "duplicate it: save as a copy under a new title, and open the copy"],
      ["D", "delete it (asks first; u brings it back)"],
      ["x", "export it: save to a .md file"],
      ["i", "import a .md file as a new document (or drop the file on the menu)"],
      ["/", "back to the filter"],
    ],
  ],
  [
    "In history (g)",
    [
      ["j k", "select"],
      ["Enter", "commit: view it (read-only). Branch: switch. Open conflict: ask the model"],
      ["r", "revert to the selected commit, as a new commit"],
      ["n", "new branch from the selected commit"],
      ["m", "merge the selected branch into this one"],
      ["1 2 3", "conflict: take side A / side B / the mechanical merge"],
      ["x", "conflict: reopen a resolution"],
      ["f", "show only what touched the current document, or everything"],
      ["v", "verify: check every commit reproduces its recorded hash"],
      ["", "each commit names the documents it touched; r reverts only the current document, the rest of the library stays as it is"],
    ],
  ],
  [
    "Commands (:)",
    [
      ["/branch name", "create and switch to a branch"],
      ["/switch name", "switch branch"],
      ["/merge name", "merge a branch into this one"],
      ["/resolve", "have the model resolve open conflicts"],
      ["/auto on|off", "reconcile automatically after edits"],
      ["/speculate on|off", "start writing the focused sentence's expansion early"],
      ["/view mode", "page layout: auto, column or panes; auto shows panes on windows 1600 px wide or more"],
      ["/curves on|off", "in panes: the faint curves from where each pane was opened to it"],
      ["/user name", "set the name on your commits"],
      ["/new title", "new blank document"],
      ["/open name", "open a document by title or id"],
      ["/rename title", "rename this document"],
      ["/duplicate title", "save this document as a copy, and open the copy"],
      ["/export", "save this document to a .md file"],
      ["/import", "open a .md file as a new document"],
      ["/recover", "save edits this browser made before the library existed, and never sent, as .md files"],
      ["/link target", "link the selection (or the node): w:Title, /document/Section, an address, or a Wikipedia title"],
      ["/unlink", "remove the link on the selection, or the node's own target"],
      ["/autolink suggest|on|off", "after an edit: suggest what was found (suggest, the default), also link the surest at once (on, u undoes), or look for nothing (off)"],
      ["/linkdoc", "look for links in the whole document, in the background; progress in the status line"],
      ["/linkall", "look for links in the whole library, in the background"],
      ["/linkcancel", "stop looking (what was found is kept)"],
      ["/research question", "the editor searches the web, reads a few pages and writes what it finds into the focused node, each claim linked to its page (within the server's limits, by default 5 searches and 5 pages read per request; Esc stops)"],
      ["", "an ordinary request to the editor may use the web too when it says so: \"look up…\", \"find sources for…\", \"search the web…\", \"cite sources\", \"fact-check\""],
    ],
  ],
];

const isTyping = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
};

interface KeyHooks {
  openCommand(prefill?: string): void;
  verify(): void;
}

export function handleKey(e: KeyboardEvent, hooks: KeyHooks) {
  if (!store.ready || isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key;
  const done = () => {
    e.preventDefault();
    store.t0 = { what: k, at: e.timeStamp };
  };

  if (store.mode === "help") {
    if (k === "Escape" || k === "?" || k === "q") {
      store.setMode("normal");
      e.preventDefault();
    }
    return;
  }

  if (store.mode === "history") {
    const items = store.panel();
    const item = items[store.historyIndex];
    const select = (i: number) => {
      store.historyIndex = Math.max(0, Math.min(items.length - 1, i));
      const it = items[store.historyIndex];
      if (store.preview && it?.type === "commit") store.setPreview(it.commit);
      store.emit();
    };
    switch (k) {
      case "Escape":
        if (store.preview) store.setPreview(null);
        else store.closeHistory();
        break;
      case "g":
      case "q":
        store.closeHistory();
        break;
      case "j":
      case "ArrowDown":
        select(store.historyIndex + 1);
        break;
      case "k":
      case "ArrowUp":
        select(store.historyIndex - 1);
        break;
      case "Enter":
        if (item?.type === "commit") store.setPreview(store.preview?.commit.id === item.commit.id ? null : item.commit);
        else if (item?.type === "branch") store.switchBranch(item.branch);
        else if (item?.type === "conflict" && item.conflict.status === "open") store.resolveAll();
        break;
      case "r":
        if (item?.type === "commit") store.revert(item.commit);
        break;
      case "n":
        if (item?.type === "commit") {
          store.branchFrom = item.commit;
          hooks.openCommand("/branch ");
        }
        break;
      case "m":
        if (item?.type === "branch") store.mergeFrom(item.branch);
        break;
      case "1":
      case "2":
      case "3":
        if (item?.type === "conflict") store.settle(item.conflict.id, (["a", "b", "merged"] as const)[+k - 1]);
        break;
      case "x":
        if (item?.type === "conflict") store.reopen(item.conflict.id);
        break;
      case "v":
        hooks.verify();
        break;
      case "f":
        store.toggleHistoryFilter();
        break;
      case ":":
        hooks.openCommand();
        break;
      case "?":
        store.setMode("help");
        break;
      default:
        return;
    }
    return done();
  }

  if (store.mode === "docs") {
    // The filter and title boxes take their own keys (Menu.tsx); these are the list's.
    const m = store.menu;
    const d = store.menuSelected();
    if (m.focus === "filter" && !m.prompt && !m.confirm) {
      // The filter box is not focused (a key typed before it took focus, or after a click
      // elsewhere in the panel): keys still mean what they would there.
      if (k === "Escape" || k === "Tab") m.focus = "list";
      else if (k === "Enter") return d && (e.preventDefault(), store.openDoc(d.node, true));
      else if (k === "ArrowDown" || k === "ArrowUp") return e.preventDefault(), store.menuMove(k === "ArrowDown" ? 1 : -1);
      else if (k.length === 1) return e.preventDefault(), store.menuFilter(m.filter + k);
      else return;
      store.emit();
      return done();
    }
    if (m.confirm) {
      if (k === "y") store.deleteDocument(m.confirm);
      else if (k === "n" || k === "Escape" || k === "q") (m.confirm = null), store.emit();
      else return;
      return done();
    }
    switch (k) {
      case "Escape":
      case "q":
      case "m":
        store.closeMenu();
        break;
      case "j":
      case "ArrowDown":
        store.menuMove(1);
        break;
      case "k":
      case "ArrowUp":
        store.menuMove(-1);
        break;
      case "Enter":
        if (d) store.openDoc(d.node, true);
        break;
      case "/":
        m.focus = "filter";
        store.emit();
        break;
      case "n":
        store.menuPrompt("new");
        break;
      case "r":
        store.menuPrompt("rename");
        break;
      case "s":
        store.menuPrompt("duplicate");
        break;
      case "D":
        if (d) (m.confirm = d.node), store.emit();
        break;
      case "x":
        if (d) store.exportDocument(d.node);
        break;
      case "i":
        store.pickFile();
        break;
      case "?":
        store.setMode("help");
        break;
      default:
        return;
    }
    return done();
  }

  if (store.mode === "review") {
    switch (k) {
      case "y":
        store.acceptSuggestion();
        break;
      case "n":
        store.rejectSuggestion();
        break;
      case "s":
      case "j":
      case "Tab":
      case " ":
        store.reviewStep(e.shiftKey ? -1 : 1);
        break;
      case "k":
        store.reviewStep(-1);
        break;
      case "Y":
        store.reviewAcceptAll();
        break;
      case "Escape":
      case "q":
      case "S":
        store.endReview("Review stopped.");
        break;
      case "u":
        store.undoLast();
        break;
      default:
        return;
    }
    return done();
  }

  if (store.mode !== "normal") return;
  // Esc stops the editor while it works, and puts away the panel of a finished research run.
  if (k === "Escape" && store.agentRun) {
    store.escAgent();
    return done();
  }
  if (store.panes) store.syncTrail();
  // On a Wikipedia view, a target or a "Linked from" row, the keys mean what they would on rows
  // (unless the focus is an annotation shown in it, which is a node like any other).
  const onAnnotation = !!store.snap.nodes[store.focus.node]?.wanchor || inArticles(store.snap, store.focus.node);
  if (!store.aux && !onAnnotation && ((store.panes && store.trail[store.paneAt]?.kind === "wiki") || (!store.panes && store.colWiki))) {
    store.aux = { kind: "wiki", host: store.panes ? `p${store.paneAt}` : "col", row: { t: "head" } };
  }
  // An Enter after a Tab that is waiting for its article to arrive waits with it.
  if (store.aux && store.holdKey(k, e.shiftKey)) return done();
  // Enter opens beside what is in the next column; Shift+Enter in place of the focused branch's pane there.
  const replace = k === "Enter" && e.shiftKey;
  // Words selected in an article's text take the same keys as words of a node.
  if (store.aux && !store.inArticleText) {
    if (store.withReplace(replace, () => auxKey(k, e.shiftKey)) || commonKey(k, hooks)) return done();
    const why = store.aux.kind === "wiki" ? store.articleRefuses(k, false) : null;
    if (why) (store.say(why), done());
    return;
  }
  if (commonKey(k, hooks)) return done();
  const selecting = store.focus.grain !== "node" || store.inArticleText;
  if (store.inArticleText) {
    const why = store.articleRefuses(k, true);
    if (why) return store.say(why), done();
  }

  switch (k) {
    case "j":
    case "ArrowDown":
      store.move(1);
      break;
    case "k":
    case "ArrowUp":
      store.move(-1);
      break;
    case "l":
    case "ArrowRight":
      store.into();
      break;
    case "h":
    case "ArrowLeft":
      store.out();
      break;
    case "i":
      store.descend();
      break;
    case "Escape":
      store.ascend();
      break;
    case "Tab":
      store.nextAnchor(e.shiftKey ? -1 : 1);
      break;
    case "e":
      store.expand();
      break;
    case "Enter":
    case " ":
      store.withReplace(replace, () => {
        if (selecting) store.enterOrExpand();
        else if (store.snap.nodes[store.focus.node]?.kind === "note" && store.targetOf(store.focus.node)) store.followOwn();
        else store.toggle();
      });
      break;
    case "w":
      store.openPicker();
      break;
    case "L":
      if (selecting) store.extend(1);
      else store.followOwn();
      break;
    case "H":
      store.extend(-1);
      break;
    case "J":
      if (selecting) store.extend(1);
      else store.shift(1);
      break;
    case "K":
      if (selecting) store.extend(-1);
      else store.shift(-1);
      break;
    case "d":
      if (selecting) store.expand("define");
      break;
    case "y":
      if (store.focusedSuggestion()) store.acceptSuggestion();
      else if (selecting) store.expand("why");
      break;
    case "n":
      if (store.focusedSuggestion()) store.rejectSuggestion();
      else return;
      break;
    case "S":
      store.startReview();
      break;
    case "1":
    case "2":
    case "3":
    case "4":
    case "5":
      store.relatedKey(+k);
      break;
    case "x":
      if (selecting) store.expand("example");
      break;
    case "c":
      if (selecting) store.expand("challenge");
      else store.startEdit("body");
      break;
    case "r":
      if (!selecting) store.startEdit("title");
      break;
    case "a":
      if (!selecting) store.add("child");
      break;
    case "A":
      if (!selecting) store.add("after");
      break;
    case "D":
      store.remove();
      break;
    case ">":
      store.indent(1);
      break;
    case "<":
      store.indent(-1);
      break;
    case "p":
      store.togglePin();
      break;
    case "f":
      store.cycleForm();
      break;
    case "R":
      store.reconcileFocus();
      break;
    case "b":
      store.bless();
      break;
    case "o":
      store.expandAll();
      break;
    case "O":
      store.collapseAll();
      break;
    case "z":
      store.setHoist(store.focus.node);
      break;
    default:
      return;
  }
  done();
}

/** Keys that mean the same on a node and on an aux row. Returns whether the key was taken. */
function commonKey(k: string, hooks: KeyHooks): boolean {
  switch (k) {
    case "W":
      store.openOnWikipedia();
      return true;
    case "q":
      if (store.panes) store.closePane();
      return true;
    case "P":
      store.togglePanePin();
      return true;
    case "[":
    case "]":
      store.focusFork(k === "[" ? -1 : 1);
      return true;
    case "v":
      store.cycleView();
      return true;
    case "u":
      store.undoLast();
      return true;
    case "U":
      store.undoLast(true);
      return true;
    case "g":
      store.openHistory();
      return true;
    case "m":
      store.openMenu();
      return true;
    case "/":
      store.setMode("jump");
      return true;
    case "?":
      store.setMode("help");
      return true;
    case ":":
      hooks.openCommand();
      return true;
    default:
      return false;
  }
}

/** Keys on an aux row. Returns whether the key was taken; keys that only make sense on a node are ignored there. */
function auxKey(k: string, shift: boolean): boolean {
  switch (k) {
    case "j":
    case "ArrowDown":
      store.move(1);
      return true;
    case "k":
    case "ArrowUp":
      store.move(-1);
      return true;
    case "l":
    case "ArrowRight":
    case "Enter":
    case " ":
      store.auxActivate();
      return true;
    case "h":
    case "ArrowLeft":
    case "Escape":
      store.auxLeave();
      return true;
    case "Tab":
      store.auxTab(shift ? -1 : 1);
      return true;
    case "i":
      store.descend();
      return true;
    case "L": {
      // Under a node, its article opens in a pane of its own.
      const a = store.aux;
      const id = a?.kind === "wiki" && a.host.startsWith("n") ? a.host.slice(1) : a?.kind === "target" ? a.of : null;
      const r = id ? store.targetOf(id as keyof typeof store.snap.nodes) : undefined;
      if (r) store.follow(r);
      return true;
    }
    default:
      return false;
  }
}
