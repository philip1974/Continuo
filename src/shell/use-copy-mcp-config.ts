// 「复制 MCP 配置」动作(状态栏按钮与 Debug 面板空态共用):取 stdio 配置的 `claude mcp add` 命令写入剪贴板,
// 按结果短暂显示「已复制 / 复制失败 / MCP 不可用」,1500ms 后回到「复制 MCP 配置」。
// 调用方渲染按钮文本 `label` + 视觉隐藏 role=status 镜像 `announcement`(A51:焦点在按钮时也播报结果)。

import { useEffect, useRef, useState } from 'react';
import { coApi } from '@/lib/co-api';
import { getCachedClipboard } from '@/plugins/sandbox-sweep';
import { createLatestGuard } from '@/lib/latest-wins';
import { useT } from '@/i18n';

export type CopyMcpConfigState = 'idle' | 'ok' | 'unavailable' | 'fail';

async function copyMcpConfig(): Promise<Exclude<CopyMcpConfigState, 'idle'>> {
  // a11y(A115,A50 同族):整体 try/catch —— getStdioConfig() IPC reject 时若不捕获,
  // copy() 会 reject,而点击处 void copy() 丢弃异常 → 无失败文本/无 live 播报。
  // 任何 reject 都归 'fail',复用既有失败按钮文案 + role=status live region(A51)。
  try {
    const r = await coApi.mcp.getStdioConfig();
    if (!r.ok) return 'fail';
    if (!r.data.claudeAddCommand) return 'unavailable';
    // PROD 下 sandboxSweep 已涂掉 navigator.clipboard,必须走 cached raw ref
    await getCachedClipboard().writeText(r.data.claudeAddCommand);
    return 'ok';
  } catch {
    return 'fail';
  }
}

export interface CopyMcpConfig {
  readonly state: CopyMcpConfigState;
  /** 按钮可见文本(随结果短暂变化)。 */
  readonly label: string;
  /** live region 文本(仅非 idle 时有值)。 */
  readonly announcement: string;
  readonly copy: () => Promise<void>;
}

export function useCopyMcpConfig(): CopyMcpConfig {
  const t = useT();
  const [state, setState] = useState<CopyMcpConfigState>('idle');
  // race(R9):复制反馈的清空 timer 须保存 + 递增 token 校验。裸 setTimeout 不清旧 timer:连续
  // 复制时第一轮的 1500ms timeout 会在第二轮反馈刚显示后把状态清回 idle(SR/用户错过真实结果);
  // 慢 copyMcpConfig 先后返回也可能旧结果覆盖新结果。
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [guard] = useState(createLatestGuard);
  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );
  const copy = async (): Promise<void> => {
    const isLatest = guard.begin();
    const r = await copyMcpConfig();
    // 过期请求(其后已有更新的复制发起)→ 不更新状态,由最新请求负责。
    if (!isLatest()) return;
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    setState(r);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      // 仅当仍是本次反馈(无更新复制)才清回 idle —— 旧 timer 不得清掉新反馈。
      if (isLatest()) setState('idle');
    }, 1500);
  };
  const label =
    state === 'ok'
      ? t('statusbar.mcp.copied')
      : state === 'unavailable'
        ? t('statusbar.mcp.unavailable')
        : state === 'fail'
          ? t('statusbar.mcp.copy_failed')
          : t('statusbar.mcp.copy');
  return { state, label, announcement: state !== 'idle' ? label : '', copy };
}
