// topic 45 ADR-Plugin-5 Phase 0 spike: thin-entry router.
// spike 命中时只 import spike orchestrator; 否则 import main-app.
// 严格 m.init() 调用 (不用 m.init?.()), spec strict-init 强契约 (plan-v4 P1.2)。
// 边界(E194,E193 兄弟入口):spike 判定复用 safeStartupParams —— renderer 最早入口同样对超长
// location.search 加长度闸(否则畸形超长 query 在 thin-entry 被完整解析一次,绕过 parseInitial* 的保护)。
// initial-workspace 是零依赖纯模块,静态 import 不会拉入 main-app/spike chunk(thin-entry 契约不破)。
import { safeStartupParams } from './lib/initial-workspace';

const isSpike =
  typeof location !== 'undefined' &&
  safeStartupParams(location.search)?.get('spike') === 'plugin-isolation';

if (isSpike) {
  void import('./spikes/plugin-isolation').then((m) => m.run());
} else {
  void import('./main-app').then((m) => m.init());
}

export {};
