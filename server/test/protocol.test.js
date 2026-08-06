import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ErrorCodes,
  isHintMessage,
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
