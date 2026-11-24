// mock `node:child_process` 的 spawn 时返回的假子进程(stdout / stderr / stdin 事件源 + 退出态 + kill)。
// 在 vi.mock 工厂的 spawn 闭包里使用(调用时才取值,不受 vi.mock 提升影响)。
// electron/ 下测试不能从 src/ 导入(process-layering),故放在 electron 侧。
import { EventEmitter } from 'node:events';

export class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = Object.assign(new EventEmitter(), { write() {}, end() {} });
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill(): boolean {
    return true;
  }
}
