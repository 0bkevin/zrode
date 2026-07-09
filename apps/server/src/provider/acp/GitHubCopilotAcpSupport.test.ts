// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import {
  buildGitHubCopilotAcpEnvironment,
  buildGitHubCopilotAcpRuntimeOptions,
  buildGitHubCopilotAcpSpawnInput,
  GITHUB_COPILOT_AUTH_METHOD_ID,
  makeGitHubCopilotContinuationGroupKey,
  resolveGitHubCopilotAcpModelId,
  resolveGitHubCopilotEnvironmentAuth,
  resolveGitHubCopilotHomePath,
} from "./GitHubCopilotAcpSupport.ts";

describe("buildGitHubCopilotAcpSpawnInput", () => {
  it("builds the documented GitHub Copilot ACP stdio command", () => {
    expect(buildGitHubCopilotAcpSpawnInput(undefined, "/tmp/project")).toEqual({
      command: "copilot",
      args: ["--acp", "--stdio"],
      cwd: "/tmp/project",
      env: {},
    });
  });

  it("passes configured binary, COPILOT_HOME, and COPILOT_MODEL through env", () => {
    const resolvedHome = NodePath.resolve(NodeOS.homedir(), ".copilot-work");

    expect(
      buildGitHubCopilotAcpSpawnInput(
        { binaryPath: "/usr/local/bin/copilot", homePath: "  ~/.copilot-work  " },
        "/tmp/project",
        {
          GH_TOKEN: "secret",
          COPILOT_MODEL: "gpt-5.4",
        },
        " claude-sonnet-4.6 ",
      ),
    ).toEqual({
      command: "/usr/local/bin/copilot",
      args: ["--acp", "--stdio"],
      cwd: "/tmp/project",
      env: {
        GH_TOKEN: "secret",
        COPILOT_HOME: resolvedHome,
        COPILOT_MODEL: "claude-sonnet-4.6",
      },
    });
  });
});

describe("buildGitHubCopilotAcpEnvironment", () => {
  it("does not force COPILOT_MODEL when no model is supplied", () => {
    expect(
      buildGitHubCopilotAcpEnvironment({
        copilotSettings: { binaryPath: "copilot", homePath: "" },
        environment: { GITHUB_TOKEN: "secret" },
      }),
    ).toEqual({ GITHUB_TOKEN: "secret" });
  });
});

describe("resolveGitHubCopilotHomePath", () => {
  it("resolves configured and default Copilot home paths predictably", () => {
    const configuredHome = NodePath.resolve(NodeOS.homedir(), ".copilot-work");
    const defaultHome = NodePath.resolve(NodeOS.homedir(), ".copilot");

    expect(
      resolveGitHubCopilotHomePath({ binaryPath: "copilot", homePath: "~/.copilot-work" }),
    ).toBe(configuredHome);
    expect(resolveGitHubCopilotHomePath({ binaryPath: "copilot", homePath: "" })).toBe(defaultHome);
    expect(
      makeGitHubCopilotContinuationGroupKey({
        binaryPath: "copilot",
        homePath: "~/.copilot-work",
      }),
    ).toBe(`githubCopilot:home:${configuredHome}`);
    expect(makeGitHubCopilotContinuationGroupKey({ binaryPath: "copilot", homePath: "" })).toBe(
      `githubCopilot:home:${defaultHome}`,
    );
  });
});

describe("buildGitHubCopilotAcpRuntimeOptions", () => {
  it("keeps token-based starts passive and only configures auth as a fallback", () => {
    const options = buildGitHubCopilotAcpRuntimeOptions({
      copilotSettings: { binaryPath: "copilot", homePath: "" },
      cwd: "/tmp/project",
      environment: { GH_TOKEN: "secret" },
      clientInfo: { name: "zrode-test", version: "0.0.0" },
    });

    expect(options.authMethodId).toBe(GITHUB_COPILOT_AUTH_METHOD_ID);
    expect(options.skipAuthenticate).toBe(true);
    expect(options.authenticateOnSessionAuthFailure).toBe(true);
    expect(options.spawn.env).toEqual({ GH_TOKEN: "secret" });
  });
});

describe("resolveGitHubCopilotAcpModelId", () => {
  it("defaults empty model ids to auto", () => {
    expect(resolveGitHubCopilotAcpModelId(undefined)).toBe("auto");
    expect(resolveGitHubCopilotAcpModelId("   ")).toBe("auto");
    expect(resolveGitHubCopilotAcpModelId("  gpt-5.4  ")).toBe("gpt-5.4");
  });
});

describe("resolveGitHubCopilotEnvironmentAuth", () => {
  it("detects documented environment tokens in precedence order", () => {
    expect(
      resolveGitHubCopilotEnvironmentAuth({
        GITHUB_TOKEN: "github-token",
        GH_TOKEN: "gh-token",
        COPILOT_GITHUB_TOKEN: "copilot-token",
      }),
    ).toEqual({
      status: "authenticated",
      type: "token",
      label: "COPILOT_GITHUB_TOKEN",
    });
    expect(resolveGitHubCopilotEnvironmentAuth({ GH_TOKEN: "  " })).toBeNull();
  });
});
