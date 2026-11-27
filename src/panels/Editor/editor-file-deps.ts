// 编辑器文件操作(openFileByPath / saveFile)的默认依赖:绑定到 coApi.fs(惰性取用,模块求值时不访问 coApi)。
// useEditorFile(Explorer / EditorPanel / DockShell)、插件 SDK editor.openFile(co-app)与 Quick Open 共用 ——
// 此前三处各拼一份且形状不一(Quick Open 只给 readFile / writeFile,漏了 stat;将来若在该路径保存会失去 stat 快路径)。
import { coApi } from '@/lib/co-api';
import type { EditorFileDeps } from './editor-file-actions';
import { readEditorFile } from './editor-image';

export const editorFileDeps: EditorFileDeps = {
  fs: {
    // 图片按 stat 指纹建 / 刷新只读 tab(见 editor-image)
    readFile: (p, o) => readEditorFile(coApi.fs, p, o),
    writeFile: (p, c, o) => (o ? coApi.fs.writeFile(p, c, o) : coApi.fs.writeFile(p, c)),
    stat: (p) => coApi.fs.stat(p),
  },
};
