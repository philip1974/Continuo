// dockview popout 子窗口的标记。主窗口给 addPopoutGroup 传 popoutUrl 时附 ?popout=1,
// 子窗口的 App.tsx 据此短路 DockShell,留位置给 dockview 的 portal 渲染。
import {
  MAX_STARTUP_QUERY_LEN,
  safeStartupParams,
} from './initial-workspace';

const POPOUT_FLAG = 'popout';

export function isPopoutWindow(): boolean {
  if (typeof window === 'undefined') return false;
  // 边界(E195,E193/E194 兄弟入口):isPopoutWindow 在每次 App 渲染时调用(render-path 无条件解析)。
  // 复用 safeStartupParams 的启动 query 长度闸 —— 畸形超长 location.search 否则每次渲染被完整解析一次,
  // 绕过同一外部输入族(E193 parseInitial* / E194 main.tsx spike)的保护。超长 → null → 非 popout(默认主窗)。
  const params = safeStartupParams(window.location.search);
  return params?.get(POPOUT_FLAG) === '1';
}

export function popoutUrlFor(baseHref: string): string {
  // 边界(E296,A50 反馈契约):popoutUrlFor 在调用点同步构造 addPopoutGroup 参数(HeaderActions:107),
  // 早于 Promise 创建 —— 若此处 new URL(baseHref) 抛(理论上 window.location.href 必合法,防御未来/异常
  // 调用方),同步异常会绕过调用点 .catch(...)→notify.error(A50 弹出失败反馈),成未处理异常。令本函数
  // total(永不抛):baseHref 不可解析 → 原样返回(畸形 URL 会在 addPopoutGroup 异步失败→.catch 统一反馈)。
  let url: URL;
  try {
    url = new URL(baseHref);
  } catch {
    return baseHref;
  }
  // 边界(E195):不把超长 query 携带进 popout 子窗 —— 否则子窗每次渲染(isPopoutWindow 等)又要解析一次。
  // 超 MAX_STARTUP_QUERY_LEN 的 query 必是畸形(合法启动 query 远小于此),清空后再附 popout 标记。
  if (url.search.length > MAX_STARTUP_QUERY_LEN) {
    url.search = '';
  }
  url.searchParams.set(POPOUT_FLAG, '1');
  return url.toString();
}
