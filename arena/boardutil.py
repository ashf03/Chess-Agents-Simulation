"""Thin wrappers around python-chess for board setup, legality, and material."""

from __future__ import annotations

import chess


def new_board() -> chess.Board:
    """Standard starting position."""
    return chess.Board()


def board_ascii(board: chess.Board) -> str:
    """Human-readable board dump (fed into LLM prompts)."""
    return str(board)


def legal_uci(board: chess.Board) -> list[str]:
    """All legal moves as UCI strings (e.g. e2e4, e7e8q)."""
    return [m.uci() for m in board.legal_moves]


def try_push_uci(board: chess.Board, uci: str) -> tuple[bool, str]:
    """
    Apply a UCI move if legal.

    Returns (ok, message). On failure the board is left unchanged.
    """
    try:
        move = chess.Move.from_uci(uci.strip())
    except ValueError:
        return False, f"invalid UCI: {uci}"
    if move not in board.legal_moves:
        return False, f"illegal move: {uci}"
    board.push(move)
    return True, "ok"


def material_score(board: chess.Board) -> float:
    """Simple white-minus-black material in pawn units (kings ignored)."""
    values = {
        chess.PAWN: 1,
        chess.KNIGHT: 3,
        chess.BISHOP: 3,
        chess.ROOK: 5,
        chess.QUEEN: 9,
        chess.KING: 0,
    }
    total = 0.0
    for piece_type, val in values.items():
        total += val * len(board.pieces(piece_type, chess.WHITE))
        total -= val * len(board.pieces(piece_type, chess.BLACK))
    return total
