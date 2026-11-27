// 主进程落盘粘贴 / 拖入的图片(fs:save-document-image):目的地 = 文档所在目录(须在工作区内,目录链接指向外部拒绝);
// 文件名由主进程生成(末段、清洗、扩展名按文件头),重名加序号不覆盖;只收图片、有大小上限。行为见同目录 README。
import { mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { saveDocumentImage, type SaveDocumentImageContext } from '../../../electron/main/ipc/fs/save-document-image';
import {
  documentImageFileName,
  MAX_DOCUMENT_IMAGE_BYTES,
  sniffDocumentImageMime,
} from '../../../electron/shared/document-image';
import { saveDocumentImageInputSchema } from '../../../electron/main/ipc/fs.ipc';
import { setupTempDirs } from '../_helpers/tmp-dir';
import { vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  BrowserWindow: { getAllWindows: () => [], fromId: () => null, getFocusedWindow: () => null },
  dialog: {},
  shell: {},
}));

const tmp = setupTempDirs();
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (err) {
    return (err as { code?: string }).code;
  }
  return 'resolved';
}

async function workspace(): Promise<{ root: string; doc: string; ctx: SaveDocumentImageContext }> {
  const root = await tmp.make('continuo-paste-');
  await mkdir(join(root, 'docs'));
  const doc = join(root, 'docs', 'a.md');
  await writeFile(doc, '# a\n');
  return { root, doc, ctx: { workspaceRoot: root, isWindowDocument: (p) => p === doc } };
}

describe('saveDocumentImage', () => {
  it('截图(image.png)写进文档所在目录;同名已存在 → image-1.png、image-2.png,原文件不被覆盖', async () => {
    const { root, doc, ctx } = await workspace();
    const first = await saveDocumentImage({ documentPath: doc, fileName: 'image.png', data: PNG }, ctx);
    expect(first).toBe(join(root, 'docs', 'image.png'));
    expect(new Uint8Array(await readFile(first))).toEqual(PNG);
    await writeFile(join(root, 'docs', 'image-1.png'), 'keep');
    const second = await saveDocumentImage({ documentPath: doc, fileName: 'image.png', data: PNG }, ctx);
    expect(second).toBe(join(root, 'docs', 'image-2.png'));
    expect(await readFile(join(root, 'docs', 'image-1.png'), 'utf8')).toBe('keep');
    expect(new Uint8Array(await readFile(first))).toEqual(PNG);
  });

  it('文件名只取末段并清洗:`../../evil.png` / 带分隔符 / 控制字符不会写到目录外', async () => {
    const { root, doc, ctx } = await workspace();
    const p = await saveDocumentImage({ documentPath: doc, fileName: '../../evil.png', data: PNG }, ctx);
    expect(p).toBe(join(root, 'docs', 'evil.png'));
    const q = await saveDocumentImage({ documentPath: doc, fileName: 'a\\..\\b:c\u0007.png', data: PNG }, ctx);
    expect(q).toBe(join(root, 'docs', 'bc.png'));
    expect((await readdir(root)).sort()).toEqual(['docs']);
  });

  it('扩展名按文件头:jpeg 字节叫 shot.png → shot.jpg;无扩展名 / 空名 → 补扩展名 / image', async () => {
    const { root, doc, ctx } = await workspace();
    expect(await saveDocumentImage({ documentPath: doc, fileName: 'shot.png', data: JPEG }, ctx)).toBe(
      join(root, 'docs', 'shot.png.jpg'),
    );
    expect(await saveDocumentImage({ documentPath: doc, fileName: 'Photo.JPEG', data: JPEG }, ctx)).toBe(
      join(root, 'docs', 'Photo.JPEG'),
    );
    expect(await saveDocumentImage({ documentPath: doc, fileName: '', data: PNG }, ctx)).toBe(join(root, 'docs', 'image.png'));
  });

  it('不是图片(按文件头,不信扩展名)/ 超过大小上限 → 拒绝,不写文件', async () => {
    const { root, doc, ctx } = await workspace();
    expect(await codeOf(saveDocumentImage({ documentPath: doc, fileName: 'x.png', data: new TextEncoder().encode('<svg/>') }, ctx))).toBe(
      'FS_DENIED',
    );
    const big = new Uint8Array(MAX_DOCUMENT_IMAGE_BYTES + 1);
    big.set(PNG);
    expect(await codeOf(saveDocumentImage({ documentPath: doc, fileName: 'x.png', data: big }, ctx))).toBe('FS_FILE_TOO_LARGE');
    expect((await readdir(join(root, 'docs'))).sort()).toEqual(['a.md']);
  });

  it('文档不在工作区内 / 没有工作区 / 不是本窗口打开过的文档 → FS_DENIED', async () => {
    const { doc, ctx } = await workspace();
    const other = await tmp.make('continuo-paste-out-');
    const outsideDoc = join(other, 'b.md');
    await writeFile(outsideDoc, '');
    const input = { fileName: 'image.png', data: PNG };
    expect(await codeOf(saveDocumentImage({ ...input, documentPath: outsideDoc }, { ...ctx, isWindowDocument: () => true }))).toBe(
      'FS_DENIED',
    );
    expect(await codeOf(saveDocumentImage({ ...input, documentPath: doc }, { ...ctx, workspaceRoot: null }))).toBe('FS_DENIED');
    expect(await codeOf(saveDocumentImage({ ...input, documentPath: doc }, { ...ctx, isWindowDocument: () => false }))).toBe(
      'FS_DENIED',
    );
    expect((await readdir(other)).sort()).toEqual(['b.md']);
  });

  it('文档所在目录是指向工作区外的链接 → FS_DENIED,外部目录不被写入', async () => {
    const { root, ctx } = await workspace();
    const outside = await tmp.make('continuo-paste-out-');
    await symlink(outside, join(root, 'linked'));
    const doc = join(root, 'linked', 'c.md');
    await writeFile(doc, '');
    expect(
      await codeOf(saveDocumentImage({ documentPath: doc, fileName: 'image.png', data: PNG }, { ...ctx, isWindowDocument: () => true })),
    ).toBe('FS_DENIED');
    expect((await readdir(outside)).sort()).toEqual(['c.md']);
  });

  it('目标名已是(悬空)链接 → 不跟随,换下一个序号', async () => {
    const { root, doc, ctx } = await workspace();
    const outside = await tmp.make('continuo-paste-out-');
    await symlink(join(outside, 'pwn.png'), join(root, 'docs', 'image.png'));
    expect(await saveDocumentImage({ documentPath: doc, fileName: 'image.png', data: PNG }, ctx)).toBe(join(root, 'docs', 'image-1.png'));
    expect(await readdir(outside)).toEqual([]);
  });
});

