# Chess Agents Simulation

Two language models play chess against each other. A third model judges every move and the player's reasoning. A live UI streams the board, scores, and history as the match runs.

```
┌─────────────────┬──────────────────┬────────────────────┐
│ Controls        │  Chess board     │ Quality chart      │
│ Status          │                  │ Judge / live turn  │
│ History         │                  │                    │
└─────────────────┴──────────────────┴────────────────────┘
```

## Requirements

- Python **3.11+**
- An **OpenAI API key**

## Setup

```bash
# Create and activate a virtualenv (Homebrew Python needs this)
python3 -m venv .venv
source .venv/bin/activate

# Install the package
pip install -e .

# Optional: tests
pip install -e ".[dev]"
pytest
```

Copy `.env.example` to `.env` and set your key (`.env` is gitignored):

```bash
cp .env.example .env
# edit .env — set OPENAI_API_KEY=sk-...
# optional:
# JUDGE_MODEL=gpt-4.1-mini
# CHESS_MODELS=gpt-4.1,o4-mini
```

Never commit `.env` or paste keys into the repo.

## Run

```bash
source .venv/bin/activate
python -m arena.server
```

Open **http://127.0.0.1:8765**

Pick White / Black / Judge models, set **Max plies** (half-moves; default 40), then **Start match**. While a match is running, **End match** appears instead.

## How it works

1. **Players** (`arena/players.py`) — each side is prompted with FEN, ASCII board, and legal UCI moves; they return JSON `{move, reasoning}`.
2. **Board** (`arena/boardutil.py`) — only legal UCI moves are applied via `python-chess`. Illegal moves lose the game immediately.
3. **Judge** (`arena/judge.py`) — scores move quality and reasoning (0–10) plus a short critique.
4. **Match loop** (`arena/match.py`) — yields events until checkmate, draw, illegal move, or max plies.
5. **Server** (`arena/server.py`) — FastAPI + SSE (`/api/match`) streams those events to the UI.
6. **UI** (`arena/static/`) — updates the board, chart, history, and judge panel live.

### SSE event kinds

| Kind | Meaning |
|------|---------|
| `start` | Match begun |
| `thinking` | Side is calling the model |
| `move_proposed` | Move + reasoning received |
| `judging` | Judge is scoring |
| `turn` | Ply finished (scores available) |
| `end` | Match over |
| `error` | Failure (missing key, API error, …) |

## Project layout

```
Chess-Agents-Simulation/
├── arena/
│   ├── server.py      # FastAPI + SSE
│   ├── match.py       # Match orchestration
│   ├── players.py     # LLM chess players
│   ├── judge.py       # LLM move judge
│   ├── boardutil.py   # python-chess helpers
│   └── static/        # UI (HTML / CSS / JS + piece SVGs)
├── tests/
├── .env               # local secrets (gitignored)
├── pyproject.toml
└── README.md
```

## Notes

- **Max plies** is a ceiling, not a minimum. Real checkmate / stalemate / illegal moves end the game earlier.
- Kings are never captured; checkmate ends the game through `python-chess`.
- Piece art uses the Cburnett SVG set (same family as Lichess).
