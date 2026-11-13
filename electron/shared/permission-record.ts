// 权限记录(decision / path scope)单条形态校验的跨进程单一来源。
//
// 此前同一份磁盘 / IPC 契约有三套手写校验 + 一套 zod schema,且已漂移:
//   - decidedAt:main 读盘只要求有限(负数可过);renderer 与 zod 要求有限且非负。
//   - permission:main 要求属于 PERMISSION_KEYS;renderer 与 zod 只要求 string(renderer 还直接 `as PermissionKey`)。
//   - path:request-scope 入口拒空串;读盘 / renderer / zod 放行空串。
// 读端与写端判定不同就会出现「写成功、读回被丢」或「一端认、另一端不认」。统一取最严的一组:
//   decision:permission ∈ PERMISSION_KEYS、granted 为 boolean、decidedAt 有限且非负;
//   scope:path 非空且 ≤ SCOPE_PATH_MAX、mode ∈ {'r','rw'}。
// main 读盘 / 写盘、renderer 读端、IPC zod schema 都以此为准(zod 用同一组常量与枚举表达)。

import { PERMISSION_KEYS } from './permission-keys';
import { PERMISSION_RECORD_LIMITS } from './permission-record-limits';
import type { IpcPathScope, IpcPermissionDecision } from './plugins-channels';

const PERMISSION_KEY_SET: ReadonlySet<string> = new Set(PERMISSION_KEYS);

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}

export function isIpcPermissionDecision(x: unknown): x is IpcPermissionDecision {
  if (!isPlainObject(x)) return false;
  return (
    typeof x['permission'] === 'string' &&
    PERMISSION_KEY_SET.has(x['permission']) &&
    typeof x['granted'] === 'boolean' &&
    typeof x['decidedAt'] === 'number' &&
    Number.isFinite(x['decidedAt']) &&
    x['decidedAt'] >= 0
  );
}

export function isIpcPathScope(x: unknown): x is IpcPathScope {
  if (!isPlainObject(x)) return false;
  const path = x['path'];
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    path.length <= PERMISSION_RECORD_LIMITS.SCOPE_PATH_MAX &&
    (x['mode'] === 'r' || x['mode'] === 'rw')
  );
}
