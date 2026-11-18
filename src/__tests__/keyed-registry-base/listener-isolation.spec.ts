// 安全:注册表变更通知逐个监听器隔离。插件 `app.commands.subscribe(() => { throw 1 })` 之后,别人的 register
// 不能因此抛错(条目已入表却拿不到 Disposable、没有所有者记录 → 该 key 永远注销不掉,宿主重注册被拒)。
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/co-api', () => ({ coApi: {} }));

import { createScopedApp, isThirdPartyContribution } from '../../plugins/scoped-app';
import { createTestCoApp } from '../../plugins/test-utils';

const Noop = (): null => null;
const boom = (): never => {
  throw new Error('listener boom');
};

afterEach(() => vi.restoreAllMocks());

describe('注册表通知:一个监听器抛错不影响注册与其它监听器', () => {
  it('keyed 注册表:插件监听器抛错 → 他人的 register 照常返回 Disposable,其它监听器照常收到,可注销可重注册', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const coApp = createTestCoApp('1.0.0');
    const evil = createScopedApp(coApp, 'evil', null, 'token-evil');
    const core = createScopedApp(coApp, 'core.terminal', null);
    const after = vi.fn();
    evil.commands.subscribe(boom);
    coApp.commands.subscribe(after);

    const d = core.commands.register({ id: 'terminal.new', title: 'New Terminal', fn: () => {} });
    expect(after).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    expect(coApp.commands.get('terminal.new')?.title).toBe('New Terminal');
    // 所有者已登记:同一所有者可重注册(此前无记录 → PERMISSION_DENIED)。
    expect(() =>
      core.commands.register({ id: 'terminal.new', title: 'v2', fn: () => {} }),
    ).not.toThrow();
    d.dispose(); // 被 v2 顶替的旧句柄:no-op
    expect(coApp.commands.get('terminal.new')?.title).toBe('v2');
  });

  it('注销时的通知同样隔离:dispose 不抛,条目确实删除', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const coApp = createTestCoApp('1.0.0');
    const d = coApp.panels.register({ type: 'p', title: 'P', factory: Noop });
    coApp.panels.subscribe(boom);
    const after = vi.fn();
    coApp.panels.subscribe(after);
    expect(() => d.dispose()).not.toThrow();
    expect(coApp.panels.get('p')).toBeUndefined();
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('explorerDecorators:监听器抛错不打断 register / dispose', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const coApp = createTestCoApp('1.0.0');
    const evil = createScopedApp(coApp, 'evil', null, 'token-evil');
    const other = createScopedApp(coApp, 'other', null, 'token-other');
    const after = vi.fn();
    evil.explorerDecorators.subscribe(boom);
    coApp.explorerDecorators.subscribe(after);
    const fn = (): null => null;
    const d = other.explorerDecorators.register(fn);
    expect(coApp.explorerDecorators.getAll()).toEqual([fn]);
    expect(() => d.dispose()).not.toThrow();
    expect(coApp.explorerDecorators.getAll()).toEqual([]);
    expect(after).toHaveBeenCalledTimes(2);
  });

  it('所有者在通知之前登记:监听器里同步读到的新条目已有所有者', () => {
    const coApp = createTestCoApp('1.0.0');
    const core = createScopedApp(coApp, 'core.terminal', null);
    const seen: boolean[] = [];
    coApp.panels.subscribe(() => {
      const spec = coApp.panels.get('terminal');
      if (spec) seen.push(isThirdPartyContribution(spec));
    });
    core.panels.register({ type: 'terminal', title: 'Terminal', factory: Noop });
    expect(seen).toEqual([false]);
  });

  it('注册被注册表拒绝(校验失败)→ 不留下所有者记录与条目', () => {
    const coApp = createTestCoApp('1.0.0');
    const evil = createScopedApp(coApp, 'evil', null, 'token-evil');
    expect(() => evil.commands.register({ id: 'x', title: '', fn: () => {} })).toThrow();
    expect(coApp.commands.get('x')).toBeUndefined();
  });
});
