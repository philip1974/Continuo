// @vitest-environment jsdom
// 打磨 R34(codex 一致性/i18n):PermissionPrompt 的 fs-scope 分支原先硬编码英文
// (Filesystem access request / Deny / Grant / read+write / read only),manifest
// 分支却已走 i18n。补 permissions.fs_scope.* 到 en/zh/ko 后该分支全走 t(),
// 切中文时权限弹窗不再混入英文(安全敏感 UI 的本地化一致性)。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { PermissionPrompt } from '../../plugins/permissions/PermissionPrompt';
import { usePermissionPromptStore } from '../../plugins/permissions/promptStore';
import { setLocale } from '../../i18n';

beforeEach(() => {
  usePermissionPromptStore.setState({ pending: null, currentFsScope: null });
});
afterEach(() => {
  setLocale('en');
  cleanup();
});

function seedFsScope(): void {
  usePermissionPromptStore.setState({
    pending: null,
    currentFsScope: {
      requestId: 'req-1',
      pluginId: 'com.example.plugin',
      scopes: [
        { path: '/work/data', displayPath: '/work/data', mode: 'rw' },
        { path: '/work/ro', displayPath: '/work/ro', mode: 'r' },
      ],
    },
  });
}

describe('打磨 R34 — fs-scope 权限弹窗本地化', () => {
  it('zh locale → 标题/按钮/模式显中文,不混英文', () => {
    setLocale('zh');
    seedFsScope();
    const { container } = render(<PermissionPrompt />);
    const txt = container.textContent ?? '';
    expect(txt).toContain('文件系统访问请求');
    expect(txt).toContain('拒绝');
    expect(txt).toContain('授权');
    expect(txt).toContain('读 + 写');
    expect(txt).toContain('只读');
    expect(txt).toContain('com.example.plugin'); // pluginId 仍内联
    // 不再混入英文硬编码
    expect(txt).not.toContain('Filesystem access request');
    expect(txt).not.toContain('Deny');
    expect(txt).not.toContain('Grant');
  });

  it('en locale → 显英文(默认 catalog)', () => {
    setLocale('en');
    seedFsScope();
    const { container } = render(<PermissionPrompt />);
    const txt = container.textContent ?? '';
    expect(txt).toContain('Filesystem access request');
    expect(txt).toContain('read + write');
  });
});
