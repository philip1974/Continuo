// 内置 Window 插件(issue #23 Phase 1)。
// 命令面板贡献"新窗口" / "在新窗口打开文件夹",Cmd+Shift+N 直开空 workspace 新窗口。

import { Plugin } from '@/plugins/Plugin';
import { coApi } from '@/lib/co-api';
import { notify } from '@/notifications/notify';

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
          notify.error(r.message, { code: r.code, mirror: false });
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
          notify.error(cr.message, { code: cr.code });
        }
      },
    });
  }
}
