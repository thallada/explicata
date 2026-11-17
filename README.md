# Infinispand

A tree of writing you can expand without limit. It opens as an outline of titles; every node, sentence,
phrase and word can be opened further. The first levels are written ahead of time and open
instantly; past them, a model writes the expansion on request. Everything is editable, by you or
by a model, and the tree is versioned like git.

Everything is a node of a library: a single versioned tree whose root is the library itself.
Any node, with everything under it, can be moved under any other, copied, saved to a file, or
given a file's tree under it, and reading goes from one place to the next without closing
anything. There can be several libraries, each a tree of its own: nothing in one links to, moves
into or is found from another. The first tree of the first library is this project describing
itself, grown from the prompt that started it; a set of starter trees (`library/*.md`) comes with
it.

## Run it

```sh
npm install
npm run dev            # http://localhost:4747
```

Without credentials the library is fully explorable and editable, and anything that needs a model
says so. To turn generation on, start the server with `ANTHROPIC_API_KEY=sk-ant-…`, or, to run on
your own Claude subscription, with the token `claude setup-token` prints:
`CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat… npm run dev`. Subscription calls go through the Claude Agent
SDK, count against your plan's limits and start a little slower; that route is for the owner's own
use on their own machine.

`npm run build && npm start` serves the production build.

| Variable | Default | |
|---|---|---|
| `ANTHROPIC_API_KEY` | unset | Enables generation. The key stays in the server process. |
| `CLAUDE_CODE_OAUTH_TOKEN` | unset | A subscription token, used when no API key is set. A token put in `ANTHROPIC_API_KEY` by mistake is moved here. |
| `IE_MODEL` | `claude-opus-5-5` | Model for every call. |
| `IE_LLM` | `claude` with a key, `subscription` with a token, else `off` | `mock`: a deterministic stand-in (the tests). |
| `IE_DATA` | `.data` | Where the libraries and their caches are kept. Delete it to start again from the seed and the starter trees. |
| `IE_LIBRARY` | `library` | Starter trees (`.md` files in the text format), written into the first library when `IE_DATA` is empty. |
| `IE_USER` | your login name | The name on commits the server makes for you (the page lets you change yours with `/user`). |
| `IE_WIKI` | `live` | `mock`: built-in test articles, no network (the browser tests); `off`: every `/api/wiki/*` route answers 503. |
| `IE_HOSTS` | (none) | Extra host names the dev server answers to, comma-separated. `localhost` and `*.ts.net` (Tailscale) are always allowed. |
| `IE_WIKI_LANG` | `en` | Which Wikipedia. |
| `IE_WIKI_CONTACT` | unset | An email address, an `https://` URL or `User:Name` for the User-Agent of Wikipedia requests. Without it requests are spaced 6.5 s apart (the page says so once, the first time it is slow); with it, 1 s. Nothing else about you is sent. |
| `IE_WEB` | `on` when a model is configured | `off` takes web search and fetch away from the editor agent, whatever the page asks. |
| `IE_WEB_SEARCHES`, `IE_WEB_FETCHES` | `5`, `5` | Searches and page reads one request to the editor may make. |
| `IE_REVIEW_CALLS` | `50` | Model calls the link reviewer may make in one `/linkhere` or `/linkall` (each call judges up to 60 links). What is left past the cap waits for you. |
| `IE_EMBED` | on | Local embeddings for link discovery (bge-small, loaded on first use in a worker thread, about 560 MB of memory). `off`: links are found by text alone. `fake`: hashed words, no download (the tests). |
| `IE_EMBED_MODEL` | `Xenova/bge-small-en-v1.5` | Downloaded once into `IE_DATA/models/`. `Snowflake/snowflake-arctic-embed-xs` is a drop-in alternative. |
| `IE_EMBED_THREADS` | `4` | ONNX threads for the embedding model. |
| `IE_EMBED_OFFLINE` | unset | `1`: never download, use cached model files only. |
| `PORT` | `4747` | |

For the tests: `IE_MOCK_DELAY` (ms per mock token), `IE_WIKI_MOCK_BULK_MS` (delay on background
Wikipedia requests), `IE_PROD=1` and `IE_DIST` (serve a build, and which one), `IE_E2E_PORT` and
`IE_E2E_DATA` (playwright.config.ts).

## Using it

Press `?` for every key. The short version:

- Focus is a **node** and a **grain**. `j` `k` move, `l` opens, `h` closes. `i` narrows the grain
  (node → sentence → word), `Esc` widens it.
- `e` goes deeper on whatever is focused. Text with a dotted underline already has an expansion;
  anything else is written on request. `d` `y` `x` `c` ask for a definition, a reason, an example,
  an objection; `:` asks your own question. The size of the selection decides the form: a word or
  two gets an inline gloss, a sentence a margin note, several sentences an inset passage, a node
  child sections.
