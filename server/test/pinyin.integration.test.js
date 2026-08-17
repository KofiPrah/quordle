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
    } catch {}
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
    if (index < 0) queued.push(message);
    else {
      const [waiter] = waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  });
  return {
    wait(predicate, label) {
      const index = queued.findIndex(predicate);
      if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timer: null };
        waiter.timer = setTimeout(() => {
          const pending = waiters.indexOf(waiter);
          if (pending >= 0) waiters.splice(pending, 1);
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

test('Pinyin REST and WebSocket paths enforce one versioned authoritative contract', { timeout: 30_000 }, async () => {
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
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  try {
    await waitForHealth(baseUrl, child, () => output);
    const dateKey = '2026-08-17';
    const restIdentity = { roomId: 'pinyin-parity', userId: 'rest-player', dateKey, language: 'zh', puzzleVariant };
    const wsIdentity = { roomId: 'pinyin-parity', visibleUserId: 'ws-player', dateKey, language: 'zh', puzzleVariant };

    for (const badVariant of [undefined, 'hanzi-v1', 'unknown-v9']) {
      const rejected = await post('/api/game/join', { ...restIdentity, puzzleVariant: badVariant });
      assert.equal(rejected.status, 400);
      assert.equal(rejected.body.code, 'UNSUPPORTED_PUZZLE_VERSION');
    }

    const connection = await connectSocket(`ws://127.0.0.1:${port}/ws`);
    for (const badVariant of [undefined, 'hanzi-v1', 'unknown-v9']) {
      connection.socket.send(JSON.stringify({ type: 'JOIN', ...wsIdentity, puzzleVariant: badVariant }));
      const error = await connection.inbox.wait(
        (message) => message.type === 'ERROR' && message.code === 'UNSUPPORTED_PUZZLE_VERSION',
        'version error',
      );
      assert.equal(error.code, 'UNSUPPORTED_PUZZLE_VERSION');
    }

    const joined = await post('/api/game/join', restIdentity);
    assert.equal(joined.status, 200);
    assert.equal(joined.body.puzzleVariant, puzzleVariant);
    assert.equal(joined.body.gameState.puzzleVariant, puzzleVariant);
    assert.equal(joined.body.gameState.wordLength, 6);
    assert.equal(joined.body.gameState.maxGuesses, 9);
    assert.deepEqual(joined.body.gameState.boards.map((board) => board.targetWord), ['qunian', 'jiejie', 'gongsi', 'lanqiu']);
    assert.ok(joined.body.gameState.boards.every((board) => /^\p{Script=Han}{2}$/u.test(board.targetId)));

    connection.socket.send(JSON.stringify({ type: 'JOIN', ...wsIdentity }));
    const wsJoined = await connection.inbox.wait((message) => message.type === 'STATE', 'Pinyin state');
    assert.deepEqual(
      wsJoined.playerState.gameState.boards.map((board) => ({ targetWord: board.targetWord, targetId: board.targetId })),
      joined.body.gameState.boards.map((board) => ({ targetWord: board.targetWord, targetId: board.targetId })),
    );

    const errorCases = [
      ['xue/sheng', 'INVALID_FORMAT'],
      ['xue sheng', 'INVALID_LENGTH'],
      ['mi miao', 'NOT_IN_LIST'],
    ];
    for (const [guess, code] of errorCases) {
      const restError = await post('/api/game/guess', { ...restIdentity, guess });
      assert.equal(restError.status, 400);
      assert.equal(restError.body.code, code);
      connection.socket.send(JSON.stringify({ type: 'GUESS', ...wsIdentity, guess }));
      const wsError = await connection.inbox.wait(
        (message) => message.type === 'ERROR' && message.code === code,
        `${code} WebSocket error`,
      );
      assert.equal(wsError.code, restError.body.code);
    }

    const restAfterErrors = await (
      await fetch(`${baseUrl}/api/room/pinyin-parity/${dateKey}/player/rest-player?language=zh&puzzleVariant=${puzzleVariant}`)
    ).json();
    assert.equal(restAfterErrors.playerState.gameState.guessCount, 0);
    assert.ok(restAfterErrors.playerState.gameState.boards.every((board) => board.guesses.length === 0));

    const invalidAttempt = await post('/api/game/invalid-guess', {
      ...restIdentity, puzzleVariant: undefined, guess: 'xue/sheng', attemptId: randomUUID(),
    });
    assert.equal(invalidAttempt.body.code, 'UNSUPPORTED_PUZZLE_VERSION');
    connection.socket.send(JSON.stringify({
      type: 'INVALID_GUESS_ATTEMPT', ...wsIdentity, puzzleVariant: undefined,
      guess: 'xue/sheng', attemptId: randomUUID(),
    }));
    assert.equal((await connection.inbox.wait(
      (message) => message.type === 'ERROR' && message.code === 'UNSUPPORTED_PUZZLE_VERSION',
      'invalid-attempt version error',
    )).code, invalidAttempt.body.code);

    const missingGuessVersion = await post('/api/game/guess', {
      ...restIdentity, puzzleVariant: undefined, guess: 'jiejie',
    });
    assert.equal(missingGuessVersion.status, 400);
    assert.equal(missingGuessVersion.body.code, 'UNSUPPORTED_PUZZLE_VERSION');
    connection.socket.send(JSON.stringify({
      type: 'GUESS', ...wsIdentity, puzzleVariant: 'hanzi-v1', guess: 'jiejie',
    }));
    assert.equal((await connection.inbox.wait(
      (message) => message.type === 'ERROR' && message.code === 'UNSUPPORTED_PUZZLE_VERSION',
      'guess version error',
    )).code, missingGuessVersion.body.code);

    const restGuess = await post('/api/game/guess', { ...restIdentity, guess: 'jiě jie' });
    assert.equal(restGuess.status, 200);
    connection.socket.send(JSON.stringify({ type: 'GUESS', ...wsIdentity, guess: 'jiě jie' }));
    const wsGuess = await connection.inbox.wait(
      (message) => message.type === 'STATE' && message.playerState.gameState.guessCount === 1,
      'accepted Pinyin state',
    );
    assert.deepEqual(wsGuess.playerState.gameState, restGuess.body.gameState);
    assert.equal(restGuess.body.gameState.boards[1].solved, true);
    assert.ok(restGuess.body.gameState.boards.every((board) => board.guesses[0] === 'jiejie'));

    const restored = await post('/api/game/join', restIdentity);
    assert.equal(restored.body.gameState.guessCount, 1);
    connection.socket.send(JSON.stringify({ type: 'JOIN', ...wsIdentity }));
    assert.equal((await connection.inbox.wait(
      (message) => message.type === 'STATE' && message.playerState.gameState.guessCount === 1,
      'restored WebSocket state',
    )).playerState.gameState.guessCount, 1);

    const hintIdentity = { roomId: 'pinyin-hints', userId: 'hint-player', dateKey, language: 'zh', puzzleVariant };
    await post('/api/game/join', hintIdentity);
    const firstHint = await post('/api/game/hint', { ...hintIdentity, boardIndex: 0, hintType: 'syllable-boundary' });
    const duplicateHint = await post('/api/game/hint', { ...hintIdentity, boardIndex: 0, hintType: 'syllable-boundary' });
    assert.equal(firstHint.status, 200);
    assert.equal(duplicateHint.status, 200);
    assert.equal(duplicateHint.body.gameState.assistance.hints.length, 1);
    assert.equal(duplicateHint.body.gameState.assistance.hints[0].cost, 2);
    assert.equal(duplicateHint.body.gameState.assistance.hints[0].usedAt, firstHint.body.gameState.assistance.hints[0].usedAt);

    const unavailableIdentity = { roomId: 'pinyin-unavailable', userId: 'no-charge', dateKey, language: 'zh', puzzleVariant };
    const unavailableJoin = await post('/api/game/join', unavailableIdentity);
    const jiejieBoard = unavailableJoin.body.gameState.boards.findIndex((board) => board.targetWord === 'jiejie');
    assert.equal((await post('/api/game/guess', { ...unavailableIdentity, guess: 'jiejin' })).status, 200);
    const unavailable = await post('/api/game/hint', {
      ...unavailableIdentity, boardIndex: jiejieBoard, hintType: 'reveal-letter',
    });
    assert.equal(unavailable.status, 422);
    assert.equal(unavailable.body.code, 'HINT_UNAVAILABLE');
    const unchanged = await (
      await fetch(`${baseUrl}/api/room/pinyin-unavailable/${dateKey}/player/no-charge?language=zh&puzzleVariant=${puzzleVariant}`)
    ).json();
    assert.deepEqual(unchanged.playerState.gameState.assistance.hints, []);

    const wrongHintVersion = await post('/api/game/hint', {
      ...hintIdentity, puzzleVariant: 'hanzi-v1', boardIndex: 0, hintType: 'syllable-boundary',
    });
    assert.equal(wrongHintVersion.body.code, 'UNSUPPORTED_PUZZLE_VERSION');

    for (const target of ['qunian', 'gongsi', 'lanqiu']) {
      assert.equal((await post('/api/game/guess', { ...restIdentity, guess: target })).status, 200);
      connection.socket.send(JSON.stringify({ type: 'GUESS', ...wsIdentity, guess: target }));
      await connection.inbox.wait(
        (message) => message.type === 'STATE' && message.playerState.gameState.boards.some(
          (board) => board.targetWord === target && board.solved,
        ),
        `solved ${target}`,
      );
    }
    const restCompleted = await post('/api/game/join', restIdentity);
    assert.deepEqual(restCompleted.body.gameState, {
      ...restCompleted.body.gameState,
      guessCount: 4,
      gameOver: true,
      won: true,
    });

    const english = await post('/api/game/join', {
      roomId: restIdentity.roomId, userId: restIdentity.userId, dateKey, language: 'en',
    });
    assert.equal(english.status, 200);
    assert.equal(english.body.gameState.language, 'en');
    assert.equal(english.body.gameState.guessCount, 0);

    const leaderboard = await (
      await fetch(`${baseUrl}/api/room/pinyin-parity/${dateKey}/leaderboard?language=zh&puzzleVariant=${puzzleVariant}`)
    ).json();
    assert.equal(leaderboard.puzzleVariant, puzzleVariant);
    assert.deepEqual(
      leaderboard.leaderboard.map((entry) => entry.puzzleVariant),
      [puzzleVariant, puzzleVariant],
    );
    assert.deepEqual(
      new Set(leaderboard.leaderboard.map((entry) => entry.visibleUserId)),
      new Set(['rest-player', 'ws-player']),
    );
    connection.socket.close();
  } finally {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 3000)).then(() => child.kill('SIGKILL')),
    ]);
  }
});
