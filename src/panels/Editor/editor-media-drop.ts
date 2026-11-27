// 往编辑器里粘贴 / 拖入文件(对齐 VSCode;BDD: src/__tests__/markdown-image-paste/、src/__tests__/explorer-drag-out/):
// - Markdown 文档里粘贴截图 / 从 Finder 拖入图片(markdown-language-features ResourcePasteOrDropProvider + copyFiles):
//   已在工作区内的图片直接引用;其余(剪贴板图片数据、工作区外的文件)复制到文档所在目录(markdown.copyFiles.destination 缺省),
//   重名加序号(`image-1.png`),再插入指向它的相对路径。绝不插入 blob: / data: 地址 —— 存不下来就提示并且什么都不插。
// - 从资源管理器拖到编辑器内容区:只打开(交给 dockview,见 explorer-editor-drop);按住 ⇧ 放下才插入 ——
//   Markdown 插入相对文档的链接(图片 `![alt text](…)`,其余 `[text](…)`),其它文件插入相对工作区根的路径
//   (editor RelativePathProvider)。
import { t } from '@/i18n';
import { coApi } from '@/lib/co-api';
import { failureOf, type Failure } from '@/lib/failure-of';
import { fileUrlOf, hasExplorerDrag, type ExplorerDragEntry } from '@/lib/explorer-drag';
import { hasFiles } from '@/lib/window-drop';
import {
  basename,
  dirname,
  isAbsolutePath,
  isSameOrInsidePath,
  isWindowsRuntime,
  splitPathSegments,
  stripRootPrefix,
} from '@/lib/path-cross';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { notify } from '@/notifications/notify';
import { fileFailureText } from '@/notifications/notify-open-failed';
import { lowerIfNeeded } from '../../../electron/shared/lower-if-needed';
import { imageMimeOf } from '../../../electron/shared/image-preview';
import { documentImageMimeOfName, isDocumentImageMime } from '../../../electron/shared/document-image';
import type { IpcResult } from '../../../electron/shared/ipc-result';

/** VSCode 图片片段的 alt 占位文字(createUriListSnippet:`![alt text](path)`)。 */
export const IMAGE_ALT_PLACEHOLDER = 'alt text';
/** VSCode 链接片段的文字占位(`[text](path)`)。 */
export const LINK_TEXT_PLACEHOLDER = 'text';
/** 一次粘贴 / 拖入最多处理的图片数。 */
export const MAX_MEDIA_FILES = 50;

/**
 * Markdown 链接目标的转义(VSCode shared.ts escapeMarkdownLinkPath):含空白 / 控制字符、以 `<` 开头、括号不配对 → 包进 `<…>`
 *(其中的 `<` `>` 加反斜杠);其余原样(不做 %20 编码)。
 */
export function escapeMarkdownLinkPath(mdPath: string): string {
  if (needsBracketLink(mdPath)) return `<${mdPath.replaceAll('<', '\\<').replaceAll('>', '\\>')}>`;
  return mdPath;
}

function needsBracketLink(mdPath: string): boolean {
  // eslint-disable-next-line no-control-regex
  if (mdPath.startsWith('<') || /\s|[\u007F\u0000-\u001f]/.test(mdPath)) return true;
  if (!/[()]/.test(mdPath)) return false;
  let previous = '';
  let nesting = 0;
  for (const ch of mdPath) {
    if (ch === '(' && previous !== '\\') nesting++;
    else if (ch === ')' && previous !== '\\') nesting--;
    if (nesting < 0) return true;
    previous = ch;
  }
  return nesting > 0;
}

/**
 * fromDir → target 的相对路径(`/` 分隔;VSCode getRelativeMdPath)。不在同一根下(Windows 不同盘符 / UNC 主机)→ target 的
 * file:// URL(VSCode 同:取不到相对路径时用 uri 原文)。
 */
export function relativeLinkPath(fromDir: string, target: string): string {
  const windowsLike = isWindowsRuntime() || /^(?:[A-Za-z]:|\\\\)/.test(fromDir);
  const fold = windowsLike ? lowerIfNeeded : (s: string): string => s;
  const from = splitPathSegments(fromDir).filter((s) => s !== '');
  const to = splitPathSegments(target, fromDir).filter((s) => s !== '');
  if (windowsLike && fold(from[0] ?? '') !== fold(to[0] ?? '')) return fileUrlOf(target);
  let common = 0;
  while (common < from.length && common < to.length && fold(from[common]!) === fold(to[common]!)) common++;
  return [...from.slice(common).map(() => '..'), ...to.slice(common)].join('/');
}

/** 可以作为图片插入的文件(类型是允许的图片;类型为空时按扩展名)。 */
export function isInsertableImageFile(file: Pick<File, 'type' | 'name'>): boolean {
  return file.type === '' ? documentImageMimeOfName(file.name) !== null : isDocumentImageMime(file.type);
}

/** 从 FileList(事件期内同步)取出可插入的图片,最多 MAX_MEDIA_FILES 个。 */
export function takeImageFiles(files: ArrayLike<File> | null | undefined): File[] {
  const out: File[] = [];
  if (!files) return out;
  for (let i = 0; i < files.length && out.length < MAX_MEDIA_FILES; i++) {
    const file = files[i];
    if (file && isInsertableImageFile(file)) out.push(file);
  }
  return out;
}

export interface MediaStoreDeps {
  readonly getPathForFile: (file: File) => string;
  readonly workspaceRoot: () => string | null;
  readonly readBytes: (file: File) => Promise<Uint8Array>;
  readonly saveImage: (documentPath: string, fileName: string, data: Uint8Array) => Promise<IpcResult<string>>;
}

