const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

/**
 * Room state (in-memory).
 * rooms: Map<roomId, { players: Map<socketId, {name, vote}>, revealed: bool }>
 * vote === null  -> player has not voted this round
 */
const rooms = new Map();

function getRoom(id) {
  if (!rooms.has(id)) rooms.set(id, { players: new Map(), revealed: false });
  return rooms.get(id);
}

function buildState(room) {
  const players = [...room.players.entries()].map(([id, p]) => ({
    id,
    name: p.name,
    hasVoted: p.vote !== null,
    // Only expose the actual value once the round is revealed.
    vote: room.revealed ? p.vote : null,
  }));

  let stats = null;
  if (room.revealed) {
    const values = [...room.players.values()].map((p) => p.vote).filter((v) => v !== null);
    const numeric = values.filter((v) => v !== '?' && v !== '☕' && !isNaN(parseFloat(v))).map(Number);
    const average = numeric.length
      ? Math.round((numeric.reduce((a, b) => a + b, 0) / numeric.length) * 10) / 10
      : null;
    const consensus = values.length > 1 && values.every((v) => v === values[0]);
    stats = { average, consensus, votedCount: values.length };
  }

  return { revealed: room.revealed, players, stats };
}

function broadcast(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  io.to(roomId).emit('state', buildState(room));
}

// Reveal automatically once every player in the room has voted.
function maybeReveal(room) {
  const players = [...room.players.values()];
  if (players.length > 0 && players.every((p) => p.vote !== null)) {
    room.revealed = true;
  }
}

function resetRound(room) {
  room.revealed = false;
  room.players.forEach((p) => {
    p.vote = null;
  });
}

io.on('connection', (socket) => {
  let roomId = null;

  socket.on('join', ({ room, name }) => {
    roomId = String(room || '').trim().toLowerCase() || 'default';
    const displayName = String(name || '').trim().slice(0, 24) || 'Anon';
    socket.join(roomId);
    const roomObj = getRoom(roomId);
    roomObj.players.set(socket.id, { name: displayName, vote: null });
    // A newcomer starts a fresh round: clear any revealed/stale votes so
    // everyone re-estimates together instead of seeing a finished round.
    if (roomObj.revealed) resetRound(roomObj);
    socket.emit('joined', { id: socket.id, roomId });
    broadcast(roomId);
  });

  socket.on('vote', ({ card }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player) return;

    // Picking a card after the reveal starts a fresh round for the whole
    // room: all votes are cleared and hidden again, then this pick is recorded.
    if (room.revealed) resetRound(room);

    player.vote = String(card);
    maybeReveal(room);
    broadcast(roomId);
  });

  socket.on('newRound', () => {
    const room = rooms.get(roomId);
    if (!room) return;
    resetRound(room);
    broadcast(roomId);
  });

  // Anyone in the room may kick anyone.
  socket.on('kick', ({ targetId }) => {
    const room = rooms.get(roomId);
    if (!room || !room.players.has(targetId)) return;
    io.to(targetId).emit('kicked');
    const target = io.sockets.sockets.get(targetId);
    if (target) target.leave(roomId);
    room.players.delete(targetId);
    maybeReveal(room);
    broadcast(roomId);
  });

  socket.on('reaction', ({ targetId, emoji }) => {
    if (!roomId) return;
    io.to(roomId).emit('reaction', { from: socket.id, targetId, emoji });
  });

  socket.on('leave', cleanup);
  socket.on('disconnect', cleanup);

  function cleanup() {
    const room = rooms.get(roomId);
    if (!room) return;
    room.players.delete(socket.id);
    if (room.players.size === 0) {
      rooms.delete(roomId);
    } else {
      maybeReveal(room);
      broadcast(roomId);
    }
    roomId = null;
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Pokering running on http://localhost:${PORT}`);
});
