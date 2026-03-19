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

// ─── Bot helpers ──────────────────────────────────────────────────────────────

/**
 * Three difficulty tiers. Each tier builds on the previous one:
 *
 *  easy   – picks the FIRST valid meld found (no optimisation); never
 *            extends existing board sets; draws immediately when stuck.
 *            Thinks for 2.5 s so it feels human-slow.
 *
 *  medium – greedy: plays the meld that uses the most tiles, then most
 *            points. Extends board runs/groups with rack tiles.
 *            Thinks for 1.5 s.
 *
 *  hard   – strategic: plays the meld that leaves the lowest-value tiles
 *            on the rack (minimises points held = minimises loss penalty);
 *            extends board sets; will split existing board sets to create
 *            new plays; and draws only when truly stuck.
 *            Thinks for 0.8 s so it feels snappy and confident.
 */
const BOT_DIFFICULTY = { easy: 'easy', medium: 'medium', hard: 'hard' };

const BOT_NAMES_BY_DIFF = {
  easy:   ['😊 Robby', '😊 Byte',  '😊 Chip',  '😊 Pixel',  '😊 Glitch'],
  medium: ['🤖 Robby', '🤖 Byte',  '🤖 Chip',  '🤖 Pixel',  '🤖 Glitch'],
  hard:   ['😈 Robby', '😈 Byte',  '😈 Chip',  '😈 Pixel',  '😈 Glitch'],
};
const BOT_COLORS  = ['#7f8c8d','#27ae60','#8e44ad','#16a085','#d35400'];
/** Delay (ms) before a bot acts — varies by difficulty for feel. */
const BOT_THINK_MS = { easy: 2500, medium: 1500, hard: 800 };

let botCounter = 0;
function makeBotId() { return `bot_${Date.now()}_${botCounter++}`; }

// ── Meld finders ──────────────────────────────────────────────────────────────

/** Find every valid 3+-tile meld that can be formed purely from `tiles`. */
function findMeldsFromTiles(tiles) {
  const results = [];

  // Groups: same number, different colours, 3–4 tiles
  const byNum = {};
  for (const t of tiles) {
    if (t.isJoker) continue;
    (byNum[t.num] = byNum[t.num] || []).push(t);
  }
  const jokers = tiles.filter(t => t.isJoker);

  for (const [, group] of Object.entries(byNum)) {
    const byColor = {};
    for (const t of group) byColor[t.color] = t;
    const uniq = Object.values(byColor);
    for (let sz = 3; sz <= 4; sz++) {
      if (uniq.length >= sz)
        results.push(uniq.slice(0, sz));
      if (uniq.length + jokers.length >= sz && uniq.length < sz)
        results.push([...uniq, ...jokers.slice(0, sz - uniq.length)]);
    }
  }

  // Runs: same colour, consecutive numbers
  const byColor = {};
  for (const t of tiles) {
    if (t.isJoker) continue;
    (byColor[t.color] = byColor[t.color] || []).push(t);
  }
  for (const [, colorTiles] of Object.entries(byColor)) {
    const sorted = colorTiles.slice().sort((a, b) => a.num - b.num);
    for (let i = 0; i < sorted.length; i++) {
      let run = [sorted[i]];
      for (let j = i + 1; j < sorted.length; j++) {
        const last = run[run.length - 1];
        const gap  = sorted[j].num - last.num;
        if (gap === 1) {
          run.push(sorted[j]);
        } else if (gap === 2 && jokers.length > 0) {
          run.push(jokers[0], sorted[j]);
        } else break;
        if (run.length >= 3) results.push([...run]);
      }
    }
  }

  return results;
}

/**
 * Try to extend existing board sets with tiles from `rack`.
 * Returns an array of { newBoard, usedTileIds } candidates.
 * Used by medium and hard bots.
 */
