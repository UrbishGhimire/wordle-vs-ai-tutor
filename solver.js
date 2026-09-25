/**
 * solver.js — deterministic Wordle bot solver.
 *
 * ============================================================================
 * HARD REQUIREMENT: the bot's guesses come from THIS deterministic JavaScript
 * solver, NEVER from an LLM. The QVAC LLM is used only for tutor chat and
 * optional pre/post-round bot banter (flavor text). Guessing via LLM would be
 * slower, non-deterministic, untestable, and expensive — so it is forbidden
 * here by design. (There is a test that fails if this file ever imports the
 * QVAC SDK.)
 * ============================================================================
 *
 * Pure logic, no DOM, no I/O. The score matrix is a Uint8Array of base-3
 * feedback patterns (see wordle.js encodeFeedback): matrix[i*n + j] is the
 * feedback pattern the bot would see guessing answers[i] when the hidden
 * answer is answers[j].
 */
import { scoreGuess, encodeFeedback } from './wordle.js';

/**
 * The precomputed optimal first guess for the shipped answer list
 * (minimizes expected remaining candidates; ties broken alphabetically).
 * Verified by tests/solver.test.mjs against bestGuessIndex(full pool).
 */
export const HARD_FIRST_GUESS = 'raise';

/** Medium bot's fixed opening guess (documented in strategy-guide.md). */
export const MEDIUM_FIRST_GUESS = 'crane';

/**
 * When the candidate pool shrinks to this size, the hard bot stops
 * restricting itself to answer-list guesses and searches every valid guess
 * for the most distinguishing play (classic endgame: one guess that splits
 * a word family like _OWER instead of trying family members one by one).
 */
export const ENDGAME_THRESHOLD = 16;

/**
 * Build the full guess-vs-answer score matrix over the answer list.
 * @param {string[]} answers - sorted answer list
 * @returns {{ matrix: Uint8Array, n: number }}
 */
export function buildScoreMatrix(answers) {
  const n = answers.length;
  const matrix = new Uint8Array(n * n);
  for (let i = 0; i < n; i++) {
    const guess = answers[i];
    const row = i * n;
    for (let j = 0; j < n; j++) {
      // scoreGuess(answer, guess): feedback for guessing answers[i]
      // when the hidden answer is answers[j].
      matrix[row + j] = encodeFeedback(scoreGuess(answers[j], guess));
    }
  }
  return { matrix, n };
}

/**
 * Build the wide score matrix: every valid guess against every answer.
 * Used to accelerate the hard bot's endgame search in tests; the app uses
 * direct scoreGuess calls instead (same algorithm, no 33MB download).
 *
 * @param {string[]} validGuesses - sorted full guess list
 * @param {string[]} answers - sorted answer list
 * @returns {{ matrix: Uint8Array, g: number, n: number }}
 */
export function buildFullMatrix(validGuesses, answers) {
  const g = validGuesses.length;
  const n = answers.length;
  const matrix = new Uint8Array(g * n);
  for (let i = 0; i < g; i++) {
    const guess = validGuesses[i];
    const row = i * n;
    for (let j = 0; j < n; j++) {
      matrix[row + j] = encodeFeedback(scoreGuess(answers[j], guess));
    }
  }
  return { matrix, g, n };
}

/**
 * Keep only candidates consistent with observed feedback:
 * candidate C survives iff scoreGuess(C, guess) equals the observed tiles.
 * (Pure, used by tests and by the bots' pruning.)
 */
export function filterByFeedback(candidates, guess, tiles) {
  return candidates.filter((c) => {
    const t = scoreGuess(c, guess);
    for (let k = 0; k < t.length; k++) {
      if (t[k] !== tiles[k]) return false;
    }
    return true;
  });
}

/**
 * Expected remaining candidate-pool size after guessing guessIdx:
 * group pool members by the feedback pattern they'd produce, then
 * sum(groupSize^2) / poolSize. Lower = more informative guess.
 */
