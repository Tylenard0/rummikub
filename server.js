/**
 * Parsons Family Rummikub — PWA Server
 * Run: node server.js
 */

const http = require('http');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

// ─── Static file server ───────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.css': 'text/css',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  let urlPath = req.url.split('?')[0];

  if (urlPath === '/') urlPath = '/index.html';
  // Let Socket.IO handle its own requests
  if (urlPath.startsWith('/socket.io/')) return;
  const filePath = path.join(__dirname, 'public', urlPath);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    return res.end(fs.readFileSync(filePath));
  }

  // For navigation requests (no extension), serve the SPA shell
  const ext = path.extname(urlPath);
  if (!ext) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
  }

  // Unknown asset — return 404
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

const { Server } = require('socket.io');
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 120000,       // 2 min — tolerate slow mobile connections
  pingInterval: 20000,       // ping every 20s
  upgradeTimeout: 30000,
  maxHttpBufferSize: 1e6,
});

// ─── Constants ────────────────────────────────────────────────────────────────
const COLORS           = ['red', 'blue', 'orange', 'black'];
const TILES_PER_PLAYER = 14;
const MAX_PLAYERS      = 6;
const MIN_PLAYERS      = 2;
const DEFAULT_RULES    = { initialMeldMin: 30, turnTimer: 0 };
const AVATAR_COLORS    = ['#e05050','#4a90d9','#e07820','#50c878','#9b59b6','#e8c84a'];

// ─── Tiles ────────────────────────────────────────────────────────────────────
function createTileSet() {
  const tiles = []; let id = 0;
  for (let copy = 0; copy < 2; copy++)
    for (const color of COLORS)
      for (let num = 1; num <= 13; num++)
        tiles.push({ id: id++, color, num, isJoker: false });
  tiles.push({ id: id++, color: 'joker', num: 0, isJoker: true });
  tiles.push({ id: id++, color: 'joker', num: 0, isJoker: true });
  return tiles;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─── Validation ───────────────────────────────────────────────────────────────
function isValidGroup(tiles) {
  if (tiles.length < 3 || tiles.length > 4) return false;
  const nj = tiles.filter(t => !t.isJoker);
  if (!nj.length) return false;
  const num = nj[0].num; const cols = new Set();
  for (const t of nj) { if (t.num !== num) return false; if (cols.has(t.color)) return false; cols.add(t.color); }
  return true;
}

function isValidRun(tiles) {
  if (tiles.length < 3) return false;
  const nj = tiles.filter(t => !t.isJoker); const jc = tiles.length - nj.length;
  if (!nj.length) return false;
  const color = nj[0].color;
  for (const t of nj) { if (t.color !== color) return false; }
  const nums = nj.map(t => t.num).sort((a,b) => a-b);
  for (let i = 1; i < nums.length; i++) { if (nums[i] === nums[i-1]) return false; }
  let j = jc;
  for (let i = 1; i < nums.length; i++) { j -= (nums[i]-nums[i-1]-1); if (j < 0) return false; }
  const span = nums[nums.length-1] - nums[0] + 1 + j;
  return span === tiles.length && nums[0] >= 1 && nums[nums.length-1] <= 13;
}

function isValidSet(tiles) { return isValidGroup(tiles) || isValidRun(tiles); }

function setPoints(tiles) {
  return tiles.filter(t => !t.isJoker).reduce((s,t) => s+t.num, 0)
       + tiles.filter(t => t.isJoker).length * 30;
}

function rackPoints(rack) {
  return rack.reduce((s,t) => s + (t.isJoker ? 30 : t.num), 0);
}

function validateBoard(sets) {
  for (const set of sets)
    if (!isValidSet(set))
      return { valid: false, msg: `Invalid set: [${set.map(t => t.isJoker ? 'J' : t.num).join(',')}]` };
  return { valid: true };
}

// ─── Rooms ────────────────────────────────────────────────────────────────────
const rooms = {};

function createRoom(roomId) {
  return {
    id: roomId, phase: 'lobby',
    players: [], board: [], pool: [],
    currentPlayerIndex: 0, turnSnapshot: null,
    log: [], winner: null, winnerScores: null,
    rules: { ...DEFAULT_RULES },
    palette: 'classic',
    createdAt: Date.now(),
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [id, room] of Object.entries(rooms))
    if (room.players.length === 0 && now - room.createdAt > 7_200_000)
      delete rooms[id];
}, 300_000);

