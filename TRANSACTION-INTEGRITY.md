# Transaction integrity and recovery

## Verified findings and limits (2026-10-13)

The fetched `origin/main` baseline was `385a430a4bb87089bb6a877e58661cecb6dfb20b`.
The lockfile and installed Actual API are **26.7.0**. The local test runtime is
Node **24.15.0**; the deployment Dockerfile uses Node **22** (tested as **22.23.3**).
The Docker image built successfully: **63 tests passed, zero failures/skips**, in
Node 22.23.3 with networking disabled. `git diff --check` also passed.
No dependency upgrade
was used as a fix. No real budget was written, synced, or modified during this work.

| Classification | Evidence | Distinguishing next check |
| --- | --- | --- |
| Confirmed code defect: false success | Old `addToActual` discarded import errors/added/updated and returned success after sync even without an ID. | New production pipeline failure-injection tests reject invalid results. |
| Confirmed code defect: accidental reconciliation | 26.7.0 import implementation searches for existing entries and can update them; old manual expenses called it. | Synthetic integration proves identical explicit additions produce distinct IDs. |
| Confirmed code defect: unsafe undo | Old read-back chose a matching amount/category instead of a created identity. | New exact-ID/origin/fingerprint checks and undo tests. |
| Confirmed code defect: misleading drafts | Old catch returned null; confirmation called that “Draft Logged.” No durable draft was recorded. | New stage-specific outcomes and durable journal. |
| Confirmed code race | Old receipt/category handlers could resume and restore state after cancellation. | Production-handler tests delay receipt/category work, cancel, then release it. |
| Confirmed API behavior | `addTransactions` returns `"ok"`; IDs supplied in payload and `imported_id` persist through restart. Both add and import run rules. Delete/update wrappers can return before mutations settle. | Real API synthetic tests, hard process exits, bounded local verification. |
| Unresolved runtime cause: Pip Finances | No historical `Failed to add transaction...` error window, deployed configuration, or live access is present here. | Redacted stage/error logs; route-specific Sync ID, encryption and account validation. |
| Unresolved hypothesis: Sheng Shiong was matched/updated | Supplied `updatedPreview` fragment is consistent with reconciliation, but lacks final `errors`, `added`, `updated` and matched ID. | Inspect that exact account/date window and import result from the incident, read-only. |
| Unresolved independent Telegram issue | `EFATAL ... ECONNRESET` alone proves neither an Actual failure nor duplicate pollers. | Correlate timestamps, process count, polling 409/429/errors and deployment restarts separately. |

`reproduction-results.txt` reports seven reproductions of old defects and one
cancellation control. Those passes are not fixed-code tests or live-server checks.
The previous baseline was unchanged on fetch. There is no `.env`, deployed image
identity, server version, live cache, or route credential available in this checkout.
`maybankxl` cannot be classified as a configured account alias without the deployed
account mapping; it remains ordinary notes if not an existing configured keyword.
Pip Finances and Family Budget must be investigated independently.

## Submission contract

Completed text and receipt input submits immediately. Receipts use the configured
default account. Missing amount/category still prompts; there is no draft toggle
or confirmation gate. Origin is SHA-256 of bot ID, chat ID, user ID, budget route,
and original Telegram message ID. Follow-ups keep this original identity. Durable
message links prevent a redelivered follow-up from becoming another expense;
duplicate undo commands remain bound to their original target.

Before writing money, an atomic, fsynced record stores the original date, account,
payload, server/Sync-ID fingerprint, random UUID and bot-scoped origin marker for
each leg. The UUID is passed through the pinned API's supported transaction input;
the persistent `imported_id` is a second provenance check. Neither field is assumed
to make Actual's insertion idempotent: the journal and single writer decide whether
insertion is permitted. Querying exact UUID/marker includes deleted rows and checks
cardinality, account, amount, date, category, payee, notes, imported payee and cleared
status. Similar transactions are never candidates.

An attempted insertion is never repeated. If a process dies after recording intent
but before actually writing, absence is conservatively **outcome unknown**, not
permission to insert. A fully prepared, not-yet-attempted record can resume.
After an insertion, recovery resolves the original UUID/marker and retries only
sync/verification. Missing cache/remote rows, changed configuration, malformed
results, removed markers or unexpected split/transfer effects require inspection.
New submissions can still proceed. Deleted and undone entries are never recreated.

Normal success requires exact local verification and successful `sync()` resolution
(which returns `undefined` in 26.7.0). It is **not** independent proof of remote
browser visibility. Failure before writing, local-only confirmation, unknown write
outcome, and sync acknowledgement followed by verification failure have distinct
responses. Outcomes persist before replying to Telegram. Reply failures never
retry monetary operations.

Known transient network codes receive at most three delayed recovery attempts,
30/60/120 seconds apart, persisted in the journal. Startup inspects unresolved
attempts once. Authentication, encryption, configuration and payload failures do
not enter a continuous retry loop. No promised notification/receipt delivery queue
exists; background recovery logs its outcome and duplicate delivery can retrieve it.

