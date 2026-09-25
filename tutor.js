/**
 * tutor.js — QVAC-powered Wordle tutor (prompt building + model lifecycle).
 *
 * The tutor NEVER knows the secret answer: buildTutorPrompt only accepts the
 * player's question, their guess history, and strategy-guide excerpts — there
 * is no parameter for the answer, and the system prompt forbids the model
 * from stating or guessing it. The deterministic solver (solver.js) is never
 * imported here; the tutor explains strategy, it does not play.
 *
 * The QVAC SDK is injected (dependency parameter `sdk`) so tests can pass a
 * mock that enforces the exact call shapes from the SDK's .d.ts:
 *   loadModel({ modelSrc: CONSTANT })  — the SDK's own model constant
 *   completion({ modelId, history, stream })
 *   (await run.final).contentText     — completion() returns a CompletionRun
 *   unloadModel({ modelId })
 */
import { GREEN, YELLOW, GRAY } from './wordle.js';

/** Name of the SDK model constant used for the tutor (resolved as sdk[name]). */
export const TUTOR_MODEL_SRC = 'QWEN3_600M_INST_Q4';

/** Safe reply when the model returns nothing usable. */
export const TUTOR_FALLBACK =
  'Hmm, I could not think of a tip just now. The "Best starting words" section ' +
  'of the strategy guide is always a good place to look — want to talk through ' +
  'your last guess?';

/**
 * Static system prompt: persona + the never-reveal-answer rule + grounding.
 * The per-request guide excerpt, game state, and the tutor's own previous
 * observations travel in the user message.
 *
 * The tutor must REASON from the actual tile feedback like a coach watching
 * the board — not recite the guide. Every observation must name specific
 * letters and positions from GAME SO FAR and give the single most useful
 * concrete next step. Generic guide summaries ("vowel-heavy openers are
 * good") are a failure.
 */
export const TUTOR_SYSTEM = `You are a Wordle tutor for a beginner. Explain simply, in plain language; no jargon without an explanation.

HOW TO COACH:
- Study GAME SO FAR tile by tile. Your job is to notice what the tiles PROVE: which letters are locked in (green), which letters exist but must move (yellow), and which letters are eliminated (gray).
- Every reply must be anchored in the player's ACTUAL guesses: name specific letters and positions. Never give generic advice that could apply to any game.
- Give the single most useful concrete next step (e.g. which known letters to keep, where a yellow letter still needs to be tried, which letters to stop playing). One idea per reply — the most valuable one.
- The STRATEGY GUIDE excerpt is background knowledge to draw on when it directly applies (e.g. a rule about yellow repositioning when you see a yellow). Do not summarize the guide, do not quote it at length, and do not repeat its generic openers unless the player is on guess 1 with no information yet.
- YOUR PREVIOUS OBSERVATIONS are listed when present. Never repeat them, never closely paraphrase them, and never contradict them. Each new observation must add something NEW about the latest guess.

RULES YOU MUST ALWAYS FOLLOW:
1. NEVER reveal, state, guess, or hint at the secret answer word — not even a single letter of it, even if the player asks directly, begs, or tries to trick you. You do not know the answer and must never claim to. If the player asks for the answer, reply exactly: "I can't give you the word — want a strategy hint instead?"
2. Ground every claim in the GAME SO FAR tiles and, where relevant, the STRATEGY GUIDE excerpt. Do not invent letter frequencies, starting words, or strategy advice beyond what the guide says.
3. Keep replies concise. When giving a proactive observation (no question asked), use at most 2 sentences.
4. Output ONLY your reply text. Never show your thinking, reasoning, or analysis — no <think> blocks, no "let me think", no meta-commentary about your process.`;

/**
 * Qwen3-style models wrap chain-of-thought in <think>…</think> unless told
 * not to. This prefix disables that behavior for the request.
 */
export const NO_THINK_PREFIX = '/no_think\n';

