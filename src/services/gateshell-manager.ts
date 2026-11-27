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

export type GateShellPhase = 'closed' | 'menu' | 'server';

export interface ListServersResult {
  servers: ServerEntry[];
  phase: GateShellPhase;
  currentServer?: ServerEntry;
  reusedCache: boolean;
}

/** 移除 ANSI 转义序列，保留逻辑换行 */
export function stripAnsi(str: string): string {
  return str
    .replace(/\x1B\][^\x07]*\x07/g, '')       // OSC 序列 (如 \x1B]0;title\x07)
    .replace(/\x1B\[\d*B/g, '\n')              // Cursor Down → 换行
    .replace(/\x1B\[\??[0-9;]*[a-zA-Z]/g, '')  // 其他 CSI 序列
    .replace(/\x1B[()][0-9A-Z]/g, '')           // 字符集选择
    .replace(/\r/g, '');                         // 回车符
}

/** 从 GateShell 原始输出解析服务器列表 */
export function parseServerList(rawOutput: string): ServerEntry[] {
  const clean = stripAnsi(rawOutput);
  const re = /(\d{3}):[^\S\n]+(\S+)[^\S\n]+(\S+:\d+)[^\S\n]+(\S+)[^\S\n]+(\S+)(?:[^\S\n]+(\S+))?/;
  const seen = new Set<number>();
  const entries: ServerEntry[] = [];
  for (const line of clean.split('\n')) {
    const m = line.match(re);
    if (m) {
      const index = parseInt(m[1], 10);
      if (!seen.has(index)) {
        seen.add(index);
        entries.push({
          index,
          name: m[2],
          host: m[3],
          protocol: m[4],
          username: m[5],
          group: m[6],
        });
      }
    }
  }
  return entries;
}

/** 从命令输出中抽出结束标记之前的结果，兼容 \\r\\n / ANSI / 同行回显 */
export function extractCommandOutput(rawOutput: string, marker: string): string {
  const output = stripAnsi(rawOutput);
  const lines = output.split('\n');
  const markerIdx = lines.findIndex((l) => l.trim() === marker);
  const before = markerIdx === -1 ? lines : lines.slice(0, markerIdx);

  while (before.length && !before[0].trim()) before.shift();
  if (before.length && isCommandEchoLine(before[0], marker)) {
    before.shift();
  }

  return before.join('\n').trim();
}

function isCommandEchoLine(line: string, marker: string): boolean {
  return line.includes('; printf')
    || line.includes('; echo ')
    || line.includes("printf '\\n%s\\n'")
    || (line.includes(marker) && (line.includes('printf') || line.includes('echo')));
}

export function commandFinished(rawOutput: string, marker: string): boolean {
  return outputContainsStandaloneMarker(stripAnsi(rawOutput), marker);
}

export function outputContainsStandaloneMarker(text: string, marker: string): boolean {
  return text.split(/\r?\n/).some((line) => line.trim() === marker);
}

// --- GateShellManager 类 ---

export class GateShellManager {
  private channel: ClientChannel | null = null;
  private phase: GateShellPhase = 'closed';
  private cachedServerList: ServerEntry[] = [];
  private currentServerIndex: number | null = null;
  private readonly sessionId = crypto.randomUUID();
  private busy = false;

  // Do not queue terminal operations: a queued command could run after another
  // caller switches hosts. Reject overlaps before sending any input instead.
  private async exclusively<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy) {
      throw new ToolError('GATESHELL_BUSY', 'GateShell operation in progress; no input sent');
    }
    this.busy = true;
    try {
      return await operation();
    } finally {
      this.busy = false;
    }
  }

  constructor(private readonly sshClient: Client) {}

  /** 读取 channel 数据直到匹配指定文本，返回累积的输出。支持传入多个 marker，任一匹配即返回。 */
  async readUntil(marker: string | string[], timeoutMs = 30000): Promise<string> {
    if (!this.channel) {
      throw new ToolError('GATESHELL_NOT_CONNECTED', 'No channel available');
    }
    const markers = Array.isArray(marker) ? marker : [marker];
    return new Promise<string>((resolve, reject) => {
      let buf = '';
      const ch = this.channel!;
      const cleanup = () => {
        clearTimeout(timer);
        ch.removeListener('data', onData);
        ch.removeListener('close', onClosed);
        ch.removeListener('end', onClosed);
        ch.removeListener('error', onClosed);
      };
      const onClosed = () => {
        cleanup();
        reject(new ToolError('GATESHELL_NOT_CONNECTED', 'Channel closed while waiting for output'));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new ToolError('GATESHELL_PARSE_TIMEOUT', `Timeout waiting for "${markers.join('" or "')}"; command outcome is unknown, do not replay automatically`));
        this.close();
      }, timeoutMs);
      const onData = (data: Buffer) => {
        buf += data.toString('utf-8');
        const cleaned = stripAnsi(buf);
        if (markers.some((m) => outputContainsStandaloneMarker(cleaned, m) || outputContainsStandaloneMarker(buf, m))) {
          cleanup();
          resolve(buf);
        }
      };
      ch.on('close', onClosed);
      ch.on('end', onClosed);
      ch.on('error', onClosed);
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

  hasChannel(): boolean {
    return this.channel !== null;
  }

  getPhase(): GateShellPhase {
    return this.phase;
  }

  getCurrentServer(): ServerEntry | undefined {
    if (this.currentServerIndex === null) return undefined;
    return this.cachedServerList.find((s) => s.index === this.currentServerIndex);
  }

  /** 打开 GateShell 交互式 shell。已有 channel 时复用，避免把菜单/业务机会话冲掉。 */
  async openShell(): Promise<void> {
    return this.exclusively(() => this.openShellInternal());
  }

  private async openShellInternal(): Promise<void> {
    if (this.channel) {
      Logger.log(`[GateShell:${this.sessionId}] Reusing existing shell (phase=${this.phase})`);
      return;
    }
    return new Promise<void>((resolve, reject) => {
      // 设置较大的终端窗口，确保堡垒机能一次输出完整的服务器列表
      const shellOpts = { term: 'xterm', rows: 200, cols: 200 };
      this.sshClient.shell(shellOpts, (err, channel) => {
        if (err) {
          reject(new ToolError('GATESHELL_CONNECT_FAILED', `Failed to open shell: ${err.message}`));
          return;
        }
        this.channel = channel;
        this.phase = 'menu';
        const invalidate = () => {
          // Ignore late lifecycle events from a previously replaced channel.
          if (this.channel !== channel) return;
          this.channel = null;
          this.phase = 'closed';
          this.currentServerIndex = null;
          this.cachedServerList = [];
        };
        channel.on('close', invalidate);
        channel.on('end', invalidate);
        channel.on('error', invalidate);
        Logger.log(`[GateShell:${this.sessionId}] Shell opened`);
        resolve();
      });
    });
  }

  /** 读取 channel 数据直到一段时间内没有新数据到达（数据流空闲检测） */
  async readUntilIdle(idleMs = 2000, timeoutMs = 30000): Promise<string> {
    if (!this.channel) {
      throw new ToolError('GATESHELL_NOT_CONNECTED', 'No channel available');
    }
    return new Promise<string>((resolve, reject) => {
      let buf = '';
      const ch = this.channel!;
      let idleTimer: ReturnType<typeof setTimeout>;
      const cleanup = () => {
        clearTimeout(idleTimer);
        clearTimeout(overallTimer);
        ch.removeListener('data', onData);
        ch.removeListener('close', onClosed);
        ch.removeListener('end', onClosed);
        ch.removeListener('error', onClosed);
      };
      const finish = () => { cleanup(); resolve(buf); };
      const onClosed = () => {
        cleanup();
        reject(new ToolError('GATESHELL_NOT_CONNECTED', 'Channel closed while reading menu'));
      };
      const overallTimer = setTimeout(finish, timeoutMs);
      const resetIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(finish, idleMs);
      };
      const onData = (data: Buffer) => {
        buf += data.toString('utf-8');
        resetIdle();
      };
      ch.on('close', onClosed);
      ch.on('end', onClosed);
      ch.on('error', onClosed);
      ch.on('data', onData);
      resetIdle();
    });
  }

  /** 列出可用服务器。已进入业务机时默认返回缓存，避免把 bash 输出当成空菜单。 */
  async listServers(options: { refresh?: boolean } = {}): Promise<ListServersResult> {
    return this.exclusively(() => this.listServersInternal(options));
  }

  private async listServersInternal(options: { refresh?: boolean }): Promise<ListServersResult> {
    if (!this.channel) {
      throw new ToolError('GATESHELL_NOT_CONNECTED', 'Shell not opened');
    }

    if (this.phase === 'server' && !options.refresh) {
      Logger.log(
        `[GateShell:${this.sessionId}] Returning cached list (${this.cachedServerList.length} servers, on index ${this.currentServerIndex})`,
      );
      return {
        servers: this.cachedServerList,
        phase: this.phase,
        currentServer: this.getCurrentServer(),
        reusedCache: true,
      };
    }

    if (options.refresh) {
      await this.disconnectServerInternal();
    }

    if (this.phase === 'menu' && this.cachedServerList.length > 0 && !options.refresh) {
      Logger.log(`[GateShell:${this.sessionId}] Returning cached menu list (${this.cachedServerList.length} servers)`);
      return {
        servers: this.cachedServerList,
        phase: this.phase,
        currentServer: this.getCurrentServer(),
        reusedCache: true,
      };
    }

    const servers = await this.readMenuServerList();
    this.cachedServerList = servers;
    this.phase = servers.length > 0 ? 'menu' : this.phase;
    Logger.log(`[GateShell:${this.sessionId}] Found ${servers.length} servers`);
    return {
      servers,
      phase: this.phase,
      currentServer: this.getCurrentServer(),
      reusedCache: false,
    };
  }

  private async readMenuServerList(): Promise<ServerEntry[]> {
    const initialOutput = await this.readUntilIdle(3000, 15000);
    Logger.log(`[GateShell:${this.sessionId}] Initial output length: ${initialOutput.length}`);
    const fromInitial = parseServerList(initialOutput);
    if (fromInitial.length > 0) {
      Logger.log(`[GateShell:${this.sessionId}] Found ${fromInitial.length} servers from initial output`);
      return fromInitial;
    }
    this.channel!.write('\r');
    const output = await this.readUntilIdle(5000, 30000);
    Logger.log(`[GateShell:${this.sessionId}] After enter output length: ${output.length}`);
    const parsed = parseServerList(output);
    if (parsed.length > 0) return parsed;

    this.close();
    throw new ToolError('GATESHELL_PARSE_TIMEOUT', 'No fresh GateShell menu received; reconnect before selecting a server');
  }

  /** 检查输出中是否包含 shell 提示符 */
  private hasShellPrompt(output: string): boolean {
    const clean = stripAnsi(output);
    // 匹配常见 shell 提示符模式：]# ]$ ~# ~$ >$ ># 或行尾的 # $
    return /[>\]~\$#]\s*[#$]\s*$/.test(clean.trimEnd())
      || /[\$#]\s*$/m.test(clean.trimEnd());
  }

  /** 连接到指定服务器 */
  async connectServer(serverIndex: number): Promise<void> {
    return this.exclusively(async () => {
      if (this.phase === 'server') {
        if (this.currentServerIndex === serverIndex) return;
        throw new ToolError('GATESHELL_CONNECT_FAILED', 'Already on a backend host; refresh the menu explicitly before switching hosts');
      }
      try {
        await this.connectServerInternal(serverIndex);
      } catch (error) {
        // A failed selection may have moved the cursor or entered another prompt.
        this.close();
        throw error;
      }
    });
  }

  private async connectServerInternal(serverIndex: number): Promise<void> {
    if (!this.channel) {
      throw new ToolError('GATESHELL_NOT_CONNECTED', 'Shell not opened');
    }

    // GateShell 使用类似 less 的全屏 TUI 界面，不能直接输入编号选择服务器。
    // 需要用 j 键向下移动光标到目标行，然后按回车连接。
    // 初始光标位置为 0（标题行），服务器从第 1 行开始，所以移动次数 = serverIndex 在列表中的位置。
    const listIndex = this.cachedServerList.findIndex(s => s.index === serverIndex);
    if (listIndex === -1) {
      throw new ToolError('GATESHELL_CONNECT_FAILED', `Server index ${serverIndex} not found in cached list`);
    }
    // 移动到目标行：TUI 中标题区域占第 0 行，[GateShell] 标签占第 1 行，服务器从第 2 行开始
    const moves = listIndex + 2;
    Logger.log(`[GateShell:${this.sessionId}] Selecting server ${serverIndex} (list position ${listIndex}, ${moves} j-moves)`);
    this.channel.write('j'.repeat(moves));

    // 等待光标移动完成
    await this.readUntilIdle(1000, 5000);

    // 按回车选择服务器
    this.channel.write('\r');

    // 等待连接建立和 shell 提示符出现
    const output = await this.readUntilIdle(3000, 60000);
    const cleanOutput = stripAnsi(output);
    Logger.log(`[GateShell:${this.sessionId}] After select (${output.length} chars), last 200: ${cleanOutput.slice(-200)}`);

    if (this.hasShellPrompt(output)) {
      this.markConnected(serverIndex);
      return;
    }

    // 可能需要额外的回车来触发提示符显示
    Logger.log(`[GateShell:${this.sessionId}] No prompt detected, sending extra enter`);
    this.channel.write('\r');
    const extraOutput = await this.readUntilIdle(3000, 15000);

    if (this.hasShellPrompt(extraOutput)) {
      this.markConnected(serverIndex);
      Logger.log(`[GateShell:${this.sessionId}] Connected to server ${serverIndex} (after extra enter)`);
      return;
    }

    throw new ToolError(
      'GATESHELL_CONNECT_FAILED',
      `Could not detect shell prompt after selecting server ${serverIndex}. Last output: ${stripAnsi(extraOutput || output).slice(-300)}`,
    );
  }

  /** 在已连接的服务器上执行命令 */
  async executeCommand(command: string, timeoutMs = 30000): Promise<string> {
    return this.exclusively(() => this.executeCommandInternal(command, timeoutMs));
  }

  private async executeCommandInternal(command: string, timeoutMs: number): Promise<string> {
    if (!this.channel || this.phase !== 'server') {
      throw new ToolError('GATESHELL_NOT_CONNECTED', 'Not connected to a server');
    }
    const marker = `__END_${crypto.randomUUID().slice(0, 8)}__`;
    const output = this.readUntil(marker, timeoutMs);
    try {
      this.channel.write(`${command}; echo ${marker}\r`);
      return extractCommandOutput(await output, marker);
    } catch (error) {
      this.close();
      // A write failure can precede the reader's rejection.
      await output.catch(() => {});
      throw error;
    }
  }

  /** 断开与当前服务器的连接，回到堡垒机菜单 */
  async disconnectServer(): Promise<void> {
    return this.exclusively(() => this.disconnectServerInternal());
  }

  private async disconnectServerInternal(): Promise<void> {
    // Start at a known cursor position; `exit` may only leave a nested shell
    // or be queued behind a still-running process instead of returning to menu.
    this.close();
    await this.openShellInternal();
  }

  /** 关闭 shell channel */
  close(): void {
    const channel = this.channel;
    this.channel = null;
    this.phase = 'closed';
    this.currentServerIndex = null;
    this.cachedServerList = [];
    channel?.destroy();
    Logger.log(`[GateShell:${this.sessionId}] Shell closed`);
  }

  /** 是否已连接到内网服务器 */
  isConnectedToServer(): boolean {
    return this.phase === 'server';
  }

  /** 获取缓存的服务器列表 */
  getCachedServerList(): ServerEntry[] {
    return this.cachedServerList;
  }

  private markConnected(serverIndex: number): void {
    this.phase = 'server';
    this.currentServerIndex = serverIndex;
    Logger.log(`[GateShell:${this.sessionId}] Connected to server ${serverIndex}`);
  }
}
