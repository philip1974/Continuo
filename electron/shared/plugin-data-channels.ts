export const PLUGIN_DATA_CHANNELS = {
  LOAD: 'plugin-data:load',
  SAVE: 'plugin-data:save',
  /**
   * perf:args = (pluginId, serializedValue: string) —— value 的 JSON 文本(renderer 字节预检时已算好)。
   * main 落盘 `{"value":<serializedValue>}`,与 SAVE(pluginId, { value }) 字节一致;
   * 结构化克隆一个字符串远快于克隆整棵对象图。
   */
  SAVE_SERIALIZED: 'plugin-data:save-serialized',
  CLEAR: 'plugin-data:clear',
} as const;
