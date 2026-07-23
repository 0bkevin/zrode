import { describe, expect, it, vi } from "vite-plus/test";

import { providerUpdateToast } from "./ProviderUpdateToast";

describe("providerUpdateToast", () => {
  it("keeps provider details in a collapsed disclosure with compact inline settings", () => {
    const toast = providerUpdateToast({
      type: "warning",
      title: "Updates Available: 2 providers",
      details: <div>Provider rows</div>,
      detailCount: 2,
      onClose: vi.fn(),
      onOpenSettings: vi.fn(),
    });

    expect(toast.description).toBe("Review 2 updates");
    expect(toast.actionProps).toMatchObject({
      "aria-label": "Provider settings",
      title: "Provider settings",
    });
    expect(toast.data).toMatchObject({
      actionLayout: "inline-top",
      actionVariant: "ghost",
      expandableDescriptionTrigger: true,
      expandableLabels: {
        expand: "Show updates",
        collapse: "Hide updates",
      },
      hideCopyButton: true,
    });
    expect(toast.data?.expandableContent).toBeDefined();
  });

  it("uses singular disclosure copy for one provider", () => {
    const toast = providerUpdateToast({
      type: "warning",
      title: "Update Available",
      details: <div>Provider row</div>,
      detailCount: 1,
      onClose: vi.fn(),
      onOpenSettings: vi.fn(),
    });

    expect(toast.description).toBe("Review 1 update");
    expect(toast.data?.expandableLabels).toEqual({
      expand: "Show update",
      collapse: "Hide update",
    });
  });
});
