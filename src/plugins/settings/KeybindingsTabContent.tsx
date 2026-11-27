// 快捷键参考表(Settings → 快捷键 tab)。
// 订阅 commands registry,列出全部命令(对齐 VSCode 键盘快捷方式编辑器:无快捷键的显示「未绑定」,可直接录键),按 category 分组。
// KeyCap 渲染 hotkey,跟 CommandPalette 风格一致。
// 行右键 / Shift+F10 菜单(VSCode keybindingsEditor onContextMenu),外壳同 tab 右键菜单。BDD: src/__tests__/list-context-menus/

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSettingsStore } from '@/plugins/settings/store';
import { Badge, IconButton, Input, KeyCap } from '@/design';
import { clampSearchQuery, normalizeSearchQuery } from '@/lib/search-query';
import { coApp } from '@/plugins/co-app';
import { useRegistry } from '../registries/useRegistry';
import { defaultHotkeysOf, type CommandSpec } from '@/plugins/registries/CommandRegistry';
import {
  canonicalHotkey,
  formatHotkey,
  hotkeyFilterQuery,
  formatHotkeyParts,
  detectPlatform,
  hotkeySignature,
  type HotkeySignature,
  type Platform,
} from '@/plugins/command-palette/format-hotkey';
import {
  getEffectiveHotkey,
  resolveEffectiveHotkeys,
  useKeybindingsStore,
} from '@/plugins/keybindings/keybindings-store';
import { KeybindingCaptureModal } from '@/plugins/keybindings/KeybindingCaptureModal';
import { useT, useTWithFallback, useLocale, englishWithFallback } from '@/i18n';
import { lowerIfNeeded } from '../../../electron/shared/lower-if-needed';
import { groupKeepingOrder } from '@/lib/group-keeping-order';
import { ResetIcon } from '@/lib/ui-icons';
import { TabContextMenu, type TabMenuEntry } from '@/lib/TabContextMenu';
import { copyToClipboardOrNotify } from '@/panels/Explorer/copy-to-clipboard';
import { isSortedBy } from '@/lib/is-sorted-by';
import { useCloseWhenGone } from '@/lib/use-close-when-gone';
import { byDisplayTitle } from '@/plugins/command-palette/by-display-title';
import { reservedHotkeyOfCommand, reservedPickerHotkeyOf } from '@/plugins/picker/use-picker-toggle-hotkey';
import { selectShadowedBindings } from '@/plugins/command-palette/useCommandHotkeys';

const PLATFORM = detectPlatform();
const COMMAND_PALETTE_HOTKEY_PARTS = formatHotkeyParts('mod+shift+p', PLATFORM);
const EMPTY_KEYBINDING_DISPLAY_COMMANDS: DisplayCommand[] = [];
const KEYBINDING_ROW_CLASS_NAME = 'flex items-center gap-3 px-4 py-3 text-xs';
const KEYBINDING_ROW_BORDER_CLASS_NAME = `${KEYBINDING_ROW_CLASS_NAME} border-t border-line/50`;
// 命令标题占据剩余宽度并可省略号截断(title 给全称);flex 基准 6rem、可收缩到 0(min-w-0):空间不足时与键帽组按基准
// 比例一起收缩(4 键组合时键帽组换行),而不是固定最小宽度把编辑 / 重置按钮挤出列表。id 徽标(min-w-0,最多占 40%)
// 基准是自身内容宽,先收缩;列表窄于 28rem 时徽标隐藏。编辑 / 重置按钮 shrink-0 始终完整可见。未覆盖时的重置按钮宽时
// invisible 占位(各行键帽列对齐),窄时 hidden 让出宽度给标题。
export const KEYBINDING_TITLE_CLASS_NAME = 'min-w-0 flex-[1_1_6rem] truncate text-sm text-fg';
// id 徽标保留原大小写(命令 id 区分大小写,大写化会误导照抄),靠 Badge 浅底 + <code> 等宽与标题区分。
export const KEYBINDING_ID_BADGE_CLASS_NAME = 'min-w-0 max-w-[40%] @max-md:hidden';
const EDIT_HOTKEY_ICON = (
  <svg
    viewBox="0 0 16 16"
    width="11"
    height="11"
    aria-hidden="true"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
  >
    <path d="M11.5 1.5l3 3-9 9-3.5.5.5-3.5z" />
  </svg>
);
const RESET_HOTKEY_ICON = <ResetIcon size={11} />;

