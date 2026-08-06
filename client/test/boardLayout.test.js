import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getRemainingGuessCount,
  partitionBoards,
  reconcileExpandedSolvedBoardIndex,
  reconcileSelectedBoardIndex,
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
