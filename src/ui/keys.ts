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
      ["/", "jump to a section by name, anywhere in the library"],
      ["z", "hoist: make this node the whole page (again, or h or Esc at its top, to step out to its parent's page)"],
      ["v", "view: one column ↔ panes (side by side, or as pages on a narrow screen; in panes, j k move among siblings)"],
      ["q", "in panes: close the active pane (the one under the heavy rule, whatever it shows) and every pane opened from it, except pinned ones; the focus goes back to where it was opened from. A pane's x does the same. Moving left never closes anything"],
      ["P", "in panes: pin or unpin the active pane (or its pin, top right). A pinned pane stays where it is when a pane it came from closes, is never replaced by a Shift open, and is never covered, in its column or along the strip"],
      ["Enter l", "in panes: open into the next column, beside what is open there (so does a click, and a Ctrl-, Cmd- or middle click); on something open already, focus it"],
      ["Shift+Enter", "in panes: open in place of the focused branch's pane in the next column (so does a Shift-click)"],
      ["Alt+h Alt+l", "in panes: the pane this one was opened from (left) / one opened from it (right): the one opened from the focused row or link if it is open, else the one last visited; from a node, a selection or an article alike. Left then right comes back"],
      ["Alt+k Alt+j", "in panes: the pane above / below in the same column, across forks (Alt+↑ ↓ and [ ] too)"],
      ["Alt+Shift+k j", "in panes: move the active pane up / down its column, as dragging it by its grip or tab does (Alt+Shift+↑ ↓ too; the pane's ⋯ menu offers the same)"],
      ["[ ]", "in panes: the pane above / below in the same column (back where you were in it, or at its head); at the top or bottom nothing moves. A crowded column stacks its panes as the strip stacks columns, covered to a tab; resting the mouse on a covered pane peeks it out; its grip or tab drags it up or down. A faint curve runs from where each pane was opened to its title"],    ],
  ],
  [
    "Mouse and touch",
    [
      ["", "a click on a sentence selects it, and a bar over it offers expand · define · why · example · challenge · ask · link, each with its key (on a phone, at the foot of the screen, × puts it away); a drag selects words, a double click a word"],
      ["", "right-click (a long press on a phone) on words, a row, a link, a note or a pane: what can be done with it, Copy first. Shift+right-click is the browser's own menu"],
      ["", "⋯ by a row, a pane's pin, a page's byline or a note (shown when pointed at): the same menu. A stale flag, clicked, offers what to do about it"],
      ["", "the top bar: the library's name (it opens the libraries panel), undo, redo, and menu: libraries, jump, history, links, layout and settings. A key named in the status line or a panel's head is a button that presses it"],
      ["", "on a phone the panes are pages, a column each: a tap on a row or a link goes to its pane, a swipe sideways goes from page to page, Back goes back a pane. The pane gone to has the page's height; the others in its column fold to their tabs. The trail at the foot names the panes on the way, each in its colour (a tap goes there), with a dot for each pane in that page's column, the one on the way filled; its map draws every open pane as a tree, each branch in its colour, to go to, pin or close. What a pane was opened from takes its colour. A long press on a link shows what it opens; a tap on one only opens it. A press held on a pane's tab, or on the band above its title, picks the pane up to move it up or down its page (the pane's ⋯ has Move up and Move down too)"],
      ["", "in the libraries panel a click on a row opens that library; its ⋯ (or a right-click) offers open, rename, delete and a new library; a press outside the panel closes it"],
    ],
  ],
  [
    "Links",
    [
      ["", "W marks a Wikipedia link, § another note in the library, ↗ a web page; a dotted underline is a note, both together a note that also links"],
      ["Enter", "on a link: open it (panes: the next pane; column: a preview, Enter again opens it). On a note that also links, or a note and a link on the same words: one page, the note's text above the article"],
      ["w", "on a selection: link it (library, Wikipedia or an address); on a link: retarget it; on a node: give the node a target"],
      ["L", "on a node: open its own target"],
      ["W", "open the focused article on wikipedia.org, in a new tab"],
      ["D", "on a link: remove it, and decline its words in that node so it is not made again (u undoes). Also in the right-click menu: Remove the link"],
      ["y n", "on a suggested link (a faint dashed underline; Tab reaches it): link it / decline it (a declined phrase is not suggested again in that node)"],
      ["S", "the links list of the node you are on and everything under it (on the library root, the whole library): every link found or made, with who decided and the reviewer's reason. 1 2 3 show or hide linked · rejected · pending (rejected is hidden at first); j k move (the words are selected in the text); y links (also a rejected one: you overrule); n declines, or on a link removes it for good; Y links all the pending shown; Enter goes to the words; Esc closes"],
      ["1–5", "the node's Related list (sections elsewhere in the library close in meaning, numbered under its text): with words selected, link them to that one; on the node, go there"],
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
      ["a A", "add a section inside / after (on the library root: a new top-level node)"],
      ["D", "delete (no confirmation; u undoes)"],
      ["J K", "move down / up among siblings"],
      ["> <", "indent / outdent"],
      ["M", "move under…: pick any node in the library (or the library root) and this node, with everything under it, becomes its last child (u undoes)"],
      ["p", "lock or unlock: a locked node is never rewritten by the model (your own edits lock it). Not the same as P, which pins a pane"],
      ["f", "on a note: cycle its form (inline · margin · inset)"],
      [":", "on a node: tell the editor agent what to change"],
      ["u U", "undo / redo: the last edit made in this tab, wherever in the library it was"],
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
    "Libraries",
    [
      ["", "everything is a node of one tree, whose root is the library: the first page. Any node can be moved under any other (M, > <), copied (/duplicate), saved to a file (/export) or given a file's tree under it (/import); each acts on the node you are on, with everything under it. The ⋯ menu of any node offers the same"],
      ["", "there can be several libraries, each a tree of its own with its own address (/l/…): nothing links, moves or is found from one to another (export, then import, carries a tree across)"],
      ["m", "the libraries panel, on the left (so does a click on the library's name in the top bar; m, Esc or a press outside closes it): every library with its size, ● the one open here"],
      ["j k", "in the panel: move"],
      ["Enter", "in the panel: open the library (a page load; each library opens where it was left)"],
      ["n", "in the panel: a new library: type its name, Enter makes it (its root alone) and opens it"],
      ["r", "in the panel: rename the library (Enter keeps the name, Esc leaves it)"],
      ["D", "in the panel: delete the library, after y (n keeps it). Its files are moved, unchanged, to libraries/.deleted/ in the server's data folder, from where it can be restored by hand; u cannot. The last library cannot be deleted"],
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
      ["f", "show only what touched the node you are on and what is under it, or everything"],
      ["v", "verify: check every commit reproduces its recorded hash"],
      ["", "each commit names the top-level nodes it touched. r reverts only the node you are on and what is under it, the rest of the library stays as it is; on the library root, the whole library"],
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
      ["/view mode", "page layout: auto, column or panes; auto shows panes on windows 900 px wide or more"],
      ["/curves on|off", "in panes: the faint curves from where each pane was opened to it"],
      ["/colors line|top|edge|off", "in panes: each fork's own colour, on its curves and the rule under its panes' titles (line, the default), across their tops, down their left edges, or none"],
      ["/user name", "set the name on your commits"],
      ["/duplicate title", "save the node you are on, with everything under it, as a copy just after it (titled \"… (copy)\" unless given one); the copy has the focus"],
      ["/export", "save the node you are on, with everything under it, to a .md file (on the library root, the whole library)"],
      ["/import", "read a .md file into the node you are on, as its last child (on the library root, a new top-level node)"],
      ["/library [name]", "the libraries panel (m); with a name, open that library (a page load); /library new name makes one and opens it"],
      ["/link target", "link the selection (or the node): w:Title, /Top title/Section (titles from the library root), an address, or a Wikipedia title"],
      ["/unlink", "remove the link on the selection (for good: its words are declined; a note that also links keeps its text), or the node's own target"],
      ["/autolink review|suggest|on|off", "after an edit: the model reviews what was found and links what it approves (review, the default with a model; u undoes, S lists every decision), suggest everything for you to decide (suggest; what review does without a model, or when the model fails or its limit is reached), link the scanner's sure ones unreviewed (on), or look for nothing (off)"],
      ["/linkhere", "look for links in the node you are on and everything under it, in the background (reviewed, in review mode); progress and the reviewer's model calls in the status line"],
      ["/linkall", "look for links in the whole library, in the background (so does /linkhere on the library root)"],
      ["/linkcancel", "stop looking (what was found and reviewed is kept, and what was approved is linked)"],
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

/**
 * Between panes, whatever the focus (a node, a sentence, an article): Alt with h j k l, or with ↑ ↓.
 * By the key's place on the keyboard (e.code), so a layout or Option producing another letter still works.
 */
const PANE_KEYS: Record<string, () => void> = {
  KeyH: () => store.paneSide(-1),
  KeyL: () => store.paneSide(1),
  KeyK: () => store.focusFork(-1),
  KeyJ: () => store.focusFork(1),
  ArrowUp: () => store.focusFork(-1),
  ArrowDown: () => store.focusFork(1),
};

/** Alt+Shift with k j (or ↑ ↓): move the active pane up or down its column. */
const PANE_MOVE_KEYS: Record<string, () => void> = {
  KeyK: () => store.movePane(-1),
  KeyJ: () => store.movePane(1),
  ArrowUp: () => store.movePane(-1),
  ArrowDown: () => store.movePane(1),
};

export function handleKey(e: KeyboardEvent, hooks: KeyHooks) {
  if (!store.ready || isTyping(e) || e.metaKey || e.ctrlKey) return;
  if (e.altKey) {
    const go = store.mode === "normal" ? (e.shiftKey ? PANE_MOVE_KEYS : PANE_KEYS)[e.code] : undefined;
    if (!go) return;
    e.preventDefault();
    store.t0 = { what: `A-${e.code}`, at: e.timeStamp };
    return go();
  }
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

  // The libraries panel has the keys while it is open, over any other panel.
  if (store.libs) {
    if (libsKey(k)) done();
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

  if (store.mode === "review") {
    switch (k) {
      case "y":
        store.reviewAccept();
        break;
      case "n":
      case "D":
        store.reviewReject();
        break;
      case "s":
      case "j":
      case "ArrowDown":
      case "Tab":
      case " ":
        store.reviewStep(e.shiftKey ? -1 : 1);
        break;
      case "k":
      case "ArrowUp":
        store.reviewStep(-1);
        break;
      case "1":
      case "2":
      case "3":
        store.reviewFilter((["linked", "rejected", "pending"] as const)[+k - 1]);
        break;
      case "Y":
        store.reviewAcceptAll();
        break;
      case "Enter":
        store.reviewGo();
        break;
      case "Escape":
      case "q":
      case "S":
        store.endReview();
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
      store.toggleLock();
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
    case "M":
      if (!selecting) store.startMove();
      break;
    default:
      return;
  }
  done();
}

/**
 * Keys in the libraries panel. A deletion waiting for its answer takes only y and n (or Esc); a
 * name being typed has its own box, which keeps its keys. Returns whether the key was taken.
 */
function libsKey(k: string): boolean {
  const p = store.libs!;
  if (p.confirm) {
    switch (k) {
      case "y":
        void store.libConfirm();
        return true;
      case "n":
      case "Escape":
        store.libCancel();
        return true;
      default:
        return false;
    }
  }
  switch (k) {
    case "j":
    case "ArrowDown":
      store.libStep(1);
      return true;
    case "k":
    case "ArrowUp":
      store.libStep(-1);
      return true;
    case "Enter":
    case "l":
      store.libOpen();
      return true;
    case "n":
    case "a":
      store.libEdit("new");
      return true;
    case "r":
      store.libEdit("rename");
      return true;
    case "D":
      store.libDelete();
      return true;
    case "Escape":
    case "m":
    case "q":
    case "h":
      store.closeLibraries();
      return true;
    case "?":
      store.setMode("help");
      return true;
    default:
      return false;
  }
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
      store.openLibraries();
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
