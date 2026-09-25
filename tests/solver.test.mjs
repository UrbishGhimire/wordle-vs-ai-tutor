/**
 * tests/solver.test.mjs
 *
 * Tests for the deterministic JS bot solver (solver.js). Written FIRST.
 *
 * HARD REQUIREMENT (PRD section 3): the bot's guesses come from this
 * deterministic solver, NEVER from an LLM. The last suite asserts solver.js
 * contains no SDK/LLM imports.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { scoreGuess, encodeFeedback, GREEN, YELLOW, GRAY } from '../wordle.js';
import {
  buildScoreMatrix,
  buildFullMatrix,
  filterByFeedback,
  expectedRemaining,
  bestGuessIndex,
  letterFrequencyScores,
  Bot,
  HARD_FIRST_GUESS,
} from '../solver.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const answers = readFileSync(path.join(root, 'words', 'answers.txt'), 'utf8').split('\n').filter(Boolean);
const validGuesses = readFileSync(path.join(root, 'words', 'valid-guesses.txt'), 'utf8').split('\n').filter(Boolean);

// Deterministic RNG for tests (mulberry32).
function makeRng(seed) {
  let s = seed >>> 0;
  return (max) => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) % max;
  };
}

/** Play a full bot game against `answer`; returns guesses used (7 = failed). */
function playBotGame(bot, answer) {
  bot.reset();
  let tiles = null;
  for (let turn = 1; turn <= 6; turn++) {
    const guess = bot.move(tiles);
    tiles = scoreGuess(answer, guess);
    if (tiles.every((t) => t === GREEN)) return turn;
  }
  return 7;
}

describe('filterByFeedback', () => {
  it('keeps exactly the candidates consistent with observed feedback', () => {
    const rng = makeRng(42);
    for (let trial = 0; trial < 50; trial++) {
      const answer = answers[rng(answers.length)];
      const guess = answers[rng(answers.length)];
      const tiles = scoreGuess(answer, guess);
      const kept = filterByFeedback(answers, guess, tiles);
      assert.ok(kept.includes(answer), `answer ${answer} must survive its own feedback`);
      for (const c of kept) {
        assert.deepEqual(scoreGuess(c, guess), tiles, `${c} inconsistent with feedback`);
      }
      // every dropped candidate is truly inconsistent
      const keptSet = new Set(kept);
      for (const c of answers) {
        if (!keptSet.has(c)) {
          assert.notDeepEqual(scoreGuess(c, guess), tiles, `${c} wrongly dropped`);
        }
      }
    }
  });
});

describe('score matrix', () => {
  let matrix, n;
  before(() => {
    ({ matrix, n } = buildScoreMatrix(answers));
  });

  it('matrix agrees with scoreGuess on random pairs', () => {
    const rng = makeRng(7);
    for (let k = 0; k < 200; k++) {
      const i = rng(n);
      const j = rng(n);
      assert.equal(matrix[i * n + j], encodeFeedback(scoreGuess(answers[j], answers[i])));
    }
  });

  it('diagonal is all-green', () => {
    const allGreen = encodeFeedback([GREEN, GREEN, GREEN, GREEN, GREEN]);
    for (let i = 0; i < n; i += 97) {
      assert.equal(matrix[i * n + i], allGreen);
    }
  });

  it('bestGuessIndex on the full pool equals the hardcoded HARD_FIRST_GUESS', () => {
    const pool = answers.map((_, i) => i);
    const best = bestGuessIndex(pool, matrix, n);
    assert.equal(answers[best], HARD_FIRST_GUESS);
  });

  it('expectedRemaining is minimized by the best guess (spot check)', () => {
    const rng = makeRng(11);
    const pool = [];
    for (let k = 0; k < 300; k++) pool.push(rng(n));
    const best = bestGuessIndex(pool, matrix, n);
    const bestScore = expectedRemaining(pool, best, matrix, n);
    for (let k = 0; k < 20; k++) {
      const other = pool[rng(pool.length)];
      assert.ok(
        expectedRemaining(pool, other, matrix, n) >= bestScore - 1e-9,
        'best guess must minimize expected remaining pool'
      );
    }
  });
});

describe('letterFrequencyScores', () => {
  it('ranks common letters above rare ones', () => {
    const scores = letterFrequencyScores(['crane', 'trace', 'slate', 'jazzy']);
    assert.ok(scores.get('e') > scores.get('z'), 'e should outscore z');
    assert.equal(scores.get('e'), 3, 'e appears in 3 of 4 candidates');
    assert.equal(scores.get('z'), 1, 'z appears in 1 of 4 candidates');
  });
});

describe('Bot — easy', () => {
  it('guesses valid words and ignores feedback (naive)', () => {
    const bot = new Bot('easy', answers, validGuesses, { rng: makeRng(1) });
    const guessSet = new Set(validGuesses);
    let tiles = null;
    for (let turn = 0; turn < 6; turn++) {
      const g = bot.move(tiles);
      assert.ok(guessSet.has(g), `${g} must be a valid guess`);
      tiles = [GRAY, GRAY, GRAY, GRAY, GRAY]; // bot should not care
    }
  });

  it('honest measurement: solve rate matches the mathematical expectation (~0.04%)', () => {
    // PRD section 3 specifies Easy as uniform-random over the 15,921-word
    // valid-guess list, ignoring feedback. Under that behavior the per-game
    // solve chance is 1-(15920/15921)^6 ≈ 0.04%, so the PRD section 8 bar
    // ("solves >= 25%") is mathematically impossible — see TESTING-NOTES.md.
    // This test pins the honest behavior instead of faking the bar.
    const rng = makeRng(2);
    let solved = 0;
    const bot = new Bot('easy', answers, validGuesses, { rng });
    for (let k = 0; k < 200; k++) {
      if (playBotGame(bot, answers[rng(answers.length)]) <= 6) solved++;
    }
    console.log(`    easy: solved ${solved}/200 (expected ~0.08 at 0.04%/game)`);
    assert.ok(solved <= 10, `easy solved ${solved}/200 — far above the 0.04%/game expectation`);
  });
});

