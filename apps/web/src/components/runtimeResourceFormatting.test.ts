import { describe, expect, it } from "vite-plus/test";

import { formatRuntimeBytes, formatRuntimeCpu } from "./runtimeResourceFormatting";

describe("runtime resource formatting", () => {
  it("formats byte totals across runtime status sections", () => {
    expect(formatRuntimeBytes(512)).toBe("512 B");
    expect(formatRuntimeBytes(1_536)).toBe("1.5 KB");
    expect(formatRuntimeBytes(12 * 1_024 * 1_024)).toBe("12 MB");
  });

  it("keeps small CPU values precise and large values compact", () => {
    expect(formatRuntimeCpu(1.25)).toBe("1.3%");
    expect(formatRuntimeCpu(12.6)).toBe("13%");
  });
});
