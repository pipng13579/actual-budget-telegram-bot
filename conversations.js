import { AsyncLocalStorage } from 'node:async_hooks';

export const isCancellation = error => error?.code === 'CANCELLED';
export class Conversations {
  storage = new AsyncLocalStorage();
  states = new Map();
  state(key) {
    if (!this.states.has(key)) this.states.set(key, { generation: 0, queue: Promise.resolve() });
    return this.states.get(key);
  }
  check() {
    const token = this.storage.getStore();
    if (token && !token.committed && token.generation !== token.state.generation) {
      throw Object.assign(new Error('CANCELLED'), { code: 'CANCELLED' });
    }
  }
  commit() { this.check(); const token = this.storage.getStore(); if (token) token.committed = true; }
  cancel(key) {
    const state = this.state(key);
    state.generation++;
    return !!state.active?.committed;
  }
  run(key, operation) {
    const state = this.state(key);
    const token = { state, generation: state.generation, committed: false };
    const result = state.queue.then(() => this.storage.run(token, async () => {
      this.check(); state.active = token;
      try { return await operation(); } finally { state.active = null; }
    }));
    state.queue = result.catch(() => {});
    return result;
  }
  async drain() { await Promise.all([...this.states.values()].map(s => s.queue)); }
}

export class ConversationMap extends Map {
  constructor(conversations) { super(); this.conversations = conversations; }
  set(key, value) { this.conversations.check(); return super.set(key, value); }
  delete(key) { this.conversations.check(); return super.delete(key); }
}
