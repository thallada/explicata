# Fixed points

A fixed point of a function is an input the function leaves alone: *f(x) = x*. That one small idea turns up as the reason recursion can be defined without names, the reason arithmetic contains statements about itself, the reason iterating a formula can solve an equation, and the reason a web page has a rank. This document follows the idea through six places it lives.

## The idea itself

A fixed point is a value that a transformation maps to itself. Whether one exists, whether it is unique and whether you can find it depend on what kind of function you have, and each of the famous fixed-point theorems is an answer to those three questions for one kind of function. The theorems split into two families: those that tell you a fixed point exists and those that hand you a way to reach it.

^ "exists and those that hand you a way to reach it" note example: Brouwer's theorem is of the first kind: it proves a point exists and says nothing about where. Banach's is of the second: it gives a procedure and an error bound.

### Three questions

Take the function that halves a number. Its only fixed point is zero, and repeated halving from anywhere arrives there. Take squaring: zero and one are both fixed, but only zero attracts nearby starting points, and one repels them. Take adding one: nothing is fixed at all. Existence, uniqueness and reachability are separate properties, and a theorem that grants one often stays silent about the others.

^ "one repels them" note elaborate: Start at 1.01 and square repeatedly and you run off to infinity; start at 0.99 and you fall to zero. A fixed point is stable when the function's slope there is smaller than one in size, and squaring has slope two at one.

### Why they matter

An equation can usually be rearranged into the form *x = f(x)*, so solving it is finding a fixed point. A self-referential definition says a thing equals some expression containing that same thing, which is the same form again. So the study of fixed points is the study of two things at once: solutions and self-reference.

## Recursion without names

In the lambda calculus functions have no names, so a function cannot call itself by name. Recursion is recovered with a fixed-point combinator, a term that takes a function and returns a fixed point of it. The best known is the Y combinator. It shows that self-reference does not have to be built into a language: self-application is enough.

^ "lambda calculus" gloss define: Alonzo Church's 1930s notation in which everything is an anonymous function
^ "self-application" note define: Applying a term to itself, written *x x*. It is the only ingredient the Y combinator needs beyond ordinary function application.

### How Y works

Write a recursive function as if it received itself as an extra argument. Factorial becomes a function *F* that takes a function *self* and returns a function of *n* which calls *self* on *n − 1*. The function we actually want is one that, when handed to *F*, comes back unchanged: a fixed point of *F*. Y builds that fixed point by making a term that, when run, rebuilds a copy of itself and hands the copy to *F*.

^ "rebuilds a copy of itself" passage elaborate: The term is *λf. (λx. f (x x)) (λx. f (x x))*. The inner piece is applied to itself, and one step of evaluation turns *(λx. f (x x)) (λx. f (x x))* into *f* applied to that same expression.

  So *Y f* reduces to *f (Y f)*, which is exactly the statement that *Y f* is a fixed point of *f*. Nothing was named; the copying did the work.
  ^ "one step of evaluation" note challenge: In a language that evaluates arguments first, this step repeats forever before *f* ever runs. Such languages use a variant, often called Z, that wraps the self-application in a function so that it waits until called.

### What it buys

Any language with first-class functions therefore has recursion whether or not its designers provided it. This is one route to the fact that the lambda calculus computes everything a Turing machine can. It also explains a limit: because every function has a fixed point there, the untyped calculus cannot be given a consistent reading as logic, and type systems that restore consistency do it by ruling out the self-application Y depends on.

^ "ruling out the self-application" note elaborate: In the simply typed lambda calculus *x x* has no type, since *x* would have to be a function whose argument type is its own type. Every program in that calculus halts, and the price is that general recursion is gone.

## Sentences about themselves

Gödel's incompleteness theorem rests on a fixed point too. The diagonal lemma says that for any property of sentences expressible in arithmetic, there is a sentence that asserts that property of itself. Apply it to the property of not being provable and you get a sentence that says, in effect, that it has no proof.

### The diagonal lemma

Sentences can be numbered, so a formula about numbers can be read as a formula about sentences. The lemma constructs, for any formula *P*, a sentence *G* that is provably equivalent to *P* applied to *G*'s own number. *G* is a fixed point of *P*, up to provable equivalence. The construction is the same trick as Y: a piece of text that describes how to build a copy of itself and then says something about the copy.

^ "Sentences can be numbered" note elaborate: Gödel coded each symbol as a number and each string as a product of prime powers. Any reversible encoding works; today one would just say the sentence is a file and the number is its bytes.

### From the lemma to incompleteness