function findBoardExtensions(rack, board) {
  const candidates = [];
  const rackById = new Map(rack.map(t => [t.id, t]));

  for (let si = 0; si < board.length; si++) {
    const set = board[si];
    const nj  = set.filter(t => !t.isJoker);
    if (!nj.length) continue;

    // --- Try extending a run on either end ---
    const allSameColor = nj.every(t => t.color === nj[0].color);
    if (allSameColor) {
      const nums = set.filter(t => !t.isJoker).map(t => t.num).sort((a, b) => a - b);
      const minN = nums[0], maxN = nums[nums.length - 1];
      for (const t of rack) {
        if (t.isJoker || t.color !== nj[0].color) continue;
        const extended = (t.num === minN - 1) ? [t, ...set] : (t.num === maxN + 1) ? [...set, t] : null;
        if (!extended) continue;
        if (!isValidSet(extended)) continue;
        const newBoard = board.map((s, i) => i === si ? extended : s);
        candidates.push({ newBoard, usedTileIds: new Set([t.id]) });
      }
    }

    // --- Try extending a group (add a 4th tile of the same number) ---
    if (!allSameColor && set.length === 3) {
      const num = nj[0].num;
      const usedColors = new Set(nj.map(t => t.color));
      for (const t of rack) {
        if (t.isJoker || t.num !== num || usedColors.has(t.color)) continue;
        const extended = [...set, t];
        if (!isValidSet(extended)) continue;
        const newBoard = board.map((s, i) => i === si ? extended : s);
        candidates.push({ newBoard, usedTileIds: new Set([t.id]) });
      }
    }
  }

  return candidates;
}

/**
 * Hard-mode only: try splitting an existing board run to free a tile slot
 * that allows a rack tile to complete a new meld.
 * Returns an array of { newBoard, usedTileIds } candidates.
 */
function findSplitPlays(rack, board) {
  const candidates = [];

  for (let si = 0; si < board.length; si++) {
    const set = board[si];
    const nj  = set.filter(t => !t.isJoker);
    if (!nj.length) continue;
    const allSameColor = nj.every(t => t.color === nj[0].color);
    if (!allSameColor || set.length < 4) continue;   // only split runs of 4+

    // Try each possible split point
    for (let split = 3; split <= set.length - 3; split++) {
      const left  = set.slice(0, split);
      const right = set.slice(split);
      if (!isValidSet(left) || !isValidSet(right)) continue;

      // With the split in place, try to play from rack into each half
      const boardWithSplit = [...board.slice(0, si), left, right, ...board.slice(si + 1)];
      const rackMelds = findMeldsFromTiles(rack);
      for (const meld of rackMelds) {
        if (setPoints(meld) === 0) continue;
        const usedIds  = new Set(meld.map(t => t.id));
        const newBoard = [...boardWithSplit, meld];
        candidates.push({ newBoard, usedTileIds: usedIds });
      }
    }
  }

  return candidates;
}

// ── Per-difficulty play selectors ─────────────────────────────────────────────

/**
 * EASY – pick the very first meld available; no board manipulation.
 * Intentionally sub-optimal so new players can beat it.
 */
function botPlayEasy(rack, board, hasInitialMeld, minInitial) {
  const melds = findMeldsFromTiles(rack);
  for (const meld of melds) {
    const pts = setPoints(meld);
    if (!hasInitialMeld && pts < minInitial) continue;
    return { newBoard: [...board, meld], usedTileIds: new Set(meld.map(t => t.id)), pts };
  }
  return null;
}

/**
 * MEDIUM – greedy: most tiles played, then most points.
 * Also tries single-tile extensions onto existing board sets.
 */
function botPlayMedium(rack, board, hasInitialMeld, minInitial) {
  // Gather candidates: new melds from rack + board extensions
  let candidates = [];

  const rackMelds = findMeldsFromTiles(rack);
  for (const meld of rackMelds) {
    const pts = setPoints(meld);
    if (!hasInitialMeld && pts < minInitial) continue;
    candidates.push({ newBoard: [...board, meld], usedTileIds: new Set(meld.map(t => t.id)), pts });
  }

  if (hasInitialMeld) {
    for (const ext of findBoardExtensions(rack, board)) {
      ext.pts = [...ext.usedTileIds].reduce((s, id) => {
        const t = rack.find(r => r.id === id);
        return s + (t ? (t.isJoker ? 30 : t.num) : 0);
      }, 0);
      candidates.push(ext);
    }
  }

  if (!candidates.length) return null;

  // Sort: most tiles first, then most points
  candidates.sort((a, b) => b.usedTileIds.size - a.usedTileIds.size || b.pts - a.pts);
  return candidates[0];
}

/**
 * HARD – strategic: minimise the point value left on the rack after playing
 * (i.e. dump the highest-value tiles first).  Also considers board extensions
 * and run-splitting.
 */
