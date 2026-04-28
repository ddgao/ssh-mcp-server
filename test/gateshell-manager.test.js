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
});
