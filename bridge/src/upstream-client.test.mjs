import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, rm, writeFile, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {WebSocketServer} from 'ws';
import {UpstreamGatewayClient} from './upstream-client.mjs';

for (const mode of ['close-before-challenge', 'silent-handshake']) {
  test(`rejects ${mode} and can connect on the next attempt`, {timeout: 5000}, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cardputer-connect-'));
    const server = new WebSocketServer({host: '127.0.0.1', port: 0});
    await once(server, 'listening');
    let accept = false;
    server.on('connection', ws => {
      if (!accept) {
        if (mode === 'close-before-challenge') ws.close();
        return;
      }
      ws.send(JSON.stringify({type: 'event', event: 'connect.challenge', payload: {nonce: 'test'}}));
      ws.on('message', raw => {
        const req = JSON.parse(raw);
        ws.send(JSON.stringify({type: 'res', id: req.id, ok: true, payload: {type: 'hello-ok'}}));
      });
    });
    const client = new UpstreamGatewayClient({
      url: `ws://127.0.0.1:${server.address().port}`,
      deviceIdentityPath: path.join(dir, 'identity.json'),
      handshakeTimeoutMs: 150, clientId: 'test', mode: 'backend', scopes: []
    });
    try {
      await assert.rejects(client.connect(), /handshake/);
      assert.equal(client.connecting, null);
      assert.equal(client.connected, false);
      accept = true;
      await client.connect();
      assert.equal(client.connected, true);
    } finally {
      await client.stop();
      for (const ws of server.clients) ws.terminate();
      await new Promise(resolve => server.close(resolve));
      await rm(dir, {recursive: true, force: true});
    }
  });
}

test('HTTP liveness starts with an unavailable gateway', {timeout: 10000}, async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dir = await mkdtemp(path.join(tmpdir(), 'cardputer-offline-'));
  const cfg = JSON.parse(await readFile(path.join(root, 'config.example.json'), 'utf8'));
  cfg.server.port = 0;
  cfg.stateDir = path.join(dir, 'data');
  cfg.upstream.url = 'ws://127.0.0.1:1';
  cfg.devices[0].device_token = 'test-device-token-0000000000000000000000000001';
  for (const key of ['inboundDir', 'canonicalDir', 'playbackDir', 'tmpDir']) cfg.media[key] = path.join(dir, key);
  cfg.assets.rootDir = path.join(dir, 'assets');
  cfg.assets.logsDir = path.join(dir, 'logs');
  cfg.firmware.rootDir = path.join(dir, 'firmware');
  const configPath = path.join(dir, 'config.json');
  // Choose an ephemeral port before spawn; the test owns the reservation until close.
  const {createServer} = await import('node:net');
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  cfg.server.port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  await writeFile(configPath, JSON.stringify(cfg));
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: root, env: {...process.env, CARDPUTER_BRIDGE_CONFIG: configPath}, stdio: 'ignore'
  });
  try {
    let health;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const response = await fetch(`http://127.0.0.1:${cfg.server.port}/healthz`,
          {headers: {Authorization: `Bearer ${cfg.devices[0].device_token}`}});
        health = await response.json();
        break;
      } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    assert.equal(health?.ok, true);
    assert.equal(health?.upstream_connected, false);
  } finally {
    if (child.exitCode === null) {
      const ended = once(child, 'exit');
      child.kill();
      await ended;
    }
    await rm(dir, {recursive: true, force: true});
  }
});
