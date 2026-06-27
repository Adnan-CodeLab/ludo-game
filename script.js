/* Ludo Royale frontend — vanilla JS, Socket.IO, WebRTC voice. */

const BACKEND_URL = (() => {
  const meta = document.querySelector('meta[name="backend-url"]');
  if (meta) return meta.content;
  if (location.port === '3001' || location.hostname === '') return '';
  // For GitHub Pages → Railway, override via <meta name="backend-url" content="https://your-app.up.railway.app">.
  return `${location.protocol}//${location.hostname}:3001`;
})();

const socket = io(BACKEND_URL || undefined, { transports: ['websocket', 'polling'] });

/* ---------- Board geometry ---------- */
const MAIN_PATH = [
  [6,1],[6,2],[6,3],[6,4],[6,5],
  [5,6],[4,6],[3,6],[2,6],[1,6],[0,6],
  [0,7],
  [0,8],[1,8],[2,8],[3,8],[4,8],[5,8],
  [6,9],[6,10],[6,11],[6,12],[6,13],[6,14],
  [7,14],
  [8,14],[8,13],[8,12],[8,11],[8,10],[8,9],
  [9,8],[10,8],[11,8],[12,8],[13,8],[14,8],
  [14,7],
  [14,6],[13,6],[12,6],[11,6],[10,6],[9,6],
  [8,5],[8,4],[8,3],[8,2],[8,1],[8,0],
  [7,0],
  [6,0],
];
const START_INDEX = { red: 0, green: 13, yellow: 26, blue: 39 };
const SAFE_SQUARES = new Set([0, 8, 13, 21, 26, 34, 39, 47]);
const HOME_LANES = {
  red:    [[7,1],[7,2],[7,3],[7,4],[7,5]],
  green:  [[1,7],[2,7],[3,7],[4,7],[5,7]],
  yellow: [[7,13],[7,12],[7,11],[7,10],[7,9]],
  blue:   [[13,7],[12,7],[11,7],[10,7],[9,7]],
};
const CENTER = [7,7];
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

/* ---------- DOM ---------- */
const $ = (s) => document.querySelector(s);
const lobby = $('#lobby'), game = $('#game'), board = $('#board');
const nameInput = $('#nameInput'), codeInput = $('#codeInput'), lobbyError = $('#lobbyError');
const roomCodeEl = $('#roomCode'), playerList = $('#playerList');
const startBtn = $('#startBtn'), rollBtn = $('#rollBtn');
const die1 = $('#die1'), die2 = $('#die2');
const moveHint = $('#moveHint'), turnInd = $('#turnIndicator'), logEl = $('#log');
const warnBox = $('#warnBox'), winOverlay = $('#winOverlay'), winnerText = $('#winnerText');
const combinedBtn = $('#combinedBtn'), cancelMoveBtn = $('#cancelMoveBtn');
const chatBox = $('#chatBox'), chatForm = $('#chatForm'), chatInput = $('#chatInput');
const micBtn = $('#micBtn'), audioSink = $('#audioSink');

let me = null, roomCode = null, roomView = null;
// Track 2-dice flow state.
// activeDieIdx: which die index will be spent on the next token click (0 or 1).
// pendingMove: first move already chosen, waiting for the second token click.
let activeDieIdx = 0;
let pendingMove = null;
let useCombined = false;

// Persistent token nodes keyed `${color}-${idx}` so CSS transitions can animate.
const tokenNodes = new Map();

