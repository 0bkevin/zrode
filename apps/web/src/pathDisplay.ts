function trimTrailingPathSeparators(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

function basenameOfPath(path: string): string {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separatorIndex >= 0 ? path.slice(separatorIndex + 1) : path;
}

function isRootPath(path: string): boolean {
  return /^[\\/]+$/.test(path) || /^[A-Za-z]:[\\/]+$/.test(path);
}

export function formatPathTailForDisplay(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return path;
  if (isRootPath(trimmed)) return trimmed;

  const pathWithoutTrailingSeparators = trimTrailingPathSeparators(trimmed);
  const tail = basenameOfPath(pathWithoutTrailingSeparators);
  return tail || trimmed;
}
