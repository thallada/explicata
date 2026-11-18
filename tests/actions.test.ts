/** What the mouse offers (src/ui/actions.ts): every item does what its key does, and the bar, the ⋯ menus and the right-click menu are built from one place. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { articleRowEntries, barItems, libraryEntries, nodeEntries, paneEntries, selectionEntries, tidy, topEntries, webPageEntries, type Act, type Entry, type Item, type NodeCtx, type SelCtx, type TopCtx } from "../src/ui/actions";
import { deletedPlace, keep, nodeCount, openPanel, step } from "../src/ui/libraries";
import type { LibraryInfo } from "../src/ui/api";

/** An Act that records what was asked of it. */
function recorder() {
  const calls: string[] = [];
  const act: Act = {
    press: (k, shift) => void calls.push(`press ${shift ? "S-" : ""}${k}`),
    command: (t) => void calls.push(`command ${t}`),
    prompt: (p) => void calls.push(`prompt ${p}`),
    copy: (t) => void calls.push(`copy ${t}`),
  };
  return { act, calls };
}

const items = (es: Entry[]): Item[] => es.filter((e): e is Item => e.t === "item");
const labels = (es: Entry[]) => es.map((e) => (e.t === "item" ? e.label : e.t === "head" ? `# ${e.text}` : e.t === "choices" ? `[${e.label}: ${e.options.map((o) => o.label).join(" ")}]` : "--"));
const find = (es: Entry[], label: string) => items(es).find((i) => i.label === label)!;

const node = (more: Partial<NodeCtx> = {}): NodeCtx => ({ title: "Training", text: "Training\n\nIt is trained.", note: false, locked: false, target: false, library: false, generating: true, ...more });
const sel = (more: Partial<SelCtx> = {}): SelCtx => ({ text: "a probability for each possible next piece", article: false, panes: false, ...more });
const top = (more: Partial<TopCtx> = {}): TopCtx => ({ view: "auto", autolink: "suggest", auto: true, speculate: false, curves: true, colors: "line", panes: false, canRedo: false, ...more });

