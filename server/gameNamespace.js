import { PINYIN_PUZZLE_VARIANT } from '@quordle/engine/chineseLexicon';

export { PINYIN_PUZZLE_VARIANT };
export const HANZI_PUZZLE_VARIANT = 'hanzi-v1';
export const UNSUPPORTED_PUZZLE_VERSION = Object.freeze({
  ok: false,
  code: 'UNSUPPORTED_PUZZLE_VERSION',
  message: `Chinese gameplay requires puzzleVariant ${PINYIN_PUZZLE_VARIANT}.`,
});

export function parseRequiredPuzzleVariant(language, value) {
  if (language !== 'zh') return { ok: true, puzzleVariant: undefined };
  if (value !== PINYIN_PUZZLE_VARIANT) return { ...UNSUPPORTED_PUZZLE_VERSION };
  return { ok: true, puzzleVariant: PINYIN_PUZZLE_VARIANT };
}

export function parseReadPuzzleVariant(language, value) {
  if (language !== 'zh') return { ok: true, puzzleVariant: undefined };
  if (value === undefined || value === null || value === '' || value === PINYIN_PUZZLE_VARIANT) {
    return { ok: true, puzzleVariant: PINYIN_PUZZLE_VARIANT };
  }
  if (value === HANZI_PUZZLE_VARIANT) return { ok: true, puzzleVariant: HANZI_PUZZLE_VARIANT };
  return { ...UNSUPPORTED_PUZZLE_VERSION };
}

export function gameplayNamespace(language = 'en', puzzleVariant) {
  return language === 'zh' && puzzleVariant === PINYIN_PUZZLE_VARIANT
    ? `${language}:${PINYIN_PUZZLE_VARIANT}`
    : language;
}

export function makeRoomStoreKey(roomId, dateKey, language = 'en', puzzleVariant) {
  return `${roomId}:${dateKey}:${gameplayNamespace(language, puzzleVariant)}`;
}

export function makePlayerStoreKey(roomId, dateKey, visibleUserId, language = 'en', puzzleVariant) {
  return `${makeRoomStoreKey(roomId, dateKey, language, puzzleVariant)}:${visibleUserId}`;
}

export function makePlayerRedisKey(roomId, dateKey, visibleUserId, language = 'en', puzzleVariant) {
  return `player:${makePlayerStoreKey(roomId, dateKey, visibleUserId, language, puzzleVariant)}`;
}

export function makeRoomPlayersRedisKey(roomId, dateKey, language = 'en', puzzleVariant) {
  return `roomPlayers:${makeRoomStoreKey(roomId, dateKey, language, puzzleVariant)}`;
}

export function dailyRoundId(dateKey, language = 'en', puzzleVariant) {
  return `daily:${dateKey}:${gameplayNamespace(language, puzzleVariant)}`;
}

export function makeCompletionDedupeKey(
  guildId,
  channelId,
  dateKey,
  userId,
  language = 'en',
  puzzleVariant,
) {
  return `dailyFinish:${guildId}:${channelId}:${dateKey}:${gameplayNamespace(language, puzzleVariant)}:${userId}`;
}

export function isCompatiblePersistedPlayer(player, language = 'en', puzzleVariant) {
  if (!player?.gameState) return false;
  const storedLanguage = player.language || player.gameState.language || 'en';
  if (storedLanguage !== language) return false;
  if (language !== 'zh' || puzzleVariant !== PINYIN_PUZZLE_VARIANT) return true;
  return player.puzzleVariant === PINYIN_PUZZLE_VARIANT
    && player.gameState.puzzleVariant === PINYIN_PUZZLE_VARIANT;
}
