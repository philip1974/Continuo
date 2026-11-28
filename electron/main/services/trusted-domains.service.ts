// 用户受信域名(VSCode 存在应用级 storage 的 http.linkProtectionTrustedDomains)的内存态与持久化。
// 权威值在 main:外链确认的判定、确认框里「信任 <域名>」的写入都在 main 完成,页面内容无法绕过或伪造;设置页经 IPC 读写。
// 独立小文件(同 window-theme.json):settings.json 是 {version, locale} 严格 schema。
// 数据安全:缺文件 = 空列表;文件损坏 / 超大 / 读失败 → 本次运行按空列表处理(只会多问,不会少问),且不写盘 ——
// 不拿「读不出来」当「空」去覆盖用户原有的列表。
// BDD: src/__tests__/external-link-trusted-domains/
import path from 'node:path';
import { app } from 'electron';
import { z } from 'zod';
import { atomicWriteJson } from '../lib/atomic-write';
import { readFileCappedFd } from '../lib/read-fh-capped';
import { createSerialQueue } from '../../shared/run-serial-per-key';
import {
  DEFAULT_TRUSTED_DOMAINS,
  TRUSTED_DOMAINS_MAX,
  TRUSTED_DOMAIN_MAX_LEN,
  normalizeTrustedDomains,
} from '../../shared/trusted-domains';

export const TRUSTED_DOMAINS_FILE_NAME = 'trusted-domains.json';
const MAX_FILE_BYTES = 256 * 1024;

const FileSchema = z.object({
  version: z.literal(1),
  domains: z.array(z.string().max(TRUSTED_DOMAIN_MAX_LEN)).max(TRUSTED_DOMAINS_MAX),
});

let domains: readonly string[] = [];
let loaded = false;
/** 读盘失败 / 文件损坏:本次运行不写盘(见文件头)。 */
let writeBlocked = false;
const queue = createSerialQueue();
const listeners = new Set<(list: readonly string[]) => void>();

const file = (): string => path.join(app.getPath('userData'), TRUSTED_DOMAINS_FILE_NAME);

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  try {
    const r = await readFileCappedFd(file(), MAX_FILE_BYTES);
    if (r.tooLarge) throw new Error('trusted-domains.json too large');
    domains = normalizeTrustedDomains(FileSchema.parse(JSON.parse(r.text as string)).domains);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      writeBlocked = true;
      console.warn('[trusted-domains] load failed; keeping the file untouched this session', err);
    }
    domains = [];
  }
  loaded = true;
}

/** 用户添加的受信域名(不含默认项)。 */
export function getUserTrustedDomains(): Promise<readonly string[]> {
  return queue.run(async () => {
    await ensureLoaded();
    return domains;
  });
}

/** 判定用的完整列表:默认项 + 用户项。 */
export async function getEffectiveTrustedDomains(): Promise<readonly string[]> {
  return [...DEFAULT_TRUSTED_DOMAINS, ...(await getUserTrustedDomains())];
}

/** 在队列内调用:规整后与当前相同则不写盘;变化后通知订阅方(各窗口设置页刷新)。 */
async function replaceLocked(next: readonly string[]): Promise<readonly string[]> {
  await ensureLoaded();
  const normalized = normalizeTrustedDomains(next);
  if (normalized.length === domains.length && normalized.every((d, i) => d === domains[i])) return domains;
  if (!writeBlocked) await atomicWriteJson(file(), { version: 1, domains: normalized });
  domains = normalized;
  for (const l of listeners) l(domains);
  return domains;
}

/** 整体替换用户列表(设置页编辑)。 */
export function setUserTrustedDomains(next: readonly string[]): Promise<readonly string[]> {
  return queue.run(() => replaceLocked(next));
}

/** 追加一条(确认框「信任 <域名>」);已存在则不变。读与写在同一次排队里完成,并发追加不互相覆盖。 */
export function addUserTrustedDomain(pattern: string): Promise<readonly string[]> {
  return queue.run(async () => {
    await ensureLoaded();
    return domains.includes(pattern) ? domains : replaceLocked([...domains, pattern]);
  });
}

export function onUserTrustedDomainsChanged(cb: (list: readonly string[]) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Test helper。 */
export function _resetTrustedDomainsForTest(): void {
  domains = [];
  loaded = false;
  writeBlocked = false;
  listeners.clear();
  queue.reset();
}
