// topic 45 ADR-Plugin-5 Phase 0 spike: thin-entry router.
// spike 命中时只 import spike orchestrator; 否则 import main-app.
// 严格 m.init() 调用 (不用 m.init?.()), spec strict-init 强契约 (plan-v4 P1.2)。
const isSpike =
  typeof location !== 'undefined' &&
  new URLSearchParams(location.search).get('spike') === 'plugin-isolation';

if (isSpike) {
  void import('./spikes/plugin-isolation').then((m) => m.run());
} else {
  void import('./main-app').then((m) => m.init());
}