function botPlayHard(rack, board, hasInitialMeld, minInitial) {
  let candidates = [];

  const rackMelds = findMeldsFromTiles(rack);
  for (const meld of rackMelds) {
    const pts = setPoints(meld);
    if (!hasInitialMeld && pts < minInitial) continue;
    const usedTileIds = new Set(meld.map(t => t.id));
    const remainingRackPts = rack.filter(t => !usedTileIds.has(t.id))
                                 .reduce((s, t) => s + (t.isJoker ? 30 : t.num), 0);
    candidates.push({ newBoard: [...board, meld], usedTileIds, pts, remainingRackPts });
  }

  if (hasInitialMeld) {
    for (const ext of findBoardExtensions(rack, board)) {
      const remainingRackPts = rack.filter(t => !ext.usedTileIds.has(t.id))
                                   .reduce((s, t) => s + (t.isJoker ? 30 : t.num), 0);
      candidates.push({ ...ext, pts: 0, remainingRackPts });
    }
    for (const sp of findSplitPlays(rack, board)) {
      const remainingRackPts = rack.filter(t => !sp.usedTileIds.has(t.id))
                                   .reduce((s, t) => s + (t.isJoker ? 30 : t.num), 0);
      candidates.push({ ...sp, pts: 0, remainingRackPts });
    }
  }

  if (!candidates.length) return null;

  // Sort: fewest remaining rack points first, then most tiles played as tiebreak
  candidates.sort((a, b) =>
    a.remainingRackPts - b.remainingRackPts || b.usedTileIds.size - a.usedTileIds.size
  );
  return candidates[0];
}

/** Dispatch to the right strategy based on bot.difficulty. */
function botFindBestPlay(bot, board, minInitial) {
  const diff = bot.difficulty || 'medium';
  if (diff === 'easy')   return botPlayEasy  (bot.rack, board, bot.hasInitialMeld, minInitial);
  if (diff === 'hard')   return botPlayHard  (bot.rack, board, bot.hasInitialMeld, minInitial);
  /* medium */           return botPlayMedium(bot.rack, board, bot.hasInitialMeld, minInitial);
}

// ── Bot turn execution ────────────────────────────────────────────────────────

/** Execute one bot turn inside a room. */
function doBotTurn(room) {
  const bot = room.players[room.currentPlayerIndex];
  if (!bot?.isBot) return;

  const result = botFindBestPlay(bot, room.board, room.rules.initialMeldMin);

  if (!result) {
    // Draw a tile
    if (room.pool.length > 0) {
      bot.rack.push(room.pool.pop());
      room.log.push(`${bot.name} drew a tile.`);
    } else {
      room.log.push(`${bot.name} passed (pool empty).`);
    }
    advanceTurn(room);
    return;
  }

  // Play the meld
  if (!bot.hasInitialMeld) {
    bot.hasInitialMeld = true;
    room.log.push(`${bot.name} made their initial meld! (${result.pts} pts)`);
  }
  bot.rack = bot.rack.filter(t => !result.usedTileIds.has(t.id));
  room.board = result.newBoard.map(set => sortSet(set));
  room.log.push(`${bot.name} played ${result.usedTileIds.size} tile(s).`);

  if (bot.rack.length === 0) {
    clearTurnTimer(room);   // don't fire after game ends
    room.phase = 'ended';
    room.winner = bot.name;
    room.winnerScores = room.players.map(p => ({
      name: p.name, avatarColor: p.avatarColor,
      rackCount: p.rack.length, points: rackPoints(p.rack),
    }));
    room.log.push(`🏆 ${bot.name} wins!`);
    return;
  }

  advanceTurn(room);
}

/** After advanceTurn, schedule the bot to play after a difficulty-appropriate delay. */
function maybeTriggerBot(room) {
  const current = room.players[room.currentPlayerIndex];
  if (!current?.isBot || room.phase !== 'playing') return;
  const delay = BOT_THINK_MS[current.difficulty] ?? BOT_THINK_MS.medium;
  setTimeout(() => {
    if (room.phase !== 'playing') return;
    if (!room.players[room.currentPlayerIndex]?.isBot) return;
    doBotTurn(room);
    broadcastState(room);
    // Chain: in case the next player is also a bot
    maybeTriggerBot(room);
  }, delay);
}

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

