// 拖文件夹到 Continuo 窗口(issue #23 衍生 UX)。
//
// VSCode 同款:用户拖文件夹到当前窗口 → 当前窗口换 workspace。文件 drop
// 暂不处理,后续 Phase 接 editor open。
//
// 纯函数版,接注入的 getPath / isDir,便于单测。生产端 getPath 来自
// coApi.window.getPathForFile(webUtils 包装),isDir 来自 coApi.fs.listDir
// 调用成功判定。

export interface DataTransferLike {
  readonly files: ReadonlyArray<File>;
}

/**
 * 从拖入的 dataTransfer.files 中挑出**第一个目录**绝对路径。
 *  - 单个目录 → 返路径
 *  - 文件 + 目录混合 → 取第一个目录
 *  - 全是文件 / 空 → null
 *  - getPath 返空字符串 / isDir 抛错 → 视为非目录跳过
 */
export async function pickDroppedDirectory(
  data: DataTransferLike,
  getPath: (file: File) => string,
  isDir: (path: string) => Promise<boolean>,
): Promise<string | null> {
  if (!data.files || data.files.length === 0) return null;
  for (const file of data.files) {
    const p = getPath(file);
    if (!p) continue;
    let ok = false;
    try {
      ok = await isDir(p);
    } catch {
      ok = false;
    }
    if (ok) return p;
  }
  return null;
}
