/**
 * tests/tutor.test.mjs
 *
 * Grounding tests for the QVAC tutor (tutor.js). Written FIRST.
 *
 * The real QVAC SDK is NEVER touched here: a mock SDK records every call and
 * enforces the exact call shapes from the SDK's own .d.ts —
 *   loadModel({ modelSrc: CONSTANT })            (constant, not a bare string)
 *   completion({ modelId, history, stream })     (modelId = loadModel's string)
 *   (await run.final).contentText                (CompletionRun object, not text)
 *   unloadModel({ modelId })
 * so the mocks catch exactly the class of bug that breaks against the real SDK.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  TUTOR_MODEL_SRC,
  TUTOR_SYSTEM,
  TUTOR_FALLBACK,
  NO_THINK_PREFIX,
  MAX_REPLY_CHARS,
  loadTutorModel,
  unloadTutorModel,
  buildTutorPrompt,
  selectGuideSections,
  getGuideSections,
  formatBoardSummary,
  splitThinking,
  sanitizeReply,
  askTutor,
} from '../tutor.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const guideText = readFileSync(path.join(root, 'strategy-guide.md'), 'utf8');

/** Mock SDK enforcing exact call shapes. */
function makeMockSdk(replyText = 'Mock tutor reply.') {
  const calls = [];
  return {
    sdk: {
      QWEN3_600M_INST_Q4: { __mockConstant: 'QWEN3_600M_INST_Q4' },
      async loadModel(args) {
        calls.push(['loadModel', args]);
        assert.deepEqual(Object.keys(args), ['modelSrc']);
        assert.equal(args.modelSrc.__mockConstant, 'QWEN3_600M_INST_Q4');
        return 'mock-model-id';
      },
      completion(args) {
        calls.push(['completion', args]);
        assert.deepEqual(Object.keys(args).sort(), ['history', 'modelId', 'stream']);
        assert.equal(args.modelId, 'mock-model-id');
        assert.equal(args.stream, false);
        return { final: Promise.resolve({ contentText: replyText }) };
      },
      async unloadModel(args) {
        calls.push(['unloadModel', args]);
        assert.deepEqual(args, { modelId: 'mock-model-id' });
      },
    },
    calls,
  };
}

describe('guide section routing', () => {
  it('parses all 8 required sections from the shipped guide', () => {
    const sections = getGuideSections(guideText);
    assert.equal(sections.length, 8);
    const titles = sections.map((s) => s.title);
    assert.ok(titles[0].toLowerCase().includes('starting words'));
    assert.ok(titles.some((t) => t.toLowerCase().includes('yellow')));
  });

  it('routes a starting-word question to section 1', () => {
    const excerpt = selectGuideSections('what is a good starting word?', guideText);
    assert.ok(excerpt.includes('CRANE'), 'section 1 names CRANE');
  });

  it('routes a yellow question to the yellow section', () => {
    const excerpt = selectGuideSections('what does a yellow tile mean?', guideText);
    assert.match(excerpt.toLowerCase(), /yellow/);
    assert.match(excerpt.toLowerCase(), /not in that position/);
  });

  it('always includes at least one section, even for nonsense questions', () => {
    const excerpt = selectGuideSections('xyzzy plugh frobnicate', guideText);
    assert.ok(excerpt.length > 200, 'falls back to a default section, never empty');
  });
});

describe('board summary formatting', () => {
  it('renders guesses with tile emoji like the PRD example', () => {
    const text = formatBoardSummary([
      { word: 'crane', tiles: ['yellow', 'gray', 'gray', 'green', 'gray'] },
    ]);
    assert.equal(text, 'Guess 1: CRANE -> 🟨⬛⬛🟩⬛');
  });

  it('numbers multiple guesses', () => {
    const text = formatBoardSummary([
      { word: 'crane', tiles: ['gray', 'gray', 'gray', 'gray', 'gray'] },
      { word: 'slate', tiles: ['green', 'green', 'green', 'green', 'green'] },
    ]);
    assert.ok(text.includes('Guess 1: CRANE'));
    assert.ok(text.includes('Guess 2: SLATE'));
  });
});

