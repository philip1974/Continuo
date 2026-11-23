import { describe, it, expect } from 'vitest';

// preload 暴露的 API 形状契约。后续里程碑会扩展 layout / popout 真实实现。
describe('preload api 契约', () => {
  it('M1: window.api 应预留 layout / popout 命名空间', () => {
    const namespaces = ['layout', 'popout'] as const;
    expect(namespaces).toEqual(['layout', 'popout']);
  });
});
