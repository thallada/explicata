/**
 * Bare addresses typed into a node's text (src/core/bareLinks.ts): which addresses are picked up
 * (trailing punctuation, brackets, code spans, words already linked, only those new in the edit,
 * declined ones), the link made as typed, the title swapped in while the words are untouched (and
 * not after a concurrent edit of them on another replica), undo bringing the address back without
 * it being converted again, a Wikipedia address, and a section whose whole text is an address.
 */
import { UndoManager } from "loro-crdt";
import { describe, expect, it } from "vitest";
import { addressTarget, bareAddresses, linkAddresses, newAddresses, placeholderTitle, titleLink, titleWhole, titleWords } from "../src/core/bareLinks";
import { Doc, SYSTEM_ORIGIN, linkOnly, notesOf, type NodeId } from "../src/core/model";
import { healAnchors, history, mergeUpdate } from "../src/core/repo";
import { phraseKey } from "../src/core/links";

const PAGE = "https://tracing.example.org/posts/following-a-request";
const meta = { author: "alice" };

function lib(body = "", title = "Reading") {
  const doc = Doc.library("alice");
  const [id] = doc.apply([{ op: "create", parent: doc.snap().root, title, body }], "Add").created;
  return { doc, id };
}

/** An edit of a node's text, as commitEdit makes it, and step 1 after it. */
function edit(doc: Doc, id: NodeId, body: string) {
  const before = doc.snap().nodes[id].body;
  doc.apply([{ op: "update", id, body }], "Edit");
  return linkAddresses(doc, id, before, meta);
}

const links = (doc: Doc, id: NodeId) => notesOf(doc.snap(), id).map((c) => doc.snap().nodes[c]).filter((n) => n.ref);
const sync = (into: Doc, from: Doc) => mergeUpdate(into, from.loro.export({ mode: "update", from: into.loro.version() }), from.loro.version().toJSON());

describe("which addresses are picked up", () => {
  it("trailing punctuation is not part of an address; a bracket only when it closes one inside", () => {
    const text = `See ${PAGE}. Also (https://a.example.org/x), https://en.wikipedia.org/wiki/Mercury_(planet), and https://b.example.org/q?a=1&b=2!`;
    expect(bareAddresses(text).map((b) => b.url)).toEqual([PAGE, "https://a.example.org/x", "https://en.wikipedia.org/wiki/Mercury_(planet)", "https://b.example.org/q?a=1&b=2"]);
    const [first] = bareAddresses(text);
    expect(text.slice(...first.range)).toBe(PAGE);
  });

  it("none inside a code span or a fenced block; not half-typed ones, nor hosts without a dot", () => {
    expect(bareAddresses("`https://code.example.org/a` and\n```\nhttps://fence.example.org/b\n```\nbut https://real.example.org/c")).toEqual([
      { range: expect.any(Array), url: "https://real.example.org/c" },
    ]);
    expect(bareAddresses("https:// and http://localhost/x and ftp://x.example.org/ and xhttps://y.example.org/")).toEqual([]);
  });

  it("only addresses the edit brought: one already in the text before is never new", () => {
    expect(newAddresses(`old ${PAGE}`, `old ${PAGE} and https://new.example.org/`).map((b) => b.url)).toEqual(["https://new.example.org/"]);
  });

  it("titles become plain words; placeholders say nothing yet", () => {
    expect(titleWords("  A *bold*\n`title` [[x]] ")).toBe("A bold title x");
    expect(placeholderTitle("", PAGE)).toBe(true);
    expect(placeholderTitle("Untitled", PAGE)).toBe(true);
    expect(placeholderTitle(PAGE, PAGE)).toBe(true);
    expect(placeholderTitle("My reading", PAGE)).toBe(false);
    expect(addressTarget("https://fr.m.wikipedia.org/wiki/Phare#Histoire")).toEqual({ kind: "wiki", title: "Phare", lang: "fr" });
    expect(addressTarget(PAGE)).toEqual({ kind: "url", url: PAGE });
  });
});

