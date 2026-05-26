import {
  DatabaseIcon,
  FileArchiveIcon,
  FileBoxIcon,
  FileCodeIcon,
  FileCogIcon,
  FileDiffIcon,
  FileIcon,
  FileImageIcon,
  FileJsonIcon,
  FileKeyIcon,
  FileLockIcon,
  FileMusicIcon,
  FileSlidersIcon,
  FileSpreadsheetIcon,
  FileTerminalIcon,
  FileTextIcon,
  FileVideoIcon,
} from "lucide-react";
import { describe, expect, it } from "vitest";
import { getFileTypeIcon } from "./fileTypeIcons";

describe("getFileTypeIcon", () => {
  it("uses exact filename matches before extensions", () => {
    expect(getFileTypeIcon("package.json")).toBe(FileBoxIcon);
    expect(getFileTypeIcon("/repo/tsconfig.json")).toBe(FileSlidersIcon);
    expect(getFileTypeIcon("C:\\repo\\.env.local")).toBe(FileLockIcon);
    expect(getFileTypeIcon("README")).toBe(FileTextIcon);
    expect(getFileTypeIcon("Dockerfile.dev")).toBe(FileCogIcon);
    expect(getFileTypeIcon("Makefile.local")).toBe(FileTerminalIcon);
  });

  it("uses extension matches for common file types", () => {
    expect(getFileTypeIcon("src/App.tsx")).toBe(FileCodeIcon);
    expect(getFileTypeIcon("config/settings.jsonc")).toBe(FileJsonIcon);
    expect(getFileTypeIcon("README.md")).toBe(FileTextIcon);
    expect(getFileTypeIcon("assets/logo.png")).toBe(FileImageIcon);
    expect(getFileTypeIcon("notes.patch")).toBe(FileDiffIcon);
    expect(getFileTypeIcon("db/schema.sql")).toBe(DatabaseIcon);
    expect(getFileTypeIcon("reports/summary.xlsx")).toBe(FileSpreadsheetIcon);
    expect(getFileTypeIcon("certs/server.pem")).toBe(FileKeyIcon);
    expect(getFileTypeIcon("release.tar.gz")).toBe(FileArchiveIcon);
    expect(getFileTypeIcon("sound/theme.mp3")).toBe(FileMusicIcon);
    expect(getFileTypeIcon("demo.mov")).toBe(FileVideoIcon);
  });

  it("falls back to the generic file icon for unknown files", () => {
    expect(getFileTypeIcon("unknown.customtype")).toBe(FileIcon);
  });
});
