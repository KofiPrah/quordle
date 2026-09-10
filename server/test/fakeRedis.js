import net from 'node:net';

function parseLine(buffer, offset) {
  const end = buffer.indexOf('\r\n', offset);
  if (end < 0) return null;
  return { value: buffer.toString('utf8', offset, end), nextOffset: end + 2 };
}

function parseCommand(buffer) {
  if (buffer.length === 0 || buffer[0] !== 42) return null;
  const countLine = parseLine(buffer, 1);
  if (!countLine) return null;
  const count = Number(countLine.value);
  let offset = countLine.nextOffset;
  const values = [];
  for (let index = 0; index < count; index += 1) {
    if (offset >= buffer.length || buffer[offset] !== 36) return null;
    const lengthLine = parseLine(buffer, offset + 1);
    if (!lengthLine) return null;
    const length = Number(lengthLine.value);
    const valueStart = lengthLine.nextOffset;
    const valueEnd = valueStart + length;
    if (buffer.length < valueEnd + 2) return null;
    values.push(buffer.toString('utf8', valueStart, valueEnd));
    offset = valueEnd + 2;
  }
  return { values, consumed: offset };
}

function bulkString(value) {
  return `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
}

export async function createFakeRedis() {
  const published = [];
  const commands = [];
  const sockets = new Set();
  const subscriptions = new Map();
  const waiters = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let buffer = Buffer.alloc(0);
    socket.on('error', () => {});
    socket.on('close', () => {
      sockets.delete(socket);
      subscriptions.delete(socket);
    });
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        const parsed = parseCommand(buffer);
        if (!parsed) break;
        buffer = buffer.subarray(parsed.consumed);
        const [rawCommand, ...args] = parsed.values;
        const command = rawCommand.toUpperCase();
        commands.push({ command, args });
        if (command === 'INFO') {
          socket.write(bulkString('# Server\r\nredis_version:7.2.0\r\n'));
        } else if (command === 'PING') {
          socket.write('+PONG\r\n');
        } else if (command === 'GET') {
          socket.write('$-1\r\n');
        } else if (command === 'SMEMBERS') {
          socket.write('*0\r\n');
        } else if (command === 'TTL') {
          socket.write(':-1\r\n');
        } else if (command === 'SADD' || command === 'EXPIRE') {
          socket.write(':1\r\n');
        } else if (command === 'SUBSCRIBE') {
          const channels = subscriptions.get(socket) || new Set();
          subscriptions.set(socket, channels);
          for (const channel of args) {
            channels.add(channel);
            socket.write(`*3\r\n${bulkString('subscribe')}${bulkString(channel)}:${channels.size}\r\n`);
          }
        } else if (command === 'PUBLISH') {
          const record = { channel: args[0], payload: JSON.parse(args[1]) };
          published.push(record);
          let recipients = 0;
          for (const [subscriber, channels] of subscriptions) {
            if (channels.has(args[0])) {
              subscriber.write(`*3\r\n${bulkString('message')}${bulkString(args[0])}${bulkString(args[1])}`);
              recipients += 1;
            }
          }
          socket.write(`:${recipients}\r\n`);
          for (let index = waiters.length - 1; index >= 0; index -= 1) {
            if (published.length >= waiters[index].count) {
              const [waiter] = waiters.splice(index, 1);
              clearTimeout(waiter.timer);
              waiter.resolve([...published]);
            }
          }
        } else {
          socket.write('+OK\r\n');
        }
      }
    });
  });
  let port = 0;
  async function start() {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    port = server.address().port;
  }
  async function stop() {
    for (const socket of sockets) socket.destroy();
    subscriptions.clear();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
  await start();
  return {
    url: `redis://127.0.0.1:${port}`,
    published,
    commands,
    start,
    stop,
    waitForPublished(count, timeoutMs = 2000) {
      if (published.length >= count) return Promise.resolve([...published]);
      return new Promise((resolve, reject) => {
        const waiter = { count, resolve, timer: null };
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`timed out waiting for ${count} published Redis events; received ${published.length}`));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
    close: stop,
  };
}
