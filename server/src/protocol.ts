import { calculatePerformanceMetrics } from '@quordle/engine/assistance';
import type { GameState, HintType, PuzzleVariant } from '@quordle/engine';

// ============================================================================
// Keys
// ============================================================================

/** Supported languages */
export type Language = 'en' | 'ko' | 'zh';

/** Unique identifier for a Discord Activity instance (room) */
export type RoomId = string;

/** Date key in YYYY-MM-DD format (America/Chicago timezone) */
export type DateKey = string;

/** Visible user identifier from Discord SDK, or random UUID for dev */
export type VisibleUserId = string;

/** Composite key for player state storage */
export interface PlayerKey {
    roomId: RoomId;
    dateKey: DateKey;
    visibleUserId: VisibleUserId;
    language?: Language;
    puzzleVariant?: PuzzleVariant;
}

/** Composite key for room state storage */
export interface RoomKey {
    roomId: RoomId;
    dateKey: DateKey;
    language?: Language;
    puzzleVariant?: PuzzleVariant;
}

// ============================================================================
// State
// ============================================================================

/** Game mode - daily only for now */
export type GameMode = 'daily';

/** Default language */
export const DEFAULT_LANGUAGE: Language = 'en';

/** User profile display info */
export interface UserProfile {
    displayName: string;       // Discord username or display name
    avatarUrl: string | null;  // Discord avatar URL or null
}

/** Leaderboard entry for a player in a room */
export interface LeaderboardEntry {
    visibleUserId: VisibleUserId;
    profile: UserProfile;
    solvedCount: number;       // 0-4 boards solved
    guessCount: number;        // total guesses made
    hintCount: number;
    hintPenalty: number;
    assisted: boolean;
    score: number;
    gameOver: boolean;
    won: boolean;
    finishedAt: number | null; // timestamp when game completed (for tiebreaker)
    puzzleVariant?: PuzzleVariant;
}

/** Server-authoritative state for a single player */
export interface PlayerState {
    visibleUserId: VisibleUserId;
    roomId: RoomId;
    dateKey: DateKey;
    mode: GameMode;
    language: Language;
    puzzleVariant?: PuzzleVariant;
    profile: UserProfile;
    gameState: GameState;
    createdAt: number;         // timestamp
    updatedAt: number;         // timestamp
    finishedAt: number | null; // timestamp when game completed
}

/** Room-wide state containing all players */
export interface RoomState {
    roomId: RoomId;
    dateKey: DateKey;
    language?: Language;
    puzzleVariant?: PuzzleVariant;
    players: Map<VisibleUserId, PlayerState>;
    leaderboard: LeaderboardEntry[];
    lastBroadcastAt: number;   // timestamp of last broadcast
}

// ============================================================================
// WebSocket Messages: Client → Server
// ============================================================================

export interface JoinMessage {
    type: 'JOIN';
    roomId: RoomId;
    dateKey: DateKey;
    visibleUserId: VisibleUserId;
    profile: UserProfile;
    language?: Language;
    puzzleVariant?: PuzzleVariant;
}

export interface GuessMessage {
    type: 'GUESS';
    roomId: RoomId;
    dateKey: DateKey;
    visibleUserId: VisibleUserId;
    guess: string;
    language?: Language;
    puzzleVariant?: PuzzleVariant;
}

export interface InvalidGuessAttemptMessage {
    type: 'INVALID_GUESS_ATTEMPT';
    roomId: RoomId;
    dateKey: DateKey;
    visibleUserId: VisibleUserId;
    guess: string;
    attemptId: string;
    language?: Language;
    puzzleVariant?: PuzzleVariant;
}

export interface HintMessage {
    type: 'HINT';
    roomId: RoomId;
    dateKey: DateKey;
    visibleUserId: VisibleUserId;
    boardIndex: number;
    hintType: HintType;
    language: Language;
    puzzleVariant?: PuzzleVariant;
}

export interface LeaveMessage {
    type: 'LEAVE';
    roomId: RoomId;
    dateKey: DateKey;
    visibleUserId: VisibleUserId;
    language?: Language;
}

