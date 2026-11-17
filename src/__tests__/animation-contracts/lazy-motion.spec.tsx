// @vitest-environment jsdom
// 首屏包体积:motion.* 组件会把完整特性集(动画 / 手势 / 拖拽 / layout ~115KB)静态打进 main-app。
// 改为 App 根 <LazyMotion strict> 异步加载 domMax(layoutId 需要 layout 特性,domAnimation 不含),
// 组件一律用轻量 m.*。strict 模式下任何残留的 motion.* 会在渲染时抛错。
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { render, cleanup } from '@testing-library/react';
import { LazyMotion, domMax } from 'motion/react';
import { SharedTab } from '../../shell/motion/SharedTab';
import { PanelMount } from '../../shell/motion/PanelMount';
import { BackgroundBeams } from '../../shell/decor/BackgroundBeams';

afterEach(() => cleanup());

const ROOT = process.cwd();

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

describe('LazyMotion — 首屏不静态引入完整 motion 特性集', () => {
  it('src 内无 motion.* 组件 / `motion` 具名导入 / framer-motion', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(join(ROOT, 'src'))) {
      const code = readFileSync(file, 'utf8');
      const importsMotion = /import\s*\{[^}]*\bmotion\b[^}]*\}\s*from\s*['"](motion\/react|framer-motion)['"]/.test(code);
      if (importsMotion || /<motion\.\w/.test(code) || /from\s*['"]framer-motion['"]/.test(code)) {
        offenders.push(relative(ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('App 根挂 LazyMotion strict,特性集经动态 import 的 motion-features 异步加载', () => {
    const app = readFileSync(join(ROOT, 'src/shell/App.tsx'), 'utf8');
    expect(app).toMatch(/<LazyMotion\b[^>]*\bstrict\b/);
    expect(app).toContain("import('./motion-features')");
    expect(app).not.toMatch(/import\s*\{[^}]*\bdomMax\b[^}]*\}\s*from\s*['"]motion\/react['"]/);
  });

  it('motion-features 提供 domMax(含 layoutId 所需的 layout 特性)', async () => {
    const mod = await import('../../shell/motion-features');
    expect(mod.domMax).toBe(domMax);
  });

  it('strict LazyMotion 下 SharedTab(active)/ PanelMount / BackgroundBeams 渲染不抛错', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const api = {
        id: 'p1',
        title: 'T',
        isActive: true,
        group: { id: 'g1', api: { isMaximized: () => false } },
        close: vi.fn(),
        setActive: vi.fn(),
        onDidActiveChange: () => ({ dispose: vi.fn() }),
        onDidTitleChange: () => ({ dispose: vi.fn() }),
      };
      const tabProps = {
        api,
        containerApi: {
          onDidMaximizedGroupChange: () => ({ dispose: vi.fn() }),
          exitMaximizedGroup: vi.fn(),
        },
        params: {},
      } as unknown as Parameters<typeof SharedTab>[0];
      const { container } = render(
        <LazyMotion features={domMax} strict>
          <SharedTab {...tabProps} />
          <PanelMount panelId="p1">
            <div data-testid="panel-body" />
          </PanelMount>
          <BackgroundBeams />
        </LazyMotion>,
      );
      expect(container.querySelector('.bg-accent')).not.toBeNull();
      expect(container.querySelector('[data-testid=panel-body]')).not.toBeNull();
      expect(container.querySelectorAll('linearGradient').length).toBe(50);
    } finally {
      errors.mockRestore();
    }
  });
});
