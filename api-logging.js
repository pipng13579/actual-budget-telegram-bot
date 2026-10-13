import { AsyncLocalStorage } from 'node:async_hooks';
import { safeCode } from './submissions.js';

const calls = new AsyncLocalStorage();
export function redactedApi(api) {
  return new Proxy(api, { get(target, key) {
    const value = target[key];
    return typeof value === 'function' ? (...args) => calls.run(String(key), () => value(...args)) : value;
  } });
}

// verbose:false does NOT disable upstream warnings/exceptions in 26.7.0.
// Async context includes background tasks created during API initialization.
export function installApiLogRedaction() {
  const originals = {};
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    originals[level] = console[level];
    console[level] = (...args) => {
      const method = calls.getStore();
      if (!method) return originals[level](...args);
      const error = args.find(arg => arg instanceof Error);
      originals[level](JSON.stringify({ source: 'actual-api', method, level, code: safeCode(error) }));
    };
  }
  return () => Object.assign(console, originals);
}
