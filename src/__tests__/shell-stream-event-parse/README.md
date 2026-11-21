# shell-stream-event-parse (E175)

plugin-shell-stream:event payload 解析守卫(preload handler 复用)。分类:not-ours / unattributable /
invalid(收敛本 stream)/ exit / chunk。IPC ingress 纵深防御族(E168-E175),防畸形事件让 preload
listener 抛或喂错 chunk/exitInfo 给插件 stream。
