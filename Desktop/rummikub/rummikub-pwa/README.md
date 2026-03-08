# 🎲 Rummikub PWA — iPad Edition

Multiplayer Rummikub optimized for iPad Safari. Works on LAN and over the internet.
Install it to the home screen like a native app — no App Store required.

---

## 📦 Setup

### 1. Install Node.js
Download from https://nodejs.org (v16 or newer)

### 2. Install dependencies
```bash
cd rummikub-pwa
npm install
```

### 3. Start the server
```bash
npm start
```

You'll see:
```
🎲 Rummikub PWA Server
══════════════════════════════════════════════════
  Local:    http://localhost:3000
  LAN:      http://192.168.1.42:3000  ← share with iPads on same WiFi
```

---

## 📱 iPad Setup (each player)

1. Open **Safari** on the iPad
2. Navigate to the **LAN URL** shown in the terminal (e.g. `http://192.168.1.42:3000`)
3. Tap the **Share button** (box with arrow) → **Add to Home Screen**
4. Tap **Add** — the game appears as an app icon!
5. Open it from the home screen for fullscreen mode

> **Note:** Must use Safari, not Chrome, for Add to Home Screen on iOS.

---

## 🌐 Internet Multiplayer (players on different networks)

You need to expose your local server to the internet. Pick one method:

### Option A — ngrok (easiest, free)
```bash
# In a new terminal window:
npx ngrok http 3000
```
Copy the `https://xxxx.ngrok.io` URL and share it. Anyone can join!

### Option B — Cloudflare Tunnel (free, no account)
```bash
npx cloudflared tunnel --url http://localhost:3000
```
Gives you a `https://xxxx.trycloudflare.com` URL instantly.

### Option C — Deploy permanently (free hosting)

**Render.com** (easiest free hosting):
1. Push this folder to a GitHub repo
2. Go to render.com → New → Web Service
3. Connect your repo, set Build Command: `npm install`, Start: `node server.js`
4. Free tier gives you a permanent `https://your-app.onrender.com` URL

**Railway.app** or **Fly.io** are also great free options.

---

## 🎮 How to Play

### Lobby
- One player creates a room → gets a 5-letter code
- Others enter the code to join (2–6 players)
- Host presses **Start Game**

### Your Turn
| Button | Action |
|--------|--------|
| ✓ Play | Commit your tile moves to the board |
| ↓ Draw | Take a tile from the pool (ends your turn) |
| ↩ Undo | Reset board & rack to start of your turn |
| ⇅ Sort | Toggle sort by color / by number |
| 💬 | Open chat panel |

### Moving Tiles
- **Tap** a tile to select it (glows gold), then **tap** a set or the **+** button
- **Drag** tiles between sets or back to your rack
- **Long-press drag** on touch screens

### Rules
- 106 tiles: numbers 1–13 in red, blue, orange, black (×2 sets) + 2 jokers
- **Initial meld:** First play must total ≥ 30 points (jokers = 30 pts)
- **Valid Group:** 3–4 tiles, same number, different colors
- **Valid Run:** 3+ tiles, consecutive numbers, same color
- Jokers substitute any tile
- First to empty their rack wins!

---

## 🔧 Customization

Edit these constants at the top of `server.js`:
```js
const INITIAL_MELD_MIN = 30;   // minimum initial meld points
const TILES_PER_PLAYER = 14;   // starting tiles per player
const MAX_PLAYERS = 6;          // max players per room
const MIN_PLAYERS = 2;          // min to start
```

---

## 🏗️ Architecture

```
rummikub-pwa/
├── server.js          ← Node.js game engine + Socket.IO + HTTP server
├── package.json
└── public/
    ├── index.html     ← Full PWA client (game UI + game logic)
    ├── manifest.json  ← PWA manifest (enables Add to Home Screen)
    ├── sw.js          ← Service worker (offline caching)
    └── icons/
        ├── icon-192.png
        └── icon-512.png
```

**Tech stack:** Pure Node.js (no Express), Socket.IO for real-time multiplayer, vanilla JS + CSS for the client. No build step needed.
