// @vitest-environment jsdom
// BDD:强制颜色下每个选中 / 当前项只画一种标记(见同目录 README 第 7 条)。forced-colors.css 的语义规则按状态属性命中,
// 若组件把状态属性同时挂在外层与内层(如旧 TabNav:外层 data-active + 内层 aria-selected),同一项会画两圈 Highlight 轮廓。
// 这里渲染 design 里带选中态的组件,钉住「语义状态元素互不嵌套」。真实计算样式的全应用扫描见 e2e forced-colors-states。
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { NavRailButton, SegmentedControl, TabNav, TabNavItem, Tabs } from '@/design';

/** 与 src/styles/forced-colors.css 第一条规则同一组选择器(spec forced-colors.spec.ts 钉住该规则本身)。 */
const FORCED_STATE_SELECTOR = [
  '[aria-selected="true"]',
  '[aria-current]:not([aria-current="false"])',
  '[aria-pressed="true"]',
  '[data-highlighted]',
  '[data-state="active"]',
  '[data-state="checked"]',
  '[data-state="on"]',
  '[data-active="true"]',
].join(',');

function nestedStateHits(root: ParentNode): string[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FORCED_STATE_SELECTOR))
    .filter((el) => el.parentElement?.closest(FORCED_STATE_SELECTOR) != null)
    .map((el) => el.outerHTML.slice(0, 120));
}

afterEach(() => cleanup());

describe('强制颜色:选中项只命中一次语义状态规则(无嵌套双框)', () => {
  it('TabNav 活动 tab:状态属性只在 role=tab 元素上', () => {
    const { container } = render(
      <TabNav>
        <TabNavItem active dirty onSelect={() => {}} onClose={() => {}}>
          a.ts
        </TabNavItem>
        <TabNavItem onSelect={() => {}}>b.ts</TabNavItem>
      </TabNav>,
    );
    const hits = container.querySelectorAll(FORCED_STATE_SELECTOR);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.getAttribute('role')).toBe('tab');
    expect(nestedStateHits(container)).toEqual([]);
  });

  it('Tabs / SegmentedControl / NavRailButton:选中项同样只有一个命中元素', () => {
    const { container } = render(
      <>
        <Tabs items={[{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]} activeId="a" onSelect={() => {}} />
        <SegmentedControl options={[{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }]} value="x" onChange={() => {}} />
        <NavRailButton active title="Explorer" onClick={() => {}}>
          <span />
        </NavRailButton>
      </>,
    );
    expect(nestedStateHits(container)).toEqual([]);
  });
});
