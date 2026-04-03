const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const rooms = new Map();

const genId = (n) => {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: n }, () => c[crypto.randomInt(c.length)]).join('');
};

const send = (ws, d) => { if (ws?.readyState === 1) ws.send(JSON.stringify(d)); };

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'));
    return;
  }

  // Discord bot API: GET /api/create-room
  if (req.method === 'GET' && url.pathname === '/api/create-room') {
    const roomId = genId(6);
    const link = `${url.protocol}//${req.headers.host}/?room=${roomId}`;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ roomId, link }));
    return;
  }

  // Status endpoint
  if (req.method === 'GET' && url.pathname === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ rooms: rooms.size, clients: wss.clients.size, uptime: process.uptime() | 0 }));
    return;
  }

  res.writeHead(404); res.end('Not found');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return send(ws, { type: 'error', msg: 'Bad request' }); }
    try {
      switch (msg.type) {
        case 'create': {
          const roomId = genId(6);
          const token = genId(16);
          rooms.set(roomId, { state: msg.state, white: { ws, token }, black: null, ts: Date.now() });
          ws.rid = roomId; ws.tok = token;
          send(ws, { type: 'created', roomId, token, color: 'w' });
          console.log(`[+] Room ${roomId} created`);
          break;
        }
        case 'join': {
          const rid = (msg.roomId || '').toUpperCase().trim();
          const room = rooms.get(rid);
          if (!room) return send(ws, { type: 'error', msg: 'Room not found. Check the code.' });
          if (room.black) return send(ws, { type: 'error', msg: 'Room is full.' });
          if (room.state.status === 'finished') return send(ws, { type: 'error', msg: 'Game ended. Create new.' });

          const token = genId(16);
          room.black = { ws, token };
          room.state.status = 'playing';
          room.state.lastMoveAt = Date.now();
          ws.rid = rid; ws.tok = token;

          send(ws, { type: 'joined', roomId: rid, token, color: 'b', state: room.state });
          send(room.white?.ws, { type: 'started', state: room.state });
          console.log(`[+] Player joined room ${rid}`);
          break;
        }
        case 'update': {
          const room = rooms.get(msg.roomId);
          if (!room) return;
          const isW = room.white?.token === msg.token;
          const isB = room.black?.token === msg.token;
          if (!isW && !isB) return send(ws, { type: 'error', msg: 'Unauthorized' });
          room.state = msg.state;
          const opp = isW ? room.black : room.white;
          send(opp?.ws, { type: 'state', state: room.state });
          break;
        }
        case 'reconnect': {
          const rid = (msg.roomId || '').toUpperCase().trim();
          const room = rooms.get(rid);
          if (!room) return send(ws, { type: 'error', msg: 'Room expired.', fatal: true });
          let color = null;
          if (room.white?.token === msg.token) { room.white.ws = ws; color = 'w'; }
          else if (room.black?.token === msg.token) { room.black.ws = ws; color = 'b'; }
          else return send(ws, { type: 'error', msg: 'Session expired.', fatal: true });
          ws.rid = rid; ws.tok = msg.token;
          send(ws, { type: 'reconnected', roomId: rid, color, state: room.state });
          const opp = color === 'w' ? room.black : room.white;
          send(opp?.ws, { type: 'opponent_connected' });
          console.log(`[↻] Player reconnected to ${rid} as ${color}`);
          break;
        }
        case 'ping': send(ws, { type: 'pong' }); break;
        default: send(ws, { type: 'error', msg: 'Unknown' });
      }
    } catch (e) { console.error('Error:', e); send(ws, { type: 'error', msg: 'Server error' }); }
  });

  ws.on('close', () => {
    for (const [id, room] of rooms) {
      if (room.white?.ws === ws) { room.white.ws = null; send(room.black?.ws, { type: 'opponent_disconnected' }); break; }
      if (room.black?.ws === ws) { room.black.ws = null; send(room.white?.ws, { type: 'opponent_disconnected' }); break; }
    }
  });
});

// Keep connections alive
setInterval(() => { wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); }); }, 25000);

// Cleanup rooms older than 2 hours
setInterval(() => { const now = Date.now(); for (const [id, r] of rooms) if (now - r.ts > 7200000) rooms.delete(id); }, 300000);

function getLocalIP() {
  try { const n = require('os').networkInterfaces(); for (const k of Object.keys(n)) for (const i of n[k]) if (i.family === 'IPv4' && !i.internal) return i.address; } catch {} return 'localhost';
}

server.listen(PORT, () => {
  console.log(`\n  ♟  Chess Online Server`);
  console.log(`  ════════════════════════════`);
  console.log(`  Local:    http://localhost:${PORT}`);
  console.log(`  Network:  http://${getLocalIP()}:${PORT}`);
  console.log(`  \n  Open on any device to play!\n`);
});