/* ---------- Build board ---------- */
function buildBoard() {
  board.innerHTML = '';
  tokenNodes.clear();
  for (let r = 0; r < 15; r++) {
    for (let c = 0; c < 15; c++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.style.gridRow = (r + 1);
      cell.style.gridColumn = (c + 1);
      cell.dataset.r = r; cell.dataset.c = c;
      board.appendChild(cell);
    }
  }
  for (const color of COLORS) {
    const { row, col, cls } = HOME_BLOCKS[color];
    for (let r = row; r < row + 6; r++)
      for (let c = col; c < col + 6; c++) cellAt(r, c).classList.add(cls);
    const pad = document.createElement('div');
    pad.className = 'home-pad';
    pad.style.left = `${(col + 1) * cellSize() + 10}px`;
    pad.style.top  = `${(row + 1) * cellSize() + 10}px`;
    pad.style.width  = `${4 * cellSize()}px`;
    pad.style.height = `${4 * cellSize()}px`;
    board.appendChild(pad);
  }
  MAIN_PATH.forEach(([r, c], idx) => {
    const cell = cellAt(r, c);
    cell.classList.remove(...Array.from(cell.classList).filter(x => x.startsWith('home-')));
    cell.classList.add('path');
    if (SAFE_SQUARES.has(idx)) cell.classList.add('safe');
  });
  for (const color of COLORS) {
    const [r, c] = MAIN_PATH[START_INDEX[color]];
    cellAt(r, c).classList.add(`start-${color}`);
  }
  for (const color of COLORS) {
    for (const [r, c] of HOME_LANES[color]) {
      const cell = cellAt(r, c);
      cell.classList.add('path', `lane-${color}`);
      cell.classList.remove('safe');
    }
  }
  const ct = document.createElement('div');
  ct.className = 'center-triangle';
  ct.style.left = `${6 * cellSize() + 10}px`;
  ct.style.top  = `${6 * cellSize() + 10}px`;
  ct.innerHTML = `
    <div class="tri" style="background: var(--red);"></div>
    <div class="tri" style="background: var(--green);"></div>
    <div class="tri" style="background: var(--blue);"></div>
    <div class="tri" style="background: var(--yellow);"></div>
  `;
  board.appendChild(ct);
}
function cellSize() {
  const styles = getComputedStyle(board);
  const v = styles.getPropertyValue('--cell').trim();
  if (v.endsWith('px')) return parseFloat(v);
  // computed style usually resolves to px, but fall back to measuring a cell.
  const cell = board.querySelector('.cell');
  return cell ? cell.getBoundingClientRect().width : 38;
}
function cellAt(r, c) {
  return board.querySelector(`.cell[data-r="${r}"][data-c="${c}"]`);
}

/* ---------- Token positioning ---------- */
function tokenCoord(color, tok) {
  if (tok.finished) {
    const o = { red:[7,6.5], green:[6.5,7], yellow:[7,7.5], blue:[7.5,7] };
    return o[color];
  }
  if (tok.steps === 0) return null;
  if (tok.steps >= 52) {
    const li = tok.steps - 52;
    if (li <= 4) return HOME_LANES[color][li];
    return CENTER;
  }
  return MAIN_PATH[(START_INDEX[color] + tok.steps) % 52];
}

function renderTokens() {
  if (!roomView) return;
  const padding = 10;
  const size = cellSize();
  const tokenSize = size * 0.7;
  // Stack offsets per cell.
  const stacks = new Map();

  const keepKeys = new Set();
  for (const color of COLORS) {
    const player = roomView.state.players[color];
    player.tokens.forEach((tok, idx) => {
      const key = `${color}-${idx}`;
      keepKeys.add(key);
      let coord = tokenCoord(color, tok);
      if (!coord) coord = HOME_BASE[color][idx];
      const [r, c] = coord;
      const sk = `${Math.round(r*2)},${Math.round(c*2)}`;
      const si = stacks.get(sk) || 0;
      stacks.set(sk, si + 1);

      let node = tokenNodes.get(key);
      if (!node) {
        node = document.createElement('div');
        node.className = `token ${color}`;
        node.textContent = idx + 1;
        node.dataset.color = color;
        node.dataset.tokenIdx = idx;
        const handler = () => onTokenClick(color, idx);
        node.addEventListener('click', handler);
        node.addEventListener('touchend', (e) => { e.preventDefault(); handler(); }, { passive: false });
        board.appendChild(node);
        tokenNodes.set(key, node);
        // Initial position set without transition (avoid sliding from 0,0).
        node.style.transition = 'none';
      }
      const left = padding + c * size + size / 2 - tokenSize / 2 + (si % 2) * 5;
      const top  = padding + r * size + size / 2 - tokenSize / 2 + Math.floor(si / 2) * 5;
      node.style.width = `${tokenSize}px`;
      node.style.height = `${tokenSize}px`;
      // Re-enable transition next frame for any node that had it temporarily disabled.
      requestAnimationFrame(() => { node.style.transition = ''; });
      node.style.left = `${left}px`;
      node.style.top = `${top}px`;
    });
  }
  for (const [k, n] of tokenNodes) {
    if (!keepKeys.has(k)) { n.remove(); tokenNodes.delete(k); }
  }

  highlightSelectableTokens();
}

