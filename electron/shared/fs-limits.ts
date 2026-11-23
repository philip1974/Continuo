// 文件系统写入/路径大小上限,main + renderer 单一来源(E13/E29/E44)。
//
// 纯常量(无 node/electron 依赖),renderer 与 main 都可 import:
//  - main:fs.ipc.ts writeFile/writeBinary schema(E13)、plugin-fs.service write-file(E29)。
//  - renderer:scoped-app.ts app.fs.writeFile() 在发 IPC 前预检 content/path(E44),挡畸形插件
//    传超大字符串时 renderer/preload IPC structured-clone 先序列化、主进程 schema 才拒绝的前置放大。

export const MAX_WRITE_BYTES = 64 * 1024 * 1024; // 64 MiB:fs 写入内容上限
export const FS_PATH_MAX = 8192; // 路径字符串上限(与 fs.ipc fsPath / plugin-fs scope path 一致)
/** fs:list-dir 单次遍历的条目硬上限(main list-dir 早停;IPC schema 的 maxFiles 上界对齐到它,E275)。 */
export const LIST_DIR_TOTAL_ENTRIES_MAX = 100_000;

// 安全:路径**层级数**上限。长度上限(8192)挡不住「很短的段 × 很多级」:`/a/a/a/…` 可以有 4000 多级,而主进程里
// 凡是「按层级逐级处理」的代码(逐级 stat 取文件身份、逐级找最近的已存在上级、逐级拼前缀)对它都是线性甚至二次方
// 的开销 —— 实测一次 requestScope 传 64 条这样的路径,主进程事件循环卡死 10s、RSS +2.8GB。真实路径到不了这个深度
//(macOS PATH_MAX 1024、Linux 4096;嵌套很深的 node_modules 也就几十级),超出即按畸形输入拒绝。
/** plugin-fs 各操作的 target 路径层级上限。 */
export const FS_PATH_MAX_DEPTH = 256;
/** request-scope 的 scope 路径层级上限(授权的是目录,更浅;同时限定「scope 数 × 层级」的扇出)。 */
export const MAX_SCOPE_PATH_DEPTH = 64;

/** 路径的非空段数是否超过 max(`/` 与 `\` 都算分隔符;O(长度),超过即返回,不分配)。 */
export function pathDepthExceeds(path: string, max: number): boolean {
  let depth = 0;
  let inSegment = false;
  for (let i = 0; i < path.length; i += 1) {
    const code = path.charCodeAt(i);
    if (code === 47 || code === 92) {
      inSegment = false;
    } else if (!inSegment) {
      inSegment = true;
      depth += 1;
      if (depth > max) return true;
    }
  }
  return false;
}

// 边界(E63 / E314 renderer 对偶):git blob sha 是插件直传 IPC 入 git cat-file argv。固定 hex 形态 +
// 长度(完整 SHA-1 = 40 / SHA-256 = 64 位 hex),挡超长 sha 触发 spawn E2BIG / argv 放大。不接受缩写:
// git 对唯一前缀直接返回内容,4 位起即可枚举对象库。
// main(plugin-fs readGitBlob)+ renderer(scoped-app readGitBlob 发 IPC 前预检)单一来源。
/** sha 是否合法 git blob 形态(有效性谓词:非 string → false → 无效 → 调用方拒). */
export function isValidGitBlobSha(sha: unknown): boolean {
  if (typeof sha !== 'string' || (sha.length !== 40 && sha.length !== 64)) {
    return false;
  }
  for (let i = 0; i < sha.length; i += 1) {
    const code = sha.charCodeAt(i);
    const isHex =
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 70) ||
      (code >= 97 && code <= 102);
    if (!isHex) {
      return false;
    }
  }
  return true;
}

// 边界(E239,E44/E180 pre-IPC 预检族):request-scope 的 scopes 数组上限 + 形态校验,main + renderer
// 单一来源。主进程 plugin-fs.service request-scope 入口校验(数量/path/mode),但 renderer scoped-app
// 的 app.fs.requestScope() 此前直接把插件传入的 scopes 发 IPC —— 畸形插件传超大数组/超长路径时,
// renderer→preload→main 的 structured clone 已先序列化大对象(IPC 放大),主进程 schema 才拒绝。把校验
// 收口为共享 helper,scoped-app 发 IPC 前先调,超量不进 IPC;主进程仍调同一 helper 作权威兜底。
export const MAX_SCOPE_REQUEST_COUNT = 64; // 单次 request-scope 的 scopes 数量上限
// scope path 长度复用 FS_PATH_MAX(8192,二者本就对齐)。

/**
 * 校验 request-scope 的 scopes 数组形态(数组 + 数量 ≤ MAX_SCOPE_REQUEST_COUNT + 每项
 * {path: 非空 string ≤ FS_PATH_MAX 且层级 ≤ MAX_SCOPE_PATH_DEPTH, mode: 'r'|'rw'})。合法返 null,否则返错误消息(由调用方按各自
 * 错误类型抛出:main 用 fsError,renderer 用 Error+code)。
 */
export function validateScopesShape(scopes: unknown): string | null {
  if (!Array.isArray(scopes) || scopes.length > MAX_SCOPE_REQUEST_COUNT) {
    return `invalid scopes: not an array or count > ${MAX_SCOPE_REQUEST_COUNT}`;
  }
  for (const s of scopes as readonly unknown[]) {
    const sc = s as { path?: unknown; mode?: unknown };
    if (
      s === null ||
      typeof s !== 'object' ||
      typeof sc.path !== 'string' ||
      sc.path.length === 0 ||
      sc.path.length > FS_PATH_MAX ||
      (sc.mode !== 'r' && sc.mode !== 'rw')
    ) {
      return `invalid scope entry: path must be non-empty ≤${FS_PATH_MAX} chars, mode ∈ {r,rw}`;
    }
    if (pathDepthExceeds(sc.path, MAX_SCOPE_PATH_DEPTH)) {
      return `invalid scope entry: path must be at most ${MAX_SCOPE_PATH_DEPTH} levels deep`;
    }
  }
  return null;
}

/**
 * fs:list-dir 未传 exclude 时的默认排除项。跨进程单一来源:main list-dir 用它建默认 Set;renderer
 * Quick Open 的 walk-files 因 exclude 是**整体替换**语义(传了就不用默认),必须把这份完整带上再追加
 * 构建产物 —— 此前 walk-files 手抄了一份,main 侧加一项而那边不同步就会多扫。
 */
export const LIST_DIR_DEFAULT_EXCLUDE: readonly string[] = [
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  '.DS_Store',
  'Thumbs.db',
];
