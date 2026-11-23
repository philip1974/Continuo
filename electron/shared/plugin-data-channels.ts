export const PLUGIN_DATA_CHANNELS = {
  LOAD: 'plugin-data:load',
  /**
   * 保存:args = (pluginId, serializedValue: string) —— value 的 JSON 文本(renderer 字节预检时已算好)。
   * main 落盘 `{"value":<serializedValue>}`;
   * 结构化克隆一个字符串远快于克隆整棵对象图。
   */
  SAVE_SERIALIZED: 'plugin-data:save-serialized',
} as const;
