import {
  FileRenderer,
  type FileContents,
  type HighlightedToken,
  type RenderedFileASTCache,
  type RenderFileOptions,
  type ThemedFileResult,
  VirtualizedFile,
  Virtualizer,
} from "@pierre/diffs";
import { TextDocument } from "@pierre/diffs/editor";
import { describe, expect, it, vi } from "vite-plus/test";

const renderOptions = {
  theme: "dark-plus",
  tokenizeMaxLineLength: 20_000,
  useTokenTransformer: true,
} satisfies RenderFileOptions;

type LineCache = { cacheKey: string; lines: string[] };

type RendererInternals = {
  asyncHighlight: (file: FileContents) => Promise<{
    options: RenderFileOptions;
    result: ThemedFileResult;
    source: FileContents;
  }>;
  initializeHighlighter: () => Promise<unknown>;
  computedLang: string;
  lineCache: LineCache | undefined;
  onHighlightSuccess: (
    file: FileContents,
    result: ThemedFileResult,
    options: RenderFileOptions,
    highlighted?: boolean,
    source?: FileContents,
  ) => void;
  renderCache: RenderedFileASTCache | undefined;
  renderFileWithHighlighter: (
    file: FileContents,
    highlighter: unknown,
    forcePlainText?: boolean,
  ) => { options: RenderFileOptions; result: ThemedFileResult };
  textDoucmentCache: WeakMap<FileContents, TextDocument<unknown>>;
};

function getInternals(renderer: FileRenderer): RendererInternals {
  return renderer as unknown as RendererInternals;
}

function textLine(value: string): ThemedFileResult["code"][number] {
  return { type: "text", value };
}

function resultFor(...lines: string[]): ThemedFileResult {
  return {
    baseThemeType: "dark",
    code: lines.map(textLine),
    themeStyles: "",
  };
}

function installRenderCache(
  renderer: FileRenderer,
  file: FileContents,
  result: ThemedFileResult | undefined,
  highlighted = true,
): RenderedFileASTCache {
  const cache = {
    file,
    highlighted,
    options: renderOptions,
    renderRange: undefined,
    result,
  } satisfies RenderedFileASTCache;
  getInternals(renderer).renderCache = cache;
  return cache;
}

function createLiveFixture(highlighted = true) {
  const onRenderUpdate = vi.fn();
  const renderer = new FileRenderer(renderOptions, onRenderUpdate);
  const file = {
    cacheKey: "editable-demo",
    contents: "const oldValue = 1;",
    name: "demo.ts",
  } satisfies FileContents;
  const cache = installRenderCache(renderer, file, resultFor("const oldValue = 1;"), highlighted);
  const liveText = "const liveValue = 2;\nreturn liveValue;";
  renderer.applyDocumentChange(new TextDocument("demo.ts", liveText, "typescript"));

  return {
    cache,
    file,
    internals: getInternals(renderer),
    liveSource: { ...file, contents: liveText },
    liveText,
    onRenderUpdate,
    renderer,
  };
}

function expectRejectedWithoutMutation(
  fixture: ReturnType<typeof createLiveFixture>,
  request: FileContents,
  result: ThemedFileResult,
  options: RenderFileOptions,
  source?: FileContents,
) {
  const { cache, internals, onRenderUpdate } = fixture;
  const before = structuredClone(cache);

  internals.onHighlightSuccess(request, result, options, true, source);

  expect(internals.renderCache).toBe(cache);
  expect(internals.renderCache).toEqual(before);
  expect(onRenderUpdate).not.toHaveBeenCalled();
}

