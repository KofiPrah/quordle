import {
    appendHintUse,
    CHINESE_HINT_TYPES,
    findHintUse,
    HINT_COSTS,
    normalizeAssistanceState,
    PINYIN_CHINESE_HINT_TYPES,
} from './assistance.js';
import {
    CHINESE_PINYIN_PUZZLE_ANSWERS,
    PINYIN_PUZZLE_VARIANT,
    type ChinesePinyinPuzzleAnswer,
} from './chineseLexicon.js';
import type {
    BoardState,
    ChineseHintType,
    GameState,
    HintUse,
    LegacyChineseHintType,
    PinyinChineseHintType,
} from './types.js';

export type ChineseHintErrorCode = 'INVALID_LANGUAGE' | 'INVALID_BOARD' | 'GAME_OVER' | 'BOARD_SOLVED' | 'INVALID_HINT' | 'HINT_UNAVAILABLE';

export type ChineseHintResult =
    | { ok: true; state: GameState; hint: HintUse; duplicate: boolean }
    | { ok: false; code: ChineseHintErrorCode; message: string };

const LEGACY_HINT_TYPES = new Set<ChineseHintType>(CHINESE_HINT_TYPES);
const PINYIN_HINT_TYPES = new Set<ChineseHintType>(PINYIN_CHINESE_HINT_TYPES);
const PINYIN_ANSWER_BY_ID = new Map<string, ChinesePinyinPuzzleAnswer>(
    CHINESE_PINYIN_PUZZLE_ANSWERS.map((answer) => [answer.id, answer]),
);

function isFirstCharacterKnown(board: BoardState): boolean {
    return board.results.some((result) => result?.[0] === 'correct');
}

function getPinyinInitial(syllable: string): string {
    return /^(zh|ch|sh|[bpmfdtnlgkhjqxrzcs])/u.exec(syllable)?.[1] ?? '∅';
}

function getLegacyHintPayload(board: BoardState, type: LegacyChineseHintType): HintUse['payload'] | null {
    const answer = PINYIN_ANSWER_BY_ID.get(board.targetWord);
    if (!answer) return null;
    switch (type) {
        case 'tone-pattern':
            return [...answer.tones].map(String);
        case 'pinyin-initials': {
            const first = answer.key.slice(0, answer.syllableBoundary);
            const second = answer.key.slice(answer.syllableBoundary);
            return [getPinyinInitial(first), getPinyinInitial(second)];
        }
        case 'broad-meaning':
            return answer.broadMeaning;
        case 'reveal-first-character':
            return isFirstCharacterKnown(board) ? null : Array.from(answer.hanzi)[0];
    }
}

function getUnresolvedPositions(board: BoardState): number[] {
    return Array.from(board.targetWord).map((_letter, index) => index).filter(
        (index) => !board.results.some((result) => result?.[index] === 'correct'),
    );
}

function getPinyinAnswer(board: BoardState): ChinesePinyinPuzzleAnswer | null {
    if (!board.targetId) return null;
    const answer = PINYIN_ANSWER_BY_ID.get(board.targetId) ?? null;
    return answer?.key === board.targetWord ? answer : null;
}

function getPinyinHintPayload(board: BoardState, type: PinyinChineseHintType): HintUse['payload'] | null {
    const answer = getPinyinAnswer(board);
    if (!answer) return null;
    switch (type) {
        case 'syllable-boundary':
            return answer.syllableBoundary;
        case 'reveal-letter': {
            const unresolved = getUnresolvedPositions(board);
            if (unresolved.length < 2) return null;
            const index = unresolved[0];
            return { index, letter: answer.key[index] };
        }
        case 'broad-meaning':
            return answer.broadMeaning;
    }
}

function isAllowedHintType(gameState: GameState, type: ChineseHintType): boolean {
    return gameState.puzzleVariant === PINYIN_PUZZLE_VARIANT
        ? PINYIN_HINT_TYPES.has(type)
        : LEGACY_HINT_TYPES.has(type);
}

function getHintPayload(gameState: GameState, board: BoardState, type: ChineseHintType): HintUse['payload'] | null {
    return gameState.puzzleVariant === PINYIN_PUZZLE_VARIANT
        ? getPinyinHintPayload(board, type as PinyinChineseHintType)
        : getLegacyHintPayload(board, type as LegacyChineseHintType);
}

export function isChineseHintAvailable(gameState: GameState, boardIndex: number, type: ChineseHintType): boolean {
    if (gameState.language !== 'zh' || gameState.gameOver || !isAllowedHintType(gameState, type)) return false;
    if (!Number.isInteger(boardIndex) || boardIndex < 0 || boardIndex >= gameState.boards.length) return false;
    const board = gameState.boards[boardIndex];
    if (gameState.puzzleVariant === PINYIN_PUZZLE_VARIANT
        && findHintUse(gameState.assistance, boardIndex, type)) return false;
    return !board.solved && getHintPayload(gameState, board, type) !== null;
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
    if (!isAllowedHintType(gameState, type)) {
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

    const payload = getHintPayload(gameState, board, type);
    if (payload === null) {
        const message = type === 'reveal-first-character'
            ? 'The first character is already confirmed on this board.'
            : type === 'reveal-letter'
                ? 'At least two unresolved positions are required for this hint.'
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