- `c` edits, `r` renames, `a` adds, `D` deletes, `u` undoes (the last edit made in this tab,
  wherever it was). `p` locks a node: the model never rewrites a locked node (your own edits lock
  it). Locking is not pinning: a pin (`P`) keeps a pane open in the panes view. On a node, `:` hands an instruction to the editor agent; `Esc` stops it.
- `g` opens history: commits, branches, conflicts. `f` shows only what touched the node you are on
  and what is under it; `r` reverts that node and what is under it to a commit, leaving the rest of
  the library alone (on the library root, the whole library goes back).
- The library root is the first page, a node like any other: `l` or `Enter` opens one of its
  sections in place, `a` adds one, `z` makes a node the whole page and `h` or `Esc` at its top steps
  out to its parent's page. `/` jumps to any section anywhere in the library.
- What acts on a node and everything under it acts on the node you are on (the focused section,
  or the one a focused note or selection is in), anywhere in the tree: `M` moves it under any other
  node (a picker like the jump box; the library root is offered too), `/duplicate [title]` copies
  it just after itself, `/export` saves it as a `.md` file, `/import` reads a `.md` file into it as
  its last child, `/linkhere` looks for links in it. Each is in the `⋯` menu of any node, and each
  is an ordinary edit of the library, made in the browser's replica (`u` undoes it).
- Edits are saved as they are made; the top bar says `saved` once the server has them all.
- **With a mouse or a finger.** Everything a reader needs is reachable without the keys, and each
  control names its key, so the mouse teaches the keyboard. A click on a sentence selects it and a
  small bar over it offers `expand e · define d · why y · example x · challenge c · ask :` and
  `link w`, with `⋯` for the rest (Copy, Related sections, select less or more); a drag selects
  words, a double click a word; it works the same in an article's text, without link. A right-click
  on words, a row, a link, a note or a pane opens what can be done with it, Copy first (Shift+right-
  click is the browser's own menu); so does the `⋯` beside a row, a pane's pin, a page's byline or a
  note, shown only when pointed at, and a stale flag. The top bar, which stays at the top, has
  `undo`, `redo` when there is something to redo, and `menu` (libraries, jump, history, links,
  layout and settings); on its left, the library's name, which opens the libraries panel. Keys
  named in the status line or a panel's head are buttons. On a phone the selection bar sits at the
  foot of the screen and menus rise from it, above an on-screen keyboard and the home indicator. Every item acts by pressing its key
  (`src/ui/press.ts`), so a click and a key cannot do different things. The first visit says, once,
  in the status line, that a click on a sentence offers actions and `?` lists the keys. Left to the
  keys: stepping by grain (`j` `k` `i`; a click or a drag goes straight there), `Tab` from mark to
  mark, `[` `]` up and down a column (a click on a pane does it), and the commands typed at `:`
  that no menu lists (`/branch`, `/switch`, `/merge`, `/user`, `/link`, …), which the menu's
  Command line… opens for typing.
- **Libraries.** `m`, or a click on the library's name at the top left, opens the libraries panel
  on the left: every library, with how many nodes it holds, ● the one open here. `j` `k` move,
  `Enter` (or a click on a row) opens one, `n` names a new one (its root alone) and opens it, `r`
  renames one, `D` deletes one after a `y` (`n` keeps it; the last library cannot be deleted, and
  where a deleted one goes is below); `Esc`, `m`, the name again or a press outside closes the
  panel. A row's `⋯`, or a right-click on it, offers the same. Beside the panel the column moves
  over and the panes narrow; on a phone it covers the page. Each library is a page of its own, at
  its own address (`/l/<id>`); opening another loads the page, where you left it in this browser.
  `/` opens the library last used in this browser. A library's name is its root's title (`r` on
  the root renames it too). Nothing crosses between libraries: links, the jump box, Related, the
  link scanner and reviewer, and the editor agent see only the library they are in; export then
  import carries a tree across. A page whose library is deleted, by another page or while it was
  away, stops sending, says so (`deleted · not saved` in the top bar) and opens the panel on the
  others. On the command line, `:/library name` opens a library by name and `:/library new name`
  makes one.
- On a window 900 px wide or more, a laptop's too, the page opens as panes side by side, after
  Andy Matuschak's notes: the library, then each open node in a pane of its own. On a narrower one, a
  phone's or a tablet's held upright, the same panes open as pages (below). `v` switches between the
  panes and the single column, `/view auto|column|panes` sets it: `auto` is panes side by side or
  pages by the width, `panes` side by side at any width, `column` the indented outline.
- **On a phone: pages.** Each column of the panes view is a page as wide as the screen, its panes
  stacked down it exactly as in a column on a wide screen (a pane not looked at folded to a tab, a
  finger high; a pane scrolled past its title shows its tab at its top). A tap on a row, a link, a
  "Linked from" or Related row opens its target and goes to it: the next page slides in. A swipe
  sideways goes from page to page and makes the pane on that page the active one (the one on the
  focused branch there, else the one last visited); a swipe down a pane scrolls its text. The trail
  at the foot names the focused branch, a step per pane, each underlined in its pane's colour, the
  one on screen in the text's ink, those opened beyond it fainter; a tap on a step goes there. Its
  `map` button opens every open pane as an outline of the forest, indented by where each was opened
  from: a tap goes to a pane, its pin pins it, its × closes it (Esc or a press outside puts the map
  away). Each pane's ⋯, pin and × sit above its title, always shown. No curves are drawn (the panes
  are never side by side): what each pane was opened from, its link's underline, a note's dotted
  rule or its row's edge and arrow, takes the pane's colour instead, the colour of the rule under the
  pane's title. Every step from pane to pane is a step in the browser's history, so Back, the button
  or the edge swipe, goes back a pane (a swipe back to the pane before is Back itself), Forward
  forward again, and a reload keeps the panes and the place. A long press on a link shows what it
  opens above its menu. Turned to a width of 900 px or more, the page shows the same panes side by
  side, the same one active, and back again. What a finger presses is at least 40 px each way (words
  in running text excepted); the key hints, the branch, the model and the `?` button leave the
  status line (the top menu has Keys and help, the history panel the branch). A hardware keyboard
  works as anywhere: `Alt+h` `Alt+l` turn the pages, `[` `]` move up and down a page's panes, and `l`
  or `Enter` on a row goes into its pane.
