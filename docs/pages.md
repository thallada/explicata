# Web pages

The findings and decisions behind `server/pageFetch.ts`, `server/pageHtml.ts`, `server/page.ts`
and `server/pageRoutes.ts`: how a node whose target is a web address (`Ref { kind: "url" }`) gets
its page read, split into a lead and sections, and shown like a Wikipedia article (§9 is the
browser's side: `src/ui/web.ts` and `src/ui/Web.tsx`; §10 is arranging a page with a model,
`server/pageArrange.ts`; §12 is notes on a page's words). The survey in §1 was made while planning,
once per page, with the same honest User-Agent the server sends.

## 1. What real pages look like

Seventeen pages, chosen to cover the kinds of page a reader links to, each fetched once with
`Explicata/0.1 (personal reading tool)`:

| # | kind | host | status | words | sections | author via | date | verdict |
|---|---|---|---|---|---|---|---|---|
| 1 | sectioned blog | jvns.ca | 200 | 2,409 | 20 h3 | meta author | `<time>` | headings |
| 2 | headingless essay | paulgraham.com | 200 | 12,316 | none, `<br><br>` | none | text only | model organise |
| 3 | Substack | astralcodexten.com | 200 | 6,547 | `<p>I.</p>`… | JSON-LD + meta | JSON-LD | pseudo-headings |
| 4 | Medium | medium.com | 403 | – | – | – | – | refused (Cloudflare) |
| 5 | news | theguardian.com | 200 | 36 | – | – | – | refused (challenge body) |
| 6 | news | nytimes.com | 403 | – | – | – | – | refused (DataDome) |
| 7 | docs | developer.mozilla.org | 200 | 603 | 10 h2 | none | modified only | headings |
| 8 | GitHub repo | github.com | 200 | 74 | UI only | none | none | link out (short) |
| 9 | arXiv abstract | arxiv.org | 200 | 715 | UI only | citation_author | citation_date | misfire |
| 10 | JS app | bsky.app | 200 | 0 | – | – | – | link out (needs JS) |
| 11 | PDF | bitcoin.org | 200 | – | – | – | – | link out (PDF) |
| 12 | long spec | html.spec.whatwg.org | 200 | 49,948 | h3-h6 | none | none | headings, no model |
| 13 | French | fr.wikipedia.org | 200 | 32,001 | 9 h2, 40 h3 | collective | JSON-LD | headings, no model |
| 14 | Q&A | stackoverflow.com | robots disallow | – | – | – | – | refused |
| 15 | forum | news.ycombinator.com | 200 | 5,150 | none | user link | span title | misfire |
| 16 | WordPress | joelonsoftware.com | 200 | 3,675 | `<strong>N.` | byline class | meta | pseudo-headings |
| 17 | hand-written | norvig.com | 200 | 2,753 | 9 h2 | layout only → none | none | headings |

("model organise": such a page is split by length, and a model arranges it, by itself once and at the reader's request, §10.)

What the table says:

- **12 of 17 returned real content.** Four were refused, one of them with **HTTP 200** and a
  "Client Challenge" page in place of the article (Guardian). One was a PDF.
- Of the 12, six have three or more usable h2–h6 sections, two more open their sections with
  pseudo-headings (`<p>I.</p>`, `<p><strong>1. …</strong></p>`), one (12,000 words in `<br><br>`
  paragraphs, no metadata at all) has nothing to split at, and three are not articles (a GitHub
  repository page of 74 words, a Hacker News thread, an arXiv abstract page).
- **A named person as author in structured metadata: 3 of 12.** A byline class only: 1. Layout only:
  2. None, or an organisation: 5. `Last-Modified` was never the date the text was written.
- Lengths: median about 3,200 words; three pages over 12,000 (12k, 32k, 50k; 50k words is about
  67k tokens).
- **Regexes for challenge words over the whole HTML misclassify**: Substack, MDN and GitHub carry
  "captcha", "paywall" or "enable JavaScript" in scripts and `<noscript>`. So do text-to-markup
  ratios. Challenge markers are therefore matched on headers and the `<title>` only.

The test fixtures (`server/pageMock.ts`) imitate one page of each shape. They are written for the
purpose: no third-party page is committed.

## 2. Storage

Page text is never stored in a library. Only the `Ref` is, as today. The text lives in a server
disk cache, `<EX_DATA>/page-cache/<sha1(normUrl(url))>.json`, beside an `index.json` of when each
snapshot was last read and which images it shows, and in the browser's memory. Reasons: someone
else's text is not replicated to other replicas or exported in `.md`; undo and merge are not
affected; Wikipedia already works this way.

- **A snapshot is kept until the reader asks for it again** (Reload, `R`). There is no timed
  refetch: pages have no revisions, and a silent re-read would re-split the text and move section
  ids under open panes.
- `hash` is a hash of the extracted text units, not of the HTML, so a page whose scripts or ads
  change reads as unchanged. What a model made of a page (§10) is kept in its snapshot with the
  hash it was made for, beside the outline made without a model, and is laid over the page only
  while the hash is the same.
- A Reload that fails (a 404, a refusal, no answer) keeps the old snapshot and marks it `stale`:
  the foot then reads "the page no longer answers; last read <date>". A Reload whose text is
  unchanged keeps what the model made of it. A page remembered as unusable is asked again at once
  by Reload (robots.txt is still the one kept for the day).
- The snapshot also keeps the units of the lead and sections (the opening 400 characters of each,
  and, for a page divided by length, each unit's HTML), so that a model can arrange the page
  without it being read again.
- At most 500 snapshots; the least recently read goes first.
- A page that cannot be shown (robots, refused, not a page, too little text, too large) is
  remembered for a day, so that opening it again does not ask the site again at once. An
  unreachable site or a 5xx is not remembered at all. These are not snapshots: they have no
  sections whose ids could move.

`normUrl` (src/llm/web.ts) is the comparison the research guard already uses: no fragment, no
trailing slash on a bare path.

## 3. Fetching (server/pageFetch.ts)

One small module, not the Wikipedia `RequestQueue`, which is shaped by Wikimedia's rules (maxlag,
priorities, a single host).

- **http and https only, default ports only, no credentials, URLs of 2,000 characters at most.**
- **The address guard is the existing `publicUrl`** (server/subscription.ts), applied to the
  address asked and to every redirect hop. Redirects are followed by hand, at most 5. The server
  only ever listens on the owner's localhost, so this host-string check is the whole guard for
  now; §8 says what would have to change otherwise. `publicUrl` sees the address after the URL
  parser has normalised it, so `http://2130706433/` and `http://0x7f.1/` arrive as `127.0.0.1`
  and are refused; IPv6 literals are refused outright.
- **15 s for the whole read, 5 MB of decoded body** (10 MB for an image), counted while the body
  streams in and cancelled at the cap. `fetch` undoes gzip and br itself, so what is counted is
  what was decoded: a small gzip bomb stops at 5 MB. A declared `content-length` over the cap is
  refused before reading.
- **Content types**: `text/html`, `application/xhtml+xml`, `text/plain` for a page; `image/*` for
  the media route. No content-type at all: an HTML doctype at the start of the body counts as a
  page. Charset: the header's, else a `<meta>` one in the first 2 KB, else UTF-8.
- **User-Agent `Explicata/0.1 (personal reading tool)`**, never browser-like and never naming the
  owner. **A refusal is final**: nothing is retried with another User-Agent or anything else changed.
- **robots.txt is honoured**, because page text may later be sent to a model. It is read once per
  host and kept a day, and judged by its body whatever the status (a 418 with `Disallow: /`
  disallows; this is what Stack Overflow does). The group naming `Explicata` is used if there is
  one, else the `*` group (RFC 9309: a specific group replaces `*`, it does not add to it); the
  longest matching rule wins, `Allow` on a tie, with `*` and `$` patterns. A robots.txt that
  cannot be read (network error, 404, a 5xx with no rules in it) allows; a network error is not
  remembered, so robots.txt is asked again on the next read.
- **Politeness**: requests to one host start at least 1 s apart (robots.txt included); one URL is
  read once however many callers ask at the same time. A caller that goes away stops waiting, and
  the read goes on for the others and for the cache.
- **Only addresses a person opened are read.** Nothing follows the links in a page, and nothing is
  read ahead.
- `fetch` is injected, as in `WikiClient`, so the tests and the mock never touch the network.

## 4. Extraction (server/pageHtml.ts, parse5 only)

**Unusable pages** link out with a plain reason: `robots`; `refused` (any non-2xx 4xx answer,
`cf-mitigated: challenge`, `server: DataDome` or `x-datadome`, or a `<title>` that is exactly
"Just a moment..." or "Client Challenge"); `type` (a PDF, an image); `empty` (under 150 words in the
container, which also catches JavaScript shells); `too-large`; `offline` (no answer, or none in 15
s); `error` (a 5xx or 429, or something unexpected). An address the guard refuses is `refused`
too, with its own message. An unusable answer still carries whatever title, description and site
were found.

**Metadata**, each from the first source that has it:

| field | sources, in order |
|---|---|
| title | `og:title`, `<title>`, the first `<h1>`; else the host |
| site | `og:site_name`, the host |
| author | JSON-LD `Article`/`NewsArticle`/`BlogPosting` `author.name` (people only; an `@id` reference is followed; several are joined with commas), `<meta name=author>`, `citation_author` (all of them), then inside the container `[rel=author]`, `.author .fn`, `[itemprop=author]` |
| published | JSON-LD `datePublished`, `article:published_time`, `citation_date`, the first `<time datetime>` in the container |
| description | `og:description`, `<meta name=description>`, JSON-LD `description` |
| canonical | `<link rel=canonical>` |

Never from `Last-Modified`, never from a model, never guessed from layout. Absent means absent. A
date is kept as the page gives it when it is ISO 8601; `2017/06/12` becomes `2017-06-12`.

**Container**: the largest `<article>` with 50 words or more, else `<main>` or `[role=main]`, else
`<body>`. Out of it go `nav`, `aside`, `header`, `footer`, `form` (unless a form holds 150 words or
more: an ASP.NET page is one `<form>`), the matching ARIA roles, hidden
elements (`hidden`, `aria-hidden=true`, `display:none`), and blocks whose class or id names
comments, sharing, related posts, a sidebar or a newsletter, unless that block holds more than half
the text (a wrapper called `has-sidebar` is layout, not junk). The byline and `<time>` are looked
for before this, because they usually sit in the article's own `<header>`.

**Units.** The container is flattened into units: paragraphs, lists, tables, `pre`, figures,
quotations, headings, and embeds. Runs of two or more `<br>` become paragraph breaks first (a
headingless essay is otherwise one paragraph); a single `<br>` stays. An inline element that holds
such a run (paulgraham.com's `<font>`) is walked into. Images are lifted out of paragraphs into
figures of their own, after the paragraph, or before it if the image came first; a `<p>` may not
hold a `<figure>`. A table is kept as a table when it holds data, and walked through when it is
layout (it holds another table, block elements, `<br><br>`, or a cell of over 80 words).

**Sanitising** uses the allowlist emitter of `server/wikiHtml.ts`, parameterised by an
`HtmlPolicy`, not a fork: when web pages were added Wikipedia's policy was the old behaviour byte
for byte (it has since kept pictures: docs/wikipedia.md §3), and the web policy differs only in
its hooks:

- links resolve against the address the page was read from (never a `<base>`), http(s) only, and
  are emitted as `<a data-url="…" href="…" target="_blank" rel="noopener noreferrer">`; a link to
  `*.wikipedia.org/wiki/Title` (mobile hosts included) becomes the existing `data-wiki` form, with
  `data-wiki-lang` taken from the host;
- `pre`/`code`, lists, quotations and tables are kept; no class is junk by name;
- images become `<figure><img src="/api/page/media?u=…" alt width height loading="lazy"
  decoding="async" data-full="<original>"><figcaption>…</figcaption></figure>`. The source is
  `src`, else `data-src` / `data-lazy-src`, else the largest `srcset` candidate up to 1600w (else
  the smallest), else a `<picture>`'s `<source srcset>`. The caption is the `figcaption`, else
  `alt`. Dropped: images declared 2 px or smaller, `data:` URIs, inline `<svg>`;
- scripts, styles, iframes, forms, `on*` and `style` attributes never survive. A video is a
  click-to-play facade (§11); any other `<iframe>`, or a `<video>` with no https source, becomes a
  link "Embedded content from <host> ↗" to its source.

**Sections**, from the first rule that fits. Ids are strings namespaced by the rule, so an id from
one outline never names a section of another:

1. **Headings** (`h1`, `h2`, …). L is the shallowest of h2–h6 used at least twice; shallower
   headings count as L, deeper ones nest under the one before (the level stack of
   `splitArticle`). An `h1` before any other heading is the page's title, not a section.
2. **Pseudo-headings** (`p1`, …): a paragraph that is only a roman or arabic numeral ("II.", "3"),
   else one that is wholly `<strong>`/`<b>` and under 80 characters.
3. **Parts by length** (`c1`, …): about 600 words each, cut at unit boundaries (the last part is
   never under 300 words), each titled by its first eight words and "…". An opening paragraph of 40
   words or more leads, with whatever short lines come before it (a title, a date).
4. **None**: under 600 words, the whole text is the lead.

Rules 1 and 2 need three sections at the top level that are not junk, each of 40 words or more,
together covering half the container's words. Junk sections are dropped with what is under them
and listed (`dropped` in the snapshot, and "sections left out: …" in `attribution.adapted`). A
heading is junk when, lower-cased and without numbers or punctuation ("12 Comments" is
"comments"), it is one of a small bilingual list, matched whole so that "Notes on the design" is
not junk: see also / voir aussi, references / références, notes (and notes and references / notes
et références), footnotes, comments / commentaires, responses, leave a reply, related (posts,
articles, stories), read more / lire aussi, subscribe, share (this), partager, contents / table of
contents / sommaire, in this article / dans cet article, external links / liens externes, further
reading, bibliography / bibliographie.

**Lead**: the units before the first section, when they come to 40 words or more
(`leadFrom: "intro"`). Otherwise the page's description goes first, and the short intro after it
(`"page-description"`), so that no unit is left out; with neither, `"none"`.

**The invariant** (tests/pageHtml.test.ts, on every fixture and on random documents): every unit
appears exactly once, in order, across the lead and the sections; heading and pseudo-heading units
become section titles, the page's `h1` its title, and junk sections are the one listed exception.

## 5. Routes

`server/pageRoutes.ts`, in the manner of `server/wikiRoutes.ts`:

| | |
|---|---|
| `GET /api/page/article?url=…` | 200 `{ ok, cached, article: WebArticle }` |
| `GET /api/page/summary?url=…[&cached=1]` | 200 `{ ok, cached, summary: WebSummary }`: title, site, author, date, description and the lead's first sentence; `cached=1` never reads the page (404 `uncached`) |
| `GET /api/page/media?u=…` | the image, if a kept snapshot shows it (a picture, or a video's still: its poster, YouTube's thumbnail): `image/*` only, 10 MB, `cache-control: private, max-age=604800`, `content-security-policy: sandbox`, `x-content-type-options: nosniff`; 404 for any address no snapshot shows (it is not an open proxy), 415 for something that is not an image |
| `POST /api/page/reload` `{ url }` | the page read again: 200 `{ ok, article }`, or the last copy with `stale: <why>` when it no longer answers; a page never shown that still cannot be is a 422 or 503 `WebUnusable` |
| `POST /api/page/arrange` `{ url, auto? }` | §10: 200 `{ ok, article, called, arranged: "sections" \| "summary", note? }`; refused with `{ ok: false, reason, message }`: 404 `uncached`, 409 `old` (a copy read before arranging existed), 422 `too-long`, 429 `budget` or `plan`, 502 `failed`, 503 `no-model` or `off`. With `auto: true` it only waits for an arrangement by itself under way (§10), answering with what it came to (409 `idle`: none under way), and never makes a call |

A page that cannot be shown is a 422 with the `WebUnusable` body; an unreachable or failing site
503. `EX_PAGES=off` answers every route with 503 `reason: "off"`; `/api/state` says
`pages: { mode }`. The types are exported from `server/page.ts` for the browser.

**Cross-site requests are refused** (403): a `Sec-Fetch-Site` other than `same-origin` or `none`,
or an `Origin` whose host is not the request's own `Host`. A request with neither header (curl,
the tests) is allowed. The app's CSP keeps `img-src 'self' data: blob:`: images come from the
app's own origin through the media route (the CSP's two additions for videos are in §11). The two routes that act, `reload` (it reads a
site) and `arrange` (it spends model budget), are POST only; the others GET only.

## 6. Known misfires, and what is left out

Known misfires, accepted: an **arXiv abstract page** is split at its interface's headings; a
**Hacker News thread** reads as a headingless article and is split by length; a **short GitHub
README** (74 words on the repository page) links out as too short.

Deliberately left out: a headless browser for pages that need JavaScript; PDF parsing; per-site
adapters (arXiv, GitHub, HN, Reddit); login or paywall handling; backlinks to web pages ("Mentioned
in" is Wikipedia's only); automatic refresh. Video and Wikipedia's pictures came later (§11;
docs/wikipedia.md §3), and so did notes on a page's words (§12).

## 7. Mock

`EX_PAGES=mock` (the browser tests, playwright.config.ts) serves the fixtures in
`server/pageMock.ts` through the real fetcher and extractor, with no spacing and nothing written to
disk. `MOCK_PAGES` lists their addresses; each is named for the shape it imitates (§1), and one,
`vanishing`, answers once and then 410, for a Reload that finds a page gone. With `EX_LLM=mock` the
mock model arranges a page into three sections, sending them out of order, with a repeat and a
number past the end, so that the cleaning in §10 is exercised every time. Two headingless fixtures
are there for arranging by itself: `drift`, whose title says "mockfail", which the mock model fails
on, and `slow`, whose title says "mockslow", over which it takes 1.5 s.

## 8. If the server is ever reachable by others

The guard above is enough for a server that only its owner can reach on localhost. Before it is
reachable by anyone else:

- **Resolve and pin DNS before connecting**: look the host up, check every address, and connect to
  the checked address (a `lookup` passed to `node:http(s)`), so that a name cannot resolve to a
  public address for the check and a private one for the connection.
- **Block by address, not by name**, with `net.BlockList`: loopback, private (10/8, 172.16/12,
  192.168/16), link-local (169.254/16, fe80::/10), CGNAT (100.64/10), unique local (fc00::/7),
  NAT64 (64:ff9b::/96), 6to4 (2002::/16), IPv4-mapped IPv6, multicast and unspecified.
- **Check IP-literal hosts before connecting**, in every notation the URL parser accepts.
- **Per-user budgets** for fetches and for model calls, not one for the server.
- **Revisit which `Host` values server/index.ts accepts** (it allows `*.ts.net` and `EX_HOSTS`), since
  the Origin check compares against `Host`.

## 9. In the browser (src/ui/web.ts, src/ui/Web.tsx)

A web page is a third kind of pane, `{ kind: "web", url, sec? }` beside a node's and an article's,
keyed `u:<normUrl(url)>#<sec>` (the section ids are the server's strings: `h3`, `p2`, `c1`). The
seam is the article view's host, not the pane: an aux focus names a view (`p<i>`, `f<id>`, `n<id>`,
`col`), and `Store.viewHost` says what it shows, a Wikipedia article or a web page. Everything that
walks a view (rows, j k h l, Tab, i, Enter, notes on its words, forks and curves, the panes'
history, reload) goes through it; what only Wikipedia's allows (senses, "Mentioned in") asks
`Store.wikiHost`, which is null for a page. The view reuses the article view's structure and classes (`.wiki`, `.wiki-head`,
`.wiki-text`, `.wrows`) with a `.web` modifier, which swaps Wikipedia's ground and rule tokens for
`--web-bg` and `--web-rule` (amber).

