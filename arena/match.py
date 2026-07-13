"""
Match orchestration: two ChessPlayers take turns, a MoveJudge scores each ply.

`run_match` is a generator that yields UI events as the game progresses.
"""

from __future__ import annotations

import time
from collections.abc import Iterator
from dataclasses import asdict, dataclass, field
from typing import Any

import chess

from arena.boardutil import board_ascii, material_score, new_board, try_push_uci
from arena.judge import MoveJudge
from arena.players import ChessPlayer


@dataclass
class MatchConfig:
    """Who plays, who judges, and the ply ceiling."""

    white_model: str = "gpt-4.1-mini"
    black_model: str = "gpt-4o-mini"
    judge_model: str = "gpt-4.1-mini"
    max_plies: int = 40


@dataclass
class MatchState:
    """Mutable match snapshot mirrored to the frontend after every event."""

    ply: int = 0
    fen: str = ""
    ascii: str = ""
    over: bool = False
    result: str = "*"
    history: list[dict[str, Any]] = field(default_factory=list)
    series: dict[str, list[float]] = field(
        default_factory=lambda: {
            "white_move": [],
            "white_reason": [],
            "black_move": [],
            "black_reason": [],
        }
    )


def run_match(cfg: MatchConfig) -> Iterator[dict[str, Any]]:
    """
    Play until checkmate / draw / illegal move / max plies.

    Yields dict events consumed by `/api/match` (SSE).
    """
    board = new_board()
    white = ChessPlayer("White", cfg.white_model)
    black = ChessPlayer("Black", cfg.black_model)
    judge = MoveJudge(cfg.judge_model)
    state = MatchState(fen=board.fen(), ascii=board_ascii(board))

    yield {"kind": "start", "config": asdict(cfg), "state": _public(state, board)}

    while not board.is_game_over() and state.ply < cfg.max_plies:
        player = white if board.turn == chess.WHITE else black
        side = "white" if board.turn == chess.WHITE else "black"

        yield {
            "kind": "thinking",
            "side": side,
            "model": player.model,
            "state": _public(state, board),
        }

        # --- Player chooses a UCI move + reasoning ---
        t0 = time.perf_counter()
        choice = player.choose_move(board)
        think_s = time.perf_counter() - t0

        yield {
            "kind": "move_proposed",
            "side": side,
            "choice": choice,
            "think_s": think_s,
            "state": _public(state, board),
        }

        before = board.copy(stack=False)
        ok, err = try_push_uci(board, choice["move"])
        after = board.copy(stack=False) if ok else None

        yield {
            "kind": "judging",
            "side": side,
            "move": choice["move"],
            "state": _public(state, board if ok else before),
        }

        # --- Judge scores move quality + reasoning quality ---
        t1 = time.perf_counter()
        verdict = judge.judge(
            board_before=before,
            board_after=after,
            uci=choice["move"],
            reasoning=choice.get("reasoning", ""),
            player_name=f"{player.name}/{player.model}",
            legal=ok,
            legal_error=err,
        )
        judge_s = time.perf_counter() - t1

        if not ok:
            # Illegal UCI → instant loss for the side that moved.
            state.over = True
            state.result = "0-1" if side == "white" else "1-0"
            row = {
                "ply": state.ply + 1,
                "side": side,
                "model": player.model,
                "move": choice["move"],
                "reasoning": choice.get("reasoning", ""),
                "think_s": think_s,
                "judge_s": judge_s,
                "verdict": verdict,
                "illegal": True,
                "fen": before.fen(),  # board unchanged on illegal move
            }
            state.history.append(row)
            _push_series(state, side, verdict)
            yield {"kind": "turn", "row": row, "state": _public(state, before)}
            yield {"kind": "end", "reason": "illegal_move", "state": _public(state, before)}
            return

        state.ply += 1
        state.fen = board.fen()
        state.ascii = board_ascii(board)
        row = {
            "ply": state.ply,
            "side": side,
            "model": player.model,
            "move": choice["move"],
            "reasoning": choice.get("reasoning", ""),
            "think_s": think_s,
            "judge_s": judge_s,
            "verdict": verdict,
            "illegal": False,
            "material": material_score(board),
            "fen": board.fen(),  # position after this ply (for post-game scrubbing)
        }
        state.history.append(row)
        _push_series(state, side, verdict)

        yield {"kind": "turn", "row": row, "state": _public(state, board)}

        if board.is_game_over():
            state.over = True
            state.result = board.result(claim_draw=True)
            yield {"kind": "end", "reason": "game_over", "state": _public(state, board)}
            return

    # Hit ply ceiling without a terminal position.
    state.over = True
    state.result = board.result(claim_draw=True) if board.is_game_over() else "1/2-1/2 (max plies)"
    yield {"kind": "end", "reason": "max_plies", "state": _public(state, board)}


def _push_series(state: MatchState, side: str, verdict: dict[str, Any]) -> None:
    """Append chart points for the side that just moved."""
    if side == "white":
        state.series["white_move"].append(float(verdict.get("move_score", 0)))
        state.series["white_reason"].append(float(verdict.get("reasoning_score", 0)))
    else:
        state.series["black_move"].append(float(verdict.get("move_score", 0)))
        state.series["black_reason"].append(float(verdict.get("reasoning_score", 0)))


def _public(state: MatchState, board: chess.Board) -> dict[str, Any]:
    """JSON-safe state payload for the browser."""
    return {
        "ply": state.ply,
        "fen": board.fen(),
        "ascii": board_ascii(board),
        "over": state.over,
        "result": state.result,
        "turn": "white" if board.turn == chess.WHITE else "black",
        "history": state.history,
        "series": state.series,
    }
