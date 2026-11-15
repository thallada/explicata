/** Rendering shared by both page layouts: a node's body with its notes, the outline rows, and the top of the page. */
import { Component, type ComponentChildren } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { anchorLost, ancestors, descendants, docOf, isLibraryRoot, label, notesOf, sections, staleness, type NodeId, type Snap } from "../core/model";
import type { Ref } from "../core/ref";
import { clip, overlaps, paragraphs, plain, type Form, type Range } from "../core/text";
import { streamView } from "../core/marks";
import { ChoiceRows, LinkMark, LinkPreview, NodeBacklinks, NodeRelated, SuggestionCard, TargetRow, articleChoice, sectionChoice, useWikiSuggest, type Choice } from "./Links";
import { store, type Pending } from "./store";

// ---- inline text ----

/** A note as the renderer sees it: one in the document, or one still being written. */
interface VNote {
  key: string;
  id?: NodeId;
  form: Form;
  ranges: Range[];
  open: boolean;
  pending?: Pending;
  lens?: string;
  /** Its target, if it links somewhere. */
  ref?: Ref;
  /** A link: a target and no text of its own. */
  link?: boolean;
}

function notesFor(snap: Snap, id: NodeId): { placed: VNote[]; orphans: NodeId[] } {
  const placed: VNote[] = [];
  const orphans: NodeId[] = [];
  for (const c of notesOf(snap, id)) {
    const n = snap.nodes[c];
    const ranges = n.anchors.filter((a) => a.end > a.start).map((a): Range => [a.start, a.end]);
    if (!ranges.length || n.anchors.every(anchorLost)) orphans.push(c);
    else placed.push({ key: c, id: c, form: n.form ?? "note", ranges, open: store.open.has(c), lens: n.lens, ref: n.ref, link: !!n.ref && !n.body.trim() });
  }
  for (const p of store.pending.values()) {
    if (p.node === id && p.kind === "note" && p.range) placed.push({ key: p.key, form: p.form ?? "note", ranges: [p.range], open: true, pending: p, lens: p.lens });
  }
  return { placed, orphans };
}

