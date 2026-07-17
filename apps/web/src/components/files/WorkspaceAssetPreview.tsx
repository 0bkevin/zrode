import { useAtomValue } from "@effect/atom-react";
import type { AssetResource, EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { LoaderCircle, Minus, Plus, RefreshCw, Scan } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useAssetUrlState } from "~/assets/assetUrls";
import { Button } from "~/components/ui/button";
import { projectEnvironment } from "~/state/projects";

import type { WorkspaceAssetPreviewKind } from "./filePreviewMode";

function withPreviewRevision(url: string, revision: number): string {
  if (revision === 0) return url;
  const parsed = new URL(url);
  parsed.searchParams.set("preview-revision", String(revision));
  return parsed.toString();
}

function PreviewMessage(props: {
  readonly title: string;
  readonly detail?: string;
  readonly loading?: boolean;
  readonly onRetry?: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      {props.loading ? (
        <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
      ) : null}
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{props.title}</p>
        {props.detail ? <p className="text-xs text-muted-foreground">{props.detail}</p> : null}
      </div>
      {props.onRetry ? (
        <Button size="xs" variant="outline" onClick={props.onRetry}>
          <RefreshCw />
          Retry
        </Button>
      ) : null}
    </div>
  );
}

function ImagePreview(props: { readonly relativePath: string; readonly url: string }) {
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [zoom, setZoom] = useState<number | null>(null);
  const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    setLoadState("loading");
    setZoom(null);
  }, [props.url]);

  const imageStyle =
    zoom === null || naturalSize.width === 0
      ? undefined
      : {
          width: `${Math.max(1, Math.round(naturalSize.width * zoom))}px`,
          height: `${Math.max(1, Math.round(naturalSize.height * zoom))}px`,
          maxWidth: "none",
          maxHeight: "none",
        };

  return (
    <div className="relative min-h-0 flex-1 overflow-auto bg-muted/20">
      <div className="flex min-h-full min-w-full items-center justify-center p-4">
        <img
          src={props.url}
          alt={props.relativePath}
          decoding="async"
          referrerPolicy="no-referrer"
          className={zoom === null ? "max-h-full max-w-full object-contain" : "shrink-0"}
          style={imageStyle}
          onLoad={(event) => {
            setNaturalSize({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight,
            });
            setLoadState("ready");
          }}
          onError={() => setLoadState("error")}
        />
      </div>
      {loadState === "loading" ? (
        <div className="absolute inset-0 flex bg-background">
          <PreviewMessage title="Loading image…" loading />
        </div>
      ) : null}
      {loadState === "error" ? (
        <div className="absolute inset-0 flex bg-background">
          <PreviewMessage
            title="Image preview unavailable"
            detail="The file may be damaged or use an image codec Chromium cannot decode."
          />
        </div>
      ) : null}
      {loadState === "ready" ? (
        <div className="absolute top-2 right-2 flex items-center gap-1 rounded-lg border border-border/70 bg-popover/95 p-1 shadow-sm backdrop-blur">
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Zoom out"
            disabled={zoom !== null && zoom <= 0.25}
            onClick={() => setZoom((current) => Math.max(0.25, (current ?? 1) - 0.25))}
          >
            <Minus />
          </Button>
          <button
            type="button"
            className="min-w-11 px-1 text-[11px] font-medium text-muted-foreground"
            onClick={() => setZoom(1)}
            aria-label="Show image at actual size"
          >
            {zoom === null ? "Fit" : `${Math.round(zoom * 100)}%`}
          </button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Zoom in"
            disabled={zoom !== null && zoom >= 8}
            onClick={() => setZoom((current) => Math.min(8, (current ?? 0.75) + 0.25))}
          >
            <Plus />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Fit image to panel"
            disabled={zoom === null}
            onClick={() => setZoom(null)}
          >
            <Scan />
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function PdfPreview(props: { readonly relativePath: string; readonly url: string }) {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => setLoaded(false), [props.url]);

  return (
    <div className="relative min-h-0 flex-1 bg-muted/20">
      {!loaded ? (
        <div className="absolute inset-0 z-10 flex bg-background">
          <PreviewMessage title="Loading PDF…" loading />
        </div>
      ) : null}
      <iframe
        src={props.url}
        title={`PDF preview of ${props.relativePath}`}
        className="size-full border-0 bg-background"
        // Chromium's native PDF viewer needs both tokens. The signed route also forces
        // application/pdf with nosniff, so an HTML payload cannot turn this into an active frame.
        // eslint-disable-next-line react/iframe-missing-sandbox
        sandbox="allow-downloads allow-same-origin allow-scripts"
        referrerPolicy="no-referrer"
        onLoad={() => setLoaded(true)}
      />
    </div>
  );
}

export function WorkspaceAssetPreview(props: {
  readonly absolutePath: string;
  readonly cwd: string;
  readonly environmentId: EnvironmentId;
  readonly kind: WorkspaceAssetPreviewKind;
  readonly relativePath: string;
  readonly threadId: ThreadId;
}) {
  const resource = useMemo<AssetResource>(
    () => ({ _tag: "workspace-file", threadId: props.threadId, path: props.absolutePath }),
    [props.absolutePath, props.threadId],
  );
  const asset = useAssetUrlState(props.environmentId, resource);
  const fileEventResult = useAtomValue(
    projectEnvironment.fileEvents({
      environmentId: props.environmentId,
      input: { cwd: props.cwd },
    }),
  );
  const latestFileEvent = Option.getOrNull(AsyncResult.value(fileEventResult));
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (latestFileEvent === null || latestFileEvent.cwd !== props.cwd) return;
    if (
      latestFileEvent.type === "resync" ||
      (latestFileEvent.type === "changed" &&
        (latestFileEvent.contentPaths.includes(props.relativePath) ||
          latestFileEvent.structuralPaths.includes(props.relativePath)))
    ) {
      setRevision((current) => current + 1);
    }
  }, [latestFileEvent, props.cwd, props.relativePath]);

  if (asset.status === "loading") {
    return <PreviewMessage title="Preparing preview…" loading />;
  }
  if (asset.status === "error") {
    return (
      <PreviewMessage title="Preview unavailable" detail={asset.message} onRetry={asset.retry} />
    );
  }

  const url = withPreviewRevision(asset.url, revision);
  return props.kind === "image" ? (
    <ImagePreview relativePath={props.relativePath} url={url} />
  ) : (
    <PdfPreview relativePath={props.relativePath} url={url} />
  );
}
