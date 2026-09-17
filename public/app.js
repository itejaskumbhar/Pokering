const socket = io();

const CARDS = ['0', '1', '2', '3', '5', '8', '13', '21', '34', '55', '89', '?', '☕'];
const REACTIONS = ['🎯', '✈️', '💰', '❤️', '😊'];

let myId = null;
let myVote = null; // local memory of my current pick (server hides it from others while voting)
let currentRoom = null;
let myRole = 'voter';
let celebrated = false; // confetti fires once per revealed consensus

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
const shareBtn = document.getElementById('share-btn');
const roleToggle = document.getElementById('role-toggle');
const watchingPill = document.getElementById('watching-pill');
const watchingCount = document.getElementById('watching-count');
const spectatorHint = document.getElementById('spectator-hint');

// remember last used name/room
nameInput.value = localStorage.getItem('pk-name') || '';
roomInput.value = localStorage.getItem('pk-room') || '';

// a shared link like ?room=sprint7 pre-fills the room so the invitee only
// has to type their name
const linkRoom = new URLSearchParams(location.search).get('room');
if (linkRoom) {
  roomInput.value = linkRoom;
  // focus the name field since the room is already filled in
  setTimeout(() => nameInput.focus(), 0);
}

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

// toggle myself between voting and spectating
roleToggle.addEventListener('change', () => {
  socket.emit('setRole', { spectator: roleToggle.checked });
});

// copy an invite link for the current room to the clipboard
shareBtn.addEventListener('click', async () => {
  if (!currentRoom) return;
  const url = `${location.origin}${location.pathname}?room=${encodeURIComponent(currentRoom)}`;
  let ok = false;
  try {
    await navigator.clipboard.writeText(url);
    ok = true;
  } catch {
    // fallback for non-secure contexts where the clipboard API is blocked
    const tmp = document.createElement('input');
    tmp.value = url;
    document.body.appendChild(tmp);
    tmp.select();
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    tmp.remove();
  }
  if (ok) {
    shareBtn.textContent = '✓ Link copied!';
    shareBtn.classList.add('copied');
    setTimeout(() => {
      shareBtn.textContent = '🔗 Share link';
      shareBtn.classList.remove('copied');
    }, 1600);
  } else {
    window.prompt('Copy this invite link:', url);
  }
});

// ---- socket events ----
socket.on('joined', ({ id, roomId }) => {
  myId = id;
  myVote = null;
  currentRoom = roomId;
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
  const { players, anyShown, stats, votersTotal, votersVoted, watching } = state;

  const me = players.find((p) => p.id === myId);
  const amSpectator = !!(me && me.role === 'spectator');
  myRole = amSpectator ? 'spectator' : 'voter';
  // clear my selection if a new round wiped my vote (or I switched to watching)
  if (!me || !me.hasVoted) myVote = null;
  highlightDeck();

  // role toggle + deck visibility for me
  roleToggle.checked = amSpectator;
  deck.hidden = amSpectator;
  spectatorHint.hidden = !amSpectator;

  // counts: voters only, plus a separate watcher tally
  votedCount.textContent = votersVoted;
  totalCount.textContent = votersTotal;
  watchingPill.hidden = !watching;
  watchingCount.textContent = watching;
  newRoundBtn.hidden = !anyShown;

  // celebrate consensus once per reveal
  const consensus = !!(anyShown && stats && stats.consensus);
  if (consensus && !celebrated) {
    launchConfetti();
    celebrated = true;
  }
  if (!anyShown) celebrated = false;

  // seats: split around the table
  rowTop.innerHTML = '';
  rowBottom.innerHTML = '';
  const half = Math.ceil(players.length / 2);
  players.forEach((p, i) => {
    const seat = buildSeat(p);
    (i < half ? rowTop : rowBottom).appendChild(seat);
  });

  // center message
  if (votersTotal === 0) {
    tableMsg.innerHTML = '<span class="wait">Waiting for voters…</span>';
  } else if (!anyShown) {
    tableMsg.innerHTML = 'Pick your cards!';
  } else {
    const counts = (stats && stats.counts) || {};
    const values = CARDS.filter((v) => counts[v]);
    const max = Math.max(1, ...values.map((v) => counts[v]));
    const MAX_H = 72;
    const cols = values
      .map((v) => {
        const h = Math.max(12, Math.round((counts[v] / max) * MAX_H));
        const cls = counts[v] === max ? ' mode' : '';
        const votes = counts[v] === 1 ? '1 vote' : `${counts[v]} votes`;
        return `<div class="tally-col${cls}"><span class="tally-n">${votes}</span><span class="tally-bar${cls}" style="height:${h}px"></span><span class="tally-val">${v}</span><span class="tally-cap">points</span></div>`;
      })
      .join('');
    let html = `<div class="tally-title">Results — votes per estimate</div><div class="tally">${cols}</div><span class="sub">${stats.votedCount} of ${votersTotal} revealed</span>`;
    if (stats && stats.consensus) html += `<div class="agree">Everyone agrees!</div>`;
    tableMsg.innerHTML = html;
  }
}

function buildSeat(player) {
  const seat = document.createElement('div');
  seat.className = 'seat' + (player.id === myId ? ' is-you' : '');
  seat.dataset.id = player.id;

  const card = document.createElement('div');
  card.className = 'seat-card';
  if (player.role === 'spectator') {
    card.classList.add('spectator'); // eye badge, no card — just watching
  } else if (player.shown && player.vote !== null) {
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
  if (player.role === 'spectator') name.classList.add('is-spectator');

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

// ---- confetti ----
function launchConfetti() {
  const layer = document.getElementById('confetti');
  if (!layer) return;
  const colors = ['#2f6fed', '#f4623a', '#37b24d', '#f7b500', '#e64980', '#1e56c9'];
  for (let i = 0; i < 90; i++) {
    const p = document.createElement('span');
    p.className = 'confetti-piece';
    p.style.left = Math.random() * 100 + 'vw';
    p.style.background = colors[i % colors.length];
    p.style.animationDelay = Math.random() * 0.3 + 's';
    p.style.animationDuration = 2.2 + Math.random() * 1.6 + 's';
    p.style.setProperty('--x', Math.random() * 240 - 120 + 'px');
    p.style.setProperty('--r', Math.random() * 720 - 360 + 'deg');
    const w = 6 + Math.random() * 6;
    p.style.width = w + 'px';
    p.style.height = w * 1.6 + 'px';
    layer.appendChild(p);
    setTimeout(() => p.remove(), 4200);
  }
}
