// Plugin 贡献的命令注册表(M-Plugin v1.5)。
// 命令面板订阅本 registry 渲染列表;keybinding 解析时按 hotkey 分发。

import type { Disposable } from '../types';
import { assertRegistryCapacity } from './registry-capacity';
import { isSpecObject } from './spec-guard';

export interface CommandSpec {
  readonly id: string;
  readonly title: string;
  /**
   * i18n key（topic-19）。类型 string 不绑死 keyof typeof en（开放第三方 plugin）；
   * 核心 plugin 可写 `'commands.terminal.new.title' satisfies TranslationKey` 编译验。
   * 渲染层 `tWithFallback(titleKey, title)` 兜底，缺 key 不退化为 key 字面量。
   */
  readonly titleKey?: string;
  /** Accelerator string,如 'mod+s' / 'mod+shift+p',可选. */
  readonly hotkey?: string;
  /**
   * 分类前缀(如 'Settings' / 'Editor' / 'Git')。CommandPalette 显示
   * `${category}: ${title}`,fuzzy 匹配同时覆盖 category + title。
   * VSCode 同款。可选,向后兼容。
   */
  readonly category?: string;
  /** i18n key for category（topic-19）。同 titleKey。 */
  readonly categoryKey?: string;
  readonly fn: () => void | Promise<void>;
}

type Listener = () => void;

// 边界(E35):register 接受第三方插件的 id/title/titleKey/hotkey/category/categoryKey 后直接入全局
// registry,无长度/形态上限。恶意/畸形插件可注册超长标题/分类/热键 → 命令面板排序与搜索、快捷键
// 预编译(compileCombo)、日志 warning、UI 渲染都携带大字符串 → renderer 卡顿;异常 hotkey 还会被
// compileCombo 当有效签名参与全局 keydown 扫描。注册边界统一校验长度 + hotkey 形态,非法拒绝(抛
// 可诊断错误,由插件加载错误处理捕获)。上限远超任何真实贡献项,只挡滥用。
const CMD_ID_MAX = 256;
const CMD_TITLE_MAX = 512;
const CMD_KEY_MAX = 256; // titleKey / categoryKey(i18n key)
const CMD_CATEGORY_MAX = 256;
const CMD_HOTKEY_MAX = 64;
// hotkey 形态(宽松):'+'-连接的非空段,段内无空白/'+'(允许 mod+, mod+/ 等标点主键)。挡空段
// (mod++p)、含空白、超长 —— 不强限字符集以免误伤合法标点快捷键。
// 边界(E145):导出供 keybindings 捕获侧(eventToCombo)与写端(setHotkey)复用同一形态校验,
// 防捕获/override 写入注册侧会拒绝的畸形 hotkey(空段 / 含空白 / 主键为分隔符 '+')。
export const HOTKEY_SHAPE_RE = /^[^+\s]+(\+[^+\s]+)*$/;

