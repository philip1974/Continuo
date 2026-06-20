// 运行"贡献式 action"(插件 ribbon / 编辑器工具栏 action / 命令面板命令 /
// 资源管理器右键项)回调的统一入口,把同步 throw 和 async reject 都捕获并经
// notify.error 弹给用户。
//
// 背景:这些调用点曾各自 `void fn()` 或只 console.warn —— 插件/命令内部抛错时
// 用户"点了没反应",没有任何可感知反馈(EditorHeader 连 console 都没有)。第十四轮
// P2-AO 只修了 IconSidebar 一处,未传播到其余兄弟调用点。本轮统一收敛到此 helper。
// notify.error 默认 mirror=true → 同时写 console.error,保留原有 console 诊断输出。

import { notify } from '@/notifications/notify';

/**
 * 运行贡献回调,失败时弹 error toast(标签 + 错误信息)。返回值忽略;返回 Promise
 * 时等待其 reject。同步 throw 与 async reject 均覆盖。
 *
 * @param label 出错时展示给用户的动作名(应为已 localize 的 title/label)。
 * @param fn    贡献的回调。
 */
export function runContributedAction(label: string, fn: () => unknown): void {
  const fail = (err: unknown): void =>
    notify.error(
      `${label}: ${err instanceof Error ? err.message : String(err)}`,
    );
  try {
    void Promise.resolve(fn()).catch(fail);
  } catch (err) {
    fail(err);
  }
}