/* ---------- Move planning (mirror of server) ---------- */
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
  const apply = (s, tIdx, r) => {
    const tok = s.players[color].tokens[tIdx];
    tok.steps = r.newSteps;
    if (r.finished) tok.finished = true;
    if (r.capture) s.players[r.capture.oc].tokens[r.capture.i].steps = 0;
    return s;
  };

  if (dice.length === 1) {
    const d = dice[0];
    for (let i = 0; i < 4; i++) {
      const s = sim(state, i, d);
      if (s.ok) plans.push({ moves: [{ tokenIdx: i, die: d, steps: d }], capturesCount: s.capture ? 1 : 0 });
    }
    return plans;
  }

  const [d1, d2] = dice;
  for (let i = 0; i < 4; i++) {
    const s = sim(state, i, d1 + d2);
    if (s.ok) plans.push({ moves: [{ tokenIdx: i, die: d1 + d2, steps: d1 + d2, combined: true }], capturesCount: s.capture ? 1 : 0 });
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
          moves: [{ tokenIdx: i, die: a, steps: a }, { tokenIdx: j, die: b, steps: b }],
          capturesCount: (s1.capture ? 1 : 0) + (s2.capture ? 1 : 0),
        });
      }
      if (!any) {
        plans.push({
          moves: [{ tokenIdx: i, die: a, steps: a }, { tokenIdx: -1, die: b, steps: 0, skipped: true }],
          capturesCount: s1.capture ? 1 : 0,
        });
      }
    }
  }
  return plans;
}

function iAmTurn() {
  return roomView && me && roomView.turnColor === me.color;
}

function refreshDiceUI() {
  die1.classList.remove('active', 'spent');
  die2.classList.remove('active', 'spent');
  combinedBtn.classList.add('hidden');
  cancelMoveBtn.classList.add('hidden');

  if (!roomView || !roomView.awaitingMove || !iAmTurn()) return;
  const dice = roomView.dice;
  if (!dice) return;

  if (dice.length === 2) {
    if (pendingMove) {
      // First die already used.
      const usedIdx = pendingMove.dieIdx; // 0 or 1
      (usedIdx === 0 ? die1 : die2).classList.add('spent');
      (usedIdx === 0 ? die2 : die1).classList.add('active');
      cancelMoveBtn.classList.remove('hidden');
    } else if (useCombined) {
      die1.classList.add('active'); die2.classList.add('active');
      cancelMoveBtn.classList.remove('hidden');
    } else {
      (activeDieIdx === 0 ? die1 : die2).classList.add('active');
      // Combined option button if any combined plan exists.
      const plans = clientEnumerate();
      if (plans.some(p => p.moves[0].combined)) {
        combinedBtn.classList.remove('hidden');
        combinedBtn.textContent = `Use combined ${dice[0] + dice[1]}`;
      }
    }
  } else {
    die1.classList.add('active');
  }
}

