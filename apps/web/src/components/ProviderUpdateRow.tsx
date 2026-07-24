import { CheckIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import type {
  ProviderUpdateRowStatus,
  ProviderUpdateRowStatusKind,
} from "./ProviderUpdateLaunchNotification.logic";
import { Button } from "./ui/button";
import { Spinner } from "./ui/spinner";

const ROW_ACTION_CLASS_NAME = "h-6 px-2 text-[11px] shadow-none";

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
        <Button className={ROW_ACTION_CLASS_NAME} size="xs" variant="outline" onClick={onUpdate}>
          Retry
        </Button>
      ) : (
        <Button
          className={ROW_ACTION_CLASS_NAME}
          size="xs"
          variant="outline"
          onClick={onOpenSettings}
        >
          Settings
        </Button>
      );
      break;
    default:
      trailing = canUpdate ? (
        <Button className={ROW_ACTION_CLASS_NAME} size="xs" onClick={onUpdate}>
          Update
        </Button>
      ) : (
        <Button
          className={ROW_ACTION_CLASS_NAME}
          size="xs"
          variant="outline"
          onClick={onOpenSettings}
        >
          Settings
        </Button>
      );
      break;
  }

  return (
    <div className="flex min-h-7 w-full min-w-0 max-w-full items-center justify-between gap-2 overflow-x-clip py-px">
      <div className="flex min-w-0 items-baseline gap-1.5">
        <span className="max-w-24 shrink-0 truncate text-xs font-medium leading-4 text-foreground">
          {label}
        </span>
        <span className={cn("truncate text-[10px] leading-3.5", rowToneClass(status.kind))}>
          {status.text}
        </span>
      </div>
      <div className="shrink-0">{trailing}</div>
    </div>
  );
}
