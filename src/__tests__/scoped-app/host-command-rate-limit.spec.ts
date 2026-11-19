// @vitest-environment jsdom
// 安全(审计 F4):零权限第三方插件经 app.commands.execute 执行宿主命令不受限 —— 循环 execute('window.new') 每次
// 开一个新窗口,新窗口重新加载该插件 → 指数开窗;'terminal.new' 每次起一个 shell。修复:第三方插件实例执行宿主
// 命令(含经 get / getAll 拿到的 fn)在滑动窗口内限次;主进程另有全局窗口数上限。行为见同目录 README。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootCorePlugins, shutdownCorePlugins } from '../../core-plugins';
import { coApp } from '../../plugins/co-app';
import { _resetLmApiForTest, captureLmApi } from '../../lib/co-api';
import {
  createScopedApp,
  createScopedAppController,
  HOST_COMMAND_RATE_LIMIT,
  HOST_COMMAND_RATE_WINDOW_MS,
} from '../../plugins/scoped-app';

let create: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-19T00:00:00Z'));
  _resetLmApiForTest();
  create = vi.fn().mockResolvedValue({ ok: true, data: { windowId: 2 } });
  Object.defineProperty(window, 'api', { value: { window: { create } }, writable: true, configurable: true });
  captureLmApi();
  bootCorePlugins(); // 真实 WindowPlugin 注册 window.new(所有者 core:)
});

afterEach(async () => {
  await shutdownCorePlugins();
  delete (window as { api?: unknown }).api;
  _resetLmApiForTest();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const evil = () => createScopedAppController(coApp, 'evil', null, 'token-evil').app;

describe('第三方插件执行宿主命令限次', () => {
  it(`循环 execute('window.new') 100 次:只有前 ${HOST_COMMAND_RATE_LIMIT} 次真的建窗,其余 RATE_LIMITED`, async () => {
    const app = evil();
    const results = await Promise.allSettled(
      Array.from({ length: 100 }, () => app.commands.execute('window.new')),
    );
    expect(create).toHaveBeenCalledTimes(HOST_COMMAND_RATE_LIMIT);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(100 - HOST_COMMAND_RATE_LIMIT);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('经 get / getAll 拿到的宿主命令 fn 共用同一个额度(不能绕过 execute)', async () => {
    const app = evil();
    const viaGet = app.commands.get('window.new')!.fn;
    const viaAll = app.commands.getAll().find((c) => c.id === 'window.new')!.fn;
    let denied = 0;
    for (let i = 0; i < 20; i++) {
      try {
        await (i % 2 === 0 ? viaGet : viaAll)();
      } catch (err) {
        expect(err).toMatchObject({ code: 'RATE_LIMITED' });
        denied += 1;
      }
      try {
        await app.commands.execute('window.new');
      } catch {
        denied += 1;
      }
    }
    expect(create).toHaveBeenCalledTimes(HOST_COMMAND_RATE_LIMIT);
    expect(denied).toBe(40 - HOST_COMMAND_RATE_LIMIT);
  });

  it('滑动窗口过去后恢复额度;合法的单次调用照常', async () => {
    const app = evil();
    await app.commands.execute('window.new');
    expect(create).toHaveBeenCalledTimes(1);
    for (let i = 1; i < HOST_COMMAND_RATE_LIMIT; i++) await app.commands.execute('window.new');
    await expect(app.commands.execute('window.new')).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    vi.setSystemTime(Date.now() + HOST_COMMAND_RATE_WINDOW_MS);
    await app.commands.execute('window.new');
    expect(create).toHaveBeenCalledTimes(HOST_COMMAND_RATE_LIMIT + 1);
  });

  it('插件自己注册的命令不受限;内置插件(无 token)执行宿主命令不受限', async () => {
    const app = evil();
    const own = vi.fn();
    app.commands.register({ id: 'evil.own', title: 'Own', fn: own });
    for (let i = 0; i < 50; i++) await app.commands.execute('evil.own');
    expect(own).toHaveBeenCalledTimes(50);
    const core = createScopedApp(coApp, 'core.something', null);
    for (let i = 0; i < 20; i++) await core.commands.execute('window.new');
    expect(create).toHaveBeenCalledTimes(20);
  });

  it('额度按插件实例计(另一个第三方插件有自己的额度)', async () => {
    const a = evil();
    const b = createScopedAppController(coApp, 'other', null, 'token-other').app;
    for (let i = 0; i < HOST_COMMAND_RATE_LIMIT; i++) await a.commands.execute('window.new');
    await expect(a.commands.execute('window.new')).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    await b.commands.execute('window.new');
    expect(create).toHaveBeenCalledTimes(HOST_COMMAND_RATE_LIMIT + 1);
  });
});
