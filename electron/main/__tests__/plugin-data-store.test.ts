import { randomUUID } from 'node:crypto';
import { existsSync, promises as fsp, rmSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerPluginDataStoreHandlers } from '../services/plugin-data-store.service';

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

class FakeIpcMain {
  readonly handlers = new Map<string, Handler>();

  handle(channel: string, handler: Handler): void {
    this.handlers.set(channel, handler);
  }

  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`missing handler ${channel}`);
    return handler({}, ...args);
  }
}

const roots: string[] = [];

async function makeHarness(): Promise<{
  root: string;
  ipc: FakeIpcMain;
}> {
  const root = await mkdtemp(join(tmpdir(), 'continuo-plugin-data-'));
  roots.push(root);
  const ipc = new FakeIpcMain();
  registerPluginDataStoreHandlers(ipc as never, { userDataPath: root });
  return { root, ipc };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('plugin-data-store.service', () => {
  it('T2.a load missing file returns empty object', async () => {
    const { ipc } = await makeHarness();

    await expect(ipc.invoke('plugin-data:load', 'p.missing')).resolves.toEqual(
      {},
    );
  });

  // 数据安全(codex 复查):clear 旧实现 try/catch 吞掉所有 rm 错误,删除失败仍报成功 →
  // 调用方以为已清除、重启却恢复旧数据。force:true 仅容忍 ENOENT,真错误须传播。
  it('clear 文件不存在 → no-op 成功(ENOENT 容忍)', async () => {
    const { ipc } = await makeHarness();
    await expect(
      ipc.invoke('plugin-data:clear', 'p.absent'),
    ).resolves.toBeUndefined();
  });

  it('clear rm 真错误(EACCES 等)→ 抛出,不静默报成功', async () => {
    const { ipc } = await makeHarness();
    await ipc.invoke('plugin-data:save', 'p.x', { a: 1 });
    const rmSpy = vi
      .spyOn(fsp, 'rm')
      .mockRejectedValue(
        Object.assign(new Error('EACCES'), { code: 'EACCES' }),
      );
    await expect(ipc.invoke('plugin-data:clear', 'p.x')).rejects.toThrow();
    rmSpy.mockRestore();
  });

  it('T2.race 加锁前初始化 lock 目标不截断已有 data.json(竞态/TOCTOU 防护)', async () => {
    const { ipc, root } = await makeHarness();
    // 预置已落盘内容(模拟另一次 save 已成功)
    const dir = join(root, 'plugins', 'p.race');
    await fsp.mkdir(dir, { recursive: true });
    const file = join(dir, 'data.json');
    await writeFile(file, JSON.stringify({ keep: 1 }), 'utf-8');

    // 模拟 TOCTOU:access 判定缺失(老代码据此走截断式 writeFile('{}'));并让加锁
    // 失败,使初始化之后的 atomicWriteJson 不执行 → 暴露「初始化步骤是否截断已有数据」。
    const accessSpy = vi
      .spyOn(fsp, 'access')
      .mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
      );
    const lockSpy = vi
      .spyOn(lockfile, 'lock')
      .mockRejectedValue(new Error('lock fail'));

    await expect(
      ipc.invoke('plugin-data:save', 'p.race', { next: 2 }),
    ).rejects.toThrow();

    accessSpy.mockRestore();
    lockSpy.mockRestore();

    // 关键:即便加锁失败,已有数据必须原样保留(绝不被初始化步骤截断成 {})
    expect(JSON.parse(await readFile(file, 'utf-8'))).toEqual({ keep: 1 });
  });

  it('T2.b save then load round-trips JSON data', async () => {
    const { ipc } = await makeHarness();

    await ipc.invoke('plugin-data:save', 'p.roundtrip', { a: 1 });

    await expect(ipc.invoke('plugin-data:load', 'p.roundtrip')).resolves.toEqual({
      a: 1,
    });
  });

  // 边界(E20):插件持久化 JSON 序列化字节上限。save 超 16MiB / 不可序列化 → 拒绝;load 磁盘残留
  // 超大 data.json → stat.size 拦截、隔离 .corrupt、降级 {},不整文件 parse。
  it('E20 save 超 16MiB → 拒绝(不写)', async () => {
    const { root, ipc } = await makeHarness();
    const big = { v: 'x'.repeat(16 * 1024 * 1024) };
    await expect(ipc.invoke('plugin-data:save', 'p.big', big)).rejects.toThrow();
    // 未写出超大 data.json(仅可能有 wx 占位 {} 或无文件,但绝非 16MB)
    const file = join(root, 'plugins', 'p.big', 'data.json');
    if (existsSync(file)) {
      expect((await readFile(file, 'utf-8')).length).toBeLessThan(1024);
    }
  });

  it('E20 save 循环引用 → 拒绝(不可序列化)', async () => {
    const { ipc } = await makeHarness();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(
      ipc.invoke('plugin-data:save', 'p.circ', circular),
    ).rejects.toThrow();
  });

  it('E20 load 超 16MiB data.json → 隔离 .corrupt + 返 {}', async () => {
    const { root, ipc } = await makeHarness();
    const dir = join(root, 'plugins', 'p.huge');
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'data.json');
    await writeFile(file, '{}');
    await truncate(file, 16 * 1024 * 1024 + 1); // 稀疏扩展,不写 16MB
    await expect(ipc.invoke('plugin-data:load', 'p.huge')).resolves.toEqual({});
    expect(existsSync(`${file}.corrupt`)).toBe(true); // 隔离
    expect(existsSync(file)).toBe(false); // 原超大文件已移走
  });

  // 边界(E161,stat-before-read TOCTOU 修正):load 改用共享单 fd readFileCappedFd,EACCES 等非
  // ENOENT 读错误经 fs.open 抛出透传(绝不静默降级 {},否则覆盖/丢插件已存数据)。
  it('E161 load 非 ENOENT 读错误(EACCES)→ 抛出,不降级 {}', async () => {
    const { root, ipc } = await makeHarness();
    const dir = join(root, 'plugins', 'p.acc');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'data.json'), '{"value":1}');
    const spy = vi
      .spyOn(fsp, 'open')
      .mockRejectedValue(
        Object.assign(new Error('EACCES'), { code: 'EACCES' }),
      );
    await expect(ipc.invoke('plugin-data:load', 'p.acc')).rejects.toThrow();
    spy.mockRestore();
  });

  it('T2.c concurrent saves end with one complete caller payload', async () => {
    const { ipc } = await makeHarness();
    const payloads = Array.from({ length: 5 }, (_, i) => ({
      writer: i,
      id: randomUUID(),
    }));

    await Promise.all(
      payloads.map((payload) =>
        ipc.invoke('plugin-data:save', 'p.concurrent', payload),
      ),
    );
    const loaded = await ipc.invoke('plugin-data:load', 'p.concurrent');

    expect(payloads).toContainEqual(loaded);
  });

  it('T2.d clear deletes data file', async () => {
    const { ipc } = await makeHarness();

    await ipc.invoke('plugin-data:save', 'p.clear', { a: 1 });
    await ipc.invoke('plugin-data:clear', 'p.clear');

    await expect(ipc.invoke('plugin-data:load', 'p.clear')).resolves.toEqual({});
  });

  it('T2.e save creates missing parent plugin dir', async () => {
    const { root, ipc } = await makeHarness();
    const file = join(root, 'plugins', 'p.parent', 'data.json');

    expect(existsSync(file)).toBe(false);
    await ipc.invoke('plugin-data:save', 'p.parent', { created: true });

    expect(existsSync(file)).toBe(true);
  });

  it('T2.f rejects path-traversal pluginId on load/save/clear (审计 V1)', async () => {
    const { root, ipc } = await makeHarness();
    const evil = '../../escaped';

    await expect(ipc.invoke('plugin-data:load', evil)).rejects.toThrow(
      /invalid plugin id/,
    );
    await expect(
      ipc.invoke('plugin-data:save', evil, { pwn: true }),
    ).rejects.toThrow(/invalid plugin id/);
    await expect(ipc.invoke('plugin-data:clear', evil)).rejects.toThrow(
      /invalid plugin id/,
    );

    // 确认没有在 plugins 目录外写出任何文件
    expect(existsSync(join(root, 'escaped'))).toBe(false);
    expect(existsSync(join(root, 'escaped.json'))).toBe(false);
  });

  it('T2.g rejects separators / dot segments / empty / uppercase pluginId', async () => {
    const { ipc } = await makeHarness();
    for (const bad of ['a/b', 'a\\b', '.', '..', '', 'UPPER']) {
      await expect(ipc.invoke('plugin-data:load', bad)).rejects.toThrow(
        /invalid plugin id/,
      );
    }
  });

  it('pluginId 字符集校验不调用 RegExp.test', async () => {
    const { ipc } = await makeHarness();
    const testSpy = vi.spyOn(RegExp.prototype, 'test');

    try {
      await expect(ipc.invoke('plugin-data:load', 'p.safe-id_1')).resolves.toEqual(
        {},
      );
      await expect(ipc.invoke('plugin-data:load', 'BadId')).rejects.toThrow(
        /invalid plugin id/,
      );
      const pluginIdRegexCalls = testSpy.mock.contexts.filter(
        (context) => context instanceof RegExp && context.source === '^[a-z0-9._-]+$',
      );
      expect(pluginIdRegexCalls).toHaveLength(0);
    } finally {
      testSpy.mockRestore();
    }
  });

  // 边界(E177):pluginId 长度上限(PLUGIN_ID_MAX=256,对齐 plugins.service/plugin-mcp/plugins.ipc)。
  // 超长合法字符 id 绕过 wrapper 直调 → 拒绝 + 错误不回显原始超长 id。
  it('E177 超长 pluginId(>256,合法字符)→ 拒绝,错误不回显原始超长 id', async () => {
    const { ipc } = await makeHarness();
    const longId = 'a'.repeat(257); // 合法字符但超长
    for (const ch of ['load', 'clear']) {
      const err = (await ipc
        .invoke(`plugin-data:${ch}`, longId)
        .catch((e: unknown) => e)) as { code?: string; message?: string };
      expect(err.code).toBe('BAD_INPUT');
      expect(err.message).toMatch(/invalid plugin id/);
      expect(err.message).not.toContain('a'.repeat(100)); // 不回显原始超长串
    }
    await expect(
      ipc.invoke('plugin-data:save', longId, { x: 1 }),
    ).rejects.toThrow(/invalid plugin id/);
  });

  it('E177 恰好 256 合法 pluginId → 接受(边界含等号)', async () => {
    const { ipc } = await makeHarness();
    const id = 'a'.repeat(256);
    await expect(ipc.invoke('plugin-data:load', id)).resolves.toEqual({});
  });
});
