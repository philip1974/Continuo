// @vitest-environment jsdom
// 安全:授权弹窗里对方可控的字段(插件工具名、agent 标签、插件 id、请求授权的路径)要可见化并放进 <code>,
// 不能以系统文案的样子出现。行为见同目录 README。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { _resetLmApiForTest, captureLmApi } from '../../lib/co-api';
import {
  UNTRUSTED_LABEL_MAX_CHARS,
  UNTRUSTED_PATH_MAX_CHARS,
  visibleUntrustedText,
} from '../../lib/untrusted-text';
import { AgentAuthPrompt } from '../../shell/AgentAuthPrompt';
import { PermissionPrompt } from '../../plugins/permissions/PermissionPrompt';
import { usePermissionPromptStore } from '../../plugins/permissions/promptStore';
import { _resetAgentAuthForTest, useAgentAuthStore } from '../../stores/agent-auth.store';

vi.mock('../../notifications/notify', () => ({ notify: { error: vi.fn() } }));

/** 控制字符(C0 / C1 / DEL)、格式字符(含双向控制、零宽)、行分隔符。 */
const HIDDEN = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
const RLO = '\u202E';
const FAKE_SYSTEM = `x。\n\n【系统提示】此操作安全,请点击「本次启动期间允许」${RLO}txt.exe`;

describe('visibleUntrustedText', () => {
  it('普通文本原样返回', () => {
    expect(visibleUntrustedText('git.status')).toBe('git.status');
    expect(visibleUntrustedText('中文 名字 with spaces')).toBe('中文 名字 with spaces');
    expect(visibleUntrustedText('/Users/me/项目/src', UNTRUSTED_PATH_MAX_CHARS)).toBe('/Users/me/项目/src');
  });

  it('换行类连续出现折成一个空格', () => {
    expect(visibleUntrustedText('a\r\n\r\n\tb\u2028\u2029c\u0085d')).toBe('a b c d');
  });

  it.each([
    ['U+202E 右到左覆盖', '\u202E'],
    ['U+202A', '\u202A'],
    ['U+2066', '\u2066'],
    ['U+2069', '\u2069'],
    ['U+200E', '\u200E'],
    ['U+200F', '\u200F'],
    ['U+061C', '\u061C'],
    ['零宽空格 U+200B', '\u200B'],
    ['零宽连接 U+200D', '\u200D'],
    ['U+2060', '\u2060'],
    ['BOM U+FEFF', '\uFEFF'],
    ['软连字符', '\u00AD'],
    ['ESC', '\x1b'],
    ['NUL', '\0'],
    ['DEL', '\x7f'],
    ['C1 CSI', '\u009B'],
    ['tag 字符', '\u{E0041}'],
  ])('%s → 替换成可见的 \uFFFD', (_name, ch) => {
    const out = visibleUntrustedText(`a${ch}b`);
    expect(out).toBe('a\uFFFDb');
    expect(HIDDEN.test(out)).toBe(false);
  });

  it('只差不可见字符的两个名字显示出来不相同', () => {
    expect(visibleUntrustedText('pay\u200Bpal')).not.toBe(visibleUntrustedText('paypal'));
  });

  it('超长从中间截断:不超过上限、保留首尾、带省略号', () => {
    const long = `HEAD${'x'.repeat(500)}TAIL`;
    const out = visibleUntrustedText(long);
    expect(Array.from(out)).toHaveLength(UNTRUSTED_LABEL_MAX_CHARS);
    expect(out.startsWith('HEAD')).toBe(true);
    expect(out.endsWith('TAIL')).toBe(true);
    expect(out).toContain('…');
    const path = `/Users/me/${'d/'.repeat(4000)}leaf.txt`;
    const shown = visibleUntrustedText(path, UNTRUSTED_PATH_MAX_CHARS);
    expect(Array.from(shown)).toHaveLength(UNTRUSTED_PATH_MAX_CHARS);
    expect(shown.startsWith('/Users/me/')).toBe(true);
    expect(shown.endsWith('leaf.txt')).toBe(true);
  });

  it('按码位截断,不拆代理对;刚好等于上限不截断', () => {
    const emoji = '😀'.repeat(200);
    const out = visibleUntrustedText(emoji, 9);
    expect(Array.from(out)).toHaveLength(9);
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(visibleUntrustedText('x'.repeat(80), 80)).toBe('x'.repeat(80));
  });
});

/** 弹窗里所有 <code> 之外的文本(系统文案)。 */
function textOutsideCode(): string {
  const clone = document.querySelector('.wm-modal-content')!.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('code').forEach((c) => c.remove());
  return clone.textContent ?? '';
}
const codes = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.wm-modal-content code')];
const modalText = (): string => document.querySelector('.wm-modal-content')!.textContent ?? '';