- **Opening.** Following a `url` target opens the page in the next pane, or in the column as a page
  of its own at `/l/<library>/u/<encodeURIComponent(url)>`; h or Back returns. An address that is a
  Wikipedia article (`https://fr.m.wikipedia.org/wiki/Phare`) opens as that article, here and in
  the link picker (`wikiRefOf` in src/core/ref.ts). W opens the original in a new tab, as it opens
  an article on wikipedia.org. A node whose own target is a page shows it under its text where an
  article would be shown; under a section with text or sections of its own it is folded and asks
  only `summary?cached=1`, so the site is read only when the reader unfolds (l) or opens (L) it. L
  opens it to the right of the section's own pane when that pane is open, from its head or from its
  row in the pane before, never beside that pane in its column.
- **A section that is only a link** (a page or an article as its target, no text and no sections
  of its own: `linkOnly` in src/core/model.ts, `Store.linkOnly`) is shown as its target, at once,
  since there is nothing of its own to read first. In panes its pane stays the node's (host
  `n<id>`, so the trail, the focus, its row's commands and the saved view are unchanged) but reads
  as the page's own pane: one head, the page's (↗, site, title, byline), its lead, its sections as
  rows opening to the right, its foot, the whole pane on the page's ground (`.link-pane`, amber for
  a page, Wikipedia's ground for an article). On that head the page's keys work as in its own pane
  (W, R, s, i, Tab), and the keys that act on a node (r, w, D, a, c, e, J K, > <, p, M, z…) act on
  the section; the head's menu has both. h from the head goes back to the section's row. In the
  column its row, opened, shows the page under it, its sections opening in place. Given text (c),
  a section (a) or text written for it (e), it is a section like any other again: its text, then
  the page folded under it.