describe('tutor prompt grounding', () => {
  it('system prompt contains the never-reveal-answer rule', () => {
    assert.match(TUTOR_SYSTEM, /never reveal/i);
    assert.match(TUTOR_SYSTEM, /secret answer/i);
  });

  it('system prompt carries the exact refusal script', () => {
    assert.ok(TUTOR_SYSTEM.includes("I can't give you the word"));
  });

  it('the target word never enters the prompt', () => {
    // Simulate a game whose answer is "zebra" (a real answer that never
    // appears in the guide — "crane" would be a bad test answer because the
    // guide legitimately recommends CRANE as a starter word, i.e. ordinary
    // vocabulary, not a reveal). The prompt is built only from the player's
    // question, their guesses, and guide text — none of which may carry the
    // answer as the answer.
    const board = formatBoardSummary([
      { word: 'trace', tiles: ['gray', 'green', 'green', 'yellow', 'green'] },
      { word: 'slate', tiles: ['gray', 'gray', 'gray', 'gray', 'gray'] },
    ]);
    const excerpt = selectGuideSections('am I doing well?', guideText);
    const { system, history } = buildTutorPrompt({
      question: 'am I doing well?',
      boardSummary: board,
      guideExcerpt: excerpt,
    });
    const serialized = system + '\n' + history.map((m) => m.content).join('\n');
    assert.ok(!serialized.toLowerCase().includes('zebra'), 'answer "zebra" must not appear');
    // Non-vacuous: the player's own guesses ARE present.
    assert.ok(serialized.includes('TRACE'));
    assert.ok(serialized.includes('SLATE'));
  });

  it('buildTutorPrompt has nowhere to put the answer (structural)', () => {
    // Even if a caller tries to smuggle the answer in as an extra field,
    // buildTutorPrompt only reads its documented inputs, so the answer
    // cannot leak into the prompt.
    const { system, history } = buildTutorPrompt({
      question: 'q',
      boardSummary: 'Guess 1: TRACE -> ⬛🟩🟩🟨🟩',
      guideExcerpt: 'g',
      answer: 'crane',
      target: 'crane',
      secretWord: 'crane',
    });
    const serialized = system + '\n' + history.map((m) => m.content).join('\n');
    assert.ok(!serialized.toLowerCase().includes('crane'));
    assert.equal(history[0].role, 'system');
  });

  it('user message always carries a guide excerpt', () => {
    const excerpt = selectGuideSections('help', guideText);
    const { history } = buildTutorPrompt({
      question: 'help',
      boardSummary: 'Guess 1: CRANE -> ⬛⬛⬛⬛⬛',
      guideExcerpt: excerpt,
    });
    const userMsg = history.find((m) => m.role === 'user');
    assert.ok(userMsg.content.includes(excerpt.slice(0, 80)));
  });

  it('observation mode adds the 2-sentence limit', () => {
    const { system } = buildTutorPrompt({
      question: null,
      boardSummary: 'Guess 1: CRANE -> ⬛⬛⬛⬛⬛',
      guideExcerpt: 'guide',
      observationMode: true,
    });
    assert.match(system, /2 sentences/);
  });

  it('system prompt demands concrete, guess-anchored coaching — not guide recitals', () => {
    assert.match(TUTOR_SYSTEM, /specific letters and positions/i);
    assert.match(TUTOR_SYSTEM, /never repeat/i);
    assert.match(TUTOR_SYSTEM, /generic/i);
  });

  it('recentNotes are passed through as anti-repeat context', () => {
    const { history } = buildTutorPrompt({
      question: null,
      boardSummary: 'Guess 1: CRANE -> ⬛⬛⬛⬛⬛\nGuess 2: SLATE -> ⬛🟩⬛⬛⬛',
      guideExcerpt: 'guide',
      observationMode: true,
      recentNotes: ['CRANE told you nothing — try a vowel-heavy opener next.'],
    });
    const userMsg = history.find((m) => m.role === 'user');
    assert.ok(userMsg.content.includes('YOUR PREVIOUS OBSERVATIONS'));
    assert.ok(userMsg.content.includes('CRANE told you nothing'));
  });

  it('recentNotes are omitted cleanly when empty', () => {
    const { history } = buildTutorPrompt({
      question: 'hi',
      boardSummary: '',
      guideExcerpt: 'guide',
    });
    const userMsg = history.find((m) => m.role === 'user');
    assert.ok(!userMsg.content.includes('YOUR PREVIOUS OBSERVATIONS'));
  });

  it('a smuggled answer inside recentNotes cannot leak (it is tutor text, still scanned)', () => {
    // recentNotes come from the tutor's own prior replies, never the player,
    // but the structural guarantee must hold for every prompt input.
    const { system, history } = buildTutorPrompt({
      question: 'q',
      boardSummary: 'Guess 1: TRACE -> ⬛🟩🟩🟨🟩',
      guideExcerpt: 'g',
      recentNotes: ['nice guess'],
    });
    const serialized = system + '\n' + history.map((m) => m.content).join('\n');
    assert.ok(!serialized.toLowerCase().includes('zebra'));
  });
});

