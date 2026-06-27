/* Ludo Royale frontend.
   Connect via Socket.IO to a backend, render the 15x15 board, animate tokens. */

const BACKEND_URL = (() => {
  // If served from same origin as backend, use ''. Otherwise default to localhost:3001.
  const meta = document.querySelector('meta[name="backend-url"]');
  if (meta) return meta.content;
  if (location.port === '3001' || location.hostname === '') return '';
  return `${location.protocol}//${location.hostname}:3001`;
})();

const socket = io(BACKEND_URL || undefined, { transports: ['websocket', 'polling'] });

/* ---------- Constants: board geometry ---------- */
// 52 main-track squares mapped to [row,col] on 15x15 grid.
const MAIN_PATH = [
  [6,1],[6,2],[6,3],[6,4],[6,5],          // 0-4 (red start at 0)
  [5,6],[4,6],[3,6],[2,6],[1,6],[0,6],    // 5-10
  [0,7],                                  // 11
  [0,8],[1,8],[2,8],[3,8],[4,8],[5,8],    // 12-17 (green start at 13)
  [6,9],[6,10],[6,11],[6,12],[6,13],[6,14], // 18-23
  [7,14],                                 // 24
  [8,14],[8,13],[8,12],[8,11],[8,10],[8,9], // 25-30 (yellow start at 26)
  [9,8],[10,8],[11,8],[12,8],[13,8],[14,8], // 31-36
  [14,7],                                 // 37
  [14,6],[13,6],[12,6],[11,6],[10,6],[9,6], // 38-43 (blue start at 39)
  [8,5],[8,4],[8,3],[8,2],[8,1],[8,0],    // 44-49
  [7,0],                                  // 50
  [6,0],                                  // 51
];

const START_INDEX = { red: 0, green: 13, yellow: 26, blue: 39 };
const SAFE_SQUARES = new Set([0, 8, 13, 21, 26, 34, 39, 47]);

// Home lanes: 5 squares per color leading to center.
const HOME_LANES = {
  red:    [[7,1],[7,2],[7,3],[7,4],[7,5]],
  green:  [[1,7],[2,7],[3,7],[4,7],[5,7]],
  yellow: [[7,13],[7,12],[7,11],[7,10],[7,9]],
  blue:   [[13,7],[12,7],[11,7],[10,7],[9,7]],
};
const CENTER = [7,7];

// Home base parking spots for unmoved tokens (4 per color).
const HOME_BASE = {
  red:    [[1.5,1.5],[1.5,3.5],[3.5,1.5],[3.5,3.5]],
  green:  [[1.5,10.5],[1.5,12.5],[3.5,10.5],[3.5,12.5]],
  yellow: [[10.5,10.5],[10.5,12.5],[12.5,10.5],[12.5,12.5]],
  blue:   [[10.5,1.5],[10.5,3.5],[12.5,1.5],[12.5,3.5]],
};

const COLORS = ['red','green','yellow','blue'];
const HOME_BLOCKS = {
  red:    { row: 0, col: 0, cls: 'home-red' },
  green:  { row: 0, col: 9, cls: 'home-green' },
  yellow: { row: 9, col: 9, cls: 'home-yellow' },
  blue:   { row: 9, col: 0, cls: 'home-blue' },
};

/* ---------- DOM refs ---------- */
const $ = (s) => document.querySelector(s);
const lobby = $('#lobby');
const game = $('#game');
const board = $('#board');
const nameInput = $('#nameInput');
const codeInput = $('#codeInput');
const lobbyError = $('#lobbyError');
const roomCodeEl = $('#roomCode');
const playerList = $('#playerList');
const startBtn = $('#startBtn');
const rollBtn = $('#rollBtn');
const die1 = $('#die1');
const die2 = $('#die2');
const moveHint = $('#moveHint');
const turnInd = $('#turnIndicator');
const logEl = $('#log');
const warnBox = $('#warnBox');
const winOverlay = $('#winOverlay');
const winnerText = $('#winnerText');

let me = null;        // {socketId, name, color}
let roomCode = null;
let roomView = null;
let pendingMove = null; // selected first move when 2-dice and not combined
let dieAssign = { dieIdx: 0 }; // which die we're spending next

