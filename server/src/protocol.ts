import type { BoardState, GameState } from '@quordle/engine';

// ============================================================================
// Keys
// ============================================================================

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
}

/** Composite key for room state storage */
export interface RoomKey {
    roomId: RoomId;
    dateKey: DateKey;
}

// ============================================================================
// State
// ============================================================================

/** Game mode - daily only for now */
export type GameMode = 'daily';

/** Leaderboard entry for a player in a room */
export interface LeaderboardEntry {
    visibleUserId: VisibleUserId;
    solvedCount: number;       // 0-4 boards solved
    guessCount: number;        // total guesses made
    gameOver: boolean;
    won: boolean;
    finishedAt: number | null; // timestamp when game completed (for tiebreaker)
}

/** Server-authoritative state for a single player */
export interface PlayerState {
    visibleUserId: VisibleUserId;
    roomId: RoomId;
    dateKey: DateKey;
    mode: GameMode;
    gameState: GameState;
    createdAt: number;         // timestamp
    updatedAt: number;         // timestamp
    finishedAt: number | null; // timestamp when game completed
}

/** Room-wide state containing all players */
export interface RoomState {
    roomId: RoomId;
    dateKey: DateKey;
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
}

export interface GuessMessage {
    type: 'GUESS';
    roomId: RoomId;
    dateKey: DateKey;
    visibleUserId: VisibleUserId;
    guess: string;
}

export interface LeaveMessage {
    type: 'LEAVE';
    roomId: RoomId;
    dateKey: DateKey;
    visibleUserId: VisibleUserId;
}

/** Union of all client-to-server messages */
export type ClientMessage = JoinMessage | GuessMessage | LeaveMessage;

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
    return m.type === 'JOIN' || m.type === 'GUESS' || m.type === 'LEAVE';
}

export function isJoinMessage(msg: unknown): msg is JoinMessage {
    if (typeof msg !== 'object' || msg === null) return false;
    const m = msg as Record<string, unknown>;
    return (
        m.type === 'JOIN' &&
        typeof m.roomId === 'string' &&
        typeof m.dateKey === 'string' &&
        typeof m.visibleUserId === 'string'
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
        typeof m.guess === 'string'
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
export function makePlayerKey(roomId: RoomId, dateKey: DateKey, visibleUserId: VisibleUserId): string {
    return `${roomId}:${dateKey}:${visibleUserId}`;
}

/** Create a composite key string for room state storage */
export function makeRoomKey(roomId: RoomId, dateKey: DateKey): string {
    return `${roomId}:${dateKey}`;
}

/** Parse a player key string back to components */
export function parsePlayerKey(key: string): PlayerKey | null {
    const parts = key.split(':');
    if (parts.length !== 3) return null;
    return {
        roomId: parts[0],
        dateKey: parts[1],
        visibleUserId: parts[2],
    };
}

/** Parse a room key string back to components */
export function parseRoomKey(key: string): RoomKey | null {
    const parts = key.split(':');
    if (parts.length !== 2) return null;
    return {
        roomId: parts[0],
        dateKey: parts[1],
    };
}

/** Convert PlayerState to LeaderboardEntry */
export function toLeaderboardEntry(player: PlayerState): LeaderboardEntry {
    const gs = player.gameState;
    const solvedCount = gs.boards.filter((b: BoardState) => b.solved).length;
    return {
        visibleUserId: player.visibleUserId,
        solvedCount,
        guessCount: gs.guessCount,
        gameOver: gs.gameOver,
        won: gs.won,
        finishedAt: player.finishedAt,
    };
}

/** Sort leaderboard: most boards solved, then fewest guesses, then earliest finish */
export function sortLeaderboard(entries: LeaderboardEntry[]): LeaderboardEntry[] {
    return [...entries].sort((a, b) => {
        // Finished players rank above unfinished
        if (a.gameOver !== b.gameOver) return a.gameOver ? -1 : 1;
        // More boards solved = better
        if (a.solvedCount !== b.solvedCount) return b.solvedCount - a.solvedCount;
        // Fewer guesses = better
        if (a.guessCount !== b.guessCount) return a.guessCount - b.guessCount;
        // Earlier finish = better (tiebreaker)
        if (a.finishedAt !== null && b.finishedAt !== null) {
            return a.finishedAt - b.finishedAt;
        }
        return 0;
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
export function createLeaderboardMessage(leaderboard: LeaderboardEntry[]): LeaderboardMessage {
    return { type: 'LEADERBOARD', leaderboard };
}

/** Create room event message helper */
export function createRoomEventMessage(event: 'join' | 'leave', visibleUserId: VisibleUserId): RoomEventMessage {
    return { type: 'ROOM_EVENT', event, visibleUserId };
}
