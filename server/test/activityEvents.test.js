import test from 'node:test';
import assert from 'node:assert/strict';
import { createDailyGame, transitionPlayerGuess } from '../gameplay.js';

const puzzleVariant = 'pinyin-latin-v2';

test('REST and WebSocket completion calls share one exact DAILY_FINISHED event contract', async () => {
  const activityEvents = await import('../activityEvents.js');
  let player = {
    roomId: 'room-1',
    dateKey: '2026-08-17',
    visibleUserId: 'player-1',
    language: 'zh',
    puzzleVariant,
    profile: { displayName: 'Canonical Player', avatarUrl: 'https://cdn.example/avatar.png' },
    gameState: createDailyGame('2026-08-17', 'zh', puzzleVariant),
    createdAt: 1,
    updatedAt: 1,
    finishedAt: null,
  };
  let transition;
  player.gameState.boards.map((board) => board.targetWord).forEach((guess, index) => {
    transition = transitionPlayerGuess(player, guess, {}, 10 + index, `submission-${index}`);
    assert.equal(transition.ok, true);
    player = transition.playerState;
  });
  assert.equal(transition.justCompleted, true);

  const publishedByRest = [];
  const publishedByWebSocket = [];
  const input = {
    transition,
    roomId: 'room-1',
    dateKey: '2026-08-17',
    visibleUserId: 'player-1',
    guildId: 'guild-1',
    language: 'zh',
    puzzleVariant,
    timestamp: 99,
  };
  activityEvents.publishDailyFinishedForTransition({
    ...input,
    publish: (channel, payload) => publishedByRest.push({ channel, payload: JSON.parse(payload) }),
  });
  activityEvents.publishDailyFinishedForTransition({
    ...input,
    publish: (channel, payload) => publishedByWebSocket.push({ channel, payload: JSON.parse(payload) }),
  });

  assert.deepEqual(publishedByRest, publishedByWebSocket);
  assert.deepEqual(publishedByRest, [{
    channel: 'activity:events',
    payload: {
      type: 'DAILY_FINISHED',
      roomId: 'room-1',
      channelId: 'room-1',
      guildId: 'guild-1',
      dateKey: '2026-08-17',
      visibleUserId: 'player-1',
      displayName: 'Canonical Player',
      avatarUrl: 'https://cdn.example/avatar.png',
      won: true,
      guessCount: 4,
      solvedBoards: 4,
      totalBoards: 4,
      hintCount: 0,
      hintPenalty: 0,
      assisted: false,
      score: 100,
      language: 'zh',
      puzzleVariant,
      timestamp: 99,
    },
  }]);

  const replay = transitionPlayerGuess(player, player.gameState.boards[0].targetWord, {}, 100, 'submission-0');
  activityEvents.publishDailyFinishedForTransition({
    ...input,
    transition: replay,
    publish: (channel, payload) => publishedByRest.push({ channel, payload }),
  });
  activityEvents.publishDailyFinishedForTransition({
    ...input,
    publish: null,
  });
  assert.equal(publishedByRest.length, 1);
});
