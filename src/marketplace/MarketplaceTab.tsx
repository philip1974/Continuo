// 插件商店 SettingTab(Phase 1+2:浏览 + 安装)。
//
// 启动时拉 index.json,卡片列表展示。verified 徽章、tags、作者链接外站。
// 已装的卡片显 "已安装" disabled;未装显 [安装] primary,点击调
// installFromGit(走 v4.5 已有 IPC)。安装成功 toast 在卡片下方提示。

import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Input, Spinner } from '@/design';
import { coApi } from '@/lib/co-api';
import { errorMessage } from '../../electron/shared/error-message';
import { getUserPluginManager } from '@/plugins/PluginManager';
import { entryToGitUrl, type MarketplaceEntry } from './types';
import { fetchMarketplaceIndex } from './fetcher';
import { applyFilter, collectAllTags } from './filter';
import { useUpdateStore } from './update-store';
import { useReviewsStore } from './reviews-store';
import type { PluginAggregateRating, Review } from './reviews-types';
import { useT, t as translate } from '@/i18n';

/** 项目维护者(角标用),hard-coded. */
const MAINTAINERS: ReadonlySet<string> = new Set(['philip1974']);
const NEW_ACCOUNT_DAYS = 7;
const NEW_ACCOUNT_MS = NEW_ACCOUNT_DAYS * 24 * 60 * 60 * 1000;

