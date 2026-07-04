---
name: verify
description: Build, launch, and drive the zrode web app to verify a change end-to-end.
---

# Verifying zrode changes in the running app

## Launch

```bash
pnpm dev > /tmp/zrode-dev.log 2>&1 &   # starts server (port 13773) + web (port 5733)
```

- Watch the log for `Authentication required. Open Zrode using the pairing URL.` —
  it prints a one-time URL like `http://localhost:5733/pair#token=XXXX`. Open that
  URL in the preview browser to authenticate; it redirects to `/`.
- Server state lives in `~/.t3/dev` (SQLite + keybindings.json). Existing projects
  and threads from previous dev sessions are available.
- Both `@t3tools/shared` and `@t3tools/contracts` are consumed from `src/` via
  package exports — no package build step needed before running.

## Drive

- Use the `mcp__t3-code__preview_*` tools against `localhost:5733`.
- Most thread/project features need an active thread: open the sidebar
  (button `Toggle main sidebar`), click a thread under a project, or navigate
  directly to `/{environmentId}/{threadId}`.
- `preview_press` with real keys works for shortcuts (e.g. `p` + `Meta`), but
  typing into dialog inputs is more reliable after clicking the input first.
  `window.dispatchEvent(new KeyboardEvent('keydown', {...}))` via
  `preview_evaluate` also reaches the app's window-level shortcut listeners.
- `preview_press`/`preview_click` often return a malformed-result MCP error even
  when the action succeeded — confirm effects with `preview_evaluate` or
  `preview_snapshot` instead of retrying blindly.

## Gotchas

- Vite HMR of route files re-runs `beforeLoad`; a transient auth error there can
  bounce the app back to `/`. Re-navigate and continue — not a product bug.
- Verify keybinding changes end-to-end: the server backfills new defaults into
  `~/.t3/dev/keybindings.json` on startup and streams resolved bindings to the
  client, so a stale server process will not know a newly added command.

## Teardown

```bash
kill %1  # or pkill -f dev-runner
```