export interface DisplayCommand {
  readonly cmd: CommandSpec;
  readonly displayTitle: string;
  readonly displayCategory: string;
  /** 预计算的 effective hotkey(含 user override;无 / 解绑则 undefined)(打磨 R29). */
  readonly effectiveHotkey: string | undefined;
  /** 预计算的 hotkey 段(无则空数组). */
  readonly hotkeyParts: readonly string[];
  /** 附加默认键(未被用户覆盖时;如下一个编辑器的 ⇧⌘])各自的 hotkey 段,排在主键之后显示。 */
  readonly secondaryHotkeyParts?: readonly (readonly string[])[];
  /** 附加默认键的运行时语义(按快捷键搜索时与主键一样比对)。 */
  readonly secondaryHotkeySigs?: readonly (HotkeySignature | null)[];
  /** 该命令是否被用户 override(决定 reset 按钮可见). */
  readonly isOverridden: boolean;
  /** effective hotkey 落在 Quick Open / 命令面板保留键上(分发忽略,行内标注「未生效」)。 */
  readonly reserved?: boolean;
  /** 保留键归属命令(转到文件… ⌘P / 显示所有命令 ⇧⌘P):显示保留键,标「保留键，不可更改」,不可编辑。 */
  readonly fixed?: boolean;
  /** 搜索用小写 haystack,随命令/语言/override 变化预计算. */
  readonly searchHaystack: string;
  /** effective hotkey 的运行时语义(修饰键位 + 主键),按快捷键搜索(cmd+s)时比对;无快捷键则缺省. */
  readonly hotkeySig?: HotkeySignature | null;
}

export interface Bucket {
  readonly category: string;
  readonly items: readonly DisplayCommand[];
}

const EMPTY_KEYBINDING_BUCKETS: Bucket[] = [];
const EMPTY_VISIBLE_KEYBINDING_COMMANDS: DisplayCommand[] = [];
const EMPTY_HOTKEY_PARTS: readonly string[] = [];

export function keybindingRowClassName(index: number): string {
  return index > 0 ? KEYBINDING_ROW_BORDER_CLASS_NAME : KEYBINDING_ROW_CLASS_NAME;
}


function byCategory(a: Bucket, b: Bucket): number {
  return a.category.localeCompare(b.category);
}

/** 按 displayCategory 分组,每组按 displayTitle 字母序;空 category 归 defaultGroup. */
export function groupByCategory(
  commands: readonly DisplayCommand[],
  defaultGroup: string,
): Bucket[] {
  if (commands.length === 0) return EMPTY_KEYBINDING_BUCKETS;
  const groups = groupKeepingOrder(commands, (d) => d.displayCategory || defaultGroup);
  const buckets = new Array<Bucket>(groups.length);
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]!;
    let items = group.items;
    if (items.length > 1 && !isSortedBy(items, byDisplayTitle)) {
      // owned=false 时 items 就是入参数组,不能原地排 → 拷一份再排。
      const sortable = group.owned ? (items as DisplayCommand[]) : copyCommands(items);
      sortable.sort(byDisplayTitle);
      items = sortable;
    }
    buckets[i] = { category: group.key, items };
  }
  if (buckets.length > 1 && !isSortedBy(buckets, byCategory)) {
    buckets.sort(byCategory);
  }
  return buckets;
}

function copyCommands(commands: readonly DisplayCommand[]): DisplayCommand[] {
  const copy = new Array<DisplayCommand>(commands.length);
  for (let i = 0; i < commands.length; i++) copy[i] = commands[i]!;
  return copy;
}

