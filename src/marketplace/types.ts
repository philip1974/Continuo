// 插件商店类型(Phase 1)。
// 与索引仓库 philip1974/continuo-plugins 的 index.json schema 对齐。
//
// version 不在此处:由各 plugin repo 的 manifest.json 当版本源。
// 索引只指方向,fetcher 取 manifest 拿真实 version。

export interface MarketplaceEntry {
  /** 反 DNS 唯一 id,与 plugin manifest.id 一致. */
  readonly id: string;
  /** 显示名. */
  readonly name: string;
  /** 一句话简介. */
  readonly description?: string;
  /** 作者 handle. */
  readonly author: string;
  /** 作者主页. */
  readonly authorUrl?: string;
  /** GitHub `owner/name` 格式. */
  readonly repo: string;
  /** 默认 'main'. */
  readonly branch?: string;
  /** 自由字符串数组. */
  readonly tags?: readonly string[];
  /** 官方 review 过 → true,缺省 = 社区贡献. */
  readonly verified?: boolean;
}

/** 把 entry.repo 拼成 git clone URL,供 installFromGit 用. */
export function entryToGitUrl(entry: MarketplaceEntry): string {
  return `https://github.com/${entry.repo}.git`;
}

/** 把 entry.repo + branch 拼成 raw manifest URL. */
export function entryToManifestUrl(entry: MarketplaceEntry): string {
  const branch = entry.branch ?? 'main';
  return `https://raw.githubusercontent.com/${entry.repo}/${branch}/manifest.json`;
}
