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
  const all = [...room.players.values()];
  const anyShown = all.some((p) => p.shown);
  const allShown = all.length > 0 && all.every((p) => p.shown);

  const players = [...room.players.entries()].map(([id, p]) => ({
    id,
    name: p.name,
    hasVoted: p.vote !== null,
    shown: p.shown,
    // Only expose the actual value for players whose card is face-up.
    vote: p.shown ? p.vote : null,
  }));

  // Stats cover the cards currently face-up (all of them once fully revealed,
  // a subset while some players are re-voting).
  let stats = null;
  if (anyShown) {
    const values = all.filter((p) => p.shown).map((p) => p.vote);
    const numeric = values.filter((v) => v !== '?' && v !== '☕' && !isNaN(parseFloat(v))).map(Number);
    const average = numeric.length
      ? Math.round((numeric.reduce((a, b) => a + b, 0) / numeric.length) * 10) / 10
      : null;
    const consensus = allShown && values.length > 1 && values.every((v) => v === values[0]);
    stats = { average, consensus, votedCount: values.length };
  }

  return { revealed: allShown, anyShown, players, stats };
}

function broadcast(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  io.to(roomId).emit('state', buildState(room));
}

// Flip every card face-up once everyone has voted AND nobody is currently
// shown. This fires on the first full round, and again only after a complete
// re-vote cycle — so a single person re-voting does NOT re-reveal the room.
function maybeReveal(room) {
  const players = [...room.players.values()];
  const allVoted = players.length > 0 && players.every((p) => p.vote !== null);
  const anyShown = players.some((p) => p.shown);
  if (allVoted && !anyShown) {
    players.forEach((p) => {
      p.shown = true;
    });
  }
}

function resetRound(room) {
  room.players.forEach((p) => {
    p.vote = null;
    p.shown = false;
  });
}

io.on('connection', (socket) => {
  let roomId = null;

  socket.on('join', ({ room, name }) => {
    roomId = String(room || '').trim().toLowerCase() || 'default';
    const displayName = String(name || '').trim().slice(0, 24) || 'Anon';
    socket.join(roomId);
    const roomObj = getRoom(roomId);
    roomObj.players.set(socket.id, { name: displayName, vote: null, shown: false });
    socket.emit('joined', { id: socket.id, roomId });
    broadcast(roomId);
  });

  socket.on('vote', ({ card }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player) return;

    // Picking a card always hides just YOUR card (so a re-vote after the
    // reveal re-conceals only you — everyone else keeps their revealed card
    // until they choose to change too).
    player.vote = String(card);
    player.shown = false;
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