/** 搜索框里可写的修饰键名 → 快捷键串词汇(mac 键帽符号与常见别名都认)。 */
const QUERY_MODIFIERS: Readonly<Record<string, string>> = {
  cmd: 'cmd', meta: 'cmd', command: 'cmd', '⌘': 'cmd',
  mod: 'mod',
  ctrl: 'ctrl', control: 'ctrl', '⌃': 'ctrl',
  shift: 'shift', '⇧': 'shift',
  alt: 'alt', opt: 'alt', option: 'alt', '⌥': 'alt',
};

/** 按快捷键搜索的查询:修饰键 + 主键;exact = 引号包住(修饰键集合须相同)。 */
interface HotkeyQuery {
  readonly sig: HotkeySignature;
  readonly exact: boolean;
}

/**
 * 查询是否「修饰键名 + … + 主键」形态(对齐 VSCode 键盘快捷方式编辑器按 `+` 拆词):前几段全是修饰键名、末段是非空的非修饰键。
 * 是 → 返回运行时语义;否则 null(按文本搜索)。`"cmd+s"`(引号)= 精确搜索。
 */
export function parseHotkeyQuery(qLower: string, platform: Platform): HotkeyQuery | null {
  let text = qLower;
  const exact = text.length > 2 && text.startsWith('"') && text.endsWith('"');
  if (exact) text = text.slice(1, -1);
  const segments = text.split('+');
  if (segments.length < 2) return null;
  const key = segments[segments.length - 1]!.trim();
  if (key === '' || Object.hasOwn(QUERY_MODIFIERS, key)) return null;
  let combo = '';
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!.trim();
    if (!Object.hasOwn(QUERY_MODIFIERS, seg)) return null;
    combo += `${QUERY_MODIFIERS[seg]}+`;
  }
  const sig = hotkeySignature(combo + key, platform);
  return sig === null ? null : { sig, exact };
}

/**
 * VSCode 同款(KeybindingItemMatches):主键精确相等;修饰键 —— 普通查询要求查询的修饰键都在绑定里(cmd+s 命中 ⌘S 与 ⇧⌘S,
 * 不命中 ⇧⌘E),引号精确查询要求修饰键集合相同。
 */
function matchesHotkeyQuery(d: DisplayCommand, hq: HotkeyQuery): boolean {
  if (sigMatchesQuery(d.hotkeySig, hq)) return true;
  for (const sig of d.secondaryHotkeySigs ?? []) if (sigMatchesQuery(sig, hq)) return true;
  return false;
}

function sigMatchesQuery(sig: HotkeySignature | null | undefined, hq: HotkeyQuery): boolean {
  if (!sig || sig.key !== hq.sig.key) return false;
  return hq.exact ? sig.mask === hq.sig.mask : (sig.mask & hq.sig.mask) === hq.sig.mask;
}

function matches(d: DisplayCommand, qLower: string, hq: HotkeyQuery | null): boolean {
  return hq ? matchesHotkeyQuery(d, hq) : d.searchHaystack.includes(qLower);
}

export function selectVisibleKeybindingCommands(
  commands: readonly DisplayCommand[],
  query: string,
  platform: Platform = PLATFORM,
): DisplayCommand[] {
  const q = normalizeSearchQuery(query);
  const hasQuery = q.length > 0;
  const qLower = hasQuery ? lowerIfNeeded(q) : '';
  const hq = hasQuery && qLower.includes('+') ? parseHotkeyQuery(qLower, platform) : null;
  let selected: DisplayCommand[] | null = null;
  let count = 0;

  for (let i = 0; i < commands.length; i++) {
    const d = commands[i]!;
    const visible = !hasQuery || matches(d, qLower, hq);
    if (!visible) {
      if (selected === null) {
        selected = new Array<DisplayCommand>(commands.length);
        for (let j = 0; j < i; j++) selected[j] = commands[j]!;
        count = i;
      }
      continue;
    }
    if (selected !== null) selected[count++] = d;
  }

  if (selected === null) return commands as DisplayCommand[];
  selected.length = count;
  return count === 0 ? EMPTY_VISIBLE_KEYBINDING_COMMANDS : selected;
}