function validateCommandSpec(spec: CommandSpec): void {
  // 边界(E273,E271 registry 族):先校验 spec 是对象,否则读 spec.id/字段对 null/undefined 抛 TypeError。
  if (!isSpecObject(spec)) {
    throw new Error('[command-registry] spec must be an object');
  }
  // 边界(E153,E37/E35 兄弟 registry):CommandSpec 来自第三方未类型化 JS plugin,TS 类型不构成
  // 运行时保证。E35 此前只按 .length 做上限,假设字段都是 string;畸形 spec(id:{}/title:123/
  // hotkey:42/fn:'x' 等)会绕过(如 `(123).length === undefined > max` 为 false,hotkey:42 经
  // String 强转还能通过 regex),随后 CommandPalette/hotkey 分发/execute 按 string/function 使用
  // → 崩溃(execute 调 cmd.fn())或注册出不可触发命令(id 非 string 当 Map key)。注册边界显式
  // 校验运行时类型 + 必填非空(对齐 PanelRegistry E37)。
  if (typeof spec.id !== 'string' || spec.id.length === 0) {
    throw new Error('[command-registry] id must be a non-empty string');
  }
  if (typeof spec.title !== 'string' || spec.title.length === 0) {
    throw new Error('[command-registry] title must be a non-empty string');
  }
  if (typeof spec.fn !== 'function') {
    throw new Error('[command-registry] fn must be a function');
  }
  const lenChecks: ReadonlyArray<readonly [string, unknown, number]> = [
    ['id', spec.id, CMD_ID_MAX],
    ['title', spec.title, CMD_TITLE_MAX],
    ['titleKey', spec.titleKey, CMD_KEY_MAX],
    ['category', spec.category, CMD_CATEGORY_MAX],
    ['categoryKey', spec.categoryKey, CMD_KEY_MAX],
    ['hotkey', spec.hotkey, CMD_HOTKEY_MAX],
  ];
  for (const [name, val, max] of lenChecks) {
    if (val === undefined) continue;
    if (typeof val !== 'string') {
      throw new Error(
        `[command-registry] command spec field "${name}" must be a string`,
      );
    }
    if (val.length > max) {
      throw new Error(
        `[command-registry] command spec field "${name}" exceeds max length ${max}`,
      );
    }
  }
  // hotkey 此处已确认为 string(非 string 上面已抛),再校验形态。
  if (spec.hotkey !== undefined && !HOTKEY_SHAPE_RE.test(spec.hotkey)) {
    throw new Error(
      `[command-registry] invalid hotkey shape: "${spec.hotkey}"`,
    );
  }
}

export class CommandRegistry {
  private items = new Map<string, CommandSpec>();
  private listeners = new Set<Listener>();
  private cachedAll: readonly CommandSpec[] | null = null;

  register(spec: CommandSpec): Disposable {
    validateCommandSpec(spec); // 边界(E35):注册前校验长度 + hotkey 形态
    // 边界(E236):注册前容量守卫(共享 helper),超限抛、不入表
    assertRegistryCapacity('command-registry', this.items.size, this.items.has(spec.id));
    if (this.items.has(spec.id)) {
      console.warn(
        `[command-registry] id "${spec.id}" 已注册,后注册赢覆盖前者`,
      );
    }
    if (spec.hotkey && this.findByHotkey(spec.hotkey)) {
      console.warn(
        `[command-registry] hotkey "${spec.hotkey}" 已被另一命令占用,后注册赢`,
      );
    }
    this.items.set(spec.id, spec);
    this.invalidateSnapshotCache();
    this.notify();

    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (this.items.get(spec.id) === spec) {
          this.items.delete(spec.id);
          this.invalidateSnapshotCache();
          this.notify();
        }
      },
    };
  }

  getAll(): readonly CommandSpec[] {
    if (this.cachedAll !== null) return this.cachedAll;

    const out: CommandSpec[] = [];
    for (const item of this.items.values()) out.push(item);
    this.cachedAll = out;
    return out;
  }

  /**
   * race(R51):按 id 取当前 live 命令(已 unregister 返 undefined)。hotkey 绑定表 / 命令面板
   * 列表项缓存的是旧 CommandSpec 对象,命令被插件 disable/reload 同步 unregister 后、到 React
   * 重渲替换 handler/快照前仍可能触发 → 触发时用本方法从 registry 重查并执行,死命令静默忽略,
   * 不再调已卸载插件的 fn。
   */
  get(id: string): CommandSpec | undefined {
    return this.items.get(id);
  }

  async execute(id: string): Promise<void> {
    const cmd = this.items.get(id);
    if (!cmd) throw new Error(`Command ${id} not found`);
    await cmd.fn();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private findByHotkey(hotkey: string): CommandSpec | undefined {
    for (const c of this.items.values()) if (c.hotkey === hotkey) return c;
    return undefined;
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }

  private invalidateSnapshotCache(): void {
    this.cachedAll = null;
  }
}
