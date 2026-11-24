// renderer 入口:动态 import main-app 并启动。严格 m.init() 调用(不用 m.init?.())。
void import('./main-app').then((m) => m.init());

export {};
