import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createRedisConnection } from '../redisConnection.js';
import { createFakeRedis } from './fakeRedis.js';

const silentLogger = { log() {}, warn() {} };

async function waitUntil(check, message, timeoutMs = 7000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(50);
  }
  assert.fail(message);
}

test('bot data requests fail within their retry budget but later requests recover', { timeout: 20_000 }, async () => {
  const endpoint = await createFakeRedis();
  await endpoint.stop();
  const warnings = [];
  const client = createRedisConnection(endpoint.url, {
    label: 'Bot Redis', logger: { log() {}, warn: (message) => warnings.push(message) },
  });
  try {
    // A command must fail without disabling the underlying connection.
    await assert.rejects(client.get('daily-message'), /max retries per request/i);
    assert.notEqual(client.status, 'end');
    assert.equal(warnings.length, 1, 'repeated reconnect failures should not flood the logs');
    await endpoint.start();
    await waitUntil(() => client.status === 'ready', 'bot data connection did not recover');
    assert.equal(await client.ping(), 'PONG');
  } finally {
    client.disconnect();
    await endpoint.close();
  }
});

test('bot subscription survives a startup outage and repeated Redis restarts without duplicate messages', { timeout: 30_000 }, async () => {
  const endpoint = await createFakeRedis();
  await endpoint.stop();
  const subscriber = createRedisConnection(endpoint.url, { subscriber: true, logger: silentLogger });
  const publisher = createRedisConnection(endpoint.url, { logger: silentLogger });
  const received = [];
  subscriber.on('message', (channel, message) => received.push({ channel, event: JSON.parse(message) }));
  // Attach the rejection handler immediately: an expired startup subscription must fail the test.
  const subscription = subscriber.subscribe('activity:events').then(
    (count) => ({ count }), (error) => ({ error }),
  );
  try {
    await delay(2600);
    await endpoint.start();
    const result = await subscription;
    assert.equal(result.error, undefined, 'startup SUBSCRIBE expired before Redis returned');
    assert.equal(result.count, 1);
    for (let round = 0; round < 3; round += 1) {
      await waitUntil(() => subscriber.status === 'ready' && publisher.status === 'ready', 'notification connections did not recover');
      assert.equal(await publisher.publish('activity:events', JSON.stringify({ type: 'DAILY_FINISHED', round })), 1);
      await waitUntil(() => received.length >= round + 1, 'bot did not receive the notification after reconnecting');
      assert.deepEqual(received.map(({ channel, event }) => ({ channel, round: event.round })),
        Array.from({ length: round + 1 }, (_, index) => ({ channel: 'activity:events', round: index })));
      if (round < 2) {
        await endpoint.stop();
        await delay(2600);
        await endpoint.start();
      }
    }
  } finally {
    subscriber.disconnect();
    publisher.disconnect();
    await endpoint.close();
  }
});