export function expectedRemaining(poolIdx, guessIdx, matrix, n) {
  const counts = new Array(243).fill(0);
  const row = guessIdx * n;
  for (const i of poolIdx) {
    counts[matrix[row + i]]++;
  }
  let sumSquares = 0;
  for (const c of counts) {
    sumSquares += c * c;
  }
  return sumSquares / poolIdx.length;
}

/**
 * Index of the guess minimizing expected remaining pool size.
 * poolIdx must be in alphabetical (answers) order; the first minimum wins,
 * which implements the alphabetical tie-break.
 */
export function bestGuessIndex(poolIdx, matrix, n) {
  let best = poolIdx[0];
  let bestScore = expectedRemaining(poolIdx, best, matrix, n);
  for (let k = 1; k < poolIdx.length; k++) {
    const g = poolIdx[k];
    const s = expectedRemaining(poolIdx, g, matrix, n);
    if (s < bestScore - 1e-12) {
      best = g;
      bestScore = s;
    }
  }
  return best;
}

/**
 * Letter-value map for the medium bot: each letter scores the number of
 * candidate words containing it (counted once per word).
 */
export function letterFrequencyScores(candidates) {
  const freq = new Map();
  for (const w of candidates) {
    for (const ch of new Set(w)) {
      freq.set(ch, (freq.get(ch) || 0) + 1);
    }
  }
  return freq;
}

function scoreByLetters(word, freq) {
  let s = 0;
  for (const ch of new Set(word)) {
    s += freq.get(ch) || 0;
  }
  return s;
}

/**
 * The vs-AI bot. Owns its candidate pool and guess history for one difficulty.
 *
 *   new Bot('easy' | 'medium' | 'hard', answers, validGuesses,
 *           { rng, scoreMatrix, fullMatrix })
 *   bot.reset()                    — start a new round
 *   bot.move(tiles | null) -> word — tiles = feedback for the previous guess
 *                                    (null on the first move of a round)
 *
 * Easy:   uniform random valid guess every turn; ignores feedback entirely.
 * Medium: prunes candidates by feedback, then picks uniformly among the top 5
 *         letter-frequency guesses; opens with CRANE.
 * Hard:   prunes candidates by feedback, then plays the guess minimizing the
 *         expected remaining pool (near-optimal solver); deterministic,
 *         alphabetical tie-break; opens with HARD_FIRST_GUESS. In the
 *         endgame (pool <= ENDGAME_THRESHOLD) it searches every valid guess
 *         for the most distinguishing play, so word families like _OWER are
 *         split instead of guessed one by one.
 *
 * scoreMatrix ({matrix, n} from buildScoreMatrix) accelerates midgame search;
 * fullMatrix ({matrix, g, n} from buildFullMatrix) accelerates the endgame
 * search. Both are built lazily when needed if not provided.
 */
export class Bot {
  constructor(difficulty, answers, validGuesses, options = {}) {
    if (!['easy', 'medium', 'hard'].includes(difficulty)) {
      throw new Error(`unknown difficulty: ${difficulty}`);
    }
    this.difficulty = difficulty;
    this.answers = answers;
    this.validGuesses = validGuesses;
    this.rng = options.rng || ((max) => Math.floor(Math.random() * max));
    this.scoreMatrix = options.scoreMatrix || null;
    this.fullMatrix = options.fullMatrix || null;
    this.indexOf = new Map(answers.map((w, i) => [w, i]));
    this.fullIndexOf = new Map(validGuesses.map((w, i) => [w, i]));
    this.reset();
  }

  reset() {
    // Candidate answers, always kept in alphabetical (answers) order.
    this.pool = [...this.answers];
    this.used = new Set();
    this.lastGuess = null;
    this.isFirstMove = true;
  }

  _ensureScoreMatrix() {
    if (!this.scoreMatrix) {
      this.scoreMatrix = buildScoreMatrix(this.answers);
    }
    return this.scoreMatrix;
  }

