// P2 资源不闭环回归(第八 session R5):app.shell.exec 的 timeoutMs / maxOutputBytes
// 此前无上界 —— schema 只 `z.number().int().positive()`,service 直接 `input ?? DEFAULT`
// 喂给 setTimeout / Buffer 封顶。插件传 timeoutMs:2e9(~23 天,仍 < 2³¹ 不触发 timer
// 截断)可把不退出的子进程 + stdout/stderr Buffer 钉到那个超时,maxOutputBytes 超大值
// 进一步放大单进程内存。
//
// 孪生的流式版 plugin-shell-stream 早已 `Math.min(opts.timeoutMs, MAX_TIMEOUT_MS=30min)`
// 封顶,而一次性 exec 漏了这条 —— 同一「绑定子进程最长存活」安全意图只传播到一个兄弟
// 入口(本仓最高频「防御未传播到所有平行入口」族)。修复:补 MAX_TIMEOUT_MS(30min,与
// 孪生对齐)+ MAX_OUTPUT_BYTES_CAP(100MB)上界 clamp,抽纯 helper 便于测试。
import { describe, it, expect } from 'vitest';
import {
  clampExecTimeoutMs,
  clampExecMaxBytes,
  EXEC_LIMITS_FOR_TEST as L,
} from '../../../electron/main/services/shell.service';

describe('49 第八 session · execShell timeout/bytes 上界 clamp', () => {
  it('超大 timeoutMs(~23 天)被封顶到 MAX_TIMEOUT_MS(30min),不再钉住子进程', () => {
    expect(clampExecTimeoutMs(2_000_000_000)).toBe(L.MAX_TIMEOUT_MS);
    expect(L.MAX_TIMEOUT_MS).toBe(30 * 60_000);
  });

  it('正常范围 timeoutMs 原样透传', () => {
    expect(clampExecTimeoutMs(200)).toBe(200);
    expect(clampExecTimeoutMs(5 * 60_000)).toBe(5 * 60_000);
  });

  it('缺省 timeoutMs → DEFAULT(30s)', () => {
    expect(clampExecTimeoutMs(undefined)).toBe(L.DEFAULT_TIMEOUT_MS);
    expect(L.DEFAULT_TIMEOUT_MS).toBe(30_000);
  });

  it('恰好等于 MAX 的 timeoutMs 不被改', () => {
    expect(clampExecTimeoutMs(L.MAX_TIMEOUT_MS)).toBe(L.MAX_TIMEOUT_MS);
  });

  it('超大 maxOutputBytes 被封顶到 MAX_OUTPUT_BYTES_CAP(100MB)', () => {
    expect(clampExecMaxBytes(10 * 1024 ** 3)).toBe(L.MAX_OUTPUT_BYTES_CAP);
    expect(L.MAX_OUTPUT_BYTES_CAP).toBe(100 * 1024 * 1024);
  });

  it('正常范围 maxOutputBytes 原样透传 + 缺省走 DEFAULT(10MB)', () => {
    expect(clampExecMaxBytes(1024)).toBe(1024);
    expect(clampExecMaxBytes(undefined)).toBe(L.DEFAULT_MAX_OUTPUT_BYTES);
    expect(L.DEFAULT_MAX_OUTPUT_BYTES).toBe(10 * 1024 * 1024);
  });
});
