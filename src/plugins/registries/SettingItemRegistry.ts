// 单个设置项贡献(M-Settings v6)。
// 与 SettingTabRegistry 同级,但粒度细到「一个 toggle / select」级别。
// plugin 用 Plugin.addSettingItem(spec) 注册,通用渲染器自动渲染 UI,
// 免每加一项偏好都写一整页 SettingTab。
//
// 内置「通用 / 编辑器」等 tab 自动消费 category 匹配的 items。

import type { Disposable } from '../types';
import { assertRegistryCapacity } from './registry-capacity';
import { isSpecObject } from './spec-guard';

export type SettingItemType = 'boolean' | 'select' | 'number' | 'text';

export interface SettingItemEnumOption {
  readonly value: string;
  readonly label: string;
  readonly labelKey?: string;
}

export type SettingItemValue = string | number | boolean;

export interface SettingItemSpec {
  /** 全局唯一,推荐 'category.name' 风格,如 'general.theme'. */
  readonly id: string;
  /** 归属 category(决定哪个 tab 渲染本项),如 'general' / 'editor'. */
  readonly category: string;
  /** 同 category 内的子分组(可选). 同 group 的 items 一起渲染,
   *  group header 显示在第一项之前. 缺失时归 default bucket(无 header).
   *  group 是分组的 *身份* key — 不展示给用户;UI label 走 groupKey → t(...)，
   *  缺失时回退到 group 字面量. */
  readonly group?: string;
  /** group header 的 i18n key,渲染时 t(groupKey) 优先于 group 字面量. */
  readonly groupKey?: string;
  readonly title: string;
  readonly titleKey?: string;
  readonly description?: string;
  readonly descriptionKey?: string;
  readonly type: SettingItemType;
  readonly default: SettingItemValue;
  /** type='select' 时必填. */
  readonly enum?: readonly SettingItemEnumOption[];
  /** type='number' 时可选(min/max/step 同 HTML number input). */
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  /** type='number' 时可选:右侧显示的单位 chip(如 'ms' / 'px'). */
  readonly unit?: string;
  /** 同 category 内升序排序,默认 100. */
  readonly priority?: number;
}

// 边界(E6):把 number 值约束到 spec.min/max。`<input type=number min/max>` 不阻止键入或脚本写入
// 越界值,onChange 此前只 Number.isFinite 不 clamp → terminal/editor.fontSize、explorer.indentSize、
// autoSave.delayMs 可被写成 0/负/超大值,致 UI 布局异常、xterm 配置异常、autosave 防抖退化。非有限
// 值(NaN/Infinity,如损坏持久化)回退到 default。写入与读取两路都用此 helper。
export function clampSettingNumber(spec: SettingItemSpec, n: number): number {
  let v = Number.isFinite(n)
    ? n
    : typeof spec.default === 'number'
      ? spec.default
      : 0;
  if (typeof spec.min === 'number' && v < spec.min) v = spec.min;
  if (typeof spec.max === 'number' && v > spec.max) v = spec.max;
  return v;
}

// 边界(E142/E241):单个 text/string 设置值长度上限(64KiB,远超任何真实设置文本)。单一来源放此处
// (coerceSettingValue 的家),values-store 写端 import 复用 —— 写端 setValue 与读端 getSettingValue/
// useSettingValue 都经 coerceSettingValue,在此截断使读≡写。
export const SI_TEXT_VALUE_MAX = 64 * 1024;

// 边界(E139,E6/E122 同族读路径净化):按 spec 把已持久化/篡改的值规整到合法域 —— number clamp
// 到 min/max(E6),select 校验属于 spec.enum(否则回退 default,防非法字符串喂给消费者,如
// terminal.cursorStyle → xterm)。getSettingValue(非 hook)与 useSettingValue(hook)共用单一来源,
// 避免两读路径净化逻辑漂移(E122 教训)。无 enum 的 select 无可校验集合 → 原样返回。
export function coerceSettingValue(
  spec: SettingItemSpec,
  value: SettingItemValue,
): SettingItemValue {
  if (spec.type === 'number' && typeof value === 'number') {
    return clampSettingNumber(spec, value);
  }
  if (spec.type === 'select' && spec.enum !== undefined && spec.enum.length > 0) {
    const ok =
      typeof value === 'string' && spec.enum.some((o) => o.value === value);
    return ok ? value : spec.default;
  }
  // 边界(E241,E142 写端对偶):text/string 值按 SI_TEXT_VALUE_MAX 截断。写端 setValue 已截断,但
  // 篡改/旧版 localStorage 可放入接近 readRecord 1MiB raw cap 的超长 text override,读端经此 coerce
  // 截断,防 useSettingValue/getSettingValue 原样返回超长字符串致设置页/消费者渲染卡顿。读≡写。
  if (
    spec.type === 'text' &&
    typeof value === 'string' &&
    value.length > SI_TEXT_VALUE_MAX
  ) {
    return value.slice(0, SI_TEXT_VALUE_MAX);
  }
  return value;
}