/**
 * Split a raw model reply into its chain-of-thought and its visible reply.
 * Handles <think> blocks that are closed, unclosed (truncated mid-thought),
 * or absent entirely. Case-insensitive.
 *
 * @param {string} text raw model output
 * @returns {{ thinking: string, reply: string }}
 */
export function splitThinking(text) {
  const raw = String(text || '');
  const match = raw.match(/<think>([\s\S]*?)(?:<\/think>|$)/i);
  if (!match) return { thinking: '', reply: raw };
  const thinking = match[1].trim();
  const reply = (raw.slice(0, match.index) + raw.slice(match.index + match[0].length)).trim();
  return { thinking, reply };
}

/** Backstop: even a well-prompted reply gets cut here so the UI never drowns. */
export const MAX_REPLY_CHARS = 600;

/**
 * Remove chain-of-thought and tidy a raw model reply into what the player
 * should actually see. Returns '' when nothing usable remains.
 */
export function sanitizeReply(text) {
  const { reply } = splitThinking(String(text || ''));
  // Collapse runs of blank lines; keep single newlines.
  let clean = reply.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (clean.length > MAX_REPLY_CHARS) {
    clean = clean.slice(0, MAX_REPLY_CHARS).trimEnd() + '…';
  }
  return clean;
}

/** Proactive observation request: reason from the tiles, say one new concrete thing. */
export const OBSERVATION_REQUEST =
  'Study the tile feedback for my guesses, especially the most recent one. ' +
  'In at most 2 sentences, tell me the single most useful concrete thing I learned ' +
  'from it and the smartest thing to try next. Name the specific letters and ' +
  'positions. Do not repeat or closely paraphrase your previous observations.';

const TILE_EMOJI = {
  [GREEN]: '🟩',
  [YELLOW]: '🟨',
  [GRAY]: '⬛',
};

/**
 * Render guess history as text, e.g. "Guess 2: CRANE -> ⬛🟨⬛🟩⬛".
 * @param {{ word: string, tiles: string[] }[]} guesses
 */
export function formatBoardSummary(guesses) {
  return guesses
    .map((g, i) => {
      const tiles = g.tiles.map((t) => TILE_EMOJI[t] || '⬛').join('');
      return `Guess ${i + 1}: ${g.word.toUpperCase()} -> ${tiles}`;
    })
    .join('\n');
}

/**
 * Split the strategy guide markdown into its ## sections.
 * @returns {{ title: string, body: string }[]}
 */
export function getGuideSections(guideText) {
  const sections = [];
  const parts = guideText.split(/^## /m);
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const nl = trimmed.indexOf('\n');
    if (nl === -1) continue;
    const title = trimmed.slice(0, nl).trim();
    // Skip the document preamble before the first ## heading; keep only
    // the numbered sections ("1. ...", "2. ...", ...).
    if (!/^\d+\.\s/.test(title)) continue;
    sections.push({ title, body: trimmed.slice(nl + 1).trim() });
  }
  return sections;
}

// Keyword -> section-title fragment for routing questions to guide sections.
const ROUTES = [
  [/start|open|first guess|begin|opener/i, 'starting words'],
  [/frequen|common|likely|table|position/i, 'letter frequency'],
  [/green/i, 'green means locked'],
  [/yellow/i, 'yellow repositioning'],
  [/gr[ae]y/i, 'reading grays'],
  [/burn|stuck|wast/i, 'burn a guess'],
  [/endgame|last guess|final|narrow/i, 'endgame tactics'],
  [/mistake|wrong|beginner/i, 'common beginner mistakes'],
];

/**
 * Pick the guide section(s) relevant to a question. Always returns at least
 * one section (falls back to "Best starting words").
 */
