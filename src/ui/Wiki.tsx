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
import { useContext, useEffect, useRef, useState } from "preact/hooks";
import type { NodeId } from "../core/model";
import { clip, type Range } from "../core/text";
import { PLAYER_ALLOW, PLAYER_SANDBOX, embedSrc } from "../core/video";
import type { Block } from "./articleText";
import { Attribution, Backlinks, PaneCtx, useForkMark } from "./Links";
import { NodeBody, NoteView, type VNote } from "./Node";
import { sameAux, sourceId, store, textOf, type SecId, type Source, type WRow } from "./store";
import { article, known, revisionUrl, sectionsUnder, sensesOf, summary, type Article } from "./wiki";
import { webKey } from "./web";

type Para = Extract<Block, { k: "para" }>;
/** What drawing a piece of article text needs besides its blocks (a web page's too: Web.tsx). */
export interface Ctx {
  text: string;
  notes: VNote[];
  sel: { grain: string; range: Range } | null;
  /** The focused link's words, when the selection is exactly a link. */
  link: Range | null;
  /** In a pane with forks: the mark for a link whose article is open as one of them. */
  fork: ((...keys: string[]) => string) | null;
}

/**
 * A piece of article text (the lead or a section of a Wikipedia article or of a web page) as text
 * the keys select in: every paragraph is drawn from the same characters sentences() and words()
 * count (articleText.ts), so a selection, an annotation's words and a link are ranges into it, as
 * in a node's body. Annotations are drawn as the library's notes are (a dotted underline; the note
 * inline, or after its paragraph), in the library's own face. Tables and preformatted blocks are
 * shown as they came.
 */
export function ArticleTextView({ host, row, sec, html, src }: { host: string; row: WRow; sec: SecId; html: string; src: Source }) {
  const at = textOf(src, html);
  const a = store.aux;
  const here = a?.kind === "wiki" && a.host === host && sameAux({ ...a, grain: undefined, range: undefined }, { kind: "wiki", host, row });
  const sel = here && a.grain && a.range ? { grain: a.grain, range: a.range } : null;
  const link = sel && at.links.some((l) => l.range[0] === sel.range[0] && l.range[1] === sel.range[1]) ? sel.range : null;
  const snap = store.snap;
  const notes: VNote[] = [];
  for (const [id, p] of store.annotations(src).at) {
    const n = snap.nodes[id];
    if (p.sec === sec) notes.push({ key: id, id, form: n.form ?? "note", ranges: [p.range], open: store.open.has(id), lens: n.lens });
  }
  const key = sourceId(src);
  const fork = useForkMark();
  for (const p of store.pending.values()) if (p.art?.key === key && p.art.sec === sec && p.range) notes.push({ key: p.key, form: p.form ?? "note", ranges: [p.range], open: true, pending: p, lens: p.lens });
  return (
    <div class="wiki-text" data-wtext={row.t === "sec" ? row.id : "head"}>
      <Blocks bs={at.blocks} c={{ text: at.text, notes, sel, link, fork }} />
    </div>
  );
}

export function Blocks({ bs, c }: { bs: Block[]; c: Ctx }) {
  return (
    <>
      {bs.map((b, i) =>
        b.k === "para" ? (
          <APara key={i} b={b} c={c} />
        ) : b.k === "raw" ? (
          <div key={i} class="wraw" dangerouslySetInnerHTML={{ __html: b.html }} />
        ) : b.tag === "figure" && b.attrs.some(([k, v]) => k === "class" && v === "video") ? (
          <VideoFigure key={i} b={b} c={c} />
        ) : (
          h(b.tag, { key: i, ...Object.fromEntries(b.attrs) }, <Blocks bs={b.kids} c={c} />)
        ),
      )}
    </>
  );
}

type El = Extract<Block, { k: "el" }>;

/** A video box's shape: the nearest of a few common ones to the video's own (16:9 when unknown), as a class, since the text may carry no style attribute. */
const SHAPES: [string, number][] = [["r21-9", 21 / 9], ["r16-9", 16 / 9], ["r3-2", 3 / 2], ["r4-3", 4 / 3], ["r1-1", 1], ["r3-4", 3 / 4], ["r9-16", 9 / 16]];
function shape(size: { width?: string; height?: string }): string {
  const r = size.width && size.height ? Number(size.width) / Number(size.height) : 16 / 9;
  return SHAPES.reduce((best, s) => (Math.abs(Math.log(s[1] / r)) < Math.abs(Math.log(best[1] / r)) ? s : best))[0];
}

