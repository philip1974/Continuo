// 反向调用路由 — preload.pluginMcp.onInvoke → registry.invokeLocal → replyInvoke。
//
// renderer 启动时调一次,订阅 main 推过来的 INVOKE,据 name 派发到本 renderer
// 的 PluginMcpRegistry,把结果(或错)封成 InvokeReply 通过 replyInvoke 单向发回 main。

import type { PluginMcpRegistry } from './registries/PluginMcpRegistry';
import type {
  InvokePayload,
  InvokeReply,
} from '../../electron/shared/plugin-mcp-channels';
import { coApi } from '@/lib/co-api';

interface PluginMcpPreloadApi {
  onInvoke(cb: (payload: InvokePayload) => void): () => void;
  replyInvoke(reply: InvokeReply): void;
}

export function startPluginMcpInvokeBridge(
  registry: PluginMcpRegistry,
): () => void {
  let api: PluginMcpPreloadApi | undefined;
  try {
    api = coApi.pluginMcp;
  } catch {
    api = undefined;
  }
  if (!api) {
    // 测试 / 未注入 preload 环境 → noop unsub
    return () => {};
  }
  const unsub = api.onInvoke((payload) => {
    void registry
      .invokeLocal(payload.name, payload.input)
      .then((result) => {
        api.replyInvoke({
          requestId: payload.requestId,
          ok: true,
          result,
        });
      })
      .catch((err: unknown) => {
        const e = err as { code?: unknown; message?: unknown };
        api.replyInvoke({
          requestId: payload.requestId,
          ok: false,
          code: typeof e.code === 'string' ? e.code : 'UNKNOWN',
          message:
            typeof e.message === 'string' ? e.message : 'unknown error',
        });
      });
  });
  return unsub;
}
