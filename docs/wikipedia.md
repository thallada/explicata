# Wikipedia and local semantic search

The findings and decisions behind `server/wiki.ts`, `server/embed.ts` and `server/links/` (the model
reviewer that judges what the scanner finds is §9). Sources
were read on 14 November 2026. The Wikimedia rate limits are new this year and its own page calls
them "subject to experimentation and change", so check the links again before relying on the
numbers.

## 1. What an unauthenticated client may do

**Rate limits.** [Wikimedia APIs/Rate limits](https://www.mediawiki.org/wiki/Wikimedia_APIs/Rate_limits)
(last edited 8 Nov 2026). The limits apply per user across the Action API and the REST APIs:

| Client | Requests per minute |
|---|---|
| Unidentified ("no identifying traits beyond IP address") | 10 |
| Unauthenticated browser requests | 200 |
| Unauthenticated bots with a compliant User-Agent | 200 |
| Authenticated, new account or few edits | 200 |
| Authenticated, established editor | 2000 |
| Bot-flagged accounts, Toolforge with compliant UA, granted exemptions | exempt (robot policy still applies) |

The same page says to "limit concurrency to 3 or fewer requests" and to "respect the Retry-After
header on 429 responses". 429 and 503 "typically include Retry-After"; without one, "wait at least
five seconds or use exponential back-off". It mentions no headers that report remaining quota,
and the live responses had none. The limits are not split by endpoint family: one budget covers
the Action API and REST together. The [changelog](https://www.mediawiki.org/wiki/Wikimedia_APIs/Changelog)
dates the rollout: Phase 1 enforcement from 12 Mar 2026, Phase 2 for identified requests from the
week of 28 Apr 2026, and the API Portal (api.wikimedia.org) sunset in June 2026.

**The User-Agent is parsed by machine, and the contact in it decides the tier.**
[User-Agent policy](https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_User-Agent_Policy)
(edited 27 Mar 2026): a client should identify itself "in a way that isn't going to be confused
with many other bots, and supplying some way of contacting you, the operator". The format is
`<client name>/<version> (<contact information>) <library>/<version>`, and the contact is "an
email address, a website, or a wiki user", e.g. `(wikipedia:de; User:DuesenBot)`. On the
[rate-limit talk page](https://www.mediawiki.org/wiki/Talk:Wikimedia_APIs/Rate_limits) WMF staff
explain how it is enforced. A contact the gateway did not recognise "dropped you to the lowest rate
limit tier". The contact must match "the regex used for extracting the contact info", which reads
the parenthesised part as a semicolon-separated list with no spaces inside an element, and only
the last element is used (15 Apr 2026). A client that sent `(wikipedia:en User:Name)` without the
semicolon was throttled after about 500 requests; with the semicolon it ran 2,500 requests at 1/s
without a 429. Browser requests are limited by IP or user id, "not based on the user agent at all".

*Consequence for this app.* The privacy rule (no name, email or host in the UA) and the policy pull
in opposite directions. With no contact, the default UA `Explicata/0.1 (personal knowledge tool)`
should be expected to fall in the 10/min "unidentified" tier. I did not provoke a 429 to check
this. The client therefore spaces requests 6.5 s apart when there is no contact. If the owner sets
`EX_WIKI_CONTACT` to an email address, an `https://` URL or `User:Name`, the UA becomes
`Explicata/0.1 (<contact>)` and the spacing drops to 1 s, a third of the 200/min budget. The
policy does expect a contact. A throwaway address or a wiki user page is enough, and either keeps
the owner's real identity out of the UA.

**maxlag.** [Manual:Maxlag parameter](https://www.mediawiki.org/wiki/Manual:Maxlag_parameter):
`maxlag=5` is the recommended value on Wikimedia wikis. It applies to any `api.php` request:
"Interactive tasks … may omit it. Noninteractive tasks should always use it." A lag error comes
back as HTTP 200 with `error.code = "maxlag"` and a `Retry-After` header. The client sends it on
bulk work only.

**Serial requests and batching.** [API:Etiquette](https://www.mediawiki.org/wiki/API:Etiquette)
(edited 13 May 2026) asks for requests "in series rather than in parallel", says "there is no hard
speed limit on read requests", and recommends `Accept-Encoding: gzip`, the pipe (`titles=A|B|C`)
"whenever possible", and caching.

**Authentication** only raises a new account to the same 200/min a compliant UA already gets (the
2000/min tier needs an established editor account), and Wikimedia Enterprise is overkill for one
user, so neither is used.

## 2. Endpoints used, and why

| Need | Request | Notes |
|---|---|---|
| Batch title check | `GET /w/api.php?action=query&format=json&formatversion=2&redirects=1&prop=pageprops\|description&ppprop=disambiguation&titles=A\|B\|…` | "limited to 50 titles per query, or 500 for those with the `apihighlimits` right" ([API:Query](https://www.mediawiki.org/wiki/API:Query)). The answer has `normalized`, `redirects` (with `tofragment`), and `pages` with `missing`/`invalid`. A disambiguation page carries `pageprops.disambiguation`. The short description is in `description`. Pages are not returned in request order, so inputs are mapped back through normalized → redirects. |
| Senses of a disambiguation page | same, with `generator=links&gplnamespace=0&gpllimit=max` on the one title | One request gives every linked article with its description. "Set" returned 73. |
| Title autocomplete | `GET /w/rest.php/v1/search/title?q=…&limit=…` | Documented for this: "a typeahead search that automatically suggests relevant pages by title" ([REST reference](https://www.mediawiki.org/wiki/API:REST_API/Reference)). Returns title, description and thumbnail, limit 1–100. `action=opensearch` returns empty descriptions on Wikimedia wikis ([API:Opensearch](https://www.mediawiki.org/wiki/API:Opensearch)). `list=prefixsearch` gives titles only. The completion index is "updated once a day" ([Help:CirrusSearch](https://www.mediawiki.org/wiki/Help:CirrusSearch)). |
| Preview | `GET /api/rest_v1/page/summary/{title}?redirect=true` | Extract, description, thumbnail, `revision`, `type: "disambiguation"`. Edge-cached (`s-maxage=1209600`), so it is cheap for Wikimedia. rest_v1 is RESTBase, which is being retired: there is no date for `page/summary` ([RESTBase/deprecation](https://www.mediawiki.org/wiki/RESTBase/deprecation)). The client falls back to `prop=extracts\|pageimages\|description\|info` if it disappears. |
| Article by section | `GET /w/api.php?action=parse&page=…&redirects=1&prop=text\|tocdata\|revid\|displaytitle\|properties&disableeditsection=1&disablelimitreport=1&disabletoc=1` | One request for the whole page (Octopus: 480 KB raw, 69 KB after sanitising), split on the server at `div.mw-heading` boundaries and cached for 7 days. A section then costs nothing. `prop=sections` now warns "deprecated … use prop=tocdata". With `section=N`, both come back empty, so the section list cannot be had alongside one section's text. REST `/page/{title}/html` (Parsoid, with `<section>` wrappers) also works; the splitter flattens either. |

Two route parameters (`server/wikiRoutes.ts`) shape the answers for the UI. `article?full=1`
returns every section's sanitised HTML along with the section list and the `disambiguation`
flag (read from `prop=properties`), so a whole article costs the browser one request and the
server at most one. `summary?cached=1` answers from the server's cache only, fresh or expired,
and never waits on Wikipedia: 404 `reason: "uncached"` when nothing is cached. The UI uses it to
put a summary in a model prompt without delaying the prompt.

What gets stripped (seen in real output): inline `<style>` (TemplateStyles), `sup.reference`
markers, the reference list, COinS spans (`Z3988`), navboxes, infoboxes, sidebars, hatnotes,
clade tables, the hidden short description, edit links, maintenance boxes and `noprint`. Images
are dropped: each file has its own licence, and the browser would load them from
upload.wikimedia.org. MathML is kept, because the parser now emits native MathML and browsers
render it.

**Services not used.** The Link Recommendation API ("Add a link") takes an existing article, not
arbitrary text, and is scheduled for deprecation from July 2026; its underlying idea (anchor
dictionary and link probability) is the right one, see §4. CirrusSearch's semantic search is an
internal, undocumented path. The Wikidata Embedding Project searches Wikidata items, is in alpha,
and would send node text off the machine. `wbsearchentities` adds nothing over `search/title`.

## 3. Licence and attribution

Article text is CC BY-SA 4.0 (and GFDL where applicable)
([Reusing Wikipedia content](https://en.wikipedia.org/wiki/Wikipedia:Reusing_Wikipedia_content)).
When text is shown in the app it must carry:

- **Credit**: "a hyperlink or URL to the page(s) being reused" is acceptable. The client gives the
  article URL and a permanent link to the revision shown (`oldid`).
- **Licence notice**: name the licence and link to it
  (https://creativecommons.org/licenses/by-sa/4.0/).
- **Modifications**: one "must indicate in a reasonable fashion that the original work has been
  modified". We remove references, boxes and images, so `article()` returns
  `attribution.modified` and an `attribution.text` that says so.
- **Share-alike** applies to modified article text that is redistributed. If a node quotes or adapts
  article text and that text is exported or shared, that part is CC BY-SA. Linking to an
  article and writing your own prose about it is not affected.
- **Images** each have their own licence and need their own credit. This is why they are dropped.

The UI must show `attribution.text`, with its links, next to every pane of article text, and next
to summary extracts too.

## 4. Decision: live API with a disk cache; no local title index

Measured on two real nodes from `library/` (§6): **2 lookup requests per node of 80–100
candidates**, about 25 % of them found. Arithmetic, with spacing 1 s (contact set) or 6.5 s (none):

| Work | Requests | Time with contact | Time without |
|---|---|---|---|
| One edited node, cold: ≤ 100 phrases → 2 batches, plus 0–4 `senses` | 2–6 | 2–6 s | 13–40 s |
| Same node rescanned | 0 | 0 | 0 |
| Autocomplete while typing a link (debounced, superseded requests aborted unsent) | 3–6 per link | ≤ 1/s | unusable, see below |
| Open an article (whole page, then sections free) | 1 | 1 s | 6.5 s |
| Bulk pass, 600 nodes × 60 phrases = 36,000; assume half unique → 18,000 → 360 batches, plus ~600 `senses` | ~1,000 | ~17 min | ~1.8 h |
| Bulk pass, 5,000 nodes (unique phrases grow sub-linearly; say 120,000) → 2,400 batches, plus ~3,000 `senses` | ~5,400 | ~1.5 h | ~10 h |

At 1 request a second the client uses 30 % of the 200/min budget, serially, with interactive calls
jumping ahead of bulk ones. A local title index is not needed for these volumes. The
`all-titles-in-ns0` dump is 110 MB gzipped, and it has no redirect targets, disambiguation flags or
descriptions: for those you also need `page_props` (486 MB) and `redirect`. Building one would
replace a few hundred cached requests with a gigabyte of downloads and a weekly refresh.

What would make it necessary:

1. The client stays in the 10/min tier (no contact can be given) and bulk passes over thousands of
   nodes must finish in minutes.
2. Matching every n-gram of every node, rather than an extracted list of candidates: that means
   10⁵–10⁶ lookups per pass.
3. Link-worthiness statistics, which the API does not provide: how often a phrase is used as link
   text on Wikipedia (keyphraseness or link probability), and which target it usually points to
   (commonness). That is the real case for a local dataset: an anchor-text dictionary built from
   the pagelinks/linktarget dumps (7.2 GB and 1.5 GB gzipped), or the "Add a link" model's anchor
   tables. It would replace most of the per-phrase checking, not just speed it up.
4. Needing to work offline for long periods.

**Autocomplete without a contact.** At 6.5 s spacing, server-side autocomplete is slow: set
`EX_WIKI_CONTACT`. (Calling `search/title` from the browser would be the "unauthenticated browser"
tier, 200/min per IP; not done.)

## 5. What makes a good candidate (from the demonstration)

- **Batching makes candidates almost free, but most raw n-grams miss.** 57 of 80 and 75 of 80 in the
  first run. Every candidate checked costs 1/50 of a request, so over-generating is fine, but a
  per-node cap of 80 crowded out the single nouns that mattered (*octopus*, *cephalopod*,
  *nautilus*). The extractor should rank noun phrases above arbitrary trigrams.
- **Single common words resolve to junk or to disambiguation pages.** "itself" → *Reflexive
  pronoun*, "repeated" → *Rerun*, "twice" → *Twice (South Korean girl group)*, "quickly" →
  *Quickly (Bubble tea chain)*. 38 of 95 hits in the second run were disambiguation pages, nearly
  all of them ordinary words ("small", "clever", "split").
- **Case matters past the first letter.** Titles are case-sensitive after the first character:
  "Y combinator" is a disambiguation page, while "Y Combinator" is the company. Keep the text's own
  casing, and use `search/title` (case-insensitive) as a second try for multi-word misses.
- **Plurals mostly resolve through redirects**: "fixed-point theorems" → *Fixed-point theorem*,
  "cephalopods" → *Cephalopod*. Trying a singular form is a cheap extra candidate.
- **Embedding fit separates senses well.** Each candidate was scored by the cosine between the
  node text and "Title: short description" (bge-small):
  - *Fixed point* senses: *Fixed point (mathematics)* 0.83, then *Fixed-point arithmetic* 0.65 and
    *Triple point* 0.62.
  - *Y combinator*: *Fixed-point combinator* 0.75 against *Y Combinator* (the company) 0.50.
  - "set" in a maths sentence: *Set (mathematics)* 0.66, tied with *Category of sets*; *Set
    (deity)* ranked 55th of 73 at 0.48.
  - Among direct hits in the octopus node, right senses scored 0.60–0.74 (*Octopus*, *Cephalopod*,
    *Squid*, *Nautilus*, *Neuron*). Wrong ones scored 0.34–0.51 (*Fat fetishism* for "gaining",
    *Twice*, *Quickly*, *Arriving* the album).

  A threshold near 0.6 for this model separates most of them. Junk such as "therefore" → *Logical
  consequence* (0.52) sits just below it, so fit alone does not decide whether something is worth
  linking. Combine it with a link-worthiness prior (§4.3) or a rule of noun phrases only.

## 6. Measured on this machine

24 live requests in total: 6 raw probes, and 18 through the client with the generic UA, serial,
6.5 s apart. There were no 429s.

- Node *fixed-points* (201 words, 80 candidates): 2 requests, 23 found, 12 of them disambiguation
  pages. Node *octopus-minds* (145 words, 80 candidates): 2 requests, 5 found. A second extraction
  (326 words, 100 candidates, single words first): 2 requests, 95 found.
- Repeat scan of both nodes, plus a repeat summary, article and suggest: **0 requests** (196 cache
  hits).
- Embeddings: `Xenova/bge-small-en-v1.5`, q8 ONNX, **34 MB** on disk, 384 dimensions, MIT. Load
  0.6 s from cache, 1.5 s including the download. With 4 threads (the default,
  `EX_EMBED_THREADS`): **43 paragraphs/s** for ~110-word paragraphs and **450 short strings/s**;
  with 8 threads, 61/s and 575/s. Process RSS is about 560 MB once loaded. The 600-node library
  embeds in about 15 s. `all-MiniLM-L6-v2` (Apache-2.0, 23 MB) is about 1.3× faster but separates
  senses less clearly.

**Choice of model.** bge-small-en-v1.5 is MIT-licensed, has a 512-token window, has a good MTEB
score for its 33M parameters, and is a first-class transformers.js model. Larger models were
considered and set aside:

- `jina-embeddings-v5-text-small` (Feb 2026, MTEB-en 71.7) is **CC BY-NC 4.0** and 0.6B parameters.
- EmbeddingGemma-300m is under the Gemma terms and is 10× larger.
- Qwen3-Embedding-0.6B is Apache, but has about 18× the parameters; its CPU speed was not measured.

`EX_EMBED_MODEL=Snowflake/snowflake-arctic-embed-xs` (Apache-2.0) is a drop-in alternative.

## 7. Caches

`<EX_DATA>/wiki-cache/<lang>/titles.json` (found 30 d, missing 3 d), `small.json` (summaries 14 d,
senses 14 d, suggest 1 d), `articles/` (7 d). Vectors, per library: `<EX_DATA>/libraries/<id>/vectors/<name>.json`
and `.f32`. An expired entry is still served, marked `stale`, when the network is down. The
variables that configure all this are in the README.

Notes on articles (src/core/article.ts) rely on this cache and add nothing to it: an article is
re-read through `article?full=1`, whose answer always carries `revisionId` and `pageId` (a
`summary` may not). A note records the revision it was made against; when the cached copy expires
(7 d) and Wikipedia has a newer revision, the note is found again in it, or shown as detached with
a link to the old revision. The browser keeps articles in
memory for the page's life only, never in IndexedDB.

## 8. Link discovery as built

`server/links/` (README "Links found for you" says what the writer sees). A scan of one node:

1. **Candidates** (`extract.ts`). Runs of content words, cut at punctuation, function words, a
   possessive, `code` and existing links; every span of one to four words of a run, in the text's
   own casing, with a singular variant. Proper names (capitalised away from a sentence's start, or
   capitalised again elsewhere in the text, or followed by another capital) and multi-word spans
   are always candidates; a single lower-case word only when its rank in the bundled frequency list
   (`words.txt`, 20,000 words from FrequencyWords/OpenSubtitles, CC BY-SA 4.0) is past 6,000. A
   phrase may not end on a verb form. `[[marks]]` are forced candidates. Measured on the sample:
   16 distinct phrases per section on average (986 for 60 sections), so one lookup request per
   node scanned alone, a third of one when a job batches nodes together.
2. **Library titles**: a phrase equal (normalised: case, plurals, hyphens, a leading article) to a
   section's title of up to four words, never the node itself or an ancestor; sections in other
   top-level trees preferred.
3. **Meaning**: the library's sections in a vector index, re-embedded only when their text hash
   changes (patches only mark nodes; the embedding runs later, off any request). Sections in other
   top-level trees at cosine ≥ 0.78 become a link only where a phrase here names them; otherwise they are
   the derived **Related** list.
4. **Wikipedia**: through the client's serial queue in its own lane: a person's requests (an
   article, a preview) first, background jobs next, the scans that follow edits last (a scan that
   has waited 30 s goes ahead of a job). One batched lookup; at most two disambiguation pages a scan resolved by fit, at
   most one title search for a multi-word miss; every hit scored by cosine between the node in its
   top-level tree and "Title: description".
5. **Tiers** (`judge()` in `scan.ts`): each kind of phrase has its own bar, and `auto` needs the
   phrase's form to vouch for it as well as the fit:

   | | auto (applied unasked) | suggest |
   |---|---|---|
   | term (several words) | exact title, one word ranked ≥ 6,000, fit ≥ 0.55 | fit ≥ 0.60 (0.65 for a redirect) |
   | name | exact title, not an ordinary word (rank < 1,000 is dropped), a single word only if unlisted; fit ≥ 0.55 (0.60 single) | fit ≥ 0.60 |
   | one word | rank ≥ 15,000, exact title, fit ≥ 0.70 | rank ≥ 8,000, fit ≥ 0.64 |
   | library title | a title of several words, fit (node to node) ≥ 0.72 | same top-level tree ≥ 0.64 (any title); another tree only a multi-word or rare title |
   | never auto | a sense chosen by fit (suggested for names and terms with a 0.04 margin), a searched title, a one-word section title ("The comma"), a concept already mentioned in an earlier section of the same top-level tree (applied once per tree, where it first appears; later mentions only suggested), a concept central to the tree (in its title or in 30 % of its sections: linked once, at its first mention, suggested) | |
   | dropped | countries, surname and list pages, articles about a film, album, band… | |

   With a phrase matching both a section and an article, the section wins. Then first mention per
   node, no overlaps, three links a paragraph counting existing ones, the strongest kept, and a word
   already linked inside a longer phrase in the node ("beryllium" beside "beryllium-8") not again.
   Without embeddings nothing is applied unasked; the strongest are suggested.

**Evaluation** (`scripts/linkEval.ts`). Tuning sample (`tests/fixtures/link-labels.json`): the
first 16 sections with 40 words or more of *Octopus minds*, *Fixed points*, *Where the elements
come from* and *The invention of writing* (64 sections; 444 labelled phrases, 165 worth linking,
13 of them to a different target than the scanner found), plus 12 sections of *Tuning and
temperament*, first used as a held-out set and then looked at, so no longer held out. Every
phrase the scanner resolved was labelled by hand as a careful Wikipedia editor would link
(MOS:LINK: no everyday words, no countries, a tree's own subject once).

Fresh held-out set (`tests/fixtures/link-labels-heldout.json`): 16 sections each of *The
Antikythera mechanism*, *The one merger* (the eukaryotic cell), *The tides* and *What a proof is*
(64 sections). It was labelled from the text alone, by a forked copy of the agent, before the
scanner had ever run on those trees: an exhaustive list of the 165 phrases worth linking, each
with its acceptable targets, so a link not on the list counts as wrong (closed-world scoring;
`linkEval.ts heldout`). The rule was frozen before it was scored, and was scored once.

Live requests: 299 in all, serial, 6.5 s apart (no contact), no 429s.

| | auto: precision | recall | auto + suggest: precision | recall |
|---|---|---|---|---|
| tuning sample (4 trees), first rule | 0.962 (50/52) | 0.303 | 0.809 (89/110) | 0.539 |
| *Tuning and temperament*, first rule | 0.818 (9/11) | 0.321 | 0.650 (13/20) | 0.464 |
| tuning sample, final rule | 1.000 (32/32) | 0.194 | 0.826 (90/109) | 0.545 |
| *Tuning and temperament*, final rule (looked at before) | 1.000 (5/5) | 0.179 | 0.700 (14/20) | 0.500 |
| **fresh held-out set (4 trees), final rule** | **0.844 (27/32)** | **0.164** | **0.577 (56/97)** | **0.339** |

The final rule adds two form rules that the errors pointed to: a concept is applied unasked only
where it is first mentioned in its top-level tree (later mentions are suggested), and a one-word
section title is only ever suggested. A word already linked inside a longer phrase is no longer
linked again on its own (the "beryllium" beside "beryllium-8" error). On the fresh set the five
wrong autos were: "front dial" → the section *The front dial* (a real section of the same tree the
labeller did not list); "linear chromosomes" → *Linear chromosome* (label: *Chromosome*);
"complex traits" → *Complex traits* (a genetics article for an ordinary phrase); "Asgard archaea"
→ *Asgard archaea* (label: *Asgard (archaea)*; arguably right); "northern hemisphere" →
*Northern Hemisphere* (well known, not listed). With 32 decisions the precision estimate is
loose, but it is under 0.95, so the default became **`/autolink suggest`**: nothing is written
without the writer's say; `/autolink on` is an opt-in. The rule was not tuned against the fresh
set. (The default is now `/autolink review`, §9: a model judges each candidate first.)

Representative decisions of the first rule (tuning sample unless marked):

- right, auto: "fixed-point theorems" → *Fixed-point theorem* (fit 0.81); "Cephalopod eyes" →
  *Cephalopod eye* (0.81); "cuttlefish" → *Cuttlefish* (0.73); "Uruk" → *Uruk* (0.70); "white dwarf"
  → *White dwarf* (0.71); "tablets" → the section *The tablet* in the same tree (0.81);
  *Tuning and temperament*: "Andreas Werckmeister" → *Andreas Werckmeister* (0.71), "syntonic comma" → *Syntonic
  comma* (0.73).
- right, suggest: "incompleteness theorem" → *Gödel's incompleteness theorems* (redirect, 0.76);
  "helium nuclei" → *Alpha particle* (0.67); "Shang" → *Shang dynasty* (0.70).
- wrong, auto: "fixed-point theorem" in a later section of *Fixed points* (labelled not worth a
  second link); "beryllium" in a section that also links "beryllium-8"; *Tuning and temperament*: "Pythagorean" →
  the section *Pythagorean*.
- wrong, suggest: "mammal" → *Mammal*, "joints" → *Joint*, "pigment" → *Pigment* (ordinary words
  that fit the text); "unprovable" → *Independence (mathematical logic)*; "Arabic" → *Arabic* where
  the label wanted *Arabic alphabet*.
- rightly dropped: "Bang" → *Explosion* (a sense; "Big Bang" was linked); "Sun" (rank 830);
  "Iraq" (a country); "Hoyle" → a surname page; "concealment" → *Oecophoridae* (moths), fit 0.59.

**Cost.** A node scanned alone, cold: one lookup plus 0–3 sense or search requests (median 2 on
the sample), so 1–4 requests: 7–26 s without a contact, 1–4 s with one. Warm (cached): 0 requests,
46 ms median, 580 ms max per section with the real model (scan time includes embedding the
context and any new "Title: description" strings). Embedding the 252 sections of the starter
library: 3.8 s in the evaluation script; in the server on a first start, 318 sections in 6.8 s on
the worker thread, while `/api/state` kept answering in about 1 ms. A bulk pass over the owner's ~600 nodes should take
about 10,000 phrases → ~200 lookups plus ~1 sense or search per node, ~800 requests: ~85 min
without a contact, ~14 min with one (estimated from the sample, not run).

## 9. The model reviewer

The scanner over-generates on purpose (§5), and its `suggest` tier is right about half the time
(0.58 on the fresh set). A one-off model reviewer, run outside the app over a bulk pass of the
owner's library, accepted about 64 % of `auto` and 17 % of `suggest` candidates, and its errors were
the scanner's known blind spots: a parent linked to its own child or sibling, a second mention of
something linked nearby, everyday words and household names, a fragment of a longer name, the wrong
sense or the wrong person of the same name, a library section matched on its title alone, and the
first tree's own quoted prompt. That reviewer is now built in (`server/links/review.ts`), and
**`/autolink review`** is the default whenever a model is configured.

**Flow.** After a scan (an edit saved, `/linkhere`, `/linkall`) the candidates nobody has judged
go to the configured model in batches of up to 60, grouped by top-level tree and section. Each proposal
carries its sentence, the section's title and path, the target's title and short description (and
the first sentence of its summary when the cache has one, never a new request), and for a library
target how it stands to the section (subsection, parent, sibling, elsewhere in its tree, in
another tree); each tree's heading lists what is already linked in it, and each section
heading what is linked there. The model has no tools; it returns, by structured output, a verdict
(link or not) and a reason of at most twelve words per proposal. The system prompt names each
blind spot above as a reason to reject. Verdicts are stored with the suggestion in
`EX_DATA/libraries/<id>/links/pending.json` (each library its own), keyed by node, phrase and target rather than by offsets, so a
suggestion found again by a later scan keeps its verdict and is never sent twice. Rejected phrases
are skipped by later scans of that node, as declined ones are.

**Applying.** The approved links are handed once to the page that asked (a scan's answer, or a
job's list fetched with `claim=1` when it ends), which makes them in its own replica as one commit
by "reviewer", tagged `review`, so history shows them and `u` takes them back. Undone, they are
offered as suggestions again. A person's decisions (`y`, `n`, a removed link) are recorded in the
library as before (a link, or the phrase in the node's `nolink`) and on the server, so the links
list can say who decided.

**Cost.** A node scanned after an edit costs at most 2 calls (`SCAN_CALLS`), almost always 1, and
none when nothing new was found. A `/linkhere` or `/linkall` job costs ⌈N / 60⌉ calls for N new
candidates, at most `EX_REVIEW_CALLS` (default 50, so 3,000 candidates); the status line counts
them, and a second run asks nothing about what the first judged. Every call uses the configured
model (`EX_MODEL`) at effort `low`: the app has no per-task model setting, and none was added.

**Falling back.** With no model (`EX_LLM=off`), when a call fails (a limit reached, the network
gone), or when a job reaches its cap, nothing unreviewed is applied: what is left stays pending, is
drawn as suggestions and listed under *pending*, and the status line says why ("Not reviewed (the
reviewer failed: …)").

**Earlier data.** The pending file keeps the shape it had; entries written before verdicts existed
read as pending. Declines already in nodes (`nolink:`) are listed as rejected; those whose target
was not kept show the phrase alone. Links already in the text are listed as linked, with no reason.

**Not measured.** The built-in reviewer has not been scored against the labelled sets
(`scripts/linkEval.ts`); the 64 % and 17 % above are the one-off reviewer's acceptance rates on the
owner's library, not precision. The tests use a mock whose verdicts follow a fixed rule.
