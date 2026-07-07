import { DesktopPaneWindowInputSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopWindow from "../../window/DesktopWindow.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const openPaneWindow = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPEN_PANE_WINDOW_CHANNEL,
  payload: DesktopPaneWindowInputSchema,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.window.openPaneWindow")(function* (input) {
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    return yield* desktopWindow.createPane(input);
  }),
});
