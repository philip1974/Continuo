// Electron 43 起 dialog.showOpenDialog 未传 defaultPath 时固定从「下载」目录打开(此前由 OS 记住上次
// 位置)。createRememberingOpenDialog 在主进程记住上次选中项的父目录,作为下一次的 defaultPath。
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createRememberingOpenDialog } from '../lib/open-dialog-last-dir';

type Opts = { properties?: string[]; defaultPath?: string };
type Result = { canceled: boolean; filePaths: string[] };

function setup(results: Result[]) {
  const show = vi.fn(async (_opts: Opts): Promise<Result> => results.shift()!);
  return { show, open: createRememberingOpenDialog(show) };
}

describe('createRememberingOpenDialog', () => {
  it('首次打开不注入 defaultPath(交给 Electron 默认)', async () => {
    const { show, open } = setup([{ canceled: true, filePaths: [] }]);
    await open({ properties: ['openDirectory'] });
    expect(show).toHaveBeenCalledWith({ properties: ['openDirectory'] });
  });

  it('选中后,下一次从所选项的父目录打开', async () => {
    const picked = path.join(path.sep, 'work', 'proj-a');
    const { show, open } = setup([
      { canceled: false, filePaths: [picked] },
      { canceled: true, filePaths: [] },
    ]);
    await open({ properties: ['openDirectory'] });
    await open({ properties: ['openDirectory'] });
    expect(show).toHaveBeenLastCalledWith({
      properties: ['openDirectory'],
      defaultPath: path.dirname(picked),
    });
  });

  it('取消不改变记住的目录', async () => {
    const picked = path.join(path.sep, 'work', 'proj-a');
    const { show, open } = setup([
      { canceled: false, filePaths: [picked] },
      { canceled: true, filePaths: [] },
      { canceled: true, filePaths: [] },
    ]);
    await open({});
    await open({});
    await open({});
    expect(show).toHaveBeenLastCalledWith({ defaultPath: path.dirname(picked) });
  });

  it('调用方显式给 defaultPath 时不覆盖', async () => {
    const { show, open } = setup([
      { canceled: false, filePaths: [path.join(path.sep, 'work', 'proj-a')] },
      { canceled: true, filePaths: [] },
    ]);
    await open({});
    await open({ defaultPath: '/explicit' });
    expect(show).toHaveBeenLastCalledWith({ defaultPath: '/explicit' });
  });

  it('返回值原样透传', async () => {
    const r = { canceled: false, filePaths: ['/x/y'] };
    const { open } = setup([r]);
    await expect(open({})).resolves.toBe(r);
  });
});
