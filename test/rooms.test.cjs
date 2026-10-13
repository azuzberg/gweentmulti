const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const { createServer } = require('../server.cjs');
const { defaultDeck } = require('../server/decks.cjs');

function mockEngineFactory(captured) {
  return options => {
    const engine = {
      options, turn: 0, revision: 0, phase: 'playing', closed: false,
      start() { options.onUpdate(); },
      snapshot(seat) {
        return {
          phase: this.phase, revision: this.revision, turn: this.turn,
          hand: [`secret-for-${seat}`], opponent: { handCount: 10 },
        };
      },
      act(seat, action) {
        if (this.turn !== seat) throw new Error('Сейчас ход соперника.');
        if (action.revision !== undefined && action.revision !== this.revision) {
          throw new Error('Игровое состояние изменилось.');
        }
        if (action.type !== 'pass') throw new Error('Неизвестный игровой ход.');
        this.turn = 1 - seat;
        this.revision++;
        options.onUpdate();
      },
      close() { this.closed = true; },
    };
    captured.push(engine);
    return engine;
  };
}

async function fixture(t, options = {}) {
  const engines = [];
  const app = createServer({
    deckDurationMs: 2000, reconnectGraceMs: 150,
    engineFactory: mockEngineFactory(engines), ...options,
  });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const port = app.server.address().port;
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.socket.terminate();
    await app.close();
  });
  async function connect(token) {
    const url = `ws://127.0.0.1:${port}/ws${token ? `?token=${encodeURIComponent(token)}` : ''}`;
    const socket = new WebSocket(url, { origin: `http://127.0.0.1:${port}` });
    const messages = [];
    const waiters = [];
    const client = {
      socket, messages,
      send(message) { socket.send(JSON.stringify(message)); },
      take(predicate, timeout = 1500) {
        const index = messages.findIndex(predicate);
        if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
        return new Promise((resolve, reject) => {
          const waiter = { predicate, resolve, timer: null };
          waiter.timer = setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) waiters.splice(index, 1);
            reject(new Error(`Message timeout; received: ${JSON.stringify(messages)}`));
          }, timeout);
          waiters.push(waiter);
        });
      },
    };
    socket.on('message', data => {
      const message = JSON.parse(data.toString());
      const index = waiters.findIndex(waiter => waiter.predicate(message));
      if (index >= 0) {
        const waiter = waiters.splice(index, 1)[0];
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else messages.push(message);
    });
    clients.push(client);
    await once(socket, 'open');
    client.welcome = await client.take(message => message.type === 'welcome');
    return client;
  }
  return { ...app, engines, connect, base: `http://127.0.0.1:${port}`, port };
}

async function paired(f) {
  const host = await f.connect();
  const guest = await f.connect();
  host.send({ type: 'create', name: 'Гвинт друзей', nickname: 'Хозяин' });
  const created = await host.take(message => message.type === 'room' && message.room?.phase === 'waiting');
  guest.send({ type: 'join', code: created.room.code.toLowerCase(), nickname: 'Гость' });
  const deckRoom = await host.take(message => message.type === 'room' && message.room?.phase === 'deck');
  await guest.take(message => message.type === 'room' && message.room?.phase === 'deck');
  return { host, guest, code: created.room.code, deckRoom };
}

test('two players enter deck selection, both ready start a private authoritative game', async t => {
  const f = await fixture(t);
  const { host, guest, code, deckRoom } = await paired(f);
  assert.equal(deckRoom.seat, 0);
  assert.equal(deckRoom.room.players.length, 2);
  assert.equal(deckRoom.room.players[1].name, 'Гость');
  assert.ok(deckRoom.room.deadline - deckRoom.room.serverTime > 1900);

  const third = await f.connect();
  third.send({ type: 'join', code });
  assert.match((await third.take(message => message.type === 'error')).message, /два игрока/);
  assert.ok(third.messages.filter(message => message.type === 'lobby').every(message =>
    !message.rooms.some(room => room.code === code)));

  host.send({ type: 'ready', deck: defaultDeck() });
  const ready = await host.take(message => message.type === 'room' && message.room?.players[0].ready);
  assert.equal(ready.room.phase, 'deck');
  assert.equal(ready.room.players[1].ready, false);
  assert.equal(f.engines.length, 0);
  guest.send({ type: 'ready', deck: defaultDeck() });
  const hostGame = await host.take(message => message.type === 'game');
  const guestGame = await guest.take(message => message.type === 'game');
  assert.equal(f.engines.length, 1);
  assert.deepEqual(hostGame.game.hand, ['secret-for-0']);
  assert.deepEqual(guestGame.game.hand, ['secret-for-1']);
  assert.ok(!JSON.stringify(hostGame).includes('secret-for-1'));

  guest.send({ type: 'action', action: { type: 'pass' } });
  assert.match((await guest.take(message => message.type === 'error')).message, /ход соперника/);
  host.send({ type: 'action', action: { type: 'pass', revision: -1 } });
  assert.match((await host.take(message => message.type === 'error')).message, /состояние изменилось/);
  host.send({ type: 'action', action: { type: 'pass', revision: 0 } });
  assert.equal((await guest.take(message => message.type === 'game' && message.game.revision === 1)).game.turn, 1);
});

