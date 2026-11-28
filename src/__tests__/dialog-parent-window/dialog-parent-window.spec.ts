// BDD:原生对话框挂在发起窗口上(见同目录 README)。
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeSelectDirectoryHandler } from '../../../electron/main/ipc/fs.ipc';
import { createRememberingOpenDialog } from '../../../electron/main/lib/open-dialog-last-dir';

const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8');

describe('选择文件夹对话框的父窗口', () => {
  it('fs:selectDirectory:调用时取发起窗口作为对话框父窗口', async () => {
    const parent = { id: 7 };
    const parentWindow = vi.fn(() => parent);
    const showOpenDialog = vi.fn(async () => ({ canceled: false, filePaths: ['/w/a'] }));
    const handler = makeSelectDirectoryHandler({ parentWindow, showOpenDialog });
    expect(parentWindow).not.toHaveBeenCalled();
    expect(await handler()).toBe('/w/a');
    expect(showOpenDialog).toHaveBeenCalledWith({ properties: ['openDirectory', 'createDirectory'] }, parent);
  });

  it('取不到发起窗口 → 父窗口为 undefined(独立对话框)', async () => {
    const showOpenDialog = vi.fn(async () => ({ canceled: true, filePaths: [] }));
    await makeSelectDirectoryHandler({ parentWindow: () => undefined, showOpenDialog })();
    expect(showOpenDialog.mock.calls[0]).toEqual([{ properties: ['openDirectory', 'createDirectory'] }, undefined]);
  });

  it('记住上次位置的包装把父窗口原样透传(defaultPath 记忆不受影响)', async () => {
    const parent = { id: 3 };
    const show = vi.fn(async (_o: { defaultPath?: string }, _p: unknown) => ({ canceled: false, filePaths: ['/w/proj/a'] }));
    const open = createRememberingOpenDialog(show);
    await open({}, parent);
    await open({}, undefined);
    expect(show.mock.calls[0]).toEqual([{}, parent]);
    expect(show.mock.calls[1]).toEqual([{ defaultPath: '/w/proj' }, undefined]);
  });

  it('接线:Electron 对话框按父窗口调用;fs:selectDirectory 取发送方主窗(popout 获焦挂子窗),菜单入口取获焦窗口', () => {
    expect(read('electron/main/lib/open-dialog.ts')).toMatch(
      /parent && !parent\.isDestroyed\(\) \? dialog\.showOpenDialog\(parent, opts\) : dialog\.showOpenDialog\(opts\)/,
    );
    const fsIpc = read('electron/main/ipc/fs.ipc.ts');
    const sel = fsIpc.slice(fsIpc.indexOf('safeHandleWithCtx(FS_CHANNELS.SELECT_DIRECTORY'));
    const body = sel.slice(0, sel.indexOf('})(),'));
    expect(body).toMatch(/const owner = trustedSenderWindow\(event\);/);
    expect(body).toMatch(/\(owner \? dialogParentFor\(owner\) : BrowserWindow\.getFocusedWindow\(\)\) \?\? undefined/);
    expect(body).toMatch(/showOpenDialogRemembering\([^]*?,\s*parent,\s*\)/);
    // 另存为与选择文件夹共用同一父窗口规则
    expect(fsIpc).toMatch(/parentFor: dialogParentFor,/);
    const index = read('electron/main/index.ts');
    const menu = index.slice(index.indexOf('async function openFolderInNewWindow()'));
    expect(menu.slice(0, menu.indexOf('\n}'))).toMatch(
      /showOpenDialogRemembering\(\{ properties: \['openDirectory'\] \}, BrowserWindow\.getFocusedWindow\(\)\)/,
    );
  });

  it('主进程里不带父窗口的对话框调用只出现在「没有窗口」的兜底分支', () => {
    const files = [
      'electron/main/index.ts',
      'electron/main/lib/open-dialog.ts',
      'electron/main/help-links.ts',
      'electron/main/external-link-confirm.ts',
      'electron/main/ipc/workspace-trust.ipc.ts',
    ];
    let checked = 0;
    for (const f of files) {
      const src = read(f);
      for (const m of src.matchAll(/dialog\.show(?:OpenDialog|SaveDialog|MessageBox)\((?!\w+, )/g)) {
        const line = src.slice(src.lastIndexOf('\n', m.index) + 1, src.indexOf('\n', m.index));
        // 单参调用必须是「有父窗口 ? 带父窗口 : 不带」三元的 else 分支
        checked += 1;
        expect(line, `${f}: ${line.trim()}`).toMatch(/\? (?:await )?dialog\.show\w+\(\w+, \w+\) : (?:await )?dialog\.show\w+\(\w+\)/);
      }
    }
    expect(checked).toBeGreaterThanOrEqual(6);
  });
});