// ─── Game logic ───────────────────────────────────────────────────────────────
function startGame(room) {
  room.pool = shuffle(createTileSet());
  room.board = []; room.phase = 'playing';
  room.currentPlayerIndex = 0; room.winner = null; room.winnerScores = null;
  const ruleDesc = room.rules.initialMeldMin === 0
    ? '⚡ House rule active: no initial meld minimum!'
    : `Initial meld minimum: ${room.rules.initialMeldMin} pts`;
  room.log = [`🎲 Game started! ${ruleDesc}`];
  for (const p of room.players) {
    p.rack = []; p.hasInitialMeld = false;
    for (let i = 0; i < TILES_PER_PLAYER; i++) p.rack.push(room.pool.pop());
  }
}

function drawTile(room, playerId) {
  const player = room.players.find(p => p.id === playerId);
  if (!player) return { error: 'Player not found' };
  if (room.players[room.currentPlayerIndex].id !== playerId) return { error: 'Not your turn' };
  if (room.pool.length === 0) return { error: 'Pool is empty' };
  player.rack.push(room.pool.pop());
  room.log.push(`${player.name} drew a tile.`);
  advanceTurn(room);
  return { ok: true };
}

function playTurn(room, playerId, newBoard) {
  const player = room.players.find(p => p.id === playerId);
  if (!player) return { error: 'Player not found' };
  if (room.players[room.currentPlayerIndex].id !== playerId) return { error: 'Not your turn' };

  const check = validateBoard(newBoard);
  if (!check.valid) return { error: check.msg };

  const flatNew    = newBoard.flat();
  const flatOld    = room.board.flat();
  const oldIds     = new Set(flatOld.map(t => t.id));
  const tilesAdded = flatNew.filter(t => !oldIds.has(t.id));

  if (tilesAdded.length === 0) return { error: 'Play at least one tile, or draw' };

  const rackIds = new Set(player.rack.map(t => t.id));
  for (const t of tilesAdded)
    if (!rackIds.has(t.id)) return { error: 'Tile not in your rack' };

  if (!player.hasInitialMeld) {
    const newIdSet = new Set(flatNew.map(t => t.id));
    for (const t of flatOld)
      if (!newIdSet.has(t.id))
        return { error: 'Cannot rearrange existing tiles before your initial meld' };

    const pts = tilesAdded.reduce((s,t) => s + (t.isJoker ? 30 : t.num), 0);
    const min = room.rules.initialMeldMin;
    if (min > 0 && pts < min)
      return { error: `Initial meld must total ≥${min} pts (yours: ${pts})` };

    player.hasInitialMeld = true;
    room.log.push(`${player.name} made their initial meld! (${pts} pts)`);
  }

  const usedIds = new Set(tilesAdded.map(t => t.id));
  player.rack = player.rack.filter(t => !usedIds.has(t.id));
  room.board = newBoard;
  room.log.push(`${player.name} played ${tilesAdded.length} tile(s).`);

  if (player.rack.length === 0) {
    room.phase = 'ended';
    room.winner = player.name;
    room.winnerScores = room.players.map(p => ({
      name: p.name, avatarColor: p.avatarColor,
      rackCount: p.rack.length, points: rackPoints(p.rack),
    }));
    room.log.push(`🏆 ${player.name} wins!`);
    return { ok: true, winner: player.name };
  }

  advanceTurn(room);
  return { ok: true };
}

function advanceTurn(room) {
  room.currentPlayerIndex = (room.currentPlayerIndex + 1) % room.players.length;
  const next = room.players[room.currentPlayerIndex];
  room.turnSnapshot = {
    board: JSON.parse(JSON.stringify(room.board)),
    rack:  JSON.parse(JSON.stringify(next.rack)),
  };
  room.log.push(`It's ${next.name}'s turn.`);
}