const MARK = /\*([^*\n]+)\*|`([^`\n]+)`/g;

/** One paragraph (or a whole short body) as spans that know their offsets into the body. */
function Para(props: { id: NodeId; range: Range; notes: VNote[]; inline: boolean; inNote: boolean; first: boolean }) {
  const { id, range, notes, inline } = props;
  const snap = store.snap;
  const body = snap.nodes[id].body;
  const [ps, pe] = range;
  const cuts = new Set<number>([ps, pe]);
  const clipTo = (r: Range): Range | null => (r[0] < pe && r[1] > ps ? [Math.max(r[0], ps), Math.min(r[1], pe)] : null);
  const cut = (r: Range | null) => r && (cuts.add(r[0]), cuts.add(r[1]));

  // *emphasis* and `code`: the markers are hidden but still count as characters.
  const hidden = new Set<number>();
  const em: Range[] = [];
  const code: Range[] = [];
  const text = body.slice(ps, pe);
  MARK.lastIndex = 0;
  for (let m; (m = MARK.exec(text)); ) {
    const a = ps + m.index;
    const b = a + m[0].length;
    hidden.add(a).add(b - 1);
    (m[1] !== undefined ? em : code).push([a + 1, b - 1]);
    [a, a + 1, b - 1, b].forEach((x) => cuts.add(x));
  }

  for (const n of notes) n.ranges.forEach((r) => cut(clipTo(r)));
  // Suggested links: a faint dashed underline where no note or link already is.
  const suggs = store.preview ? [] : store.links.forNode(id, snap).filter((sg) => !notes.some((n) => n.ranges.some((r) => overlaps(r, sg.range))));
  for (const sg of suggs) cut(clipTo(sg.range));
  const focusedSugg = store.focusedSuggestion();
  // Each linked span gets one mark, after its last character: the first link on it, in library order.
  const marked = new Set<string>();
  const f = store.focus;
  const sel = f.node === id && f.grain !== "node" && f.range ? clipTo(f.range) : null;
  cut(sel);
  // On the root, show which sentences of the prompt the focused section grew from.
  const focusNode = snap.nodes[f.node];
  const chain = focusNode ? [f.node, ...ancestors(snap, f.node)] : [];
  const source = chain.map((x) => snap.nodes[x]).find((x) => x.parent === id && x.kind === "section" && x.anchors.length);
  const srcRanges = source ? source.anchors.map((a): Range => [a.start, a.end]) : [];
  srcRanges.forEach((r) => cut(clipTo(r)));

  const within = (rs: Range[], a: number, b: number) => rs.some((r) => r[0] <= a && r[1] >= b);
  const points = [...cuts].sort((x, y) => x - y);
  const out: ComponentChildren[] = [];
  const after: ComponentChildren[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (!(b === a + 1 && hidden.has(a))) {
      // A note (with text) gets the dotted underline; a link the solid one. A note that also links
      // keeps its dotted underline and gets the mark, so the two facts stay separately legible.
      const note = notes.find((n) => !n.link && within(n.ranges, a, b));
      const link = notes.find((n) => n.ref && within(n.ranges, a, b));
      const sugg = !note && !link ? suggs.find((sg) => sg.range[0] <= a && sg.range[1] >= b) : undefined;
      const cls = [
        within(em, a, b) && "em",
        within(code, a, b) && "code",
        note && `anchor a-${note.form}`,
        note?.open && "on",
        note?.pending && "writing",
        link?.link && !note && `lnk l-${link.ref!.kind}${link.open ? " on" : ""}`,
        sel && sel[0] <= a && sel[1] >= b && `sel ${f.grain}`,
        within(srcRanges, a, b) && "src",
        sugg && `sugg${sugg.tier === "auto" ? " sure" : ""}`,
      ].filter(Boolean).join(" ");
      out.push(
        <span key={a} data-o={a} class={cls || undefined} data-note={(note ?? link)?.id} data-sugg={sugg?.id}>
          {body.slice(a, b)}
        </span>,
      );
    }
    for (const n of notes) {
      const r = n.ranges[0];
      if (!n.ref || r[1] !== b || b <= ps || b > pe || marked.has(`${r[0]}:${r[1]}`)) continue;
      marked.add(`${r[0]}:${r[1]}`);
      out.push(<LinkMark key={`m${n.key}`} r={n.ref} id={n.id} />);
    }
    if (focusedSugg && focusedSugg.node === id && focusedSugg.range[1] === b && b > ps && b <= pe) after.push(<SuggestionCard key="sugg" sg={focusedSugg} />);
    for (const n of notes) {
      if (!n.open || n.ranges[0][1] !== b || (b === ps && i === 0)) continue;
      if (n.link) {
        // A link opens its target in panes; in the column it shows a preview under the paragraph.
        if (!store.panes && n.id) after.push(<LinkPreview key={`p${n.key}`} id={n.id} />);
        continue;
      }
      const view = <NoteView key={`n${n.key}`} v={n} inNote={props.inNote} />;
      // A pane has no margin, so there a margin note follows its paragraph instead of splitting it.
      if (n.form === "passage" || (n.form === "note" && (props.inNote || store.panes))) after.push(view);
      else out.push(view);
    }
  }
  const Tag = (inline ? "span" : "p") as "p";
  return (
    <>
      <Tag class={`para${props.first ? " first" : ""}`}>{out}</Tag>
      {after}
    </>
  );
}

function Writing({ text }: { text: string }) {
  // Link marks ([[…]]) a model writes are never shown, even half-written.
  return (
    <>
      {plain(streamView(text))}
      <span class="caret" />
    </>
  );
}

const LENS_LABEL: Record<string, string> = { elaborate: "", define: "definition", why: "why", example: "example", challenge: "objection" };

function NoteView({ v, inNote }: { v: VNote; inNote: boolean }) {
  const snap = store.snap;
  const focused = !!v.id && store.focus.node === v.id;
  const st = v.id ? staleness(snap, v.id) : null;
  const stale = !!st && (st.down || st.up);
  const cls = `${focused && store.focus.grain === "node" ? " focused" : ""}${v.pending ? " pending" : ""}${stale ? " stale" : ""}`;
  const lens = v.lens ? (LENS_LABEL[v.lens] ?? v.lens) : "";
  const content = v.pending ? <Writing text={v.pending.text} /> : <NodeBody id={v.id!} inline inNote />;
  const meta = (lens || stale || (v.id && snap.nodes[v.id].pinned)) && (
    <span class="meta">
      {lens}
      {v.id && snap.nodes[v.id].pinned ? " · pinned" : ""}
      {stale ? " · stale" : ""}
    </span>
  );
  if (v.form === "gloss") {
    return (
      <span class={`gloss${cls}`} data-node={v.id}>
        {content}
      </span>
    );
  }
  const kids = v.id ? sections(snap, v.id) : [];
  return (
    <span class={`${v.form === "passage" || inNote ? "inset" : "sidenote"}${cls}`} data-node={v.id}>
      {meta}
      {content}
      {kids.length > 0 && <Outline ids={kids} />}
      {v.id && <PendingSections id={v.id} />}
    </span>
  );
}

/** The phrase a choice puts in the text: what was typed, finished from the title where the title continues it. */
function phraseFor(typed: string, title: string): string {
  const base = title.replace(/\s*\([^)]*\)\s*$/, "");
  if (!typed.trim()) return base;
  return base.toLowerCase().startsWith(typed.toLowerCase()) ? typed + base.slice(typed.length) : typed.trim();
}

function BodyEditor({ id }: { id: NodeId }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // The [[ completer: where the [[ is, what follows it, Wikipedia's answer for it, and the selection.
  const [comp, setComp] = useState<{ start: number; q: string } | null>(null);
  const [sel, setSel] = useState(0);
  const fit = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  };
  useLayoutEffect(() => {
    ref.current?.focus();
    fit();
  }, []);
  const typed = comp?.q.trim() ?? "";
  const wiki = useWikiSuggest(typed.length >= 2 ? typed : "");
  const detect = () => {
    const el = ref.current!;
    const m = /\[\[([^\[\]\n|]{0,60})$/.exec(el.value.slice(0, el.selectionStart));
    setComp(m ? { start: el.selectionStart - m[0].length, q: m[1] } : null);
    setSel(0);
  };
  // Library titles are instant and come first.
  const choices: Choice[] = typed
    ? [...store.search(comp!.q).filter((x) => x !== id).slice(0, 5).map(sectionChoice), ...(wiki?.list.slice(0, 6) ?? []).map(articleChoice)]
    : [];
  const accept = (c: Choice) => {
    const el = ref.current!;
    const phrase = phraseFor(comp!.q, c.label);
    el.setRangeText(phrase, comp!.start, el.selectionStart, "end");
    (store.edit!.chosen ??= []).push({ phrase, at: comp!.start, target: c.ref });
    setComp(null);
    fit();
  };
  return (
    <>
      <textarea
        ref={ref}
        class="editor"
        data-edit={id}
        spellcheck
        defaultValue={store.edit!.value}
        onInput={() => (fit(), detect())}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (comp) {
            const n = choices.length;
            if (e.key === "Escape") return e.preventDefault(), setComp(null);
            if (n && (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey))) return e.preventDefault(), setSel((sel + 1) % n);
            if (n && (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey))) return e.preventDefault(), setSel((sel - 1 + n) % n);
            if (n && e.key === "Enter") return e.preventDefault(), accept(choices[Math.min(sel, n - 1)]);
          }
          if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) {
            e.preventDefault();
            store.commitEdit((e.target as HTMLTextAreaElement).value);
          }
        }}
        onKeyUp={(e) => (e.key === "ArrowLeft" || e.key === "ArrowRight") && detect()}
        onBlur={(e) => store.edit?.node === id && store.commitEdit((e.target as HTMLTextAreaElement).value)}
      />
      {comp && (
        <div class="completer" data-completer>
          <ul>
            <ChoiceRows choices={choices} sel={Math.min(sel, choices.length - 1)} pick={accept} />
            {!choices.length && <li class="group">{comp.q.trim() ? "Nothing yet · Esc leaves [[…]] to be looked up on save" : "Type what to link"}</li>}
          </ul>
        </div>
      )}
    </>
  );
}

/** A node's body: paragraphs, with its notes placed where they are anchored. */
export function NodeBody({ id, inline, inNote }: { id: NodeId; inline?: boolean; inNote?: boolean }) {
  const snap = store.snap;
  const n = snap.nodes[id];
  if (store.edit?.node === id && store.edit.field === "body") return <BodyEditor id={id} />;
  const rewrite = [...store.pending.values()].find((p) => p.node === id && p.kind === "rewrite");
  const { placed, orphans } = notesFor(snap, id);
  const paras = paragraphs(n.body);
  return (
    <span class={`body${rewrite ? " rewriting" : ""}`} data-body={id}>
      {paras.map((r, i) => (
        <Para key={i} id={id} range={r} notes={placed} inline={!!inline} inNote={!!inNote} first={i === 0} />
      ))}
      {!paras.length && !inline && (
        <p class="para first empty">
          {isLibraryRoot(snap, id) ? "Every document is a section of this library. l or Enter opens one, a adds one, m lists them; c writes a note about the library here." : `No text yet. c to write it${store.generating ? ", e to have it written" : ""}.`}
        </p>
      )}
      {orphans.map((o) => (
        <span key={o} class={`inset orphan${store.focus.node === o ? " focused" : ""}`} data-node={o}>
          <span class="meta">orphaned: its text “{clip(snap.nodes[o].anchors[0]?.quote ?? "", 60)}” was deleted</span>
          <NodeBody id={o} inline inNote />
        </span>
      ))}
    </span>
  );
}

export function PendingSections({ id }: { id: NodeId }) {
  const p = [...store.pending.values()].find((x) => x.node === id && x.kind === "sections");
  if (!p) return null;
  return (
    <div class="pending-sections">
      {p.text
        ? p.text.split(/^##\s+/m).filter((c) => c.trim()).map((chunk, i, all) => {
            const nl = chunk.indexOf("\n");
            const title = nl < 0 ? chunk : chunk.slice(0, nl);
            return (
              <div key={i} class="pending-section">
                <div class="title">{title}</div>
                <p class="para first">
                  {i === all.length - 1 ? <Writing text={nl < 0 ? "" : chunk.slice(nl + 1)} /> : plain(streamView(nl < 0 ? "" : chunk.slice(nl + 1)))}
                </p>
              </div>
            );
          })
        : <p class="para first"><Writing text="" /></p>}
    </div>
  );
}

// ---- the outline ----

export function TitleEditor({ id }: { id: NodeId }) {
  const ref = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => ref.current?.focus(), []);
  return (
    <input
      ref={ref}
      class="title-editor"
      data-edit={id}
      defaultValue={store.edit!.value}
      placeholder="Title"
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === "Escape") {
          e.preventDefault();
          store.commitEdit((e.target as HTMLInputElement).value);
        }
        e.stopPropagation();
      }}
      onBlur={(e) => store.edit?.node === id && store.commitEdit((e.target as HTMLInputElement).value)}
    />
  );
}

export function Flags({ id }: { id: NodeId }) {
  const snap = store.snap;
  const n = snap.nodes[id];
  const st = staleness(snap, id);
  const conflict = store.shown.conflicts().some((c) => c.status === "open" && (c.node === id || c.other === id));
  const flags = [
    conflict && "conflict",
    st.up && "sections changed",
    st.down && "parent changed",
    n.pinned && n.parent && "pinned",
  ].filter(Boolean) as string[];
  if (!flags.length) return null;
  return <span class={`flags${st.up || st.down || conflict ? " attn" : ""}`}>{flags.join(" · ")}</span>;
}

/** Redraws a section only when something in its subtree changed. */
class Section extends Component<{ id: NodeId }> {
  shouldComponentUpdate(next: { id: NodeId }) {
    return next.id !== this.props.id || store.isDirty(next.id);
  }
  render() {
    return <SectionView id={this.props.id} />;
  }
}

/** A section's title line: marker, title (or its editor), flags. Clicking it is handled by the page. */
export function Row({ id, open, leaf, editing }: { id: NodeId; open: boolean; leaf: boolean; editing: boolean }) {
  const n = store.snap.nodes[id];
  return (
    <div class="row" data-row={id}>
      <span class="mark">{open ? "▾" : leaf ? "·" : "▸"}</span>
      {editing ? <TitleEditor id={id} /> : <span class="title">{n.title || <i class="untitled">untitled</i>}</span>}
      <Flags id={id} />
    </div>
  );
}

function SectionView({ id }: { id: NodeId }) {
  const snap = store.snap;
  const n = snap.nodes[id];
  const open = store.isOpen(id);
  const kids = sections(snap, id);
  const focused = store.focus.node === id;
  const leaf = !kids.length && !n.body.trim();
  const editing = store.edit?.node === id && store.edit.field === "title";
  const st = staleness(snap, id);
  return (
    <li class={`node d${Math.min(n.depth - (snap.library ? 1 : 0), 6)}${open ? " open" : ""}${focused ? " focused" : ""}${st.up || st.down ? " stale" : ""}`} data-node={id}>
      <Row id={id} open={open} leaf={leaf} editing={editing} />
      {open && (
        <div class="content">
          <NodeBody id={id} />
          {kids.length > 0 && <Outline ids={kids} />}
          <PendingSections id={id} />
          <TargetRow id={id} />
          <NodeBacklinks id={id} />
          <NodeRelated id={id} />
        </div>
      )}
    </li>
  );
}

export function Outline({ ids }: { ids: NodeId[] }) {
  return (
    <ul class="outline">
      {ids.map((id) => (
        <Section key={id} id={id} />
      ))}
    </ul>
  );
}

/**
 * The head of a page or of a pane that is a page of its own: the top node, or a document. Crumbs
 * (on the top only), title, byline, and the node's own text, folded if it is a prompt. The
 * library's byline counts documents; a document's counts its own sections and nodes.
 */
export function TopMatter({ id }: { id: NodeId }) {
  const snap = store.snap;
  const n = snap.nodes[id];
  const kids = sections(snap, id);
  const isTop = id === store.top;
  const crumbs = isTop ? ancestors(snap, id).reverse() : [];
  const focused = store.focus.node === id;
  const editing = store.edit?.node === id && store.edit.field === "title";
  const library = isLibraryRoot(snap, id);
  // A document whose sections cite its sentences is a prompt (the first document's is): long, and
  // the page should open on the outline, so it is folded until asked for. Other text is plain.
  const prompt = !library && docOf(snap, id) === id && kids.some((k) => snap.nodes[k].anchors.length > 0);
  const folded = prompt && !store.unfolded.has(id) && !(focused && store.focus.grain !== "node") && store.edit?.node !== id;
  const count = library ? Object.keys(snap.nodes).length - 1 : descendants(snap, id).length;
  return (
    <>
      {crumbs.length > 0 && (
        <nav class="crumbs">
          {crumbs.map((c) => (
            <span key={c}>
              <a onClick={() => (isLibraryRoot(snap, c) ? store.setHoist(null) : store.setHoist(c))}>{label(snap, c)}</a> ›{" "}
            </span>
          ))}
        </nav>
      )}
      <header class={`top${focused ? " focused" : ""}${library ? " library" : ""}`} data-node={id}>
        <div data-row={id}>{editing ? <TitleEditor id={id} /> : <h1>{n.title || "Untitled"}</h1>}</div>
        <div class="byline">
          {library ? `${kids.length} document${kids.length === 1 ? "" : "s"}` : `${kids.length} section${kids.length === 1 ? "" : "s"}`} · {count} nodes · branch {store.repo.current}
          <Flags id={id} />
        </div>
      </header>
      <div class={`abstract${prompt ? " seed" : ""}${folded ? " folded" : ""}`} onClick={folded ? () => store.toggleFold(id) : undefined}>
        <NodeBody id={id} />
      </div>
      {folded && <div class="unfold">Enter to read the whole prompt · every sentence of it is traced to a section below</div>}
    </>
  );
}
