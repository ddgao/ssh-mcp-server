import { describe, it } from 'node:test';
import assert from 'node:assert';
import { formatGateShellServerList } from '../build/tools/list-gateshell-servers.js';

describe('GateShell Tools', () => {
  describe('formatGateShellServerList', () => {
    it('有服务器时应返回格式化的服务器信息', () => {
      const servers = [
        { index: 1, name: 'web-01', host: '10.0.0.1:22', protocol: 'SSH', username: 'root', group: 'prod' },
        { index: 2, name: 'db-01', host: '10.0.0.2:22', protocol: 'SSH', username: 'admin' },
      ];
      const output = formatGateShellServerList(servers);

      assert.match(output, /GateShell servers/);
      assert.match(output, /001.*web-01.*10\.0\.0\.1:22.*SSH.*root.*prod/);
      assert.match(output, /002.*db-01.*10\.0\.0\.2:22.*SSH.*admin/);
    });

    it('空列表应返回无服务器提示', () => {
      const output = formatGateShellServerList([]);
      assert.match(output, /No servers/i);
    });
  });
});
