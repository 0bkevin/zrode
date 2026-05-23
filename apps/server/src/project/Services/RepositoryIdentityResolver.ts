import type { RepositoryIdentity } from "@zrode/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface RepositoryIdentityResolverShape {
  readonly resolve: (cwd: string) => Effect.Effect<RepositoryIdentity | null>;
}

export class RepositoryIdentityResolver extends Context.Service<
  RepositoryIdentityResolver,
  RepositoryIdentityResolverShape
>()("zrode/project/Services/RepositoryIdentityResolver") {}
