/**
 * Links as the reader sees them: the small mark after linked words (after gwern.net's typed link
 * icons: W for Wikipedia, § for another note in this library, ↗ for the web), the card a popup or
 * an inset shows, a node's own target, the "Linked from" list, and the link picker.
 */
import { Fragment } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { ownerSection, resolveNode } from "../core/links";
import { docOf, isLink, label, type NodeId } from "../core/model";
import { describeTarget, hostOf, parseTarget, validateRef, wikiTitle, type Ref } from "../core/ref";
import { clip, plain } from "../core/text";
import { sameAux, store, type Aux } from "./store";
import type { Sugg } from "./linker";
import { suggest, summary, wikiConfig, type Attribution as Attr, type Suggestion } from "./wiki";

const MARK: Record<Ref["kind"], string> = { wiki: "W", node: "§", url: "↗" };

/** The document a node target is in, for its mark's tooltip. */
function where(r: Ref): string {
  if (r.kind === "wiki") return `Wikipedia: ${r.title}`;
  if (r.kind === "url") return hostOf(r.url);
  const s = store.snap;
  const id = resolveNode(store.snap, r);
  if (!id) return "a note that is gone";
  const d = docOf(s, id);
  return `${label(s, id)}${d && d !== id ? ` · in ${s.nodes[d].title}` : ""}`;
}

/** The mark set after linked words. Not text of the body: it carries no offset and cannot be selected. */
export function LinkMark({ r, id }: { r: Ref; id?: NodeId }) {
  const broken = r.kind === "node" && !resolveNode(store.snap, r);
  return (
    <span class={`lmark l-${r.kind}${broken ? " broken" : ""}`} data-note={id} title={where(r)} aria-hidden="true">
      {MARK[r.kind]}
    </span>
  );
}

/** The licence line every piece of article text carries: who wrote it, under what terms, and what was changed. */
export function Attribution({ a }: { a: Attr }) {
  return (
    <p class="wattr">
      {a.text}{" "}
      <a href={a.url} target="_blank" rel="noopener noreferrer">article</a>
      {a.revisionUrl && (
        <>
          {" · "}
          <a href={a.revisionUrl} target="_blank" rel="noopener noreferrer">this revision</a>
        </>
      )}
      {" · "}
      <a href={a.license.url} target="_blank" rel="noopener noreferrer">{a.license.name}</a>
    </p>
  );
}

/** What a target is, briefly: an article's summary, a node's title, document and first lines, a page's host. */
export function LinkCard({ r, compact }: { r: Ref; compact?: boolean }) {
  if (r.kind === "url") {
    return (
      <div class="lcard l-url">
        <div class="lhead">
          <span class="lmark l-url">↗</span> {hostOf(r.url)}
        </div>
        {r.title && <div class="ltitle">{r.title}</div>}
        <div class="lsub">{clip(r.url, 90)}</div>
      </div>
    );
  }
  if (r.kind === "node") {
    const s = store.snap;
    const id = resolveNode(store.snap, r);
    if (!id) {
      return (
        <div class="lcard l-node broken">
          <div class="lhead"><span class="lmark l-node">§</span> broken link</div>
          <div class="lsub">The note this pointed to is gone{r.path?.length ? `: it was “${r.path.join(" › ")}”${r.doc ? ` in ${r.doc}` : ""}` : ""}.</div>
        </div>
      );
    }
    const d = docOf(s, id);
    const n = s.nodes[id];
    const sec = ownerSection(s, id);
    return (
      <div class="lcard l-node">
        <div class="lhead">
          <span class="lmark l-node">§</span> {d ? s.nodes[d].title : "the library"}
          {sec !== d && n.kind === "note" ? ` › ${label(s, sec)}` : ""}
        </div>
        <div class="ltitle">{label(s, id)}</div>
        {n.body.trim() && <div class="lbody">{clip(plain(n.body), compact ? 160 : 320)}</div>}
      </div>
    );
  }
  const sum = summary(r.title, r.lang);
  return (
    <div class="lcard l-wiki">
      <div class="lhead">
        <span class="lmark l-wiki">W</span> Wikipedia
      </div>
      <div class="ltitle">{sum.state === "ready" ? sum.value.title : r.title}</div>
      {sum.state === "loading" && <div class="lsub">Loading the summary…</div>}
      {sum.state === "failed" && <div class="lsub problem">{sum.message}</div>}
      {sum.state === "ready" && (
        <>
          {sum.value.description && <div class="lsub">{sum.value.description}</div>}
          {sum.value.disambiguation && <div class="lsub">A disambiguation page: it lists the senses of the word.</div>}
          <div class="lbody">{compact ? clip(sum.value.extract, 240) : sum.value.extract}</div>
          <Attribution a={sum.value.attribution} />
        </>
      )}
    </div>
  );
}

