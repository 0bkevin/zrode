import { type ServerProvider } from "@t3tools/contracts";
import { memo, useEffect, useState } from "react";
import { InfoIcon, XIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { formatProviderDriverKindLabel } from "../../providerModels";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const ProviderStatusBanner = memo(function ProviderStatusBanner({
  status,
}: {
  status: ServerProvider | null;
}) {
  // Dismissal is keyed on the banner content so a new status/message shows again.
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const isHidden = !status || status.status === "ready" || status.status === "disabled";
  // Reset the dismissal once the provider recovers, so a later recurrence with identical
  // content isn't permanently suppressed by a stale content key.
  useEffect(() => {
    if (isHidden) setDismissedKey(null);
  }, [isHidden]);

  if (isHidden) {
    return null;
  }

  const providerName = status.displayName?.trim() || formatProviderDriverKindLabel(status.driver);
  const isUnauthenticated = status.status === "error" && status.auth.status === "unauthenticated";
  const title = isUnauthenticated
    ? `${providerName} is unauthenticated`
    : `${providerName} provider status`;
  const message = isUnauthenticated
    ? "Sign in via the CLI to authenticate again."
    : (status.message ??
      (status.status === "error"
        ? `${providerName} provider is unavailable.`
        : `${providerName} provider has limited availability.`));

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
          onClick={() => setDismissedKey(bannerKey)}
          size="icon-xs"
          variant="ghost"
        >
          <XIcon />
        </Button>
      </div>
    </div>
  );
});
