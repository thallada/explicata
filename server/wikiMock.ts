/**
 * A stand-in Wikipedia for tests and offline work (EX_WIKI=mock). `mockWikiFetch` answers every
 * URL server/wiki.ts builds, in the shapes the real APIs return (docs/wikipedia.md §2), from a
 * few short articles written for the purpose. The HTML imitates action=parse output, junk
 * included (reference markers, infoboxes, navboxes, hatnotes, TemplateStyles), so the real
 * sanitising and splitting code runs on it. Nothing here touches the network.
 *
 * Some titles misbehave on purpose:
 *   "Offline example"       the fetch throws TypeError("fetch failed"), as with no network
 *   "Rate limited example"  429 with Retry-After: 0
 *   "Slow article"          every answer about it arrives after SLOW_MS
 *   "Hostile article"       HTML full of attacks that must not survive sanitising
 * "Grey heron" has pictures as Wikipedia marks them up: an infobox image, a thumbnail, a gallery,
 * a video, and flag icons (which are not kept). Every address on upload.wikimedia.org answers
 * with one tiny PNG (the same as server/pageMock.ts's), whatever it names.
 * A request is about a title when it is the summary or parse of it, a query whose titles include
 * it, or a search whose query is exactly that title (any case). Typing a prefix of it is normal.
 */

import { TINY_PNG } from "./pageMock";

/** How long "Slow article" takes to answer: long enough for the UI to say Wikipedia is slow. */
const SLOW_MS = 2500;

type Block = string | string[] | { html: string }; // a paragraph, a bulleted list, or markup as it is (a figure, a gallery)
interface Fixture {
  id: number;
  description: string | null;
  disambiguation?: boolean;
  hatnote?: string;
  /** More rows for the infobox (an image cell), as markup. */
  infobox?: string;
  /** Paragraph markup: [[Target]] or [[Target|text]] for links, [ref] for a reference marker. */
  lead: Block[];
  sections?: { heading: string; level?: 3; body: Block[] }[];
  /** Raw page HTML instead of generated, with its own summary extract. */
  html?: string;
  extract?: string;
  behaviour?: "offline" | "rate-limited" | "slow";
}

