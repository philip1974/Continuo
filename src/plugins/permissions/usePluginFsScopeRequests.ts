import { coApi } from '@/lib/co-api';
import { notify } from '@/notifications/notify';
import { t as translate } from '@/i18n';
import { isSafePluginId } from '../../../electron/shared/plugin-id';
import { FS_PATH_MAX, validateScopesShape } from '../../../electron/shared/fs-limits';
import { usePermissionPromptStore, type FsScopePromptScope } from './promptStore';
import {
  SCOPE_REQUEST_ID_MAX,
  type ScopeRequestPayload,
  type ScopeRequestScope,
} from '../../../electron/shared/plugin-fs-channels';

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
  if (typeof o.pluginId !== 'string' || !isSafePluginId(o.pluginId)) {
    return false;
  }
  // 数量 + 每项 path/mode 与 main / scoped-app 同一校验(shared 单一来源);这里只额外校验 displayPath。
  if (validateScopesShape(o.scopes) !== null) return false;
  for (const sc of o.scopes as readonly { displayPath?: unknown }[]) {
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
  scopes: readonly ScopeRequestScope[],
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
  // main 侧已收口(超时 / 插件已注销)的请求:main 已无此 pending,撤掉弹窗但不回传决定(回传只会失败并报错)。
  const cancelledByMain = new Set<string>();
  const unsub = coApi.pluginFsRaw.onScopeRequest(
    (payload: unknown) => {
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
          if (cancelledByMain.delete(payload.requestId)) return; // main 已收口 → 无决定可回传
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
  const unsubCancelled = coApi.pluginFsRaw.onScopeRequestCancelled((payload: unknown) => {
    // payload 未经校验(形态应为 ScopeRequestCancelledPayload):逐字段判型,不信任类型。
    const requestId = (payload as { requestId?: unknown } | null)?.requestId;
    if (typeof requestId !== 'string') return;
    const store = usePermissionPromptStore.getState();
    // 只认仍在队列里的请求(未知 id 不留痕)。走 deny 的收口路径撤弹窗 + 推进队列,上面的 .then 据标记不回传。
    if (!Object.hasOwn(store.fsScopePending, requestId)) return;
    cancelledByMain.add(requestId);
    store.denyFsScope(requestId);
  });
  // 弹窗开始显示某个请求时回报 main 一次:main 的无应答超时从此刻起算(排队期间不计,否则排在后面的请求轮到显示时
  // 已所剩无几)。manifest 权限弹窗优先占屏(PermissionPrompt),那时 fs-scope 队首并未显示。
  let lastShown: string | null = null;
  const reportShown = (state: ReturnType<typeof usePermissionPromptStore.getState>): void => {
    const shownId = state.pending ? null : (state.currentFsScope?.requestId ?? null);
    if (shownId === null || shownId === lastShown) return;
    lastShown = shownId;
    // 回报失败(请求已在 main 收口等)无需处理:main 的排队兜底仍会收口该请求。
    coApi.pluginFsRaw._scopeShown(shownId).catch(() => undefined);
  };
  const unsubShown = usePermissionPromptStore.subscribe(reportShown);
  reportShown(usePermissionPromptStore.getState());
  return () => {
    active = false; // race(R99):失效在途 requestFsScope 的迟到回传
    unsub();
    unsubCancelled();
    unsubShown();
  };
}