- **Opening.** `Enter`, `l` or a click on a row, a link, a link in an article, or a "Linked from",
  "Mentioned in" or Related row opens its target in the next column, beside what is already open
  there (so do Ctrl-, Cmd- and middle clicks); `Shift+Enter` or a Shift-click opens it in place of
  the focused branch's pane there, closing that pane and what was opened from it. Opening what is
  open already focuses it; a second `Enter` on an open row keeps it (closing is `q`'s or the x's).
  The first pane is the page, headed with its crumbs and byline; every other pane has a section's
  head, whatever node it shows, and one opened by a jump names the titles above it. Moving back
  left with `h` closes nothing.
- **Columns.** Column d holds every pane at depth d, top to bottom, in the order of what they were
  opened from: by where their parents stand, then by where in the parent each was opened from, so a
  pane opened from higher up stands higher (and curves cross as little as they can). A column divides
  its own height among its panes, a short pane taking only what its text needs. When they do not all
  fit, the column stacks them the way the strip stacks columns: the pane on the focused branch shown
  whole, those before it stuck a tab apart above it and those after it a tab apart at the column's
  foot, partly covered and at the limit down to a one-line tab, so every pane shows at least its tab.
  A pane scrolled past its own title shows the same tab at its top, over its text; a pane shows its
  tab only while the rule under its title does not show, never both. A click anywhere
  in a pane that is not text, a row or a link makes it the active pane; a click anywhere else, or
  Esc, clears a selection. Mouse resting on a pane that is cut off for any reason (covered across
  or down, too small a share of its column, past its foot): after a moment it peeks out whole over
  its neighbours, its column across and the pane down its column, as tall as its text needs, and
  stays out while the pointer is on it (the wheel scrolls it); a click makes it the active pane. A
  pane's grip (the band above its title, by the pin and x, shown when pointed at) or its tab drags
  it up or down its column; Esc cancels; the column keeps that order, and a pane opened later goes in
  just after the one before it in its own order.
- **Between panes, by keys.** `Alt+h` goes to the pane this one was opened from, `Alt+l` to one
  opened from it (the one opened from the focused row or link, if it is open, else the one last
  visited there), `Alt+k` and `Alt+j` (or `Alt+↑` `Alt+↓`, or `[` `]`) to the pane above and below
  in the column, across forks; the same from a node, a selection or an article, back where you were
  in each pane, and left then right comes back. Plain `h` and `l` still move along the focused branch.
  The pane menu (`⋯`) offers the same.
- **Curves.** A curve runs from the words, row or link each pane was opened from into the rule under
  the pane's title, and draws that rule, and a link's underline too, so link, curve and rule are one
  hairline on device pixels. Curves pass over the panes' edges and under the selection bar and the
  menus; a pane peeking out covers the curves that are not its own; the focused branch's is drawn stronger. Where the title does not show (the pane
  folded to its tab, or scrolled past it), the curve runs into the tab's foot instead; out of a
  folded pane whose source is out of sight, it leaves from the end of that pane's tab foot. A source
  scrolled or covered out of sight in a pane that still shows is pointed at: the curve is dotted
  and ends turned toward it, at the pane's edge over where it is. Curves down
  one gutter run side by side, ordered to cross as little as they can. `/curves off` hides them.
