/** Keep only the most recent bytes from process output without decoding an unbounded string. */
export function appendBoundedBytes(
  current: Uint8Array,
  chunk: Uint8Array,
  limit: number,
): Uint8Array {
  if (chunk.byteLength >= limit) return chunk.slice(chunk.byteLength - limit);
  const keepFromCurrent = Math.min(current.byteLength, limit - chunk.byteLength);
  const previous = current.subarray(current.byteLength - keepFromCurrent);
  const joined = new Uint8Array(previous.byteLength + chunk.byteLength);
  joined.set(previous, 0);
  joined.set(chunk, previous.byteLength);
  return joined;
}

export function decodeBoundedBytes(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8");
}
