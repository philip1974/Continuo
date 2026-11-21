import { useT } from '@/i18n';

export function Output() {
  // i18n(I15,I14 同类硬编码 UI):状态文案走 catalog,zh/ko 不再显英文。`[info]` 是
  // 语言无关的日志级别标记,保留字面;消息部分用 useT 本地化(响应 locale)。
  const t = useT();
  return (
    <div className="h-full w-full overflow-auto p-3 font-mono text-xs text-fg">
      <div className="text-fg-dim">[info] {t('panels.output.ready')}</div>
      <div className="text-fg-dim">
        [info] {t('panels.output.layout_restored')}
      </div>
    </div>
  );
}
