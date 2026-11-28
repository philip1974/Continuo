// @vitest-environment jsdom
// BDD: plugin-failure-notify(见同目录 README)。
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { state } = vi.hoisted(() => ({ state: { list: [] as unknown[] } }));
vi.mock('../../plugins/PluginManager', async () => {
  const { asSubscribableManager } = await import('../plugins-tab-content/fake-user-plugin-manager');
  const mgr = { listAll: () => state.list };
  return { getUserPluginManager: () => asSubscribableManager(mgr), setUserPluginManager: vi.fn() };
});

import { setLocale } from '@/i18n/translate';
import { notify } from '../../notifications/notify';
import { localizePluginError } from '../../plugins/plugin-error-text';
import { PluginFailureNotifier } from '../../plugins/PluginFailureNotifier';
import { notifyUserPluginListChanged } from '../plugins-tab-content/fake-user-plugin-manager';

const item = (status: string, error?: { code: string; message: string }) => ({
  id: 'acme.x',
  manifest: { id: 'acme.x', name: 'Acme X', version: '1.0.0' },
  status,
  ...(error ? { error } : {}),
});

beforeEach(() => setLocale('en'));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setLocale('zh');
});

describe('localizePluginError', () => {
  it.each([
    [{ code: 'PERMISSION_DENIED', message: 'fs, network', params: { perms: 'fs, network' } }, 'Required permissions denied: fs, network', '所需权限已被拒绝：fs, network'],
    [{ code: 'IMPORT_FAILED', message: 'SyntaxError' }, 'Failed to load the plugin entry: SyntaxError', '插件入口加载失败：SyntaxError'],
    [{ code: 'RENDER_FAILED', message: 'boom' }, 'UI failed to render: boom', '界面渲染出错：boom'],
    [{ code: 'EXCEPTION', message: 'kaput' }, 'Activation failed: kaput', '激活失败：kaput'],
    [{ code: 'EBOOM', message: 'kaput' }, 'Activation failed: kaput', '激活失败：kaput'],
    [{ code: 'NO_DEFAULT_EXPORT', message: 'raw' }, 'Plugin has no default export', '插件没有 export default'],
  ])('%o → 本地化文案(en / zh),不出现原始 code', (error, en, zh) => {
    expect(localizePluginError(error)).toBe(en);
    setLocale('zh');
    expect(localizePluginError(error)).toBe(zh);
  });
});

describe('PluginFailureNotifier', () => {
  it('挂载时已 failed → 通知一次(插件名 + 本地化原因 + 设置指引,带 code);列表再变化同一失败不重复', () => {
    const spy = vi.spyOn(notify, 'error').mockImplementation(() => {});
    state.list = [item('failed', { code: 'EXCEPTION', message: 'kaput' })];
    notifyUserPluginListChanged();
    render(<PluginFailureNotifier />);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      'Plugin “Acme X”: Activation failed: kaput. Retry or disable it in Settings › Plugins.',
      { code: 'EXCEPTION' },
    );
    act(() => {
      state.list = [item('failed', { code: 'EXCEPTION', message: 'kaput' })];
      notifyUserPluginListChanged();
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('恢复 enabled 后再失败 / 失败原因变化 → 再通知', () => {
    const spy = vi.spyOn(notify, 'error').mockImplementation(() => {});
    state.list = [item('failed', { code: 'EXCEPTION', message: 'a' })];
    notifyUserPluginListChanged();
    render(<PluginFailureNotifier />);
    act(() => {
      state.list = [item('enabled')];
      notifyUserPluginListChanged();
    });
    act(() => {
      state.list = [item('failed', { code: 'EXCEPTION', message: 'a' })];
      notifyUserPluginListChanged();
    });
    act(() => {
      state.list = [item('failed', { code: 'RENDER_FAILED', message: 'b' })];
      notifyUserPluginListChanged();
    });
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('被禁用 / 卸载中止的激活不通知', () => {
    const spy = vi.spyOn(notify, 'error').mockImplementation(() => {});
    state.list = [item('failed', { code: 'ACTIVATION_ABORTED', message: 'x' })];
    notifyUserPluginListChanged();
    render(<PluginFailureNotifier />);
    act(() => {
      state.list = [item('failed', { code: 'NOT_INSTALLED', message: 'x' })];
      notifyUserPluginListChanged();
    });
    expect(spy).not.toHaveBeenCalled();
  });
});
