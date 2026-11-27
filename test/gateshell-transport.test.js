import { it } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'ssh2';
import { SSHConnectionManager } from '../build/services/ssh-connection-manager.js';

function fixture(t) {
  // All transport methods are mocked: these tests never open a network socket.
  t.mock.method(Client.prototype, 'connect', function () {
    queueMicrotask(() => this.emit('ready'));
    return this;
  });
  t.mock.method(Client.prototype, 'end', function () { return this; });
  const manager = new SSHConnectionManager();
  manager.setConfig({ test: {
    host: 'test.invalid', port: 22, username: 'test', password: 'fixture-only', type: 'gateshell',
  } });
  t.after(() => manager.disconnect());
  return manager;
}

for (const event of ['close', 'error']) {
  it(`transport ${event} evicts the GateShell manager before reconnect`, async t => {
    const manager = fixture(t);
    await manager.connect('test');
    const oldClient = manager.getClient('test');
    const oldGateShell = manager.getGateShellManager('test');
    oldGateShell.phase = 'server';
    oldClient.emit(event, new Error('transport lost'));
    assert.equal(oldGateShell.isConnectedToServer(), false);
    assert.equal(manager.gateshellManagers.has('test'), false);
    await manager.connect('test');
    const replacement = manager.getGateShellManager('test');
    assert.notEqual(replacement, oldGateShell);
    assert.equal(replacement.sshClient, manager.getClient('test'));
  });
}

it('late old transport events cannot invalidate the replacement connection', async t => {
  const manager = fixture(t);
  await manager.connect('test');
  const oldClient = manager.getClient('test');
  manager.disconnectByName('test');
  await manager.connect('test');
  const newClient = manager.getClient('test');
  const newGateShell = manager.getGateShellManager('test');
  oldClient.emit('error', new Error('late error'));
  oldClient.emit('close');
  assert.equal(manager.getClient('test'), newClient);
  assert.equal(manager.connected.get('test'), true);
  assert.equal(manager.getGateShellManager('test'), newGateShell);
});

it('close before ready rejects setup instead of leaving it pending', async t => {
  const manager = fixture(t);
  t.mock.method(Client.prototype, 'connect', function () {
    queueMicrotask(() => this.emit('close'));
    return this;
  });
  await assert.rejects(manager.connect('test'), { code: 'SSH_CONNECTION_FAILED' });
  assert.equal(manager.pendingConnections.has('test'), false);
  assert.throws(() => manager.getClient('test'));
});

it('close immediately after ready does not publish a dead client', async t => {
  const manager = fixture(t);
  t.mock.method(Client.prototype, 'connect', function () {
    queueMicrotask(() => { this.emit('ready'); this.emit('close'); });
    return this;
  });
  await assert.rejects(manager.connect('test'), { code: 'SSH_CONNECTION_FAILED' });
  assert.equal(manager.connected.get('test'), false);
  assert.equal(manager.pendingStatusCollections.has('test'), false);
  assert.throws(() => manager.getClient('test'));
});

it('preserves installed default routing and explicit connection names', t => {
  const manager = fixture(t);
  const config = manager.getConfig('test');
  manager.setConfig({ dev: { ...config, type: 'ssh' }, prod: config });
  assert.equal(manager.getConfig(), manager.getConfig('prod'));
  assert.equal(manager.resolveGateShellName(), 'prod');
  assert.equal(manager.resolveGateShellName('dev'), 'dev');
  manager.setConfig({ dev: { ...config, type: 'ssh' }, bastion: config }, 'dev');
  assert.equal(manager.getConfig(), manager.getConfig('dev'));
  assert.equal(manager.resolveGateShellName(), 'bastion');
});

it('retains the installed handshake deadline without waiting in real time', async t => {
  const manager = fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let client;
  t.mock.method(Client.prototype, 'connect', function (config) {
    assert.equal(config.readyTimeout, 12000);
    client = this;
    return this;
  });
  const result = assert.rejects(manager.connect('test'), { code: 'SSH_CONNECTION_FAILED' });
  t.mock.timers.tick(12000);
  await result;
  client.emit('ready');
  assert.equal(manager.clients.has('test'), false);
  assert.equal(manager.pendingConnections.has('test'), false);
});
