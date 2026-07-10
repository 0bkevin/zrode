import type {
  EditorId,
  EnvironmentId,
  ResolvedKeybindingsConfig,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { parseDiffFromFile, VirtualizedFile, type SelectedLineRange } from "@pierre/diffs";
import { Editor } from "@pierre/diffs/editor";
import { EditorProvider, File, FileDiff, type FileOptions, Virtualizer } from "@pierre/diffs/react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  ChevronRight,
  Code2,
  Eye,
  FolderTree,
  Globe2,
  LoaderCircle,
  TriangleAlert,
} from "lucide-react";
import * as Schema from "effect/Schema";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { isBrowserPreviewFile, openFileInPreview } from "~/browser/openFileInPreview";
import ChatMarkdown from "~/components/ChatMarkdown";
import { OpenInPicker } from "~/components/chat/OpenInPicker";
import { useClientSettings } from "~/hooks/useSettings";
import { useTheme } from "~/hooks/useTheme";
import { useResizableWidth } from "~/hooks/useResizableWidth";
import { getLocalStorageItem, setLocalStorageItem } from "~/hooks/useLocalStorage";
import { resolveDiffThemeName } from "~/lib/diffRendering";
import { cn } from "~/lib/utils";
import { isPopoutWindow } from "~/lib/windowScope";
import { isPreviewSupportedInRuntime } from "~/previewStateStore";
import { resolvePathLinkTarget } from "~/terminal-links";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Button } from "~/components/ui/button";
import { Toggle } from "~/components/ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { buildFileReviewComment } from "~/reviewCommentContext";
import { assetEnvironment } from "~/state/assets";
import {
  useEnvironment,
  useEnvironmentHttpBaseUrl,
  usePrimaryEnvironmentId,
} from "~/state/environments";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

import FileBrowserPanel from "./FileBrowserPanel";
import {
  FILE_EXPLORER_DEFAULT_WIDTH,
  FILE_EXPLORER_MAX_WIDTH,
  FILE_EXPLORER_MIN_WIDTH,
  resolveFileExplorerMaxWidth,
} from "./fileExplorerLayout";
import {
  areFileCommentAnnotationsEqual,
  type FileCommentAnnotationEntry,
  type FileCommentAnnotationGroup,
  type FileCommentLineAnnotation,
  formatFileCommentRange,
  nextFileCommentId,
  normalizeFileCommentRange,
  remapFileCommentAnnotations,
} from "./fileCommentAnnotations";
import { installFileEditorDismissal } from "./fileEditorDismissal";
import { LocalCommentAnnotation } from "./LocalCommentAnnotation";
import { projectFileCacheKey } from "./fileContentRevision";
import { fileBreadcrumbs } from "./filePath";
import { isMarkdownPreviewFile, setMarkdownTaskChecked } from "./filePreviewMode";
import { fileDocumentErrorMessage, useFileDocument } from "./fileDocumentRuntime";
import type { FileDocumentHandle, FileDocumentSnapshot } from "./fileDocumentStore";

interface FilePreviewPanelProps {
  environmentId: EnvironmentId;
  cwd: string;
  projectName: string;
  relativePath: string | null;
  threadRef: ScopedThreadRef;
  composerDraftTarget: ScopedThreadRef | DraftId;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  revealLine: number | null;
  revealRequestId: number;
  onOpenFile: (relativePath: string) => void;
}

const FILE_EXPLORER_STORAGE_KEY = "zrode.fileExplorerOpen";
const FILE_EXPLORER_WIDTH_STORAGE_KEY = "zrode:file-explorer-width";
// Whether review-comment annotations reach the chat composer from this
// window; constant for the window's lifetime.
const reviewCommentsAvailable = !isPopoutWindow();
const FILE_LINK_REVEAL_ATTRIBUTE = "data-file-link-reveal";
const FILE_LINK_REVEAL_UNSAFE_CSS = `
  [${FILE_LINK_REVEAL_ATTRIBUTE}][data-line] {
    background-color: light-dark(
      color-mix(
        in lab,
        var(--diffs-computed-diff-line-bg) 82%,
        var(--diffs-bg-selection-override, var(--diffs-selection-base))
      ),
      color-mix(
        in lab,
        var(--diffs-computed-diff-line-bg) 75%,
        var(--diffs-bg-selection-override, var(--diffs-selection-base))
      )
    ) !important;
  }

  [${FILE_LINK_REVEAL_ATTRIBUTE}][data-column-number] {
    background-color: light-dark(
      color-mix(
        in lab,
        var(--diffs-computed-diff-line-bg) 75%,
        var(--diffs-bg-selection-number-override, var(--diffs-selection-base))
      ),
      color-mix(
        in lab,
        var(--diffs-computed-diff-line-bg) 60%,
        var(--diffs-bg-selection-number-override, var(--diffs-selection-base))
      )
    ) !important;
    color: var(--diffs-selection-number-fg) !important;
  }
`;
// Soften the library's gutter "add comment" button: the default is a solid, full
// line-height blue block that dominates the gutter. Render it as a small, translucent
// ghost chip that only fills in on hover, so it stays out of the way while reading.
const EDITABLE_GUTTER_BUTTON_CSS = `
  [data-utility-button] {
    width: 15px;
    height: 15px;
    min-width: 0;
    border-radius: 5px;
    background-color: color-mix(in oklab, var(--diffs-modified-base) 14%, transparent);
    color: var(--diffs-modified-base);
    box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--diffs-modified-base) 24%, transparent);
    opacity: 0.72;
    transition:
      background-color 120ms ease,
      color 120ms ease,
      box-shadow 120ms ease,
      opacity 120ms ease;
  }

  [data-utility-button]:hover,
  [data-utility-button]:focus-visible {
    background-color: var(--diffs-modified-base);
    color: var(--diffs-bg);
    box-shadow: none;
    opacity: 1;
  }

  [data-utility-button] [data-icon] {
    width: 10px;
    height: 10px;
  }
`;
const EDITABLE_FILE_UNSAFE_CSS = `${FILE_LINK_REVEAL_UNSAFE_CSS}${EDITABLE_GUTTER_BUTTON_CSS}`;
type FilePostRender = NonNullable<FileOptions<unknown>["onPostRender"]>;

