// @vitest-environment jsdom
// BDD: win-linux-parity / 5「在 Finder 中显示」/「废纸篓」按平台措辞(VSCode REVEAL_IN_OS_LABEL、Recycle Bin)、6 Windows Ctrl+F4 关闭编辑器
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { osVariantKey, setLocale } from '@/i18n';
import { ContextMenu, type ContextMenuActions } from '@/panels/Explorer/ContextMenu';
import type { FileEntry } from '@/lib/fs/types';
import { closeActiveEditorDefaultHotkeys, editorCommandSpecs } from '@/panels/Editor/editor-commands';
import { terminalYieldedCommandId } from '@/panels/Terminal/terminal-hotkeys';
import { TERMINAL_ATTR } from '@/lib/editor-text-focus';
import { en } from '../../../electron/shared/i18n-locales/en';
import { zh } from '../../../electron/shared/i18n-locales/zh';
import { ko } from '../../../electron/shared/i18n-locales/ko';

let platformDescriptor: PropertyDescriptor | undefined;
const setPlatform = (value: string) =>
  Object.defineProperty(Navigator.prototype, 'platform', { configurable: true, get: () => value });
beforeEach(() => {
  platformDescriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, 'platform');
});
afterEach(() => {
  cleanup();
  setLocale('en');
  document.body.innerHTML = '';
  if (platformDescriptor) Object.defineProperty(Navigator.prototype, 'platform', platformDescriptor);
});

describe('5 osVariantKey:Windows `_win`、Linux `_linux`,无变体 / 平台无法识别 → 原 key', () => {
  it.each([
    ['Win32', 'panels.explorer.ctx.reveal_in_finder_win', 'panels.explorer.ctx.trash_win'],
    ['Linux x86_64', 'panels.explorer.ctx.reveal_in_finder_linux', 'panels.explorer.ctx.trash'],
    ['MacIntel', 'panels.explorer.ctx.reveal_in_finder', 'panels.explorer.ctx.trash'],
    ['', 'panels.explorer.ctx.reveal_in_finder', 'panels.explorer.ctx.trash'],
  ])('%s', (platform, reveal, trash) => {
    setPlatform(platform);
    expect(osVariantKey('panels.explorer.ctx.reveal_in_finder')).toBe(reveal);
    expect(osVariantKey('panels.explorer.ctx.trash')).toBe(trash);
    expect(osVariantKey('common.cancel')).toBe('common.cancel');
  });

  it('文案同 VSCode 及其中文 / 韩文语言包', () => {
    expect([en, zh, ko].map((c) => c['panels.explorer.ctx.reveal_in_finder_win'])).toEqual([
      'Reveal in File Explorer',
      '在文件资源管理器中显示',
      '파일 탐색기에 표시',
    ]);
    expect([en, zh, ko].map((c) => c['panels.explorer.ctx.reveal_in_finder_linux'])).toEqual([
      'Open Containing Folder',
      '打开所在的文件夹',
      '상위 폴더 열기',
    ]);
    expect([en, zh, ko].map((c) => c['panels.explorer.ctx.trash_win'])).toEqual(['Move to Recycle Bin', '移到回收站', '휴지통으로 이동']);
  });

  it('每个变体都有基础 key、三语齐全、占位符与基础 key 一致;Windows 变体不再提「废纸篓 / Trash / Finder」', () => {
    const variants = Object.keys(en).filter((k) => /_(win|linux)$/.test(k));
    expect(variants.length).toBeGreaterThanOrEqual(16);
    const params = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of variants) {
      const base = key.replace(/_(win|linux)$/, '');
      for (const cat of [en, zh, ko] as Array<Record<string, string>>) {
        expect(cat[key], key).toBeTruthy();
        expect(cat[base], base).toBeTruthy();
        expect(params(cat[key]!), key).toEqual(params(cat[base]!));
      }
      if (key.endsWith('_win')) {
        expect(en[key as keyof typeof en], key).not.toMatch(/Trash|Finder/);
        expect(zh[key as keyof typeof zh], key).not.toMatch(/废纸篓|Finder/);
      }
    }
  });
});