function highlightSelectableTokens() {
  board.querySelectorAll('.token.selectable').forEach(n => n.classList.remove('selectable'));
  refreshDiceUI();
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
  if (maxCap > 0) {
    warnBox.textContent = '⚠ MANDATORY CAPTURE — you must take it, or your token will be sent back.';
    warnBox.classList.remove('hidden');
  } else {
    warnBox.classList.add('hidden');
  }

  const dice = roomView.dice;

  let selectable = new Set();
  let hint = '';

  if (dice.length === 1) {
    plans.forEach(p => selectable.add(p.moves[0].tokenIdx));
    hint = `Die ${dice[0]} — click a token.`;
  } else if (pendingMove) {
    // Show valid second-token candidates.
    for (const p of plans) {
      if (p.moves[0].tokenIdx !== pendingMove.tokenIdx || p.moves[0].die !== pendingMove.die) continue;
      if (p.moves[1] && !p.moves[1].skipped) selectable.add(p.moves[1].tokenIdx);
    }
    const remainingDie = pendingMove.dieIdx === 0 ? dice[1] : dice[0];
    hint = `Now click a token to use die ${remainingDie}.`;
    if (selectable.size === 0) {
      // Auto-commit skipped variant.
      const skip = plans.find(p =>
        p.moves[0].tokenIdx === pendingMove.tokenIdx &&
        p.moves[0].die === pendingMove.die &&
        p.moves[1] && p.moves[1].skipped);
      if (skip) { hint = `Die ${remainingDie} cannot be used — submitting…`; setTimeout(() => commit(skip), 250); }
    }
  } else if (useCombined) {
    plans.filter(p => p.moves[0].combined).forEach(p => selectable.add(p.moves[0].tokenIdx));
    hint = `Combined ${dice[0] + dice[1]} — click a token.`;
  } else {
    const dieVal = dice[activeDieIdx];
    plans.filter(p => !p.moves[0].combined && p.moves[0].die === dieVal)
         .forEach(p => selectable.add(p.moves[0].tokenIdx));
    hint = `Click a token to use die ${dieVal} (or pick combined).`;
    if (selectable.size === 0) {
      // Active die unusable individually — flip automatically.
      activeDieIdx = activeDieIdx === 0 ? 1 : 0;
      const v2 = dice[activeDieIdx];
      plans.filter(p => !p.moves[0].combined && p.moves[0].die === v2)
           .forEach(p => selectable.add(p.moves[0].tokenIdx));
      hint = `Die ${dice[1-activeDieIdx]} can't be used first — click a token to use die ${v2}.`;
    }
  }

  selectable.forEach(idx => {
    if (idx < 0) return;
    const n = board.querySelector(`.token[data-color="${me.color}"][data-tokenIdx="${idx}"]`);
    if (n) n.classList.add('selectable');
  });
  moveHint.textContent = hint;
}

/* ---------- Token clicks ---------- */
function onTokenClick(color, tokenIdx) {
  if (!roomView || !roomView.awaitingMove || !iAmTurn() || color !== me.color) return;
  const dice = roomView.dice;
  const plans = clientEnumerate();
  if (plans.length === 0) return;

  if (dice.length === 1) {
    const plan = plans.find(p => p.moves[0].tokenIdx === tokenIdx);
    if (plan) commit(plan);
    return;
  }

  // Two dice flow.
  if (pendingMove) {
    const want = plans.find(p =>
      p.moves[0].tokenIdx === pendingMove.tokenIdx &&
      p.moves[0].die === pendingMove.die &&
      p.moves[1] && p.moves[1].tokenIdx === tokenIdx);
    if (want) { pendingMove = null; commit(want); }
    return;
  }

  if (useCombined) {
    const want = plans.find(p => p.moves[0].combined && p.moves[0].tokenIdx === tokenIdx);
    if (want) { useCombined = false; commit(want); }
    return;
  }

  const dieVal = dice[activeDieIdx];
  const candidates = plans.filter(p => !p.moves[0].combined && p.moves[0].die === dieVal && p.moves[0].tokenIdx === tokenIdx);
  if (candidates.length === 0) return;
  // If only-skipped variants, commit immediately.
  const skippedOnly = candidates.every(p => p.moves[1] && p.moves[1].skipped);
  if (skippedOnly) { commit(candidates[0]); return; }
  // Stash first move and wait for second click.
  pendingMove = { tokenIdx, die: dieVal, dieIdx: activeDieIdx };
  highlightSelectableTokens();
}

function commit(plan) {
  socket.emit('move:commit', { code: roomCode, moves: plan.moves }, (res) => {
    if (!res || !res.ok) {
      moveHint.textContent = (res && res.error) ? `Server: ${res.error}` : 'Move rejected.';
      pendingMove = null; useCombined = false; activeDieIdx = 0;
      highlightSelectableTokens();
    }
  });
}

/* ---------- Dice UI controls ---------- */
die1.addEventListener('click', () => {
  if (!roomView || !roomView.awaitingMove || !iAmTurn() || pendingMove) return;
  if (!roomView.dice || roomView.dice.length !== 2) return;
  useCombined = false; activeDieIdx = 0; highlightSelectableTokens();
});
die2.addEventListener('click', () => {
  if (!roomView || !roomView.awaitingMove || !iAmTurn() || pendingMove) return;
  if (!roomView.dice || roomView.dice.length !== 2) return;
  useCombined = false; activeDieIdx = 1; highlightSelectableTokens();
});
combinedBtn.addEventListener('click', () => {
  useCombined = true; pendingMove = null; highlightSelectableTokens();
});
cancelMoveBtn.addEventListener('click', () => {
  pendingMove = null; useCombined = false; activeDieIdx = 0; highlightSelectableTokens();
});

