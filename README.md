# Infinispand

A document you can expand without limit. It opens as an outline of titles; every node, sentence,
phrase and word can be opened further. The first levels are written ahead of time and open
instantly; past them, a model writes the expansion on request. Everything is editable, by you or
by a model, and the tree is versioned like git.

All documents live in one library: a single versioned tree whose root is the library and whose
sections are the documents, so a node can move from one document to another and reading goes from
one to the next without closing anything. The first document is this project describing itself,
grown from the prompt that started it; a set of starter documents (`library/*.md`) comes with it.

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
| `IE_DATA` | `.data` | Where the library and its caches are kept. Delete it to start again from the seed and the starter documents. |
| `IE_LIBRARY` | `library` | Starter documents, each imported once. |
| `IE_USER` | your login name | The name on commits the server makes for you (the page lets you change yours with `/user`). |
| `IE_WIKI` | `live` | `mock`: built-in test articles, no network (the browser tests); `off`: every `/api/wiki/*` route answers 503. |
| `IE_HOSTS` | (none) | Extra host names the dev server answers to, comma-separated. `localhost` and `*.ts.net` (Tailscale) are always allowed. |
| `IE_WIKI_LANG` | `en` | Which Wikipedia. |
| `IE_WIKI_CONTACT` | unset | An email address, an `https://` URL or `User:Name` for the User-Agent of Wikipedia requests. Without it requests are spaced 6.5 s apart (the page says so once, the first time it is slow); with it, 1 s. Nothing else about you is sent. |
| `IE_WEB` | `on` when a model is configured | `off` takes web search and fetch away from the editor agent, whatever the page asks. |
| `IE_WEB_SEARCHES`, `IE_WEB_FETCHES` | `5`, `5` | Searches and page reads one request to the editor may make. |
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
  wherever it was). On a node, `:` hands an instruction to the editor agent; `Esc` stops it.
- `g` opens history: commits, branches, conflicts. `f` shows only what touched the current
  document; `r` reverts the current document to a commit, leaving the rest of the library alone.
- The library is the first page. `l` or `Enter` opens a document in place; `h` or `Esc` at its top
  steps back out. `/` jumps to any section in any document.
- `m` (or a click on the title) opens the documents menu: type to filter, `Enter` opens. `Esc`
  moves to the list, where `n` makes a document, `r` renames, `s` duplicates, `D` deletes (`u`
  brings it back), `x` saves it as a `.md` file and `i` imports one (dropping a file on the menu
  works too). From the command bar: `/new`, `/open`, `/rename`, `/duplicate`, `/export`,
  `/import`. All of these are ordinary edits of the library, made in the browser's replica.
- Edits are saved as they are made; the top bar says `saved` once the server has them all.
- On a window 1600 px wide or more the page opens as panes side by side, after Andy Matuschak's
  notes: the library, the open document, its open sections. Following a link opens its target in
  the next pane; moving back left with `h` closes nothing; `q` closes panes. `v` switches between
  panes and the single column, `/view auto|column|panes` sets it.
