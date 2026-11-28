// 输出通道(BDD: src/__tests__/plugin-output-channel/)。对齐 VSCode `window.createOutputChannel` / 输出视图
//(src/vs/workbench/api/common/extHostOutput.ts、src/vs/workbench/contrib/output/):每个通道是一段按行追加的文本,
// 输出面板用下拉切换通道、可清除、自动滚动。
//
// 每窗口一份(同 PluginManager);不持久化(VSCode 的输出通道同样随窗口重载清空)。每个第三方插件自动有一个以插件名命名的
// 默认通道(`plugin:<id>`,首次写入时创建):宿主把它的激活失败、加载跳过原因、运行时未捕获错误写进去,插件经 `app.output`
// 写自己的日志;`app.output.createOutputChannel(name)` 另建通道(插件停用时移除)。
//
// 内容上限:每通道按行的环形缓冲(行数 + 总字符双闸,丢最早的行);单行、单次追加各有长度上限。

import { useSyncExternalStore } from 'react';

/** 每通道保留的最多行数(超出丢最早的)。 */
export const OUTPUT_MAX_LINES = 10_000;
/** 每通道保留的最多字符数(超出丢最早的行)。 */
export const OUTPUT_MAX_CHARS = 2_000_000;
/** 单行最长字符数(超出截断并加 …)。 */
export const OUTPUT_LINE_MAX = 10_000;
/** 单次 append 的最长字符数(超出截断)。 */
export const OUTPUT_APPEND_MAX = 1_000_000;
/** 通道名最长字符数。 */
export const OUTPUT_NAME_MAX = 128;

export interface OutputChannelInfo {
  readonly id: string;
  readonly name: string;
  /** 所属插件 id(宿主自己的通道为 null)。 */
  readonly ownerId: string | null;
}

export interface OutputChannelSnapshot {
  /** 已完成的行(最早 → 最近)。 */
  readonly lines: readonly string[];
  /**
   * lines[0] 的绝对行号:通道建立以来写入的完整行按 0、1、2… 编号,环形缓冲丢掉 / 清除的行号不复用(= 累计丢弃的行数)。
   * 面板按绝对行号给行做 key,锁定滚动时据此补偿头部丢掉的行高(正在看的内容不动)。
   */
  readonly firstLine: number;
  /** 末尾未换行的部分(append 不带换行时;没有则为空串)。 */
  readonly partial: string;
  /** 已完成的行 + 末尾未换行的部分拼成的文本(按需拼接)。 */
  readonly text: string;
  readonly lineCount: number;
  /** 每次内容变化 +1(面板据此自动滚动)。 */
  readonly version: number;
}

function makeSnapshot(lines: readonly string[], firstLine: number, partial: string, version: number): OutputChannelSnapshot {
  let text: string | null = null;
  return {
    lines,
    firstLine,
    partial,
    get text() {
      text ??= partial.length > 0 ? [...lines, partial].join('\n') : lines.join('\n');
      return text;
    },
    lineCount: lines.length + (partial.length > 0 ? 1 : 0),
    version,
  };
}

class Channel {
  /** 环形缓冲:lines[(start + i) % cap]。 */
  private readonly lines: string[] = [];
  private start = 0;
  private size = 0;
  /** 累计写入的完整行数(清除不归零):当前最早一行的绝对行号 = pushed - size。 */
  private pushed = 0;
  private chars = 0;
  private partial = '';
  version = 0;
  private snapshot: OutputChannelSnapshot | null = null;

  constructor(readonly info: OutputChannelInfo) {}

  private pushLine(line: string): void {
    const text = line.length > OUTPUT_LINE_MAX ? `${line.slice(0, OUTPUT_LINE_MAX)}…` : line;
    if (this.size < OUTPUT_MAX_LINES) {
      this.lines[(this.start + this.size) % OUTPUT_MAX_LINES] = text;
      this.size += 1;
    } else {
      this.chars -= this.lines[this.start]!.length;
      this.lines[this.start] = text;
      this.start = (this.start + 1) % OUTPUT_MAX_LINES;
    }
    this.pushed += 1;
    this.chars += text.length;
    while (this.chars > OUTPUT_MAX_CHARS && this.size > 1) {
      this.chars -= this.lines[this.start]!.length;
      this.lines[this.start] = '';
      this.start = (this.start + 1) % OUTPUT_MAX_LINES;
      this.size -= 1;
    }
  }

  append(value: string): void {
    const text = value.length > OUTPUT_APPEND_MAX ? value.slice(0, OUTPUT_APPEND_MAX) : value;
    if (text.length === 0) return;
    const parts = text.split('\n');
    this.partial += parts[0]!;
    for (let i = 1; i < parts.length; i += 1) {
      this.pushLine(this.partial.endsWith('\r') ? this.partial.slice(0, -1) : this.partial);
      this.partial = parts[i]!;
    }
    if (this.partial.length > OUTPUT_LINE_MAX) {
      this.pushLine(this.partial);
      this.partial = '';
    }
    this.changed();
  }

  clear(): void {
    this.lines.length = 0;
    this.start = 0;
    this.size = 0;
    this.chars = 0;
    this.partial = '';
    this.changed();
  }