/** Union of all client-to-server messages */
export type ClientMessage = JoinMessage | GuessMessage | InvalidGuessAttemptMessage | HintMessage | LeaveMessage;

/** All valid client message types */
export type ClientMessageType = ClientMessage['type'];

// ============================================================================
// WebSocket Messages: Server → Client
// ============================================================================

export interface StateMessage {
    type: 'STATE';
    playerState: PlayerState;
}

export interface LeaderboardMessage {
    type: 'LEADERBOARD';
    leaderboard: LeaderboardEntry[];
    language?: Language;
    puzzleVariant?: PuzzleVariant;
}

export interface RoomEventMessage {
    type: 'ROOM_EVENT';
    event: 'join' | 'leave';
    visibleUserId: VisibleUserId;
}

export interface ErrorMessage {
    type: 'ERROR';
    code: string;
    message: string;
}

/** Union of all server-to-client messages */
export type ServerMessage = StateMessage | LeaderboardMessage | RoomEventMessage | ErrorMessage;

/** All valid server message types */
export type ServerMessageType = ServerMessage['type'];

// ============================================================================
// Error Codes
// ============================================================================

export const ErrorCodes = {
    INVALID_MESSAGE: 'INVALID_MESSAGE',
    INVALID_GUESS: 'INVALID_GUESS',
    INVALID_FORMAT: 'INVALID_FORMAT',
    INVALID_LENGTH: 'INVALID_LENGTH',
    NOT_IN_LIST: 'NOT_IN_LIST',
    UNSUPPORTED_PUZZLE_VERSION: 'UNSUPPORTED_PUZZLE_VERSION',
    INVALID_LANGUAGE: 'INVALID_LANGUAGE',
    INVALID_BOARD: 'INVALID_BOARD',
    INVALID_HINT: 'INVALID_HINT',
    HINT_UNAVAILABLE: 'HINT_UNAVAILABLE',
    BOARD_SOLVED: 'BOARD_SOLVED',
    GAME_OVER: 'GAME_OVER',
    ROOM_NOT_FOUND: 'ROOM_NOT_FOUND',
    PLAYER_NOT_FOUND: 'PLAYER_NOT_FOUND',
    INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes];

// ============================================================================
// Type Guards: Client Messages
// ============================================================================

export function isClientMessage(msg: unknown): msg is ClientMessage {
    if (typeof msg !== 'object' || msg === null) return false;
    const m = msg as Record<string, unknown>;
    return m.type === 'JOIN' || m.type === 'GUESS' || m.type === 'INVALID_GUESS_ATTEMPT'
        || m.type === 'HINT' || m.type === 'LEAVE';
}

function hasSupportedPuzzleVersion(message: Record<string, unknown>): boolean {
    return message.language !== 'zh' || message.puzzleVariant === 'pinyin-latin-v2';
}

export function isJoinMessage(msg: unknown): msg is JoinMessage {
    if (typeof msg !== 'object' || msg === null) return false;
    const m = msg as Record<string, unknown>;
    return (
        m.type === 'JOIN' &&
        typeof m.roomId === 'string' &&
        typeof m.dateKey === 'string' &&
        typeof m.visibleUserId === 'string' &&
        hasSupportedPuzzleVersion(m)
    );
}

export function isGuessMessage(msg: unknown): msg is GuessMessage {
    if (typeof msg !== 'object' || msg === null) return false;
    const m = msg as Record<string, unknown>;
    return (
        m.type === 'GUESS' &&
        typeof m.roomId === 'string' &&
        typeof m.dateKey === 'string' &&
        typeof m.visibleUserId === 'string' &&
        typeof m.guess === 'string' &&
        hasSupportedPuzzleVersion(m)
    );
}

