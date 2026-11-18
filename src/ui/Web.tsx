/**
 * A web page shown as an article view, the way Wiki.tsx shows a Wikipedia article: its lead is
 * its text, its sections are rows (in a pane a section opens as the next pane; on the column's page
 * it opens in place), its links are Tab stops (one to an article opens the article, in the link's
 * own language; one to another page opens that page), and its figures show through the server's
 * media route. It is never stored in the library: it comes from /api/page/article, read once by
 * the server and kept in its cache (server/page.ts).
 *
 * It takes the article views' structure and classes (`.wiki`, `.wiki-head`, `.wiki-text`, `.wrows`)
 * with a `.web` modifier: an amber ground and a ↗ at the head instead of Wikipedia's W, so it is
 * always clear whose text this is. Its head names the site, the title and who wrote it; its foot
 * says where it is from, when it was read and what was changed. A page that cannot be shown says
 * why in plain words and offers the original. Its text takes annotations as Wikipedia's does (the
 * same keys, the same notes, kept under the page's node in the library: src/core/article.ts); a
 * note whose words a newer copy lacks is listed as detached, and on a page that cannot be shown
 * every note is. What a model made of it at the reader's request (s) is marked as the model's: its
 * summary above the lead (the page's own opening still follows), a line when the sections are the
 * model's, and the foot.
 */
import { useContext } from "preact/hooks";
import { clip } from "../core/text";
import { PaneCtx, useForkMark } from "./Links";
import { sameAux, store, type SecId, type Source, type WRow } from "./store";
import { ArticleTextView, Detached, Problem, WikiPage, WikiView, backLabel, detachedIn } from "./Wiki";
import { article, attributionText, byline, cachedSummary, sectionsUnder, siteOf, webKey, type WebArticle, type WebProblem } from "./web";

/**
 * What an article view under a node is drawn as. `own`: the view is its pane's own (a section that
 * is only a link, shown as its article), not an inset under the node's text. `headFocused`: its
 * head is focused because the node is (that pane's head, as a node's pane has).
 */
export interface ViewOpts {
  own?: boolean;
  headFocused?: boolean;
}

/** Any article view by its host: a web page's, or Wikipedia's. */
export function ArticleView({ host, ...o }: { host: string } & ViewOpts) {
  return store.isWeb(host) ? <WebView host={host} {...o} /> : <WikiView host={host} {...o} />;
}

/** The column's article page, Wikipedia's or a web page's. */
export function ArticlePage() {
  if (!store.colWiki?.url) return <WikiPage />;
  return (
    <article class="wiki-page web">
      <WebView host="col" />
      <p class="wiki-back">h at the top, or Back, returns to “{clip(backLabel(), 40)}”.</p>
    </article>
  );
}

/** A piece of the page's text (the lead or a section), with its detached notes above it: as an article's is, with its annotations. */
function WebText({ host, row, sec, html, src }: { host: string; row: WRow; sec: SecId; html: string; src: Source }) {
  return (
    <>
      <Detached ids={detachedIn(src, sec)} src={src} />
      <ArticleTextView host={host} row={row} sec={sec} html={html} src={src} />
    </>
  );
}

/** The ↗ and the site that mark a web page's text, its title, and its byline (author · site · date, only what the page gives). */
function Head({ url, title, sub, line, focused, mark }: { url: string; title: string; sub?: string; line?: string; focused: boolean; mark?: string }) {
  return (
    <header class={`wiki-head${focused ? " focused" : ""}${mark ? ` ${mark}` : ""}`}>
      <div class="wiki-brand">
        <span class="wmark umark">↗</span> {siteOf(url)}
      </div>
      <h2>
        {title}
        {sub && <span class="wsub"> › {sub}</span>}
      </h2>
      {line && <p class="web-byline">{line}</p>}
    </header>
  );
}

/** The line every view of a page's text ends with: where it is from, who wrote it, when it was read, what was changed, and the original. */
function Attribution({ a }: { a: WebArticle["attribution"] }) {
  return (
    <p class="wattr">
      {attributionText(a)}{" "}
      <a href={a.url} target="_blank" rel="noopener noreferrer">the original</a>
    </p>
  );
}

/** The summary a model wrote of the page, set apart and labelled so it is never taken for the page's own words. */
function ModelSummary({ m }: { m: NonNullable<WebArticle["model"]> }) {
  return (
    <aside class="web-model" data-model-summary>
      <p class="web-model-label">Summary written by a model{m.by ? ` (${m.by})` : ""} from the page's openings, at your request; not the author's words</p>
      <p class="web-model-text">{m.summary}</p>
      {m.note && <p class="web-model-label">{m.note}</p>}
    </aside>
  );
}

/** A page that is not shown: what is known of it, why, and the original in a new tab. */
function Unusable({ url, p }: { url: string; p: WebProblem }) {
  return (
    <>
      {p.description && <p class="wiki-desc">{p.description}</p>}
      <Problem message={p.message} />
      <p class="web-open">
        <a href={url} target="_blank" rel="noopener noreferrer" data-original>
          Open in a new tab
        </a>{" "}
        · W does the same
      </p>
    </>
  );
}

/** The title a page goes by before it has arrived: the link's own, else its site. */
function knownTitle(host: string, url: string): string {
  const h = store.viewHost(host);
  const r = h?.embedded ? store.targetOf(h.embedded) : undefined;
  if (r?.kind === "url" && r.title) return r.title;
  if (host === "col" && store.colWiki?.url === url && store.colWiki.title !== siteOf(url)) return store.colWiki.title;
  return siteOf(url);
}

