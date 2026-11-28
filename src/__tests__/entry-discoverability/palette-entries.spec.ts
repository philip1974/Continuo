// @vitest-environment jsdom
// BDD: entry-discoverability 第 2 条 —— 命令面板按 VSCode 标题「首选项: 打开设置」找到设置;关键词「快捷键 / keybindings」找到
// 「首选项: 打开键盘快捷方式」。见同目录 README。
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { bootCorePlugins } from '@/core-plugins';
import { coApp } from '@/plugins/co-app';
import { buildDisplayCommands, searchDisplayCommands } from '@/plugins/command-palette/CommandPalette';
import { englishWithFallback, setLocale, tWithFallback, type Locale } from '@/i18n';

beforeAll(() => bootCorePlugins());
afterEach(() => setLocale('en'));

function search(locale: Locale, query: string): string[] {
  setLocale(locale);
  const items = buildDisplayCommands(
    coApp.commands.getAll(),
    tWithFallback,
    'mac',
    {},
    locale === 'en' ? undefined : englishWithFallback,
  );
  return searchDisplayCommands(items, query).matches.map((d) => d.cmd.id);
}

function displayLabel(locale: Locale, id: string): string {
  setLocale(locale);
  const d = buildDisplayCommands(coApp.commands.getAll(), tWithFallback, 'mac').find((x) => x.cmd.id === id)!;
  return `${d.displayCategory}: ${d.displayTitle}`;
}

describe('设置命令的标题同 VSCode', () => {
  it.each([
    ['zh', '首选项: 打开设置'],
    ['en', 'Preferences: Open Settings'],
    ['ko', '기본 설정: 설정 열기'],
  ] as const)('%s → %s', (locale, label) => {
    expect(displayLabel(locale, 'settings.toggle')).toBe(label);
  });

  it.each([
    ['zh', '打开设置'],
    ['zh', 'open settings'],
    ['en', 'open settings'],
    ['en', 'preferences'],
    ['ko', '설정 열기'],
  ] as const)('%s 搜「%s」找到设置', (locale, query) => {
    expect(search(locale, query)).toContain('settings.toggle');
  });
});

describe('命令关键词(keywordsKey)', () => {
  it.each([
    ['zh', '快捷键'],
    ['zh', 'keybindings'],
    ['en', 'keybindings'],
    ['en', 'shortcuts'],
    ['ko', '단축키'],
  ] as const)('%s 搜「%s」找到「打开键盘快捷方式」', (locale, query) => {
    expect(search(locale, query)).toContain('workbench.action.openGlobalKeybindings');
  });

  it('关键词按词子串匹配,不做模糊子序列;每个词都要命中', () => {
    expect(search('en', 'zzkeyb')).not.toContain('workbench.action.openGlobalKeybindings');
    expect(search('zh', '快捷键 偏好')).not.toContain('workbench.action.openGlobalKeybindings');
    expect(search('zh', '键位 热键')).toContain('workbench.action.openGlobalKeybindings');
  });

  it('标题与关键词都命中时只列一次(按标题命中)', () => {
    const ids = search('zh', '快捷');
    expect(ids.filter((id) => id === 'workbench.action.openGlobalKeybindings')).toHaveLength(1);
  });
});
