export interface DockerContainerPort {
  readonly id: string;
  readonly name: string;
  readonly hostPorts: ReadonlySet<number>;
}

const DOCKER_CONTAINER_ID_PATTERN = /^[a-f0-9]{12,64}$/i;
const PUBLISHED_PORT_PATTERN = /(?:^|,\s*)(?:\[[0-9a-f:]+\]|[0-9a-f:.]+|\*):(\d+)->/gi;

export function isDockerContainerId(value: string): boolean {
  return DOCKER_CONTAINER_ID_PATTERN.test(value);
}

/** Parses the newline-delimited JSON emitted by `docker container ls --format '{{json .}}'`. */
export function parseDockerContainerPorts(raw: string): ReadonlyArray<DockerContainerPort> {
  const containers: DockerContainerPort[] = [];

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    try {
      const value = JSON.parse(trimmed) as Record<string, unknown>;
      const id = typeof value.ID === "string" ? value.ID.trim() : "";
      const name = typeof value.Names === "string" ? value.Names.trim() : "";
      const ports = typeof value.Ports === "string" ? value.Ports : "";
      if (!isDockerContainerId(id) || name.length === 0) continue;

      const hostPorts = new Set<number>();
      for (const match of ports.matchAll(PUBLISHED_PORT_PATTERN)) {
        const port = Number(match[1]);
        if (Number.isInteger(port) && port > 0 && port < 65_536) hostPorts.add(port);
      }
      containers.push({ id, name, hostPorts });
    } catch {
      // Docker may print a warning alongside the formatted records. Ignore it.
    }
  }

  return containers;
}
