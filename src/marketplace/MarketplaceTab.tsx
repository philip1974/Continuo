// 插件市场 SettingTab(Phase 1+2:浏览 + 安装)。
//
// 启动时拉 index.json,卡片列表展示。verified 徽章、tags、作者链接外站。
// 已装的卡片显 "已安装" disabled;未装显 [安装] primary,点击调
// installFromGit(走 v4.5 已有 IPC)。安装成功 toast 在卡片下方提示。

import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Badge, Button, Input, Spinner } from '@/design';
import { errorMessage } from '../../electron/shared/error-message';
import { getUserPluginManager, type PluginListItem } from '@/plugins/PluginManager';
import { localizePluginError } from '@/plugins/plugin-error-text';
import { entryInstallOptions, entryToGitUrl, type MarketplaceEntry } from './types';
import { fetchMarketplaceIndex, MARKETPLACE_NETWORK } from './fetcher';
import { applyFilter, collectAllTags } from './filter';
import { clampSearchQuery } from '@/lib/search-query';
import { useAvailableUpdates, useUpdateStore, type AvailableUpdate } from './update-store';
import { recordPendingInstall, usePendingInstalls } from '@/plugins/pending-installs-store';
import { useReviewsStore } from './reviews-store';
import type { PluginAggregateRating, Review } from './reviews-types';
import { isHttpUrl } from './url-safety';
import { useT, t as translate, translateCount } from '@/i18n';
import { localizeErrorByCode } from '@/lib/localize-error';
import { SR_ONLY_STYLE } from '@/lib/sr-only';
import { useUserPluginList } from '@/plugins/use-user-plugin-list';
import { GitUrlInstallForm } from '@/plugins/GitUrlInstallForm';
import { MARKETPLACE_REPO_SLUG } from '../../electron/shared/marketplace-channels';
import { ResultMessage, type ResultMsg } from '@/lib/result-message';
import { installFromGitLocalized, repoNameFromGitUrl } from '@/plugins/install-from-git';

/** 项目维护者(角标用),hard-coded. */
const MAINTAINERS: ReadonlySet<string> = new Set(['philip1974']);
const NEW_ACCOUNT_DAYS = 7;
const NEW_ACCOUNT_MS = NEW_ACCOUNT_DAYS * 24 * 60 * 60 * 1000;
const REVIEW_DISPLAY_LIMIT = 10;

type ReviewSort = 'newest' | 'helpful';
const REVIEW_SORTS: readonly ReviewSort[] = ['newest', 'helpful'];

const MARKETPLACE_TAG_BUTTON_BASE_CLASS_NAME =
  'rounded-full border px-3 py-1 text-[11px] transition';
const MARKETPLACE_TAG_BUTTON_ACTIVE_CLASS_NAME =
  `${MARKETPLACE_TAG_BUTTON_BASE_CLASS_NAME} border-accent bg-accent text-canvas`;
const MARKETPLACE_TAG_BUTTON_INACTIVE_CLASS_NAME =
  `${MARKETPLACE_TAG_BUTTON_BASE_CLASS_NAME} border-line bg-panel text-fg-muted hover:bg-hover hover:text-fg`;

const MARKETPLACE_REVIEW_SORT_BUTTON_BASE_CLASS_NAME =
  'rounded px-1.5 py-0.5';
const MARKETPLACE_REVIEW_SORT_BUTTON_ACTIVE_CLASS_NAME =
  `${MARKETPLACE_REVIEW_SORT_BUTTON_BASE_CLASS_NAME} bg-accent/20 text-accent`;
const MARKETPLACE_REVIEW_SORT_BUTTON_INACTIVE_CLASS_NAME =
  `${MARKETPLACE_REVIEW_SORT_BUTTON_BASE_CLASS_NAME} hover:bg-hover`;
/** 卡片头部(头像 / 标题区 / 操作按钮):卡片窄于 28rem 时允许换行,操作按钮独占下一行。 */
export const MARKETPLACE_CARD_HEADER_CLASS_NAME = 'flex items-start gap-4 @max-md:flex-wrap @max-md:gap-y-3';
export const MARKETPLACE_CARD_ACTION_CLASS_NAME = 'shrink-0 @max-md:basis-full';
const EMPTY_INSTALLED: ReadonlyMap<string, PluginListItem> = new Map();
const EMPTY_MARKETPLACE_ENTRIES: readonly MarketplaceEntry[] = [];
const EMPTY_UPDATE_VERSION_MAP: ReadonlyMap<string, string> = new Map();
const EMPTY_REVIEWS: readonly Review[] = [];

export function marketplaceTagButtonClassName(active: boolean): string {
  return active
    ? MARKETPLACE_TAG_BUTTON_ACTIVE_CLASS_NAME
    : MARKETPLACE_TAG_BUTTON_INACTIVE_CLASS_NAME;
}