describe("an address typed into a node's text", () => {
  it("is linked as typed, then titled from its page in a commit of its own; undo brings the address back, and it is not converted again", () => {
    const { doc, id } = lib("A first line.");
    const u = new UndoManager(doc.loro, { mergeInterval: 0, maxUndoSteps: 50, excludeOriginPrefixes: [SYSTEM_ORIGIN] });
    doc.group = { start: () => u.groupStart(), end: () => u.groupEnd() };
    const r = edit(doc, id, `A first line. Read ${PAGE}, then sleep.`);
    expect(r.whole).toBeNull();
    expect(r.links).toHaveLength(1);
    let [link] = links(doc, id);
    expect(link.ref).toEqual({ kind: "url", url: PAGE });
    expect(link.anchors[0].text).toBe(PAGE);
    expect(history(doc).map((c) => c.message).join("\n")).toMatch(/^Link “https:\/\/tracing/);

    expect(titleLink(doc, r.links[0], "Following one request through the stack", meta)).toBe(true);
    expect(doc.snap().nodes[id].body).toBe("A first line. Read Following one request through the stack, then sleep.");
    [link] = links(doc, id);
    expect(link.anchors[0].text).toBe("Following one request through the stack");
    expect(link.ref).toEqual({ kind: "url", url: PAGE, title: "Following one request through the stack" });

    // u: the address back, still linked to the page.
    u.undo();
    doc.touch();
    healAnchors(doc);
    expect(doc.snap().nodes[id].body).toBe(`A first line. Read ${PAGE}, then sleep.`);
    [link] = links(doc, id);
    expect(link.anchors[0].text).toBe(PAGE);
    // A later edit of the same node does not take it for new.
    const again = edit(doc, id, `A first line, changed. Read ${PAGE}, then sleep.`);
    expect(again).toEqual({ links: [], whole: null });
  });

  it("several addresses in one edit are linked in one commit; words already linked and declined phrases are left alone", () => {
    const { doc, id } = lib("Start.");
    const one = edit(doc, id, "Start. https://one.example.org/a and https://two.example.org/b");
    expect(one.links.map((l) => l.url)).toEqual(["https://one.example.org/a", "https://two.example.org/b"]);
    expect(links(doc, id)).toHaveLength(2);
    // An address typed where it is already linked (the same words, linked by hand before) stays as it is.
    const { doc: d2, id: n2 } = lib("Start.");
    const before = d2.snap().nodes[n2].body;
    d2.apply([{ op: "update", id: n2, body: "Start. https://three.example.org/c" }], "Edit");
    d2.apply([{ op: "create", parent: n2, kind: "note", quote: "https://three.example.org/c", ref: { kind: "wiki", title: "Octopus", lang: "en" } }], "Link by hand");
    expect(linkAddresses(d2, n2, before, meta).links).toEqual([]);
    // A declined phrase (D on the link) is not linked again.
    const { doc: d3, id: n3 } = lib("Start.", "Declined");
    const r3 = edit(d3, n3, "Start. https://four.example.org/d");
    d3.apply([{ op: "delete", id: r3.links[0].note }, { op: "update", id: n3, body: "Start.", nolink: [phraseKey("https://four.example.org/d")] }], "Decline");
    expect(edit(d3, n3, "Start. https://four.example.org/d").links).toEqual([]);
  });

  it("the swap is dropped when the words were changed meanwhile, here or on another replica", () => {
    const { doc, id } = lib("Start.");
    const r = edit(doc, id, `Start. ${PAGE}`);
    // Another replica edits the address before the title arrives here.
    const other = doc.fork("bob");
    other.apply([{ op: "update", id, body: `Start. ${PAGE}/more` }], "Edit");
    sync(doc, other);
    expect(titleLink(doc, r.links[0], "Following one request", meta)).toBe(false);
    expect(doc.snap().nodes[id].body).toBe(`Start. ${PAGE}/more`);
    // And a retargeted link keeps its words.
    const { doc: d2, id: n2 } = lib("Start.");
    const r2 = edit(d2, n2, `Start. ${PAGE}`);
    d2.apply([{ op: "update", id: r2.links[0].note, ref: { kind: "wiki", title: "Octopus", lang: "en" } }], "Retarget");
    expect(titleLink(d2, r2.links[0], "Following one request", meta)).toBe(false);
  });

  it("a Wikipedia article's address is linked to the article, and titled with its title", () => {
    const { doc, id } = lib("Start.");
    const r = edit(doc, id, "Start. See https://en.wikipedia.org/wiki/Common_octopus.");
    expect(r.links[0].target).toEqual({ kind: "wiki", title: "Common octopus", lang: "en" });
    expect(titleLink(doc, r.links[0], "Common octopus", meta)).toBe(true);
    expect(doc.snap().nodes[id].body).toBe("Start. See Common octopus.");
    expect(links(doc, id)[0].ref).toEqual({ kind: "wiki", title: "Common octopus", lang: "en" });
  });
});

describe("a section whose whole text is an address", () => {
  it("becomes a section that is only the link, named by its page when its title says nothing yet", () => {
    const { doc, id } = lib("", "");
    const r = edit(doc, id, `  ${PAGE}  `);
    expect(r.links).toEqual([]);
    expect(r.whole).toEqual({ node: id, url: PAGE, target: { kind: "url", url: PAGE } });
    let n = doc.snap().nodes[id];
    expect(n.body).toBe("");
    expect(n.ref).toEqual({ kind: "url", url: PAGE });
    expect(linkOnly(doc.snap(), id)).toBe(true);
    expect(titleWhole(doc, r.whole!, "Following one request through the stack", meta)).toBe(true);
    n = doc.snap().nodes[id];
    expect(n.title).toBe("Following one request through the stack");
    expect(n.ref).toEqual({ kind: "url", url: PAGE, title: "Following one request through the stack" });
  });

  it("keeps a title of its own", () => {
    const { doc, id } = lib("", "My reading");
    const r = edit(doc, id, PAGE);
    expect(r.whole).not.toBeNull();
    expect(titleWhole(doc, r.whole!, "Following one request", meta)).toBe(false);
    expect(doc.snap().nodes[id].title).toBe("My reading");
  });

  it("a Wikipedia address makes it a section about the article", () => {
    const { doc, id } = lib("", "");
    const r = edit(doc, id, "https://en.wikipedia.org/wiki/Octopus");
    expect(doc.snap().nodes[id].ref).toEqual({ kind: "wiki", title: "Octopus", lang: "en" });
    expect(titleWhole(doc, r.whole!, "Octopus", meta)).toBe(true);
    expect(doc.snap().nodes[id].title).toBe("Octopus");
  });
});