describe('5 资源管理器右键菜单按平台显示', () => {
  const actions = (): ContextMenuActions => ({
    onRename: vi.fn(),
    onNewFile: vi.fn(),
    onNewDir: vi.fn(),
    onCopyPath: vi.fn(),
    onCopyRelativePath: vi.fn(),
    onRevealInFinder: vi.fn(),
    onOpenInTerminal: vi.fn(),
    onTrash: vi.fn(),
    onCut: vi.fn(),
    onCopy: vi.fn(),
    onPaste: vi.fn(),
  });
  function labels(): string[] {
    const file = { path: '/work/a.ts', name: 'a.ts', isDirectory: false } as FileEntry;
    const r = render(
      <ContextMenu target={file} selectedPaths={new Set(['/work/a.ts'])} rootPath="/work" actions={actions()} hasClipboard={false} pluginItems={[]}>
        <div data-testid="trigger">row</div>
      </ContextMenu>,
    );
    fireEvent.contextMenu(r.getByTestId('trigger'));
    return Array.from(document.querySelectorAll<HTMLElement>('[role=menuitem]')).map((el) => el.textContent ?? '');
  }
  it.each([
    ['Win32', '在文件资源管理器中显示', '移到回收站'],
    ['Linux x86_64', '打开所在的文件夹', '移到废纸篓'],
    ['MacIntel', '在 Finder 中显示', '移到废纸篓'],
  ])('%s', (platform, reveal, trash) => {
    setPlatform(platform);
    setLocale('zh');
    const all = labels();
    expect(all.some((l) => l.startsWith(reveal))).toBe(true);
    expect(all.some((l) => l.startsWith(trash))).toBe(true);
  });
});

describe('5 命令面板「在 Finder 中显示活动文件」按平台标题', () => {
  const titleKey = () => editorCommandSpecs('other').find((c) => c.id === 'revealFileInOS')!.titleKey;
  it('Windows / Linux / mac', () => {
    setPlatform('Win32');
    expect(titleKey()).toBe('commands.file.reveal.title_win');
    setPlatform('Linux x86_64');
    expect(titleKey()).toBe('commands.file.reveal.title_linux');
    setPlatform('MacIntel');
    expect(titleKey()).toBe('commands.file.reveal.title');
  });
});

describe('6 关闭编辑器:Windows 主键 Ctrl+F4、附加 Ctrl+W(VSCode win 绑定)', () => {
  const close = (windows: boolean) => editorCommandSpecs('other', windows).find((c) => c.id === 'workbench.action.closeActiveEditor')!;
  it('Windows', () => {
    expect(closeActiveEditorDefaultHotkeys(true)).toEqual({ hotkey: 'ctrl+f4', secondaryHotkeys: ['mod+w'] });
    expect(close(true)).toMatchObject({ hotkey: 'ctrl+f4', secondaryHotkeys: ['mod+w'] });
  });
  it('Linux / mac 不变(⌘W / Ctrl+W)', () => {
    expect(close(false).hotkey).toBe('mod+w');
    expect(close(false).secondaryHotkeys).toBeUndefined();
    expect(editorCommandSpecs('mac', false).find((c) => c.id === 'workbench.action.closeActiveEditor')!.hotkey).toBe('mod+w');
  });
  it('默认按运行平台(navigator.platform)', () => {
    setPlatform('Win32');
    expect(editorCommandSpecs('other').find((c) => c.id === 'workbench.action.closeActiveEditor')!.hotkey).toBe('ctrl+f4');
  });
  it('终端里 Ctrl+F4 不让出(关闭编辑器不在 commandsToSkipShell,只认 Meta,同 VSCode)', () => {
    const spec = close(true);
    const host = document.createElement('div');
    host.setAttribute(TERMINAL_ATTR, '');
    document.body.appendChild(host);
    const e = new KeyboardEvent('keydown', { key: 'F4', ctrlKey: true, cancelable: true, bubbles: true });
    host.dispatchEvent(e);
    expect(terminalYieldedCommandId(e, 'other', {}, { getAll: () => [spec] })).toBeNull();
  });
});
