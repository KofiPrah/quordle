import { appendHintUse, findHintUse, HINT_COSTS, normalizeAssistanceState } from './assistance.js';
import { decomposeHangul } from './jamo.js';
import { KO_HINT_METADATA } from './koHintMetadata.generated.js';
import type { GameState, HintType, HintUse } from './types.js';

export type KoreanHintErrorCode = 'INVALID_LANGUAGE' | 'INVALID_BOARD' | 'GAME_OVER' | 'BOARD_SOLVED' | 'INVALID_HINT' | 'HINT_UNAVAILABLE';

export type KoreanHintResult =
    | { ok: true; state: GameState; hint: HintUse; duplicate: boolean }
    | { ok: false; code: KoreanHintErrorCode; message: string };

const HINT_TYPES = new Set<HintType>(Object.keys(HINT_COSTS) as HintType[]);

function getHintPayload(targetWord: string, type: HintType): HintUse['payload'] | null {
    const metadata = KO_HINT_METADATA[targetWord as keyof typeof KO_HINT_METADATA];
    switch (type) {
        case 'part-of-speech':
            return metadata?.partsOfSpeech?.length ? [...metadata.partsOfSpeech] : null;
        case 'semantic-category':
            return metadata?.semanticCategories?.length
                ? metadata.semanticCategories.map((category) => category.english)
                : null;
        case 'batchim-count':
            return Array.from(targetWord).reduce(
                (count, syllable) => count + (decomposeHangul(syllable).coda ? 1 : 0),
                0,
            );
        case 'reveal-first-syllable':
            return Array.from(targetWord)[0] ?? null;
    }
}

export function isKoreanHintAvailable(targetWord: string, type: HintType): boolean {
    return HINT_TYPES.has(type) && getHintPayload(targetWord, type) !== null;
}

export function requestKoreanHint(
    gameState: GameState,
    boardIndex: number,
    type: HintType,
    usedAt = Date.now(),
): KoreanHintResult {
    if (gameState.language !== 'ko') {
        return { ok: false, code: 'INVALID_LANGUAGE', message: 'Hints are currently available only for Korean games.' };
    }
    if (!Number.isInteger(boardIndex) || boardIndex < 0 || boardIndex >= gameState.boards.length) {
        return { ok: false, code: 'INVALID_BOARD', message: 'Select a valid board.' };
    }
    if (!HINT_TYPES.has(type)) {
        return { ok: false, code: 'INVALID_HINT', message: 'Select a valid hint.' };
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

    const payload = getHintPayload(board.targetWord, type);
    if (payload === null) {
        return { ok: false, code: 'HINT_UNAVAILABLE', message: 'This hint is unavailable for the selected word.' };
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
