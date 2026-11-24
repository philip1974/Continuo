// 「该 webContents 的当前 renderer 文档已被换掉 / 不在了」的单一判定。renderer 各类就绪握手(agent 授权弹窗、
// co:// 深链监听、关窗 flush 与脏态上报)都只对上报它的那份文档有效,文档换掉后须作废,等新文档重新上报。
// 此前三处各写一套作废规则并已分叉(深链只认 did-navigate、flush / 脏态从不作废)。
import type { WebContents } from 'electron';

/** Chromium net::ERR_ABORTED。 */
const ERR_ABORTED = -3;

export function onRendererDocumentGone(
  wc: Pick<WebContents, 'on'>,
  onGone: () => void,
): void {
  // 主框架非同文档导航**提交**:旧文档(连同它的订阅)没了。只认提交不认开始(did-start-navigation 之后可能
  // 根本不提交,旧文档原样留着、也不会再上报就绪)。
  wc.on('did-navigate', onGone);
  wc.on('render-process-gone', onGone);
  // 主框架加载失败:Chromium 提交的是错误页,不发 did-navigate,但旧文档同样没了。
  // ERR_ABORTED(-3)除外,它不代表文档被换掉(真机实测 Electron 对主框架发 -3 的两种情况):
  // - 文档已提交但仍在加载时又 reload:did-fail-load(-3) → did-navigate → 就绪,换文档由随后的 did-navigate 处理;
  // - 文档提交后主进程调 wc.stop():-3 在就绪**之后**才到,文档原样留着、不会再上报就绪 —— 按换文档处理会让该
  //   窗口的就绪态永久作废。
  wc.on('did-fail-load', (_event, errorCode, _description, _url, isMainFrame) => {
    if (isMainFrame && errorCode !== ERR_ABORTED) onGone();
  });
}
