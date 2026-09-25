/**
 * tests/scoring.test.mjs
 *
 * Unit tests for the exact two-pass tile-scoring algorithm in wordle.js.
 * Written FIRST (TEST-FIRST): these tests define the contract.
 *
 * Tile codes: 'green' = correct letter, correct spot;
 *             'yellow' = letter in word, wrong spot;
 *             'gray' = letter not in word (with duplicate-letter rules).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scoreGuess, GREEN, YELLOW, GRAY } from '../wordle.js';

const G = GREEN;
const Y = YELLOW;
const X = GRAY;

describe('scoreGuess — basic cases', () => {
  it('all green on exact match', () => {
    assert.deepEqual(scoreGuess('crane', 'crane'), [G, G, G, G, G]);
  });

  it('all gray when no letters match', () => {
    assert.deepEqual(scoreGuess('crane', 'might'), [X, X, X, X, X]);
  });

  it('mixed green/yellow/gray', () => {
    // crane vs trace: t gray, r yellow? answer c r a n e; guess t r a c e
    // t: not in crane -> gray; r: in crane, pos1 vs guess pos1 -> green!
    // a: pos2=pos2 green; c: in crane pos0, guess pos3 -> yellow; e: pos4=pos4 green
    assert.deepEqual(scoreGuess('crane', 'trace'), [X, G, G, Y, G]);
  });

  it('is case-insensitive', () => {
    assert.deepEqual(scoreGuess('CRANE', 'Crane'), [G, G, G, G, G]);
  });

  it('throws on non-5-letter inputs', () => {
    assert.throws(() => scoreGuess('crane', 'toolong'), /5-letter/);
    assert.throws(() => scoreGuess('cat', 'crane'), /5-letter/);
  });
});

describe('scoreGuess — duplicate-letter edge cases (PRD section 2)', () => {
  it('WORDS vs SWISS: single S in answer, green takes the slot', () => {
    // answer w o r d s ; guess s w i s s
    // pass1: i=4 s==s green (slot4 consumed)
    // pass2: i=0 s: no unconsumed s -> gray; i=1 w: slot0 -> yellow;
    //        i=2 i: gray; i=3 s: no unconsumed s -> gray
    assert.deepEqual(scoreGuess('words', 'swiss'), [X, Y, X, X, G]);
  });

  it('ABBEY vs BOBBY: green claims the slot first, remaining copy yellows once', () => {
    // answer a b b e y ; guess b o b b y
    // pass1: i=2 b==b green (slot2 consumed); i=4 y==y green (slot4 consumed)
    // pass2: i=0 b: unconsumed b at slot1 -> yellow (consume slot1)
    //        i=1 o: gray; i=3 b: no unconsumed b remains -> gray
    assert.deepEqual(scoreGuess('abbey', 'bobby'), [Y, X, G, X, G]);
  });

  it('ABBEY vs BEFAB (PRD example, corrected): yellow,yellow,gray,yellow,yellow', () => {
    // The PRD's claimed result for this pair is arithmetically wrong; the
    // correct official scoring is derived here step by step.
    // answer a b b e y ; guess b e f a b
    // pass1 (greens): no position matches -> no greens, nothing consumed.
    // pass2 (yellows, left to right):
    //   i=0 b: unconsumed b at slot1 -> yellow (consume slot1)
    //   i=1 e: unconsumed e at slot3 -> yellow (consume slot3)
    //   i=2 f: f not in answer -> gray
    //   i=3 a: unconsumed a at slot0 -> yellow (consume slot0)
    //   i=4 b: unconsumed b at slot2 -> yellow (consume slot2)
    assert.deepEqual(scoreGuess('abbey', 'befab'), [Y, Y, X, Y, Y]);
  });

  it('guess has two of a letter, answer has two: both can score', () => {
    // answer s t e e l ; guess e e r i e
    // pass1: no greens (e vs s, e vs t, r vs e, i vs e, e vs l)
    // pass2: i=0 e: unconsumed e at slot2 -> yellow (consume slot2)
    //        i=1 e: unconsumed e at slot3 -> yellow (consume slot3)
    //        i=2 r,i=3 i: gray; i=4 e: no e left -> gray
    assert.deepEqual(scoreGuess('steel', 'eerie'), [Y, Y, X, X, X]);
  });

  it('double green consumes both answer slots', () => {
    // answer a b b e y ; guess a b b o t
    assert.deepEqual(scoreGuess('abbey', 'abbot'), [G, G, G, X, X]);
  });

  it('yellow does not double-count a consumed slot', () => {
    // answer a b c d e ; guess e e e e e
    // pass1: i=4 green (slot4 consumed); pass2: i=0..3 e: no unconsumed e -> gray
    assert.deepEqual(scoreGuess('abcde', 'eeeee'), [X, X, X, X, G]);
  });

  it('left-to-right determinism in pass 2', () => {
    // answer a x b c d ; guess b b b b b
    // pass1: i=2 green (slot2 consumed); pass2: all other b -> gray
    assert.deepEqual(scoreGuess('axbcd', 'bbbbb'), [X, X, G, X, X]);
  });
});

describe('scoreGuess — feedback encoding helpers', () => {
  it('encodeFeedback/decodeFeedback round-trip', async () => {
    const { encodeFeedback, decodeFeedback } = await import('../wordle.js');
    const tiles = [G, Y, X, G, X];
    assert.deepEqual(decodeFeedback(encodeFeedback(tiles)), tiles);
  });

  it('encodeFeedback matches known pattern index', async () => {
    const { encodeFeedback } = await import('../wordle.js');
    // base-3: gray=0, yellow=1, green=2 ; index = t0 + 3*t1 + 9*t2 + 27*t3 + 81*t4
    assert.equal(encodeFeedback([G, G, G, G, G]), 2 + 6 + 18 + 54 + 162);
    assert.equal(encodeFeedback([X, X, X, X, X]), 0);
  });
});