/** A link opened in the column: its card set under the paragraph, with what Enter does next. */
export function LinkPreview({ id }: { id: NodeId }) {
  const n = store.snap.nodes[id];
  if (!n?.ref) return null;
  const next = n.ref.kind === "wiki" ? "Enter opens the article · W opens it on Wikipedia" : n.ref.kind === "node" ? "Enter goes there · Back returns" : "Enter opens the page in a new tab";
  return (
    <span class={`inset lpreview l-${n.ref.kind}${store.focus.node === id ? " focused" : ""}`} data-node={id}>
      <LinkCard r={n.ref} />
      <span class="meta lnext">{next}</span>
    </span>
  );
}

/** A node's own target, as a row at the foot of its text (the column; in panes a Wikipedia target is the article itself). */
export function TargetRow({ id }: { id: NodeId }) {
  const r = store.targetOf(id);
  if (!r) return null;
  const focused = sameAux(store.aux, { kind: "target", of: id });
  return (
    <div class={`target-row l-${r.kind}${focused ? " focused" : ""}`} data-target={id}>
      <span class="meta">about</span>
      <LinkCard r={r} compact />
    </div>
  );
}

/**
 * "Linked from": the nodes that link here, each as its section's title and its document. Collapsed
 * to nothing when there are none. The same list, for an article, is "Mentioned in".
 */