function undoTurn(room, playerId) {
  const player = room.players.find(p => p.id === playerId);
  if (!player) return { error: 'Player not found' };
  if (room.players[room.currentPlayerIndex].id !== playerId) return { error: 'Not your turn' };
  if (!room.turnSnapshot) return { error: 'Nothing to undo' };
  room.board  = JSON.parse(JSON.stringify(room.turnSnapshot.board));
  player.rack = JSON.parse(JSON.stringify(room.turnSnapshot.rack));
  return { ok: true };
}

// ─── Remove a player from a game (boot, quit, or disconnect handling) ─────────
function removePlayer(room, idx) {
  const player = room.players[idx];

  if (room.phase === 'playing') {
    // Return tiles to pool and shuffle
    room.pool.push(...player.rack);
    for (let i = room.pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [room.pool[i], room.pool[j]] = [room.pool[j], room.pool[i]];
    }

    const wasTheirTurn = room.currentPlayerIndex === idx;
    room.players.splice(idx, 1);

    if (room.players.length < 2) {
      room.phase = 'ended';
      room.winner = room.players[0]?.name || 'Nobody';
      room.winnerScores = room.players.map(p => ({
        name: p.name, avatarColor: p.avatarColor,
        rackCount: p.rack.length, points: rackPoints(p.rack),
      }));
      room.log.push('Not enough players. Game over!');
    } else {
      if (wasTheirTurn) {
        // Wrap index to stay in bounds — this player is now gone so the
        // player at this index IS the next player already; just set snapshot.
        room.currentPlayerIndex = room.currentPlayerIndex % room.players.length;
        const next = room.players[room.currentPlayerIndex];
        room.turnSnapshot = {
          board: JSON.parse(JSON.stringify(room.board)),
          rack:  JSON.parse(JSON.stringify(next.rack)),
        };
        room.log.push(`It's ${next.name}'s turn.`);
      } else if (idx < room.currentPlayerIndex) {
        // Removed player was before the current player — shift index back
        room.currentPlayerIndex--;
      }
      // If idx > currentPlayerIndex: no change needed
    }
  } else {
    room.players.splice(idx, 1);
  }
}

function safeState(room, forPlayerId) {
  return {
    id: room.id, phase: room.phase,
    board: room.board, pool: room.pool.length,
    currentPlayerIndex: room.currentPlayerIndex,
    winner: room.winner, winnerScores: room.winnerScores,
    log: room.log.slice(-30), rules: room.rules, palette: room.palette,
    players: room.players.map(p => ({
      id: p.id, name: p.name,
      avatarColor: p.avatarColor || AVATAR_COLORS[0],
      rackCount: p.rack.length, hasInitialMeld: p.hasInitialMeld,
      rack: p.id === forPlayerId ? p.rack : undefined,
    })),
  };
}

function broadcastState(room) {
  for (const p of room.players)
    io.to(p.id).emit('state', safeState(room, p.id));
}

