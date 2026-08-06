export function partitionBoards(boards = []) {
  return boards.reduce((groups, board, index) => {
    const entry = { board, index };
    if (board?.solved) {
      groups.solved.push(entry);
    } else {
      groups.active.push(entry);
    }
    return groups;
  }, { active: [], solved: [] });
}

export function getRemainingGuessCount(maxGuesses, guessCount) {
  const maximum = Number.isFinite(maxGuesses) ? Math.max(0, maxGuesses) : 0;
  const used = Number.isFinite(guessCount) ? Math.max(0, guessCount) : 0;
  return Math.max(0, maximum - used);
}

export function reconcileSelectedBoardIndex(boards = [], selectedBoardIndex = null) {
  const activeIndices = boards
    .map((board, index) => board?.solved ? null : index)
    .filter((index) => index !== null);

  if (activeIndices.length === 0) return null;
  return activeIndices.includes(selectedBoardIndex) ? selectedBoardIndex : activeIndices[0];
}

export function reconcileExpandedSolvedBoardIndex(boards = [], expandedBoardIndex = null) {
  if (!Number.isInteger(expandedBoardIndex)) return null;
  return boards[expandedBoardIndex]?.solved ? expandedBoardIndex : null;
}

export function toggleExpandedSolvedBoardIndex(boards = [], expandedBoardIndex = null, boardIndex) {
  if (!Number.isInteger(boardIndex) || !boards[boardIndex]?.solved) return null;
  return expandedBoardIndex === boardIndex ? null : boardIndex;
}
