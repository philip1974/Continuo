// 带严重度的异步操作结果消息(插件安装 / 卸载 / 更新等)。a11y(A42-A44):结果须经 live region 主动播报 ——
// 失败 role=alert(assertive),成功 role=status(polite)。设置 → 插件、插件商店 Git URL 段与卡片三处共用。

export interface ResultMsg {
  readonly text: string;
  readonly isError: boolean;
}

export function ResultMessage({
  msg,
  className,
}: {
  readonly msg: ResultMsg | null;
  readonly className: string;
}) {
  if (!msg) return null;
  return (
    <div className={className} role={msg.isError ? 'alert' : 'status'}>
      {msg.text}
    </div>
  );
}
