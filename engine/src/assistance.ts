import { PINYIN_PUZZLE_VARIANT } from './chineseLexicon.js';
import type {
    AssistanceState,
    GameState,
    HintType,
    HintUse,
    KoreanHintType,
    Language,
    LegacyChineseHintType,
    PinyinChineseHintType,
    PinyinChineseHintUse,
    RevealLetterHintPayload,
} from './types.js';

export const ASSISTANCE_SCORING_VERSION = 1 as const;
export const PINYIN_ASSISTANCE_SCORING_VERSION = 2 as const;

export const HINT_COSTS: Readonly<Record<HintType, number>> = Object.freeze({
    'part-of-speech': 2,
    'semantic-category': 3,
    'batchim-count': 5,
    'reveal-first-syllable': 10,
    'tone-pattern': 2,
    'pinyin-initials': 5,
    'broad-meaning': 7,
    'reveal-first-character': 10,
    'syllable-boundary': 2,
    'reveal-letter': 5,
});

export const KOREAN_HINT_TYPES: readonly KoreanHintType[] = Object.freeze([
    'part-of-speech',
    'semantic-category',
    'batchim-count',
    'reveal-first-syllable',
]);

export const CHINESE_HINT_TYPES: readonly LegacyChineseHintType[] = Object.freeze([
    'tone-pattern',
    'pinyin-initials',
    'broad-meaning',
    'reveal-first-character',
]);

export const PINYIN_CHINESE_HINT_TYPES: readonly PinyinChineseHintType[] = Object.freeze([
    'syllable-boundary',
    'reveal-letter',
    'broad-meaning',
]);

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

export function isHintTypeForLanguage(value: unknown, language: Language): value is HintType {
    if (language === 'ko') return KOREAN_HINT_TYPES.includes(value as KoreanHintType);
    if (language === 'zh') {
        return CHINESE_HINT_TYPES.includes(value as LegacyChineseHintType)
            || PINYIN_CHINESE_HINT_TYPES.includes(value as PinyinChineseHintType);
    }
    return false;
}

function isRevealLetterPayload(value: unknown): value is RevealLetterHintPayload {
    if (!value || typeof value !== 'object') return false;
    const payload = value as Partial<RevealLetterHintPayload>;
    return Number.isInteger(payload.index)
        && Number(payload.index) >= 0
        && typeof payload.letter === 'string'
        && /^[a-z]$/u.test(payload.letter);
}

function isVersionTwoPayload(type: HintType, payload: unknown): boolean {
    if (!PINYIN_CHINESE_HINT_TYPES.includes(type as PinyinChineseHintType)) return false;
    if (type === 'syllable-boundary') return Number.isInteger(payload) && Number(payload) > 0;
    if (type === 'reveal-letter') return isRevealLetterPayload(payload);
    return typeof payload === 'string' && payload.length > 0;
}

function normalizeHintUse(value: unknown, scoringVersion: 1 | 2): HintUse | null {
    if (!value || typeof value !== 'object') return null;
    const hint = value as Partial<HintUse>;
    if (!Number.isInteger(hint.boardIndex) || Number(hint.boardIndex) < 0 || Number(hint.boardIndex) > 3) return null;
    if (!isHintType(hint.type)) return null;
    if (scoringVersion === 2) {
        if (!isVersionTwoPayload(hint.type, hint.payload)) return null;
    } else {
        const isLegacyType = KOREAN_HINT_TYPES.includes(hint.type as KoreanHintType)
            || CHINESE_HINT_TYPES.includes(hint.type as LegacyChineseHintType);
        if (!isLegacyType) return null;
        if (!['string', 'number'].includes(typeof hint.payload) && !Array.isArray(hint.payload)) return null;
        if (Array.isArray(hint.payload) && !hint.payload.every((entry) => typeof entry === 'string')) return null;
    }
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
    const candidate = value as Partial<AssistanceState>;
    const isPinyinVersionTwo = candidate.scoringVersion === PINYIN_ASSISTANCE_SCORING_VERSION
        && candidate.puzzleVariant === PINYIN_PUZZLE_VARIANT;
    const scoringVersion = isPinyinVersionTwo ? PINYIN_ASSISTANCE_SCORING_VERSION : ASSISTANCE_SCORING_VERSION;
    const hints = Array.isArray(candidate.hints)
        ? candidate.hints.map((hint) => normalizeHintUse(hint, scoringVersion)).filter((hint): hint is HintUse => hint !== null)
        : [];
    const uniqueHints = new Map<string, HintUse>();
    for (const hint of hints) {
        const key = `${hint.boardIndex}:${hint.type}`;
        if (!uniqueHints.has(key)) uniqueHints.set(key, hint);
    }
    if (isPinyinVersionTwo) {
        return {
            scoringVersion: PINYIN_ASSISTANCE_SCORING_VERSION,
            puzzleVariant: PINYIN_PUZZLE_VARIANT,
            hints: [...uniqueHints.values()] as PinyinChineseHintUse[],
        };
    }
    return { scoringVersion: ASSISTANCE_SCORING_VERSION, hints: [...uniqueHints.values()] };
}

export function findHintUse(assistance: unknown, boardIndex: number, type: HintType): HintUse | null {
    return normalizeAssistanceState(assistance).hints.find(
        (hint) => hint.boardIndex === boardIndex && hint.type === type,
    ) ?? null;
}

export function appendHintUse(assistance: unknown, hint: HintUse): AssistanceState {
    const normalized = normalizeAssistanceState(assistance);
    if (findHintUse(normalized, hint.boardIndex, hint.type)) return normalized;
    if (normalized.scoringVersion === PINYIN_ASSISTANCE_SCORING_VERSION) {
        return {
            scoringVersion: PINYIN_ASSISTANCE_SCORING_VERSION,
            puzzleVariant: PINYIN_PUZZLE_VARIANT,
            hints: [...normalized.hints, hint as PinyinChineseHintUse],
        };
    }
    return { scoringVersion: ASSISTANCE_SCORING_VERSION, hints: [...normalized.hints, hint] };
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
