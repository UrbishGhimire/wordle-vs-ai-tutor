/**
 * app.js — Wordle vs AI browser UI.
 *
 * Three modes:
 *   classic — daily word, solo, stats in localStorage.
 *   versus  — random word, player and a deterministic JS bot race the SAME
 *             word, alternating with the player first. Fewest guesses wins.
 *             (The bot's guesses come from solver.js — NEVER an LLM.)
 *   tutor   — solo game (daily or random) with an on-device QVAC tutor that
 *             watches your guesses and answers strategy questions, grounded
 *             in strategy-guide.md. The tutor NEVER knows the answer.
 */
import {
  GREEN, YELLOW, GRAY,
  MAX_GUESSES, WORD_LENGTH,
  scoreGuess, Game,
  dailyWord, randomWord,
} from './wordle.js';
import { Bot, MEDIUM_FIRST_GUESS, HARD_FIRST_GUESS } from './solver.js';
import { formatBoardSummary, selectGuideSections } from './tutor.js';

const $ = (id) => document.getElementById(id);
const KEYBOARD_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

let answers = [];
let validSet = new Set();
let guideText = '';
let mode = 'classic';
let settings = { difficulty: 'medium', tutorWord: 'daily' };

// Current round state.
let game = null;        // player's Game
let botGame = null;     // bot's Game (versus mode only)
let bot = null;         // Bot instance (versus mode only)
let answer = '';
let current = '';       // in-progress typed letters
let locked = false;     // input locked during animations / round end
let botTimer = null;
// The tutor's last observations this round — sent back with each new
// observation request so it never repeats itself.
let recentTutorNotes = [];

// ---------------------------------------------------------------------------
// Classic word persistence: the classic word is random per game, but a lost
// game keeps the SAME word on "Play again" until the player wins it — only
// then does the next game pick a new random word.
// ---------------------------------------------------------------------------

const CLASSIC_STORE_KEY = 'wordle-vs-ai-classic';

function loadClassicWord() {
  try {
    const saved = JSON.parse(localStorage.getItem(CLASSIC_STORE_KEY));
    if (saved && typeof saved.answer === 'string' && validSet.has(saved.answer)) {
      return { answer: saved.answer, won: saved.won === true };
    }
  } catch {
    // fall through to a fresh word
  }
  return { answer: '', won: true };
}

function saveClassicWord(word, won) {
  try {
    localStorage.setItem(CLASSIC_STORE_KEY, JSON.stringify({ answer: word, won }));
  } catch {
    // storage unavailable — the in-memory `answer` still drives the round
  }
}

/** Random answer that is never an immediate repeat of the previous word. */
function newClassicWord(previous) {
  let word = randomWord(answers);
  for (let i = 0; word === previous && i < 10; i++) {
    word = randomWord(answers);
  }
  return word;
}

