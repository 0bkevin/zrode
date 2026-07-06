import { createFileRoute } from "@tanstack/react-router";

import { UsageSettingsPanel } from "../components/settings/UsageSettings";

function SettingsUsageRoute() {
  return <UsageSettingsPanel />;
}

export const Route = createFileRoute("/settings/usage")({
  component: SettingsUsageRoute,
});
