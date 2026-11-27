// 主/渲染共享的文件条目数据形状。所有权在 main 进程的 list-dir,
// renderer 通过 preload 拿到后透传给 headless-tree dataLoader。
// 详见 doc/08 § 接口契约。

export interface FileEntry {
  /** 绝对路径,作为 headless-tree 的 id */
  readonly path: string;
  /** basename,用于 UI 显示与排序 */
  readonly name: string;
  /** 是否目录 */
  readonly isDirectory: boolean;
  /** 是否符号链接(默认不递归 symlink) */
  readonly isSymlink?: boolean;
  // size / mtime / ctime 是列目录时的快照:Explorer 对仅内容变化(changeOnly)的 dir-changed 不重新
  // listDir,文件被改写后这些值可能已过期。需要最新值请调用 fs stat(插件:app.fs.stat)。
  /** 字节,sort by size 用(列目录时的快照,可能已过期) */
  readonly size?: number;
  /** ms epoch,sort by mtime 用(列目录时的快照,可能已过期) */
  readonly mtime?: number;
  /** ms epoch,sort by ctime 用(列目录时的快照,可能已过期) */
  readonly ctime?: number;
}

/** fs:scan-files 的结果:递归扫描的条目 + 因无法读取而整棵跳过的子目录数(Quick Open 提示用)。 */
export interface FsScanFilesData {
  readonly entries: readonly FileEntry[];
  readonly skippedDirs: number;
}
