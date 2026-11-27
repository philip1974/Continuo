// @vitest-environment jsdom
// BDD:差异 tab 不进持久化布局;标题随界面语言切换(titleKey + titleArgs)。见同目录 README 契约 2、6。
import { afterEach, describe, expect, it } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import type { DockviewApi, SerializedDockview } from 'dockview-react';
import { stripTerminalPanelsFromLayout } from '@/shell/dock/strip-terminal-layout';
import { useDockLocaleSync } from '@/shell/dock/useDockLocaleSync';
import { setLocale } from '@/i18n/translate';
import { notifyLocaleChange } from '@/i18n/react';
import { CONFLICT_DIFF_PANEL_TYPE, CONFLICT_DIFF_TITLE_KEY } from '@/panels/Editor/conflict-diff-constants';

afterEach(() => {
  cleanup();
  setLocale('zh');
});

describe('布局持久化剥离差异 tab', () => {
  it('与编辑器同组的差异 tab 被剥离,编辑器保留并成为该组活动面板', () => {
    const diffId = `${CONFLICT_DIFF_PANEL_TYPE}:/w/a.ts`;
    const layout = {
      grid: {
        root: {
          type: 'branch',
          data: [{ type: 'leaf', data: { id: '1', views: ['editor', diffId], activeView: diffId }, size: 700 }],
          size: 800,
        },
        width: 1000,
        height: 800,
        orientation: 'HORIZONTAL',
      },
      panels: {
        editor: { id: 'editor', contentComponent: 'editor' },
        [diffId]: { id: diffId, contentComponent: CONFLICT_DIFF_PANEL_TYPE },
      },
      activeGroup: '1',
    } as unknown as SerializedDockview;
    const out = stripTerminalPanelsFromLayout(layout) as unknown as {
      panels: Record<string, unknown>;
      grid: { root: { data: Array<{ data: { views: string[]; activeView?: string } }> } };
    };
    expect(Object.keys(out.panels)).toEqual(['editor']);
    expect(out.grid.root.data[0]!.data.views).toEqual(['editor']);
    expect(out.grid.root.data[0]!.data.activeView).toBe('editor');
  });
});

describe('差异 tab 标题随语言切换', () => {
  it('按 titleKey + titleArgs 重算', () => {
    setLocale('zh');
    let title = 'a.ts（在磁盘上）↔ a.ts（你的版本）';
    const panel = {
      api: {
        id: `${CONFLICT_DIFF_PANEL_TYPE}:/w/a.ts`,
        get title() {
          return title;
        },
        setTitle: (next: string) => {
          title = next;
        },
      },
      params: { tabId: '/w/a.ts', groupId: 'editor', titleKey: CONFLICT_DIFF_TITLE_KEY, titleArgs: { name: 'a.ts' } },
    };
    const api = {
      panels: [panel],
      onDidAddPanel: () => ({ dispose() {} }),
      onDidLayoutChange: () => ({ dispose() {} }),
    } as unknown as DockviewApi;
    renderHook(() => useDockLocaleSync(api));
    act(() => {
      setLocale('en');
      notifyLocaleChange();
    });
    expect(title).toBe('a.ts (on Disk) ↔ a.ts (Your Version)');
    act(() => {
      setLocale('ko');
      notifyLocaleChange();
    });
    expect(title).toBe('a.ts(디스크) ↔ a.ts(내 버전)');
  });
});