/* ---------- Build the board ---------- */
function buildBoard() {
  board.innerHTML = '';
  // Create 15x15 cells.
  for (let r = 0; r < 15; r++) {
    for (let c = 0; c < 15; c++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.style.gridRow = (r + 1);
      cell.style.gridColumn = (c + 1);
      cell.dataset.r = r;
      cell.dataset.c = c;
      board.appendChild(cell);
    }
  }

  // Color home blocks (6x6 corners).
  for (const color of COLORS) {
    const { row, col, cls } = HOME_BLOCKS[color];
    for (let r = row; r < row + 6; r++) {
      for (let c = col; c < col + 6; c++) {
        cellAt(r, c).classList.add(cls);
      }
    }
    // Inner pad (white square w/ parking spots).
    const pad = document.createElement('div');
    pad.className = 'home-pad';
    pad.style.left = `${(col + 1) * cellSize() + 10}px`;
    pad.style.top = `${(row + 1) * cellSize() + 10}px`;
    pad.style.width = `${4 * cellSize()}px`;
    pad.style.height = `${4 * cellSize()}px`;
    board.appendChild(pad);
  }

  // Main path cells.
  MAIN_PATH.forEach(([r, c], idx) => {
    const cell = cellAt(r, c);
    cell.classList.remove(...Array.from(cell.classList).filter(x => x.startsWith('home-')));
    cell.classList.add('path');
    if (SAFE_SQUARES.has(idx)) cell.classList.add('safe');
  });
  // Color the start squares with their color.
  for (const color of COLORS) {
    const [r, c] = MAIN_PATH[START_INDEX[color]];
    cellAt(r, c).classList.add(`start-${color}`);
  }

  // Home lanes.
  for (const color of COLORS) {
    for (const [r, c] of HOME_LANES[color]) {
      const cell = cellAt(r, c);
      cell.classList.add('path', `lane-${color}`);
      cell.classList.remove('safe');
    }
  }

  // Center finish triangles.
  const ct = document.createElement('div');
  ct.className = 'center-triangle';
  ct.style.left = `${6 * cellSize() + 10}px`;
  ct.style.top = `${6 * cellSize() + 10}px`;
  ct.innerHTML = `
    <div class="tri" style="background: var(--red); transform: rotate(-90deg); transform-origin: center;"></div>
    <div class="tri" style="background: var(--green);"></div>
    <div class="tri" style="background: var(--blue); transform: rotate(180deg); transform-origin: center;"></div>
    <div class="tri" style="background: var(--yellow); transform: rotate(90deg); transform-origin: center;"></div>
  `;
  board.appendChild(ct);
}

function cellSize() {
  const styles = getComputedStyle(board);
  return parseFloat(styles.getPropertyValue('--cell')) || 38;
}
function cellAt(r, c) {
  return board.querySelector(`.cell[data-r="${r}"][data-c="${c}"]`);
}

/* ---------- Token positioning ---------- */
function tokenCoord(color, tok) {
  // Returns [row, col] (fractional allowed) for the token center.
  if (tok.finished) {
    // Stack near center based on color.
    const offsets = {
      red:    [7, 6.5],
      green:  [6.5, 7],
      yellow: [7, 7.5],
      blue:   [7.5, 7],
    };
    return offsets[color];
  }
  if (tok.steps === 0) return null; // park in base
  if (tok.steps >= 52) {
    const laneIdx = tok.steps - 52;
    if (laneIdx <= 4) return HOME_LANES[color][laneIdx];
    return CENTER;
  }
  const abs = (START_INDEX[color] + tok.steps) % 52;
  return MAIN_PATH[abs];
}

function renderTokens() {
  // Clear existing tokens.
  board.querySelectorAll('.token').forEach(n => n.remove());
  if (!roomView) return;
  const padding = 10; // board inner padding
  const size = cellSize();

  // Group tokens by cell for stacking offsets.
  const stacks = new Map(); // key "r,c" -> count

  for (const color of COLORS) {
    const player = roomView.state.players[color];
    player.tokens.forEach((tok, idx) => {
      let coord = tokenCoord(color, tok);
      let baseSpot = null;
      if (!coord) {
        baseSpot = HOME_BASE[color][idx];
        coord = baseSpot;
      }
      const [r, c] = coord;
      const key = `${Math.round(r*2)},${Math.round(c*2)}`;
      const stackIdx = stacks.get(key) || 0;
      stacks.set(key, stackIdx + 1);

      const node = document.createElement('div');
      node.className = `token ${color}`;
      node.textContent = idx + 1;
      node.dataset.color = color;
      node.dataset.tokenIdx = idx;

      const tokenSize = size * 0.7;
      const left = padding + c * size + size / 2 - tokenSize / 2 + (stackIdx % 2) * 4;
      const top = padding + r * size + size / 2 - tokenSize / 2 + Math.floor(stackIdx / 2) * 4;
      node.style.left = `${left}px`;
      node.style.top = `${top}px`;
      node.style.width = `${tokenSize}px`;
      node.style.height = `${tokenSize}px`;

      node.addEventListener('click', () => onTokenClick(color, idx));
      board.appendChild(node);
    });
  }

  highlightSelectableTokens();
}

