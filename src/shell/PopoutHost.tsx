// dockview popout 子窗口的根组件。dockview 自己会把 panel portal 到 body 下的
// dv-popout-window 容器,我们这边只负责给一层一致的深色底,避免 React #root
// 留下默认背景。
export function PopoutHost() {
  return <div className="fixed inset-0 -z-10 bg-[#020617]" data-testid="popout-host" />;
}
