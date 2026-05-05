// 插件商店 SettingTab(Phase 1:仅浏览,无安装)。
//
// 启动时拉 index.json,卡片列表展示。verified 徽章、tags、作者链接外站。
// Phase 2 接入 install,Phase 3 加更新检查 + 角标。

import { useEffect, useState } from 'react';
import { Spinner } from '@/design';
import { fetchMarketplaceIndex } from './fetcher';
import type { MarketplaceEntry } from './types';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ok'; entries: readonly MarketplaceEntry[] }
  | { kind: 'error'; message: string };

export function MarketplaceTab() {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const entries = await fetchMarketplaceIndex();
        if (!cancelled) setState({ kind: 'ok', entries });
      } catch (err) {
        if (!cancelled) {
          setState({
            kind: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === 'loading') {
    return (
      <div className="flex h-32 items-center justify-center text-fg-dim">
        <Spinner />
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div className="rounded border border-line bg-panel-soft/40 p-4 text-xs text-red-400">
        ✘ 拉取索引失败:{state.message}
        <div className="mt-1 text-fg-dim">
          检查网络;若 GitHub 暂不可达,稍后再试。
        </div>
      </div>
    );
  }

  if (state.entries.length === 0) {
    return (
      <div className="rounded border border-dashed border-line bg-panel-soft/40 px-3 py-6 text-center text-xs text-fg-dim">
        暂无插件。索引仓库:
        <a
          href="https://github.com/philip1974/continuo-plugins"
          target="_blank"
          rel="noopener noreferrer"
          className="ml-1 text-accent hover:underline"
        >
          philip1974/continuo-plugins
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-[10px] text-fg-dim">
        共 {state.entries.length} 个插件 · 索引 1 小时缓存。
        Phase 2 起可直接安装,当前点 repo 链接外站手动 git URL 安装。
      </p>
      <div className="space-y-2">
        {state.entries.map((entry) => (
          <MarketplaceCard key={entry.id} entry={entry} />
        ))}
      </div>
    </div>
  );
}

function MarketplaceCard({ entry }: { entry: MarketplaceEntry }) {
  return (
    <div className="rounded border border-line bg-panel-soft/40 px-3 py-2">
      <div className="flex items-baseline gap-2">
        <span className="font-medium text-fg">{entry.name}</span>
        {entry.verified && (
          <span
            className="rounded bg-accent/20 px-1.5 py-0.5 text-[10px] text-accent"
            title="官方 review 过"
          >
            ✓ verified
          </span>
        )}
        <code className="text-[10px] text-fg-dim">{entry.id}</code>
      </div>
      {entry.description && (
        <p className="mt-0.5 text-xs text-fg-dim">{entry.description}</p>
      )}
      <div className="mt-1.5 flex items-center justify-between gap-2 text-[10px] text-fg-dim">
        <div className="flex items-center gap-2">
          <span>
            by{' '}
            {entry.authorUrl ? (
              <a
                href={entry.authorUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:underline"
              >
                {entry.author}
              </a>
            ) : (
              entry.author
            )}
          </span>
          {entry.tags && entry.tags.length > 0 && (
            <span className="flex gap-1">
              {entry.tags.map((t) => (
                <span
                  key={t}
                  className="rounded bg-panel px-1.5 py-0.5 text-fg-muted"
                >
                  {t}
                </span>
              ))}
            </span>
          )}
        </div>
        <a
          href={`https://github.com/${entry.repo}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent hover:underline"
        >
          {entry.repo} ↗
        </a>
      </div>
    </div>
  );
}
