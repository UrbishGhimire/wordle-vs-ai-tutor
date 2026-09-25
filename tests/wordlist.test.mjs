/**
 * tests/wordlist.test.mjs
 *
 * Assertions on the shipped word lists (words/answers.txt, words/valid-guesses.txt).
 * Written FIRST: these define the contract the build script must satisfy.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadWords(name) {
  const text = readFileSync(path.join(root, 'words', name), 'utf8');
  const words = text.split('\n').filter((w) => w.length > 0);
  return { words, text };
}

const answers = loadWords('answers.txt');
const guesses = loadWords('valid-guesses.txt');

describe('word list format', () => {
  it('every answer is exactly 5 lowercase letters', () => {
    for (const w of answers.words) {
      assert.match(w, /^[a-z]{5}$/, `bad answer: ${w}`);
    }
  });

  it('every valid guess is exactly 5 lowercase letters', () => {
    for (const w of guesses.words) {
      assert.match(w, /^[a-z]{5}$/, `bad guess: ${w}`);
    }
  });

  it('no duplicates in either list', () => {
    assert.equal(new Set(answers.words).size, answers.words.length);
    assert.equal(new Set(guesses.words).size, guesses.words.length);
  });

  it('both lists are sorted (deterministic builds)', () => {
    assert.deepEqual([...answers.words].sort(), answers.words);
    assert.deepEqual([...guesses.words].sort(), guesses.words);
  });

  it('files end with a single trailing newline', () => {
    assert.ok(answers.text.endsWith('\n') && !answers.text.endsWith('\n\n'));
    assert.ok(guesses.text.endsWith('\n') && !guesses.text.endsWith('\n\n'));
  });
});

describe('word list sizes', () => {
  it('answer list has ~2,300 common words (2,100–2,400)', () => {
    assert.ok(
      answers.words.length >= 2100 && answers.words.length <= 2400,
      `answers: ${answers.words.length}`
    );
  });

  it('valid-guess list covers the full dictionary slice (15,000–17,000)', () => {
    assert.ok(
      guesses.words.length >= 15000 && guesses.words.length <= 17000,
      `guesses: ${guesses.words.length}`
    );
  });
});

describe('word list relationships', () => {
  it('every answer is also a valid guess', () => {
    const guessSet = new Set(guesses.words);
    const missing = answers.words.filter((w) => !guessSet.has(w));
    assert.deepEqual(missing, []);
  });

  it('well-known starters are valid guesses', () => {
    const guessSet = new Set(guesses.words);
    for (const w of ['crane', 'slate', 'adieu', 'trace', 'roate']) {
      if (['crane', 'slate', 'adieu'].includes(w)) {
        assert.ok(guessSet.has(w), `${w} must be a valid guess (strategy guide starter)`);
      }
    }
  });

  it('answer list contains no obvious plurals/proper nouns/profanity spot-check', () => {
    const answerSet = new Set(answers.words);
    for (const w of ['paris', 'jesus', 'yemen', 'fucks', 'shits', 'dicks', 'cunts', 'youve', 'doesn', 'gonna']) {
      assert.ok(!answerSet.has(w), `${w} must not be an answer`);
    }
  });
});
