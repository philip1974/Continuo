#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXPECTED_JS_DEBUG_SHA256 =
  'ad8d04ede9d4b75cc290fd5438a65047a06f786d04f604b6112485b36f090772';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultAdapterPath = path.join(
  scriptDir,
  '.adapter',
  'js-debug',
  'src',
  'dapDebugServer.js',
);

export function encodeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
  return Buffer.concat([header, body]);
}

export class StreamDecoder {
  #buffer = Buffer.alloc(0);

  push(chunk) {
    const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.#buffer = Buffer.concat([this.#buffer, input]);
    const messages = [];

    while (true) {
      const headerEnd = this.#buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return messages;

      const header = this.#buffer.subarray(0, headerEnd).toString('ascii');
      const contentLength = parseContentLength(header);
      const bodyStart = headerEnd + 4;
      const frameEnd = bodyStart + contentLength;
      if (this.#buffer.length < frameEnd) return messages;

      const body = this.#buffer.subarray(bodyStart, frameEnd).toString('utf8');
      messages.push(JSON.parse(body));
      this.#buffer = this.#buffer.subarray(frameEnd);
    }
  }
}

function parseContentLength(header) {
  for (const line of header.split('\r\n')) {
    const match = /^Content-Length:\s*(\d+)$/i.exec(line);
    if (match) return Number.parseInt(match[1], 10);
  }
  throw new Error(`DAP frame missing Content-Length header: ${header}`);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createSocketPath() {
  if (process.platform === 'win32') return null;
  const baseDir = os.tmpdir().length < 60 ? os.tmpdir() : '/tmp';
  const socketPath = path.join(
    baseDir,
    `continuo-dap-${process.pid}-${Date.now()}.sock`,
  );
  if (socketPath.length > 100) {
    return path.join('/tmp', `cdap-${process.pid}-${Date.now()}.sock`);
  }
  return socketPath;
}

function randomTcpPort() {
  return 20_000 + Math.floor(Math.random() * 30_000);
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class DapClient {
  constructor(options = {}) {
    this.adapterPath = options.adapterPath ?? defaultAdapterPath;
    this.nodePath = options.nodePath ?? process.execPath;
    this.readyTimeoutMs = options.readyTimeoutMs ?? 15_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 20_000;
    this.connectIntervalMs = options.connectIntervalMs ?? 100;
    this.socketPath = options.socketPath ?? createSocketPath();
    this.tcpPort = options.tcpPort ?? randomTcpPort();
    this.transcript = options.transcript ?? [];
    this.server = null;
    this.socket = null;
    this.seq = 1;
    this.pending = new Map();
    this.eventHandlers = new Map();
    this.decoder = new StreamDecoder();
    this.serverStderr = '';
    this.childSessions = [];
    this.startDebuggingHandler = options.startDebuggingHandler ?? null;
  }

  async spawnServer() {
    const endpoint = this.socketPath ?? String(this.tcpPort);
    if (!endpoint) {
      throw new Error('no DAP endpoint configured');
    }

    if (this.socketPath) {
      await fs.rm(this.socketPath, { force: true });
    }

    this.server = spawn(this.nodePath, [this.adapterPath, endpoint], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });

    this.server.stderr?.on('data', (chunk) => {
      this.serverStderr += chunk.toString('utf8');
    });
    this.server.stdout?.on('data', (chunk) => {
      this.transcript.push({ direction: 'server-stdout', text: chunk.toString('utf8') });
    });
    this.server.once('exit', (code, signal) => {
      this.rejectAllPending(new Error(`DAP server exited code=${code} signal=${signal}`));
    });

    this.socket = await this.waitForReady();
    this.attachSocket(this.socket);
    return this;
  }

  async connectToServer() {
    this.socket = await this.connectOnce();
    this.attachSocket(this.socket);
    return this;
  }

  createChildSession(options = {}) {
    const child = new DapClient({
      adapterPath: this.adapterPath,
      nodePath: this.nodePath,
      readyTimeoutMs: this.readyTimeoutMs,
      requestTimeoutMs: this.requestTimeoutMs,
      connectIntervalMs: this.connectIntervalMs,
      socketPath: this.socketPath,
      tcpPort: this.tcpPort,
      transcript: this.transcript,
      ...options,
    });
    this.childSessions.push(child);
    return child;
  }

  setStartDebuggingHandler(handler) {
    this.startDebuggingHandler = handler;
  }

  async waitForReady() {
    const deadline = Date.now() + this.readyTimeoutMs;
    let lastError;

    while (Date.now() < deadline) {
      try {
        return await this.connectOnce();
      } catch (err) {
        lastError = err;
        await sleep(this.connectIntervalMs);
      }
    }

    const detail = lastError ? ` last error: ${lastError.message}` : '';
    throw new Error(
      `DAP server readiness timed out after ${this.readyTimeoutMs}ms.${detail}\nserver stderr:\n${this.serverStderr}`,
    );
  }

  connectOnce() {
    return new Promise((resolve, reject) => {
      const socket = this.socketPath
        ? net.connect(this.socketPath)
        : net.connect({ port: this.tcpPort, host: '127.0.0.1' });
      socket.once('connect', () => resolve(socket));
      socket.once('error', (err) => {
        socket.destroy();
        reject(err);
      });
    });
  }

  attachSocket(socket) {
    socket.on('data', (chunk) => {
      for (const message of this.decoder.push(chunk)) {
        this.receiveMessage(message);
      }
    });
    socket.on('error', (err) => this.rejectAllPending(err));
    socket.on('close', () => {
      this.rejectAllPending(new Error('DAP socket closed'));
    });
  }

  on(eventName, callback) {
    const callbacks = this.eventHandlers.get(eventName) ?? new Set();
    callbacks.add(callback);
    this.eventHandlers.set(eventName, callbacks);
    return () => callbacks.delete(callback);
  }

  waitForEvent(eventName, timeoutMs = this.requestTimeoutMs) {
    return withTimeout(
      new Promise((resolve) => {
        const off = this.on(eventName, (event) => {
          off();
          resolve(event);
        });
      }),
      timeoutMs,
      `event ${eventName}`,
    );
  }

  sendRequest(command, args = {}, timeoutMs = this.requestTimeoutMs) {
    const request = this.createRequest(command, args);
    const response = withTimeout(
      new Promise((resolve, reject) => {
        this.pending.set(request.seq, { resolve, reject });
      }),
      timeoutMs,
      `request ${command}`,
    );
    this.sendMessage(request);
    return response;
  }

  sendRequestNoWait(command, args = {}) {
    const request = this.createRequest(command, args);
    this.sendMessage(request);
    return request.seq;
  }

  createRequest(command, args) {
    return {
      seq: this.seq++,
      type: 'request',
      command,
      arguments: args,
    };
  }

  sendMessage(message) {
    if (!this.socket || this.socket.destroyed) {
      throw new Error('DAP socket is not connected');
    }
    this.transcript.push({ direction: 'client', message });
    this.socket.write(encodeMessage(message));
  }

  receiveMessage(message) {
    this.transcript.push({ direction: 'server', message });
    if (message.type === 'response') {
      const pending = this.pending.get(message.request_seq);
      if (!pending) return;
      this.pending.delete(message.request_seq);
      if (message.success === false) {
        pending.reject(new Error(message.message ?? `DAP request ${message.request_seq} failed`));
      } else {
        pending.resolve(message);
      }
      return;
    }

    if (message.type === 'event') {
      const callbacks = this.eventHandlers.get(message.event);
      if (!callbacks) return;
      for (const callback of callbacks) callback(message);
      return;
    }

    if (message.type === 'request') {
      void this.respondToReverseRequest(message);
    }
  }

  async respondToReverseRequest(message) {
    if (message.command === 'startDebugging' && this.startDebuggingHandler) {
      try {
        const body = await this.startDebuggingHandler(message, this);
        this.sendMessage({
          seq: this.seq++,
          type: 'response',
          request_seq: message.seq,
          command: message.command,
          success: true,
          body: body ?? {},
        });
      } catch (err) {
        this.sendMessage({
          seq: this.seq++,
          type: 'response',
          request_seq: message.seq,
          command: message.command,
          success: false,
          message: err.message,
        });
      }
      return;
    }

    const unsupported = message.command !== 'runInTerminal';
    this.sendMessage({
      seq: this.seq++,
      type: 'response',
      request_seq: message.seq,
      command: message.command,
      success: !unsupported,
      message: unsupported ? `unsupported reverse request: ${message.command}` : undefined,
      body: unsupported ? undefined : {},
    });
  }

  rejectAllPending(err) {
    for (const { reject } of this.pending.values()) {
      reject(err);
    }
    this.pending.clear();
  }

  async dispose() {
    await Promise.all(
      this.childSessions.map((child) => child.dispose().catch(() => undefined)),
    );
    this.childSessions = [];
    if (this.socket && !this.socket.destroyed) {
      this.socket.destroy();
    }
    if (this.server && this.server.exitCode === null && this.server.signalCode === null) {
      this.server.kill('SIGTERM');
      const exited = Promise.race([
        once(this.server, 'exit'),
        sleep(1_000).then(() => 'timeout'),
      ]);
      if ((await exited) === 'timeout') {
        this.server.kill('SIGKILL');
      }
    }
    if (this.socketPath) {
      await fs.rm(this.socketPath, { force: true });
    }
  }
}

export { defaultAdapterPath };
