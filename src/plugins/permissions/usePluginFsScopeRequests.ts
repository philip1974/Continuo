import { coApi } from '@/lib/co-api';
import { notify } from '@/notifications/notify';
import { t as translate } from '@/i18n';
import type { PathScope } from '../types';
import { isValidPluginId } from '../plugin-id';
import { FS_PATH_MAX, MAX_SCOPE_REQUEST_COUNT } from '../../../electron/shared/fs-limits';
import { usePermissionPromptStore, type FsScopePromptScope } from './promptStore';
import { SCOPE_REQUEST_ID_MAX } from '../../../electron/shared/plugin-fs-channels';

/** main 推来的 scope:displayPath 是归一化后的路径(`~` 已展开),旧形态可能不带。 */
interface RequestedScope extends PathScope {
  readonly displayPath?: string;
}

interface ScopeRequestPayload {
  readonly requestId: string;
  readonly pluginId: string;
  readonly scopes: readonly RequestedScope[];
}

// 边界(E169,E168 同族 IPC ingress 纵深防御):plugin-fs:scope-request 驱动 fs 授权弹窗(安全敏感)。
// 此前 bridge 直接 `payload.scopes.map(...)` 信任 TS 类型,畸形 payload(null/scopes 非数组/scope 非
// 对象/超长 path/非法 mode/超长 requestId/非法 pluginId)会让回调抛错(scopes.map / scope.path)或
// 把脏授权请求写入 prompt store。注册入口 runtime 守卫,非法 drop + warn,不进 prompt store。
const EMPTY_FS_SCOPE_PROMPT_SCOPES: FsScopePromptScope[] = [];

function isScopeRequestPayload(v: unknown): v is ScopeRequestPayload {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (
    typeof o.requestId !== 'string' ||
    o.requestId.length === 0 ||
    o.requestId.length > SCOPE_REQUEST_ID_MAX
  ) {
    return false;
  }
  if (typeof o.pluginId !== 'string' || !isValidPluginId(o.pluginId)) {
    return false;
  }
  if (!Array.isArray(o.scopes) || o.scopes.length > MAX_SCOPE_REQUEST_COUNT) {
    return false;
  }
  for (const s of o.scopes) {
    if (s === null || typeof s !== 'object') return false;
    const sc = s as Record<string, unknown>;
    if (
      typeof sc.path !== 'string' ||
      sc.path.length === 0 ||
      sc.path.length > FS_PATH_MAX
    ) {
      return false;
    }
    if (sc.mode !== 'r' && sc.mode !== 'rw') return false;
    if (
      sc.displayPath !== undefined &&
      (typeof sc.displayPath !== 'string' ||
        sc.displayPath.length === 0 ||
        sc.displayPath.length > FS_PATH_MAX)
    ) {
      return false;
    }
  }
  return true;
}

export function buildFsScopePromptScopes(
  scopes: readonly RequestedScope[],
): FsScopePromptScope[] {
  if (scopes.length === 0) return EMPTY_FS_SCOPE_PROMPT_SCOPES;
  const out = new Array<FsScopePromptScope>(scopes.length);
  for (let i = 0; i < scopes.length; i++) {
    const scope = scopes[i]!;
    out[i] = {
      path: scope.path,
      mode: scope.mode,
      // 展示路径由 main 归一化后给出(sandbox renderer 展开不了 `~`);旧形态回退原始 path。
      displayPath: scope.displayPath ?? scope.path,
    };
  }
  return out;
}

export function startPluginFsScopeRequestBridge(): () => void {
  // race(R99,R98 同型):active 守卫。unsub 只移除后续 onScopeRequest 监听,但已进入的
  // requestFsScope(...).then(_scopeDecision) 是异步的;bridge 卸载/HMR/重启后旧生命周期的授权/
  // 拒绝仍会晚到 main —— 完成已取消/已过期的 scope pending,或在新 bridge 已启动后产生过期授权
  // 回写。unsub 置 active=false;_scopeDecision(及失败 toast)前复查,过期结果直接丢弃。
  let active = true;
  const unsub = coApi.pluginFsRaw.onScopeRequest(
    (payload: ScopeRequestPayload) => {
      // 边界(E169):IPC ingress runtime 守卫,畸形 payload drop + warn,不进 prompt store/不抛。
      if (!isScopeRequestPayload(payload)) {
        console.warn(
          '[plugin-fs-scope] invalid scope-request payload, dropped',
          payload,
        );
        return;
      }
      const scopes = buildFsScopePromptScopes(payload.scopes);
      void usePermissionPromptStore
        .getState()
        .requestFsScope({
          requestId: payload.requestId,
          pluginId: payload.pluginId,
          scopes,
        })
        .then((decision) => {
          if (!active) return; // race(R99):bridge 已卸载 → 不回传过期决定
          // 必须 return:让 _scopeDecision 的 reject 沿链传到下方 .catch(A126 反馈)。
          return coApi.pluginFsRaw._scopeDecision(payload.requestId, decision);
        })
        // a11y(A126,A58 同族):决定回传链(requestFsScope/_scopeDecision)reject 时若不捕获,
        // 用户已点授权/拒绝、弹窗已关,但失败被静默丢弃,main 侧 scope 请求一直 pending/超时,
        // 用户和 SR 都不知决定未生效 → notify.error 主动反馈。
        .catch(() => {
          if (!active) return; // race(R99):已卸载 → 不弹过期 toast
          notify.error(translate('permissions.fs_scope.respond_failed'));
        });
    },
  );
  return () => {
    active = false; // race(R99):失效在途 requestFsScope 的迟到回传
    unsub();
  };
}
