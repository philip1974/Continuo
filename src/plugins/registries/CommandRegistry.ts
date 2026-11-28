// Plugin 贡献的命令注册表(M-Plugin v1.5)。
// 命令面板订阅本 registry 渲染列表;keybinding 解析时按 hotkey 分发。

import type { Disposable } from '../types';
import { KeyedRegistry } from './keyed-registry';
import {
  assertOptionalSpecString,
  assertSpecFunction,
  assertSpecObject,
  assertSpecString,
  SPEC_ID_MAX,
  SPEC_TITLE_MAX,
} from './spec-guard';
import { isEcmaWhitespaceCode } from '../../../electron/shared/ecma-whitespace';
import { lowerIfNeeded } from '../../../electron/shared/lower-if-needed';
import {
  canonicalHotkey,
  detectPlatform,
  isKnownHotkeyModifier,
  type Platform,
} from '../command-palette/format-hotkey';
import { isCommandWhen, type CommandWhen } from '@/lib/editor-text-focus';

export interface CommandSpec {
  readonly id: string;
  readonly title: string;
  /**
   * i18n key（topic-19）。类型 string 不绑死 keyof typeof en（开放第三方 plugin）；
   * 核心 plugin 可写 `'commands.terminal.new.title' satisfies TranslationKey` 编译验。
   * 渲染层 `tWithFallback(titleKey, title)` 兜底，缺 key 不退化为 key 字面量。
   */
  readonly titleKey?: string;
  /** Accelerator string,如 'mod+s' / 'mod+shift+p',可选. 主默认键:界面上显示的就是它. */
  readonly hotkey?: string;
  /**
   * 附加默认键(VSCode IKeybindings.secondary:一个命令多条 keybinding,如 nextEditor 的 ⌥⌘→ 与 ⇧⌘])。都参与分发与冲突
   * 判定;显示只取主键(hotkey,缺省时取本列表第一条)。用户改键 / 解绑(keybindings override)覆盖全部默认键。
   * BDD: src/__tests__/command-secondary-hotkeys/
   */
  readonly secondaryHotkeys?: readonly string[];
  /**
   * 分类前缀(如 'Settings' / 'Editor' / 'Git')。CommandPalette 显示
   * `${category}: ${title}`,fuzzy 匹配同时覆盖 category + title。
   * VSCode 同款。可选,向后兼容。
   */
  readonly category?: string;
  /** i18n key for category（topic-19）。同 titleKey。 */
  readonly categoryKey?: string;
  /**
   * 搜索关键词的 i18n key(空格分隔的同义说法,如「快捷键」之于「打开键盘快捷方式」;同设置项 keywordsKey):命令面板按标题 / 英文原名都
   * 没命中时,查询的每个词都出现在关键词(当前语言 + 英文)里也列出该命令。不显示。BDD: src/__tests__/command-discoverability/
   */
  readonly keywordsKey?: string;
  /**
   * 按键的上下文条件(VSCode keybinding when 的极简版):'editorTextFocus' = 只在按键落在代码编辑器正文里时分发;
   * 'terminalFocus' = 只在按键落在终端输入区里时分发(BDD: src/__tests__/terminal-focus-cycle/)。
   * 同一层内带条件的绑定排在无条件的之前(编辑器里 ⇧⌘Enter 是在上方插入行,其它地方仍是终端缩放);只在条件不成立时
   * 让给后面的绑定,所以与条件不同的同键绑定不算冲突。命令面板执行不受影响。BDD: src/__tests__/editor-text-commands/
   */
  readonly when?: CommandWhen;
  readonly fn: () => void | Promise<void>;
}


