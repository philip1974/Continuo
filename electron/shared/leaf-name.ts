// 单段 leaf 文件名校验(跨进程 + 跨 plugin-fs/Explorer 单一来源)。
//
// 边界(E268/E274):leaf 名拼进 FS 路径前须校验。E268 初版只拒空/`.`/`..`/分隔符/控制字符/超长,
// E274 收口到与 plugin-fs 写路径的 validateLeaf(path-resolve.helper.ts)**同一最强规则集**:补 Windows
// 危险名(`:`/ADS、CON/NUL 等保留设备名、尾随点/空格、NTFS 8.3 短名 `~[0-9]`、任意 `~`)与 NFC 归一化。
//
// 策略(cross-platform-p0):POSIX 上虽合法的名(`CON`/`a:b`/`file.`)在此**统一拒**,保证工作区可移植 ——
// 与 plugin-fs validateLeaf 既有的无条件拒绝策略一致。renderer(Explorer drop/create/rename)与 main
// (assertValidBasename / plugin-fs validateLeaf)共用,消漂移。reason 文案与原 validateLeaf 逐字一致
// (其 ScopeError reason 是既有契约,path-resolve 测试断言)。

// failed 列表/显示截断用的单组件名上限(常见文件系统组件名 255 上限)。注:校验用的长度上限见下方
// MAX_PATH_WIN/POSIX(与原 validateLeaf 一致,严于 255 的拒绝阈值由长度 tier 给出)。
export const FS_NAME_MAX = 255;

const MAX_PATH_WIN = 260; // Windows MAX_PATH
const MAX_PATH_POSIX = 4096;
const WIN_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;
const NTFS_83_ALIAS = /~[0-9]/;

/**
 * 返回 leaf 不合法的原因(null = 合法)。规则顺序与文案与原 plugin-fs validateLeaf 逐字一致(单一来源)。
 * 拒:非 string / 空 / `.`·`..` / 分隔符 / NTFS 8.3 短名 / 含 `~` / 含 `..` / 控制字符(0x00-0x1F) /
 * 超 260(Win)/4096(POSIX) / 含 `:`(Windows ADS) / Windows 保留设备名 / 尾随点或空格 / 非 NFC。
 */
export function leafNameRejectReason(name: unknown): string | null {
  if (typeof name !== 'string') return 'leaf is not a string';
  if (name === '') return 'empty leaf';
  if (name === '.' || name === '..') return `leaf is "${name}"`;
  if (name.includes('/') || name.includes('\\')) {
    return 'leaf contains path separator';
  }
  if (NTFS_83_ALIAS.test(name)) return 'leaf matches NTFS 8.3 short-name pattern';
  if (name.includes('~')) return 'leaf contains ~';
  if (name.includes('..')) return 'leaf contains ..';
  for (let i = 0; i < name.length; i += 1) {
    if (name.charCodeAt(i) <= 0x1f) return 'leaf contains control char';
  }
  if (name.length > MAX_PATH_WIN) {
    return 'leaf exceeds 260 chars (Windows MAX_PATH)';
  }
  if (name.length > MAX_PATH_POSIX) return 'leaf exceeds 4096 chars (POSIX)';
  if (name.includes(':')) return 'leaf contains : (Windows ADS hazard)';
  if (WIN_RESERVED.test(name)) return 'leaf is Windows reserved device name';
  if (name.endsWith('.') || name.endsWith(' ')) {
    return 'leaf has trailing dot or space';
  }
  if (name.normalize('NFC') !== name) return 'leaf is not NFC-normalized';
  return null;
}

/** 单段 leaf 是否合法(可安全拼进路径,跨平台可移植)。 */
export function isValidLeafName(name: unknown): boolean {
  return leafNameRejectReason(name) === null;
}
