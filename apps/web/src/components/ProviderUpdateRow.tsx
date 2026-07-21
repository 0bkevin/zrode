import { CheckIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import type {
  ProviderUpdateRowStatus,
  ProviderUpdateRowStatusKind,
} from "./ProviderUpdateLaunchNotification.logic";
import { Button } from "./ui/button";
import { Spinner } from "./ui/spinner";

function rowToneClass(kind: ProviderUpdateRowStatusKind): string {
  switch (kind) {
    case "failed":
      return "text-destructive";
    case "unchanged":
      return "text-warning";
    case "success":
      return "text-success";
    default:
      return "text-muted-foreground";
  }
}

export function ProviderUpdateRow({
  label,
  status,
  canUpdate,
  onUpdate,
  onOpenSettings,
}: {
  readonly label: ReactNode;
  readonly status: ProviderUpdateRowStatus;
  readonly canUpdate: boolean;
  readonly onUpdate: () => void;
  readonly onOpenSettings?: () => void;
}) {
  let trailing: ReactNode;
  switch (status.kind) {
    case "loading":
      trailing = <Spinner className="size-4 text-muted-foreground" />;
      break;
    case "success":
      trailing = <CheckIcon aria-hidden="true" className="size-4 text-success" />;
      break;
    case "failed":
    case "unchanged":
      trailing = canUpdate ? (
        <Button size="xs" variant="outline" onClick={onUpdate}>
          Retry
        </Button>
      ) : (
        <Button size="xs" variant="outline" onClick={onOpenSettings}>
          Settings
        </Button>
      );
      break;
    default:
      trailing = canUpdate ? (
        <Button size="xs" onClick={onUpdate}>
          Update
        </Button>
      ) : (
        <Button size="xs" variant="outline" onClick={onOpenSettings}>
          Settings
        </Button>
      );
      break;
  }

  return (
    <div className="flex items-center justify-between gap-3 py-0.5">
      <div className="flex min-w-0 flex-col">
        <span className="truncate font-medium text-foreground">{label}</span>
        <span className={cn("truncate text-xs", rowToneClass(status.kind))}>{status.text}</span>
      </div>
      <div className="shrink-0">{trailing}</div>
    </div>
  );
}