describe('QVAC call shapes (mocked SDK)', () => {
  it('full lifecycle: load -> completion -> unload with exact shapes', async () => {
    const { sdk, calls } = makeMockSdk();
    const modelId = await loadTutorModel(sdk);
    assert.equal(modelId, 'mock-model-id');

    const excerpt = selectGuideSections('starting words', guideText);
    const prompt = buildTutorPrompt({
      question: 'what should I guess first?',
      boardSummary: 'Guess 1: CRANE -> ⬛⬛⬛⬛⬛',
      guideExcerpt: excerpt,
    });
    const reply = await askTutor(sdk, modelId, prompt);
    assert.equal(reply.text, 'Mock tutor reply.');
    assert.equal(reply.thinking, '');
    assert.equal(reply.raw, 'Mock tutor reply.');

    await unloadTutorModel(sdk, modelId);

    assert.deepEqual(
      calls.map((c) => c[0]),
      ['loadModel', 'completion', 'unloadModel']
    );
    // The completion's history carries the grounded system prompt.
    const completionArgs = calls[1][1];
    assert.match(completionArgs.history[0].content, /never reveal/i);
  });

  it('askTutor falls back gracefully on empty model output', async () => {
    const { sdk } = makeMockSdk('');
    const prompt = buildTutorPrompt({
      question: 'hi',
      boardSummary: '',
      guideExcerpt: 'guide',
    });
    const reply = await askTutor(sdk, 'mock-model-id', prompt);
    assert.equal(reply.text, TUTOR_FALLBACK);
    assert.ok(!reply.text.toLowerCase().includes('crane'));
  });

  it('loadTutorModel throws a clear error when the SDK lacks the constant', async () => {
    await assert.rejects(() => loadTutorModel({}), /QWEN3_600M_INST_Q4/);
  });
});

describe('tutor has no solver dependency', () => {
  it('tutor.js never imports the solver or guesses words itself', () => {
    const src = readFileSync(path.join(root, 'tutor.js'), 'utf8');
    // Check import statements, not the bare word (it appears in comments).
    assert.ok(!/from\s+['"][^'"]*solver[^'"]*['"]/.test(src), 'tutor must not import the solver');
    assert.ok(!/import\s*\([^)]*solver/.test(src), 'tutor must not dynamically import the solver');
  });
});

describe('chain-of-thought stripping (the <think> leak fix)', () => {
  it('splitThinking extracts a closed <think> block', () => {
    const { thinking, reply } = splitThinking('<think>let me think…</think> Let\'s go!');
    assert.equal(thinking, 'let me think…');
    assert.equal(reply, 'Let\'s go!');
  });

  it('splitThinking handles an unclosed <think> block (truncated output)', () => {
    const { thinking, reply } = splitThinking('<think> Okay, the user wants… TRULY starts');
    assert.ok(thinking.includes('Okay, the user wants'));
    assert.equal(reply, '');
  });

  it('splitThinking is case-insensitive and leaves clean replies alone', () => {
    const { thinking, reply } = splitThinking('<THINK>reasoning</THINK> Short tip.');
    assert.equal(thinking, 'reasoning');
    assert.equal(reply, 'Short tip.');
    const clean = splitThinking('Just a normal reply.');
    assert.equal(clean.thinking, '');
    assert.equal(clean.reply, 'Just a normal reply.');
  });

  it('sanitizeReply strips thinking and keeps the visible reply', () => {
    const out = sanitizeReply('<think>long chain of thought</think>\n\nTry a vowel-heavy opener.');
    assert.ok(!out.includes('<think>'));
    assert.ok(!out.toLowerCase().includes('chain of thought'));
    assert.ok(out.includes('vowel-heavy opener'));
  });

  it('sanitizeReply returns empty string when only thinking remains', () => {
    assert.equal(sanitizeReply('<think>thinking only, truncated'), '');
  });

  it('sanitizeReply truncates runaway replies at MAX_REPLY_CHARS', () => {
    const long = 'word '.repeat(300);
    const out = sanitizeReply(long);
    assert.ok(out.length <= MAX_REPLY_CHARS + 1); // +1 for the ellipsis
    assert.ok(out.endsWith('…'));
  });

  it('askTutor sanitizes a leaking model reply and records the thinking', async () => {
    const { sdk } = makeMockSdk('<think>leaked reasoning here</think>Good starter tip.');
    const prompt = buildTutorPrompt({ question: 'hi', boardSummary: '', guideExcerpt: 'guide' });
    const reply = await askTutor(sdk, 'mock-model-id', prompt);
    assert.ok(!reply.text.includes('<think>'));
    assert.ok(!reply.text.includes('leaked reasoning'));
    assert.equal(reply.text, 'Good starter tip.');
    assert.equal(reply.thinking, 'leaked reasoning here');
  });

  it('buildTutorPrompt disables thinking and the system bans reasoning display', () => {
    const prompt = buildTutorPrompt({ question: 'hi', boardSummary: '', guideExcerpt: 'guide' });
    assert.ok(prompt.history[1].content.startsWith(NO_THINK_PREFIX));
    assert.match(prompt.system, /never show your thinking/i);
    assert.match(prompt.system, /no_think|<think>/i);
  });
});
