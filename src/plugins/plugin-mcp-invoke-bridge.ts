// 反向调用路由 — preload.pluginMcp.onInvoke → registry.invokeLocal → replyInvoke。
//
// renderer 启动时调一次,订阅 main 推过来的 INVOKE,据 name 派发到本 renderer
// 的 PluginMcpRegistry,把结果(或错)封成 InvokeReply 通过 replyInvoke 单向发回 main。

import type { PluginMcpRegistry } from './registries/PluginMcpRegistry';
import type {
  InvokePayload,
  InvokeReply,
} from '../../electron/shared/plugin-mcp-channels';
import {
  InvokePayloadSchema,
  REQUEST_ID_MAX,
  isInvokeResultAdmissible,
  makeInvokeErrorReply,
} from '../../electron/shared/plugin-mcp-schemas';
import { PLUGIN_MCP_ERROR_CODES } from '../../electron/shared/plugin-mcp-channels';
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
  // race(R98):active 守卫。unsub 只停后续 onInvoke 投递,但已进入的 invokeLocal 是异步的;
  // 其 .then/.catch 在 bridge 卸载/HMR/重启/owner 清理之后仍会无条件 replyInvoke → 把过期结果
  // 回写到 main(完成已取消的 pending,或旧 registry 的结果晚到污染新生命周期的同 requestId)。
  // unsub 置 active=false;回写前复查 active,过期结果直接丢弃。
  let active = true;
  const unsub = api.onInvoke((payload) => {
    // 边界(E172,E168/E169/E170/E171 同族 IPC ingress 纵深防御):main→renderer INVOKE payload 此前直接
    // 读 payload.name/input/requestId,畸形(null/缺 requestId·name/缺 input/超长)→ 回调读 null 抛 /
    // invokeLocal(undefined) / replyInvoke 无法关联致 main pending 超时。先 InvokePayloadSchema 校验:
    // 非法但含可用 requestId(string 非空 ≤上限)→ 回 ok:false INVALID_PARAMS 让 main pending 立即收口;
    // 无合法 requestId(无法关联)→ drop + warn。两路都不调 invokeLocal。
    const parsed = InvokePayloadSchema.safeParse(payload);
    if (!parsed.success) {
      const rid = (payload as { requestId?: unknown } | null | undefined)
        ?.requestId;
      if (
        active &&
        typeof rid === 'string' &&
        rid.length > 0 &&
        rid.length <= REQUEST_ID_MAX
      ) {
        api.replyInvoke({
          requestId: rid,
          ok: false,
          code: 'INVALID_PARAMS',
          message: 'invalid invoke payload',
        });
      } else {
        console.warn('[plugin-mcp-invoke] invalid payload, dropped', payload);
      }
      return;
    }
    const valid = parsed.data;
    void registry
      .invokeLocal(valid.name, valid.input)
      .then((result) => {
        if (!active) return;
        // 边界(E262,E19 同族 / 校验太晚):plugin run() 结果直接 replyInvoke 会先经 preload→main
        // structured-clone IPC,再在 main 侧 InvokeReplySchema 校验 10MB/JSON-safe —— 上限发生在 IPC
        // **之后**,恶意/畸形插件超大或非 JSON-safe 结果已放大内存/卡顿(不可 clone 值还触发 IPC 异常)。
        // 发 IPC 前用同一 isInvokeResultAdmissible 预检;不合格 → 不发原 result,改回稳定 ok:false 错误
        //(对应 main pending invoke 立即收口,不传超大 payload)。
        if (!isInvokeResultAdmissible(result)) {
          api.replyInvoke({
            requestId: valid.requestId,
            ok: false,
            code: PLUGIN_MCP_ERROR_CODES.RESULT_TOO_LARGE,
            message:
              'plugin tool result is not JSON-safe or exceeds size limit',
          });
          return;
        }
        api.replyInvoke({
          requestId: valid.requestId,
          ok: true,
          result,
        });
      })
      .catch((err: unknown) => {
        if (!active) return;
        const e = err as { code?: unknown; message?: unknown };
        // 边界(E263,E262 兄弟 / 校验太晚):catch 分支此前把 err.code/err.message **原样** replyInvoke,
        // 而 code≤256/message≤8192 的校验在 main 侧、preload→main IPC 之后才生效 → 插件 run() 抛超长
        // Error.message/code 仍先跨 IPC 放大内存/卡顿。发 IPC 前用 makeInvokeErrorReply 裁剪到 schema 同源
        // 上限(E262 只修了 ok:true result 分支,此为同文件兄弟分支残留)。
        api.replyInvoke(
          makeInvokeErrorReply(
            valid.requestId,
            typeof e.code === 'string' ? e.code : 'UNKNOWN',
            typeof e.message === 'string' ? e.message : 'unknown error',
          ),
        );
      });
  });
  return () => {
    active = false; // race(R98):失效在途 invokeLocal 的迟到回写
    unsub();
  };
}
