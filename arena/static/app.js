/**
 * Chess Agents Simulation — frontend
 *
 * Layout: left controls + history | center board | right chart + judge panel
 * Match stream: EventSource → /api/match (SSE)
 */

/* ── DOM refs ─────────────────────────────────────────── */
const whiteSel = document.getElementById("white");
const blackSel = document.getElementById("black");
const judgeSel = document.getElementById("judge");
const pliesInput = document.getElementById("plies");
const startBtn = document.getElementById("start");
const endBtn = document.getElementById("end");
const statusEl = document.getElementById("status");
const boardEl = document.getElementById("board");
const historyEl = document.getElementById("history");
const judgeOut = document.getElementById("judge-out");

/** FEN piece letter → SVG asset under /static/pieces/ */
const PIECE_FILES = {
  K: "wK.svg", Q: "wQ.svg", R: "wR.svg", B: "wB.svg", N: "wN.svg", P: "wP.svg",
  k: "bK.svg", q: "bQ.svg", r: "bR.svg", b: "bB.svg", n: "bN.svg", p: "bP.svg",
};

let qualityChart;
let es;                 // active EventSource (null when idle)
let turnDetails = [];   // history rows aligned with chart x-axis
let hoverPinned = false; // true while mouse is over a chart point
let matchOver = false;   // scrubbing the board via chart is only allowed after the game ends
let reviewingPly = null; // index into turnDetails while scrubbing (null = live/latest)

/* ── Match controls ───────────────────────────────────── */

function setStatus(t) {
  statusEl.textContent = t;
}

/** Toggle Start ↔ End and lock model selectors during play. */
function setMatchRunning(running) {
  startBtn.hidden = running;
  endBtn.hidden = !running;
  whiteSel.disabled = running;
  blackSel.disabled = running;
  judgeSel.disabled = running;
  pliesInput.disabled = running;
  if (running) {
    matchOver = false;
    reviewingPly = null;
  }
  updateChartHint();
}

function updateChartHint() {
  const hint = document.querySelector(".chart-hint");
  if (!hint) return;
  hint.textContent = matchOver
    ? "Click a point to jump the board to that ply"
    : "Hover a point to inspect that turn";
  const canvas = document.getElementById("chart-quality");
  if (canvas) canvas.style.cursor = matchOver ? "pointer" : "default";
}

/** After the match ends, click a chart point to show that board position. */
function seekToHistoryIndex(index) {
  if (!matchOver) return;
  const h = turnDetails[index];
  if (!h?.fen) return;
  reviewingPly = index;
  showJudge(h);
  // Snap (no slide) so scrubbing feels instant.
  displayedFen = null;
  snapBoard(h.fen);
  if (!h.illegal) highlightMove(h.move);
  else clearHighlights();
  setStatus(`reviewing ply ${h.ply} · ${h.side} ${h.move}`);
}

/* ── Board rendering (animated pieces + last-move glow) ─ */

let squaresEls = [];
let piecesLayer = null;
let pieceBySq = new Map(); // 0–63 → <img>
let displayedFen = null;
let moveAnimToken = 0;
let boardAnimating = false;

function sqIndex(file, rank) {
  return rank * 8 + file;
}

/** Algebraic like "e4" → board coords (rank 0 = black's back rank / FEN top). */
function parseAlg(alg) {
  const file = alg.charCodeAt(0) - 97;
  const rank = 8 - Number(alg[1]);
  return { file, rank, index: sqIndex(file, rank) };
}

function fenPlacementMap(fen) {
  const map = new Map();
  const placement = (fen || "").split(" ")[0] || "8/8/8/8/8/8/8/8";
  placement.split("/").forEach((row, r) => {
    let file = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) {
        file += Number(ch);
      } else {
        map.set(sqIndex(file, r), ch);
        file += 1;
      }
    }
  });
  return map;
}

