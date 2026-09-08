import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import TelegramBot from 'node-telegram-bot-api';
import { installTelegramRateLimits, retryAfterSeconds } from './telegram-rate-limit.js';

function limited(seconds = 452) {
  return Object.assign(new Error('Too Many Requests'), {
    response: { statusCode: 429, body: { error_code: 429, parameters: { retry_after: seconds } } },
  });
}

function fixture(send = async () => ({})) {
  let time = 0;
  const calls = [];
  const bot = Object.assign(new EventEmitter(), {
    options: { polling: { interval: 1000 } },
    getUpdates: async () => [],
    sendMessage: async (...args) => {
      calls.push({ time, args });
      return send(...args);
    },
  });
  installTelegramRateLimits(bot, {
    now: () => time,
    wait: async (delay) => { time += delay; },
    warn: () => {},
  });
  return { bot, calls };
}

test('452-second rejection waits in seconds and preserves payload and ordering', async () => {
  let attempts = 0;
  const { bot, calls } = fixture(async () => {
    if (++attempts === 1) throw limited();
    return { message_id: attempts };
  });
  const options = { reply_markup: { remove_keyboard: true } };
  const results = await Promise.all([
    bot.sendMessage(123, 'Saved', options),
    bot.sendMessage(456, 'Next'),
  ]);
  assert.deepEqual(calls.map((c) => c.time), [0, 453000, 453050]);
  assert.deepEqual(calls[0].args, calls[1].args);
  assert.deepEqual(results, [{ message_id: 2 }, { message_id: 3 }]);
});

test('paces private and group messages including concurrent callers', async () => {
  const { bot, calls } = fixture();
  await Promise.all([bot.sendMessage(123, 'a'), bot.sendMessage('123', 'b')]);
  assert.equal(calls[1].time - calls[0].time, 1100);
  await Promise.all([bot.sendMessage(-123, 'a'), bot.sendMessage('-123', 'b')]);
  assert.equal(calls[3].time - calls[2].time, 3100);
});

test('does not retry ambiguous network errors and keeps queue usable', async () => {
  let attempts = 0;
  const error = new Error('Connection reset');
  const { bot, calls } = fixture(async () => {
    if (++attempts === 1) throw error;
    return 'ok';
  });
  await assert.rejects(bot.sendMessage(123, 'a'), error);
  assert.equal(await bot.sendMessage(123, 'b'), 'ok');
  assert.equal(calls.length, 2);
});

test('caps retries and preserves cooldown for the next queued message', async () => {
  let attempts = 0;
  const { bot, calls } = fixture(async () => {
    if (++attempts <= 4) throw limited();
    return 'ok';
  });
  await assert.rejects(bot.sendMessage(123, 'a'));
  assert.equal(calls.length, 4);
  await bot.sendMessage(456, 'b');
  assert.equal(calls[4].time - calls[3].time, 453000);
});

test('polling backs off and restores normal interval on successful empty response', async () => {
  const { bot } = fixture();
  bot.emit('polling_error', limited());
  assert.equal(bot.options.polling.interval, 453000);
  await bot.getUpdates({ offset: 42 });
  assert.equal(bot.options.polling.interval, 1000);
});

test('handles missing retry_after without treating other errors as rate limits', () => {
  assert.equal(retryAfterSeconds(limited(undefined)), 452);
  assert.equal(retryAfterSeconds(limited(0)), 60);
  assert.equal(retryAfterSeconds({ response: { statusCode: 429 } }), 60);
  assert.equal(retryAfterSeconds(new Error('Network error')), null);
});

test('installed library polling uses backoff and remains cancellable', async () => {
  const bot = new TelegramBot('test-token', {
    polling: { autoStart: false, interval: 1000, params: { timeout: 30 } },
  });
  // Use the actual library's promise implementation, without network access.
  const Bluebird = (await import('bluebird')).default;
  bot._request = () => Bluebird.reject(limited());
  installTelegramRateLimits(bot, { warn: () => {} });
  try {
    await bot.startPolling();
    assert.equal(bot.options.polling.interval, 453000);
    assert.equal(typeof bot.getUpdates().catch(() => {}).cancel, 'function');
  } finally {
    await bot.stopPolling({ cancel: true });
  }
});
