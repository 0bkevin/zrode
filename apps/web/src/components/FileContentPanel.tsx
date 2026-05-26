import { type EnvironmentId } from "@zrode/contracts";
import Editor, { type OnMount } from "@monaco-editor/react";
import { Code2Icon, EyeIcon, RefreshCcwIcon, SaveIcon } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";

import { readEnvironmentApi } from "../environmentApi";
import {
  fileLanguageFromPath,
  isPdfMimeType,
  latexDocumentToMarkdown,
  textPreviewKindForPath,
  type TextPreviewKind,
} from "../fileContentPreview";
import { useTheme } from "../hooks/useTheme";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Spinner } from "./ui/spinner";
import { MONACO_DARK_THEME, MONACO_LIGHT_THEME } from "../monacoSetup";

interface FileContentPanelProps {
  className?: string;
  environmentId: EnvironmentId;
  workspaceRoot: string;
  relativePath: string;
  onDirtyChange: (relativePath: string, dirty: boolean) => void;
}

type FileContentState =
  | {
      readonly status: "loading";
      readonly draftContent: string;
      readonly originalContent: string;
      readonly saveError: string | null;
    }
  | {
      readonly status: "loaded";
      readonly draftContent: string;
      readonly originalContent: string;
      readonly isBinary: boolean;
      readonly isImage: boolean;
      readonly mimeType: string | undefined;
      readonly truncated: boolean;
      readonly saveError: string | null;
      readonly saving: boolean;
    }
  | {
      readonly status: "error";
      readonly message: string;
      readonly draftContent: string;
      readonly originalContent: string;
      readonly saveError: string | null;
    };

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function base64ToBlobUrl(content: string, mimeType: string): string | null {
  try {
    const binary = window.atob(content.replace(/\s/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
  } catch {
    return null;
  }
}

function useBase64BlobUrl(content: string, mimeType: string | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!mimeType) {
      setUrl(null);
      return;
    }
    const nextUrl = base64ToBlobUrl(content, mimeType);
    setUrl(nextUrl);
    return () => {
      if (nextUrl) {
        URL.revokeObjectURL(nextUrl);
      }
    };
  }, [content, mimeType]);

  return url;
}

function FilePdfPreview({
  content,
  mimeType,
  relativePath,
}: {
  content: string;
  mimeType: string | undefined;
  relativePath: string;
}) {
  const objectUrl = useBase64BlobUrl(content, mimeType);

  if (!objectUrl) {
    return (
      <div className="flex h-full min-h-32 items-center justify-center p-4 text-sm text-destructive">
        Failed to load PDF preview.
      </div>
    );
  }

  return (
    <object data={objectUrl} type={mimeType} aria-label={relativePath} className="h-full w-full">
      <div className="flex h-full min-h-32 items-center justify-center p-4 text-sm text-muted-foreground">
        PDF preview is unavailable in this browser.
      </div>
    </object>
  );
}

function FileMarkdownPreview({
  content,
  kind,
}: {
  content: string;
  kind: Exclude<TextPreviewKind, null>;
}) {
  const previewContent = useMemo(
    () => (kind === "latex" ? latexDocumentToMarkdown(content) : content),
    [content, kind],
  );

  return (
    <div className="h-full overflow-auto px-8 py-6">
      <div className="chat-markdown mx-auto w-full max-w-4xl min-w-0 text-sm leading-relaxed text-foreground/85">
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath]}
          rehypePlugins={[rehypeKatex]}
          components={{
            a({ node: _node, href, ...props }) {
              const isHashLink = href?.startsWith("#") === true;
              return (
                <a
                  {...props}
                  href={href}
                  target={isHashLink ? undefined : "_blank"}
                  rel={isHashLink ? undefined : "noopener noreferrer"}
                />
              );
            },
            img({ node: _node, src, alt, ...props }) {
              return (
                <img
                  {...props}
                  src={src}
                  alt={alt ?? ""}
                  className="max-w-full rounded border border-border"
                />
              );
            },
          }}
        >
          {previewContent}
        </ReactMarkdown>
      </div>
    </div>
  );
}

