// 安全:registerPluginFsIpc 把本实例 userData、两种发行形态的默认 userData 注入为受保护根。行为见同目录 README。
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ paths: {} as Record<string, string> }));

vi.mock('electron', () => ({
  app: { getPath: (name: string) => h.paths[name] ?? '', isPackaged: false },
  webContents: { fromId: () => null, getAllWebContents: () => [] },
}));

import { registerPluginFsIpc } from '../../../electron/main/ipc/plugin-fs.ipc';
import { PLUGIN_FS_CHANNELS as C } from '../../../electron/shared/plugin-fs-channels';
import { StubIpcMain, makeFakeEvent } from '../sdk-contract/integration/make-stub-ipc';

const PLUGIN = 'plugin.attacker';
const DENIED = 'target not in any granted scope';
let root: string;
let home: string;
let userDataDirs: string[];

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'protected-wiring-')));
  home = join(root, 'home');
  const appData = join(home, 'Library', 'Application Support');
  // 本实例用的是自定义位置的 userData(如 e2e 的 --user-data-dir);两种发行形态的默认目录也都存在。
  const custom = join(home, 'custom-user-data');
  h.paths = { userData: custom, appData };
  userDataDirs = [custom, join(appData, 'Continuo'), join(appData, 'Continuo Dev')];
  for (const dir of userDataDirs) {
    await mkdir(join(dir, 'plugins'), { recursive: true });
    await writeFile(join(dir, 'plugins', '_permissions.json'), '{}');
  }
  await writeFile(join(home, 'note.txt'), 'n');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('registerPluginFsIpc 注入受保护根', () => {
  it('持 home 的 rw scope:三处 userData 的权限文件都不可读写,home 下其它文件照常', async () => {
    const ipc = new StubIpcMain();
    const event = makeFakeEvent({ id: 1 });
    const handles = registerPluginFsIpc({ ipcMain: ipc as never });
    try {
      const { token } = (await ipc.invokeWithEvent(event, C.REGISTER_PLUGIN, PLUGIN)) as { token: string };
      handles.pathScopeRegistry.grant(PLUGIN, [{ path: home, mode: 'rw' }]);
      for (const dir of userDataDirs) {
        const file = join(dir, 'plugins', '_permissions.json');
        await expect(ipc.invokeWithEvent(event, C.WRITE_FILE, token, file, '{"evil":1}')).rejects.toThrow(DENIED);
        await expect(ipc.invokeWithEvent(event, C.READ_FILE, token, file)).rejects.toThrow(DENIED);
        expect(await readFile(file, 'utf-8')).toBe('{}');
      }
      expect(await ipc.invokeWithEvent(event, C.READ_FILE, token, join(home, 'note.txt'))).toBe('n');
    } finally {
      handles.correlator.dispose();
    }
  });
});
