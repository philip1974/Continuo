// @vitest-environment jsdom
// 粘贴 / 拖入的图片怎么变成文档里的引用(editor-media-drop):工作区内的磁盘文件直接引用,其余复制到文档旁;相对路径与 VSCode 同样
// 转义(空白 → `<…>`,不做 %20);无标题 / 工作区外 / 写入失败给提示且不返回(什么都不插)。行为见同目录 README。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn() }));
vi.mock('../../notifications/notify', () => ({ notify: { warn: mocks.warn, error: mocks.error, info: vi.fn() } }));
vi.mock('../../lib/co-api', () => ({ coApi: {} }));

import {
  codeDropText,
  escapeMarkdownLinkPath,
  isInsertableImageFile,
  markdownLinkTarget,
  markdownSnippet,
  relativeLinkPath,
  storeImagesForDocument,
  type MediaStoreDeps,
} from '../../panels/Editor/editor-media-drop';
import { t } from '../../i18n';

const DOC = '/w/docs/a.md';

function deps(over: Partial<MediaStoreDeps> = {}): MediaStoreDeps & { saveImage: ReturnType<typeof vi.fn> } {
  const saveImage = vi.fn(async (_doc: string, name: string) => ({ ok: true as const, data: `/w/docs/${name}` }));
  return {
    getPathForFile: () => '',
    workspaceRoot: () => '/w',
    readBytes: async () => new Uint8Array([1]),
    saveImage,
    ...over,
  } as MediaStoreDeps & { saveImage: ReturnType<typeof vi.fn> };
}

const png = (name = 'image.png') => new File([new Uint8Array([0x89])], name, { type: 'image/png' });

beforeEach(() => {
  mocks.warn.mockReset();
  mocks.error.mockReset();
});

describe('链接路径(对齐 VSCode markdown copyFiles / shared.ts)', () => {
  it('相对文档目录:同目录 → 文件名;子目录 / 上级目录 → `a/b.png` / `../x.png`', () => {
    expect(relativeLinkPath('/w/docs', '/w/docs/image.png')).toBe('image.png');
    expect(relativeLinkPath('/w/docs', '/w/docs/img/b.png')).toBe('img/b.png');
    expect(relativeLinkPath('/w/docs', '/w/assets/x.png')).toBe('../assets/x.png');
  });

  it('含空白 / 括号不配对 → `<…>`(不做 %20);普通路径原样', () => {
    expect(escapeMarkdownLinkPath('my shot.png')).toBe('<my shot.png>');
    expect(escapeMarkdownLinkPath('a(b.png')).toBe('<a(b.png>');
    expect(escapeMarkdownLinkPath('a(b).png')).toBe('a(b).png');
    expect(escapeMarkdownLinkPath('<x>.png')).toBe('<\\<x\\>.png>');
    expect(escapeMarkdownLinkPath('img/b.png')).toBe('img/b.png');
  });

  it('源码片段:图片 `![alt text](…)`、其余 `[text](…)`,空格分隔,占位范围指向 alt / text', () => {
    const { text, placeholders } = markdownSnippet([
      markdownLinkTarget(DOC, '/w/docs/my shot.png'),
      markdownLinkTarget(DOC, '/w/src/a.ts'),
    ]);
    expect(text).toBe('![alt text](<my shot.png>) [text](../src/a.ts)');
    expect(placeholders.map((p) => text.slice(p.from, p.to))).toEqual(['alt text', 'text']);
  });

  it('代码文件 ⇧ 放下:工作区内 → 相对工作区根,其余 → 绝对路径,空格分隔', () => {
    expect(codeDropText(['/w/src/a.ts', '/elsewhere/b.ts'], '/w')).toBe('src/a.ts /elsewhere/b.ts');
    expect(codeDropText(['/w/src/a.ts'], null)).toBe('/w/src/a.ts');
  });

  it('可插入的图片:允许的图片类型;类型为空时按扩展名;svg / 文本不算', () => {
    expect(isInsertableImageFile({ type: 'image/png', name: 'x' })).toBe(true);
    expect(isInsertableImageFile({ type: '', name: 'a.JPG' })).toBe(true);
    expect(isInsertableImageFile({ type: 'image/svg+xml', name: 'a.svg' })).toBe(false);
    expect(isInsertableImageFile({ type: 'text/plain', name: 'a.png' })).toBe(false);
  });
});

describe('storeImagesForDocument', () => {
  it('剪贴板图片(无磁盘路径)→ 经主进程存到文档旁,返回新文件路径', async () => {
    const d = deps();
    expect(await storeImagesForDocument(DOC, [png()], d)).toEqual(['/w/docs/image.png']);
    expect(d.saveImage).toHaveBeenCalledWith(DOC, 'image.png', new Uint8Array([1]));
  });

  it('Finder 拖来、已在工作区内的图片 → 直接引用,不复制;工作区外的 → 复制', async () => {
    const d = deps({ getPathForFile: (f) => (f.name === 'in.png' ? '/w/assets/in.png' : '/Users/me/Desktop/out.png') });
    expect(await storeImagesForDocument(DOC, [png('in.png'), png('out.png')], d)).toEqual(['/w/assets/in.png', '/w/docs/out.png']);
    expect(d.saveImage).toHaveBeenCalledTimes(1);
    expect(d.saveImage.mock.calls[0]![1]).toBe('out.png');
  });

  it('文档没保存过(无标题 / 无路径)→ 提示先保存,不写、不返回', async () => {
    const d = deps();
    expect(await storeImagesForDocument(null, [png()], d)).toEqual([]);
    expect(await storeImagesForDocument('untitled:Untitled-1', [png()], d)).toEqual([]);
    expect(d.saveImage).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledWith(t('editor.media.save_document_first'));
  });

  it('文档不在工作区内 → 提示,不复制(工作区内的磁盘图片仍可引用)', async () => {
    const d = deps({ workspaceRoot: () => '/other' });
    expect(await storeImagesForDocument(DOC, [png()], d)).toEqual([]);
    expect(d.saveImage).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledWith(t('editor.media.outside_workspace'));
  });

  it('写入失败(结果失败 / 抛错)→ 错误提示,该图片不返回', async () => {
    const d = deps({
      saveImage: vi.fn(async () => ({ ok: false as const, code: 'FS_DENIED', message: 'x' })),
    });
    expect(await storeImagesForDocument(DOC, [png()], d)).toEqual([]);
    expect(mocks.error).toHaveBeenCalledTimes(1);
    expect(String(mocks.error.mock.calls[0]![0])).toContain(t('editor.media.image_save_failed'));
    const e = deps({ readBytes: async () => Promise.reject(new Error('gone')) });
    expect(await storeImagesForDocument(DOC, [png()], e)).toEqual([]);
    expect(mocks.error).toHaveBeenCalledTimes(2);
  });
});
