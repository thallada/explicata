/**
 * A Wikipedia article shown as a tree, so the keys that move through nodes move through it: the
 * lead is its text, its sections are rows (in a pane a section opens as the next pane; on the
 * column's article page it opens in place), its links are Tab stops, and a disambiguation page
 * lists its senses as rows. It is never stored in the library: it comes from /api/wiki/article,
 * one request per article, cached by the server.
 *
 * Article panes look different on purpose (sans-serif, a tinted ground, a W at the head) so it is
 * always clear which text is Wikipedia's and which is the reader's, and every view of article
 * text ends with its attribution.
 */
import { h, type ComponentChildren } from "preact";
import { useContext } from "preact/hooks";
import type { NodeId } from "../core/model";
import { wikiKey } from "../core/ref";
import { clip, type Range } from "../core/text";
import type { Block } from "./articleText";
import { Attribution, Backlinks, PaneCtx, useForkMark } from "./Links";
import { NodeBody, NoteView, type VNote } from "./Node";
import { sameAux, store, type WRow } from "./store";
import { article, articleText, known, revisionUrl, sectionsUnder, sensesOf, summary, type Article } from "./wiki";

type Para = Extract<Block, { k: "para" }>;
interface Ctx {
  text: string;
  notes: VNote[];
  sel: { grain: string; range: Range } | null;
  /** The focused link's words, when the selection is exactly a link. */
  link: Range | null;
  /** In a pane with forks: the mark for a link whose article is open as one of them. */
  fork: ((...keys: string[]) => string) | null;
}

/**
 * A piece of article text (the lead or a section) as text the keys select in: every paragraph is
 * drawn from the same characters sentences() and words() count (articleText.ts), so a selection,
 * an annotation's words and a link are ranges into it, as in a node's body. Annotations are drawn
 * as the library's notes are (a dotted underline; the note inline, or after its paragraph), in the
 * library's own face. Tables and preformatted blocks are shown as they came.
 */
function ArticleTextView({ host, row, sec, html, article, lang }: { host: string; row: WRow; sec: number; html: string; article: Article; lang: string }) {
  const at = articleText(html);
  const a = store.aux;
  const here = a?.kind === "wiki" && a.host === host && sameAux({ ...a, grain: undefined, range: undefined }, { kind: "wiki", host, row });
  const sel = here && a.grain && a.range ? { grain: a.grain, range: a.range } : null;
  const link = sel && at.links.some((l) => l.range[0] === sel.range[0] && l.range[1] === sel.range[1]) ? sel.range : null;
  const snap = store.snap;
  const notes: VNote[] = [];
  for (const [id, p] of store.annotations(article, lang).at) {
    const n = snap.nodes[id];
    if (p.sec === sec) notes.push({ key: id, id, form: n.form ?? "note", ranges: [p.range], open: store.open.has(id), lens: n.lens });
  }
  const key = wikiKey(lang, article.title);
  const fork = useForkMark();
  for (const p of store.pending.values()) if (p.art?.key === key && p.art.sec === sec && p.range) notes.push({ key: p.key, form: p.form ?? "note", ranges: [p.range], open: true, pending: p, lens: p.lens });
  return (
    <div class="wiki-text" data-wtext={row.t === "sec" ? row.id : "head"}>
      <Blocks bs={at.blocks} c={{ text: at.text, notes, sel, link, fork }} />
    </div>
  );
}

function Blocks({ bs, c }: { bs: Block[]; c: Ctx }) {
  return (
    <>
      {bs.map((b, i) =>
        b.k === "para" ? <APara key={i} b={b} c={c} /> : b.k === "raw" ? <div key={i} class="wraw" dangerouslySetInnerHTML={{ __html: b.html }} /> : h(b.tag, { key: i, ...Object.fromEntries(b.attrs) }, <Blocks bs={b.kids} c={c} />),
      )}
    </>
  );
}

