import Redis from 'ioredis';

export function createRedisConnection(url, { label = 'Redis', subscriber = false, logger = console } = {}) {
  const redis = new Redis(url, {
    // Bound individual data requests, but keep the connection retrying forever.
    // A subscriber's initial SUBSCRIBE must survive an outage during startup.
    maxRetriesPerRequest: subscriber ? null : 3,
    retryStrategy: (times) => Math.min(times * 200, 2000),
    autoResubscribe: true,
  });
  let unavailableLogged = false;
  const reportUnavailable = (error) => {
    if (unavailableLogged) return;
    unavailableLogged = true;
    logger.warn(`[${label}] Unavailable; retrying in background${error ? `: ${error.message}` : ''}`);
  };
  redis.on('error', reportUnavailable);
  redis.on('close', () => reportUnavailable());
  redis.on('ready', () => {
    unavailableLogged = false;
    logger.log(`[${label}] Ready`);
  });
  return redis;
}
