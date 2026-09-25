# Wordle Strategy Guide

A beginner-friendly guide to playing Wordle well. Every number in the tables
below was computed from this app's actual answer list (2,204 words) — nothing
is guessed or invented.

---

## 1. Best starting words

Your first guess should test the most common letters in the most common
positions, with no repeated letters. Five strong starters, each with a reason:

- **CRANE** — C, R, A, N, E are all in the top 10 most common letters; E and A
  are the two most common vowels. A balanced, proven opener.
- **SLATE** — S is the single most common first letter (15.1% of answers start
  with S); L, A, T, E are all frequent. Great if you like consonant-heavy openers.
- **ADIEU** — Tests four vowels at once (A, I, E, U). It tells you less about
  consonants, but knowing the vowels early makes everything after easier.
- **TRACE** — Like CRANE with T instead of N; T is a top-5 letter and very
  common at the end of words (9.9% of answers end in T).
- **ROAST** — R, O, A, S, T are all top-10 letters; O is the most common
  second letter (13.1%). Good if your first instinct is vowel-second words.

Rule of thumb: never start with a repeated letter (like LLAMA) — a repeat
tests one fewer new letter, and information is everything on guess one.

---

## 2. Letter frequency tables

**Overall — how often each letter appears anywhere in an answer**
(% of answers containing the letter at least once):

| Letter | % of answers | Letter | % of answers | Letter | % of answers |
|--------|--------------|--------|--------------|--------|--------------|
| E | 45.1% | L | 26.8% | Y | 17.1% |
| A | 40.7% | S | 26.4% | H | 16.7% |
| R | 37.0% | N | 23.7% | D | 15.4% |
| O | 30.5% | C | 19.7% | P | 14.9% |
| T | 28.7% | U | 18.8% | | |
| I | 28.6% | | | | |

**By position — the 5 most common letters in each slot:**

| Pos 1 | Pos 2 | Pos 3 | Pos 4 | Pos 5 |
|-------|-------|-------|-------|-------|
| S 15.1% | A 14.0% | A 13.1% | E 13.9% | E 18.4% |
| C 8.8% | O 13.1% | I 11.2% | N 7.4% | Y 14.7% |
| B 7.3% | R 10.8% | O 9.9% | R 7.1% | T 9.9% |
| T 6.7% | E 10.3% | R 7.5% | S 6.9% | R 9.6% |
| A 6.6% | I 9.4% | E 7.4% | I 6.8% | L 6.4% |

**Vowel balance:** 59.5% of answers have exactly 2 vowels, 29.8% have exactly
1 vowel, and only 10.2% have 3. If your first two guesses reveal zero vowels,
something is off — re-check.

How to use this: when choosing between two possible guesses, prefer the one
whose new letters are higher in the tables, especially in the positions where
those letters are common.

---

## 3. Green means locked

A green tile is a fact: that letter is in that exact position in the answer.
**Never move a green letter.** Every future guess keeps greens where they are.

Beginners sometimes "re-test" a green letter elsewhere "just in case" — this
wastes a guess. The game already told you the answer. Trust it.

---

## 4. Yellow repositioning

A yellow tile means: **the letter IS in the answer, but NOT in that position.**
Your job is to find where it actually goes.

Work through the remaining positions one at a time:

1. List the positions you have NOT tried this letter in yet.
2. Next guess, put the yellow letter in one of those untested positions.
3. If it goes yellow again, cross that position off and try the next one.
4. If it goes green, it's locked (see section 3).

Example: you guess CRANE and the R is yellow in position 2. The answer has R
somewhere in position 1, 3, 4, or 5 — but not 2. Your next guess should move R
to an untested slot: WORLD puts R in position 3 (W-O-R-L-D). If R is yellow
again, positions 1, 4, 5 remain — cross off position 3 and try the next one.

Also use the position table: R is most common in positions 2 and 5 (10.8% and
9.6%). Try likely slots first.

---

## 5. Reading grays

A gray tile means the letter is **not in the answer at all** — with one
important exception:

> **If the same letter also earned a green or yellow in the SAME guess, the
> gray only means "no MORE copies of this letter."**

Why: the game scores greens first, then hands out yellows for remaining
copies, and only then marks the leftovers gray. So in the guess SPEED against
an answer with one E, one E may go green/yellow and the second E goes gray —
the gray does NOT cancel the green.

Practical rule: **never reuse a pure-gray letter** (gray with no green/yellow
twin in that guess). It gives you zero new information. The on-screen keyboard
dims gray letters — treat dimmed keys as dead unless they have a colored twin.

---

## 6. When to burn a guess

Sometimes you're stuck: two or three letters known, but ten possibilities fit.
Guessing the answer directly is a lottery. Instead, **burn a guess**: play a
word you know is NOT the answer, built purely to test as many new letters as
possible.

When to do it:
- You have 3+ guesses left and the possibilities feel endless.
- Your known letters leave a "family" of similar words (see section 7).

How to build a burn guess:
1. Keep your greens in place (they're locked).
2. Move yellows to untested positions if you can.
3. Fill every other slot with the highest-frequency untested letters from the
   tables — even if the resulting word looks weird.

Worked example: after two guesses you know A is green in position 3, R is
yellow from position 2, and you've ruled out S, T, L, N. Guessing at the
answer directly is a lottery. Instead, burn: **REACH** — R moves to position 1
(a slot you haven't tried it in), A stays locked at position 3, and E, C, H
are three brand-new high-frequency letters. If C lights up yellow, your
candidate pool collapses. That's a guess well spent, even though REACH was
never going to be the answer.

---

## 7. Endgame tactics

Two or three guesses left, a handful of candidates. Don't guess candidates
one by one — **guess a word that distinguishes between them.**

Classic trap: the answer is `_ATCH` and candidates are BATCH, CATCH, HATCH,
LATCH, MATCH, PATCH, WATCH. Guessing them one at a time needs up to 7 guesses
— you only have 6 total.

The fix: play a word that tests the differing first letters all at once.
Something like **CHAMP**? No — better: a word containing B, C, H, L, M, P, W
is impossible in 5 letters, but **CLIMB** tests C, L, M, B at once (plus I).
Whichever letter lights up yellow or green tells you the answer family:

- C yellow/green → CATCH
- L → LATCH, M → MATCH, B → BATCH...

Then your next guess IS the answer. One distinguishing guess replaces up to
six blind stabs. Look for the position where your candidates differ, and
cram as many of the differing letters as you can into one guess.

---

## 8. Common beginner mistakes

1. **Repeating gray letters.** If S went gray, don't play another word with S
   "just in case." The keyboard dims it for a reason.
2. **Ignoring yellows.** A yellow letter must appear in your next guess
   (somewhere else). Leaving it out throws away information you already paid
   a guess to earn.
3. **Guesses with no new information.** Replaying 4 known letters to test 1
   new one is weak — flip it: keep 1–2 anchors, test 3–4 new letters.
4. **Forgetting the word list.** Not every English word is allowed. If your
   brilliant guess gets rejected, it isn't in the list — pick the closest
   legal word instead of retyping it.
5. **Moving green letters.** Covered in section 3. Don't do it.
6. **Burning too late.** A burn guess on guess 5 of 6 is usually too late to
   help. If you're stuck on guess 3, burn on guess 3.
7. **Chasing rare letters early.** Q, Z, X, J, V appear in few answers. Test
   E, A, R, O, T first — they appear in 30–45% of answers each.