- **Fork colours.** Each fork has a colour of its own, quiet and the same lightness for all: a
  pane opened as the first from its pane goes on in that pane's colour, any other starts the next
  of seven, so a plain trail is one colour. The top node (the library) has none to hand down: each
  pane opened from it starts its own. The colour runs along the curve into the rule under the
  pane's title (a tab's foot, a dash on a spine), at full strength on the focused branch and
  fainter off it; a pane keeps its colour while it is open, through a reorder, or as an orphan, and
  nothing but the panes' tree decides it (not the focus, a scroll or a fold).
  `/colors line|top|edge|off` (or the menu) puts it there, in a band across each pane's top, down
  its left edge, or nowhere.
- **The active pane**, where the keys act, has a heavy rule across its top and its other edges in a
  stronger ink; the rest of the focused branch, a hairline across its top. A pane peeking out is
  edged all round. `q` closes it and every pane opened from it (whatever it shows: a section, a
  note, an article); each pane's x does the same for that pane. `P`, or a pane's pin, pins it: a
  pinned pane stays where it is when a pane it was opened from closes (it shows that its source has
  closed), is never replaced by a Shift open, and is never covered, in its column or along the
  strip. The panes, their order and pins are kept with the rest of the view, so a reload brings them
  back; the address names the focused pane only. The column has one page: there a Shift open is a
  plain one.

### Links and Wikipedia

- A node can have a **target**: a Wikipedia article, another node in the library, or a web page.
  A note with a target and no text of its own is a **link**. Linked words get a thin underline and
  a mark after them, after gwern.net: **W** Wikipedia, **§** a node in this library, **↗** the web.
  A note that also links keeps its dotted underline and gets the mark; `Enter` or a click on it (or on
  words that carry both a note and a link) opens one page: the note's text first, as the library's,
  then the article in full (or the node's or page's card). `h` returns to the words.
- Hovering linked words, or landing on them with `Tab`, previews the target. `Enter` opens it: in
  panes in the next pane; in the column a preview first, then the node (Back returns) or the
  article as a page of its own. `L` opens a node's own target; a web page opens in a new tab.
- An article is shown as a tree, so the same keys work: its sections are rows, `Tab` walks its
  links, `Enter` opens one. A disambiguation page lists its senses. `W` opens the article on
  wikipedia.org. Article text is set apart (sans-serif, tinted, under a W) and carries its licence
  line.
- Under an open node, **Linked from** lists what links to it; under an article, **Mentioned in**
  lists the library's nodes that link to it.
- **Notes on an article.** In an article's text the keys are a node's: `i` selects a sentence, then
  a word, `j` `k` `H` `L` move and widen, `Tab` walks links and notes, and `e` `d` `y` `x` `c` `:`
  write a note on the words, which is a note like any other (`Enter` steps into it; `c`, `D`, `f`,
  `u`, `:` the editor). Wikipedia's text itself cannot be edited: keys that would edit it say why not. The notes
  belong to the article, so they show wherever it is opened. The library keeps a node per annotated
  article in a container that is not one of the root's sections (not listed, never scanned for links, never
  reconciled); the article text stays in the server's cache. Each note records its section, its
  words, a little text either side and the revision; in a later revision it is found again (its
  section first, then anywhere, then ignoring case and punctuation), and if its words are gone it
  is listed at the top of its section as detached, with a link to the old revision. Tables and
  preformatted blocks are shown but cannot be selected; a formula is selected whole.
- To link by hand, select words (`i`, widen with `H` `L`) and press `w`: the picker offers library
  sections and notes, Wikipedia articles and, for a pasted address, the web page. `w` on a link
  retargets it, `D` removes it (for good: see below); `:/link target` and `:/unlink` do the same.
- A link to a deleted node stays in the text, marked broken, with the titles down to it from the
  library root, so undoing the delete finds it again.

### Links found for you

- Whenever text is written (an edit saved, text a model wrote, a file imported) the server scans it
  in the background: phrases that are another section's title, sections in other top-level trees close in
  meaning, and Wikipedia articles, each checked against the text. These scans ask Wikipedia only
  after anything a person is waiting for.
- What is found is **reviewed by the model** (`/autolink review`, the default when a model is
  configured): it judges every candidate as a careful Wikipedia editor would, and the links it
  approves are made at once, as one commit by "reviewer" (`u` takes it back; history shows it). What
  it rejects is kept, with its one-line reason, and not looked for again. The model gets no tools,
  only the candidates: each phrase's sentence, its section's title and path, and the target's title
  and description (or first sentence); many candidates go in one call, and nothing judged is sent
  twice. Without a model (`IE_LLM=off`), or when a call fails or a job reaches its cap
  (`IE_REVIEW_CALLS`), nothing unreviewed is linked: the candidates are suggested instead, and the
  status line says why.
