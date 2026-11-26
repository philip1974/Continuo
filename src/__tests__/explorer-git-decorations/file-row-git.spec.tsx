// @vitest-environment jsdom
// BDD: explorer-git-decorations / 行渲染:名称颜色 class、徽标字母(aria-hidden)、读屏 + 悬浮文案;文件夹只着色;设置开关
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { cleanup, render } from '@testing-library/react';
import type { ItemInstance } from '@headless-tree/core';
import type { FileEntry } from '../../lib/fs/types';
import type { GitStatusKind } from '../../../electron/shared/git-status';

vi.mock('../../panels/Explorer/ContextMenu', () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../../plugins/settings/values-store', () => ({
  useSettingValue: (_k: string, fallback: unknown) => fallback,
}));

import { FileRow, readFileRowState } from '../../panels/Explorer/FileRow';
import { coApp } from '../../plugins/co-app';
import { t } from '../../i18n';

function mockItem(p: string, isDir: boolean): ItemInstance<FileEntry> {
  return {
    getItemData: () => ({ path: p, name: path.basename(p), isDirectory: isDir }) as FileEntry,
    isFolder: () => isDir,
    isSelected: () => false,
    isFocused: () => false,
    isExpanded: () => false,
    isLoading: () => false,
    isRenaming: () => false,
    isDraggingOver: () => false,
    getItemMeta: () => ({ level: 0 }) as ReturnType<ItemInstance<FileEntry>['getItemMeta']>,
    getProps: () => ({ role: 'treeitem' }),
    getRenameInputProps: () => ({}),
  } as unknown as ItemInstance<FileEntry>;
}

function renderRow(opts: { path?: string; isDir?: boolean; kind?: GitStatusKind; color?: boolean; letter?: string }) {
  const item = mockItem(opts.path ?? '/w/a.ts', opts.isDir ?? false);
  return render(
    <FileRow
      item={item}
      {...readFileRowState(item, { getRenamingValue: () => '' })}
      start={0}
      getSelectedPaths={() => new Set()}
      rootPath="/w"
      contextActions={{} as never}
      decorators={[]}
      hasClipboard={false}
      pluginMenuItems={[]}
      indent={16}
      gitKind={opts.kind}
      gitColor={opts.color ?? true}
      gitLetter={opts.letter ?? ''}
    />,
  );
}

const nameEl = (c: HTMLElement) => c.querySelector('span.truncate') as HTMLElement;

afterEach(() => cleanup());

describe('文件', () => {
  it('名称着色、右侧字母同色且 aria-hidden;treeitem 朗读与悬浮提示带状态文案', () => {
    const { container, getByRole } = renderRow({ kind: 'modified', letter: 'M' });
    expect(nameEl(container).className).toContain('text-git-modified');
    const letter = [...container.querySelectorAll('[aria-hidden="true"]')].find((e) => e.textContent === 'M')!;
    expect(letter.className).toContain('text-git-modified');
    const row = getByRole('treeitem');
    expect(row.textContent).toContain(t('panels.explorer.git.modified'));
    expect(row.getAttribute('title')).toBe(`/w/a.ts · ${t('panels.explorer.git.modified')}`);
  });

  it('decorations.colors 关 → 名称不着色(字母仍在)', () => {
    const { container } = renderRow({ kind: 'untracked', letter: 'U', color: false });
    expect(nameEl(container).className).not.toContain('text-git-');
    expect(container.textContent).toContain('U');
  });

  it('decorations.badges 关(字母为空)→ 无字母(颜色仍在)', () => {
    const { container } = renderRow({ kind: 'untracked', letter: '' });
    expect(nameEl(container).className).toContain('text-git-untracked');
    expect(container.textContent).toBe(`a.ts, ${t('panels.explorer.git.untracked')}`);
  });

  it('忽略项:只置灰,无字母、无文案', () => {
    const { container, getByRole } = renderRow({ kind: 'ignored' });
    expect(nameEl(container).className).toContain('text-git-ignored');
    expect(getByRole('treeitem').textContent).toBe('a.ts');
    expect(getByRole('treeitem').getAttribute('title')).toBe('/w/a.ts');
  });

  it('无装饰 → 与原先一致', () => {
    const { container, getByRole } = renderRow({});
    expect(nameEl(container).className).toBe('truncate');
    expect(getByRole('treeitem').textContent).toBe('a.ts');
  });
});

describe('文件夹', () => {
  it('只着色:无字母、无文案', () => {
    const { container, getByRole } = renderRow({ path: '/w/src', isDir: true, kind: 'modified' });
    expect(nameEl(container).className).toContain('text-git-modified');
    expect(getByRole('treeitem').textContent).not.toContain(t('panels.explorer.git.modified'));
    expect(getByRole('treeitem').textContent).not.toContain('M');
  });
});

describe('插件装饰', () => {
  it('插件 textColor 仍覆盖名称颜色(内联 style)', () => {
    const d = coApp.explorerDecorators.register(() => ({ textColor: 'var(--md-error)' }));
    try {
      const { container } = renderRow({ kind: 'modified', letter: 'M' });
      expect(nameEl(container).style.color).toBe('var(--md-error)');
    } finally {
      d.dispose();
    }
  });
});

describe('颜色只用语义 token', () => {
  it('text-git-* 映射到 --md-git-*,light 与 dark 各有取值', () => {
    const css = readFileSync(path.join(process.cwd(), 'src/styles/theme.css'), 'utf8');
    const light = css.slice(css.indexOf(':root {'), css.indexOf('.dark {'));
    const dark = css.slice(css.indexOf('.dark {'), css.indexOf('@theme inline {'));
    for (const k of ['modified', 'added', 'untracked', 'deleted', 'conflict', 'ignored']) {
      expect(css).toContain(`--color-git-${k}: var(--md-git-${k});`);
      expect(light).toMatch(new RegExp(`--md-git-${k}: #[0-9a-f]{6};`));
      expect(dark).toMatch(new RegExp(`--md-git-${k}: #[0-9a-f]{6};`));
    }
  });
});
