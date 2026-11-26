// @vitest-environment jsdom
// en 计数文案按单复数(_one / _other + translateCount)。行为见同目录 README。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { LOCALE_DICTS } from '../../../electron/shared/i18n-interpolate';
import { setLocale, translateCount } from '../../i18n';
import { notifyLocaleChange } from '../../i18n/react';
import { _resetLmApiForTest, captureLmApi } from '../../lib/co-api';
import { StatusBar } from '../../shell/StatusBar';
import { useTerminalStore } from '../../stores/terminal.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useEditorStore } from '../../stores/editor.store';
import { TerminalSearchBar } from '../../panels/Terminal/TerminalSearchBar';
import type { SearchApi } from '../../panels/Terminal/useTerminal';

vi.mock('../../plugins/sandbox-sweep', () => ({
  getCachedFetch: () => globalThis.fetch,
  getCachedClipboard: () => ({ readText: () => Promise.resolve(''), writeText: vi.fn() }),
  sandboxSweep: () => {},
}));

/**
 * 含 {count} 但不需要单复数对的 en key(不带可数名词,或调用点保证计数 ≥ 2)。新增带 {count} 的 en 文案:
 * 优先拆 _one / _other 走 translateCount;确实不涉及单复数才加到这里并写明原因。
 */
const NO_PLURAL_NEEDED: Record<string, string> = {
  'panels.explorer.trash_confirm.multiple': '仅多选(≥2)时使用',
  'panels.explorer.move_confirm.multiple': '仅多项(≥2)时使用(1 项用 move_confirm.single)',
  'panels.explorer.overwrite_confirm.multiple': '仅多项(≥2)时使用(1 项用 overwrite_confirm.single)',
  'panels.explorer.trash_confirm.more': '无可数名词(…and N more)',
  'panels.explorer.trash_confirm.unsaved': '仅 count > 1 时使用(1 用 unsaved_one / unsaved_single)',
  'panels.explorer.ctx.items_count': '仅多选(> 1)时显示',
  'notifications.repeat_announce': '合并重复通知时计数 ≥ 2',
  'statusbar.mcp.revoke_tooltip': '无可数名词(… N in this window)',
  'errors.folder.batch_failed': '无可数名词(N failed)',
  'settings.panel.matched': '无可数名词(Matched N)',
  'permissions.prompt.grant_selected': '无可数名词(Grant selected (N))',
};

const sess = (id: string, originHint: 'agent' | 'user') => ({
  id,
  title: id,
  cwd: '/',
  originHint,
  createdAt: 0,
  exitCode: null,
  ownerWindowId: 1,
});

function searchApi(result: { index: number; count: number }): SearchApi {
  return {
    isOpen: true,
    term: 'x',
    options: { regex: false, caseSensitive: false, wholeWord: false },
    result,
    focusRequest: 1,
    open: vi.fn(),
    close: vi.fn(),
    next: vi.fn(),
    prev: vi.fn(),
    setTerm: vi.fn(),
    setOptions: vi.fn(),
    clearActiveDecoration: vi.fn(),
  } as unknown as SearchApi;
}

beforeEach(() => {
  _resetLmApiForTest();
  Object.defineProperty(window, 'api', { value: {}, writable: true, configurable: true });
  captureLmApi();
  useWorkspaceStore.setState({ root: null, recentRoots: [] });
  useEditorStore.setState({ tabs: [], activeTabId: null });
  setLocale('en');
});
afterEach(() => {
  delete (window as { api?: unknown }).api;
  cleanup();
  act(() => {
    setLocale('en');
    notifyLocaleChange();
  });
});

describe('守护:en 中带 {count} 的文案', () => {
  it('要么是 _one / _other 成对 key,要么用 (s),要么在豁免表中', () => {
    const en = LOCALE_DICTS.en as Record<string, string>;
    const bad: string[] = [];
    for (const [key, text] of Object.entries(en)) {
      if (!text.includes('{count}')) continue;
      const pair = /^(.*)_(one|other)$/.exec(key);
      if (pair) {
        if (en[`${pair[1]}_one`] === undefined || en[`${pair[1]}_other`] === undefined) bad.push(`${key}(缺另一半)`);
        continue;
      }
      if (text.includes('(s)') || key in NO_PLURAL_NEEDED) continue;
      bad.push(`${key}: ${text}`);
    }
    expect(bad).toEqual([]);
  });

  it('豁免表里的 key 都仍存在(删 / 改名后同步清理)', () => {
    const en = LOCALE_DICTS.en as Record<string, string>;
    expect(Object.keys(NO_PLURAL_NEEDED).filter((k) => en[k] === undefined)).toEqual([]);
  });

  it.each([
    ['statusbar.agent_sessions', '1 agent', '2 agents'],
    ['marketplace.reviews.count', '(1 review)', '(2 reviews)'],
    ['marketplace.reviews.thumbs_up', '1 like', '2 likes'],
    ['panels.terminal.search.match_total', '1 match', '2 matches'],
  ])('en %s:1 → 单数,2 → 复数', (key, one, two) => {
    expect(translateCount(key, 1)).toBe(one);
    expect(translateCount(key, 2)).toBe(two);
  });
});

describe('调用点按单复数渲染', () => {
  it('状态栏 agent 计数:1 agent / 2 agents', () => {
    useTerminalStore.setState({ sessions: [sess('a1', 'agent'), sess('u1', 'user')] });
    const r = render(<StatusBar />);
    expect(r.container.textContent).toContain('1 agent');
    expect(r.container.textContent).not.toContain('1 agents');
    act(() => {
      useTerminalStore.setState({ sessions: [sess('a1', 'agent'), sess('a2', 'agent')] });
    });
    expect(r.container.textContent).toContain('2 agents');
  });

  it('终端搜索只显示总数:1 match / 20 matches / 达上限 1000+ matches', () => {
    const one = render(<TerminalSearchBar searchApi={searchApi({ index: -1, count: 1 })} onClose={vi.fn()} />);
    expect(one.getByRole('status').textContent).toBe('1 match');
    cleanup();
    const many = render(<TerminalSearchBar searchApi={searchApi({ index: -1, count: 20 })} onClose={vi.fn()} />);
    expect(many.getByRole('status').textContent).toBe('20 matches');
    cleanup();
    const capped = render(<TerminalSearchBar searchApi={searchApi({ index: -1, count: 1000 })} onClose={vi.fn()} />);
    expect(capped.getByRole('status').textContent).toBe('1000+ matches');
  });
});
