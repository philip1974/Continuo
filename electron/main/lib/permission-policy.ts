// 安全:Chromium 权限请求/检查默认拒绝。
//
// Electron 未设 setPermissionRequestHandler / setPermissionCheckHandler 时**放行所有**权限请求。
// 攻击:renderer 内任意 JS(与 LM 同 realm 的插件、或未来 XSS / 被导航进来的不受信页面)可直接
// getUserMedia(摄像头/麦克风)、geolocation、Notification、clipboard-read 等,绕过插件权限模型
// (src/plugins/permissions.ts + sandbox-sweep.ts)。
//
// 策略:白名单只放行应用自身**真实用到**的权限,且请求来源必须是受信 renderer 入口
// (复用 safe-handle 的 defaultIsTrustedFrame:prod 只认真实 index.html 的 file URL,dev 认
// ELECTRON_RENDERER_URL 同源)。其余一律拒。
//   - clipboard-sanitized-write:navigator.clipboard.writeText(Explorer 复制路径、StatusBar
//     复制命令、Milkdown 代码块/链接复制按钮、插件 app.clipboard.writeText)
//   - clipboard-read:navigator.clipboard.readText(插件 app.clipboard.readText,受插件权限门)
// 原生菜单全屏 / 系统 Notification(主进程)/ xterm 粘贴(paste 事件)不走 Chromium 权限,不受影响。
import type { Session } from 'electron';
import { defaultIsTrustedFrame } from '../safe-handle';

export const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set([
  'clipboard-read',
  'clipboard-sanitized-write',
]);

/**
 * 纯判定:permission 在白名单内且 requestingUrl 是受信 renderer 入口 → true;否则 false。
 * requestingUrl 缺失(跨源子 frame 的 check 不提供)→ fail-closed 拒。
 */
export function isPermissionAllowed(
  permission: string,
  requestingUrl: string | undefined,
): boolean {
  if (!ALLOWED_PERMISSIONS.has(permission)) return false;
  if (typeof requestingUrl !== 'string' || requestingUrl === '') return false;
  return defaultIsTrustedFrame({ url: requestingUrl });
}

type PermissionSession = Pick<
  Session,
  'setPermissionRequestHandler' | 'setPermissionCheckHandler' | 'setDevicePermissionHandler'
>;

/** app ready 后对 session(defaultSession)注册 request / check / device 三个处理器。 */
export function installPermissionHandlers(ses: PermissionSession): void {
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(isPermissionAllowed(permission, details?.requestingUrl));
  });
  ses.setPermissionCheckHandler((_wc, permission, _origin, details) =>
    isPermissionAllowed(permission, details?.requestingUrl),
  );
  // HID / Serial / USB 设备:应用不使用,一律拒。
  ses.setDevicePermissionHandler(() => false);
}
