'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const { WebSocket } = require('ws');
const { createServer } = require('../server.cjs');

async function fixture(t, options = {}) {
  const app = createServer(options);
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const port = app.server.address().port;
  t.after(() => app.close());
  return { app, port };
}

function handshake(port, origin, headers = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin, headers });
    socket.on('error', reject);
    socket.on('unexpected-response', (request, response) => {
      response.resume();
      request.destroy();
      resolve({ status: response.statusCode });
    });
    socket.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.type === 'welcome') {
        socket.close();
        resolve({ status: 101, message });
      }
    });
  });
}

test('WebSocket accepts HTTPS forwarded from a managed host and rejects a foreign origin', async t => {
  const { port } = await fixture(t);
  const headers = { host: 'gwent.example.test', 'x-forwarded-proto': 'https' };
  assert.equal((await handshake(port, 'https://gwent.example.test', headers)).status, 101);
  assert.equal((await handshake(port, 'https://other.example.test', headers)).status, 403);
});

test('configured public URL survives an internal proxy Host without allowing arbitrary origins', async t => {
  const { port } = await fixture(t, { publicUrl: 'https://gwent.example.test/' });
  assert.equal((await handshake(port, 'https://gwent.example.test')).status, 101);
  assert.equal((await handshake(port, 'https://other.example.test')).status, 403);
});

test('unsafe public URL and invalid capacity settings fail before starting a service', () => {
  for (const publicUrl of ['file:///tmp/site', 'https://user:password@example.test',
    'https://gwent.example.test/path', 'https://gwent.example.test/?token=x']) {
    assert.throws(() => createServer({ publicUrl }), /PUBLIC_URL/);
  }
  assert.throws(() => createServer({ maxRooms: 0 }), /limits/);
  assert.throws(() => createServer({ maxSessions: 1 }), /sessions/);
});

test('hosting capacity limit denies excess connections while preserving existing sessions', async t => {
  const { port } = await fixture(t, { maxSessions: 2 });
  const origin = `http://127.0.0.1:${port}`;
  assert.equal((await handshake(port, origin)).status, 101);
  assert.equal((await handshake(port, origin)).status, 101);
  assert.equal((await handshake(port, origin)).status, 503);
});

async function spawnService(t, extraEnv) {
  const reserve = http.createServer();
  reserve.listen(0, '127.0.0.1');
  await once(reserve, 'listening');
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const child = spawn(process.execPath, ['server.cjs'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PUBLIC_URL: '', RENDER_EXTERNAL_URL: '', RAILWAY_PUBLIC_DOMAIN: '',
      HOST: '127.0.0.1', PORT: String(port), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => {
    if (child.exitCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  });
  let stdout = '', stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.includes('Гвинт:')) resolve();
    });
    child.on('error', reject);
    child.on('exit', code => reject(new Error(`Service exited ${code}: ${stderr}`)));
  });
  return { port, child, stdout };
}

test('Render and Railway public URL metadata work with an injected service port', async t => {
  for (const metadata of [
    { RENDER_EXTERNAL_URL: 'https://gwent.example.onrender.com' },
    { RAILWAY_PUBLIC_DOMAIN: 'gwent.example.up.railway.app' },
    { PUBLIC_URL: 'https://cards.example.test', RENDER_EXTERNAL_URL: 'https://gwent.example.onrender.com' }
  ]) {
    const publicUrl = metadata.PUBLIC_URL || metadata.RENDER_EXTERNAL_URL || `https://${metadata.RAILWAY_PUBLIC_DOMAIN}`;
    const service = await spawnService(t, metadata);
    assert.ok(service.stdout.includes(publicUrl));
    const health = await fetch(`http://127.0.0.1:${service.port}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });
    assert.equal((await handshake(service.port, publicUrl)).status, 101);
  }
});