function clampFileLine(contents: string, requestedLine: number): number {
  let lineCount = 1;
  for (let index = 0; index < contents.length; index += 1) {
    const character = contents.charCodeAt(index);
    if (character === 10) {
      lineCount += 1;
    } else if (character === 13) {
      lineCount += 1;
      if (contents.charCodeAt(index + 1) === 10) index += 1;
    }
  }
  return Math.min(Math.max(1, requestedLine), lineCount);
}

function updateFileLinkReveal(fileContainer: HTMLElement, line: number | null): void {
  const root = fileContainer.shadowRoot ?? fileContainer;
  for (const element of root.querySelectorAll<HTMLElement>(`[${FILE_LINK_REVEAL_ATTRIBUTE}]`)) {
    element.removeAttribute(FILE_LINK_REVEAL_ATTRIBUTE);
  }
  if (line === null) return;

  root
    .querySelector<HTMLElement>(`[data-line="${line}"]`)
    ?.setAttribute(FILE_LINK_REVEAL_ATTRIBUTE, "");
  root
    .querySelector<HTMLElement>(`[data-column-number="${line}"]`)
    ?.setAttribute(FILE_LINK_REVEAL_ATTRIBUTE, "");
}

function useFileLineReveal(
  relativePath: string | null,
  revealLine: number | null,
  revealRequestId: number,
  contents: string,
): FilePostRender {
  const [handledRequestIdsByPath] = useState(() => new Map<string, number>());
  const [latestRequestIdsByPath] = useState(() => new Map<string, number>());
  const [pendingFramesByPath] = useState(() => new Map<string, number>());

  return useCallback<FilePostRender>(
    (fileContainer, instance, phase) => {
      if (relativePath === null) return;

      const cancelPendingReveal = () => {
        const frameId = pendingFramesByPath.get(relativePath);
        if (frameId !== undefined) {
          cancelAnimationFrame(frameId);
          pendingFramesByPath.delete(relativePath);
        }
      };

      if (phase === "unmount") {
        cancelPendingReveal();
        return;
      }

      // Clamp against the query contents rather than instance.file: the editable
      // surface keeps its file object frozen while typing, so instance.file goes stale.
      const targetLine = revealLine === null ? null : clampFileLine(contents, revealLine);
      updateFileLinkReveal(fileContainer, targetLine);

      if (!(instance instanceof VirtualizedFile)) return;

      if (latestRequestIdsByPath.get(relativePath) !== revealRequestId) {
        cancelPendingReveal();
        latestRequestIdsByPath.set(relativePath, revealRequestId);
      }

      if (targetLine === null) {
        fileContainer.style.minHeight = "";
        return;
      }

      const scrollContainer = fileContainer.closest<HTMLElement>(".file-preview-virtualizer");
      if (!scrollContainer) return;
      fileContainer.style.minHeight = `${Math.ceil(
        Math.max(instance.height, scrollContainer.clientHeight),
      )}px`;

      if (
        handledRequestIdsByPath.get(relativePath) === revealRequestId ||
        pendingFramesByPath.has(relativePath)
      ) {
        return;
      }

      const reveal = () => {
        pendingFramesByPath.delete(relativePath);
        if (
          latestRequestIdsByPath.get(relativePath) !== revealRequestId ||
          !fileContainer.isConnected
        ) {
          return;
        }

        const linePosition = instance.getLinePosition(targetLine);
        if (!linePosition) return;

        const fileTop =
          scrollContainer.scrollTop +
          fileContainer.getBoundingClientRect().top -
          scrollContainer.getBoundingClientRect().top;
        const centeredTop = Math.max(
          0,
          fileTop +
            linePosition.top -
            Math.max(0, (scrollContainer.clientHeight - linePosition.height) / 2),
        );
        const maxScrollTop = Math.max(
          0,
          scrollContainer.scrollHeight - scrollContainer.clientHeight,
        );

        scrollContainer.scrollTop = Math.min(centeredTop, maxScrollTop);
        handledRequestIdsByPath.set(relativePath, revealRequestId);
      };

      pendingFramesByPath.set(relativePath, requestAnimationFrame(reveal));
    },
    [
      contents,
      handledRequestIdsByPath,
      latestRequestIdsByPath,
      pendingFramesByPath,
      relativePath,
      revealLine,
      revealRequestId,
    ],
  );
}

