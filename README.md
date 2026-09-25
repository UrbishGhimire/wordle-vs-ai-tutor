# 🎯 Wordle vs AI Tutor

On-device Wordle — daily solo, player-vs-AI battles, and a grounded AI tutor that coaches you through the board. All AI runs **fully on your machine** with the [QVAC SDK](https://github.com/tetherto/qvac) — no cloud, no API keys, no account.

## 🎮 Modes

| Mode | What it is |
|---|---|
| 🧩 **Classic** | Daily solo Wordle. Random word, stats saved locally. A lost game keeps the same word on "Play again" until you win it. |
| ⚔️ **Versus** | You and a deterministic JS bot race the **same** word. You go first. Fewest guesses wins. The bot is pure logic — **never an LLM**. |
| 🧠 **Tutor** | Solo game (daily or random) with an on-device QVAC tutor watching your guesses. Ask strategy questions, get grounded answers from the strategy guide. The tutor **never knows the answer**. |

Every mode is keyboard-driven, with tile flips, colour feedback, and a running board summary.

## 🧠 Tech

- **QVAC SDK** `^0.19.1` (declared in `package.json`)
- **QVAC functions used:**
  - `loadModel` — loads the tutor model into memory
  - `completion` — answers tutor questions and fires opponent banter during versus matches
  - `unloadModel` — frees the model when you leave tutor mode, so RAM stays free
- **Model:** `QWEN3_600M_INST_Q4` — ~400 MB, loaded lazily on first tutor/banter request
- **Runtime:** Node.js 18+
- Zero runtime dependencies besides `@qvac/sdk` — plain `node:http` server, vanilla JS UI
- SDK calls live **server-side** through two small local routes (`/api/tutor/*`, `/api/banter`), so the browser UI stays dependency-free
- The tutor is grounded in `strategy-guide.md`; its prompt has **no parameter for the secret word**, and the system prompt forbids stating or guessing it
- A 30-second timeout races every model call, so a slow first-time model download never hangs the game — the UI shows a graceful fallback instead
- An AI activity log records every interaction in memory (last 200) and appends to `ai-log.jsonl` for inspection

## 🚀 Run it

Requires **Node.js 18+** and **git**.

```bash
git clone https://github.com/UrbishGhimire/wordle-vs-ai-tutor.git
cd wordle-vs-ai-tutor
npm install
npm start
```

Then open 👉 **http://localhost:8094** (the server falls back to 8095, 8096, … if the port is busy).

Keep the terminal open while you play — press `Ctrl+C` to stop the server. 🛑

> 💡 **First tutor request downloads the model** (~400 MB, one time). After that it's cached locally and loads from disk.

## 🧪 Tests

```bash
npm test
```

- **63 unit tests** covering the game logic, the deterministic solver, prompt building, guide selection, and reply sanitisation
- **Headless UI smoke script** in `scripts/` that drives the interface without a browser
- SDK-mocked tests enforce the exact call shapes from `@qvac/sdk` — `loadModel({ modelSrc: CONSTANT })`, `completion({ modelId, history, stream })`, `unloadModel({ modelId })`

## 📁 Project layout

```
wordle-vs-ai-tutor/
├── app.js                 # Browser UI — three modes, boards, keyboard, tutor chat
├── server.mjs             # node:http static server + QVAC API routes
├── wordle.js              # Game logic, scoring, daily/random word selection
├── solver.js              # Deterministic bot (versus mode) — never an LLM
├── tutor.js               # Prompt building + QVAC model lifecycle
├── strategy-guide.md      # Grounding document for the tutor
├── index.html             # UI shell
├── style.css              # Styling
├── words/
│   ├── answers.txt        # 2,204 answer words
│   └── valid-guesses.txt  # 15,921 valid guesses
├── scripts/               # Word-list builder + headless UI smoke script
└── tests/                 # Unit tests
```

## 🔒 Privacy

No accounts, no tracking, no uploads. Word lists ship with the repo; the model is downloaded once and cached on your machine. Game stats live in `localStorage` — clear them any time. 🧹

## 📄 License

MIT — see [LICENSE](LICENSE).
