// In-memory room store. For production, swap with Redis/DB.
import { customAlphabet } from 'nanoid';
import { COLORS, newPlayerState } from './game.js';

const codeGen = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 5);

const rooms = new Map();

export function createRoom(hostSocketId, hostName) {
  let code;
  do { code = codeGen(); } while (rooms.has(code));

  const room = {
    code,
    hostId: hostSocketId,
    started: false,
    finished: false,
    winner: null,
    players: [], // { socketId, name, color, connected }
    state: {
      players: {
        red: newPlayerState('red'),
        green: newPlayerState('green'),
        yellow: newPlayerState('yellow'),
        blue: newPlayerState('blue'),
      },
    },
    turnIndex: 0,        // index into players[] (only seated colors play)
    seatedColors: [],    // colors in turn order
    dice: null,          // current dice roll [a,b] or [a]
    plans: null,         // enumerated plans for current dice
    awaitingMove: false,
    log: [],
  };
  rooms.set(code, room);
  return room;
}

export function getRoom(code) {
  return rooms.get(code);
}

export function deleteRoom(code) {
  rooms.delete(code);
}

export function joinRoom(code, socketId, name) {
  const room = rooms.get(code);
  if (!room) return { error: 'Room not found' };
  if (room.started) return { error: 'Game already started' };
  if (room.players.length >= 4) return { error: 'Room is full' };

  const used = new Set(room.players.map(p => p.color));
  const color = COLORS.find(c => !used.has(c));
  const player = { socketId, name: name || `Player ${room.players.length + 1}`, color, connected: true };
  room.players.push(player);
  return { room, player };
}

export function removePlayer(socketId) {
  for (const room of rooms.values()) {
    const p = room.players.find(p => p.socketId === socketId);
    if (!p) continue;
    p.connected = false;
    if (!room.started) {
      room.players = room.players.filter(x => x.socketId !== socketId);
      if (room.players.length === 0) {
        rooms.delete(room.code);
        return { room: null };
      }
      if (room.hostId === socketId) room.hostId = room.players[0].socketId;
    }
    return { room, player: p };
  }
  return { room: null };
}

export function publicRoomView(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    started: room.started,
    finished: room.finished,
    winner: room.winner,
    players: room.players.map(p => ({
      socketId: p.socketId, name: p.name, color: p.color, connected: p.connected,
    })),
    seatedColors: room.seatedColors,
    turnColor: room.seatedColors[room.turnIndex] || null,
    state: room.state,
    dice: room.dice,
    awaitingMove: room.awaitingMove,
    log: room.log.slice(-30),
  };
}