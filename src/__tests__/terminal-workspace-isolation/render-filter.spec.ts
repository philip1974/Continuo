// BDD: terminal-workspace-isolation — render filter
//
// 锁 invariant:InternalTerminalPanel 按当前 workspaceRoot 过滤可见 tabs。
// hidden tab 留在 state.tabs(PTY 保活,切回去恢复),activeTabId 落在 hidden
// tab 上时回退到第一个 visible tab。

import { describe, it, expect } from 'vitest';
import { filterTabsByWorkspace } from '../../panels/Terminal/TerminalPanel';

interface FakeTab {
  id: string;
  workspaceRoot?: string;
}

const t = (id: string, workspaceRoot?: string): FakeTab => ({
  id,
  ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
});

describe('filterTabsByWorkspace', () => {
  it('current workspace 命中 → 该 tab 显示', () => {
    const r = filterTabsByWorkspace([t('a', '/proj-a')], 'a', '/proj-a');
    expect(r.visibleTabs.map((x) => x.id)).toEqual(['a']);
    expect(r.effectiveActiveId).toBe('a');
  });

  it('其它 workspace 的 tab → 不显示但仍在 state(由 caller 持)', () => {
    const tabs = [t('a', '/proj-a'), t('b', '/proj-b')];
    const r = filterTabsByWorkspace(tabs, 'a', '/proj-b');
    expect(r.visibleTabs.map((x) => x.id)).toEqual(['b']);
  });

  it('workspaceRoot=undefined(全局,如 agent) → 任何 workspace 都显示', () => {
    const tabs = [t('a', '/proj-a'), t('global'), t('c', '/proj-c')];
    const inA = filterTabsByWorkspace(tabs, 'global', '/proj-a');
    expect(inA.visibleTabs.map((x) => x.id)).toEqual(['a', 'global']);
    const inC = filterTabsByWorkspace(tabs, 'global', '/proj-c');
    expect(inC.visibleTabs.map((x) => x.id)).toEqual(['global', 'c']);
  });

  it('currentWorkspaceRoot=undefined(没开 workspace) → 仅显示全局 tab', () => {
    const tabs = [t('a', '/proj-a'), t('g')];
    const r = filterTabsByWorkspace(tabs, 'a', undefined);
    expect(r.visibleTabs.map((x) => x.id)).toEqual(['g']);
  });

  it('activeTabId 落在被隐藏 tab → effectiveActiveId 退到第一个 visible', () => {
    const tabs = [t('hidden', '/proj-a'), t('visible', '/proj-b')];
    const r = filterTabsByWorkspace(tabs, 'hidden', '/proj-b');
    expect(r.effectiveActiveId).toBe('visible');
  });

  it('没有任何 visible tab → effectiveActiveId=null', () => {
    const r = filterTabsByWorkspace([t('x', '/proj-a')], 'x', '/proj-b');
    expect(r.visibleTabs).toEqual([]);
    expect(r.effectiveActiveId).toBeNull();
  });

  it('activeTabId=null → effectiveActiveId 直接走第一个 visible 兜底', () => {
    const tabs = [t('a', '/proj-x'), t('b', '/proj-x')];
    const r = filterTabsByWorkspace(tabs, null, '/proj-x');
    expect(r.effectiveActiveId).toBe('a');
  });
});