- **The view.** Head: ↗ and the host, the title, and a byline of author, site and date (read as
  "9 Aug 2000"), only those the page gives. Foot: "From “Title” by Author, site, published D. Read D.
  Adapted: …" with the original; for a stale copy, "the page no longer answers; last read D". A
  page that cannot be shown keeps its head (its own title when it gave one), shows its description
  and the server's reason, and offers the original in a new tab.
- **Text.** Cleaned a second time with the article cleaner in its `web` mode: `data-url` links (a
  pane of their own, and Tab stops like article links), `data-wiki` links in their own language
  (`data-wiki-lang`), and figures: `figure`, `figcaption` and an `img` with a fixed set of
  attributes, kept only when its `src` is the media route; a video's facade with its checked data
  attributes (§11). A figure's caption is text like a paragraph's; a click on the image opens
  `data-full` in a new tab. Links in Wikipedia's own text
  are cleaned and followed exactly as before.
- **A section that is gone.** A pane on a section id the page no longer has is closed when the page
  arrives (`Store.livePane`), never shown as the lead in its place.
- **Reload** (`R`, or "Read it again" in the page's menu) asks `POST /api/page/reload` and puts the
  answer in place of the page kept in the browser; panes on sections the new copy does not have
  close as above, and the status line says how many. The foot's "no longer answers" is true when it
  is shown: the server sets `stale` only when a Reload failed.
- **A link's card** (a hover, Tab onto linked words, the column's preview) shows the page's title,
  site, author, date and first sentence from what the server has kept (`summary?cached=1`), and only
  the host and address for a page never read: a card never makes the site be read.