- **Forks.** To go two ways from one pane, open the second with `Shift+Enter` (or a Shift-, Ctrl- or
  Cmd-click, or a middle click) on a row, a link, a link in an article, or a "Linked from",
  "Mentioned in" or Related row: it opens beside what is to the right instead of replacing it, and
  the space right of the pane divides into rows, one per fork, top to bottom in the order they were
  opened. Each fork goes on to the right on its own and can fork again. Rows share the height down
  to a third of it each; with more, the rows scroll down (the pane they came from stays at the top),
  keeping the focused one in view. Sideways the whole strip scrolls as one, so a fork always sits in
  the column next to the pane it came from. That pane marks every fork's row, link or words, the
  focused fork's as before and the others lightly. A plain `Enter` or click works as it always has:
  it replaces the focused fork (or, on something already open as a fork of that pane, focuses it);
  with nothing open to the right, a fork is a plain open.
  `[` and `]` move to the fork above and below (in the order the rows are drawn, the nearest first),
  back where you were in it or to its pane nearest your column; a click anywhere in a fork does the
  same. `h` and `l` move along the focused fork, as along a trail. `q` closes the panes right of the
  one being read, every fork among them; with none, it closes that pane and steps left, and in a fork
  that means the whole fork, from where it branched to its end. With one fork left the panes are a
  plain trail again. The forks are kept with the rest of the view, so a reload brings them back; the
  address names the focused pane only. On a window too short or narrow for rows only the focused fork
  is drawn, and its first pane says which fork of how many it is. The column has one page: there a
  modified open is a plain one.

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
  article in a container that is not a document (not listed, never scanned for links, never
  reconciled); the article text stays in the server's cache. Each note records its section, its
  words, a little text either side and the revision; in a later revision it is found again (its
  section first, then anywhere, then ignoring case and punctuation), and if its words are gone it
  is listed at the top of its section as detached, with a link to the old revision. Tables and
  preformatted blocks are shown but cannot be selected; a formula is selected whole.
- To link by hand, select words (`i`, widen with `H` `L`) and press `w`: the picker offers library
  sections and notes, Wikipedia articles and, for a pasted address, the web page. `w` on a link
  retargets it, `D` removes it; `:/link target` and `:/unlink` do the same.
- A link to a deleted node stays in the text, marked broken, with the document and section titles
  it pointed to, so undoing the delete finds it again.

### Links found for you

- Whenever text is written (an edit saved, text a model wrote, a file imported) the server scans it
  in the background: phrases that are another section's title, sections of other documents close in
  meaning, and Wikipedia articles, each checked against the text. These scans ask Wikipedia only
  after anything a person is waiting for.
- What is found is **suggested** (a faint dashed underline). `Tab` reaches suggestions; `y` links
  one, `n` declines it (remembered in the node, on every replica). `S` reviews a document's
  suggestions one by one. `/autolink on` also makes the surest at once, as one commit (`u` takes it
  back); it is opt-in because that tier measured 0.84 precision on unseen documents.
  `/autolink off` scans nothing by itself.
- In the body editor `[[` opens a completer (library titles, then Wikipedia). A bare `[[term]]`
  left in the text is looked up on save.
- Under the node being read, **Related** lists sections of other documents close in meaning.
  `1`–`5` with words selected links them to that row; on the node, goes there.
- `/linkdoc` and `/linkall` scan the document or the library in the background, with progress in
  the status line (`/linkcancel` stops).
- A model writing a note or sections is given a few nearby library nodes and may mark phrases
  `[[phrase]]`; the marks never show and each is checked before it becomes a link. The editor
  agent has a `suggest_links` tool.

How the rule was tuned and measured: [docs/wikipedia.md](docs/wikipedia.md).

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
  request, the document sent with it, or an earlier search or fetch of the run; dynamic filtering
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
  edits pin a node: flagged when stale, never rewritten. The library and its documents are not
  reconciled with each other.
- **Snapshots are patched, not rebuilt**: a change re-reads only the nodes it wrote, so an edit
  costs what it touches, whatever the size of the library.
- **`src/core/repo.ts`** Every commit records the SHA-256 of the tree, so any checkout can be
  verified. Merging is structural (the CRDT) and then semantic: base, ours and theirs are compared
  node by node and what a character merge cannot see becomes a conflict record.
- **`src/llm/`** Prompts and the tasks built on them: expand a selection, deepen a leaf, cascade
  after an edit (a resolver decides how far up), resolve conflicts, and the editor agent, which
  works on a fork and merges back. A prompt carries the focused node's document only.
- **`src/core/ref.ts`, `src/core/links.ts`** Targets, the backlinks index, finding a node target
  again, and `applyLinks`, which links a batch of spans in one commit.