/** One paragraph, cut where its inline elements, annotations, the selection and the focused link begin and end; a formula is never cut. */
function APara({ b, c }: { b: Para; c: Ctx }) {
  const clipTo = (r: Range): Range | null => (r[0] < b.e && r[1] > b.s ? [Math.max(r[0], b.s), Math.min(r[1], b.e)] : null);
  const cuts = new Set<number>([b.s, b.e]);
  for (const r of b.runs) cuts.add(r.s).add(r.e);
  const notes = c.notes.filter((n) => n.ranges.some((r) => clipTo(r)));
  for (const n of notes) for (const r of n.ranges.map(clipTo)) if (r) cuts.add(r[0]).add(r[1]);
  const sel = c.sel && clipTo(c.sel.range);
  if (sel) cuts.add(sel[0]).add(sel[1]);
  const maths = b.runs.filter((r) => r.math);
  const points = [...cuts].filter((x) => !maths.some((m) => x > m.s && x < m.e)).sort((x, y) => x - y);
  const meets = (r: Range, x: number, y: number, whole: boolean) => (whole ? r[0] < y && r[1] > x : r[0] <= x && r[1] >= y);
  const out: ComponentChildren[] = [];
  const after: ComponentChildren[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const [x, y] = [points[i], points[i + 1]];
    const run = b.runs.find((r) => r.s <= x && x < r.e);
    if (run) {
      const whole = !!run.math;
      // Where notes overlap, the narrowest is the one these words open.
      const note = notes.filter((n) => n.ranges.some((r) => meets(r, x, y, whole))).sort((m, n) => m.ranges[0][1] - m.ranges[0][0] - (n.ranges[0][1] - n.ranges[0][0]))[0];
      const cls = [note && `anchor a-${note.form}`, note?.open && "on", note?.pending && "writing", sel && meets(sel, x, y, whole) && `sel ${c.sel!.grain}`].filter(Boolean).join(" ") || undefined;
      let el = run.math ? (
        <span key={x} class={cls ? `wmath ${cls}` : "wmath"} data-o={x} data-note={note?.id} dangerouslySetInnerHTML={{ __html: run.math }} />
      ) : (
        <span key={x} class={cls} data-o={x} data-note={note?.id}>
          {c.text.slice(x, y)}
        </span>
      );
      for (const m of [...run.marks].reverse()) {
        const attrs = Object.fromEntries(m.attrs);
        const cls = m.tag === "a" ? [c.link && meets(c.link, x, y, false) && "wfocus", c.fork && attrs["data-wiki"] && c.fork(`w:${attrs["data-wiki"]}`)].filter(Boolean).join(" ") : "";
        el = h(m.tag, { key: x, ...attrs, class: cls || undefined }, el);
      }
      out.push(el);
    }
    for (const n of notes) {
      if (!n.open || n.ranges[0][1] !== y) continue;
      const view = <NoteView key={`n${n.key}`} v={n} inNote />;
      if (n.form === "gloss") out.push(view);
      else after.push(view);
    }
  }
  return (
    <>
      {b.p ? <p class="wpara">{out}</p> : <span class="wpara loose">{out}</span>}
      {after}
    </>
  );
}

/** Annotations whose words are not in this revision: kept, shown at the top of their section (or of the article), with the words and the revision they were made on. */
function Detached({ ids, article, lang }: { ids: NodeId[]; article: Article; lang: string }) {
  if (!ids.length) return null;
  const snap = store.snap;
  return (
    <div class="wdetached">
      {ids.map((id) => {
        const w = snap.nodes[id].wanchor!;
        return (
          <span key={id} class={`inset detached${store.focus.node === id && !store.aux ? " focused" : ""}`} data-node={id}>
            <span class="meta">
              detached: “{clip(w.q, 90)}” is not in this revision ·{" "}
              <a href={revisionUrl(article.title, w.rev, lang)} target="_blank" rel="noopener noreferrer">
                the words in revision {w.rev}
              </a>
            </span>
            <NodeBody id={id} inline inNote />
          </span>
        );
      })}
    </div>
  );
}

/** The detached annotations of a section (0: the lead, which also takes those whose section is gone). */
const detachedIn = (article: Article, lang: string, sec: number) =>
  store.annotations(article, lang).detached.filter((d) => d.sec === sec || (sec === 0 && d.sec === null)).map((d) => d.id);

/** The W that marks Wikipedia's text, and the title. */
function Head({ title, sub, focused }: { title: string; sub?: string; focused: boolean }) {
  return (
    <header class={`wiki-head${focused ? " focused" : ""}`}>
      <div class="wiki-brand">
        <span class="wmark">W</span> Wikipedia
      </div>
      <h2>
        {title}
        {sub && <span class="wsub"> › {sub}</span>}
      </h2>
    </header>
  );
}

function Problem({ message }: { message: string }) {
  return <p class="wiki-problem">{message}</p>;
}