/** One web page's view. `host` says which (see Aux in store.ts). */
export function WebView({ host, own, headFocused }: { host: string } & ViewOpts) {
  const tid = useContext(PaneCtx);
  const fork = useForkMark();
  const h = store.viewHost(host);
  if (h?.src !== "web") return null;
  // Under a node, the page opened in a pane of its own (L) is marked at this head, where its curve starts.
  const mark = h.embedded ? fork?.(webKey(h.url)) : undefined;
  const a = store.aux;
  const at = (row: WRow) => (row.t === "head" && !!headFocused) || (!!a && a.kind === "wiki" && a.host === host && !a.grain && sameAux(a, { kind: "wiki", host, row }));
  const cls = `wiki web${h.embedded && !own ? " embedded" : ""}`;

  // Under a section, folded: what the server's cache knows of it (never a request to the site), until l opens it.
  if (store.folded(h.embedded)) {
    const sum = cachedSummary(h.url);
    const s = sum.state === "ready" ? sum.value : null;
    return (
      <section class={`${cls} folded${at({ t: "head" }) ? " focused" : ""}`} data-host={host}>
        <Head url={h.url} title={s?.title ?? knownTitle(host, h.url)} line={s ? byline(s) : undefined} focused={at({ t: "head" })} mark={mark} />
        {s?.description && <p class="wiki-summary">{s.description}</p>}
        <p class="wiki-more">l reads the page here · L opens it in a pane of its own · W the original</p>
      </section>
    );
  }

  const art = article(h.url);
  if (art.state === "loading") {
    return (
      <section class={cls} data-host={host}>
        <Head url={h.url} title={knownTitle(host, h.url)} focused={at({ t: "head" })} mark={mark} />
        <p class="wiki-wait">Reading the page…</p>
      </section>
    );
  }
  if (art.state === "failed") {
    return (
      <section class={`${cls} unusable`} data-host={host} data-reason={art.reason}>
        <Head url={h.url} title={art.title ?? knownTitle(host, h.url)} line={art.site && art.site !== siteOf(h.url) ? art.site : undefined} focused={at({ t: "head" })} mark={mark} />
        <Unusable url={h.url} p={art} />
        <Detached ids={store.pageNotes(h.url)} src={null} />
      </section>
    );
  }
  const v = art.value;
  const src: Source = { kind: "web", page: v, url: h.url };
  const at0 = v.attribution;
  const sec = h.sec !== null ? v.sections.find((x) => x.id === h.sec) : undefined;
  const line = byline({ author: at0.author, site: at0.site, published: at0.published });
  // A section the page no longer has: its pane is closed as the page arrives (store.livePane); never the lead in its place.
  if (h.sec !== null && !sec) {
    return (
      <section class={cls} data-host={host}>
        <Head url={h.url} title={v.title} line={line} focused={at({ t: "head" })} mark={mark} />
        <Problem message="This section is no longer in the page." />
      </section>
    );
  }
  // A section open as a pane to the right is marked: the picked child "showing", another fork "forked".
  const showing = (id: string): string | undefined => (store.panes ? store.kidMark(tid, (r) => r.kind === "web" && r.sec === id && webKey(r.url) === webKey(h.url)) : undefined);
  return (
    <section class={cls} data-host={host} data-outline={v.outline}>
      <Head url={h.url} title={v.title} sub={sec?.heading} line={line} focused={at({ t: "head" })} mark={mark} />
      {at0.stale && <p class="wiki-wait">The page no longer answers; this is the copy read before. R tries again.</p>}
      {!sec && v.model?.summary && <ModelSummary m={v.model} />}
      {sec || v.lead ? <WebText host={host} row={{ t: "head" }} sec={h.sec} html={sec ? sec.html : v.lead} src={src} /> : <Detached ids={detachedIn(src, null)} src={src} />}
      {!sec && v.outline === "model" && <p class="web-model-label web-arranged">Sections arranged by a model at your request; the page has no headings of its own.</p>}
      <Rows article={v} src={src} host={host} parent={h.sec} nested={!!h.nested} at={at} showing={showing} />
      <Attribution a={at0} />
    </section>
  );
}

function Rows(props: { article: WebArticle; src: Source; host: string; parent: string | null; nested: boolean; at: (r: WRow) => boolean; showing: (id: string) => string | undefined }) {
  const { article: v, src, host, parent, nested, at, showing } = props;
  const kids = sectionsUnder(v, parent);
  if (!kids.length) return null;
  return (
    <ul class={`wrows${parent ? " nested" : ""}`}>
      {kids.map((x) => {
        const row: WRow = { t: "sec", id: x.id };
        const open = nested && store.secOpen(host, x.id);
        const leaf = !sectionsUnder(v, x.id).length;
        const mark = showing(x.id);
        return (
          <li key={x.id} class={`wrow${at(row) ? " focused" : ""}${open ? " open" : ""}${mark ? ` ${mark}` : ""}`}>
            <div class="row" data-wrow={x.id}>
              <span class="mark">{open ? "▾" : leaf && !x.html ? "·" : "▸"}</span>
              <span class="title">{x.heading}</span>
            </div>
            {open && (
              <div class="content">
                <WebText host={host} row={row} sec={x.id} html={x.html} src={src} />
                <Rows {...props} parent={x.id} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