/** @param englishText 非英文界面下的英文原名(标题 + 分类,与命令面板同源;VSCode 同样可按英文命令名搜)。 */
export function buildCommandSearchHaystack(
  displayTitle: string,
  displayCategory: string,
  commandId: string,
  effectiveHotkey: string | undefined,
  englishText?: string,
): string {
  const base = `${displayTitle} ${displayCategory} ${commandId} ${effectiveHotkey ?? ''}`;
  return lowerIfNeeded(englishText ? `${base} ${englishText}` : base);
}

/**
 * 快捷键的搜索文本:原始串(mod+t)+ 平台显示形式(mac `⌘T`、其它 `Ctrl+T`)+ 按固定修饰键顺序的英文名
 *(mac cmd+shift+t;其它 ctrl+shift+t —— 原始串与显示形式保留注册时的段序,`shift+mod+enter` 不按常规顺序
 * 输入就搜不到;mac 键帽只有符号,用户常输 cmd)。否则占位写「可搜索快捷键」,Windows 输 ctrl+t、mac 输 ⌘ / cmd
 * 都搜不到。两平台对称。
 */
export function hotkeySearchText(hotkey: string, platform: Platform): string {
  return `${hotkey} ${formatHotkey(hotkey, platform)} ${hotkeyFilterQuery(hotkey, platform)}`;
}

/** 已绑定(有生效快捷键)的命令数;解绑的不算。 */
export function countBoundCommands(commands: readonly DisplayCommand[]): number {
  let count = 0;
  for (const d of commands) {
    if (d.effectiveHotkey !== undefined) count += 1;
  }
  return count;
}

type TranslateWithFallback = (key: string | undefined, fallback: string) => string;

export function buildKeybindingDisplayCommands(
  allCommands: readonly CommandSpec[],
  tk: TranslateWithFallback,
  overrides: Readonly<Record<string, string>>,
  platform: Platform,
  english?: TranslateWithFallback,
): DisplayCommand[] {
  if (allCommands.length === 0) return EMPTY_KEYBINDING_DISPLAY_COMMANDS;
  const out = new Array<DisplayCommand>(allCommands.length);
  for (let i = 0; i < allCommands.length; i++) {
    const cmd = allCommands[i]!;
    const fixedHotkey = reservedHotkeyOfCommand(cmd.id);
    // 只认自有属性(toString 等命令 id)。保留键命令按「无 override」处理(旧版本存下的 override 不分发也不显示,
    // 行上无重置入口 —— 同 VSCode 不可改的行);存储原样保留不清理。
    const isOverridden = fixedHotkey === undefined && Object.hasOwn(overrides, cmd.id);
    // 全部生效键(主键在前);保留键命令 = 保留键 + 附加默认键(显示所有命令的 F1)。
    const all = fixedHotkey !== undefined ? [fixedHotkey, ...(cmd.secondaryHotkeys ?? [])] : resolveEffectiveHotkeys(cmd, overrides);
    const effective = all[0];
    const secondary = all.length > 1 ? all.slice(1) : undefined;
    const displayTitle = tk(cmd.titleKey, cmd.title);
    const displayCategory = tk(cmd.categoryKey, cmd.category ?? '');
    let englishText: string | undefined;
    if (english) {
      const enTitle = english(cmd.titleKey, cmd.title);
      const enCategory = english(cmd.categoryKey, cmd.category ?? '');
      if (enTitle !== displayTitle || enCategory !== displayCategory) englishText = `${enTitle} ${enCategory}`;
    }
    out[i] = {
      cmd,
      displayTitle,
      displayCategory,
      effectiveHotkey: effective,
      hotkeyParts: effective ? formatHotkeyParts(effective, platform) : EMPTY_HOTKEY_PARTS,
      ...(secondary
        ? {
            secondaryHotkeyParts: secondary.map((h) => formatHotkeyParts(h, platform)),
            secondaryHotkeySigs: secondary.map((h) => hotkeySignature(h, platform)),
          }
        : {}),
      isOverridden,
      reserved: fixedHotkey === undefined && reservedPickerHotkeyOf(effective, platform) !== null,
      fixed: fixedHotkey !== undefined,
      // haystack 用 effective hotkey(含 override)而非原 cmd.hotkey(打磨 R29):
      // 否则 override 后搜索仍只能命中默认组合,与列表显示的 effective 不一致。
      // 打磨 R52:随 displayCommands 预计算,避免每次输入都逐行 join + lower-case。
      searchHaystack: buildCommandSearchHaystack(
        displayTitle,
        displayCategory,
        cmd.id,
        effective ? all.map((h) => hotkeySearchText(h, platform)).join(' ') : undefined,
        englishText,
      ),
      hotkeySig: effective ? hotkeySignature(effective, platform) : null,
    };
  }
  return out;
}

