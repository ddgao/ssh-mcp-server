import crypto from 'crypto';
import { Client, ClientChannel } from 'ssh2';
import { Logger } from '../utils/logger.js';
import { ToolError } from '../utils/tool-error.js';

// --- 纯函数：ANSI 解析和服务器列表提取 ---

export interface ServerEntry {
  index: number;
  name: string;
  host: string;
  protocol: string;
  username: string;
  group?: string;
}

/** 移除 ANSI 转义序列 */
export function stripAnsi(str: string): string {
  return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
}

/** 从 GateShell 原始输出解析服务器列表 */
export function parseServerList(rawOutput: string): ServerEntry[] {
  const clean = stripAnsi(rawOutput);
  const re = /(\d{3}):\s+(\S+)\s+(\S+:\d+)\s+(\S+)\s+(\S+)(?:\s+(\S+))?/;
  const entries: ServerEntry[] = [];
  for (const line of clean.split('\n')) {
    const m = line.match(re);
    if (m) {
      entries.push({
        index: parseInt(m[1], 10),
        name: m[2],
        host: m[3],
        protocol: m[4],
        username: m[5],
        group: m[6],
      });
    }
  }
  return entries;
}

// --- GateShellManager 类 ---

export class GateShellManager {
  private channel: ClientChannel | null = null;
  private connectedToServer = false;
  private cachedServerList: ServerEntry[] = [];
  private readonly sessionId = crypto.randomUUID();

  constructor(private readonly sshClient: Client) {}

  /** 读取 channel 数据直到匹配指定文本，返回累积的输出 */
  async readUntil(marker: string, timeoutMs = 30000): Promise<string> {
    if (!this.channel) {
      throw new ToolError('GATESHELL_NOT_CONNECTED', 'No channel available');
    }
    return new Promise<string>((resolve, reject) => {
      let buf = '';
      const ch = this.channel!;
      const timer = setTimeout(() => {
        ch.removeAllListeners('data');
        reject(new ToolError('GATESHELL_PARSE_TIMEOUT', `Timeout waiting for "${marker}"`));
      }, timeoutMs);

      const onData = (data: Buffer) => {
        buf += data.toString('utf-8');
        if (buf.includes(marker)) {
          clearTimeout(timer);
          ch.removeListener('data', onData);
          resolve(buf);
        }
      };
      ch.on('data', onData);
    });
  }

  /** 接收两个标记之间的输出 */
  async recvBetween(startMarker: string, endMarker: string, timeoutMs = 30000): Promise<string> {
    const full = await this.readUntil(endMarker, timeoutMs);
    const startIdx = full.indexOf(startMarker);
    const endIdx = full.indexOf(endMarker);
    if (startIdx === -1) return full.substring(0, endIdx !== -1 ? endIdx : undefined);
    return full.substring(startIdx + startMarker.length, endIdx !== -1 ? endIdx : undefined);
  }

  /** 打开 GateShell 交互式 shell */
  async openShell(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.sshClient.shell((err, channel) => {
        if (err) {
          reject(new ToolError('GATESHELL_CONNECT_FAILED', `Failed to open shell: ${err.message}`));
          return;
        }
        this.channel = channel;
        Logger.log(`[GateShell:${this.sessionId}] Shell opened`);
        resolve();
      });
    });
  }

  /** 列出可用服务器 */
  async listServers(): Promise<ServerEntry[]> {
    if (!this.channel) {
      throw new ToolError('GATESHELL_NOT_CONNECTED', 'Shell not opened');
    }
    // 发送列表命令并等待输出
    this.channel.write('\r');
    const output = await this.readUntil('>', 15000);
    this.cachedServerList = parseServerList(output);
    Logger.log(`[GateShell:${this.sessionId}] Found ${this.cachedServerList.length} servers`);
    return this.cachedServerList;
  }

  /** 连接到指定服务器 */
  async connectServer(serverIndex: number): Promise<void> {
    if (!this.channel) {
      throw new ToolError('GATESHELL_NOT_CONNECTED', 'Shell not opened');
    }
    // 发送服务器编号
    const indexStr = String(serverIndex).padStart(3, '0');
    this.channel.write(`${indexStr}\r`);
    await this.readUntil('$', 30000);
    this.connectedToServer = true;
    Logger.log(`[GateShell:${this.sessionId}] Connected to server ${indexStr}`);
  }

  /** 在已连接的服务器上执行命令 */
  async executeCommand(command: string, timeoutMs = 30000): Promise<string> {
    if (!this.channel || !this.connectedToServer) {
      throw new ToolError('GATESHELL_NOT_CONNECTED', 'Not connected to a server');
    }
    const marker = `__END_${crypto.randomUUID().slice(0, 8)}__`;
    this.channel.write(`${command}; echo "${marker}"\r`);
    const output = await this.readUntil(marker, timeoutMs);
    // 提取命令输出：在命令回显之后、marker 之前
    const lines = output.split('\n');
    const markerIdx = lines.findIndex(l => l.includes(marker));
    // 跳过第一行（命令回显）
    const resultLines = lines.slice(1, markerIdx !== -1 ? markerIdx : undefined);
    return resultLines.join('\n').trim();
  }

  /** 断开与当前服务器的连接 */
  async disconnectServer(): Promise<void> {
    if (!this.channel) return;
    this.channel.write('exit\r');
    this.connectedToServer = false;
    Logger.log(`[GateShell:${this.sessionId}] Disconnected from server`);
  }

  /** 关闭 shell channel */
  close(): void {
    if (this.channel) {
      this.channel.end();
      this.channel = null;
    }
    this.connectedToServer = false;
    Logger.log(`[GateShell:${this.sessionId}] Shell closed`);
  }

  /** 是否已连接到内网服务器 */
  isConnectedToServer(): boolean {
    return this.connectedToServer;
  }

  /** 获取缓存的服务器列表 */
  getCachedServerList(): ServerEntry[] {
    return this.cachedServerList;
  }
}