const TILE_CLASS = { [GREEN]: 'green', [YELLOW]: 'yellow', [GRAY]: 'gray' };
const STATE_RANK = { [GRAY]: 0, [YELLOW]: 1, [GREEN]: 2 };

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function loadText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to load ${url}: ${res.status}`);
  return res.text();
}

async function boot() {
  try {
    const [aText, gText, guide] = await Promise.all([
      loadText('words/answers.txt'),
      loadText('words/valid-guesses.txt'),
      loadText('strategy-guide.md'),
    ]);
    answers = aText.split('\n').filter(Boolean);
    validSet = new Set(gText.split('\n').filter(Boolean));
    guideText = guide;
  } catch (err) {
    toast('Could not load word lists. Is the server running?');
    console.error(err);
    return;
  }
  buildKeyboard();
  wireModeTabs();
  wireTutorForm();
  wireAiLogButtons();
  wireResultClose();
  document.addEventListener('keydown', onPhysicalKey);
  document.body.dataset.mode = mode;
  renderSettings();
  startRound();
  armAiStatusPolling();
  armAiLogPolling();
}

function wireModeTabs() {
  $('mode-tabs').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (!btn) return;
    // Drop focus so a later physical Enter/Space can't re-click the tab and
    // silently restart the round (this used to eat the player's first guess).
    btn.blur();
    for (const b of $('mode-tabs').querySelectorAll('button')) {
      b.classList.toggle('active', b === btn);
    }
    // Await the unload before switching: the next mode must never inherit a
    // model id that is about to be invalidated (the old "Model with ID ...
    // not found" banter error).
    if (mode === 'tutor' && btn.dataset.mode !== 'tutor') {
      try {
        await fetch('/api/tutor/unload', { method: 'POST' });
      } catch {
        // unload is best-effort; the game never depends on it
      }
      $('tutor-log').innerHTML = '';
      recentTutorNotes = [];
    }
    mode = btn.dataset.mode;
    document.body.dataset.mode = mode;
    renderSettings();
    armAiStatusPolling();
    armAiLogPolling();
    if (mode === 'versus') {
      // Versus waits for the chat model behind a loading overlay — the round
      // only starts once the model is ready (or confirmed unavailable).
      await enterVersus();
    } else {
      startRound();
    }
  });
}

function wireResultClose() {
  $('result-close').addEventListener('click', () => {
    $('result-modal').classList.add('hidden');
    startRound();
  });
}

// ---------------------------------------------------------------------------
// Settings bar
// ---------------------------------------------------------------------------

function renderSettings() {
  const el = $('settings');
  el.innerHTML = '';
  if (mode === 'versus') {
    el.appendChild(labeledSelect(
      'Bot difficulty:',
      ['easy', 'medium', 'hard'],
      settings.difficulty,
      (v) => { settings.difficulty = v; startRound(); },
    ));
    const hint = document.createElement('span');
    hint.textContent = botBlurb(settings.difficulty);
    el.appendChild(hint);
  } else if (mode === 'tutor') {
    el.appendChild(labeledSelect(
      'Word:',
      [['daily', 'Daily word'], ['random', 'Random word']],
      settings.tutorWord,
      (v) => { settings.tutorWord = v; startRound(); },
    ));
    const hint = document.createElement('span');
    hint.textContent = 'The tutor watches your guesses — it never knows the answer.';
    el.appendChild(hint);
  } else {
    const hint = document.createElement('span');
    hint.textContent = 'Random word · retries keep the same word until you win';
    el.appendChild(hint);
  }
}

function labeledSelect(labelText, options, value, onChange) {
  const label = document.createElement('label');
  label.textContent = labelText;
  const select = document.createElement('select');
  for (const opt of options) {
    const [v, text] = Array.isArray(opt) ? opt : [opt, opt[0].toUpperCase() + opt.slice(1)];
    const o = document.createElement('option');
    o.value = v;
    o.textContent = text;
    if (v === value) o.selected = true;
    select.appendChild(o);
  }
  select.addEventListener('change', () => onChange(select.value));
  label.appendChild(select);
  return label;
}

function botBlurb(difficulty) {
  return {
    easy: 'Easy: guesses at random, ignores clues.',
    medium: `Medium: uses clues + letter frequency (opens ${MEDIUM_FIRST_GUESS.toUpperCase()}).`,
    hard: `Hard: near-optimal solver (opens ${HARD_FIRST_GUESS.toUpperCase()}).`,
  }[difficulty];
}

// ---------------------------------------------------------------------------
// Round setup
// ---------------------------------------------------------------------------

function startRound() {
  clearTimeout(botTimer);
  current = '';
  locked = false;
  $('result-modal').classList.add('hidden');
  $('banter').textContent = '';

  if (mode === 'versus') {
    answer = pickAnswerFor('versus');
    game = new Game(answer, validSet);
    botGame = new Game(answer, validSet);
    bot = new Bot(settings.difficulty, answers, [...validSet].sort());
    $('bot-panel').classList.remove('hidden');
    $('tutor-panel').classList.add('hidden');
    $('player-title').textContent = 'You';
    $('bot-title').textContent = `AI Bot (${settings.difficulty})`;
    banter('game start');
  } else if (mode === 'classic') {
    // Random word per game; a lost game retries the SAME word until won.
    const saved = loadClassicWord();
    answer = saved.answer && !saved.won ? saved.answer : newClassicWord(saved.answer);
    saveClassicWord(answer, false);
    game = new Game(answer, validSet);
    botGame = null;
    bot = null;
    $('bot-panel').classList.add('hidden');
    $('tutor-panel').classList.add('hidden');
    $('player-title').textContent = 'You';
  } else {
    // tutor mode — the tutor never knows the answer (see tutor.js)
    answer = pickAnswerFor(mode);
    game = new Game(answer, validSet);
    botGame = null;
    bot = null;
    recentTutorNotes = [];
    $('bot-panel').classList.add('hidden');
    $('player-title').textContent = 'You (tutored)';
    $('tutor-panel').classList.remove('hidden');
    tutorSay('tutor', 'I\'m watching your game. Play your first guess and I\'ll share an observation — or ask me anything about strategy.');
  }

  renderBoard($('board'), game.guesses);
  renderBoard($('bot-board'), []);
  resetKeyboard();
}

function pickAnswerFor(modeName) {
  if (modeName === 'versus') return randomWord(answers);
  if (modeName === 'tutor' && settings.tutorWord === 'random') return randomWord(answers);
  return dailyWord(answers);
}

// ---------------------------------------------------------------------------
// Board + keyboard rendering
// ---------------------------------------------------------------------------

function renderBoard(boardEl, guesses) {
  boardEl.innerHTML = '';
  for (let r = 0; r < MAX_GUESSES; r++) {
    const row = document.createElement('div');
    row.className = 'row';
    const g = guesses[r];
    for (let c = 0; c < WORD_LENGTH; c++) {
      const tile = document.createElement('div');
      tile.className = 'tile';
      if (g) {
        tile.textContent = g.word[c];
        tile.classList.add('filled', TILE_CLASS[g.tiles[c]]);
      } else if (r === guesses.length && current[c]) {
        tile.textContent = current[c];
        tile.classList.add('filled', 'pop');
      }
      row.appendChild(tile);
    }
    boardEl.appendChild(row);
  }
}

function buildKeyboard() {
  const kb = $('keyboard');
  kb.innerHTML = '';
  for (const rowChars of KEYBOARD_ROWS) {
    const row = document.createElement('div');
    row.className = 'kb-row';
    if (rowChars === 'zxcvbnm') row.appendChild(makeKey('Enter', 'wide'));
    for (const ch of rowChars) row.appendChild(makeKey(ch, ''));
    if (rowChars === 'zxcvbnm') row.appendChild(makeKey('Backspace', 'wide', '⌫'));
    kb.appendChild(row);
  }
  kb.addEventListener('click', (e) => {
    const key = e.target.closest('.key');
    if (key) handleKey(key.dataset.key);
  });
}

function makeKey(key, extra, label) {
  const b = document.createElement('button');
  b.className = `key ${extra}`.trim();
  b.dataset.key = key;
  b.dataset.letter = key;
  b.textContent = label || key.toUpperCase();
  return b;
}

function resetKeyboard() {
  for (const key of $('keyboard').querySelectorAll('.key')) {
    key.classList.remove('green', 'yellow', 'gray');
  }
}

function paintKeyboard(guesses) {
  const best = {};
  for (const g of guesses) {
    for (let i = 0; i < WORD_LENGTH; i++) {
      const ch = g.word[i];
      if (STATE_RANK[g.tiles[i]] > (STATE_RANK[best[ch]] ?? -1)) best[ch] = g.tiles[i];
    }
  }
  for (const key of $('keyboard').querySelectorAll('.key')) {
    const ch = key.dataset.letter;
    if (ch.length === 1 && best[ch]) {
      key.classList.remove('green', 'yellow', 'gray');
      key.classList.add(TILE_CLASS[best[ch]]);
    }
  }
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

function onPhysicalKey(e) {
  if (!$('result-modal').classList.contains('hidden')) {
    if (e.key === 'Enter' || e.key === 'Escape') $('result-close').click();
    return;
  }
  if (document.activeElement === $('tutor-input')) return;
  if (/^[a-zA-Z]$/.test(e.key)) handleKey(e.key.toLowerCase());
  else if (e.key === 'Enter') handleKey('Enter');
  else if (e.key === 'Backspace') handleKey('Backspace');
}

function handleKey(key) {
  if (locked || game.over) return;
  if (key === 'Enter') {
    submitGuess();
  } else if (key === 'Backspace') {
    current = current.slice(0, -1);
    renderBoard($('board'), game.guesses);
  } else if (/^[a-z]$/.test(key) && current.length < WORD_LENGTH) {
    current += key;
    renderBoard($('board'), game.guesses);
  }
}

async function submitGuess() {
  if (current.length !== WORD_LENGTH) {
    toast('Not enough letters');
    shakeRow(game.guesses.length);
    return;
  }
  if (!validSet.has(current)) {
    toast('Not in word list');
    shakeRow(game.guesses.length);
    return;
  }
  locked = true;
  const word = current;
  current = '';
  try {
    const result = game.guess(word);
    renderBoard($('board'), game.guesses);
    paintKeyboard(game.guesses);

    if (mode === 'versus') {
      await versusAfterPlayerMove(result);
    } else {
      afterSoloMove(result);
    }
  } finally {
    // Never leave input bricked if the bot's move throws.
    locked = false;
  }
}

function shakeRow(rowIndex) {
  const row = $('board').children[rowIndex];
  if (!row) return;
  row.classList.add('shake-row');
  setTimeout(() => row.classList.remove('shake-row'), 450);
}

// ---------------------------------------------------------------------------
// Solo + tutor flow
// ---------------------------------------------------------------------------

function afterSoloMove(result) {
  if (mode === 'tutor') observeGuess();
  if (mode === 'classic') {
    // A win unlocks a fresh random word next round; a loss retries this one.
    saveClassicWord(answer, result.won);
  }
  if (result.won) {
    recordStats(true, result.guessesUsed);
    showResult('You win! 🎉', `Solved in ${result.guessesUsed} ${result.guessesUsed === 1 ? 'guess' : 'guesses'}. The word was ${answer.toUpperCase()}.`);
  } else if (result.lost) {
    recordStats(false, MAX_GUESSES);
    showResult('Out of guesses', `The word was ${answer.toUpperCase()}. Hit "Play again" to retry the same word.`);
  }
}

// ---------------------------------------------------------------------------
// Versus entry gate — the round starts only after the chat model is ready
// (or confirmed unavailable), behind a "please wait" loading overlay.
// ---------------------------------------------------------------------------

function showLoadingOverlay(message) {
  $('loading-message').textContent = message;
  $('loading-overlay').classList.remove('hidden');
}

function hideLoadingOverlay() {
  $('loading-overlay').classList.add('hidden');
}

async function fetchModelState() {
  try {
    const res = await fetch('/api/tutor/status');
    const data = await res.json();
    return data.ok && data.state ? data.state : 'idle';
  } catch {
    return 'unavailable';
  }
}

/** Poll /api/tutor/status until ready/failed, or give up after timeoutMs. */
async function waitForModelReady(timeoutMs) {
  const startedAt = Date.now();
  for (;;) {
    const state = await fetchModelState();
    if (state === 'ready') return true;
    if (state === 'failed' || state === 'unavailable') return false;
    if (Date.now() - startedAt > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

async function enterVersus() {
  // Fast path: the model is already warm.
  if ((await fetchModelState()) === 'ready') {
    startRound();
    return;
  }
  showLoadingOverlay('Please wait — loading the AI model…');
  try {
    await fetch('/api/tutor/warmup', { method: 'POST' });
  } catch {
    // warmup is best-effort; the status poll below is the source of truth
  }
  const ready = await waitForModelReady(4 * 60 * 1000);
  hideLoadingOverlay();
  if (!ready) {
    toast('AI chat unavailable — playing without banter.');
  }
  updateAiStatus();
  startRound();
}

// ---------------------------------------------------------------------------
// Versus flow — same word, player first, fewest guesses wins
// ---------------------------------------------------------------------------

async function versusAfterPlayerMove(playerResult) {
  const playerSolvedIn = playerResult.won ? playerResult.guessesUsed : null;

  // Player won outright (bot moves second each round, so the bot cannot tie
  // a same-round solve — it would already have fewer guesses).
  if (playerSolvedIn !== null) {
    const botSolvedIn = botGame.won ? botGame.guesses.length : null;
    endVersus(playerSolvedIn, botSolvedIn);
    return;
  }

  // Player used all 6 without solving: the bot still gets its final move.
  const botHasMovesLeft = botGame.guesses.length < MAX_GUESSES && !botGame.over;
  if (playerResult.lost && !botHasMovesLeft) {
    endVersus(null, botGame.won ? botGame.guesses.length : null);
    return;
  }

  // Bot's turn (slight delay for readability). The game bot is deterministic
  // JS — it never waits on the AI model — but hard mode can crunch numbers
  // for a few seconds, so show a status first and let it paint.
  setBotStatus('Bot is thinking…');
  try {
    await new Promise((resolve) => {
      botTimer = setTimeout(resolve, 450);
    });
    const tiles = botGame.guesses.length === 0
      ? null
      : scoreGuess(answer, botGame.guesses[botGame.guesses.length - 1].word);
    const botWord = bot.move(tiles);
    const botResult = botGame.guess(botWord);
    renderBoard($('bot-board'), botGame.guesses);

    if (botResult.won) {
      endVersus(playerSolvedIn, botResult.guessesUsed);
    } else if (botResult.lost && game.over) {
      endVersus(playerSolvedIn, null);
    }
    // Otherwise the round continues with the player's next guess.
  } finally {
    setBotStatus('');
  }
}

function setBotStatus(text) {
  const el = $('bot-status');
  if (el) el.textContent = text;
}

function endVersus(playerSolvedIn, botSolvedIn) {
  let title;
  let detail;
  let moment;
  if (playerSolvedIn !== null && botSolvedIn !== null) {
    if (playerSolvedIn < botSolvedIn) {
      title = 'You win! 🎉';
      detail = `You solved it in ${playerSolvedIn}; the bot needed ${botSolvedIn}.`;
      moment = 'player wins';
    } else if (botSolvedIn < playerSolvedIn) {
      title = 'Bot wins 🤖';
      detail = `The bot solved it in ${botSolvedIn}; you needed ${playerSolvedIn}.`;
      moment = 'bot wins';
    } else {
      title = "It's a draw";
      detail = `Both solved in ${playerSolvedIn} guesses.`;
      moment = 'draw';
    }
  } else if (playerSolvedIn !== null) {
    title = 'You win! 🎉';
    detail = `You solved it in ${playerSolvedIn}; the bot ran out of guesses.`;
    moment = 'player wins';
  } else if (botSolvedIn !== null) {
    title = 'Bot wins 🤖';
    detail = `The bot solved it in ${botSolvedIn}; you ran out of guesses. The word was ${answer.toUpperCase()}.`;
    moment = 'bot wins';
  } else {
    title = "It's a draw";
    detail = `Nobody solved it. The word was ${answer.toUpperCase()}.`;
    moment = 'draw';
  }
  banter(moment);
  showResult(title, detail);
}

// ---------------------------------------------------------------------------
// Tutor chat (server-side QVAC; failures are silent — the game never depends
// on the model)
// ---------------------------------------------------------------------------

async function observeGuess() {
  const summary = formatBoardSummary(game.guesses);
  const excerpt = selectGuideSections('observation after guess', guideText);
  const thinking = tutorSay('tutor', 'Thinking…', true);
  try {
    const res = await fetch('/api/tutor/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        question: null,
        boardSummary: summary,
        guideExcerpt: excerpt,
        observationMode: true,
        recentNotes: recentTutorNotes.slice(-2),
      }),
    });
    const data = await res.json();
    thinking.remove();
    if (data.ok && data.text) {
      tutorSay('tutor', data.text);
      recentTutorNotes.push(data.text);
      if (recentTutorNotes.length > 2) recentTutorNotes.splice(0, recentTutorNotes.length - 2);
    }
  } catch {
    thinking.remove();
  } finally {
    updateAiStatus();
    refreshAiLogs();
  }
}

function wireTutorForm() {
  $('tutor-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('tutor-input');
    const question = input.value.trim();
    if (!question) return;
    input.value = '';
    tutorSay('player', question);
    const summary = formatBoardSummary(game.guesses);
    const excerpt = selectGuideSections(question, guideText);
    const thinking = tutorSay('tutor', 'Thinking…', true);
    try {
      const res = await fetch('/api/tutor/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          question,
          boardSummary: summary,
          guideExcerpt: excerpt,
          recentNotes: recentTutorNotes.slice(-2),
        }),
      });
      const data = await res.json();
      thinking.remove();
      tutorSay('tutor', data.ok && data.text
        ? data.text
        : 'The on-device tutor is unavailable right now — check the strategy guide section above for now.');
    } catch {
      thinking.remove();
      tutorSay('tutor', 'The on-device tutor is unavailable right now — check the strategy guide section above for now.');
    } finally {
      updateAiStatus();
      refreshAiLogs();
    }
  });
}

function tutorSay(who, text, thinking = false) {
  const log = $('tutor-log');
  const div = document.createElement('div');
  div.className = `tutor-msg ${who}${thinking ? ' thinking' : ''}`;
  div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div;
}

// ---------------------------------------------------------------------------
// Banter (optional flavor text from the model; never affects gameplay)
// ---------------------------------------------------------------------------

function banter(moment) {
  if (mode !== 'versus') return;
  fetch('/api/banter', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ moment }),
  })
    .then((r) => r.json())
    .then((data) => {
      if (data.ok && data.text) $('banter').textContent = `“${data.text}”`;
    })
    .catch(() => {})
    .finally(() => {
      updateAiStatus();
      refreshAiLogs();
    });
}

// ---------------------------------------------------------------------------
// AI model status pills + AI activity log panel
//
// The game bot (solver.js) is deterministic JS and never needs the model, so
// typing always works. The pills below report the *chat* model state
// (banter + tutor): loading while the ~400MB weights download, ready once
// loaded, unavailable when the load failed.
// ---------------------------------------------------------------------------

let aiStatusTimer = null;

const AI_STATE_LABEL = {
  idle: 'idle',
  loading: 'loading…',
  ready: 'ready',
  failed: 'unavailable',
  unavailable: 'unreachable',
};

function paintAiPill(pill, state, prefix) {
  if (!pill) return;
  const label = AI_STATE_LABEL[state] || AI_STATE_LABEL.idle;
  const cls = state === 'loading' ? 'loading' : state === 'ready' ? 'ready' : 'bad';
  pill.textContent = `${prefix} ${label}`;
  pill.className = `ai-status ${cls}`;
}

async function updateAiStatus() {
  let state = 'idle';
  try {
    const res = await fetch('/api/tutor/status');
    const data = await res.json();
    if (data.ok && data.state) state = data.state;
  } catch {
    state = 'unavailable';
  }
  paintAiPill($('ai-status-versus'), state, 'Chat AI');
  paintAiPill($('ai-status-tutor'), state, 'AI');
}

function armAiStatusPolling() {
  clearInterval(aiStatusTimer);
  aiStatusTimer = null;
  if (mode === 'versus' || mode === 'tutor') {
    updateAiStatus();
    aiStatusTimer = setInterval(updateAiStatus, 8000);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function aiLogEntryHtml(e) {
  const time = (() => {
    try {
      return new Date(e.t).toLocaleTimeString();
    } catch {
      return '';
    }
  })();
  let html =
    `<div class="ai-log-entry">` +
    `<div class="ai-log-head"><span class="ai-log-time">${escapeHtml(time)}</span> ` +
    `<span class="ai-log-kind">${escapeHtml(e.kind || 'ai')}</span>` +
    (e.ms ? ` <span class="ai-log-ms">${escapeHtml(String(e.ms))}ms</span>` : '') +
    `</div>`;
  if (e.input) html += `<div class="ai-log-input"><b>you:</b> ${escapeHtml(e.input)}</div>`;
  if (e.thinking) {
    html += `<details class="ai-log-thinking"><summary>model thinking</summary>` +
      `<pre>${escapeHtml(e.thinking)}</pre></details>`;
  }
  if (e.response) html += `<div class="ai-log-response"><b>ai:</b> ${escapeHtml(e.response)}</div>`;
  return `${html}</div>`;
}

async function refreshAiLog(listId) {
  const list = $(listId);
  if (!list) return;
  list.innerHTML = '<div class="ai-log-empty">loading…</div>';
  try {
    const res = await fetch('/api/ai-log');
    const data = await res.json();
    const entries = (data.ok && data.entries ? data.entries : []).slice(-30).reverse();
    list.innerHTML = entries.length
      ? entries.map(aiLogEntryHtml).join('')
      : '<div class="ai-log-empty">No AI activity yet — play a round or ask the tutor.</div>';
  } catch {
    list.innerHTML = '<div class="ai-log-empty">Could not load the log.</div>';
  }
}

/** Refresh whichever AI log section is currently visible. */
function refreshAiLogs() {
  if (mode === 'versus') refreshAiLog('ai-log-list-versus');
  if (mode === 'tutor') refreshAiLog('ai-log-list-tutor');
}

let aiLogTimer = null;

/** Keep the always-visible AI log fresh while in versus/tutor mode. */
function armAiLogPolling() {
  clearInterval(aiLogTimer);
  aiLogTimer = null;
  if (mode === 'versus' || mode === 'tutor') {
    refreshAiLogs();
    aiLogTimer = setInterval(refreshAiLogs, 3000);
  }
}

function wireAiLogButtons() {
  const pairs = [
    ['ai-log-list-versus', 'ai-log-refresh-versus'],
    ['ai-log-list-tutor', 'ai-log-refresh-tutor'],
  ];
  for (const [listId, btnId] of pairs) {
    const btn = $(btnId);
    if (btn) btn.addEventListener('click', () => refreshAiLog(listId));
  }
}

// ---------------------------------------------------------------------------
// Toast, result modal, stats
// ---------------------------------------------------------------------------

let toastTimer = null;

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 1200);
}

function showResult(title, detail) {
  $('result-title').textContent = title;
  $('result-detail').textContent = detail;
  renderStats();
  $('result-modal').classList.remove('hidden');
}

function getStats() {
  try {
    return JSON.parse(localStorage.getItem('wordle-vs-ai-stats')) || freshStats();
  } catch {
    return freshStats();
  }
}

function freshStats() {
  return { played: 0, won: 0, streak: 0, maxStreak: 0, dist: [0, 0, 0, 0, 0, 0] };
}

function recordStats(won, guessesUsed) {
  if (mode === 'versus') return; // versus rounds don't count toward solo stats
  const s = getStats();
  s.played += 1;
  if (won) {
    s.won += 1;
    s.streak += 1;
    s.maxStreak = Math.max(s.maxStreak, s.streak);
    s.dist[guessesUsed - 1] += 1;
  } else {
    s.streak = 0;
  }
  localStorage.setItem('wordle-vs-ai-stats', JSON.stringify(s));
}

function renderStats() {
  const s = getStats();
  const winPct = s.played ? Math.round((100 * s.won) / s.played) : 0;
  const max = Math.max(1, ...s.dist);
  const bars = s.dist
    .map((c, i) => {
      const h = Math.round((40 * c) / max);
      return `<div class="dist-bar" style="height:${18 + h}px">${c}</div>`;
    })
    .join('');
  $('stats').innerHTML =
    `<div>Played ${s.played} · Won ${winPct}% · Streak ${s.streak} (best ${s.maxStreak})</div>` +
    `<div class="dist">${bars}</div>`;
}

boot();
