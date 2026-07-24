import type { ToastManagerAddOptions } from "@base-ui/react/toast";
import { SettingsIcon } from "lucide-react";
import type { ReactNode } from "react";

import type { ThreadToastData } from "./ui/toast";

interface ProviderUpdateToastOptions {
  readonly type: "warning" | "info" | "loading" | "success" | "error";
  readonly title: ReactNode;
  readonly details: ReactNode;
  readonly detailCount: number;
  readonly inlineActions?: ReactNode;
  readonly leadingIcon?: ReactNode;
  readonly onClose: () => void;
  readonly onOpenSettings: () => void;
}

/**
 * Provider updates can contain several independently actionable rows. Keep the
 * notification compact until the user asks for those details, while leaving
 * the secondary settings action immediately available.
 */
export function providerUpdateToast({
  type,
  title,
  details,
  detailCount,
  inlineActions,
  leadingIcon,
  onClose,
  onOpenSettings,
}: ProviderUpdateToastOptions): ToastManagerAddOptions<ThreadToastData> {
  const plural = detailCount === 1 ? "update" : "updates";

  return {
    type,
    title,
    description: `Review ${detailCount} ${plural}`,
    timeout: 0,
    actionProps: {
      "aria-label": "Provider settings",
      children: <SettingsIcon aria-hidden="true" className="size-3.5" />,
      onClick: onOpenSettings,
      title: "Provider settings",
    },
    data: {
      actionLayout: "inline-top",
      actionVariant: "ghost",
      expandableContent: details,
      expandableDescriptionTrigger: true,
      expandableLabels: {
        expand: `Show ${plural}`,
        collapse: `Hide ${plural}`,
      },
      customActions: inlineActions,
      hideCopyButton: true,
      leadingIcon,
      onClose,
    },
  };
}
