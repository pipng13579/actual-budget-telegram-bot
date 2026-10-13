// Compatibility fix for the exact pinned 26.7.0 bundle. Remove/reassess on upgrade.
// Actual's sync listener launches a mutator that closeBudget does not await.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const originalHash = '5397cb2223ecdf5c8283df1807a9824c44fcae2e7d99d549077a51140c58abc5';
const marker = '// Telegram bot: drain background schedules before closing a budget.';
const replacements = [
  ['app$17.events.on("sync", ({ type }) => {', `${marker}
var scheduleServiceTask = null;
var scheduleServiceClosing = false;
app$17.events.on("sync", ({ type }) => {
\tif (scheduleServiceClosing || scheduleServiceTask) return;`],
  ['\t\t\trunMutator(() => advanceSchedulesService(type === "success"));\n\t\t\tif (type === "success") savePrefs({ lastScheduleRun: currentDay() });',
    `\t\t\tconst task = runMutator(async () => {
\t\t\t\tawait advanceSchedulesService(type === "success");
\t\t\t\tif (type === "success") await savePrefs({ lastScheduleRun: currentDay() });
\t\t\t});
\t\t\tscheduleServiceTask = task;
\t\t\ttask.then(() => { scheduleServiceTask = null; }, () => {
\t\t\t\tscheduleServiceTask = null;
\t\t\t\t// Do not expose transaction details or leave an unhandled rejection.
\t\t\t\tlogger.warn("Scheduled transaction service failed; will retry on next sync");
\t\t\t});`],
  ['async function closeBudget() {', `async function closeBudget() {
\tscheduleServiceClosing = true;
\ttry {
\t\t// Includes preference persistence. A failure rejects close, keeping the DB open.
\t\tawait scheduleServiceTask;
\t\treturn await closeBudgetAfterSchedules();
\t} finally {
\t\tscheduleServiceClosing = false;
\t}
}
async function closeBudgetAfterSchedules() {`],
];
const hash = source => createHash('sha256').update(source).digest('hex');

export function patchSource(source, version) {
  if (version !== '26.7.0') throw new Error('Reassess the Actual schedule lifecycle patch before changing API versions');
  if (source.includes(marker)) {
    // Verify the entire source even on repeated installs, not just our marker.
    let restored = source;
    for (const [before, after] of [...replacements].reverse()) {
      if (restored.split(after).length !== 2) throw new Error('Incomplete Actual schedule lifecycle patch');
      restored = restored.replace(after, before);
    }
    if (hash(restored) !== originalHash) throw new Error('Unexpected patched Actual API bundle');
    return source;
  }
  if (hash(source) !== originalHash) throw new Error('Unexpected Actual API bundle; refusing to apply schedule lifecycle patch');
  for (const [before, after] of replacements) {
    if (source.split(before).length !== 2) throw new Error('Actual schedule lifecycle patch no longer matches');
    source = source.replace(before, after);
  }
  return source;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const require = createRequire(import.meta.url);
  const entry = require.resolve('@actual-app/api');
  const { version } = JSON.parse(readFileSync(resolve(dirname(entry), '../package.json'), 'utf8'));
  const source = readFileSync(entry, 'utf8');
  const patched = patchSource(source, version);
  if (patched !== source) writeFileSync(entry, patched);
  console.log('Actual 26.7.0 schedule lifecycle patch verified');
}