- **The link picker's "Address"** for a bare address reads the page's title then, as part of the
  reader's choice (2.5 s at most, the picker saying so meanwhile, Esc leaving the words unlinked), and
  keeps it in `Ref.title` in the same commit as the link; a page that is slow or cannot be read is
  linked without one. A title is never written because a page was opened.
- **An address typed into a node's text** (`src/core/bareLinks.ts`, `Store.typedAddresses`) is
  turned into a titled link once the edit is finished, never while typing, in three steps that are
  each one commit, so `u` takes each back on its own:
  1. Each bare `http(s)` address new in this edit (not in the text before it; not inside a code span
     or words already linked; not a phrase declined in the node's `nolink`; trailing `.,;:!?…` and
     an unbalanced `)` or `]` left out; a host with a dot) is linked as typed, all in one commit, as
     selecting it and `w` would: a Wikipedia article's address to the article (`wikiRefOf`), any
     other to the page. A section whose whole text is one address, with no target and no sections,
     instead becomes a section that is only that link (its text cleared, `linkOnly`), so it opens
     straight as the page.
  2. Each page is read for its title (`GET /api/page/summary`, up to 20 s; at most five pages from
     one edit, the rest staying linked as typed, and the status line says so); an article's title
     is in its address. Reading the page also starts arranging it by itself (§10), so the link opens
     at once, already arranged.
  3. The address in the text is replaced by the title, with the link's anchor (and `Ref.title`), as
     the address out then the title in, so undo puts the link back on the address. Only while those
     words are still the whole address as typed and the link still goes there: a concurrent edit of
     them, here or merged from another replica, drops the step. A title that arrives while the node's
     text is being edited again waits for that edit to finish. For a section made a link, its title
     is set to the page's only while it is empty or a placeholder; a title of its own is kept.

  `u` after step 3 brings the address back, still linked; a later edit finds it in the text before
  it, so it is never converted again. A page that cannot be read (robots, a refusal, offline, not a
  page, `EX_PAGES=off`) keeps its address, linked, and the status line says why, once. It is always
  on: unlike link suggestions it acts only on what the reader typed, and every step is undone like
  any edit.

