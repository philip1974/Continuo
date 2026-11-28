// 插件运行时错误写进它的输出通道(BDD: src/__tests__/plugin-output-channel/)。
//
// 插件与宿主同在 renderer:插件定时器 / 事件回调里抛出的未捕获错误、未处理的 Promise 拒绝只到 DevTools。入口带稳定
// sourceURL(continuo-plugin://<id>/…,见 plugin-source-url),据错误堆栈最靠栈顶的插件帧归属到该插件,写进其默认通道
//(VSCode 把扩展的未捕获错误记进扩展宿主日志;这里按插件分通道)。插件 console.* 不镜像:插件跑在 renderer,console
// 本就直达 DevTools(VSCode 扩展宿主同样把 console 转发到开发者工具控制台,而不是扩展自己的输出通道)。

import { t } from '@/i18n';
import { errorMessage } from '../../../electron/shared/error-message';
import { getUserPluginManager } from '../PluginManager';
import { pluginIdFromStack } from '../plugin-source-url';
import { appendPluginHostLog } from './output-channels';

const STACK_MAX = 8 * 1024;

function stackOf(err: unknown): string | undefined {
  const stack = (err as { stack?: unknown } | null | undefined)?.stack;
  return typeof stack === 'string' ? stack.slice(0, STACK_MAX) : undefined;
}

/** 已登记插件的显示名;不是本窗口登记的插件 → undefined(不记)。 */
function pluginName(id: string): string | undefined {
  return getUserPluginManager()
    ?.listAll()
    .find((p) => p.id === id)?.manifest.name;
}

/**
 * 堆栈里有插件帧 → 把这条错误写进该插件的输出通道,返回插件 id;否则 null。
 * kind:uncaught(未捕获错误 / 未处理拒绝)或 command(贡献回调失败,label 为动作名)。
 */
export function logPluginErrorFromStack(err: unknown, kind: 'uncaught' | 'command', label?: string): string | null {
  const stack = stackOf(err);
  const id = pluginIdFromStack(stack);
  if (id === null) return null;
  const name = pluginName(id);
  if (name === undefined) return null;
  const message = errorMessage(err);
  appendPluginHostLog(
    id,
    name,
    'error',
    kind === 'command'
      ? t('plugin_output.command_failed', { label: label ?? '', message })
      : t('plugin_output.uncaught', { message }),
    stack,
  );
  return id;
}

/** 主窗接线:监听 window 的 error / unhandledrejection(只记录,不拦截默认行为 —— DevTools 照常显示)。返回卸载函数。 */
export function installPluginErrorCapture(target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window): () => void {
  const onError = (e: ErrorEvent) => {
    logPluginErrorFromStack(e.error, 'uncaught');
  };
  const onRejection = (e: PromiseRejectionEvent) => {
    logPluginErrorFromStack(e.reason, 'uncaught');
  };
  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onRejection);
  return () => {
    target.removeEventListener('error', onError);
    target.removeEventListener('unhandledrejection', onRejection);
  };
}