const FIXTURES: Record<string, Fixture> = {
  "Fixed-point combinator": {
    id: 1_200_101,
    description: "Higher-order function Y for which Y f = f (Y f)",
    hatnote: `For fixed points of functions in general, see <a href="/wiki/Fixed_point_(mathematics)" title="Fixed point (mathematics)">Fixed point (mathematics)</a>.`,
    lead: [
      `In mathematics and computer science, a <b>fixed-point combinator</b> (or <b>fixpoint combinator</b>) is a higher-order function that, given a function <i>f</i>, returns a fixed point of <i>f</i>: a value <i>x</i> with <i>f</i>(<i>x</i>) = <i>x</i>.[ref] In the untyped [[Lambda calculus|lambda calculus]] such combinators exist for every term, and the best known of them, the Y combinator, is usually credited to [[Haskell Curry]]. Because a fixed-point combinator lets an anonymous function call itself, it gives a way to express [[Recursion (computer science)|recursion]] in languages that have no built-in way for a function to name itself.`,
    ],
    sections: [
      {
        heading: "Introduction",
        body: [
          `A combinator is a function with no free variables. Applied to a function <i>f</i>, a fixed-point combinator <code>fix</code> produces a value that <i>f</i> maps to itself, so that <code>fix f = f (fix f)</code>. Unfolding this equation again and again gives <code>f (f (f …))</code>, which is how the combinator builds up a recursive computation one step at a time.`,
        ],
      },
      {
        heading: "Y combinator",
        body: [
          `The Y combinator is defined in the [[Lambda calculus|lambda calculus]] as <span class="mwe-math-element mwe-math-element-inline"><math xmlns="http://www.w3.org/1998/Math/MathML" display="inline"><semantics><mrow><mi>Y</mi><mo>=</mo><mi>λ</mi><mi>f</mi><mo>.</mo><mo stretchy="false">(</mo><mi>λ</mi><mi>x</mi><mo>.</mo><mi>f</mi><mo stretchy="false">(</mo><mi>x</mi><mi>x</mi><mo stretchy="false">)</mo><mo stretchy="false">)</mo><mo stretchy="false">(</mo><mi>λ</mi><mi>x</mi><mo>.</mo><mi>f</mi><mo stretchy="false">(</mo><mi>x</mi><mi>x</mi><mo stretchy="false">)</mo><mo stretchy="false">)</mo></mrow><annotation encoding="application/x-tex">Y=\\lambda f.(\\lambda x.f(xx))(\\lambda x.f(xx))</annotation></semantics></math></span>. It works by applying a term to a copy of itself, the same trick that makes <code>(λx.x x)(λx.x x)</code> reduce to itself forever. Under normal-order evaluation, <code>Y g</code> reduces to <code>g (Y g)</code> for any term <code>g</code>.[ref]`,
        ],
      },
      {
        heading: "Verification",
        level: 3,
        body: [
          `Applying Y to a function <code>g</code> and performing one beta reduction gives <code>(λx.g (x x)) (λx.g (x x))</code>. A second beta reduction turns this into <code>g ((λx.g (x x)) (λx.g (x x)))</code>, which is <code>g</code> applied to the previous term. The result is therefore equal to <code>g (Y g)</code>, as the defining equation requires.`,
        ],
      },
      {
        heading: "Other fixed-point combinators",
        body: [
          `Infinitely many terms satisfy the fixed-point equation. Alan Turing gave one, often written Θ, that reduces to its fixed point directly rather than only being equal to it. Others can be generated mechanically, for instance by composing an existing combinator with suitable auxiliary terms.`,
        ],
      },
      {
        heading: "Strict fixed-point combinator",
        level: 3,
        body: [
          `In a language that evaluates arguments before calling a function, the Y combinator never returns, because <code>Y g</code> keeps expanding before <code>g</code> is ever called. The Z combinator avoids this by wrapping the self-application in an extra abstraction, <code>λv.x x v</code>, which delays evaluation until an argument is supplied. It is the form usually written in languages such as JavaScript or Python.`,
        ],
      },
      {
        heading: "Typed fixed-point combinators",
        body: [
          `In the simply typed lambda calculus no fixed-point combinator can be written, since every typed term has a normal form and self-application cannot be given a type. Typed languages therefore usually supply fixed points as a primitive, such as a <code>fix</code> operator or recursive <code>let</code> bindings. Alternatively a recursive type can be introduced so that a value may be applied to itself, which makes the Y combinator typable again.`,
        ],
      },
    ],
  },
  "Lambda calculus": {
    id: 1_200_102,
    description: "Mathematical-logic system based on functions",
    lead: [
      `<b>Lambda calculus</b> (also written <b>λ-calculus</b>) is a formal system for expressing computation through function abstraction and application, using only variable binding and substitution. It was introduced by the mathematician [[Alonzo Church]] in the 1930s as part of an investigation into the foundations of mathematics.[ref] Although it has just three kinds of term, it is a universal model of computation, and recursion can be encoded in it with a [[Fixed-point combinator|fixed-point combinator]].`,
    ],
    sections: [
      {
        heading: "History",
        body: [
          `Church first presented the calculus in the early 1930s inside a larger logical system, which was soon found to be inconsistent. He then isolated its purely computational part, the untyped lambda calculus, and in 1936 used it to show that the Entscheidungsproblem has no solution. Around the same time Alan Turing reached the same result with his machines, and the two models were shown to define the same class of functions.`,
        ],
      },
      {
        heading: "Informal description",
        body: [
          `A lambda term is a variable, an abstraction <code>λx.M</code> that defines an anonymous function of <code>x</code> with body <code>M</code>, or an application <code>M N</code> of one term to another. Functions take a single argument; a function of several arguments is written as a chain of single-argument functions, a technique known as currying.`,
        ],
      },
      {
        heading: "Motivation",
        level: 3,
        body: [
          `In ordinary mathematics a function is usually given a name before it is used, as in <i>f</i>(<i>x</i>) = <i>x</i> + 2. The lambda calculus drops the name and writes only the rule, <code>λx.x + 2</code>, so that functions can be passed around and returned like any other value. This anonymity is also why recursion needs a special device: a nameless function has no direct way to refer to itself.`,
        ],
      },
      {
        heading: "Reduction",
        body: [
          `Computation in the lambda calculus proceeds by reduction. Beta reduction replaces an application <code>(λx.M) N</code> with the body <code>M</code> in which <code>N</code> is substituted for <code>x</code>, while alpha conversion renames bound variables to avoid capture. A term that admits no further beta reduction is in normal form, and by the Church–Rosser theorem a term has at most one.`,
        ],
      },
    ],
  },
  "Alonzo Church": {
    id: 1_200_103,
    description: "American mathematician and logician (1903–1995)",
    lead: [
      `<b>Alonzo Church</b> (1903–1995) was an American mathematician and logician who made major contributions to mathematical logic and the theory of computation.[ref] He is best known for the [[Lambda calculus|lambda calculus]] and for the Church–Turing thesis, which proposes that his notion of effective calculability captures every mechanical procedure.`,
    ],
    sections: [
      {
        heading: "Career",
        body: [
          `Church spent most of his career at Princeton University, where his doctoral students included Alan Turing and Stephen Kleene. He later moved to the University of California, Los Angeles. He was also a founding editor of the <i>Journal of Symbolic Logic</i>.`,
        ],
      },
    ],
  },
  "Haskell Curry": {
    id: 1_200_104,
    description: "American mathematician and logician (1900–1982)",
    lead: [
      `<b>Haskell Brooks Curry</b> (1900–1982) was an American mathematician and logician known for his work in combinatory logic.[ref] The programming language Haskell and the technique of currying are both named after him, although currying had been described earlier by others.`,
    ],
    sections: [
      {
        heading: "Work",
        body: [
          `Curry developed combinatory logic as a way of doing without bound variables, building every function from a small set of basic combinators. He is associated with the [[Fixed-point combinator|Y combinator]] and with the observation, later called the Curry–Howard correspondence, that proofs and programs share a common structure.`,
        ],
      },
    ],
  },
  "Recursion (computer science)": {
    id: 1_200_105,
    description: "Use of functions that call themselves",
    lead: [
      `In computer science, <b>recursion</b> is a method of solving a problem in which the solution depends on solutions to smaller instances of the same problem.[ref] Most programming languages support it by allowing a function to call itself from within its own code. Where functions cannot refer to themselves by name, a [[Fixed-point combinator|fixed-point combinator]] can provide the same effect.`,
    ],
    sections: [
      {
        heading: "Base case",
        body: [
          `A recursive definition needs at least one base case, an input whose answer is given directly, so that the chain of calls eventually stops. Without one the function calls itself until the program runs out of memory for its call stack.`,
        ],
      },
      {
        heading: "Tail recursion",
        body: [
          `A call is in tail position when nothing remains to be done after it returns. Many compilers turn such tail calls into jumps, so that a tail-recursive function runs in constant stack space, like a loop.`,
        ],
      },
    ],
  },
  Octopus: {
    id: 1_200_106,
    description: "Soft-bodied eight-limbed order of molluscs",
    hatnote: `For other uses, see <a href="/wiki/Octopus_(disambiguation)" class="mw-disambig" title="Octopus (disambiguation)">Octopus (disambiguation)</a>.`,
    lead: [
      `An <b>octopus</b> (plural: <b>octopuses</b>) is a soft-bodied, eight-limbed mollusc of the order Octopoda. Together with squids, cuttlefish and nautiloids it belongs to the class Cephalopoda, the [[Cephalopod|cephalopods]].[ref] Octopuses have no internal or external skeleton, which lets them squeeze through very small openings.`,
    ],
    sections: [
      {
        heading: "Etymology and pluralisation",
        body: [
          `The word comes through scientific Latin from the Greek <i>oktōpous</i>, meaning "eight-footed". In English the standard plural is <i>octopuses</i>. The form <i>octopi</i> arose from the mistaken belief that the word is a Latin second-declension noun, while <i>octopodes</i> follows the Greek.`,
        ],
      },
      {
        heading: "Description",
        body: [
          `An octopus has a bulbous mantle containing its organs, a head with two prominent eyes, and eight arms lined with suckers. Its skin contains specialised cells that let it change colour and texture within a fraction of a second.`,
        ],
      },
      {
        heading: "Size",
        level: 3,
        body: [
          `Species range widely in size. The giant Pacific octopus is often cited as the largest, with adults commonly weighing around 15 kilograms, while the smallest species are only a few centimetres long when fully grown.`,
        ],
      },
      {
        heading: "Nervous system and senses",
        level: 3,
        body: [
          `Octopuses have a large and unusual nervous system, with roughly two thirds of their neurons in the arms rather than the brain. Each arm can carry out some actions with a degree of independence. Their eyes are acute, yet most species are thought to be colour-blind.[ref]`,
        ],
      },
      {
        heading: "Intelligence",
        body: [
          `Octopuses are widely regarded as the most intelligent invertebrates. In laboratory studies they have solved mazes, unscrewed jar lids and learned by watching other octopuses. Some have been seen carrying coconut shells to use later as shelter.`,
        ],
      },
    ],
  },
  Cephalopod: {
    id: 1_200_107,
    description: "Class of mollusks",
    lead: [
      `A <b>cephalopod</b> is any member of the molluscan class Cephalopoda, which includes the squid, the cuttlefish, the nautilus and the [[Octopus|octopus]].[ref] Cephalopods are marine animals with bilateral symmetry, a prominent head, and a set of arms or tentacles derived from the ancestral mollusc foot.`,
    ],
    sections: [
      {
        heading: "Nervous system",
        body: [
          `Cephalopods have the largest nervous systems of any invertebrates, and many show complex learned behaviour. Their eyes form images in a way that closely parallels the vertebrate eye, although the two evolved independently.`,
        ],
      },
    ],
  },
  Eukaryote: {
    id: 1_200_122,
    description: "Domain of life whose cells have nuclei",
    lead: [
      `The <b>eukaryotes</b> are organisms whose cells have a membrane-bound nucleus.[ref] They include all animals, plants, fungi and many single-celled organisms, the protists, and with the [[Bacteria|bacteria]] and the [[Archaea|archaea]] they make up the three domains of life. Eukaryotic cells also contain other membrane-bound compartments, such as [[Mitochondrion|mitochondria]] and the Golgi apparatus, and are typically much larger than those of prokaryotes.`,
      `Eukaryotes probably emerged within the archaea, and the leading theory holds that the first eukaryotic cell arose when an archaeon took in a bacterium that became the mitochondrion.[ref] All living eukaryotes descend from a single last common ancestor, which already had most of the features that distinguish them.`,
    ],
    sections: [
      {
        heading: "Cell features",
        body: [
          `Eukaryotic cells are on average about ten thousand times the volume of prokaryotic cells. Their DNA is organised into several linear chromosomes inside the nucleus, and a cytoskeleton of protein filaments gives the cell its shape and lets it move material from place to place.`,
          `Most eukaryotes reproduce sexually at some stage of their life cycle, by meiosis and the fusion of gametes, although many single-celled species also divide asexually.`,
        ],
      },
      {
        heading: "Origin",
        body: [
          `The timing of the origin of eukaryotes is uncertain: the oldest fossils accepted as eukaryotic are about 1.6 billion years old. Comparisons of genes place their nearest living relatives among the Asgard archaea, discovered in deep-sea sediments in 2015.`,
        ],
      },
    ],
  },
  Bacteria: {
    id: 1_200_121,
    description: "Domain of prokaryotic microorganisms",
    lead: [
      `<b>Bacteria</b> are ubiquitous, mostly free-living organisms often consisting of one biological cell.[ref] They constitute a large domain of prokaryotic microorganisms. Typically a few micrometres in length, bacteria were among the first life forms to appear on Earth, and are present in most of its habitats, from soil and water to acidic hot springs and the deep biosphere.`,
      `Bacteria play a vital role in many stages of the nutrient cycle, by recycling nutrients and fixing nitrogen from the atmosphere. Most have not been characterised, and many species cannot be grown in the laboratory. Their study is known as bacteriology, a branch of microbiology.`,
    ],
    sections: [
      {
        heading: "Structure",
        body: [
          `A bacterial cell is surrounded by a membrane and, in most species, a cell wall. Its DNA lies in the cytoplasm, usually as a single circular chromosome, with no nucleus around it. Many bacteria swim by turning a flagellum.`,
        ],
      },
    ],
  },
  "Hoyle state": {
    id: 1_200_108,
    description: "Excited state of the carbon-12 nucleus",
    lead: [
      `The <b>Hoyle state</b> is an excited, spin-0 resonant state of the [[Carbon-12|carbon-12]] nucleus, lying about 7.65 MeV above the ground state. It is named after [[Fred Hoyle]], who argued that such a state must exist for the [[Triple-alpha process|triple-alpha process]] to produce the amount of carbon observed in the universe.[ref]`,
    ],
    sections: [
      {
        heading: "Prediction",
        body: [
          `Hoyle reasoned that without a resonance near the combined energy of beryllium-8 and helium-4, stars would make far too little carbon. In 1953 he persuaded experimenters at the California Institute of Technology to look for it, and the state was found close to the energy he had estimated.`,
        ],
      },
      {
        heading: "Structure",
        body: [
          `The Hoyle state is thought to be a loosely bound arrangement of three alpha particles rather than a compact nucleus like the ground state. Its structure is still studied, including by lattice calculations from first principles.`,
        ],
      },
    ],
  },
  "Carbon-12": {
    id: 1_200_109,
    description: "Most abundant isotope of carbon",
    lead: [
      `<b>Carbon-12</b> (<sup>12</sup>C) is the more abundant of the two stable isotopes of carbon, making up about 98.9 percent of the element on Earth. Its nucleus contains six protons and six neutrons.[ref] Since 1961 it has been the reference for the atomic mass scale, on which one atom of carbon-12 has a mass of exactly 12 daltons.`,
    ],
    sections: [
      {
        heading: "Formation",
        body: [
          `Nearly all carbon-12 in the universe is made inside stars by the [[Triple-alpha process|triple-alpha process]], in which three helium-4 nuclei fuse. The reaction runs at a useful rate only because carbon-12 has an excited state at just the right energy, the [[Hoyle state]].`,
        ],
      },
    ],
  },
  "Fred Hoyle": {
    id: 1_200_110,
    description: "British astronomer (1915–2001)",
    lead: [
      `Sir <b>Fred Hoyle</b> (1915–2001) was an English astronomer who did influential work on how chemical elements are formed in stars.[ref] In 1953 he predicted that carbon-12 must have an excited state near 7.7 MeV, a prediction soon confirmed by experiment and now known as the [[Hoyle state]].`,
    ],
    sections: [
      {
        heading: "Steady-state theory",
        body: [
          `Hoyle was a leading advocate of the steady-state model of the universe, in which new matter is continuously created as the universe expands. He coined the name "Big Bang" for the rival theory in a 1949 radio broadcast, and never fully accepted it.`,
        ],
      },
    ],
  },
  "Triple-alpha process": {
    id: 1_200_111,
    description: "Nuclear fusion of helium into carbon in stars",
    lead: [
      `The <b>triple-alpha process</b> is a set of nuclear fusion reactions by which three helium-4 nuclei (alpha particles) are turned into [[Carbon-12|carbon-12]].[ref] It takes place in the cores of stars that have used up their hydrogen and reached temperatures of around 100 million kelvin.`,
    ],
    sections: [
      {
        heading: "Reactions",
        body: [
          `Two helium-4 nuclei first fuse into beryllium-8, which is so unstable that it decays again in about 10<sup>−16</sup> seconds. In the dense core of a star a third helium nucleus occasionally strikes the beryllium-8 before it decays, forming carbon-12 in the excited [[Hoyle state]], which can then settle to the ground state.`,
        ],
      },
    ],
  },
  Mercury: {
    id: 1_200_112,
    description: "Topics referred to by the same term",
    disambiguation: true,
    lead: [
      `<b>Mercury</b> commonly refers to:`,
      [
        `[[Mercury (planet)]], the planet closest to the Sun`,
        `[[Mercury (element)]], a metallic chemical element with the symbol Hg`,
        `[[Mercury (mythology)]], a Roman god`,
      ],
    ],
    sections: [{ heading: "People", body: [[`[[Freddie Mercury]] (1946–1991), British singer of the rock band Queen`]] }],
  },
  "Mercury (planet)": {
    id: 1_200_113,
    description: "First planet from the Sun",
    lead: [
      `<b>Mercury</b> is the smallest planet in the Solar System and the one closest to the Sun, completing an orbit every 88 days.[ref] It has almost no atmosphere, so its surface swings from about −180 °C at night to over 400 °C during the day.`,
    ],
    sections: [
      {
        heading: "Orbit",
        body: [
          `Mercury's orbit is the most eccentric of any planet in the Solar System. A small extra precession of its perihelion, which Newtonian gravity could not explain, was one of the first confirmations of general relativity.`,
        ],
      },
    ],
  },
  "Mercury (element)": {
    id: 1_200_114,
    description: "Chemical element with atomic number 80",
    lead: [
      `<b>Mercury</b> is a chemical element with the symbol Hg and atomic number 80. It is the only metal that is liquid at standard temperature and pressure.[ref] Mercury and many of its compounds are toxic, and its use in thermometers has largely been phased out.`,
    ],
  },
  "Mercury (mythology)": {
    id: 1_200_115,
    description: "Roman god of commerce and messages",
    lead: [
      `<b>Mercury</b> is a major god of Roman religion, associated with commerce, communication, travellers and luck.[ref] He was identified with the Greek god Hermes and is often shown with winged sandals and a winged hat.`,
    ],
  },
  "Freddie Mercury": {
    id: 1_200_116,
    description: "British singer (1946–1991)",
    lead: [
      `<b>Freddie Mercury</b> (born Farrokh Bulsara; 1946–1991) was a British singer and songwriter, famous as the lead vocalist of the rock band Queen.[ref] He was known for his wide vocal range and his flamboyant stage presence.`,
    ],
  },
  "Grey heron": {
    id: 1_200_123,
    description: "Long-legged wading bird of the heron family",
    infobox: `<tr><td colspan="2" class="infobox-image"><span class="mw-default-size" typeof="mw:File/Frameless"><a href="/wiki/File:Grey_heron_at_the_weir.jpg" class="mw-file-description"><img alt="A grey heron standing in shallow water" src="${thumb("a/a1/Grey_heron_at_the_weir.jpg", 250)}" decoding="async" width="250" height="188" class="mw-file-element" srcset="${thumb("a/a1/Grey_heron_at_the_weir.jpg", 375)} 1.5x, ${thumb("a/a1/Grey_heron_at_the_weir.jpg", 500)} 2x" data-file-width="3000" data-file-height="2250" /></a></span><div class="infobox-caption">An adult at a weir</div></td></tr><tr><th scope="row" class="infobox-label">Range</th><td class="infobox-data"><span class="flagicon"><span class="mw-image-border" typeof="mw:File"><span><img alt="" src="${thumb("f/f0/Flag_of_Europe.svg", 23, ".png")}" decoding="async" width="23" height="15" class="mw-file-element" /></span></span></span> Europe</td></tr>`,
    lead: [
      `The <b>grey heron</b> (<i>Ardea cinerea</i>) is a long-legged wading bird of the heron family, native throughout temperate Europe and Asia and parts of Africa.[ref] It hunts by standing motionless in shallow water, at a weir or the edge of a lake, until a fish comes within reach of its bill. It is a bird of rivers, marshes and coasts.`,
    ],
    sections: [
      {
        heading: "Description",
        body: [
          { html: `<figure class="mw-default-size" typeof="mw:File/Thumb"><a href="/wiki/File:Heron_in_flight.jpg" class="mw-file-description"><img src="${thumb("b/b1/Heron_in_flight.jpg", 250)}" decoding="async" width="250" height="167" class="mw-file-element" srcset="${thumb("b/b1/Heron_in_flight.jpg", 375)} 1.5x, ${thumb("b/b1/Heron_in_flight.jpg", 500)} 2x" data-file-width="2400" data-file-height="1600" /></a><figcaption>A heron in flight, its neck folded back</figcaption></figure>` },
          `The grey heron stands nearly a metre tall, with grey upperparts, a white head and neck, and a black stripe running from the eye to the back of the head. In flight it folds its neck back into an S, which tells it apart from cranes and storks at a distance. <span class="flagicon"><span typeof="mw:File"><a href="/wiki/File:Flag_of_Europe.svg" class="mw-file-description"><img alt="" src="${thumb("f/f0/Flag_of_Europe.svg", 20, ".png")}" width="20" height="13" class="mw-file-element noviewer" /></a></span></span> European birds are slightly paler than those further east.`,
          { html: `<figure typeof="mw:File"><a href="/wiki/File:Heron_icon.svg" class="mw-file-description"><img src="${thumb("c/c3/Heron_icon.svg", 24, ".png")}" width="24" height="24" class="mw-file-element" /></a><figcaption>An icon</figcaption></figure>` },
        ],
      },
      {
        heading: "Gallery",
        body: [
          { html: `<ul class="gallery mw-gallery-traditional"><li class="gallerycaption">Herons at the weir</li><li class="gallerybox" style="width: 155px"><div class="thumb" style="width: 150px; height: 150px;"><span typeof="mw:File"><a href="/wiki/File:Heron_fishing.jpg" class="mw-file-description" title="Fishing"><img alt="" src="${thumb("d/d4/Heron_fishing.jpg", 120)}" decoding="async" width="120" height="90" class="mw-file-element" srcset="${thumb("d/d4/Heron_fishing.jpg", 180)} 1.5x, ${thumb("d/d4/Heron_fishing.jpg", 240)} 2x" /></a></span></div><div class="gallerytext">Fishing below the weir</div></li><li class="gallerybox" style="width: 155px"><div class="thumb" style="width: 150px; height: 150px;"><span typeof="mw:File"><a href="/wiki/File:Heron_nest.jpg" class="mw-file-description" title="A nest"><img alt="" src="${thumb("e/e5/Heron_nest.jpg", 120)}" decoding="async" width="120" height="80" class="mw-file-element" srcset="${thumb("e/e5/Heron_nest.jpg", 180)} 1.5x, ${thumb("e/e5/Heron_nest.jpg", 240)} 2x" /></a></span></div><div class="gallerytext">A nest high in an alder</div></li></ul>` },
          `Herons nest in colonies called heronries, usually high in trees near water. The same heronry may be used for decades, and its nests grow larger every year as new sticks are added to the old ones.`,
        ],
      },
      {
        heading: "Behaviour",
        body: [
          { html: `<figure class="mw-default-size" typeof="mw:File/Thumb"><span><video id="mwe_player_0" poster="${thumb("b/b2/Heron_takes_off.webm", 220, "", "-")}" controls="" preload="none" data-mw-tmh="" class="mw-file-element" width="220" height="124" data-durationhint="12" data-mwtitle="Heron_takes_off.webm" data-mwprovider="wikimediacommons" resource="/wiki/File:Heron_takes_off.webm"><source src="//upload.wikimedia.org/wikipedia/commons/b/b2/Heron_takes_off.webm" type="video/webm; codecs=&quot;vp9, opus&quot;" data-width="1920" data-height="1080" /><source src="//upload.wikimedia.org/wikipedia/commons/transcoded/b/b2/Heron_takes_off.webm/Heron_takes_off.webm.480p.vp9.webm" type="video/webm; codecs=&quot;vp9, opus&quot;" data-transcodekey="480p.vp9.webm" data-width="854" data-height="480" /><track src="https://en.wikipedia.org/w/api.php?action=timedtext&amp;title=File%3AHeron_takes_off.webm&amp;lang=en&amp;trackformat=vtt" kind="subtitles" type="text/vtt" srclang="en" /></video></span><figcaption>A heron taking off from the weir</figcaption></figure>` },
          `A heron may stand still for an hour before it strikes. It eats mostly fish, but also frogs, small mammals and young birds, and it will take food from garden ponds.`,
        ],
      },
    ],
  },
  "Slow article": {
    id: 1_200_117,
    description: "Test article whose answers arrive slowly",
    behaviour: "slow",
    lead: [
      `The <b>slow article</b> is a short test page whose every answer takes a few seconds to arrive. It exists so that the interface can show what it does while Wikipedia is slow. It links to the [[Octopus|octopus]] article.`,
    ],
    sections: [
      {
        heading: "Details",
        body: [`Nothing else about it is unusual. Once fetched it is cached like any other article, so opening it a second time is immediate.`],
      },
    ],
  },
  "Offline example": {
    id: 1_200_118,
    description: "Test title for which Wikipedia cannot be reached",
    behaviour: "offline",
    lead: [`Never served: every request about this title fails as if the network were down.`],
  },
  "Rate limited example": {
    id: 1_200_119,
    description: "Test title for which Wikipedia asks the client to slow down",
    behaviour: "rate-limited",
    lead: [`Never served: every request about this title is answered with 429 Too Many Requests.`],
  },
  "Hostile article": {
    id: 1_200_120,
    description: "Test page whose markup must be sanitised",
    extract: "The hostile article is a test page. Its markup tries every trick a sanitiser has to catch.",
    lead: [],
    html: `<div class="mw-content-ltr mw-parser-output" lang="en" dir="ltr"><base href="https://evil.example/">
<meta http-equiv="refresh" content="0;url=https://evil.example/">
<link rel="stylesheet" href="https://evil.example/s.css">
<style>body{background:url(https://evil.example/bg.png)}</style>
<p>The <b>hostile article</b> is a test page.<script>window.__pwned=1</script> Its markup tries every trick a sanitiser has to catch.<img src="https://evil.example/x.png" onerror="window.__pwned=2"> It links to the <a href="/wiki/Octopus" onmouseover="window.__pwned=6" title="Octopus">Octopus</a> article and to <a rel="nofollow" class="external text" href="https://evil.example/page">an external page</a>.</p>
<p style="background-image:url(https://evil.example/p.png)" onclick="window.__pwned=4">Links that must lose their targets: <a href="javascript:window.__pwned=3">click</a>, <a href="JaVaScRiPt:window.__pwned=3">mixed case</a>, <a href="javascript&colon;window.__pwned=7">encoded colon</a>, <a href="java&#x09;script:window.__pwned=7">tab</a>, <a href=" javascript:window.__pwned=7">leading space</a>, <a href="data:text/html,&lt;script&gt;window.__pwned=8&lt;/script&gt;">data</a>, <a href="vbscript:msgbox(1)">vbscript</a>.</p>
<iframe src="https://evil.example/" srcdoc="&lt;script&gt;parent.__pwned=22&lt;/script&gt;"></iframe>
<svg><script>window.__pwned=5</script><a href="javascript:window.__pwned=5"><text>svg link</text></a><animate onbegin="window.__pwned=5" attributeName="x" dur="1s"/></svg>
<div class="mw-heading mw-heading2"><h2 id="Attacks_&lt;img_src=x_onerror=&quot;window.__pwned=9&quot;&gt;">Attacks &lt;img src=x onerror="window.__pwned=9"&gt;</h2></div>
<p>Math: <math xmlns="http://www.w3.org/1998/Math/MathML" href="javascript:window.__pwned=10" display="inline"><mi xlink:href="javascript:window.__pwned=10" onclick="window.__pwned=10">x</mi><maction actiontype="statusline"><mtext>y</mtext><mtext>z</mtext></maction><annotation-xml encoding="text/html"><img src="https://evil.example/m.png" onerror="window.__pwned=10"></annotation-xml></math>.</p>
<form action="https://evil.example/steal" method="post"><input name="q" autofocus onfocus="window.__pwned=11"><button formaction="javascript:window.__pwned=11">Go</button></form>
<object data="https://evil.example/o.swf"></object><embed src="https://evil.example/e.swf">
<video src="https://evil.example/v.mp4" autoplay onplay="window.__pwned=12"></video><audio src="https://evil.example/a.mp3" autoplay></audio>
<table class="wikitable" background="https://evil.example/t.png" style="background:url(https://evil.example/t2.png)"><tbody><tr><th style="color:red" onmouseover="window.__pwned=13">Vector</th><th>Status</th></tr><tr><td background="https://evil.example/td.png" colspan="1">table background</td><td>removed</td></tr></tbody></table>
<div onclick="window.__pwned=14" style="position:fixed;inset:0">A div with a click handler that covers the page.</div>
<p><img src="https://upload.wikimedia.org/wikipedia/commons/x.png" srcset="https://evil.example/1x.png 1x, https://evil.example/2x.png 2x" alt="a picture"><picture><source srcset="https://evil.example/s.png"></picture>Forged attributes: <a href="/wiki/Octopus" data-wiki="Evil" data-wiki-anchor="x" id="app" name="getElementById">octopus again</a>, <a href="//evil.example/protocol-relative">protocol-relative</a>, <a href="#" onclick="window.__pwned=15">anchor</a>, <a href="/wiki/javascript:window.__pwned=21">a title that looks like a script URL</a>.</p>
<details open ontoggle="window.__pwned=16"><summary>details</summary>toggle</details>
<noscript><img src="https://evil.example/ns.png"></noscript><template><img src="x" onerror="window.__pwned=17"></template>
<marquee onstart="window.__pwned=18">marquee</marquee>
<p>Text with &lt;script&gt;window.__pwned=19&lt;/script&gt; written as escaped text, which must stay text.</p>
<figure typeof="mw:File/Thumb"><a href="/wiki/File:Forged.png" class="mw-file-description" onclick="window.__pwned=23"><img src="https://evil.example/thumb.png" srcset="//upload.wikimedia.org/wikipedia/commons/thumb/e/ee/Forged.png/500px-Forged.png 2x, https://evil.example/3x.png 3x" onerror="window.__pwned=24" onload="window.__pwned=24" style="position:fixed" width="250" height="200"></a><figcaption onmouseover="window.__pwned=25">A forged <a href="javascript:window.__pwned=26">caption</a> on a real file</figcaption></figure>
<figure typeof="mw:File/Thumb"><a href="javascript:window.__pwned=27" class="mw-file-description"><img src="//upload.wikimedia.org/wikipedia/commons/x/xx/No_credit.png" width="250" height="200"></a><figcaption>A picture with no file page</figcaption></figure>
<figure typeof="mw:File/Thumb"><a href="/wiki/File:Inline.png" class="mw-file-description"><img src="data:image/png;base64,iVBORw0KGgo=" width="250" height="200"></a><figcaption>A data: picture</figcaption></figure>
<figure typeof="mw:File/Thumb"><a href="/wiki/File:Script.png" class="mw-file-description"><img src="javascript:window.__pwned=28" width="250" height="200"></a><figcaption>A javascript: picture</figcaption></figure>
<figure typeof="mw:File/Thumb"><span><video src="https://evil.example/v.webm" poster="javascript:window.__pwned=29" autoplay loop muted onplay="window.__pwned=30" resource="/wiki/File:Autoplay.webm"><source src="//upload.wikimedia.org/wikipedia/commons/a/aa/Autoplay.webm" type="video/webm"></video></span><figcaption>A video that tries to play by itself</figcaption></figure>
<iframe src="https://www.youtube.com/embed/AAAAAAAAAAA" srcdoc="&lt;script&gt;parent.__pwned=31&lt;/script&gt;"></iframe><iframe src="https://unknown.example/embed"></iframe>
<!-- <script>window.__pwned=20</script> -->
</div>`,
  },
};

