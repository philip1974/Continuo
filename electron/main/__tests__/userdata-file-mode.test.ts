// 安全(多用户 POSIX):userData 内的 .corrupt 快照 / 初始占位文件含工作区路径、插件授权与插件数据,
// 须与 atomicWriteText 一致以 0600 创建;默认 0666&umask(通常 0644)会让同机其他用户读到。
// 只约束新建文件的 mode。Windows 上 mode 仅影响只读位,跳过。
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadExplorer } from '../persistence';
import { registerPluginDataStoreHandlers } from '../services/plugin-data-store.service';
import { readPluginPathScopes } from '../services/plugins.service';
import { setupTempDirs } from './_helpers/temp-dirs';

// 先注册删目录、后注册 restoreAllMocks:after 钩子逆序执行,保持原「先 restore 再删」顺序。
const tempDirs = setupTempDirs();
function tempDir(): Promise<string> {
  return tempDirs.make('continuo-filemode-');
}
afterEach(() => {
  vi.restoreAllMocks();
});

async function modeOf(p: string): Promise<number> {
  return (await stat(p)).mode & 0o777;
}

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
async function pluginDataHarness(): Promise<{ root: string; invoke: (ch: string, ...a: unknown[]) => Promise<unknown> }> {
  const root = await tempDir();
  const handlers = new Map<string, Handler>();
  registerPluginDataStoreHandlers({ handle: (ch: string, h: Handler) => handlers.set(ch, h) } as never, {
    userDataPath: root,
  });
  return { root, invoke: (ch, ...a) => handlers.get(ch)!({}, ...a) };
}

describe.skipIf(process.platform === 'win32')('userData 敏感文件以 0600 新建', () => {
  it('explorer.json 损坏 → .corrupt 快照 0600', async () => {
    const dir = await tempDir();
    const file = join(dir, 'explorer.json');
    await writeFile(file, '{"recentRoots": ["/secret/ws"');
    await loadExplorer(file);
    expect(await modeOf(`${file}.corrupt`)).toBe(0o600);
  });

  it.each([
    ['JSON 损坏', '{truncated'],
    ['非 plain object', 'null'],
  ])('插件 data.json %s → .corrupt 快照 0600', async (_label, content) => {
    const { root, invoke } = await pluginDataHarness();
    const file = join(root, 'plugins', 'p.a', 'data.json');
    await mkdir(join(root, 'plugins', 'p.a'), { recursive: true });
    await writeFile(file, content);
    await expect(invoke('plugin-data:load', 'p.a')).resolves.toEqual({});
    expect(await modeOf(`${file}.corrupt`)).toBe(0o600);
  });

  it('插件 data.json 首次保存的占位文件 0600(加锁失败时残留也不放宽)', async () => {
    const { root, invoke } = await pluginDataHarness();
    await mkdir(join(root, 'plugins', 'p.b'), { recursive: true }); // save 只写已安装插件的目录
    vi.spyOn(lockfile, 'lock').mockRejectedValue(new Error('lock failed'));
    await expect(invoke('plugin-data:save-serialized', 'p.b', JSON.stringify(1))).rejects.toThrow('lock failed');
    expect(await modeOf(join(root, 'plugins', 'p.b', 'data.json'))).toBe(0o600);
  });

  it('_plugin-path-scopes.json 损坏 → .corrupt 快照 0600', async () => {
    const base = await tempDir();
    const file = join(base, '_plugin-path-scopes.json');
    await writeFile(file, 'corrupt}}}');
    await readPluginPathScopes(base, 'com.a');
    expect(await modeOf(`${file}.corrupt`)).toBe(0o600);
  });
});
