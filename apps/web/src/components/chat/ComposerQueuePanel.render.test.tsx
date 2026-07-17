import { MessageId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ComposerQueuePanel } from "./ComposerQueuePanel";

const queuedTurn = {
  messageId: MessageId.make("message-queued-1"),
  text: "Use this guidance next",
  attachments: [],
};

it("renders a discoverable steer action for queued messages", () => {
  const markup = renderToStaticMarkup(
    <ComposerQueuePanel
      queuedTurns={[queuedTurn]}
      onCancel={() => {}}
      onSteer={() => {}}
      canSteer
      steeringMessageIds={new Set()}
    />,
  );

  assert.match(markup, />Steer</);
  const steerButton = markup.match(
    /<button[^>]*aria-label="Steer queued message 1 after the current tool call"[^>]*>/,
  )?.[0];
  assert.ok(steerButton);
  assert.ok(!/\sdisabled(?:=""|(?=[\s>]))/.test(steerButton));
});

it("disables the steer action without an active turn", () => {
  const markup = renderToStaticMarkup(
    <ComposerQueuePanel
      queuedTurns={[queuedTurn]}
      onCancel={() => {}}
      onSteer={() => {}}
      canSteer={false}
      steeringMessageIds={new Set()}
    />,
  );

  const steerButton = markup.match(
    /<button[^>]*aria-label="Steer queued message 1 after the current tool call"[^>]*>/,
  )?.[0];
  assert.ok(steerButton);
  assert.ok(/\sdisabled(?:=""|(?=[\s>]))/.test(steerButton));
});
