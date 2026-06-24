import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server } from 'socket.io';

import {
  createRoom, getRoom, joinRoom, removePlayer, publicRoomView, deleteRoom,
} from './rooms.js';
import {
  diceCountFor, rollDice, enumeratePlans, simulateMove,
  applyMoveToSnapshot, violatesMandatoryKill, findGuiltyToken,
  allFinished,
} from './game.js';

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (_req, res) => res.send('Ludo backend OK'));
app.get('/api/health', (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

function broadcast(room) {
  io.to(room.code).emit('room:update', publicRoomView(room));
}
function pushLog(room, msg) {
  room.log.push({ t: Date.now(), msg });
}

function nextTurn(room) {
  if (room.finished) return;
  for (let i = 0; i < room.seatedColors.length; i++) {
    room.turnIndex = (room.turnIndex + 1) % room.seatedColors.length;
    // skip if that player already won (all finished)
    const c = room.seatedColors[room.turnIndex];
    if (!allFinished(room.state.players[c])) break;
  }
  room.dice = null;
  room.plans = null;
  room.awaitingMove = false;
}

io.on('connection', (socket) => {
  socket.on('room:create', ({ name }, cb) => {
    const room = createRoom(socket.id, name);
    const join = joinRoom(room.code, socket.id, name);
    socket.join(room.code);
    cb?.({ ok: true, code: room.code, you: join.player });
    broadcast(room);
  });

  socket.on('room:join', ({ code, name }, cb) => {
    code = String(code || '').toUpperCase();
    const r = joinRoom(code, socket.id, name);
    if (r.error) return cb?.({ ok: false, error: r.error });
    socket.join(code);
    cb?.({ ok: true, code, you: r.player });
    broadcast(r.room);
  });

  socket.on('room:start', ({ code }, cb) => {
    const room = getRoom(code);
    if (!room) return cb?.({ ok: false, error: 'No room' });
    if (room.hostId !== socket.id) return cb?.({ ok: false, error: 'Only host can start' });
    if (room.players.length < 2) return cb?.({ ok: false, error: 'Need at least 2 players' });
    room.started = true;
    // Turn order follows COLORS order so the board feels consistent.
    const order = ['red', 'green', 'yellow', 'blue'];
    room.seatedColors = order.filter(c => room.players.some(p => p.color === c));
    room.turnIndex = 0;
    pushLog(room, `Game started — ${room.seatedColors.join(', ')}`);
    cb?.({ ok: true });
    broadcast(room);
  });

  socket.on('dice:roll', ({ code }, cb) => {
    const room = getRoom(code);
    if (!room || !room.started || room.finished) return cb?.({ ok: false });
    const turnColor = room.seatedColors[room.turnIndex];
    const me = room.players.find(p => p.socketId === socket.id);
    if (!me || me.color !== turnColor) return cb?.({ ok: false, error: 'Not your turn' });
    if (room.awaitingMove) return cb?.({ ok: false, error: 'Already rolled' });

    const count = diceCountFor(room.state.players[turnColor]);
    const dice = rollDice(count);
    const plans = enumeratePlans(room.state, turnColor, dice);
    room.dice = dice;
    room.plans = plans;
    room.awaitingMove = true;

    pushLog(room, `${turnColor} rolled ${dice.join(' + ')}`);

    // If no legal moves at all, skip turn.
    if (plans.length === 0) {
      pushLog(room, `${turnColor} has no legal moves — turn skipped`);
      nextTurn(room);
      broadcast(room);
      return cb?.({ ok: true, dice, skipped: true });
    }
    broadcast(room);
    cb?.({ ok: true, dice });
  });

  // Player commits a plan: an ordered list of {tokenIdx, die}.
  socket.on('move:commit', ({ code, moves }, cb) => {
    const room = getRoom(code);
    if (!room || !room.awaitingMove) return cb?.({ ok: false, error: 'No move expected' });
    const turnColor = room.seatedColors[room.turnIndex];
    const me = room.players.find(p => p.socketId === socket.id);
    if (!me || me.color !== turnColor) return cb?.({ ok: false, error: 'Not your turn' });

    // Find a matching plan among the enumerated plans.
    const norm = (mv) => mv.map(m => `${m.tokenIdx}:${m.die}:${m.skipped?1:0}`).join('|');
    const wanted = norm(moves);
    const chosen = room.plans.find(p => norm(p.moves) === wanted);
    if (!chosen) return cb?.({ ok: false, error: 'Illegal move' });

    // Mandatory kill enforcement.
    const violates = violatesMandatoryKill(room.plans, chosen);
    let punishedToken = null;
    if (violates) {
      punishedToken = findGuiltyToken(room.state, turnColor, room.plans);
    }

    // Apply the plan.
    for (const m of chosen.moves) {
      if (m.skipped) continue;
      const sim = simulateMove(room.state, turnColor, m.tokenIdx, m.steps);
      if (!sim.ok) return cb?.({ ok: false, error: 'Illegal step' });
      applyMoveToSnapshot(room.state, turnColor, m.tokenIdx, sim);
      if (sim.capture) {
        pushLog(room, `${turnColor} captured ${sim.capture.color}'s token`);
      }
      if (sim.finished) {
        pushLog(room, `${turnColor} brought a token home`);
      }
    }

    // Punishment: send guilty token back to start.
    if (punishedToken !== null && punishedToken >= 0) {
      const t = room.state.players[turnColor].tokens[punishedToken];
      if (!t.finished) {
        t.steps = 0;
        pushLog(room, `⚠ ${turnColor} ignored a mandatory capture — token #${punishedToken+1} sent to start`);
      }
    }

    // Win check.
    if (allFinished(room.state.players[turnColor])) {
      room.finished = true;
      room.winner = turnColor;
      pushLog(room, `🏆 ${turnColor} WINS!`);
      broadcast(room);
      return cb?.({ ok: true, win: true });
    }

    // Bonus turn: only if two dice and both were 6.
    const bonus = room.dice.length === 2 && room.dice[0] === 6 && room.dice[1] === 6;
    if (bonus) {
      pushLog(room, `${turnColor} rolled double 6 — bonus turn!`);
      room.dice = null;
      room.plans = null;
      room.awaitingMove = false;
    } else {
      nextTurn(room);
    }

    broadcast(room);
    cb?.({ ok: true });
  });

  socket.on('disconnect', () => {
    const r = removePlayer(socket.id);
    if (r.room) broadcast(r.room);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Ludo backend listening on :${PORT}`));