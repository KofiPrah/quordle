import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDailyGame,
  normalizePinyinPlayerSubmissionState,
  transitionPlayerGuess,
} from '../gameplay.js';

const puzzleVariant = 'pinyin-latin-v2';

function createPlayer() {
  return {
    roomId: 'round-receipts',
    dateKey: '2026-08-17',
    visibleUserId: 'player',
    language: 'zh',
    puzzleVariant,
    profile: { displayName: 'Player', avatarUrl: null },
    gameState: createDailyGame('2026-08-17', 'zh', puzzleVariant),
    createdAt: 1,
    updatedAt: 1,
    finishedAt: null,
  };
}

function accept(player, guess, submissionId, timestamp) {
  const transition = transitionPlayerGuess(player, guess, {}, timestamp, submissionId);
  assert.equal(transition.ok, true);
  return transition;
}

test('Pinyin submission IDs remain idempotent and conflict-safe across intervening guesses and JSON restore', () => {
  const initial = createPlayer();
  const [guessA, guessB] = initial.gameState.boards.map((board) => board.targetWord);
  const acceptedA = accept(initial, guessA, 'submission-a', 10);
  const acceptedB = accept(acceptedA.playerState, guessB, 'submission-b', 20);
  const restored = JSON.parse(JSON.stringify(acceptedB.playerState));

  const replayA = transitionPlayerGuess(restored, guessA, {}, 30, 'submission-a');
  assert.equal(replayA.ok, true);
  assert.equal(replayA.idempotent, true);
  assert.equal(replayA.gameState.guessCount, 2);
  assert.deepEqual(replayA.playerState.gameState, restored.gameState);
  assert.deepEqual(replayA.playerState.pinyinSubmissionReceipt, {
    submissionId: 'submission-b',
    normalizedGuess: guessB,
    guessIndex: 1,
  });

  const conflictA = transitionPlayerGuess(restored, guessB, {}, 40, 'submission-a');
  assert.equal(conflictA.ok, false);
  assert.equal(conflictA.code, 'SUBMISSION_ID_REUSED');
  assert.equal(restored.gameState.guessCount, 2);
});

test('legacy singular receipts migrate into the bounded round-wide receipt history', () => {
  const initial = createPlayer();
  const [guessA, guessB] = initial.gameState.boards.map((board) => board.targetWord);
  const acceptedA = accept(initial, guessA, 'legacy-a', 10);
  const legacyPlayer = { ...acceptedA.playerState };
  delete legacyPlayer.pinyinSubmissionReceipts;

  const acceptedB = accept(legacyPlayer, guessB, 'submission-b', 20);
  assert.deepEqual(acceptedB.playerState.pinyinSubmissionReceipts, [
    { submissionId: 'legacy-a', normalizedGuess: guessA, guessIndex: 0 },
    { submissionId: 'submission-b', normalizedGuess: guessB, guessIndex: 1 },
  ]);

  const oversized = {
    ...initial,
    pinyinSubmissionReceipt: { submissionId: 'old-11', normalizedGuess: guessA, guessIndex: 11 },
    pinyinSubmissionReceipts: Array.from({ length: 12 }, (_, index) => ({
      submissionId: `old-${index}`,
      normalizedGuess: guessA,
      guessIndex: index,
    })),
  };
  const bounded = accept(oversized, guessB, 'new-submission', 30);
  assert.equal(bounded.playerState.pinyinSubmissionReceipts.length, 9);
  assert.deepEqual(
    bounded.playerState.pinyinSubmissionReceipts.map((receipt) => receipt.submissionId),
    ['old-4', 'old-5', 'old-6', 'old-7', 'old-8', 'old-9', 'old-10', 'old-11', 'new-submission'],
  );
});

test('malformed legacy receipt data is removed during Pinyin player normalization', () => {
  const normalized = normalizePinyinPlayerSubmissionState({
    ...createPlayer(),
    pinyinSubmissionReceipt: { submissionId: 'incomplete' },
    pinyinSubmissionReceipts: [{ submissionId: '', normalizedGuess: 'jiejie', guessIndex: 0 }],
  });

  assert.deepEqual(normalized.pinyinSubmissionReceipts, []);
  assert.equal(Object.hasOwn(normalized, 'pinyinSubmissionReceipt'), false);
});

test('a matching old submission ID replays authoritative state after completion without reopening the round', () => {
  let player = createPlayer();
  const guesses = player.gameState.boards.map((board) => board.targetWord);
  guesses.forEach((guess, index) => {
    player = accept(player, guess, `submission-${index}`, 10 + index).playerState;
  });
  assert.equal(player.gameState.gameOver, true);

  const replay = transitionPlayerGuess(player, guesses[0], {}, 100, 'submission-0');
  assert.equal(replay.ok, true);
  assert.equal(replay.idempotent, true);
  assert.equal(replay.justCompleted, false);
  assert.equal(replay.gameState.guessCount, 4);
  assert.equal(replay.gameState.gameOver, true);

  const conflict = transitionPlayerGuess(player, guesses[1], {}, 101, 'submission-0');
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'SUBMISSION_ID_REUSED');
  assert.equal(player.gameState.guessCount, 4);
});
