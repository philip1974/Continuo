// @vitest-environment jsdom
// 插件可控键按名查普通对象字典时不得命中 Object.prototype 成员(constructor / toString / hasOwnProperty …)。
// 此前 `{id:'toString'}` 命令让 resolveEffectiveHotkey 返回函数 → compileCombo 抛 TypeError,在 App 的
// useCommandHotkeys useMemo 里 → 整窗白屏;`titleKey:'constructor'` 让 tWithFallback 返回函数 →
// CommandPalette 渲染期抛错。
import { describe, it, expect, vi } from 'vitest';
import { tWithFallback, translate } from '../../i18n/translate';
import { buildCompiledBindings } from '../../plugins/command-palette/useCommandHotkeys';
import { resolveEffectiveHotkey } from '../../plugins/keybindings/keybindings-store';
import {
  canonicalHotkeyKey,
  formatHotkey,
  formatHotkeyParts,
} from '../../plugins/command-palette/format-hotkey';
import {
  getStoredSettingValue,
  useSettingsValuesStore,
} from '../../plugins/settings/values-store';
import type { CommandSpec } from '../../plugins/registries/CommandRegistry';
import {
  coerceSettingValue,
  type SettingItemSpec,
} from '../../plugins/registries/SettingItemRegistry';

/** 非 React 读取口径:override ?? default,经 coerceSettingValue 规整(与 useSettingValue 同一规整)。 */
function getSettingValue(spec: SettingItemSpec): unknown {
  return coerceSettingValue(spec, getStoredSettingValue(spec.id) ?? spec.default);
}

const PROTO_NAMES = ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__'];

describe('原型链键名:快捷键解析', () => {
  it.each(PROTO_NAMES)('命令 id=%s 无 override 也无 hotkey → 不抛、无绑定', (id) => {
    const cmds: CommandSpec[] = [{ id, title: 'x', fn: () => {} }];
    expect(resolveEffectiveHotkey(cmds[0]!, {})).toBeUndefined();
    expect(buildCompiledBindings(cmds, 'mac', {})).toEqual([]);
  });

  it('命令 id=toString 有默认 hotkey → 按默认 hotkey 编译', () => {
    const cmds: CommandSpec[] = [{ id: 'toString', title: 'x', hotkey: 'mod+k', fn: () => {} }];
    expect(resolveEffectiveHotkey(cmds[0]!, {})).toBe('mod+k');
    expect(buildCompiledBindings(cmds, 'mac', {})).toHaveLength(1);
  });

  it('主键名为原型成员名 → 显示/归一仍是字符串', () => {
    expect(canonicalHotkeyKey('constructor')).toBe('constructor');
    expect(formatHotkeyParts('cmd+constructor', 'mac')).toEqual(['⌘', 'CONSTRUCTOR']);
    expect(formatHotkey('ctrl+tostring', 'other')).toBe('Ctrl+TOSTRING');
  });
});

describe('原型链键名:i18n', () => {
  it.each(PROTO_NAMES)('titleKey=%s → tWithFallback 返回 fallback 字符串', (key) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(tWithFallback(key, 'FB')).toBe('FB');
    expect(translate(key)).toBe(key);
  });
});

describe('原型链键名:设置值读取', () => {
  it.each(PROTO_NAMES)('setting id=%s 无存储值 → 返回 default', (id) => {
    useSettingsValuesStore.setState({ values: {} });
    const spec = { id, type: 'text', default: 'D', title: 't', category: 'general' } as unknown as SettingItemSpec;
    expect(getSettingValue(spec)).toBe('D');
  });
});