// 边界(E36,E35 兄弟 registry):register 接受插件贡献的 SettingItemSpec 但无运行时校验。畸形插件
// 可注册超大 select 枚举冻结设置页,或用 NaN/Infinity 的 priority/min/max/step、类型不匹配的 default
// 让排序/输入控件行为异常(clampSettingNumber 对 NaN min/max 也会算错)。注册入口集中校验:字符串
// 长度、enum 数量与 option 长度、default 与 type 匹配、number 参数 finite 且 min≤max、step>0。
// 非法 spec 抛可诊断错误、不入 registry。上限远超任何真实设置项,只挡滥用。
const SI_ID_MAX = 256;
const SI_CATEGORY_MAX = 256;
const SI_GROUP_MAX = 256;
const SI_TITLE_MAX = 512;
const SI_KEY_MAX = 256; // *Key i18n key
const SI_DESC_MAX = 2048;
const SI_UNIT_MAX = 64;
const SI_OPTION_MAX = 512; // enum option value/label
const SI_ENUM_COUNT_MAX = 256;
const SI_DEFAULT_MAX = 8192; // 边界(E141):text/select string default 长度上限(防超长默认冻结设置页)
const SETTING_ITEM_TYPES: readonly SettingItemType[] = [
  'boolean',
  'select',
  'number',
  'text',
];

function validateSettingItemSpec(spec: SettingItemSpec): void {
  // 边界(E273,E271 registry 族):先校验 spec 是对象,否则读 spec.id/字段对 null/undefined 抛 TypeError。
  if (!isSpecObject(spec)) {
    throw new Error('[setting-item-registry] spec must be an object');
  }
  // 边界(E154,E153/E36 兄弟 registry):SettingItemSpec 来自未类型化第三方 JS plugin,TS 类型不
  // 构成运行时保证。E36/E141 只对字符串字段做 .length 上限,假设它们都是 string;畸形 spec
  // (id:{}/category:123/title:true/titleKey:{})会绕过(`({}).length === undefined > max` 为
  // false)进 registry → 设置项排序/UI/values 写入链路出脏项、React 渲染异常,或非 string id 进
  // settings override 路径。必填 id/category/title 校验非空 string,可选字段校验前先 typeof。
  if (typeof spec.id !== 'string' || spec.id.length === 0) {
    throw new Error('[setting-item-registry] id must be a non-empty string');
  }
  if (typeof spec.category !== 'string' || spec.category.length === 0) {
    throw new Error(
      '[setting-item-registry] category must be a non-empty string',
    );
  }
  if (typeof spec.title !== 'string' || spec.title.length === 0) {
    throw new Error('[setting-item-registry] title must be a non-empty string');
  }
  const lenChecks: ReadonlyArray<readonly [string, unknown, number]> = [
    ['id', spec.id, SI_ID_MAX],
    ['category', spec.category, SI_CATEGORY_MAX],
    ['group', spec.group, SI_GROUP_MAX],
    ['groupKey', spec.groupKey, SI_KEY_MAX],
    ['title', spec.title, SI_TITLE_MAX],
    ['titleKey', spec.titleKey, SI_KEY_MAX],
    ['description', spec.description, SI_DESC_MAX],
    ['descriptionKey', spec.descriptionKey, SI_KEY_MAX],
    ['unit', spec.unit, SI_UNIT_MAX],
  ];
  for (const [name, val, max] of lenChecks) {
    if (val === undefined) continue;
    if (typeof val !== 'string') {
      throw new Error(
        `[setting-item-registry] spec field "${name}" must be a string`,
      );
    }
    if (val.length > max) {
      throw new Error(
        `[setting-item-registry] spec field "${name}" exceeds max length ${max}`,
      );
    }
  }
  if (!SETTING_ITEM_TYPES.includes(spec.type)) {
    throw new Error(`[setting-item-registry] invalid type: "${spec.type}"`);
  }
  // 边界(E156):type='select' 语义上必须提供非空 enum 数组(SettingItemRow 仅在 select && enum
  // 时渲染控件)。此前 enum 校验只在 `enum !== undefined` 时跑,畸形 plugin 可注册 select 无 enum
  // → 设置项有标题但无可操作控件,且 default 无法按枚举域校验(coerceSettingValue 的 select 分支
  // 也因 enum 缺失而原样放行非法值)。注册边界要求 select 必带非空 enum。
  if (spec.type === 'select' && (!Array.isArray(spec.enum) || spec.enum.length === 0)) {
    throw new Error(
      '[setting-item-registry] select type requires a non-empty enum array',
    );
  }
  if (spec.enum !== undefined) {
    // 边界(E156):enum 若提供必须是数组(否则下面 for-of 对非可迭代值 TypeError 崩在 validate 内)。
    if (!Array.isArray(spec.enum)) {
      throw new Error('[setting-item-registry] enum must be an array');
    }
    if (spec.enum.length > SI_ENUM_COUNT_MAX) {
      throw new Error(
        `[setting-item-registry] enum count exceeds max ${SI_ENUM_COUNT_MAX}`,
      );
    }
    for (const opt of spec.enum) {
      if (typeof opt.value !== 'string' || opt.value.length > SI_OPTION_MAX) {
        throw new Error('[setting-item-registry] invalid enum option value');
      }
      if (typeof opt.label !== 'string' || opt.label.length > SI_OPTION_MAX) {
        throw new Error('[setting-item-registry] invalid enum option label');
      }
      // 边界(E154):可选 labelKey 先 typeof 再长度(对齐 value/label 的 typeof 校验)。
      if (opt.labelKey !== undefined) {
        if (typeof opt.labelKey !== 'string') {
          throw new Error(
            '[setting-item-registry] enum option labelKey must be a string',
          );
        }
        if (opt.labelKey.length > SI_KEY_MAX) {
          throw new Error(
            '[setting-item-registry] enum option labelKey too long',
          );
        }
      }
    }
  }
  const numChecks: ReadonlyArray<readonly [string, number | undefined]> = [
    ['min', spec.min],
    ['max', spec.max],
    ['step', spec.step],
    ['priority', spec.priority],
  ];
  for (const [name, val] of numChecks) {
    if (val !== undefined && !Number.isFinite(val)) {
      throw new Error(
        `[setting-item-registry] number param "${name}" must be finite`,
      );
    }
  }
  if (spec.min !== undefined && spec.max !== undefined && spec.min > spec.max) {
    throw new Error('[setting-item-registry] min must be <= max');
  }
  if (spec.step !== undefined && spec.step <= 0) {
    throw new Error('[setting-item-registry] step must be > 0');
  }
  // default 与 type 匹配:boolean→boolean,number→有限 number,text/select→string。
  const d = spec.default;
  const defaultOk =
    spec.type === 'boolean'
      ? typeof d === 'boolean'
      : spec.type === 'number'
        ? typeof d === 'number' && Number.isFinite(d)
        : typeof d === 'string'; // text / select
  if (!defaultOk) {
    throw new Error(
      `[setting-item-registry] default does not match type "${spec.type}"`,
    );
  }
  // 边界(E141):string default(text/select)长度上限,防畸形插件注册超长默认值冻结设置页。
  if (typeof d === 'string' && d.length > SI_DEFAULT_MAX) {
    throw new Error(
      `[setting-item-registry] default exceeds max length ${SI_DEFAULT_MAX}`,
    );
  }
  // 边界(E141):select 若声明 enum,default 必须命中某选项 —— 否则 E139 对非法持久化值的「回退
  // default」仍回到非法值,消费者继续拿到 enum 外的字符串(如 xterm cursorStyle)。
  if (spec.type === 'select' && spec.enum !== undefined && spec.enum.length > 0) {
    if (!spec.enum.some((o) => o.value === d)) {
      throw new Error(
        '[setting-item-registry] select default must be one of enum values',
      );
    }
  }
}