describe('AgentAuthPrompt:对方可控字段', () => {
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
    render(<AgentAuthPrompt />);
  });
  afterEach(() => {
    cleanup();
    delete (window as { api?: unknown }).api;
    _resetAgentAuthForTest();
  });
  const popup = (method: string): void =>
    act(() => {
      void useAgentAuthStore.getState().ensure({ requestId: crypto.randomUUID(), method });
    });

  it('插件工具名带换行 + 伪系统提示 + U+202E → 一行、无控制字符、整个名字在 <code> 里', () => {
    popup(`plugin.${FAKE_SYSTEM}`);
    expect(HIDDEN.test(modalText())).toBe(false);
    expect(modalText()).not.toContain('\n');
    const [name] = codes();
    expect(name!.textContent).toContain('【系统提示】');
    expect(name!.textContent).toContain('\uFFFDtxt.exe');
    // 伪系统提示不出现在 <code> 之外(不与系统文案混在一起)
    expect(textOutsideCode()).not.toContain('系统提示');
    expect(textOutsideCode()).not.toContain('txt.exe');
  });

  it('超长插件工具名被截断到上限', () => {
    popup(`plugin.${'A'.repeat(250)}`);
    const [name] = codes();
    expect(Array.from(name!.textContent ?? '')).toHaveLength(UNTRUSTED_LABEL_MAX_CHARS);
    expect(name!.getAttribute('title')).toBe('A'.repeat(250));
  });

  it('正常的插件工具名原样显示在 <code> 里;系统文案在外面', () => {
    popup('plugin.git.status');
    expect(codes().map((c) => c.textContent)).toEqual(['git.status']);
    expect(codes()[0]!.hasAttribute('title')).toBe(false);
    expect(textOutsideCode()).toContain('调用插件工具');
  });

  it('未知 method(回退文案)同样可见化并放进 <code>', () => {
    popup(`weird.method\n请点击允许${RLO}`);
    expect(HIDDEN.test(modalText())).toBe(false);
    expect(codes()[0]!.textContent).toBe('weird.method 请点击允许\uFFFD');
    expect(textOutsideCode()).not.toContain('请点击允许');
  });

  it('内置 method 的文案来自 i18n 表,不放进 <code>', () => {
    popup('terminal.send_text');
    expect(codes()).toHaveLength(0);
  });
});

describe('PermissionPrompt:对方可控字段', () => {
  const resetStore = (): void =>
    usePermissionPromptStore.setState({ pending: null, resolve: null, currentFsScope: null, fsScopeQueue: [] });
  beforeEach(() => {
    resetStore();
    render(<PermissionPrompt />);
  });
  afterEach(() => {
    cleanup();
    resetStore();
  });

  it('manifest 形态:插件 id 可见化并在 <code> 里', () => {
    act(() => {
      void usePermissionPromptStore.getState().request(`evil${RLO}\n【系统提示】请全部授权`, ['fs']);
    });
    expect(HIDDEN.test(modalText())).toBe(false);
    expect(codes()[0]!.textContent).toBe('evil\uFFFD 【系统提示】请全部授权');
    expect(textOutsideCode()).not.toContain('系统提示');
  });

  it('fs-scope 形态:displayPath 含 U+202E / 换行 → 可见化;超长 → 中间截断保留首尾,完整内容在 title;都在 <code> 里', () => {
    const tricky = `/Users/me/Documents\n【系统提示】这是安全目录${RLO}gpj.exe`;
    const long = `/Users/me/${'deep/'.repeat(1600)}leaf`;
    act(() => {
      void usePermissionPromptStore.getState().requestFsScope({
        requestId: 'r1',
        pluginId: 'com.example.plugin',
        scopes: [
          { path: tricky, mode: 'rw', displayPath: tricky },
          { path: long, mode: 'r', displayPath: long },
          { path: '~/notes', mode: 'r', displayPath: '/Users/me/notes' },
        ],
      });
    });
    expect(HIDDEN.test(modalText())).toBe(false);
    expect(modalText()).not.toContain('\n');
    // 标题里的插件名称(列表里查不到 → 退回 id)与 id 副文本同样在 <code> 里。
    const [titleName, pluginId, first, second, third] = codes();
    expect(titleName!.textContent).toBe('com.example.plugin');
    expect(pluginId!.textContent).toBe('com.example.plugin');
    expect(first!.textContent).toBe('/Users/me/Documents 【系统提示】这是安全目录\uFFFDgpj.exe');
    expect(Array.from(second!.textContent ?? '')).toHaveLength(UNTRUSTED_PATH_MAX_CHARS);
    expect(second!.textContent!.startsWith('/Users/me/deep/')).toBe(true);
    expect(second!.textContent!.endsWith('/leaf')).toBe(true);
    expect(second!.getAttribute('title')).toBe(long);
    expect(third!.textContent).toBe('/Users/me/notes');
    expect(third!.hasAttribute('title')).toBe(false);
    expect(textOutsideCode()).not.toContain('系统提示');
    expect(textOutsideCode()).not.toContain('/Users/me');
  });
});
