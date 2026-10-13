const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { validateDeck, defaultDeck } = require('./server/decks.cjs');
const { GameEngine } = require('./server/game-engine.cjs');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
};

function cleanName(value, fallback, limit) {
  if (typeof value !== 'string') return fallback;
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '')
    .trim().slice(0, limit) || fallback;
}

function createServer(options = {}) {
  const deckDurationMs = options.deckDurationMs ?? 30_000;
  const reconnectGraceMs = options.reconnectGraceMs ?? 30_000;
  if (!Number.isFinite(deckDurationMs) || deckDurationMs < 1 ||
      !Number.isFinite(reconnectGraceMs) || reconnectGraceMs < 1) {
    throw new Error('Timers must be positive finite numbers.');
  }
  const publicRoot = path.join(__dirname, 'public');
  const rooms = new Map();
  const sessions = new Map();
  let shuttingDown = false;

  function reportEngineError(error) {
    if (options.onEngineError) options.onEngineError(error);
    else console.error('Game engine error:', error?.stack || error?.message || error);
  }

  const server = http.createServer((request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end();
      return;
    }
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    } catch {
      response.writeHead(400);
      response.end('Bad request');
      return;
    }
    if (pathname === '/health') {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(request.method === 'HEAD' ? undefined : JSON.stringify({ ok: true }));
      return;
    }
    if (pathname.includes('\0')) {
      response.writeHead(400);
      response.end('Bad request');
      return;
    }
    const filename = path.resolve(publicRoot, '.' + (pathname === '/' ? '/index.html' : pathname));
    const relative = path.relative(publicRoot, filename);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
      response.writeHead(403);
      response.end('Forbidden');
      return;
    }
    fs.realpath(filename, (error, resolved) => {
      if (error) {
        response.writeHead(404);
        response.end('Not found');
        return;
      }
      const realRelative = path.relative(publicRoot, resolved);
      if (realRelative === '..' || realRelative.startsWith('..' + path.sep) || path.isAbsolute(realRelative)) {
        response.writeHead(403);
        response.end('Forbidden');
        return;
      }
      fs.stat(resolved, (error, stat) => {
        if (error || !stat.isFile()) {
          response.writeHead(404);
          response.end('Not found');
          return;
        }
        response.writeHead(200, {
          'Content-Type': MIME_TYPES[path.extname(filename).toLowerCase()] || 'application/octet-stream',
          'Content-Length': stat.size,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': /\.(?:html|js|css|json)$/.test(filename) ? 'no-cache' : 'public, max-age=3600',
        });
        if (request.method === 'HEAD') response.end();
        else {
          const stream = fs.createReadStream(resolved);
          stream.on('error', () => response.destroy());
          stream.pipe(response);
        }
      });
    });
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 });

  function send(session, message) {
    if (session.socket?.readyState === WebSocket.OPEN) session.socket.send(JSON.stringify(message));
  }

  function fail(session, message) {
    send(session, { type: 'error', message });
  }

  function playerView(player) {
    return {
      id: player.id, name: player.name, ready: player.ready,
      connected: player.socket?.readyState === WebSocket.OPEN,
    };
  }

  function roomView(room) {
    return {
      code: room.code, name: room.name, phase: room.phase,
      players: room.players.map(playerView), deadline: room.deadline,
      serverTime: Date.now(),
    };
  }

  function sendRoom(session, room) {
    send(session, { type: 'room', room: room ? roomView(room) : null, seat: room ? session.seat : null });
  }

  function broadcastRoom(room) {
    for (const player of room.players) sendRoom(player, room);
  }

  function sendLobby(session) {
    send(session, {
      type: 'lobby',
      rooms: [...rooms.values()]
        .filter(room => room.phase === 'waiting' && room.players[0]?.socket?.readyState === WebSocket.OPEN)
        .map(room => ({ code: room.code, name: room.name, players: room.players.map(playerView), phase: room.phase })),
    });
  }

  function broadcastLobby() {
    for (const session of sessions.values()) sendLobby(session);
  }

  function sendGame(session, room) {
    if (!room.engine) return;
    send(session, { type: 'game', game: room.engine.snapshot(session.seat), seat: session.seat });
  }

  function broadcastGame(room) {
    if (!rooms.has(room.code) || !room.engine) return;
    if (room.engine.snapshot(0).phase === 'finished' && room.phase !== 'finished') {
      room.phase = 'finished';
      broadcastRoom(room);
    }
    for (const player of room.players) sendGame(player, room);
  }

  function removeRoom(room, message, excludedPlayer) {
    if (!rooms.delete(room.code)) return;
    clearTimeout(room.deckTimer);
    room.engine?.close();
    for (const player of room.players) {
      player.roomCode = null;
      player.seat = null;
      player.ready = false;
      player.deck = null;
      sendRoom(player, null);
      if (message && player !== excludedPlayer) fail(player, message);
    }
    broadcastLobby();
  }

  function startGame(room) {
    if (room.phase !== 'deck' || !rooms.has(room.code)) return;
    clearTimeout(room.deckTimer);
    room.deadline = null;
    room.phase = 'playing';
    try {
      for (const player of room.players) {
        player.deck = player.deck || defaultDeck();
        player.ready = true;
      }
      const engineOptions = {
        decks: room.players.map(player => player.deck),
        names: room.players.map(player => player.name),
        onUpdate: () => {
          try { broadcastGame(room); }
          catch (error) {
            reportEngineError(error);
            removeRoom(room, 'Не удалось обновить игру. Создайте новую комнату.');
          }
        },
        onError: error => {
          reportEngineError(error);
          removeRoom(room, 'Игра завершена из-за ошибки. Создайте новую комнату.');
        },
      };
      room.engine = options.engineFactory ? options.engineFactory(engineOptions) : new GameEngine(engineOptions);
      broadcastRoom(room);
      Promise.resolve(room.engine.start()).catch(error => {
        reportEngineError(error);
        removeRoom(room, 'Не удалось начать игру. Создайте новую комнату.');
      });
      broadcastLobby();
    } catch (error) {
      reportEngineError(error);
      removeRoom(room, 'Не удалось начать игру. Создайте новую комнату.');
    }
  }

  function startDeckSelection(room) {
    room.phase = 'deck';
    room.deadline = Date.now() + deckDurationMs;
    room.deckTimer = setTimeout(() => startGame(room), deckDurationMs);
    room.deckTimer.unref();
    broadcastRoom(room);
    broadcastLobby();
  }

  function newRoomCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do {
      code = [...crypto.randomBytes(6)].map(byte => alphabet[byte % alphabet.length]).join('');
    } while (rooms.has(code));
    return code;
  }

  function bindToRoom(session, room) {
    session.roomCode = room.code;
    session.seat = room.players.length;
    session.ready = false;
    session.deck = null;
    room.players.push(session);
  }

  function handleMessage(session, raw, isBinary) {
    if (isBinary) return fail(session, 'Отправляйте команды в формате JSON.');
    let message;
    try { message = JSON.parse(raw.toString()); }
    catch { return fail(session, 'Некорректная команда.'); }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return fail(session, 'Некорректная команда.');
    }
    const room = rooms.get(session.roomCode);
    switch (message.type) {
      case 'create': {
        if (room) return fail(session, 'Сначала выйдите из текущей комнаты.');
        if (rooms.size >= (options.maxRooms ?? 100)) return fail(session, 'Все комнаты заняты. Попробуйте позже.');
        session.name = cleanName(message.nickname, 'Игрок', 40);
        const created = {
          code: newRoomCode(), name: cleanName(message.name, `Комната ${session.name}`, 60),
          phase: 'waiting', players: [], deadline: null, deckTimer: null, engine: null,
        };
        bindToRoom(session, created);
        rooms.set(created.code, created);
        broadcastRoom(created);
        broadcastLobby();
        break;
      }
      case 'join': {
        const code = typeof message.code === 'string' ? message.code.trim().toUpperCase() : '';
        if (room) {
          if (room.code === code) sendRoom(session, room);
          else fail(session, 'Сначала выйдите из текущей комнаты.');
          return;
        }
        const target = rooms.get(code);
        if (!target) return fail(session, 'Комната не найдена.');
        if (target.phase !== 'waiting' || target.players.length >= 2) {
          return fail(session, 'В комнате уже два игрока или игра началась.');
        }
        if (target.players[0].socket?.readyState !== WebSocket.OPEN) {
          return fail(session, 'Создатель комнаты переподключается. Попробуйте позже.');
        }
        session.name = cleanName(message.nickname, 'Игрок', 40);
        bindToRoom(session, target);
        startDeckSelection(target);
        break;
      }
      case 'deck_update':
      case 'ready': {
        if (!room || room.phase !== 'deck') return fail(session, 'Выбор колоды сейчас недоступен.');
        if (session.ready) return fail(session, 'Колода уже подтверждена.');
        try {
          const candidate = message.deck === undefined && message.type === 'ready' ? session.deck : message.deck;
          session.deck = validateDeck(candidate);
        } catch (error) {
          session.deck = null;
          if (message.type === 'ready') fail(session, error.message || 'Выберите допустимую колоду.');
          return;
        }
        if (message.type === 'ready') session.ready = true;
        broadcastRoom(room);
        if (room.players.every(player => player.ready)) startGame(room);
        break;
      }
      case 'action': {
        if (!room || room.phase !== 'playing' || !room.engine) return fail(session, 'Игра ещё не началась.');
        if (!message.action || typeof message.action !== 'object' || Array.isArray(message.action)) {
          return fail(session, 'Некорректный игровой ход.');
        }
        try {
          Promise.resolve(room.engine.act(session.seat, message.action))
            .catch(error => fail(session, error.message || 'Этот ход недоступен.'));
        } catch (error) {
          fail(session, error.message || 'Этот ход недоступен.');
        }
        break;
      }
      case 'leave':
        if (room) removeRoom(room, 'Соперник вышел из комнаты.', session);
        else { sendRoom(session, null); sendLobby(session); }
        break;
      default:
        fail(session, 'Неизвестная команда.');
    }
  }

  server.on('upgrade', (request, socket, head) => {
    if (shuttingDown) return socket.destroy();
    let url;
    try { url = new URL(request.url, 'http://localhost'); }
    catch { return socket.destroy(); }
    if (url.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (request.headers.origin) {
      const forwardedProtocol = request.headers['x-forwarded-proto'];
      const protocol = forwardedProtocol === 'https' || forwardedProtocol === 'http'
        ? forwardedProtocol : request.socket.encrypted ? 'https' : 'http';
      if (request.headers.origin !== `${protocol}://${request.headers.host}`) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
    }
    const token = url.searchParams.get('token');
    let session = token && sessions.get(token);
    if (!session) {
      if (sessions.size >= (options.maxSessions ?? 1000)) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      session = {
        id: crypto.randomUUID(), token: crypto.randomBytes(32).toString('hex'),
        name: 'Игрок', socket: null, roomCode: null, seat: null, ready: false,
        deck: null, disconnectTimer: null,
      };
      sessions.set(session.token, session);
    }
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request, session));
  });

  wss.on('connection', (socket, request, session) => {
    clearTimeout(session.disconnectTimer);
    const previousSocket = session.socket;
    session.socket = socket;
    previousSocket?.close(4001, 'Connected in another tab');
    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });
    socket.on('error', () => {});
    socket.on('message', (raw, isBinary) => {
      if (session.socket === socket && !shuttingDown) handleMessage(session, raw, isBinary);
    });
    socket.on('close', () => {
      if (session.socket !== socket || shuttingDown) return;
      session.socket = null;
      const room = rooms.get(session.roomCode);
      if (room) broadcastRoom(room);
      broadcastLobby();
      session.disconnectTimer = setTimeout(() => {
        if (session.socket) return;
        const currentRoom = rooms.get(session.roomCode);
        if (currentRoom) removeRoom(currentRoom, 'Соперник отключился. Комната закрыта.', session);
        sessions.delete(session.token);
      }, reconnectGraceMs);
      session.disconnectTimer.unref();
    });
    send(session, {
      type: 'welcome', playerId: session.id, token: session.token,
      serverTime: Date.now(), deckDurationMs,
    });
    const room = rooms.get(session.roomCode);
    if (room) {
      broadcastRoom(room);
      sendGame(session, room);
    } else sendRoom(session, null);
    broadcastLobby();
  });

  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!socket.isAlive) socket.terminate();
      else { socket.isAlive = false; socket.ping(); }
    }
  }, 15_000);
  heartbeat.unref();

  let closePromise;
  function close() {
    if (closePromise) return closePromise;
    shuttingDown = true;
    clearInterval(heartbeat);
    for (const session of sessions.values()) clearTimeout(session.disconnectTimer);
    for (const room of rooms.values()) {
      clearTimeout(room.deckTimer);
      room.engine?.close();
    }
    rooms.clear();
    sessions.clear();
    for (const socket of wss.clients) socket.terminate();
    closePromise = Promise.all([
      new Promise(resolve => wss.close(resolve)),
      new Promise(resolve => server.close(() => resolve())),
    ]).then(() => undefined);
    return closePromise;
  }
  return { server, wss, close };
}

module.exports = { createServer };

if (require.main === module) {
  const app = createServer();
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '0.0.0.0';
  app.server.listen(port, host, () => {
    const address = app.server.address();
    const browserHost = address.address === '0.0.0.0' || address.address === '::'
      ? 'localhost'
      : address.address.includes(':') ? `[${address.address}]` : address.address;
    console.log(`Гвинт: http://${browserHost}:${address.port}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => app.close().then(() => process.exit(0)));
  }
}