/* ---------- Move planning ---------- */
// Compute available plans on the client too (for highlighting & UX).
// Mirrors server logic; server is still authoritative.
function clientEnumerate() {
  if (!roomView || !roomView.awaitingMove || !roomView.dice || !iAmTurn()) return [];
  const state = roomView.state;
  const color = me.color;
  const dice = roomView.dice;
  const plans = [];

  const sim = (s, tIdx, steps) => {
    const tok = s.players[color].tokens[tIdx];
    if (!tok || tok.finished) return { ok: false };
    const target = tok.steps + steps;
    if (target > 57) return { ok: false };
    let capture = null;
    if (target < 52) {
      const sq = (START_INDEX[color] + target) % 52;
      if (!SAFE_SQUARES.has(sq)) {
        for (const oc of COLORS) {
          if (oc === color) continue;
          const op = s.players[oc];
          for (let i = 0; i < op.tokens.length; i++) {
            const ot = op.tokens[i];
            if (ot.finished || ot.steps >= 52) continue;
            const osq = (START_INDEX[oc] + ot.steps) % 52;
            if (osq === sq) { capture = { oc, i }; break; }
          }
          if (capture) break;
        }
      }
    }
    return { ok: true, newSteps: target, capture, finished: target === 57 };
  };

  const apply = (s, tIdx, simResult) => {
    const tok = s.players[color].tokens[tIdx];
    tok.steps = simResult.newSteps;
    if (simResult.finished) tok.finished = true;
    if (simResult.capture) {
      s.players[simResult.capture.oc].tokens[simResult.capture.i].steps = 0;
    }
    return s;
  };

  if (dice.length === 1) {
    const d = dice[0];
    for (let i = 0; i < 4; i++) {
      const s = sim(state, i, d);
      if (s.ok) plans.push({
        moves: [{ tokenIdx: i, die: d, steps: d }],
        capturesCount: s.capture ? 1 : 0,
      });
    }
    return plans;
  }

  const [d1, d2] = dice;
  // combined
  for (let i = 0; i < 4; i++) {
    const s = sim(state, i, d1 + d2);
    if (s.ok) plans.push({
      moves: [{ tokenIdx: i, die: d1 + d2, steps: d1 + d2, combined: true }],
      capturesCount: s.capture ? 1 : 0,
    });
  }
  const orders = d1 === d2 ? [[d1, d2]] : [[d1, d2], [d2, d1]];
  for (const [a, b] of orders) {
    for (let i = 0; i < 4; i++) {
      const s1 = sim(state, i, a);
      if (!s1.ok) continue;
      const snap = JSON.parse(JSON.stringify(state));
      apply(snap, i, s1);
      let any = false;
      for (let j = 0; j < 4; j++) {
        const s2 = sim(snap, j, b);
        if (!s2.ok) continue;
        any = true;
        plans.push({
          moves: [
            { tokenIdx: i, die: a, steps: a },
            { tokenIdx: j, die: b, steps: b },
          ],
          capturesCount: (s1.capture ? 1 : 0) + (s2.capture ? 1 : 0),
        });
      }
      if (!any) {
        plans.push({
          moves: [
            { tokenIdx: i, die: a, steps: a },
            { tokenIdx: -1, die: b, steps: 0, skipped: true },
          ],
          capturesCount: s1.capture ? 1 : 0,
        });
      }
    }
  }
  return plans;
}

function iAmTurn() {
  return roomView && me && roomView.seatedColors[
    roomView.seatedColors.findIndex(c => c === roomView.turnColor)
  ] && roomView.turnColor === me.color;
}

