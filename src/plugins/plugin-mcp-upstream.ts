// PluginMcpUpstream 的生产实装:走 preload 暴露的 pluginMcp IPC API。
//
// 单测里 PluginMcpRegistry 注入 fake upstream 即可,本文件只在 main.tsx 启动时
// 通过 createIpcPluginMcpUpstream() 装到 coApp.mcp。
//
// register 失败(权限 / 重名 / 上行错)IpcResult.ok=false → 抛 Error 含 code,
// 让 PluginMcpRegistry 透传给 plugin。

import type {
  PluginMcpUpstream,
  PluginMcpUpstreamRegisterPayload,
} from './registries/PluginMcpRegistry';
import { coApi } from '@/lib/co-api';
import { codedError } from '../../electron/shared/error-message';

interface PluginMcpPreloadApi {
  registerTool(
    payload: PluginMcpUpstreamRegisterPayload,
  ): Promise<{ ok: true; data: void } | { ok: false; code: string; message: string }>;
  unregisterTool(
    name: string,
  ): Promise<{ ok: true; data: void } | { ok: false; code: string; message: string }>;
}

function getPluginMcpApi(): PluginMcpPreloadApi | undefined {
  try {
    return coApi.pluginMcp;
  } catch {
    return undefined;
  }
}

export function createIpcPluginMcpUpstream(): PluginMcpUpstream {
  return {
    async register(payload) {
      const api = getPluginMcpApi();
      if (!api) {
        throw codedError('PRELOAD_NOT_READY', 'plugin mcp preload API not available');
      }
      const r = await api.registerTool(payload);
      if (!r.ok) {
        throw codedError(r.code, r.message);
      }
    },
    async unregister(name) {
      const api = getPluginMcpApi();
      if (!api) return; // 关闭中或未就绪,静默
      const r = await api.unregisterTool(name);
      if (!r.ok) {
        console.warn(
          `[plugin-mcp-upstream] unregister "${name}" failed`,
          r.code,
          r.message,
        );
      }
    },
  };
}