export const defaultMediaStoreDeps: MediaStoreDeps = {
  getPathForFile: (file) => {
    try {
      return coApi.window.getPathForFile(file);
    } catch {
      return ''; // 剪贴板 / 合成的 File 没有磁盘路径
    }
  },
  workspaceRoot: () => useWorkspaceStore.getState().root,
  readBytes: async (file) => new Uint8Array(await file.arrayBuffer()),
  saveImage: (documentPath, fileName, data) => coApi.fs.saveDocumentImage(documentPath, fileName, data),
};

/**
 * 粘贴 / 拖入的图片 → 文档可引用的图片文件绝对路径(顺序同 files):工作区内的磁盘文件直接用;其余复制到文档所在目录(主进程生成
 * 文件名、不覆盖)。文档没保存过(无标题)/ 不在工作区内 / 写入失败 → 提示,该图片不返回(全部失败 → 空数组,调用方什么都不插)。
 */
export async function storeImagesForDocument(
  documentPath: string | null | undefined,
  files: readonly File[],
  deps: MediaStoreDeps = defaultMediaStoreDeps,
): Promise<string[]> {
  if (files.length === 0) return [];
  if (!documentPath || !isAbsolutePath(documentPath)) {
    notify.warn(t('editor.media.save_document_first'));
    return [];
  }
  const root = deps.workspaceRoot();
  const out: string[] = [];
  let failure: { name: string; failure: Failure } | null = null;
  let outside = false;
  for (const file of files) {
    const diskPath = deps.getPathForFile(file);
    if (diskPath !== '' && root !== null && isSameOrInsidePath(root, diskPath)) {
      out.push(diskPath);
      continue;
    }
    if (root === null || !isSameOrInsidePath(root, documentPath)) {
      outside = true;
      continue;
    }
    const name = file.name || 'image.png';
    try {
      const r = await deps.saveImage(documentPath, name, await deps.readBytes(file));
      if (r.ok) out.push(r.data);
      else failure ??= { name, failure: r };
    } catch (err) {
      failure ??= { name, failure: failureOf(err) };
    }
  }
  if (outside) notify.warn(t('editor.media.outside_workspace'));
  if (failure) notify.error(fileFailureText(t('editor.media.image_save_failed'), failure.name, failure.failure), { code: failure.failure.code });
  return out;
}

/** 插入 Markdown 的一项:相对文档目录的链接目标,是否按图片插入。 */
export interface MarkdownLinkTarget {
  readonly href: string;
  readonly image: boolean;
  /** 文件名(编辑模式下链接的文字)。 */
  readonly name: string;
}

/** 绝对路径 → 相对文档目录的链接目标(图片按扩展名判定,同 VSCode getDesiredLinkKind)。 */
export function markdownLinkTarget(documentPath: string, target: string, image?: boolean): MarkdownLinkTarget {
  return {
    href: relativeLinkPath(dirname(documentPath), target),
    image: image ?? imageMimeOf(target) !== null,
    name: basename(target),
  };
}

/**
 * 源码视图插入的 Markdown 文字(VSCode createUriListSnippet:多项以空格分隔):图片 `![alt text](href)`、其余 `[text](href)`;
 * placeholders = 每项占位文字在 text 中的范围(插入后选中,同 VSCode 片段的占位)。
 */
export function markdownSnippet(targets: readonly MarkdownLinkTarget[]): {
  text: string;
  placeholders: { from: number; to: number }[];
} {
  let text = '';
  const placeholders: { from: number; to: number }[] = [];
  targets.forEach((target, i) => {
    if (i > 0) text += ' ';
    const open = target.image ? '![' : '[';
    const label = target.image ? IMAGE_ALT_PLACEHOLDER : LINK_TEXT_PLACEHOLDER;
    text += open;
    placeholders.push({ from: text.length, to: text.length + label.length });
    text += `${label}](${escapeMarkdownLinkPath(target.href)})`;
  });
  return { text, placeholders };
}

/** 是从系统(Finder / 桌面)拖来的磁盘文件(不是资源管理器内部拖动、不是文字拖动)。BDD: src/__tests__/os-file-drop/ */
export function isOsFileDrop(dt: DataTransfer | null | undefined): boolean {
  return dt != null && hasFiles(dt) && !hasExplorerDrag(dt);
}

/** 有磁盘路径的文件的路径(顺序同 files;剪贴板 / 合成的 File 没有路径,跳过)。 */
export function diskPathsOf(files: readonly File[], getPath: (file: File) => string = defaultMediaStoreDeps.getPathForFile): string[] {
  const out: string[] = [];
  for (const f of files) {
    const p = getPath(f);
    if (p !== '') out.push(p);
  }
  return out;
}

/** 资源管理器拖来的项里的文件(文件夹不插入:VSCode 拖动数据的资源列表只含文件)。 */
export function explorerDropFiles(entries: readonly ExplorerDragEntry[]): string[] {
  const out: string[] = [];
  for (const entry of entries) if (!entry.isDirectory) out.push(entry.path);
  return out;
}

/** 代码文件里 ⇧ 放下插入的文字:工作区内 → 相对工作区根的路径,其余 → 绝对路径;多个以空格分隔(VSCode Relative / Path provider)。 */
export function codeDropText(paths: readonly string[], workspaceRoot: string | null): string {
  return paths
    .map((p) => {
      if (workspaceRoot === null || !isSameOrInsidePath(workspaceRoot, p)) return p;
      const rel = stripRootPrefix(workspaceRoot, p);
      return isWindowsRuntime() ? rel.replace(/\\/g, '/') : rel;
    })
    .join(' ');
}