/** Piece position via CSS vars — translate % is relative to the piece (one square). */
function setPieceSquare(el, file, rank, { animate = false } = {}) {
  el.dataset.file = String(file);
  el.dataset.rank = String(rank);
  if (!animate) el.classList.add("no-anim");
  el.style.setProperty("--file", String(file));
  el.style.setProperty("--rank", String(rank));
  if (!animate) {
    // Force apply without transition, then re-enable for the next move.
    void el.offsetWidth;
    el.classList.remove("no-anim");
  }
}

function ensureBoard() {
  if (boardEl.dataset.ready === "1") return;
  boardEl.innerHTML = "";
  boardEl.dataset.ready = "1";
  squaresEls = [];
  for (let i = 0; i < 64; i++) {
    const rank = Math.floor(i / 8);
    const file = i % 8;
    const sq = document.createElement("div");
    sq.className = `sq ${(rank + file) % 2 === 1 ? "dark" : "light"}`;
    boardEl.appendChild(sq);
    squaresEls.push(sq);
  }
  piecesLayer = document.createElement("div");
  piecesLayer.className = "pieces-layer";
  boardEl.appendChild(piecesLayer);
}

function makePieceEl(fenChar, file, rank) {
  const img = document.createElement("img");
  img.src = `/static/pieces/${PIECE_FILES[fenChar]}`;
  img.alt = fenChar;
  img.className = "piece no-anim";
  img.draggable = false;
  img.dataset.piece = fenChar;
  setPieceSquare(img, file, rank, { animate: false });
  piecesLayer.appendChild(img);
  return img;
}

function clearHighlights() {
  for (const sq of squaresEls) sq.classList.remove("last-from", "last-to");
}

function highlightMove(uci) {
  clearHighlights();
  if (!uci || uci.length < 4) return;
  const from = parseAlg(uci.slice(0, 2));
  const to = parseAlg(uci.slice(2, 4));
  squaresEls[from.index]?.classList.add("last-from");
  squaresEls[to.index]?.classList.add("last-to");
}

