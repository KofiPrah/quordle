import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { createFakeRedis } from './fakeRedis.js';

const serverDirectory = fileURLToPath(new URL('..', import.meta.url));
const puzzleVariant = 'pinyin-latin-v2';

async function reservePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function waitForServer(baseUrl, child, logs) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/debug/persist`);
      const state = await response.json();
      if (state.redisConnected === true) return;
    } catch {}
    if (child.exitCode !== null) throw new Error(`server exited early\n${logs()}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not become Redis-ready\n${logs()}`);
}

function createInbox(socket) {
  const queue = [];
  const waiters = [];
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    const index = waiters.findIndex(({ predicate }) => predicate(message));
    if (index < 0) queue.push(message);
    else waiters.splice(index, 1)[0].resolve(message);
  });
  return {
    wait(predicate) {
      const index = queue.findIndex(predicate);
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve };
        waiters.push(waiter);
        setTimeout(() => {
          const pending = waiters.indexOf(waiter);
          if (pending >= 0) waiters.splice(pending, 1);
          reject(new Error('timed out waiting for WebSocket state'));
        }, 3000);
      });
    },
  };
}

test('REST and WebSocket completion each publish one equivalent versioned DAILY_FINISHED event', { timeout: 20_000 }, async () => {
  const port = await reservePort();
  const fakeRedis = await createFakeRedis();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: serverDirectory,
    env: { ...process.env, PORT: String(port), REDIS_URL: fakeRedis.url, DEBUG_WS: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  let socket;
  const post = async (path, body) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };

  try {
    await waitForServer(baseUrl, child, () => output);
    const shared = {
      roomId: 'completion-parity',
      dateKey: '2026-08-17',
      language: 'zh',
      puzzleVariant,
      guildId: 'guild-1',
      profile: { displayName: 'Canonical Player', avatarUrl: 'https://cdn.example/avatar.png' },
    };
    const restIdentity = { ...shared, userId: 'rest-player' };
    const wsIdentity = { ...shared, visibleUserId: 'ws-player' };
    assert.equal((await post('/api/game/join', restIdentity)).status, 200);

    socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const inbox = createInbox(socket);
    socket.send(JSON.stringify({ type: 'JOIN', ...wsIdentity }));
    await inbox.wait((message) => message.type === 'STATE');

    for (const [index, guess] of ['qunian', 'jiejie', 'gongsi', 'lanqiu'].entries()) {
      const rest = await post('/api/game/guess', {
        ...restIdentity, guess, submissionId: `rest-submission-${index}`,
      });
      assert.equal(rest.status, 200);
      socket.send(JSON.stringify({
        type: 'GUESS', ...wsIdentity, guess, submissionId: `ws-submission-${index}`,
      }));
      await inbox.wait((message) => message.type === 'STATE' && message.playerState.gameState.guessCount === index + 1);
    }

    const records = await fakeRedis.waitForPublished(2);
    assert.equal(records.length, 2);
    const [restEvent, wsEvent] = ['rest-player', 'ws-player'].map(
      (visibleUserId) => records.find((record) => record.payload.visibleUserId === visibleUserId),
    );
    assert.ok(restEvent);
    assert.ok(wsEvent);
    assert.equal(restEvent.channel, 'activity:events');
    assert.equal(wsEvent.channel, 'activity:events');
    assert.deepEqual(Object.keys(restEvent.payload).sort(), Object.keys(wsEvent.payload).sort());
    const normalize = ({ visibleUserId, timestamp, ...payload }) => payload;
    assert.deepEqual(normalize(restEvent.payload), normalize(wsEvent.payload));
  } finally {
    socket?.close();
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 3000)).then(() => child.kill('SIGKILL')),
    ]);
    await fakeRedis.close();
  }
});