export function Backlinks({ ids, title, focusedAt }: { ids: NodeId[]; title: string; focusedAt: (i: number) => boolean }) {
  if (!ids.length) return null;
  const s = store.snap;
  return (
    <section class="backlinks">
      <h3>{title}</h3>
      <ul>
        {ids.map((id, i) => {
          const sec = ownerSection(s, id);
          const d = docOf(s, id);
          const n = s.nodes[id];
          return (
            <li key={id} class={focusedAt(i) ? "focused" : ""} data-linking={id}>
              <span class="bl-title">{label(s, sec)}</span>
              <span class="bl-doc">{d && d !== sec ? s.nodes[d].title : "document"}</span>
              {n.kind === "note" && <span class="bl-quote">“{clip(n.anchors[0]?.text ?? "", 60)}”</span>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** A suggested link, while the focus is on its words: the proposed target with its summary, and what the keys do. */
export function SuggestionCard({ sg }: { sg: Sugg }) {
  return (
    <span class={`inset lpreview suggestion l-${sg.target.kind}`} data-suggestion={sg.id}>
      <span class="meta">suggested link{sg.tier === "auto" ? " (sure)" : ""} · y links · n declines{store.review ? " · s skips" : " · S reviews them all"}</span>
      <LinkCard r={sg.target} compact />
      <span class="meta why">{sg.why}</span>
    </span>
  );
}

/**
 * "Related": sections of other documents close in meaning to this one, derived and never stored.
 * Numbered: with words of this node selected, the number links them to that section; on the node,
 * it goes there.
 */
export function NodeRelated({ id }: { id: NodeId }) {
  const rows = store.relatedShown(id) ? store.relatedOf(id) : [];
  if (!rows.length) return null;
  return (
    <section class="related-list">
      <h3>Related</h3>
      <ul>
        {rows.map((r, i) => (
          <li key={r.node} data-related={r.node}>
            <span class="bl-key">{i + 1}</span>
            <span class="bl-title">{r.title}</span>
            <span class="bl-doc">{r.doc}</span>
            <span class="bl-quote">{r.why}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function NodeBacklinks({ id }: { id: NodeId }) {
  const ids = store.linkedFrom(id);
  const a = store.aux;
  return <Backlinks ids={ids} title="Linked from" focusedAt={(i) => sameAux(a, { kind: "back", of: id, index: i } as Aux)} />;
}

// ---- choosing a target: the picker (w) and the [[ completer in the body editor ----

export interface Choice {
  group: "Library" | "Wikipedia" | "Address";
  label: string;
  sub: string;
  ref: Ref;
}

/** A section of the library as a choice, with the document it is in. */
export function sectionChoice(id: NodeId): Choice {
  const s = store.snap;
  const d = docOf(s, id);
  return { group: "Library", label: s.nodes[id].title || "(untitled)", sub: d && d !== id ? s.nodes[d].title : "document", ref: { kind: "node", id } };
}

/** A Wikipedia title suggestion as a choice. */
export const articleChoice = (w: Suggestion): Choice => ({ group: "Wikipedia", label: w.title, sub: w.description ?? "", ref: { kind: "wiki", title: wikiTitle(w.title), lang: wikiConfig().lang } });

/**
 * Wikipedia's title suggestions for some text, after a pause in typing. A superseded request is
 * abandoned, and the server then never sends it. Empty text asks for nothing.
 */
export function useWikiSuggest(text: string): { q: string; list: Suggestion[]; problem?: string } | null {
  const [found, setFound] = useState<{ q: string; list: Suggestion[]; problem?: string } | null>(null);
  useEffect(() => {
    if (!text || wikiConfig().mode === "off") return setFound(null);
    const ac = new AbortController();
    const timer = setTimeout(() => {
      suggest(text, ac.signal)
        .then((r) => !ac.signal.aborted && setFound(Array.isArray(r) ? { q: text, list: r } : { q: text, list: [], problem: r.message }))
        .catch(() => {});
    }, 250);
    return () => (clearTimeout(timer), ac.abort());
  }, [text]);
  return found;
}

/** The rows of a list of choices, under a heading for each group. A row is taken on click, without taking the focus from the input. */
export function ChoiceRows({ choices, sel, pick }: { choices: Choice[]; sel: number; pick: (c: Choice) => void }) {
  let group = "";
  return (
    <>
      {choices.map((c, k) => {
        const head = c.group !== group ? (group = c.group) : null;
        return (
          <Fragment key={k}>
            {head && <li class="group">{head}</li>}
            <li class={`choice${k === sel ? " selected" : ""}`} data-choice={k} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(c)}>
              <span class={`lmark l-${c.ref.kind}`}>{MARK[c.ref.kind]}</span>
              <span class="t">{c.label}</span>
              <span class="p">{c.sub}</span>
            </li>
          </Fragment>
        );
      })}
    </>
  );
}

/** Sections and notes whose words match, across the library. */
function libraryChoices(q: string, spot: NodeId): Choice[] {
  const s = store.snap;
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const out = store.search(q).filter((id) => id !== spot).slice(0, 6).map(sectionChoice);
  for (const n of Object.values(s.nodes)) {
    if (out.length >= 9) break;
    if (n.kind !== "note" || isLink(n) || !n.anchors.length) continue;
    const text = (n.anchors[0].text || n.anchors[0].quote).toLowerCase();
    if (!terms.every((t) => text.includes(t))) continue;
    const d = docOf(s, n.id);
    out.push({ group: "Library", label: `“${clip(n.anchors[0].text, 50)}”`, sub: `note in ${d ? s.nodes[d].title : "the library"} › ${label(s, ownerSection(s, n.id))}`, ref: { kind: "node", id: n.id } });
  }
  return out;
}

/** w: link the selected words (or the node) to a note in the library, a Wikipedia article or an address. */
export function LinkPicker() {
  const spot = store.picker!;
  const [q, setQ] = useState(spot.text);
  const [i, setI] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const text = q.trim();
  const wiki = useWikiSuggest(/^https?:\/\//i.test(text) ? "" : text);

  const choices: Choice[] = [];
  if (/^https?:\/\/\S+$/i.test(text)) {
    try {
      choices.push({ group: "Address", label: hostOf(text), sub: text, ref: validateRef({ kind: "url", url: text }) });
    } catch {
      /* not an address after all */
    }
  }
  const typed = /^(w(\.[a-z-]+)?:|\.?\/)/.test(text) ? parseTarget(text) : null;
  if (typed && typeof typed !== "string") choices.push({ group: typed.kind === "wiki" ? "Wikipedia" : "Library", label: describeTarget(typed), sub: "as typed", ref: typed });
  choices.push(...libraryChoices(text, spot.node));
  choices.push(...(wiki?.list ?? []).map(articleChoice));
  const sel = Math.min(i, choices.length - 1);
  const apply = (c: Choice | undefined) => {
    if (!c) return;
    store.closePicker();
    store.applyTarget(spot, c.ref);
  };
  const existing = spot.existing ? store.snap.nodes[spot.existing]?.ref : spot.range ? undefined : store.snap.nodes[spot.node]?.ref;
  return (
    <div class="overlay" onClick={() => store.closePicker()}>
      <div class="jump picker" onClick={(e) => e.stopPropagation()}>
        <div class="picker-head">
          {existing ? `Retarget (now ${describeTarget(existing)})` : spot.range ? `Link “${clip(spot.text, 50)}” to…` : `What “${clip(spot.text, 40)}” is about…`}
        </div>
        <input
          ref={input}
          value={q}
          placeholder="Search the library and Wikipedia, or paste an address"
          onInput={(e) => (setQ((e.target as HTMLInputElement).value), setI(0))}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") store.closePicker();
            else if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n") || (e.key === "Tab" && !e.shiftKey)) (e.preventDefault(), setI(Math.min(choices.length - 1, sel + 1)));
            else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p") || (e.key === "Tab" && e.shiftKey)) (e.preventDefault(), setI(Math.max(0, sel - 1)));
            else if (e.key === "Enter") (e.preventDefault(), apply(choices[sel]));
          }}
        />
        <ul>
          <ChoiceRows choices={choices} sel={sel} pick={apply} />
          {!choices.length && <li class="none">{text ? "Nothing matches yet." : "Type to search."}</li>}
          {text && !wiki && wikiConfig().mode !== "off" && !/^https?:/i.test(text) && <li class="none">Asking Wikipedia…</li>}
          {wiki?.problem && <li class="none problem">Wikipedia: {wiki.problem}</li>}
        </ul>
      </div>
    </div>
  );
}
