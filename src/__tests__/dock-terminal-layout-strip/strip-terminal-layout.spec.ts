// 持久化 dockview 布局剥离终端 panel 的纯函数规范。见 ./README.md。
import { describe, it, expect, vi } from 'vitest';
import type { SerializedDockview } from 'dockview-react';
import { stripTerminalPanelsFromLayout } from '@/shell/dock/strip-terminal-layout';

// 便捷构造:横向 root branch + 任意 leaf。
const leaf = (
  id: string,
  views: string[],
  activeView?: string,
  extra: Record<string, unknown> = {},
) => ({ type: 'leaf', data: { id, views, activeView, ...extra }, size: 700 });

const layout = (
  rootChildren: unknown[],
  panels: Record<string, { contentComponent?: string }>,
  rest: Record<string, unknown> = {},
): SerializedDockview =>
  ({
    grid: {
      root: { type: 'branch', data: rootChildren, size: 800 },
      width: 1400,
      height: 800,
      orientation: 'HORIZONTAL',
    },
    panels,
    ...rest,
  }) as unknown as SerializedDockview;

const out = (l: SerializedDockview) =>
  stripTerminalPanelsFromLayout(l) as unknown as {
    panels: Record<string, unknown>;
    grid: { root: { data: Array<{ type: string; data: { views: string[]; activeView?: string; tabGroups?: unknown[] } }> } };
    activeGroup?: string;
    floatingGroups?: Array<{ data: { views: string[] } }>;
    popoutGroups?: Array<{ data: { views: string[] } }>;
  } | null;

describe('stripTerminalPanelsFromLayout', () => {
  it('无终端 → 返回原对象(引用不变)', () => {
    const l = layout([leaf('1', ['editor'], 'editor')], {
      editor: { contentComponent: 'editor' },
    });
    expect(stripTerminalPanelsFromLayout(l)).toBe(l);
  });

  it('扫描 panels 时不通过 Object.entries 全量物化', () => {
    const l = layout([leaf('1', ['editor', 'term-1'], 'term-1')], {
      editor: { contentComponent: 'editor' },
      'term-1': { contentComponent: 'terminal' },
    });
    const entriesSpy = vi.spyOn(Object, 'entries');

    try {
      expect(out(l)!.panels).toEqual({ editor: { contentComponent: 'editor' } });
      expect(entriesSpy).not.toHaveBeenCalled();
    } finally {
      entriesSpy.mockRestore();
    }
  });

  it('leaf 含 editor+终端 → 剥终端,views 仅剩 editor,activeView 从终端回退到 editor', () => {
    const l = layout([leaf('1', ['editor', 'term-1'], 'term-1')], {
      editor: { contentComponent: 'editor' },
      'term-1': { contentComponent: 'terminal' },
    });
    const r = out(l)!;
    expect(Object.keys(r.panels)).toEqual(['editor']);
    expect(r.grid.root.data).toHaveLength(1);
    expect(r.grid.root.data[0].data.views).toEqual(['editor']);
    expect(r.grid.root.data[0].data.activeView).toBe('editor');
  });

  it('leaf 仅含终端 → 整 leaf 摘除;另一 leaf 保留', () => {
    const l = layout(
      [leaf('1', ['editor'], 'editor'), leaf('2', ['term-1'], 'term-1')],
      {
        editor: { contentComponent: 'editor' },
        'term-1': { contentComponent: 'terminal' },
      },
    );
    const r = out(l)!;
    expect(r.grid.root.data).toHaveLength(1);
    expect(r.grid.root.data[0].data.views).toEqual(['editor']);
  });

  it('嵌套 branch 内子节点全为终端 → 整个子 branch 摘除', () => {
    const innerBranch = {
      type: 'branch',
      data: [leaf('2', ['term-1'], 'term-1'), leaf('3', ['term-2'], 'term-2')],
      size: 400,
    };
    const l = layout([leaf('1', ['editor'], 'editor'), innerBranch], {
      editor: { contentComponent: 'editor' },
      'term-1': { contentComponent: 'terminal' },
      'term-2': { contentComponent: 'terminal' },
    });
    const r = out(l)!;
    expect(r.grid.root.data).toHaveLength(1);
    expect(r.grid.root.data[0].type).toBe('leaf');
    expect(r.grid.root.data[0].data.views).toEqual(['editor']);
  });

  it('整棵树仅含终端 → 返回 null(走默认)', () => {
    const l = layout([leaf('1', ['term-1'], 'term-1')], {
      'term-1': { contentComponent: 'terminal' },
    });
    expect(stripTerminalPanelsFromLayout(l)).toBeNull();
  });

  it('悬空 activeGroup(指向被摘除的终端 group)→ 清除', () => {
    const l = layout(
      [leaf('1', ['editor'], 'editor'), leaf('2', ['term-1'], 'term-1')],
      {
        editor: { contentComponent: 'editor' },
        'term-1': { contentComponent: 'terminal' },
      },
      { activeGroup: '2' },
    );
    expect(out(l)!.activeGroup).toBeUndefined();
  });

  it('activeGroup 指向存活 group → 保留', () => {
    const l = layout(
      [leaf('1', ['editor'], 'editor'), leaf('2', ['term-1'], 'term-1')],
      {
        editor: { contentComponent: 'editor' },
        'term-1': { contentComponent: 'terminal' },
      },
      { activeGroup: '1' },
    );
    expect(out(l)!.activeGroup).toBe('1');
  });

  it('floatingGroups:过滤终端 views,丢弃变空的浮动组', () => {
    const l = layout([leaf('1', ['editor'], 'editor')], {
      editor: { contentComponent: 'editor' },
      'term-1': { contentComponent: 'terminal' },
      'term-2': { contentComponent: 'terminal' },
      note: { contentComponent: 'editor' },
    }, {
      floatingGroups: [
        { data: { id: 'f1', views: ['note', 'term-1'], activeView: 'term-1' }, position: {} },
        { data: { id: 'f2', views: ['term-2'], activeView: 'term-2' }, position: {} },
      ],
    });
    const r = out(l)!;
    expect(r.floatingGroups).toHaveLength(1);
    expect(r.floatingGroups![0].data.views).toEqual(['note']);
  });

  it('tabGroups:同步剔除终端 panelIds', () => {
    const l = layout(
      [leaf('1', ['editor', 'term-1'], 'editor', {
        tabGroups: [{ id: 'tg1', collapsed: false, panelIds: ['editor', 'term-1'] }],
      })],
      {
        editor: { contentComponent: 'editor' },
        'term-1': { contentComponent: 'terminal' },
      },
    );
    const r = out(l)!;
    const tg = r.grid.root.data[0].data.tabGroups as Array<{ panelIds: string[] }>;
    expect(tg[0].panelIds).toEqual(['editor']);
  });

  it('缺 grid 但 panels 含终端 → 返回 null(无法安全剥离)', () => {
    const l = { panels: { 'term-1': { contentComponent: 'terminal' } } } as unknown as SerializedDockview;
    expect(stripTerminalPanelsFromLayout(l)).toBeNull();
  });

  it('缺 panels 段 → 原样返回', () => {
    const l = { grid: { root: { type: 'branch', data: [] } } } as unknown as SerializedDockview;
    expect(stripTerminalPanelsFromLayout(l)).toBe(l);
  });
});
