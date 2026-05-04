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
  /** 字节,sort by size 用 */
  readonly size?: number;
  /** ms epoch,sort by mtime 用 */
  readonly mtime?: number;
  /** ms epoch,sort by ctime 用 */
  readonly ctime?: number;
}
