import type {
    RoomId,
    DateKey,
    VisibleUserId,
    PlayerState,
    RoomState,
    LeaderboardEntry,
    GameMode,
    Language,
    UserProfile,
} from './protocol.js';
import {
    makeRoomKey,
    toLeaderboardEntry,
    sortLeaderboard,
} from './protocol.js';
import type { GameState } from '@quordle/engine';

// ============================================================================
// In-Memory Storage
// ============================================================================

/** Room state store keyed by `roomId:dateKey` */
const roomStore = new Map<string, RoomState>();

/** WebSocket connection tracking: roomKey -> Set of { ws, visibleUserId } */
export interface WsClient {
    ws: WebSocket;
    visibleUserId: VisibleUserId;
    roomId: RoomId;
    dateKey: DateKey;
}

const wsConnections = new Map<string, Set<WsClient>>();

// ============================================================================
// Room State Operations
// ============================================================================

/** Get or create a room state */
export function getOrCreateRoom(roomId: RoomId, dateKey: DateKey): RoomState {
    const key = makeRoomKey(roomId, dateKey);
    let room = roomStore.get(key);
    if (!room) {
        room = {
            roomId,
            dateKey,
            players: new Map(),
            leaderboard: [],
            lastBroadcastAt: Date.now(),
        };
        roomStore.set(key, room);
    }
    return room;
}

/** Get a room state (returns undefined if not exists) */
export function getRoom(roomId: RoomId, dateKey: DateKey): RoomState | undefined {
    return roomStore.get(makeRoomKey(roomId, dateKey));
}

/** Get a player state from a room */
export function getPlayer(
    roomId: RoomId,
    dateKey: DateKey,
    visibleUserId: VisibleUserId
): PlayerState | undefined {
    const room = getRoom(roomId, dateKey);
    return room?.players.get(visibleUserId);
}

/** Set a player state in a room (creates room if needed) */
export function setPlayer(playerState: PlayerState): void {
    const room = getOrCreateRoom(playerState.roomId, playerState.dateKey);
    room.players.set(playerState.visibleUserId, playerState);
    updateLeaderboard(room);
}

/** Remove a player from a room */
export function removePlayer(
    roomId: RoomId,
    dateKey: DateKey,
    visibleUserId: VisibleUserId
): boolean {
    const room = getRoom(roomId, dateKey);
    if (!room) return false;
    const deleted = room.players.delete(visibleUserId);
    if (deleted) {
        updateLeaderboard(room);
    }
    return deleted;
}

/** Update the leaderboard for a room */
function updateLeaderboard(room: RoomState): void {
    const entries: LeaderboardEntry[] = [];
    for (const player of room.players.values()) {
        entries.push(toLeaderboardEntry(player));
    }
    room.leaderboard = sortLeaderboard(entries);
    room.lastBroadcastAt = Date.now();
}

/** Get the current leaderboard for a room */
export function getLeaderboard(roomId: RoomId, dateKey: DateKey): LeaderboardEntry[] {
    const room = getRoom(roomId, dateKey);
    return room?.leaderboard ?? [];
}

// ============================================================================
// Player State Factory
// ============================================================================

/** Create a new player state with a fresh game */
export function createPlayerState(
    roomId: RoomId,
    dateKey: DateKey,
    visibleUserId: VisibleUserId,
    gameState: GameState,
    mode: GameMode = 'daily',
    language: Language = 'en',
    profile: UserProfile = { displayName: visibleUserId, avatarUrl: null },
): PlayerState {
    const now = Date.now();
    return {
        visibleUserId,
        roomId,
        dateKey,
        mode,
        language,
        profile,
        gameState,
        createdAt: now,
        updatedAt: now,
        finishedAt: null,
    };
}

/** Update a player's game state */
export function updatePlayerGameState(
    roomId: RoomId,
    dateKey: DateKey,
    visibleUserId: VisibleUserId,
    gameState: GameState
): PlayerState | undefined {
    const player = getPlayer(roomId, dateKey, visibleUserId);
    if (!player) return undefined;

    const now = Date.now();
    const updatedPlayer: PlayerState = {
        ...player,
        gameState,
        updatedAt: now,
        finishedAt: gameState.gameOver && !player.finishedAt ? now : player.finishedAt,
    };

    setPlayer(updatedPlayer);
    return updatedPlayer;
}

// ============================================================================
// WebSocket Connection Tracking
// ============================================================================

/** Add a WebSocket connection to a room */
export function addWsConnection(client: WsClient): void {
    const key = makeRoomKey(client.roomId, client.dateKey);
    let connections = wsConnections.get(key);
    if (!connections) {
        connections = new Set();
        wsConnections.set(key, connections);
    }
    connections.add(client);
}

/** Remove a WebSocket connection from a room */
export function removeWsConnection(client: WsClient): void {
    const key = makeRoomKey(client.roomId, client.dateKey);
    const connections = wsConnections.get(key);
    if (connections) {
        connections.delete(client);
        if (connections.size === 0) {
            wsConnections.delete(key);
        }
    }
}

/** Get all WebSocket connections for a room */
export function getWsConnections(roomId: RoomId, dateKey: DateKey): Set<WsClient> {
    return wsConnections.get(makeRoomKey(roomId, dateKey)) ?? new Set();
}

/** Find a WebSocket client by userId in a room */
export function findWsClient(
    roomId: RoomId,
    dateKey: DateKey,
    visibleUserId: VisibleUserId
): WsClient | undefined {
    const connections = getWsConnections(roomId, dateKey);
    for (const client of connections) {
        if (client.visibleUserId === visibleUserId) {
            return client;
        }
    }
    return undefined;
}

// ============================================================================
// Debug / Testing Utilities
// ============================================================================

/** Clear all state (for testing) */
export function clearAllState(): void {
    roomStore.clear();
    wsConnections.clear();
}

/** Get room count (for debugging) */
export function getRoomCount(): number {
    return roomStore.size;
}

/** Get total player count across all rooms */
export function getTotalPlayerCount(): number {
    let count = 0;
    for (const room of roomStore.values()) {
        count += room.players.size;
    }
    return count;
}