/* ---------- Server updates ---------- */
function renderRoom(view) {
  const prevTurnColor = roomView?.turnColor;
  roomView = view;
  roomCodeEl.textContent = view.code;

  // Reset 2-dice flow on new turn/roll.
  if (!view.awaitingMove || view.turnColor !== prevTurnColor) {
    pendingMove = null; useCombined = false; activeDieIdx = 0;
  }

  playerList.innerHTML = '';
  for (const p of view.players) {
    const li = document.createElement('li');
    li.dataset.socketId = p.socketId;
    if (p.color === view.turnColor && view.started) li.classList.add('turn');
    if (me && p.socketId === me.socketId) li.classList.add('you');
    li.innerHTML = `
      <span class="dot ${p.color}"></span>
      <span class="name">${escapeHtml(p.name)}${me && p.socketId === me.socketId ? ' (you)' : ''}</span>
      <span class="meta"><span class="mic-ind" data-mic="${p.socketId}">${voiceMutedPeers.has(p.socketId) ? '🔇' : ''}</span>${p.connected ? '' : 'offline'}</span>
    `;
    playerList.appendChild(li);
  }

  const amHost = me && view.hostId === me.socketId;
  if (!view.started && amHost && view.players.length >= 2) startBtn.classList.remove('hidden');
  else startBtn.classList.add('hidden');

  if (view.finished) {
    turnInd.innerHTML = `<span class="badge" style="background:var(--${view.winner})"></span>${view.winner} wins`;
  } else if (view.started) {
    const myTurn = view.turnColor === (me && me.color);
    turnInd.innerHTML = `<span class="badge" style="background:var(--${view.turnColor})"></span>${myTurn ? 'Your turn' : view.turnColor + "'s turn"}`;
  } else {
    turnInd.textContent = view.players.length < 2 ? 'Waiting for players…' : (amHost ? 'Ready to start' : 'Waiting for host…');
  }

  if (view.dice) {
    die1.textContent = view.dice[0]; die1.classList.remove('hidden');
    if (view.dice.length === 2) { die2.textContent = view.dice[1]; die2.classList.remove('hidden'); }
    else die2.classList.add('hidden');
  } else {
    die1.textContent = '?'; die2.textContent = '?';
    die1.classList.remove('hidden'); die2.classList.remove('hidden');
  }

  const myTurn = view.started && !view.finished && view.turnColor === (me && me.color);
  rollBtn.disabled = !(myTurn && !view.awaitingMove);

  logEl.innerHTML = '';
  for (const entry of view.log) {
    const li = document.createElement('li');
    li.textContent = entry.msg;
    logEl.appendChild(li);
  }
  logEl.scrollTop = logEl.scrollHeight;

  if (view.finished) {
    winnerText.textContent = view.winner;
    winOverlay.classList.remove('hidden');
  } else {
    winOverlay.classList.add('hidden');
  }

  renderTokens();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/* ---------- Socket events ---------- */
socket.on('room:update', renderRoom);

/* ---------- Chat ---------- */
function addChatMessage(msg) {
  const div = document.createElement('div');
  const mine = me && msg.socketId === me.socketId;
  div.className = 'chat-msg' + (mine ? ' mine' : '');
  div.innerHTML = `
    <div class="meta"><span class="dot ${msg.color}"></span><strong>${escapeHtml(msg.name)}</strong></div>
    <div class="body">${escapeHtml(msg.text)}</div>
  `;
  chatBox.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
}
socket.on('chat:message', addChatMessage);
chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text || !roomCode) return;
  socket.emit('chat:message', { code: roomCode, text });
  chatInput.value = '';
});