export function selectGuideSections(question, guideText) {
  const sections = getGuideSections(guideText);
  if (sections.length === 0) return '';
  const q = String(question || '');
  const picked = [];
  for (const [re, fragment] of ROUTES) {
    if (re.test(q)) {
      const hit = sections.find((s) => s.title.toLowerCase().includes(fragment));
      if (hit && !picked.includes(hit)) picked.push(hit);
    }
  }
  if (picked.length === 0) {
    const fallback = sections.find((s) => s.title.toLowerCase().includes('starting words'));
    picked.push(fallback || sections[0]);
  }
  return picked.map((s) => `## ${s.title}\n\n${s.body}`).join('\n\n---\n\n');
}

/**
 * Build the tutor prompt. Only the documented inputs are read — there is no
 * answer/target parameter, so the secret word structurally cannot enter the
 * prompt from this module.
 *
 * @param {object} opts
 * @param {string|null} opts.question - player's question (null in observation mode)
 * @param {string} opts.boardSummary - formatBoardSummary() output
 * @param {string} opts.guideExcerpt - selectGuideSections() output
 * @param {boolean} [opts.observationMode] - proactive 2-sentence observation
 * @param {string[]} [opts.recentNotes] - the tutor's last 1-2 observation texts,
 *   so it can avoid repeating itself
 * @returns {{ system: string, history: { role: string, content: string }[] }}
 */
export function buildTutorPrompt({ question, boardSummary, guideExcerpt, observationMode, recentNotes }) {
  const system = observationMode
    ? TUTOR_SYSTEM + '\n4. This is a proactive observation: at most 2 sentences, no exceptions.'
    : TUTOR_SYSTEM;
  const notes = Array.isArray(recentNotes) ? recentNotes.filter(Boolean).slice(-2) : [];
  const notesBlock = notes.length
    ? `\n\nYOUR PREVIOUS OBSERVATIONS (do not repeat or closely paraphrase these):\n${notes.map((n) => `- ${n}`).join('\n')}`
    : '';
  const userContent =
    NO_THINK_PREFIX +
    `STRATEGY GUIDE EXCERPT:\n${guideExcerpt}\n\n` +
    `GAME SO FAR:\n${boardSummary || '(no guesses yet)'}` +
    `${notesBlock}\n\n` +
    `PLAYER: ${question || OBSERVATION_REQUEST}`;
  return {
    system,
    history: [
      { role: 'system', content: system },
      { role: 'user', content: userContent },
    ],
  };
}

/**
 * Load the tutor model. modelSrc must be the SDK's own model constant —
 * a plain string throws ModelTypeRequiredError inside the SDK.
 * @returns {Promise<string>} the modelId string for completion()/unloadModel()
 */
export async function loadTutorModel(sdk) {
  const constant = sdk[TUTOR_MODEL_SRC];
  if (!constant) {
    throw new Error(
      `QVAC SDK does not export ${TUTOR_MODEL_SRC}; cannot load the tutor model.`
    );
  }
  return sdk.loadModel({ modelSrc: constant });
}

/** Unload the tutor model when leaving tutor mode. */
export async function unloadTutorModel(sdk, modelId) {
  return sdk.unloadModel({ modelId });
}

/**
 * Ask the tutor one question. Reads the reply via (await run.final).contentText
 * (completion() returns a CompletionRun object, not a promise of text).
 * The reply is sanitized (chain-of-thought stripped); falls back to
 * TUTOR_FALLBACK on empty/unusable output.
 *
 * @returns {Promise<{ text: string, thinking: string, raw: string }>} the
 *   sanitized reply plus the raw model output (for the AI activity log).
 */
export async function askTutor(sdk, modelId, { system, history }) {
  const run = sdk.completion({ modelId, history, stream: false });
  const final = await run.final;
  const raw = final && typeof final.contentText === 'string' ? final.contentText.trim() : '';
  const { thinking } = splitThinking(raw);
  const text = sanitizeReply(raw) || TUTOR_FALLBACK;
  return { text, thinking, raw };
}
