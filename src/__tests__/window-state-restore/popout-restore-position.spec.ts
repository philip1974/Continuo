// BDD:popout 子窗位置重启不漂移。dockview 6 把 popout 序列化成屏幕绝对坐标,恢复时 addPopoutGroup 又加一次主窗原点
//(window.screenX + box.left);fromJSON 前换算成相对主窗原点,加回后即原值。见同目录 README 第 2 条。
import { describe, expect, it } from 'vitest';
import { popoutPositionsRelativeToWindow } from '@/shell/dock/popout-restore-position';

const grid = { root: { type: 'branch', data: [] }, width: 1, height: 1, orientation: 'HORIZONTAL' };

describe('popoutPositionsRelativeToWindow', () => {
  it('每个 popout 的 left/top 减去主窗原点,width/height 与其它字段不变', () => {
    const layout = {
      grid,
      panels: {},
      popoutGroups: [
        { data: { id: '2' }, gridReferenceGroup: '1', position: { left: 1700, top: 300, width: 640, height: 480 }, url: 'x' },
        { data: { id: '3' }, position: { left: -500, top: 40, width: 500, height: 400 } },
      ],
    };
    const out = popoutPositionsRelativeToWindow(layout, 200, 100);
    expect(out.popoutGroups).toEqual([
      { data: { id: '2' }, gridReferenceGroup: '1', position: { left: 1500, top: 200, width: 640, height: 480 }, url: 'x' },
      { data: { id: '3' }, position: { left: -700, top: -60, width: 500, height: 400 } },
    ]);
    // 输入不被原地修改(sanitize 结果可能还被别处引用)
    expect(layout.popoutGroups[0]!.position.left).toBe(1700);
  });

  it('dockview 恢复时加回主窗原点 → 等于保存时的屏幕坐标(多次重启不漂移)', () => {
    const saved = { left: 1700, top: 300, width: 640, height: 480 };
    const origin = { x: 200, y: 100 };
    let position = saved;
    for (let restart = 0; restart < 3; restart += 1) {
      const out = popoutPositionsRelativeToWindow({ grid, panels: {}, popoutGroups: [{ data: {}, position }] }, origin.x, origin.y);
      const rel = out.popoutGroups[0]!.position;
      // dockview addPopoutGroup:left = window.screenX + box.left
      position = { ...rel, left: origin.x + rel.left, top: origin.y + rel.top };
    }
    expect(position).toEqual(saved);
  });

  it('没有 popout / 没有 position → 原样返回同一对象', () => {
    const noPopout = { grid, panels: {} };
    expect(popoutPositionsRelativeToWindow(noPopout, 10, 10)).toBe(noPopout);
    const noPosition = { grid, panels: {}, popoutGroups: [{ data: {} }] };
    expect(popoutPositionsRelativeToWindow(noPosition, 10, 10)).toEqual(noPosition);
  });
});
