/**
 * scripts/smoke.mjs — headless UI smoke test.
 *
 * Runs the REAL app.js against the REAL server.mjs with a minimal DOM shim
 * (no browser on this VM). /api/banter, /api/tutor/ask and /api/ai-log are
 * mocked (they would otherwise wait on the model); /api/tutor/status and all
 * static files hit the real server.
 *
 * Usage: node scripts/smoke.mjs
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;

function check(name, cond) {
  if (cond) {
    passed += 1;
    console.log(`  ok - ${name}`);
  } else {
    console.error(`  FAIL - ${name}`);
    process.exitCode = 1;
  }
}

async function pollFor(fn, timeoutMs = 10000, label = '') {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

// ---------------------------------------------------------------------------
// Minimal DOM shim
// ---------------------------------------------------------------------------

let activeElement = null;

class FakeClassList {
  constructor() { this.set = new Set(); }
  add(...c) { c.forEach((x) => this.set.add(x)); }
  remove(...c) { c.forEach((x) => this.set.delete(x)); }
  toggle(c, force) {
    const on = force !== undefined ? force : !this.set.has(c);
    if (on) this.set.add(c); else this.set.delete(c);
    return on;
  }
  contains(c) { return this.set.has(c); }
}

class FakeElement {
  constructor(tag = 'div', id = '') {
    this.tagName = String(tag).toUpperCase();
    this.id = id;
    this.children = [];
    this.parent = null;
    this.classList = new FakeClassList();
    this.dataset = {};
    this.style = {};
    this.textContent = '';
    this._innerHTML = '';
    this.listeners = {};
    this.value = '';
    this.open = false;
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.blurCalled = false;
  }
  get className() { return [...this.classList.set].join(' '); }
  set className(v) {
    this.classList.set.clear();
    String(v).split(/\s+/).filter(Boolean).forEach((c) => this.classList.set.add(c));
  }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(v) {
    this._innerHTML = String(v);
    if (String(v) === '') this.children = [];
  }
  appendChild(c) { this.children.push(c); c.parent = this; return c; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  dispatch(type, event = {}) {
    if (event.target == null) event.target = this;
    for (const fn of this.listeners[type] || []) fn(event);
    // Real DOM clicks bubble: button -> nav, key -> keyboard.
    if (this.parent) this.parent.dispatch(type, event);
  }
  click() { this.dispatch('click', {}); }
  blur() { this.blurCalled = true; if (activeElement === this) activeElement = null; }
  focus() { activeElement = this; }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
  }
  closest(sel) {
    if (sel === 'button[data-mode]' && this.tagName === 'BUTTON' && this.dataset.mode) return this;
    if (sel === '.key' && this.classList.contains('key')) return this;
    return null;
  }
  querySelectorAll(sel) {
    const out = [];
    const walk = (el) => {
      for (const c of el.children) {
        if (sel === '.key' && c.classList.contains('key')) out.push(c);
        if (sel === 'button' && c.tagName === 'BUTTON') out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
}

const byId = {};
function el(id, tag = 'div', cls = '') {
  const e = new FakeElement(tag, id);
  if (cls) e.classList.add(...cls.split(' '));
  byId[id] = e;
  return e;
}

// Build the page skeleton (mirrors index.html).
const modeTabs = el('mode-tabs', 'nav');
for (const [m, active] of [['classic', true], ['versus', false], ['tutor', false]]) {
  const b = new FakeElement('button');
  b.dataset.mode = m;
  b.textContent = m;
  if (active) b.classList.add('active');
  modeTabs.appendChild(b);
}
el('settings', 'section');
el('game-area');
el('player-panel', 'section');
el('player-title', 'h2');
el('board', 'div', 'board');
el('keyboard');
const botPanel = el('bot-panel', 'section', 'hidden');
el('bot-title', 'span');
el('bot-board', 'div', 'board');
el('bot-status', 'p', 'bot-status');
el('banter', 'p', 'banter');
el('ai-status-versus', 'span', 'ai-status');
const aiLogVersus = el('ai-log-versus', 'section', 'ai-log-wrap');
aiLogVersus.appendChild(el('ai-log-list-versus', 'div', 'ai-log-list'));
aiLogVersus.appendChild(el('ai-log-refresh-versus', 'button'));
const tutorPanel = el('tutor-panel', 'aside', 'hidden');
el('ai-status-tutor', 'span', 'ai-status');
el('tutor-log', 'div', 'tutor-log');
el('tutor-form', 'form');
const tutorInput = el('tutor-input', 'input');
const aiLogTutor = el('ai-log-tutor', 'section', 'ai-log-wrap');
aiLogTutor.appendChild(el('ai-log-list-tutor', 'div', 'ai-log-list'));
aiLogTutor.appendChild(el('ai-log-refresh-tutor', 'button'));
el('toast', 'div', 'hidden');
const loadingOverlay = el('loading-overlay', 'div', 'hidden');
el('loading-message', 'p');
const resultModal = el('result-modal', 'div', 'hidden');
el('result-title', 'h2');
el('result-detail', 'p');
el('result-close', 'button');
el('stats');

const keydownListeners = [];
const fakeDocument = {
  getElementById: (id) => byId[id] || null,
  createElement: (tag) => new FakeElement(tag),
  addEventListener: (t, fn) => { if (t === 'keydown') keydownListeners.push(fn); },
  body: new FakeElement('body'),
};
Object.defineProperty(fakeDocument, 'activeElement', { get: () => activeElement });

const store = new Map();
const fakeLocalStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

globalThis.document = fakeDocument;
globalThis.localStorage = fakeLocalStorage;

// ---------------------------------------------------------------------------
// Start the real server
// ---------------------------------------------------------------------------

const server = spawn('node', ['server.mjs'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
let port = 0;
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('server did not start')), 10000);
  server.stdout.on('data', (d) => {
    const s = String(d);
    const m = s.match(/http:\/\/localhost:(\d+)/);
    if (m) { clearTimeout(t); port = Number(m[1]); resolve(); }
  });
  server.stderr.on('data', (d) => process.stderr.write(d));
});
console.log(`server on :${port}`);

const realFetch = globalThis.fetch;
const asJson = (obj) => ({ ok: true, json: async () => obj });
// Model-gate mock: the app must wait behind a loading overlay until the chat
// model reports ready. Flip mockModelState to 'loading' before entering
// versus mode to exercise the full gate.
let mockModelState = 'ready';
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u === '/api/tutor/status') return asJson({ ok: true, state: mockModelState });
  if (u === '/api/tutor/warmup') {
    setTimeout(() => { mockModelState = 'ready'; }, 300);
    return asJson({ ok: true, state: mockModelState });
  }
  if (u === '/api/banter') return asJson({ ok: true, text: 'Mock banter!' });
  if (u === '/api/tutor/ask') return asJson({ ok: true, text: 'Mock observation.' });
  if (u === '/api/ai-log') {
    return asJson({
      ok: true,
      entries: [{
        t: new Date().toISOString(),
        kind: 'tutor-question',
        input: 'what is a good starter?',
        thinking: 'canned thinking text',
        response: 'canned response',
        ms: 12,
      }],
    });
  }
  const p = u.startsWith('/') ? u : `/${u}`;
  return realFetch(`http://localhost:${port}${p}`, opts);
};

// ---------------------------------------------------------------------------
// Load the real app
// ---------------------------------------------------------------------------

await import('../app.js');
await pollFor(() => byId.keyboard.children.length > 0, 10000, 'keyboard build');
console.log('booted');

const keydown = (key) => { for (const fn of keydownListeners) fn({ key, preventDefault() {} }); };
const typeWord = (w) => { for (const ch of w) keydown(ch); };
const boardWord = (row = 0) => byId.board.children[row].children.map((t) => t.textContent).join('');
const tabButton = (m) => modeTabs.querySelectorAll('button').find((b) => b.dataset.mode === m);
const answers = readFileSync(path.join(root, 'words/answers.txt'), 'utf8').split('\n').filter(Boolean);
const modalOpen = () => !byId['result-modal'].classList.contains('hidden');

// 1. Classic: valid guess scores tiles + paints keyboard.
typeWord('crane');
keydown('Enter');
await pollFor(() => boardWord().toUpperCase() === 'CRANE', 5000, 'guess render');
check('classic guess renders on board', boardWord().toUpperCase() === 'CRANE');
const tileClass = byId.board.children[0].children[0].classList;
check('scored tile gets a color class',
  tileClass.contains('green') || tileClass.contains('yellow') || tileClass.contains('gray'));

// 2. Invalid word: toast, guess not consumed.
typeWord('xyzzy');
keydown('Enter');
await new Promise((r) => setTimeout(r, 100));
check('invalid word shows toast', !byId.toast.classList.contains('hidden'));
check('invalid word does not consume the guess', boardWord(1).toUpperCase() === 'XYZZY');

// 3. On-screen keyboard click works.
for (let i = 0; i < 5; i++) keydown('Backspace');
const keyA = byId.keyboard.querySelectorAll('.key').find((k) => k.dataset.key === 'a');
keyA.dispatch('click', {});
check('on-screen key types', boardWord(1) === 'a');
byId.keyboard.querySelectorAll('.key').find((k) => k.dataset.key === 'Backspace').dispatch('click', {});
check('on-screen backspace works', boardWord(1) === '');

// 3b. Classic word lifecycle: random word, retries keep it until won, win → new word.
// (If 'crane' above happened to be the answer, close the win modal for a fresh round.)
if (modalOpen()) byId['result-close'].click();
const classicStored = () => JSON.parse(fakeLocalStorage.getItem('wordle-vs-ai-classic'));
const firstWord = classicStored();
check('classic stores a random 5-letter word at round start',
  firstWord.answer.length === 5 && firstWord.won === false);
// Submit wrong words until the round is lost (stops the moment the modal opens,
// so Enter never lands on an open modal and dismisses it).
for (const w of answers.filter((w) => w !== firstWord.answer)) {
  if (modalOpen()) break;
  typeWord(w);
  keydown('Enter');
}
await pollFor(modalOpen, 10000, 'classic loss modal');
check('classic loss modal offers a same-word retry',
  byId['result-detail'].textContent.includes('retry the same word'));
byId['result-close'].click();
check('lost classic word is retried (same word kept)', classicStored().answer === firstWord.answer);
// Win it with the stored answer.
typeWord(firstWord.answer);
keydown('Enter');
await pollFor(modalOpen, 10000, 'classic win modal');
check('classic win modal shows', byId['result-title'].textContent.includes('You win'));
byId['result-close'].click();
const secondWord = classicStored();
check('a new random word is picked after a win',
  secondWord.answer !== firstWord.answer && secondWord.answer.length === 5);

// 4. Switch to Vs AI: the model gate shows a loading overlay until the model
//    reports ready, then the round starts.
mockModelState = 'loading';
tabButton('versus').click();
check('mode tab drops focus after click (Enter cannot re-trigger it)', tabButton('versus').blurCalled);
await pollFor(() => !byId['loading-overlay'].classList.contains('hidden'), 5000, 'loading overlay');
check('versus waits behind a "please wait" overlay while the model loads',
  byId['loading-message'].textContent.includes('loading the AI model'));
await pollFor(() => byId['loading-overlay'].classList.contains('hidden'), 15000, 'overlay dismiss');
check('versus shows bot panel after model ready', !byId['bot-panel'].classList.contains('hidden'));
check('versus AI log is always visible (not a dropdown)',
  byId['ai-log-list-versus'].parent.tagName === 'SECTION');
check('document mode flag set for CSS', fakeDocument.body.dataset.mode === 'versus');
await pollFor(() => byId['ai-status-versus'].textContent !== '', 10000, 'AI status pill');
check('AI status pill reports model state', /Chat AI (idle|loading…|ready|unavailable|unreachable)/.test(byId['ai-status-versus'].textContent));

// 5. Versus round: typing registers, bot thinking indicator shows, bot moves.
typeWord('treat');
keydown('Enter');
await new Promise((r) => setTimeout(r, 150));
check('bot thinking indicator visible during bot move', byId['bot-status'].textContent === 'Bot is thinking…');
await pollFor(() => byId['bot-board'].children[0].children[0].textContent !== '', 10000, 'bot move');
const botWord = byId['bot-board'].children[0].children.map((t) => t.textContent).join(''); // lowercase in DOM
check('medium bot opens CRANE', botWord.toUpperCase() === 'CRANE');
check('bot thinking indicator cleared after move', byId['bot-status'].textContent === '');
check('banter line rendered', byId.banter.textContent.includes('Mock banter!'));

// 6. Full versus round reaches a result (player burns 6 guesses).
const botGuesses = () => byId['bot-board'].children.filter((r) => r.children[0].textContent !== '').length;
let rounds = 0;
while (!modalOpen() && rounds < 6) {
  typeWord(answers[rounds]);
  keydown('Enter');
  rounds += 1;
  await pollFor(() => modalOpen() || botGuesses() >= rounds, 15000, 'round progress');
}
check('versus round reaches a result modal', !byId['result-modal'].classList.contains('hidden'));
byId['result-close'].click();
check('play again resets the round', byId['result-modal'].classList.contains('hidden'));

// 7. Tutor mode: welcome, question flow, wider chat flag, AI log panel.
tabButton('tutor').click();
check('tutor panel visible', !byId['tutor-panel'].classList.contains('hidden'));
check('tutor shows welcome message', byId['tutor-log'].children.length > 0);
check('document mode flag set for wide chat CSS', fakeDocument.body.dataset.mode === 'tutor');
tutorInput.value = 'what is a good starter?';
byId['tutor-form'].dispatch('submit', { preventDefault() {} });
await pollFor(() => byId['tutor-log'].innerHTML !== '' || byId['tutor-log'].children.some((c) => c.textContent === 'Mock observation.'), 10000, 'tutor reply');
const logTexts = byId['tutor-log'].children.map((c) => c.textContent);
check('player question echoed in chat', logTexts.includes('what is a good starter?'));
check('tutor reply shown in chat', logTexts.includes('Mock observation.'));

// 8. AI log panel renders user input + thinking + response.
byId['ai-log-refresh-tutor'].click();
await pollFor(() => byId['ai-log-list-tutor'].innerHTML.includes('canned thinking text'), 10000, 'ai log render');
const logHtml = byId['ai-log-list-tutor'].innerHTML;
check('AI log shows what the user typed', logHtml.includes('what is a good starter?'));
check('AI log shows the model thinking', logHtml.includes('model thinking'));
check('AI log shows the AI response', logHtml.includes('canned response'));

// 9. Real API routes respond.
const statusRes = await realFetch(`http://localhost:${port}/api/tutor/status`).then((r) => r.json());
check('real /api/tutor/status works', statusRes.ok === true && typeof statusRes.state === 'string');
const logRes = await realFetch(`http://localhost:${port}/api/ai-log`).then((r) => r.json());
check('real /api/ai-log works', logRes.ok === true && Array.isArray(logRes.entries));

console.log(`\n${passed} smoke checks passed${process.exitCode ? ' (with failures)' : ''}.`);
server.kill();
process.exit(process.exitCode || 0);
