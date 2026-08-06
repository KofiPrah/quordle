import type { AssistanceState, GameState, HintType, HintUse } from './types.js';

export const ASSISTANCE_SCORING_VERSION = 1 as const;

export const HINT_COSTS: Readonly<Record<HintType, number>> = Object.freeze({
    'part-of-speech': 2,
    'semantic-category': 3,
    'batchim-count': 5,
    'reveal-first-syllable': 10,
});

export interface PerformanceMetrics {
    solvedCount: number;
    guessCount: number;
    hintCount: number;
    hintPenalty: number;
    assisted: boolean;
    score: number;
}

export function createEmptyAssistanceState(): AssistanceState {
    return {
        scoringVersion: ASSISTANCE_SCORING_VERSION,
        hints: [],
    };
}

function isHintType(value: unknown): value is HintType {
    return typeof value === 'string' && Object.prototype.hasOwnProperty.call(HINT_COSTS, value);
}

function normalizeHintUse(value: unknown): HintUse | null {
    if (!value || typeof value !== 'object') return null;
    const hint = value as Partial<HintUse>;
    if (!Number.isInteger(hint.boardIndex) || Number(hint.boardIndex) < 0 || Number(hint.boardIndex) > 3) return null;
    if (!isHintType(hint.type)) return null;
    if (!['string', 'number'].includes(typeof hint.payload) && !Array.isArray(hint.payload)) return null;
    if (Array.isArray(hint.payload) && !hint.payload.every((entry) => typeof entry === 'string')) return null;
    const cost = Number(hint.cost);
    const usedAt = Number(hint.usedAt);
    if (!Number.isFinite(cost) || cost < 0 || !Number.isFinite(usedAt) || usedAt < 0) return null;
    return {
        boardIndex: Number(hint.boardIndex),
        type: hint.type,
        payload: hint.payload as HintUse['payload'],
        cost,
        usedAt,
    };
}

export function normalizeAssistanceState(value: unknown): AssistanceState {
    if (!value || typeof value !== 'object') return createEmptyAssistanceState();
    const hints = Array.isArray((value as Partial<AssistanceState>).hints)
        ? (value as Partial<AssistanceState>).hints?.map(normalizeHintUse).filter((hint): hint is HintUse => hint !== null) ?? []
        : [];
    const uniqueHints = new Map<string, HintUse>();
    for (const hint of hints) {
        const key = `${hint.boardIndex}:${hint.type}`;
        if (!uniqueHints.has(key)) uniqueHints.set(key, hint);
    }
    return {
        scoringVersion: ASSISTANCE_SCORING_VERSION,
        hints: [...uniqueHints.values()],
    };
}

export function findHintUse(assistance: unknown, boardIndex: number, type: HintType): HintUse | null {
    return normalizeAssistanceState(assistance).hints.find(
        (hint) => hint.boardIndex === boardIndex && hint.type === type,
    ) ?? null;
}

export function appendHintUse(assistance: unknown, hint: HintUse): AssistanceState {
    const normalized = normalizeAssistanceState(assistance);
    if (findHintUse(normalized, hint.boardIndex, hint.type)) return normalized;
    return {
        scoringVersion: ASSISTANCE_SCORING_VERSION,
        hints: [...normalized.hints, hint],
    };
}

export function calculatePerformanceMetrics(gameState: Pick<GameState, 'boards' | 'guessCount'> & { assistance?: unknown }): PerformanceMetrics {
    const solvedCount = gameState.boards.filter((board) => board.solved).length;
    const guessCount = Number.isFinite(gameState.guessCount) ? Math.max(0, gameState.guessCount) : 0;
    const assistance = normalizeAssistanceState(gameState.assistance);
    const hintPenalty = assistance.hints.reduce((total, hint) => total + hint.cost, 0);
    const score = Math.max(
        0,
        (25 * solvedCount) - (2 * Math.max(0, guessCount - solvedCount)) - hintPenalty,
    );
    return {
        solvedCount,
        guessCount,
        hintCount: assistance.hints.length,
        hintPenalty,
        assisted: assistance.hints.length > 0,
        score,
    };
}