- **`src/core/article.ts`, `src/ui/articleText.ts`** Notes on Wikipedia articles: the article
  nodes, anchors and finding them again in a new revision; an article's HTML as text to select in.
- **`src/core/format.ts`, `seed.ts`, `library.ts`** The text format, writing a parsed tree into the
  library, and the document operations and addresses.
- **`server/`** Relays updates between replicas and persists them (`library.ts`), proxies model
  calls (`claude.ts`, `subscription.ts`, `usage.ts`, `web.ts`), Wikipedia (`wiki.ts`, `wikiHtml.ts`,
  `wikiRoutes.ts`, `wikiMock.ts`), local embeddings (`embed.ts`), link discovery (`links/`), and
  migrates data from older layouts (`migrate.ts`).
- **`src/ui/`** The browser's replica of the library (`session.ts`, kept in IndexedDB), the store
  and keymap, and the page. The panes view's panes are a tree of forks (`forks.ts`, pure functions;
  the store's `trail` is its focused branch).

## The library

On disk:

```
IE_DATA/library/<branch>.loro      the library, one Loro snapshot per branch
IE_DATA/library.json               starter documents already imported
IE_DATA/links/pending.json         link suggestions waiting for a writer (derived)
IE_DATA/vectors/nodes.*            the library's sections as vectors (derived)
IE_DATA/wiki-cache/                Wikipedia answers (derived)
IE_DATA/models/                    the embedding model
```

Each document has a slug, made from its title when it is created and kept on rename, and a title.

| | |
|---|---|
| `/` | the library |
| `/doc/<slug>` | a document |
| `/doc/<slug>/<node id>` | a node in it (the id is what counts: a moved node is still found) |
| `/n/<node id>` | any node |
| `/w/<lang>/<title>` | a Wikipedia article as a page of its own (the column) |

The address follows the focus; opening a document or jumping makes a history entry.

On startup every `library/*.md` whose slug (its file name) has not been imported before is
imported at the end of the library, so a starter document you delete stays deleted. A file that
does not parse is logged and skipped.

A data directory from an older layout (one database per document under `IE_DATA/docs/`, or a
single document at `IE_DATA/*.loro`) is migrated into one library, histories kept, on the first
start that finds no `IE_DATA/library/`; the old files are moved aside unchanged. If a browser still
holds edits to such a document that never reached the server, the page says so and `:/recover`
saves each as a `.md` file.

### The text format

Used for the starter library and for export and import.

```
# Document title

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
^ "a phrase" link -> /fixed-points/Recursion without names/How Y works
^ "nearby" link -> ./A section about something
^ "a quote" link -> /octopus-minds/Arms that decide ^"tastes what it touches"
^ "the web" link -> https://example.org/page "Its title"
```

A `^` line is a note on the section above it, or, indented, on the note above: `^ "quote" form
[lens]: text`, where form is `gloss`, `note` or `passage` and the lens is `elaborate` (default),
`define`, `why`, `example`, `challenge` or any question. The quote must be exact words of the
parent's text (the first occurrence is anchored); a missing quote is an error naming the file,
line, section and quote. A target is `w:Title` (`w.fr:Titre` for another language), a node by its
document's slug and section titles (`./Section` in the same document, `^"quote"` for a note there),
or an `http(s)` address with an optional title. A target containing `: ` is quoted; in a path `\/`,
`\^` and `\\` escape a slash, a caret and a backslash. Wrapped lines join with a space; a line
ending in `\` keeps its break; a text line starting with `#`, `^` or `\` is written with a `\` in
front. Imported documents are written as the model, all reconciled, so nothing starts stale.

Export writes each note with the current text of its anchor; orphaned notes and sections under a
note have no place in the format and are left out and counted. Export then import gives back the
same tree.

### HTTP API

`<branch>` defaults to `main`. Node ids are the library's, so one batch of ops can span documents.

