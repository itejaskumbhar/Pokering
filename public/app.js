const socket = io();

const CARDS = ['0', '1', '2', '3', '5', '8', '13', '21', '34', '55', '89', '?', '☕'];
const REACTIONS = ['🎯', '✈️', '💰', '❤️', '😊'];

let myId = null;
let myVote = null; // local memory of my current pick (server hides it from others while voting)

// ---- elements ----
const loginSection = document.getElementById('login');
const roomSection = document.getElementById('room');
const loginForm = document.getElementById('login-form');
const nameInput = document.getElementById('name-input');
const roomInput = document.getElementById('room-input');
const loginMsg = document.getElementById('login-msg');

const roomLabel = document.getElementById('room-label');
const votedCount = document.getElementById('voted-count');
const totalCount = document.getElementById('total-count');
const rowTop = document.getElementById('row-top');
const rowBottom = document.getElementById('row-bottom');
const tableMsg = document.getElementById('table-msg');
const deck = document.getElementById('deck');
const newRoundBtn = document.getElementById('new-round-btn');
const leaveBtn = document.getElementById('leave-btn');

// remember last used name/room
nameInput.value = localStorage.getItem('pk-name') || '';
roomInput.value = localStorage.getItem('pk-room') || '';

// ---- deck (built once) ----
CARDS.forEach((value) => {
  const card = document.createElement('button');
  card.className = 'deck-card';
  card.dataset.value = value;
  card.textContent = value;
  card.addEventListener('click', () => {
    myVote = value;
    socket.emit('vote', { card: value });
    highlightDeck();
  });
  deck.appendChild(card);
});

function highlightDeck() {
  deck.querySelectorAll('.deck-card').forEach((c) => {
    c.classList.toggle('selected', c.dataset.value === myVote);
  });
}

// ---- login ----
loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = nameInput.value.trim();
  const room = roomInput.value.trim();
  if (!name || !room) return;
  localStorage.setItem('pk-name', name);
  localStorage.setItem('pk-room', room);
  socket.emit('join', { name, room });
});

leaveBtn.addEventListener('click', () => {
  socket.emit('leave');
  showLogin();
});

newRoundBtn.addEventListener('click', () => socket.emit('newRound'));

// ---- socket events ----
socket.on('joined', ({ id, roomId }) => {
  myId = id;
  myVote = null;
  roomLabel.textContent = roomId;
  loginSection.hidden = true;
  roomSection.hidden = false;
  loginMsg.hidden = true;
});

socket.on('state', render);

socket.on('kicked', () => {
  showLogin('You were removed from the room.');
});

socket.on('reaction', ({ targetId, emoji }) => {
  const seat = document.querySelector(`.seat[data-id="${targetId}"]`);
  if (!seat) return;
  const fly = document.createElement('div');
  fly.className = 'reaction-fly';
  fly.textContent = emoji;
  seat.appendChild(fly);
  setTimeout(() => fly.remove(), 1100);
});

function showLogin(message) {
  roomSection.hidden = true;
  loginSection.hidden = false;
  myVote = null;
  if (message) {
    loginMsg.textContent = message;
    loginMsg.hidden = false;
  }
}

// ---- render ----
function render(state) {
  const { players, anyShown, stats } = state;

  // clear my selection if a new round wiped my vote
  const me = players.find((p) => p.id === myId);
  if (me && !me.hasVoted) myVote = null;
  highlightDeck();

  // counts
  const voted = players.filter((p) => p.hasVoted).length;
  votedCount.textContent = voted;
  totalCount.textContent = players.length;
  newRoundBtn.hidden = !anyShown;

  // seats: split around the table
  rowTop.innerHTML = '';
  rowBottom.innerHTML = '';
  const half = Math.ceil(players.length / 2);
  players.forEach((p, i) => {
    const seat = buildSeat(p);
    (i < half ? rowTop : rowBottom).appendChild(seat);
  });

  // center message — tally of how many cards landed on each value
  if (!anyShown) {
    tableMsg.innerHTML = 'Pick your cards!';
  } else {
    const counts = (stats && stats.counts) || {};
    const items = CARDS.filter((v) => counts[v])
      .map(
        (v) =>
          `<div class="tally-item"><span class="tally-card">${v}</span><span class="tally-count">${counts[v]}</span></div>`
      )
      .join('');
    let html = `<div class="tally">${items}</div><span class="sub">${stats.votedCount} card${stats.votedCount === 1 ? '' : 's'} revealed</span>`;
    if (stats && stats.consensus) html += `<div class="agree">Everyone agrees! 🎉</div>`;
    tableMsg.innerHTML = html;
  }
}

function buildSeat(player) {
  const seat = document.createElement('div');
  seat.className = 'seat' + (player.id === myId ? ' is-you' : '');
  seat.dataset.id = player.id;

  const card = document.createElement('div');
  card.className = 'seat-card';
  if (player.shown && player.vote !== null) {
    card.classList.add('revealed');
    card.textContent = player.vote;
  } else if (player.hasVoted) {
    card.classList.add('back');
  } else if (player.id === myId) {
    card.classList.add('you-waiting');
  } else {
    card.classList.add('empty');
  }

  const name = document.createElement('div');
  name.className = 'seat-name';
  name.textContent = player.name;

  // hover toolbar (reactions + kick) — not shown on yourself
  if (player.id !== myId) {
    const tools = document.createElement('div');
    tools.className = 'seat-tools';
    REACTIONS.forEach((emoji) => {
      const b = document.createElement('button');
      b.textContent = emoji;
      b.title = 'Send reaction';
      b.addEventListener('click', () => socket.emit('reaction', { targetId: player.id, emoji }));
      tools.appendChild(b);
    });
    const kick = document.createElement('button');
    kick.className = 'kick';
    kick.textContent = '🗑';
    kick.title = 'Kick player out';
    kick.addEventListener('click', () => {
      if (confirm(`Kick ${player.name} out of the room?`)) socket.emit('kick', { targetId: player.id });
    });
    tools.appendChild(kick);
    seat.appendChild(tools);
  }

  seat.appendChild(card);
  seat.appendChild(name);
  return seat;
}
