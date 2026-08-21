# Claude Usage Freshness Design

## Goal

When Claude Code writes a newer status-line usage observation, `status.json` must expose it immediately and a concurrently running daemon must never replace it with an older observation.

## Root cause

`collectLocalState()` currently reads Claude's cached observation before awaiting live network collectors. If status-line ingest writes a newer Claude observation while those requests are in flight, the daemon later saves the old in-memory observation to `status.json`. Separately, ingest updates only `claude/latest.json`, so the display can remain stale until the next five-minute daemon run.

## Design

Add a local-only snapshot refresh path that reads provider `latest.json` files and rebuilds `status.json` without live API calls, child processes, image rendering, or notification work.

Claude status-line ingest will:

1. Parse and persist the Claude observation as it does today.
2. Refresh `status.json` from local provider caches so the new percentage is immediately visible.

The daemon will:

1. Perform its existing live collection.
2. Immediately before building and saving `status.json`, reconcile every collected provider with its local cached observation.
3. Select the observation with the newer valid `observedAt`, preventing an in-flight collection from overwriting a newer producer write.

The display boundary remains unchanged: `status` and `menubar render` continue to read only `status.json`.

## Performance constraints

- Claude ingest adds only bounded local JSON reads and one atomic `status.json` write.
- Claude ingest must not call any provider API, spawn a subprocess, send notifications, or render images.
- Existing sample files are not appended again during snapshot refresh.
- No extra work is added to the one-minute SwiftBar render path.

## Error handling

Status-line ingest remains successful after the Claude provider cache is persisted even if rebuilding `status.json` fails because another cached provider file is malformed. A valid provider cache is used; missing caches are skipped. Invalid timestamps never displace a valid newer observation.

## Tests

- A local-only refresh test proves a newly saved Claude observation immediately replaces the older Claude provider in `status.json` while preserving other cached providers.
- A reconciliation test proves an older in-memory daemon observation cannot overwrite a newer Claude cache observation.
- A performance-boundary test proves local refresh uses injected local loaders only and never invokes live collectors.
- Existing tests retain the invariant that display entry points do not collect raw provider data.

## Acceptance criteria

- After Claude ingest receives `101%`, the next menu render can read `101%` without waiting for daemon scheduling.
- A daemon that started before that ingest still saves `101%`, not its older value.
- The status-line path performs no network, subprocess, notification, or image-rendering work.
- The repository's required test, build, CLI, package, and SwiftBar plugin-presence checks pass.