type ReviewSort = 'newest' | 'helpful';

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
  const t = useT();
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
  const reviewsByPid = useReviewsStore((s) => s.byPid);
  const reviewsLoading = useReviewsStore((s) => s.loading);
  const refreshReviews = useReviewsStore((s) => s.refresh);

  // entry.id → 可用更新版本(若有)。useMemo 让 memo 子组件能受益:
  // updates 来自 zustand store,Array.prototype.map 否则每次 render 创新 Map ref.
  const updateByPid = useMemo(
    () => new Map(updates.map((u) => [u.id, u.to])),
    [updates],
  );

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
            message: errorMessage(err),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // useCallback 稳定 handler ref,让 MarketplaceCard memo 不被 inline arrow 撑破。
  // setInstall 函数式更新,不依赖外部 state → deps 仅 store action。
  const onInstall = useCallback(async (entry: MarketplaceEntry) => {
    setInstall((prev) => ({ ...prev, busy: entry.id }));
    let msg: string;
    let success = false;
    try {
      const r = await coApi.plugins.installFromGit(entryToGitUrl(entry));
      success = r.ok;
      msg = r.ok
        ? translate('marketplace.install_success', { name: r.data.name, version: r.data.version })
        : `✘ [${r.code}] ${r.message}`;
    } catch (err) {
      msg = `✘ ${errorMessage(err)}`;
    }
    setInstall((prev) => {
      const nextMsgs = new Map(prev.msgs);
      nextMsgs.set(entry.id, msg);
      const nextPending = new Set(prev.pending);
      if (success) nextPending.add(entry.id);
      return { busy: null, msgs: nextMsgs, pending: nextPending };
    });
  }, []);

  const onUpdate = useCallback(
    async (entry: MarketplaceEntry) => {
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
          ? translate('marketplace.update_success', { name: r.data.name, version: r.data.version })
          : translate('marketplace.update_failed_code', { code: r.code, message: r.message });
      } catch (err) {
        msg = translate('marketplace.update_failed_msg', {
          message: errorMessage(err),
        });
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
    },
    [refreshUpdates],
  );

  // useCallback 让 TagButton memo 不被 inline arrow 撑破。
  // setSelectedTags 函数式更新,无外部依赖 → deps=[].
  // 必须在 early return 前声明(hooks 顺序规则)。
  const toggleTag = useCallback((tag: string) => {
    setSelectedTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  }, []);

  const clearTags = useCallback(() => {
    setSelectedTags(new Set());
  }, []);

  // Hooks 必须无条件按相同顺序;loading / error 时 entries=[],计算 noop
  const stateEntries = state.kind === 'ok' ? state.entries : undefined;
  const entries = useMemo(() => stateEntries ?? [], [stateEntries]);
  const allTags = useMemo(() => collectAllTags(entries), [entries]);
  const filtered = useMemo(
    () => applyFilter(entries, { query, selectedTags }),
    [entries, query, selectedTags],
  );

  if (state.kind === 'loading') {
    return (
      <div className="flex h-32 items-center justify-center text-fg-dim">
        <Spinner />
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div className="rounded border border-line bg-panel-soft/40 p-4 text-xs text-error">
        {t('marketplace.index_fetch_failed', { message: state.message })}
        <div className="mt-1 text-fg-dim">
          {t('marketplace.index_fetch_hint')}
        </div>
      </div>
    );
  }

  if (state.entries.length === 0) {
    return (
      <div className="rounded border border-dashed border-line bg-panel-soft/40 px-3 py-6 text-center text-xs text-fg-dim">
        {t('marketplace.empty_index_prefix')}
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
    <div className="flex flex-col gap-3">
      <div className="space-y-2">
        <Input
          size="sm"
          placeholder={t('marketplace.search_placeholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {allTags.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-2xs uppercase tracking-wider text-fg-dim">
              {t('marketplace.popular_tags')}
            </span>
            {allTags.map((tag) => (
              <TagButton
                key={tag}
                tag={tag}
                active={selectedTags.has(tag)}
                onToggle={toggleTag}
              />
            ))}
            {selectedTags.size > 0 && (
              <button
                type="button"
                onClick={clearTags}
                className="rounded px-2 py-0.5 text-2xs text-fg-dim hover:text-fg"
              >
                {t('marketplace.clear_filter')}
              </button>
            )}
          </div>
        )}
      </div>
      <div className="flex items-center justify-between gap-2 text-2xs text-fg-dim">
        <span>
          {t('marketplace.count_summary', {
            shown: filtered.length,
            total: state.entries.length,
          })}
        </span>
        <button
          type="button"
          onClick={() => void refreshReviews(true)}
          disabled={reviewsLoading}
          className="rounded px-2 py-0.5 text-fg-muted hover:bg-hover hover:text-fg disabled:opacity-50"
          title={t('marketplace.reviews.refresh_title')}
        >
          {reviewsLoading
            ? t('marketplace.reviews.refreshing')
            : t('marketplace.reviews.refresh')}
        </button>
      </div>
      {filtered.length === 0 ? (
        <div className="rounded border border-dashed border-line bg-panel-soft/40 px-3 py-6 text-center text-xs text-fg-dim">
          {t('marketplace.no_match')}
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
              rating={reviewsByPid.get(entry.id) ?? null}
              onInstall={onInstall}
              onUpdate={onUpdate}
            />
          ))}
        </div>
      )}
      <GitUrlInstallSection />
    </div>
  );
}

