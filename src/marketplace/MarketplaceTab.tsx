// 插件商店 SettingTab(Phase 1+2:浏览 + 安装)。
//
// 启动时拉 index.json,卡片列表展示。verified 徽章、tags、作者链接外站。
// 已装的卡片显 "已安装" disabled;未装显 [安装] primary,点击调
// installFromGit(走 v4.5 已有 IPC)。安装成功 toast 在卡片下方提示。

import { useEffect, useMemo, useState } from 'react';
import { Button, Input, Spinner } from '@/design';
import { coApi } from '@/lib/co-api';
import { getUserPluginManager } from '@/plugins/co-plugin-manager';
import { entryToGitUrl, type MarketplaceEntry } from './types';
import { fetchMarketplaceIndex } from './fetcher';
import { applyFilter, collectAllTags } from './filter';
import { useUpdateStore } from './update-store';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ok'; entries: readonly MarketplaceEntry[] }
  | { kind: 'error'; message: string };

interface InstallState {
  /** 正在装的 entry id. */
  busy: string | null;
  /** 安装结果消息(per entry). */
  msgs: ReadonlyMap<string, string>;
  /** 刚装成功但 PluginManager 还没扫到的 id(下次 LM 启动才入表). */
  pending: ReadonlySet<string>;
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
  const updates = useUpdateStore((s) => s.available);
  const refreshUpdates = useUpdateStore((s) => s.refresh);
  const [install, setInstall] = useState<InstallState>({
    busy: null,
    msgs: new Map(),
    pending: new Set(),
  });
  const [query, setQuery] = useState('');
  const [selectedTags, setSelectedTags] = useState<ReadonlySet<string>>(
    new Set(),
  );

  // entry.id → 可用更新版本(若有)
  const updateByPid = new Map(updates.map((u) => [u.id, u.to]));

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
    let success = false;
    try {
      const r = await coApi.plugins.installFromGit(entryToGitUrl(entry));
      success = r.ok;
      msg = r.ok
        ? `✔ 已安装 ${r.data.name} v${r.data.version} — 重启 Continuo 后激活`
        : `✘ [${r.code}] ${r.message}`;
    } catch (err) {
      msg = `✘ ${err instanceof Error ? err.message : String(err)}`;
    }
    setInstall((prev) => {
      const nextMsgs = new Map(prev.msgs);
      nextMsgs.set(entry.id, msg);
      const nextPending = new Set(prev.pending);
      if (success) nextPending.add(entry.id);
      return { busy: null, msgs: nextMsgs, pending: nextPending };
    });
  };

  const onUpdate = async (entry: MarketplaceEntry) => {
    // 更新 = 卸载 + 重装。卸载走 PluginManager 走 LIFO + 清 _enabled / _permissions;
    // 装走 v4.5 installFromGit。两步任一失败 → toast 显错。
    setInstall((prev) => ({ ...prev, busy: entry.id }));
    let msg: string;
    let success = false;
    try {
      const mgr = getUserPluginManager();
      if (mgr) {
        try {
          await mgr.uninstall(entry.id);
        } catch (err) {
          console.warn(`[marketplace] uninstall ${entry.id} failed`, err);
        }
      }
      const r = await coApi.plugins.installFromGit(entryToGitUrl(entry));
      success = r.ok;
      msg = r.ok
        ? `✔ 更新到 ${r.data.name} v${r.data.version} — 重启 Continuo 后激活`
        : `✘ 更新失败 [${r.code}] ${r.message}`;
    } catch (err) {
      msg = `✘ 更新失败:${err instanceof Error ? err.message : String(err)}`;
    }
    setInstall((prev) => {
      const nextMsgs = new Map(prev.msgs);
      nextMsgs.set(entry.id, msg);
      const nextPending = new Set(prev.pending);
      if (success) nextPending.add(entry.id);
      return { busy: null, msgs: nextMsgs, pending: nextPending };
    });
    // 更新成功后刷新 update-store(从 available 摘掉这条)
    if (success) void refreshUpdates();
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

  const allTags = useMemo(() => collectAllTags(state.entries), [state.entries]);
  const filtered = useMemo(
    () => applyFilter(state.entries, { query, selectedTags }),
    [state.entries, query, selectedTags],
  );

  const toggleTag = (tag: string) => {
    setSelectedTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Input
          size="sm"
          placeholder="搜索插件名 / 描述 / tag…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {allTags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {allTags.map((tag) => {
              const active = selectedTags.has(tag);
              return (
                <button
                  key={tag}
                  type="button"
                  onClick={() => toggleTag(tag)}
                  className={[
                    'rounded px-2 py-0.5 text-[10px] transition',
                    active
                      ? 'bg-accent text-canvas'
                      : 'bg-panel text-fg-muted hover:bg-hover',
                  ].join(' ')}
                >
                  {tag}
                </button>
              );
            })}
            {selectedTags.size > 0 && (
              <button
                type="button"
                onClick={() => setSelectedTags(new Set())}
                className="rounded px-2 py-0.5 text-[10px] text-fg-dim hover:text-fg"
              >
                清除筛选
              </button>
            )}
          </div>
        )}
      </div>
      <p className="text-[10px] text-fg-dim">
        显示 {filtered.length} / 共 {state.entries.length} 个插件 · 索引 1 小时缓存
      </p>
      {filtered.length === 0 ? (
        <div className="rounded border border-dashed border-line bg-panel-soft/40 px-3 py-6 text-center text-xs text-fg-dim">
          没有匹配的插件。换个搜索词或清除 tag 筛选。
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((entry) => (
            <MarketplaceCard
              key={entry.id}
              entry={entry}
              installed={installed.has(entry.id) || install.pending.has(entry.id)}
              pendingRestart={
                install.pending.has(entry.id) && !installed.has(entry.id)
              }
              updateAvailable={updateByPid.get(entry.id) ?? null}
              installing={install.busy === entry.id}
              installDisabled={install.busy !== null && install.busy !== entry.id}
              message={install.msgs.get(entry.id) ?? null}
              onInstall={() => void onInstall(entry)}
              onUpdate={() => void onUpdate(entry)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface CardProps {
  entry: MarketplaceEntry;
  installed: boolean;
  /** 已装但 PluginManager 还没扫到 → 提示需重启. */
  pendingRestart: boolean;
  /** 远程有比本地新的版本号(Phase 3),null 表示没更新可用. */
  updateAvailable: string | null;
  installing: boolean;
  installDisabled: boolean;
  message: string | null;
  onInstall: () => void;
  onUpdate: () => void;
}

function MarketplaceCard({
  entry,
  installed,
  pendingRestart,
  updateAvailable,
  installing,
  installDisabled,
  message,
  onInstall,
  onUpdate,
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
          {installed && updateAvailable && !pendingRestart ? (
            <Button
              variant="primary"
              size="sm"
              onClick={onUpdate}
              disabled={installing || installDisabled}
              title={`远程版本 v${updateAvailable},点击更新`}
            >
              {installing ? '更新中…' : `更新到 v${updateAvailable}`}
            </Button>
          ) : installed ? (
            <Button
              variant="ghost"
              size="sm"
              disabled
              title={
                pendingRestart
                  ? '磁盘已就位,重启 Continuo 后才会进 plugin manager'
                  : '已在第三方插件列表'
              }
            >
              {pendingRestart ? '已安装(待重启)' : '已安装'}
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
