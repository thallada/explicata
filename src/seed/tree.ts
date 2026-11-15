import type { SeedNode } from "./types";

/**
 * The pre-generated tree: Infinispand describing itself.
 * The root's body is src/seed/prompt.txt, verbatim; each top-level section's
 * `src` lists the prompt sentences it traces back to.
 */

/** Join paragraphs. */
const P = (...paras: string[]): string => paras.join("\n\n");

export const seed: SeedNode[] = [
  // ───────────────────────────────────────────────────────────── 1
  {
    title: "Expansion by depth",
    src: [
      "For example, with something like a design doc: the top level is a simple bulleted list outline of broad topics.",
      "Basically a table of contents.",
      "Some N number of top levels would be pre-written by the LLM ahead of time.",
      "The second level would be general summaries of the level selected above.",
      "Another level would be the topic explained in a significant step in density further.",
      "Individual sentences or even whole paragraphs could be drilled down into.",
      "You could keep going like this endlessly recursively, but once you keep clicking down further to expand paragraphs at a deeper level, past what was pre-generated then the LLM would take over and start generating those expansions.",
      "This would be necessary for user selections that weren’t covered by the pre-generations like highlighting certain sentences, phrases, or words.",
      "In general level of detail expands further but the length of the text generated at a deeper level isn’t necessarily deeper.",
    ],
    body: "A document opens as an outline of titles. Opening a node shows its body and the titles of its children, and each level down is a step denser than the one above. The first levels are written ahead of time and open instantly; past them, or on any selection of text, the model generates the expansion on request. Going deeper makes the text more specific, not longer.",
    notes: [
      {
        quote: "a step denser",
        form: "note",
        lens: "define",
        body: "Density here means claims per sentence. A summary says that merges are automatic; the level below says which algorithm makes them so.",
      },
    ],
    children: [
      {
        title: "Levels of a node",
        body: P(
          "A collapsed node is its title and nothing else. Open, it shows its body and, beneath it, the titles of its children, themselves collapsed. The root is therefore a table of contents. One level down, each entry is a general summary; the level below that restates the topic a significant step denser, with mechanisms, names and numbers where the summary only gestured.",
          "The same two states repeat at every depth, so there is one gesture to learn. A body is written as the summary of the children beneath it, which is why opening a child never contradicts what was just read, only sharpens it.",
        ),
        notes: [
          {
            quote: "collapsed node",
            form: "gloss",
            lens: "define",
            body: "one showing only its title; body and children exist but are not drawn",
          },
          {
            quote: "A body is written as the summary of the children beneath it",
            form: "passage",
            lens: "elaborate",
            body: P(
              "This is an invariant, not a habit of style. Every claim in a parent's body should be supported by something in its children, and a check run by a fresh model tests exactly that. When an edit breaks the invariant, the parent is marked stale and not left quietly wrong.",
              "The reverse does not hold: children say much that the parent omits. That asymmetry is what makes the parent a summary.",
            ),
            notes: [
              {
                quote: "marked stale",
                form: "note",
                lens: "elaborate",
                body: "Staleness is recomputed from hashes whenever the tree changes. The section on editing and regeneration describes how.",
              },
            ],
          },
        ],
      },
      {
        title: "Pre-generated depth",
        body: "The first three levels of sections, and a scattering of notes on their text, are written by the LLM before the reader arrives. Opening them makes no request to a model: the budget from keypress to paint is 50 ms. A span of text that already carries a note is marked with a dotted underline, the only sign of where the pre-written material lies.",
        notes: [
          {
            quote: "50 ms",
            form: "note",
            lens: "why",
            body: "Below roughly 50 ms a response still reads as caused by the keypress. Much past that it reads as the machine answering, and the reader starts waiting instead of reading.",
          },
          {
            quote: "dotted underline",
            form: "gloss",
            lens: "define",
            body: "Gwern's mark for a link with an annotation behind it",
          },
        ],
      },
      {
        title: "Generation on demand",
        body: "The model writes what was not written ahead of time. `e` on a leaf section asks for child sections; `e` on a selected sentence, phrase or word asks for a note anchored to that span, read through one of several lenses. The text streams in, and the request carries the path from the root as cached context.",
        children: [
          {
            title: "Deepening a leaf",
            body: "A leaf is a section with no child sections. Pressing `e` on one asks the LLM to write them: a handful of titled children, each a step denser than the leaf's own body. They are committed to the tree like any other edit, so the next reader finds them already there. This is the sense in which the document has no bottom; every leaf is one keystroke from not being a leaf.",
            notes: [
              {
                quote: "no bottom",
                form: "note",
                lens: "challenge",
                body: "In practice the bottom is wherever the model stops having anything specific to add. Past that point expansions restate instead of deepening, and the right move is to stop pressing `e`.",
              },
            ],
          },
          {
            title: "Expanding a selection",
            body: "In sentence or word grain, `e` on any selection asks for a note anchored to exactly that span. This covers what pre-generation cannot: any sentence, phrase or word the reader happens to care about. The request is made through a lens. The default is elaborate; the others are define, why, example and challenge, and a free-form question typed in the command bar serves when none of the five fits.",
            notes: [
              {
                quote: "a lens",
                form: "gloss",
                lens: "define",
                body: "the question asked of the selected text; it shapes the answer, not the topic",
              },
              {
                quote: "challenge",
                form: "note",
                lens: "elaborate",
                body: "Challenge asks for the strongest objection to the selected claim. It is the lens most likely to change the document instead of lengthening it.",
              },
            ],
          },
          {
            title: "Context and latency",
            body: "Generated text streams into place as it is produced, with a budget of under one second to the first token. Each request carries the ancestor path, root to node, together with the outline of the whole document, sent as cached context so that repeated requests in the same region do not pay for it twice. Speculative generation is optional: when enabled, focusing a sentence starts generating its expansion before it is asked for.",
            notes: [
              {
                quote: "sent as cached context",
                form: "note",
                lens: "why",
                body: "The path tells the model what has already been said above this point, so the expansion can add to it instead of repeating it. Caching pays because that prefix is identical for every request made under the same node.",
              },
              {
                quote: "Speculative generation is optional",
                form: "note",
                lens: "why",
                body: "It spends tokens on sentences the reader may never open, so it is off unless asked for.",
              },
            ],
          },
        ],
      },
      {
        title: "Deeper, not longer",
        body: "Depth changes resolution, not length. A note on a single word may run to six words; a section three levels down is no longer than the one at the top, only narrower in what it covers and more exact about it. Each request tells the model which form it is writing for and asks it to add only what the text above leaves out.",
        notes: [
          {
            quote: "Depth changes resolution, not length.",
            form: "passage",
            lens: "elaborate",
            body: P(
              "The failure this guards against is the expansion that grows by padding: the same claim restated with more adjectives, then again with an example nobody asked for. A reader who descends three levels into such a document has read the first level three times.",
              "The alternative is to treat each level like a map at a larger scale. The sheet of paper stays the same size; the territory it covers shrinks, and the detail that was below the threshold at the previous scale appears.",
            ),
            notes: [
              {
                quote: "a larger scale",
                form: "gloss",
                lens: "define",
                body: "in the cartographer's usage: more zoomed in",
              },
            ],
          },
        ],
      },
    ],
  },

  // ───────────────────────────────────────────────────────────── 2
  {
    title: "Display forms",
    src: [
      "You can click on any of these to “expand” out that section (this could be shown visually different ways: accordian expand inline, open new sidebar to the right, a big giant pannable canvas with card to the right).",
      "The way concept expansion should be displayed visually should vary depending on the depth of the resulting expansion: a simple word definition for example could be expanded inline within the text, something a bit longer may opt for a more like a footnote .",
    ],
    body: "How an expansion is shown depends on the size of what was expanded. One to three words get an inline gloss, a phrase or sentence gets a sidenote, several sentences get an inset passage, and a whole node gets child sections. A note is itself a node, so any of these can be expanded again.",
    notes: [
      {
        quote: "depends on the size of what was expanded",
        form: "note",
        lens: "why",
        body: "The prompt asks for this directly: a word definition inline, something longer as a footnote. The size of the selection is the cheapest available predictor of the size of the answer.",
      },
    ],
    children: [
      {
        title: "Gloss",
        body: "A selection of one to three words becomes a gloss: a definition of a dozen words or so, set inline directly after the term. It does not interrupt the sentence so much as lengthen it, and closing it restores the sentence exactly.",
        notes: [
          {
            quote: "a gloss",
            form: "gloss",
            lens: "define",
            body: "originally a translation written between the lines of a manuscript",
          },
        ],
      },
      {
        title: "Sidenote",
        body: "A phrase or a single sentence gets a sidenote: one to three sentences in the right margin, level with the text they are anchored to. Where two sidenotes would overlap they are pushed apart. On a narrow screen there is no margin, and the sidenote is set inset beneath its paragraph instead.",
        notes: [
          {
            quote: "pushed apart",
            form: "note",
            lens: "elaborate",
            body: "Gwern's layout moves the lower note down by half the overlap and pushes the ones above it up by the other half. The effect is that a crowded passage keeps its notes centred on it.",
          },
        ],
      },
      {
        title: "Passage",
        body: "Several sentences, or a whole paragraph, get a passage: one or two paragraphs set inset beneath the paragraph they expand. It is the form for an expansion that needs room to make an argument, and the largest that still belongs to a particular stretch of text and not to the outline.",
      },
      {
        title: "Sections and recursion",
        body: "Expanding a whole node produces child sections, which appear in the outline beneath it. Every other form is a note, and a note is a node like any other: it has a body, and its body can carry notes of its own. A sidenote can therefore be expanded again, and a passage can hold a gloss. The form is fixed from the size of the selection before generation starts, so text does not change place while it streams.",
        notes: [
          {
            quote: "does not change place while it streams",
            form: "note",
            lens: "why",
            body: "The alternative, choosing the form from the length of the answer, would mean starting inline and jumping to the margin when the answer ran long.",
          },
        ],
      },
    ],
  },

  // ───────────────────────────────────────────────────────────── 3
  {
    title: "Editing and regeneration",
    src: [
      "Another key element to this is that users can actually add, modify, or delete a “node” to the tree.",
      "So they could expand the document in directions that it didn’t originally go in.",
      "When this happens, the parent node may need to be “re-calculated” by an LLM to account for the modifications of it’s children.",
      "This may need to cascade up the tree N number of levels: to be determined by a resolver LLM.",
      "The same goes for the other direction.",
      "Modify a node and all of it’s rendered children should also be recalculated.",
      "For modifying nodes it should be possible to lean on LLMs for editing.",
      "I should be able to request a change through a prompt and have the LLM edit for me.",
      "The LLM editor should also have the capability and agency to do the same CRUD operations on the information tree that a user has: create, replace, update, delete nodes.",
    ],
    body: "Readers can add, change, move and delete nodes, by hand or by asking an LLM editor that has the same operations. An edit leaves the nodes around it stale: its parent in one direction and its children in the other. Staleness is computed from hashes, a resolver LLM decides how far up a rewrite must go, and nothing a human wrote is overwritten.",
    notes: [
      {
        quote: "stale",
        form: "gloss",
        lens: "define",
        body: "no longer consistent with the text it was derived from",
      },
    ],
    children: [
      {
        title: "One op API",
        body: "Every change to the tree is one of five operations: create, replace, update, delete and move. A sixth, bless, changes no text; it records that a node has been checked against its neighbours and stands as it is. The same operations are used by the keyboard, by the LLM editor agent through tool use, and by an HTTP endpoint open to outside agents. There is no privileged path: whatever a person can do to the tree, a model can do, and the reverse.",
        notes: [
          {
            quote: "replace, update",
            form: "note",
            lens: "define",
            body: "Update changes the fields it names and leaves the rest. Replace swaps the node's whole content.",
          },
          {
            quote: "There is no privileged path: whatever a person can do to the tree, a model can do, and the reverse.",
            form: "passage",
            lens: "why",
            body: P(
              "The prompt asks that the LLM editor have “the capability and agency to do the same CRUD operations” as a user. The cheapest way to guarantee that is to have only one set of operations, so that parity is a property of the architecture and not something to be maintained.",
              "It also means every author leaves the same kind of trace. A commit made by the agent is listed, compared and undone exactly as one made from the keyboard.",
            ),
            notes: [
              {
                quote: "CRUD",
                form: "gloss",
                lens: "define",
                body: "create, read, update, delete: the four basic operations on stored data",
              },
            ],
          },
        ],
      },
      {
        title: "Computed staleness",
        body: "Staleness is computed, not stored. Each node remembers a hash of what it was last reconciled with above and below, and when the current hash differs the node is stale in that direction. Editing a node makes its parent and its children stale. Human-written and pinned nodes are flagged but never rewritten.",
        children: [
          {
            title: "Two hashes",
            body: "Each node keeps two values. `seenUp` is a hash of the children it was last reconciled with; `seenDown` is a hash of the parent text, or for a note the anchored quote, it was last reconciled with. Nothing else is stored. On every change the current hashes are recomputed and compared: if the children's hash no longer matches `seenUp` the node is stale upward, and if the parent's no longer matches `seenDown` it is stale downward.",
            notes: [
              {
                quote: "Nothing else is stored.",
                form: "note",
                lens: "why",
                body: "A stored stale flag would be one more thing for two replicas to disagree about. A comparison of hashes gives the same answer on every replica that holds the same tree.",
              },
            ],
          },
          {
            title: "What an edit touches",
            body: "Editing a node makes its parent stale upward, because the parent's summary was written for the old child, and makes its children stale downward, because they elaborated the old text. A note is tied to its anchored quote and not to the whole body, so an edit elsewhere in the paragraph leaves it alone.",
          },
          {
            title: "Pinned nodes",
            body: "Nodes written by a person, and any node a person has pinned with `p`, are flagged when they go stale but never overwritten by a regeneration. The choice is left to the person: `b` blesses the node, accepting it as it stands, and unpinning it hands it back to the model.",
          },
        ],
      },
      {
        title: "The cascade",
        body: "A stale node is rewritten, blessed, or left stale until it is opened. Upward, a resolver LLM decides how many ancestors need rewriting. Downward, only the children currently open are regenerated. Whoever caused a regeneration is blessed, so the process ends, and each step is a commit that can be undone.",
        children: [
          {
            title: "Upward: the resolver",
            body: "After an edit, a resolver LLM reads the change and the chain of ancestors above it and decides how many levels actually need rewriting. A corrected typo needs none; a new child that changes what a section is about may need two or three. The levels it names are rewritten from their children, nearest first. The rest are blessed without being touched.",
            notes: [
              {
                quote: "how many levels actually need rewriting",
                form: "note",
                lens: "example",
                body: "Adding a section on offline use changes the parent's summary of the data model, but the root's one-line entry for that parent still holds. The resolver would answer: one level.",
              },
            ],
          },
          {
            title: "Downward: rendered children",
            body: "In the other direction, only the children that are rendered, meaning open on screen, are regenerated when their parent changes. The others stay stale until someone opens them, at which point they are brought up to date. Work is spent only on text that someone is looking at.",
          },
          {
            title: "Why it ends",
            body: "A regenerated parent changes the input its children were derived from, which would make them stale in turn, and so on indefinitely. The rule that prevents this is that whoever caused a regeneration is blessed: a parent rewritten from its children marks those children as reconciled with the new text. Every regeneration is its own commit, so each step of a cascade can be undone on its own.",
          },
        ],
      },
      {
        title: "The editor agent",
        body: "At node grain the command bar takes an instruction instead of a question: tighten this, add a section on that, split this node in two. The instruction goes to an LLM editor agent that works on a fork of the document under its own peer id, using the same operations as the user. When it finishes, its fork is merged back. The user can keep editing in the meantime, because the two sets of changes meet as an ordinary merge.",
        notes: [
          {
            quote: "peer id",
            form: "gloss",
            lens: "define",
            body: "the identifier under which one replica's operations are recorded",
          },
          {
            quote: "an ordinary merge",
            form: "note",
            lens: "elaborate",
            body: "If the agent and the user rewrote the same sentence, the result is a semantic conflict, handled as it would be between two people.",
          },
        ],
      },
    ],
  },

  // ───────────────────────────────────────────────────────────── 4
  {
    title: "Borrowed from Gwern",
    src: [
      "The UI for this should be heavily inspired by the professional, clean, text-focused UI of Gwern’s site: About This Website · Gwern.net (https://gwern.net/about).",
      "He has also developed a lot of neat ways to “expand” on concepts which I think we should borrow here (but ultimately we are expanding on this significantly).",
    ],
    body: "The look and several of the mechanisms come from gwern.net: semantic zoom as the organising principle, margin sidenotes, hover popups, collapse blocks, and plain grayscale typography. What is added is that every expansion can be edited, generated on demand, versioned, and reached from the keyboard.",
    children: [
      {
        title: "Semantic zoom",
        body: "Gwern names semantic zoom as one of his site's design principles: “progressively expose more beyond the default as the reader requests it”. The hierarchy of a text is made visible and the reader chooses how far into it to go. The idea is older than the web; Ted Nelson described StretchText, prose that lengthens in place when asked, in 1967. This project takes the principle as its organising one.",
        notes: [
          {
            quote: "StretchText",
            form: "gloss",
            lens: "define",
            body: "Nelson's term for text that expands in place into a more detailed version of itself",
          },
        ],
      },
      {
        title: "Mechanisms taken",
        body: "Several of his mechanisms are used directly. Sidenotes sit in the right margin and are pushed apart where they would overlap. Hovering over a marked span raises a popup with its expansion. Collapsed blocks are marked by a bar in the gutter. A dotted underline marks a link that carries an annotation, and a page opens with an abstract.",
        notes: [
          {
            quote: "raises a popup",
            form: "note",
            lens: "elaborate",
            body: "On gwern.net the popup appears after a hover of 750 ms and starts to fade 100 ms after the pointer leaves. Popups can be nested and pinned.",
          },
        ],
      },
      {
        title: "Typography",
        body: "The page is set as he sets his: a grayscale palette, Source Serif for the body, and paragraphs that are justified and marked by an indent instead of a gap. Nothing is coloured to attract attention, so the few marks that do appear, an underline or a bar, carry meaning.",
        notes: [
          {
            quote: "a grayscale palette",
            form: "note",
            lens: "why",
            body: "His stated rule is that “visual differences should be semantic differences”. Colour used for decoration would be a difference that meant nothing.",
          },
        ],
      },
      {
        title: "What is added",
        body: "On gwern.net the reader opens what the author prepared. Here every expansion is also editable, can be generated on demand where none was prepared, is versioned along with the rest of the tree, and can be reached and operated from the keyboard.",
      },
    ],
  },

  // ───────────────────────────────────────────────────────────── 5
  {
    title: "Keyboard and focus",
    src: [
      "This should feel effortless to use: power users should be able to move around and expand at the speed of thought.",
    ],
    body: "The interface is modal and vim-like, so that moving and expanding each take one keystroke. Focus is a node plus a grain, which is node, sentence or word, and the same keys act at every grain. The mouse works as well; a mouse selection is treated as just another range.",
    notes: [
      {
        quote: "modal",
        form: "gloss",
        lens: "define",
        body: "keys act as commands, not as typed text, until an editing mode is entered",
      },
    ],
    children: [
      {
        title: "Focus and grain",
        body: "Focus is a pair: a node and a grain. There are three grains, node, sentence and word; `i` descends from one to the next and Esc ascends. The interface is modal in the manner of vim, and the same keys keep their meaning at each grain: j and k move to the next and previous unit, and `e` expands whatever is focused, each in one keystroke. At word grain the focus can be widened into a phrase, so any span of text is reachable without the mouse.",
        notes: [
          {
            quote: "a node and a grain",
            form: "note",
            lens: "why",
            body: "A cursor that only addressed nodes could open sections but never ask about a word. One that only addressed characters would take dozens of keystrokes to cross a page.",
          },
        ],
      },
      {
        title: "Keys",
        body: "Actions are bound to single keys. j, k, h and l move through the tree, with keys to jump and to hoist; `e` expands and `:` opens the command bar; other keys edit the tree, undo, and open history and help.",
        children: [
          {
            title: "Moving",
            body: "j and k move down and up. l opens the focused node, or enters it if it is already open; h closes it, or moves to its parent if it is already closed. Tab steps between the spans that already carry a note, and `/` jumps to a node by title. `z` hoists the focused node, making it the temporary root of the view, which is how a deep subtree is read without its ancestors crowding the page.",
          },
          {
            title: "Expanding and asking",
            body: "`e` expands the focus, whatever its grain. On a selection, H and L shrink and grow it by a word or a sentence, Enter opens the note on a marked span and then steps into it, and d, y, x and c ask for a definition, a reason, an example or an objection. `:` opens the command bar. With a selection, what is typed there is a question about the selected text; at node grain it is an instruction to the editor agent.",
          },
          {
            title: "Editing",
            body: "a and A add a node; c edits the body and r renames the title; D deletes. J and K reorder a node among its siblings, and < and > outdent and indent it. p pins, R reconciles a stale node, and b blesses it as it stands. u undoes, g opens history, and ? lists all of this.",
            notes: [
              {
                quote: "D deletes",
                form: "note",
                lens: "why",
                body: "There is no confirmation dialog. Deletion is a commit like any other, and u reverses it.",
              },
            ],
          },
        ],
      },
      {
        title: "The mouse",
        body: "Nothing requires the keyboard. Titles and marked spans can be clicked, and text can be selected by dragging. A mouse selection is just another range: it becomes the focus, and `e` or `:` acts on it exactly as on a range chosen with keys.",
      },
    ],
  },

  // ───────────────────────────────────────────────────────────── 6
  {
    title: "The tree underneath",
    src: [
      "Another key element to this is that users can actually add, modify, or delete a “node” to the tree.",
      "I think maybe we want something like CDRTs under the hood that would instead use LLMs to resolve logical conflicts.",
    ],
    body: "A document is a tree of nodes held in a CRDT. Each node has a title, a body, a kind and a provenance, and a note is tied to its parent's text by anchors that survive editing. Every browser holds a full replica, and a small local server relays changes and keeps the API key.",
    notes: [
      {
        quote: "CRDT",
        form: "gloss",
        lens: "define",
        body: "conflict-free replicated data type: replicas edited independently always merge to the same state",
      },
    ],
    children: [
      {
        title: "Nodes",
        body: "The document lives in a Loro CRDT, using its movable tree for structure and its text type for bodies. A node has a title and a body. It has a kind: a section is a structural child, listed in the outline under its parent, and a note is an expansion anchored to a span of its parent's body. And it has a provenance: whether it was written by a human or by an LLM, and whether it is pinned.",
        notes: [
          {
            quote: "movable tree",
            form: "note",
            lens: "elaborate",
            body: "Moving a node is the hard case for a tree CRDT, since two replicas can concurrently move two nodes under each other. Loro resolves this deterministically, so every replica ends with the same tree and no cycle.",
          },
        ],
      },
      {
        title: "Anchors",
        body: "A note is attached to its parent's text by an anchor, which is a pair of CRDT cursors marking the start and end of a span. A cursor is a reference to a position in the text's history and not a character offset, so the anchor stays on its phrase while text is inserted or deleted around it. If the anchored text itself is deleted, the note has nothing to attach to; it becomes an orphan and is flagged, not discarded.",
        notes: [
          {
            quote: "character offset",
            form: "gloss",
            lens: "define",
            body: "a position counted in characters from the start; it shifts whenever earlier text changes",
          },
          {
            quote: "If the anchored text itself is deleted, the note has nothing to attach to; it becomes an orphan and is flagged, not discarded.",
            form: "passage",
            lens: "why",
            body: P(
              "Discarding would be simpler and wrong. The note may be the most valuable thing in the paragraph, and the deletion may have been a rewrite that kept the idea and changed every word.",
              "So the orphan is kept and shown at the end of its parent, marked, until someone moves it or deletes it on purpose.",
            ),
          },
        ],
      },
      {
        title: "Local-first",
        body: "Each browser holds a full replica of the document in IndexedDB and can read and edit without a connection. A small local server does three things: it relays updates between tabs, people and agents; it persists the document to disk; and it is the only holder of the API key, so the key never reaches a browser.",
        notes: [
          {
            quote: "full replica",
            form: "note",
            lens: "elaborate",
            body: "Full means the whole history, not just the current text, which is what lets any replica travel back or merge on its own.",
          },
        ],
      },
    ],
  },

  // ───────────────────────────────────────────────────────────── 7
  {
    title: "Versioning and merge",
    src: [
      "The built tree should be versioned like git so that changes can be easily rolled back or merged if multiple people or agents are updating the tree simultaneously.",
      "I think maybe we want something like CDRTs under the hood that would instead use LLMs to resolve logical conflicts.",
    ],
    body: "Every change is a commit with an author, a message and a hash of the tree, and history can be traveled, reverted, branched and merged. Merges of structure are automatic. Conflicts of meaning, which the CRDT cannot see, are detected, recorded, and resolved by an LLM in a commit that a person can review and revert.",
    children: [
      {
        title: "Commits",
        body: "Every change is a commit in Loro's causal DAG. A commit carries a message, an author, and the SHA-256 of the canonical state of the tree at that point. Because the hash is recorded, checking out any commit can be verified byte for byte: rebuild the tree, hash it, compare.",
        notes: [
          {
            quote: "causal DAG",
            form: "gloss",
            lens: "define",
            body: "a graph in which each change points to the changes it was made after",
          },
          {
            quote: "canonical state",
            form: "note",
            lens: "define",
            body: "Canonical means serialised in one fixed order with nothing replica-specific in it, so two replicas at the same version produce the same bytes.",
          },
        ],
      },
      {
        title: "History operations",
        body: "Four operations work on history. Time travel checks out an earlier commit read-only. Revert returns the tree to an earlier state by adding a new commit, so the reverted work stays in history. A branch is a named fork of the document. Merge brings one branch's changes into another. All four are reached from the history view, opened with g.",
        notes: [
          {
            quote: "by adding a new commit",
            form: "note",
            lens: "why",
            body: "History is shared between replicas, so it cannot be rewritten; someone else may already have built on the commits being undone.",
          },
        ],
      },
      {
        title: "Structural merge",
        body: "Merging structure is automatic: it needs no judgment and gets none. Concurrent moves in the tree are resolved by a Kleppmann-style move operation, and concurrent edits to a body by the text CRDT. The result is deterministic: any two replicas that have seen the same changes hold the same tree, whatever order the changes arrived in.",
        notes: [
          {
            quote: "Kleppmann-style",
            form: "gloss",
            lens: "define",
            body: "after Kleppmann et al., “A highly-available move operation for replicated trees” (2021)",
          },
        ],
      },
      {
        title: "Semantic conflicts",
        body: "Some conflicts are invisible to the CRDT because the merged result is well-formed. There are three kinds. They are found by comparing both sides against the merge base, with an LLM scanning for contradictions, and written into the document as conflict records. An LLM then proposes a resolution as an explicit commit that can be reviewed and reverted, never silently; without an LLM the conflict stays open for a person.",
        children: [
          {
            title: "Three kinds",
            body: "First, both sides rewrote the same sentence. The text CRDT merges the two edits character by character into something well-formed that means neither. Second, one side edited a node that the other deleted. Third, two different nodes, each edited cleanly, now contradict one another. In none of these does the CRDT report anything, since by its lights nothing went wrong.",
            notes: [
              {
                quote: "The text CRDT merges the two edits character by character into something well-formed that means neither.",
                form: "passage",
                lens: "example",
                body: P(
                  "Take the sentence “Hello brave new world.” One replica changes it to “Hello bold new world.” and another, at the same time, to “Hello brave old world.” Merged, the body reads “Hello bold old world.”",
                  "Each replica changed one word and the merge kept both changes, which is correct by the rules of the data type. But nobody wrote that sentence. For prose, a merge that no author intended is a conflict, whether or not anything overlapped.",
                ),
                notes: [
                  {
                    quote: "nobody wrote that sentence",
                    form: "note",
                    lens: "elaborate",
                    body: "The example is the library's actual output, from a probe run while the data model was being chosen.",
                  },
                ],
              },
            ],
          },
          {
            title: "Detection",
            body: "At a merge, each node is compared three ways: its state at the merge base, on one side, and on the other. A field changed differently on both sides, or changed on one and deleted on the other, is a conflict. Contradictions between different nodes cannot be found by comparison, so an LLM scans the two sets of changes for them. Every conflict found is recorded in the document itself as a conflict record, which means it is replicated and versioned like everything else.",
            notes: [
              {
                quote: "merge base",
                form: "gloss",
                lens: "define",
                body: "the most recent state both sides have in common",
              },
            ],
          },
          {
            title: "Resolution",
            body: "An LLM reads each conflict record, with the base and both versions, and proposes a resolution. The proposal is applied as an explicit commit: it is listed in history, it can be reviewed against both originals, and it can be reverted. It is never applied silently. Without an LLM available the conflict stays open for a person to settle, with both versions kept.",
            notes: [
              {
                quote: "never applied silently",
                form: "note",
                lens: "why",
                body: "A model that quietly rewrites a disputed sentence has taken a side in an argument between two authors without telling either.",
              },
            ],
          },
        ],
      },
    ],
  },

  // ───────────────────────────────────────────────────────────── 8
  {
    title: "Approaches considered",
    src: [
      "You can click on any of these to “expand” out that section (this could be shown visually different ways: accordian expand inline, open new sidebar to the right, a big giant pannable canvas with card to the right).",
      "Exercise abstract thinking, think outside the box and don’t let normal guidelines constrain you: this is a new and novel thing that we are building together.",
      "Brainstorm multiple different approaches we could take in designing and implementing this and then go with your favorite.",
    ],
    body: "Several interaction models and data models were considered. For interaction, a single column of stretchtext with a margin, plus hoisting, was chosen over an accordion, a sidebar and a canvas. For data, a tree CRDT with commit metadata was chosen over a JSON tree with snapshots and a git-style Merkle tree.",
    children: [
      {
        title: "Interaction models",
        body: "The prompt suggests three ways to show an expansion: an accordion, a sidebar, and a canvas. The accordion has only one form of expansion; the sidebar separates an expansion from the text that prompted it, and the canvas is slow to drive from the keyboard. The design chosen is a single column of stretchtext with a margin, plus hoisting, because it keeps the text in one reading order at every size.",
        children: [
          {
            title: "Accordion outline",
            body: "An accordion, the first of the three displays the prompt suggests, expands every node inline as a block beneath its title. It is the simplest model and it keeps reading order. Its weakness is that it has one form: the definition of a word arrives as the same kind of block as a chapter, pushed below the paragraph it belongs to.",
          },
          {
            title: "Sidebar and canvas",
            body: "The prompt's other two suggestions are a sidebar and a canvas. A Miller-column sidebar opens each level in a new column to the right. It shows the path well, but the expansion sits apart from the sentence that prompted it, and deep paths run off the screen. A pannable canvas of cards gives every expansion a place in two dimensions. It suits arranging more than reading: position has to be managed, and nothing about it is fast from the keyboard.",
            notes: [
              {
                quote: "Miller-column",
                form: "gloss",
                lens: "define",
                body: "side-by-side columns, one per level of a hierarchy, as in the macOS Finder",
              },
            ],
          },
          {
            title: "Chosen: one column with a margin",
            body: "The chosen model is a single column of stretchtext with a margin. Sections expand in place, as in the accordion; small expansions go inline or into the margin beside their anchor, so the text keeps one reading order at every size. Hoisting, which makes any node the temporary root, supplies what the sidebar and canvas offered: a way to be deep in the tree without the rest of it on screen.",
          },
        ],
      },
      {
        title: "Data models",
        body: "Three ways of storing the tree were considered. A JSON tree with snapshots cannot merge concurrent edits. A git-style Merkle tree has real history but merges text by three-way diff, with conflicts left to the user. A tree CRDT, with commit metadata added, was chosen because concurrent edits converge on their own and the history features can be layered on top.",
        children: [
          {
            title: "JSON tree with snapshots",
            body: "The simplest store is a plain JSON tree, saved whole, with a snapshot kept at each save for rollback. It gives history of a kind, but no way to merge: when two people or agents edit at once, the later save replaces the earlier, and one set of changes is lost.",
          },
          {
            title: "Git-style Merkle tree",
            body: "A content-addressed Merkle tree, as in git, gives real history, branches and cheap comparison of versions. Merging is the trouble. Bodies would be merged by three-way text diff, which stops and hands the user conflict markers whenever two edits touch the same lines, and moving a node is not an operation the format knows about. It also assumes merges are occasional events, not something happening continuously while two authors type.",
            notes: [
              {
                quote: "content-addressed",
                form: "gloss",
                lens: "define",
                body: "stored under the hash of its own contents, so identical content has one identity",
              },
            ],
          },
          {
            title: "Chosen: tree CRDT with commit metadata",
            body: "A tree CRDT makes concurrent edits converge without coordination, including moves, and does so continuously. What it lacks compared with git is legible history, so each commit is given metadata: a message, an author and a hash of the tree's state. That restores messages, verification, branches and revert on top of the CRDT, and leaves the conflicts no data structure can see to the LLM.",
          },
        ],
      },
    ],
  },

  // ───────────────────────────────────────────────────────────── 9
  {
    title: "A shared working memory",
    src: [
      "I want you to be super creative with this and actually have a lot of fun building this.",
      "This is really a testament to the usefulness for human and machine mind-meld towards building ideas.",
      "AI as a mental prosthesis.",
      "The first example we should use in the editor/explorer should be meta: this project itself.",
      "Break what I have outlined here down into an initial tree we can explore together.",
    ],
    body: "The tree is a working memory shared by a person and a model. The person steers by attention, the model fills in at the resolution asked for, and either can restructure what is there. The first document is this one.",
    notes: [
      {
        quote: "working memory",
        form: "gloss",
        lens: "define",
        body: "what a mind holds ready while thinking; small, and quickly overwritten",
      },
    ],
    children: [
      {
        title: "Steering by attention",
        body: "The person steers mostly by attention: by what they open, what they select, and what they question. None of these requires writing a prompt. Pressing `e` on a sentence is already a complete request, since the sentence, its place in the tree and the chosen lens say what is wanted. The model's part is to fill in at the resolution asked for, a gloss for a word and sections for a node.",
        notes: [
          {
            quote: "None of these requires writing a prompt.",
            form: "passage",
            lens: "why",
            body: P(
              "A prosthesis is used without being addressed. Composing a request is a task of its own, and it takes the attention it was supposed to save; by the time the question is phrased, the thought it interrupted is often gone.",
              "So the common case is made wordless. The context a prompt would have had to describe is already present in where the cursor is.",
            ),
          },
        ],
      },
      {
        title: "Either can restructure",
        body: "The tree is a shared working memory in the plain sense that both parties read it and both write it. Neither is confined to filling in. The person can add, move, rewrite and delete nodes, and so can the model, through the same operations; the document can grow in directions that neither started with. What a person writes is kept as written.",
      },
      {
        title: "The first document",
        body: "The first document is this one. Its root holds the prompt that began the project, verbatim, and each top-level section is tied to the sentences of the prompt it came from, so the description of the tool can be read, questioned and corrected with the tool.",
      },
    ],
  },

  // ───────────────────────────────────────────────────────────── 10
  {
    title: "How we know it works",
    src: [
      "Break what I have outlined here down into an initial tree we can explore together.",
      "The built tree should be versioned like git so that changes can be easily rolled back or merged if multiple people or agents are updating the tree simultaneously.",
    ],
    body: "Six checks are run. Three test the data layer, two test the content of this tree, and one drives the interface from the keyboard and times it.",
    children: [
      {
        title: "Data layer",
        body: "Three checks cover the data layer. Convergence is a property test: random operations are applied concurrently to several replicas, which are then synchronised in random order and must end in the identical state. History is tested by checking out every commit and comparing the hash of the rebuilt tree with the one recorded, byte for byte. Conflict handling is tested with seeded fixtures, pairs of branches built to conflict in known ways with known acceptable resolutions.",
        notes: [
          {
            quote: "property test",
            form: "gloss",
            lens: "define",
            body: "a test checking a rule against many randomly generated cases, not a few chosen ones",
          },
        ],
      },
      {
        title: "Content",
        body: "Two checks cover the content of this tree. The coverage check takes every sentence of the original prompt and requires that at least one section trace back to it. The entailment check gives a fresh model, one that has seen none of the design, only the children of a node, and asks whether every claim in the parent's body is supported by them.",
        notes: [
          {
            quote: "a fresh model",
            form: "note",
            lens: "why",
            body: "The model that wrote the tree knows what it meant and will read that meaning into the children. A model without the context can only use what is on the page.",
          },
        ],
      },
      {
        title: "Interface",
        body: "One check covers the interface. A script drives the application through this document using only the keyboard, and records two latencies against their budgets: keypress to paint for pre-generated expansions, under 50 ms, and time to first token for generated ones, under 1 s.",
      },
    ],
  },
];
