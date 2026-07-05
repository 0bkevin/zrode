import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { scopedThreadKey } from "@t3tools/client-runtime/environment";

import { threadHasStarted } from "../components/ChatView.logic";
import ThreadSplitView from "../components/ThreadSplitView";
import { finalizePromotedDraftThreadByRef, useComposerDraftStore } from "../composerDraftStore";
import { findLeafByThreadKey } from "../paneLayout.logic";
import { closePaneLeaf, usePaneLayoutStore } from "../paneLayoutStore";
import { resolveThreadRouteRef, threadRouteOptionsForKey } from "../threadRoutes";
import { SidebarInset } from "~/components/ui/sidebar";
import { useEnvironmentThreadRefs, useThreadDetail, useThreadShell } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { environmentShell } from "../state/shell";

function ChatThreadRouteView() {
  const navigate = useNavigate();
  const threadRef = Route.useParams({
    select: (params) => resolveThreadRouteRef(params),
  });
  const shell = useEnvironmentQuery(
    threadRef === null ? null : environmentShell.stateAtom(threadRef.environmentId),
  );
  const serverThreadShell = useThreadShell(threadRef);
  const serverThreadDetail = useThreadDetail(threadRef);
  const environmentThreadRefs = useEnvironmentThreadRefs(threadRef?.environmentId ?? null);
  const bootstrapComplete = shell.data?.snapshot._tag === "Some";
  const threadExists = serverThreadShell !== null || serverThreadDetail !== null;
  const environmentHasServerThreads = environmentThreadRefs.length > 0;
  const draftThreadExists = useComposerDraftStore((store) =>
    threadRef ? store.getDraftThreadByRef(threadRef) !== null : false,
  );
  const draftThread = useComposerDraftStore((store) =>
    threadRef ? store.getDraftThreadByRef(threadRef) : null,
  );
  const environmentHasDraftThreads = useComposerDraftStore((store) => {
    if (!threadRef) {
      return false;
    }
    return store.hasDraftThreadsInEnvironment(threadRef.environmentId);
  });
  const routeThreadExists = threadExists || draftThreadExists;
  const serverThreadStarted = threadHasStarted(serverThreadDetail);
  const environmentHasAnyThreads = environmentHasServerThreads || environmentHasDraftThreads;

  useEffect(() => {
    if (!threadRef || !bootstrapComplete) {
      return;
    }

    if (!routeThreadExists && environmentHasAnyThreads) {
      // In a split, only the dead pane closes — the other panes stay up and
      // the URL moves to the surviving focused pane instead of the index.
      const paneStore = usePaneLayoutStore.getState();
      const deadLeaf =
        paneStore.root === null
          ? null
          : findLeafByThreadKey(paneStore.root, scopedThreadKey(threadRef));
      if (deadLeaf !== null) {
        const nextThreadKey = closePaneLeaf(deadLeaf.id);
        const options = nextThreadKey === null ? null : threadRouteOptionsForKey(nextThreadKey);
        if (options !== null) {
          void navigate({ ...options, replace: true });
          return;
        }
      }
      void navigate({ to: "/", replace: true });
    }
  }, [bootstrapComplete, environmentHasAnyThreads, navigate, routeThreadExists, threadRef]);

  useEffect(() => {
    if (!threadRef || !serverThreadStarted || !draftThread) {
      return;
    }
    finalizePromotedDraftThreadByRef(threadRef);
  }, [draftThread, serverThreadStarted, threadRef]);

  if (!threadRef || !bootstrapComplete || !routeThreadExists) {
    return null;
  }

  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
      <ThreadSplitView threadRef={threadRef} />
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/$environmentId/$threadId")({
  component: ChatThreadRouteView,
});