export function isInvalidGuessAttemptMessage(msg: unknown): msg is InvalidGuessAttemptMessage {
    if (typeof msg !== 'object' || msg === null) return false;
    const m = msg as Record<string, unknown>;
    return (
        m.type === 'INVALID_GUESS_ATTEMPT' &&
        typeof m.roomId === 'string' &&
        typeof m.dateKey === 'string' &&
        typeof m.visibleUserId === 'string' &&
        typeof m.guess === 'string' &&
        typeof m.attemptId === 'string' &&
        hasSupportedPuzzleVersion(m)
    );
}

export function isHintMessage(msg: unknown): msg is HintMessage {
    if (typeof msg !== 'object' || msg === null) return false;
    const m = msg as Record<string, unknown>;
    return (
        m.type === 'HINT' &&
        typeof m.roomId === 'string' &&
        typeof m.dateKey === 'string' &&
        typeof m.visibleUserId === 'string' &&
        (m.language === 'en' || m.language === 'ko' || m.language === 'zh') &&
        Number.isInteger(m.boardIndex) &&
        typeof m.hintType === 'string' &&
        hasSupportedPuzzleVersion(m)
    );
}

export function isLeaveMessage(msg: unknown): msg is LeaveMessage {
    if (typeof msg !== 'object' || msg === null) return false;
    const m = msg as Record<string, unknown>;
    return (
        m.type === 'LEAVE' &&
        typeof m.roomId === 'string' &&
        typeof m.dateKey === 'string' &&
        typeof m.visibleUserId === 'string'
    );
}

// ============================================================================
// Type Guards: Server Messages
// ============================================================================

export function isServerMessage(msg: unknown): msg is ServerMessage {
    if (typeof msg !== 'object' || msg === null) return false;
    const m = msg as Record<string, unknown>;
    return (
        m.type === 'STATE' ||
        m.type === 'LEADERBOARD' ||
        m.type === 'ROOM_EVENT' ||
        m.type === 'ERROR'
    );
}

export function isStateMessage(msg: unknown): msg is StateMessage {
    if (typeof msg !== 'object' || msg === null) return false;
    const m = msg as Record<string, unknown>;
    return m.type === 'STATE' && typeof m.playerState === 'object';
}

export function isLeaderboardMessage(msg: unknown): msg is LeaderboardMessage {
    if (typeof msg !== 'object' || msg === null) return false;
    const m = msg as Record<string, unknown>;
    return m.type === 'LEADERBOARD' && Array.isArray(m.leaderboard);
}

export function isRoomEventMessage(msg: unknown): msg is RoomEventMessage {
    if (typeof msg !== 'object' || msg === null) return false;
    const m = msg as Record<string, unknown>;
    return (
        m.type === 'ROOM_EVENT' &&
        (m.event === 'join' || m.event === 'leave') &&
        typeof m.visibleUserId === 'string'
    );
}

export function isErrorMessage(msg: unknown): msg is ErrorMessage {
    if (typeof msg !== 'object' || msg === null) return false;
    const m = msg as Record<string, unknown>;
    return (
        m.type === 'ERROR' &&
        typeof m.code === 'string' &&
        typeof m.message === 'string'
    );
}

// ============================================================================
// Helper Functions
// ============================================================================

/** Create a composite key string for player state storage */
function gameplayNamespace(language: Language = 'en', puzzleVariant?: PuzzleVariant): string {
    return language === 'zh' && puzzleVariant === 'pinyin-latin-v2'
        ? `${language}:${puzzleVariant}`
        : language;
}

export function makePlayerKey(
    roomId: RoomId,
    dateKey: DateKey,
    visibleUserId: VisibleUserId,
    language: Language = 'en',
    puzzleVariant?: PuzzleVariant,
): string {
    return `${makeRoomKey(roomId, dateKey, language, puzzleVariant)}:${visibleUserId}`;
}

/** Create a composite key string for room state storage */
export function makeRoomKey(
    roomId: RoomId,
    dateKey: DateKey,
    language: Language = 'en',
    puzzleVariant?: PuzzleVariant,
): string {
    return `${roomId}:${dateKey}:${gameplayNamespace(language, puzzleVariant)}`;
}

