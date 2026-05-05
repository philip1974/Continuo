// 插件商店 SettingTab(Phase 1+2:浏览 + 安装)。
//
// 启动时拉 index.json,卡片列表展示。verified 徽章、tags、作者链接外站。
// 已装的卡片显 "已安装" disabled;未装显 [安装] primary,点击调
// installFromGit(走 v4.5 已有 IPC)。安装成功 toast 在卡片下方提示。

import { useEffect, useState } from 'react';
import { Button, Spinner } from '@/design';
import { coApi } from '@/lib/co-api';
import { getUserPluginManager } from '@/plugins/co-plugin-manager';
import { entryToGitUrl, type MarketplaceEntry } from './types';
import { fetchMarketplaceIndex } from './fetcher';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ok'; entries: readonly MarketplaceEntry[] }
  | { kind: 'error'; message: string };

interface InstallState {
  /** 正在装的 entry id. */
  busy: string | null;
  /** 安装结果消息(per entry). */
  msgs: ReadonlyMap<string, string>;
}

/** 1s 轮询当前已装 plugin id 集合(同 PluginsTabContent 模式). */
function useInstalledIds(): ReadonlySet<string> {
  const [snap, setSnap] = useState<ReadonlySet<string>>(() => readIds());
  useEffect(() => {
    const t = setInterval(() => setSnap(readIds()), 1000);
    return () => clearInterval(t);
  }, []);
  return snap;
}

function readIds(): ReadonlySet<string> {
  const m = getUserPluginManager();
  if (!m) return new Set();
  return new Set(m.listAll().map((p) => p.id));
}

export function MarketplaceTab() {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const installed = useInstalledIds();
  const [install, setInstall] = useState<InstallState>({
    busy: null,
    msgs: new Map(),
  });

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

  const onInstall = async (entry: MarketplaceEntry) => {
    setInstall((prev) => ({ ...prev, busy: entry.id }));
    let msg: string;
    try {
      const r = await coApi.plugins.installFromGit(entryToGitUrl(entry));
      msg = r.ok
        ? `✔ 已安装 ${r.data.name} v${r.data.version} — 重启 Continuo 后插件加载`
        : `✘ [${r.code}] ${r.message}`;
    } catch (err) {
      msg = `✘ ${err instanceof Error ? err.message : String(err)}`;
    }
    setInstall((prev) => {
      const nextMsgs = new Map(prev.msgs);
      nextMsgs.set(entry.id, msg);
      return { busy: null, msgs: nextMsgs };
    });
  };

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
        安装后需重启 Continuo 才会出现在"插件" tab。
      </p>
      <div className="space-y-2">
        {state.entries.map((entry) => (
          <MarketplaceCard
            key={entry.id}
            entry={entry}
            installed={installed.has(entry.id)}
            installing={install.busy === entry.id}
            installDisabled={install.busy !== null && install.busy !== entry.id}
            message={install.msgs.get(entry.id) ?? null}
            onInstall={() => void onInstall(entry)}
          />
        ))}
      </div>
    </div>
  );
}

interface CardProps {
  entry: MarketplaceEntry;
  installed: boolean;
  installing: boolean;
  installDisabled: boolean;
  message: string | null;
  onInstall: () => void;
}

function MarketplaceCard({
  entry,
  installed,
  installing,
  installDisabled,
  message,
  onInstall,
}: CardProps) {
  return (
    <div className="rounded border border-line bg-panel-soft/40 px-3 py-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
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
        </div>
        <div className="shrink-0">
          {installed ? (
            <Button variant="ghost" size="sm" disabled title="已在第三方插件列表">
              已安装
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              onClick={onInstall}
              disabled={installing || installDisabled}
            >
              {installing ? '安装中…' : '安装'}
            </Button>
          )}
        </div>
      </div>
      {message && (
        <div className="mt-1 text-[10px] text-fg-muted">{message}</div>
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
