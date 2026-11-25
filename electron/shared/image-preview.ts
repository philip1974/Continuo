// 编辑器内只读图片预览的格式表与大小上限(main 读图 / renderer 打开路由共用的单一来源)。
// 对齐 VSCode 内置 media-preview 的 imagePreview.previewEditor:`*.{jpg,jpe,jpeg,png,bmp,gif,ico,webp,avif}`。
// .svg 不在其中 —— VSCode 把 svg 当文本(XML)打开,Continuo 同。BDD: src/__tests__/editor-image-preview/

const IMAGE_MIME_BY_EXT: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpe: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  avif: 'image/avif',
};

/** 图片预览读取上限(50 MiB):data URL 经 IPC 整块发送,超限给提示而不读入。 */
export const MAX_IMAGE_PREVIEW_BYTES = 50 * 1024 * 1024;

/** 按扩展名(大小写不敏感)取可预览图片的 MIME;不是可预览图片 → null。`/` `\` 都按分隔符。 */
export function imageMimeOf(path: string): string | null {
  const sep = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const dot = path.lastIndexOf('.');
  if (dot <= sep + 1) return null; // 无扩展名 / 点开头的隐藏文件名(`.png`)
  const ext = path.slice(dot + 1).toLowerCase();
  return Object.hasOwn(IMAGE_MIME_BY_EXT, ext) ? IMAGE_MIME_BY_EXT[ext]! : null;
}

/** 是否按只读图片视图打开(而不是读成文本)。 */
export function isImagePreviewPath(path: string): boolean {
  return imageMimeOf(path) !== null;
}
