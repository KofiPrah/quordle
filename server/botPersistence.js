import {
  PINYIN_PUZZLE_VARIANT,
  makeCompletionDedupeKey,
  makePlayerRedisKey,
  makeRoomPlayersRedisKey,
} from './gameNamespace.js';

export function completionKeyForEvent(event) {
  return makeCompletionDedupeKey(
    event.guildId,
    event.channelId,
    event.dateKey,
    event.visibleUserId,
    event.language || 'en',
    event.puzzleVariant,
  );
}

export function leaderboardSources(channelId, dateKey) {
  return [
    { language: 'en', puzzleVariant: undefined },
    { language: 'ko', puzzleVariant: undefined },
    { language: 'zh', puzzleVariant: PINYIN_PUZZLE_VARIANT },
  ].map((source) => ({
    ...source,
    redisKey: makeRoomPlayersRedisKey(channelId, dateKey, source.language, source.puzzleVariant),
  }));
}

export function playerKeyForSource(source, channelId, dateKey, visibleUserId) {
  return makePlayerRedisKey(
    channelId,
    dateKey,
    visibleUserId,
    source.language,
    source.puzzleVariant,
  );
}
