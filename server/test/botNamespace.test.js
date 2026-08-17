import test from 'node:test';
import assert from 'node:assert/strict';
import {
  completionKeyForEvent,
  leaderboardSources,
  playerKeyForSource,
} from '../botPersistence.js';

test('bot completion dedupe uses the event puzzle variant', () => {
  assert.equal(completionKeyForEvent({
    guildId: 'guild',
    channelId: 'channel',
    dateKey: '2026-08-17',
    visibleUserId: 'player',
    language: 'zh',
    puzzleVariant: 'pinyin-latin-v2',
  }), 'dailyFinish:guild:channel:2026-08-17:zh:pinyin-latin-v2:player');
});

test('bot reads only the versioned Pinyin Chinese leaderboard namespace', () => {
  const sources = leaderboardSources('channel', '2026-08-17');
  assert.deepEqual(sources.map((source) => source.redisKey), [
    'roomPlayers:channel:2026-08-17:en',
    'roomPlayers:channel:2026-08-17:ko',
    'roomPlayers:channel:2026-08-17:zh:pinyin-latin-v2',
  ]);
  assert.ok(!sources.some((source) => source.redisKey === 'roomPlayers:channel:2026-08-17:zh'));
  const chinese = sources[2];
  assert.equal(
    playerKeyForSource(chinese, 'channel', '2026-08-17', 'player'),
    'player:channel:2026-08-17:zh:pinyin-latin-v2:player',
  );
});
