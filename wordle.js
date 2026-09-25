/**
 * wordle.js — pure Wordle game logic: exact tile scoring + game state machine.
 *
 * No DOM, no SDK, no I/O. Importable from both Node tests and the browser UI
 * (served as an ES module).
 */

export const GREEN = 'green';
export const YELLOW = 'yellow';
export const GRAY = 'gray';

export const MAX_GUESSES = 6;
export const WORD_LENGTH = 5;

/**
 * Score a guess against the answer with the exact two-pass algorithm
 * (see PRD section 2):
 *
 *   PASS 1: mark greens; each green consumes its answer slot.
 *   PASS 2: for each non-green position, left to right: if the letter occurs
 *           in any UNCONSUMED answer slot, mark yellow and consume exactly one
 *           such slot; otherwise mark gray.
 *
 * Duplicate-letter consequence: a guess letter can only "use up" as many
 * answer slots as the answer actually contains, and greens claim slots first.
 *
 * @param {string} answer - 5-letter answer (case-insensitive)
 * @param {string} guess  - 5-letter guess (case-insensitive)
 * @returns {string[]} five tile codes: 'green' | 'yellow' | 'gray'
 */
export function scoreGuess(answer, guess) {
  const a = String(answer).toLowerCase();
  const g = String(guess).toLowerCase();
  if (a.length !== WORD_LENGTH || g.length !== WORD_LENGTH) {
    throw new Error(`scoreGuess expects 5-letter words, got "${answer}" / "${guess}"`);
  }

  const tiles = new Array(WORD_LENGTH).fill(GRAY);
  const consumed = new Array(WORD_LENGTH).fill(false);

  // Pass 1: greens.
  for (let i = 0; i < WORD_LENGTH; i++) {
    if (g[i] === a[i]) {
      tiles[i] = GREEN;
      consumed[i] = true;
    }
  }

  // Pass 2: yellows / grays, left to right.
  for (let i = 0; i < WORD_LENGTH; i++) {
    if (tiles[i] === GREEN) continue;
    const slot = findUnconsumedSlot(a, g[i], consumed);
    if (slot !== -1) {
      tiles[i] = YELLOW;
      consumed[slot] = true;
    }
  }

  return tiles;
}

function findUnconsumedSlot(answer, letter, consumed) {
  for (let j = 0; j < WORD_LENGTH; j++) {
    if (!consumed[j] && answer[j] === letter) return j;
  }
  return -1;
}

/**
 * Encode five tiles as a base-3 integer (gray=0, yellow=1, green=2).
 * Used by the solver's precomputed score matrix: 3^5 = 243 patterns.
 */
export function encodeFeedback(tiles) {
  if (tiles.length !== WORD_LENGTH) throw new Error('encodeFeedback needs 5 tiles');
  const value = { [GRAY]: 0, [YELLOW]: 1, [GREEN]: 2 };
  let code = 0;
  let base = 1;
  for (const tile of tiles) {
    code += value[tile] * base;
    base *= 3;
  }
  return code;
}

export function decodeFeedback(code) {
  const names = [GRAY, YELLOW, GREEN];
  const tiles = [];
  for (let i = 0; i < WORD_LENGTH; i++) {
    tiles.push(names[code % 3]);
    code = Math.floor(code / 3);
  }
  return tiles;
}

/**
 * Pure game state machine: one answer, up to 6 validated guesses.
 */
export class Game {
  /**
   * @param {string} answer - the hidden 5-letter answer
   * @param {Set<string>} validWords - lowercase valid-guess list (answers must be a subset)
   */
  constructor(answer, validWords) {
    this.answer = String(answer).toLowerCase();
    this.validWords = validWords;
    this.guesses = []; // [{ word, tiles }]
    this.over = false;
    this.won = false;
  }

  /**
   * Submit a guess. Throws on invalid word or finished game.
   * @returns {{ word: string, tiles: string[], won: boolean, lost: boolean, guessesUsed: number }}
   */
  guess(word) {
    if (this.over) throw new Error('game is already over');
    const w = String(word).toLowerCase();
    if (w.length !== WORD_LENGTH) throw new Error(`guess must be ${WORD_LENGTH} letters`);
    if (!this.validWords.has(w)) throw new Error(`"${word}" is not in the word list`);

    const tiles = scoreGuess(this.answer, w);
    this.guesses.push({ word: w, tiles });

    this.won = tiles.every((t) => t === GREEN);
    this.over = this.won || this.guesses.length >= MAX_GUESSES;

    return {
      word: w,
      tiles,
      won: this.won,
      lost: this.over && !this.won,
      guessesUsed: this.guesses.length,
    };
  }
}

/**
 * Daily-word index: days since a fixed epoch (local timezone), modulo list size.
 * Same word all day; new word at local midnight.
 */
export const DAILY_EPOCH = '2026-01-01';

export function dailyWordIndex(date, listLength) {
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const epoch = new Date(2026, 0, 1);
  const days = Math.floor((day - epoch) / 86_400_000);
  return ((days % listLength) + listLength) % listLength;
}

export function dailyWord(answers, date = new Date()) {
  return answers[dailyWordIndex(date, answers.length)];
}

/**
 * Uniform random word from a list (for vs-AI rounds).
 */
export function randomWord(words, randomValues = null) {
  const rv = randomValues || crypto.getRandomValues(new Uint32Array(1));
  return words[rv[0] % words.length];
}
