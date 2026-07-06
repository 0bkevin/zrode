import { describe, expect, it } from "vite-plus/test";
import { shouldRestoreTimelineLiveFollowAtEnd } from "./timelineLiveFollow";

describe("timeline live-follow restore", () => {
  it("restores when the same manual interaction is still at the live edge", () => {
    expect(
      shouldRestoreTimelineLiveFollowAtEnd({
        userScrollGeneration: 2,
        currentUserScrollGeneration: 2,
        isAtEnd: true,
        scrollOffset: 120,
        currentScrollOffset: 120.5,
      }),
    ).toBe(true);
  });

  it("does not restore after the user actually scrolls away", () => {
    expect(
      shouldRestoreTimelineLiveFollowAtEnd({
        userScrollGeneration: 2,
        currentUserScrollGeneration: 2,
        isAtEnd: true,
        scrollOffset: 120,
        currentScrollOffset: 96,
      }),
    ).toBe(false);
  });

  it("does not restore stale interactions", () => {
    expect(
      shouldRestoreTimelineLiveFollowAtEnd({
        userScrollGeneration: 2,
        currentUserScrollGeneration: 3,
        isAtEnd: true,
        scrollOffset: 120,
        currentScrollOffset: 120,
      }),
    ).toBe(false);
  });

  it("does not restore away from the live edge", () => {
    expect(
      shouldRestoreTimelineLiveFollowAtEnd({
        userScrollGeneration: 2,
        currentUserScrollGeneration: 2,
        isAtEnd: false,
        scrollOffset: 120,
        currentScrollOffset: 120,
      }),
    ).toBe(false);
  });
});
