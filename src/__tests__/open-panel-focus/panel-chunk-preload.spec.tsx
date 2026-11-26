// @vitest-environment jsdom
// BDD:冷启动按 ⇧⌘F / ⌘, 后立刻打字不丢字 —— 面板 chunk 启动空闲时预取,预取后挂载不经 Suspense 挂起。
// 见同目录 README 第 2 条。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Suspense, createElement, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { preloadableLazy } from '@/lib/lazy-panel';

const src = (p: string): string => readFileSync(join(__dirname, '../..', p), 'utf8');

function Counter({ label }: { label: string }) {
  const [n, setN] = useState(0);
  return createElement('button', { type: 'button', onClick: () => setN(n + 1) }, `${label}:${n}`);
}

const withSuspense = (node: React.ReactNode) => createElement(Suspense, { fallback: 'loading' }, node);

afterEach(cleanup);

describe('preloadableLazy', () => {
  it('预取完成后挂载 → 同步渲染出内容,不显示 Suspense 回退', async () => {
    const { Component, preload } = preloadableLazy(() => Promise.resolve({ default: Counter }));
    await preload();
    render(withSuspense(createElement(Component, { label: 'c' })));
    expect(screen.queryByText('loading')).toBeNull();
    expect(screen.getByRole('button').textContent).toBe('c:0');
  });

  it('预取前挂载 → 照常挂起,加载后显示内容;之后父组件重渲染不重挂(状态保留)', async () => {
    let resolve!: (m: { default: typeof Counter }) => void;
    const { Component } = preloadableLazy(() => new Promise<{ default: typeof Counter }>((r) => (resolve = r)));
    const { rerender } = render(withSuspense(createElement(Component, { label: 'c' })));
    expect(screen.getByText('loading')).toBeTruthy();
    await act(async () => resolve({ default: Counter }));
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('button').textContent).toBe('c:1');
    rerender(withSuspense(createElement(Component, { label: 'c' })));
    expect(screen.getByRole('button').textContent).toBe('c:1');
  });

  it('preload 重复调用共用同一次加载', async () => {
    let calls = 0;
    const { preload } = preloadableLazy(() => {
      calls += 1;
      return Promise.resolve({ default: Counter });
    });
    await Promise.all([preload(), preload()]);
    expect(calls).toBe(1);
  });
});

describe('搜索 / 设置面板启动空闲时预取', () => {
  it('两个面板经 preloadableLazy 注册,导出 preload(与面板 lazy 共用同一加载器 → 同一 chunk)', () => {
    expect(src('core-plugins/SearchPlugin.ts')).toMatch(/export const preloadSearchPanel = \w+\.preload/);
    expect(src('core-plugins/SettingsPanelPlugin.ts')).toMatch(/export const preloadSettingsPanel = \w+\.preload/);
  });

  it('设置分类页签内容同经 preloadableLazy,设置预取(loadCategoryTabContent)时一并预取', () => {
    const tab = src('core-plugins/lazy-category-tab.ts');
    expect(tab).toMatch(/const categoryTabContent = preloadableLazy\(/);
    expect(tab).toMatch(/lazyPanel\(categoryTabContent\.Component\)/);
    expect(tab).toMatch(/export function loadCategoryTabContent\(\)[^{]*\{\s*return Promise\.all\(\[categoryTabContent\.preload\(\)/);
    expect(src('core-plugins/SettingsPanelPlugin.ts')).toMatch(/preloadableLazy\(\(\) => \{\s*loadCategoryTabContent\(\)/);
  });

  it('main-app 在 requestIdleCallback 里调用两者', () => {
    expect(src('main-app.ts')).toMatch(
      /requestIdleCallback\?\.\(\(\) => \{\s*preloadSearchPanel\(\)[^\n]*\n\s*preloadSettingsPanel\(\)/,
    );
  });
});