interface EditableFileSurfaceProps {
  cwd: string;
  relativePath: string;
  composerDraftTarget: ScopedThreadRef | DraftId;
  contents: string;
  documentHandle: FileDocumentHandle;
  resolvedTheme: "light" | "dark";
  revealRequestId: number;
  wordWrap: boolean;
  onPostRender: FilePostRender;
}

interface FileSelectionOverride {
  revealRequestId: number;
  range: SelectedLineRange | null;
}

interface EditorFileRef {
  name: string;
  contents: string;
  cacheKey: string;
}

interface EditorFileState {
  file: EditorFileRef;
  editorContents: string;
}

function editorFileRef(cwd: string, relativePath: string, contents: string): EditorFileRef {
  return {
    name: relativePath,
    contents,
    cacheKey: projectFileCacheKey(cwd, relativePath, contents),
  };
}

function EditableFileSurface({
  cwd,
  relativePath,
  composerDraftTarget,
  contents,
  documentHandle,
  resolvedTheme,
  revealRequestId,
  wordWrap,
  onPostRender,
}: EditableFileSurfaceProps) {
  const addReviewComment = useComposerDraftStore((store) => store.addReviewComment);
  const removeReviewComment = useComposerDraftStore((store) => store.removeReviewComment);
  const [lineAnnotations, setLineAnnotations] = useState<FileCommentLineAnnotation[]>([]);
  const [selectionOverride, setSelectionOverride] = useState<FileSelectionOverride | null>(null);
  const selectedRange =
    selectionOverride?.revealRequestId === revealRequestId ? selectionOverride.range : null;
  const setSelectedRange = useCallback(
    (range: SelectedLineRange | null) => {
      setSelectionOverride({ revealRequestId, range });
    },
    [revealRequestId],
  );
  const surfaceRef = useRef<HTMLDivElement>(null);
  const selectionFrameRef = useRef<number | null>(null);
  // The Pierre editor owns the text document while the user types: handing its own
  // onChange contents back through a new `file` prop makes it rebuild the document,
  // which drops focus, caret position, and undo history on every keystroke. Keep the
  // mounted file stable and only swap it when contents arrive that the editor did
  // not produce (external writes, refetches — including reverts back to the mounted
  // baseline). Assumes cwd/environment changes remount this surface: FilePreviewPanel
  // is keyed by environment+cwd in ChatView, and this component by path. Theme
  // changes update Pierre's options without recreating document persistence state.
  const [fileState, setFileState] = useState<EditorFileState>(() => ({
    file: editorFileRef(cwd, relativePath, contents),
    editorContents: contents,
  }));
  if (fileState.file.name !== relativePath || contents !== fileState.editorContents) {
    setFileState({
      file: editorFileRef(cwd, relativePath, contents),
      editorContents: contents,
    });
  }
  const editor = useMemo(
    () =>
      new Editor<FileCommentAnnotationGroup>({
        onChange: (file, nextLineAnnotations) => {
          const nextContents = file.contents;
          setFileState((current) =>
            current.editorContents === nextContents
              ? current
              : { ...current, editorContents: nextContents },
          );
          documentHandle.edit(nextContents);
          if (nextLineAnnotations) {
            const remapped = remapFileCommentAnnotations(
              nextLineAnnotations as FileCommentLineAnnotation[],
            );
            // Preserve array identity when nothing moved: the File component
            // full-renders (dropping the caret) whenever the annotations prop
            // identity changes while annotations exist.
            setLineAnnotations((current) =>
              areFileCommentAnnotationsEqual(current, remapped) ? current : remapped,
            );
            for (const annotation of remapped) {
              for (const entry of annotation.metadata.entries) {
                if (entry.kind !== "comment") continue;
                addReviewComment(
                  composerDraftTarget,
                  buildFileReviewComment({
                    id: entry.id,
                    filePath: relativePath,
                    startLine: entry.startLine,
                    endLine: entry.endLine,
                    text: entry.text,
                    contents: nextContents,
                  }),
                );
              }
            }
          }
        },
      }),
    [addReviewComment, composerDraftTarget, documentHandle, relativePath],
  );

  useEffect(
    () => () => {
      editor.cleanUp();
    },
    [editor],
  );

  const removeAnnotationEntry = useCallback(
    (entryId: string) => {
      setSelectedRange(null);
      removeReviewComment(composerDraftTarget, entryId);
      setLineAnnotations((current) => {
        return current.flatMap((annotation) => {
          const entries = annotation.metadata.entries.filter((entry) => entry.id !== entryId);
          return entries.length > 0 ? [{ ...annotation, metadata: { entries } }] : [];
        });
      });
    },
    [composerDraftTarget, removeReviewComment, setSelectedRange],
  );

  const submitAnnotationEntry = useCallback(
    (entryId: string, text: string) => {
      setSelectedRange(null);
      const entry = lineAnnotations
        .flatMap((annotation) => annotation.metadata.entries)
        .find((candidate) => candidate.id === entryId);
      if (entry) {
        addReviewComment(
          composerDraftTarget,
          buildFileReviewComment({
            id: entry.id,
            filePath: relativePath,
            startLine: entry.startLine,
            endLine: entry.endLine,
            text,
            contents: fileState.editorContents,
          }),
        );
      }
      setLineAnnotations((current) =>
        current.map((annotation) => ({
          ...annotation,
          metadata: {
            entries: annotation.metadata.entries.map((annotationEntry) =>
              annotationEntry.id === entryId
                ? { ...annotationEntry, kind: "comment", text }
                : annotationEntry,
            ),
          },
        })),
      );
    },
    [
      addReviewComment,
      composerDraftTarget,
      fileState.editorContents,
      lineAnnotations,
      relativePath,
      setSelectedRange,
    ],
  );

  const beginComment = useCallback((range: SelectedLineRange) => {
    const { startLine, endLine } = normalizeFileCommentRange(range);
    const draftEntry: FileCommentAnnotationEntry = {
      id: nextFileCommentId(),
      kind: "draft",
      startLine,
      endLine,
      text: "",
    };
    setLineAnnotations((current) => {
      const withoutDraft = current.flatMap((annotation) => {
        const entries = annotation.metadata.entries.filter((entry) => entry.kind !== "draft");
        return entries.length > 0 ? [{ ...annotation, metadata: { entries } }] : [];
      });
      const existingIndex = withoutDraft.findIndex(
        (annotation) => annotation.lineNumber === endLine,
      );
      if (existingIndex < 0) {
        return [
          ...withoutDraft,
          {
            lineNumber: endLine,
            metadata: { entries: [draftEntry] },
          },
        ];
      }
      return withoutDraft.map((annotation, index) =>
        index === existingIndex
          ? {
              ...annotation,
              metadata: { entries: [...annotation.metadata.entries, draftEntry] },
            }
          : annotation,
      );
    });
  }, []);
  const hasOpenCommentForm = lineAnnotations.some((annotation) =>
    annotation.metadata.entries.some((entry) => entry.kind === "draft"),
  );
  useEffect(() => {
    const root = surfaceRef.current;
    if (!root) return;
    return installFileEditorDismissal({
      root,
      editor,
      isBlocked: () => hasOpenCommentForm,
      onDismiss: () => setSelectedRange(null),
    });
  }, [editor, hasOpenCommentForm, setSelectedRange]);
  const handleLineSelectionEnd = useCallback(
    (range: SelectedLineRange | null) => {
      setSelectedRange(range);
      if (range) {
        beginComment(range);
      }
    },
    [beginComment, setSelectedRange],
  );

  const handlePostRender = useCallback<FilePostRender>(
    (fileContainer, instance, phase) => {
      onPostRender(fileContainer, instance, phase);

      if (selectionFrameRef.current !== null) {
        cancelAnimationFrame(selectionFrameRef.current);
        selectionFrameRef.current = null;
      }
      if (phase === "unmount") return;

      selectionFrameRef.current = requestAnimationFrame(() => {
        selectionFrameRef.current = null;
        if (!fileContainer.isConnected) return;
        instance.setSelectedLines(selectedRange, { notify: false });
      });
    },
    [onPostRender, selectedRange],
  );

  return (
    <EditorProvider editor={editor}>
      <div ref={surfaceRef} className="flex min-h-0 flex-1">
        <Virtualizer
          className="file-preview-virtualizer min-h-0 flex-1 overflow-auto"
          config={{
            overscrollSize: 600,
            intersectionObserverMargin: 1200,
          }}
        >
          <File<FileCommentAnnotationGroup>
            file={fileState.file}
            options={{
              disableFileHeader: true,
              // Review comments land in the composer draft, which is
              // window-local in popouts — they would render as attached but
              // never reach the main window's composer. Disable the
              // affordance there instead of silently dropping input.
              enableGutterUtility: reviewCommentsAvailable && !hasOpenCommentForm,
              enableLineSelection: reviewCommentsAvailable && !hasOpenCommentForm,
              onGutterUtilityClick: setSelectedRange,
              onLineSelectionChange: setSelectedRange,
              onLineSelectionEnd: handleLineSelectionEnd,
              overflow: wordWrap ? "wrap" : "scroll",
              theme: resolveDiffThemeName(resolvedTheme),
              themeType: resolvedTheme,
              unsafeCSS: EDITABLE_FILE_UNSAFE_CSS,
              onPostRender: handlePostRender,
            }}
            selectedLines={selectedRange}
            lineAnnotations={lineAnnotations}
            renderAnnotation={(annotation) => (
              <div className="py-1">
                {annotation.metadata.entries.map((entry) => (
                  <LocalCommentAnnotation
                    key={entry.id}
                    kind={entry.kind}
                    rangeLabel={formatFileCommentRange(entry.startLine, entry.endLine)}
                    text={entry.text}
                    onCancel={() => removeAnnotationEntry(entry.id)}
                    onComment={(text) => submitAnnotationEntry(entry.id, text)}
                    onDelete={() => removeAnnotationEntry(entry.id)}
                  />
                ))}
              </div>
            )}
            className="min-h-full"
            contentEditable
          />
        </Virtualizer>
      </div>
    </EditorProvider>
  );
}