function snapBoard(fen) {
  ensureBoard();
  piecesLayer.innerHTML = "";
  pieceBySq = new Map();
  for (const [index, ch] of fenPlacementMap(fen)) {
    if (!PIECE_FILES[ch]) continue;
    const rank = Math.floor(index / 8);
    const file = index % 8;
    pieceBySq.set(index, makePieceEl(ch, file, rank));
  }
  displayedFen = fen;
  boardAnimating = false;
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Rook destinations for king-side / queen-side castling UCI. */
function castlingRookMove(uci) {
  const map = {
    e1g1: ["h1", "f1"],
    e1c1: ["a1", "d1"],
    e8g8: ["h8", "f8"],
    e8c8: ["a8", "d8"],
  };
  return map[uci.slice(0, 4)] || null;
}

async function animateUci(uci, nextMap) {
  if (!uci || uci.length < 4 || pieceBySq.size === 0) {
    snapBoardFromMap(nextMap);
    return;
  }

  const from = parseAlg(uci.slice(0, 2));
  const to = parseAlg(uci.slice(2, 4));
  const promo = uci[4] ? uci[4].toLowerCase() : null;
  const moving = pieceBySq.get(from.index);
  if (!moving) {
    snapBoardFromMap(nextMap);
    return;
  }

  const captured = pieceBySq.get(to.index);
  if (captured && captured !== moving) {
    captured.classList.add("is-captured");
    pieceBySq.delete(to.index);
    setTimeout(() => captured.remove(), 280);
  }

  moving.classList.add("is-moving");
  moving.classList.remove("no-anim");
  pieceBySq.delete(from.index);
  pieceBySq.set(to.index, moving);

  // Double rAF so the browser paints the start square before transitioning.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  setPieceSquare(moving, to.file, to.rank, { animate: true });

  const rookMv = castlingRookMove(uci);
  if (rookMv) {
    const rFrom = parseAlg(rookMv[0]);
    const rTo = parseAlg(rookMv[1]);
    const rook = pieceBySq.get(rFrom.index);
    if (rook) {
      rook.classList.add("is-moving");
      rook.classList.remove("no-anim");
      pieceBySq.delete(rFrom.index);
      pieceBySq.set(rTo.index, rook);
      setPieceSquare(rook, rTo.file, rTo.rank, { animate: true });
      setTimeout(() => rook.classList.remove("is-moving"), 450);
    }
  }

  await waitMs(450);
  moving.classList.remove("is-moving");

  if (promo && PIECE_FILES[moving.dataset.piece]) {
    const wasWhite = moving.dataset.piece === moving.dataset.piece.toUpperCase();
    const promoChar = wasWhite ? promo.toUpperCase() : promo;
    if (PIECE_FILES[promoChar]) {
      moving.dataset.piece = promoChar;
      moving.alt = promoChar;
      moving.src = `/static/pieces/${PIECE_FILES[promoChar]}`;
    }
  }

  syncPieces(nextMap);
}

function snapBoardFromMap(map) {
  piecesLayer.innerHTML = "";
  pieceBySq = new Map();
  for (const [index, ch] of map) {
    if (!PIECE_FILES[ch]) continue;
    const rank = Math.floor(index / 8);
    const file = index % 8;
    pieceBySq.set(index, makePieceEl(ch, file, rank));
  }
}

function syncPieces(nextMap) {
  for (const [index, el] of [...pieceBySq.entries()]) {
    const want = nextMap.get(index);
    if (!want || want !== el.dataset.piece) {
      el.remove();
      pieceBySq.delete(index);
    }
  }
  for (const [index, ch] of nextMap) {
    if (!PIECE_FILES[ch]) continue;
    const rank = Math.floor(index / 8);
    const file = index % 8;
    let el = pieceBySq.get(index);
    if (!el) {
      pieceBySq.set(index, makePieceEl(ch, file, rank));
      continue;
    }
    if (el.dataset.piece !== ch) {
      el.dataset.piece = ch;
      el.alt = ch;
      el.src = `/static/pieces/${PIECE_FILES[ch]}`;
    }
    setPieceSquare(el, file, rank, { animate: false });
  }
}

/**
 * Render FEN onto the board.
 * When `moveUci` is set and the position changed, slide the piece smoothly.
 */
async function renderBoard(fen, moveUci = null) {
  ensureBoard();
  const token = ++moveAnimToken;
  const fenChanged = fen !== displayedFen;
  const nextMap = fenPlacementMap(fen);

  if (!displayedFen || pieceBySq.size === 0) {
    snapBoard(fen);
    if (moveUci) highlightMove(moveUci);
    return;
  }

  if (!fenChanged) {
    if (moveUci) highlightMove(moveUci);
    return;
  }

  // Another event (thinking / judging) often arrives mid-slide with the same
  // new FEN — lock displayedFen up front so those calls don't snap-teleport.
  if (moveUci && !String(moveUci).includes("illegal")) {
    displayedFen = fen;
    boardAnimating = true;
    highlightMove(moveUci);
    try {
      await animateUci(moveUci, nextMap);
    } finally {
      if (token === moveAnimToken) boardAnimating = false;
    }
    return;
  }

  if (boardAnimating) {
    // Let the in-flight slide finish; don't clobber it.
    return;
  }

  clearHighlights();
  snapBoardFromMap(nextMap);
  displayedFen = fen;
}

/* ── Judge panel (right sidebar, under chart) ─────────── */

function showJudge(h) {
  if (!h) {
    judgeOut.className = "log";
    judgeOut.textContent = "—";
    return;
  }
  const v = h.verdict || {};
  const cls = v.verdict === "WRONG" || h.illegal ? "bad" : "ok";
  judgeOut.className = `log ${cls}`;
  judgeOut.textContent = [
    `Ply ${h.ply} · ${h.side.toUpperCase()} · ${h.move}`,
    `Model: ${h.model || "—"}`,
    "",
    "Live turn",
    h.reasoning || "—",
    "",
    "Judge",
    `${v.verdict || "?"} · move ${v.move_score ?? "-"}/10 · reasoning ${v.reasoning_score ?? "-"}/10`,
    `flags: ${(v.logic_flags || []).join(", ") || "—"}`,
    `material Δ ${v.material_delta ?? 0}`,
    "",
    v.critique || "",
  ].join("\n");
}

/* ── Quality chart ────────────────────────────────────── */

function ensureCharts() {
  if (qualityChart) return;
  const canvas = document.getElementById("chart-quality");
  qualityChart = new Chart(canvas, {
    type: "line",
    data: {
      labels: [],
      datasets: [
        { label: "White move", data: [], borderColor: "#0f6b4c", backgroundColor: "#0f6b4c", tension: 0.2, borderWidth: 2, spanGaps: true },
        { label: "Black move", data: [], borderColor: "#a33b1f", backgroundColor: "#a33b1f", tension: 0.2, borderWidth: 2, spanGaps: true },
        { label: "White reasoning", data: [], borderColor: "#0f6b4c", backgroundColor: "#0f6b4c", tension: 0.2, borderWidth: 2, borderDash: [6, 4], spanGaps: true },
        { label: "Black reasoning", data: [], borderColor: "#a33b1f", backgroundColor: "#a33b1f", tension: 0.2, borderWidth: 2, borderDash: [6, 4], spanGaps: true },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        y: { min: 0, max: 10, ticks: { stepSize: 2 } },
      },
      plugins: {
        legend: { position: "bottom" },
        tooltip: { enabled: false }, // details go in the Judge panel instead
      },
      onHover(_evt, elements) {
        if (elements.length) {
          hoverPinned = true;
          showJudge(turnDetails[elements[0].index]);
        }
      },
      onClick(_evt, elements) {
        if (!elements.length || !matchOver) return;
        seekToHistoryIndex(elements[0].index);
      },
    },
  });

  // Leaving the chart returns the panel to the latest turn (unless reviewing).
  canvas.addEventListener("mouseleave", () => {
    hoverPinned = false;
    if (reviewingPly != null && turnDetails[reviewingPly]) {
      showJudge(turnDetails[reviewingPly]);
      return;
    }
    if (turnDetails.length) showJudge(turnDetails[turnDetails.length - 1]);
  });
  updateChartHint();
}

/** Rebuild chart series from match history (one x-tick per ply). */
function updateChartsFromHistory(history) {
  ensureCharts();
  turnDetails = history || [];
  const labels = turnDetails.map((h) => String(h.ply));
  qualityChart.data.labels = labels;
  qualityChart.data.datasets[0].data = turnDetails.map((h) =>
    h.side === "white" ? Number(h.verdict?.move_score ?? 0) : null
  );
  qualityChart.data.datasets[1].data = turnDetails.map((h) =>
    h.side === "black" ? Number(h.verdict?.move_score ?? 0) : null
  );
  qualityChart.data.datasets[2].data = turnDetails.map((h) =>
    h.side === "white" ? Number(h.verdict?.reasoning_score ?? 0) : null
  );
  qualityChart.data.datasets[3].data = turnDetails.map((h) =>
    h.side === "black" ? Number(h.verdict?.reasoning_score ?? 0) : null
  );
  qualityChart.update();
  if (!hoverPinned && turnDetails.length) {
    showJudge(turnDetails[turnDetails.length - 1]);
  }
}

/* ── State + SSE handlers ─────────────────────────────── */

function renderState(state, opts = {}) {
  if (!state) return;
  const last = state.history?.length ? state.history[state.history.length - 1] : null;
  const moveUci = opts.animate && last && !last.illegal ? last.move : null;
  renderBoard(state.fen, moveUci);
  if (state.history) updateChartsFromHistory(state.history);
  if (state.history?.length) {
    historyEl.textContent = state.history
      .map((h) => {
        const v = h.verdict || {};
        return `#${h.ply} ${h.side[0].toUpperCase()} ${h.move}  ${v.verdict || "?"}  move=${v.move_score ?? "-"} reason=${v.reasoning_score ?? "-"}\n  ${h.reasoning}\n  judge: ${v.critique || ""}`;
      })
      .join("\n\n");
  }
}

function handleEvent(data) {
  switch (data.kind) {
    case "start":
      setStatus("match started");
      displayedFen = null;
      renderState(data.state);
      break;
    case "thinking":
      setStatus(`${data.side} thinking (${data.model})…`);
      renderState(data.state);
      break;
    case "move_proposed":
      setStatus(`${data.side} proposes ${data.choice.move}`);
      if (!hoverPinned) {
        judgeOut.className = "log";
        judgeOut.textContent = [
          `${data.side.toUpperCase()} proposes ${data.choice.move}`,
          `think ${data.think_s.toFixed(2)}s`,
          "",
          data.choice.reasoning || "",
        ].join("\n");
      }
      renderState(data.state);
      break;
    case "judging":
      setStatus(`judge scoring ${data.move}…`);
      if (!hoverPinned) {
        judgeOut.className = "log";
        judgeOut.textContent = `scoring ${data.side} ${data.move}…`;
      }
      break;
    case "turn":
      // Animate only when a legal move was just applied.
      renderState(data.state, { animate: true });
      setStatus(`ply ${data.row.ply} done`);
      break;
    case "end":
      setStatus(`ended: ${data.reason} → ${data.state?.result}`);
      renderState(data.state);
      matchOver = true;
      reviewingPly = null;
      setMatchRunning(false);
      updateChartHint();
      break;
    case "error":
      setStatus(`error: ${data.message}`);
      matchOver = Boolean(turnDetails.length);
      setMatchRunning(false);
      updateChartHint();
      break;
    default:
      break;
  }
}

/* ── Bootstrap ────────────────────────────────────────── */

async function loadModels() {
  const res = await fetch("/api/models");
  const data = await res.json();
  for (const sel of [whiteSel, blackSel, judgeSel]) {
    sel.innerHTML = "";
    for (const m of data.models) {
      const opt = document.createElement("option");
      opt.value = m;
      opt.textContent = m;
      sel.appendChild(opt);
    }
  }
  whiteSel.value = data.models[0];
  blackSel.value = data.models.includes("gpt-4o-mini")
    ? "gpt-4o-mini"
    : data.models[Math.min(1, data.models.length - 1)];
  judgeSel.value = data.models.includes(data.judge) ? data.judge : data.models[0];
}

function endMatch() {
  if (es) {
    es.close();
    es = null;
  }
  matchOver = Boolean(turnDetails.length);
  reviewingPly = null;
  setMatchRunning(false);
  setStatus(matchOver ? "match ended — click graph to review" : "match ended");
  updateChartHint();
}

function startMatch() {
  if (es) es.close();
  ensureCharts();
  turnDetails = [];
  hoverPinned = false;
  matchOver = false;
  reviewingPly = null;
  qualityChart.data.labels = [];
  qualityChart.data.datasets.forEach((d) => (d.data = []));
  qualityChart.update();
  historyEl.textContent = "—";
  showJudge(null);
  displayedFen = null;
  snapBoard("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
  clearHighlights();
  setMatchRunning(true);
  updateChartHint();
  setStatus("connecting…");

  const qs = new URLSearchParams({
    white: whiteSel.value,
    black: blackSel.value,
    judge: judgeSel.value,
    max_plies: String(pliesInput.value || 40),
  });
  es = new EventSource(`/api/match?${qs}`);
  es.onmessage = (msg) => {
    try {
      handleEvent(JSON.parse(msg.data));
    } catch (err) {
      setStatus(String(err));
      setMatchRunning(false);
    }
  };
  es.onerror = () => {
    if (es) {
      es.close();
      es = null;
    }
    // Stream end also fires onerror — only treat as failure if still "running".
    if (!endBtn.hidden) {
      setMatchRunning(false);
      if (statusEl.textContent === "connecting…") {
        setStatus("connection lost");
      }
    }
  };
}

startBtn.addEventListener("click", startMatch);
endBtn.addEventListener("click", endMatch);
snapBoard("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
loadModels().catch((err) => setStatus(String(err)));
