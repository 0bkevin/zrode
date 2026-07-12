import { describe, expect, it } from "vite-plus/test";

import { CHAT_MARKDOWN_COMPONENTS } from "./ChatMarkdown";

describe("ChatMarkdown renderer components", () => {
  it("keeps component identities immutable across streaming renders", () => {
    const identities = Object.entries(CHAT_MARKDOWN_COMPONENTS);

    expect(Object.isFrozen(CHAT_MARKDOWN_COMPONENTS)).toBe(true);
    expect(identities.map(([tag]) => tag)).toEqual([
      "p",
      "li",
      "input",
      "a",
      "table",
      "details",
      "pre",
    ]);
    for (const [tag, component] of identities) {
      expect(CHAT_MARKDOWN_COMPONENTS[tag as keyof typeof CHAT_MARKDOWN_COMPONENTS]).toBe(
        component,
      );
    }
  });
});