function RenderedMarkdownSurface({
  cwd,
  relativePath: _relativePath,
  contents,
  documentHandle,
  threadRef,
}: Omit<
  EditableFileSurfaceProps,
  "resolvedTheme" | "composerDraftTarget" | "revealRequestId" | "wordWrap" | "onPostRender"
> & {
  threadRef: ScopedThreadRef;
}) {
  return (
    <ScrollArea className="min-h-0 flex-1">
      <ChatMarkdown
        text={contents}
        cwd={cwd}
        threadRef={threadRef}
        className="mx-auto max-w-4xl px-6 py-5"
        onTaskListChange={({ markerOffset, checked }) => {
          const currentContents = documentHandle.getSnapshot().contents;
          const nextContents = setMarkdownTaskChecked(currentContents, markerOffset, checked);
          if (nextContents === currentContents) return;
          documentHandle.edit(nextContents);
        }}
      />
    </ScrollArea>
  );
}

function FileDocumentStatusBanner({
  relativePath,
  snapshot,
  handle,
  onCompare,
}: {
  relativePath: string;
  snapshot: FileDocumentSnapshot;
  handle: FileDocumentHandle;
  onCompare: () => void;
}) {
  const [activeAction, setActiveAction] = useState<"overwrite" | "reload" | "retry" | null>(null);

  const runAction = useCallback(
    (action: "overwrite" | "reload" | "retry", operation: () => Promise<unknown>) => {
      setActiveAction(action);
      void operation()
        .catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: `Unable to ${action === "overwrite" ? "save" : action} ${relativePath}`,
              description: fileDocumentErrorMessage(error),
            }),
          );
        })
        .finally(() => setActiveAction(null));
    },
    [relativePath],
  );

  if (snapshot.status === "retrying") {
    return (
      <div
        className="flex shrink-0 items-center gap-2 border-b border-amber-500/20 bg-amber-500/8 px-3 py-1.5 text-[11px] text-amber-800 dark:text-amber-200"
        role="status"
        aria-live="polite"
      >
        <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
        The connection was interrupted. Your changes are safe here and will retry automatically.
      </div>
    );
  }

  const isConflict = snapshot.status === "conflict";
  const isOrphaned = snapshot.status === "orphaned" && snapshot.isDirty;
  const isSaveError = snapshot.status === "error" && snapshot.isDirty;
  if (!isConflict && !isOrphaned && !isSaveError) return null;

  return (
    <div
      className={cn(
        "flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b px-3 py-2 text-xs",
        isSaveError
          ? "border-destructive/25 bg-destructive/8 text-destructive-foreground"
          : "border-amber-500/25 bg-amber-500/10 text-amber-900 dark:text-amber-100",
      )}
      role="alert"
    >
      <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
      <p className="min-w-48 flex-1 leading-relaxed">
        {isConflict
          ? "This file changed on disk. Your unsaved version has been preserved."
          : isOrphaned
            ? "This file was removed on disk. Your unsaved version has been preserved."
            : `Zrode could not save this file. ${fileDocumentErrorMessage(snapshot.error)}`}
      </p>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        {isConflict ? (
          <Button size="xs" variant="outline" onClick={onCompare}>
            Compare
          </Button>
        ) : null}
        {isConflict || isOrphaned ? (
          <Button
            size="xs"
            variant="outline"
            disabled={activeAction !== null}
            onClick={() => {
              const confirmed = window.confirm(
                isOrphaned
                  ? `Recreate ${relativePath} with your local changes?`
                  : `Save your local version of ${relativePath} over the latest disk version?`,
              );
              if (confirmed) runAction("overwrite", () => handle.overwrite());
            }}
          >
            {activeAction === "overwrite" ? "Saving…" : isOrphaned ? "Recreate" : "Overwrite"}
          </Button>
        ) : null}
        {isSaveError ? (
          <Button
            size="xs"
            variant="outline"
            disabled={activeAction !== null}
            onClick={() => runAction("retry", () => handle.retry())}
          >
            {activeAction === "retry" ? "Retrying…" : "Retry"}
          </Button>
        ) : null}
        <Button
          size="xs"
          variant="ghost"
          disabled={activeAction !== null}
          onClick={() => {
            const confirmed = window.confirm(
              isOrphaned
                ? `Discard your unsaved changes to the deleted file ${relativePath}?`
                : `Discard your unsaved changes to ${relativePath} and reload from disk?`,
            );
            if (confirmed) {
              runAction("reload", () => (isOrphaned ? handle.discard() : handle.reload()));
            }
          }}
        >
          {activeAction === "reload"
            ? "Reloading…"
            : isOrphaned
              ? "Discard local changes"
              : "Reload from disk"}
        </Button>
      </div>
    </div>
  );
}