function highlightSelectableTokens() {
  board.querySelectorAll('.token.selectable').forEach(n => n.classList.remove('selectable'));
  board.querySelectorAll('.cell.target-highlight').forEach(n => n.classList.remove('target-highlight'));
  if (!roomView || !roomView.awaitingMove || !iAmTurn()) {
    moveHint.textContent = '';
    warnBox.classList.add('hidden');
    return;
  }
  const plans = clientEnumerate();
  if (plans.length === 0) {
    moveHint.textContent = 'No legal moves — turn passes.';
    return;
  }
  const maxCap = plans.reduce((m, p) => Math.max(m, p.capturesCount), 0);
  const mandatory = maxCap > 0;
  if (mandatory) {
    warnBox.textContent = '⚠ MANDATORY CAPTURE — you must take the capture, or your token will be sent back.';
    warnBox.classList.remove('hidden');
  } else {
    warnBox.classList.add('hidden');
  }

  // Tokens that are the first-move candidate.
  const firstTokens = new Set();
  for (const p of plans) {
    const first = p.moves[0];
    if (first) firstTokens.add(first.tokenIdx);
  }
  firstTokens.forEach(idx => {
    const n = board.querySelector(`.token[data-color="${me.color}"][data-tokenIdx="${idx}"]`);
    if (n) n.classList.add('selectable');
  });

  if (roomView.dice.length === 2) {
    moveHint.textContent = `Dice ${roomView.dice[0]} + ${roomView.dice[1]}. Click a token to spend a die (or combined ${roomView.dice[0]+roomView.dice[1]}).`;
  } else {
    moveHint.textContent = `Die ${roomView.dice[0]}. Click a token to move.`;
  }
}

/* ---------- Token click handling ---------- */
function onTokenClick(color, tokenIdx) {
  if (!roomView || !roomView.awaitingMove || !iAmTurn() || color !== me.color) return;
  const dice = roomView.dice;
  const plans = clientEnumerate();
  if (plans.length === 0) return;

  if (dice.length === 1) {
    const plan = plans.find(p => p.moves[0].tokenIdx === tokenIdx);
    if (!plan) return;
    commit(plan);
    return;
  }

  // Two dice case: choose between combined / individual.
  if (!pendingMove) {
    // Offer a choice: prefer "combined" if it's the only option for this token.
    const candidates = plans.filter(p => p.moves[0].tokenIdx === tokenIdx);
    if (candidates.length === 0) return;
    // Auto-pick combined-only if the only candidate is combined; otherwise default to first-die individual.
    const combinedOnly = candidates.every(p => p.moves[0].combined);
    if (combinedOnly) { commit(candidates[0]); return; }

    // Pick the candidate that uses the first die individually (a = dice[0]).
    const indiv = candidates.find(p => !p.moves[0].combined && p.moves[0].die === dice[0]) ||
                  candidates.find(p => !p.moves[0].combined);
    if (!indiv) { commit(candidates[0]); return; }

    // If second move is forced/skipped only, commit immediately.
    if (indiv.moves.length === 2 && indiv.moves[1].skipped) {
      commit(indiv);
      return;
    }
    // Stash and wait for second token.
    pendingMove = indiv.moves[0];
    moveHint.textContent = `Now use die ${indiv.moves[1].die} — click a token.`;
    // Highlight second-token options.
    board.querySelectorAll('.token.selectable').forEach(n => n.classList.remove('selectable'));
    const validSecond = new Set();
    for (const p of plans) {
      if (p.moves[0].tokenIdx !== pendingMove.tokenIdx || p.moves[0].die !== pendingMove.die) continue;
      if (p.moves[1] && !p.moves[1].skipped) validSecond.add(p.moves[1].tokenIdx);
    }
    if (validSecond.size === 0) {
      // No valid second; commit a skipped variant.
      const skipPlan = plans.find(p =>
        p.moves[0].tokenIdx === pendingMove.tokenIdx &&
        p.moves[0].die === pendingMove.die &&
        p.moves[1] && p.moves[1].skipped
      );
      if (skipPlan) commit(skipPlan);
      pendingMove = null;
      return;
    }
    validSecond.forEach(idx => {
      const n = board.querySelector(`.token[data-color="${me.color}"][data-tokenIdx="${idx}"]`);
      if (n) n.classList.add('selectable');
    });
    return;
  }

  // Second click: complete plan.
  const want = plans.find(p =>
    p.moves[0].tokenIdx === pendingMove.tokenIdx &&
    p.moves[0].die === pendingMove.die &&
    p.moves[1] && p.moves[1].tokenIdx === tokenIdx
  );
  pendingMove = null;
  if (!want) return;
  commit(want);
}

function commit(plan) {
  socket.emit('move:commit', { code: roomCode, moves: plan.moves }, (res) => {
    if (!res || !res.ok) {
      moveHint.textContent = (res && res.error) ? `Server: ${res.error}` : 'Move rejected.';
    }
  });
}