/** Parse a player key string back to components */
export function parsePlayerKey(key: string): PlayerKey | null {
    const parts = key.split(':');
    if (parts.length < 3 || parts.length > 5) return null;
    if (parts.length === 3) {
        return { roomId: parts[0], dateKey: parts[1], visibleUserId: parts[2] };
    }
    return {
        roomId: parts[0],
        dateKey: parts[1],
        language: parts[2] as Language,
        ...(parts.length === 5 ? { puzzleVariant: parts[3] as PuzzleVariant } : {}),
        visibleUserId: parts[parts.length - 1] as VisibleUserId,
    };
}

/** Parse a room key string back to components */
export function parseRoomKey(key: string): RoomKey | null {
    const parts = key.split(':');
    if (parts.length === 2) return { roomId: parts[0], dateKey: parts[1] };
    if (parts.length === 3 && ['en', 'ko', 'zh'].includes(parts[2])) {
        return { roomId: parts[0], dateKey: parts[1], language: parts[2] as Language };
    }
    if (parts.length === 4 && parts[2] === 'zh' && parts[3] === 'pinyin-latin-v2') {
        return {
            roomId: parts[0],
            dateKey: parts[1],
            language: 'zh',
            puzzleVariant: 'pinyin-latin-v2',
        };
    }
    return null;
}

/** Convert PlayerState to LeaderboardEntry */
export function toLeaderboardEntry(player: PlayerState): LeaderboardEntry {
    const gs = player.gameState;
    const performance = calculatePerformanceMetrics(gs);
    return {
        visibleUserId: player.visibleUserId,
        profile: player.profile,
        solvedCount: performance.solvedCount,
        guessCount: performance.guessCount,
        hintCount: performance.hintCount,
        hintPenalty: performance.hintPenalty,
        assisted: performance.assisted,
        score: performance.score,
        gameOver: gs.gameOver,
        won: gs.won,
        finishedAt: player.finishedAt,
        ...(player.puzzleVariant ? { puzzleVariant: player.puzzleVariant } : {}),
    };
}

/** Sort leaderboard: most boards solved, highest score, then fewest guesses and earliest finish */
export function sortLeaderboard(entries: LeaderboardEntry[]): LeaderboardEntry[] {
    return [...entries].sort((a, b) => {
        // More boards solved = better
        if (a.solvedCount !== b.solvedCount) return b.solvedCount - a.solvedCount;
        // Higher score = better
        if (a.score !== b.score) return b.score - a.score;
        // Fewer guesses = better
        if (a.guessCount !== b.guessCount) return a.guessCount - b.guessCount;
        // Earlier finish = better (tiebreaker)
        return (a.finishedAt ?? Number.POSITIVE_INFINITY) - (b.finishedAt ?? Number.POSITIVE_INFINITY);
    });
}

/** Get current date key in America/Chicago timezone */
export function getCurrentDateKey(): DateKey {
    const now = new Date();
    const chicagoTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
    const year = chicagoTime.getFullYear();
    const month = String(chicagoTime.getMonth() + 1).padStart(2, '0');
    const day = String(chicagoTime.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/** Validate date key format (YYYY-MM-DD) */
export function isValidDateKey(dateKey: string): boolean {
    return /^\d{4}-\d{2}-\d{2}$/.test(dateKey);
}

/** Create error message helper */
export function createErrorMessage(code: ErrorCode, message: string): ErrorMessage {
    return { type: 'ERROR', code, message };
}

/** Create state message helper */
export function createStateMessage(playerState: PlayerState): StateMessage {
    return { type: 'STATE', playerState };
}

/** Create leaderboard message helper */
export function createLeaderboardMessage(
    leaderboard: LeaderboardEntry[],
    language?: Language,
    puzzleVariant?: PuzzleVariant,
): LeaderboardMessage {
    return { type: 'LEADERBOARD', leaderboard, language, puzzleVariant };
}

/** Create room event message helper */
export function createRoomEventMessage(event: 'join' | 'leave', visibleUserId: VisibleUserId): RoomEventMessage {
    return { type: 'ROOM_EVENT', event, visibleUserId };
}
