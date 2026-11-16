/** What the mouse offers (src/ui/actions.ts): every item does what its key does, and the bar, the ⋯ menus and the right-click menu are built from one place. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { articleRowEntries, barItems, nodeEntries, pageEntries, paneEntries, selectionEntries, tidy, topEntries, type Act, type Entry, type Item, type NodeCtx, type SelCtx, type TopCtx } from "../src/ui/actions";

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

const node = (more: Partial<NodeCtx> = {}): NodeCtx => ({ title: "Training", text: "Training\n\nIt is trained.", note: false, locked: false, target: false, library: false, doc: false, generating: true, ...more });
const sel = (more: Partial<SelCtx> = {}): SelCtx => ({ text: "a probability for each possible next piece", article: false, panes: false, ...more });
const top = (more: Partial<TopCtx> = {}): TopCtx => ({ view: "auto", autolink: "suggest", auto: true, speculate: false, curves: true, colors: "line", panes: false, doc: true, canRedo: false, ...more });

/** Every key the page's handler takes, read from keys.ts: an item's key must be one of them. */
const handled = new Set([...readFileSync(new URL("../src/ui/keys.ts", import.meta.url), "utf8").matchAll(/case "([^"]+)":/g)].map((m) => m[1]));

describe("actions", () => {
  it("every item with a key runs by pressing exactly that key, which the key handler takes", () => {
    const { act, calls } = recorder();
    const all = [
      ...barItems(sel(), act).flat(),
      ...items(selectionEntries(sel({ link: "wiki", note: true, suggestion: "Hoyle state", related: [{ title: "Nodes" }], panes: true }), act)),
      ...items(nodeEntries(node({ stale: "parent", target: true, note: true }), act)),
      ...items(pageEntries(node({ doc: true }), act)),
      ...items(paneEntries({ node: node(), pinned: false }, act)),
      ...items(paneEntries({ article: "Octopus", pinned: true }, act)),
      ...items(articleRowEntries("Octopus", true, act)),
      ...items(topEntries(top({ canRedo: true }), act)),
    ];
    const keyed = all.filter((i) => i.key);
    expect(keyed.length).toBeGreaterThan(50);
    for (const it of keyed) {
      calls.length = 0;
      it.run();
      expect(calls).toEqual([`press ${it.shift ? "S-" : ""}${it.key}`]);
      expect(handled.has(it.key!) || it.key === "Escape", `${it.label}: ${it.key}`).toBe(true);
    }
  });

  it("the bar offers the lenses and linking, each with its key; in an article, no linking", () => {
    const { act } = recorder();
    expect(barItems(sel(), act).map((g) => g.map((i) => `${i.short} ${i.key}`))).toEqual([["expand e", "define d", "why y", "example x", "challenge c", "ask… :"], ["link… w"]]);
    expect(barItems(sel({ article: true }), act).flat().map((i) => i.key)).toEqual(["e", "d", "y", "x", "c", ":"]);
  });

  it("the selection menu puts Copy first, then what the words carry, then the lenses, linking and Related", () => {
    const { act, calls } = recorder();
    const plain = selectionEntries(sel({ related: [{ title: "Expansion by depth", doc: "Infinispand" }, { title: "Nodes" }] }), act);
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
    for (const l of ["Delete", "Lock", "Add a section after", "[Move: up down in out]", "Show only this"]) expect(lib).not.toContain(l);
    expect(lib).toContain("Add a document");
    expect(labels(nodeEntries(node({ note: true }), act))).toContain("Change its form");
    find(nodeEntries(node(), act), "Research on the web…").run();
    expect(calls).toEqual(["prompt /research "]);
    expect(labels(nodeEntries(node({ generating: false }), act))).not.toContain("Research on the web…");
  });

  it("a page adds the document's own items; a pane adds pin, close and the column", () => {
    const { act, calls } = recorder();
    const page = pageEntries(node({ doc: true }), act);
    expect(labels(page).slice(-2)).toEqual(["Save a copy", "Export as .md"]);
    find(page, "Export as .md").run();
    expect(calls).toEqual(["command /export"]);
    const pane = paneEntries({ node: node(), pinned: true }, act);
    expect(labels(pane).slice(-3)).toEqual(["Pin this pane", "Close this pane", "Show as one column"]);
    expect(find(pane, "Pin this pane").checked).toBe(true);
    expect(labels(paneEntries({ article: "Octopus", pinned: false }, act)).slice(0, 2)).toEqual(["# Octopus", "Open on wikipedia.org"]);
  });

  it("the top menu: documents, history, undo and redo, links, the layout and settings as commands", () => {
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
    expect(labels(topEntries(top({ doc: false }), act))).not.toContain("Review suggested links");
  });

  it("tidy leaves no separator at an end or next to another", () => {
    const s = { t: "sep" } as const;
    const h = { t: "head", text: "x" } as const;
    expect(tidy([s, h, s, false, s, null, h, s, ""]).map((e) => e.t)).toEqual(["head", "sep", "head"]);
  });
});