## 10. Arranging with a model (server/pageArrange.ts)

A page with no headings is divided by length (§4), which is honest but blind. A model writes a
short summary of the page and, for a page divided by length, chooses where its sections begin: by
itself, once, for a page divided by length when it is first read (below), and on the reader's
request (`s` on a page, or "Arrange with a model" in its menu; `POST /api/page/arrange`) for any
page.

- **What is sent.** The page's title, and each unit of the lead and sections numbered in reading
  order, as its first 150 characters (a figure as `[image: caption]`, a heading as
  `[heading: …]`), within about 6,000 tokens (four characters a token). A page that does not fit
  has every opening shortened, down to 40 characters, rather than units left out; one that does not
  fit even then is refused, and says how many parts it has. The units go inside a
  `<page_text>…</page_text>` block, and the system prompt says that everything in it is untrusted
  text from a web page, to be summarised and arranged and never obeyed; the page's own copies of
  the markers are disarmed. No tools; low effort; the server's shared model, so the call is
  counted in the usage like any other. The page is never read again for this: the units come from
  its snapshot.
- **What comes back** (schema `arrange`): a summary and a flat list of sections, each a title and
  the number of the unit it starts at. The schema sets no lengths: a long summary is clipped to 600
  characters and a title to 80 afterwards, rather than the answer refused. The list is made valid
  by construction: starts rounded and sorted, repeats and numbers outside the units after the lead
  dropped, the first moved to the first unit after the lead, an empty title named by its unit's
  first words. Fewer than two sections left: the page keeps its parts by length, gains the
  summary, and says the model could not divide it.
