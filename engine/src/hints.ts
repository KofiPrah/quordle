import { isChineseHintAvailable, requestChineseHint } from './chineseHints.js';
import { isKoreanHintAvailable, requestKoreanHint } from './koreanHints.js';
import type { ChineseHintType, GameState, HintType, KoreanHintType } from './types.js';

export function isHintAvailable(gameState: GameState, boardIndex: number, type: HintType): boolean {
    if (!Number.isInteger(boardIndex) || boardIndex < 0 || boardIndex >= gameState.boards.length) return false;
    if (gameState.gameOver || gameState.boards[boardIndex].solved) return false;
    if (gameState.language === 'ko') {
        return isKoreanHintAvailable(gameState.boards[boardIndex].targetWord, type as KoreanHintType);
    }
    if (gameState.language === 'zh') {
        return isChineseHintAvailable(gameState, boardIndex, type as ChineseHintType);
    }
    return false;
}

export function requestHint(gameState: GameState, boardIndex: number, type: HintType, usedAt = Date.now()) {
    if (gameState.language === 'ko') {
        return requestKoreanHint(gameState, boardIndex, type as KoreanHintType, usedAt);
    }
    if (gameState.language === 'zh') {
        return requestChineseHint(gameState, boardIndex, type as ChineseHintType, usedAt);
    }
    return { ok: false as const, code: 'INVALID_LANGUAGE' as const, message: 'Hints are unavailable for this language.' };
}
