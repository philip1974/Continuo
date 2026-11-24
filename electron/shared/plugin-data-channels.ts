export const PLUGIN_DATA_CHANNELS = {
  LOAD: 'plugin-data:load',
  /**
   * 保存:args = (pluginId, serializedValue: string) —— value 的 JSON 文本(renderer 字节预检时已算好)。
   * main 落盘 `{"value":<serializedValue>}`;
   * 结构化克隆一个字符串远快于克隆整棵对象图。
   */
  SAVE_SERIALIZED: 'plugin-data:save-serialized',
  /**
   * main → renderer 推送 `{ id }`:某插件 data.json 落盘成功(发给发起窗口以外的窗口)。每个主窗口各缓存一份
   * 插件数据、插件整份读-改-写,收到后须失效本窗缓存,否则陈旧窗口的整份写会抹掉别窗刚保存的改动。
   */
  CHANGED: 'plugin-data:changed',
} as const;
