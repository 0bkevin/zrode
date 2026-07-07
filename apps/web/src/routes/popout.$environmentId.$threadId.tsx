import { createFileRoute } from "@tanstack/react-router";

import { PopoutPaneView, type PopoutPaneSearch } from "../components/popout/PopoutPaneView";
import { resolveThreadRouteRef } from "../threadRoutes";

function PopoutRouteView() {
  const threadRef = Route.useParams({
    select: (params) => resolveThreadRouteRef(params),
  });
  const search = Route.useSearch();

  if (!threadRef) {
    return null;
  }

  return <PopoutPaneView threadRef={threadRef} search={search} />;
}

export const Route = createFileRoute("/popout/$environmentId/$threadId")({
  validateSearch: (search: Record<string, unknown>): PopoutPaneSearch => ({
    kind:
      search.kind === "files" || search.kind === "chat" || search.kind === "terminal"
        ? search.kind
        : null,
    ...(typeof search.terminalIds === "string" && search.terminalIds.length > 0
      ? { terminalIds: search.terminalIds }
      : {}),
    ...(typeof search.activeTerminalId === "string" && search.activeTerminalId.length > 0
      ? { activeTerminalId: search.activeTerminalId }
      : {}),
    ...(typeof search.path === "string" && search.path.length > 0 ? { path: search.path } : {}),
  }),
  component: PopoutRouteView,
});
