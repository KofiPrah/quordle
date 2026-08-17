import { escapeHtml } from './dictionary.js';
import { CHINESE_PINYIN_PUZZLE_VARIANT } from './chineseInput.js';

function displayTone(tone) {
  return tone === 5 ? 'neutral' : String(tone);
}

export function formatPinyinTones(tones) {
  const labels = Array.isArray(tones) ? tones.map(displayTone) : [];
  return {
    visible: labels.length > 0 ? `Tones ${labels.join(' · ')}` : '',
    accessible: labels.length > 0 ? `Tones: ${labels.join(' and ')}` : '',
  };
}

export function createPinyinLearningSurface(catalog) {
  const learningByTargetId = new Map(
    (Array.isArray(catalog) ? catalog : []).map((entry) => [entry.id, entry]),
  );

  const getPinyinLearningMetadata = (gameState, boardIndex) => {
    if (gameState?.language !== 'zh'
      || gameState?.puzzleVariant !== CHINESE_PINYIN_PUZZLE_VARIANT
      || !Array.isArray(gameState.boards)) return null;
    const board = gameState.boards[boardIndex];
    if (!board || (!board.solved && !gameState.gameOver)) return null;
    const metadata = learningByTargetId.get(board.targetId);
    if (!metadata || metadata.key !== board.targetWord) return null;
    return metadata;
  };

  const getVisiblePinyinLearningEntries = (gameState) => {
    if (!Array.isArray(gameState?.boards)) return [];
    return gameState.boards
      .map((_, boardIndex) => getPinyinLearningMetadata(gameState, boardIndex))
      .filter(Boolean);
  };

  const requirePinyinLearningMetadata = (gameState, boardIndex) => {
    const metadata = getPinyinLearningMetadata(gameState, boardIndex);
    if (!metadata) {
      throw new Error(`Missing canonical Pinyin learning metadata for solved board ${boardIndex + 1}.`);
    }
    return metadata;
  };

  const renderPinyinLearningSummary = (gameState, boardIndex) => {
    const metadata = getPinyinLearningMetadata(gameState, boardIndex);
    if (!metadata) return '';
    const tones = formatPinyinTones(metadata.tones);
    return `<span class="pinyin-learning-summary" data-learning-target="${escapeHtml(metadata.id)}"><strong class="pinyin-learning-hanzi" lang="zh-Hans">${escapeHtml(metadata.hanzi)}</strong><span class="pinyin-learning-pronunciation" lang="zh-Latn" aria-label="Pinyin: ${escapeHtml(metadata.pinyinMarked)}">${escapeHtml(metadata.pinyinMarked)}</span><span class="pinyin-learning-tones" aria-label="${escapeHtml(tones.accessible)}">${escapeHtml(tones.visible)}</span><span class="pinyin-learning-meaning">${escapeHtml(metadata.broadMeaning)}</span></span>`;
  };

  return {
    getPinyinLearningMetadata,
    getVisiblePinyinLearningEntries,
    requirePinyinLearningMetadata,
    renderPinyinLearningSummary,
  };
}