type Listener = () => void;

export class SettingItemRegistry {
  private items = new Map<string, SettingItemSpec>();
  private listeners = new Set<Listener>();

  register(spec: SettingItemSpec): Disposable {
    validateSettingItemSpec(spec); // 边界(E36):注册前校验长度/枚举/数值/default 类型
    // 边界(E236):注册前容量守卫(共享 helper),超限抛、不入表
    assertRegistryCapacity('setting-item-registry', this.items.size, this.items.has(spec.id));
    if (this.items.has(spec.id)) {
      console.warn(
        `[setting-item-registry] id "${spec.id}" 已注册,后注册赢覆盖前者`,
      );
    }
    this.items.set(spec.id, spec);
    this.notify();

    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (this.items.get(spec.id) === spec) {
          this.items.delete(spec.id);
          this.notify();
        }
      },
    };
  }

  getAll(): readonly SettingItemSpec[] {
    return Array.from(this.items.values()).sort(
      (a, b) => (a.priority ?? 100) - (b.priority ?? 100),
    );
  }

  /**
   * race(R58,R50 同族):按 id 取当前 live setting item(已 unregister 返 undefined)。SettingItemRow
   * 控件 onChange/reset 按 spec.id 写 settings values;item 在用户操作前被插件 disable/reload
   * unregister 后旧控件仍可把 override 写到已不存在的 setting id(localStorage 残留 + 同 id 重注册
   * 意外继承)。写前用本方法复查 setting 仍注册,已移除则跳过写。
   */
  get(id: string): SettingItemSpec | undefined {
    return this.items.get(id);
  }

  /** 取某 category 下的所有 items(已排序),供 CategoryTabContent 使用. */
  getByCategory(category: string): readonly SettingItemSpec[] {
    // 先过滤再排序(打磨 R5):原先 getAll() 对全部 category 的 items 排序后才
    // 过滤,每个设置 tab 都为无关 category 付排序成本。filter 在前,只排本
    // category 的子集;Array.prototype.sort 稳定,输出与原契约完全一致。
    const items: SettingItemSpec[] = [];
    for (const item of this.items.values()) {
      if (item.category === category) {
        items.push(item);
      }
    }
    items.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
    return items;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }
}