  private changed(): void {
    this.version += 1;
    this.snapshot = null;
  }

  read(): OutputChannelSnapshot {
    if (this.snapshot) return this.snapshot;
    const out = new Array<string>(this.size);
    for (let i = 0; i < this.size; i += 1) out[i] = this.lines[(this.start + i) % OUTPUT_MAX_LINES]!;
    this.snapshot = makeSnapshot(out, this.pushed - this.size, this.partial, this.version);
    return this.snapshot;
  }
}

const channels = new Map<string, Channel>();
const listeners = new Set<() => void>();
let activeId: string | null = null;
let autoScroll = true;
let cachedList: readonly OutputChannelInfo[] | null = null;
const EMPTY_LIST: readonly OutputChannelInfo[] = [];
const EMPTY_SNAPSHOT: OutputChannelSnapshot = makeSnapshot([], 0, '', 0);

function emit(): void {
  for (const l of [...listeners]) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 插件的默认通道 id。 */
export function pluginOutputChannelId(pluginId: string): string {
  return `plugin:${pluginId}`;
}

/** 插件经 createOutputChannel 建的通道 id(同插件同名 = 同一通道)。 */
export function pluginNamedOutputChannelId(pluginId: string, name: string): string {
  return `plugin:${pluginId}\0${name}`;
}

/** 取或建通道(已存在 → 原样返回,名字以首次为准;更新显示名用 renameOutputChannel)。 */
export function ensureOutputChannel(id: string, name: string, ownerId: string | null): OutputChannelInfo {
  const existing = channels.get(id);
  if (existing) return existing.info;
  const channel = new Channel({ id, name: name.slice(0, OUTPUT_NAME_MAX), ownerId });
  channels.set(id, channel);
  cachedList = null;
  if (activeId === null) activeId = id;
  emit();
  return channel.info;
}

export function hasOutputChannel(id: string): boolean {
  return channels.has(id);
}

export function appendToOutputChannel(id: string, value: string): void {
  const channel = channels.get(id);
  if (!channel) return;
  channel.append(value);
  emit();
}

export function clearOutputChannel(id: string): void {
  const channel = channels.get(id);
  if (!channel) return;
  channel.clear();
  emit();
}

export function removeOutputChannel(id: string): void {
  if (!channels.delete(id)) return;
  cachedList = null;
  if (activeId === id) activeId = channels.keys().next().value ?? null;
  emit();
}

/** 移除某插件的全部通道(卸载);keepDefault → 只移除它经 createOutputChannel 建的(停用)。 */
export function removePluginOutputChannels(pluginId: string, { keepDefault = false }: { keepDefault?: boolean } = {}): void {
  const defaultId = pluginOutputChannelId(pluginId);
  for (const [id, channel] of [...channels]) {
    if (channel.info.ownerId !== pluginId) continue;
    if (keepDefault && id === defaultId) continue;
    removeOutputChannel(id);
  }
}

export function setActiveOutputChannel(id: string): void {
  if (!channels.has(id) || activeId === id) return;
  activeId = id;
  emit();
}

export function setOutputAutoScroll(on: boolean): void {
  if (autoScroll === on) return;
  autoScroll = on;
  emit();
}

export function listOutputChannels(): readonly OutputChannelInfo[] {
  if (cachedList !== null) return cachedList;
  cachedList = channels.size === 0 ? EMPTY_LIST : [...channels.values()].map((c) => c.info);
  return cachedList;
}

export function getActiveOutputChannelId(): string | null {
  return activeId;
}

export function readOutputChannel(id: string | null): OutputChannelSnapshot {
  return (id !== null && channels.get(id)?.read()) || EMPTY_SNAPSHOT;
}

export function useOutputChannels(): readonly OutputChannelInfo[] {
  return useSyncExternalStore(subscribe, listOutputChannels);
}

export function useActiveOutputChannelId(): string | null {
  return useSyncExternalStore(subscribe, getActiveOutputChannelId);
}

export function useOutputChannelSnapshot(id: string | null): OutputChannelSnapshot {
  return useSyncExternalStore(subscribe, () => readOutputChannel(id));
}

export function useOutputAutoScroll(): boolean {
  return useSyncExternalStore(subscribe, () => autoScroll);
}

/** 本地时间戳 `YYYY-MM-DD HH:MM:SS.mmm`(同 VSCode 日志行前缀)。 */
function timestamp(d = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/**
 * 宿主往插件默认通道写一条日志(`<时间> [error] <消息>`;同 VSCode LogOutputChannel 行格式),通道不存在则以插件名创建。
 * detail(如堆栈)接在下一行。
 */
export function appendPluginHostLog(
  pluginId: string,
  pluginName: string,
  level: 'error' | 'warning' | 'info',
  message: string,
  detail?: string,
): void {
  const id = pluginOutputChannelId(pluginId);
  ensureOutputChannel(id, pluginName, pluginId);
  appendToOutputChannel(id, `${timestamp()} [${level}] ${message}\n${detail ? `${detail}\n` : ''}`);
}

export function _resetOutputChannelsForTest(): void {
  channels.clear();
  activeId = null;
  autoScroll = true;
  cachedList = null;
  emit();
}
