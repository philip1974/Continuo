// 三处查找(编辑器 CodeMirror 查找面板、在文件中查找视图、终端 / Markdown 查找条)共用的选项:名称(catalog key)、
// 切换快捷键与按键匹配(对齐 VSCode findInput:mac ⌥⌘C / ⌥⌘W / ⌥⌘R,Windows / Linux Alt+C / W / R)。
// 编辑器查找面板的切换由 codemirror-find 的 CodeMirror keymap 处理(同一组键,CodeMirror 键名写法),这里只供显示。
// 按键匹配经 matchesHotkey:主键按物理键(e.code)判 —— macOS 按住 ⌥ 时 e.key 是特殊字符(⌥C = ç)。
// BDD: src/__tests__/find-options-parity/

import type { TranslationKey } from '@/i18n';
import { detectPlatform, formatHotkey, type Platform } from '@/plugins/command-palette/format-hotkey';
import { matchesHotkey } from '@/plugins/command-palette/useCommandHotkeys';
import { withHotkey } from './hotkey-label';
// hotkey-label 只依赖快捷键 store / 格式化(不拉 co-app),查找条可放心引入。

export type FindOption = 'caseSensitive' | 'wholeWord' | 'regex';

export const FIND_OPTIONS: readonly FindOption[] = ['caseSensitive', 'wholeWord', 'regex'];

export const FIND_OPTIONS_GROUP_KEY: TranslationKey = 'find.options_group';

export const FIND_OPTION_LABEL_KEYS: Readonly<Record<FindOption, TranslationKey>> = {
  caseSensitive: 'find.option.match_case',
  wholeWord: 'find.option.whole_word',
  regex: 'find.option.regex',
};

const OPTION_LETTER: Readonly<Record<FindOption, string>> = { caseSensitive: 'c', wholeWord: 'w', regex: 'r' };

/** 选项切换键(hotkey 词汇):mac `mod+alt+<字母>`,其它 `alt+<字母>`。 */
export function findOptionHotkey(option: FindOption, platform: Platform = detectPlatform()): string {
  return `${platform === 'mac' ? 'mod+alt' : 'alt'}+${OPTION_LETTER[option]}`;
}

/** 按键是哪个选项的切换键;都不是 → null。 */
export function matchFindOptionHotkey(e: KeyboardEvent, platform: Platform = detectPlatform()): FindOption | null {
  for (const option of FIND_OPTIONS) if (matchesHotkey(findOptionHotkey(option, platform), e, platform)) return option;
  return null;
}

/** 选项按钮 / 复选框的 tooltip:「区分大小写 (⌥⌘C)」。label 为已翻译的选项名。 */
export function findOptionTooltip(label: string, option: FindOption, platform: Platform = detectPlatform()): string {
  return withHotkey(label, formatHotkey(findOptionHotkey(option, platform), platform));
}
