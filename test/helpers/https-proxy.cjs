const https = require('node:https');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

let certificate;

async function testCertificate() {
  if (!certificate) {
    certificate = (async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gwent-https-test-'));
      try {
        const key = path.join(directory, 'key.pem');
        const cert = path.join(directory, 'cert.pem');
        await promisify(execFile)('openssl', [
          'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1',
          '-keyout', key, '-out', cert, '-subj', '/CN=localhost',
          '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
        ]);
        return { key: await fs.readFile(key), cert: await fs.readFile(cert) };
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    })();
  }
  return certificate;
}

// Only a test fixture: browsers opt into its self-signed certificate explicitly.
// TLS ends here while HTTP and WebSocket requests reach the real app unchanged.
async function startHttpsProxy(targetPort) {
  const sockets = new Set();
  const requests = new Set();
  const trackSocket = socket => {
    if (sockets.has(socket)) return socket;
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    return socket;
  };
  const forward = request => {
    const upstream = http.request({
      hostname: '127.0.0.1', port: targetPort,
      method: request.method, path: request.url,
      headers: {
        ...request.headers,
        'x-forwarded-proto': 'https',
        'x-forwarded-host': request.headers.host,
      },
    });
    requests.add(upstream);
    upstream.once('close', () => requests.delete(upstream));
    upstream.on('socket', trackSocket);
    return upstream;
  };

  const server = https.createServer(await testCertificate(), (request, response) => {
    const upstream = forward(request);
    upstream.on('response', result => {
      response.writeHead(result.statusCode, result.headers);
      result.pipe(response);
      result.on('error', () => response.destroy());
    });
    upstream.on('error', () => {
      if (response.destroyed) return;
      if (response.headersSent) response.destroy();
      else response.writeHead(502).end('Test proxy upstream unavailable');
    });
    response.on('close', () => upstream.destroy());
    request.pipe(upstream);
  });
  server.on('connection', trackSocket);
  server.on('upgrade', (request, socket, head) => {
    // Track TLS sockets as well as their underlying TCP connections.
    trackSocket(socket);
    const upstream = forward(request);
    upstream.on('upgrade', (response, targetSocket, targetHead) => {
      trackSocket(targetSocket);
      const headers = [];
      for (let i = 0; i < response.rawHeaders.length; i += 2) {
        headers.push(`${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}`);
      }
      socket.write(`HTTP/${response.httpVersion} ${response.statusCode} ${response.statusMessage}\r\n${headers.join('\r\n')}\r\n\r\n`);
      if (targetHead.length) socket.write(targetHead);
      if (head.length) targetSocket.write(head);
      socket.pipe(targetSocket).pipe(socket);
      socket.on('error', () => targetSocket.destroy());
      targetSocket.on('error', () => socket.destroy());
      socket.once('close', () => targetSocket.destroy());
      targetSocket.once('close', () => socket.destroy());
    });
    upstream.on('response', response => {
      response.resume();
      socket.destroy();
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    upstream.end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  let closing;
  return {
    url: `https://127.0.0.1:${server.address().port}`,
    close() {
      if (!closing) {
        closing = new Promise(resolve => {
          server.close(resolve);
          for (const request of requests) request.destroy();
          for (const socket of sockets) socket.destroy();
        });
      }
      return closing;
    },
  };
}

module.exports = { startHttpsProxy };