/* ---------- UI updates from server ---------- */
function renderRoom(view) {
  roomView = view;
  roomCodeEl.textContent = view.code;

  // Player list.
  playerList.innerHTML = '';
  for (const p of view.players) {
    const li = document.createElement('li');
    if (p.color === view.turnColor && view.started) li.classList.add('turn');
    if (me && p.socketId === me.socketId) li.classList.add('you');
    li.innerHTML = `
      <span class="dot ${p.color}"></span>
      <span class="name">${escapeHtml(p.name)}${me && p.socketId === me.socketId ? ' (you)' : ''}</span>
      <span class="meta">${p.color}${p.connected ? '' : ' · offline'}</span>
    `;
    playerList.appendChild(li);
  }

  // Start button (host only, pre-game).
  const amHost = me && view.hostId === me.socketId;
  if (!view.started && amHost && view.players.length >= 2) startBtn.classList.remove('hidden');
  else startBtn.classList.add('hidden');

  // Turn indicator.
  if (view.finished) {
    turnInd.innerHTML = `<span class="badge" style="background:var(--${view.winner})"></span>${view.winner} wins`;
  } else if (view.started) {
    const myTurn = view.turnColor === (me && me.color);
    turnInd.innerHTML = `<span class="badge" style="background:var(--${view.turnColor})"></span>${myTurn ? 'Your turn' : view.turnColor + "'s turn"}`;
  } else {
    turnInd.textContent = view.players.length < 2 ? 'Waiting for players…' : (amHost ? 'Ready to start' : 'Waiting for host…');
  }

  // Dice display.
  if (view.dice) {
    die1.textContent = view.dice[0];
    die1.classList.remove('hidden');
    if (view.dice.length === 2) { die2.textContent = view.dice[1]; die2.classList.remove('hidden'); }
    else die2.classList.add('hidden');
  } else {
    die1.textContent = '?'; die2.textContent = '?';
    die1.classList.remove('hidden');
    die2.classList.remove('hidden');
  }

  const myTurn = view.started && !view.finished && view.turnColor === (me && me.color);
  rollBtn.disabled = !(myTurn && !view.awaitingMove);

  // Log.
  logEl.innerHTML = '';
  for (const entry of view.log) {
    const li = document.createElement('li');
    li.textContent = entry.msg;
    logEl.appendChild(li);
  }
  logEl.scrollTop = logEl.scrollHeight;

  // Winner overlay.
  if (view.finished) {
    winnerText.textContent = view.winner;
    winOverlay.classList.remove('hidden');
  } else {
    winOverlay.classList.add('hidden');
  }

  pendingMove = null;
  renderTokens();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/* ---------- Socket events ---------- */
socket.on('connect', () => { /* noop */ });
socket.on('room:update', (view) => {
  renderRoom(view);
});

/* ---------- UI wiring ---------- */
$('#createBtn').addEventListener('click', () => {
  const name = (nameInput.value || '').trim() || 'Host';
  socket.emit('room:create', { name }, (res) => {
    if (!res || !res.ok) { lobbyError.textContent = res?.error || 'Failed'; return; }
    me = res.you;
    roomCode = res.code;
    enterGame();
  });
});

$('#joinBtn').addEventListener('click', () => {
  const name = (nameInput.value || '').trim() || 'Guest';
  const code = (codeInput.value || '').trim().toUpperCase();
  if (!code) { lobbyError.textContent = 'Enter a room code.'; return; }
  socket.emit('room:join', { code, name }, (res) => {
    if (!res || !res.ok) { lobbyError.textContent = res?.error || 'Failed'; return; }
    me = res.you;
    roomCode = res.code;
    enterGame();
  });
});

$('#copyCodeBtn').addEventListener('click', () => {
  if (roomCode) navigator.clipboard?.writeText(roomCode);
});

$('#leaveBtn').addEventListener('click', () => {
  location.reload();
});

startBtn.addEventListener('click', () => {
  socket.emit('room:start', { code: roomCode }, (res) => {
    if (!res || !res.ok) alert(res?.error || 'Failed to start');
  });
});

rollBtn.addEventListener('click', () => {
  rollBtn.disabled = true;
  die1.classList.add('rolling'); die2.classList.add('rolling');
  setTimeout(() => {
    die1.classList.remove('rolling'); die2.classList.remove('rolling');
  }, 600);
  socket.emit('dice:roll', { code: roomCode }, (res) => {
    if (!res || !res.ok) {
      moveHint.textContent = res?.error || 'Roll failed';
      rollBtn.disabled = false;
    }
  });
});
$('#winCloseBtn').addEventListener('click', () => location.reload());
function enterGame() {
  lobby.classList.add('hidden');
  game.classList.remove('hidden');
  buildBoard();
  window.addEventListener('resize', () => { buildBoard(); renderTokens(); });
}