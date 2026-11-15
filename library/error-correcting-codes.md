# Error-correcting codes

Every channel makes mistakes: radio fades, discs scratch, memory cells flip. Error-correcting codes add carefully structured redundancy so the receiver can work out what was sent anyway. In 1948 Claude Shannon proved that this can be done almost perfectly up to a sharp limit, and the following sixty years were spent learning how to reach it.

## The problem

To protect a message you must send more than the message. The naive way, repeating everything, is ruinously wasteful. The question that opened the field was how little extra you can send and still recover from a given amount of damage.

### Repetition

Send each bit three times and take a majority vote. One flipped bit in a group of three is outvoted. But two thirds of the transmission is now overhead, and two flips in a group still defeat it. Repeating five or seven times helps the error rate and makes the waste worse. It looks as though reliability can only be bought by slowing toward a standstill.

^ "slowing toward a standstill" note elaborate: This was the general belief before 1948: to make errors rarer you must send more copies, so the useful rate has to fall toward zero as reliability rises toward certainty. Shannon showed the belief was false.

### Distance

Think of the valid messages as points, with the distance between two being the number of positions where they differ. Damage moves a point a short way. If valid points are all at least three apart, any single error leaves the received word closer to the original than to any other, and it can be corrected. Designing a code is packing points far apart in a space of bit strings.

^ "the number of positions where they differ" gloss define: called the Hamming distance
^ "at least three apart" note elaborate: In general a minimum distance of *d* lets the receiver detect *d − 1* errors or correct half that many, rounded down. Distance three corrects one; distance five corrects two.

## Shannon's limit

Shannon showed that every channel has a capacity, a rate in bits per use, and that below it communication can be made as reliable as you like while above it reliability is impossible. The limit is sharp and has nothing to do with engineering skill. His proof showed that good codes exist without exhibiting one.

### Capacity

For a channel that flips each bit with probability one in ten, the capacity is about 0.53. That means a code exists that turns each 1,000 message bits into about 1,900 sent bits and yet fails as rarely as you care to demand. Triple repetition, by contrast, spends 3,000 bits and still fails on about three percent of bits.

^ "about three percent" note elaborate: A group of three fails when two or three of its bits flip. With a flip probability of 0.1 that is 3 × 0.01 × 0.9 plus 0.001, or 2.8 percent.

### The random coding argument

Shannon did not construct a code. He showed that if you pick codewords at random, the average code works, so some code must. The cost is hidden in the decoding: a random code has no structure, and finding the nearest codeword means searching all of them. The practical problem became finding codes with enough structure to decode fast and enough randomness to be good.

^ "the average code works" note why: Long random codewords are almost certainly far apart, because in a high-dimensional space nearly all pairs of points are about equally distant. Noise moves the sent word by a predictable amount, and with high probability no other codeword lies within that range.

## Algebra

The first practical codes got their structure from algebra. Hamming's codes locate a single error by arithmetic on parity checks. Reed and Solomon treated the message as a polynomial, which gives codes that shrug off long bursts of damage and are still in almost every storage device.

### Hamming's code

Richard Hamming, tired of a relay computer at Bell Labs that halted his weekend jobs whenever it detected an error, asked why it could not also find the error. His answer adds three check bits to four data bits. Each check covers a different subset of positions, arranged so that the pattern of failed checks, read as a binary number, is the position of the flipped bit.

^ "the pattern of failed checks, read as a binary number, is the position of the flipped bit" passage example: Number the seven positions 1 to 7 and write each number in binary. The first check covers every position whose number has a 1 in the lowest binary digit: 1, 3, 5, 7. The second covers those with a 1 in the middle digit: 2, 3, 6, 7. The third covers 4, 5, 6, 7.

  If position 6 is flipped, the second and third checks fail and the first passes. Reading the failures as binary digits gives 110, which is six.

### Reed–Solomon

