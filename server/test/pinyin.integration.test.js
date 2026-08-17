import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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

async function waitForRedis(baseUrl, child, logs) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/debug/persist`);
      const health = await response.json();
      if (health.redisConnected === true) return;
    } catch {}
    if (child.exitCode !== null) throw new Error(`server exited before Redis was ready\n${logs()}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server Redis connection timed out\n${logs()}`);
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
    await waitForRedis(baseUrl, child, () => output);
    const dateKey = '2026-08-17';
    const profile = { displayName: 'Canonical Player', avatarUrl: 'https://cdn.example/avatar.png' };
    const restIdentity = {
      roomId: 'pinyin-parity', userId: 'rest-player', dateKey, language: 'zh', puzzleVariant, guildId: 'guild-1', profile,
    };
    const wsIdentity = {
      roomId: 'pinyin-parity', visibleUserId: 'ws-player', dateKey, language: 'zh', puzzleVariant, guildId: 'guild-1', profile,
    };

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

    const missingPlayerSubmissionId = randomUUID();
    const missingPlayer = await post('/api/game/guess', {
      ...restIdentity,
      userId: 'missing-player',
      guess: 'jiejie',
      submissionId: missingPlayerSubmissionId,
    });
    assert.equal(missingPlayer.status, 404);
    assert.equal(missingPlayer.body.submissionId, missingPlayerSubmissionId);
    connection.socket.send(JSON.stringify({
      type: 'GUESS',
      ...wsIdentity,
      visibleUserId: 'missing-player',
      guess: 'jiejie',
      submissionId: missingPlayerSubmissionId,
    }));
    const missingWsPlayer = await connection.inbox.wait(
      (message) => message.type === 'ERROR' && message.code === 'PLAYER_NOT_FOUND',
      'correlated missing player error',
    );
    assert.equal(missingWsPlayer.submissionId, missingPlayerSubmissionId);
    connection.socket.send(JSON.stringify({
      type: 'HINT',
      ...wsIdentity,
      visibleUserId: 'missing-player',
      boardIndex: 0,
      hintType: 'syllable-boundary',
    }));
    assert.equal((await connection.inbox.wait(
      (message) => message.type === 'ERROR'
        && ['PLAYER_NOT_FOUND', 'INTERNAL_ERROR'].includes(message.code),
      'missing hint player error',
    )).code, 'PLAYER_NOT_FOUND');

    const errorCases = [
      ['xue/sheng', 'INVALID_FORMAT'],
      ['xue sheng', 'INVALID_LENGTH'],
      ['mi miao', 'NOT_IN_LIST'],
    ];
    for (const [guess, code] of errorCases) {
      const submissionId = randomUUID();
      const restError = await post('/api/game/guess', { ...restIdentity, guess, submissionId });
      assert.equal(restError.status, 400);
      assert.equal(restError.body.code, code);
      assert.equal(restError.body.submissionId, submissionId);
      connection.socket.send(JSON.stringify({ type: 'GUESS', ...wsIdentity, guess, submissionId }));
      const wsError = await connection.inbox.wait(
        (message) => message.type === 'ERROR' && message.code === code,
        `${code} WebSocket error`,
      );
      assert.equal(wsError.code, restError.body.code);
      assert.equal(wsError.submissionId, submissionId);
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
      ...restIdentity, puzzleVariant: undefined, guess: 'jiejie', submissionId: randomUUID(),
    });
    assert.equal(missingGuessVersion.status, 400);
    assert.equal(missingGuessVersion.body.code, 'UNSUPPORTED_PUZZLE_VERSION');
    connection.socket.send(JSON.stringify({
      type: 'GUESS', ...wsIdentity, puzzleVariant: 'hanzi-v1', guess: 'jiejie', submissionId: randomUUID(),
    }));
    assert.equal((await connection.inbox.wait(
      (message) => message.type === 'ERROR' && message.code === 'UNSUPPORTED_PUZZLE_VERSION',
      'guess version error',
    )).code, missingGuessVersion.body.code);

    const restSubmissionId = randomUUID();
    const wsSubmissionId = randomUUID();
    const restGuess = await post('/api/game/guess', {
      ...restIdentity, guess: 'jiě jie', submissionId: restSubmissionId,
    });
    assert.equal(restGuess.status, 200);
    assert.deepEqual(restGuess.body.pinyinSubmissionReceipt, {
      submissionId: restSubmissionId,
      normalizedGuess: 'jiejie',
      guessIndex: 0,
    });
    connection.socket.send(JSON.stringify({
      type: 'GUESS', ...wsIdentity, guess: 'jiě jie', submissionId: wsSubmissionId,
    }));
    const wsGuess = await connection.inbox.wait(
      (message) => message.type === 'STATE' && message.playerState.gameState.guessCount === 1,
      'accepted Pinyin state',
    );
    assert.deepEqual(wsGuess.playerState.pinyinSubmissionReceipt, {
      submissionId: wsSubmissionId,
      normalizedGuess: 'jiejie',
      guessIndex: 0,
    });
    assert.deepEqual(wsGuess.playerState.gameState, restGuess.body.gameState);
    assert.equal(restGuess.body.gameState.boards[1].solved, true);
    assert.ok(restGuess.body.gameState.boards.every((board) => board.guesses[0] === 'jiejie'));

    const duplicateRestGuess = await post('/api/game/guess', {
      ...restIdentity, guess: 'jie3 jie3', submissionId: restSubmissionId,
    });
    assert.equal(duplicateRestGuess.status, 200);
    assert.equal(duplicateRestGuess.body.gameState.guessCount, 1);
    assert.deepEqual(duplicateRestGuess.body.pinyinSubmissionReceipt, restGuess.body.pinyinSubmissionReceipt);
    connection.socket.send(JSON.stringify({
      type: 'GUESS', ...wsIdentity, guess: 'jie3 jie3', submissionId: wsSubmissionId,
    }));
    const duplicateWsGuess = await connection.inbox.wait(
      (message) => message.type === 'STATE'
        && message.playerState.pinyinSubmissionReceipt?.submissionId === wsSubmissionId,
      'idempotent Pinyin state',
    );
    assert.equal(duplicateWsGuess.playerState.gameState.guessCount, 1);

    const conflictingRestGuess = await post('/api/game/guess', {
      ...restIdentity, guess: 'gongsi', submissionId: restSubmissionId,
    });
    assert.equal(conflictingRestGuess.status, 409);
    assert.equal(conflictingRestGuess.body.code, 'SUBMISSION_ID_REUSED');
    assert.equal(conflictingRestGuess.body.submissionId, restSubmissionId);
    connection.socket.send(JSON.stringify({
      type: 'GUESS', ...wsIdentity, guess: 'gongsi', submissionId: wsSubmissionId,
    }));
    const conflictingWsGuess = await connection.inbox.wait(
      (message) => message.type === 'ERROR' && message.code === 'SUBMISSION_ID_REUSED',
      'reused submission ID error',
    );
    assert.equal(conflictingWsGuess.submissionId, wsSubmissionId);

    const restSubmissionB = randomUUID();
    const wsSubmissionB = randomUUID();
    const restGuessB = await post('/api/game/guess', {
      ...restIdentity, guess: 'gongsi', submissionId: restSubmissionB,
    });
    assert.equal(restGuessB.status, 200);
    assert.equal(restGuessB.body.gameState.guessCount, 2);
    connection.socket.send(JSON.stringify({
      type: 'GUESS', ...wsIdentity, guess: 'gongsi', submissionId: wsSubmissionB,
    }));
    const wsGuessB = await connection.inbox.wait(
      (message) => message.type === 'STATE' && message.playerState.gameState.guessCount === 2,
      'second accepted Pinyin state',
    );

    const oldRestReplay = await post('/api/game/guess', {
      ...restIdentity, guess: 'jie3 jie3', submissionId: restSubmissionId,
    });
    assert.equal(oldRestReplay.status, 200);
    assert.equal(oldRestReplay.body.gameState.guessCount, 2);
    assert.deepEqual(oldRestReplay.body.pinyinSubmissionReceipt, restGuessB.body.pinyinSubmissionReceipt);
    connection.socket.send(JSON.stringify({
      type: 'GUESS', ...wsIdentity, guess: 'jie3 jie3', submissionId: wsSubmissionId,
    }));
    const oldWsReplay = await connection.inbox.wait(
      (message) => message.type === 'STATE'
        && message.playerState.gameState.guessCount === 2
        && message.playerState.pinyinSubmissionReceipt?.submissionId === wsSubmissionB,
      'old idempotent Pinyin state',
    );
    assert.deepEqual(oldWsReplay.playerState.pinyinSubmissionReceipt, wsGuessB.playerState.pinyinSubmissionReceipt);

    const oldRestConflict = await post('/api/game/guess', {
      ...restIdentity, guess: 'qunian', submissionId: restSubmissionId,
    });
    assert.equal(oldRestConflict.status, 409);
    assert.equal(oldRestConflict.body.code, 'SUBMISSION_ID_REUSED');
    connection.socket.send(JSON.stringify({
      type: 'GUESS', ...wsIdentity, guess: 'qunian', submissionId: wsSubmissionId,
    }));
    assert.equal((await connection.inbox.wait(
      (message) => message.type === 'ERROR' && message.code === 'SUBMISSION_ID_REUSED',
      'old reused submission ID error',
    )).submissionId, wsSubmissionId);

    const restAfterIdempotency = await (
      await fetch(`${baseUrl}/api/room/pinyin-parity/${dateKey}/player/rest-player?language=zh&puzzleVariant=${puzzleVariant}`)
    ).json();
    assert.equal(restAfterIdempotency.playerState.gameState.guessCount, 2);
    const wsAfterIdempotency = await (
      await fetch(`${baseUrl}/api/room/pinyin-parity/${dateKey}/player/ws-player?language=zh&puzzleVariant=${puzzleVariant}`)
    ).json();
    assert.equal(wsAfterIdempotency.playerState.gameState.guessCount, 2);

    const restored = await post('/api/game/join', restIdentity);
    assert.equal(restored.body.gameState.guessCount, 2);
    assert.deepEqual(restored.body.pinyinSubmissionReceipt, restGuessB.body.pinyinSubmissionReceipt);
    connection.socket.send(JSON.stringify({ type: 'JOIN', ...wsIdentity }));
    const restoredWs = await connection.inbox.wait(
      (message) => message.type === 'STATE' && message.playerState.gameState.guessCount === 2,
      'restored WebSocket state',
    );
    assert.equal(restoredWs.playerState.gameState.guessCount, 2);
    assert.deepEqual(restoredWs.playerState.pinyinSubmissionReceipt, wsGuessB.playerState.pinyinSubmissionReceipt);

    const restHintWithReceipt = await post('/api/game/hint', {
      ...restIdentity, boardIndex: 0, hintType: 'syllable-boundary',
    });
    assert.deepEqual(
      restHintWithReceipt.body.pinyinSubmissionReceipt,
      restGuessB.body.pinyinSubmissionReceipt,
    );
    connection.socket.send(JSON.stringify({
      type: 'HINT', ...wsIdentity, boardIndex: 0, hintType: 'syllable-boundary',
    }));
    await connection.inbox.wait(
      (message) => message.type === 'STATE' && message.playerState.gameState.assistance?.hints?.length === 1,
      'WebSocket hint state',
    );

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
    assert.equal((await post('/api/game/guess', {
      ...unavailableIdentity, guess: 'jiejin', submissionId: randomUUID(),
    })).status, 200);
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

    let restFinalSubmissionId;
    let wsFinalSubmissionId;
    for (const target of ['qunian', 'lanqiu']) {
      restFinalSubmissionId = randomUUID();
      wsFinalSubmissionId = randomUUID();
      assert.equal((await post('/api/game/guess', {
        ...restIdentity, guess: target, submissionId: restFinalSubmissionId,
      })).status, 200);
      connection.socket.send(JSON.stringify({
        type: 'GUESS', ...wsIdentity, guess: target, submissionId: wsFinalSubmissionId,
      }));
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

    const finishRecords = await fakeRedis.waitForPublished(2);
    assert.equal(finishRecords.length, 2);
    assert.ok(finishRecords.every((record) => record.channel === 'activity:events'));
    const restFinish = finishRecords.find((record) => record.payload.visibleUserId === 'rest-player')?.payload;
    const wsFinish = finishRecords.find((record) => record.payload.visibleUserId === 'ws-player')?.payload;
    assert.ok(restFinish);
    assert.ok(wsFinish);
    assert.deepEqual(Object.keys(restFinish).sort(), Object.keys(wsFinish).sort());
    const withoutTransportIdentity = ({ visibleUserId, timestamp, ...event }) => event;
    assert.deepEqual(withoutTransportIdentity(restFinish), withoutTransportIdentity(wsFinish));
    assert.deepEqual({
      type: restFinish.type,
      roomId: restFinish.roomId,
      channelId: restFinish.channelId,
      guildId: restFinish.guildId,
      displayName: restFinish.displayName,
      avatarUrl: restFinish.avatarUrl,
      language: restFinish.language,
      puzzleVariant: restFinish.puzzleVariant,
      won: restFinish.won,
      guessCount: restFinish.guessCount,
      solvedBoards: restFinish.solvedBoards,
      totalBoards: restFinish.totalBoards,
      hintCount: restFinish.hintCount,
      hintPenalty: restFinish.hintPenalty,
      assisted: restFinish.assisted,
      score: restFinish.score,
    }, {
      type: 'DAILY_FINISHED',
      roomId: 'pinyin-parity',
      channelId: 'pinyin-parity',
      guildId: 'guild-1',
      displayName: 'Canonical Player',
      avatarUrl: 'https://cdn.example/avatar.png',
      language: 'zh',
      puzzleVariant,
      won: true,
      guessCount: 4,
      solvedBoards: 4,
      totalBoards: 4,
      hintCount: 1,
      hintPenalty: 2,
      assisted: true,
      score: 98,
    });

    const duplicateFinalRest = await post('/api/game/guess', {
      ...restIdentity, guess: 'lanqiu', submissionId: restFinalSubmissionId,
    });
    assert.equal(duplicateFinalRest.status, 200);
    assert.equal(duplicateFinalRest.body.gameState.guessCount, 4);
    connection.socket.send(JSON.stringify({
      type: 'GUESS', ...wsIdentity, guess: 'lanqiu', submissionId: wsFinalSubmissionId,
    }));
    assert.equal((await connection.inbox.wait(
      (message) => message.type === 'STATE' && message.playerState.gameState.gameOver,
      'completed latest-id replay state',
    )).playerState.gameState.guessCount, 4);

    const completedOldRestReplay = await post('/api/game/guess', {
      ...restIdentity, guess: 'jie3 jie3', submissionId: restSubmissionId,
    });
    assert.equal(completedOldRestReplay.status, 200);
    assert.equal(completedOldRestReplay.body.gameState.guessCount, 4);
    connection.socket.send(JSON.stringify({
      type: 'GUESS', ...wsIdentity, guess: 'jie3 jie3', submissionId: wsSubmissionId,
    }));
    assert.equal((await connection.inbox.wait(
      (message) => message.type === 'STATE' && message.playerState.gameState.gameOver,
      'completed old-id replay state',
    )).playerState.gameState.guessCount, 4);

    const completedConflict = await post('/api/game/guess', {
      ...restIdentity, guess: 'gongsi', submissionId: restSubmissionId,
    });
    assert.equal(completedConflict.status, 409);
    assert.equal(completedConflict.body.code, 'SUBMISSION_ID_REUSED');
    connection.socket.send(JSON.stringify({
      type: 'GUESS', ...wsIdentity, guess: 'gongsi', submissionId: wsSubmissionId,
    }));
    assert.equal((await connection.inbox.wait(
      (message) => message.type === 'ERROR' && message.code === 'SUBMISSION_ID_REUSED',
      'completed reused submission ID error',
    )).submissionId, wsSubmissionId);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(fakeRedis.published.length, 2);

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
    await fakeRedis.close();
  }
});
