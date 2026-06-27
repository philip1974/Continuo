import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { recoverInterruptedInstalls } from '../services/plugins.service';

// 数据安全(codex 复查 P1):插件 overwrite 更新若在 rename(target→backup) 与
// rename(staging→target) 之间进程崩溃,会留下孤儿 backup + 目标缺失 → 插件静默消失。
// 启动期恢复必须还原 backup;同时清理已完成更新的残留 backup 与残留 staging。
describe('recoverInterruptedInstalls', () => {
  let baseDir: string;
  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(os.tmpdir(), 'continuo-plugins-'));
  });
  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it('崩溃中断(目标缺失 + 孤儿 .old backup)→ 还原旧版本', async () => {
    const backup = path.join(baseDir, '.foo.old-uuid123');
    await mkdir(backup);
    await writeFile(path.join(backup, 'manifest.json'), '{"id":"foo"}');

    await recoverInterruptedInstalls(baseDir);

    const entries = await readdir(baseDir);
    expect(entries).toContain('foo'); // 已还原
    expect(entries).not.toContain('.foo.old-uuid123'); // backup 被搬走
    expect(await readFile(path.join(baseDir, 'foo', 'manifest.json'), 'utf-8')).toBe(
      '{"id":"foo"}',
    );
  });

  it('更新已完成(目标存在 + 残留 .old backup)→ 清理 backup,不动目标', async () => {
    await mkdir(path.join(baseDir, 'bar'));
    await writeFile(path.join(baseDir, 'bar', 'manifest.json'), '{"v":"new"}');
    const staleBackup = path.join(baseDir, '.bar.old-uuid456');
    await mkdir(staleBackup);
    await writeFile(path.join(staleBackup, 'manifest.json'), '{"v":"old"}');

    await recoverInterruptedInstalls(baseDir);

    const entries = await readdir(baseDir);
    expect(entries).toContain('bar');
    expect(entries).not.toContain('.bar.old-uuid456'); // 残留被清
    // 目标是新版本,未被旧 backup 覆盖
    expect(await readFile(path.join(baseDir, 'bar', 'manifest.json'), 'utf-8')).toBe(
      '{"v":"new"}',
    );
  });

  it('残留 staging(.installing)→ 清理', async () => {
    await mkdir(path.join(baseDir, '.baz.installing-uuid789'));
    await recoverInterruptedInstalls(baseDir);
    expect(await readdir(baseDir)).not.toContain('.baz.installing-uuid789');
  });

  it('无残留 → 幂等 no-op(普通插件目录不动)', async () => {
    await mkdir(path.join(baseDir, 'normal'));
    await recoverInterruptedInstalls(baseDir);
    expect(await readdir(baseDir)).toEqual(['normal']);
  });
});
