import { setTimeout as sleep } from 'node:timers/promises';

export function retryAfterSeconds(error) {
  const body = error?.response?.body;
  if (Number(body?.error_code ?? error?.response?.statusCode) !== 429) return null;
  const seconds = Number(body?.parameters?.retry_after);
  // Some proxies omit parameters; never fall back to a tight retry loop.
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 60;
}

export function installTelegramRateLimits(bot, {
  now = Date.now,
  wait = sleep,
  warn = console.warn,
} = {}) {
  const normalInterval = bot.options.polling.interval;
  const getUpdates = bot.getUpdates.bind(bot);
  // Keep the library's cancellable promise for stopPolling().
  bot.getUpdates = (...args) => getUpdates(...args).then((updates) => {
    bot.options.polling.interval = normalInterval;
    return updates;
  });
  bot.on('polling_error', (error) => {
    const seconds = retryAfterSeconds(error);
    bot.options.polling.interval = seconds === null ? normalInterval : (seconds + 1) * 1000;
    if (seconds !== null) {
      warn(`Telegram getUpdates rate limited; polling resumes in ${seconds + 1}s.`);
    }
  });

  const sendMessage = bot.sendMessage.bind(bot);
  let queue = Promise.resolve();
  let nextGlobalSend = 0;
  const nextChatSend = new Map();
  bot.sendMessage = (chatId, ...args) => {
    const run = async () => {
      const key = String(chatId);
      for (let attempt = 0; ; attempt++) {
        const delay = Math.max(nextGlobalSend, nextChatSend.get(key) || 0) - now();
        if (delay > 0) await wait(delay);
        // Telegram allows roughly 1/s per private chat and 20/min per group.
        nextGlobalSend = now() + 50;
        nextChatSend.set(key, now() + (key.startsWith('-') || key.startsWith('@') ? 3100 : 1100));
        try {
          return await sendMessage(chatId, ...args);
        } catch (error) {
          const seconds = retryAfterSeconds(error);
          if (seconds === null) throw error;
          nextGlobalSend = Math.max(nextGlobalSend, now() + (seconds + 1) * 1000);
          warn(`Telegram sendMessage rate limited; outgoing messages paused for ${seconds + 1}s.`);
          // Retry only rejected Telegram sends, never the expense handler.
          if (attempt >= 3) throw error;
        }
      }
    };
    const result = queue.then(run);
    queue = result.catch(() => {});
    return result;
  };
}