- **What is kept.** Sections `m1`, `m2`… (outline `model`), each the units from its start to the
  next one's, so every unit is still in the lead or one section, once, in order. The outline made
  without a model stays in the snapshot. The summary is shown above the page's own opening (which is
  still shown), labelled as written by a model; a line says the sections are a model's; the foot's
  "Adapted" gains "sections arranged by a model" and "summary written by a model" (and loses
  "divided into parts by length"). A page with headings or pseudo-headings keeps its sections and
  gains only the summary; so does a page short enough to be one lead.
- **Panes.** Section ids are namespaced by outline, so a pane open on a part by length (`c2`)
  names nothing in the model's outline: it closes when the arranged page arrives, and the status
  line says so with the result. Moving such a pane to the model's section that holds its first
  unit was considered and left out: the arrangement usually arrives within seconds of opening,
  before the reader has opened a part, and a pane silently showing a different, longer span would
  lose the place nearly as much as closing it.
- **The gate**, checked before any call, each refusal a sentence the status line shows: no model;
  `EX_PAGES_ARRANGE=off`; the plan's limits nearly used (`warning`) or refusing (`limited`, server/
  usage.ts), so that what is left of a plan goes to writing; the server's day of calls spent
  (`EX_PAGE_CALLS`, default 20, a `{ day, used }` file at `<EX_DATA>/page-calls.json`, the day in
  UTC, every call made counted, failed ones too). One call per content hash however many ask at once;
  a page already arranged for the text it now has answers from its snapshot without a call (the
  status line says "no new call").