/** Redirects to fixtures, as the wiki has them. */
const REDIRECTS: Record<string, string> = {
  "Fixed point combinator": "Fixed-point combinator",
  Octopuses: "Octopus",
  Cephalopods: "Cephalopod",
};

/** A thumbnail's address on upload.wikimedia.org as Wikipedia writes it (protocol-relative); `ext` for an SVG's PNG, `sep` "-" for a video's still. */
function thumb(path: string, width: number, ext = "", sep = "") {
  const name = path.split("/").pop()!;
  return `//upload.wikimedia.org/wikipedia/commons/thumb/${path}/${width}px-${sep}${name}${ext || (sep ? ".jpg" : "")}`;
}

const revisionOf = (f: Fixture) => 1_250_000_000 + f.id;
const wikidataOf = (f: Fixture) => `Q${90_000_000 + f.id}`;
const dbKey = (title: string) => title.replace(/ /g, "_");

// ---- rendering fixtures as action=parse output ----

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const REF = (n: number) =>
  `<sup id="cite_ref-${n}" class="reference"><a href="#cite_note-${n}"><span class="cite-bracket">&#91;</span>${n}<span class="cite-bracket">&#93;</span></a></sup>`;

function inline(markup: string, refs: { n: number }): string {
  return markup
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, t: string, text?: string) => `<a href="/wiki/${encodeURI(dbKey(t))}" title="${escape(t)}">${text ?? t}</a>`)
    .replace(/\[ref\]/g, () => REF(++refs.n));
}