/** Every key the page's handler takes, read from keys.ts: an item's key must be one of them. */
const handled = new Set([...readFileSync(new URL("../src/ui/keys.ts", import.meta.url), "utf8").matchAll(/case "([^"]+)":/g)].map((m) => m[1]));

/** The Alt keys the page's handler takes (by the key's place: KeyH, ArrowUp…), written as the menus press them ("A-h"). */
const altKeys = new Set([...readFileSync(new URL("../src/ui/keys.ts", import.meta.url), "utf8").matchAll(/^\s+(Key[A-Z]|Arrow\w+): \(\) =>/gm)].map((m) => `A-${m[1].startsWith("Key") ? m[1].slice(3).toLowerCase() : m[1]}`));

describe("actions", () => {
  it("every item with a key runs by pressing exactly that key, which the key handler takes", () => {
    const { act, calls } = recorder();
    const all = [
      ...barItems(sel(), act).flat(),
      ...items(selectionEntries(sel({ link: "wiki", note: true, suggestion: "Hoyle state", related: [{ title: "Nodes" }], panes: true }), act)),
      ...items(nodeEntries(node({ stale: "parent", target: true, note: true }), act)),
      ...items(nodeEntries(node({ library: true }), act)),
      ...items(paneEntries({ node: node(), pinned: false }, act)),
      ...items(paneEntries({ article: "Octopus", pinned: true }, act)),
      ...items(paneEntries({ node: node(), pinned: false, above: true, below: true }, act)),
      ...items(articleRowEntries("Octopus", true, act)),
      ...items(topEntries(top({ canRedo: true }), act)),
      ...items(libraryEntries({ title: "Work", current: false, last: false }, act)),
    ];
    const keyed = all.filter((i) => i.key);
    expect(keyed.length).toBeGreaterThan(50);
    for (const it of keyed) {
      calls.length = 0;
      it.run();
      expect(calls).toEqual([`press ${it.shift ? "S-" : ""}${it.key}`]);
      expect(handled.has(it.key!) || it.key === "Escape" || altKeys.has(it.key!), `${it.label}: ${it.key}`).toBe(true);
    }
  });

  it("the bar offers the lenses and linking, each with its key; in an article, no linking", () => {
    const { act } = recorder();
    expect(barItems(sel(), act).map((g) => g.map((i) => `${i.short} ${i.key}`))).toEqual([["expand e", "define d", "why y", "example x", "challenge c", "ask… :"], ["link… w"]]);
    expect(barItems(sel({ article: true }), act).flat().map((i) => i.key)).toEqual(["e", "d", "y", "x", "c", ":"]);
  });

  it("the selection menu puts Copy first, then what the words carry, then the lenses, linking and Related", () => {
    const { act, calls } = recorder();
    const plain = selectionEntries(sel({ related: [{ title: "Expansion by depth", where: "Explicata" }, { title: "Nodes" }] }), act);
    expect(labels(plain)).toEqual([
      "# “a probability for each possible next piece”",
      "Copy",
      "--",
      "Expand",
      "Define",
      "Why?",
      "An example",
      "An objection",
      "Ask your own question…",
      "--",
      "Link to…",
      "# Link to a related section",
      "Expansion by depth",
      "Nodes",
      "--",
      "[Select: less more]",
    ]);
    find(plain, "Copy").run();
    expect(calls).toEqual(["copy a probability for each possible next piece"]);
    // A Wikipedia link on the words, in panes: open beside or in place, on wikipedia.org, retarget, remove.
    const link = selectionEntries(sel({ link: "wiki", panes: true }), act);
    expect(labels(link).slice(1, 8)).toEqual(["Copy", "--", "Open the link beside", "Open it in place", "Open on wikipedia.org", "Retarget…", "Remove the link"]);
    expect(find(link, "Open it in place")).toMatchObject({ key: "Enter", shift: true, keyText: "⇧⏎" });
    expect(labels(link)).not.toContain("Link to…");
    // As pages (a phone) an open goes to the next page, not beside; in place is still there.
    expect(labels(selectionEntries(sel({ link: "wiki", panes: true, pages: true }), act)).slice(3, 5)).toEqual(["Open the link", "Open it in place"]);
    expect(labels(articleRowEntries("Octopus", true, act, true)).slice(1, 3)).toEqual(["Open", "Open in place"]);
    // Removing a link is D, and says it is for good; a library link the same; a note that also links can lose only its target.
    expect(find(link, "Remove the link")).toMatchObject({ key: "D", sub: "and do not link these words again here" });
    expect(find(selectionEntries(sel({ link: "node" }), act), "Remove the link")).toMatchObject({ key: "D" });
    const both = selectionEntries(sel({ link: "wiki", note: true }), act);
    expect(find(both, "Delete the note")).toMatchObject({ key: "D" });
    find(both, "Remove the link, keep the note").run();
    expect(calls).toContain("command /unlink");
    // In an article: no linking by hand, no Related.
    const art = selectionEntries(sel({ article: true, related: [{ title: "Nodes" }] }), act);
    expect(labels(art)).not.toContain("Link to…");
    expect(labels(art)).not.toContain("# Link to a related section");
    // A suggestion on the words: link it or decline it.
    expect(items(selectionEntries(sel({ suggestion: "Hoyle state" }), act)).map((i) => i.key)).toEqual(expect.arrayContaining(["y", "n"]));
  });

  it("a node's menu: its remedies first when stale, Lock checked when locked, and nothing a library cannot do", () => {
    const { act, calls } = recorder();
    const stale = nodeEntries(node({ stale: "parent" }), act);
    expect(labels(stale).slice(0, 3)).toEqual(["# Training · its parent changed", "Bring it in line", "Accept as it stands"]);
    const locked = nodeEntries(node({ stale: "parent", locked: true }), act);
    expect(find(locked, "Bring it in line").disabled).toBe(true);
    expect(find(locked, "Lock")).toMatchObject({ key: "p", checked: true });
    expect(find(nodeEntries(node(), act), "Lock").checked).toBe(false);
    expect(labels(nodeEntries(node(), act)).join("|")).not.toMatch(/pin/i);
    const lib = labels(nodeEntries(node({ library: true }), act));
    for (const l of ["Delete", "Lock", "Add a section after", "[Move: up down in out]", "Move under…", "Show only this", "Save a copy"]) expect(lib).not.toContain(l);
    // The library root is a node like any other: it takes a section, and is exported, imported into and scanned like one.
    for (const l of ["Add a section inside", "Export as .md", "Import a .md file into it…", "Find links here"]) expect(lib).toContain(l);
    expect(labels(nodeEntries(node({ note: true }), act))).toContain("Change its form");
    find(nodeEntries(node(), act), "Research on the web…").run();
    expect(calls).toEqual(["prompt /research "]);
    expect(labels(nodeEntries(node({ generating: false }), act))).not.toContain("Research on the web…");
  });

  it("every node offers what acts on it and everything under it, a note none of it; a pane adds pin, close and the column", () => {
    const { act, calls } = recorder();
    const any = nodeEntries(node(), act);
    expect(labels(any).slice(-7)).toEqual(["--", "Find links here", "Save a copy", "Export as .md", "Import a .md file into it…", "--", "Delete"]);
    expect(find(any, "Move under…")).toMatchObject({ key: "M" });
    for (const [label, cmd] of [["Find links here", "/linkhere"], ["Save a copy", "/duplicate"], ["Export as .md", "/export"], ["Import a .md file into it…", "/import"]]) {
      calls.length = 0;
      find(any, label).run();
      expect(calls).toEqual([`command ${cmd}`]);
    }
    const note = labels(nodeEntries(node({ note: true }), act));
    for (const l of ["Move under…", "Save a copy", "Export as .md", "Import a .md file into it…", "Find links here"]) expect(note).not.toContain(l);
    calls.length = 0;
    const pane = paneEntries({ node: node(), pinned: true }, act);
    expect(labels(pane).slice(-3)).toEqual(["Pin this pane", "Close this pane", "Show as one column"]);
    expect(find(pane, "Pin this pane").checked).toBe(true);
    expect(labels(paneEntries({ article: "Octopus", pinned: false }, act)).slice(0, 2)).toEqual(["# Octopus", "Open on wikipedia.org"]);
    // The pane of a section shown as its article: the section's own items (rename, retarget, delete…), then the page's.
    const link = labels(paneEntries({ node: node({ title: "How a request travels", target: true }), article: "Following one request", web: true, pinned: false }, act));
    expect(link[0]).toBe("# How a request travels");
    for (const l of ["Rename", "Link this section to…", "Open its target", "Delete", "Open the original", "Arrange with a model", "Read it again"]) expect(link).toContain(l);
    expect(link.indexOf("# Following one request")).toBeGreaterThan(link.indexOf("Delete"));
    expect(labels(paneEntries({ node: node({ target: true }), article: "Octopus", pinned: false }, act))).toContain("Open on wikipedia.org");
    // Its menu goes to the panes around it, by the keys that do.
    const go = paneEntries({ article: "Octopus", pinned: false }, act).find((e) => e.t === "choices" && e.label === "Go to the pane") as Extract<Entry, { t: "choices" }>;
    expect(go.options.map((o) => `${o.label} ${o.key}`)).toEqual(["left A-h", "right A-l", "above A-k", "below A-j"]);
  });

  it("the top menu: jump, history, undo and redo, links, the layout and settings as commands", () => {
    const { act, calls } = recorder();
    const es = topEntries(top(), act);
    expect(find(es, "Redo").disabled).toBe(true);
    expect(find(topEntries(top({ canRedo: true }), act), "Redo").disabled).toBeFalsy();
    const layout = es.find((e) => e.t === "choices" && e.label === "Layout") as Extract<Entry, { t: "choices" }>;
    expect(layout.options.map((o) => `${o.label}${o.on ? "*" : ""}`)).toEqual(["auto*", "column", "panes"]);
    layout.options[2].run();
    find(es, "Reconcile after edits").run();
    find(es, "Write ahead while reading").run();
    expect(calls).toEqual(["command /view panes", "command /auto off", "command /speculate on"]);
    expect(labels(es)).not.toContain("Curves between panes");
    expect(labels(topEntries(top({ panes: true }), act))).toContain("Curves between panes");
    const colors = topEntries(top({ panes: true }), act).find((e) => e.t === "choices" && e.label === "Fork colours") as Extract<Entry, { t: "choices" }>;
    expect(colors.options.map((o) => `${o.label}${o.on ? "*" : ""}`)).toEqual(["line*", "top", "edge", "off"]);
    colors.options[3].run();
    expect(calls.at(-1)).toBe("command /colors off");
    expect(labels(es)).not.toContain("Documents…");
    expect(find(es, "Links found: review and reverse")).toMatchObject({ key: "S" });
    calls.length = 0;
    find(es, "Find links in the whole library").run();
    find(es, "Find links here").run();
    expect(calls).toEqual(["command /linkall", "command /linkhere"]);
  });

  it("tidy leaves no separator at an end or next to another", () => {
    const s = { t: "sep" } as const;
    const h = { t: "head", text: "x" } as const;
    expect(tidy([s, h, s, false, s, null, h, s, ""]).map((e) => e.t)).toEqual(["head", "sep", "head"]);
  });

  it("a library's row offers open, rename and delete, with new; this page's own cannot be opened again, and the last cannot be deleted", () => {
    const { act, calls } = recorder();
    const other = libraryEntries({ title: "Work", current: false, last: false }, act);
    expect(labels(other)).toEqual(["# Work", "Open", "Rename…", "Delete…", "--", "New library…"]);
    expect(items(other).map((i) => i.key)).toEqual(["Enter", "r", "D", "n"]);
    find(other, "Delete…").run();
    expect(calls).toEqual(["press D"]);
    const mine = libraryEntries({ title: "Library", current: true, last: true }, act);
    expect(find(mine, "Open here already").disabled).toBe(true);
    expect(find(mine, "Delete…").disabled).toBe(true);
    expect(find(mine, "Delete…").sub).toContain("last library");
    expect(find(topEntries(top(), act), "Libraries…").key).toBe("m");
  });
});

describe("moving a pane in its column", () => {
  it("the pane menu offers Move this pane up and down (Alt+Shift+k j) only where its column has another pane, greyed where it cannot go", () => {
    const { act, calls } = recorder();
    expect(labels(paneEntries({ node: node(), pinned: false }, act))).not.toContain("Move this pane up");
    const es = paneEntries({ node: node(), pinned: false, above: false, below: true }, act);
    const up = find(es, "Move this pane up");
    const down = find(es, "Move this pane down");
    expect(up.disabled).toBe(true);
    expect(down.disabled).toBe(false);
    expect([up.keyText, down.keyText]).toEqual(["Alt+⇧k", "Alt+⇧j"]);
    down.run();
    expect(calls).toEqual(["press S-A-j"]);
    expect(labels(paneEntries({ article: "Octopus", pinned: false, above: true, below: false }, act))).toContain("Move this pane up");
  });
});

describe("the libraries panel's state", () => {
  const lib = (id: string, title = id): LibraryInfo => ({ id, title, created: "", nodes: 0, branches: ["main"] });
  const list = [lib("a"), lib("b"), lib("c")];

  it("opens on this page's library, else the first", () => {
    expect(openPanel(list, "b")).toMatchObject({ sel: "b", edit: null, confirm: null, loading: true });
    expect(openPanel(list, "gone").sel).toBe("a");
    expect(openPanel([], "x").sel).toBe("x");
  });

  it("steps by rows, held at the ends", () => {
    expect(step(list, "a", 1)).toBe("b");
    expect(step(list, "c", 1)).toBe("c");
    expect(step(list, "a", -1)).toBe("a");
    expect(step(list, "missing", 1)).toBe("a");
    expect(step([], "a", 1)).toBe("a");
  });

  it("keeps the row a fetch still lists, else takes the one that stood where it was", () => {
    expect(keep(list, [lib("c"), lib("b")], "b")).toBe("b");
    expect(keep(list, [lib("a"), lib("c")], "b")).toBe("c");
    expect(keep(list, [lib("a"), lib("b")], "c")).toBe("b");
    expect(keep(list, [], "b")).toBe("b");
  });

  it("says where a deleted library went as the data folder names it, and counts nodes", () => {
    expect(deletedPlace("/home/x/.data/libraries/.deleted/k06dp45g64-20261117-074500")).toBe("libraries/.deleted/k06dp45g64-20261117-074500");
    expect(deletedPlace("C:\\data\\libraries\\.deleted\\abc-1")).toBe("libraries/.deleted/abc-1");
    expect(deletedPlace("elsewhere")).toBe("elsewhere");
    expect([nodeCount(0), nodeCount(1), nodeCount(2)]).toEqual(["0 nodes", "1 node", "2 nodes"]);
  });
});

describe("a web page's menus", () => {
  it("offer the original (W), arranging with a model (s) and reading it again (R), keys the handler takes; arranging is disabled where no model may", () => {
    const { act, calls } = recorder();
    const pane = paneEntries({ article: "Following one request", web: true, pinned: false }, act);
    expect(labels(pane).slice(0, 4)).toEqual(["# Following one request", "Open the original", "Arrange with a model", "Read it again"]);
    const row = articleRowEntries("The proxies", true, act, false, true);
    expect(labels(row)).toEqual(["# The proxies", "Open beside", "Open in place", "--", "Open the original", "Arrange with a model", "Read it again"]);
    expect(labels(articleRowEntries("Octopus", true, act))).not.toContain("Arrange with a model");
    for (const it of items([...pane, ...row, ...webPageEntries(act)])) {
      calls.length = 0;
      it.run();
      expect(calls).toEqual([`press ${it.shift ? "S-" : ""}${it.key}`]);
    }
    const keys = readFileSync(new URL("../src/ui/keys.ts", import.meta.url), "utf8");
    expect(keys).toContain(`store.onWeb && (k === "R" || k === "s")`);
    expect(find(paneEntries({ article: "A page", web: true, arrange: false, pinned: false }, act), "Arrange with a model").disabled).toBe(true);
  });

  it("words of a page's text take what words of an article take: the lenses on the bar and in the menu, Delete on a note; no linking by hand", () => {
    const { act } = recorder();
    const web = sel({ article: true, web: true });
    const bar = (c: SelCtx) => barItems(c, act).map((g) => g.map((i) => `${i.label} ${i.key}`));
    expect(bar(web)).toEqual(bar(sel({ article: true })));
    expect(barItems(web, act).flat().map((i) => i.key)).toEqual(["e", "d", "y", "x", "c", ":"]);
    const menu = labels(selectionEntries(web, act));
    for (const l of ["Copy", "Open the original", "Expand", "Define", "Why?", "An example", "An objection", "Ask your own question…"]) expect(menu).toContain(l);
    expect(menu).not.toContain("Link to…");
    const onNote = labels(selectionEntries(sel({ article: true, web: true, note: true }), act));
    expect(onNote).toContain("Open the note");
    expect(onNote).toContain("Delete the note");
    expect(onNote).not.toContain("Link it…");
  });
});

