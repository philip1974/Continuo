# shell-stream-event-parse (E175)

plugin-shell-stream:event payload 解析守卫(preload handler 复用)。分类:invalid(收敛本 stream)/ exit / chunk;
归属(无主畸形 payload、非本窗口活跃流)由 preload 的单 listener 分发器先行判定并丢弃。IPC ingress 纵深防御族(E168-E175),防畸形事件让 preload
listener 抛或喂错 chunk/exitInfo 给插件 stream。