test('deadline uses the current valid selection and a default deck for an unfinished player', async t => {
  const f = await fixture(t, { deckDurationMs: 250 });
  const { host, guest } = await paired(f);
  const selected = defaultDeck('nilfgaard');
  host.send({ type: 'deck_update', deck: selected });
  await host.take(message => message.type === 'room' && message.room?.phase === 'deck');
  guest.send({ type: 'ready', deck: { faction: 'invalid', cards: [], leader: -1 } });
  assert.ok((await guest.take(message => message.type === 'error')).message);
  await host.take(message => message.type === 'game');
  await guest.take(message => message.type === 'game');
  assert.equal(f.engines.length, 1);
  assert.deepEqual(f.engines[0].options.decks, [selected, defaultDeck()]);
});

test('editing a valid deck into an invalid draft makes the deadline use the default', async t => {
  const f = await fixture(t, { deckDurationMs: 250 });
  const { host, guest } = await paired(f);
  host.send({ type: 'deck_update', deck: defaultDeck('nilfgaard') });
  await host.take(message => message.type === 'room' && message.room?.phase === 'deck');
  host.send({ type: 'deck_update', deck: { faction: 'nilfgaard', cards: [], leader: -1 } });
  // Live invalid drafts are silent; the next queued command confirms the draft was processed.
  host.send({ type: 'action', action: { type: 'pass' } });
  assert.match((await host.take(message => message.type === 'error')).message, /не началась/);
  await host.take(message => message.type === 'game');
  await guest.take(message => message.type === 'game');
  assert.deepEqual(f.engines[0].options.decks, [defaultDeck(), defaultDeck()]);
});

test('room list permits code joining and a player cannot occupy two rooms', async t => {
  const f = await fixture(t);
  const host = await f.connect();
  const guest = await f.connect();
  host.send({ type: 'create', name: '  Комната\u0000  ', nickname: '  Имя\n  ' });
  const created = await host.take(message => message.type === 'room' && message.room?.phase === 'waiting');
  const listed = await guest.take(message => message.type === 'lobby' && message.rooms.length === 1);
  assert.equal(listed.rooms[0].name, 'Комната');
  assert.equal(listed.rooms[0].players[0].name, 'Имя');
  assert.equal(listed.rooms[0].code, created.room.code);
  host.send({ type: 'create' });
  assert.match((await host.take(message => message.type === 'error')).message, /текущей комнаты/);
  host.send({ type: 'action', action: { type: 'pass' } });
  assert.match((await host.take(message => message.type === 'error')).message, /не началась/);
  guest.send({ type: 'join', code: 'MISSING' });
  assert.match((await guest.take(message => message.type === 'error')).message, /не найдена/);
});

test('reloading restores identity, selected deck, original deadline and seat', async t => {
  const f = await fixture(t, { reconnectGraceMs: 500 });
  const { host, guest, deckRoom } = await paired(f);
  host.send({ type: 'deck_update', deck: defaultDeck() });
  await host.take(message => message.type === 'room' && message.room?.phase === 'deck');
  host.socket.close();
  await guest.take(message => message.type === 'room' && message.room?.players[0].connected === false);
  const resumed = await f.connect(host.welcome.token);
  assert.equal(resumed.welcome.playerId, host.welcome.playerId);
  assert.equal(resumed.welcome.token, host.welcome.token);
  const restored = await resumed.take(message => message.type === 'room' && message.room?.phase === 'deck');
  assert.equal(restored.room.deadline, deckRoom.room.deadline);
  assert.equal(restored.seat, 0);
  resumed.send({ type: 'ready' });
  guest.send({ type: 'ready', deck: defaultDeck() });
  await resumed.take(message => message.type === 'game');
  assert.deepEqual(f.engines[0].options.decks[0], defaultDeck());

  resumed.socket.close();
  await guest.take(message => message.type === 'room' && message.room?.players[0].connected === false);
  const resumedGame = await f.connect(host.welcome.token);
  assert.deepEqual((await resumedGame.take(message => message.type === 'game')).game.hand, ['secret-for-0']);
});

