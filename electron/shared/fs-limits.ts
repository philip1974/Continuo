// 文件系统写入/路径大小上限,main + renderer 单一来源(E13/E29/E44)。
//
// 纯常量(无 node/electron 依赖),renderer 与 main 都可 import:
//  - main:fs.ipc.ts writeFile/writeBinary schema(E13)、plugin-fs.service write-file(E29)。
//  - renderer:scoped-app.ts app.fs.writeFile() 在发 IPC 前预检 content/path(E44),挡畸形插件
//    传超大字符串时 renderer/preload IPC structured-clone 先序列化、主进程 schema 才拒绝的前置放大。

export const MAX_WRITE_BYTES = 64 * 1024 * 1024; // 64 MiB:fs 写入内容上限
export const FS_PATH_MAX = 8192; // 路径字符串上限(与 fs.ipc fsPath / plugin-fs scope path 一致)

// 边界(E63 / E314 renderer 对偶):git blob sha 是插件直传 IPC 入 git cat-file argv。固定 hex 形态 +
// 长度上限(4-64 hex,git 缩写到完整 SHA-1/SHA-256),挡超长 sha 触发 spawn E2BIG / argv 放大。
// main(plugin-fs readGitBlob)+ renderer(scoped-app readGitBlob 发 IPC 前预检)单一来源。
export const GIT_BLOB_SHA_RE = /^[0-9a-fA-F]{4,64}$/;
/** sha 是否合法 git blob 形态(有效性谓词:非 string → false → 无效 → 调用方拒). */
export function isValidGitBlobSha(sha: unknown): boolean {
  if (typeof sha !== 'string' || sha.length < 4 || sha.length > 64) {
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
 * {path: 非空 string ≤ FS_PATH_MAX, mode: 'r'|'rw'})。合法返 null,否则返错误消息(由调用方按各自
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
  }
  return null;
}
