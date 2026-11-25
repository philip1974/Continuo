// @vitest-environment jsdom
// BDD: permission-prompt —— 授权弹窗以插件名称称呼(id 作副文本),说明文案不含开发者术语(见同目录 README「插件身份与文案」)。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

vi.mock('../../plugins/PluginManager', async () => {
  const { asSubscribableManager } = await import('../plugins-tab-content/fake-user-plugin-manager');
  const mgr = {
    listAll: () => [{ id: 'acme.tool', manifest: { id: 'acme.tool', name: 'Acme Tool', version: '1.0.0' }, status: 'disabled' }],
  };
  return { getUserPluginManager: () => asSubscribableManager(mgr), setUserPluginManager: vi.fn() };
});

import { setLocale } from '@/i18n/translate';
import { en } from '../../../electron/shared/i18n-locales/en';
import { ko } from '../../../electron/shared/i18n-locales/ko';
import { zh } from '../../../electron/shared/i18n-locales/zh';
import { PermissionPrompt } from '../../plugins/permissions/PermissionPrompt';
import { PermissionEditorModal } from '../../plugins/permissions/PermissionEditorModal';
import { usePermissionPromptStore } from '../../plugins/permissions/promptStore';

beforeEach(() => {
  setLocale('en');
  usePermissionPromptStore.setState({ pending: null, resolve: null, currentFsScope: null });
});
afterEach(() => cleanup());

function dialogParts(): { title: string; dialog: Element; codes: string[] } {
  const dialog = document.querySelector('.wm-modal-content')!;
  const title = document.getElementById(dialog.getAttribute('aria-labelledby')!)!.textContent ?? '';
  const codes = Array.from(dialog.querySelectorAll('code'), (c) => c.textContent ?? '');
  return { title, dialog, codes };
}

describe('授权弹窗以插件名称称呼', () => {
  it('启用时的权限请求:标题含插件名,id 作副文本(等宽),标题不含 id', () => {
    render(<PermissionPrompt />);
    act(() => {
      void usePermissionPromptStore.getState().request('acme.tool', ['fs']);
    });
    const { title, codes } = dialogParts();
    expect(title).toContain('Acme Tool');
    expect(title).not.toContain('acme.tool');
    // 名称与 id 都由插件提供 → 都在 <code> 里(不与系统文案混);id 在标题之外作副文本。
    expect(codes.slice(0, 2)).toEqual(['Acme Tool', 'acme.tool']);
  });

  it('运行时的文件夹访问请求:同样以名称称呼,id 作副文本', () => {
    render(<PermissionPrompt />);
    act(() => {
      usePermissionPromptStore.setState({
        currentFsScope: { requestId: 'r1', pluginId: 'acme.tool', scopes: [{ path: '/w', displayPath: '/w', mode: 'r' }] },
      });
    });
    const { title, codes } = dialogParts();
    expect(title).toContain('Acme Tool');
    expect(title).not.toContain('acme.tool');
    // 名称与 id 都由插件提供 → 都在 <code> 里(不与系统文案混);id 在标题之外作副文本。
    expect(codes.slice(0, 2)).toEqual(['Acme Tool', 'acme.tool']);
  });

  it('列表里查不到(尚未登记)→ 退回显示 id', () => {
    render(<PermissionPrompt />);
    act(() => {
      void usePermissionPromptStore.getState().request('other.x', ['fs']);
    });
    expect(dialogParts().title).toContain('other.x');
  });
});

describe('面向用户的文案不含开发者术语(三语)', () => {
  const catalogs = { en, zh, ko } as Record<string, Record<string, string>>;
  it.each(['en', 'zh', 'ko'])('%s:授权说明不提 PermissionError / API;卸载确认不提 git URL', (locale) => {
    const c = catalogs[locale]!;
    const note = `${c['permissions.prompt.note_prefix']}${c['permissions.prompt.note_partial']}${c['permissions.prompt.note_suffix']}`;
    expect(note).not.toMatch(/PermissionError|API|抛/);
    expect(c['plugins_tab.uninstall.body']).not.toMatch(/git|\{id\}/i);
    expect(c['plugins_tab.uninstall.body']).toContain('{name}');
  });
});

describe('权限编辑弹窗同样以名称称呼', () => {
  it('「插件」一行显示名称,id 作等宽副文本', async () => {
    const store = { get: vi.fn(async () => []), grant: vi.fn(), deny: vi.fn(), clearDenied: vi.fn() } as never;
    render(<PermissionEditorModal open pluginId="acme.tool" declared={['fs']} store={store} onClose={() => {}} />);
    const dialog = document.querySelector('.wm-modal-content')!;
    expect(dialog.querySelector('[data-plugin-name]')?.textContent).toBe('Acme Tool');
    expect(Array.from(dialog.querySelectorAll('code'), (c) => c.textContent)).toEqual(['Acme Tool', 'acme.tool']);
  });
});
