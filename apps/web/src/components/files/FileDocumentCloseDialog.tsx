import { Button } from "~/components/ui/button";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";

import type { FileDocumentCloseDecision, FileDocumentClosePrompt } from "./fileDocumentRuntime";

export function FileDocumentCloseDialog({
  prompt,
  onDecision,
}: {
  readonly prompt: FileDocumentClosePrompt | null;
  readonly onDecision: (decision: FileDocumentCloseDecision) => void;
}) {
  const conflict = prompt?.kind === "conflict";
  const orphaned = prompt?.kind === "orphaned";

  return (
    <AlertDialog
      open={prompt !== null}
      onOpenChange={(open) => {
        if (!open && prompt !== null) onDecision("cancel");
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {conflict || orphaned ? "Resolve file changes before closing" : "Save before closing?"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {prompt ? (
              <>
                <span className="font-medium text-foreground">{prompt.relativePath}</span>{" "}
                {conflict
                  ? "changed on disk after you started editing. Your local version is still safe in Zrode."
                  : orphaned
                    ? "was removed on disk. Your local version is still safe in Zrode."
                    : "has changes that have not reached disk yet."}
              </>
            ) : null}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="outline" onClick={() => onDecision("cancel")}>
            Cancel
          </Button>
          <Button variant="destructive-outline" onClick={() => onDecision("discard")}>
            {orphaned ? "Discard local changes" : "Don't save"}
          </Button>
          <Button onClick={() => onDecision("save")}>
            {conflict ? "Overwrite and close" : orphaned ? "Recreate and close" : "Save and close"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
