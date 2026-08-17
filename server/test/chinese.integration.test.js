import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

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

async function waitForHealth(baseUrl, child, logs) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) return;
    } catch {
      // Server may still be starting.
    }
    if (child.exitCode !== null) throw new Error(`server exited early\n${logs()}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server health check timed out\n${logs()}`);
}

function createInbox(socket) {
  const messages = [];
  const waiters = [];
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(message));
    if (waiterIndex < 0) messages.push(message);
    else waiters.splice(waiterIndex, 1)[0].resolve(message);
  });
  return {
    wait(predicate) {
      const index = messages.findIndex(predicate);
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve };
        waiters.push(waiter);
        setTimeout(() => {
          const pendingIndex = waiters.indexOf(waiter);
          if (pendingIndex >= 0) waiters.splice(pendingIndex, 1);
          reject(new Error('timed out waiting for WebSocket message'));
        }, 5000);
      });
    },
  };
}

test('Chinese REST and WebSocket games validate, persist, and isolate language state', { timeout: 20_000 }, async () => {
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: serverDirectory,
    env: { ...process.env, PORT: String(port), REDIS_URL: '', DEBUG_WS: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const post = async (path, body) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null);
    return { response, payload };
  };

  try {
    await waitForHealth(baseUrl, child, () => output);
    const dateKey = '2026-08-06';
    const invalidLanguage = await post('/api/game/join', {
      roomId: 'phase7', userId: 'invalid', dateKey, language: 'xx',
    });
    assert.equal(invalidLanguage.response.status, 400);
    assert.equal(invalidLanguage.payload.code, 'INVALID_LANGUAGE');

    const legacyEnglish = await post('/api/game/join', {
      roomId: 'phase7', userId: 'legacy', dateKey,
    });
    assert.equal(legacyEnglish.payload.language, 'en');

    const joined = await post('/api/game/join', {
      roomId: 'phase7', userId: 'rest-zh', dateKey, language: 'zh', puzzleVariant,
    });
    assert.equal(joined.response.status, 200);
    assert.equal(joined.payload.language, 'zh');
    assert.equal(joined.payload.gameState.maxGuesses, 9);
    assert.ok(joined.payload.gameState.boards.every((board) => /^[a-z]+$/u.test(board.targetWord)));
    assert.ok(joined.payload.gameState.boards.every((board) => /^\p{Script=Han}{2}$/u.test(board.targetId)));

    const invalidGuess = await post('/api/game/guess', {
      roomId: 'phase7', userId: 'rest-zh', dateKey, language: 'zh', puzzleVariant, guess: 'hello', submissionId: randomUUID(),
    });
    assert.equal(invalidGuess.response.status, 400);

    const target = joined.payload.gameState.boards[0].targetWord;
    const guessed = await post('/api/game/guess', {
      roomId: 'phase7', userId: 'rest-zh', dateKey, language: 'zh', puzzleVariant, guess: target, submissionId: randomUUID(),
    });
    assert.equal(guessed.response.status, 200);
    assert.equal(guessed.payload.gameState.guessCount, 1);
    assert.equal(guessed.payload.gameState.boards[0].solved, true);

    const rejoined = await post('/api/game/join', {
      roomId: 'phase7', userId: 'rest-zh', dateKey, language: 'zh', puzzleVariant,
    });
    assert.equal(rejoined.payload.gameState.guessCount, 1);

    const zhLeaderboard = await (await fetch(`${baseUrl}/api/room/phase7/${dateKey}/leaderboard?language=zh`)).json();
    const enLeaderboard = await (await fetch(`${baseUrl}/api/room/phase7/${dateKey}/leaderboard?language=en`)).json();
    assert.ok(zhLeaderboard.leaderboard.some((entry) => entry.visibleUserId === 'rest-zh'));
    assert.ok(!enLeaderboard.leaderboard.some((entry) => entry.visibleUserId === 'rest-zh'));

    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const inbox = createInbox(socket);
    socket.send(JSON.stringify({ type: 'JOIN', roomId: 'phase7-ws', dateKey, visibleUserId: 'bad', language: 'xx' }));
    assert.equal((await inbox.wait((message) => message.code === 'INVALID_LANGUAGE')).code, 'INVALID_LANGUAGE');
    socket.send(JSON.stringify({ type: 'JOIN', roomId: 'phase7-ws', dateKey, visibleUserId: 'ws-zh', language: 'zh', puzzleVariant }));
    const state = await inbox.wait((message) => message.type === 'STATE');
    assert.equal(state.playerState.language, 'zh');
    const wsTarget = state.playerState.gameState.boards[0].targetWord;
    socket.send(JSON.stringify({
      type: 'GUESS', roomId: 'phase7-ws', dateKey, visibleUserId: 'ws-zh', language: 'zh', puzzleVariant, guess: wsTarget, submissionId: randomUUID(),
    }));
    const updated = await inbox.wait((message) => message.type === 'STATE' && message.playerState.gameState.guessCount === 1);
    assert.equal(updated.playerState.gameState.boards[0].solved, true);
    socket.close();
  } finally {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
  }
});
