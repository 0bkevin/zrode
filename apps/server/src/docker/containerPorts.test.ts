import { describe, expect, it } from "vite-plus/test";

import { isDockerContainerId, parseDockerContainerPorts } from "./containerPorts.ts";

describe("Docker container port parsing", () => {
  it("maps IPv4 and IPv6 published ports to one container", () => {
    const parsed = parseDockerContainerPorts(
      [
        JSON.stringify({
          ID: "abcdef123456",
          Names: "web-app",
          Ports: "0.0.0.0:3000->3000/tcp, [::]:3000->3000/tcp, 127.0.0.1:9229->9229/tcp",
        }),
        "docker warning that is not JSON",
      ].join("\n"),
    );

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.id).toBe("abcdef123456");
    expect(parsed[0]?.name).toBe("web-app");
    expect([...(parsed[0]?.hostPorts ?? [])]).toEqual([3000, 9229]);
  });

  it("rejects values that cannot be Docker container IDs", () => {
    expect(isDockerContainerId("abcdef123456")).toBe(true);
    expect(isDockerContainerId("container-name")).toBe(false);
    expect(isDockerContainerId("abcdef; rm -rf /")).toBe(false);
  });
});
