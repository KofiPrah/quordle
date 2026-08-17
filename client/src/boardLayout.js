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

const BOARD_LAYOUT_MODES = new Set(['overview', 'focus']);
export const OVERVIEW_MIN_TILE_WIDTH = 24;

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

export function estimateOverviewTileWidth({
  viewportWidth,
  safeAreaLeft = 0,
  safeAreaRight = 0,
  contentPaddingLeft = 0,
  contentPaddingRight = 0,
  stagePaddingLeft = 0,
  stagePaddingRight = 0,
  stageBorderLeft = 0,
  stageBorderRight = 0,
  boardGap = 0,
  boardPaddingLeft = 0,
  boardPaddingRight = 0,
  boardBorderLeft = 0,
  boardBorderRight = 0,
  tileGap = 0,
  wordLength,
} = {}) {
  const length = Number(wordLength);
  if (!Number.isInteger(length) || length <= 0) return 0;

  const stageWidth = Math.max(0,
    finiteNonNegative(viewportWidth)
      - finiteNonNegative(safeAreaLeft)
      - finiteNonNegative(safeAreaRight)
      - finiteNonNegative(contentPaddingLeft)
      - finiteNonNegative(contentPaddingRight)
      - finiteNonNegative(stagePaddingLeft)
      - finiteNonNegative(stagePaddingRight)
      - finiteNonNegative(stageBorderLeft)
      - finiteNonNegative(stageBorderRight));
  const boardWidth = Math.max(0, (stageWidth - finiteNonNegative(boardGap)) / 2);
  const tileSpace = Math.max(0,
    boardWidth
      - finiteNonNegative(boardPaddingLeft)
      - finiteNonNegative(boardPaddingRight)
      - finiteNonNegative(boardBorderLeft)
      - finiteNonNegative(boardBorderRight)
      - ((length - 1) * finiteNonNegative(tileGap)));
  return tileSpace / length;
}

export function getDefaultBoardLayoutMode(estimatedTileWidth) {
  return finiteNonNegative(estimatedTileWidth) >= OVERVIEW_MIN_TILE_WIDTH ? 'overview' : 'focus';
}

export function setRoundBoardLayoutMode(state, roundId, mode) {
  if (typeof roundId !== 'string' || !roundId || !BOARD_LAYOUT_MODES.has(mode)) return state ?? null;
  return { roundId, manualMode: mode };
}

export function resolveRoundBoardLayoutMode(state, roundId, estimatedTileWidth) {
  if (state?.roundId === roundId && BOARD_LAYOUT_MODES.has(state.manualMode)) {
    return state.manualMode;
  }
  return getDefaultBoardLayoutMode(estimatedTileWidth);
}

export function getVisibleActiveBoardEntries(boards = [], mode = 'overview', selectedBoardIndex = null) {
  const { active } = partitionBoards(boards);
  if (mode !== 'focus') return active;
  const selected = reconcileSelectedBoardIndex(boards, selectedBoardIndex);
  return active.filter(({ index }) => index === selected);
}

export function rerenderAdaptiveBoardLayout({
  layoutModeChanged = false,
  overlayActive = false,
  render,
  bindListeners,
  restoreOverlayFocus,
} = {}) {
  if (!layoutModeChanged) return false;
  render?.();
  bindListeners?.();
  if (overlayActive) restoreOverlayFocus?.();
  return true;
}

export function getSolvedHistoryFocusSelector(layoutMode, boardIndex) {
  if (!Number.isInteger(boardIndex) || boardIndex < 0) return null;
  return layoutMode === 'focus'
    ? `[data-board-status="${boardIndex}"]`
    : `[data-toggle-solved-board="${boardIndex}"]`;
}

export function activateBoardStatus(
  boards = [],
  selectedBoardIndex = null,
  expandedSolvedBoardIndex = null,
  boardIndex,
) {
  const selected = reconcileSelectedBoardIndex(boards, selectedBoardIndex);
  if (!Number.isInteger(boardIndex) || !boards[boardIndex]) {
    return {
      selectedBoardIndex: selected,
      expandedSolvedBoardIndex: reconcileExpandedSolvedBoardIndex(boards, expandedSolvedBoardIndex),
      action: null,
    };
  }
  if (boards[boardIndex].solved) {
    return {
      selectedBoardIndex: selected,
      expandedSolvedBoardIndex: toggleExpandedSolvedBoardIndex(boards, expandedSolvedBoardIndex, boardIndex),
      action: 'history',
    };
  }
  return {
    selectedBoardIndex: boardIndex,
    expandedSolvedBoardIndex: null,
    action: 'select',
  };
}