## Actual API compatibility decisions

Source checked: `node_modules/@actual-app/api/dist/index.js`, specifically
`api/transactions-add`, `addTransactions$1`, `normalizeTransactions`,
`reconcileTransactions`, `api/sync`, `api/transaction-update/delete`.

* `addTransactions` does not reconcile; its public handler returns `"ok"`, not the
  IDs returned by its internal helper. Integration tests verify supplied UUIDs and
  origin markers persist across shutdown/reload and hard process exit.
* Addition trims raw payee names; import title-cases them. Existing payees are reused
  by the API. Rules may normalize payees; the resulting exact payee ID/name is frozen
  for verification. Original input is retained in `imported_payee`.
* Both methods run rules. Explicit amount/date/category/notes/cleared/imported-payee
  choices are restored on the **just-created** proven row and verified before sync.
  Recovery never blindly rewrites a mismatched row. Interrupted normalization can
  therefore require operator review. Rule-created splits, transfer payees or lost
  markers produce an explicit unresolved outcome rather than false success.
* Cleared is deliberately `true`, matching the old import default. Category learning
  remains disabled (the old import's batch default was also false). Bot keyword
  learning and budget-scoped learned files remain unchanged.
* Automatic Actual transfer generation is disabled. `/transfer` retains the existing
  two independent signed entries and descriptive payees, rather than redesigning
  them as a linked Actual transfer. Each leg has its own journaled UUID/marker.
  Both legs must verify and sync; partial completion is reported truthfully and
  recovery never recreates an attempted leg. This operation is **not atomic**.
  `/undo` is for expenses, not transfers. Historical/partial transfer correction is
  an operator task requiring separate authorization and a backup.
* Update/delete return values are not trusted as completion. Bounded reads wait for
  the local mutation, then sync and read again. Undo compares the original fingerprint
  and refuses externally changed, reconciled, or unproven entries.

## Durable storage and deployment

1. Stop the old writer gracefully. Preserve/back up its **existing Actual cache**,
   learned-keyword files and any journal. Do not deploy to an empty replacement
   cache while old local writes may be unresolved.
2. Mount persistent local storage, e.g. a Docker named volume at `/data`. Set
   `ACTUAL_DATA_DIR=/data`, `BOT_DATA_DIR=/data/bot-data`, and optionally
   `ACTUAL_BUDGET_DATA_DIR` to the existing persistent cache location. Existing
   legacy account and `ACTUAL_SYNC_ID` configuration remain supported for user 1.
   A configured default outside a user's account allowlist is now an explicit error.
3. Run exactly **one process/machine** per Telegram token, journal and Actual cache.
   Process-lifetime locks guard journal and cache. Multi-host/network filesystem
   operation is unsupported. Same-host locks left by a dead PID can be reclaimed;
   changed-host locks or an interrupted `.reclaim` operation fail closed. An operator
   may remove a stale lock only after proving no owner/old deployment is running;
   never erase the cache or journal to clear a lock.
4. Journal files use mode 0600 and its directory 0700 on POSIX. On Windows apply
   equivalent NTFS ACLs to the dedicated bot account. Use restrictive backup access.
   Existing broad parent-directory access and mount durability are operator checks.
5. Completed financial payloads are compacted after **90 days**, at startup; compact
   message/submission/undo tombstones persist without automatic expiry. Unresolved
   records remain until reviewed. `/undo` is supported only while full provenance
   remains. Deduplication persists while tombstones are retained; deleting/restoring
   an older journal loses that protection. Journal size should be monitored: this is
   a small single-process atomic JSON store, not a large multi-writer database.
6. Rebuild/recreate the image. Docker copies all new runtime modules. The Fly template
   requires an `actual_bot_data` volume and exactly one machine. The template app name
   and region are examples, not evidence of the live deployment.

Default timezone is **Asia/Singapore**, overridden by an explicit `TZ`. Default expense
dates use the original Telegram message timestamp, including slow receipt processing.
Parser dates,
daily/weekly/monthly boundaries and scheduled checks use the same timezone. Recovery
retains the originally resolved date rather than recalculating after midnight.

Rolling back to an older writer while attempts are unresolved is unsafe: it ignores
the journal and may reconcile or duplicate entries. Keep journals/caches intact,
stop writers, reconcile unresolved identities, and back up before any rollback.
Pushing source changes does not mean deployment has occurred.

## Read-only diagnostics and historical reconciliation

Host/operator-only commands (do not publish their output to another user's chat):

```sh
npm run diagnose
node diagnostics.js --remote --route user1
node diagnostics.js --remote --route family --reference <full-submission-reference>
```

Default diagnostics inspect configuration **presence**, mapping consistency, cache
accessibility and journal state counts, without initializing Actual. The optional
remote check uses a new temporary cache in a separate process, one explicitly chosen
route, and read-only account/category/exact-ID queries. It never calls `sync()` or
uses/replaces the running cache. It reports installed API/server version where
obtainable. An absent remote row does not establish that no unsynced local row exists.
This diagnostic was run offline here; live remote checks remain unperformed.

Collect the following missing evidence per affected route, with secrets redacted:

* Narrow log window around the incident: original Actual error, initialization and
  switching errors, final import `errors/added/updated`, exact matched ID, and timestamps.
* Deployed commit/image digest, Node/API/Actual server versions; compare with repository
  and lockfile. Check mounting/persistence, directory permissions and free space.
* Actual **Sync ID** (not a local budget ID), endpoint, encryption requirement, account
  IDs belonging to that budget, default/user allowlist and categories. Never dump `.env`.
* Process/container count for the bot token and cache, restart history, Telegram polling
  resets/409 conflicts/429 cooldowns separately from Actual sync outcomes.
* For Sheng Shiong, only its relevant account/date window and matched ID. Check the
  target route/date and browser filters/freshness. Do not export whole ledger histories.

Classify each historical incident as **absent**, **present**, **matched/updated**,
**locally unsynced**, or **unresolved**, citing exact evidence. New origin markers
cannot retroactively identify old Telegram entries. Do not bulk-resubmit old
“Draft Logged” expenses, use the old undo heuristic, or auto-delete suspected
duplicates. Any real-ledger correction needs separate authorization and a backup.
Do not call `sync()` on the old running cache as a read-only diagnostic: that can
upload outstanding writes. A local-cache read is not remote verification.

Routine logs contain stage, route, reference, attempt, exact IDs, outcome, duration
and allowlisted error codes. The API is initialized with `verbose:false`; its warnings
and errors are additionally redacted through an async-context wrapper because verbose
mode alone does not suppress upstream exception/payload logging. No unredacted verbose
mode is enabled. Credentials, amounts, payees, notes and ledger payloads stay out of
routine logs. References/IDs themselves should still be treated as private metadata.

## Tests and synthetic post-deployment check

### Actual 26.7.0 scheduled-transaction close race

The reported `Cannot read properties of null (reading 'prepare')` stack in
`advanceSchedulesService` is reproducible on Node 22.23.3 with the unmodified
26.7.0 API and two isolated synthetic budgets, with Docker networking disabled.
Actual's sync listener starts a background schedule mutator without awaiting it.
Both switching budgets and shutdown can close SQLite while that mutator still
uses it. The bot's own serialized queue cannot track this internal background work.

`scripts/patch-actual-api.js` applies a narrow compatibility patch during `npm ci`
or `npm install`. It tracks the pending schedule task (including preference writes),
waits for it before closing, and prevents new schedule runs during close. Concurrent
sync events share the in-progress run. Schedules remain enabled; the daily success
marker is saved only after the run succeeds. A failure is logged without ledger
details, and a close awaiting that failed run rejects while keeping the database
open. No process-wide unhandled-rejection suppression or fixed sleep is used.

The patch checks the exact API version and bundle SHA-256, including on repeated
installation. An unexpected version or modified bundle fails installation so an
upgrade requires explicit review of the patch. Do not use `--ignore-scripts` for
installation. Docker copies the patch before `npm ci --omit=dev`, so **rebuild and
redeploy the image** to apply this fix; restarting an old image is insufficient.
No API version, budget data, or schedule configuration is changed by installation.

`schedule.integration.test.js` exercises the installed patched API in child
processes: a real offline sync event starts a due scheduled transaction immediately
before switching or shutdown. Reopening confirms exactly one transaction in the
source budget and none in the destination. These are synthetic local lifecycle
tests, not remote server verification.

```sh
npm ci
npm test
```

Tests import production services and handler factories without polling/timers/live
clients. Controlled mocks cover failures, routing, races, Telegram delivery, malformed
results, undo and partial transfers. `actual-api.integration.test.js` uses the pinned
API with an isolated local synthetic budget for insertion, persistence, rules and
delete behavior. `crash.integration.test.js` forcibly exits child processes at four
boundaries and reopens the real API cache/journal to verify no duplicate insertion.
Their sync acknowledgement is explicitly stubbed: **no real sync server is used**.
The offline `runImport` fixture may print an expected unauthorized-upload warning;
it has no configured endpoint or credentials. This is not a live budget failure.

After deployment, use a **designated synthetic budget** and authorized test Telegram
user. Configure its actual Sync ID/accounts and persistent storage. Submit two identical
purchases in different messages; confirm two exact IDs. Replay one message and restart
the bot; confirm no third entry. Cancel an incomplete receipt, then submit a fresh
expense. Test `/undo` on a proven synthetic entry and replay it. Use the fresh-cache
diagnostic with each reference to check independent remote presence/deletion. Exercise
each route separately. Only then assess live resolution; unit/local integration passes
alone cannot establish it.

Changed runtime files: `bot.js`, `submissions.js`, `submission-journal.js`,
`conversations.js`, `dates.js`, `api-logging.js`, `diagnostics.js`, `parser.js`,
`telegram-rate-limit.js`. Deployment/config/docs and production-import tests accompany
these changes. The rate-limit behavior is preserved; the added send-time guard only
suppresses stale conversation replies after cancellation.