- A **suggestion** has a faint dashed underline. `Tab` reaches suggestions; `y` links one, `n`
  declines it (remembered in the node, on every replica). `/autolink suggest` leaves every
  candidate to you; `/autolink on` makes the scanner's surest links unreviewed (they measured 0.84
  precision on unseen trees); `/autolink off` scans nothing by itself.
- `S` opens the **links list** of the node you are on and everything under it (on the library
  root, of the whole library), beside the text: every link found or made, what
  was rejected and what waits, each with who decided (the reviewer or you) and the reviewer's
  reason. `1` `2` `3` (or a click) show or hide linked · rejected · pending, with their counts;
  rejected is hidden at first. `j` `k` move, and the row's words are selected in the text; `y`
  links a row, also one the reviewer rejected; `n` declines one, or removes a link for good (its
  words are declined so it is not made again); `Y` links every pending row shown; `Enter` goes to
  the words; `Esc` closes. Declines made before determinations were kept show as the phrase alone.
- `D` on a link, or **Remove the link** in its right-click menu, removes it and declines its words in
  that node, so neither the scanner nor the reviewer puts it back (`:/unlink` does the same, and on a
  note that also links keeps the note's text).
- In the body editor `[[` opens a completer (library titles, then Wikipedia). A bare `[[term]]`
  left in the text is looked up on save.
- Under the node being read, **Related** lists sections elsewhere in the library close in meaning.
  `1`–`5` with words selected links them to that row; on the node, goes there.
- `/linkhere` and `/linkall` scan the node you are on with everything under it, or the whole
  library (as `/linkhere` does on the library root), in the background, with progress in
  the status line, the reviewer's calls counted against the cap (`/linkcancel` stops; what was
  reviewed is kept, and what was approved is linked).
- A model writing a note or sections is given a few nearby library nodes and may mark phrases
  `[[phrase]]`; the marks never show and each is checked before it becomes a link. The editor
  agent has a `suggest_links` tool.

How the rule was tuned and measured, and how the reviewer is asked and what it costs:
[docs/wikipedia.md](docs/wikipedia.md) (§8, §9).

### Web research

