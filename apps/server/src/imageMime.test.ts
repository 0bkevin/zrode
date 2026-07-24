import { describe, expect, it } from "vite-plus/test";

import { inferImageExtension, parseBase64DataUrl } from "./imageMime.ts";

describe("imageMime", () => {
  it("parses base64 data URL with mime type", () => {
    expect(parseBase64DataUrl("data:image/png;base64,SGVsbG8=")).toEqual({
      mimeType: "image/png",
      base64: "SGVsbG8=",
    });
  });

  it("parses base64 data URL with mime parameters", () => {
    expect(parseBase64DataUrl("data:image/png;charset=utf-8;base64,SGVsbG8=")).toEqual({
      mimeType: "image/png",
      base64: "SGVsbG8=",
    });
  });

  it("rejects non-base64 data URL", () => {
    expect(parseBase64DataUrl("data:image/png;charset=utf-8,hello")).toBeNull();
  });

  it("rejects missing mime type", () => {
    expect(parseBase64DataUrl("data:;base64,SGVsbG8=")).toBeNull();
  });

  it("parses base64 data URL with spaces in payload", () => {
    expect(parseBase64DataUrl("data:image/png;base64,SGVs bG8=\n")).toEqual({
      mimeType: "image/png",
      base64: "SGVsbG8=",
    });
  });

  it("rejects characters outside the base64 alphabet and malformed padding", () => {
    expect(parseBase64DataUrl("data:image/png;base64,SGVs!bG8=")).toBeNull();
    expect(parseBase64DataUrl("data:image/png;base64,SGVs,bG8=")).toBeNull();
    expect(parseBase64DataUrl("data:image/png;base64,SGV=bG8=")).toBeNull();
    expect(parseBase64DataUrl("data:image/png;base64,SGVsbG8=====AAA")).toBeNull();
    expect(parseBase64DataUrl("data:image/png;base64,SGVsbG8")).toBeNull();
  });

  it("rejects empty payloads and accepts a case-insensitive scheme", () => {
    expect(parseBase64DataUrl("data:image/png;base64,")).toBeNull();
    expect(parseBase64DataUrl("data:image/png;base64, \r\n")).toBeNull();
    expect(parseBase64DataUrl("DATA:IMAGE/PNG;BASE64,SGVsbG8=")).toEqual({
      mimeType: "image/png",
      base64: "SGVsbG8=",
    });
  });

  it("parses a multi-megabyte payload without using the regex stack", () => {
    const payload = "A".repeat(14_000_000);
    const result = parseBase64DataUrl(`data:image/png;base64,${payload}`);
    expect(result?.mimeType).toBe("image/png");
    expect(result?.base64.length).toBe(payload.length);
  });

  it("compacts a whitespace-heavy payload with bounded allocation", () => {
    const dataUrl = `data:image/png;base64,${"AAAA ".repeat(500_000)}`;
    const result = parseBase64DataUrl(dataUrl);
    expect(result?.base64.length).toBe(2_000_000);
    expect(result?.base64.startsWith("AAAAAAAA")).toBe(true);
  });

  it("does not read inherited keys from mime extension map", () => {
    expect(inferImageExtension({ mimeType: "constructor" })).toBe(".bin");
  });
});
