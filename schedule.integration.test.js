import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { patchSource } from './scripts/patch-actual-api.js';

test('Actual lifecycle patch is installed, idempotent, and fails closed on source/version drift', () => {
  const require = createRequire(import.meta.url);
  const source = readFileSync(require.resolve('@actual-app/api'), 'utf8');
  assert.equal(patchSource(source, '26.7.0'), source, 'Run npm ci to install the required lifecycle patch');
  assert.throws(() => patchSource(source, '26.8.0'), /Reassess/);
  assert.throws(() => patchSource(source + '\n// drift', '26.7.0'), /Unexpected/);
});

for (const mode of ['switch', 'shutdown']) {
  test(`Actual scheduled transaction survives immediate ${mode} without crossing budgets or duplicating`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'telegram-schedule-test-'));
    try {
      const result = spawnSync(process.execPath, ['support/schedule-worker.js', directory, mode],
        { encoding: 'utf8', timeout: 30_000, windowsHide: true });
      assert.equal(result.status, 0, result.stderr + result.stdout);
      assert.match(result.stdout, /SCHEDULE_LIFECYCLE_OK/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}
