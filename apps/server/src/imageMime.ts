import Mime from "@effect/platform-node/Mime";

export const IMAGE_EXTENSION_BY_MIME_TYPE: Record<string, string> = {
  "image/avif": ".avif",
  "image/bmp": ".bmp",
  "image/gif": ".gif",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/svg+xml": ".svg",
  "image/tiff": ".tiff",
  "image/webp": ".webp",
};

export const SAFE_IMAGE_FILE_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".heif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".tiff",
  ".webp",
]);

function isBase64Char(code: number): boolean {
  return (
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x2b ||
    code === 0x2f ||
    code === 0x3d
  );
}

function isBase64Whitespace(code: number): boolean {
  return code === 0x0d || code === 0x0a || code === 0x20;
}

// Never run a regular expression across the payload. V8's regex engine borrows
// the JavaScript stack, so multi-megabyte image payloads can overflow when this
// parser is called from a deeply nested Effect fiber.
export function parseBase64DataUrl(
  dataUrl: string,
): { readonly mimeType: string; readonly base64: string } | null {
  const trimmed = dataUrl.trim();
  if (trimmed.slice(0, 5).toLowerCase() !== "data:") return null;

  const commaIndex = trimmed.indexOf(",");
  if (commaIndex === -1) return null;
  const header = trimmed.slice(5, commaIndex);
  if (header.length === 0) return null;

  const headerParts: Array<string> = [];
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (trimmed.length > 0) {
      headerParts.push(trimmed);
    }
  }
  if (headerParts.length < 2) {
    return null;
  }
  const trailingToken = headerParts.at(-1)?.toLowerCase();
  if (trailingToken !== "base64") {
    return null;
  }

  const mimeType = headerParts[0]?.toLowerCase();
  if (!mimeType) return null;

  const payload = trimmed.slice(commaIndex + 1);
  let compactLength = 0;
  let firstPaddingIndex = -1;
  let hasWhitespace = false;
  for (let index = 0; index < payload.length; index += 1) {
    const code = payload.charCodeAt(index);
    if (isBase64Char(code)) {
      if (code === 0x3d) {
        if (firstPaddingIndex === -1) firstPaddingIndex = compactLength;
      } else if (firstPaddingIndex !== -1) {
        return null;
      }
      compactLength += 1;
      continue;
    }
    if (!isBase64Whitespace(code)) return null;
    hasWhitespace = true;
  }

  if (compactLength === 0 || compactLength % 4 !== 0) return null;
  if (firstPaddingIndex !== -1) {
    if (compactLength - firstPaddingIndex > 2) return null;
  }

  let base64 = payload;
  if (hasWhitespace) {
    // Compact into one bounded byte buffer. Collecting every whitespace-
    // separated run would create millions of tiny strings for inputs such as
    // "A A A …", turning a bounded upload into a GC/OOM hazard.
    const compacted = Buffer.allocUnsafe(compactLength);
    let offset = 0;
    for (let index = 0; index < payload.length; index += 1) {
      const code = payload.charCodeAt(index);
      if (!isBase64Whitespace(code)) {
        compacted[offset] = code;
        offset += 1;
      }
    }
    base64 = compacted.toString("ascii");
  }

  return { mimeType, base64 };
}

export function inferImageExtension(input: { mimeType: string; fileName?: string }): string {
  const key = input.mimeType.toLowerCase();
  const fromMime = Object.hasOwn(IMAGE_EXTENSION_BY_MIME_TYPE, key)
    ? IMAGE_EXTENSION_BY_MIME_TYPE[key]
    : undefined;
  if (fromMime) {
    return fromMime;
  }

  const fromMimeExtension = Mime.getExtension(input.mimeType);
  if (fromMimeExtension && SAFE_IMAGE_FILE_EXTENSIONS.has(fromMimeExtension)) {
    return fromMimeExtension;
  }

  const fileName = input.fileName?.trim() ?? "";
  const extensionMatch = /\.([a-z0-9]{1,8})$/i.exec(fileName);
  const fileNameExtension = extensionMatch ? `.${extensionMatch[1]!.toLowerCase()}` : "";
  if (SAFE_IMAGE_FILE_EXTENSIONS.has(fileNameExtension)) {
    return fileNameExtension;
  }

  return ".bin";
}
