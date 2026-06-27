// 设置项值的全局 store(M-Settings v6)。
// key=SettingItemSpec.id,value=Spec.default 类型;只存 partial overrides,
// 默认值由 spec 提供(reset 即删 key)。
//
// 持久化:localStorage 简单 JSON,与 ThemeProvider 同样的轻量策略;
// 不进 explorer.json 避免持久化层耦合扩张。

import { create } from 'zustand';
import {
  coerceSettingValue,
  SI_TEXT_VALUE_MAX,
  type SettingItemSpec,
  type SettingItemValue,
} from '../registries/SettingItemRegistry';
import {
  readRecord,
  writeRecord,
  subscribeStorageKey,
  type WriteRecordResult,
} from '../storage/local-storage-record';
import { coApp } from '../co-app';

const STORAGE_KEY = 'continuo.settings.values';

// 边界(E142/E241):单个 text/string 设置值长度上限。setValue 写入前截断 —— 否则用户在 text setting
// 粘贴超大文本会进 zustand+localStorage,整份 settings 记录超 readRecord 1MiB raw cap 后下次启动
// 被当空表丢弃(所有设置丢失)。64KiB 远超任何真实设置文本,只挡滥用/误操作。常量收口到
// SettingItemRegistry(coerceSettingValue 家),读端(getSettingValue/useSettingValue 经 coerce)也用同值。
const MAX_SETTING_TEXT_LEN = SI_TEXT_VALUE_MAX;

// 可维护性 M21:localStorage 对象持久化 + 跨窗同步样板复用 local-storage-record helper。
// 边界(E22):value 守卫 + 上限。settings 值只接受原语(string/number/boolean),畸形/篡改的
// localStorage 混入对象/数组会被 getSettingValue 直接返出污染消费者;number 越界由 getSettingValue
// 的 clampSettingNumber(E6)钳制。key 限长 256、条目数封顶,非法项丢弃(回退 spec.default)。
const readStored = (): Record<string, SettingItemValue> =>
  readRecord<SettingItemValue>(STORAGE_KEY, {
    // 边界(E122,E22 延伸):number 须有限(Number.isFinite),拒 Infinity/NaN —— 经 setValue 写入
    // 的非有限值虽在 JSON 落盘时被 stringify 成 null,但其它入口/未来格式不应放行非有限 number。
    valueGuard: (v): v is SettingItemValue =>
      typeof v === 'string' ||
      (typeof v === 'number' && Number.isFinite(v)) ||
      typeof v === 'boolean',
    maxKeyLength: 256,
    maxEntries: 10_000,
  });
const writeStored = (
  values: Record<string, SettingItemValue>,
): WriteRecordResult => writeRecord(STORAGE_KEY, values);

export interface SettingsValueState {
  /** partial overrides(未写过的 key 走 spec.default). */
  values: Record<string, SettingItemValue>;
  setValue: (id: string, value: SettingItemValue) => void;
  /** 删除某 id 的 override(回到 spec.default). */
  reset: (id: string) => void;
  /** 清空所有 overrides. */
  resetAll: () => void;
}

