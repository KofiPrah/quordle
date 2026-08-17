import { calculatePerformanceMetrics } from '@quordle/engine/assistance';

export const ACTIVITY_EVENT_CHANNEL = 'activity:events';

export function buildDailyFinishedEvent({
  transition,
  roomId,
  dateKey,
  visibleUserId,
  guildId = null,
  language,
  puzzleVariant,
  timestamp = Date.now(),
}) {
  const player = transition.playerState;
  const gameState = transition.gameState;
  const canonicalRoomId = player.roomId || roomId;
  const canonicalVisibleUserId = player.visibleUserId || visibleUserId;
  const canonicalLanguage = player.language || language || 'en';
  const canonicalPuzzleVariant = player.puzzleVariant || puzzleVariant;
  const performance = calculatePerformanceMetrics(gameState);
  return {
    type: 'DAILY_FINISHED',
    roomId: canonicalRoomId,
    channelId: canonicalRoomId,
    guildId,
    dateKey: player.dateKey || dateKey,
    visibleUserId: canonicalVisibleUserId,
    displayName: player.profile?.displayName || canonicalVisibleUserId,
    avatarUrl: player.profile?.avatarUrl || null,
    won: gameState.won,
    guessCount: gameState.guessCount,
    solvedBoards: performance.solvedCount,
    totalBoards: 4,
    hintCount: performance.hintCount,
    hintPenalty: performance.hintPenalty,
    assisted: performance.assisted,
    score: performance.score,
    language: canonicalLanguage,
    ...(canonicalPuzzleVariant ? { puzzleVariant: canonicalPuzzleVariant } : {}),
    timestamp,
  };
}

export function publishDailyFinishedForTransition({
  transition,
  publish,
  onError = () => {},
  ...eventContext
}) {
  if (!transition?.ok
    || transition.idempotent
    || !transition.justCompleted
    || typeof publish !== 'function') return null;
  const event = buildDailyFinishedEvent({ transition, ...eventContext });
  try {
    Promise.resolve(publish(ACTIVITY_EVENT_CHANNEL, JSON.stringify(event))).catch(onError);
  } catch (error) {
    onError(error);
  }
  return event;
}
