"""
HTTP server for Chess Agents Simulation.

Serves the board UI and streams match events over Server-Sent Events (SSE)
so the frontend can update the board, chart, and history in real time.
"""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, Query
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from arena.match import MatchConfig, run_match

# Load secrets from repo-root .env (never commit this file).
load_dotenv(Path(__file__).resolve().parents[1] / ".env")

STATIC = Path(__file__).resolve().parent / "static"
app = FastAPI(title="Chess Agents Simulation")
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/")
def index() -> FileResponse:
    """SPA shell — disable caching so UI tweaks show up after refresh."""
    return FileResponse(
        STATIC / "index.html",
        headers={"Cache-Control": "no-store"},
    )


@app.get("/api/models")
def models() -> dict:
    """Model dropdown options (+ optional extras via CHESS_MODELS)."""
    defaults = ["gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini", "gpt-4o"]
    extra = [m.strip() for m in os.environ.get("CHESS_MODELS", "").split(",") if m.strip()]
    return {
        "models": list(dict.fromkeys([*defaults, *extra])),
        "judge": os.environ.get("JUDGE_MODEL", "gpt-4.1-mini"),
    }


def _next_event(it):
    """Pull one event from the sync match generator (run in a worker thread)."""
    try:
        return next(it)
    except StopIteration:
        return None


@app.get("/api/match")
async def api_match(
    white: str = Query("gpt-4.1-mini"),
    black: str = Query("gpt-4o-mini"),
    judge: str = Query("gpt-4.1-mini"),
    max_plies: int = Query(40, ge=2, le=200),
):
    """
    Stream a full match as SSE (`data: {...}\\n\\n` frames).

    Event kinds: start, thinking, move_proposed, judging, turn, end, error.
    """
    cfg = MatchConfig(
        white_model=white,
        black_model=black,
        judge_model=judge,
        max_plies=max_plies,
    )

    async def gen():
        it = run_match(cfg)
        while True:
            try:
                # Match / OpenAI calls are blocking — keep the event loop free.
                event = await asyncio.to_thread(_next_event, it)
            except Exception as exc:
                yield f"data: {json.dumps({'kind': 'error', 'message': str(exc)})}\n\n"
                break
            if event is None:
                break
            yield f"data: {json.dumps(event, default=str)}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")


def main() -> None:
    import uvicorn

    uvicorn.run("arena.server:app", host="127.0.0.1", port=8765, reload=False)


if __name__ == "__main__":
    main()