// 边界(E35):register 接受第三方插件的 id/title/titleKey/hotkey/category/categoryKey 后直接入全局
// registry,无长度/形态上限。恶意/畸形插件可注册超长标题/分类/热键 → 命令面板排序与搜索、快捷键
// 预编译(compileCombo)、日志 warning、UI 渲染都携带大字符串 → renderer 卡顿;异常 hotkey 还会被
// compileCombo 当有效签名参与全局 keydown 扫描。注册边界统一校验长度 + hotkey 形态,非法拒绝(抛
// 可诊断错误,由插件加载错误处理捕获)。上限远超任何真实贡献项,只挡滥用。
// id / category / *Key 用 SPEC_ID_MAX、title 用 SPEC_TITLE_MAX(spec-guard 收口);CMD_ID_MAX 是其别名,
// 供 keybindings-store / recent 与注册侧用同一上限。
export const CMD_ID_MAX = SPEC_ID_MAX;
export const CMD_HOTKEY_MAX = 64;
/** 附加默认键条数上限(只挡滥用)。 */
export const CMD_SECONDARY_HOTKEYS_MAX = 8;
// hotkey 形态(宽松):'+'-连接的非空段,段内无空白/'+'(允许 mod+, mod+/ 等标点主键)。挡空段
// (mod++p)、含空白、超长 —— 不强限字符集以免误伤合法标点快捷键。
// 边界(E145):isValidHotkeyShape 导出供 keybindings 捕获侧(eventToCombo)与写端(setHotkey)复用同一形态校验,
// 防捕获/override 写入注册侧会拒绝的畸形 hotkey(空段 / 含空白 / 主键为分隔符 '+')。
// 等价正则:/^[^+\s]+(\+[^+\s]+)*$/(下面是其零分配手写版)。
// 另:主键之前的每段必须是运行时认识的修饰键(isKnownHotkeyModifier,大小写不敏感)——未知修饰符
// (hyper+x)会被 compileCombo 忽略降级成裸 x,注册 / override 写读 / 捕获三处同此拒绝。
export function isValidHotkeyShape(hotkey: string): boolean {
  if (hotkey.length === 0) return false;
  let prevWasPlus = true;
  let segStart = 0;
  for (let i = 0; i < hotkey.length; i += 1) {
    const code = hotkey.charCodeAt(i);
    if (code === 43) {
      if (prevWasPlus || i === hotkey.length - 1) return false;
      if (!isKnownHotkeyModifier(lowerIfNeeded(hotkey.slice(segStart, i)))) return false;
      prevWasPlus = true;
      segStart = i + 1;
      continue;
    }
    if (isEcmaWhitespaceCode(code)) return false;
    prevWasPlus = false;
  }
  return true;
}

const TAG = 'command-registry';

function validateCommandSpec(spec: CommandSpec): void {
  // 边界(E273,E271 registry 族):先校验 spec 是对象,否则读 spec.id/字段对 null/undefined 抛 TypeError。
  assertSpecObject(TAG, spec);
  // 边界(E153,E37/E35 兄弟 registry):CommandSpec 来自第三方未类型化 JS plugin,TS 类型不构成
  // 运行时保证。E35 此前只按 .length 做上限,假设字段都是 string;畸形 spec(id:{}/title:123/
  // hotkey:42/fn:'x' 等)会绕过(如 `(123).length === undefined > max` 为 false,hotkey:42 经
  // String 强转还能通过 regex),随后 CommandPalette/hotkey 分发/execute 按 string/function 使用
  // → 崩溃(execute 调 cmd.fn())或注册出不可触发命令(id 非 string 当 Map key)。注册边界显式
  // 校验运行时类型 + 必填非空(对齐 PanelRegistry E37)。
  assertSpecString(TAG, 'id', spec.id, SPEC_ID_MAX);
  assertSpecString(TAG, 'title', spec.title, SPEC_TITLE_MAX);
  assertSpecFunction(TAG, 'fn', spec.fn);
  assertOptionalSpecString(TAG, 'titleKey', spec.titleKey, SPEC_ID_MAX);
  assertOptionalSpecString(TAG, 'category', spec.category, SPEC_ID_MAX);
  assertOptionalSpecString(TAG, 'categoryKey', spec.categoryKey, SPEC_ID_MAX);
  assertOptionalSpecString(TAG, 'keywordsKey', spec.keywordsKey, SPEC_ID_MAX);
  assertOptionalSpecString(TAG, 'hotkey', spec.hotkey, CMD_HOTKEY_MAX);
  if (spec.when !== undefined && !isCommandWhen(spec.when)) {
    throw new Error(`[command-registry] unknown when: "${String(spec.when)}"`);
  }
  // hotkey 此处已确认为 string(非 string 上面已抛),再校验形态。
  if (spec.hotkey !== undefined && !isValidHotkeyShape(spec.hotkey)) {
    throw new Error(
      `[command-registry] invalid hotkey shape: "${spec.hotkey}"`,
    );
  }
  const secondary: unknown = spec.secondaryHotkeys;
  if (secondary === undefined) return;
  if (!Array.isArray(secondary) || secondary.length > CMD_SECONDARY_HOTKEYS_MAX) {
    throw new Error(`[command-registry] secondaryHotkeys must be an array of at most ${CMD_SECONDARY_HOTKEYS_MAX}`);
  }
  for (const hotkey of secondary as readonly unknown[]) {
    assertSpecString(TAG, 'secondaryHotkeys[]', hotkey, CMD_HOTKEY_MAX);
    if (!isValidHotkeyShape(hotkey as string)) {
      throw new Error(`[command-registry] invalid hotkey shape: "${hotkey as string}"`);
    }
  }
}

