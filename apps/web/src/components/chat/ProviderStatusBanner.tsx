import { type ServerProvider } from "@t3tools/contracts";
import { normalizeProviderErrorMessage } from "@t3tools/shared/providerError";
import { memo, useEffect } from "react";
import { InfoIcon, XIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { useNotificationDismissalStore } from "../../notificationDismissalStore";
import { formatProviderDriverKindLabel } from "../../providerModels";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const ProviderStatusBanner = memo(function ProviderStatusBanner({
  status,
}: {
  status: ServerProvider | null;
}) {
  const providerInstanceId = status?.instanceId ?? null;
  const dismissedKey = useNotificationDismissalStore((store) =>
    providerInstanceId === null
      ? null
      : (store.providerStatusByInstanceId[providerInstanceId] ?? null),
  );
  const dismissProviderStatus = useNotificationDismissalStore(
    (store) => store.dismissProviderStatus,
  );
  const clearProviderStatusDismissal = useNotificationDismissalStore(
    (store) => store.clearProviderStatusDismissal,
  );
  const isHidden = !status || status.status === "ready" || status.status === "disabled";
  // Reset the dismissal once the provider recovers, so a later recurrence with identical
  // content isn't permanently suppressed by a stale content key.
  useEffect(() => {
    if (isHidden && providerInstanceId !== null) {
      clearProviderStatusDismissal(providerInstanceId);
    }
  }, [clearProviderStatusDismissal, isHidden, providerInstanceId]);

  if (isHidden) {
    return null;
  }

  const providerName = status.displayName?.trim() || formatProviderDriverKindLabel(status.driver);
  const isUnauthenticated = status.status === "error" && status.auth.status === "unauthenticated";
  const title = isUnauthenticated
    ? `${providerName} is unauthenticated`
    : `${providerName} provider status`;
  const fallbackMessage =
    status.status === "error"
      ? `${providerName} provider is unavailable.`
      : `${providerName} provider has limited availability.`;
  const message = isUnauthenticated
    ? "Sign in via the CLI to authenticate again."
    : (normalizeProviderErrorMessage(status.message, {
        fallback: fallbackMessage,
        requestSubject: `${providerName} status check`,
        maxLength: 240,
      }) ?? fallbackMessage);

  const bannerKey = `${status.driver}:${status.status}:${title}:${message}`;
  if (bannerKey === dismissedKey) {
    return null;
  }

  return (
    <div className="pointer-events-auto w-fit max-w-full">
      <div
        className={cn(
          "flex items-center gap-3 rounded-xl border bg-background/70 px-3.5 py-3 text-card-foreground text-sm shadow-lg/5 backdrop-blur-md",
          status.status === "warning"
            ? "border-warning/32 [&>svg]:text-warning"
            : "border-destructive/32 text-destructive-foreground [&>svg]:text-destructive",
        )}
        role="alert"
      >
        <InfoIcon className="size-4 shrink-0" aria-hidden />
        <div className="flex min-w-0 flex-col gap-1">
          <div className="font-medium">{title}</div>
          <Tooltip>
            <TooltipTrigger
              render={<div className="line-clamp-3 text-muted-foreground">{message}</div>}
            />
            <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap">
              {message}
            </TooltipPopup>
          </Tooltip>
        </div>
        <Button
          aria-label="Dismiss notification"
          className="shrink-0 self-center"
          onClick={() => {
            if (providerInstanceId !== null) {
              dismissProviderStatus(providerInstanceId, bannerKey);
            }
          }}
          size="icon-xs"
          variant="ghost"
        >
          <XIcon />
        </Button>
      </div>
    </div>
  );
});
