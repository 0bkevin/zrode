import { projectFileCacheKey } from "./fileContentRevision";

export interface EditorFileRef {
  name: string;
  contents: string;
  cacheKey: string;
}

export interface EditorFileState {
  file: EditorFileRef;
  editorContents: string;
  externalRevision: number;
}

function editorFileRef(
  cwd: string,
  relativePath: string,
  contents: string,
  externalRevision: number,
): EditorFileRef {
  return {
    name: relativePath,
    contents,
    cacheKey: `${projectFileCacheKey(cwd, relativePath, contents)}:external:${externalRevision}`,
  };
}

export function createEditorFileState(
  cwd: string,
  relativePath: string,
  contents: string,
  externalRevision = 0,
): EditorFileState {
  return {
    file: editorFileRef(cwd, relativePath, contents, externalRevision),
    editorContents: contents,
    externalRevision,
  };
}

export function adoptExternalEditorFileState(
  current: EditorFileState,
  cwd: string,
  relativePath: string,
  contents: string,
): EditorFileState {
  return createEditorFileState(cwd, relativePath, contents, current.externalRevision + 1);
}

export function updateLocalEditorContents(
  current: EditorFileState,
  contents: string,
): EditorFileState {
  return current.editorContents === contents ? current : { ...current, editorContents: contents };
}