const NO_HOTKEYS: readonly string[] = [];

/** 命令的全部默认键(主键在前,再接附加默认键)。 */
export function defaultHotkeysOf(spec: Pick<CommandSpec, 'hotkey' | 'secondaryHotkeys'>): readonly string[] {
  // 空串主键(第三方插件 / 测试里的 hotkey: '')视为无主键,与此前「falsy 即未绑定」一致。
  const primary = spec.hotkey ? spec.hotkey : undefined;
  const secondary = spec.secondaryHotkeys;
  if (!secondary || secondary.length === 0) return primary === undefined ? NO_HOTKEYS : [primary];
  return primary === undefined ? secondary : [primary, ...secondary];
}

export class CommandRegistry extends KeyedRegistry<CommandSpec> {
  // 以 canonicalHotkey 为键:`mod+shift+enter` 与 mac 上的 `shift+cmd+return` 运行时等价,须算作同一占用。
  private hotkeyCounts = new Map<string, number>();

  // platform 与运行时匹配 / KeybindingCaptureModal 同源(detectPlatform);参数仅供测试注入。
  constructor(private readonly platform: Platform = detectPlatform()) {
    super('command-registry');
  }

  register(spec: CommandSpec): Disposable {
    validateCommandSpec(spec); // 边界(E35):注册前校验长度 + hotkey 形态
    return this.registerKeyed(spec.id, spec);
  }

  // hotkey 占用计数:覆盖告警之后、入表之前维护(容量守卫抛错时不会走到这里,计数不脏)。
  protected override onBeforeSet(
    spec: CommandSpec,
    previous: CommandSpec | undefined,
  ): void {
    // 先扣减被替换命令(同 id 重注册,如插件 reload)的占用:否则同 id 覆盖被误报为与自身冲突。
    if (previous) for (const hotkey of defaultHotkeysOf(previous)) this.decrementHotkey(hotkey, previous.when);
    for (const hotkey of defaultHotkeysOf(spec)) {
      if ((this.hotkeyCounts.get(this.hotkeyCountKey(hotkey, spec.when)) ?? 0) > 0) {
        // 只陈述冲突事实,不断言谁生效:useCommandHotkeys 按 Map 迭代序先命中者执行,而同 id 替换时
        // Map.set 保留原插入位置,迭代序未必等于注册时间先后。这里比较的是默认快捷键;用户在快捷键
        // 设置里覆盖其中一个后冲突即解除,故文案限定"未被用户覆盖时"。
        console.warn(
          `[command-registry] 默认快捷键(hotkey) "${hotkey}"(命令 "${spec.id}")与已注册的其他命令冲突,未被用户覆盖时只有其中一个会响应`,
        );
      }
      this.incrementHotkey(hotkey, spec.when);
    }
  }

  protected override onRemoved(spec: CommandSpec): void {
    for (const hotkey of defaultHotkeysOf(spec)) this.decrementHotkey(hotkey, spec.when);
  }

  protected buildSnapshot(): readonly CommandSpec[] {
    const out = new Array<CommandSpec>(this.items.size);
    let i = 0;
    for (const item of this.items.values()) out[i++] = item;
    return out;
  }

  async execute(id: string): Promise<void> {
    const cmd = this.items.get(id);
    if (!cmd) throw new Error(`Command ${id} not found`);
    await cmd.fn();
  }

  // 条件不同的同键绑定各在其上下文里生效,不算占用同一个键(不告警)。
  private hotkeyCountKey(raw: string, when: CommandWhen | undefined): string {
    const hotkey = canonicalHotkey(raw, this.platform);
    return when === undefined ? hotkey : `${when}\u0000${hotkey}`;
  }

  private incrementHotkey(raw: string, when: CommandWhen | undefined): void {
    const hotkey = this.hotkeyCountKey(raw, when);
    this.hotkeyCounts.set(hotkey, (this.hotkeyCounts.get(hotkey) ?? 0) + 1);
  }

  private decrementHotkey(raw: string, when: CommandWhen | undefined): void {
    const hotkey = this.hotkeyCountKey(raw, when);
    const count = this.hotkeyCounts.get(hotkey);
    if (count === undefined) return;
    if (count <= 1) this.hotkeyCounts.delete(hotkey);
    else this.hotkeyCounts.set(hotkey, count - 1);
  }
}