describe('Bot — medium', () => {
  it('opens with CRANE', () => {
    const bot = new Bot('medium', answers, validGuesses, { rng: makeRng(3) });
    assert.equal(bot.move(null), 'crane');
  });

  it('never repeats a guess within a round and only plays valid words', () => {
    const bot = new Bot('medium', answers, validGuesses, { rng: makeRng(4) });
    const seen = new Set();
    let tiles = null;
    for (let turn = 0; turn < 6; turn++) {
      const g = bot.move(tiles);
      assert.ok(!seen.has(g), `medium repeated ${g}`);
      seen.add(g);
      tiles = scoreGuess('crane', g); // arbitrary fixed answer
      if (tiles.every((t) => t === GREEN)) break;
    }
  });

  it('quality: avg <= 4.6 and solves >= 90% over 200 random answers', () => {
    const rng = makeRng(5);
    const bot = new Bot('medium', answers, validGuesses, { rng });
    let total = 0;
    let solved = 0;
    for (let k = 0; k < 200; k++) {
      const used = playBotGame(bot, answers[rng(answers.length)]);
      if (used <= 6) {
        solved++;
        total += used;
      } else {
        total += 7;
      }
    }
    const avg = total / 200;
    assert.ok(solved >= 180, `medium solved ${solved}/200, need >= 180`);
    assert.ok(avg <= 4.6, `medium avg ${avg.toFixed(2)}, need <= 4.6`);
    console.log(`    medium: avg ${avg.toFixed(2)}, solved ${solved}/200`);
  });
});

describe('Bot — hard', () => {
  let matrix, n, fullMatrix;
  before(() => {
    ({ matrix, n } = buildScoreMatrix(answers));
    // Wide matrix (15,921 x 2,204) accelerates the endgame search in tests.
    fullMatrix = buildFullMatrix(validGuesses, answers);
  });

  it('is fully deterministic: same answer => same guess sequence', () => {
    const mk = () => new Bot('hard', answers, validGuesses, { rng: makeRng(9), scoreMatrix: { matrix, n }, fullMatrix });
    const seq = (bot) => {
      bot.reset();
      const out = [];
      let tiles = null;
      for (let t = 0; t < 6; t++) {
        const g = bot.move(tiles);
        out.push(g);
        tiles = scoreGuess('crane', g);
        if (tiles.every((x) => x === GREEN)) break;
      }
      return out;
    };
    assert.deepEqual(seq(mk()), seq(mk()));
  });

  it('quality: full answer list — avg <= 3.9, never fails, no repeats', () => {
    const bot = new Bot('hard', answers, validGuesses, { rng: makeRng(10), scoreMatrix: { matrix, n }, fullMatrix });
    let total = 0;
    let worst = 0;
    for (const answer of answers) {
      bot.reset();
      const seen = new Set();
      let tiles = null;
      let used = 7;
      for (let turn = 1; turn <= 6; turn++) {
        const g = bot.move(tiles);
        assert.ok(!seen.has(g), `hard repeated ${g} vs ${answer}`);
        seen.add(g);
        tiles = scoreGuess(answer, g);
        if (tiles.every((t) => t === GREEN)) {
          used = turn;
          break;
        }
      }
      assert.ok(used <= 6, `hard failed to solve ${answer}`);
      total += used;
      worst = Math.max(worst, used);
    }
    const avg = total / answers.length;
    assert.ok(avg <= 3.9, `hard avg ${avg.toFixed(3)}, need <= 3.9`);
    console.log(`    hard: avg ${avg.toFixed(3)} over ${answers.length} answers, worst ${worst}`);
  });

  it('endgame: direct-scoreGuess path matches the matrix path (trap words)', () => {
    // The app has no wide matrix; it uses direct scoreGuess in the endgame.
    // Both paths must choose identical guesses and solve word-family traps.
    const traps = ['tight', 'light', 'might', 'batch', 'catch', 'watch', 'bound', 'found', 'sound', 'tower', 'power', 'rower', 'foyer'];
    for (const answer of traps) {
      const seqWith = [];
      const seqWithout = [];
      const botWith = new Bot('hard', answers, validGuesses, {
        scoreMatrix: { matrix, n },
        fullMatrix,
      });
      const botWithout = new Bot('hard', answers, validGuesses, {
        scoreMatrix: { matrix, n },
      });
      for (const [bot, seq] of [[botWith, seqWith], [botWithout, seqWithout]]) {
        bot.reset();
        let tiles = null;
        for (let turn = 1; turn <= 6; turn++) {
          const g = bot.move(tiles);
          seq.push(g);
          tiles = scoreGuess(answer, g);
          if (tiles.every((t) => t === GREEN)) break;
        }
        assert.ok(tiles.every((t) => t === GREEN), `endgame failed on ${answer}`);
      }
      assert.deepEqual(seqWithout, seqWith, `path mismatch on ${answer}`);
    }
  });
});

describe('solver has no LLM dependency', () => {
  it('solver.js does not import the QVAC SDK or mention LLMs', () => {
    const src = readFileSync(path.join(root, 'solver.js'), 'utf8');
    assert.ok(!src.includes('@qvac/sdk'), 'solver must not import @qvac/sdk');
    assert.ok(!src.includes('loadModel'), 'solver must not load models');
    assert.ok(!src.includes('completion('), 'solver must not call completions');
  });
});
