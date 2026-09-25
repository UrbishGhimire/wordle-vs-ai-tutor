/**
 * server.mjs — local web server for Wordle vs AI.
 *
 * - Static file server (node:http only, no framework). Default port 8094;
 *   falls back to 8095, 8096, ... if occupied.
 * - node_modules is NEVER served (the browser needs no npm packages).
 * - QVAC SDK calls happen server-side through two small local API routes
 *   (/api/tutor/*, /api/banter) so the browser UI stays dependency-free.
 *
 * Usage: npm start
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORTS = [8094, 8095, 8096, 8097, 8098, 8099];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// Only these paths may be served. Everything else -> 404.
const ALLOWED = new Set([
  '/',
  '/index.html',
  '/app.js',
  '/style.css',
  '/wordle.js',
  '/solver.js',
  '/tutor.js',
  '/strategy-guide.md',
  '/words/answers.txt',
  '/words/valid-guesses.txt',
]);

function isAllowedPath(urlPath) {
  return ALLOWED.has(urlPath);
}

function send(res, status, contentType, body) {
  res.writeHead(status, { 'content-type': contentType });
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(obj));
}

// ---------------------------------------------------------------------------
// Tutor / banter API (server-side QVAC). The SDK is required lazily so the
// static game works even on machines without the QVAC package installed.
// ---------------------------------------------------------------------------

let sdkPromise = null;
let tutorModelId = null;
let tutorModelLoading = null;
// idle: never requested. loading: download/load in progress. ready: loaded.
// failed: the last load attempt errored (a later request may retry).
let tutorModelState = 'idle';
let tutorModelError = '';
// Serializes unloads against loads: a banter/tutor call must never grab a
// model id that an unload is about to invalidate (that surfaced as
// "Model with ID ... not found" when switching modes quickly).
let unloadChain = Promise.resolve();

/** Drop a cached model id that the SDK no longer recognizes. */
function invalidateModelId(message) {
  if (/not found/i.test(String(message || ''))) {
    tutorModelId = null;
    tutorModelLoading = null;
    tutorModelState = 'idle';
  }
}

// ---------------------------------------------------------------------------
// AI activity log — records every model interaction: what the user typed,
// the model's raw thinking, and the final reply shown in the UI.
// Kept in memory (last 200) and appended to ai-log.jsonl for inspection.
// ---------------------------------------------------------------------------

const AI_LOG_MAX = 200;
const aiLog = [];

function logAi(entry) {
  const record = { t: new Date().toISOString(), ...entry };
  aiLog.push(record);
  if (aiLog.length > AI_LOG_MAX) aiLog.splice(0, aiLog.length - AI_LOG_MAX);
  // Best-effort file log; never let logging break a request.
  import('node:fs/promises')
    .then((fs) => fs.appendFile(path.join(ROOT, 'ai-log.jsonl'), JSON.stringify(record) + '\n'))
    .catch(() => {});
  return record;
}

// The QVAC model registry can be very slow (or unreachable) on some
// networks; loadModel may hang for many minutes instead of failing. Tutor
// and banter must never hang an HTTP request — race the work against a
// timeout so the UI gets its graceful fallback fast. The underlying load
// keeps running in the background, so a later request can still succeed
// once the model is cached.
const TUTOR_TIMEOUT_MS = 30000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withTutorTimeout(work) {
  let finished = false;
  const timer = sleep(TUTOR_TIMEOUT_MS).then(() => {
    if (!finished) {
      throw new Error('tutor timed out — the model may still be downloading');
    }
  });
  // Swallow the timer's late throw when the work finished first.
  timer.catch(() => {});
  try {
    return await Promise.race([work, timer]);
  } finally {
    finished = true;
  }
}

async function getSdk() {
  if (!sdkPromise) {
    sdkPromise = import('@qvac/sdk').catch((err) => {
      sdkPromise = null;
      throw err;
    });
  }
  return sdkPromise;
}

async function getTutorModelId() {
  // Wait out any in-flight unload first: the cached id is unusable after it.
  await unloadChain.catch(() => {});
  if (tutorModelId) return tutorModelId;
  if (!tutorModelLoading) {
    tutorModelState = 'loading';
    tutorModelLoading = (async () => {
      const sdk = await getSdk();
      const { loadTutorModel, TUTOR_MODEL_SRC } = await import('./tutor.js');
      const constant = sdk[TUTOR_MODEL_SRC];
      if (!constant) {
        throw new Error(`QVAC SDK does not export ${TUTOR_MODEL_SRC}`);
      }
      const id = await loadTutorModel(sdk);
      tutorModelId = id;
      tutorModelState = 'ready';
      return id;
    })().catch((err) => {
      tutorModelState = 'failed';
      tutorModelError = String(err && err.message ? err.message : err);
      throw err;
    }).finally(() => {
      tutorModelLoading = null;
    });
  }
  return tutorModelLoading;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 200_000) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

