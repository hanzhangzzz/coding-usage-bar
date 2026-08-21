# Claude Usage Freshness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make new Claude status-line usage immediately visible while preventing a concurrent daemon from restoring an older value, without adding history scans, network calls, subprocesses, or rendering to the hot path.

**Architecture:** Serialize only `status.json` read-modify-write operations with a short filesystem lock. Ingest patches the Claude provider entry using its previous conversion rate; daemon collection remains outside the lock and reconciles cached observations by `observedAt` inside the lock before saving.

**Tech Stack:** TypeScript, Node.js synchronous filesystem primitives, Node test runner.

---

### Task 1: Lock and monotonic reconciliation

**Files:**
- Modify: `src/status.ts`
- Test: `tests/status.test.js`

- [ ] **Step 1: Write failing tests**

Add tests that construct an older collected Claude observation and a newer `claude/latest.json`, then assert the committed snapshot uses the newer observation. Add a second test in which two status update callbacks contend for the lock and assert the second callback cannot enter until the first exits.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- --test-name-pattern="newer cached usage|serializes status"`

Expected: FAIL because the locking and reconciliation exports do not exist.

- [ ] **Step 3: Implement minimal locking and reconciliation**

In `src/status.ts`, add:

```ts
export function withStatusSnapshotLock<T>(paths: RuntimePaths, action: () => T): T
export function reconcileLatestUsages(usages: ProviderUsage[], paths: RuntimePaths): ProviderUsage[]
```

The lock uses an exclusive filesystem lock adjacent to `status.json`, waits only around the local critical section, cleans up in `finally`, and rejects an invalid timestamp as newer. Reconciliation preserves input order and chooses the cache only when its valid `observedAt` is newer.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npm test -- --test-name-pattern="newer cached usage|serializes status"`

Expected: PASS.

### Task 2: Constant-cost Claude snapshot update

**Files:**
- Modify: `src/burn.ts`
- Modify: `src/status.ts`
- Modify: `src/cli.ts`
- Test: `tests/status.test.js`

- [ ] **Step 1: Write failing tests**

Add a test that saves an existing multi-provider snapshot, updates Claude from 44% to 101%, and asserts Claude becomes `LIMIT_RISK` immediately while the other provider is unchanged. Make `claude/samples.jsonl` a directory and assert the same update still succeeds, proving the hot path does not read history.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- --test-name-pattern="updates Claude immediately|does not read Claude samples"`

Expected: FAIL because `updateStatusSnapshotUsage()` does not exist.

- [ ] **Step 3: Implement the minimal update path**

Refactor `src/burn.ts` so the existing analysis path and the hot update path share a function that accepts a precomputed conversion rate. Add this API in `src/status.ts`:

```ts
export function updateStatusSnapshotUsage(
  usage: ProviderUsage,
  paths?: RuntimePaths,
): StatusSnapshot
```

Inside the status lock, load the existing snapshot, preserve non-Claude providers, reuse Claude's previous `target.conversionRate` when present, recompute Claude analysis and freshness, remove resolved Claude missing/stale issues, and atomically save. Change `ingest claude-statusline` to call this function after `saveUsage()`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npm test -- --test-name-pattern="updates Claude immediately|does not read Claude samples"`

Expected: PASS.

### Task 3: Protect daemon final write

**Files:**
- Modify: `src/runtime.ts`
- Test: `tests/status.test.js`

- [ ] **Step 1: Write a failing end-to-end commit test**

Exercise the daemon snapshot commit helper with an older collected Claude value and a newer cached value. Assert both returned snapshot and saved `status.json` contain the newer value.

- [ ] **Step 2: Run the test and verify RED**

Run: `npm test -- --test-name-pattern="daemon commit preserves newer Claude"`

Expected: FAIL because daemon final save is not locked and reconciled.

- [ ] **Step 3: Implement guarded commit**

Wrap only the non-fixture snapshot creation and save in `withStatusSnapshotLock()`. Inside that lock call `reconcileLatestUsages()` before `createStatusSnapshot()`. Keep `collectLocalState()` and every live Provider API request outside the lock.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npm test -- --test-name-pattern="daemon commit preserves newer Claude"`

Expected: PASS.

### Task 4: Adversarial and delivery verification

**Files:**
- Modify only if a test exposes a defect in the scoped implementation.

- [ ] **Step 1: Run required repository verification**

Run:

```bash
npm ci
npm test
npm run build
npx --no-install coding-usage-bar doctor --dry-run
npx --no-install coding-usage-bar status --fixtures
npx --no-install coding-usage-bar menubar render
npm pack --dry-run
```

Expected: all commands exit 0.

- [ ] **Step 2: Verify hot-path performance boundary**

Run a temporary-HOME harness with a large or inaccessible Claude samples path and repeated `updateStatusSnapshotUsage()` calls. Confirm zero sample access failures and record elapsed time; do not set a brittle CI wall-clock threshold.

- [ ] **Step 3: Verify installed plugin presence**

Run:

```bash
PLUGINDIR=$(defaults read com.ameba.SwiftBar PluginDirectory 2>/dev/null || echo "$HOME/Library/Application Support/SwiftBar/Plugins")
ls -la "$PLUGINDIR/coding-usage-bar.1m.js"
```

Expected: file exists and is executable. No real install is performed without separate authorization.

- [ ] **Step 4: Inspect the final diff and commit**

Run `git diff --check`, confirm only scoped files changed, commit with the configured `huajuan404` identity, and push the task branch without force.