function blocks(body: Block[], refs: { n: number }): string {
  return body
    .map((b) => (typeof b === "string" ? `<p>${inline(b, refs)}\n</p>` : Array.isArray(b) ? `<ul>${b.map((li) => `<li>${inline(li, refs)}</li>`).join("\n")}</ul>` : b.html))
    .join("\n");
}

function pageHtml(title: string, f: Fixture): string {
  if (f.html) return f.html;
  const refs = { n: 0 };
  const parts = [`<div class="mw-content-ltr mw-parser-output" lang="en" dir="ltr">`];
  if (f.description) parts.push(`<div class="shortdescription nomobile noexcerpt noprint searchaux" style="display:none">${escape(f.description)}</div>`);
  if (f.hatnote) {
    parts.push(`<style data-mw-deduplicate="TemplateStyles:r1236090951">.mw-parser-output .hatnote{font-style:italic}</style>`);
    parts.push(`<div role="note" class="hatnote navigation-not-searchable">${f.hatnote}</div>`);
  }
  parts.push(`<p class="mw-empty-elt">\n</p>`);
  if (f.disambiguation) {
    parts.push(blocks(f.lead, refs));
  } else {
    parts.push(
      `<table class="infobox"><caption class="infobox-title">${escape(title)}</caption><tbody>${f.infobox ?? ""}<tr><th scope="row" class="infobox-label">Summary</th><td class="infobox-data">${escape(f.description ?? "")}</td></tr></tbody></table>`,
    );
    parts.push(blocks(f.lead, refs));
  }
  if (f.sections?.length) parts.push(`<meta property="mw:PageProp/toc" />`);
  for (const s of f.sections ?? []) {
    const h = s.level === 3 ? "h3" : "h2";
    parts.push(`<div class="mw-heading mw-heading${h[1]}"><${h} id="${escape(dbKey(s.heading))}">${escape(s.heading)}</${h}></div>`);
    parts.push(blocks(s.body, refs));
  }
  if (f.disambiguation) {
    parts.push(
      `<div id="disambigbox" class="metadata plainlinks dmbox dmbox-disambig" role="note">This <a href="/wiki/Help:Disambiguation" title="Help:Disambiguation">disambiguation</a> page lists articles associated with the title <b>${escape(title)}</b>.</div>`,
    );
  } else {
    const links = leadLinks(f).map((t) => `<li><a href="/wiki/${encodeURI(dbKey(t))}" title="${escape(t)}">${escape(t)}</a></li>`);
    parts.push(
      `<div role="navigation" class="navbox" aria-label="Navbox"><table class="nowraplinks navbox-inner"><tbody><tr><th scope="col" class="navbox-title">Related articles</th></tr><tr><td class="navbox-list"><ul>${links.join("")}</ul></td></tr></tbody></table></div>`,
    );
  }
  if (refs.n) {
    const notes = Array.from({ length: refs.n }, (_, i) => `<li id="cite_note-${i + 1}"><span class="reference-text">A source.</span></li>`);
    parts.push(`<div class="reflist"><div class="mw-references-wrap"><ol class="references">${notes.join("")}</ol></div></div>`);
  }
  parts.push(`</div>`);
  return parts.join("\n");
}