// ─── Socket.IO ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('create_room', ({ name, avatarColor }, cb) => {
    if (!name?.trim()) return cb?.({ error: 'Name required' });
    const roomId = Math.random().toString(36).slice(2, 7).toUpperCase();
    rooms[roomId] = createRoom(roomId);
    const room = rooms[roomId];
    room.players.push({ id: socket.id, name: name.trim(), avatarColor: avatarColor || AVATAR_COLORS[0], rack: [], hasInitialMeld: false });
    socket.join(roomId); currentRoom = roomId;
    cb?.({ ok: true, roomId });
    broadcastState(room);
  });

  socket.on('join_room', ({ roomId, name, avatarColor }, cb) => {
    const room = rooms[roomId?.toUpperCase()];
    if (!room) return cb?.({ error: 'Room not found' });
    if (room.phase !== 'lobby') return cb?.({ error: 'Game already started' });
    if (room.players.length >= MAX_PLAYERS) return cb?.({ error: `Room full (max ${MAX_PLAYERS})` });
    if (room.players.find(p => p.name === name?.trim())) return cb?.({ error: 'Name already taken' });
    const autoColor = AVATAR_COLORS[room.players.length % AVATAR_COLORS.length];
    room.players.push({ id: socket.id, name: name.trim(), avatarColor: avatarColor || autoColor, rack: [], hasInitialMeld: false });
    socket.join(roomId.toUpperCase()); currentRoom = roomId.toUpperCase();
    cb?.({ ok: true, roomId: currentRoom });
    broadcastState(room);
  });

  socket.on('set_rules', ({ rules }, cb) => {
    const room = rooms[currentRoom];
    if (!room) return cb?.({ error: 'Room not found' });
    if (room.players[0]?.id !== socket.id) return cb?.({ error: 'Only host can change rules' });
    if (room.phase !== 'lobby') return cb?.({ error: 'Cannot change rules mid-game' });
    if (typeof rules.initialMeldMin === 'number')
      room.rules.initialMeldMin = Math.max(0, Math.min(100, rules.initialMeldMin));
    if (typeof rules.turnTimer === 'number')
      room.rules.turnTimer = [0, 30, 60, 90, 120].includes(rules.turnTimer) ? rules.turnTimer : 0;
    cb?.({ ok: true });
    broadcastState(room);
  });

  socket.on('start_game', (_, cb) => {
    const room = rooms[currentRoom];
    if (!room) return cb?.({ error: 'Room not found' });
    if (room.players[0].id !== socket.id) return cb?.({ error: 'Only the host can start' });
    if (room.players.length < MIN_PLAYERS) return cb?.({ error: `Need at least ${MIN_PLAYERS} players` });
    startGame(room);
    room.turnSnapshot = { board: [], rack: JSON.parse(JSON.stringify(room.players[0].rack)) };
    cb?.({ ok: true });
    broadcastState(room);
  });

  socket.on('rematch', (_, cb) => {
    const room = rooms[currentRoom];
    if (!room) return cb?.({ error: 'Room not found' });
    if (room.players[0]?.id !== socket.id) return cb?.({ error: 'Only host can start rematch' });
    room.phase = 'lobby'; room.board = []; room.pool = [];
    room.winner = null; room.winnerScores = null;
    room.log = ['🔄 Rematch! Waiting to start again…'];
    for (const p of room.players) { p.rack = []; p.hasInitialMeld = false; }
    cb?.({ ok: true });
    broadcastState(room);
  });

  socket.on('draw_tile',   (_, cb)        => { const r = rooms[currentRoom]; if (!r) return cb?.({ error: 'Room not found' }); cb?.(drawTile(r, socket.id));          broadcastState(r); });
  socket.on('play_turn',   ({ board }, cb) => { const r = rooms[currentRoom]; if (!r) return cb?.({ error: 'Room not found' }); cb?.(playTurn(r, socket.id, board));   broadcastState(r); });
  socket.on('undo_turn',   (_, cb)        => { const r = rooms[currentRoom]; if (!r) return cb?.({ error: 'Room not found' }); cb?.(undoTurn(r, socket.id)); broadcastState(r); });
  socket.on('request_state', ()           => { const r = rooms[currentRoom]; if (r) socket.emit('state', safeState(r, socket.id)); });

  socket.on('chat', ({ msg }) => {
    const room = rooms[currentRoom];
    if (!room || !msg?.trim()) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    room.log.push(`💬 ${player.name}: ${msg.trim().slice(0, 100)}`);
    broadcastState(room);
  });

  socket.on('reaction', ({ emoji }) => {
    const room = rooms[currentRoom];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    const allowed = ['👏','🔥','😬','🤔','😂','💀'];
    if (!allowed.includes(emoji)) return;
    // Broadcast reaction to all OTHER players (sender handles locally)
    for (const p of room.players) {
      if (p.id !== socket.id)
        io.to(p.id).emit('reaction', { emoji, name: player.name });
    }
  });

  socket.on('set_palette', ({ palette }, cb) => {
    const room = rooms[currentRoom];
    if (!room) return cb?.({ error: 'Room not found' });
    if (room.players[0]?.id !== socket.id) return cb?.({ error: 'Only host can change palette' });
    const valid = ['classic','jewel','pastel','colorblind','neon'];
    if (!valid.includes(palette)) return cb?.({ error: 'Invalid palette' });
    room.palette = palette;
    cb?.({ ok: true });
    broadcastState(room);
  });

  socket.on('quit_game', (_, cb) => {
    const room = rooms[currentRoom];
    if (!room) return cb?.({ error: 'Room not found' });
    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx === -1) return cb?.({ error: 'Player not found' });
    const playerName = room.players[idx].name;
    if (room.phase === 'playing')
      room.log.push(`${playerName} left the game. Their tiles returned to the pool.`);
    removePlayer(room, idx);
    socket.leave(currentRoom);
    cb?.({ ok: true });
    broadcastState(room);
  });

  socket.on('boot_player', ({ targetId }, cb) => {
    const room = rooms[currentRoom];
    if (!room) return cb?.({ error: 'Room not found' });
    if (room.players[0]?.id !== socket.id) return cb?.({ error: 'Only the host can boot players' });
    if (socket.id === targetId) return cb?.({ error: 'Cannot boot yourself' });
    const idx = room.players.findIndex(p => p.id === targetId);
    if (idx === -1) return cb?.({ error: 'Player not found' });
    const playerName = room.players[idx].name;
    if (room.phase === 'playing')
      room.log.push(`🚫 ${playerName} was booted. Their tiles returned to the pool.`);
    else
      room.log.push(`🚫 ${playerName} was removed from the lobby.`);
    removePlayer(room, idx);
    io.to(targetId).emit('booted', { msg: 'You were removed from the game by the host.' });
    cb?.({ ok: true });
    broadcastState(room);
  });

  // ── Reconnect: player rejoins with their saved name + roomId after disconnect ──
  socket.on('rejoin_room', ({ roomId, name, avatarColor }, cb) => {
    const room = rooms[roomId?.toUpperCase()];
    if (!room) return cb?.({ error: 'Room not found or expired' });
    if (room.phase === 'ended') return cb?.({ error: 'Game has ended' });

    const existing = room.players.find(p => p.name === name?.trim());
    if (existing) {
      // Swap socket ID to the new connection
      existing.id = socket.id;
      if (avatarColor) existing.avatarColor = avatarColor;
      socket.join(roomId.toUpperCase());
      currentRoom = roomId.toUpperCase();
      cb?.({ ok: true, roomId: currentRoom, rejoined: true });
      room.log.push(`🔄 ${name} reconnected.`);
      broadcastState(room);
    } else if (room.phase === 'lobby' && room.players.length < MAX_PLAYERS) {
      // Name not found but lobby still open — treat as fresh join
      const autoColor = AVATAR_COLORS[room.players.length % AVATAR_COLORS.length];
      room.players.push({ id: socket.id, name: name.trim(), avatarColor: avatarColor || autoColor, rack: [], hasInitialMeld: false });
      socket.join(roomId.toUpperCase());
      currentRoom = roomId.toUpperCase();
      cb?.({ ok: true, roomId: currentRoom, rejoined: false });
      broadcastState(room);
    } else {
      cb?.({ error: 'Could not rejoin — game in progress and name not recognised' });
    }
  });

  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const room = rooms[currentRoom];
    if (!room) return;
    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx === -1) return;
    const name = room.players[idx].name;
    if (room.phase === 'lobby') {
      room.players.splice(idx, 1);
    } else if (room.phase === 'ended') {
      // Game over — just remove the player, no need to preserve their seat
      room.players.splice(idx, 1);
    } else {
      // In-game: keep the player's seat & tiles for reconnect, just note it
      room.log.push(`⚡ ${name} disconnected — waiting for them to reconnect.`);
    }
    broadcastState(room);
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('\n🎲 Parsons Family Rummikub\n' + '═'.repeat(50));
  console.log(`\n  Local:    http://localhost:${PORT}`);
  for (const addrs of Object.values(os.networkInterfaces()))
    for (const a of addrs)
      if (a.family === 'IPv4' && !a.internal)
        console.log(`  LAN:      http://${a.address}:${PORT}  ← share with iPads on same WiFi`);
  console.log(`
  ── Internet Access ──────────────────────────────
  ngrok:       npx ngrok http ${PORT}
  Cloudflare:  npx cloudflared tunnel --url http://localhost:${PORT}
  Permanent:   push to GitHub → connect on render.com
${'═'.repeat(50)}\n`);
});
