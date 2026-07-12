# Workspace files and editor architecture

This document records the July 2026 source audit of VS Code, Zed, and Zrode's
workspace-file experience. It describes the invariants Zrode adopts, the
tradeoffs it deliberately does not copy, and the failure cases that tests must
cover.

The reference revisions were:

- VS Code `db58c8918ca2ddba2b984f7f18fca7316023d8cb`
- Zed `76c93968da`
- Zrode's implementation on the branch containing this document

## Executive conclusion

Neither reference editor makes a tree row or an editor widget the owner of a
file. Both separate three lifetimes:

1. the project tree describes resources on disk;
2. a canonical document owns text, dirty state, disk identity, and saving;
3. tabs and editor widgets are views of that document.

This separation is the main reliability feature. It means switching tabs,
changing themes, hiding a panel, or temporarily destroying an editor widget
cannot silently discard or rewrite text.

Zrode should adopt that invariant without copying the reference editors' full
provider, extension, native-rendering, or collaboration infrastructure.

## VS Code findings

VS Code's relevant pipeline is:

```text
filesystem provider
  -> FileService and watcher events
  -> ExplorerModel
  -> virtual asynchronous tree
  -> FileEditorInput
  -> TextFileEditorModel
  -> Monaco TextModel
  -> viewport-rendered editor
```

### Project tree

`ExplorerModel` caches stable `ExplorerItem` objects. A directory is unresolved
until it is expanded. A refresh merges new stats and children into existing
objects instead of replacing the entire tree. That preserves expansion,
selection, focus, and inline-edit state across disk changes.

The explorer uses an asynchronous virtual tree with fixed-height recycled rows.
Reveal is path-scoped: it resolves and merges only the root-to-file ancestor
chain, expands those ancestors, and scrolls only when the target is outside the
viewport.

Watcher events are treated as invalidation hints. They are batched, correlated
with explicit file operations where possible, and supplemented by refreshes on
window focus and explorer visibility. This acknowledges that filesystem
watchers can overflow, coalesce, or report transient deletes.

Important source locations:

- `src/vs/platform/files/common/fileService.ts`
- `src/vs/workbench/contrib/files/common/explorerModel.ts`
- `src/vs/workbench/contrib/files/browser/explorerService.ts`
- `src/vs/workbench/contrib/files/browser/views/explorerView.ts`
- `src/vs/base/browser/ui/tree/asyncDataTree.ts`

### Documents and saving

`FileEditorInput` is tab identity, not document storage. The canonical
`TextFileEditorModel` owns the text model, disk metadata, encoding, dirty state,
and save sequence. Detaching an editor widget only detaches its model.

The model has explicit saved, dirty, pending-save, conflict, orphaned, and error
states. A save captures the in-memory version it writes. Success clears dirty
state only if no newer edit appeared while I/O was pending. Newer saves queue
behind the current save instead of racing it.

External changes reload only clean documents. A dirty document is never
replaced. A modified-since error enters conflict state and offers compare,
overwrite, or reload. Closing the final dirty view prompts; closing another view
of the same document does not.

VS Code's disk etag is based primarily on mtime and size. Its source explicitly
accepts that performance compromise, so same-size changes with an unhelpful
timestamp can escape conflict detection. Zrode uses a content digest for the
editable-file limit instead.

Important source locations:

- `src/vs/workbench/services/textfile/common/textFileEditorModel.ts`
- `src/vs/workbench/services/textfile/common/textFileEditorModelManager.ts`
- `src/vs/workbench/contrib/files/browser/editors/fileEditorInput.ts`
- `src/vs/workbench/contrib/files/browser/editors/textFileSaveErrorHandler.ts`
- `src/vs/workbench/services/workingCopy/common/workingCopyBackupTracker.ts`

## Zed findings

Zed's relevant pipeline is:

```text
Fs and native watcher
  -> revisioned Worktree snapshot
  -> stable Entry IDs and path indexes
  -> derived flat project-panel rows
  -> virtual uniform list

Worktree File
  -> BufferStore singleton
  -> Buffer / MultiBuffer
  -> Editor display-map snapshot
  -> viewport-rendered rows
```

### Project tree

The worktree, not the project panel, is authoritative. Its snapshots maintain a
path index and a stable-ID index. Scan generations and completion barriers make
background reconciliation observable. Entry IDs can survive renames by using
path and inode evidence, preserving buffers and navigation state.

The panel derives a flat visible-row array from immutable worktree snapshots,
expansion state, settings, and Git state. It constructs rows off the foreground
thread and renders only the requested virtual-list range. Reveal expands stable
ancestor IDs, rebuilds visible rows, then selects and scrolls after the rebuild.