Take the message symbols as the coefficients of a polynomial and send its values at more points than strictly needed. A polynomial of degree less than *k* is fixed by any *k* of its values, so the extra values are redundancy, and the receiver can recover the polynomial even if some values are missing or wrong. The symbols are bytes, not bits, so a burst of bad bits spoils only a few symbols.

^ "fixed by any *k* of its values" note example: Two points fix a line. Send three points of a line and the receiver can lose any one; send four and the receiver can spot and outvote one that is wrong.

### Where they are

A compact disc uses two Reed–Solomon codes with the data shuffled between them, and can play through a scratch that destroys about 4,000 consecutive bits. QR codes use them, which is why a code still scans with a logo covering its middle. Storage arrays use them to survive the loss of whole drives.

^ "with the data shuffled between them" note why: Shuffling spreads a long burst of damage thinly across many codewords, so each sees only a few bad symbols, which it can correct.

## Probability

The codes that finally reached Shannon's limit came from a different idea: build a long code out of many small, loosely connected constraints and decode by letting them exchange probabilistic opinions. Turbo codes in 1993 and the rediscovery of low-density parity-check codes soon after closed a gap that had stood for decades.

### Turbo codes

In 1993 Claude Berrou and Alain Glavieux presented a code that came within half a decibel of the Shannon limit. Experts assumed an error, since nothing had come close. The design encodes the data twice, the second time in scrambled order, and runs two decoders that pass each other their growing confidence about each bit, round after round.

^ "half a decibel" note define: A decibel measures a ratio of powers on a logarithmic scale. Half a decibel means the code needed only about twelve percent more signal power than the theoretical minimum; the best earlier systems needed well over twice the minimum.

### Low-density parity-check codes

Robert Gallager described these in his 1960 doctoral thesis: thousands of parity checks, each touching only a few bits. Decoding passes messages back and forth along the connections between bits and checks until the beliefs settle. The computers of 1960 could not run it, and the idea lay almost forgotten until David MacKay and others revived it in the 1990s.

^ "each touching only a few bits" note why: Sparseness is what makes the decoding cheap and accurate. Each check's opinion about a bit depends on only a handful of others, and in a sparse graph the opinions arriving at a bit are nearly independent, which is what the method assumes.

### Polar codes

In 2008 Erdal Arıkan gave the first construction with a proof that it achieves capacity with practical decoding. It combines copies of the channel so that some become nearly perfect and the rest nearly useless, then sends data only on the good ones. Modern mobile networks use polar codes for control messages and low-density parity-check codes for data.

## In the wild

The best showcase is deep space, where signal power cannot be bought. But the codes are also in every phone, disc, drive and memory chip, mostly unnoticed, and the same mathematics now protects quantum computers.

### Deep space

Voyager 1 transmits with about twenty watts, less than a refrigerator bulb, from more than twenty billion kilometres away. The power collected by a seventy-metre dish on Earth is less than a billionth of a billionth of a watt. Its coding, a convolutional code wrapped in a Reed–Solomon code, is what makes that readable.

^ "a convolutional code wrapped in a Reed–Solomon code" note elaborate: The inner code handles random noise and, when it fails, tends to emit a short burst of errors. The outer Reed–Solomon code is good at bursts. Each covers the other's weakness.

### Memory

Servers use memory that stores eight check bits with every sixty-four data bits, an extended Hamming code that corrects any single flipped bit and detects any two. Flash drives lean much harder on coding: the raw error rate of a modern flash cell is so high that the drive would be unusable without a strong code under it.

### Quantum error correction

A quantum state cannot be copied and is destroyed by looking at it, which seems to rule out redundancy and checking. In 1995 Peter Shor showed otherwise: spread one quantum bit across nine, and measure only comparisons between them, which reveal the error and nothing about the data. Whether large quantum computers can be built now rests on doing this at scale.

^ "measure only comparisons between them" note example: Asking whether two bits agree tells you if one has flipped without telling you the value of either. Quantum codes are built entirely from questions of that kind.
