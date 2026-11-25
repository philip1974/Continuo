// 工作区外的 Markdown 文档:同目录(及子目录)图片可显示(对齐 VSCode markdown 预览:文档不属工作区时把文档目录加入
// localResourceRoots)。安全:文档目录只在「该文档确由本窗口经编辑器读取通道(fs:read-file)打开过」时才放行 ——
// main 自己记账,不信 renderer 自报的 documentPath;realpath 防符号链接逃逸。行为见同目录 README。
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  guardedReadImageHandler,
  recordingReadFileHandler,
} from '../../../electron/main/ipc/fs.ipc';
import { readImage } from '../../../electron/main/ipc/fs/read-image';
import {
  _reset as resetDocs,
  clearWindow as clearDocsOfWindow,
  recordEditorDocument,
} from '../../../electron/main/services/window-editor-documents.service';
import {
  _reset as resetRoots,
  setWorkspaceRoot,
} from '../../../electron/main/services/window-workspace-roots.service';
import { setupTempDirs } from '../_helpers/tmp-dir';

vi.mock('electron', () => ({
  app: { on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
  dialog: {},
  shell: {},
}));

const tmp = setupTempDirs();
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WIN = 7;

afterEach(() => {
  resetDocs();
  resetRoots();
});

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (err) {
    return (err as { code?: string }).code;
  }
  return 'resolved';
}

/** 工作区 + 工作区外的文档目录(含 outside.md、同目录 o.png、子目录 img/s.png)+ 另一个外部目录(other/x.png)。 */
async function layout() {
  const ws = await tmp.make('continuo-ws-');
  const out = await tmp.make('continuo-outdoc-');
  const other = await tmp.make('continuo-other-');
  const doc = join(out, 'outside.md');
  await writeFile(doc, '![o](./o.png)\n');
  await writeFile(join(out, 'o.png'), PNG);
  await mkdir(join(out, 'img'));
  await writeFile(join(out, 'img', 's.png'), PNG);
  await writeFile(join(other, 'x.png'), PNG);
  setWorkspaceRoot(WIN, ws);
  return { ws, out, other, doc };
}

describe('readImage 允许根(多根)', () => {
  it('图片在任一允许根内 → 读出;都不在 → FS_DENIED;空根集 → FS_DENIED', async () => {
    const { ws, out, other } = await layout();
    expect((await readImage(join(out, 'o.png'), [ws, out])).size).toBe(PNG.length);
    expect(await codeOf(readImage(join(other, 'x.png'), [ws, out]))).toBe('FS_DENIED');
    expect(await codeOf(readImage(join(out, 'o.png'), []))).toBe('FS_DENIED');
  });
});

describe('fs:read-image 对工作区外文档的同目录图片', () => {
  it('文档经本窗口 fs:read-file 打开后:同目录 / 子目录图片可读', async () => {
    const { out, doc } = await layout();
    await recordingReadFileHandler({ path: doc }, WIN);
    for (const img of [join(out, 'o.png'), join(out, 'img', 's.png')]) {
      const r = await guardedReadImageHandler({ path: img, workspaceOnly: true, documentPath: doc }, WIN);
      expect(r.size).toBe(PNG.length);
    }
  });

  it('文档目录外(兄弟目录 / .. 逃逸)仍 FS_DENIED', async () => {
    const { out, other, doc } = await layout();
    await recordingReadFileHandler({ path: doc }, WIN);
    expect(
      await codeOf(guardedReadImageHandler({ path: join(other, 'x.png'), workspaceOnly: true, documentPath: doc }, WIN)),
    ).toBe('FS_DENIED');
    expect(
      await codeOf(
        guardedReadImageHandler({ path: `${out}/img/../../${other.split('/').pop()}/x.png`, workspaceOnly: true, documentPath: doc }, WIN),
      ),
    ).toBe('FS_DENIED');
  });

  it('renderer 自报的 documentPath 未经本窗口打开(或只在别的窗口打开过)→ FS_DENIED', async () => {
    const { out, doc } = await layout();
    const req = { path: join(out, 'o.png'), workspaceOnly: true, documentPath: doc };
    expect(await codeOf(guardedReadImageHandler(req, WIN))).toBe('FS_DENIED');
    await recordingReadFileHandler({ path: doc }, WIN + 1);
    expect(await codeOf(guardedReadImageHandler(req, WIN))).toBe('FS_DENIED');
  });

  it('非 Markdown 文档读取不登记;窗口关闭后登记清除', async () => {
    const { out, doc } = await layout();
    const txt = join(out, 'notes.txt');
    await writeFile(txt, 'x');
    await recordingReadFileHandler({ path: txt }, WIN);
    expect(
      await codeOf(guardedReadImageHandler({ path: join(out, 'o.png'), workspaceOnly: true, documentPath: txt }, WIN)),
    ).toBe('FS_DENIED');
    recordEditorDocument(WIN, doc);
    clearDocsOfWindow(WIN);
    expect(
      await codeOf(guardedReadImageHandler({ path: join(out, 'o.png'), workspaceOnly: true, documentPath: doc }, WIN)),
    ).toBe('FS_DENIED');
  });

  it('读取失败(文档不存在)不登记', async () => {
    const { out } = await layout();
    const ghost = join(out, 'ghost.md');
    expect(await codeOf(recordingReadFileHandler({ path: ghost }, WIN))).toBe('FS_NOT_FOUND');
    await writeFile(join(out, 'ghost.md'), 'x');
    expect(
      await codeOf(guardedReadImageHandler({ path: join(out, 'o.png'), workspaceOnly: true, documentPath: ghost }, WIN)),
    ).toBe('FS_DENIED');
  });

  // Windows 建符号链接需管理员权限
  it.skipIf(process.platform === 'win32')('文档目录内的符号链接指向目录外 → FS_DENIED(realpath 判定)', async () => {
    const { out, other, doc } = await layout();
    await symlink(join(other, 'x.png'), join(out, 'link.png'));
    await recordingReadFileHandler({ path: doc }, WIN);
    expect(
      await codeOf(guardedReadImageHandler({ path: join(out, 'link.png'), workspaceOnly: true, documentPath: doc }, WIN)),
    ).toBe('FS_DENIED');
  });

  it('工作区内图片照旧可读(不带 documentPath)', async () => {
    const { ws } = await layout();
    await writeFile(join(ws, 'w.png'), PNG);
    expect((await guardedReadImageHandler({ path: join(ws, 'w.png'), workspaceOnly: true }, WIN)).size).toBe(PNG.length);
  });
});
