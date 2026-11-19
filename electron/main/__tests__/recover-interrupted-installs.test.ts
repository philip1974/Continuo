import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    const backup = path.join(baseDir, '.foo.old-11111111-2222-4333-8444-555555555555');
    await mkdir(backup);
    await writeFile(path.join(backup, 'manifest.json'), '{"id":"foo"}');

    await recoverInterruptedInstalls(baseDir);

    const entries = await readdir(baseDir);
    expect(entries).toContain('foo'); // 已还原
    expect(entries).not.toContain('.foo.old-11111111-2222-4333-8444-555555555555'); // backup 被搬走
    expect(await readFile(path.join(baseDir, 'foo', 'manifest.json'), 'utf-8')).toBe(
      '{"id":"foo"}',
    );
  });

  it('更新已完成(目标存在 + 残留 .old backup)→ 清理 backup,不动目标', async () => {
    await mkdir(path.join(baseDir, 'bar'));
    await writeFile(path.join(baseDir, 'bar', 'manifest.json'), '{"v":"new"}');
    const staleBackup = path.join(baseDir, '.bar.old-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    await mkdir(staleBackup);
    await writeFile(path.join(staleBackup, 'manifest.json'), '{"v":"old"}');

    await recoverInterruptedInstalls(baseDir);

    const entries = await readdir(baseDir);
    expect(entries).toContain('bar');
    expect(entries).not.toContain('.bar.old-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'); // 残留被清
    // 目标是新版本,未被旧 backup 覆盖
    expect(await readFile(path.join(baseDir, 'bar', 'manifest.json'), 'utf-8')).toBe(
      '{"v":"new"}',
    );
  });

  it('残留 staging(.installing)→ 清理', async () => {
    await mkdir(path.join(baseDir, '.baz.installing-01234567-89ab-4cde-8f01-23456789abcd'));
    await recoverInterruptedInstalls(baseDir);
    expect(await readdir(baseDir)).not.toContain('.baz.installing-01234567-89ab-4cde-8f01-23456789abcd');
  });

  it('残留名解析走字符扫描,不调用 RegExp.exec/test', async () => {
    await mkdir(path.join(baseDir, '.foo.old-part.old-11111111-2222-4333-8444-555555555555'));
    await writeFile(
      path.join(baseDir, '.foo.old-part.old-11111111-2222-4333-8444-555555555555', 'manifest.json'),
      '{"id":"foo.old-part"}',
    );
    await mkdir(path.join(baseDir, '.bar.installing-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'));
    const execSpy = vi.spyOn(RegExp.prototype, 'exec');
    const testSpy = vi.spyOn(RegExp.prototype, 'test');
    try {
      await recoverInterruptedInstalls(baseDir);
      expect(execSpy).not.toHaveBeenCalled();
      expect(testSpy).not.toHaveBeenCalled();
    } finally {
      execSpy.mockRestore();
      testSpy.mockRestore();
    }

    const entries = await readdir(baseDir);
    expect(entries).toContain('foo.old-part');
    expect(entries).not.toContain('.bar.installing-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  });

  // 后缀按 installFromGit 实际生成的形态(randomUUID)锚定匹配;先判 installing 再判 backup。
  // 曾用 lastIndexOf('.old-') 且先判 backup:manifest.id = "a.old-z" 的 staging 目录
  // `.a.old-z.installing-<uuid>` 被当成「插件 a 的备份」,崩溃恢复时 rename 成 plugins/a(未完成安装的代码冒名成 a)。
  const UUID = '9f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';

  it('id 含 ".old-" 的 staging 目录不被当成别的插件的备份:清理它,不 rename 成 plugins/a', async () => {
    const staging = `.a.old-z.installing-${UUID}`;
    await mkdir(path.join(baseDir, staging));
    await writeFile(path.join(baseDir, staging, 'manifest.json'), '{"id":"a.old-z"}');

    await recoverInterruptedInstalls(baseDir);

    expect(await readdir(baseDir)).toEqual([]);
  });

  it('id 含 ".old-" 的插件自己的备份 → 还原成完整 id(不是截断的前缀)', async () => {
    const backup = `.a.old-z.old-${UUID}`;
    await mkdir(path.join(baseDir, backup));
    await writeFile(path.join(baseDir, backup, 'manifest.json'), '{"id":"a.old-z"}');

    await recoverInterruptedInstalls(baseDir);

    expect(await readdir(baseDir)).toEqual(['a.old-z']);
  });

  it('id 含 ".installing-<uuid 形态>" 的插件的备份 → 仍按备份还原', async () => {
    const id = `x.installing-${UUID}`;
    const backup = `.${id}.old-${UUID}`;
    await mkdir(path.join(baseDir, backup));

    await recoverInterruptedInstalls(baseDir);

    expect(await readdir(baseDir)).toEqual([id]);
  });

  it.each([
    ['.foo.old-123', '后缀不是 uuid'],
    ['.foo.old-9F1C2D3E-4A5B-4C6D-8E7F-0A1B2C3D4E5F', '大写 uuid(randomUUID 只产生小写)'],
    ['.foo.old-9f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5fx', 'uuid 后还有多余字符'],
    ['.foo.installing-9f1c2d3e4a5b4c6d8e7f0a1b2c3d4e5f', 'uuid 缺连字符'],
    ['..old-9f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f', 'id 为空'],
  ])('形态不符的名字 %s(%s)→ 不认作残留,原样保留', async (name) => {
    await mkdir(path.join(baseDir, name));
    await recoverInterruptedInstalls(baseDir);
    expect(await readdir(baseDir)).toEqual([name]);
  });

  it('无残留 → 幂等 no-op(普通插件目录不动)', async () => {
    await mkdir(path.join(baseDir, 'normal'));
    await recoverInterruptedInstalls(baseDir);
    expect(await readdir(baseDir)).toEqual(['normal']);
  });
});