- **By itself** (`Arranger.auto`). The owner expected a page without headings of its own to be given
  section titles without being asked, so the routes that read a page for a person, `article`,
  `reload` and `summary` (not `&cached=1`: a card never spends anything), start the same call `s`
  makes, without waiting for it, for a page whose outline is `chunks` and that has nothing a model
  made for its current hash. Pages with headings or pseudo-headings (real text of the page's own,
  left as they are), pages short enough to be one lead, and pages that cannot be shown never start
  it. It goes through the same gate, the same input cap, the same untrusted-text block, the same
  daily budget and the same single flight per hash, plus one more refusal: `EX_PAGES_ARRANGE=manual`
  leaves arranging to `s` alone. **One attempt per content hash per server run**: a refusal
  (budget, plan, too long, an old copy) or a failure is remembered, in memory, and said each time
  the page is sent, but not tried again by itself; `s` still may. A Reload with unchanged text keeps
  the hash, and so the arrangement or the refusal; one that changes the text is a new hash and gets
  one attempt. No model, `off` and `manual` are not attempts, only said. Kept in memory rather than
  in the snapshot, so a restart is the one way a failed page is tried by itself again.
- **What the reader sees.** `article` and `reload` send the page with `auto: { state: "running" }`
  or `{ state: "skipped", reason, message }` (never kept in the snapshot). The page is shown at once,
  in its parts by length, with one quiet line: "Arranging into sections with a model…", or "Kept in
  parts by length: <why> s tries again." (nothing about `s` for no model or `off`, "s arranges it"
  for `manual`). While it runs the browser asks `arrange` with `auto: true`, which only joins the
  call under way (or answers with the kept result, or why it came to nothing) and can never start a
  call, so asking costs nothing whatever happens; there is no other channel. When the sections come
  the page swaps to them in place: the reader's pane on the page stays where it is, a focus on one
  of its rows moves to its head, and a pane open on a part by length closes (its id, `c2`, names
  nothing in the model's outline) with one status line saying why. Nothing else is said, so a page
  arranged before the reader got to its parts changes only its rows. A page read for a link's title
  (§9) is arranged without any pane open; opening it later finds it done.

## 11. Videos (and what loads when)

The owner's decision: keep videos in web pages and in Wikipedia articles, formatted inside the
pane, and load nothing from outside until the reader clicks. A video is a **facade**
(`src/core/video.ts`), fixed markup the sanitiser writes and nothing of the page's own:

```html
<figure class="video" data-video="https://media.example.org/weir.mp4" data-width="640" data-height="360">
  <img src="/api/page/media?u=…" alt="" width="640" height="360" loading="lazy" decoding="async">
  <figcaption>The weir at dawn</figcaption>
</figure>
<figure class="video" data-embed="youtube" data-id="Wx7bQk2pL9a"><img src="/api/page/media?u=…i.ytimg.com…"><figcaption>Video from YouTube</figcaption></figure>
```

- **What becomes one.** A `<video>` whose `src` (else its first `<source>` with one) resolves,
  against the page's address, to an **https** address; with its `poster` as the still and its
  `width`/`height` as its shape. `autoplay`, `loop`, `muted` and the rest are not kept. An http
  video stays a link: the page's CSP lets the browser load media from https alone. An `<iframe>`
  of YouTube (`youtube.com/embed/ID`, `youtube-nocookie.com/embed/ID`, `youtu.be/ID`,
  `youtube.com/watch?v=ID`) or Vimeo (`player.vimeo.com/video/ID`), and only with a valid id
  (YouTube: 11 of `A–Z a–z 0–9 _ -`; Vimeo: digits); YouTube's still is
  `https://i.ytimg.com/vi/<id>/hqdefault.jpg`. Anything else, a malformed id included, stays the
  "Embedded content from <host> ↗" link. Caption: the figure's `figcaption`, else the element's
  `title` (a player's stock "YouTube video player" says nothing), else its `aria-label`, else
  "Video from <host>" (or YouTube, Vimeo).
- **Stills go through the media route.** A poster and a YouTube thumbnail are added to the
  snapshot's `media`, so `/api/page/media` serves them as it serves pictures, and nothing else.
  The video file itself is never fetched by the server.
- **In the text.** A video is a unit of its own (kind `video`), its caption its text; to the model
  that arranges a page it reads `[video: caption]`. In the browser it is a figure whose caption is
  text (`buildText`), so a caption takes part in selection like a picture's.
- **The browser.** The client's second cleaning (`cleanAttrs`) keeps on a `figure` only
  `class="video"` and `data-embed` + `data-id` (a valid id), else `data-video` (https; in
  Wikipedia's text only upload.wikimedia.org), `data-width`/`data-height` (digits) and
  `data-file` (a wikipedia.org page); anything else is an empty figure that shows its caption.
  `Wiki.tsx` draws the still with a play mark (no `<button>`, no style attribute: the box's shape
  is a class, the nearest of 21:9, 16:9, 3:2, 4:3, 1:1, 3:4, 9:16; 16:9 when unknown and for a
  player). Never wider than the pane, at most 70vh tall, the caption under it, a dark box in both
  themes. **On a click** it makes, from those checked values and never from page HTML, a
  `<video controls preload="none">` with that source and the still as its poster, and starts it
  (the reader asked; no autoplay attribute, no loop, not muted); or an iframe to
  `https://www.youtube-nocookie.com/embed/<id>` or `https://player.vimeo.com/video/<id>` with
  `sandbox="allow-scripts allow-same-origin allow-presentation"`,
  `allow="fullscreen; picture-in-picture"` and `referrerpolicy="no-referrer"`.
- **The CSP** (`server/csp.ts`, sent with the production page) gained two directives and lost
  nothing: `media-src https:` (the file plays straight from its origin, after the click) and
  `frame-src https://www.youtube-nocookie.com https://player.vimeo.com` (was `'none'`). http media
  was left out: nothing else in the policy allows http, and a page's http video is a link.

**What loads when.** Opening a page or an article: the app's own routes only (text, then each
picture and still through `/api/page/media` or `/api/wiki/media`, lazily as they scroll into
view). Clicking a picture: a new tab at the picture (a web page) or its File page (Wikipedia).
Clicking a video: the file from its own host, or the player's page from YouTube or Vimeo, and from
then on whatever that player loads inside its sandbox.

**To check, not checked here** (nothing was fetched from the real sites): whether YouTube's
privacy-enhanced player still plays with no referrer (it has been reported to refuse some embeds
that send none; if so, `strict-origin-when-cross-origin`, which sends only the app's origin, is
the next thing to try), and whether `i.ytimg.com/vi/<id>/hqdefault.jpg` answers the server's
User-Agent and robots.txt.

## 12. Notes on a page's words

The owner's request: the selection on a page's text offers what it offers on Wikipedia's, and the
notes behave the same. They do, through the same code: `src/core/article.ts` files notes on an
article or a page, `Store.hostSource` gives either as a `Source`, and `ArticleTextView` and
`Detached` (src/ui/Wiki.tsx) draw both. Where the two differ:

- **Filing.** A page's node sits in the same hidden container as the articles' (a section of the
  library root flagged `articles`; one made before pages could be annotated is titled "Wikipedia"
  and is used as it is, a new one is titled "Articles and pages"). It is keyed by the page's
  address as `normUrl` compares them (no fragment, no trailing slash), its target a `url` ref with
  that address and the page's title. The address is the one the view shows the page at (the link's,
  not the one redirects ended at), so a section that is only a link to a page and the page's own
  pane show the same notes. Everything that skips the container (the outline, search, links, the
  scanner and reviewer, Related, export, the library's node count, "Linked from") skips a page's
  node as it skips an article's, by the container's flag, not by the kind of target.
- **The anchor** is an article's (`WikiAnchor`: the section's headings, the words, 32 characters
  either side). A page has no revisions, so `rev` is `pageRev(hash)`: the first 48 bits of the
  copy's content hash (§2), a whole number as the anchor's check requires, so nothing about the
  stored shape changed and earlier Wikipedia notes read as they did.
- **Finding it again.** A page's sections are cut anew more often than an article's: a Reload whose
  text changed re-divides a page divided by length (`c1`…), and arranging it replaces those with the
  model's (`m1`…), whose headings are the model's. So a section's headings name it only loosely, and
  `reanchor` is given every section's text (`pageSectionTexts`, the lead first); when the words are
  not in the section named, they are taken wherever they and their surroundings agree best, in any
  section (articles gained this too: before, the first section in order with the words won), and the
  note shows in whichever section now holds them. Words not found, even ignoring case and
  punctuation, leave the note detached: listed at the top of the page (or of its section, while one
  with its headings is still there), "not in the page as it now reads", with no link, since no older
  copy is kept.
- **A page that cannot be shown** (robots, refused, offline, a Reload that found it unusable) lists
  every note kept on it under the reason, each a note like any other (a click focuses it), so none
  is lost; they are placed in the text again when it can be read.
- **The model.** A lens sends what it sends for an article (the lead up to 6,000 characters, or 2,000
  and up to 3,000 characters either side of the words in their section), with the usual limits and
  no budget of its own. The prompt is built where an article's is (`src/llm/prompts.ts`; the server's
  `/api/llm/stream` passes prompts through), and every piece of the page in it (title, site, lead,
  section heading and passage, the words) is inside `<page_text>…</page_text>` with the page's own
  copies of the markers disarmed; the system prompt (`PAGE_NOTE_SYSTEM`) adds the paragraph
  `server/pageArrange.ts` uses: untrusted text from a web page, never an instruction.
- **Linking by hand** is not offered on a page's words, as on an article's: the text is not the
  reader's.

