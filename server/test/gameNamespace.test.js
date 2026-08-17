import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HANZI_PUZZLE_VARIANT,
  PINYIN_PUZZLE_VARIANT,
  dailyRoundId,
  isCompatiblePersistedPlayer,
  makeCompletionDedupeKey,
  makePlayerRedisKey,
  makeRoomPlayersRedisKey,
  makeRoomStoreKey,
  parseRequiredPuzzleVariant,
} from '../gameNamespace.js';

test('Chinese writes fail closed unless the exact Pinyin protocol version is supplied', () => {
  assert.deepEqual(parseRequiredPuzzleVariant('zh'), {
    ok: false,
    code: 'UNSUPPORTED_PUZZLE_VERSION',
    message: 'Chinese gameplay requires puzzleVariant pinyin-latin-v2.',
  });
  assert.deepEqual(parseRequiredPuzzleVariant('zh', HANZI_PUZZLE_VARIANT), {
    ok: false,
    code: 'UNSUPPORTED_PUZZLE_VERSION',
    message: 'Chinese gameplay requires puzzleVariant pinyin-latin-v2.',
  });
  assert.deepEqual(parseRequiredPuzzleVariant('zh', PINYIN_PUZZLE_VARIANT), {
    ok: true,
    puzzleVariant: PINYIN_PUZZLE_VARIANT,
  });
  assert.deepEqual(parseRequiredPuzzleVariant('ko'), { ok: true, puzzleVariant: undefined });
});

test('Pinyin room, player, Redis, round, and bot completion keys share one versioned namespace', () => {
  const identity = ['room', '2026-08-17', 'zh', PINYIN_PUZZLE_VARIANT];
  assert.equal(makeRoomStoreKey(...identity), 'room:2026-08-17:zh:pinyin-latin-v2');
  assert.equal(
    makePlayerRedisKey('room', '2026-08-17', 'player', 'zh', PINYIN_PUZZLE_VARIANT),
    'player:room:2026-08-17:zh:pinyin-latin-v2:player',
  );
  assert.equal(
    makeRoomPlayersRedisKey(...identity),
    'roomPlayers:room:2026-08-17:zh:pinyin-latin-v2',
  );
  assert.equal(dailyRoundId('2026-08-17', 'zh', PINYIN_PUZZLE_VARIANT), 'daily:2026-08-17:zh:pinyin-latin-v2');
  assert.equal(
    makeCompletionDedupeKey('guild', 'room', '2026-08-17', 'player', 'zh', PINYIN_PUZZLE_VARIANT),
    'dailyFinish:guild:room:2026-08-17:zh:pinyin-latin-v2:player',
  );
  assert.equal(makeRoomStoreKey('room', '2026-08-17', 'ko'), 'room:2026-08-17:ko');
});

test('a Pinyin restore rejects legacy Hanzi and mismatched versioned player state', () => {
  const legacy = {
    language: 'zh',
    gameState: { language: 'zh', boards: [], assistance: { scoringVersion: 1, hints: [] } },
  };
  const pinyin = {
    language: 'zh',
    puzzleVariant: PINYIN_PUZZLE_VARIANT,
    gameState: {
      language: 'zh',
      puzzleVariant: PINYIN_PUZZLE_VARIANT,
      boards: [],
      assistance: { scoringVersion: 2, puzzleVariant: PINYIN_PUZZLE_VARIANT, hints: [] },
    },
  };
  assert.equal(isCompatiblePersistedPlayer(legacy, 'zh', PINYIN_PUZZLE_VARIANT), false);
  assert.equal(isCompatiblePersistedPlayer({ ...pinyin, puzzleVariant: HANZI_PUZZLE_VARIANT }, 'zh', PINYIN_PUZZLE_VARIANT), false);
  assert.equal(isCompatiblePersistedPlayer(pinyin, 'zh', PINYIN_PUZZLE_VARIANT), true);
});
