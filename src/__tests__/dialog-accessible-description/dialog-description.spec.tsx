// @vitest-environment jsdom
// BDD:确认框 / 授权弹窗经 aria-describedby 暴露说明正文;destructive 确认框是 alertdialog。见同目录 README D1-D4。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { ConfirmDialog } from '../../lib/ConfirmDialog';
import { _resetLmApiForTest, captureLmApi } from '../../lib/co-api';
import { AgentAuthPrompt } from '../../shell/AgentAuthPrompt';
import { PermissionPrompt } from '../../plugins/permissions/PermissionPrompt';
import { usePermissionPromptStore } from '../../plugins/permissions/promptStore';
import { _resetAgentAuthForTest, useAgentAuthStore } from '../../stores/agent-auth.store';
import { t } from '../../i18n';

vi.mock('../../notifications/notify', () => ({ notify: { error: vi.fn() } }));

afterEach(() => cleanup());

/** 对话框 aria-describedby 指向的全部文本(按 id 列表拼接,id 须都存在)。 */
function describedText(dialog: Element): string {
  const ids = (dialog.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
  expect(ids.length).toBeGreaterThan(0);
  return ids
    .map((id) => {
      const el = dialog.ownerDocument.getElementById(id);
      expect(el, `aria-describedby 指向不存在的 id ${id}`).not.toBeNull();
      expect(dialog.contains(el)).toBe(true);
      return el!.textContent ?? '';
    })
    .join(' ');
}

const dialogs = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.wm-modal-content')];

describe('ConfirmDialog', () => {
  it('D1 aria-describedby 指向说明区(含列表等富内容);两个实例 id 不冲突', () => {
    render(
      <>
        <ConfirmDialog
          open
          title="移到废纸篓"
          description={
            <>
              <ul>
                <li>a.ts</li>
              </ul>
              <p>有未保存的更改</p>
            </>
          }
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />
        <ConfirmDialog open title="第二个" description="另一段说明" onConfirm={vi.fn()} onCancel={vi.fn()} />
      </>,
    );
    const [first, second] = dialogs();
    expect(describedText(first!)).toContain('a.ts');
    expect(describedText(first!)).toContain('有未保存的更改');
    expect(describedText(first!)).not.toContain('移到废纸篓');
    expect(describedText(second!)).toBe('另一段说明');
    expect(first!.getAttribute('aria-describedby')).not.toBe(second!.getAttribute('aria-describedby'));
  });

  it('D2 destructive → role=alertdialog(仍 aria-modal + 标题);非 destructive → role=dialog', () => {
    const { rerender } = render(
      <ConfirmDialog open destructive title="终止终端?" description="sleep 仍在运行" onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    let dialog = dialogs()[0]!;
    expect(dialog.getAttribute('role')).toBe('alertdialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('终止终端?');
    expect(describedText(dialog)).toContain('sleep');

    rerender(<ConfirmDialog open title="保存更改?" description="不保存将丢失" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    dialog = dialogs()[0]!;
    expect(dialog.getAttribute('role')).toBe('dialog');
  });
});

describe('AgentAuthPrompt', () => {
  beforeEach(() => {
    _resetLmApiForTest();
    _resetAgentAuthForTest();
    Object.defineProperty(window, 'api', {
      value: {
        agentAuth: {
          onRequest: vi.fn(() => () => {}),
          onRevoked: vi.fn(() => () => {}),
          onCancelled: vi.fn(() => () => {}),
          respond: vi.fn(async () => ({ ok: true })),
        },
      },
      writable: true,
      configurable: true,
    });
    captureLmApi();
  });
  afterEach(() => {
    cleanup();
    delete (window as { api?: unknown }).api;
    _resetAgentAuthForTest();
  });

  it('D3 aria-describedby 覆盖请求说明(动作名)、外部调用方提示与授权后果;不含按钮文字', () => {
    render(<AgentAuthPrompt />);
    act(() => {
      void useAgentAuthStore
        .getState()
        .ensure({ requestId: crypto.randomUUID(), method: 'custom.do_thing', external: true });
    });
    const dialog = dialogs()[0]!;
    expect(dialog.getAttribute('role')).toBe('dialog');
    const text = describedText(dialog);
    expect(text).toContain('custom.do_thing');
    expect(text).toContain(t('permissions.agent.external_caller'));
    expect(text).toContain(t('permissions.agent.hint'));
    expect(text).not.toContain(t('permissions.agent.deny'));
  });
});

describe('PermissionPrompt', () => {
  const resetStore = (): void =>
    usePermissionPromptStore.setState({
      pending: null,
      resolve: null,
      currentFsScope: null,
      fsScopePending: {},
      fsScopeQueue: [],
    });
  beforeEach(resetStore);
  afterEach(() => {
    cleanup();
    resetStore();
  });

  it('D4 manifest 形态:aria-describedby 覆盖说明句(插件 id)与部分授予提示', () => {
    render(<PermissionPrompt />);
    act(() => {
      void usePermissionPromptStore.getState().request('com.example.plugin', ['fs']);
    });
    const dialog = dialogs()[0]!;
    const text = describedText(dialog);
    expect(text).toContain('com.example.plugin');
    expect(text).toContain(t('permissions.prompt.note_partial'));
    expect(text).not.toContain(t('permissions.prompt.select_all'));
  });

  it('D4 fs-scope 形态:aria-describedby 覆盖说明句与申请的路径 / 模式', () => {
    render(<PermissionPrompt />);
    act(() => {
      void usePermissionPromptStore.getState().requestFsScope({
        requestId: 'r1',
        pluginId: 'com.example.plugin',
        scopes: [{ path: '/Users/me/notes', mode: 'rw', displayPath: '/Users/me/notes' }],
      });
    });
    const dialog = dialogs()[0]!;
    const text = describedText(dialog);
    expect(text).toContain('com.example.plugin');
    expect(text).toContain('/Users/me/notes');
    expect(text).toContain(t('permissions.fs_scope.mode_rw'));
    expect(text).not.toContain(t('permissions.fs_scope.deny'));
  });
});
