// Markdown 图片(Milkdown 行内 image 节点)的渲染:相对路径按文档目录解析、经受控通道加载,失败给 alt 占位。
// BDD: src/__tests__/editor-image-preview/
// 对齐 VSCode markdown 预览:相对图片按文档目录解析,只能加载工作区(localResourceRoots)内的文件;严格安全级别 CSP
// `img-src 'self' https: data:` —— https 远程图片允许,http 不允许。Continuo 的 CSP 现状同(index.html,不扩大到 http)。
// 不启用 Crepe ImageBlock(上传 / 尺寸 / 标题 UI 且改变序列化):只替换 image 节点的 DOM 视图,文档里的 src 原样保留,
// 序列化与保存不受影响(保存后文件里仍是 ./q.png)。
import { coApi } from '@/lib/co-api';
import { t } from '@/i18n';
import { resolveLink } from './link-resolve';
import { isImagePreviewPath } from './editor-image';

export type MarkdownImageSource =
  | { readonly kind: 'file'; readonly absPath: string }
  | { readonly kind: 'url'; readonly url: string };

/**
 * 图片 src → 加载来源:本地(相对 / 绝对)路径 → 按 docPath 所在目录解析(同链接解析,含 %20 解码、`..` 折叠、UNC 限制),
 * 且须是可预览图片扩展名;`https:` / `data:image/…` → 原样;其它(http / file: / javascript: / 非图片 / 空)→ null(不加载)。
 */
export function resolveMarkdownImageSource(src: string, docPath: string | null): MarkdownImageSource | null {
  if (!src) return null;
  const lower = src.slice(0, 11).toLowerCase();
  if (lower.startsWith('https:') || lower.startsWith('data:image/')) return { kind: 'url', url: src };
  const target = resolveLink(src, docPath);
  if (target?.kind !== 'file' || !isImagePreviewPath(target.absPath)) return null;
  return { kind: 'file', absPath: target.absPath };
}

/** nodeView 用到的 ProseMirror 节点子集(@milkdown/kit / prosemirror 非直接依赖,按结构取)。 */
interface PmImageNode {
  readonly attrs: { readonly src?: unknown; readonly alt?: unknown; readonly title?: unknown };
  sameMarkup(other: PmImageNode): boolean;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * Milkdown nodeView 工厂(注册到 'nodeView' slice 的 'image' 项)。docPath = 当前 md 文件路径(挂载时取定)。
 * 本地图片经 fs:read-image(workspaceOnly:主进程按发送窗口工作区 realpath 判定)读为 data URL;
 * 不加载 / 读取失败 / 解码失败 → alt 文字占位(虚线框,role=img + 名称),不出现破图图标。
 */
export function markdownImageNodeView(docPath: string | null) {
  return (node: PmImageNode, view: { readonly dom: HTMLElement }) => {
    const doc = view.dom.ownerDocument;
    const src = str(node.attrs.src);
    const alt = str(node.attrs.alt);
    const title = str(node.attrs.title);
    const dom = doc.createElement('span');
    dom.className = 'co-md-image';
    let disposed = false;

    const showPlaceholder = (): void => {
      if (disposed) return;
      const ph = doc.createElement('span');
      ph.setAttribute('role', 'img');
      ph.setAttribute('aria-label', t('editor.md.image_unavailable', { name: alt || src }));
      if (src) ph.title = src;
      ph.className = 'inline-block rounded border border-dashed border-line px-1 text-fg-muted';
      ph.textContent = alt || src;
      dom.replaceChildren(ph);
    };
    const showImage = (url: string): void => {
      if (disposed) return;
      const img = doc.createElement('img');
      img.alt = alt;
      if (title) img.title = title;
      img.addEventListener('error', showPlaceholder, { once: true });
      img.src = url;
      dom.replaceChildren(img);
    };

    const source = resolveMarkdownImageSource(src, docPath);
    if (source === null) showPlaceholder();
    else if (source.kind === 'url') showImage(source.url);
    else {
      coApi.fs.readImage(source.absPath, { workspaceOnly: true }).then(
        (r) => (r.ok ? showImage(r.data.dataUrl) : showPlaceholder()),
        showPlaceholder,
      );
    }

    return {
      dom,
      // src / alt / title 变了 → 返回 false 让 ProseMirror 重建视图(重新解析加载)
      update: (next: PmImageNode): boolean => next.sameMarkup(node),
      // 异步替换子节点是视图自身的渲染,不是文档编辑
      ignoreMutation: (): boolean => true,
      destroy: (): void => {
        disposed = true;
      },
    };
  };
}
