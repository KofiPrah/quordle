import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const serverDirectory = fileURLToPath(new URL('..', import.meta.url));

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
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // The server may still be starting.
    }
    if (child.exitCode !== null) throw new Error(`server exited early\n${logs()}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server health check timed out\n${logs()}`);
}

function createInbox(socket) {
  const queued = [];
  const waiters = [];
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    const index = waiters.findIndex((waiter) => waiter.predicate(message));
    if (index < 0) {
      queued.push(message);
      return;
    }
    const [waiter] = waiters.splice(index, 1);
    clearTimeout(waiter.timer);
    waiter.resolve(message);
  });
  return {
    wait(predicate, label) {
      const queuedIndex = queued.findIndex(predicate);
      if (queuedIndex >= 0) return Promise.resolve(queued.splice(queuedIndex, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timer: null };
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`timed out waiting for ${label}`));
        }, 5000);
        waiters.push(waiter);
      });
    },
  };
}

async function connectSocket(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return { socket, inbox: createInbox(socket) };
}

test('daily REST and WebSocket hints are authoritative, idempotent, and reconnect-safe', { timeout: 20_000 }, async () => {
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const socketUrl = `ws://127.0.0.1:${port}/ws`;
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
    return { status: response.status, body: await response.json() };
  };

  try {
    await waitForHealth(baseUrl, child, () => output);
    const dateKey = '2099-12-31';
    const restIdentity = { roomId: 'rest-hints', userId: 'rest-player', dateKey, language: 'ko' };
    const joined = await post('/api/game/join', restIdentity);
    assert.deepEqual(joined.body.gameState.assistance, { scoringVersion: 1, hints: [] });

    const first = await post('/api/game/hint', {
      ...restIdentity,
      boardIndex: 0,
      hintType: 'part-of-speech',
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.gameState.assistance.hints[0].cost, 2);
    const usedAt = first.body.gameState.assistance.hints[0].usedAt;

    const duplicate = await post('/api/game/hint', {
      ...restIdentity,
      boardIndex: 0,
      hintType: 'part-of-speech',
    });
    assert.equal(duplicate.body.gameState.assistance.hints.length, 1);
    assert.equal(duplicate.body.gameState.assistance.hints[0].usedAt, usedAt);
    const restLeaderboard = await (
      await fetch(`${baseUrl}/api/room/${restIdentity.roomId}/${dateKey}/leaderboard?language=ko`)
    ).json();
    const restEntry = restLeaderboard.leaderboard.find((entry) => entry.visibleUserId === restIdentity.userId);
    assert.deepEqual(
      { hintCount: restEntry.hintCount, hintPenalty: restEntry.hintPenalty, assisted: restEntry.assisted },
      { hintCount: 1, hintPenalty: 2, assisted: true },
    );

    const firstTarget = joined.body.gameState.boards[0].targetWord;
    const solvedState = await post('/api/game/guess', { ...restIdentity, guess: firstTarget });
    assert.equal(solvedState.body.gameState.boards[0].solved, true);
    const solvedBoardHint = await post('/api/game/hint', {
      ...restIdentity,
      boardIndex: 0,
      hintType: 'batchim-count',
    });
    assert.equal(solvedBoardHint.status, 409);
    assert.equal(solvedBoardHint.body.code, 'BOARD_SOLVED');

    let finishedState = solvedState;
    while (!finishedState.body.gameState.gameOver) {
      finishedState = await post('/api/game/guess', { ...restIdentity, guess: firstTarget });
    }
    const unfinishedBoardIndex = finishedState.body.gameState.boards.findIndex((board) => !board.solved);
    assert.ok(unfinishedBoardIndex >= 0);
    const finishedGameHint = await post('/api/game/hint', {
      ...restIdentity,
      boardIndex: unfinishedBoardIndex,
      hintType: 'reveal-first-syllable',
    });
    assert.equal(finishedGameHint.status, 409);
    assert.equal(finishedGameHint.body.code, 'GAME_OVER');

    const englishIdentity = { roomId: 'rest-english', userId: 'english-player', dateKey, language: 'en' };
    await post('/api/game/join', englishIdentity);
    const rejected = await post('/api/game/hint', {
      ...englishIdentity,
      boardIndex: 0,
      hintType: 'part-of-speech',
    });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.code, 'INVALID_LANGUAGE');

    const identity = { roomId: 'ws-hints', dateKey, visibleUserId: 'ws-player', language: 'ko' };
    let connection = await connectSocket(socketUrl);
    connection.socket.send(JSON.stringify({ type: 'JOIN', ...identity, profile: { displayName: 'WS Player' } }));
    await connection.inbox.wait((message) => message.type === 'STATE', 'initial state');

    connection.socket.send(JSON.stringify({
      type: 'HINT',
      ...identity,
      boardIndex: 1,
      hintType: 'batchim-count',
    }));
    const hinted = await connection.inbox.wait(
      (message) => message.type === 'STATE' && message.playerState.gameState.assistance.hints.length === 1,
      'hinted state',
    );
    const wsHint = hinted.playerState.gameState.assistance.hints[0];
    assert.equal(wsHint.cost, 5);
    const leaderboard = await connection.inbox.wait(
      (message) => message.type === 'LEADERBOARD' && message.leaderboard.some((entry) => entry.hintCount === 1),
      'assisted leaderboard',
    );
    const player = leaderboard.leaderboard.find((entry) => entry.visibleUserId === identity.visibleUserId);
    assert.deepEqual(
      { hintCount: player.hintCount, hintPenalty: player.hintPenalty, assisted: player.assisted, score: player.score },
      { hintCount: 1, hintPenalty: 5, assisted: true, score: 0 },
    );

    connection.socket.send(JSON.stringify({
      type: 'HINT',
      ...identity,
      boardIndex: 1,
      hintType: 'batchim-count',
    }));
    const wsDuplicate = await connection.inbox.wait(
      (message) => message.type === 'STATE' && message.playerState.gameState.assistance.hints.length === 1,
      'idempotent retry state',
    );
    assert.equal(wsDuplicate.playerState.gameState.assistance.hints[0].usedAt, wsHint.usedAt);

    connection.socket.send(JSON.stringify({
      type: 'HINT',
      ...identity,
      boardIndex: 8,
      hintType: 'batchim-count',
    }));
    await connection.inbox.wait(
      (message) => message.type === 'ERROR' && message.code === 'INVALID_BOARD',
      'invalid board error',
    );

    connection.socket.send(JSON.stringify({
      type: 'HINT',
      ...identity,
      language: 'en',
      boardIndex: 1,
      hintType: 'batchim-count',
    }));
    await connection.inbox.wait(
      (message) => message.type === 'ERROR' && message.code === 'INVALID_LANGUAGE',
      'invalid language error',
    );

    connection.socket.send(JSON.stringify({
      type: 'HINT',
      ...identity,
      boardIndex: 1,
      hintType: 'not-a-hint',
    }));
    await connection.inbox.wait(
      (message) => message.type === 'ERROR' && message.code === 'INVALID_HINT',
      'invalid hint type error',
    );

    connection.socket.close();
    await new Promise((resolve) => connection.socket.once('close', resolve));
    connection = await connectSocket(socketUrl);
    connection.socket.send(JSON.stringify({ type: 'JOIN', ...identity, profile: { displayName: 'WS Player' } }));
    const restored = await connection.inbox.wait((message) => message.type === 'STATE', 'reconnected state');
    assert.equal(restored.playerState.gameState.assistance.hints[0].usedAt, wsHint.usedAt);
    connection.socket.close();
  } finally {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 3000)).then(() => child.kill('SIGKILL')),
    ]);
  }
});
