import {
  type EnvironmentId,
  type EditorId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { PictureInPicture2 } from "lucide-react";
import { memo } from "react";
import GitActionsControl from "../GitActionsControl";
import { type DraftId } from "~/composerDraftStore";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import ProjectScriptsControl, {
  type NewProjectScriptInput,
  type ProjectScriptActionResult,
} from "../ProjectScriptsControl";
import { OpenInPicker } from "./OpenInPicker";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { cn } from "~/lib/utils";

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  draftId?: DraftId;
  activeThreadTitle: string;
  activeProjectName: string | undefined;
  /** Prefix the title with the project name (split view: the shared top bar must say which project the focused pane belongs to). */
  showProjectName?: boolean;
  openInCwd: string | null;
  activeProjectScripts: ReadonlyArray<ProjectScript> | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  rightPanelOpen: boolean;
  gitCwd: string | null;
  /** Detach this chat into its own OS window. Absent for draft threads and inside popout windows. */
  onOpenInNewWindow?: (() => void) | undefined;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<ProjectScriptActionResult>;
  onUpdateProjectScript: (
    scriptId: string,
    input: NewProjectScriptInput,
  ) => Promise<ProjectScriptActionResult>;
  onDeleteProjectScript: (scriptId: string) => Promise<ProjectScriptActionResult>;
}

export function shouldShowOpenInPicker(input: {
  readonly activeProjectName: string | undefined;
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): boolean {
  return (
    Boolean(input.activeProjectName) &&
    input.primaryEnvironmentId !== null &&
    input.activeThreadEnvironmentId === input.primaryEnvironmentId
  );
}

export const ChatHeader = memo(function ChatHeader({
  activeThreadEnvironmentId,
  activeThreadId,
  draftId,
  activeThreadTitle,
  activeProjectName,
  showProjectName = false,
  openInCwd,
  activeProjectScripts,
  preferredScriptId,
  keybindings,
  availableEditors,
  rightPanelOpen,
  gitCwd,
  onOpenInNewWindow,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
}: ChatHeaderProps) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const showOpenInPicker = shouldShowOpenInPicker({
    activeProjectName,
    activeThreadEnvironmentId,
    primaryEnvironmentId,
  });
  return (
    <div className="@container/header-actions flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden sm:gap-3">
        {showProjectName && activeProjectName && (
          <span className="flex min-w-0 shrink-0 items-center gap-2 sm:gap-3">
            <span className="max-w-48 truncate text-sm text-muted-foreground">
              {activeProjectName}
            </span>
            <span aria-hidden className="text-sm text-muted-foreground/50">
              /
            </span>
          </span>
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <h2
                aria-label={activeThreadTitle}
                className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
              >
                {activeThreadTitle}
              </h2>
            }
          />
          <TooltipPopup side="top">{activeThreadTitle}</TooltipPopup>
        </Tooltip>
      </div>
      <div
        data-chat-header-actions
        className={cn(
          "flex shrink-0 items-center justify-end gap-2 @3xl/header-actions:gap-3",
          rightPanelOpen ? "pr-0" : "pr-16",
        )}
      >
        {onOpenInNewWindow && (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label="Open chat in new window"
                  className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground [-webkit-app-region:no-drag]"
                  onClick={onOpenInNewWindow}
                >
                  <PictureInPicture2 className="size-4" />
                </button>
              }
            />
            <TooltipPopup side="bottom">Open chat in new window</TooltipPopup>
          </Tooltip>
        )}
        {activeProjectScripts && (
          <ProjectScriptsControl
            scripts={activeProjectScripts}
            keybindings={keybindings}
            preferredScriptId={preferredScriptId}
            onRunScript={onRunProjectScript}
            onAddScript={onAddProjectScript}
            onUpdateScript={onUpdateProjectScript}
            onDeleteScript={onDeleteProjectScript}
          />
        )}
        {showOpenInPicker && (
          <OpenInPicker
            environmentId={activeThreadEnvironmentId}
            keybindings={keybindings}
            availableEditors={availableEditors}
            openInCwd={openInCwd}
          />
        )}
        {activeProjectName && (
          <GitActionsControl
            gitCwd={gitCwd}
            activeThreadRef={scopeThreadRef(activeThreadEnvironmentId, activeThreadId)}
            {...(draftId ? { draftId } : {})}
          />
        )}
      </div>
    </div>
  );
});
