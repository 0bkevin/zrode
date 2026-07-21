import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "./ui/collapsible";

interface RuntimeStatusAccordionProps {
  readonly icon: ReactNode;
  readonly label: string;
  readonly count: number;
  readonly summary: string;
  readonly attention?: boolean;
  readonly children: ReactNode;
}

export function RuntimeStatusAccordion({
  icon,
  label,
  count,
  summary,
  attention = false,
  children,
}: RuntimeStatusAccordionProps) {
  return (
    <Collapsible className="border-t">
      <CollapsibleTrigger className="group flex w-full items-center gap-2.5 bg-muted/30 px-3 py-2 text-left transition-colors hover:bg-muted/50">
        <span className="shrink-0 text-muted-foreground">{icon}</span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-1.5">
            <span className="text-[11px] font-medium text-foreground">{label}</span>
            <span
              className={cn(
                "rounded-full px-1.5 text-[9px] tabular-nums",
                attention ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground",
              )}
            >
              {count}
            </span>
          </span>
          <span
            className={cn(
              "truncate text-[10px] tabular-nums",
              attention ? "text-destructive" : "text-muted-foreground",
            )}
            title={summary}
          >
            {summary}
          </span>
        </span>
        <ChevronDown
          className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-180"
          aria-hidden
        />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="border-t">{children}</div>
      </CollapsiblePanel>
    </Collapsible>
  );
}
