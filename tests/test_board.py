"""Board helper smoke tests (no API calls)."""

from arena.boardutil import material_score, new_board, try_push_uci


def test_legal_and_illegal_moves():
    board = new_board()
    ok, _ = try_push_uci(board, "e2e4")
    assert ok
    # Same pawn cannot move twice from e2 after e2e4.
    ok, err = try_push_uci(board, "e2e4")
    assert not ok
    assert "illegal" in err or "invalid" in err


def test_material_start_is_zero():
    assert material_score(new_board()) == 0
