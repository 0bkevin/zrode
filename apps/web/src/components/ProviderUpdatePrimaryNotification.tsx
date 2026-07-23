import { useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { DownloadIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { type ProviderDriverKind } from "@t3tools/contracts";

import { primaryServerProvidersAtom } from "../state/server";
import { usePrimaryEnvironment } from "../state/environments";
import { useDismissedProviderUpdateNotificationKeys } from "../providerUpdateDismissal";
import { PROVIDER_ICON_BY_PROVIDER } from "./chat/providerIconUtils";
import {
  canOneClickUpdateProviderCandidate,
  collectProviderUpdateCandidates,
  getProviderUpdateInitialToastView,
  providerUpdateNotificationKey,
} from "./ProviderUpdateLaunchNotification.logic";
import { ProviderUpdateProviderRows } from "./ProviderUpdateProviderRows";
import { providerUpdateToast } from "./ProviderUpdateToast";
import { toastManager } from "./ui/toast";

const seenProviderUpdateNotificationKeys = new Set<string>();
type ProviderUpdateToastId = ReturnType<typeof toastManager.add>;

type ActiveProviderUpdateToast = {
  readonly key: string;
  readonly toastId: ProviderUpdateToastId;
};

function ProviderUpdateToastIcon({ provider }: { provider: ProviderDriverKind }) {
  const ProviderIcon = PROVIDER_ICON_BY_PROVIDER[provider];

  if (!ProviderIcon) {
    return (
      <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
        <DownloadIcon aria-hidden="true" className="size-4 text-success" strokeWidth={2.5} />
      </span>
    );
  }

  return (
    <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
      <ProviderIcon aria-hidden="true" className="size-4" />
      <span className="absolute -right-1 -bottom-1 inline-flex size-3 items-center justify-center rounded-full bg-popover">
        <DownloadIcon aria-hidden="true" className="size-2.5 text-success" strokeWidth={2.5} />
      </span>
    </span>
  );
}

/**
 * The single-prompt provider update notification used when there is only one
 * local environment (no WSL backend). Non-WSL users see exactly this flow — the
 * per-environment split is gated behind WSL presence.
 */
export function ProviderUpdatePrimaryNotification() {
  const navigate = useNavigate();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const primaryEnvironment = usePrimaryEnvironment();
  const activeToastRef = useRef<ActiveProviderUpdateToast | null>(null);
  const hasInteractedRef = useRef(false);
  const { dismissedNotificationKeys, dismissNotificationKey } =
    useDismissedProviderUpdateNotificationKeys();

  // If this flow unmounts (e.g. a WSL backend appears and we switch to the
  // per-environment popover), close any prompt it owns so it does not linger.
  useEffect(() => {
    return () => {
      const activeToast = activeToastRef.current;
      if (activeToast) {
        toastManager.close(activeToast.toastId);
        activeToastRef.current = null;
      }
    };
  }, []);

  const updateProviders = useMemo(() => collectProviderUpdateCandidates(providers), [providers]);
  const notificationKey = useMemo(
    () => providerUpdateNotificationKey(updateProviders),
    [updateProviders],
  );
  const oneClickProviders = useMemo(
    () =>
      updateProviders.filter((provider) => canOneClickUpdateProviderCandidate(provider, providers)),
    [providers, updateProviders],
  );

  const openProviderSettings = useCallback(
    (toastId?: ProviderUpdateToastId) => {
      const activeToast = activeToastRef.current;
      if (toastId !== undefined) {
        toastManager.close(toastId);
      } else if (activeToast) {
        toastManager.close(activeToast.toastId);
      }
      if (activeToast && (toastId === undefined || activeToast.toastId === toastId)) {
        activeToastRef.current = null;
      }
      void navigate({ to: "/settings/providers" });
    },
    [navigate],
  );

  useEffect(() => {
    const activeToast = activeToastRef.current;
    if (activeToast && activeToast.key !== notificationKey) {
      if (!hasInteractedRef.current) {
        toastManager.close(activeToast.toastId);
        if (activeToastRef.current?.toastId === activeToast.toastId) {
          activeToastRef.current = null;
        }
      } else if (notificationKey) {
        // The mounted row list already exposes newly outdated providers. Adopt
        // that key so an explicit close dismisses exactly what the user saw.
        activeToastRef.current = { ...activeToast, key: notificationKey };
      }
    }

    if (
      !notificationKey ||
      dismissedNotificationKeys.has(notificationKey) ||
      seenProviderUpdateNotificationKeys.has(notificationKey) ||
      activeToastRef.current
    ) {
      return;
    }

    seenProviderUpdateNotificationKeys.add(notificationKey);
    hasInteractedRef.current = false;

    const initialView = getProviderUpdateInitialToastView({ updateProviders, oneClickProviders });

    let toastId!: ProviderUpdateToastId;
    const openSettings = () => openProviderSettings(toastId);
    const dismissPrompt = () => {
      const currentToast = activeToastRef.current;
      dismissNotificationKey(
        currentToast?.toastId === toastId ? currentToast.key : notificationKey,
      );
      if (currentToast?.toastId === toastId) {
        activeToastRef.current = null;
      }
    };

    toastId = toastManager.add(
      providerUpdateToast({
        type: initialView.type,
        title: initialView.title,
        details: primaryEnvironment ? (
          <ProviderUpdateProviderRows
            candidates={updateProviders}
            environmentId={primaryEnvironment.environmentId}
            onInteract={() => {
              hasInteractedRef.current = true;
            }}
            onOpenSettings={openSettings}
          />
        ) : (
          initialView.description
        ),
        detailCount: updateProviders.length,
        leadingIcon:
          updateProviders.length === 1 ? (
            <ProviderUpdateToastIcon provider={updateProviders[0]!.driver} />
          ) : undefined,
        onClose: dismissPrompt,
        onOpenSettings: openSettings,
      }),
    );
    activeToastRef.current = { key: notificationKey, toastId };
  }, [
    dismissNotificationKey,
    dismissedNotificationKeys,
    notificationKey,
    oneClickProviders,
    openProviderSettings,
    primaryEnvironment,
    updateProviders,
  ]);

  return null;
}
