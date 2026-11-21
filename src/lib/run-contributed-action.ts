// 运行"贡献式 action"(插件 ribbon / 编辑器工具栏 action / 命令面板命令 /
// 资源管理器右键项)回调的统一入口,把同步 throw 和 async reject 都捕获并经
// notify.error 弹给用户。
//
// 背景:这些调用点曾各自 `void fn()` 或只 console.warn —— 插件/命令内部抛错时
// 用户"点了没反应",没有任何可感知反馈(EditorHeader 连 console 都没有)。第十四轮
// P2-AO 只修了 IconSidebar 一处,未传播到其余兄弟调用点。本轮统一收敛到此 helper。
// notify.error 默认 mirror=true → 同时写 console.error,保留原有 console 诊断输出。

import { notify } from '@/notifications/notify';
import { localizeErrorByCode } from '@/lib/localize-error';

/**
 * 运行贡献回调,失败时弹 error toast(标签 + 错误信息)。返回值忽略;返回 Promise
 * 时等待其 reject。同步 throw 与 async reject 均覆盖。
 *
 * @param label 出错时展示给用户的动作名(应为已 localize 的 title/label)。
 * @param fn    贡献的回调。
 */
export function runContributedAction(label: string, fn: () => unknown): void {
  const fail = (err: unknown): void => {
    // i18n(I11,I10 同族 catch 丢 code 变体):贡献回调可能抛带 code 的 Error(如
    // PermissionError code='PERMISSION_DENIED')。只取 err.message 会丢 code 且泄漏 raw
    // 语言。有 code 时按 catalog 本地化(localizeErrorByCode,含占位符守卫),无 code 回退
    // 原 message。注:PERMISSION_DENIED code 被多处复用(PluginManager 权限列表),故不在
    // catalog 收录该 key —— PermissionError 已在源头改英文 message,这里回退即英文。
    const raw = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: unknown }).code;
    const message =
      typeof code === 'string' ? localizeErrorByCode(code, raw) : raw;
    notify.error(`${label}: ${message}`);
  };
  try {
    void Promise.resolve(fn()).catch(fail);
  } catch (err) {
    fail(err);
  }
}