/**
 * A video's facade (src/core/video.ts): its still and a play mark, its caption under them, and on
 * Wikipedia a link to its File page, which credits it. Nothing plays or loads from elsewhere until
 * the click; then a <video controls preload="none"> with the checked source (started, since the
 * reader asked), or an iframe to the one player address for the checked id, takes the still's
 * place. Both are made here from the data attributes the cleaning let through, never from the
 * page's own markup.
 */
function VideoFigure({ b, c }: { b: El; c: Ctx }) {
  const [playing, setPlaying] = useState(false);
  const ref = useRef<HTMLVideoElement>(null);
  const a = Object.fromEntries(b.attrs) as Record<string, string | undefined>;
  const still = b.kids.find((k): k is Extract<Block, { k: "raw" }> => k.k === "raw");
  const stillSrc = still && /^<img src="([^"]*)"/.exec(still.html)?.[1]?.replace(/&amp;/g, "&");
  const rest = b.kids.filter((k) => k !== still);
  const player = a["data-embed"] && a["data-id"] ? embedSrc(a["data-embed"], a["data-id"]) : null;
  const size = a["data-width"] && a["data-height"] && !player ? { width: a["data-width"], height: a["data-height"] } : {};
  const caption = rest.map((k) => (k.k === "para" ? c.text.slice(k.s, k.e) : k.k === "el" ? k.kids.map((x) => (x.k === "para" ? c.text.slice(x.s, x.e) : "")).join(" ") : "")).join(" ").trim();
  useEffect(() => {
    if (playing) void ref.current?.play().catch(() => {});
  }, [playing]);
  const play = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    setPlaying(true);
  };
  return (
    <figure {...a} class={`video${a["data-embed"] ? " embed" : ""}${playing ? " playing" : ""}`}>
      {!playing ? (
        <div class={`video-box ${shape(size)}`} role="button" aria-label={`Play video${caption ? `: ${caption}` : ""}`} onClick={play}>
          {still && <div class="wraw" dangerouslySetInnerHTML={{ __html: still.html }} />}
          <span class="video-play" aria-hidden="true">▶</span>
        </div>
      ) : player ? (
        <div class="video-box r16-9">
          <iframe src={player} title={caption || "Video"} sandbox={PLAYER_SANDBOX} allow={PLAYER_ALLOW} referrerpolicy="no-referrer" />
        </div>
      ) : (
        <div class={`video-box ${shape(size)}`}>
          <video ref={ref} src={a["data-video"]} controls preload="none" {...size} {...(stillSrc ? { poster: stillSrc } : {})} />
        </div>
      )}
      <Blocks bs={rest} c={c} />
      {a["data-file"] && (
        <a class="video-credit" href={a["data-file"]} target="_blank" rel="noopener noreferrer">
          File page: author and licence ↗
        </a>
      )}
    </figure>
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
        const fork = c.fork && (attrs["data-wiki"] ? c.fork(`w:${attrs["data-wiki"]}`) : attrs["data-url"] ? c.fork(webKey(attrs["data-url"])) : "");
        const cls = m.tag === "a" ? [c.link && meets(c.link, x, y, false) && "wfocus", fork].filter(Boolean).join(" ") : "";
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

/**
 * Annotations whose words are not in the copy at hand: kept, shown at the top of their section (or
 * of the article), with their words; on Wikipedia, with the revision they were made on. A web page
 * keeps no old copies, so its notes say only that the words are gone; on a page that cannot be
 * shown (`src` null) every note is listed so, none lost.
 */
export function Detached({ ids, src }: { ids: NodeId[]; src: Source | null }) {
  if (!ids.length) return null;
  const snap = store.snap;
  return (
    <div class="wdetached">
      {ids.map((id) => {
        const w = snap.nodes[id].wanchor!;
        return (
          <span key={id} class={`inset detached${store.focus.node === id && !store.aux ? " focused" : ""}`} data-node={id}>
            <span class="meta">
              {src?.kind === "wiki" ? (
                <>
                  detached: “{clip(w.q, 90)}” is not in this revision ·{" "}
                  <a href={revisionUrl(src.article.title, w.rev, src.lang)} target="_blank" rel="noopener noreferrer">
                    the words in revision {w.rev}
                  </a>
                </>
              ) : src ? (
                <>detached: “{clip(w.q, 90)}” is not in the page as it now reads</>
              ) : (
                <>detached: “{clip(w.q, 90)}”, in a page not shown here</>
              )}
            </span>
            <NodeBody id={id} inline inNote />
          </span>
        );
      })}
    </div>
  );
}

/** The detached annotations of a section (the lead also takes those whose section is gone). */
export const detachedIn = (src: Source, sec: SecId) => store.annotations(src).detached.filter((d) => d.sec === sec).map((d) => d.id);

/** The W that marks Wikipedia's text, and the title. */
function Head({ title, sub, focused, mark }: { title: string; sub?: string; focused: boolean; mark?: string }) {
  return (
    <header class={`wiki-head${focused ? " focused" : ""}${mark ? ` ${mark}` : ""}`}>
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

export function Problem({ message }: { message: string }) {
  return <p class="wiki-problem">{message}</p>;
}

/** One article view. `host` says which (see Aux in store.ts); a pane passes its index. */
export function WikiView({ host, own, headFocused }: { host: string; own?: boolean; headFocused?: boolean }) {
  const tid = useContext(PaneCtx);
  const fork = useForkMark();
  const h = store.wikiHost(host);
  if (!h) return null;
  // Under a node, the article opened in a pane of its own (L) is marked at this head, where its curve starts.
  const mark = h.embedded ? fork?.(`w:${h.title}`) : undefined;
  const a = store.aux;
  const at = (row: WRow) => (row.t === "head" && !!headFocused) || (!!a && a.kind === "wiki" && a.host === host && !a.grain && sameAux(a, { kind: "wiki", host, row }));
  const embedded = h.embedded;
  // Its pane's own view (a section that is only a link, shown as its article), not an inset under a node's text.
  const inset = embedded && !own ? " embedded" : "";

  // Under a node, folded: its summary only, until l unfolds the article.
  if (store.folded(embedded)) {
    const sum = summary(h.title, h.lang);
    return (
      <section class={`wiki embedded folded${at({ t: "head" }) ? " focused" : ""}`} data-host={host}>
        <Head title={sum.state === "ready" ? sum.value.title : h.title} focused={at({ t: "head" })} mark={mark} />
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
    const have = known(h.title, h.lang);
    return (
      <section class={`wiki${inset}`} data-host={host}>
        <Head title={have?.title ?? h.title} focused={at({ t: "head" })} mark={mark} />
        {have && <p class="wiki-summary">{have.extract}</p>}
        {art.state === "loading" ? <p class="wiki-wait">Loading the article from Wikipedia…</p> : <Problem message={art.message} />}
        {have && <Attribution a={have.attribution} />}
        <Mentions title={h.title} lang={h.lang} show={!!h.mentions} at={at} />
      </section>
    );
  }
  const v = art.value;
  const src: Source = { kind: "wiki", article: v, lang: h.lang };
  const sec = h.sec ? v.sections.find((x) => x.id === h.sec) : undefined;
  // A section open as a pane to the right is marked: the picked child "showing", another fork "forked".
  const showing = (id: number): string | undefined => (store.panes ? store.kidMark(tid, (r) => r.kind === "wiki" && r.title === h.title && r.sec === id) : undefined);
  return (
    <section class={`wiki${inset}`} data-host={host}>
      <Head title={v.title} sub={sec?.heading} focused={at({ t: "head" })} mark={mark} />
      {art.stale && <p class="wiki-wait">Wikipedia could not be reached; this is the copy kept from before.</p>}
      <Detached ids={detachedIn(src, h.sec)} src={src} />
      <ArticleTextView host={host} row={{ t: "head" }} sec={h.sec} html={sec ? sec.html : v.lead} src={src} />
      {v.disambiguation && !sec && <Senses title={v.title} lang={h.lang} at={at} />}
      <Rows article={v} src={src} host={host} parent={h.sec} nested={!!h.nested} at={at} showing={showing} />
      <Mentions title={v.title} lang={h.lang} show={!!h.mentions} at={at} />
      <Attribution a={v.attribution} />
    </section>
  );
}

function Rows(props: { article: Article; src: Source; host: string; parent: number; nested: boolean; at: (r: WRow) => boolean; showing: (id: number) => string | undefined }) {
  const { article: v, src, host, parent, nested, at, showing } = props;
  const kids = sectionsUnder(v, parent);
  if (!kids.length) return null;
  return (
    <ul class={`wrows${parent ? " nested" : ""}`}>
      {kids.map((x) => {
        const row: WRow = { t: "sec", id: x.id };
        const open = nested && store.secOpen(host, x.id);
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
                <Detached ids={detachedIn(src, x.id)} src={src} />
                <ArticleTextView host={host} row={row} sec={x.id} html={x.html} src={src} />
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

/** "Mentioned in": the library's nodes that link to this article, which is what makes an article a hub between places in the library. */
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

/** What h returns to from the column's article page. */
export function backLabel(): string {
  const c = store.colWiki;
  if (!c) return "";
  if (c.stack.length) return c.stack[c.stack.length - 1].title;
  const n = store.snap.nodes[c.back.focus.node];
  return n ? n.title || "the text" : "the text";
}
