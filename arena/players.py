"""LLM chess player — picks one legal UCI move and explains why."""

from __future__ import annotations

import json
import os
import re
from typing import Any

import chess
from openai import OpenAI

from arena.boardutil import board_ascii, legal_uci


def _parse_json(text: str) -> dict[str, Any]:
    """Parse model JSON, tolerating accidental prose around the object."""
    text = text.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, flags=re.DOTALL)
        if not match:
            raise ValueError(f"no JSON in model output: {text[:200]}")
        return json.loads(match.group(0))


class ChessPlayer:
    """One side of the board, backed by a chat-completions model."""

    def __init__(self, name: str, model: str, client: OpenAI | None = None):
        self.name = name
        self.model = model
        self.client = client or OpenAI(api_key=os.environ["OPENAI_API_KEY"])

    def choose_move(self, board: chess.Board) -> dict[str, Any]:
        """
        Ask the model for {"move": "<uci>", "reasoning": "..."}.

        The legal-move list is included so the model stays on-book when possible;
        legality is still enforced server-side before the move is applied.
        """
        color = "White" if board.turn == chess.WHITE else "Black"
        legal = legal_uci(board)
        prompt = "\n".join(
            [
                f"You are {self.name}, playing {color} in chess.",
                "Board (ASCII, white at bottom):",
                board_ascii(board),
                f"FEN: {board.fen()}",
                f"Legal moves (UCI): {', '.join(legal[:80])}{'...' if len(legal) > 80 else ''}",
                "",
                "Pick ONE legal move. Explain your reasoning clearly.",
                'Return ONLY JSON: {"move":"e2e4","reasoning":"..."}',
            ]
        )
        resp = self.client.chat.completions.create(
            model=self.model,
            temperature=0.3,
            messages=[
                {
                    "role": "system",
                    "content": "You are a chess player. Always reply with valid JSON only.",
                },
                {"role": "user", "content": prompt},
            ],
        )
        raw = resp.choices[0].message.content or ""
        data = _parse_json(raw)
        return {
            "move": str(data.get("move", "")).strip(),
            "reasoning": str(data.get("reasoning", "")).strip(),
            "raw": raw,
            "model": self.model,
            "name": self.name,
            "color": color,
        }