test('replacing the same session socket does not remove the active player', async t => {
  const f = await fixture(t, { reconnectGraceMs: 75 });
  const { host, guest } = await paired(f);
  const replaced = once(host.socket, 'close');
  const replacement = await f.connect(host.welcome.token);
  assert.equal((await replaced)[0], 4001);
  const restored = await replacement.take(message => message.type === 'room' && message.room?.phase === 'deck');
  assert.equal(restored.room.players[0].connected, true);
  replacement.send({ type: 'ready', deck: defaultDeck() });
  guest.send({ type: 'ready', deck: defaultDeck() });
  await replacement.take(message => message.type === 'game');
  assert.equal(f.engines.length, 1);
});

test('disconnect grace expiry closes the game and frees the remaining player', async t => {
  const f = await fixture(t, { reconnectGraceMs: 80 });
  const { host, guest } = await paired(f);
  host.send({ type: 'ready', deck: defaultDeck() });
  guest.send({ type: 'ready', deck: defaultDeck() });
  await guest.take(message => message.type === 'game');
  guest.messages.length = 0;
  host.socket.terminate();
  await guest.take(message => message.type === 'room' && message.room === null);
  assert.match((await guest.take(message => message.type === 'error')).message, /отключился/);
  assert.equal(f.engines[0].closed, true);
  guest.send({ type: 'create', nickname: 'Снова играем' });
  assert.equal((await guest.take(message => message.type === 'room' && message.room?.phase === 'waiting')).seat, 0);
});

test('leaving cancels the deck timer and allows a new room without starting the old game', async t => {
  const f = await fixture(t, { deckDurationMs: 80 });
  const { host, guest } = await paired(f);
  host.messages.length = 0;
  guest.messages.length = 0;
  host.send({ type: 'leave' });
  await host.take(message => message.type === 'room' && message.room === null);
  await guest.take(message => message.type === 'room' && message.room === null);
  assert.match((await guest.take(message => message.type === 'error')).message, /вышел/);
  host.send({ type: 'create' });
  await host.take(message => message.type === 'room' && message.room?.phase === 'waiting');
  // Passing the original deadline proves cancellation rather than merely observing immediate cleanup.
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(f.engines.length, 0);
});

test('health works, source files remain private, and foreign websocket origins are rejected', async t => {
  const f = await fixture(t);
  const response = await fetch(`${f.base}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal((await fetch(`${f.base}/`)).status, 200);
  assert.match((await fetch(`${f.base}/cards.js`, { method: 'HEAD' })).headers.get('content-type'), /javascript/);
  assert.equal((await fetch(`${f.base}/server.cjs`)).status, 404);
  assert.equal((await fetch(`${f.base}/%2e%2e%2fserver.cjs`)).status, 403);
  assert.equal((await fetch(`${f.base}/health`, { method: 'POST' })).status, 405);
  const foreign = new WebSocket(`ws://127.0.0.1:${f.port}/ws`, { origin: 'https://evil.example' });
  const rejection = await new Promise((resolve, reject) => {
    foreign.once('unexpected-response', (request, response) => {
      resolve(response.statusCode);
      response.resume();
      request.destroy();
    });
    foreign.once('error', reject);
  });
  assert.equal(rejection, 403);
});

test('malformed socket messages are rejected without corrupting the room', async t => {
  const f = await fixture(t);
  const client = await f.connect();
  client.socket.send('{invalid');
  assert.match((await client.take(message => message.type === 'error')).message, /Некорректная/);
  client.socket.send(JSON.stringify([]));
  assert.match((await client.take(message => message.type === 'error')).message, /Некорректная/);
  client.send({ type: 'unknown' });
  assert.match((await client.take(message => message.type === 'error')).message, /Неизвестная/);
  client.socket.send(Buffer.from('{}'));
  assert.match((await client.take(message => message.type === 'error')).message, /JSON/);
  client.send({ type: 'create', nickname: 'Игрок' });
  assert.equal((await client.take(message => message.type === 'room' && message.room?.phase === 'waiting')).room.players.length, 1);
});