/* ---------- UI wiring ---------- */
$('#createBtn').addEventListener('click', () => {
  const name = (nameInput.value || '').trim() || 'Host';
  socket.emit('room:create', { name }, (res) => {
    if (!res || !res.ok) { lobbyError.textContent = res?.error || 'Failed'; return; }
    me = res.you; roomCode = res.code; enterGame();
  });
});
$('#joinBtn').addEventListener('click', () => {
  const name = (nameInput.value || '').trim() || 'Guest';
  const code = (codeInput.value || '').trim().toUpperCase();
  if (!code) { lobbyError.textContent = 'Enter a room code.'; return; }
  socket.emit('room:join', { code, name }, (res) => {
    if (!res || !res.ok) { lobbyError.textContent = res?.error || 'Failed'; return; }
    me = res.you; roomCode = res.code; enterGame();
  });
});
$('#copyCodeBtn').addEventListener('click', () => {
  if (roomCode) navigator.clipboard?.writeText(roomCode);
});
$('#leaveBtn').addEventListener('click', () => { stopVoice(); location.reload(); });
startBtn.addEventListener('click', () => {
  socket.emit('room:start', { code: roomCode }, (res) => {
    if (!res || !res.ok) alert(res?.error || 'Failed to start');
  });
});
rollBtn.addEventListener('click', () => {
  rollBtn.disabled = true;
  die1.classList.add('rolling'); die2.classList.add('rolling');
  setTimeout(() => { die1.classList.remove('rolling'); die2.classList.remove('rolling'); }, 600);
  socket.emit('dice:roll', { code: roomCode }, (res) => {
    if (!res || !res.ok) { moveHint.textContent = res?.error || 'Roll failed'; rollBtn.disabled = false; }
  });
});
$('#winCloseBtn').addEventListener('click', () => { stopVoice(); location.reload(); });

function enterGame() {
  lobby.classList.add('hidden');
  game.classList.remove('hidden');
  buildBoard();
  // Re-render on resize so cell-size changes reposition tokens.
  let rt;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => { buildBoard(); renderTokens(); }, 120);
  });
}

/* =================================================================
   WebRTC voice chat (peer-to-peer mesh, Socket.IO signaling)
   ================================================================= */
const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
const peers = new Map();          // socketId -> RTCPeerConnection
const remoteAudioEls = new Map(); // socketId -> <audio>
const voiceMutedPeers = new Set();
let localStream = null;
let micOn = false;
let speakingMonitorTimer = null;

async function startMic() {
  if (localStream) return localStream;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (err) {
    alert('Microphone access denied or unavailable. Voice chat needs HTTPS and mic permission.');
    throw err;
  }
  // Attach to any existing peers.
  for (const pc of peers.values()) {
    localStream.getAudioTracks().forEach(t => pc.addTrack(t, localStream));
  }
  startSpeakingMonitor();
  return localStream;
}

function stopVoice() {
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  for (const pc of peers.values()) try { pc.close(); } catch {}
  peers.clear();
  for (const a of remoteAudioEls.values()) a.remove();
  remoteAudioEls.clear();
  if (speakingMonitorTimer) { clearInterval(speakingMonitorTimer); speakingMonitorTimer = null; }
  micOn = false; updateMicBtn();
}

function updateMicBtn() {
  micBtn.textContent = micOn ? '🎙 Mic on' : '🎤 Mic off';
  micBtn.classList.toggle('live', micOn);
}

micBtn.addEventListener('click', async () => {
  try {
    if (!localStream) await startMic();
    micOn = !micOn;
    localStream.getAudioTracks().forEach(t => t.enabled = micOn);
    updateMicBtn();
    socket.emit('voice:mute', { code: roomCode, muted: !micOn });
    // If just turned on the mic for the first time, dial all existing peers.
    if (micOn && roomView) {
      for (const p of roomView.players) {
        if (me && p.socketId === me.socketId) continue;
        if (!peers.has(p.socketId)) await dialPeer(p.socketId, true);
      }
    }
  } catch {}
});

