export function formatRuntimeBytes(value: number): string {
  if (value < 1_024) return `${Math.round(value)} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let amount = value;
  let unitIndex = -1;
  do {
    amount /= 1_024;
    unitIndex += 1;
  } while (amount >= 1_024 && unitIndex < units.length - 1);
  return `${amount >= 10 ? Math.round(amount) : amount.toFixed(1)} ${units[unitIndex]}`;
}

export function formatRuntimeCpu(value: number): string {
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)}%`;
}
