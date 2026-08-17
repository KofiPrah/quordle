import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activateBoardStatus,
  estimateOverviewTileWidth,
  getDefaultBoardLayoutMode,
  getRemainingGuessCount,
  getVisibleActiveBoardEntries,
  partitionBoards,
  reconcileExpandedSolvedBoardIndex,
  resolveRoundBoardLayoutMode,
  reconcileSelectedBoardIndex,
  setRoundBoardLayoutMode,
  toggleExpandedSolvedBoardIndex,
} from '../src/boardLayout.js';

function boardsWithSolvedCount(solvedCount) {
  return Array.from({ length: 4 }, (_, index) => ({ solved: index < solvedCount }));
}

test('partitionBoards preserves board indexes and ordering for every solved count', () => {
  for (let solvedCount = 0; solvedCount <= 4; solvedCount += 1) {
    const groups = partitionBoards(boardsWithSolvedCount(solvedCount));
    assert.deepEqual(groups.solved.map(({ index }) => index), Array.from({ length: solvedCount }, (_, index) => index));
    assert.deepEqual(groups.active.map(({ index }) => index), Array.from({ length: 4 - solvedCount }, (_, index) => index + solvedCount));
  }
});

test('getRemainingGuessCount clamps invalid and exhausted counts', () => {
  assert.equal(getRemainingGuessCount(9, 0), 9);
  assert.equal(getRemainingGuessCount(9, 8), 1);
  assert.equal(getRemainingGuessCount(9, 9), 0);
  assert.equal(getRemainingGuessCount(9, 12), 0);
  assert.equal(getRemainingGuessCount(undefined, 2), 0);
});

test('selection defaults to the first unsolved board and stays while active', () => {
  const boards = [
    { solved: true },
    { solved: false },
    { solved: false },
    { solved: true },
  ];

  assert.equal(reconcileSelectedBoardIndex(boards, null), 1);
  assert.equal(reconcileSelectedBoardIndex(boards, 2), 2);
  assert.equal(reconcileSelectedBoardIndex(boards, 0), 1);
});

test('selection advances to the lowest-numbered unsolved board after a solve', () => {
  const boards = [
    { solved: false },
    { solved: true },
    { solved: true },
    { solved: false },
  ];

  assert.equal(reconcileSelectedBoardIndex(boards, 1), 0);
  assert.equal(reconcileSelectedBoardIndex(boardsWithSolvedCount(4), 3), null);
});

test('expanded solved boards reconcile and toggle exclusively', () => {
  const boards = [
    { solved: true },
    { solved: false },
    { solved: true },
    { solved: false },
  ];
  const originalBoards = structuredClone(boards);

  assert.equal(reconcileExpandedSolvedBoardIndex(boards, 0), 0);
  assert.equal(reconcileExpandedSolvedBoardIndex(boards, 1), null);
  assert.equal(toggleExpandedSolvedBoardIndex(boards, null, 0), 0);
  assert.equal(toggleExpandedSolvedBoardIndex(boards, 0, 2), 2);
  assert.equal(toggleExpandedSolvedBoardIndex(boards, 2, 2), null);
  assert.equal(toggleExpandedSolvedBoardIndex(boards, 0, 1), null);
  assert.deepEqual(boards, originalBoards);
});

const narrowMobileGeometry = {
  viewportWidth: 320,
  safeAreaLeft: 0,
  safeAreaRight: 0,
  contentPaddingLeft: 4,
  contentPaddingRight: 4,
  stagePaddingLeft: 5,
  stagePaddingRight: 5,
  boardGap: 4,
  boardPaddingLeft: 3,
  boardPaddingRight: 3,
  tileGap: 2,
};

test('overview defaults at the inclusive 24px tile-width boundary', () => {
  const atThreshold = estimateOverviewTileWidth({
    ...narrowMobileGeometry,
    viewportWidth: 342,
    wordLength: 6,
  });
  const belowThreshold = estimateOverviewTileWidth({
    ...narrowMobileGeometry,
    viewportWidth: 341,
    wordLength: 6,
  });

  assert.equal(atThreshold, 24);
  assert.ok(belowThreshold < 24);
  assert.equal(getDefaultBoardLayoutMode(atThreshold), 'overview');
  assert.equal(getDefaultBoardLayoutMode(belowThreshold), 'focus');
});

test('narrow mobile defaults account for safe area and 5, 6, and 7-letter geometry', () => {
  assert.equal(getDefaultBoardLayoutMode(estimateOverviewTileWidth({
    ...narrowMobileGeometry,
    wordLength: 5,
  })), 'overview');
  assert.equal(getDefaultBoardLayoutMode(estimateOverviewTileWidth({
    ...narrowMobileGeometry,
    wordLength: 6,
  })), 'focus');
  assert.equal(getDefaultBoardLayoutMode(estimateOverviewTileWidth({
    ...narrowMobileGeometry,
    wordLength: 7,
  })), 'focus');

  const withDiscordSafeArea = estimateOverviewTileWidth({
    ...narrowMobileGeometry,
    viewportWidth: 342,
    safeAreaLeft: 12,
    safeAreaRight: 10,
    wordLength: 6,
  });
  assert.ok(withDiscordSafeArea < 24);
});

test('manual layout choice survives rerenders only for its versioned round', () => {
  const roundId = 'daily:2026-08-17:zh:pinyin-latin-v2';
  const state = setRoundBoardLayoutMode(null, roundId, 'overview');

  assert.equal(resolveRoundBoardLayoutMode(state, roundId, 18), 'overview');
  assert.equal(resolveRoundBoardLayoutMode(state, 'daily:2026-08-18:zh:pinyin-latin-v2', 18), 'focus');
  assert.equal(resolveRoundBoardLayoutMode(state, roundId, 30), 'overview');
});

test('focus navigation selects an unsolved hint target and opens solved history', () => {
  const boards = [
    { solved: false },
    { solved: true },
    { solved: false },
    { solved: false },
  ];

  assert.deepEqual(activateBoardStatus(boards, 0, null, 2), {
    selectedBoardIndex: 2,
    expandedSolvedBoardIndex: null,
    action: 'select',
  });
  assert.deepEqual(activateBoardStatus(boards, 2, null, 1), {
    selectedBoardIndex: 2,
    expandedSolvedBoardIndex: 1,
    action: 'history',
  });
});

test('overview and focus reuse the same draft and confirmed board histories', () => {
  const gameState = {
    currentGuess: 'peng',
    boards: [
      { solved: false, guesses: ['xuesheng'] },
      { solved: true, guesses: ['pengyou'] },
      { solved: false, guesses: ['xuesheng'] },
      { solved: false, guesses: ['xuesheng'] },
    ],
  };
  const original = structuredClone(gameState);

  const overview = getVisibleActiveBoardEntries(gameState.boards, 'overview', 0);
  const focus = getVisibleActiveBoardEntries(gameState.boards, 'focus', 2);

  assert.deepEqual(overview.map(({ index }) => index), [0, 2, 3]);
  assert.deepEqual(focus.map(({ index }) => index), [2]);
  assert.equal(overview[1].board, gameState.boards[2]);
  assert.equal(focus[0].board, gameState.boards[2]);
  assert.deepEqual(gameState, original);
});
