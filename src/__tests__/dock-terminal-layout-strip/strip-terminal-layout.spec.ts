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
    const root = r.grid.root.data[0]!;
    expect(root.data.views).toEqual(['editor']);
    expect(root.data.activeView).toBe('editor');
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
    expect(r.grid.root.data[0]!.data.views).toEqual(['editor']);
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
    const root = r.grid.root.data[0]!;
    expect(root.type).toBe('leaf');
    expect(root.data.views).toEqual(['editor']);
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
    expect(r.floatingGroups![0]!.data.views).toEqual(['note']);
  });

  it('floatingGroups/popoutGroups 空态复用稳定空数组', () => {
    const l1 = layout(
      [leaf('1', ['editor', 'term-1'], 'editor')],
      {
        editor: { contentComponent: 'editor' },
        'term-1': { contentComponent: 'terminal' },
      },
      { floatingGroups: [], popoutGroups: [{ data: { id: 'p1', views: ['term-1'] } }] },
    );
    const l2 = layout(
      [leaf('1', ['editor', 'term-1'], 'editor')],
      {
        editor: { contentComponent: 'editor' },
        'term-1': { contentComponent: 'terminal' },
      },
      { floatingGroups: [], popoutGroups: [] },
    );

    const r1 = out(l1)!;
    const r2 = out(l2)!;

    expect(r1.floatingGroups).toEqual([]);
    expect(r1.popoutGroups).toEqual([]);
    expect(r2.floatingGroups).toBe(r1.floatingGroups);
    expect(r2.popoutGroups).toBe(r1.popoutGroups);
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
    const root = r.grid.root.data[0]!;
    const tg = root.data.tabGroups as Array<{ panelIds: string[] }>;
    expect(tg[0]!.panelIds).toEqual(['editor']);
  });

  it('剪枝 views/tabGroups/branch children 时不通过 filter/map 生成中间数组', () => {
    const rootChildren = [
      leaf('1', ['editor', 'term-1'], 'term-1', {
        tabGroups: [
          { id: 'tg1', collapsed: false, panelIds: ['editor', 'term-1'] },
          { id: 'tg2', collapsed: false, panelIds: ['term-2'] },
        ],
      }),
      leaf('2', ['term-2'], 'term-2'),
    ];
    const views = (rootChildren[0]! as unknown as { data: { views: string[] } }).data.views;
    const tabGroups = (rootChildren[0]! as unknown as { data: { tabGroups: Array<{ panelIds: string[] }> } }).data.tabGroups;
    const panelIds = tabGroups[0]!.panelIds;
    const l = layout(rootChildren, {
      editor: { contentComponent: 'editor' },
      'term-1': { contentComponent: 'terminal' },
      'term-2': { contentComponent: 'terminal' },
    });
    const filterSpy = vi.spyOn(Array.prototype, 'filter');
    const mapSpy = vi.spyOn(Array.prototype, 'map');

    try {
      const r = out(l)!;
      const filterCallsOnLayoutArrays = filterSpy.mock.contexts.filter(
        (ctx) =>
          ctx === views ||
          ctx === tabGroups ||
          ctx === panelIds ||
          ctx === rootChildren,
      ).length;
      const mapCallsOnLayoutArrays = mapSpy.mock.contexts.filter(
        (ctx) => ctx === tabGroups || ctx === rootChildren,
      ).length;

      expect(filterCallsOnLayoutArrays).toBe(0);
      expect(mapCallsOnLayoutArrays).toBe(0);
      expect(r.grid.root.data).toHaveLength(1);
      const root = r.grid.root.data[0]!;
      expect(root.data.views).toEqual(['editor']);
      const tg = root.data.tabGroups as Array<{ panelIds: string[] }>;
      expect(tg).toHaveLength(1);
      expect(tg[0]!.panelIds).toEqual(['editor']);
      const body = stripTerminalPanelsFromLayout.toString();
      expect(body).not.toContain('views.push(');
      expect(body).not.toContain('panelIds.push(');
      expect(body).not.toContain('tabGroups.push(');
      expect(body).not.toContain('children.push(');
      expect(body).not.toContain('kept.push(');
      expect(body).not.toContain('raw ?? {}');
      expect(body).not.toContain(': []');
    } finally {
      filterSpy.mockRestore();
      mapSpy.mockRestore();
    }
  });

  describe('grid 只剩终端时,popout / floating 中的非终端布局仍须保留', () => {
    const panels = {
      editor: { contentComponent: 'editor' },
      'term-1': { contentComponent: 'terminal' },
    };
    const popout = (id: string, views: string[], gridReferenceGroup?: string) => ({
      data: { id, views, activeView: views[0] },
      gridReferenceGroup,
      position: { top: 0, left: 0, width: 600, height: 400 },
      url: 'popout.html?popout=1',
    });

    it('editor 与终端同组后 editor 弹出 → 保留 popout 及其引用组(剥终端后为空),不为 null', () => {
      const l = layout([leaf('1', ['term-1'], 'term-1')], panels, {
        popoutGroups: [popout('2', ['editor'], '1')],
        activeGroup: '1',
      });
      const r = out(l)!;
      expect(r).not.toBeNull();
      expect(Object.keys(r.panels)).toEqual(['editor']);
      expect(r.popoutGroups).toHaveLength(1);
      expect(r.popoutGroups![0]!.data.views).toEqual(['editor']);
      expect(r.grid.root.data).toHaveLength(1);
      expect(r.grid.root.data[0]!.data).toMatchObject({ id: '1', views: [] });
      expect(r.grid.root.data[0]!.data.activeView).toBeUndefined();
      expect(r.activeGroup).toBe('1');
    });

    it('整组弹出后 grid 留下的原本就空的引用组 → 保留;仅含终端的 leaf 仍摘除', () => {
      const l = layout(
        [
          { ...leaf('1', []), visible: false },
          leaf('3', ['term-1'], 'term-1'),
        ],
        panels,
        { popoutGroups: [popout('2', ['editor'], '1')] },
      );
      const r = out(l)!;
      expect(r.grid.root.data).toHaveLength(1);
      expect(r.grid.root.data[0]!.data).toMatchObject({ id: '1', views: [] });
      expect(r.popoutGroups![0]!.data.views).toEqual(['editor']);
    });

    it('仅含终端的 popout 被丢弃 → 它在 grid 里原本就空的隐藏引用组随之摘除(不累积孤儿隐藏空组)', () => {
      const l = layout(
        [
          leaf('1', ['editor'], 'editor'),
          { ...leaf('2', []), visible: false },
        ],
        panels,
        { popoutGroups: [popout('3', ['term-1'], '2')] },
      );
      const r = out(l)!;
      expect(r.popoutGroups).toEqual([]);
      expect(r.grid.root.data.map((n) => (n.data as { id?: string }).id)).toEqual(['1']);
    });

    it('引用组剥终端后变空且对应 popout 也被丢弃 → 引用组摘除(不留可见空组)', () => {
      const l = layout(
        [leaf('1', ['editor'], 'editor'), leaf('2', ['term-1'], 'term-1')],
        { ...panels, 'term-2': { contentComponent: 'terminal' } },
        { popoutGroups: [popout('3', ['term-2'], '2')] },
      );
      const r = out(l)!;
      expect(r.popoutGroups).toEqual([]);
      expect(r.grid.root.data.map((n) => (n.data as { id?: string }).id)).toEqual(['1']);
    });

    it('没有 popout 引用的隐藏空 leaf → 摘除;可见的原本即空 leaf(dockview 自身会产生)→ 保留', () => {
      const l = layout(
        [
          leaf('1', ['term-1'], 'term-1'),
          { ...leaf('2', []), visible: false },
          leaf('4', []),
        ],
        panels,
        { popoutGroups: [popout('3', ['editor'])] },
      );
      const r = out(l)!;
      expect(r.grid.root.data.map((n) => (n.data as { id?: string }).id)).toEqual(['4']);
    });

    it('grid 只剩终端 + editor 在 floating → 不为 null,grid 剪成空 root,floating 保留', () => {
      const l = layout([leaf('1', ['term-1'], 'term-1')], panels, {
        floatingGroups: [{ data: { id: '2', views: ['editor'], activeView: 'editor' }, position: {} }],
      });
      const r = out(l)!;
      expect(r).not.toBeNull();
      expect(r.grid.root.data).toEqual([]);
      expect(r.floatingGroups![0]!.data.views).toEqual(['editor']);
    });

    it('grid / floating / popout 全都只有终端 → 仍返回 null', () => {
      const l = layout([leaf('1', ['term-1'], 'term-1')], {
        'term-1': { contentComponent: 'terminal' },
        'term-2': { contentComponent: 'terminal' },
        'term-3': { contentComponent: 'terminal' },
      }, {
        floatingGroups: [{ data: { id: '2', views: ['term-2'] }, position: {} }],
        popoutGroups: [popout('3', ['term-3'], '1')],
      });
      expect(stripTerminalPanelsFromLayout(l)).toBeNull();
    });
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
