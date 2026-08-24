import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { SSHConnectionManager } from '../build/services/ssh-connection-manager.js';
import { ToolError } from '../build/utils/tool-error.js';

describe('GateShell Types', () => {
  let manager;

  before(() => {
    manager = SSHConnectionManager.getInstance();
  });

  it('SSHConfig 应支持 type=gateshell 字段', () => {
    const configs = {
      bastion: {
        name: 'bastion',
        host: '10.0.0.1',
        port: 60022,
        username: 'admin',
        password: 'pass',
        type: 'gateshell'
      }
    };

    manager.setConfig(configs);
    const config = manager.getConfig('bastion');
    assert.strictEqual(config.type, 'gateshell');
  });
});

describe('GateShell ToolError Codes', () => {
  it('ToolError 应接受 GATESHELL_PARSE_TIMEOUT 错误码', () => {
    const error = new ToolError('GATESHELL_PARSE_TIMEOUT', 'parse timeout');
    assert.strictEqual(error.code, 'GATESHELL_PARSE_TIMEOUT');
  });

  it('ToolError 应接受 GATESHELL_CONNECT_FAILED 错误码', () => {
    const error = new ToolError('GATESHELL_CONNECT_FAILED', 'connect failed');
    assert.strictEqual(error.code, 'GATESHELL_CONNECT_FAILED');
  });

  it('ToolError 应接受 GATESHELL_NOT_CONNECTED 错误码', () => {
    const error = new ToolError('GATESHELL_NOT_CONNECTED', 'not connected');
    assert.strictEqual(error.code, 'GATESHELL_NOT_CONNECTED');
  });
});

describe('GateShellManager', () => {
  let stripAnsi, parseServerList;

  before(async () => {
    const mod = await import('../build/services/gateshell-manager.js');
    stripAnsi = mod.stripAnsi;
    parseServerList = mod.parseServerList;
  });

  describe('stripAnsi', () => {
    it('应移除 ANSI 转义序列', () => {
      assert.strictEqual(stripAnsi('\x1B[32mhello\x1B[0m'), 'hello');
    });

    it('纯文本应保持不变', () => {
      assert.strictEqual(stripAnsi('hello world'), 'hello world');
    });

    it('应移除复合 ANSI 序列', () => {
      assert.strictEqual(stripAnsi('\x1B[1;31mred bold\x1B[0m'), 'red bold');
    });
  });

  describe('parseServerList', () => {
    it('应解析标准服务器列表行', () => {
      const output = '001: emall-dev-hv07  192.168.17.51:22  ssh  cautions  biz';
      const result = parseServerList(output);
      assert.strictEqual(result.length, 1);
      assert.deepStrictEqual(result[0], {
        index: 1,
        name: 'emall-dev-hv07',
        host: '192.168.17.51:22',
        protocol: 'ssh',
        username: 'cautions',
        group: 'biz',
      });
    });

    it('应解析无 group 的服务器行', () => {
      const output = '002: web-server  10.0.0.1:22  ssh  root';
      const result = parseServerList(output);
      assert.strictEqual(result.length, 1);
      assert.deepStrictEqual(result[0], {
        index: 2,
        name: 'web-server',
        host: '10.0.0.1:22',
        protocol: 'ssh',
        username: 'root',
        group: undefined,
      });
    });

    it('应处理包含 ANSI 的输出', () => {
      const output = '\x1B[32m001: emall-dev-hv07  192.168.17.51:22  ssh  cautions  biz\x1B[0m';
      const result = parseServerList(output);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].name, 'emall-dev-hv07');
    });

    it('空输出应返回空列表', () => {
      assert.deepStrictEqual(parseServerList(''), []);
    });

    it('应解析多行服务器列表', () => {
      const output = [
        '001: server-a  10.0.0.1:22  ssh  root  prod',
        '002: server-b  10.0.0.2:22  ssh  admin',
        '003: server-c  10.0.0.3:2222  ssh  deploy  staging',
      ].join('\n');
      const result = parseServerList(output);
      assert.strictEqual(result.length, 3);
      assert.strictEqual(result[0].index, 1);
      assert.strictEqual(result[1].index, 2);
      assert.strictEqual(result[2].index, 3);
      assert.strictEqual(result[2].host, '10.0.0.3:2222');
      assert.strictEqual(result[2].group, 'staging');
    });
  });

  describe('extractCommandOutput / commandFinished', () => {
    let extractCommandOutput, commandFinished;

    before(async () => {
      const mod = await import('../build/services/gateshell-manager.js');
      extractCommandOutput = mod.extractCommandOutput;
      commandFinished = mod.commandFinished;
    });

    it('应抽出标记前的命令结果', () => {
      const raw = 'hostname; printf ...\nhost-01\n__END_abcd1234__\n';
      assert.strictEqual(extractCommandOutput(raw, '__END_abcd1234__'), 'host-01');
    });

    it('回显与结果之间没有额外行时也不应切空', () => {
      const raw = "echo hello-from-$(hostname); printf '\\n%s\\n' '__END_abcd1234__'\nhello-from-emall-prd-01\n__END_abcd1234__\n";
      assert.strictEqual(
        extractCommandOutput(raw, '__END_abcd1234__'),
        'hello-from-emall-prd-01',
      );
    });

    it('应兼容 \\r\\n 和 ANSI', () => {
      const raw = "hostname; printf '\\n%s\\n' '__END_abcd1234__'\r\n\x1B[32mok\x1B[0m\r\n__END_abcd1234__\r\n";
      assert.strictEqual(extractCommandOutput(raw, '__END_abcd1234__'), 'ok');
      assert.strictEqual(commandFinished(raw, '__END_abcd1234__'), true);
    });

    it('标记单独出现也应视为结束', () => {
      assert.strictEqual(commandFinished('__END_abcd1234__', '__END_abcd1234__'), true);
      assert.strictEqual(commandFinished('still running', '__END_abcd1234__'), false);
    });

    it('命令回显里夹着标记不应视为结束', () => {
      assert.strictEqual(
        commandFinished('echo hello; echo __END_abcd1234__', '__END_abcd1234__'),
        false,
      );
    });
  });
});
