import { X } from "lucide-react";
import { type MouseEvent as ReactMouseEvent, useCallback, useEffect, useRef } from "react";

import { PierreEntryIcon } from "~/components/chat/PierreEntryIcon";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";

import type { PopoutFileTab } from "./popoutFileTabState";

export function PopoutFileTabs({
  tabs,
  activePath,
  pendingPaths,
  onActivate,
  onClose,
}: {
  readonly tabs: readonly PopoutFileTab[];
  readonly activePath: string | null;
  readonly pendingPaths: ReadonlySet<string>;
  readonly onActivate: (relativePath: string) => void;
  readonly onClose: (relativePath: string) => void;
}) {
  const { resolvedTheme } = useTheme();
  const tabListRef = useRef<HTMLDivElement>(null);
  const handleMouseDown = useCallback((event: ReactMouseEvent) => {
    if (event.button === 1) event.preventDefault();
  }, []);
  const handleAuxClick = useCallback(
    (event: ReactMouseEvent, relativePath: string) => {
      if (event.button !== 1) return;
      event.preventDefault();
      event.stopPropagation();
      onClose(relativePath);
    },
    [onClose],
  );

  useEffect(() => {
    tabListRef.current
      ?.querySelector<HTMLElement>("[data-active-file-tab='true']")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activePath]);

  if (tabs.length === 0) return null;

  return (
    <div
      className="surface-subheader gap-1 px-2"
      data-popout-file-tabbar
      aria-label="Open file tabs"
    >
      <ScrollArea
        ref={tabListRef}
        hideScrollbars
        scrollFade
        className="min-w-0 flex-1 rounded-none"
      >
        <div
          className="flex h-full w-max min-w-full items-center gap-1"
          role="tablist"
          aria-label="Open files"
        >
          {tabs.map((tab) => {
            const active = tab.relativePath === activePath;
            const pending = pendingPaths.has(tab.relativePath);
            const title = tab.relativePath.slice(tab.relativePath.lastIndexOf("/") + 1);
            return (
              <div
                key={tab.relativePath}
                data-active-file-tab={active}
                onMouseDown={handleMouseDown}
                onAuxClick={(event) => handleAuxClick(event, tab.relativePath)}
                className={cn(
                  "group flex h-7 min-w-25 max-w-52 shrink-0 items-center gap-1.5 rounded-md px-2 text-sm",
                  active
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
              >
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        role="tab"
                        aria-selected={active}
                        className="flex min-w-0 flex-1 items-center gap-1.5"
                        onClick={() => onActivate(tab.relativePath)}
                      >
                        <PierreEntryIcon
                          pathValue={tab.relativePath}
                          kind="file"
                          theme={resolvedTheme}
                          className="size-3.5"
                        />
                        <span className="truncate">{title}</span>
                      </button>
                    }
                  />
                  <TooltipPopup>{tab.relativePath}</TooltipPopup>
                </Tooltip>
                <button
                  type="button"
                  className={cn(
                    "relative flex size-4 shrink-0 items-center justify-center rounded hover:bg-muted focus:opacity-100",
                    pending ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                  )}
                  aria-label={`Close ${title}`}
                  onClick={() => onClose(tab.relativePath)}
                >
                  {pending ? (
                    <>
                      <span className="size-2 rounded-full bg-current group-hover:hidden" />
                      <X className="hidden size-3 group-hover:block" />
                    </>
                  ) : (
                    <X className="size-3" />
                  )}
                </button>
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
