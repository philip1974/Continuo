// @vitest-environment jsdom
// BDD: external-link-trusted-domains / 设置页「受信任的域」:列出默认项(只读)与用户项,可添加 / 移除(经 IPC 写到 main);
// 确认框里「信任 <域名>」等别处的变更经广播实时出现;命令「管理受信任的域」打开设置并只列出这一项。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({
  user: ['https://saved.test'] as readonly string[],
  persistBlocked: false,
  set: vi.fn(),
  changed: null as ((list: readonly string[]) => void) | null,
}));

vi.mock('@/lib/co-api', () => ({
  coApi: {
    shell: {
      getTrustedDomains: vi.fn(async () => ({
        ok: true,
        data: { user: h.user, defaults: ['https://github.com/philip1974/Continuo'], persistBlocked: h.persistBlocked },
      })),
      setTrustedDomains: h.set,
      onTrustedDomainsChanged: (cb: (list: readonly string[]) => void) => {
        h.changed = cb;
        return () => {
          h.changed = null;
        };
      },
    },
  },
}));

import { TrustedDomainsSettingRow } from '../../plugins/settings/TrustedDomainsSettingRow';
import { WORKBENCH_TRUSTED_DOMAINS } from '../../plugins/settings/core-setting-specs';
import { t } from '../../i18n';

beforeEach(() => {
  h.user = ['https://saved.test'];
  h.persistBlocked = false;
  h.set.mockReset();
  h.set.mockImplementation(async (list: readonly string[]) => ({ ok: true, data: list }));
});
afterEach(() => cleanup());

describe('设置页「受信任的域」', () => {
  it('列出默认项(标「默认」、不可移除)与用户项', async () => {
    render(<TrustedDomainsSettingRow spec={WORKBENCH_TRUSTED_DOMAINS} />);
    expect(await screen.findByText('https://saved.test')).toBeTruthy();
    expect(screen.getByText('https://github.com/philip1974/Continuo')).toBeTruthy();
    expect(screen.getByText(t('settings.trusted_domains.default_badge'))).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /https:/ })).toHaveLength(1); // 只有用户项有移除按钮
  });

  it('添加:输入后回车 / 点「添加」→ 整体写回 main,输入框清空', async () => {
    render(<TrustedDomainsSettingRow spec={WORKBENCH_TRUSTED_DOMAINS} />);
    await screen.findByText('https://saved.test');
    const input = screen.getByRole('textbox', { name: t('settings.trusted_domains.input_label') });
    fireEvent.change(input, { target: { value: '  *.example.com ' } });
    fireEvent.click(screen.getByRole('button', { name: t('settings.trusted_domains.add') }));
    await waitFor(() => expect(h.set).toHaveBeenCalledWith(['https://saved.test', '*.example.com']));
    expect(await screen.findByText('*.example.com')).toBeTruthy();
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('移除用户项', async () => {
    render(<TrustedDomainsSettingRow spec={WORKBENCH_TRUSTED_DOMAINS} />);
    await screen.findByText('https://saved.test');
    fireEvent.click(screen.getByRole('button', { name: t('settings.trusted_domains.remove', { domain: 'https://saved.test' }) }));
    await waitFor(() => expect(h.set).toHaveBeenCalledWith([]));
    expect(await screen.findByText(t('settings.trusted_domains.empty'))).toBeTruthy();
  });

  it('main 广播的变更(确认框里「信任 <域名>」)实时出现', async () => {
    render(<TrustedDomainsSettingRow spec={WORKBENCH_TRUSTED_DOMAINS} />);
    await screen.findByText('https://saved.test');
    act(() => h.changed?.(['https://saved.test', 'https://docs.example.com']));
    expect(await screen.findByText('https://docs.example.com')).toBeTruthy();
  });

  it('main 报告本次修改存不下来(读盘失败)→ 列表上方写明「不会保存」;正常时不显示', async () => {
    const view = render(<TrustedDomainsSettingRow spec={WORKBENCH_TRUSTED_DOMAINS} />);
    await screen.findByText('https://saved.test');
    expect(screen.queryByText(t('settings.trusted_domains.not_saved'))).toBeNull();
    view.unmount();
    h.persistBlocked = true;
    render(<TrustedDomainsSettingRow spec={WORKBENCH_TRUSTED_DOMAINS} />);
    expect((await screen.findByText(t('settings.trusted_domains.not_saved'))).getAttribute('role')).toBe('status');
  });
});

describe('命令「管理受信任的域」', () => {
  it('打开设置并以 @id:workbench.trustedDomains 过滤', async () => {
    const toggle = await import('../../lib/toggle-settings-panel');
    const spy = vi.spyOn(toggle, 'openSettingsWithQuery').mockImplementation(() => {});
    const { default: SettingsPanelPlugin } = await import('../../core-plugins/SettingsPanelPlugin');
    const commands: { id: string; fn: () => void }[] = [];
    const plugin = Object.create(SettingsPanelPlugin.prototype) as InstanceType<typeof SettingsPanelPlugin>;
    Object.assign(plugin, {
      registerPanel: () => {},
      addCommand: (c: { id: string; fn: () => void }) => commands.push(c),
    });
    plugin.onload();
    commands.find((c) => c.id === 'workbench.action.manageTrustedDomain')!.fn();
    expect(spy).toHaveBeenCalledWith('@id:workbench.trustedDomains');
  });
});
