// 内置 Window 插件(issue #23 Phase 1)。
// 命令面板贡献"新窗口" / "在新窗口打开文件夹",Cmd+Shift+N 直开空 workspace 新窗口;另注册窗口 / dock 类命令与
// 首选项:颜色主题 / 切换浅深(src/plugins/theme-picker/)。

import { Plugin } from '@/plugins/Plugin';
import { coApi } from '@/lib/co-api';
import {
  trySelectDirectoryLock,
  releaseSelectDirectoryLock,
} from '@/lib/select-directory-single-flight';
import { notifyFailure } from '@/notifications/notify-thrown-error';
import { focusPartCommandSpecs } from '@/shell/focus-parts';
import { windowCommandSpecs } from '@/shell/window-commands';
import { switchWindowCommandSpec } from '@/plugins/switch-window/switch-window-command';
import { dockCommandSpecs } from '@/shell/dock/dock-panel-actions';
import { themeCommandSpecs } from '@/plugins/theme-picker/theme-commands';
import { manageWorkspaceTrustCommandSpec } from '@/shell/workspace-trust/WorkspaceTrust';
import { workbenchLayoutCommandSpecs } from '@/shell/workbench-layout';
import { screencastCommandSpec } from '@/shell/screencast/screencast-store';

export default class WindowPlugin extends Plugin {
  onload(): void {
    // 空 workspace 新窗口(用户进 app 后再选 folder)
    this.addCommand({
      id: 'window.new',
      title: 'New Window',
      titleKey: 'commands.window.new.title',
      category: 'Window',
      categoryKey: 'commands.window.category',
      hotkey: 'mod+shift+n',
      fn: async () => {
        const r = await coApi.window.create({});
        if (!r.ok) {
          console.warn('[window.new] create failed', r.code, r.message);
          // i18n(I9,I6-I8 同族):window.create 返回 WORKSPACE_*/NO_WINDOW_SEQ 等有三语言
          // catalog 的 code,按 code 本地化(zh/ko 不看英文 raw)。WORKSPACE_* 带占位符,
          // helper 的占位符守卫会自动回退 raw message。
          notifyFailure(r, { mirror: false });
        }
      },
    });

    // 选 folder → 在新窗口打开
    this.addCommand({
      id: 'window.openFolderInNew',
      title: 'Open Folder in New Window…',
      titleKey: 'commands.window.open_folder.title',
      category: 'Window',
      categoryKey: 'commands.window.category',
      fn: async () => {
        // race(R106,R8 同族):同步单飞闸门防同 tick 重复触发并发弹原生选择器(与 EmptyWorkspace /
        // ExplorerHeader 共享全局锁 → 全 app 同时只一个目录选择器)。
        if (!trySelectDirectoryLock()) return;
        try {
          const dr = await coApi.fs.selectDirectory();
          if (!dr.ok) {
            // 与 Explorer「打开文件夹」(useSelectWorkspaceFolder)一致:失败给可见 toast,不只 console;
            // 用户取消是 ok:true + data=null(下方静默分支)。
            console.warn('[window.openFolderInNew] selectDirectory failed', dr);
            notifyFailure(dr, { mirror: false });
            return;
          }
          if (dr.data === null) return; // 用户取消
          const cr = await coApi.window.create({ workspace: dr.data });
          if (!cr.ok) {
            console.warn(
              '[window.openFolderInNew] window.create failed',
              cr.code,
              cr.message,
            );
            notifyFailure(cr, { mirror: false });
          }
        } finally {
          releaseSelectDirectoryLock();
        }
      },
    });

    // F6 / ⇧F6:在 dock 组 / 状态栏 / 侧栏间移动焦点(VSCode focusNextPart / focusPreviousPart)
    for (const spec of focusPartCommandSpecs()) this.addCommand(spec);
    // 转到文件… / 关闭窗口 / 重新加载窗口 / 缩放 / 全屏 / 显示输出·调试 / 移到新窗口(应用菜单与 dock 标题栏的同一动作;
    // BDD: src/__tests__/command-discoverability/)
    for (const spec of windowCommandSpecs()) this.addCommand(spec);
    // 切换窗口(mac ⌃W;BDD: src/__tests__/switch-window/)
    this.addCommand(switchWindowCommandSpec());
    for (const spec of dockCommandSpecs()) this.addCommand(spec);
    // 首选项:颜色主题 / 在浅色和深色主题之间切换(BDD: src/__tests__/theme-commands/)
    for (const spec of themeCommandSpecs()) this.addCommand(spec);
    // 工作区: 管理工作区信任(VSCode workbench.trust.manage;BDD: src/__tests__/workspace-trust/)
    this.addCommand(manageWorkspaceTrustCommandSpec());
    // 查看: 切换状态栏 / 活动栏、显示 / 隐藏编辑器标签、切换最大化编辑器组(BDD: src/__tests__/workbench-layout-visibility/)
    for (const spec of workbenchLayoutCommandSpecs()) this.addCommand(spec);
    // 开发人员: 切换屏幕录制模式(BDD: src/__tests__/screencast-mode/)
    this.addCommand(screencastCommandSpec());
  }
}
