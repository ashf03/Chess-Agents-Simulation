"""LLM move judge — scores chess quality and reasoning quality (0–10)."""

from __future__ import annotations

import json
import os
import re
from typing import Any

import chess
from openai import OpenAI

from arena.boardutil import board_ascii, material_score


def _parse_json(text: str) -> dict[str, Any]:
    """Parse judge JSON, tolerating accidental prose around the object."""
    text = text.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, flags=re.DOTALL)
        if not match:
            raise ValueError(f"no JSON in judge output: {text[:200]}")
        return json.loads(match.group(0))


class MoveJudge:
    """
    Hard-fail illegal moves; otherwise ask an LLM for qualitative scores.

    Returns move_score, reasoning_score, verdict, critique, logic_flags, etc.
    """

    def __init__(self, model: str | None = None, client: OpenAI | None = None):
        self.model = model or os.environ.get("JUDGE_MODEL", "gpt-4.1-mini")
        self.client = client or OpenAI(api_key=os.environ["OPENAI_API_KEY"])

    def judge(
        self,
        board_before: chess.Board,
        board_after: chess.Board | None,
        uci: str,
        reasoning: str,
        player_name: str,
        legal: bool,
        legal_error: str = "",
    ) -> dict[str, Any]:
        # Illegal moves never get a soft LLM pass — score zero and stop.
        if not legal:
            return {
                "legal": False,
                "move_score": 0,
                "reasoning_score": 0,
                "verdict": "WRONG",
                "critique": f"Illegal or invalid move ({legal_error}). Reasoning cannot salvage an illegal move.",
                "logic_flags": ["illegal_move"],
                "material_delta": 0.0,
            }

        before_mat = material_score(board_before)
        after_mat = material_score(board_after) if board_after else before_mat
        # board_before.turn is the mover (push has not happened on this copy).
        mover_is_white = board_before.turn == chess.WHITE
        delta = after_mat - before_mat
        material_delta_for_mover = delta if mover_is_white else -delta

        prompt = "\n".join(
            [
                "You are a strict chess coach judging a player's move AND their reasoning.",
                f"Player: {player_name}",
                "Position BEFORE move:",
                board_ascii(board_before),
                f"FEN: {board_before.fen()}",
                f"Move played (UCI): {uci}",
                f"Player reasoning:\n{reasoning}",
                f"Material change for mover (pawn units, simple): {material_delta_for_mover:+.1f}",
                "",
                "Score:",
                "- move_score 0-10 (chess quality: blunder=0-2, ok=5-6, strong=8-10)",
                "- reasoning_score 0-10 (logic quality: vague/wrong claims=low, concrete correct ideas=high)",
                "- verdict: RIGHT | DOUBTFUL | WRONG (WRONG if blunder or reasoning contradicts the board)",
                "- critique: short, specific",
                "- logic_flags: array of tags like hallucinated_piece, ignores_check, good_plan, tactics, vague",
                "",
                "Return ONLY JSON:",
                '{"move_score":7,"reasoning_score":6,"verdict":"RIGHT","critique":"...","logic_flags":["good_plan"]}',
            ]
        )
        resp = self.client.chat.completions.create(
            model=self.model,
            temperature=0,
            messages=[
                {
                    "role": "system",
                    "content": "You judge chess moves and reasoning. JSON only.",
                },
                {"role": "user", "content": prompt},
            ],
        )
        raw = resp.choices[0].message.content or ""
        data = _parse_json(raw)
        return {
            "legal": True,
            "move_score": float(data.get("move_score", 0)),
            "reasoning_score": float(data.get("reasoning_score", 0)),
            "verdict": str(data.get("verdict", "DOUBTFUL")).upper(),
            "critique": str(data.get("critique", "")),
            "logic_flags": list(data.get("logic_flags") or []),
            "material_delta": material_delta_for_mover,
            "raw": raw,
            "judge_model": self.model,
        }