describe("Pierre editable file highlighting", () => {
  it("preserves editor-driven scrolls and clamps stale space below the file", () => {
    const markDOMDirty = vi.fn();
    const scrollTo = vi.fn();
    const scrollContainer = {
      clientHeight: 400,
      scrollHeight: 1_000,
      scrollTop: 900,
      scrollTo,
    };
    const fixture = {
      getScrollContainerElement: () => scrollContainer,
      markDOMDirty,
      programmaticScrollPending: false,
    };
    const patchedPrototype = Virtualizer.prototype as unknown as {
      beginProgrammaticScroll(this: typeof fixture): void;
      finishProgrammaticScroll(this: typeof fixture): void;
    };

    Reflect.apply(patchedPrototype.beginProgrammaticScroll, fixture, []);
    expect(fixture.programmaticScrollPending).toBe(true);

    Reflect.apply(patchedPrototype.finishProgrammaticScroll, fixture, []);
    expect(scrollTo).toHaveBeenCalledWith({ top: 600, behavior: "instant" });
    expect(markDOMDirty).toHaveBeenCalledTimes(1);

    scrollTo.mockClear();
    scrollContainer.scrollTop = 500;
    Reflect.apply(patchedPrototype.finishProgrammaticScroll, fixture, []);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("syncs same-line virtualized edits without invalidating scroll layout", () => {
    const applyDocumentChange = vi.fn();
    const markDOMDirty = vi.fn();
    const computeApproximateSize = vi.fn();
    const reconcileHeights = vi.fn(() => false);
    const heights = new Map([[0, 20]]);
    const checkpoints = [{ lineIndex: 0, top: 0 }];
    const fixture = {
      cache: { heights, checkpoints },
      computeApproximateSize,
      fileRenderer: { applyDocumentChange },
      getSimpleVirtualizer: () => ({ markDOMDirty }),
      isSimpleMode: () => true,
      layoutDirty: false,
      lineAnnotations: [],
      reconcileHeights,
      renderRange: undefined,
    };
    const document = new TextDocument<unknown>(
      "demo.ts",
      "const updated = true;\nreturn updated;",
      "typescript",
    );

    Reflect.apply(VirtualizedFile.prototype.applyDocumentChange, fixture, [
      document,
      undefined,
      false,
      false,
    ]);

    expect(applyDocumentChange).toHaveBeenCalledWith(document);
    expect(reconcileHeights).toHaveBeenCalledTimes(1);
    expect(markDOMDirty).not.toHaveBeenCalled();
    expect(computeApproximateSize).not.toHaveBeenCalled();
    expect(fixture.layoutDirty).toBe(false);
    expect(heights.size).toBe(1);
    expect(checkpoints).toHaveLength(1);

    Reflect.apply(VirtualizedFile.prototype.applyDocumentChange, fixture, [
      document,
      undefined,
      false,
      true,
    ]);

    expect(markDOMDirty).toHaveBeenCalledTimes(1);
    expect(computeApproximateSize).toHaveBeenCalledTimes(1);
    expect(fixture.layoutDirty).toBe(true);
    expect(heights.size).toBe(0);
    expect(checkpoints).toHaveLength(0);
  });

  it("reconciles variable-height rows after same-line edits without clearing layout caches", () => {
    const applyDocumentChange = vi.fn();
    const instanceChanged = vi.fn();
    const markDOMDirty = vi.fn();
    const reconcileHeights = vi.fn(() => true);
    const heights = new Map([[4, 100]]);
    const checkpoints = [{ lineIndex: 0, top: 0 }];
    const fixture = {
      cache: { heights, checkpoints },
      fileRenderer: { applyDocumentChange },
      getSimpleVirtualizer: () => ({ markDOMDirty }),
      layoutDirty: false,
      lineAnnotations: [],
      reconcileHeights,
      renderRange: undefined,
      virtualizer: { instanceChanged },
    };
    const document = new TextDocument<unknown>(
      "wrapped.ts",
      "const shortened = true;\nreturn shortened;",
      "typescript",
    );

    Reflect.apply(VirtualizedFile.prototype.applyDocumentChange, fixture, [
      document,
      undefined,
      false,
      false,
    ]);

    expect(applyDocumentChange).toHaveBeenCalledWith(document);
    expect(reconcileHeights).toHaveBeenCalledTimes(1);
    expect(markDOMDirty).toHaveBeenCalledTimes(1);
    expect(instanceChanged).toHaveBeenCalledWith(fixture, false);
    expect(fixture.layoutDirty).toBe(false);
    expect(heights).toEqual(new Map([[4, 100]]));
    expect(checkpoints).toEqual([{ lineIndex: 0, top: 0 }]);
  });

  it("synchronizes the live document and line cache even without a render result", () => {
    const renderer = new FileRenderer(renderOptions);
    const file = {
      cacheKey: "result-null",
      contents: "let value = 1;",
      name: "demo.ts",
    } satisfies FileContents;
    const cache = installRenderCache(renderer, file, undefined);
    const internals = getInternals(renderer);
    const document = new TextDocument("demo.ts", "let value = 2;\r\nvalue += 1;", "typescript");

    expect(renderer.getOrCreateLineCache(file)).toEqual(["let value = 1;"]);
    renderer.applyDocumentChange(document);

    expect(cache.result).toBeUndefined();
    expect(internals.textDoucmentCache.get(file)).toBe(document);
    expect(renderer.getLineCount(file)).toBe(2);
    expect(renderer.getOrCreateLineCache(file)).toEqual(["let value = 2;\r\n", "value += 1;"]);
  });

  it("uses the TextDocument as the exact source of truth for same-line edits", () => {
    const renderer = new FileRenderer(renderOptions);
    const file = {
      cacheKey: "same-line",
      contents: "const value = 1;\nconsume(value);",
      name: "demo.ts",
    } satisfies FileContents;
    const result = resultFor("const value = 1;", "consume(value);");
    installRenderCache(renderer, file, result);
    const originalLine = result.code[0];

    expect(renderer.getOrCreateLineCache(file)).toEqual(["const value = 1;\n", "consume(value);"]);
    renderer.updateRenderCache(
      new Map<number, HighlightedToken[]>([[0, [[0, "#ffffff", "const value = 10;"]]]]),
      "dark",
    );

    expect(result.code[0]).not.toBe(originalLine);
    expect(renderer.getOrCreateLineCache(file)[0]).toBe("const value = 1;\n");

    const document = new TextDocument(
      "demo.ts",
      "const value = 10;\nconsume(value);",
      "typescript",
    );
    renderer.applyDocumentChange(document);

    expect(result.code).toHaveLength(2);
    expect(renderer.getOrCreateLineCache(file)).toEqual(["const value = 10;\n", "consume(value);"]);
    expect(getInternals(renderer).textDoucmentCache.get(file)).toBe(document);
  });

  it("grows and shrinks the result and CRLF line cache to the exact live size", () => {
    const renderer = new FileRenderer(renderOptions);
    const file = {
      cacheKey: "crlf-resize",
      contents: "first\r\nsecond",
      name: "demo.ts",
    } satisfies FileContents;
    const result = resultFor("first", "second");
    const cache = installRenderCache(renderer, file, result);

    renderer.applyDocumentChange(
      new TextDocument("demo.ts", "first\r\nsecond\r\nthird\r\n", "typescript"),
    );

    expect(renderer.getOrCreateLineCache(file)).toEqual([
      "first\r\n",
      "second\r\n",
      "third\r\n",
      "",
    ]);
    expect(result.code).toHaveLength(4);
    expect(cache.isDirty).toBe(true);

    renderer.applyDocumentChange(new TextDocument("demo.ts", "first", "typescript"));

    expect(renderer.getOrCreateLineCache(file)).toEqual(["first"]);
    expect(result.code).toHaveLength(1);
  });

  it("resolves the live source after highlighter initialization finishes", async () => {
    const renderer = new FileRenderer(renderOptions);
    const file = {
      cacheKey: "await-live-source",
      contents: "const before = 1;",
      name: "demo.ts",
    } satisfies FileContents;
    installRenderCache(renderer, file, undefined);
    const internals = getInternals(renderer);
    let finishInitialization: ((highlighter: unknown) => void) | undefined;
    const initialization = new Promise<unknown>((resolve) => {
      finishInitialization = resolve;
    });
    internals.initializeHighlighter = () => initialization;
    let tokenizedSource: FileContents | undefined;
    internals.renderFileWithHighlighter = (source) => {
      tokenizedSource = source;
      return {
        options: renderOptions,
        result: resultFor("const after = 2;"),
      };
    };

    const highlight = internals.asyncHighlight(file);
    const liveText = "const after = 2;";
    renderer.applyDocumentChange(new TextDocument("demo.ts", liveText, "typescript"));
    finishInitialization?.({});

    const highlighted = await highlight;
    expect(tokenizedSource).toEqual({ ...file, contents: liveText });
    expect(highlighted.source).toEqual({ ...file, contents: liveText });
  });

  it("uses the live document for an already-loaded synchronous full re-highlight", async () => {
    const renderer = new FileRenderer(renderOptions);
    const file = {
      cacheKey: "sync-live-source",
      contents: "const baseline = 1;",
      name: "demo.ts",
    } satisfies FileContents;
    const internals = getInternals(renderer);
    internals.computedLang = "typescript";
    await renderer.initializeHighlighter();
    installRenderCache(renderer, file, resultFor("const baseline = 1;"));

    const liveText = "const live = 2;";
    renderer.applyDocumentChange(new TextDocument("demo.ts", liveText, "typescript"));
    const changedOptions = {
      ...renderOptions,
      tokenizeMaxLineLength: renderOptions.tokenizeMaxLineLength - 1,
    } satisfies RenderFileOptions;
    renderer.setOptions(changedOptions);
    const liveResult = resultFor(liveText);
    let tokenizedSource: FileContents | undefined;
    internals.renderFileWithHighlighter = (source) => {
      tokenizedSource = source;
      return { options: changedOptions, result: liveResult };
    };

    renderer.renderFile(file);

    expect(tokenizedSource).toEqual({ ...file, contents: liveText });
    expect(internals.renderCache?.file).toBe(file);
    expect(internals.renderCache?.result).toBe(liveResult);
  });

  it("rejects a worker result made from the baseline contents without mutation", () => {
    const fixture = createLiveFixture();

    expectRejectedWithoutMutation(
      fixture,
      fixture.file,
      resultFor("const oldValue = 1;", "return oldValue;"),
      renderOptions,
    );
  });

  it("rejects a highlight requested for an obsolete canonical file without mutation", () => {
    const fixture = createLiveFixture();
    const obsoleteRequest = {
      ...fixture.file,
      contents: "const obsolete = true;",
    };

    expectRejectedWithoutMutation(
      fixture,
      obsoleteRequest,
      resultFor("const liveValue = 2;", "return liveValue;"),
      renderOptions,
      fixture.liveSource,
    );
  });

  it("rejects a highlight with obsolete options without mutation", () => {
    const fixture = createLiveFixture();
    fixture.renderer.setOptions({ ...renderOptions, theme: "light-plus" });

    expectRejectedWithoutMutation(
      fixture,
      fixture.file,
      resultFor("const liveValue = 2;", "return liveValue;"),
      renderOptions,
      fixture.liveSource,
    );
  });

  it("rejects a highlight with the wrong live line count without mutation", () => {
    const fixture = createLiveFixture();

    expectRejectedWithoutMutation(
      fixture,
      fixture.file,
      resultFor("const liveValue = 2;"),
      renderOptions,
      fixture.liveSource,
    );
  });

  it("accepts a valid live result while preserving the canonical file identity", () => {
    const fixture = createLiveFixture(false);
    const acceptedResult = resultFor("const liveValue = 2;", "return liveValue;");

    fixture.internals.onHighlightSuccess(
      fixture.file,
      acceptedResult,
      renderOptions,
      true,
      fixture.liveSource,
    );

    expect(fixture.internals.renderCache).not.toBe(fixture.cache);
    expect(fixture.internals.renderCache?.file).toBe(fixture.file);
    expect(fixture.internals.renderCache?.result).toBe(acceptedResult);
    expect(fixture.internals.renderCache?.highlighted).toBe(true);
    expect(fixture.onRenderUpdate).toHaveBeenCalledTimes(1);
  });

  it("notifies when a valid live result replaces an already-highlighted result", () => {
    const fixture = createLiveFixture(true);
    const acceptedResult = resultFor("const liveValue = 2;", "return liveValue;");

    fixture.internals.onHighlightSuccess(
      fixture.file,
      acceptedResult,
      renderOptions,
      true,
      fixture.liveSource,
    );

    expect(fixture.internals.renderCache?.result).toBe(acceptedResult);
    expect(fixture.internals.renderCache?.highlighted).toBe(true);
    expect(fixture.onRenderUpdate).toHaveBeenCalledTimes(1);
  });
});