export function marketplaceReviewSortButtonClassName(active: boolean): string {
  return active
    ? MARKETPLACE_REVIEW_SORT_BUTTON_ACTIVE_CLASS_NAME
    : MARKETPLACE_REVIEW_SORT_BUTTON_INACTIVE_CLASS_NAME;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ok'; entries: readonly MarketplaceEntry[] }
  | { kind: 'error'; message: string; readonly network: boolean };

interface InstallState {
  /** 正在装的 entry id. */
  busy: string | null;
  /** 安装结果消息(per entry)。a11y(A44):带严重度 → 渲染按语义选 live region。 */
  msgs: ReadonlyMap<string, ResultMsg>;
}

/** 当前已装插件 id → 实时状态(订阅 user plugin manager 的列表变化)。 */
function useInstalledPlugins(): ReadonlyMap<string, PluginListItem> {
  const plugins = useUserPluginList();
  return useMemo(() => {
    if (plugins.length === 0) return EMPTY_INSTALLED;
    const byId = new Map<string, PluginListItem>();
    for (const plugin of plugins) byId.set(plugin.id, plugin);
    return byId;
  }, [plugins]);
}

/**
 * 已装插件的启用结果(BDD: marketplace-tab「启用结果从 PluginManager 实时状态派生」):安装成功只说明已安装,权限被全部
 * 拒绝 / 激活失败时插件并未启用 —— 这里跟随 manager 的实时状态显示,失败按插件页同口径给出本地化原因。
 */
function PluginStateNote({ plugin }: { readonly plugin: PluginListItem | undefined }) {
  const t = useT();
  if (!plugin) return null;
  if (plugin.status === 'failed' && plugin.error) {
    return (
      <div role="alert" data-code={plugin.error.code} className="mt-1 text-2xs text-error">
        {localizePluginError(plugin.error)}
      </div>
    );
  }
  return (
    <div role="status" className="mt-1 text-2xs text-fg-dim">
      {t(plugin.status === 'enabled' ? 'plugins_tab.state.enabled' : 'plugins_tab.state.disabled')}
    </div>
  );
}

export function buildUpdateVersionMap(
  updates: readonly AvailableUpdate[],
): ReadonlyMap<string, string> {
  if (updates.length === 0) return EMPTY_UPDATE_VERSION_MAP;
  const byPid = new Map<string, string>();
  for (const update of updates) byPid.set(update.id, update.to);
  return byPid;
}

export function MarketplaceTab() {
  const t = useT();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const installed = useInstalledPlugins();
  const updates = useAvailableUpdates();
  const dismissUpdate = useUpdateStore((s) => s.dismiss);
  const [install, setInstall] = useState<InstallState>({
    busy: null,
    msgs: new Map(),
  });
  // 刚装成功但 PluginManager 还没扫到的 id(下次启动才入表):与设置页共用会话级 store,切页不丢;落地摘除在 store 层。
  const pending = usePendingInstalls((s) => s.byId);
  // race(R8):同步 in-flight 闸门。install.busy 是 render 后异步状态,同一事件循环内双击
  // install/update 会在 busy 生效前重入 → 双 installFromGit(主进程 lock 要等 clone+manifest
  // 才串行,期间已双 clone)。一次只允许一个安装/更新操作,ref 同步占位。
  const installBusyRef = useRef(false);
  const [query, setQuery] = useState('');
  const searchPlaceholderLabel = t('marketplace.search_placeholder');
  const [selectedTags, setSelectedTags] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const reviewsByPid = useReviewsStore((s) => s.byPid);
  const reviewsLoading = useReviewsStore((s) => s.loading);
  const reviewsError = useReviewsStore((s) => s.error);
  const reviewsUnavailable = useReviewsStore((s) => s.unavailable);
  // 未配置 token 时评分静默不显示;只有用户手动点过「刷新评分」才给中性提示(否则点了没反应无从理解)。
  const [reviewsRefreshClicked, setReviewsRefreshClicked] = useState(false);
  // 索引加载失败后「重试」:递增即重跑拉取 effect(同 QuickOpenModal 扫描失败重试)。
  const [reloadToken, setReloadToken] = useState(0);
  // a11y:「重试」按钮随加载态卸载,焦点会掉到 body。点重试置位,加载中焦点暂放加载状态块,结束后
  // 成功 → 列表区搜索框、再次失败 → 新的「重试」按钮(VSCode 扩展视图刷新后焦点回到搜索框)。首次加载不置位,不抢焦点。
  const focusAfterReloadRef = useRef(false);
  const loadingBlockRef = useRef<HTMLDivElement>(null);
  const errorBlockRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const refreshReviews = useReviewsStore((s) => s.refresh);

  // entry.id → 可用更新版本(若有)。useMemo 让 memo 子组件能受益:
  // updates 由 useAvailableUpdates 记忆化,Array.prototype.map 否则每次 render 创新 Map ref.
  const updateByPid = useMemo(() => {
    return buildUpdateVersionMap(updates);
  }, [updates]);

  // 首次挂载时拉 reviews(打磨 R53:从启动预拉移到这里)。store 持 lastFetchedAt,
  // 已拉过 / 正在拉则跳过,避免重复打 GitHub API;刷新按钮仍走 refreshReviews(true)。
  useEffect(() => {
    const rs = useReviewsStore.getState();
    if (rs.lastFetchedAt === null && !rs.loading) {
      void refreshReviews();
    }
  }, [refreshReviews]);

  // 打开市场页时顺带刷新「可用更新」(remoteVersions):此前只在启动时拉一次,启动时离线则整个会话卡片无更新按钮、
  // 侧栏无角标,直到重启。refresh 自带最新代际守卫(并发 / 过期结果不落库),失败只记日志。
  useEffect(() => {
    void useUpdateStore.getState().refresh();
  }, []);

  useEffect(() => {
    let cancelled = false;
    // 重试时回到加载态(首挂时已是 loading,函数式更新不产生多余渲染)。
    setState((prev) => (prev.kind === 'loading' ? prev : { kind: 'loading' }));
    void (async () => {
      try {
        const entries = await fetchMarketplaceIndex();
        if (!cancelled) setState({ kind: 'ok', entries });
      } catch (err) {
        if (!cancelled) {
          // i18n(I5):fetcher 对可本地化的失败抛稳定 code(MARKETPLACE_INDEX_INVALID),
          // 这里按 errors.<CODE> catalog 翻译;网络/HTTP 等动态错误无 catalog → 回退原文。
          // 网络类失败(MARKETPLACE_NETWORK,断网 / 超时 / HTTP 非 2xx)本地化为「无法连接插件市场」,HTTP 状态码附在详情。
          const raw = errorMessage(err);
          const status = (err as { status?: unknown } | null)?.status;
          const localized = localizeErrorByCode(raw, raw);
          setState({
            kind: 'error',
            message:
              typeof status === 'number'
                ? translate('common.label_detail', { label: localized, detail: `HTTP ${status}` })
                : localized,
            network: raw === MARKETPLACE_NETWORK,
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  useEffect(() => {
    if (!focusAfterReloadRef.current) return;
    if (state.kind === 'loading') {
      loadingBlockRef.current?.focus();
      return;
    }
    focusAfterReloadRef.current = false;
    if (state.kind === 'error') errorBlockRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    else searchInputRef.current?.focus();
  }, [state.kind]);

  // 卡片的「安装」与「更新」是同一流程(同步单飞 → installFromGitLocalized → 结果消息 → pending),只差
  // overwrite 标志与成功 / 失败文案 key(reject 与 ok:false 同走 *_failed_code)。返回是否成功,供调用方做后续。
  // setInstall 函数式更新,不依赖外部 state → 引用稳定,MarketplaceCard memo 不被撑破。
  const runCardInstall = useCallback(
    async (entry: MarketplaceEntry, mode: 'install' | 'update'): Promise<boolean> => {
      // race(R8):同步单飞 —— 同 tick 双击 / install 与 update 并发在 busy state 生效前重入直接挡掉。
      if (installBusyRef.current) return false;
      installBusyRef.current = true;
      setInstall((prev) => ({ ...prev, busy: entry.id }));
      const isUpdate = mode === 'update';
      // 更新 = 原子覆盖安装(overwrite=true)。不再「先卸载后重装」:旧实现一旦卸载成功但重装失败
      // (网络/clone 错),插件就从磁盘消失且无回滚(审计 #2)。overwrite 在 main 端做 staging+rename
      // swap,失败保留旧版本;且保留 _enabled / _permissions,更新后无需重新授权。
      // entryInstallOptions:clone entry.branch(与更新检查读的 manifest 同源)+ main 校验 manifest.id。
      // i18n(复查 P1,I1 同族):失败(含 reject)按稳定 code 经 catalog 翻译,再套本地化外壳。
      // a11y(A85,A84 同族):不把装饰性 ✘ 拼进 message —— 失败严重度由 isError+role=alert 表达。
      const r = await installFromGitLocalized(entryToGitUrl(entry), isUpdate, entryInstallOptions(entry));
      const success = r.ok;
      // 全新安装撞 EEXIST:插件已在盘上但不在本窗口列表(别的窗口刚装、plugins:installed 广播尚未登记到本窗口,或登记
      // 没过准入;待重启记录不跨窗口)→ 如实说明已安装、重启后加载,不报「文件已存在」这类无从下手的错误。
      const alreadyInstalled = !r.ok && r.alreadyInstalled;
      const msg = r.ok
        ? translate(isUpdate ? 'marketplace.update_success' : 'marketplace.install_success', {
            name: r.data.name,
            version: r.data.version,
          })
        : alreadyInstalled
          ? translate('marketplace.install_already_installed', { name: entry.name })
          : // 内部错误码不进用户文案(code 已随 data-code / 日志带走),只显示本地化原因。
            translate(isUpdate ? 'marketplace.update_failed_code' : 'marketplace.install_failed_code', {
              message: r.message,
            });
      installBusyRef.current = false; // race(R8):清同步闸门(与 busy:null 同步)。
      // 已在列表(更新 / 覆盖重装)不记待重启,见 recordPendingInstall。
      if (r.ok) recordPendingInstall(r.data);
      setInstall((prev) => {
        const nextMsgs = new Map(prev.msgs);
        nextMsgs.set(entry.id, { text: msg, isError: !success && !alreadyInstalled });
        return { busy: null, msgs: nextMsgs };
      });
      return success;
    },
    [],
  );

  const onInstall = useCallback(
    async (entry: MarketplaceEntry): Promise<void> => {
      await runCardInstall(entry, 'install');
    },
    [runCardInstall],
  );

  const onUpdate = useCallback(
    async (entry: MarketplaceEntry) => {
      const success = await runCardInstall(entry, 'update');
      // 更新成功后:先乐观收起这条更新,否则在 reload 推进内存版本前(或 reload 失败时)按钮仍在,
      // 用户可重复点击触发对已是最新版的二次 overwrite 安装。可用更新由已安装列表现算,无需再 refresh 对账。
      if (success) {
        dismissUpdate(entry.id);
        // installFromGit 已原子覆盖磁盘,主动 reload 让新版本即时生效(不等 2s mtime watcher);
        // reload 走 per-id 生命周期锁,与 watcher 并发安全。失败时乐观压制仍在,watcher 随后重试。
        getUserPluginManager()
          ?.reload(entry.id)
          .catch((err: unknown) => console.warn('[marketplace] reload after update failed', err));
      }
    },
    [runCardInstall, dismissUpdate],
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
  const entries =
    state.kind === 'ok' ? state.entries : EMPTY_MARKETPLACE_ENTRIES;
  const allTags = useMemo(() => collectAllTags(entries), [entries]);
  const filtered = useMemo(
    () => applyFilter(entries, { query, selectedTags }),
    [entries, query, selectedTags],
  );

  // 「从 Git URL 安装」不依赖市场索引:加载中 / 失败(断网)/ 空索引时同样渲染(VSCode:离线仍可从 VSIX 安装)。
  if (state.kind === 'loading') {
    return withGitUrlSection(
      // a11y(A104,A102 同族):初始索引加载须 role=status 播报具体「正在加载插件市场」语义,
      // Spinner aria-hidden 抑制泛化 Loading(否则 SR 只听通用加载,不知等的是市场索引)。
      // tabIndex=-1:点「重试」后焦点暂放这里(只可程序聚焦,不进 Tab 顺序)。
      <div
        ref={loadingBlockRef}
        tabIndex={-1}
        role="status"
        className="flex h-32 items-center justify-center gap-2 text-fg-dim outline-none"
      >
        <Spinner aria-hidden />
        <span className="text-xs">{t('marketplace.loading')}</span>
      </div>,
    );
  }

  if (state.kind === 'error') {
    return withGitUrlSection(
      // a11y(A66,A41 同族):索引异步加载失败的错误块须 live region(失败 → role=alert/assertive),
      // 否则焦点在面板/搜索入口附近时 SR 用户只感知"无内容",不知是加载失败。
      // 「重试」按钮放在 alert 区外,播报内容只含失败原因与提示。
      <div ref={errorBlockRef} className="rounded border border-line bg-panel-soft/40 p-4 text-xs">
        <div role="alert" className="text-error">
          {t('marketplace.index_fetch_failed', { message: state.message })}
          {/* 网络失败的错误行已写「检查网络后重试」→ 提示换成不重复的补充(索引托管在 GitHub)。 */}
          <div className="mt-1 text-fg-dim">
            {t(state.network ? 'marketplace.index_fetch_hint_network' : 'marketplace.index_fetch_hint')}
          </div>
        </div>
        <Button
          size="sm"
          variant="secondary"
          className="mt-3"
          onClick={() => {
            focusAfterReloadRef.current = true;
            setReloadToken((n) => n + 1);
          }}
        >
          {t('marketplace.retry')}
        </Button>
      </div>,
    );
  }

  if (state.entries.length === 0) {
    return withGitUrlSection(
      // a11y(A67,A56/A66 同族):索引加载成功但为空是一个异步加载结果,焦点停在原控件时 SR 用户
      // 不会获知"市场为空" → role=status(polite 中性空态结果)。失败态用 alert(A66),空态用 status。
      <div
        role="status"
        className="rounded border border-dashed border-line bg-panel-soft/40 px-3 py-6 text-center text-xs text-fg-dim"
      >
        {t('marketplace.empty_index_prefix')}
        <a
          href={`https://github.com/${MARKETPLACE_REPO_SLUG}`}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-1 text-accent hover:underline"
        >
          {MARKETPLACE_REPO_SLUG}
        </a>
      </div>,
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="space-y-2">
        <Input
          ref={searchInputRef}
          size="sm"
          // a11y(A3,A1 同族):placeholder 无参数 → 复用作 aria-label 给屏幕阅读器稳定可访问名。
          aria-label={searchPlaceholderLabel}
          placeholder={searchPlaceholderLabel}
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
            {/* native button:标签行内的 2xs 文本链接,design Button 最小尺寸(sm)也高于标签 chip 行高;颜色走语义 token。 */}
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
      <div className="flex flex-wrap items-center justify-between gap-2 text-2xs text-fg-dim">
        {/* a11y(A55,A53/A54 同族):搜索/标签过滤结果摘要随输入与 tag toggle 动态变化,焦点在
            搜索框/tag 按钮时须 live region(role=status/polite)播报筛选结果数量。 */}
        <span role="status">
          {t('marketplace.count_summary', {
            shown: filtered.length,
            total: state.entries.length,
          })}
        </span>
        {/* native button:摘要行内的紧凑文本按钮(同上,design Button 尺寸不适用);颜色走语义 token。 */}
        <button
          type="button"
          onClick={() => {
            setReviewsRefreshClicked(true);
            void refreshReviews(true);
          }}
          disabled={reviewsLoading}
          // a11y(A93,A51 同族):刷新进行中用 aria-busy 标注按钮忙碌态。
          aria-busy={reviewsLoading}
          className="shrink-0 whitespace-nowrap rounded px-2 py-0.5 text-fg-muted hover:bg-hover hover:text-fg disabled:opacity-50"
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
      {reviewsUnavailable && reviewsRefreshClicked && !reviewsLoading && (
        // 未配置 token 是正常状态:中性提示(非 alert、非错误色),仅在用户主动刷新后出现。
        <div className="text-2xs text-fg-dim" role="status">
          {t('marketplace.reviews.unavailable')}
        </div>
      )}
      {filtered.length === 0 ? (
        // 无结果给下一步:有选中标签才提标签并给「清除筛选」;有搜索词给「清除搜索」(清后焦点回搜索框)。
        <div className="flex flex-col items-center gap-3 rounded border border-dashed border-line bg-panel-soft/40 px-3 py-6 text-center text-xs text-fg-dim">
          <span>
            {selectedTags.size > 0
              ? t('marketplace.no_match')
              : t('marketplace.no_match_query', { query: query.trim() })}
          </span>
          <div className="flex flex-wrap justify-center gap-2">
            {query !== '' && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setQuery('');
                  searchInputRef.current?.focus();
                }}
              >
                {t('marketplace.clear_search')}
              </Button>
            )}
            {selectedTags.size > 0 && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  clearTags();
                  searchInputRef.current?.focus();
                }}
              >
                {t('marketplace.clear_filter')}
              </Button>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((entry) => (
            <MarketplaceCard
              key={entry.id}
              entry={entry}
              installed={installed.has(entry.id) || pending.has(entry.id)}
              pendingRestart={pending.has(entry.id) && !installed.has(entry.id)}
              updateAvailable={updateByPid.get(entry.id) ?? null}
              installing={install.busy === entry.id}
              installDisabled={install.busy !== null && install.busy !== entry.id}
              message={install.msgs.get(entry.id) ?? null}
              plugin={installed.get(entry.id)}
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

function withGitUrlSection(block: ReactNode) {
  return (
    <div className="flex flex-col gap-3">
      {block}
      <GitUrlInstallSection />
    </div>
  );
}

// 从 Git URL 安装段(对齐 demo (3) 扩展商店底部「从 GIT URL 安装」)。
// 走 v4.5 已有的 installFromGit IPC,与 PluginsTabContent 共用同一接口;
// 装好后插件磁盘已就位,需重启 Continuo 后 PluginManager 才扫到。成功同样记待重启(此前不记:装了市场里也有的插件后
// 卡片仍给「安装」,点击 main 抛 EEXIST)。
function GitUrlInstallSection() {
  const t = useT();
  // a11y(A43,A42 同族):结果消息带严重度 → 渲染时按语义选 live region(成功 status/失败 alert)。
  const [msg, setMsg] = useState<ResultMsg | null>(null);
  // 最近一次成功安装的插件 id:其后显示它的实时启用结果(PluginStateNote)。
  const [installedId, setInstalledId] = useState<string | null>(null);
  const plugins = useUserPluginList();

  const install = async (url: string): Promise<boolean> => {
    setMsg(null);
    setInstalledId(null);
    // 同卡片安装:失败(含 reject)按 code 本地化;不把 ✘ 拼进 alert 文本(severity 由 isError+role=alert 表达)。
    const r = await installFromGitLocalized(url);
    if (!r.ok) {
      setMsg(
        r.alreadyInstalled
          ? { text: translate('marketplace.install_already_installed', { name: repoNameFromGitUrl(url) }), isError: false }
          : { text: translate('marketplace.install_failed_code', { message: r.message }), isError: true },
      );
      return false;
    }
    setMsg({
      text: translate('marketplace.install_success', {
        name: r.data.name,
        version: r.data.version,
      }),
      isError: false,
    });
    setInstalledId(r.data.id);
    recordPendingInstall(r.data);
    return true;
  };

  return (
    <section className="mt-6 border-t border-line/30 pt-6">
      <h3 className="text-base font-medium text-fg">
        {t('marketplace.git_url_section_title')}
      </h3>
      <p className="mt-1 text-xs text-fg-muted">
        {t('marketplace.git_url_section_hint')}
      </p>
      <GitUrlInstallForm
        // a11y(A5 同族):placeholder 是 URL 示例非标签 → 用 section 标题作 aria-label。
        ariaLabel={t('marketplace.git_url_section_title')}
        placeholder="https://github.com/user/plugin-repo.git"
        installLabel={t('marketplace.install_extension')}
        installingLabel={t('marketplace.installing')}
        install={install}
      />
      {/* a11y(A43,A42 同族):异步安装结果须 live region 主动播报。 */}
      <ResultMessage msg={msg} className="mt-2 text-xs text-fg-muted" />
      <PluginStateNote plugin={installedId === null ? undefined : plugins.find((p) => p.id === installedId)} />
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
    // native button:标签 chip 是 aria-pressed 的多选 toggle,design 无对应组件(SegmentedControl 是单选);颜色走语义 token。
    <button
      type="button"
      // a11y(A8):tag filter 是 toggle,active 只改 className → 补 aria-pressed 暴露选中态给 AT。
      aria-pressed={active}
      onClick={() => onToggle(tag)}
      className={marketplaceTagButtonClassName(active)}
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
  message: ResultMsg | null;
  /** 已在插件列表时的实时状态(启用 / 禁用 / 失败原因)。 */
  plugin: PluginListItem | undefined;
  /** 评分聚合(reviews Phase 1),null 或 count=0 不显. */
  rating: PluginAggregateRating | null;
  /** 父组件 useCallback 稳定;card 内 onClick 闭包 entry 给它. */
  onInstall: (entry: MarketplaceEntry) => void | Promise<void>;
  onUpdate: (entry: MarketplaceEntry) => void | Promise<void>;
}

/** 把 0-5 平均分渲染成 5 个 ★/☆,半星向就近整数.
 *  调用点用 `text-rating` 着色:评分星级业内约定琥珀色,与 warning 语义不同(rating ≠ warning),
 *  故用 Continuo 自有槽位 --md-rating(theme.css,亮 / 暗各自取值保证 ≥ 4.5:1;原 Tailwind amber 400
 *  在亮色底仅 1.63:1)。 */
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
  plugin,
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
    // @container:卡片按自身宽度排版 —— 窄于 28rem 时操作按钮换到下一行、窄于 24rem 隐藏首字头像,
    // 避免按钮盖住 Verified 徽标、id / 仓库链接画出卡片、描述一行一个词。
    <div className="@container rounded-md border border-line bg-panel-soft/40 p-4 transition-colors hover:bg-panel-soft/70">
      <div className={MARKETPLACE_CARD_HEADER_CLASS_NAME}>
        <div
          aria-hidden="true"
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md border border-line bg-canvas text-base font-semibold uppercase text-fg-dim @max-sm:hidden"
        >
          {entry.name.charAt(0)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="min-w-0 break-words font-medium text-fg">{entry.name}</span>
            {entry.verified && (
              <Badge
                size="xs"
                variant="accent-soft"
                className="gap-1"
                title={t('marketplace.reviews.official_review')}
              >
                {/* a11y(A72 同族装饰符号):"Verified" 文本已表义,勾 ✓ 纯视觉 → aria-hidden,
                    否则 SR 额外读出 checkmark 造成徽标名称噪声。 */}
                <span aria-hidden="true">✓</span> {t('marketplace.verified')}
              </Badge>
            )}
            <code className="min-w-0 max-w-full truncate text-2xs text-fg-dim" title={entry.id}>
              {entry.id}
            </code>
          </div>
          {entry.description && (
            <p className="mt-0.5 text-xs text-fg-dim">{entry.description}</p>
          )}
        </div>
        <div className={MARKETPLACE_CARD_ACTION_CLASS_NAME}>
          {/* 进行中 / 已安装用 aria-disabled 而非原生 disabled:按钮保持可聚焦(三个分支同位同类型,React 复用同一 DOM
              节点 → 安装中 → 已安装焦点一直在它上面);重复点击由 runCardInstall 的同步单飞闸门挡掉。 */}
          {installed && updateAvailable && !pendingRestart ? (
            <Button
              variant="primary"
              size="sm"
              onClick={handleUpdate}
              aria-disabled={installing || installDisabled}
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
              aria-disabled
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
              aria-disabled={installing || installDisabled}
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
      {/* a11y(A44,A42/A43 同族):卡片级安装/更新结果须 live region 主动播报。 */}
      <ResultMessage msg={message} className="mt-1 text-2xs text-fg-muted" />
      <PluginStateNote plugin={plugin} />
      <RatingRow entry={entry} rating={rating} />

      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-2xs text-fg-dim">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
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
            <span className="flex flex-wrap gap-1">
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
          className="min-w-0 max-w-full truncate text-accent hover:underline"
          title={entry.repo}
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
  const sourceReviews = ratingReviews ?? EMPTY_REVIEWS;
  // 仅在卡片展开时才排序/截断(打磨 R41):sorted 只在 expanded 分支渲染,Marketplace
  // 列表大多数卡片默认折叠,无须为不可见 review 排序 + 复制数组。
  const sorted = useMemo(
    () =>
      expanded && hasReviews
        ? selectDisplayReviews(sourceReviews, sort)
        : EMPTY_REVIEWS,
    [expanded, hasReviews, sourceReviews, sort],
  );
  // 展开区同一次 render 复用同一个 now 快照;避免每条 ReviewItem 分别 Date.now().
  const reviewNowMs = expanded ? Date.now() : 0;

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
        {/* native button:评分摘要整行作为展开触发器(内含星标 + 文本),非 design Button 的形态;颜色走语义 token。 */}
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
            className="text-rating"
            aria-label={t('marketplace.reviews.stars_aria', { avg: rating.avg.toFixed(1) })}
          >
            {renderStars(rating.avg)}
          </span>
          <span>{rating.avg.toFixed(1)}</span>
          <span className="text-fg-dim">
            {translateCount('marketplace.reviews.count', rating.count)}
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
            {REVIEW_SORTS.map((s) => (
              // native button:2xs 行内排序切换(aria-pressed),design SegmentedControl 的 sm 尺寸仍大于评论列表行高。
              <button
                key={s}
                type="button"
                // a11y(A16,A8 同族):排序 toggle 组当前项只改 className → 补 aria-pressed 暴露
                // 给 AT(单选组,pressed 项即当前排序)。
                aria-pressed={sort === s}
                onClick={() => setSort(s)}
                className={marketplaceReviewSortButtonClassName(sort === s)}
              >
                {s === 'newest'
                  ? t('marketplace.reviews.sort_newest')
                  : t('marketplace.reviews.sort_helpful')}
              </button>
            ))}
          </div>
          {sorted.map((r) => (
            <ReviewItem key={r.url} review={r} nowMs={reviewNowMs} />
          ))}
          {rating.reviews.length > REVIEW_DISPLAY_LIMIT && (
            <div className="pt-1 text-2xs text-fg-dim">
              {t('marketplace.reviews.show_first_10')}
              <a
                href={`https://github.com/${MARKETPLACE_REPO_SLUG}/discussions?discussions_q=%5B${entry.id}%5D`}
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

function ReviewItem({ review: r, nowMs }: { review: Review; nowMs: number }) {
  const t = useT();
  const isMaintainer = MAINTAINERS.has(r.author.handle);
  const avatarUrl = isHttpUrl(r.author.avatarUrl) ? r.author.avatarUrl : null;
  // 边界(E270,E253 续 / 信任信号防绕过):author.createdAt 经 E253 校验为 string + 长度,但未保证可解析为
  // 日期。畸形值(如 "not-a-date")→ getTime() 为 NaN → accountAge 为 NaN → `NaN < NEW_ACCOUNT_MS` 为
  // false → 新账号 badge 被静默绕过(新账号靠损坏 createdAt 规避风险提示)。**不可解析 = 保守视为新账号**
  // (未知账龄 = 假定风险,显 badge)。注:不在数据层把畸形 createdAt 兜底成 epoch —— epoch 解析为很旧账号
  // → 反而绕过 badge,会重新打开本漏洞;故在此 UI 判定处用 Number.isFinite 兜底为"新"。
  const isNewAccount = isNewAccountCreatedAt(r.author.createdAt, nowMs);

  return (
    <div className="flex gap-2 border-b border-line/50 pb-1.5 last:border-0 last:pb-0">
      {avatarUrl ? (
        <img
          src={avatarUrl}
          alt=""
          loading="lazy"
          decoding="async"
          className="h-5 w-5 shrink-0 rounded-full"
        />
      ) : (
        <span
          aria-hidden="true"
          className="h-5 w-5 shrink-0 rounded-full bg-panel-soft"
        />
      )}
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
            <Badge
              size="xs"
              variant="accent-soft"
              className="gap-1"
              title={t('marketplace.reviews.maintainer')}
            >
              {/* a11y(A92,A88 同族):视觉盾牌 🛡 纯装饰,catalog 已去符号 → aria-hidden;
                  "维护者"文本已表义。 */}
              <span aria-hidden="true">🛡</span>{' '}
              {t('marketplace.reviews.maintainer_badge')}
            </Badge>
          )}
          {!isMaintainer && isNewAccount && (
            <Badge
              size="xs"
              variant="warning-soft"
              className="gap-1"
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
            </Badge>
          )}
          <span
            className="text-rating"
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
              title={translateCount('marketplace.reviews.thumbs_up', r.thumbsUp)}
            >
              {/* a11y(A39):👍+数字仅视觉;语义用视觉隐藏的本地化文本给 AT(文本流可读)。 */}
              <span aria-hidden="true">👍 {r.thumbsUp}</span>
              <span style={SR_ONLY_STYLE}>
                {translateCount('marketplace.reviews.thumbs_up', r.thumbsUp)}
              </span>
            </span>
          )}
          <span className="text-fg-dim">{formatDateAt(r.createdAt, nowMs)}</span>
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

function compareHelpfulReviews(a: Review, b: Review): number {
  if (a.thumbsUp !== b.thumbsUp) return b.thumbsUp - a.thumbsUp;
  if (a.createdAt === b.createdAt) return 0;
  return a.createdAt > b.createdAt ? -1 : 1;
}

export function selectDisplayReviews(
  reviews: readonly Review[],
  sort: ReviewSort,
): readonly Review[] {
  const limit = REVIEW_DISPLAY_LIMIT;
  if (reviews.length === 0) return EMPTY_REVIEWS;
  if (reviews.length === 1) return reviews;
  // newest:fetcher 已 createdAt DESC,只需取可见前 N 条。
  if (sort === 'newest') {
    if (reviews.length <= limit) return reviews;
    const visible = new Array<Review>(limit);
    for (let i = 0; i < limit; i++) {
      visible[i] = reviews[i]!;
    }
    return visible;
  }

  // helpful:只维护最多 N 条有序窗口,避免为只渲染前 10 条复制并全量排序
  // 最多 2000 条 reviews。平手时 compare=0 保持原输入顺序(与稳定 sort 等价)。
  if (reviews.length <= limit) {
    let alreadySorted = true;
    for (let i = 1; i < reviews.length; i++) {
      if (compareHelpfulReviews(reviews[i - 1]!, reviews[i]!) > 0) {
        alreadySorted = false;
        break;
      }
    }
    if (alreadySorted) return reviews;
  }

  const top = new Array<Review>(Math.min(limit, reviews.length));
  let topCount = 0;
  for (const review of reviews) {
    if (topCount === 0) {
      top[0] = review;
      topCount = 1;
      continue;
    }
    if (
      topCount === limit &&
      compareHelpfulReviews(review, top[topCount - 1]!) >= 0
    ) {
      continue;
    }
    let insertAt = topCount;
    while (
      insertAt > 0 &&
      compareHelpfulReviews(review, top[insertAt - 1]!) < 0
    ) {
      insertAt -= 1;
    }
    const moveFrom = topCount < limit ? topCount : limit - 1;
    for (let i = moveFrom; i > insertAt; i--) {
      top[i] = top[i - 1]!;
    }
    top[insertAt] = review;
    if (topCount < limit) topCount += 1;
  }
  top.length = topCount;
  return top;
}

/** 跳 GitHub 写新评论(预填 title 含 plugin id). */
function buildNewReviewUrl(pluginId: string): string {
  const title = encodeURIComponent(`[${pluginId}] `);
  return `https://github.com/${MARKETPLACE_REPO_SLUG}/discussions/new?category=general&title=${title}`;
}

export function isNewAccountCreatedAt(createdAt: string, nowMs: number): boolean {
  const createdAtMs = Date.parse(createdAt);
  return !Number.isFinite(createdAtMs) || nowMs - createdAtMs < NEW_ACCOUNT_MS;
}

/** 简单 friendly 日期。formatDateAt 是 module helper,不在 React tree,
 *  调 translate() 直读 module-level locale state (topic-19 pattern). */
export function formatDateAt(iso: string, nowMs: number): string {
  const createdAtMs = Date.parse(iso);
  if (!Number.isFinite(createdAtMs)) return iso;
  const ms = nowMs - createdAtMs;
  const min = Math.floor(ms / 60_000);
  if (min < 60) return min <= 0 ? translate('marketplace.time.now') : translate('marketplace.time.minutes_ago', { n: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return translate('marketplace.time.hours_ago', { n: hr });
  const day = Math.floor(hr / 24);
  if (day < 30) return translate('marketplace.time.days_ago', { n: day });
  return iso.slice(0, 10);
}
