import { RouterProvider } from "@tanstack/react-router";
import { useEffect } from "react";

import { applyClientAppearance } from "./appearance";
import { ElectronBrowserHost } from "./browser/ElectronBrowserHost";
import { PreviewAutomationHosts } from "./components/preview/PreviewAutomationHosts";
import { useClientSettings } from "./hooks/useSettings";
import { syncBrowserChromeTheme, useTheme } from "./hooks/useTheme";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";

function ClientAppearanceSync() {
  const appearance = useClientSettings((settings) => settings.appearance);
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    applyClientAppearance(appearance, resolvedTheme);
    syncBrowserChromeTheme();
  }, [appearance, resolvedTheme]);

  return null;
}

/**
 * Owns renderer-wide providers. The Electron browser host intentionally sits
 * outside the router so its webviews survive route transitions, but it must
 * share the same atom registry as routed UI.
 */
export function AppRoot({ router }: { readonly router: AppRouter }) {
  return (
    <AppAtomRegistryProvider>
      <RouterProvider router={router} />
      <PreviewAutomationHosts />
      <ElectronBrowserHost />
      <ClientAppearanceSync />
    </AppAtomRegistryProvider>
  );
}
