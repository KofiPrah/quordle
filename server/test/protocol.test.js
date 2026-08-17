import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ErrorCodes,
  isGuessMessage,
  isHintMessage,
  isInvalidGuessAttemptMessage,
  isJoinMessage,
  makePlayerKey,
  makeRoomKey,
  sortLeaderboard,
  toLeaderboardEntry,
} from '../dist/protocol.js';

function entry(overrides) {
  return {
    visibleUserId: overrides.visibleUserId,
    profile: { displayName: overrides.visibleUserId, avatarUrl: null },
    solvedCount: 3,
    score: 70,
    guessCount: 5,
    hintCount: 0,
    hintPenalty: 0,
    assisted: false,
    gameOver: false,
    won: false,
    finishedAt: null,
    ...overrides,
  };
}

test('hint protocol validates the complete request contract', () => {
  const valid = {
    type: 'HINT',
    roomId: 'room',
    dateKey: '2026-08-06',
    visibleUserId: 'player',
    language: 'ko',
    boardIndex: 0,
    hintType: 'part-of-speech',
  };
  assert.equal(isHintMessage(valid), true);
  assert.equal(isHintMessage({ ...valid, boardIndex: 0.5 }), false);
  assert.equal(isHintMessage({ ...valid, hintType: 7 }), false);
  assert.equal(ErrorCodes.INVALID_LANGUAGE, 'INVALID_LANGUAGE');
});

test('Chinese protocol guards require the exact Pinyin puzzle version', () => {
  const join = {
    type: 'JOIN',
    roomId: 'room',
    dateKey: '2026-08-17',
    visibleUserId: 'player',
    language: 'zh',
    puzzleVariant: 'pinyin-latin-v2',
  };
  const guess = { ...join, type: 'GUESS', guess: 'qu nian' };
  const hint = { ...join, type: 'HINT', boardIndex: 0, hintType: 'syllable-boundary' };
  const invalidAttempt = { ...join, type: 'INVALID_GUESS_ATTEMPT', guess: 'qu/nian', attemptId: 'attempt' };

  assert.equal(isJoinMessage(join), true);
  assert.equal(isGuessMessage(guess), true);
  assert.equal(isHintMessage(hint), true);
  assert.equal(isInvalidGuessAttemptMessage(invalidAttempt), true);
  assert.equal(isJoinMessage({ ...join, puzzleVariant: undefined }), false);
  assert.equal(isGuessMessage({ ...guess, puzzleVariant: 'hanzi-v1' }), false);
  assert.equal(isHintMessage({ ...hint, puzzleVariant: undefined }), false);
  assert.equal(isInvalidGuessAttemptMessage({ ...invalidAttempt, puzzleVariant: undefined }), false);
  assert.equal(isJoinMessage({ ...join, language: 'ko', puzzleVariant: undefined }), true);
  assert.equal(ErrorCodes.UNSUPPORTED_PUZZLE_VERSION, 'UNSUPPORTED_PUZZLE_VERSION');
  assert.equal(ErrorCodes.INVALID_FORMAT, 'INVALID_FORMAT');
  assert.equal(ErrorCodes.INVALID_LENGTH, 'INVALID_LENGTH');
  assert.equal(ErrorCodes.NOT_IN_LIST, 'NOT_IN_LIST');
  assert.equal(makeRoomKey('room', '2026-08-17', 'zh', 'pinyin-latin-v2'), 'room:2026-08-17:zh:pinyin-latin-v2');
  assert.equal(
    makePlayerKey('room', '2026-08-17', 'player', 'zh', 'pinyin-latin-v2'),
    'room:2026-08-17:zh:pinyin-latin-v2:player',
  );
});

test('legacy players normalize to unassisted leaderboard scoring', () => {
  const player = {
    visibleUserId: 'legacy',
    roomId: 'room',
    dateKey: '2026-08-06',
    mode: 'daily',
    language: 'en',
    profile: { displayName: 'Legacy', avatarUrl: null },
    gameState: {
      boards: [
        { solved: true },
        { solved: true },
        { solved: false },
        { solved: false },
      ],
      guessCount: 4,
      gameOver: false,
      won: false,
    },
    createdAt: 1,
    updatedAt: 1,
    finishedAt: null,
  };
  assert.deepEqual(
    toLeaderboardEntry(player),
    {
      visibleUserId: 'legacy',
      profile: player.profile,
      solvedCount: 2,
      guessCount: 4,
      hintCount: 0,
      hintPenalty: 0,
      assisted: false,
      score: 46,
      gameOver: false,
      won: false,
      finishedAt: null,
    },
  );
});

test('leaderboard ranking applies boards, score, guesses, then finish time', () => {
  const entries = [
    entry({ visibleUserId: 'unfinished', finishedAt: null }),
    entry({ visibleUserId: 'late', finishedAt: 200 }),
    entry({ visibleUserId: 'more-guesses', guessCount: 6, finishedAt: 50 }),
    entry({ visibleUserId: 'fewer-guesses', guessCount: 3, finishedAt: 300 }),
    entry({ visibleUserId: 'higher-score', score: 71, guessCount: 8, finishedAt: 400 }),
    entry({ visibleUserId: 'more-boards', solvedCount: 4, score: 1, guessCount: 9, finishedAt: 500 }),
    entry({ visibleUserId: 'early', finishedAt: 100 }),
  ];

  assert.deepEqual(
    sortLeaderboard(entries).map((candidate) => candidate.visibleUserId),
    ['more-boards', 'higher-score', 'fewer-guesses', 'early', 'late', 'unfinished', 'more-guesses'],
  );
});
