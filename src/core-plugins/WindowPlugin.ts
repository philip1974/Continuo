// 内置 Window 插件(issue #23 Phase 1)。
// 命令面板贡献"新窗口" / "在新窗口打开文件夹",Cmd+Shift+N 直开空 workspace 新窗口。

import { Plugin } from '@/plugins/Plugin';
import { coApi } from '@/lib/co-api';
import { notify } from '@/notifications/notify';
import { localizeErrorByCode } from '@/lib/localize-error';
import {
  trySelectDirectoryLock,
  releaseSelectDirectoryLock,
} from '@/lib/select-directory-single-flight';

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
          notify.error(localizeErrorByCode(r.code, r.message), {
            code: r.code,
            mirror: false,
          });
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
            console.warn('[window.openFolderInNew] selectDirectory failed', dr);
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
            notify.error(localizeErrorByCode(cr.code, cr.message), {
              code: cr.code,
            });
          }
        } finally {
          releaseSelectDirectoryLock();
        }
      },
    });
  }
}