describe('IPC 入参 schema', () => {
  it('只收 documentPath / fileName / data(Uint8Array,1..上限字节);多余字段、空数据、非 Uint8Array 拒绝', () => {
    const ok = { documentPath: '/w/a.md', fileName: 'image.png', data: PNG };
    expect(saveDocumentImageInputSchema.safeParse(ok).success).toBe(true);
    expect(saveDocumentImageInputSchema.safeParse({ ...ok, path: '/etc/x' }).success).toBe(false);
    expect(saveDocumentImageInputSchema.safeParse({ ...ok, data: new Uint8Array() }).success).toBe(false);
    expect(saveDocumentImageInputSchema.safeParse({ ...ok, data: 'abc' }).success).toBe(false);
    expect(saveDocumentImageInputSchema.safeParse({ ...ok, documentPath: '' }).success).toBe(false);
  });
});

describe('文件名 / 格式识别', () => {
  it('按文件头识别 png / jpeg / gif / webp;svg、文本、空 → null', () => {
    expect(sniffDocumentImageMime(PNG)).toBe('image/png');
    expect(sniffDocumentImageMime(JPEG)).toBe('image/jpeg');
    expect(sniffDocumentImageMime(new TextEncoder().encode('GIF89a....'))).toBe('image/gif');
    expect(sniffDocumentImageMime(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffDocumentImageMime(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffDocumentImageMime(new Uint8Array())).toBeNull();
  });

  it('保留名 / 双向文本控制符 / 尾随点被清洗', () => {
    expect(documentImageFileName('CON.png', 'image/png')).toBe('image.png');
    expect(documentImageFileName('a‮gnp.exe', 'image/png')).toBe('agnp.exe.png');
    expect(documentImageFileName('shot...', 'image/png')).toBe('shot.png');
  });
});