This is robust, but the panel rebuilds the whole visible array for many changes
and some ID-to-row lookups remain linear. Its project rows also omit tree-level
accessibility metadata even though Zed's UI toolkit can provide it.

Important source locations:

- `crates/fs/src/fs.rs`
- `crates/fs/src/fs_watcher.rs`
- `crates/worktree/src/worktree.rs`
- `crates/project_panel/src/project_panel.rs`

### Documents and saving

`BufferStore` deduplicates concurrent opens and provides one buffer for a file.
Buffers own dirty and conflict state independently of panes. A save captures the
rope snapshot and buffer version; edits made while it is writing remain dirty.
Clean buffers reload external changes through a computed text diff, guarded by
the captured buffer version. Dirty buffers keep local text and enter conflict.

Zed's client-version semantics are strong, but its ordinary file save truncates
the target directly and its external-change fallback relies on mtime ordering
that Zed's own filesystem abstraction calls unsafe. Zrode therefore combines
the captured client version with a server-checked content revision and a
same-directory atomic replacement.

Important source locations:

- `crates/project/src/buffer_store.rs`
- `crates/language/src/buffer.rs`
- `crates/workspace/src/pane.rs`
- `crates/editor/src/editor.rs`
- `crates/editor/src/display_map.rs`

## Zrode before this change

Zrode already had useful foundations:

- server-side lexical and canonical containment checks for reads;
- a 1 MiB editable/preview limit and binary-file rejection;
- FFF-backed workspace indexing with native background watching;
- a virtualized `@pierre/trees` file explorer;
- fuzzy quick-open;
- per-path client command serialization;
- a Pierre editor instance kept stable while typing;
- persistent right-panel file tabs;
- source, markdown, syntax-highlighted, wrapped, and review-comment views.

The main correctness gaps were below those UI features:

1. Writes had no expected disk revision, so another process or client could be
   silently overwritten.
2. Writes checked only a lexical path. A final or parent symlink could escape
   the workspace even though reads rejected that escape.
3. Writes truncated the destination rather than atomically replacing it.
4. `FileSaveCoordinator` retained its last numeric revision after success.
   Disposing it could therefore write previously saved text again and clobber a
   newer external change.
5. A save coordinator belonged to a mounted React surface. A failed dispose-time
   save had no durable owner, and theme/tab lifecycle could influence I/O.
6. Existing-file saves synchronously awaited a full index refresh even though
   FFF already watches the workspace.
7. There was no active-document disk reconciliation or explicit conflict UI.
8. Pending state was keyed to the project root while the editor could use a
   worktree root.
9. The explorer did not reveal the active tab and used a fixed split width.

The tree's problem was not DOM row virtualization; `@pierre/trees` already
provides that. The scaling problem is the coarse, capped whole-workspace snapshot
and reset lifecycle.

## Adopted invariants

### Disk identity

Every complete editable read returns an opaque disk revision derived from the
exact raw bytes and byte length. Clients never inspect that token. Truncated
reads have no revision and remain read-only.

Every write states its intent:

```ts
type ProjectWriteFilePrecondition =
  | { _tag: "match"; diskRevision: ProjectFileDiskRevision }
  | { _tag: "must-not-exist" }
  | { _tag: "unconditional" };
```

Normal editor saves use `match`. Creation flows use `must-not-exist`.
`unconditional` is reserved for an explicitly confirmed blind overwrite. The
editor's current Overwrite action is safer: it re-reads the latest revision and
uses a new `match`, so a second concurrent change still becomes a conflict.
If the existing file is above the revisionable size limit, an explicit
Overwrite uses `unconditional`; this is the only recovery path available when
the server cannot produce a comparable revision.

The server checks the precondition inside a per-canonical-target critical
section. A conflict is a typed result and never contains either version's file
contents.

### Safe replacement

The server canonicalizes the workspace and target, or the nearest existing
ancestor for a new target. Escaping target and parent symlinks are rejected.
The server writes an exclusive temporary file in the canonical target
directory, flushes it, preserves permission and special mode bits for an existing
target, publishes replacements by rename and creations by exclusive hard link,
and removes temporary artifacts on failure.

This protects ordinary application behavior and narrows time-of-check/time-of-
use races. Node does not expose a complete portable `openat`-style API, so this
is not claimed as a security boundary against a hostile local process that
continuously swaps directory entries.