function ConflictComparisonSurface({
  relativePath,
  snapshot,
  resolvedTheme,
  onClose,
}: {
  relativePath: string;
  snapshot: FileDocumentSnapshot;
  resolvedTheme: "light" | "dark";
  onClose: () => void;
}) {
  const remoteContents = snapshot.latestRemote?.contents ?? "";
  const fileDiff = useMemo(() => {
    if (remoteContents === snapshot.contents) return null;
    try {
      return parseDiffFromFile(
        { name: relativePath, contents: remoteContents },
        { name: relativePath, contents: snapshot.contents },
      );
    } catch {
      return null;
    }
  }, [relativePath, remoteContents, snapshot.contents]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-label={`Compare ${relativePath}`}>
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/60 px-3 py-2 text-xs">
        <div className="min-w-0">
          <div className="font-medium text-foreground">Disk version ↔ Your unsaved version</div>
          <div className="truncate text-[11px] text-muted-foreground">{relativePath}</div>
        </div>
        <Button size="xs" variant="outline" onClick={onClose}>
          Back to editor
        </Button>
      </div>
      <Virtualizer
        className="file-preview-virtualizer min-h-0 flex-1 overflow-auto"
        config={{ overscrollSize: 600, intersectionObserverMargin: 1200 }}
      >
        {fileDiff ? (
          <FileDiff
            fileDiff={fileDiff}
            options={{
              collapsed: false,
              disableFileHeader: true,
              diffStyle: "split",
              overflow: "scroll",
              theme: resolveDiffThemeName(resolvedTheme),
              themeType: resolvedTheme,
            }}
          />
        ) : (
          <div className="flex min-h-40 items-center justify-center px-6 text-center text-xs text-muted-foreground">
            The current disk version is unavailable or has no textual differences.
          </div>
        )}
      </Virtualizer>
    </div>
  );
}

