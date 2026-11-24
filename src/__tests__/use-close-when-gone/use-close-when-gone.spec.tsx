// @vitest-environment jsdom
// BDD:弹窗目标从实时列表消失即关闭。见同目录 README。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useCloseWhenGone } from '../../lib/use-close-when-gone';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hasId = (live: readonly string[], t: string) => live.includes(t);

describe('useCloseWhenGone', () => {
  it('目标为 null → 不关', () => {
    const close = vi.fn();
    renderHook(() => useCloseWhenGone<string, readonly string[]>(null, [], hasId, close));
    expect(close).not.toHaveBeenCalled();
  });

  it('目标仍在 → 不关;列表变化后目标消失 → 关一次', () => {
    const close = vi.fn();
    const { rerender } = renderHook(({ live }) => useCloseWhenGone('a', live, hasId, close), {
      initialProps: { live: ['a', 'b'] as readonly string[] },
    });
    expect(close).not.toHaveBeenCalled();
    rerender({ live: ['b'] });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('判定函数取最新一次渲染传入的', () => {
    const close = vi.fn();
    const live = ['a'] as const;
    const { rerender } = renderHook(
      ({ present }) => useCloseWhenGone('a', live, () => present, close),
      { initialProps: { present: true } },
    );
    rerender({ present: false });
    expect(close).not.toHaveBeenCalled(); // 目标与列表都没变 → 不重新判定(同原 effect 依赖)
    rerender({ present: false });
    expect(close).not.toHaveBeenCalled();
  });
});

describe('接线守卫', () => {
  it.each(['plugins/settings/KeybindingsTabContent.tsx', 'plugins/settings/PluginsTabContent.tsx'])('%s', (rel) => {
    expect(readFileSync(path.join(SRC_ROOT, rel), 'utf-8')).toContain('useCloseWhenGone(');
  });
});