/** Sort tiles within a set for consistent display: runs by number, groups by color. */
function sortSet(tiles) {
  const nj     = tiles.filter(t => !t.isJoker);
  const jokers = tiles.filter(t =>  t.isJoker);
  if (!nj.length) return tiles;
  const colorOrder = ['red','blue','orange','black'];
  const allSameColor = nj.every(t => t.color === nj[0].color);
  if (allSameColor) {
    // Run: sort by number, then slot jokers into gaps
    const sorted = nj.slice().sort((a, b) => a.num - b.num);
    const result = [...sorted];
    let jLeft = jokers.length;
    for (let i = result.length - 1; i > 0 && jLeft > 0; i--) {
      const gap = result[i].num - result[i - 1].num - 1;
      for (let g = 0; g < gap && jLeft > 0; g++) {
        result.splice(i, 0, jokers[jokers.length - jLeft]);
        jLeft--;
        i++;
      }
    }
    while (jLeft > 0) {
      const last = result.filter(t => !t.isJoker).at(-1);
      if (last && last.num < 13) result.push(jokers[jokers.length - jLeft]);
      else result.unshift(jokers[jokers.length - jLeft]);
      jLeft--;
    }
    return result;
  } else {
    // Group: sort by color order, jokers at end
    return [...nj.sort((a, b) => colorOrder.indexOf(a.color) - colorOrder.indexOf(b.color)), ...jokers];
  }
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
  // Bug 4 fix: set up the first player's snapshot, timestamp and timer
  // inside startGame so nothing is skipped regardless of call site.
  const first = room.players[0];
  room.turnSnapshot = { board: [], rack: JSON.parse(JSON.stringify(first.rack)) };
  room.turnStartedAt = Date.now();
  armTurnTimer(room);
}

