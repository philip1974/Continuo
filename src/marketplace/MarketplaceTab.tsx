// 插件商店 SettingTab(Phase 1+2:浏览 + 安装)。
//
// 启动时拉 index.json,卡片列表展示。verified 徽章、tags、作者链接外站。
// 已装的卡片显 "已安装" disabled;未装显 [安装] primary,点击调
// installFromGit(走 v4.5 已有 IPC)。安装成功 toast 在卡片下方提示。

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input, Spinner } from '@/design';
import { coApi } from '@/lib/co-api';
import { errorMessage } from '../../electron/shared/error-message';
import { getUserPluginManager } from '@/plugins/PluginManager';
import { entryToGitUrl, type MarketplaceEntry } from './types';
import { fetchMarketplaceIndex } from './fetcher';
import { applyFilter, collectAllTags } from './filter';
import { clampSearchQuery } from '@/lib/search-query';
import { clampGitUrl } from '../../electron/shared/plugins-channels';
import { useUpdateStore } from './update-store';
import { reconcileAfterUpdate } from './reconcile-after-update';
import { pruneLandedPending } from './prune-landed-pending';
import { useReviewsStore } from './reviews-store';
import type { PluginAggregateRating, Review } from './reviews-types';
import { useT, t as translate } from '@/i18n';
import { localizeErrorByCode } from '@/lib/localize-error';
import { SR_ONLY_STYLE } from '@/lib/sr-only';

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
  /** 安装结果消息(per entry)。a11y(A44):带严重度 → 渲染按语义选 live region。 */
  msgs: ReadonlyMap<string, { text: string; isError: boolean }>;
  /** 刚装成功但 PluginManager 还没扫到的 id(下次 LM 启动才入表). */
  pending: ReadonlySet<string>;
}

