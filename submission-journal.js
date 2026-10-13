import { mkdirSync, rmdirSync, openSync, closeSync, readFileSync, writeFileSync, renameSync,
  unlinkSync, fsyncSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

function processStart(pid) {
  if (process.platform !== 'linux') return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const ticks = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
    return `${readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}:${ticks}`;
  } catch { return null; }
}

// Held for the process lifetime. Shared filesystems/multiple hosts are unsupported.
export function acquireLock(directory, name = 'writer.lock') {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, name);
  const nonce = randomUUID();
  try {
    const fd = openSync(path, 'wx', 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), start: processStart(process.pid), nonce }));
      fsyncSync(fd);
    } finally { closeSync(fd); }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = JSON.parse(readFileSync(path, 'utf8'));
    if (owner.host !== hostname()) throw new Error('WRITER_LOCKED');
    try {
      // Container restarts commonly reuse PID 1. Linux start time distinguishes
      // the previous writer from the new process without stealing a live lock.
      const currentStart = processStart(owner.pid);
      if (owner.start && currentStart && owner.start !== currentStart) {
        throw Object.assign(new Error('previous process exited'), { code: 'ESRCH' });
      }
      process.kill(owner.pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') {
        const reclaim = `${path}.reclaim`;
        // Serialize stale-lock reclamation and recheck the owner under this lock.
        // Never unlink a replacement lock acquired by another process.
        mkdirSync(reclaim, { mode: 0o700 });
        try {
          const current = JSON.parse(readFileSync(path, 'utf8'));
          if (current.nonce !== owner.nonce || current.pid !== owner.pid || current.host !== owner.host) throw new Error('WRITER_LOCKED');
          unlinkSync(path);
          return acquireLock(directory, name);
        } finally { rmdirSync(reclaim); }
      }
      throw new Error('WRITER_LOCKED');
    }
    throw new Error('WRITER_LOCKED');
  }
  return () => {
    const owner = JSON.parse(readFileSync(path, 'utf8'));
    if (owner.nonce !== nonce) throw new Error('WRITER_LOCKED');
    unlinkSync(path);
  };
}

export class SubmissionJournal {
  constructor(directory) {
    if (!directory) throw new Error('BOT_DATA_DIR_REQUIRED');
    this.directory = resolve(directory);
    this.release = acquireLock(this.directory);
    chmodSync(this.directory, 0o700);
    this.path = join(this.directory, 'submissions.json');
    try {
      this.data = JSON.parse(readFileSync(this.path, 'utf8'));
      if (this.data.version !== 1 || !this.data.records || Array.isArray(this.data.records)) throw new Error('JOURNAL_INVALID');
      chmodSync(this.path, 0o600);
    } catch (error) {
      if (error.code !== 'ENOENT') { this.release(); throw error; }
      this.data = { version: 1, records: {} };
      this.flush();
    }
  }
  get(id) { return structuredClone(this.data.records[id]); }
  event(id) { return structuredClone(this.data.events?.[id]); }
  putEvent(id, event) {
    this.data.events ||= {};
    const previous = this.data.events[id];
    this.data.events[id] = structuredClone(event);
    try { this.flush(); } catch (error) {
      if (previous) this.data.events[id] = previous;
      else delete this.data.events[id];
      throw error;
    }
  }
  compact(now = Date.now()) {
    // Keep unresolved financial records. Completed payloads have a 90-day
    // retention; compact deduplication tombstones are retained indefinitely.
    for (const [id, record] of Object.entries(this.data.records)) {
      if (!record.compacted && ['verified', 'undone'].includes(record.status) &&
          record.updatedAt < now - 90 * 86400_000) {
        this.data.records[id] = { id, status: record.status, compacted: true,
          contextKey: record.contextKey, budgetKey: record.budgetKey,
          createdAt: record.createdAt, updatedAt: record.updatedAt,
          transactionIds: record.legs.map(l => l.id), legs: [] };
      }
    }
    this.flush();
  }
  all() { return Object.values(structuredClone(this.data.records)); }
  put(record) {
    const previous = this.data.records[record.id];
    this.data.records[record.id] = structuredClone(record);
    try { this.flush(); } catch (error) {
      if (previous) this.data.records[record.id] = previous;
      else delete this.data.records[record.id];
      throw error;
    }
  }
  flush() {
    const temp = `${this.path}.${randomUUID()}.tmp`;
    const fd = openSync(temp, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(this.data)); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temp, this.path);
    if (process.platform !== 'win32') {
      const dir = openSync(this.directory, 'r');
      try { fsyncSync(dir); } finally { closeSync(dir); }
    }
  }
  close() { if (this.release) { this.release(); this.release = null; } }
}