export const FileContentPanel = memo(function FileContentPanel({
  className,
  environmentId,
  workspaceRoot,
  relativePath,
  onDirtyChange,
}: FileContentPanelProps) {
  const { resolvedTheme } = useTheme();
  const [state, setState] = useState<FileContentState>({
    status: "loading",
    draftContent: "",
    originalContent: "",
    saveError: null,
  });
  const dirtyRef = useRef(false);
  const draftContentRef = useRef("");
  const originalContentRef = useRef("");
  const saveFileRef = useRef<() => void>(() => undefined);
  const [textViewMode, setTextViewMode] = useState<"preview" | "source">("source");

  const dirty = state.draftContent !== state.originalContent;
  const canSaveText =
    state.status === "loaded" && !state.isBinary && !state.isImage && !state.truncated;
  const busy = state.status === "loading" || (state.status === "loaded" && state.saving);
  const editorLanguage = useMemo(() => fileLanguageFromPath(relativePath), [relativePath]);
  const editorTheme = resolvedTheme === "dark" ? MONACO_DARK_THEME : MONACO_LIGHT_THEME;
  const textPreviewKind = useMemo(() => textPreviewKindForPath(relativePath), [relativePath]);
  const canPreviewText =
    state.status === "loaded" && !state.isBinary && !state.isImage && textPreviewKind !== null;
  const showPdfPreview =
    state.status === "loaded" && state.isBinary && isPdfMimeType(state.mimeType);

  useEffect(() => {
    dirtyRef.current = dirty;
    draftContentRef.current = state.draftContent;
    originalContentRef.current = state.originalContent;
  }, [dirty, state.draftContent, state.originalContent]);

  useEffect(() => {
    onDirtyChange(relativePath, dirty);
  }, [dirty, onDirtyChange, relativePath]);

  const loadFile = useCallback(
    async (options?: { force?: boolean }) => {
      if (dirtyRef.current && options?.force !== true) {
        const discard = window.confirm(`Discard unsaved changes to ${relativePath}?`);
        if (!discard) {
          return;
        }
      }
      const api = readEnvironmentApi(environmentId);
      if (!api) {
        setState({
          status: "error",
          message: "Environment API is unavailable.",
          draftContent: draftContentRef.current,
          originalContent: originalContentRef.current,
          saveError: null,
        });
        return;
      }
      setState((current) => ({
        status: "loading",
        draftContent: current.draftContent,
        originalContent: current.originalContent,
        saveError: null,
      }));
      try {
        const result = await api.projects.readFile({ cwd: workspaceRoot, relativePath });
        setState({
          status: "loaded",
          draftContent: result.content,
          originalContent: result.content,
          isBinary: result.isBinary,
          isImage: result.isImage === true,
          mimeType: result.mimeType,
          truncated: result.truncated,
          saveError: null,
          saving: false,
        });
      } catch (error) {
        setState((current) => ({
          status: "error",
          message: toErrorMessage(error),
          draftContent: current.draftContent,
          originalContent: current.originalContent,
          saveError: null,
        }));
      }
    },
    [environmentId, relativePath, workspaceRoot],
  );

  useEffect(() => {
    setState({
      status: "loading",
      draftContent: "",
      originalContent: "",
      saveError: null,
    });
    setTextViewMode(textPreviewKind ? "preview" : "source");
    void loadFile({ force: true });
    return () => {
      onDirtyChange(relativePath, false);
    };
  }, [loadFile, onDirtyChange, relativePath, textPreviewKind]);

  const saveFile = useCallback(async () => {
    if (!canSaveText || !dirty) {
      return;
    }
    const api = readEnvironmentApi(environmentId);
    if (!api) {
      setState((current) =>
        current.status === "loaded"
          ? { ...current, saveError: "Environment API is unavailable.", saving: false }
          : current,
      );
      return;
    }
    const contents = draftContentRef.current;
    setState((current) =>
      current.status === "loaded" ? { ...current, saveError: null, saving: true } : current,
    );
    try {
      await api.projects.writeFile({ cwd: workspaceRoot, relativePath, contents });
      setState((current) =>
        current.status === "loaded"
          ? { ...current, originalContent: contents, saveError: null, saving: false }
          : current,
      );
    } catch (error) {
      setState((current) =>
        current.status === "loaded"
          ? { ...current, saveError: toErrorMessage(error), saving: false }
          : current,
      );
    }
  }, [canSaveText, dirty, environmentId, relativePath, workspaceRoot]);

  useEffect(() => {
    saveFileRef.current = () => void saveFile();
  }, [saveFile]);

  const handleEditorMount = useCallback<OnMount>((editorInstance, monacoApi) => {
    editorInstance.addCommand(monacoApi.KeyMod.CtrlCmd | monacoApi.KeyCode.KeyS, () => {
      saveFileRef.current();
    });
  }, []);

  const statusLabel = useMemo(() => {
    if (state.status === "loaded" && state.saving) return "Saving";
    if (dirty) return "Unsaved";
    return "Saved";
  }, [dirty, state]);

  return (
    <section
      className={cn("h-full min-h-0 flex-col bg-background text-foreground", className)}
      data-file-editor-path={relativePath}
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/40 px-4">
        <div className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground/70">
          {relativePath}
        </div>
        <span
          className={cn(
            "shrink-0 text-xs font-medium",
            dirty ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground",
          )}
        >
          {statusLabel}
        </span>
        {canPreviewText ? (
          <Button
            size="icon-xs"
            variant="ghost"
            className="text-muted-foreground/60 hover:text-foreground"
            aria-label={textViewMode === "preview" ? "Show source" : "Show preview"}
            onClick={() =>
              setTextViewMode((current) => (current === "preview" ? "source" : "preview"))
            }
          >
            {textViewMode === "preview" ? (
              <Code2Icon className="size-3.5" />
            ) : (
              <EyeIcon className="size-3.5" />
            )}
          </Button>
        ) : null}
        <Button
          size="icon-xs"
          variant="ghost"
          className="text-muted-foreground/60 hover:text-foreground"
          aria-label="Save file"
          disabled={!canSaveText || !dirty || busy}
          onClick={() => void saveFile()}
        >
          <SaveIcon
            className={cn("size-3.5", state.status === "loaded" && state.saving && "opacity-60")}
          />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          className="text-muted-foreground/60 hover:text-foreground"
          aria-label="Refresh file"
          disabled={busy}
          onClick={() => void loadFile()}
        >
          <RefreshCcwIcon
            className={cn("size-3.5", state.status === "loading" && "animate-spin")}
          />
        </Button>
      </header>

      {state.saveError ? (
        <div className="border-b border-border px-4 py-2 text-xs text-destructive">
          {state.saveError}
        </div>
      ) : null}
      {state.status === "loaded" && state.truncated ? (
        <div className="border-b border-border px-4 py-2 text-xs text-amber-700 dark:text-amber-300">
          This file is too large for safe in-app editing, so it is opened read-only.
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-hidden">
        {state.status === "loading" && state.draftContent.length === 0 ? (
          <div className="flex h-full min-h-32 items-center justify-center text-muted-foreground">
            <Spinner className="size-4" />
          </div>
        ) : state.status === "error" ? (
          <div className="p-4 text-sm text-destructive">{state.message}</div>
        ) : state.status === "loaded" && state.isImage && state.mimeType ? (
          <div className="flex min-h-full items-start justify-center overflow-auto p-4">
            <img
              src={`data:${state.mimeType};base64,${state.draftContent}`}
              alt={relativePath}
              className="max-h-full max-w-full rounded border border-border object-contain"
            />
          </div>
        ) : showPdfPreview ? (
          <FilePdfPreview
            content={state.draftContent}
            mimeType={state.mimeType}
            relativePath={relativePath}
          />
        ) : state.status === "loaded" && state.isBinary ? (
          <div className="p-4 text-sm text-muted-foreground">Binary file</div>
        ) : canPreviewText && textViewMode === "preview" && textPreviewKind ? (
          <FileMarkdownPreview content={state.draftContent} kind={textPreviewKind} />
        ) : (
          <Editor
            path={`${workspaceRoot}/${relativePath}`}
            language={editorLanguage}
            theme={editorTheme}
            value={state.draftContent}
            loading={
              <div className="flex h-full min-h-32 items-center justify-center text-muted-foreground">
                <Spinner className="size-4" />
              </div>
            }
            options={{
              automaticLayout: true,
              contextmenu: true,
              fontFamily: "var(--font-mono), ui-monospace, SFMono-Regular, Menlo, monospace",
              fontLigatures: true,
              fontSize: 12,
              lineHeight: 20,
              minimap: { enabled: false },
              padding: { top: 16, bottom: 16 },
              readOnly: !canSaveText,
              renderLineHighlight: "line",
              "semanticHighlighting.enabled": true,
              scrollBeyondLastLine: false,
              smoothScrolling: true,
              tabSize: 2,
              wordWrap: "off",
            }}
            onMount={handleEditorMount}
            onChange={(value) => {
              const nextValue = value ?? "";
              setState((current) =>
                current.status === "loaded" ? { ...current, draftContent: nextValue } : current,
              );
            }}
          />
        )}
      </div>
    </section>
  );
});
