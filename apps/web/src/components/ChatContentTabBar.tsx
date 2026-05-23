import { FileIcon, MessageSquareIcon, XIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "../lib/utils";

export interface ChatContentTab {
  id: string;
  title: string;
  kind: "chat" | "file";
  closable: boolean;
  dirty?: boolean;
}

interface ChatContentTabBarProps {
  tabs: readonly ChatContentTab[];
  activeTabId: string;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
}

export const ChatContentTabBar = memo(function ChatContentTabBar({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
}: ChatContentTabBarProps) {
  return (
    <div className="flex h-9 shrink-0 items-stretch overflow-hidden border-b border-border bg-muted/30">
      <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto overflow-y-hidden">
        {tabs.map((tab, index) => {
          const active = tab.id === activeTabId;
          const Icon = tab.kind === "chat" ? MessageSquareIcon : FileIcon;
          return (
            <div
              key={tab.id}
              className={cn(
                "group flex h-full max-w-56 shrink-0 items-center border-r border-border text-xs",
                index === 0 && "border-l border-border",
                active
                  ? "bg-background text-foreground"
                  : "bg-muted/20 text-muted-foreground hover:bg-muted/50 hover:text-foreground",
              )}
            >
              <button
                type="button"
                className="flex h-full min-w-0 flex-1 items-center gap-1.5 px-2.5 text-left"
                title={tab.title}
                onClick={() => onSelectTab(tab.id)}
              >
                <Icon className="size-3.5 shrink-0" />
                <span className="min-w-0 truncate">{tab.title}</span>
                {tab.dirty ? (
                  <span
                    aria-label={`${tab.title} has unsaved changes`}
                    className="size-1.5 shrink-0 rounded-full bg-muted-foreground"
                  />
                ) : null}
              </button>
              {tab.closable ? (
                <button
                  type="button"
                  aria-label={`Close ${tab.title}`}
                  className="mr-1 rounded p-0.5 opacity-60 hover:bg-accent hover:opacity-100"
                  onClick={(event) => {
                    event.stopPropagation();
                    onCloseTab(tab.id);
                  }}
                >
                  <XIcon className="size-3" />
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
});
