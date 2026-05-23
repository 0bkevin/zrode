import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { typescript as monacoTypescript } from "monaco-editor";
import "monaco-editor/min/vs/editor/editor.main.css";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

import { registerAstroLanguage } from "./monaco-languages/register-astro";
import { registerSvelteLanguage } from "./monaco-languages/register-svelte";
import { registerVueLanguage } from "./monaco-languages/register-vue";

export const MONACO_LIGHT_THEME = "zrode-light";
export const MONACO_DARK_THEME = "zrode-dark";

globalThis.MonacoEnvironment = {
  getWorker(_workerId, label) {
    switch (label) {
      case "json":
        return new jsonWorker();
      case "css":
      case "scss":
      case "less":
        return new cssWorker();
      case "html":
      case "handlebars":
      case "razor":
        return new htmlWorker();
      case "typescript":
      case "javascript":
        return new tsWorker();
      default:
        return new editorWorker();
    }
  },
};

const diagnosticsOptions = {
  noSemanticValidation: true,
  noSuggestionDiagnostics: true,
  noSyntaxValidation: true,
};

monacoTypescript.typescriptDefaults.setDiagnosticsOptions(diagnosticsOptions);
monacoTypescript.javascriptDefaults.setDiagnosticsOptions(diagnosticsOptions);

monacoTypescript.typescriptDefaults.setCompilerOptions({
  ...monacoTypescript.typescriptDefaults.getCompilerOptions(),
  jsx: monacoTypescript.JsxEmit.Preserve,
});

monacoTypescript.javascriptDefaults.setCompilerOptions({
  ...monacoTypescript.javascriptDefaults.getCompilerOptions(),
  jsx: monacoTypescript.JsxEmit.Preserve,
});

registerVueLanguage(monaco);
registerSvelteLanguage(monaco);
registerAstroLanguage(monaco);

monaco.editor.defineTheme(MONACO_DARK_THEME, {
  base: "vs-dark",
  inherit: true,
  colors: {
    "editor.background": "#171717",
    "editor.foreground": "#d4d4d4",
    "editorLineNumber.foreground": "#525252",
    "editorLineNumber.activeForeground": "#a3a3a3",
    "editorIndentGuide.background1": "#3f3f46",
    "editorIndentGuide.activeBackground1": "#71717a",
  },
  rules: [
    { token: "comment", foreground: "6A9955" },
    { token: "keyword", foreground: "569CD6" },
    { token: "operator", foreground: "D4D4D4" },
    { token: "string", foreground: "CE9178" },
    { token: "number", foreground: "B5CEA8" },
    { token: "regexp", foreground: "D16969" },
    { token: "type", foreground: "4EC9B0" },
    { token: "class", foreground: "4EC9B0" },
    { token: "interface", foreground: "4EC9B0" },
    { token: "enum", foreground: "4EC9B0" },
    { token: "function", foreground: "DCDCAA" },
    { token: "method", foreground: "DCDCAA" },
    { token: "member", foreground: "9CDCFE" },
    { token: "property", foreground: "9CDCFE" },
    { token: "variable", foreground: "D4D4D4" },
    { token: "parameter", foreground: "9CDCFE" },
    { token: "constant", foreground: "4FC1FF" },
  ],
});

monaco.editor.defineTheme(MONACO_LIGHT_THEME, {
  base: "vs",
  inherit: true,
  colors: {
    "editor.background": "#ffffff",
    "editor.foreground": "#24292f",
    "editorLineNumber.foreground": "#8c959f",
    "editorLineNumber.activeForeground": "#57606a",
    "editorIndentGuide.background1": "#d8dee4",
    "editorIndentGuide.activeBackground1": "#afb8c1",
  },
  rules: [
    { token: "comment", foreground: "6A737D" },
    { token: "keyword", foreground: "D73A49" },
    { token: "operator", foreground: "24292F" },
    { token: "string", foreground: "032F62" },
    { token: "number", foreground: "005CC5" },
    { token: "regexp", foreground: "D73A49" },
    { token: "type", foreground: "6F42C1" },
    { token: "class", foreground: "6F42C1" },
    { token: "interface", foreground: "6F42C1" },
    { token: "enum", foreground: "6F42C1" },
    { token: "function", foreground: "6F42C1" },
    { token: "method", foreground: "6F42C1" },
    { token: "member", foreground: "005CC5" },
    { token: "property", foreground: "005CC5" },
    { token: "variable", foreground: "24292F" },
    { token: "parameter", foreground: "005CC5" },
    { token: "constant", foreground: "005CC5" },
  ],
});

loader.config({ monaco });

export { monaco };