// 从 Git URL 安装段(对齐 demo (3) 扩展商店底部「从 GIT URL 安装」)。
// 走 v4.5 已有的 installFromGit IPC,与 PluginsTabContent 共用同一接口;
// 装好后插件磁盘已就位,需重启 Continuo 后 PluginManager 才扫到。
function GitUrlInstallSection() {
  const t = useT();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const onInstall = async () => {
    const u = url.trim();
    if (!u) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await coApi.plugins.installFromGit(u);
      if (!r.ok) {
        setMsg(`✘ [${r.code}] ${r.message}`);
      } else {
        setMsg(
          translate('marketplace.install_success', {
            name: r.data.name,
            version: r.data.version,
          }),
        );
        setUrl('');
      }
    } catch (err) {
      setMsg(`✘ ${errorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-6 border-t border-line/30 pt-6">
      <h3 className="text-base font-medium text-fg">
        {t('marketplace.git_url_section_title')}
      </h3>
      <p className="mt-1 text-xs text-fg-muted">
        {t('marketplace.git_url_section_hint')}
      </p>
      <div className="mt-3 flex items-center gap-2">
        <Input
          size="sm"
          placeholder="https://github.com/user/extension-repo.git"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={busy}
          className="flex-1"
        />
        <Button
          variant="primary"
          size="sm"
          onClick={onInstall}
          disabled={busy || !url.trim()}
        >
          {busy
            ? t('marketplace.installing')
            : t('marketplace.install_extension')}
        </Button>
      </div>
      {msg && <div className="mt-2 text-xs text-fg-muted">{msg}</div>}
      <div className="mt-3 flex items-start gap-2 rounded-md border border-accent/20 bg-accent/5 p-3 text-xs text-fg-muted">
        <span aria-hidden className="mt-0.5 leading-none text-accent">
          ⓘ
        </span>
        <span>{t('marketplace.git_url_warning')}</span>
      </div>
    </section>
  );
}

interface TagButtonProps {
  tag: string;
  active: boolean;
  onToggle: (tag: string) => void;
}

const TagButton = memo(function TagButton({
  tag,
  active,
  onToggle,
}: TagButtonProps) {
  return (
    <button
      type="button"
      onClick={() => onToggle(tag)}
      className={[
        'rounded-full border px-3 py-1 text-[11px] transition',
        active
          ? 'border-accent bg-accent text-canvas'
          : 'border-line bg-panel text-fg-muted hover:bg-hover hover:text-fg',
      ].join(' ')}
    >
      {tag}
    </button>
  );
});

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
  /** 评分聚合(reviews Phase 1),null 或 count=0 不显. */
  rating: PluginAggregateRating | null;
  /** 父组件 useCallback 稳定;card 内 onClick 闭包 entry 给它. */
  onInstall: (entry: MarketplaceEntry) => void | Promise<void>;
  onUpdate: (entry: MarketplaceEntry) => void | Promise<void>;
}

/** 把 0-5 平均分渲染成 5 个 ★/☆,半星向就近整数.
 *  调用点用 `text-amber-400` 着色 — 这是评分星级业内约定色,与 design token
 *  warning(#efc15e) 语义不同(rating ≠ warning),故保留为 design system 合法例外,
 *  不再扩 --color-rating 槽以免过度设计。 */
function renderStars(avg: number): string {
  const full = Math.round(avg);
  return '★'.repeat(Math.max(0, Math.min(5, full))) + '☆'.repeat(5 - Math.max(0, Math.min(5, full)));
}

const MarketplaceCard = memo(function MarketplaceCard({
  entry,
  installed,
  pendingRestart,
  updateAvailable,
  installing,
  installDisabled,
  message,
  rating,
  onInstall,
  onUpdate,
}: CardProps) {
  const t = useT();
  // entry 引用在 filtered 数组中稳定,onInstall/onUpdate 已 useCallback;
  // 内部按钮的 inline arrow 不影响外层 memo 拦截(Button 自己未 memo)。
  const handleInstall = () => void onInstall(entry);
  const handleUpdate = () => void onUpdate(entry);
  return (
    <div className="rounded-md border border-line bg-panel-soft/40 p-4 transition-colors hover:bg-panel-soft/70">
      <div className="flex items-start justify-between gap-4">
        <div
          aria-hidden="true"
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md border border-line bg-canvas text-base font-semibold uppercase text-fg-dim"
        >
          {entry.name.charAt(0)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="font-medium text-fg">{entry.name}</span>
            {entry.verified && (
              <span
                className="rounded bg-accent/20 px-1.5 py-0.5 text-2xs text-accent"
                title={t('marketplace.reviews.official_review')}
              >
                ✓ verified
              </span>
            )}
            <code className="text-2xs text-fg-dim">{entry.id}</code>
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
              onClick={handleUpdate}
              disabled={installing || installDisabled}
              title={t('marketplace.update_tooltip', { version: updateAvailable })}
            >
              {installing
                ? t('marketplace.updating')
                : t('marketplace.update_to', { version: updateAvailable })}
            </Button>
          ) : installed ? (
            <Button
              variant="ghost"
              size="sm"
              disabled
              title={
                pendingRestart
                  ? t('marketplace.install.disk_ready_hint')
                  : t('marketplace.install.in_user_list')
              }
            >
              {pendingRestart
                ? t('marketplace.installed_pending_restart')
                : t('marketplace.installed')}
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              onClick={handleInstall}
              disabled={installing || installDisabled}
            >
              {installing
                ? t('marketplace.installing')
                : t('marketplace.install')}
            </Button>
          )}
        </div>
      </div>
      {message && (
        <div className="mt-1 text-2xs text-fg-muted">{message}</div>
      )}
      <RatingRow entry={entry} rating={rating} />

      <div className="mt-1.5 flex items-center justify-between gap-2 text-2xs text-fg-dim">
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
});

/** 评分行 + 可展开的 reviews 列表 + "写评论" 链接(Phase 2/3). */
function RatingRow({
  entry,
  rating,
}: {
  entry: MarketplaceEntry;
  rating: PluginAggregateRating | null;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const [sort, setSort] = useState<ReviewSort>('newest');
  const hasReviews = rating !== null && rating.count > 0;
  const newReviewUrl = buildNewReviewUrl(entry.id);

  // hooks 必须无条件;hasReviews=false 时 sorted 用空数组,不影响
  const ratingReviews = rating?.reviews;
  const sourceReviews = useMemo(() => ratingReviews ?? [], [ratingReviews]);
  const sorted = useMemo(
    () => sortReviews(sourceReviews, sort).slice(0, 10),
    [sourceReviews, sort],
  );

  if (!hasReviews) {
    return (
      <div className="mt-1 text-2xs text-fg-dim">
        {t('marketplace.reviews.empty')} ·{' '}
        <a
          href={newReviewUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent hover:underline"
        >
          {t('marketplace.reviews.write_first')}
        </a>
      </div>
    );
  }

  return (
    <div className="mt-1 space-y-2">
      <div className="flex items-center gap-1.5 text-2xs text-fg-muted">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1.5 hover:text-fg"
          title={
            expanded
              ? t('marketplace.reviews.collapse')
              : t('marketplace.reviews.expand')
          }
        >
          <span
            className="text-amber-400"
            aria-label={t('marketplace.reviews.stars_aria', { avg: rating.avg.toFixed(1) })}
          >
            {renderStars(rating.avg)}
          </span>
          <span>{rating.avg.toFixed(1)}</span>
          <span className="text-fg-dim">
            {t('marketplace.reviews.count', { count: rating.count })}
          </span>
          <span className="text-fg-dim">{expanded ? '▴' : '▾'}</span>
        </button>
        <span className="text-fg-dim">·</span>
        <a
          href={newReviewUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent hover:underline"
        >
          {t('marketplace.reviews.write_review')}
        </a>
      </div>
      {expanded && (
        <div className="space-y-1.5 rounded border border-line bg-panel/50 p-2">
          <div className="flex items-center gap-1 pb-1 text-2xs text-fg-dim">
            <span>{t('marketplace.reviews.sort_label')}</span>
            {(['newest', 'helpful'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSort(s)}
                className={[
                  'rounded px-1.5 py-0.5',
                  sort === s ? 'bg-accent/20 text-accent' : 'hover:bg-hover',
                ].join(' ')}
              >
                {s === 'newest'
                  ? t('marketplace.reviews.sort_newest')
                  : t('marketplace.reviews.sort_helpful')}
              </button>
            ))}
          </div>
          {sorted.map((r) => (
            <ReviewItem key={r.url} review={r} />
          ))}
          {rating.reviews.length > 10 && (
            <div className="pt-1 text-2xs text-fg-dim">
              {t('marketplace.reviews.show_first_10')}
              <a
                href={`https://github.com/philip1974/continuo-plugins/discussions?discussions_q=%5B${entry.id}%5D`}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-1 text-accent hover:underline"
              >
                {t('marketplace.reviews.see_all_in_github')}
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ReviewItem({ review: r }: { review: Review }) {
  const t = useT();
  const isMaintainer = MAINTAINERS.has(r.author.handle);
  const accountAge = Date.now() - new Date(r.author.createdAt).getTime();
  const isNewAccount = accountAge < NEW_ACCOUNT_MS;

  return (
    <div className="flex gap-2 border-b border-line/50 pb-1.5 last:border-0 last:pb-0">
      <img
        src={r.author.avatarUrl}
        alt=""
        loading="lazy"
        decoding="async"
        className="h-5 w-5 shrink-0 rounded-full"
      />
      <div className="min-w-0 flex-1 text-2xs">
        <div className="flex items-baseline gap-1.5 text-fg-muted">
          <a
            href={`https://github.com/${r.author.handle}`}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-fg hover:underline"
          >
            {r.author.handle}
          </a>
          {isMaintainer && (
            <span
              className="rounded bg-accent/20 px-1 py-0.5 text-[9px] text-accent"
              title={t('marketplace.reviews.maintainer')}
            >
              {t('marketplace.reviews.maintainer_badge')}
            </span>
          )}
          {!isMaintainer && isNewAccount && (
            <span
              className="rounded bg-warning/20 px-1 py-0.5 text-[9px] text-warning"
              title={t('marketplace.reviews.new_account_warn', { days: NEW_ACCOUNT_DAYS })}
            >
              {t('marketplace.reviews.new_account_badge')}
            </span>
          )}
          <span className="text-amber-400">{renderStars(r.rating)}</span>
          {r.thumbsUp > 0 && (
            <span
              className="text-fg-dim"
              title={t('marketplace.reviews.thumbs_up', { count: r.thumbsUp })}
            >
              👍 {r.thumbsUp}
            </span>
          )}
          <span className="text-fg-dim">{formatDate(r.createdAt)}</span>
          <a
            href={r.url}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto text-accent hover:underline"
            title={t('marketplace.reviews.open_in_github')}
          >
            ↗
          </a>
        </div>
        <p className="mt-0.5 whitespace-pre-wrap text-fg">{r.body}</p>
      </div>
    </div>
  );
}

function sortReviews(
  reviews: readonly Review[],
  sort: ReviewSort,
): readonly Review[] {
  if (sort === 'newest') return reviews; // fetcher 已 createdAt DESC
  // helpful:thumbsUp DESC,平手按 createdAt DESC
  return [...reviews].sort((a, b) => {
    if (a.thumbsUp !== b.thumbsUp) return b.thumbsUp - a.thumbsUp;
    return b.createdAt.localeCompare(a.createdAt);
  });
}

/** 跳 GitHub 写新评论(预填 title 含 plugin id). */
function buildNewReviewUrl(pluginId: string): string {
  const title = encodeURIComponent(`[${pluginId}] `);
  return `https://github.com/philip1974/continuo-plugins/discussions/new?category=general&title=${title}`;
}

/** 简单 friendly 日期。formatDate 是 module helper,不在 React tree,
 *  调 translate() 直读 module-level locale state (topic-19 pattern). */
function formatDate(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return iso;
  const min = Math.floor(ms / 60_000);
  if (min < 60) return min <= 0 ? translate('marketplace.time.now') : translate('marketplace.time.minutes_ago', { n: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return translate('marketplace.time.hours_ago', { n: hr });
  const day = Math.floor(hr / 24);
  if (day < 30) return translate('marketplace.time.days_ago', { n: day });
  return iso.slice(0, 10);
}