For replacements, Zrode hashes the current file again after the temporary file
is durable and then performs the atomic rename. Portable Node APIs still leave
a final check-to-rename interval: a hostile local process can replace or modify
the entry during that interval. The per-target lock coordinates Zrode writers,
not arbitrary local processes, so replacement is conflict-safe for normal
application concurrency but is not an OS-level compare-and-swap primitive.
Creation uses an exclusive hard-link publication step, which does not overwrite
a file created after the final check; that race returns a typed conflict.

### Document lifetime

A document is keyed by environment, actual workspace/worktree root, and
relative path. It owns:

- current text;
- baseline disk revision;
- monotonically increasing edit version;
- captured in-flight text, edit version, and precondition;
- latest remote snapshot for conflict comparison;
- persistence state and retry metadata;
- mounted-view count and subscribers.

Its minimum states are loading, clean, dirty, saving, retrying, conflict, error,
and orphaned.

A save clears dirty state only when the captured edit version is still current.
If the user typed during I/O, the returned disk revision becomes the baseline
for the queued newer save. Typed conflicts and permanent filesystem errors are
not retried. Only transient transport failures use bounded backoff.

A lost transport response is an ambiguous write, not an ordinary failure. The
store retains that one captured candidate and reads disk before sending later
text. If disk contains the candidate, the read acknowledges it and advances the
baseline; if disk still contains the old revision, retry is safe; any third
version becomes a conflict. Polling uses the same acknowledgement path.

Destructive reload/discard and overwrite-rebase operations are ordered with a
control epoch. A delayed read or overwrite cannot resume after a newer user
decision, and edits made while a destructive read is pending are never adopted
over. Presenting a close decision synchronously suspends debounce/retry timers.

Unmounting a view cannot discard an unsafe document. Clean unused documents may
be evicted after a bounded TTL.

### External changes

The first change-stream tranche now exposes `projects.watchFiles`. The server
canonicalizes the workspace before watching, shares one reference-counted
watcher per real root, waits for watcher readiness, batches bounded path hints,
and emits an explicit `resync` marker on overflow, root deletion, or watcher
error. Every subscription and reconnect receives a `ready` marker that requires
an authoritative refresh. Watcher shutdown is awaited after the last subscriber.
The protocol is intentionally an invalidation stream rather than a journal:
paths may be coalesced and consumers always re-read authoritative state. The
explorer subscribes while mounted and refreshes its indexed snapshot after
`ready`, `resync`, or a structural invalidation. Content-only changes do not
relist the entire explorer; active document polling remains the correctness
path until document refreshes consume these hints directly.

Active documents retain bounded polling as a reliability backstop:

- only documents with mounted views are polled;
- polling pauses while the page is hidden;
- polling pauses while the owning environment is disconnected;
- at most one read is in flight for a document;
- unchanged revision probes return metadata only; complete contents are fetched
  only after the opaque disk revision changes, with a full-read fallback for
  older peers and unrevisionable oversized files;
- focus and visibility restoration trigger an immediate check;
- the explorer's 25,000-entry snapshot is event-invalidated, not polled.

Before the server emits a ready, resync, or structural invalidation, it awaits
the workspace index refresh (or invalidates a failed index). The client's first
subsequent list therefore cannot race the index's independent native watcher.

A changed clean document adopts disk text. A changed dirty/saving document
keeps local text and enters conflict. Missing files become orphaned or
conflicted according to whether local text is unsafe.

Polling must remain until the stream grows a revisioned reconnect snapshot and
rename correlation. A watcher event can never be allowed to overwrite dirty
text directly.

### Views and close behavior

Tabs and editor widgets are views. Changing themes must not recreate document
persistence state. Closing or detaching the final unsafe view must save,
explicitly discard, or cancel. Browser unload receives a dirty-document guard;
it never attempts an unreliable last-moment WebSocket write.

Conflict UI keeps local text visible and offers compare, explicit overwrite,
and reload/discard. Save/retry/error state is durable and visible rather than a
one-shot toast.

### Explorer behavior

The existing virtual tree remains. Active-file reveal expands only ancestors,
selects without re-opening the file, and scrolls with nearest alignment.
Workspace refreshes preserve expansion where the tree API permits. The
explorer/editor split has a persisted, clamped internal width and accessible
resize affordance.

Basic inline file and directory creation is now available. File creation uses
the revisioned `must-not-exist` write path; directory creation validates and
pins the existing parent before one non-recursive mutation. These operations
refresh the coarse index and keep an optimistic row only while that refresh
converges. Permanent deletion is a two-phase typed operation. Before showing
confirmation, the server returns an opaque revision covering root, path, kind,
device, inode, ctime, and every recursive descendant. Commit must present that
exact revision; files are always non-recursive and directories always
recursive. The server revalidates the tree under an exclusive root mutation
permit, atomically moves the entry to a private tombstone, verifies the detached
tree, then removes it. Writes and creates use shared permits, so independent
targets remain concurrent. A failed removal restores the original name when
safe. If it is occupied or restoration fails, the entry is exposed beside it
under a collision-safe `*.zrode-recovered-*` name and a structured partial
failure is returned. Only failure of both recovery moves can leave a hidden
tombstone. The explorer blocks
deletion while an affected document has unsaved state, presents an irreversible
confirmation, and closes affected clean file tabs only after server success.
Final symlinks are rejected rather than followed. Rename remains deferred
because it additionally needs stable source identity and document re-keying.