function ensurePeer(socketId) {
  let pc = peers.get(socketId);
  if (pc) return pc;
  pc = new RTCPeerConnection(RTC_CONFIG);
  peers.set(socketId, pc);

  pc.onicecandidate = (ev) => {
    if (ev.candidate) {
      socket.emit('voice:signal', { to: socketId, data: { type: 'ice', candidate: ev.candidate } });
    }
  };
  pc.ontrack = (ev) => {
    let audio = remoteAudioEls.get(socketId);
    if (!audio) {
      audio = document.createElement('audio');
      audio.autoplay = true;
      audio.playsInline = true;
      audioSink.appendChild(audio);
      remoteAudioEls.set(socketId, audio);
    }
    audio.srcObject = ev.streams[0];
  };
  pc.onconnectionstatechange = () => {
    if (['failed','closed','disconnected'].includes(pc.connectionState)) {
      const a = remoteAudioEls.get(socketId);
      if (a) { a.remove(); remoteAudioEls.delete(socketId); }
    }
  };
  if (localStream) {
    localStream.getAudioTracks().forEach(t => pc.addTrack(t, localStream));
  }
  return pc;
}

async function dialPeer(socketId, asCaller) {
  const pc = ensurePeer(socketId);
  if (!asCaller) return pc;
  const offer = await pc.createOffer({ offerToReceiveAudio: true });
  await pc.setLocalDescription(offer);
  socket.emit('voice:signal', { to: socketId, data: { type: 'offer', sdp: pc.localDescription } });
  return pc;
}

socket.on('voice:peers', ({ peers: list }) => {
  // Don't dial yet — wait until the user enables their mic, to avoid surprise prompts.
  // We'll dial when micBtn is first toggled on.
});
socket.on('voice:peer-joined', async ({ socketId }) => {
  if (micOn) await dialPeer(socketId, true);
});
socket.on('voice:peer-left', ({ socketId }) => {
  const pc = peers.get(socketId);
  if (pc) { try { pc.close(); } catch {} peers.delete(socketId); }
  const a = remoteAudioEls.get(socketId);
  if (a) { a.remove(); remoteAudioEls.delete(socketId); }
  voiceMutedPeers.delete(socketId);
  setSpeakingIndicator(socketId, false);
});
socket.on('voice:signal', async ({ from, data }) => {
  const pc = ensurePeer(from);
  try {
    if (data.type === 'offer') {
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      // Make sure we send our audio back if mic is on.
      if (!localStream && micBtn) { /* user must enable mic to talk back */ }
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('voice:signal', { to: from, data: { type: 'answer', sdp: pc.localDescription } });
    } else if (data.type === 'answer') {
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    } else if (data.type === 'ice') {
      try { await pc.addIceCandidate(data.candidate); } catch {}
    }
  } catch (e) { console.warn('signal error', e); }
});
socket.on('voice:mute', ({ from, muted }) => {
  if (muted) voiceMutedPeers.add(from); else voiceMutedPeers.delete(from);
  const el = document.querySelector(`[data-mic="${from}"]`);
  if (el) el.textContent = muted ? '🔇' : '';
});

/* ---------- Speaking indicator (volume sampling) ---------- */
function startSpeakingMonitor() {
  if (speakingMonitorTimer) return;
  const analysers = new Map(); // socketId -> { analyser, data }
  const ctx = new (window.AudioContext || window.webkitAudioContext)();

  const ensureAnalyser = (socketId, stream) => {
    if (analysers.has(socketId)) return;
    try {
      const src = ctx.createMediaStreamSource(stream);
      const a = ctx.createAnalyser();
      a.fftSize = 512;
      src.connect(a);
      analysers.set(socketId, { analyser: a, data: new Uint8Array(a.frequencyBinCount) });
    } catch {}
  };

  speakingMonitorTimer = setInterval(() => {
    // Local speaker.
    if (localStream && micOn) {
      ensureAnalyser(me?.socketId || 'me', localStream);
    }
    // Remote speakers.
    for (const [sid, audio] of remoteAudioEls) {
      if (audio.srcObject) ensureAnalyser(sid, audio.srcObject);
    }
    for (const [sid, { analyser, data }] of analysers) {
      analyser.getByteFrequencyData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i];
      const avg = sum / data.length;
      const speaking = avg > 12;
      const realSid = sid === 'me' ? me?.socketId : sid;
      if (realSid) setSpeakingIndicator(realSid, speaking && !voiceMutedPeers.has(realSid) && (sid === 'me' ? micOn : true));
    }
  }, 150);
}
function setSpeakingIndicator(socketId, on) {
  const li = playerList.querySelector(`li[data-socket-id="${socketId}"]`);
  if (!li) return;
  li.classList.toggle('speaking', !!on);
}