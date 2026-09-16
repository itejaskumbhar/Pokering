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
  // Only voters take part in the round; spectators just watch.
  const voters = all.filter((p) => p.role === 'voter');
  const anyShown = voters.some((p) => p.shown);
  const allShown = voters.length > 0 && voters.every((p) => p.shown);

  const players = [...room.players.entries()].map(([id, p]) => ({
    id,
    name: p.name,
    role: p.role,
    hasVoted: p.role === 'voter' && p.vote !== null,
    shown: p.shown,
    // Only expose the actual value for players whose card is face-up.
    vote: p.shown ? p.vote : null,
  }));

  // Stats cover the cards currently face-up (all of them once fully revealed,
  // a subset while some players are re-voting). We report how many cards fell
  // on each value, e.g. { "5": 2, "13": 3 }.
  let stats = null;
  if (anyShown) {
    const values = voters.filter((p) => p.shown).map((p) => p.vote);
    const counts = {};
    values.forEach((v) => {
      counts[v] = (counts[v] || 0) + 1;
    });
    const consensus = allShown && values.length > 1 && Object.keys(counts).length === 1;
    stats = { counts, consensus, votedCount: values.length };
  }

  return {
    revealed: allShown,
    anyShown,
    players,
    stats,
    votersTotal: voters.length,
    votersVoted: voters.filter((p) => p.vote !== null).length,
    watching: all.length - voters.length,
  };
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
  // Reveal is decided by voters only — spectators never block it.
  const voters = [...room.players.values()].filter((p) => p.role === 'voter');
  const allVoted = voters.length > 0 && voters.every((p) => p.vote !== null);
  const anyShown = voters.some((p) => p.shown);
  if (allVoted && !anyShown) {
    voters.forEach((p) => {
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
    roomObj.players.set(socket.id, { name: displayName, vote: null, shown: false, role: 'voter' });
    // A new participant means a new estimation context: clear the round so
    // everyone (re)votes fresh. Prevents a stale/partial reveal from an early
    // voter getting stuck when others join afterwards.
    resetRound(roomObj);
    socket.emit('joined', { id: socket.id, roomId });
    broadcast(roomId);
  });

  socket.on('vote', ({ card }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player || player.role !== 'voter') return; // spectators can't vote

    // Picking a card always hides just YOUR card (so a re-vote after the
    // reveal re-conceals only you — everyone else keeps their revealed card
    // until they choose to change too).
    player.vote = String(card);
    player.shown = false;
    maybeReveal(room);
    broadcast(roomId);
  });

  // Switch between voting and spectating without leaving the room.
  socket.on('setRole', ({ spectator }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player) return;
    player.role = spectator ? 'spectator' : 'voter';
    if (spectator) {
      // Leaving the voting pool: drop their card and re-check the reveal, in
      // case they were the last voter the room was waiting on.
      player.vote = null;
      player.shown = false;
    }
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
