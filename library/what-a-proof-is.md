# What a proof is

A proof is supposed to be an argument that compels belief. In principle it is a chain of steps so small that each can be checked mechanically. In practice, for most of history, it has been a persuasive essay written for experts, accepted when enough of them are convinced. The two ideas pulled apart in the twentieth century, and computers are now pulling them back together.

## Two ideas of proof

There is the formal proof, a sequence of formulas each following from earlier ones by a stated rule, and there is the proof as mathematicians write it, an argument in prose that convinces a trained reader that a formal proof could be produced. Nearly all mathematics lives in the second form.

### The formal ideal

In a formal proof nothing is left to judgment. Every step cites a rule, and checking is clerical work. The ideal goes back to Euclid, who derived geometry from a short list of stated assumptions, and it was made exact around 1900 by Frege, Peano, Russell and Hilbert, who showed that all of mathematics could in principle be written this way.

^ "in principle" note example: Russell and Whitehead tried it in practice. Their *Principia Mathematica* reaches the proposition that one plus one is two several hundred pages in, with the remark that it is occasionally useful.

### The working practice

A published proof skips almost everything. It says *clearly* and *by a standard argument*, relies on the reader's training, and aims to transmit understanding of why the result holds. Expanding a research paper into full formal detail multiplies its length many times over. Nobody did this until recently, and mathematics worked anyway.

^ "multiplies its length many times over" gloss define: the factor is sometimes called the de Bruijn factor
^ "mathematics worked anyway" note why: Errors in published proofs are common, but most are local and repairable, because the author's understanding was right even where the written step was wrong. Understanding is more robust than text.

### Why the gap matters

The practice rests on trust that the gaps can be filled. When a proof is short, many readers check it and the trust is earned. When a proof runs to hundreds of pages or leans on a computer, few people or none can check all of it, and the question of what the community actually knows becomes real.

## When proofs got too big

Three results in the late twentieth century strained the social process: one needed a computer, one was too long for any person, and one was too hard for its referees to certify.

### The four colour theorem

Any map can be coloured with four colours so that no neighbouring regions match. In 1976 Kenneth Appel and Wolfgang Haken proved it by reducing the problem to nearly two thousand configurations and checking each by computer, using over a thousand hours of machine time. Many mathematicians were unhappy. The proof could not be read, and it gave no insight into why four suffices.

^ "Many mathematicians were unhappy" note elaborate: The philosopher Thomas Tymoczko argued that it changed the meaning of the word theorem, since accepting it required trusting an experiment. Others replied that trusting a referee's stamina is no different.

### The enormous theorem

The classification of the finite simple groups, the basic building blocks of symmetry, was declared complete around 1983. Its proof is spread over some ten thousand pages in hundreds of papers by about a hundred authors. A gap in one part was closed only in 2004, with a further 1,200 pages. Few living people understand the whole.

^ "Few living people understand the whole" note elaborate: A project to rewrite the proof in a unified series of volumes began in the 1990s and continues, partly out of fear that the knowledge would otherwise die with the generation that created it.

### Kepler's conjecture

Kepler guessed in 1611 that no packing of equal spheres is denser than the greengrocer's stack of oranges. Thomas Hales announced a proof in 1998: 250 pages of argument and three gigabytes of computation. Twelve referees worked on it for four years and reported that they were 99 percent certain it was right but could not check the computer part. The journal published it with that caveat.

## Proof assistants

A proof assistant is a program that checks formal proofs, with a small trusted core, surrounded by tools that help a human write them. After decades as a niche of computer science, these systems became able to handle frontier mathematics in the 2010s.

### How they work

The user states a theorem in a precise formal language and builds its proof interactively, with the system tracking what remains to be shown. Automation fills in routine steps. Whatever the automation does, the result is a proof object that the small core checks independently, so a bug in the clever parts cannot produce a false theorem.

^ "the small core checks independently" note define: This design is called the de Bruijn criterion. Only the checker, a few thousand lines of code, has to be trusted. Everything else may be as elaborate and unreliable as you like.

### Proofs as programs

Several of the leading systems rest on a discovery from logic: a proposition can be read as a type, and a proof of it as a program of that type. A proof that *A* implies *B* is a function turning proofs of *A* into proofs of *B*. Checking a proof is then type-checking a program, which is something computers already do well.

^ "a proposition can be read as a type" gloss define: the Curry–Howard correspondence

### Milestones

Georges Gonthier and colleagues formalised the four colour theorem in 2005, removing the need to trust the original programs. Hales, stung by his referees' verdict, led a project called Flyspeck that formally verified his Kepler proof in 2014. In 2012 Gonthier's team finished a six-year formalisation of the odd order theorem, a 255-page cornerstone of group theory.

^ "removing the need to trust the original programs" note challenge: Something must still be trusted: the checker's core, the compiler, the hardware, and above all that the formal statement says what the informal theorem means. The risk shrinks to a few readable definitions, but it does not vanish.

## Mathematics meets the machine

Since about 2020, working mathematicians have begun using proof assistants on new research, and a large shared library of formalised mathematics has made that practical.

### A library

Lean's community library, mathlib, holds well over a million lines of formalised mathematics, from basic algebra to graduate-level topics, built by hundreds of contributors. Its existence matters more than any single proof. A new formalisation can stand on it instead of starting from the axioms.

### The liquid tensor experiment

In late 2020 the Fields medallist Peter Scholze posted a challenge. He had a new and intricate proof at the foundation of his recent work, was not fully certain of it, and asked whether it could be formally checked. A team led by Johan Commelin verified the key part in six months and the whole in 2022. Scholze said the process helped him understand his own argument.

^ "was not fully certain of it" note elaborate: He wrote that he thought the theorem might be his most important to date and that with an argument so intricate he still had small lingering doubts, which for a foundation he did not consider acceptable.

### Collaboration at scale

In 2023 Terence Tao and others formalised a new proof in combinatorics within three weeks of the paper appearing, with some twenty people contributing. The work was split into small lemmas that strangers could prove independently, because the checker guarantees the pieces fit. Trust in each contributor is no longer needed.

^ "a new proof in combinatorics" gloss define: of the polynomial Freiman–Ruzsa conjecture, by Gowers, Green, Manners and Tao

## What changes

Language models have begun to write formal proofs, and a formal proof is one kind of machine output whose correctness does not have to be taken on trust. This shifts the scarce resource in mathematics from checking toward stating and understanding.

### Machines that prove

In 2024 a system from DeepMind solved four of the six problems of that year's International Mathematical Olympiad, producing formal proofs for the algebra and number theory problems that a checker verified. A model's fluent argument in prose may be wrong in ways that are hard to spot. A formal proof that passes the checker is right, whoever or whatever wrote it.

^ "is right, whoever or whatever wrote it" note challenge: Right about the formal statement, that is. A machine can also prove a statement that was formalised incorrectly, and a wrong definition can make a hard theorem trivially true. Reading the statement carefully remains a human job.

### What proofs are for

If certainty were the only aim, a checked proof no one understands would be as good as any. Mathematicians have never behaved as if that were so. They reprove known theorems to find better reasons, and prize a proof that explains over one that merely verifies. William Thurston put it that the goal is human understanding of mathematics, with theorems as a by-product.

### What stays human

Choosing what is worth proving, finding the right definitions and recognising that an argument illuminates are not checking tasks. Formal verification takes over the part of the referee's job that people do worst. What it leaves is the part that made the subject worth doing.
