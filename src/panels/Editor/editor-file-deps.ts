// 编辑器文件操作(openFileByPath / saveFile)的默认依赖:绑定到 coApi.fs(惰性取用,模块求值时不访问 coApi)。
// useEditorFile(Explorer / EditorPanel / DockShell)、插件 SDK editor.openFile(co-app)与 Quick Open 共用 ——
// 此前三处各拼一份且形状不一(Quick Open / co-app 漏了 stat,保存时会失去 stat 快路径)。
import { coApi } from '@/lib/co-api';
import type { EditorFileDeps } from './editor-file-actions';

export const editorFileDeps: EditorFileDeps = {
  fs: {
    readFile: (p) => coApi.fs.readFile(p),
    writeFile: (p, c) => coApi.fs.writeFile(p, c),
    stat: (p) => coApi.fs.stat(p),
  },
};