/**
 * 右键「复制」的文本(VSCode copyKeybinding:`{ "key": …, "command": … }`,两空格缩进)。key 用 VSCode keybindings.json 的写法
 *(修饰键 + 主键小写,mac 上 ⌘ 写作 cmd);未绑定 → 空串。
 */
export function keybindingCopyText(commandId: string, hotkey: string | undefined, platform: Platform): string {
  const key = hotkey === undefined ? '' : canonicalHotkey(hotkey, platform).replace('meta+', 'cmd+');
  return JSON.stringify({ key, command: commandId }, null, '  ');
}

export function hasCommandId(commands: readonly CommandSpec[], id: string): boolean {
  for (const command of commands) {
    if (command.id === id) return true;
  }
  return false;
}

export function KeybindingsTabContent() {
  const allCommands = useRegistry(coApp.commands);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<CommandSpec | null>(null);
  const setHotkey = useKeybindingsStore((s) => s.setHotkey);
  const reset = useKeybindingsStore((s) => s.reset);
  // 订阅 overrides:下方过滤/列表直接读它,且这一个 selector 订阅就能让
  // setHotkey/reset 后 effective hotkey 变化触发组件重渲(打磨 R3:删除原先
  // 多余的第二个裸订阅,单订阅已足够)。
  const overrides = useKeybindingsStore((s) => s.overrides);
  const t = useT();
  const tk = useTWithFallback();
  // locale 失效键(打磨 R31):tk identity 稳定,切语言不会让下面 memo 重算 →
  // displayTitle/displayCategory 会停留旧语言。用 locale 值驱动重算。
  const locale = useLocale();

  const displayCommands = useMemo<readonly DisplayCommand[]>(() => {
    // locale 也作 deps:tk 内部按 locale 翻译;非英文界面另把英文原名拼进搜索文本(与命令面板一致)。
    return buildKeybindingDisplayCommands(
      allCommands, tk, overrides, PLATFORM, locale === 'en' ? undefined : englishWithFallback,
    );
  }, [allCommands, tk, overrides, locale]);

  const buckets = useMemo(() => {
    const filtered = selectVisibleKeybindingCommands(displayCommands, query);
    return groupByCategory(filtered, t('keybindings.default_group'));
  }, [displayCommands, query, t]);

  const boundCount = useMemo(() => countBoundCommands(displayCommands), [displayCommands]);
  // 冲突落败行(与全局热键分发同一张表判定:用户绑定优先于默认,同层先注册者优先)→ 实际响应该键的命令。
  const shadowed = useMemo(
    () => selectShadowedBindings(allCommands, PLATFORM, overrides),
    [allCommands, overrides],
  );
  const searchPlaceholderLabel = t('keybindings.search_placeholder');
  const unboundLabel = t('keybindings.unbound');
  const editHotkeyLabel = t('keybindings.edit_hotkey');
  const reservedFixedLabel = t('keybindings.reserved_fixed');

  // race(R50):快捷键编辑弹窗持有打开时捕获的 editing command。若弹窗打开期间插件 reload/disable
  // 把该命令移出 registry,onSave/onReset 仍会用旧 command id 写 override → 写到已不存在的命令,
  // 同 id 命令日后重注册时意外继承旧绑定(stale write)。命令从 allCommands 消失即自动关闭弹窗。
  useCloseWhenGone(editing, allCommands, (live, cmd) => hasCommandId(live, cmd.id), () =>
    setEditing(null),
  );

  // 行内「恢复默认」后按钮变 disabled + invisible,焦点会掉到 body → 提交后移到同行的编辑按钮;该行被搜索过滤掉
  //(按旧快捷键搜)或编辑按钮已禁用(focus() 无效,焦点仍落 body)时回到搜索框。
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const focusEditAfterResetRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    const id = focusEditAfterResetRef.current;
    if (id === null) return;
    focusEditAfterResetRef.current = null;
    for (const el of rootRef.current?.querySelectorAll<HTMLButtonElement>('[data-keybinding-edit]') ?? []) {
      if (el.dataset['keybindingEdit'] === id && !el.disabled) {
        el.focus();
        return;
      }
    }
    searchRef.current?.focus();
  });
  // 命令「首选项:打开键盘快捷方式」切到本页后焦点落到搜索框(本页挂载时 / 已显示时收到请求;取走即清除,之后切回不抢焦点)。
  const searchFocusRequested = useSettingsStore((s) => s.tabSearchFocusRequested);
  useEffect(() => {
    if (searchFocusRequested && useSettingsStore.getState().takeTabSearchFocus()) searchRef.current?.focus();
  }, [searchFocusRequested]);

  // 行右键菜单(VSCode keybindingsEditor 同组同序):复制 / 复制命令 ID / 复制命令标题 ─ 更改快捷键…(未绑定时为「添加快捷键…」)
  // ─ 删除快捷键 / 重置快捷键 ─ 显示相同的快捷键。不适用的项置灰(VSCode 同):未绑定 → 删除 / 显示相同置灰;未覆盖 → 重置置灰;
  // 保留键命令不可改 → 更改 / 删除置灰。跳过:已绑定时的「添加快捷键…」(一个命令只存一条覆盖,无「再加一条」)、
  // 更改 When 表达式(无 when 条件)。
  const menuEntriesFor = (d: DisplayCommand) => (): TabMenuEntry[] => {
    const cmd = d.cmd;
    const bound = d.effectiveHotkey !== undefined;
    const copyFailed = t('panels.terminal.ctx.copy_failed');
    const copy = (text: string) => () => void copyToClipboardOrNotify(text, copyFailed);
    return [
      { label: t('keybindings.ctx.copy'), onSelect: copy(keybindingCopyText(cmd.id, d.effectiveHotkey, PLATFORM)) },
      { label: t('keybindings.ctx.copy_command_id'), onSelect: copy(cmd.id) },
      { label: t('keybindings.ctx.copy_command_title'), onSelect: copy(d.displayTitle) },
      'separator',
      {
        label: bound ? t('keybindings.ctx.change') : t('keybindings.ctx.add'),
        onSelect: () => setEditing(cmd),
        disabled: d.fixed,
        opensDialog: true,
      },
      'separator',
      { label: t('keybindings.ctx.remove'), onSelect: () => setHotkey(cmd.id, ''), disabled: !bound || d.fixed },
      {
        label: t('keybindings.ctx.reset'),
        onSelect: () => {
          focusEditAfterResetRef.current = cmd.id;
          reset(cmd.id);
        },
        disabled: !d.isOverridden,
      },
      'separator',
      {
        label: t('keybindings.ctx.show_same'),
        // VSCode showSimilarKeybindings:引号精确搜索(修饰键集合相同),⌘S 不连带列出 ⌥⌘S。
        onSelect: () => setQuery(`"${hotkeyFilterQuery(d.effectiveHotkey!, PLATFORM)}"`),
        disabled: !bound,
      },
    ];
  };

  return (
    <div ref={rootRef} className="space-y-6">
      <div className="space-y-2">
        <Input
          ref={searchRef}
          size="sm"
          // a11y(A5 同族):placeholder 无参数 → 复用作 aria-label。
          aria-label={searchPlaceholderLabel}
          placeholder={searchPlaceholderLabel}
          value={query}
          onChange={(e) => setQuery(clampSearchQuery(e.target.value))}
          // VSCode 键盘快捷方式编辑器同款:有内容时 Esc 清空并不再冒泡;空时不拦截,交给外层照常处理。
          onKeyDown={(e) => {
            if (e.key !== 'Escape' || e.nativeEvent.isComposing || query === '') return;
            e.preventDefault();
            e.stopPropagation();
            setQuery('');
          }}
        />
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-fg-muted">
          <span>
            {t('keybindings.summary', { total: displayCommands.length, bound: boundCount })}
          </span>
          <span aria-hidden="true">·</span>
          <span>{t('keybindings.palette_hint_prefix')}</span>
          {/* 键帽组整体不换行:窄宽时 ⇧⌘ 与 P 不被拆到两行。 */}
          <span data-testid="keybindings-palette-keys" className="inline-flex items-center gap-0.5 whitespace-nowrap">
            {COMMAND_PALETTE_HOTKEY_PARTS.map((p, i) => (
              <KeyCap key={i}>{p}</KeyCap>
            ))}
          </span>
          <span>{t('keybindings.palette_hint_suffix')}</span>
        </div>
      </div>

      <KeybindingCaptureModal
        visible={editing !== null}
        commandId={editing?.id ?? ''}
        commandTitle={editing ? tk(editing.titleKey, editing.title) : ''}
        currentHotkey={editing ? getEffectiveHotkey(editing) : undefined}
        defaultHotkey={editing ? defaultHotkeysOf(editing)[0] : undefined}
        allCommands={allCommands}
        overrides={overrides}
        onClose={() => setEditing(null)}
        // 冲突项点击:按该快捷键过滤列表(VSCode「显示相同的键绑定」)。
        onShowSameKeybindings={(combo) => setQuery(hotkeyFilterQuery(combo, PLATFORM))}
        onSave={(combo) => {
          // race(R50):保存瞬间从当前 registry 复检命令仍存在(覆盖 effect 关闭弹窗前的同帧
          // 点击);已移除则关弹窗不写,防 override 写到不存在的命令。
          if (!editing) return;
          if (!hasCommandId(allCommands, editing.id)) {
            setEditing(null);
            return;
          }
          setHotkey(editing.id, combo);
        }}
        onResetToDefault={() => {
          if (!editing) return;
          if (!hasCommandId(allCommands, editing.id)) {
            setEditing(null);
            return;
          }
          reset(editing.id);
        }}
      />

      {buckets.length === 0 ? (
        // a11y(A57,A54/A56 同族):焦点锁搜索框,输入致空时须 live region(role=status)播报无匹配。
        <div
          role="status"
          className="rounded-md border border-dashed border-line bg-panel-soft/40 px-4 py-8 text-center text-xs text-fg-dim"
        >
          {displayCommands.length === 0 ? t('keybindings.no_commands') : t('keybindings.no_match')}
        </div>
      ) : (
        <div className="space-y-8">
          {buckets.map((bucket) => (
            <section key={bucket.category}>
              <h3 className="mb-3 border-b border-line pb-3 text-base font-medium text-fg">
                {bucket.category}
              </h3>
              {/* @container:行内按列表自身宽度决定是否显示命令 id 徽标(窄时隐藏,标题 / 键帽 / 编辑按钮优先)。
                  不 overflow-hidden:行内无底色不需裁圆角,裁了会切掉贴边按钮的焦点环。 */}
              <ul className="@container rounded-md border border-line bg-panel-soft/40">
                {bucket.items.map((d, idx) => {
                  const cmd = d.cmd;
                  const { hotkeyParts, isOverridden } = d; // 预计算(打磨 R29)
                  const shadowedBy = shadowed.get(cmd.id);
                  // 行可聚焦(tabIndex=-1,不进 Tab 序):右键按下即聚焦本行,菜单 Esc 关闭后焦点回到本行。
                  return (
                    <TabContextMenu key={cmd.id} entries={menuEntriesFor(d)}>
                      <li tabIndex={-1} data-keybinding-row={cmd.id} className={`${keybindingRowClassName(idx)} outline-none`}>
                        <span className={KEYBINDING_TITLE_CLASS_NAME} title={d.displayTitle}>
                          {d.displayTitle}
                        </span>
                        <Badge size="xs" className={KEYBINDING_ID_BADGE_CLASS_NAME}>
                          <code className="truncate">{cmd.id}</code>
                        </Badge>
                        {d.reserved && (
                          <span className="shrink-0 text-2xs text-error">{t('keybindings.reserved_inactive')}</span>
                        )}
                        {d.fixed && <span className="shrink-0 text-2xs text-fg-dim">{reservedFixedLabel}</span>}
                        {shadowedBy && (
                          <span
                            data-testid="keybinding-conflict"
                            className="shrink-0 text-2xs text-warning"
                            title={t('keybindings.conflict_shadowed_by', {
                              command: tk(shadowedBy.titleKey, shadowedBy.title),
                            })}
                          >
                            {t('keybindings.conflict')}
                          </span>
                        )}
                        {hotkeyParts.length > 0 ? (
                          // 键帽组可收缩并换行(窄列表 + 4 键组合时折成两行),不把编辑 / 重置按钮挤出行外。
                          <span
                            data-testid="keybinding-keys"
                            className="flex min-w-0 flex-wrap items-center justify-end gap-0.5"
                          >
                            {hotkeyParts.map((p) => (
                              <KeyCap key={p}>{p}</KeyCap>
                            ))}
                            {/* 附加默认键:主键之后,以分隔符隔开(VSCode 键盘快捷方式编辑器每条键位一行;这里一命令一行)。 */}
                            {d.secondaryHotkeyParts?.map((parts, i) => (
                              <span key={i} className="contents">
                                <span aria-hidden="true" className="px-1 text-fg-dim">/</span>
                                {parts.map((p) => (
                                  <KeyCap key={p}>{p}</KeyCap>
                                ))}
                              </span>
                            ))}
                          </span>
                        ) : (
                          <span className="shrink-0 text-2xs text-fg-dim">{unboundLabel}</span>
                        )}
                        <IconButton
                          size="xs"
                          title={editHotkeyLabel}
                          // a11y(A76,A75 同族):多命令行的编辑按钮可见图标通用,aria-label 补命令名以区分。
                          aria-label={t('keybindings.edit_hotkey_for_aria', {
                            command: d.displayTitle,
                          })}
                          onClick={() => {
                            if (!d.fixed) setEditing(cmd);
                          }}
                          data-keybinding-edit={cmd.id}
                          // 保留键不可改:disabled(Tab 不可达)+ invisible 占位(各行键帽列对齐),同未覆盖时的重置按钮。
                          disabled={d.fixed}
                          className={d.fixed ? 'shrink-0 pointer-events-none invisible' : 'shrink-0'}
                        >
                          {EDIT_HOTKEY_ICON}
                        </IconButton>
                        <IconButton
                          size="xs"
                          title={t('keybindings.reset_default', {
                            // 与键帽同一格式化(⇧ ⌘ ↵),不显示原始串(shift+mod+enter)。
                            hotkey: defaultHotkeysOf(cmd).length > 0
                              ? defaultHotkeysOf(cmd)
                                  .map((h) => formatHotkeyParts(h, PLATFORM).join(' '))
                                  .join(' / ')
                              : unboundLabel,
                          })}
                          aria-label={t('keybindings.reset_default_for_aria', {
                            command: d.displayTitle,
                          })}
                          onClick={() => {
                            if (!isOverridden) return;
                            focusEditAfterResetRef.current = cmd.id;
                            reset(cmd.id);
                          }}
                          // a11y(A12 同族):未覆盖时 disabled,避免键盘 Tab 到不可见无效按钮。
                          disabled={!isOverridden}
                          // 未覆盖:宽时 invisible 占位(键帽列对齐);列表窄(@max-md)时 hidden 让出宽度给标题。
                          // 有 override 时始终可见可达。
                          className={isOverridden ? 'shrink-0' : 'shrink-0 pointer-events-none invisible @max-md:hidden'}
                        >
                          {RESET_HOTKEY_ICON}
                        </IconButton>
                      </li>
                    </TabContextMenu>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