/** 两个 id 集合成员完全相同(打磨 R2:轮询无变化时保持引用稳定). */
export function sameIdSet(
  a: ReadonlySet<string>,
  b: ReadonlySet<string>,
): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/** 1s 轮询当前已装 plugin id 集合(同 PluginsTabContent 模式). */
export function useInstalledIds(): ReadonlySet<string> {
  const [snap, setSnap] = useState<ReadonlySet<string>>(() => readIds());
  useEffect(() => {
    // readIds() 每次都返回新 Set,直接 setSnap 会让 MarketplaceTab 每秒整页
    // re-render(筛选区 + 卡片列表),即使已装集合没变。函数式更新只在集合实际
    // 变化时换引用,无变化保持同引用 → React 跳过 re-render。(codex 打磨 R2)
    const t = setInterval(() => {
      const next = readIds();
      setSnap((prev) => (sameIdSet(prev, next) ? prev : next));
    }, 1000);
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
  const dismissUpdate = useUpdateStore((s) => s.dismiss);
  const [install, setInstall] = useState<InstallState>({
    busy: null,
    msgs: new Map(),
    pending: new Set(),
  });
  // race(R8):同步 in-flight 闸门。install.busy 是 render 后异步状态,同一事件循环内双击
  // install/update 会在 busy 生效前重入 → 双 installFromGit(主进程 lock 要等 clone+manifest
  // 才串行,期间已双 clone)。一次只允许一个安装/更新操作,ref 同步占位。
  const installBusyRef = useRef(false);
  const [query, setQuery] = useState('');
  const [selectedTags, setSelectedTags] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const reviewsByPid = useReviewsStore((s) => s.byPid);
  const reviewsLoading = useReviewsStore((s) => s.loading);
  const reviewsError = useReviewsStore((s) => s.error);
  const refreshReviews = useReviewsStore((s) => s.refresh);

  // entry.id → 可用更新版本(若有)。useMemo 让 memo 子组件能受益:
  // updates 来自 zustand store,Array.prototype.map 否则每次 render 创新 Map ref.
  const updateByPid = useMemo(
    () => new Map(updates.map((u) => [u.id, u.to])),
    [updates],
  );

  // install.pending 落地(出现在 installed 真实磁盘集)后摘除:防内存泄漏 + 防卸载后
  // 卡片残留「已安装/待重启」幻影。见 prune-landed-pending。无变化时返同引用不 re-render。
  useEffect(() => {
    setInstall((prev) => {
      const pruned = pruneLandedPending(prev.pending, installed);
      return pruned === prev.pending ? prev : { ...prev, pending: pruned };
    });
  }, [installed]);

  // 首次挂载时拉 reviews(打磨 R53:从启动预拉移到这里)。store 持 lastFetchedAt,
  // 已拉过 / 正在拉则跳过,避免重复打 GitHub API;刷新按钮仍走 refreshReviews(true)。
  useEffect(() => {
    const rs = useReviewsStore.getState();
    if (rs.lastFetchedAt === null && !rs.loading) {
      void refreshReviews();
    }
  }, [refreshReviews]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const entries = await fetchMarketplaceIndex();
        if (!cancelled) setState({ kind: 'ok', entries });
      } catch (err) {
        if (!cancelled) {
          // i18n(I5):fetcher 对可本地化的失败抛稳定 code(MARKETPLACE_INDEX_INVALID),
          // 这里按 errors.<CODE> catalog 翻译;网络/HTTP 等动态错误无 catalog → 回退原文。
          const raw = errorMessage(err);
          setState({
            kind: 'error',
            message: localizeErrorByCode(raw, raw),
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
    // race(R8):同步单飞 —— 同 tick 双击在 busy state 生效前直接挡掉重入。
    if (installBusyRef.current) return;
    installBusyRef.current = true;
    setInstall((prev) => ({ ...prev, busy: entry.id }));
    let msg: string;
    let success = false;
    try {
      const r = await coApi.plugins.installFromGit(entryToGitUrl(entry));
      success = r.ok;
      // i18n(codex 复查 P1,I1 同族兄弟):installFromGit 各错误站点 Error.message 是硬编码
      // 中文,直接展示会让 en/ko 卡片看到中文。改用稳定 r.code 经 catalog(errors.<CODE>)
      // 翻译,命中用本地化文案、未知 code 回退原 message,再套本地化外壳。
      msg = r.ok
        ? translate('marketplace.install_success', { name: r.data.name, version: r.data.version })
        : translate('marketplace.install_failed_code', {
            code: r.code,
            message: localizeErrorByCode(r.code, r.message),
          });
    } catch (err) {
      // a11y(A85,A84 同族):不把装饰性 ✘ 拼进 message 字符串 —— 失败严重度由 isError+role=alert
      // 表达,符号入文本会被 live region 当内容播报成"cross mark …"噪声。
      msg = errorMessage(err);
    }
    installBusyRef.current = false; // race(R8):清同步闸门(与 busy:null 同步)。
    setInstall((prev) => {
      const nextMsgs = new Map(prev.msgs);
      nextMsgs.set(entry.id, { text: msg, isError: !success });
      const nextPending = new Set(prev.pending);
      if (success) nextPending.add(entry.id);
      return { busy: null, msgs: nextMsgs, pending: nextPending };
    });
  }, []);

  const onUpdate = useCallback(
    async (entry: MarketplaceEntry) => {
      // 更新 = 原子覆盖安装(overwrite=true)。不再「先卸载后重装」:旧实现一旦
      // 卸载成功但重装失败(网络/clone 错),插件就从磁盘消失且无回滚(审计 #2)。
      // installFromGit overwrite 在 main 端做 staging+rename swap,失败保留旧版本;
      // 且保留 _enabled / _permissions,更新后无需重新授权(语义更贴近"更新")。
      // race(R8):同步单飞 —— 同 tick 双击 / 与 install 并发在 busy 生效前重入直接挡掉。
      if (installBusyRef.current) return;
      installBusyRef.current = true;
      setInstall((prev) => ({ ...prev, busy: entry.id }));
      let msg: string;
      let success = false;
      try {
        const r = await coApi.plugins.installFromGit(entryToGitUrl(entry), true);
        success = r.ok;
        // i18n(codex 复查 P1,I1 同族):message 经 r.code 走 catalog 翻译再插本地化外壳,
        // 否则 update_failed_code 的 {message} 会塞进 main 硬编码中文 → en/ko 看到中文。
        msg = r.ok
          ? translate('marketplace.update_success', { name: r.data.name, version: r.data.version })
          : translate('marketplace.update_failed_code', {
              code: r.code,
              message: localizeErrorByCode(r.code, r.message),
            });
      } catch (err) {
        msg = translate('marketplace.update_failed_msg', {
          message: errorMessage(err),
        });
      }
      installBusyRef.current = false; // race(R8):清同步闸门(与 busy:null 同步)。
      setInstall((prev) => {
        const nextMsgs = new Map(prev.msgs);
        nextMsgs.set(entry.id, { text: msg, isError: !success });
        const nextPending = new Set(prev.pending);
        if (success) nextPending.add(entry.id);
        return { busy: null, msgs: nextMsgs, pending: nextPending };
      });
      // 更新成功后:先乐观从 available 摘掉这条让更新按钮即时收起(否则到异步
      // refresh 完成前用户可重复点击触发对已是最新版的二次 overwrite 安装),
      // 再异步刷新 update-store 与磁盘对账。
      if (success) {
        dismissUpdate(entry.id);
        // installFromGit 已原子覆盖磁盘,但 renderer 内存里的 PluginManager 版本要等
        // 2s mtime watcher reload 才更新。这里主动 reload 让本地版本即时推进 —— 否则
        // 紧随的 refreshUpdates 读到陈旧旧版本 → 误判仍可更新 → 把刚 dismiss 的条目
        // 又加回 available(更新按钮/角标复活并滞留到下次手动刷新)。reload 走 per-id
        // 生命周期锁,与 watcher 并发安全。见第二十二轮 P2-BB。
        // P2-BD:reload 失败时**不能**再 refresh(内存仍旧版会复活已 dismiss 的条目),
        // 由 reconcileAfterUpdate 做 reload→refresh 的成功门控。
        const mgr = getUserPluginManager();
        if (mgr) {
          void reconcileAfterUpdate({
            reload: () => mgr.reload(entry.id),
            refresh: () => void refreshUpdates(),
          });
        } else {
          void refreshUpdates();
        }
      }
    },
    [refreshUpdates, dismissUpdate],
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
      // a11y(A104,A102 同族):初始索引加载须 role=status 播报具体「正在加载插件市场」语义,
      // Spinner aria-hidden 抑制泛化 Loading(否则 SR 只听通用加载,不知等的是市场索引)。
      <div
        role="status"
        className="flex h-32 items-center justify-center gap-2 text-fg-dim"
      >
        <Spinner aria-hidden />
        <span className="text-xs">{t('marketplace.loading')}</span>
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      // a11y(A66,A41 同族):索引异步加载失败的错误块须 live region(失败 → role=alert/assertive),
      // 否则焦点在面板/搜索入口附近时 SR 用户只感知"无内容",不知是加载失败。
      <div
        role="alert"
        className="rounded border border-line bg-panel-soft/40 p-4 text-xs text-error"
      >
        {t('marketplace.index_fetch_failed', { message: state.message })}
        <div className="mt-1 text-fg-dim">
          {t('marketplace.index_fetch_hint')}
        </div>
      </div>
    );
  }

  if (state.entries.length === 0) {
    return (
      // a11y(A67,A56/A66 同族):索引加载成功但为空是一个异步加载结果,焦点停在原控件时 SR 用户
      // 不会获知"市场为空" → role=status(polite 中性空态结果)。失败态用 alert(A66),空态用 status。
      <div
        role="status"
        className="rounded border border-dashed border-line bg-panel-soft/40 px-3 py-6 text-center text-xs text-fg-dim"
      >
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
          // a11y(A3,A1 同族):placeholder 无参数 → 复用作 aria-label 给屏幕阅读器稳定可访问名。
          aria-label={t('marketplace.search_placeholder')}
          placeholder={t('marketplace.search_placeholder')}
          value={query}
          // 边界(E281,E279/E280 同族):截断超长 query —— applyFilter 对最多 4096 远端 entry 逐项
          // 构造 haystack + toLowerCase/includes,超长 paste 一次性放大同步 CPU/内存。复用统一搜索上限。
          onChange={(e) => setQuery(clampSearchQuery(e.target.value))}
        />
        {allTags.length > 0 && (
          // a11y(A98,A97 同族):tag 筛选 toggle 组用 role=group + aria-labelledby 关联
          // 「Popular tags」标签,否则 SR 逐个聚焦只听到 tag 名+pressed,不知是筛选条件组。
          <div
            role="group"
            aria-labelledby="marketplace-popular-tags-label"
            className="flex flex-wrap items-center gap-1.5"
          >
            <span
              id="marketplace-popular-tags-label"
              className="mr-1 text-2xs uppercase tracking-wider text-fg-dim"
            >
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
        {/* a11y(A55,A53/A54 同族):搜索/标签过滤结果摘要随输入与 tag toggle 动态变化,焦点在
            搜索框/tag 按钮时须 live region(role=status/polite)播报筛选结果数量。 */}
        <span role="status">
          {t('marketplace.count_summary', {
            shown: filtered.length,
            total: state.entries.length,
          })}
        </span>
        <button
          type="button"
          onClick={() => void refreshReviews(true)}
          disabled={reviewsLoading}
          // a11y(A93,A51 同族):刷新进行中用 aria-busy 标注按钮忙碌态。
          aria-busy={reviewsLoading}
          className="rounded px-2 py-0.5 text-fg-muted hover:bg-hover hover:text-fg disabled:opacity-50"
          title={t('marketplace.reviews.refresh_title')}
        >
          {/* a11y(A90,A88 同族):刷新图标 ⟳ 纯视觉,catalog 已去符号 → aria-hidden 单独渲染,
              按钮可访问名只剩纯文本(刷新评分/刷新中)。 */}
          <span aria-hidden="true">⟳</span>{' '}
          {reviewsLoading
            ? t('marketplace.reviews.refreshing')
            : t('marketplace.reviews.refresh')}
        </button>
        {/* a11y(A93,A51 同族):loading 是瞬时状态,按钮文字变化+disabled 焦点在按钮时不一定被
            播报 → 视觉隐藏 role=status(polite)镜像「刷新中」(仅 loading 时输出,idle 空不打扰)。 */}
        <span style={SR_ONLY_STYLE} role="status">
          {reviewsLoading ? t('marketplace.reviews.refreshing') : ''}
        </span>
      </div>
      {reviewsError && !reviewsLoading && (
        // 刷新评论失败必须给反馈,否则按钮恢复原样 + 评论区无变化 → 用户无法区分
        // "刷新成功但无新评论" vs "刷新失败"。见第二十二轮 P2-BC。
        <div className="text-2xs text-error" role="alert">
          {/* a11y(A41):异步刷新失败文本须 role=alert(隐式 aria-live=assertive),否则插入
              页面后焦点仍在按钮、AT 不主动播报失败。 */}
          {/* i18n(I12,I5 同族):reviewsError 可能是 fetcher 抛的稳定 code
              (MARKETPLACE_REVIEWS_NO_TOKEN),按 errors.<CODE> catalog 本地化;
              网络等动态错误无 catalog key → 回退原文。 */}
          {t('marketplace.reviews.refresh_failed', {
            message: localizeErrorByCode(reviewsError, reviewsError),
          })}
        </div>
      )}
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
  // race(R8):同步 in-flight 闸门(同 PluginsTabContent.onInstall)—— disabled={busy} render 滞后,
  // 同 tick 双击/Enter 会双 installFromGit。
  const busyRef = useRef(false);
  // a11y(A43,A42 同族):结果消息带严重度 → 渲染时按语义选 live region(成功 status/失败 alert)。
  const [msg, setMsg] = useState<{ text: string; isError: boolean } | null>(
    null,
  );

  const onInstall = async () => {
    const u = url.trim();
    if (!u) return;
    if (busyRef.current) return; // race(R8):同步单飞,重入直接挡掉。
    busyRef.current = true;
    setBusy(true);
    setMsg(null);
    try {
      const r = await coApi.plugins.installFromGit(u);
      if (!r.ok) {
        // i18n(I1 同族,Git URL 安装段兄弟入口):同卡片安装,按 r.code 经 catalog 翻译,
        // 未知 code 回退原 message,再套本地化外壳,避免 en/ko 看到 main 硬编码中文。
        setMsg({
          text: translate('marketplace.install_failed_code', {
            code: r.code,
            message: localizeErrorByCode(r.code, r.message),
          }),
          isError: true,
        });
      } else {
        setMsg({
          text: translate('marketplace.install_success', {
            name: r.data.name,
            version: r.data.version,
          }),
          isError: false,
        });
        setUrl('');
      }
    } catch (err) {
      // a11y(A85,A84 同族):同上,不把 ✘ 拼进 alert 文本(severity 由 isError+role=alert 表达)。
      setMsg({ text: errorMessage(err), isError: true });
    } finally {
      busyRef.current = false; // race(R8):清同步闸门。
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
          // a11y(A5 同族):placeholder 是 URL 示例非标签 → 用 section 标题作 aria-label。
          aria-label={t('marketplace.git_url_section_title')}
          placeholder="https://github.com/user/extension-repo.git"
          value={url}
          // 边界(E282):截断超长 git URL(防 paste 撑 React state + IPC structured-clone 放大,main schema 才拒)。
          onChange={(e) => setUrl(clampGitUrl(e.target.value))}
          disabled={busy}
          className="flex-1"
        />
        <Button
          variant="primary"
          size="sm"
          onClick={onInstall}
          disabled={busy || !url.trim()}
          // a11y(A94,A93 同族):安装中标 aria-busy(忙碌语义)。
          aria-busy={busy}
        >
          {busy
            ? t('marketplace.installing')
            : t('marketplace.install_extension')}
        </Button>
      </div>
      {/* a11y(A94,A51 同族):安装 loading 瞬时态,焦点在按钮时文字变化不一定被播报 →
          视觉隐藏 role=status 镜像「安装中」(仅 busy 时输出)。 */}
      <span style={SR_ONLY_STYLE} role="status">
        {busy ? t('marketplace.installing') : ''}
      </span>
      {msg && (
        // a11y(A43,A42 同族):异步安装结果须 live region 主动播报(失败 alert/成功 status)。
        <div
          className="mt-2 text-xs text-fg-muted"
          role={msg.isError ? 'alert' : 'status'}
        >
          {msg.text}
        </div>
      )}
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
      // a11y(A8):tag filter 是 toggle,active 只改 className → 补 aria-pressed 暴露选中态给 AT。
      aria-pressed={active}
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
  message: { text: string; isError: boolean } | null;
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
                {/* a11y(A72 同族装饰符号):"Verified" 文本已表义,勾 ✓ 纯视觉 → aria-hidden,
                    否则 SR 额外读出 checkmark 造成徽标名称噪声。 */}
                <span aria-hidden="true">✓</span> {t('marketplace.verified')}
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
              aria-busy={installing}
              // a11y(A77,A75 同族):多卡片操作按钮可见文本通用,aria-label 补插件名以区分。
              aria-label={t('marketplace.card_action_aria', {
                action: installing
                  ? t('marketplace.updating')
                  : t('marketplace.update_to', { version: updateAvailable }),
                name: entry.name,
              })}
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
              aria-label={t('marketplace.card_action_aria', {
                action: pendingRestart
                  ? t('marketplace.installed_pending_restart')
                  : t('marketplace.installed'),
                name: entry.name,
              })}
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
              aria-busy={installing}
              aria-label={t('marketplace.card_action_aria', {
                action: installing
                  ? t('marketplace.installing')
                  : t('marketplace.install'),
                name: entry.name,
              })}
            >
              {installing
                ? t('marketplace.installing')
                : t('marketplace.install')}
            </Button>
          )}
        </div>
      </div>
      {/* a11y(A94,A51 同族):卡片安装/更新 loading 瞬时态 → 视觉隐藏 role=status 镜像「安装中」
          (仅 installing 时输出;成功/失败结果由下方 message live region 播报)。 */}
      <span style={SR_ONLY_STYLE} role="status">
        {installing ? t('marketplace.installing') : ''}
      </span>
      {message && (
        // a11y(A44,A42/A43 同族):卡片级安装/更新结果须 live region 主动播报(失败 alert/成功 status)。
        <div
          className="mt-1 text-2xs text-fg-muted"
          role={message.isError ? 'alert' : 'status'}
        >
          {message.text}
        </div>
      )}
      <RatingRow entry={entry} rating={rating} />

      <div className="mt-1.5 flex items-center justify-between gap-2 text-2xs text-fg-dim">
        <div className="flex items-center gap-2">
          <span>
            {t('marketplace.author_by')}{' '}
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
          {/* a11y(A72,A70 同族装饰符号):链接目的已由仓库名表达,外链箭头 ↗ 纯视觉提示 →
              aria-hidden,否则混进链接可访问名读成"repo arrow"噪声。 */}
          {entry.repo} <span aria-hidden="true">↗</span>
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
  // 仅在卡片展开时才排序/截断(打磨 R41):sorted 只在 expanded 分支渲染,Marketplace
  // 列表大多数卡片默认折叠,无须为不可见 review 排序 + 复制数组。
  const sorted = useMemo(
    () =>
      expanded && hasReviews
        ? sortReviews(sourceReviews, sort).slice(0, 10)
        : [],
    [expanded, hasReviews, sourceReviews, sort],
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
          // a11y(A79,A77 同族):多卡片 review 链接可见文本通用,aria-label 注入插件名以区分。
          aria-label={t('marketplace.card_action_aria', {
            action: t('marketplace.reviews.write_first'),
            name: entry.name,
          })}
        >
          {/* a11y(A88,A86 同族):图标/箭头是纯视觉,catalog 文案已去符号,aria-label 用纯文本;
              视觉 ✏️/↗ 在 JSX 用 aria-hidden 单独渲染,不入可访问名。 */}
          <span aria-hidden="true">✏️</span> {t('marketplace.reviews.write_first')}{' '}
          <span aria-hidden="true">↗</span>
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
          // a11y(A9):展开/折叠按钮只用 title+▴/▾ 表状态 → 补 aria-expanded 暴露给 AT。
          aria-expanded={expanded}
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
          {/* a11y(A69 同族装饰符号):展开状态已由按钮 aria-expanded 暴露,视觉三角是纯装饰 →
              aria-hidden,否则 ▴/▾ 混进按钮可访问名造成与 expanded 重复的噪声。 */}
          <span className="text-fg-dim" aria-hidden="true">{expanded ? '▴' : '▾'}</span>
        </button>
        <span className="text-fg-dim">·</span>
        <a
          href={newReviewUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent hover:underline"
          // a11y(A79,A77 同族):多卡片 review 链接可见文本通用,aria-label 注入插件名以区分。
          aria-label={t('marketplace.card_action_aria', {
            action: t('marketplace.reviews.write_review'),
            name: entry.name,
          })}
        >
          {/* a11y(A88):视觉 ✏️/↗ aria-hidden,可访问名用纯文本 catalog。 */}
          <span aria-hidden="true">✏️</span> {t('marketplace.reviews.write_review')}{' '}
          <span aria-hidden="true">↗</span>
        </a>
      </div>
      {expanded && (
        <div className="space-y-1.5 rounded border border-line bg-panel/50 p-2">
          {/* a11y(A97):排序 toggle 组用 role=group + aria-labelledby 关联「Sort:」标签,
              否则 SR 逐个聚焦只听到按钮状态,不知这是 review 排序控件。id 带 entry.id 保唯一。 */}
          <div
            role="group"
            aria-labelledby={`review-sort-label-${entry.id}`}
            className="flex items-center gap-1 pb-1 text-2xs text-fg-dim"
          >
            <span id={`review-sort-label-${entry.id}`}>
              {t('marketplace.reviews.sort_label')}
            </span>
            {(['newest', 'helpful'] as const).map((s) => (
              <button
                key={s}
                type="button"
                // a11y(A16,A8 同族):排序 toggle 组当前项只改 className → 补 aria-pressed 暴露
                // 给 AT(单选组,pressed 项即当前排序)。
                aria-pressed={sort === s}
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
                // a11y(A81,A79 同族):多卡片展开该链接同名,aria-label 注入插件名以区分。
                aria-label={t('marketplace.card_action_aria', {
                  action: t('marketplace.reviews.see_all_in_github'),
                  name: entry.name,
                })}
              >
                {/* a11y(A88):视觉 ↗ aria-hidden,可访问名用纯文本 catalog。 */}
                {t('marketplace.reviews.see_all_in_github')}{' '}
                <span aria-hidden="true">↗</span>
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
  // 边界(E270,E253 续 / 信任信号防绕过):author.createdAt 经 E253 校验为 string + 长度,但未保证可解析为
  // 日期。畸形值(如 "not-a-date")→ getTime() 为 NaN → accountAge 为 NaN → `NaN < NEW_ACCOUNT_MS` 为
  // false → 新账号 badge 被静默绕过(新账号靠损坏 createdAt 规避风险提示)。**不可解析 = 保守视为新账号**
  // (未知账龄 = 假定风险,显 badge)。注:不在数据层把畸形 createdAt 兜底成 epoch —— epoch 解析为很旧账号
  // → 反而绕过 badge,会重新打开本漏洞;故在此 UI 判定处用 Number.isFinite 兜底为"新"。
  const accountAge = Date.now() - new Date(r.author.createdAt).getTime();
  const isNewAccount = !Number.isFinite(accountAge) || accountAge < NEW_ACCOUNT_MS;

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
              {/* a11y(A92,A88 同族):视觉盾牌 🛡 纯装饰,catalog 已去符号 → aria-hidden;
                  "维护者"文本已表义。 */}
              <span aria-hidden="true">🛡</span>{' '}
              {t('marketplace.reviews.maintainer_badge')}
            </span>
          )}
          {!isMaintainer && isNewAccount && (
            <span
              className="rounded bg-warning/20 px-1 py-0.5 text-[9px] text-warning"
              title={t('marketplace.reviews.new_account_warn', { days: NEW_ACCOUNT_DAYS })}
            >
              {/* a11y(A91):视觉 ⚠ 纯装饰 → aria-hidden(catalog 已去符号)。 */}
              <span aria-hidden="true">⚠</span>{' '}
              {t('marketplace.reviews.new_account_badge')}
              {/* a11y(A91):风险说明此前只在 title(键盘不可 hover、SR 读 title 不可靠)→
                  视觉隐藏可读文本,让 AT 拿到「账号小于 N 天需谨慎」的完整说明。 */}
              <span style={SR_ONLY_STYLE}>
                {' '}
                {t('marketplace.reviews.new_account_warn', { days: NEW_ACCOUNT_DAYS })}
              </span>
            </span>
          )}
          <span
            className="text-amber-400"
            // a11y(A38,A37 同族 + 镜像聚合评分):星级是纯视觉符号 ★/☆,须给 AT 可访问名,
            // 否则只听到一串星号。复用聚合评分同款 stars_aria 模式。
            aria-label={t('marketplace.reviews.stars_aria', {
              avg: String(r.rating),
            })}
          >
            {renderStars(r.rating)}
          </span>
          {r.thumbsUp > 0 && (
            <span
              className="text-fg-dim"
              title={t('marketplace.reviews.thumbs_up', { count: r.thumbsUp })}
            >
              {/* a11y(A39):👍+数字仅视觉;语义用视觉隐藏的本地化文本给 AT(文本流可读)。 */}
              <span aria-hidden="true">👍 {r.thumbsUp}</span>
              <span style={SR_ONLY_STYLE}>
                {t('marketplace.reviews.thumbs_up', { count: r.thumbsUp })}
              </span>
            </span>
          )}
          <span className="text-fg-dim">{formatDate(r.createdAt)}</span>
          <a
            href={r.url}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto text-accent hover:underline"
            title={t('marketplace.reviews.open_in_github')}
            // a11y(A36):图标-only 链接(仅 ↗)须有可访问名,否则 AT 只读箭头符号。
            // a11y(A83,A79 同族):多条 review 同名不可区分 → aria-label 注入作者上下文。
            aria-label={t('marketplace.reviews.open_in_github_by', {
              author: r.author.handle,
            })}
          >
            <span aria-hidden="true">↗</span>
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
