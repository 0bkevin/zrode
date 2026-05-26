import { memo } from "react";
import { FolderIcon, FolderOpenIcon } from "lucide-react";
import { getFileTypeIcon } from "~/lib/fileTypeIcons";
import { cn } from "~/lib/utils";

export const VscodeEntryIcon = memo(function VscodeEntryIcon(props: {
  pathValue: string;
  kind: "file" | "directory";
  theme?: "light" | "dark";
  expanded?: boolean;
  className?: string;
}) {
  const Icon =
    props.kind === "directory"
      ? props.expanded
        ? FolderOpenIcon
        : FolderIcon
      : getFileTypeIcon(props.pathValue);

  return (
    <Icon
      aria-hidden="true"
      className={cn("size-3.5 shrink-0 text-muted-foreground", props.className)}
    />
  );
});
