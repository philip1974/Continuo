// topic 49 第六 session · P2:窗口关闭立即结算该窗发起的 pending scope 授权请求。
//
// 根因:plugin-fs `request-scope` handler 用 correlator.createRequest 注册 pending 后
// `await promise` 等 renderer 弹窗决策。但 ScopeRequestCorrelator 只有 5min TTL 一条
// 结算路径,没有 cancelBySender。窗口硬关闭/崩溃时,等待的 renderer 随 wc 一起死,host
// 侧的 `await promise` + pending Map 条目要驻留满 5min 才被 sweep。这与 agent-auth 的
// cancelAgentAuthByWindow、hook-bridge broker 的 cancelByWindow 是同一类「窗口关了但
// 等待者还挂着」缺口,唯独 scope-correlator 这条平行通道没跟上。
// 修复:加 cancelBySender(webContentsId),index.ts win.on('closed') 经
// cancelScopeRequestsForWebContents 调用(镜像 cancelAgentAuthByWindow)。

import { afterEach, describe, expect, it } from 'vitest';
import { ScopeRequestCorrelator } from '../../../electron/main/services/scope-request-correlator';
import { ScopeRequestTimeoutError } from '../../../src/plugins/types';

let correlator: ScopeRequestCorrelator | null = null;

afterEach(() => {
  correlator?.dispose();
  correlator = null;
});

describe('topic49 6thS · ScopeRequestCorrelator.cancelBySender', () => {
  it('关窗 → 该 webContents 的 pending 立即 reject(不等 5min TTL)', async () => {
    correlator = new ScopeRequestCorrelator();
    const { requestId, promise } = correlator.createRequest('tok', [], 42);
    // 仍 pending(可被 _peek 查到)
    expect(correlator._peek(requestId)).toBeDefined();

    const n = correlator.cancelBySender(42);
    expect(n).toBe(1);
    await expect(promise).rejects.toBeInstanceOf(ScopeRequestTimeoutError);
    // 条目已从 pending Map 删除,不再驻留
    expect(correlator._peek(requestId)).toBeUndefined();
  });

  it('只取消匹配 webContents 的 pending,其它 wc 不受影响', async () => {
    correlator = new ScopeRequestCorrelator();
    const a = correlator.createRequest('t', [], 7);
    const b = correlator.createRequest('t', [], 9);

    const n = correlator.cancelBySender(7);
    expect(n).toBe(1);
    await expect(a.promise).rejects.toBeInstanceOf(ScopeRequestTimeoutError);

    // 窗口 9 的 pending 仍存活,可被正常 resolve
    expect(correlator._peek(b.requestId)).toBeDefined();
    correlator.resolve(b.requestId, 'grant', 9);
    await expect(b.promise).resolves.toBe('grant');
  });

  it('无匹配 webContents → 返回 0,不抛,已结算的不重复触发', async () => {
    correlator = new ScopeRequestCorrelator();
    const { requestId, promise } = correlator.createRequest('t', [], 5);
    correlator.resolve(requestId, 'deny', 5);
    await expect(promise).resolves.toBe('deny');

    // 已 resolved 的不应被 cancelBySender 再动;无此 wc 的也返回 0
    expect(correlator.cancelBySender(5)).toBe(0);
    expect(correlator.cancelBySender(999)).toBe(0);
  });
});

// 边界(E227):未决 scope 请求数量上限(canAccept 全局 + per-webContents 双闸),防插件 spam 让 pending
// Map / renderer 弹窗队列线性增长。
describe('E227 · ScopeRequestCorrelator.canAccept(pending 数量上限)', () => {
  it('per-webContents:单窗口未决达 64 → canAccept 该窗口 false,其它窗口仍 true', () => {
    correlator = new ScopeRequestCorrelator();
    const c = correlator;
    for (let i = 0; i < 64; i++) c.createRequest('t', [], 7); // 同一 wc 64 个未决
    expect(c.canAccept(7)).toBe(false); // 该窗口到顶
    expect(c.canAccept(8)).toBe(true); // 别的窗口不受影响
  });

  it('global:总未决达 256 → canAccept 任何窗口 false', () => {
    correlator = new ScopeRequestCorrelator();
    const c = correlator;
    // 256 个未决跨多窗口(每窗 <64,只触发全局闸)
    for (let i = 0; i < 256; i++) c.createRequest('t', [], 1000 + i);
    expect(c.canAccept(1)).toBe(false); // 全局到顶
  });

  it('未达上限 → canAccept true(回归)', () => {
    correlator = new ScopeRequestCorrelator();
    expect(correlator.canAccept(1)).toBe(true);
  });
});
