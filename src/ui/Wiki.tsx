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
import { useLayoutEffect, useRef } from "preact/hooks";
import { clip } from "../core/text";
import { Attribution, Backlinks } from "./Links";
import { sameAux, store, type WRow } from "./store";
import { article, cleanHtml, known, sectionsUnder, sensesOf, summary, type Article } from "./wiki";

/**
 * Article HTML, cleaned twice (server and here) and put into the page. The focused link, when Tab
 * has picked one, is marked here rather than in the HTML, which never changes once set.
 */
function WikiText({ html, link }: { html: string; link?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.querySelectorAll("a.wfocus").forEach((a) => a.classList.remove("wfocus"));
    if (link === undefined) return;
    const a = el.querySelectorAll("a[data-wiki]")[link];
    if (a) {
      a.classList.add("wfocus");
      (a as HTMLElement).scrollIntoView?.({ block: "nearest" });
    }
  });
  return <div class="wiki-text" ref={ref} dangerouslySetInnerHTML={{ __html: cleanHtml(html) }} />;
}

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
  const h = store.wikiHost(host);
  if (!h) return null;
  const a = store.aux;
  const at = (row: WRow) => !!a && a.kind === "wiki" && a.host === host && sameAux({ ...a, link: undefined }, { kind: "wiki", host, row });
  const linkAt = (row: WRow) => (at(row) && a?.kind === "wiki" ? a.link : undefined);
  const embedded = h.embedded;

  // Under a node, folded: its summary only, until l unfolds the article.
  if (embedded && !store.expanded.has(embedded)) {
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
  const showing = (id: number) => {
    const i = host.startsWith("p") ? +host.slice(1) : store.paneAt;
    const next = store.trail[i + 1];
    return !!store.panes && next?.kind === "wiki" && next.title === h.title && next.sec === id;
  };
  return (
    <section class={`wiki${embedded ? " embedded" : ""}`} data-host={host}>
      <Head title={v.title} sub={sec?.heading} focused={at({ t: "head" })} />
      {art.stale && <p class="wiki-wait">Wikipedia could not be reached; this is the copy kept from before.</p>}
      <WikiText html={sec ? sec.html : v.lead} link={linkAt({ t: "head" })} />
      {v.disambiguation && !sec && <Senses title={v.title} lang={h.lang} at={at} />}
      <Rows article={v} parent={h.sec} nested={!!h.nested} at={at} linkAt={linkAt} showing={showing} />
      <Mentions title={v.title} lang={h.lang} show={!!h.mentions} at={at} />
      <Attribution a={v.attribution} />
    </section>
  );
}

function Rows(props: { article: Article; parent: number; nested: boolean; at: (r: WRow) => boolean; linkAt: (r: WRow) => number | undefined; showing: (id: number) => boolean }) {
  const { article: v, parent, nested, at, linkAt, showing } = props;
  const kids = sectionsUnder(v, parent);
  if (!kids.length) return null;
  return (
    <ul class={`wrows${parent ? " nested" : ""}`}>
      {kids.map((x) => {
        const row: WRow = { t: "sec", id: x.id };
        const open = nested && store.colOpen.has(x.id);
        const leaf = !sectionsUnder(v, x.id).length;
        return (
          <li key={x.id} class={`wrow${at(row) ? " focused" : ""}${open ? " open" : ""}${showing(x.id) ? " showing" : ""}`}>
            <div class="row" data-wrow={x.id}>
              <span class="mark">{open ? "▾" : leaf && !x.html ? "·" : "▸"}</span>
              <span class="title">{x.heading}</span>
              {x.number && <span class="wnum">{x.number}</span>}
            </div>
            {open && (
              <div class="content">
                <WikiText html={x.html} link={linkAt(row)} />
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