export const useSettingsValuesStore = create<SettingsValueState>((set) => ({
  values: readStored(),
  // race(R6 + R113 修订):单 key RMW 基于 live localStorage 重读而非本窗内存快照,**缓解**但
  // **不能根除**多窗口 lost update。⚠️ R6 原注释声称「localStorage 读写同步、跨窗 OS 串行 →
  // read→merge→write 原子」是**错误**的:Chromium 每个 renderer 进程各自缓存 localStorage 区,
  // 别窗的写经存储服务**异步**广播,本窗 readStored() 可能读不到别窗刚写的值 → 两窗同时基于旧
  // 快照各自 merge 后写回仍会丢对方的 key(无跨进程原子性 / 早期 storage mutex 已废弃)。重读只
  // 缩小窗口不消除。**R113 DEFER**(用户决策 2026-06-25):稳健修法=settings/keybindings 持久化
  // 迁到主进程串行 delta 写(镜像 _enabled.json setEnabledId),工作量大且反转既有持久化层决策,
  // 暂缓;低频(需两窗近乎同时改不同 setting)、非数据关键(设置可重设)。keybindings-store.ts
  // 同型同 DEFER。详见 doc/race-condition-audit.md R113。
  setValue: (id, value) => {
    // 边界(E142,E122/E139 读路径净化的写侧对偶):写入前按 live spec 净化 —— number clamp /
    // select enum(coerceSettingValue),text/string 截断到 MAX_SETTING_TEXT_LEN。防超大 text 撑爆
    // settings localStorage 整份记录(1MiB raw cap 超限丢全表)+ 持久化非法值。spec 未注册原样(graceful)。
    const spec = coApp.settingItems.get(id);
    let v = spec ? coerceSettingValue(spec, value) : value;
    if (typeof v === 'string' && v.length > MAX_SETTING_TEXT_LEN) {
      v = v.slice(0, MAX_SETTING_TEXT_LEN);
    }
    const next = { ...readStored(), [id]: v };
    // 边界(E260,写读 cap 对称):若整份 overrides 序列化超读端 raw cap,拒写且**不提交内存态** ——
    // 否则本会话内存 vs 磁盘发散,下次启动 readRecord 整表返 {} = 所有设置静默丢失。保留上次有效状态。
    if (writeStored(next) === 'too-large') {
      console.warn(
        '[settings] setValue 拒写:overrides 序列化超 localStorage raw cap,保留上次有效状态',
      );
      return;
    }
    set({ values: next });
  },
  reset: (id) => {
    const latest = readStored();
    if (!(id in latest)) {
      // 别窗可能已删该 key;本窗内存若仍有则收敛到 latest。
      set((s) => (id in s.values ? { values: latest } : s));
      return;
    }
    const next = { ...latest };
    delete next[id];
    writeStored(next);
    set({ values: next });
  },
  resetAll: () => {
    writeStored({});
    set(() => ({ values: {} }));
  },
}));

// 跨窗口同步:localStorage 在同源多窗口共享,但 zustand 内存快照只在本窗启动时
// 读一次、之后不随别窗的写而更新。多窗口下窗口 A 改设置 → 写 localStorage + 经
// settings 广播更新 useSettingsStore,但窗口 B 的 values-store 内存仍是旧值 →
// LanguageFromSettings 的 values→store 协调 effect 会拿 B 的陈旧 value 把刚广播来的
// locale 又改回去(跨窗 locale 互斗)。监听 storage 事件(只在别的 document 改了
// localStorage 时 fire),同一 key 就重读,让所有窗口的 values 收敛一致(设置语义上
// 都是 app 级全局,跨窗一致也更符合预期)。
subscribeStorageKey(STORAGE_KEY, () =>
  useSettingsValuesStore.setState({ values: readStored() }),
);

/** 取某 spec 当前值(override ?? default). 非 React 上下文用. */
export function getSettingValue<T extends SettingItemValue>(
  spec: SettingItemSpec,
): T {
  const stored = useSettingsValuesStore.getState().values[spec.id];
  const v = stored ?? spec.default;
  // 边界(E6 number clamp + E139 select enum):读路径按 spec 规整已持久化/篡改值,防越界 number /
  // 非法 select 字符串喂给 xterm fontSize/cursorStyle 等消费者。与 useSettingValue 共用 coerceSettingValue。
  return coerceSettingValue(spec, v) as T;
}

/** React hook:订阅某 setting id 的值,变化时组件重渲. fallback = 该 id 的 spec.default. */
export function useSettingValue<T extends SettingItemValue>(
  id: string,
  fallback: T,
): T {
  return useSettingsValuesStore((s) => {
    const v = (s.values[id] ?? fallback) as T;
    // 边界(E122 number clamp + E139 select enum,E6 读路径对齐):按注册 spec 规整值,与 getSettingValue
    // 共用 coerceSettingValue —— 篡改/旧 localStorage 的越界 number 或非法 select 字符串(如
    // terminal.cursorStyle)绕过净化直接喂给 xterm/CSS/timer 等消费者。spec 未注册(测试/早期)原样返回。
    const spec = coApp.settingItems.get(id);
    if (spec) return coerceSettingValue(spec, v as SettingItemValue) as T;
    return v;
  });
}
