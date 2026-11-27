// @vitest-environment jsdom
// BDD:dock tab 条只有一个 Tab 停靠点(外层 .dv-tab 移出 Tab 顺序),焦点指示只在键盘焦点时显示、用 focus-ring 色。
// 见同目录 README 第 4 条。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, render } from '@testing-library/react';
import { SharedTab } from '@/shell/motion/SharedTab';

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

function makeApi(isActive: boolean) {
  const groupChange = new Set<() => void>();
  const api = {
    id: 'p1',
    title: 'Terminal 1',
    isActive,
    isVisible: isActive,
    group: { id: 'g1', api: { isMaximized: () => false }, panels: [] },
    close: vi.fn(),
    setActive: vi.fn(),
    onDidActiveChange: () => ({ dispose: () => {} }),
    onDidTitleChange: () => ({ dispose: () => {} }),
    onDidVisibilityChange: () => ({ dispose: () => {} }),
    onDidGroupChange: (cb: () => void) => {
      groupChange.add(cb);
      return { dispose: () => groupChange.delete(cb) };
    },
  };
  return { api, fireGroupChange: () => groupChange.forEach((cb) => cb()) };
}

/** dockview 的外层 tab 元素:构造时写死 tabIndex=0。 */
function dvTab(): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'dv-tab';
  el.tabIndex = 0;
  document.body.appendChild(el);
  return el;
}

function renderInto(container: HTMLElement, api: ReturnType<typeof makeApi>['api']) {
  const props = {
    api,
    containerApi: { onDidMaximizedGroupChange: () => ({ dispose: () => {} }), exitMaximizedGroup: vi.fn() },
    params: {},
  } as unknown as Parameters<typeof SharedTab>[0];
  return render(<SharedTab {...props} />, { container });
}

describe('dock tab 条一个 Tab 停靠点', () => {
  it('SharedTab 挂载后外层 .dv-tab 移出 Tab 顺序;内层 role=tab 仍按 roving(活动 0 / 非活动 -1)', () => {
    const outerActive = dvTab();
    const outerInactive = dvTab();
    renderInto(outerActive, makeApi(true).api);
    renderInto(outerInactive, makeApi(false).api);

    expect(outerActive.tabIndex).toBe(-1);
    expect(outerInactive.tabIndex).toBe(-1);
    // 外层不可聚焦(不留 tabindex 属性):tablist 下可聚焦的只有 role=tab(axe aria-required-children)
    expect(outerActive.hasAttribute('tabindex')).toBe(false);
    expect(outerInactive.hasAttribute('tabindex')).toBe(false);
    expect(outerActive.querySelector<HTMLElement>('[role="tab"]')!.tabIndex).toBe(0);
    expect(outerInactive.querySelector<HTMLElement>('[role="tab"]')!.tabIndex).toBe(-1);
  });

  it('面板挪到别的组(dockview 新建外层 tab、复用同一 tab 内容)→ 新的外层同样移出 Tab 顺序', async () => {
    // dockview-react 的 tab 内容元素(React 渲染进它),挪组时整体移到新的外层 tab 里
    const content = document.createElement('div');
    dvTab().appendChild(content);
    const { api, fireGroupChange } = makeApi(true);
    renderInto(content, api);

    const second = dvTab();
    second.appendChild(content);
    fireGroupChange();
    await act(() => new Promise<void>((r) => queueMicrotask(r)));

    expect(second.tabIndex).toBe(-1);
  });
});

describe('dock tab 焦点指示', () => {
  const css = readFileSync(join(process.cwd(), 'src/styles/dockview.css'), 'utf8');

  it('默认(含鼠标按下时的 focus-within)不显示 dockview 的 divider 色轮廓', () => {
    const rule = css.match(/\.dv-tab:focus-within::after[^{]*\{([^}]*)\}/);
    expect(rule?.[1]).toMatch(/outline-color:\s*transparent\s*!important/);
  });

  it('外层 .dv-tab 与内层 role=tab 自身不画元素轮廓(Chromium 默认 outline: auto 是系统强调色),只由 ::after 显示 focus-ring', () => {
    const outer = css.match(/\.dockview-theme-abyss \.dv-tab:focus-visible\s*,[^{]*\{([^}]*)\}/);
    expect(outer?.[0]).toContain('.dockview-theme-abyss .dv-tab [role="tab"]:focus-visible');
    expect(outer?.[1]).toMatch(/outline:\s*none/);
  });

  it('键盘焦点(focus-visible)时显示 --md-focus-ring 色轮廓', () => {
    const rule = css.match(/\.dv-tab:has\(:focus-visible\)::after[^{]*\{([^}]*)\}/);
    expect(rule?.[1]).toMatch(/outline-color:\s*var\(--md-focus-ring\)\s*!important/);
  });
});
