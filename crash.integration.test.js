import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

for (const phase of ['before-write', 'after-write', 'after-local', 'after-sync']) {
  test(`Actual synthetic budget + hard process exit at ${phase}: restart does not reinsert`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'telegram-crash-test-'));
    try {
      const run = boundary => spawnSync(process.execPath, ['support/crash-worker.js', directory, boundary],
        { encoding: 'utf8', timeout: 30_000, windowsHide: true });
      const crash = run(phase);
      assert.equal(crash.status, 86, crash.stderr);
      const recovered = run('recover');
      assert.equal(recovered.status, 0, recovered.stderr);
      const result = JSON.parse(recovered.stdout.trim().split('\n').at(-1));
      assert.equal(result.count, phase === 'before-write' ? 0 : 1);
      assert.equal(result.status, phase === 'before-write' ? 'uncertain' : 'verified');
      if (result.count) assert.equal(result.identityMatches, true);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}
