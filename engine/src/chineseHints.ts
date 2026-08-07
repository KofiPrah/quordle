import {
    appendHintUse,
    CHINESE_HINT_TYPES,
    findHintUse,
    HINT_COSTS,
    normalizeAssistanceState,
} from './assistance.js';
import { ZH_HINT_METADATA } from './zhHintMetadata.generated.js';
import type { BoardState, ChineseHintType, GameState, HintUse } from './types.js';

export type ChineseHintErrorCode = 'INVALID_LANGUAGE' | 'INVALID_BOARD' | 'GAME_OVER' | 'BOARD_SOLVED' | 'INVALID_HINT' | 'HINT_UNAVAILABLE';

export type ChineseHintResult =
    | { ok: true; state: GameState; hint: HintUse; duplicate: boolean }
    | { ok: false; code: ChineseHintErrorCode; message: string };

const HINT_TYPES = new Set<ChineseHintType>(CHINESE_HINT_TYPES);

function isFirstCharacterKnown(board: BoardState): boolean {
    return board.results.some((result) => result?.[0] === 'correct');
}

function getHintPayload(board: BoardState, type: ChineseHintType): HintUse['payload'] | null {
    const metadata = ZH_HINT_METADATA[board.targetWord as keyof typeof ZH_HINT_METADATA];
    if (!metadata) return null;
    switch (type) {
        case 'tone-pattern':
            return [...metadata.tones].map(String);
        case 'pinyin':
            return metadata.pinyinMarked;
        case 'broad-meaning':
            return metadata.meaning;
        case 'reveal-first-character':
            return isFirstCharacterKnown(board) ? null : metadata.firstCharacter;
    }
}

export function isChineseHintAvailable(gameState: GameState, boardIndex: number, type: ChineseHintType): boolean {
    if (gameState.language !== 'zh' || gameState.gameOver || !HINT_TYPES.has(type)) return false;
    if (!Number.isInteger(boardIndex) || boardIndex < 0 || boardIndex >= gameState.boards.length) return false;
    const board = gameState.boards[boardIndex];
    return !board.solved && getHintPayload(board, type) !== null;
}

export function requestChineseHint(
    gameState: GameState,
    boardIndex: number,
    type: ChineseHintType,
    usedAt = Date.now(),
): ChineseHintResult {
    if (gameState.language !== 'zh') {
        return { ok: false, code: 'INVALID_LANGUAGE', message: 'Chinese hints require a Chinese game.' };
    }
    if (!Number.isInteger(boardIndex) || boardIndex < 0 || boardIndex >= gameState.boards.length) {
        return { ok: false, code: 'INVALID_BOARD', message: 'Select a valid board.' };
    }
    if (!HINT_TYPES.has(type)) {
        return { ok: false, code: 'INVALID_HINT', message: 'Select a valid Chinese hint.' };
    }

    const assistance = normalizeAssistanceState(gameState.assistance);
    const existing = findHintUse(assistance, boardIndex, type);
    if (existing) {
        return {
            ok: true,
            state: { ...gameState, assistance },
            hint: existing,
            duplicate: true,
        };
    }
    if (gameState.gameOver) {
        return { ok: false, code: 'GAME_OVER', message: 'Hints are unavailable after the game ends.' };
    }
    const board = gameState.boards[boardIndex];
    if (board.solved) {
        return { ok: false, code: 'BOARD_SOLVED', message: 'Select an unsolved board.' };
    }

    const payload = getHintPayload(board, type);
    if (payload === null) {
        const message = type === 'reveal-first-character'
            ? 'The first character is already confirmed on this board.'
            : 'This hint is unavailable for the selected word.';
        return { ok: false, code: 'HINT_UNAVAILABLE', message };
    }
    const hint: HintUse = {
        boardIndex,
        type,
        payload,
        cost: HINT_COSTS[type],
        usedAt,
    };
    return {
        ok: true,
        state: {
            ...gameState,
            assistance: appendHintUse(assistance, hint),
        },
        hint,
        duplicate: false,
    };
}