Let *P* be the property of being unprovable in some consistent system strong enough to do arithmetic. The fixed point *G* is equivalent to its own unprovability. If the system proved *G* it would be proving a falsehood about its own proofs, so it does not; and then what *G* says is true. The system has a true sentence it cannot prove.

^ "it would be proving a falsehood" note challenge: This step needs the system to be sound about such statements, or a slightly stronger consistency assumption. Rosser later reworked the sentence so that plain consistency suffices.

### Quines

A quine is a program that prints its own source. It exists in every reasonable language for the same reason, and Kleene's recursion theorem states it in general: any program can be written as though it had access to its own text. Viruses, self-hosting compilers and Ken Thompson's compiler backdoor are all uses of that licence.

^ "Ken Thompson's compiler backdoor" note elaborate: In his 1984 lecture *Reflections on Trusting Trust*, Thompson described a compiler that inserts a backdoor when it compiles the login program and reinserts the insertion code when it compiles itself, so the source of both can be clean.

## Iterating to an answer

When a function pulls points closer together, applying it over and over converges to its one fixed point. That is the Banach fixed-point theorem, and it is the reason behind much of numerical computing: write the unknown as a fixed point of a contraction and iterate.

^ "contraction" gloss define: a map that shrinks every distance by at least some fixed factor below one

### The contraction principle

Suppose a map shrinks the distance between any two points by a factor of at most *k*, with *k* less than one, on a space with no missing limit points. Then there is exactly one fixed point, iteration from any start converges to it, and after *n* steps the error is at most a constant times *k* to the *n*. Existence, uniqueness, an algorithm and an error bound all come from one hypothesis.

^ "no missing limit points" note define: The technical word is complete. The rationals are not: iterating toward the square root of two stays inside the rationals forever while the limit lies outside them.

### Where it is used

Newton's method for roots is a fixed-point iteration, and near a simple root it is a contraction so strong that the number of correct digits roughly doubles each step. The standard proof that a differential equation has a unique solution, due to Picard and Lindelöf, rewrites the equation as a fixed point of an integral operator. Value iteration in reinforcement learning converges because the Bellman update is a contraction with factor equal to the discount rate.

^ "the number of correct digits roughly doubles each step" note example: Computing the square root of two from a start of 1 gives 1.5, then 1.4167, then 1.414216, then a value correct to eleven digits.

## Points that cannot move

Brouwer's theorem says every continuous map from a disc to itself has a fixed point. No contraction is needed and no procedure is given: the fixed point exists for topological reasons. From it and its generalisations come existence proofs across economics and game theory.

### Brouwer's theorem

Stir a cup of coffee smoothly, without splashing, and at the end some point of the liquid is where it started. Crumple a map of a country and drop it on the floor inside that country and some point of the map lies directly over the place it depicts. The proof works by contradiction: a map with no fixed point could be used to pull the whole disc onto its rim without tearing, which cannot be done.

^ "which cannot be done" note why: The rim has a hole and the disc does not, and continuous maps cannot create that difference. Making this precise was one of the first uses of algebraic topology.

### Equilibria

John Nash's proof that every finite game has an equilibrium is one paragraph long once you have Kakutani's generalisation of Brouwer. Define a map that sends each profile of strategies to the players' best responses to it. A fixed point is a profile where everyone is already responding best to everyone else, which is the definition of equilibrium. The proof guarantees one exists and gives no hint how to find it.

^ "no hint how to find it" note elaborate: The gap is real. Computing a Nash equilibrium is complete for a complexity class called PPAD, which is believed to contain problems with no efficient algorithm.

## A fixed point you use every day

PageRank defines a page's importance as the sum of the importance passed to it by pages that link to it. The definition is circular, and the ranking is its fixed point. It is found by the plainest method available, repeated application, and the reason that works ties the earlier sections together.

### The definition

Imagine a reader who clicks a random link on each page, and now and then jumps to a random page instead. The rank of a page is the fraction of time that reader spends on it in the long run. One step of reading turns one distribution over pages into another, and the long-run distribution is the one that a step leaves unchanged.

^ "now and then jumps to a random page" note why: Without the jump the reader can get trapped in a set of pages that link only to each other, and the fixed point need not be unique. With it, usually set at 15 percent of steps, every page can be reached from every other.

### Why iteration finds it

The random jump makes the update a contraction: each step shrinks the difference between any two distributions by the fraction of time spent following links. Banach's theorem then gives a unique ranking and geometric convergence. A definition that looked circular turns out to be a well-posed equation, and a few dozen passes over the link graph solve it.
