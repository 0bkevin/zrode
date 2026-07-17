import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Etag from "effect/unstable/http/Etag";
import { HttpServerResponse } from "effect/unstable/http";

import { WORKSPACE_ASSET_CONTENT_TYPES } from "./AssetMediaTypes.ts";

export type AssetByteRange = { readonly start: number; readonly end: number } | "unsatisfiable";

function parseInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Parse one RFC 9110 byte range. Multi-range requests fall back to a full response. */
export function parseAssetByteRange(header: string, fileSize: number): AssetByteRange | null {
  const value = header.trim();
  if (!value.toLowerCase().startsWith("bytes=")) return null;

  const rangeValue = value.slice(6).trim();
  if (rangeValue.length === 0 || rangeValue.includes(",")) return null;

  const separatorIndex = rangeValue.indexOf("-");
  if (separatorIndex === -1) return null;
  const startPart = rangeValue.slice(0, separatorIndex).trim();
  const endPart = rangeValue.slice(separatorIndex + 1).trim();
  if (startPart === "" && endPart === "") return null;

  if (startPart === "") {
    const suffixLength = parseInteger(endPart);
    if (suffixLength === null) return null;
    if (suffixLength === 0 || fileSize === 0) return "unsatisfiable";
    return { start: Math.max(fileSize - suffixLength, 0), end: fileSize - 1 };
  }

  const start = parseInteger(startPart);
  if (start === null) return null;
  if (endPart === "") {
    return start >= fileSize ? "unsatisfiable" : { start, end: fileSize - 1 };
  }

  const end = parseInteger(endPart);
  if (end === null) return null;
  if (start > end || start >= fileSize) return "unsatisfiable";
  return { start, end: Math.min(end, fileSize - 1) };
}

function stripWeakEtag(value: string): string {
  const trimmed = value.trim();
  return /^w\//i.test(trimmed) ? trimmed.slice(2) : trimmed;
}

function matchesIfNoneMatch(header: string, etag: string | undefined): boolean {
  const normalizedEtag = etag === undefined ? undefined : stripWeakEtag(etag);
  return header.split(",").some((candidate) => {
    const value = candidate.trim();
    return (
      value === "*" ||
      (value.length > 0 && normalizedEtag !== undefined && stripWeakEtag(value) === normalizedEtag)
    );
  });
}

function isNotModifiedSince(header: string, lastModified: string | undefined): boolean {
  if (lastModified === undefined) return false;
  const conditionTime = Date.parse(header);
  const modificationTime = Date.parse(lastModified);
  return (
    !Number.isNaN(conditionTime) &&
    !Number.isNaN(modificationTime) &&
    modificationTime <= conditionTime
  );
}

function matchesIfRange(header: string, etag: string, lastModified: string | undefined): boolean {
  const value = header.trim();
  if (value.startsWith('"')) {
    return !/^w\//i.test(etag) && value === etag;
  }
  if (/^w\//i.test(value)) return false;
  return isNotModifiedSince(value, lastModified);
}

function notModifiedResponse(
  responseHeaders: Record<string, string>,
  etag: string,
  lastModified: string | undefined,
): HttpServerResponse.HttpServerResponse {
  const headers: Record<string, string> = { ...responseHeaders, ETag: etag };
  if (lastModified !== undefined) headers["Last-Modified"] = lastModified;
  return HttpServerResponse.empty({ status: 304, headers });
}

export interface AssetFileRequestHeaders {
  readonly range?: string | undefined;
  readonly "if-range"?: string | undefined;
  readonly "if-none-match"?: string | undefined;
  readonly "if-modified-since"?: string | undefined;
}

const ASSET_BASE_RESPONSE_HEADERS = {
  "Accept-Ranges": "bytes",
  "Cache-Control": "private, no-cache",
  "X-Content-Type-Options": "nosniff",
} as const;

function assetResponseHeaders(path: Path.Path, filePath: string): Record<string, string> {
  const contentType = WORKSPACE_ASSET_CONTENT_TYPES[path.extname(filePath).toLowerCase()];
  return contentType === undefined
    ? ASSET_BASE_RESPONSE_HEADERS
    : { ...ASSET_BASE_RESPONSE_HEADERS, "Content-Type": contentType };
}

/** Stream a signed asset with conditional-request and single-range support. */
export const makeAssetFileResponse = Effect.fn("AssetFileResponse.makeAssetFileResponse")(
  function* (input: {
    readonly path: string;
    readonly contentTypePath?: string | undefined;
    readonly requestHeaders: AssetFileRequestHeaders;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const rangeHeader = input.requestHeaders.range;
    const ifRange = rangeHeader === undefined ? undefined : input.requestHeaders["if-range"];
    const responseHeaders = assetResponseHeaders(path, input.contentTypePath ?? input.path);
    const hasConditionalHeader =
      input.requestHeaders["if-none-match"] !== undefined ||
      input.requestHeaders["if-modified-since"] !== undefined;
    let inspectedFileSize: number | undefined;

    if (hasConditionalHeader || ifRange !== undefined) {
      const info = yield* fileSystem.stat(input.path);
      inspectedFileSize = Number(info.size);
      const etag = yield* Effect.flatMap(Etag.Generator, (generator) =>
        generator.fromFileInfo(info),
      ).pipe(Effect.map(Etag.toString), Effect.provide(Etag.layer));
      const lastModified = Option.getOrUndefined(
        Option.map(info.mtime, (mtime) => mtime.toUTCString()),
      );
      if (hasConditionalHeader) {
        const ifNoneMatch = input.requestHeaders["if-none-match"];
        if (
          (ifNoneMatch !== undefined && matchesIfNoneMatch(ifNoneMatch, etag)) ||
          (ifNoneMatch === undefined &&
            input.requestHeaders["if-modified-since"] !== undefined &&
            isNotModifiedSince(input.requestHeaders["if-modified-since"], lastModified))
        ) {
          return notModifiedResponse(responseHeaders, etag, lastModified);
        }
      }
      if (
        rangeHeader === undefined ||
        (ifRange !== undefined && !matchesIfRange(ifRange, etag, lastModified))
      ) {
        return yield* HttpServerResponse.file(input.path, {
          status: 200,
          headers: responseHeaders,
        });
      }
    }

    if (rangeHeader === undefined) {
      return yield* HttpServerResponse.file(input.path, {
        status: 200,
        headers: responseHeaders,
      });
    }

    const fileSize = inspectedFileSize ?? Number((yield* fileSystem.stat(input.path)).size);
    const range = parseAssetByteRange(rangeHeader, fileSize);
    if (range === null) {
      return yield* HttpServerResponse.file(input.path, {
        status: 200,
        headers: responseHeaders,
      });
    }
    if (range === "unsatisfiable") {
      return HttpServerResponse.empty({
        status: 416,
        headers: {
          ...responseHeaders,
          "Content-Range": `bytes */${fileSize}`,
        },
      });
    }

    return yield* HttpServerResponse.file(input.path, {
      status: 206,
      offset: range.start,
      bytesToRead: range.end - range.start + 1,
      headers: {
        ...responseHeaders,
        "Content-Range": `bytes ${range.start}-${range.end}/${fileSize}`,
      },
    });
  },
);
