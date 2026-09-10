import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createFakeRedis } from './fakeRedis.js';

const serverDirectory = fileURLToPath(new URL('..', import.meta.url));

async function waitUntil(check, message, timeoutMs = 7000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(50);
  }
  assert.fail(message);
}

async function startServer(t, redisUrl) {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: serverDirectory,
    env: {
      ...process.env, PORT: String(port), REDIS_URL: redisUrl, NODE_ENV: 'production',
      LEARNING_ANALYTICS_ENABLED: 'true', APP_SESSION_SECRET: 'test-session-secret',
      ANALYTICS_HMAC_SECRET: 'test-hmac-secret', ANALYTICS_ADMIN_TOKEN: 'test-admin-token',
      DEBUG_WS: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  t.after(async () => {
    if (child.exitCode !== null) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    await exited;
    clearTimeout(timer);
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const get = async (path) => {
    const response = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(2000) });
    return { status: response.status, body: await response.json() };
  };
  const post = async (path, body) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200, await response.text());
  };
  await waitUntil(async () => {
    if (child.exitCode !== null) assert.fail(`server exited early: ${output}`);
    try { await get('/health'); return true; } catch { return false; }
  }, 'server did not start');
  return { get, post };
}

test('health returns 503 while configured Redis is unavailable and recovers to 200', { timeout: 20_000 }, async (t) => {
  const redis = await createFakeRedis();
  t.after(() => redis.close());
  const server = await startServer(t, redis.url);
  await waitUntil(async () => (await server.get('/api/debug/persist')).body.redisConnected, 'Redis did not connect');
  await redis.stop();
  await waitUntil(async () => !(await server.get('/api/debug/persist')).body.redisConnected, 'disconnect was not detected');
  const unhealthy = await server.get('/health');
  assert.equal(unhealthy.status, 503);
  assert.equal(unhealthy.body.status, 'degraded');
  assert.equal(unhealthy.body.dependencies.redis.configured, true);
  assert.equal(unhealthy.body.dependencies.redis.connected, false);
  assert.equal(unhealthy.body.capabilities.learningDataAvailable, false);
  await redis.start();
  await waitUntil(async () => (await server.get('/health')).status === 200, 'health did not recover');
  const healthy = await server.get('/health');
  assert.equal(healthy.body.status, 'ok');
  assert.equal(healthy.body.dependencies.redis.status, 'ready');
  assert.equal(healthy.body.capabilities.learningDataRedisBacked, true);
});

test('health stays available when Redis is intentionally unconfigured', async (t) => {
  const server = await startServer(t, '');
  const health = await server.get('/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.status, 'ok');
  assert.deepEqual(health.body.dependencies.redis, { configured: false, connected: false, status: 'disabled' });
});

for (const initiallyUnavailable of [false, true]) {
  test(`game persistence and notifications resume after Redis ${initiallyUnavailable ? 'starts late' : 'restarts'}`, { timeout: 25_000 }, async (t) => {
    const redis = await createFakeRedis();
    t.after(() => redis.close());
    if (initiallyUnavailable) await redis.stop();
    const server = await startServer(t, redis.url);
    const identity = {
      roomId: 'recovery-channel', guildId: 'recovery-guild', userId: 'recovery-player',
      dateKey: '2026-08-17', language: 'zh', puzzleVariant: 'pinyin-latin-v2',
      profile: { displayName: 'Recovery Player' },
    };
    if (!initiallyUnavailable) {
      await waitUntil(async () => (await server.get('/api/debug/persist')).body.redisConnected, 'Redis did not connect');
    }
    await server.post('/api/game/join', identity);
    if (!initiallyUnavailable) await redis.stop();
    // Stay down beyond the old bot's entire retry budget, as well as the server's.
    await delay(2600);
    await redis.start();
    await waitUntil(async () => (await server.get('/api/debug/persist')).body.redisConnected, 'game server never reconnected to Redis');
    const commandsBefore = redis.commands.length;
    for (const [index, guess] of ['qunian', 'jiejie', 'gongsi', 'lanqiu'].entries()) {
      await server.post('/api/game/guess', { ...identity, guess, submissionId: `recovery-${index}` });
    }
    await server.post('/api/activity/leave', { ...identity, channelId: identity.roomId });
    const records = await redis.waitForPublished(2);
    assert.deepEqual(records.map((record) => record.payload.type).sort(), ['ACTIVITY_LEAVE', 'DAILY_FINISHED']);
    const completion = records.find((record) => record.payload.type === 'DAILY_FINISHED').payload;
    assert.equal(completion.won, true);
    assert.equal(completion.visibleUserId, 'recovery-player');
    const saves = redis.commands.slice(commandsBefore).filter(({ command, args }) => command === 'SETEX' && args[0].startsWith('player:'));
    assert.ok(saves.some(({ args }) => JSON.parse(args[2]).gameState.guessCount === 4), 'completed game was not persisted after recovery');
  });
}