/** Link targets written in the lead, in order. */
function leadLinks(f: Fixture): string[] {
  const text = f.lead.filter((b): b is string | string[] => typeof b === "string" || Array.isArray(b)).flat().join(" ");
  return [...new Set([...text.matchAll(/\[\[([^\]|]+)/g)].map((m) => m[1]))];
}

/** Main-namespace link targets anywhere on the page, as generator=links sees them. */
function pageLinks(title: string, f: Fixture): string[] {
  const out = new Set<string>();
  for (const m of pageHtml(title, f).matchAll(/href="\/wiki\/([^"#]+)/g)) {
    const t = safeDecode(m[1]).replace(/_/g, " ");
    if (!/^[^:]+:\S/.test(t)) out.add(t);
  }
  return [...out];
}

function safeDecode(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Plain text of the given blocks: links as their text, tags and reference markers removed. */
function plain(body: Block[]): string {
  return body
    .filter((b): b is string | string[] => typeof b === "string" || Array.isArray(b))
    .flat()
    .join("\n")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, t: string, text?: string) => text ?? t)
    .replace(/\[ref\]/g, "")
    .replace(/<annotation[\s\S]*?<\/annotation>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&");
}

const extractOf = (f: Fixture) => f.extract ?? plain(f.lead.filter((b) => typeof b === "string"));
const fullText = (f: Fixture) => [extractOf(f), ...(f.html ? [] : (f.sections ?? []).map((s) => plain(s.body)))].join("\n");

function tocdata(title: string, f: Fixture) {
  let h2 = 0;
  let h3 = 0;
  return (f.sections ?? []).map((s, i) => {
    const level = s.level === 3 ? 3 : 2;
    if (level === 2) (h2++, (h3 = 0));
    else h3++;
    return {
      tocLevel: level - 1,
      hLevel: level,
      line: escape(s.heading),
      number: level === 2 ? String(h2) : `${h2}.${h3}`,
      index: String(i + 1),
      fromTitle: dbKey(title),
      codepointOffset: null,
      anchor: dbKey(s.heading),
      linkAnchor: dbKey(s.heading),
    };
  });
}

// ---- titles ----

/** MediaWiki's normalisation for the main namespace: underscores to spaces, first letter up. */
function normalise(t: string): string {
  const s = t.replace(/_/g, " ").replace(/\s+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function find(title: string): { title: string; f: Fixture; from?: string } | null {
  const t = normalise(title);
  const target = REDIRECTS[t] ?? t;
  const f = FIXTURES[target];
  return f ? { title: target, f, ...(REDIRECTS[t] ? { from: t } : {}) } : null;
}

/** The titles a request is about, for the misbehaving fixtures. */
function subjects(url: URL): string[] {
  const p = url.searchParams;
  if (url.pathname.startsWith("/api/rest_v1/page/summary/")) return [safeDecode(url.pathname.slice("/api/rest_v1/page/summary/".length))];
  if (url.pathname.startsWith("/w/rest.php/v1/search/")) {
    const q = (p.get("q") ?? "").trim().toLowerCase();
    return Object.keys(FIXTURES).filter((t) => t.toLowerCase() === q);
  }
  if (p.get("action") === "parse") return [p.get("page") ?? ""];
  return (p.get("titles") ?? "").split("|");
}

// ---- answers ----

const json = (v: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });

function summary(url: URL): Response {
  const raw = safeDecode(url.pathname.slice("/api/rest_v1/page/summary/".length));
  const hit = find(raw);
  if (!hit) {
    return json(
      { type: "https://mediawiki.org/wiki/HyperSwitch/errors/not_found", title: "Not found.", method: "get", detail: "Page or revision not found.", uri: `/${url.host}/v1/page/summary/${raw}` },
      404,
      { "content-type": "application/problem+json" },
    );
  }
  // The real endpoint answers a redirect with 302 to the target; fetch follows it, so the
  // client only ever sees the target's summary.
  const { title, f } = hit;
  const extract = extractOf(f);
  const page = `${url.origin}/wiki/${encodeURIComponent(dbKey(title))}`;
  return json({
    type: f.disambiguation ? "disambiguation" : "standard",
    title: dbKey(title),
    displaytitle: `<span class="mw-page-title-main">${escape(title)}</span>`,
    namespace: { id: 0, text: "" },
    wikibase_item: wikidataOf(f),
    titles: { canonical: dbKey(title), normalized: title, display: `<span class="mw-page-title-main">${escape(title)}</span>` },
    pageid: f.id,
    lang: "en",
    dir: "ltr",
    revision: String(revisionOf(f)),
    tid: "00000000-0000-11f0-0000-000000000000",
    timestamp: "2026-11-01T12:00:00Z",
    ...(f.description ? { description: f.description, description_source: "local" } : {}),
    content_urls: {
      desktop: { page, revisions: `${page}?action=history`, edit: `${page}?action=edit`, talk: `${url.origin}/wiki/Talk:${encodeURIComponent(dbKey(title))}` },
      mobile: { page: page.replace(".wikipedia.org", ".m.wikipedia.org"), revisions: "", edit: "", talk: "" },
    },
    extract,
    extract_html: extract
      .split("\n")
      .map((p) => `<p>${escape(p)}</p>`)
      .join(""),
  });
}

/** One page object as action=query returns it, with what `prop` asked for. */
function queryPage(title: string, props: string[]) {
  const f = FIXTURES[title];
  if (!f) return { ns: 0, title, missing: true };
  const pageprops = { ...(f.disambiguation ? { disambiguation: "" } : {}), wikibase_item: wikidataOf(f) };
  return {
    pageid: f.id,
    ns: 0,
    title,
    ...(props.includes("description") && f.description ? { description: f.description, descriptionsource: "local" } : {}),
    ...(props.includes("pageprops") ? { pageprops } : {}),
    ...(props.includes("extracts") ? { extract: extractOf(f) } : {}),
    ...(props.includes("info") ? { contentmodel: "wikitext", pagelanguage: "en", touched: "2026-11-01T12:00:00Z", lastrevid: revisionOf(f), length: fullText(f).length } : {}),
  };
}

function query(url: URL): Response {
  const p = url.searchParams;
  const props = (p.get("prop") ?? "").split("|");
  const asked = (p.get("titles") ?? "").split("|").filter(Boolean);
  const normalized: { fromencoded: false; from: string; to: string }[] = [];
  const redirects: { from: string; to: string }[] = [];
  const ended: string[] = [];
  for (const t of asked) {
    const n = normalise(t);
    if (n !== t) normalized.push({ fromencoded: false, from: t, to: n });
    const to = REDIRECTS[n];
    if (to) redirects.push({ from: n, to });
    if (!ended.includes(to ?? n)) ended.push(to ?? n);
  }
  if (p.get("generator") === "links") {
    // The links on the asked page(s), each as a page of its own.
    const linked = ended.flatMap((t) => (FIXTURES[t] ? pageLinks(t, FIXTURES[t]) : []));
    if (!linked.length) return json({ batchcomplete: true });
    return json({ batchcomplete: true, query: { ...(redirects.length ? { redirects } : {}), pages: linked.map((t) => queryPage(t, props)) } });
  }
  return json({
    batchcomplete: true,
    query: {
      ...(normalized.length ? { normalized } : {}),
      ...(redirects.length ? { redirects } : {}),
      pages: ended.map((t) => queryPage(t, props)),
    },
  });
}

function parse(url: URL): Response {
  const asked = url.searchParams.get("page") ?? "";
  const hit = find(asked);
  if (!hit) {
    return json(
      { error: { code: "missingtitle", info: "The page you specified doesn't exist.", docref: "See https://en.wikipedia.org/w/api.php for API usage." }, servedby: "mw-api-mock" },
      200,
      { "mediawiki-api-error": "missingtitle" },
    );
  }
  const { title, f, from } = hit;
  return json({
    parse: {
      ...(from ? { redirects: [{ from, to: title }] } : {}),
      title,
      pageid: f.id,
      revid: revisionOf(f),
      displaytitle: `<span class="mw-page-title-main">${escape(title)}</span>`,
      text: pageHtml(title, f),
      tocdata: { sections: f.html ? [] : tocdata(title, f) },
      properties: { ...(f.disambiguation ? { disambiguation: "" } : {}), wikibase_item: wikidataOf(f) },
    },
  });
}

/** search/title: case-insensitive prefix of the title or of any word in it, redirects included. */
function searchTitle(url: URL): Response {
  const q = (url.searchParams.get("q") ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  const limit = Number(url.searchParams.get("limit") ?? 10) || 10;
  const names = [...Object.keys(FIXTURES), ...Object.keys(REDIRECTS)];
  const rank = (name: string) => {
    const n = name.toLowerCase();
    if (n.startsWith(q)) return 0;
    return [" ", "(", "-"].some((sep) => n.includes(sep + q)) ? 1 : -1;
  };
  const seen = new Set<string>();
  const pages = names
    .map((name) => ({ name, r: q ? rank(name) : -1 }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r)
    .flatMap(({ name }) => {
      const title = REDIRECTS[name] ?? name;
      if (seen.has(title)) return [];
      seen.add(title);
      const f = FIXTURES[title];
      return [{ id: f.id, key: dbKey(title), title, excerpt: escape(title), matched_title: REDIRECTS[name] ? name : null, anchor: null, description: f.description, thumbnail: null }];
    });
  return json({ pages: pages.slice(0, limit) });
}

function wait(ms: number, signal?: AbortSignal | null) {
  return new Promise<void>((done, fail) => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), fail(signal.reason)), { once: true });
  });
}

/**
 * A fetch that answers like Wikipedia; `slowMs` is how long "Slow article" takes. `bulkMs` delays
 * every request made for background work (those carry maxlag), so a test can watch a bulk link
 * pass make progress and cancel it, as it would against the real, rate-limited Wikipedia.
 */
export function makeMockWikiFetch(slowMs = SLOW_MS, bulkMs = 0): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const signal = init?.signal;
    signal?.throwIfAborted();
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "upload.wikimedia.org") return new Response(TINY_PNG, { headers: { "content-type": "image/png" } });
    if (bulkMs && url.searchParams.has("maxlag")) await wait(bulkMs, signal);
    const about = subjects(url).map((t) => find(t)?.f.behaviour);
    if (about.includes("offline")) throw new TypeError("fetch failed");
    if (about.includes("rate-limited")) {
      return json({ httpCode: 429, httpReason: "Too Many Requests" }, 429, { "retry-after": "0" });
    }
    if (about.includes("slow")) await wait(slowMs, signal);
    const p = url.searchParams;
    if (url.pathname.startsWith("/api/rest_v1/page/summary/")) return summary(url);
    if (url.pathname === "/w/rest.php/v1/search/title") return searchTitle(url);
    if (url.pathname === "/w/api.php" && p.get("action") === "parse") return parse(url);
    if (url.pathname === "/w/api.php" && p.get("action") === "query") return query(url);
    return json({ error: { code: "badrequest", info: `The mock does not answer ${url.pathname}` } }, 400);
  }) as typeof fetch;
}

export const mockWikiFetch: typeof fetch = makeMockWikiFetch();