| | |
|---|---|
| `GET /api/tree[/<branch>]` | the whole library as JSON, with conflicts and recent history |
| `POST /api/ops[/<branch>]` | `{ ops, message?, author?, actor? }`, applied as one commit. `create` and `update` take `ref`: `{ "kind": "wiki", "title", "lang" }`, `{ "kind": "node", "id", "doc", "path" }` or `{ "kind": "url", "url", "title" }`; `"ref": null` removes it |
| `GET /api/docs` | the documents, in library order: `{ node, slug, title, excerpt }` |
| `POST /api/docs` `{ title }` | a new blank document |
| `POST /api/docs/import?name=file.md` | body: the file (2 MB at most); 422 with `problems` if it does not parse |
| `GET` / `PATCH {title}` / `DELETE /api/docs/<slug>` | read, rename, delete (undoable) |
| `POST /api/docs/<slug>/duplicate` `{ title }` | a copy of the document |
| `GET /api/docs/<slug>/export[/<branch>]` | the text format; header `x-skipped` counts what was left out |
| `GET /api/docs/<slug>/tree[/<branch>]`, `POST /api/docs/<slug>/ops[/<branch>]` | one document's subtree with its conflicts; ops as above |
| `GET /api/wiki/…` | Wikipedia through the server's cache: `summary`, `article` (`&full=1` for every section), `section`, `senses`, `suggest`, `search`, `lookup` (server/wikiRoutes.ts) |
| `POST /api/links/scan` `{ node }` | scan a node and record what is found as pending |
| `GET /api/links/pending?doc=<slug>&tier=auto\|suggest` | pending suggestions with the context a reviewer needs |
| `POST /api/links/accept` / `reject` `{ ids, author? }` | link them in one commit, or record them as declined |
| `POST` / `GET` / `DELETE /api/links/jobs` `{ scope: "doc" \| "library", doc? }` | a background scan: start, progress, cancel |
| `GET /api/links/related?node=`, `/nearby?node=`, `/status` | the Related list, the nearby list a model is given, the scanner's state |
| `GET /api/state`, `/api/usage`, `/api/events`, `/api/branch/<b>`, `POST /api/sync/<b>`, `POST /api/llm/…` | what the page uses |

An outside agent reads and writes with the same ops the keyboard uses:

```sh
curl localhost:4747/api/docs/tides/tree
curl localhost:4747/api/ops -H 'content-type: application/json' -d '{
  "author": "my-agent", "message": "Add a remark",
  "ops": [{ "op": "create", "parent": "<node id>", "title": "A remark", "body": "Text." }]
}'
curl localhost:4747/api/links/jobs -H 'content-type: application/json' -d '{"scope":"library"}'
curl 'localhost:4747/api/links/pending?doc=tides'
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
  merge, and only within a document. Two replicas resolving one conflict at once conflict again.
  Two replicas pointing one link at different targets is left to a person (`1` `2` in history).
- Export cannot hold a note's title, sections under a note, or the prompt sentences the first
  document's sections cite.
- Two replicas creating documents with the same slug at once both keep it; the first in the library
  wins the address. Two replicas linking the same words both keep their link.
- In history, the documents a commit touched are placed by where its nodes are now: a commit that
  only deleted names none.
- Articles are shown without images, references or infoboxes.
- Web research: that queries never carry the document's text rests on the agent's instructions,
  not a check, and a cited source is checked to have been retrieved, not to say what was written.

## Third-party material

- `server/links/words.txt`: the first 20,000 words of FrequencyWords `en_50k` (2018, from
  OpenSubtitles) by Hermit Dave, https://github.com/hermitdave/FrequencyWords, filtered to plain
  lower-case words, under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
- Wikipedia text shown in the page is fetched at run time and shown with its attribution, under
  CC BY-SA 4.0. The test articles in `server/wikiMock.ts` were written for the tests.
- The embedding model (bge-small-en-v1.5, MIT) is downloaded at run time, not bundled.