The editor agent can search the web and read pages, and nothing else, only when asked: by
`:/research question` on a node, or by a request that plainly asks for it ("look up", "search the
web", "find sources", "cite sources", "fact-check"; a fixed rule, not a model's guess). A panel
above the status line lists each search, page and edit as it happens, then a summary and the
sources linked. `Esc` stops a run and keeps nothing of it (its edits were on its own copy).

Every claim taken from the web is linked (↗) to the page it came from, and only pages retrieved in
that run may be cited; any other address is refused. Each request may make at most
`IE_WEB_SEARCHES` searches and `IE_WEB_FETCHES` reads. Page text is treated as data, never
instructions.

What is sent where:

- **With an API key**, searches and fetches are Anthropic's server tools, run by Anthropic during
  the call (pages are fetched from Anthropic's servers). Fetch may only read addresses from the
  request, the outline sent with it, or an earlier search or fetch of the run; dynamic filtering
  (which runs code) is off.
- **On a subscription**, Claude Code is given exactly WebSearch and WebFetch. WebFetch fetches the
  page **from this machine** and a small model summarises it. A guard in the server refuses every
  other tool, any non-public address, any page the run's searches did not return and the request
  did not name, and anything past the caps.
- **With `IE_LLM=mock`** nothing leaves the machine.

## How it works

- **`src/core/model.ts`** The library is a tree of nodes in a [Loro](https://loro.dev) CRDT. A node
  is a section (listed under its parent) or a note (anchored to a span of its parent's text by CRDT
  cursors). One op API, `create / update / replace / delete / move / copy / bless`, is used by every
  writer: the keyboard, the editor agent and `POST /api/ops`.
- **Staleness is computed, not stored.** Each node remembers a hash of the children and of the
  parent text it was last reconciled with; a mismatch makes it stale in that direction. A person's
  edits lock a node: flagged when stale (LOCKED beside it), never rewritten. `p` locks or unlocks
  one by hand; the flag keeps its old name, `pinned`, in the data and the op API, so existing
  libraries keep their locks. The library root and its sections are not reconciled with each other.
- **Snapshots are patched, not rebuilt**: a change re-reads only the nodes it wrote, so an edit
  costs what it touches, whatever the size of the library.
- **`src/core/repo.ts`** Every commit records the SHA-256 of the tree, so any checkout can be
  verified. Merging is structural (the CRDT) and then semantic: base, ours and theirs are compared
  node by node and what a character merge cannot see becomes a conflict record.
- **`src/llm/`** Prompts and the tasks built on them: expand a selection, deepen a leaf, cascade
  after an edit (a resolver decides how far up), resolve conflicts, and the editor agent, which
  works on a fork and merges back. A prompt carries the outline of the focused node's top-level tree only.
- **`src/core/ref.ts`, `src/core/links.ts`** Targets, the backlinks index, finding a node target
  again, `applyLinks`, which links a batch of spans in one commit, and the phrase key a decline
  records.
- **`src/core/article.ts`, `src/ui/articleText.ts`** Notes on Wikipedia articles: the article
  nodes, anchors and finding them again in a new revision; an article's HTML as text to select in.
- **`src/core/format.ts`, `seed.ts`, `address.ts`** The text format, writing a parsed tree into the
  library under any node (an import), and a node's address.
- **`server/`** Keeps the libraries (`libraries.ts`, each library on disk in `library.ts`, and
  per library its routes, notices, link discovery and reviewer in `bundle.ts`), relays updates
  between replicas and persists them, proxies model calls (`claude.ts`, `subscription.ts`,
  `usage.ts`, `web.ts`), Wikipedia (`wiki.ts`, `wikiHtml.ts`, `wikiRoutes.ts`, `wikiMock.ts`), local
  embeddings (`embed.ts`), link discovery and its model reviewer (`links/`), and brings data from the
  single-library layout over when asked (`migrateLibraries.ts`, `npm run migrate`).
- **`src/ui/`** The browser's replica of the library (`session.ts`, kept in IndexedDB), the store
  and keymap, and the page. The mouse acts through the keymap: `actions.ts` builds what the
  selection bar and the menus offer for each kind of target, every item pressing its key
  (`press.ts`); `Mouse.tsx` draws the one menu, the bar and the key hints; `Menu.tsx` the top bar
  and the libraries panel (its state in `libraries.ts`). The panes view's panes are a forest of forks (`forks.ts`, pure functions;
  the store's `trail` is its focused branch); `stack.ts` is the stacking shared by the strip and its
  columns, `lanes.ts` orders the curves' lanes. The pages layout is the same panes (`Panes.tsx`) laid
  out a column per page, with `Pages.tsx` (the trail and the map) and `pages.ts` (which pane a page
  brings forward, and the history entries a pane per step, pure functions).

## The libraries

On disk:

```
IE_DATA/libraries/index.json                 the libraries, in order: id, title, when made, whether deleted
IE_DATA/libraries/<id>/<branch>.loro         a library, one Loro snapshot per branch
IE_DATA/libraries/<id>/links/pending.json    its link suggestions, the reviewer's verdicts and your decisions (derived)
IE_DATA/libraries/<id>/vectors/nodes.*       its sections as vectors (derived)
IE_DATA/libraries/.deleted/<id>-<time>/      a deleted library, moved aside whole
IE_DATA/wiki-cache/                          Wikipedia answers (derived, shared)
IE_DATA/models/                              the embedding model (shared)
IE_DATA/server.lock                          the running server's pid
```

A library's id is its database's own id (base 36); its name is its root's title. Each library is a
Loro database of its own, so a node id of one never resolves in another, and every route finds its
library first and is given only that library's data.

| | |
|---|---|
| `/` | the library last used in this browser (else the first) |
| `/l/<id>` | a library's root |
| `/l/<id>/n/<node id>` | any other node of it (by its id alone, so a moved or renamed node is still found) |
| `/l/<id>/w/<lang>/<title>` | a Wikipedia article as a page of its own (the column) |

The address follows the focus; changing the page (hoisting, stepping out) or jumping makes a
history entry. An address that names nothing shows the library's root; one without a library
(`/n/…`, `/doc/…`) is read in the library last used; a library the server does not have goes to
the first one.

When `IE_DATA` is empty, the first library is made with the seed and every `library/*.md`; a file
that does not parse is logged and skipped. A library made later starts with its root alone.

### Deleting a library

`D` in the libraries panel (or `DELETE /api/libraries/<id>`) moves the library's directory, whole
and unchanged, to `IE_DATA/libraries/.deleted/<id>-<time>/` and marks its entry in `index.json`
deleted; the page says where it went. The last library cannot be deleted, and `u` cannot undo a
deletion. To bring one back: stop the server, move the directory back to `IE_DATA/libraries/<id>/`,
remove the `"deleted"` and `"movedTo"` fields from its entry in `IE_DATA/libraries/index.json`, and
start the server. Nothing ever empties `.deleted/`.

### From the single-library layout

A data directory written before libraries (`IE_DATA/library/main.loro`) is not opened: the server
says, in one line, to run the migration, which only ever runs when asked. Stop the server (and let
every open page say `saved` first: a page of the old library cannot send its edits to the new one),
then:

```sh
npm run migrate -- --check   # a dry run: builds and verifies the new library in memory, writes nothing
npm run migrate              # the same, then writes it
```

Both take another directory as an argument (`npm run migrate -- --check /path/to/data`); without
one, `IE_DATA`, else `.data`. The migration copies the tree into a new library (a new id, a history
of one commit): titles, bodies, notes with their anchors, locks, authorship, targets, declined
phrases, the Wikipedia container with its articles' notes, the order of everything, and what each
node was last reconciled with, so nothing turns stale. Every node target is rewritten to the new
ids (a target already naming nothing keeps its titles as a hint), open conflicts come along, and
the reviewer's verdicts and your decisions (`links/pending.json`) are re-keyed; vectors are rebuilt
when first needed. Before writing, it checks the copy node by node against the original (tree,
count, text, notes, anchors, flags, staleness, and every target that resolved resolving to the same
node) and again from the file it wrote; any difference stops it with a report and leaves the
directory as it was. Then `libraries/` is put in place in one rename, and `library/`,
`library.json`, `links/` and `vectors/` are moved, unchanged, to `IE_DATA/backup-<time>/`. History,
branches other than main (listed, and kept in the backup) and resolved conflicts are not carried.
It refuses while a server has the directory open, and a second run does nothing. A directory
older still (`IE_DATA/docs/`) must first be opened once by a version from before libraries
(commit c4d6856).

To go back: stop the server, move `libraries/` away and the backup's contents back, and check out
the commit before libraries.

### The text format

Used for the starter library and for export and import.

```
# Title of the tree's top

Root text: paragraphs separated by blank lines. Inline markup is only *emphasis* and `code`.

## A section            heading depth is tree depth

Its text.

^ "exact words from the text above" gloss define: a few words shown inline
^ "other words" note why: one to three sentences in the margin.
^ "more words" passage: the first paragraph of an inset note.

  A further paragraph of that note, indented two spaces.
  ^ "further paragraph" note: a note on the note, anchored in its text.

## A section about something -> w:Fixed-point combinator

^ "words" link -> w:Octopus                     a link: a target and no text
^ "other words" note why -> w:Hoyle state: a note that also has a target
^ "a phrase" link -> /Fixed points/Recursion without names/How Y works
^ "nearby" link -> ./A section about something
^ "a quote" link -> /Octopus minds/Arms that decide ^"tastes what it touches"
^ "the web" link -> https://example.org/page "Its title"
```

A `^` line is a note on the section above it, or, indented, on the note above: `^ "quote" form
[lens]: text`, where form is `gloss`, `note` or `passage` and the lens is `elaborate` (default),
`define`, `why`, `example`, `challenge` or any question. The quote must be exact words of the
parent's text (the first occurrence is anchored); a missing quote is an error naming the file,
line, section and quote. A target is `w:Title` (`w.fr:Titre` for another language), a node by its
titles from the library root (`./Section` below the top of the file, `^"quote"` for a note there),
or an `http(s)` address with an optional title. A target containing `: ` is quoted; in a path `\/`,
`\^` and `\\` escape a slash, a caret and a backslash. Wrapped lines join with a space; a line
ending in `\` keeps its break; a text line starting with `#`, `^` or `\` is written with a `\` in
front. Imported trees are written as the model, all reconciled, so nothing starts stale; an import
goes under any node, and a path below the file's top (`./…`) is stored from the library root.

Export writes each note with the current text of its anchor; orphaned notes and sections under a
note have no place in the format and are left out and counted. Export then import gives back the
same tree.

### HTTP API

Every route that reads or writes a library is under `/api/l/<id>/`; the same routes without the
prefix act on the first library (so the examples below need no id). `<branch>` defaults to `main`.
Node ids are the library's, so one batch of ops can work anywhere in it.

| | |
|---|---|
| `GET /api/libraries` | `{ libraries: [{ id, title, created, nodes, branches }] }`, in order; `nodes` counts what is under the root (not the root, nor the Wikipedia container) |
| `POST /api/libraries` `{ title }` | a new library, its root alone, at the end: 201 `{ library }` |
| `PATCH /api/libraries/<id>` `{ title }` | rename it (a commit on its root's title) |
| `DELETE /api/libraries/<id>` | `{ deleted, movedTo }`: moved aside whole to `libraries/.deleted/` (see Deleting a library); 409 for the last one |
| `GET /api/l/<id>/tree[/<branch>]` | the whole library as JSON, with conflicts and recent history |
| `POST /api/l/<id>/ops[/<branch>]` | `{ ops, message?, author?, actor? }`, applied as one commit. `create` and `update` take `ref`: `{ "kind": "wiki", "title", "lang" }`, `{ "kind": "node", "id", "path" }` or `{ "kind": "url", "url", "title" }`; `"ref": null` removes it |
| `GET /api/l/<id>/nodes/<node>/tree[/<branch>]` | one node and everything under it, with their conflicts |
| `GET /api/l/<id>/nodes/<node>/export[/<branch>]` | the same in the text format; header `x-skipped` counts what was left out |
| `POST /api/l/<id>/nodes/<node>/import?name=file.md` | body: the file (2 MB at most), read in as the node's last child on main; 422 with `problems` if it does not parse |
| `GET /api/wiki/…` | Wikipedia through the server's cache: `summary`, `article` (`&full=1` for every section), `section`, `senses`, `suggest`, `search`, `lookup` (server/wikiRoutes.ts) |
| `POST /api/l/<id>/links/scan` `{ node, review? }` | scan a node and record what is found as pending; with `review`, the model reviewer judges what is new, and the approved links are handed back to be made |
| `GET /api/l/<id>/links/pending?node=<node>&subtree=1&tier=auto\|suggest&all=1&claim=1` | pending suggestions with the context a reviewer needs; `all` with every determination; `claim` hands out the approved links no page has made |
| `POST /api/l/<id>/links/accept` / `reject` `{ ids, author? }` | link them in one commit, or record them as declined |
| `POST /api/l/<id>/links/decide` `{ ids, link, by }` | record a person's decision made in their own replica |
| `POST` / `GET` / `DELETE /api/l/<id>/links/jobs` `{ scope: "node" \| "library", node?, review? }` | a background scan (reviewed, with `review`): start, progress, cancel |
| `GET /api/l/<id>/links/related?node=`, `/nearby?node=`, `/status` | the Related list, the nearby list a model is given, the scanner's state |
| `GET /api/l/<id>/state`, `/events`, `/branch/<b>`, `POST /api/l/<id>/sync/<b>`; `GET /api/usage`, `POST /api/llm/…` | what the page uses (the model, Wikipedia and usage are shared by every library) |

An outside agent reads and writes with the same ops the keyboard uses:

```sh
curl localhost:4747/api/libraries
curl localhost:4747/api/l/<library id>/nodes/<node id>/tree     # or, in the first library, /api/nodes/<node id>/tree
curl localhost:4747/api/nodes/<node id>/tree
curl localhost:4747/api/ops -H 'content-type: application/json' -d '{
  "author": "my-agent", "message": "Add a remark",
  "ops": [{ "op": "create", "parent": "<node id>", "title": "A remark", "body": "Text." }]
}'
curl localhost:4747/api/links/jobs -H 'content-type: application/json' -d '{"scope":"library"}'
curl 'localhost:4747/api/links/pending?node=<node id>&subtree=1'
curl localhost:4747/api/links/accept -H 'content-type: application/json' -d '{"ids":["…"],"author":"reviewer"}'
```

## Checks

```sh
npm test               # unit tests, and a convergence property test (random concurrent ops, 3 replicas)
npm run e2e            # the page driven from the keyboard in a real browser, with latency measurements
npm run check          # type check
npm run verify         # every prompt sentence traced to a section; every seed commit re-hashed
npm run fixtures render DIR && npm run fixtures check DIR
                       # seeded semantic conflicts with known answers (scripts/fixtures.ts)
```

`scripts/linkEval.ts` measures the link scanner against the hand labels in `tests/fixtures/`.

## Known limits

- There is no access control: the server binds to localhost and trusts whoever can reach it.
- Undoing or reverting a deletion re-creates nodes under new ids: content, anchors and links that
  carry a path are restored; anything else that referred to the old ids is not.
- Semantic conflicts are detected on every sync but resolved by a model only after an explicit
  merge, and only within one top-level tree. Two replicas resolving one conflict at once conflict again.
  Two replicas pointing one link at different targets is left to a person (`1` `2` in history).
- Export cannot hold a note's title, sections under a note, or the prompt sentences the first
  tree's sections cite.
- Two replicas linking the same words both keep their link.
- In history, the top-level nodes a commit touched are placed by where its nodes are now: a commit that
  only deleted names none.
- Articles are shown without images, references or infoboxes.
- Web research: that queries never carry the library's text rests on the agent's instructions,
  not a check, and a cited source is checked to have been retrieved, not to say what was written.

## Third-party material

- `server/links/words.txt`: the first 20,000 words of FrequencyWords `en_50k` (2018, from
  OpenSubtitles) by Hermit Dave, https://github.com/hermitdave/FrequencyWords, filtered to plain
  lower-case words, under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
- Wikipedia text shown in the page is fetched at run time and shown with its attribution, under
  CC BY-SA 4.0. The test articles in `server/wikiMock.ts` were written for the tests.
- The embedding model (bge-small-en-v1.5, MIT) is downloaded at run time, not bundled.
