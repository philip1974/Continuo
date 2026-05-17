// 运行时绘制层心跳 (issue #34):requestAnimationFrame 30s 节流写一条 breadcrumb。
//
// 进程级故障由 main 端 heartbeat 覆盖;本探针覆盖"进程健康但屏静"故障 ——
// rAF 在屏幕不再 paint 时会被 Chromium 暂停 fire,从 breadcrumb 缺漏可直接二分:
//   有 render_frame_heartbeat → OS 侧丢 frame (WindowServer / Metal)
//   无 render_frame_heartbeat → Chromium 自暂停 paint
//
// 窗口最小化 / 切到后台 Space 时 rAF 也会停 — 那是 OS 正常行为,与本故障无关。

import { breadcrumb } from './breadcrumb';

const RAF_HEARTBEAT_INTERVAL_MS = 30_000;

export function startRafHeartbeat(): void {
  let lastBeatMs = performance.now();
  let frameCount = 0;

  const tick = (t: number) => {
    frameCount++;
    if (t - lastBeatMs >= RAF_HEARTBEAT_INTERVAL_MS) {
      breadcrumb({
        event: 'render_frame_heartbeat',
        framesInInterval: frameCount,
        intervalMs: Math.round(t - lastBeatMs),
      });
      lastBeatMs = t;
      frameCount = 0;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
