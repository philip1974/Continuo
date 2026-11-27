// 主进程 fs:show-save-dialog(行为见同目录 README)。被测:electron/main/ipc/fs/save-dialog.ts(纯工厂,electron 依赖注入)。
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import {
  makeShowSaveDialogHandler,
  resolveSaveDialogDefaultPath,
  showSaveDialogInputSchema,
  type SaveDialogDeps,
} from '../../../electron/main/ipc/fs/save-dialog';
import { FS_PATH_MAX } from '../../../electron/shared/fs-limits';

const HOME = path.resolve('/home/me');
const owner = { id: 7, isDestroyed: () => false } as unknown as BrowserWindow;
const popout = { id: 9, isDestroyed: () => false } as unknown as BrowserWindow;

function makeDeps(over: Partial<SaveDialogDeps> = {}, result: { canceled: boolean; filePath: string } = { canceled: false, filePath: path.resolve('/w/new.txt') }) {
  const deps = {
    senderWindow: vi.fn(() => owner),
    parentFor: vi.fn((o: BrowserWindow) => o),
    showSaveDialog: vi.fn(async () => result),
    homeDir: () => HOME,
    recordDocument: vi.fn(),
    ...over,
  };
  return deps;
}

describe('输入校验', () => {
  it('只接受 { defaultPath } 且非空、不超长;多余字段拒绝', () => {
    expect(showSaveDialogInputSchema.safeParse({ defaultPath: '/w/a.ts' }).success).toBe(true);
    expect(showSaveDialogInputSchema.safeParse({ defaultPath: '' }).success).toBe(false);
    expect(showSaveDialogInputSchema.safeParse({ defaultPath: 'x'.repeat(FS_PATH_MAX + 1) }).success).toBe(false);
    expect(showSaveDialogInputSchema.safeParse({ defaultPath: '/w/a.ts', parent: 1 }).success).toBe(false);
    expect(showSaveDialogInputSchema.safeParse(undefined).success).toBe(false);
  });
});

describe('发送方与父窗口', () => {
  it('发送方不是主窗主 webContents → NO_WINDOW,不弹对话框', async () => {
    const deps = makeDeps({ senderWindow: vi.fn(() => null) });
    await expect(makeShowSaveDialogHandler(deps)({ defaultPath: '/w/a.ts' })).rejects.toMatchObject({ code: 'NO_WINDOW' });
    expect(deps.showSaveDialog).not.toHaveBeenCalled();
  });

  it('对话框挂在 parentFor 给出的窗口上(获焦的 popout 子窗),带建目录与覆盖确认', async () => {
    const deps = makeDeps({ parentFor: vi.fn(() => popout) });
    await makeShowSaveDialogHandler(deps)({ defaultPath: path.resolve('/w/a.ts') });
    expect(deps.parentFor).toHaveBeenCalledWith(owner);
    expect(deps.showSaveDialog).toHaveBeenCalledWith(popout, {
      defaultPath: path.resolve('/w/a.ts'),
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
  });
});

describe('默认位置', () => {
  it('绝对路径原样;只有文件名 → 主目录下;名字里的目录成分丢弃', () => {
    expect(resolveSaveDialogDefaultPath(path.resolve('/w/a.ts'), HOME)).toBe(path.resolve('/w/a.ts'));
    expect(resolveSaveDialogDefaultPath('hello.txt', HOME)).toBe(path.join(HOME, 'hello.txt'));
    expect(resolveSaveDialogDefaultPath('../../etc/x.txt', HOME)).toBe(path.join(HOME, 'x.txt'));
  });
});

describe('结果', () => {
  it('选定 → 返回路径并登记为本窗口打开的文档', async () => {
    const deps = makeDeps();
    expect(await makeShowSaveDialogHandler(deps)({ defaultPath: 'a.txt' })).toBe(path.resolve('/w/new.txt'));
    expect(deps.recordDocument).toHaveBeenCalledWith(7, path.resolve('/w/new.txt'));
  });

  it.each([
    ['取消', { canceled: true, filePath: '' }],
    ['空路径', { canceled: false, filePath: '' }],
    ['相对路径', { canceled: false, filePath: 'rel/x.txt' }],
    ['超长', { canceled: false, filePath: path.resolve('/' + 'x'.repeat(FS_PATH_MAX)) }],
  ])('%s → null,不登记', async (_name, result) => {
    const deps = makeDeps({}, result);
    expect(await makeShowSaveDialogHandler(deps)({ defaultPath: 'a.txt' })).toBeNull();
    expect(deps.recordDocument).not.toHaveBeenCalled();
  });
});