## Deferred roadmap

The dependency order matters. Building these as independent UI actions would
reintroduce path races and split document ownership.

### 1. Revisioned worktree snapshots and stable identity

Build a server-side, reference-counted worktree store on top of the new
invalidation stream. Each snapshot needs a monotonic revision, path-to-entry
and ID-to-entry indexes, a scan-complete barrier, and a bounded delta log.
Local entry IDs should use device/inode evidence plus a session generation;
inode values alone are not sufficient because operating systems reuse them.
When evidence is unavailable (remote/provider filesystems), IDs must be
provider-issued or explicitly path-scoped. Reconnect with an expired revision
returns a full snapshot, never a guessed delta.

The explorer can then apply deltas to stable row objects, correlate a rename
without closing its document, and preserve expansion/selection without a full
path reset. This phase is the prerequisite for mutation UI.

### 2. Rename and recoverable delete

Add typed rename and recoverable-trash operations with operation IDs and
explicit preconditions. Rename requires source identity/revision and a
destination policy. The worktree store correlates its own operation ID with
watcher echoes, and rename re-keys the canonical document only after server
success. Permanent delete already has identity revalidation and confirmation;
recoverable trash still needs host capability detection and restoration UX.
Drag/drop, clipboard, and undo can build on those same operations.

### 3. Hot exit and cross-window unsaved state

Persist document backups outside the workspace with environment/worktree/file
identity, base disk revision, edit sequence, content, and timestamp. Backup
writes need the same atomic/durable discipline as file saves and bounded
retention. Restore only after comparing the recorded base with current disk;
a mismatch opens a recovery conflict instead of silently applying text.

For windows on the same origin, use `BroadcastChannel` as notification only and
an IndexedDB transaction as the authoritative lease/sequence store. Every
message carries a window ID and document sequence; gaps force a backup reload.
Only the elected owner performs autosave, while all views share text and dirty
state. Server-side backups remain necessary because a browser channel does not
survive a crash and does not synchronize another device.

### 4. Metadata capability layer

Ordinary and special permission bits are preserved now. Ownership, ACLs,
extended attributes, timestamps, and hard-link identity require a platform
capability interface and per-platform integration tests. Metadata must be
captured from the already-open source handle and restored on the temporary file
before publication. Unsupported attributes must produce an explicit capability
result rather than being silently dropped. Hard-link identity fundamentally
conflicts with rename-based atomic replacement; detect `nlink > 1` and expose a
clear policy choice instead of claiming both guarantees.

Remaining deferred items include:

- revisioned worktree snapshots, stable IDs, and rename preservation;
- explorer rename, recoverable trash, drag/drop, clipboard, and undo;
- multi-root workspaces and provider/extension filesystem abstractions;
- cross-window live unsaved-document synchronization;
- persistence of Pierre's private undo stack across unmounted editor widgets;
- encoding selection, binary editing, Save As, and editing over the size limit;
- preservation of ownership, ACLs, extended attributes, and hard-link policy;
- hot-exit content backups and full crash recovery.

These are valuable follow-ups, but none should precede conflict-safe writes and
a document lifetime independent of React views.

## Required race tests

The highest-value tests are behavioral rather than visual:

- two writes with one expected disk revision produce one success and one
  conflict;
- stale, must-not-exist, and explicit-overwrite preconditions leave predictable
  bytes;
- an external modification after temporary-file preparation becomes a conflict;
- an external creation after temporary-file preparation is never overwritten;
- escaping target and parent symlinks never touch outside files;
- an executable target keeps its mode across atomic replacement;
- a user edit during save remains dirty and is saved afterward;
- external changes reload clean text but never replace dirty text;
- conflicts do not enter an automatic retry loop;
- releasing a view after success cannot duplicate a write;
- releasing after failure cannot abandon unsafe text;
- environment/worktree/path document keys do not collide;
- active reveal does not invoke the user-open callback;
- explorer refresh preserves expansion and width state.

The repository-wide completion gates remain `vp check` and
`vp run typecheck`, plus focused Vite+ tests for changed modules.