  /**
   * Record feedback for the previous guess by pruning the candidate pool,
   * then choose the next guess.
   */
  move(tiles) {
    if (tiles) {
      this.pool = filterByFeedback(this.pool, this.lastGuess, tiles);
      if (this.pool.length === 0) {
        // Defensive: the true answer is always drawn from `answers`, so an
        // empty pool means inconsistent state (e.g. swapped word lists).
        // Reset rather than crash; the `used` set still prevents repeats.
        this.pool = [...this.answers];
      }
    }
    let word;
    if (this.difficulty === 'easy') {
      word = this._easyMove();
    } else if (this.difficulty === 'medium') {
      word = this._mediumMove();
    } else {
      word = this._hardMove();
    }
    this.used.add(word);
    this.lastGuess = word;
    this.isFirstMove = false;
    return word;
  }

  _easyMove() {
    // Naive: uniform random valid guess, feedback ignored, repeats allowed.
    return this.validGuesses[this.rng(this.validGuesses.length)];
  }

  _mediumMove() {
    if (this.isFirstMove) {
      return this.answers.includes(MEDIUM_FIRST_GUESS)
        ? MEDIUM_FIRST_GUESS
        : this.answers[0];
    }
    const pool = this.pool.filter((w) => !this.used.has(w));
    const candidates = pool.length > 0 ? pool : this.pool;
    const freq = letterFrequencyScores(candidates);
    const ranked = candidates
      .map((w) => ({ w, s: scoreByLetters(w, freq) }))
      .sort((a, b) => b.s - a.s || (a.w < b.w ? -1 : 1));
    const top = ranked.slice(0, 5);
    return top[this.rng(top.length)].w;
  }

  _hardMove() {
    if (this.isFirstMove && this.answers.includes(HARD_FIRST_GUESS)) {
      return HARD_FIRST_GUESS;
    }
    const pool = this.pool.filter((w) => !this.used.has(w));
    const candidates = pool.length > 0 ? pool : this.pool;
    if (candidates.length <= ENDGAME_THRESHOLD) {
      return this._endgameGuess(candidates);
    }
    const { matrix, n } = this._ensureScoreMatrix();
    const poolIdx = candidates.map((w) => this.indexOf.get(w));
    return this.answers[bestGuessIndex(poolIdx, matrix, n)];
  }

  /**
   * Search every valid guess for the one minimizing the expected remaining
   * pool. Ties prefer pool members (a pool member might be the answer, which
   * wins immediately), then alphabetical order.
   */
  _endgameGuess(pool) {
    const poolSet = new Set(pool);
    let bestWord = null;
    let bestExpected = Infinity;
    let bestPoolBonus = 1;
    for (const w of this.validGuesses) {
      if (this.used.has(w)) continue;
      const exp = this._expectedRemainingWords(pool, w);
      const poolBonus = poolSet.has(w) ? 0 : 1;
      if (
        exp < bestExpected - 1e-12 ||
        (Math.abs(exp - bestExpected) <= 1e-12 && poolBonus < bestPoolBonus)
      ) {
        bestWord = w;
        bestExpected = exp;
        bestPoolBonus = poolBonus;
      }
    }
    return bestWord;
  }

  /** Feedback pattern id for guessing `guess` against answers[answerIdx]. */
  _pattern(guess, answerIdx) {
    if (this.fullMatrix) {
      const gi = this.fullIndexOf.get(guess);
      return this.fullMatrix.matrix[gi * this.fullMatrix.n + answerIdx];
    }
    return encodeFeedback(scoreGuess(this.answers[answerIdx], guess));
  }

  _expectedRemainingWords(pool, guess) {
    const counts = new Array(243).fill(0);
    for (const a of pool) {
      counts[this._pattern(guess, this.indexOf.get(a))]++;
    }
    let sumSquares = 0;
    for (const c of counts) {
      sumSquares += c * c;
    }
    return sumSquares / pool.length;
  }
}
