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
    <div className="flex h-10 shrink-0 items-center overflow-hidden border-b border-border/40 bg-background px-1.5">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overflow-y-hidden">
        {tabs.map((tab, index) => {
          const active = tab.id === activeTabId;
          const Icon = tab.kind === "chat" ? MessageSquareIcon : FileIcon;
          return (
            <div
              key={tab.id}
              className={cn(
                "group flex h-7 max-w-56 shrink-0 items-center rounded-md text-xs transition-colors",
                active
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground/70 hover:bg-accent hover:text-foreground",
                index === 0 && "ml-0",
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
                  className="mr-1 rounded-md p-0.5 opacity-55 transition hover:bg-secondary hover:opacity-100"
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