function drawTile(room, playerId) {
  const player = room.players.find(p => p.id === playerId);
  if (!player) return { error: 'Player not found' };
  if (room.players[room.currentPlayerIndex].id !== playerId) return { error: 'Not your turn' };
  if (room.pool.length === 0) return { error: 'Pool is empty' };
  // Bug 5 fix: take the snapshot BEFORE modifying the rack so that undoTurn
  // (which restores from turnSnapshot) can correctly remove the drawn tile.
  room.turnSnapshot = {
    board: JSON.parse(JSON.stringify(room.board)),
    rack:  JSON.parse(JSON.stringify(player.rack)),
  };
  player.rack.push(room.pool.pop());
  room.log.push(`${player.name} drew a tile.`);
  clearTurnTimer(room);  // cancel timer before advanceTurn re-arms for next player
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
  room.board = newBoard.map(set => sortSet(set));
  room.log.push(`${player.name} played ${tilesAdded.length} tile(s).`);

  if (player.rack.length === 0) {
    clearTurnTimer(room);   // Bug 2/3 fix: don't fire after game ends
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

/** Cancel any running turn-expiry timer for this room. */
function clearTurnTimer(room) {
  if (room._turnTimer) {
    clearTimeout(room._turnTimer);
    room._turnTimer = null;
  }
}

/**
 * Arm the server-side turn-expiry timer.
 * When the timer fires the current player auto-draws (or passes if the pool
 * is empty) and the turn advances — identical to what drawTile() does.
 * Bots manage their own timing via maybeTriggerBot, so we skip them here.
 */
function armTurnTimer(room) {
  clearTurnTimer(room);
  if (!room.rules.turnTimer || room.rules.turnTimer <= 0) return;
  const playerAtArmTime = room.players[room.currentPlayerIndex];
  if (!playerAtArmTime || playerAtArmTime.isBot) return;

  room._turnTimer = setTimeout(() => {
    // Guard: room state may have changed while we were waiting
    if (room.phase !== 'playing') return;
    const current = room.players[room.currentPlayerIndex];
    if (!current || current.id !== playerAtArmTime.id) return;

    if (room.pool.length > 0) {
      current.rack.push(room.pool.pop());
      room.log.push(`⏱️ ${current.name}'s time ran out — drew a tile.`);
    } else {
      room.log.push(`⏱️ ${current.name}'s time ran out — pool empty, passing.`);
    }
    advanceTurn(room);
    broadcastState(room);
  }, room.rules.turnTimer * 1000);
}

function advanceTurn(room) {
  clearTurnTimer(room);   // cancel the outgoing player's timer
  room.currentPlayerIndex = (room.currentPlayerIndex + 1) % room.players.length;
  const next = room.players[room.currentPlayerIndex];
  room.turnSnapshot = {
    board: JSON.parse(JSON.stringify(room.board)),
    rack:  JSON.parse(JSON.stringify(next.rack)),
  };
  room.turnStartedAt = Date.now();   // Bug 1 fix: stamp when the turn begins
  room.log.push(`It's ${next.name}'s turn.`);
  armTurnTimer(room);    // Bug 2 fix: enforce the timer server-side
  maybeTriggerBot(room);
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
      clearTurnTimer(room);   // Bug 3 fix: don't fire after game ends
      room.phase = 'ended';
      room.winner = room.players[0]?.name || 'Nobody';
      room.winnerScores = room.players.map(p => ({
        name: p.name, avatarColor: p.avatarColor,
        rackCount: p.rack.length, points: rackPoints(p.rack),
      }));
      room.log.push('Not enough players. Game over!');
    } else {
      if (wasTheirTurn) {
        // Bug 3 fix: use advanceTurn so the timer stamp and server-side
        // enforcement are set correctly for the newly-active player.
        // currentPlayerIndex already points at the next player after splice,
        // so we step back by one and let advanceTurn increment it normally.
        room.currentPlayerIndex = (room.currentPlayerIndex === 0
          ? room.players.length
          : room.currentPlayerIndex) - 1;
        advanceTurn(room);
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
    turnStartedAt: room.turnStartedAt || null,   // Bug 1 fix: clients use this to reset their countdown
    winner: room.winner, winnerScores: room.winnerScores,
    log: room.log.slice(-30), rules: room.rules, palette: room.palette,
    players: room.players.map(p => ({
      id: p.id, name: p.name,
      avatarColor: p.avatarColor || AVATAR_COLORS[0],
      rackCount: p.rack.length, hasInitialMeld: p.hasInitialMeld,
      isBot: p.isBot || false,
      difficulty: p.difficulty || null,
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
    const humanCount = room.players.filter(p => !p.isBot).length;
    const botCount   = room.players.filter(p =>  p.isBot).length;
    if (room.players.length < MIN_PLAYERS) return cb?.({ error: `Need at least ${MIN_PLAYERS} players (add a CPU player or invite a friend)` });
    if (humanCount < 1) return cb?.({ error: 'Need at least 1 human player' });
    startGame(room);
    // Bug 4 fix: snapshot/timestamp/timer are now set inside startGame()
    cb?.({ ok: true });
    broadcastState(room);
    maybeTriggerBot(room);
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

  socket.on('add_bot', ({ difficulty } = {}, cb) => {
    const room = rooms[currentRoom];
    if (!room) return cb?.({ error: 'Room not found' });
    if (room.players[0]?.id !== socket.id) return cb?.({ error: 'Only host can add bots' });
    if (room.phase !== 'lobby') return cb?.({ error: 'Cannot add bots after game starts' });
    if (room.players.length >= MAX_PLAYERS) return cb?.({ error: `Room full (max ${MAX_PLAYERS})` });
    const diff     = Object.values(BOT_DIFFICULTY).includes(difficulty) ? difficulty : 'medium';
    const botIndex = room.players.filter(p => p.isBot).length;
    const bot = {
      id: makeBotId(),
      name: BOT_NAMES_BY_DIFF[diff][botIndex % BOT_NAMES_BY_DIFF[diff].length],
      avatarColor: BOT_COLORS[botIndex % BOT_COLORS.length],
      rack: [], hasInitialMeld: false, isBot: true, difficulty: diff,
    };
    room.players.push(bot);
    room.log.push(`${bot.name} joined as a ${diff} CPU player.`);
    cb?.({ ok: true });
    broadcastState(room);
  });

  socket.on('remove_bot', (_, cb) => {
    const room = rooms[currentRoom];
    if (!room) return cb?.({ error: 'Room not found' });
    if (room.players[0]?.id !== socket.id) return cb?.({ error: 'Only host can remove bots' });
    if (room.phase !== 'lobby') return cb?.({ error: 'Cannot remove bots after game starts' });
    const botIdx = room.players.map((p, i) => p.isBot ? i : -1).filter(i => i !== -1).pop();
    if (botIdx === undefined) return cb?.({ error: 'No bots to remove' });
    const name = room.players[botIdx].name;
    room.players.splice(botIdx, 1);
    room.log.push(`🤖 ${name} removed.`);
    cb?.({ ok: true });
    broadcastState(room);
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
