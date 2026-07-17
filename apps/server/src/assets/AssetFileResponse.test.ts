import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { WORKSPACE_IMAGE_PREVIEW_CONTENT_TYPES } from "@t3tools/shared/filePreview";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type { HttpServerResponse } from "effect/unstable/http/HttpServerResponse";
import * as NodeStream from "node:stream";

import { makeAssetFileResponse, parseAssetByteRange } from "./AssetFileResponse.ts";

describe("parseAssetByteRange", () => {
  it("parses bounded, open-ended, and suffix ranges", () => {
    expect(parseAssetByteRange("bytes=2-5", 10)).toEqual({ start: 2, end: 5 });
    expect(parseAssetByteRange("bytes=7-", 10)).toEqual({ start: 7, end: 9 });
    expect(parseAssetByteRange("bytes=-4", 10)).toEqual({ start: 6, end: 9 });
    expect(parseAssetByteRange("bytes=2-50", 10)).toEqual({ start: 2, end: 9 });
  });

  it("rejects unsupported ranges and identifies unsatisfiable ranges", () => {
    expect(parseAssetByteRange("items=0-1", 10)).toBeNull();
    expect(parseAssetByteRange("bytes=0-1,4-5", 10)).toBeNull();
    expect(parseAssetByteRange("bytes=10-", 10)).toBe("unsatisfiable");
    expect(parseAssetByteRange("bytes=-0", 10)).toBe("unsatisfiable");
  });
});

const testLayer = Layer.mergeAll(NodeServices.layer, NodeHttpPlatform.layer);

async function readResponseBody(response: HttpServerResponse): Promise<string> {
  if (response.body._tag !== "Raw" || !(response.body.body instanceof NodeStream.Readable)) {
    throw new Error(`Expected a Node raw response body, received ${response.body._tag}.`);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of response.body.body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

describe("makeAssetFileResponse", () => {
  it.effect("returns a partial file response with cache-safe headers", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "asset-range-" });
      const filePath = path.join(directory, "sample.pdf");
      yield* fileSystem.writeFileString(filePath, "0123456789");

      const response = yield* makeAssetFileResponse({
        path: filePath,
        requestHeaders: { range: "bytes=2-5" },
      });

      expect(response.status).toBe(206);
      expect(response.headers["content-range"]).toBe("bytes 2-5/10");
      expect(response.headers["content-length"]).toBe("4");
      expect(response.headers["accept-ranges"]).toBe("bytes");
      expect(response.headers["cache-control"]).toBe("private, no-cache");
      expect(response.headers["content-type"]).toBe("application/pdf");
      expect(yield* Effect.promise(() => readResponseBody(response))).toBe("2345");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("returns 416 for an unsatisfiable range", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "asset-range-" });
      const filePath = path.join(directory, "sample.pdf");
      yield* fileSystem.writeFileString(filePath, "0123456789");

      const response = yield* makeAssetFileResponse({
        path: filePath,
        requestHeaders: { range: "bytes=10-" },
      });

      expect(response.status).toBe(416);
      expect(response.headers["content-range"]).toBe("bytes */10");
      expect(response.headers["content-type"]).toBe("application/pdf");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("returns a full representation when If-Range no longer matches", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "asset-if-range-" });
      const filePath = path.join(directory, "sample.pdf");
      yield* fileSystem.writeFileString(filePath, "0123456789");

      const response = yield* makeAssetFileResponse({
        path: filePath,
        requestHeaders: { range: "bytes=2-5", "if-range": '"stale-validator"' },
      });

      expect(response.status).toBe(200);
      expect(response.headers["content-range"]).toBeUndefined();
      expect(response.headers["content-length"]).toBe("10");
      expect(yield* Effect.promise(() => readResponseBody(response))).toBe("0123456789");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("honors a range when If-Range has the current strong ETag", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "asset-if-range-" });
      const filePath = path.join(directory, "sample.pdf");
      yield* fileSystem.writeFileString(filePath, "0123456789");
      const fullResponse = yield* makeAssetFileResponse({
        path: filePath,
        requestHeaders: {},
      });
      const etag = fullResponse.headers.etag;
      expect(etag).toBeDefined();
      yield* Effect.promise(() => readResponseBody(fullResponse));

      const response = yield* makeAssetFileResponse({
        path: filePath,
        requestHeaders: { range: "bytes=2-5", "if-range": etag },
      });

      expect(response.status).toBe(206);
      expect(response.headers["content-range"]).toBe("bytes 2-5/10");
      expect(yield* Effect.promise(() => readResponseBody(response))).toBe("2345");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("returns validator and security headers with a 304 response", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "asset-conditional-" });
      const filePath = path.join(directory, "sample.pdf");
      yield* fileSystem.writeFileString(filePath, "0123456789");
      const fullResponse = yield* makeAssetFileResponse({ path: filePath, requestHeaders: {} });
      const etag = fullResponse.headers.etag;
      expect(etag).toBeDefined();
      yield* Effect.promise(() => readResponseBody(fullResponse));

      const response = yield* makeAssetFileResponse({
        path: filePath,
        requestHeaders: { "if-none-match": etag },
      });

      expect(response.status).toBe(304);
      expect(response.headers.etag).toBe(etag);
      expect(response.headers["accept-ranges"]).toBe("bytes");
      expect(response.headers["cache-control"]).toBe("private, no-cache");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("provides deterministic MIME types for every supported image extension", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "asset-mime-" });
      for (const [extension, contentType] of Object.entries(
        WORKSPACE_IMAGE_PREVIEW_CONTENT_TYPES,
      )) {
        const filePath = path.join(directory, `sample${extension}`);
        yield* fileSystem.writeFileString(filePath, "preview");
        const response = yield* makeAssetFileResponse({ path: filePath, requestHeaders: {} });
        expect(response.headers["content-type"], extension).toBe(contentType);
        yield* Effect.promise(() => readResponseBody(response));
      }
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("uses the authorized logical path for MIME type instead of a canonical target", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "asset-mime-binding-",
      });
      const canonicalPath = path.join(directory, "payload.html");
      yield* fileSystem.writeFileString(
        canonicalPath,
        "<script>throw new Error('unsafe')</script>",
      );

      const response = yield* makeAssetFileResponse({
        path: canonicalPath,
        contentTypePath: "report.pdf",
        requestHeaders: {},
      });

      expect(response.headers["content-type"]).toBe("application/pdf");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      yield* Effect.promise(() => readResponseBody(response));
    }).pipe(Effect.provide(testLayer)),
  );
});
