// 设置页「受信任的域」(VSCode「Manage Trusted Domains」:受信域名列表,默认项只读)。
// 值在 main(外链确认在 main 判定,确认框里的「信任 <域名>」由 main 写入):挂载时读,订阅 main 的变更广播,增删经 IPC 整体替换。
// BDD: src/__tests__/external-link-trusted-domains/

import { useEffect, useState, type FormEvent } from 'react';
import { Badge, Button, IconButton, Input } from '@/design';
import { useT } from '@/i18n';
import { coApi } from '@/lib/co-api';
import { CloseIcon } from '@/lib/ui-icons';
import { notifyFailure, notifyThrownError } from '@/notifications/notify-thrown-error';
import type { SettingItemSpec } from '../registries/SettingItemRegistry';
import { SETTING_ROW_LAYOUT_CLASS_NAME } from './SettingItemRow';
import { TRUSTED_DOMAIN_MAX_LEN } from '../../../electron/shared/trusted-domains';

export function TrustedDomainsSettingRow({ spec }: { readonly spec: SettingItemSpec }) {
  const t = useT();
  const title = spec.titleKey ? t(spec.titleKey) : spec.title;
  const description = spec.descriptionKey ? t(spec.descriptionKey) : spec.description;
  const titleId = `setting-title-${spec.id}`;
  const [defaults, setDefaults] = useState<readonly string[]>([]);
  const [user, setUser] = useState<readonly string[]>([]);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    let alive = true;
    // 订阅失败(API 未注入等)不影响读取与编辑,只是看不到别处的实时变更
    let off = (): void => {};
    try {
      off = coApi.shell.onTrustedDomainsChanged((list) => setUser(list));
    } catch (err) {
      console.warn('[settings] trusted domains subscribe failed', err);
    }
    void Promise.resolve()
      .then(() => coApi.shell.getTrustedDomains())
      .then((r) => {
        if (!alive) return;
        if (!r.ok) return notifyFailure(r);
        setDefaults(r.data.defaults);
        setUser(r.data.user);
      })
      .catch((err: unknown) => {
        if (alive) notifyThrownError(err);
      });
    return () => {
      alive = false;
      off();
    };
  }, []);

  const save = async (next: readonly string[]): Promise<boolean> => {
    try {
      const r = await coApi.shell.setTrustedDomains(next);
      if (!r.ok) {
        notifyFailure(r);
        return false;
      }
      setUser(r.data);
      return true;
    } catch (err) {
      notifyThrownError(err);
      return false;
    }
  };

  const add = (e: FormEvent) => {
    e.preventDefault();
    const value = draft.trim();
    if (value === '') return;
    void save([...user, value]).then((ok) => ok && setDraft(''));
  };

  return (
    <div
      tabIndex={-1}
      data-setting-row={spec.id}
      className="group/setting @container relative border-b border-line/50 py-5 outline-none last:border-b-0"
    >
      <div className={SETTING_ROW_LAYOUT_CLASS_NAME}>
        <div className="min-w-0 max-w-full flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span id={titleId} className="min-w-0 break-words text-sm text-fg">
              {title}
            </span>
            <Badge size="xs" className="min-w-0 max-w-full">
              <code className="min-w-0 truncate" title={spec.id}>
                {spec.id}
              </code>
            </Badge>
          </div>
          {description && <div className="mt-1 text-xs text-fg-muted">{description}</div>}
        </div>
        <div className="flex w-80 min-w-0 max-w-full shrink-0 flex-col gap-2">
          <ul aria-labelledby={titleId} className="flex flex-col gap-1">
            {defaults.map((d) => (
              <li key={`default:${d}`} className="flex min-h-6 items-center gap-2 text-xs text-fg-muted">
                <code className="min-w-0 flex-1 break-all font-mono">{d}</code>
                <Badge size="xs">{t('settings.trusted_domains.default_badge')}</Badge>
              </li>
            ))}
            {user.map((d) => (
              <li key={`user:${d}`} className="flex min-h-6 items-center gap-2 text-xs text-fg">
                <code className="min-w-0 flex-1 break-all font-mono">{d}</code>
                <IconButton
                  size="xs"
                  title={t('settings.trusted_domains.remove', { domain: d })}
                  aria-label={t('settings.trusted_domains.remove', { domain: d })}
                  onClick={() => void save(user.filter((x) => x !== d))}
                >
                  <CloseIcon size={12} />
                </IconButton>
              </li>
            ))}
            {user.length === 0 && (
              <li className="text-xs text-fg-dim">{t('settings.trusted_domains.empty')}</li>
            )}
          </ul>
          <form className="flex min-w-0 items-center gap-2" onSubmit={add}>
            <Input
              type="text"
              size="sm"
              aria-label={t('settings.trusted_domains.input_label')}
              placeholder={t('settings.trusted_domains.placeholder')}
              maxLength={TRUSTED_DOMAIN_MAX_LEN}
              value={draft}
              onChange={(e) => setDraft((e.target as HTMLInputElement).value)}
              className="min-w-0 flex-1"
            />
            <Button type="submit" size="sm" variant="secondary" disabled={draft.trim() === ''}>
              {t('settings.trusted_domains.add')}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