/** One article view. `host` says which (see Aux in store.ts); a pane passes its index. */
export function WikiView({ host }: { host: string }) {
  const tid = useContext(PaneCtx);
  const h = store.wikiHost(host);
  if (!h) return null;
  const a = store.aux;
  const at = (row: WRow) => !!a && a.kind === "wiki" && a.host === host && !a.grain && sameAux(a, { kind: "wiki", host, row });
  const embedded = h.embedded;

  // Under a node, folded: its summary only, until l unfolds the article.
  if (store.folded(embedded)) {
    const sum = summary(h.title, h.lang);
    return (
      <section class={`wiki embedded folded${at({ t: "head" }) ? " focused" : ""}`} data-host={host}>
        <Head title={sum.state === "ready" ? sum.value.title : h.title} focused={at({ t: "head" })} />
        {sum.state === "loading" && <p class="wiki-wait">Loading the summary…</p>}
        {sum.state === "failed" && <Problem message={sum.message} />}
        {sum.state === "ready" && (
          <>
            {sum.value.description && <p class="wiki-desc">{sum.value.description}</p>}
            <p class="wiki-summary">{sum.value.extract}</p>
            <p class="wiki-more">l opens the article here · L opens it in a pane of its own · W on Wikipedia</p>
            <Attribution a={sum.value.attribution} />
          </>
        )}
      </section>
    );
  }

  const art = article(h.title, h.lang);
  if (art.state !== "ready") {
    // While the article loads, a summary already at hand is shown at once.
    const have = known(h.title, h.lang).summary;
    return (
      <section class={`wiki${embedded ? " embedded" : ""}`} data-host={host}>
        <Head title={have?.title ?? h.title} focused={at({ t: "head" })} />
        {have && <p class="wiki-summary">{have.extract}</p>}
        {art.state === "loading" ? <p class="wiki-wait">Loading the article from Wikipedia…</p> : <Problem message={art.message} />}
        {have && <Attribution a={have.attribution} />}
        <Mentions title={h.title} lang={h.lang} show={!!h.mentions} at={at} />
      </section>
    );
  }
  const v = art.value;
  const sec = h.sec ? v.sections.find((x) => x.id === h.sec) : undefined;
  // A section open as a pane to the right is marked: the picked child "showing", another fork "forked".
  const showing = (id: number) => (store.panes ? store.kidMark(tid, (r) => r.kind === "wiki" && r.title === h.title && r.sec === id) : undefined);
  return (
    <section class={`wiki${embedded ? " embedded" : ""}`} data-host={host}>
      <Head title={v.title} sub={sec?.heading} focused={at({ t: "head" })} />
      {art.stale && <p class="wiki-wait">Wikipedia could not be reached; this is the copy kept from before.</p>}
      <Detached ids={detachedIn(v, h.lang, h.sec)} article={v} lang={h.lang} />
      <ArticleTextView host={host} row={{ t: "head" }} sec={h.sec} html={sec ? sec.html : v.lead} article={v} lang={h.lang} />
      {v.disambiguation && !sec && <Senses title={v.title} lang={h.lang} at={at} />}
      <Rows article={v} host={host} lang={h.lang} parent={h.sec} nested={!!h.nested} at={at} showing={showing} />
      <Mentions title={v.title} lang={h.lang} show={!!h.mentions} at={at} />
      <Attribution a={v.attribution} />
    </section>
  );
}

function Rows(props: { article: Article; host: string; lang: string; parent: number; nested: boolean; at: (r: WRow) => boolean; showing: (id: number) => "showing" | "forked" | undefined }) {
  const { article: v, host, lang, parent, nested, at, showing } = props;
  const kids = sectionsUnder(v, parent);
  if (!kids.length) return null;
  return (
    <ul class={`wrows${parent ? " nested" : ""}`}>
      {kids.map((x) => {
        const row: WRow = { t: "sec", id: x.id };
        const open = nested && store.colOpen.has(x.id);
        const leaf = !sectionsUnder(v, x.id).length;
        return (
          <li key={x.id} class={`wrow${at(row) ? " focused" : ""}${open ? " open" : ""}${showing(x.id) ? ` ${showing(x.id)}` : ""}`}>
            <div class="row" data-wrow={x.id}>
              <span class="mark">{open ? "▾" : leaf && !x.html ? "·" : "▸"}</span>
              <span class="title">{x.heading}</span>
              {x.number && <span class="wnum">{x.number}</span>}
            </div>
            {open && (
              <div class="content">
                <Detached ids={detachedIn(v, lang, x.id)} article={v} lang={lang} />
                <ArticleTextView host={host} row={row} sec={x.id} html={x.html} article={v} lang={lang} />
                <Rows {...props} parent={x.id} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Senses({ title, lang, at }: { title: string; lang: string; at: (r: WRow) => boolean }) {
  const ss = sensesOf(title, lang);
  if (ss.state === "loading") return <p class="wiki-wait">Loading its senses…</p>;
  if (ss.state === "failed") return <Problem message={ss.message} />;
  return (
    <section class="senses">
      <h3>“{title}” may refer to</h3>
      <ul class="wrows">
        {ss.value.map((x, i) => (
          <li key={x.title} class={`wrow sense${at({ t: "sense", i }) ? " focused" : ""}`}>
            <div class="row" data-sense={x.title}>
              <span class="mark">→</span>
              <span class="title">{x.title}</span>
              {x.description && <span class="wdesc">{clip(x.description, 70)}</span>}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** "Mentioned in": the library's nodes that link to this article, which is what makes an article a hub between documents. */
function Mentions({ title, lang, show, at }: { title: string; lang: string; show: boolean; at: (r: WRow) => boolean }) {
  if (!show) return null;
  return <Backlinks ids={store.mentionsOf(lang, title)} title="Mentioned in" focusedAt={(i) => at({ t: "back", i })} />;
}

/** The column's article page: the article on its own, h or Back returns to where it was opened. */
export function WikiPage() {
  return (
    <article class="wiki-page">
      <WikiView host="col" />
      <p class="wiki-back">h at the top, or Back, returns to “{clip(backLabel(), 40)}”.</p>
    </article>
  );
}

function backLabel(): string {
  const c = store.colWiki;
  if (!c) return "";
  if (c.stack.length) return c.stack[c.stack.length - 1].title;
  const n = store.snap.nodes[c.back.focus.node];
  return n ? n.title || "the text" : "the text";
}
