// Markdown 文档里粘贴 / 拖入图片时新建的图片文件(fs:save-document-image;main 生成文件名、renderer 预判是否图片共用)。
// 对齐 VSCode markdown-language-features copyFiles:默认目的地 = 文档所在目录,文件名 = 拖入 / 粘贴的文件名(截图粘贴是
// Chromium 给的 `image.png`),重名按 `image-1.png`、`image-2.png` 递增(markdown.copyFiles.overwriteBehavior 默认
// nameIncrementally)。BDD: src/__tests__/markdown-image-paste/

import { isValidLeafName } from './leaf-name';
import { MAX_IMAGE_PREVIEW_BYTES } from './image-preview';

/** 允许落盘的图片格式(与编辑器能显示的图片同表,见 image-preview;svg 不收 —— 它是可执行脚本的文本)。MIME → 规范扩展名。 */
const EXT_BY_MIME: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
  'image/x-icon': 'ico',
};

/** 每个扩展名(小写)认的 MIME。 */
const MIME_BY_EXT: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpe: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  ico: 'image/x-icon',
};

/** 单张图片的大小上限(同图片预览的读取上限:写进去的图片要能显示出来)。 */
export const MAX_DOCUMENT_IMAGE_BYTES = MAX_IMAGE_PREVIEW_BYTES;

/** 文件名主干(不含扩展名)的最大长度(按 code point)。 */
const STEM_MAX = 100;

/** 是允许落盘的图片 MIME。 */
export function isDocumentImageMime(mime: string): boolean {
  return Object.hasOwn(EXT_BY_MIME, mime);
}

/** 按扩展名(大小写不敏感)取允许的图片 MIME;不是 → null。 */
export function documentImageMimeOfName(name: string): string | null {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return Object.hasOwn(MIME_BY_EXT, ext) ? MIME_BY_EXT[ext]! : null;
}

/** 按文件头判断图片格式(不信扩展名 / renderer 报的类型);不是允许的格式 → null。 */
export function sniffDocumentImageMime(bytes: Uint8Array): string | null {
  const at = (i: number): number => bytes[i] ?? -1;
  const ascii = (from: number, text: string): boolean => {
    for (let i = 0; i < text.length; i++) if (at(from + i) !== text.charCodeAt(i)) return false;
    return true;
  };
  if (at(0) === 0x89 && ascii(1, 'PNG\r\n\x1a\n')) return 'image/png';
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  if (ascii(0, 'BM') && bytes.length >= 26) return 'image/bmp';
  if (at(0) === 0 && at(1) === 0 && at(2) === 1 && at(3) === 0 && bytes.length >= 22) return 'image/x-icon';
  if (ascii(4, 'ftyp') && (ascii(8, 'avif') || ascii(8, 'avis'))) return 'image/avif';
  return null;
}

// 文件名里去掉的字符:路径分隔符与 Windows 不允许的字符、控制字符、双向文本控制符(防显示成别的扩展名)。
// eslint-disable-next-line no-control-regex -- 就是要匹配控制字符
const DROPPED_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g;

/**
 * 新图片文件名(不含序号):取 desired 的末段、去掉不安全字符与首尾空白 / 点;扩展名与实际格式(mime)不符或缺失 → 换成 / 补上
 * 该格式的规范扩展名;主干为空 / 仍不是合法文件名(Windows 保留名等)→ `image`。
 */
export function documentImageFileName(desired: string, mime: string): string {
  const ext = EXT_BY_MIME[mime] ?? 'png';
  const leaf = desired.slice(Math.max(desired.lastIndexOf('/'), desired.lastIndexOf('\\')) + 1);
  const cleaned = leaf.replace(DROPPED_NAME_CHARS, '').trim().replace(/^[.\s]+|[.\s]+$/g, '');
  const dot = cleaned.lastIndexOf('.');
  const ownMime = dot > 0 ? documentImageMimeOfName(cleaned) : null;
  const sameKind = ownMime === mime;
  let stem = Array.from(sameKind ? cleaned.slice(0, dot) : cleaned)
    .slice(0, STEM_MAX)
    .join('')
    .replace(/[.\s]+$/g, '');
  if (stem === '') stem = 'image';
  const name = `${stem}.${sameKind ? cleaned.slice(dot + 1) : ext}`;
  return isValidLeafName(name) ? name : `image.${ext}`;
}

/** 第 index 个候选名(0 = 原名,其后 `stem-1.ext`、`stem-2.ext` …,同 VSCode NewFilePathGenerator)。 */
export function numberedDocumentImageName(name: string, index: number): string {
  if (index === 0) return name;
  const dot = name.lastIndexOf('.');
  return `${name.slice(0, dot)}-${String(index)}${name.slice(dot)}`;
}
