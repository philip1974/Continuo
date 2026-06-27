import { promises as fs } from 'node:fs';

// 边界(E158/E159/E160 stat-before-read TOCTOU 族单一来源):此前各处「先 fs.stat(path) 判 size、
// 再 fs.readFile(path) 整文件」是两次独立按路径解析 —— 检查与读取之间文件可被替换(路径指向新
// inode)或原地增长,绕过大小上限,主进程仍整文件读入。本 helper 用**单个 fd** open→fstat(同
// inode)→有界读,消除该窗口,且读取量恒有界(不依赖 stat,绝不整超大文件读入)。
//
// 错误策略:open 的错误(ENOENT/EACCES 等)**透传抛出**,由调用方按各自契约处理(ENOENT 通常=
// 「缺文件=首次/空表」;非 ENOENT=「当前态未知,绝不降级覆盖」)。size 超限或有界读探测到越限 →
// 返回 { tooLarge:true, text:null },由调用方决定抛错/跳过/当 corrupt。

export interface CappedFdRead {
  /** 文件内容(≤maxBytes);tooLarge 时为 null。 */
  readonly text: string | null;
  /** 超过 maxBytes(单 fd fstat 或有界读探测到)。 */
  readonly tooLarge: boolean;
  /** 实际读取/探测到的字节数(tooLarge 诊断用)。 */
  readonly size: number;
}

/**
 * TOCTOU 安全的 capped 读:单 fd open → fstat → 至多读 min(size,maxBytes)+1 字节(同一 inode,
 * +1 探测 fstat 后原地增长越限)。open 错误透传;越限返回 tooLarge。
 */
export async function readFileCappedFd(
  filePath: string,
  maxBytes: number,
): Promise<CappedFdRead> {
  const fh = await fs.open(filePath, 'r'); // open 错误(ENOENT/EACCES 等)透传给调用方
  try {
    const st = await fh.stat();
    if (st.size > maxBytes) {
      return { text: null, tooLarge: true, size: st.size };
    }
    const buf = Buffer.allocUnsafe(Math.min(st.size, maxBytes) + 1);
    let total = 0;
    while (total < buf.length) {
      const { bytesRead } = await fh.read(buf, total, buf.length - total, total);
      if (bytesRead === 0) break; // EOF
      total += bytesRead;
    }
    if (total > maxBytes) {
      return { text: null, tooLarge: true, size: total };
    }
    return { text: buf.subarray(0, total).toString('utf-8'), tooLarge: false, size: total };
  } finally {
    await fh.close().catch(() => {});
  }
}