function initialExplorerOpen(): boolean {
  try {
    return getLocalStorageItem(FILE_EXPLORER_STORAGE_KEY, Schema.Boolean) ?? true;
  } catch (error) {
    console.error(error);
    return true;
  }
}

function useFileExplorerSplitLayout() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [maxExplorerWidth, setMaxExplorerWidth] = useState(FILE_EXPLORER_MAX_WIDTH);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateMaxWidth = (containerWidth: number) => {
      const next = resolveFileExplorerMaxWidth(containerWidth);
      setMaxExplorerWidth((current) => (current === next ? current : next));
    };
    updateMaxWidth(container.getBoundingClientRect().width);

    if (typeof ResizeObserver === "undefined") {
      const handleWindowResize = () => updateMaxWidth(container.getBoundingClientRect().width);
      window.addEventListener("resize", handleWindowResize);
      return () => window.removeEventListener("resize", handleWindowResize);
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries.at(-1);
      if (entry) updateMaxWidth(entry.contentRect.width);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  return { containerRef, maxExplorerWidth };
}

export default function FilePreviewPanel({
  environmentId,
  cwd,
  projectName,
  relativePath,
  threadRef,
  composerDraftTarget,
  keybindings,
  availableEditors,
  revealLine,
  revealRequestId,
  onOpenFile,
}: FilePreviewPanelProps) {
  const { resolvedTheme } = useTheme();
  const wordWrap = useClientSettings((settings) => settings.wordWrap);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environment = useEnvironment(environmentId);
  const environmentHttpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
  });
  const openPreview = useAtomCommand(previewEnvironment.open, {
    reportFailure: false,
  });
  const { handle: fileDocument, snapshot: fileSnapshot } = useFileDocument(
    environmentId,
    cwd,
    relativePath,
    environment?.connection.phase === "connected",
  );
  const [explorerOpen, setExplorerOpen] = useState(initialExplorerOpen);
  const { containerRef: fileSplitContainerRef, maxExplorerWidth } = useFileExplorerSplitLayout();
  const {
    width: explorerWidth,
    handlers: explorerResizeHandlers,
    setWidth: setExplorerWidth,
    resetWidth: resetExplorerWidth,
  } = useResizableWidth({
    storageKey: FILE_EXPLORER_WIDTH_STORAGE_KEY,
    defaultWidth: FILE_EXPLORER_DEFAULT_WIDTH,
    minWidth: FILE_EXPLORER_MIN_WIDTH,
    maxWidth: maxExplorerWidth,
    edge: "left",
  });
  const [showConflictComparison, setShowConflictComparison] = useState(false);
  const [retryingFileRead, setRetryingFileRead] = useState(false);
  const [markdownView, setMarkdownView] = useState<{
    path: string | null;
    revealRequestId: number | null;
  }>({ path: null, revealRequestId: null });
  const breadcrumbRef = useRef<HTMLDivElement>(null);
  const isMarkdown = relativePath ? isMarkdownPreviewFile(relativePath) : false;
  const renderMarkdown =
    isMarkdown &&
    markdownView.path === relativePath &&
    (revealLine === null || markdownView.revealRequestId === revealRequestId);
  const canOpenInBrowser =
    relativePath !== null && isPreviewSupportedInRuntime() && isBrowserPreviewFile(relativePath);
  const absolutePath = relativePath ? resolvePathLinkTarget(relativePath, cwd) : null;
  const breadcrumbs = useMemo(
    () => (relativePath ? fileBreadcrumbs(projectName, relativePath) : []),
    [projectName, relativePath],
  );
  const onFilePostRender = useFileLineReveal(
    relativePath,
    revealLine,
    revealRequestId,
    fileSnapshot?.contents ?? "",
  );

  const fileData = useMemo(() => {
    if (
      relativePath === null ||
      fileSnapshot === null ||
      fileSnapshot.status === "loading" ||
      (!fileSnapshot.isDirty &&
        (fileSnapshot.status === "error" || fileSnapshot.status === "orphaned"))
    ) {
      return null;
    }
    return {
      relativePath,
      contents: fileSnapshot.contents,
      byteLength: fileSnapshot.latestRemote?.byteLength ?? fileSnapshot.contents.length,
      truncated: fileSnapshot.readOnly,
      diskRevision: fileSnapshot.baseDiskRevision,
    };
  }, [fileSnapshot, relativePath]);
  const fileError =
    fileSnapshot?.status === "orphaned"
      ? "This file no longer exists in the workspace."
      : fileSnapshot?.error
        ? fileDocumentErrorMessage(fileSnapshot.error)
        : null;

  useEffect(() => {
    if (fileSnapshot?.status !== "conflict" && fileSnapshot?.status !== "orphaned") {
      setShowConflictComparison(false);
    }
  }, [fileSnapshot?.status]);

  useEffect(() => {
    const currentCrumb = breadcrumbRef.current?.querySelector<HTMLElement>(
      "[data-current-file-crumb='true']",
    );
    currentCrumb?.scrollIntoView({ block: "nearest", inline: "end" });
  }, [relativePath]);

  const toggleExplorer = () => {
    setExplorerOpen((current) => {
      const next = !current;
      try {
        setLocalStorageItem(FILE_EXPLORER_STORAGE_KEY, next, Schema.Boolean);
      } catch (error) {
        console.error(error);
      }
      return next;
    });
  };

  const handleOpenInBrowser = useCallback(() => {
    if (!absolutePath || !environmentHttpBaseUrl) return;
    void (async () => {
      const result = await openFileInPreview({
        threadRef,
        filePath: absolutePath,
        httpBaseUrl: environmentHttpBaseUrl,
        createAssetUrl,
        openPreview,
      });
      if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
        return;
      }
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to open file in browser",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    })();
  }, [absolutePath, createAssetUrl, environmentHttpBaseUrl, openPreview, threadRef]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      {relativePath ? (
        <div className="surface-subheader gap-2 px-3" data-surface-subheader>
          <ScrollArea
            ref={breadcrumbRef}
            hideScrollbars
            scrollFade
            className="min-w-0 flex-1 rounded-none"
            data-file-breadcrumbs
          >
            <div className="flex h-full w-max min-w-full items-center text-xs">
              {breadcrumbs.map((crumb, index) => (
                <div
                  key={crumb.path || "project"}
                  className="flex min-w-0 shrink-0 items-center"
                  data-current-file-crumb={crumb.kind === "file"}
                >
                  {index > 0 ? (
                    <ChevronRight className="mx-1 size-3.5 shrink-0 text-muted-foreground/60" />
                  ) : null}
                  <span
                    className={cn(
                      "max-w-40 truncate",
                      crumb.kind === "file"
                        ? "font-medium text-foreground"
                        : "text-muted-foreground",
                    )}
                    title={crumb.path || projectName}
                  >
                    {crumb.label}
                  </span>
                </div>
              ))}
            </div>
          </ScrollArea>
          {absolutePath && environmentId === primaryEnvironmentId ? (
            <OpenInPicker
              environmentId={environmentId}
              keybindings={keybindings}
              availableEditors={availableEditors}
              openInCwd={absolutePath}
              compact
              enableShortcut={false}
            />
          ) : null}
          {isMarkdown ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Toggle
                    className="shrink-0"
                    pressed={renderMarkdown}
                    onPressedChange={(pressed) => {
                      setMarkdownView({
                        path: pressed ? relativePath : null,
                        revealRequestId: pressed ? revealRequestId : null,
                      });
                    }}
                    aria-label={renderMarkdown ? "Show markdown source" : "Show rendered markdown"}
                    variant="ghost"
                    size="sm"
                  >
                    {renderMarkdown ? <Code2 className="size-3.5" /> : <Eye className="size-3.5" />}
                  </Toggle>
                }
              />
              <TooltipPopup>
                {renderMarkdown ? "Show markdown source" : "Show rendered markdown"}
              </TooltipPopup>
            </Tooltip>
          ) : null}
          {canOpenInBrowser ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Toggle
                    className="shrink-0"
                    pressed={false}
                    onPressedChange={handleOpenInBrowser}
                    aria-label="Open file in preview browser"
                    variant="ghost"
                    size="sm"
                  >
                    <Globe2 className="size-3.5" />
                  </Toggle>
                }
              />
              <TooltipPopup>Open file in preview browser</TooltipPopup>
            </Tooltip>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  className="shrink-0"
                  pressed={explorerOpen}
                  onPressedChange={toggleExplorer}
                  aria-label={explorerOpen ? "Hide file explorer" : "Show file explorer"}
                  variant="ghost"
                  size="sm"
                >
                  <FolderTree className="size-3.5" />
                </Toggle>
              }
            />
            <TooltipPopup>
              {explorerOpen ? "Hide file explorer" : "Show file explorer"}
            </TooltipPopup>
          </Tooltip>
        </div>
      ) : null}
      {relativePath && fileData?.truncated ? (
        <div className="shrink-0 border-b border-amber-500/20 bg-amber-500/8 px-3 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
          Preview limited to the first 1 MB of a {fileData.byteLength.toLocaleString()} byte file.
        </div>
      ) : null}
      {relativePath && fileSnapshot && fileDocument ? (
        <FileDocumentStatusBanner
          relativePath={relativePath}
          snapshot={fileSnapshot}
          handle={fileDocument}
          onCompare={() => {
            void fileDocument.refresh().then(() => setShowConflictComparison(true));
          }}
        />
      ) : null}
      <div ref={fileSplitContainerRef} className="flex min-h-0 flex-1 overflow-hidden">
        <div
          className={cn(
            "min-w-0 flex-1 flex-col overflow-hidden",
            relativePath ? "flex" : "hidden",
          )}
        >
          {relativePath && fileError && fileData === null ? (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-xs leading-relaxed text-destructive">
              <p>{fileError}</p>
              {fileDocument ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={retryingFileRead}
                  onClick={() => {
                    setRetryingFileRead(true);
                    void fileDocument.refresh().finally(() => setRetryingFileRead(false));
                  }}
                >
                  {retryingFileRead ? "Retrying…" : "Retry"}
                </Button>
              ) : null}
            </div>
          ) : relativePath && fileData === null ? (
            <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
              <LoaderCircle className="size-5 animate-spin" />
            </div>
          ) : relativePath && fileData && fileSnapshot && fileDocument ? (
            showConflictComparison ? (
              <ConflictComparisonSurface
                relativePath={relativePath}
                snapshot={fileSnapshot}
                resolvedTheme={resolvedTheme}
                onClose={() => setShowConflictComparison(false)}
              />
            ) : isMarkdown && renderMarkdown ? (
              <RenderedMarkdownSurface
                cwd={cwd}
                relativePath={relativePath}
                threadRef={threadRef}
                contents={fileData.contents}
                documentHandle={fileDocument}
              />
            ) : fileData.truncated ? (
              <Virtualizer
                key={`${relativePath}:${resolvedTheme}:${fileData.byteLength}`}
                className="file-preview-virtualizer min-h-0 flex-1 overflow-auto"
                config={{
                  overscrollSize: 600,
                  intersectionObserverMargin: 1200,
                }}
              >
                <File
                  file={{
                    name: relativePath,
                    contents: fileData.contents,
                    cacheKey: projectFileCacheKey(cwd, relativePath, fileData.contents),
                  }}
                  options={{
                    disableFileHeader: true,
                    overflow: wordWrap ? "wrap" : "scroll",
                    theme: resolveDiffThemeName(resolvedTheme),
                    themeType: resolvedTheme,
                    unsafeCSS: FILE_LINK_REVEAL_UNSAFE_CSS,
                    onPostRender: onFilePostRender,
                  }}
                  className="min-h-full"
                />
              </Virtualizer>
            ) : (
              <EditableFileSurface
                key={relativePath}
                cwd={cwd}
                relativePath={relativePath}
                composerDraftTarget={composerDraftTarget}
                contents={fileData.contents}
                documentHandle={fileDocument}
                resolvedTheme={resolvedTheme}
                revealRequestId={revealRequestId}
                wordWrap={wordWrap}
                onPostRender={onFilePostRender}
              />
            )
          ) : null}
        </div>
        {explorerOpen || relativePath === null ? (
          <aside
            className={cn(
              "relative flex min-h-0 shrink-0 bg-background",
              relativePath ? "min-w-60 border-l border-border/60" : "min-w-0 flex-1",
            )}
            style={relativePath ? { width: `${explorerWidth}px` } : undefined}
          >
            {relativePath ? (
              <div
                role="separator"
                aria-label="Resize file explorer"
                aria-orientation="vertical"
                aria-valuemin={FILE_EXPLORER_MIN_WIDTH}
                aria-valuemax={maxExplorerWidth}
                aria-valuenow={explorerWidth}
                tabIndex={0}
                className="group absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize select-none focus-visible:outline-2 focus-visible:outline-primary"
                onDoubleClick={resetExplorerWidth}
                onKeyDown={(event) => {
                  if (event.key === "ArrowLeft") {
                    event.preventDefault();
                    setExplorerWidth(explorerWidth + 16);
                  } else if (event.key === "ArrowRight") {
                    event.preventDefault();
                    setExplorerWidth(explorerWidth - 16);
                  } else if (event.key === "Home") {
                    event.preventDefault();
                    setExplorerWidth(FILE_EXPLORER_MIN_WIDTH);
                  } else if (event.key === "End") {
                    event.preventDefault();
                    setExplorerWidth(maxExplorerWidth);
                  }
                }}
                {...explorerResizeHandlers}
              >
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover:bg-border group-focus-visible:bg-primary/70 group-active:bg-primary/70"
                />
              </div>
            ) : null}
            <FileBrowserPanel
              key={`${environmentId}:${cwd}`}
              environmentId={environmentId}
              cwd={cwd}
              projectName={projectName}
              activeRelativePath={relativePath}
              onOpenFile={onOpenFile}
            />
          </aside>
        ) : null}
      </div>
    </div>
  );
}
