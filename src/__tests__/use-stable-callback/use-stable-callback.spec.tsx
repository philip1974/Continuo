// @vitest-environment jsdom
// BDD:引用恒定的最新回调。见同目录 README。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useStableCallback } from '../../lib/use-stable-callback';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('useStableCallback', () => {
  it('重渲染后引用不变,调用转发到最新 fn 并透传参数 / 返回值', () => {
    const a = vi.fn((x: number) => x + 1);
    const b = vi.fn((x: number) => x * 10);
    const { result, rerender } = renderHook(({ fn }) => useStableCallback(fn), {
      initialProps: { fn: a },
    });
    const first = result.current;
    rerender({ fn: b });
    expect(result.current).toBe(first);
    expect(result.current(3)).toBe(30);
    expect(a).not.toHaveBeenCalled();
  });
});

describe('接线守卫:传给 Modal 的 onClose 都经 useStableCallback', () => {
  it.each([
    'panels/Explorer/ConfirmDialog.tsx',
    'plugins/permissions/PermissionEditorModal.tsx',
    'plugins/keybindings/KeybindingCaptureModal.tsx',
  ])('%s', (rel) => {
    expect(readFileSync(path.join(SRC_ROOT, rel), 'utf-8')).toContain('useStableCallback(');
  });
});
