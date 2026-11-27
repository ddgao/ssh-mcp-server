import { it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Client } from 'ssh2';
import { SSHConnectionManager } from '../build/services/ssh-connection-manager.js';
import { GateShellManager } from '../build/services/gateshell-manager.js';
import { registerListGateShellServersTool } from '../build/tools/list-gateshell-servers.js';
import { registerConnectGateShellServerTool } from '../build/tools/connect-gateshell-server.js';

async function fixture(t) {
  const manager = new SSHConnectionManager();
  manager.setConfig({ bastion: { type: 'gateshell', host: 'test.invalid', port: 22, username: 'test', password: 'fixture-only' } });
  t.mock.method(SSHConnectionManager, 'getInstance', () => manager);
  t.mock.method(Client.prototype, 'connect', function () { queueMicrotask(() => this.emit('ready')); return this; });
  t.mock.method(Client.prototype, 'end', function () { this.emit('close'); return this; });
  t.mock.method(Client.prototype, 'shell', function (_, callback) {
    this.shellCount = (this.shellCount || 0) + 1;
    const channel = new EventEmitter();
    channel.write = () => {};
    channel.destroy = () => channel.emit('close');
    callback(null, channel);
  });
  // Model the observed bastion: only the first shell of each transport gets a menu.
  t.mock.method(GateShellManager.prototype, 'readUntilIdle', async function () {
    return this.sshClient.shellCount === 1 ? '006: test-host 10.0.0.6:22 ssh root' : '';
  });
  const handlers = {};
  const server = { registerTool: (name, _, handler) => { handlers[name] = handler; } };
  registerListGateShellServersTool(server);
  registerConnectGateShellServerTool(server);
  t.after(() => manager.disconnect());
  const list = args => handlers['list-gateshell-servers']({ connectionName: 'bastion', ...args });
  assert.notEqual((await list({})).isError, true);
  manager.getGateShellManager('bastion').markConnected(6);
  return { manager, list, handlers };
}

it('refresh rebuilds the SSH transport and opens exactly one shell per connection', async t => {
  const { manager, list } = await fixture(t);
  const original = manager.getClient('bastion');
  const result = await list({ refresh: true });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.notEqual(manager.getClient('bastion'), original);
  assert.equal(original.shellCount, 1);
  assert.equal(manager.getClient('bastion').shellCount, 1);
  assert.match(result.content[0].text, /phase: menu/);
  assert.doesNotMatch(result.content[0].text, /current:|returned cached/);
});

it('refresh cannot interrupt a running command', async t => {
  const { manager, list } = await fixture(t);
  const original = manager.getClient('bastion');
  const gate = manager.getGateShellManager('bastion');
  let finish;
  t.mock.method(gate, 'executeCommand', () => new Promise(resolve => { finish = resolve; }));
  const running = manager.executeCommand('hostname', undefined, 'bastion');
  try {
    const result = await list({ refresh: true });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).code, 'GATESHELL_BUSY');
    assert.equal(manager.getClient('bastion'), original);
  } finally { finish('test-host'); await running; }
});

it('the connection lock remains held while a refresh replaces the manager', async t => {
  const { manager, list, handlers } = await fixture(t);
  let finishConnect;
  t.mock.method(Client.prototype, 'connect', function () {
    finishConnect = () => this.emit('ready'); return this;
  });
  const refreshing = list({ refresh: true });
  try {
    await assert.rejects(manager.executeCommand('hostname', undefined, 'bastion', { timeout: 5 }), { code: 'GATESHELL_BUSY' });
    const selection = await handlers['connect-gateshell-server']({ connectionName: 'bastion', serverIndex: 6 });
    assert.equal(JSON.parse(selection.content[0].text).code, 'GATESHELL_BUSY');
    assert.equal(JSON.parse((await list({ refresh: true })).content[0].text).code, 'GATESHELL_BUSY');
  } finally {
    finishConnect?.();
    await refreshing;
  }
});

it('ordinary listing preserves the current transport and host', async t => {
  const { manager, list } = await fixture(t);
  const original = manager.getClient('bastion');
  const result = await list({});
  assert.notEqual(result.isError, true);
  assert.equal(manager.getClient('bastion'), original);
  assert.equal(original.shellCount, 1);
  assert.match(result.content[0].text, /phase: server/);
  assert.match(result.content[0].text, /current: 006/);
});

it('a failed reconnect releases the lock and permits a later explicit retry', async t => {
  const { manager, list } = await fixture(t);
  const mock = t.mock.method(Client.prototype, 'connect', function () {
    queueMicrotask(() => this.emit('error', new Error('fixture handshake failure'))); return this;
  });
  const failed = await list({ refresh: true });
  assert.equal(failed.isError, true);
  assert.equal(JSON.parse(failed.content[0].text).code, 'SSH_CONNECTION_FAILED');
  assert.equal(manager.gateshellManagers.has('bastion'), false);
  mock.mock.restore();
  const recovered = await list({ refresh: true });
  assert.notEqual(recovered.isError, true, JSON.stringify(recovered));
  assert.match(recovered.content[0].text, /phase: menu/);
});
