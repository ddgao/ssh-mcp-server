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
