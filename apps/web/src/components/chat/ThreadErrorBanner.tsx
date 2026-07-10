import { memo } from "react";
import { normalizeProviderErrorMessage } from "@t3tools/shared/providerError";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { CircleAlertIcon, XIcon } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const ThreadErrorBanner = memo(function ThreadErrorBanner({
  error,
  onDismiss,
}: {
  error: string | null;
  onDismiss?: () => void;
}) {
  const message = normalizeProviderErrorMessage(error);
  if (!message) return null;
  return (
    <div className="pointer-events-auto w-fit max-w-full sm:max-w-2xl">
      <Alert variant="error" className="bg-background/70 shadow-lg/5 backdrop-blur-md">
        <CircleAlertIcon />
        <AlertDescription className="min-w-0">
          <Tooltip>
            <TooltipTrigger
              render={<div className="min-w-0 line-clamp-3 wrap-break-word">{message}</div>}
            />
            <TooltipPopup side="bottom" className="max-w-96 whitespace-pre-wrap">
              {message}
            </TooltipPopup>
          </Tooltip>
        </AlertDescription>
        {onDismiss && (
          <AlertAction>
            <Button variant="ghost" size="icon-xs" aria-label="Dismiss error" onClick={onDismiss}>
              <XIcon className="text-destructive" />
            </Button>
          </AlertAction>
        )}
      </Alert>
    </div>
  );
});
