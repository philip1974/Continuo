// @vitest-environment node
// 插件 main 入口不可用时整个插件从列表消失(到不了 renderer,manifest 报错路径也走不到):每种原因都须留一条告警,
// 且按 dir+reason 只记一次(列举 / watcher 周期反复判定不刷屏)。此前只有「超大」一种原因有日志。
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as nodeFs } from 'node:fs';
import { listPluginDirs, recoverInterruptedInstalls } from '../../../electron/main/services/plugins.service';

let base: string;
beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'plugin-main-skip-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(base, { recursive: true, force: true });
});

describe('main 入口不可用 → 跳过并告警一次', () => {
  it('manifest 指向尚未构建的 dist/main.js:不列出,记一条含原因与目录的告警;重复列举不再记', async () => {
    const dir = path.join(base, 'unbuilt');
    await mkdir(dir);
    await writeFile(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ id: 'unbuilt', name: 'Unbuilt', version: '1.0.0', main: 'dist/main.js' }),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await listPluginDirs(base)).toEqual([]);
    await listPluginDirs(base);
    const hits = warn.mock.calls.filter((c) => String(c[0]).includes(dir));
    expect(hits).toHaveLength(1);
    expect(String(hits[0]![0])).toContain('unreachable');
  });
});

describe('启动还原中断的更新失败 → 留告警', () => {
  it('backup 还原 rename 被拒(EBUSY)→ 记一条含错误码与路径的告警,不抛', async () => {
    const backup = path.join(base, '.com.example.p.old-12345678-1234-1234-1234-123456789abc');
    await mkdir(backup);
    const err = Object.assign(new Error('busy'), { code: 'EBUSY' });
    vi.spyOn(nodeFs, 'rename').mockRejectedValue(err);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(recoverInterruptedInstalls(base)).resolves.toBeUndefined();
    const hit = warn.mock.calls.find((c) => String(c[0]).includes(backup));
    expect(String(hit?.[0])).toContain('EBUSY');
  });
});

