import type { EnvironmentId, ExecutionEnvironmentDescriptor } from "@zrode/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface ServerEnvironmentShape {
  readonly getEnvironmentId: Effect.Effect<EnvironmentId>;
  readonly getDescriptor: Effect.Effect<ExecutionEnvironmentDescriptor>;
}

export class ServerEnvironment extends Context.Service<ServerEnvironment, ServerEnvironmentShape>()(
  "zrode/environment/Services/ServerEnvironment",
) {}