async function handleApi(req, res, urlPath) {
  try {
    if (req.method === 'POST' && urlPath === '/api/tutor/ask') {
      const body = await readJsonBody(req);
      const started = Date.now();
      const kind = body.observationMode === true ? 'tutor-observation' : 'tutor-question';
      const result = await withTutorTimeout((async () => {
        const sdk = await getSdk();
        const modelId = await getTutorModelId();
        const { buildTutorPrompt, askTutor } = await import('./tutor.js');
        const prompt = buildTutorPrompt({
          question: body.question ?? null,
          boardSummary: body.boardSummary ?? '',
          guideExcerpt: body.guideExcerpt ?? '',
          observationMode: body.observationMode === true,
          recentNotes: Array.isArray(body.recentNotes) ? body.recentNotes : [],
        });
        return askTutor(sdk, modelId, prompt);
      })());
      logAi({
        kind,
        input: body.observationMode === true ? '(proactive observation)' : String(body.question ?? ''),
        thinking: result.thinking,
        response: result.text,
        ms: Date.now() - started,
      });
      sendJson(res, 200, { ok: true, text: result.text });
      return;
    }

    if (req.method === 'GET' && urlPath === '/api/tutor/status') {
      sendJson(res, 200, { ok: true, state: tutorModelState, error: tutorModelError || undefined });
      return;
    }

    if (req.method === 'GET' && urlPath === '/api/ai-log') {
      sendJson(res, 200, { ok: true, entries: aiLog.slice(-100) });
      return;
    }

    if (req.method === 'POST' && urlPath === '/api/tutor/warmup') {
      // Kick off the model load in the background and return immediately.
      // The client polls /api/tutor/status until it flips to ready/failed.
      getTutorModelId().catch(() => {});
      sendJson(res, 200, { ok: true, state: tutorModelState });
      return;
    }

    if (req.method === 'POST' && urlPath === '/api/tutor/unload') {
      // Run the unload through the chain and WAIT for it here, so the next
      // getTutorModelId() can never observe a half-unloaded model. The
      // client also awaits this response before switching modes.
      unloadChain = unloadChain.then(async () => {
        if (tutorModelId) {
          try {
            const sdk = await getSdk();
            const { unloadTutorModel } = await import('./tutor.js');
            await unloadTutorModel(sdk, tutorModelId);
          } finally {
            tutorModelId = null;
            tutorModelLoading = null;
            tutorModelState = 'idle';
            tutorModelError = '';
          }
        }
      });
      await unloadChain.catch(() => {});
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && urlPath === '/api/banter') {
      const body = await readJsonBody(req);
      const started = Date.now();
      const moment = body.moment || 'game start';
      const result = await withTutorTimeout((async () => {
        const sdk = await getSdk();
        const modelId = await getTutorModelId();
        const { sanitizeReply, splitThinking, NO_THINK_PREFIX } = await import('./tutor.js');
        const run = sdk.completion({
          modelId,
          history: [
            {
              role: 'system',
              content:
                'You are a playful Wordle rival bot. Reply with ONE short taunt or ' +
                'comment, at most 15 words. Never reveal any word. Output ONLY the ' +
                'taunt — never show your thinking, reasoning, or <think> blocks.',
            },
            {
              role: 'user',
              content: NO_THINK_PREFIX + `Write a one-line comment for this moment: ${moment}.`,
            },
          ],
          stream: false,
        });
        const final = await run.final;
        const raw = final && typeof final.contentText === 'string' ? final.contentText.trim() : '';
        return { text: sanitizeReply(raw), thinking: splitThinking(raw).thinking, raw };
      })());
      logAi({
        kind: 'banter',
        input: `(moment: ${moment})`,
        thinking: result.thinking,
        response: result.text,
        ms: Date.now() - started,
      });
      sendJson(res, 200, { ok: true, text: result.text });
      return;
    }

    sendJson(res, 404, { ok: false, error: 'unknown API route' });
  } catch (err) {
    // Banter/tutor failures are non-fatal by design: the game never depends
    // on the model. Return ok:false so the UI can skip silently.
    const message = String(err && err.message ? err.message : err);
    if (urlPath === '/api/tutor/ask' || urlPath === '/api/banter') {
      // A stale cached id (e.g. unloaded between load and completion) must
      // not poison every later call — force a fresh load next time.
      invalidateModelId(message);
      logAi({ kind: 'error', input: urlPath, thinking: '', response: `failed: ${message}`, ms: 0 });
    }
    sendJson(res, 200, { ok: false, error: message });
  }
}

// ---------------------------------------------------------------------------
// Static serving
// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  const urlPath = new URL(req.url, 'http://localhost').pathname;

  if (urlPath.startsWith('/api/')) {
    await handleApi(req, res, urlPath);
    return;
  }

  if (!isAllowedPath(urlPath)) {
    send(res, 404, 'text/plain; charset=utf-8', 'Not found');
    return;
  }

  const filePath = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath.slice(1));
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    send(res, 200, MIME[ext] || 'application/octet-stream', body);
  } catch {
    send(res, 404, 'text/plain; charset=utf-8', 'Not found');
  }
});

function listenOn(portIndex) {
  if (portIndex >= PORTS.length) {
    console.error('No free port among', PORTS.join(', '));
    process.exit(1);
  }
  const port = PORTS[portIndex];
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`Port ${port} in use, trying next…`);
      server.removeAllListeners('error');
      listenOn(portIndex + 1);
    } else {
      throw err;
    }
  });
  server.listen(port, () => {
    console.log(`Wordle vs AI running at http://localhost:${port}`);
  });
}

listenOn(0);
