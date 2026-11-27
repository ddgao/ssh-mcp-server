import { it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { GateShellManager } from '../build/services/gateshell-manager.js';

async function fixture() {
  const channel = new EventEmitter();
  channel.write = () => {};
  channel.end = () => channel.emit('close');
  channel.destroy = channel.end;
  const manager = new GateShellManager({ shell: (_, cb) => cb(null, channel) });
  await manager.openShell();
  manager.cachedServerList = [{ index: 6, name: 'test-host' }];
  manager.markConnected(6);
  return { manager, channel };
}

for (const event of ['close', 'end', 'error']) {
  it(`invalidates cached connection on channel ${event}`, async () => {
    const { manager, channel } = await fixture();
    channel.emit(event, new Error('connection lost'));
    assert.equal(manager.hasChannel(), false);
    assert.equal(manager.isConnectedToServer(), false);
    assert.equal(manager.getCurrentServer(), undefined);
    assert.deepEqual(manager.getCachedServerList(), []);
  });
}

it('rejects empty refresh instead of reporting cached menu as fresh', async () => {
  const { manager } = await fixture();
  manager.phase = 'menu';
  manager.readUntilIdle = async () => '';
  await assert.rejects(manager.listServers({ refresh: true }), { code: 'GATESHELL_PARSE_TIMEOUT' });
  assert.equal(manager.hasChannel(), false);
});

it('timeout preserves unrelated listeners and invalidates uncertain command state', async () => {
  const { manager, channel } = await fixture();
  const observer = () => {};
  channel.on('data', observer);
  await assert.rejects(manager.executeCommand('hostname', 5), { code: 'GATESHELL_PARSE_TIMEOUT' });
  assert.ok(channel.listeners('data').includes(observer));
  assert.equal(manager.isConnectedToServer(), false);
});

it('command reader is installed before writing and handles immediate output', async () => {
  const { manager, channel } = await fixture();
  channel.write = (command) => {
    const marker = command.match(/__END_[a-z0-9]+__/)[0];
    channel.emit('data', Buffer.from(`test-host\n${marker}\n`));
  };
  assert.equal(await manager.executeCommand('hostname', 20), 'test-host');
  manager.close();
});

it('pending command rejects immediately on channel close', async () => {
  const { manager, channel } = await fixture();
  const result = manager.executeCommand('hostname', 1000);
  channel.emit('close');
  await assert.rejects(result, { code: 'GATESHELL_NOT_CONNECTED' });
  assert.equal(channel.listenerCount('data'), 0);
});

it('menu reader rejects on channel end and removes its listeners', async () => {
  const { manager, channel } = await fixture();
  const result = manager.readUntilIdle(1000, 2000);
  channel.emit('end');
  await assert.rejects(result, { code: 'GATESHELL_NOT_CONNECTED' });
  assert.equal(channel.listenerCount('data'), 0);
});

it('late close from the old channel does not invalidate a new shell', async () => {
  const { manager, channel } = await fixture();
  channel.emit('end');
  const replacement = new EventEmitter();
  replacement.destroy = () => replacement.emit('close');
  manager.sshClient = { shell: (_, cb) => cb(null, replacement) };
  await manager.openShell();
  channel.emit('close');
  assert.equal(manager.hasChannel(), true);
  assert.equal(manager.getPhase(), 'menu');
  manager.close();
});

it('rejects overlapping operations before they write to the shared terminal', async () => {
  const { manager, channel } = await fixture();
  const writes = [];
  channel.write = text => writes.push(text);
  const running = manager.executeCommand('hostname', 1000);
  void running.catch(() => {});
  for (const operation of [
    () => manager.executeCommand('whoami', 5),
    () => manager.connectServer(6),
    () => manager.listServers({ refresh: true }),
    () => manager.disconnectServer(),
  ]) {
    await assert.rejects(operation(), { code: 'GATESHELL_BUSY' });
  }
  assert.equal(writes.length, 1);
  const marker = writes[0].match(/__END_[a-z0-9]+__/)[0];
  channel.emit('data', Buffer.from(`test-host\n${marker}\n`));
  assert.equal(await running, 'test-host');
  assert.equal((await manager.listServers()).phase, 'server');
  manager.close();
});

it('reselecting current host never sends menu keys into its shell', async () => {
  const { manager, channel } = await fixture();
  const writes = [];
  channel.write = text => writes.push(text);
  manager.readUntilIdle = async () => 'root@test-host#';
  await manager.connectServer(6);
  assert.deepEqual(writes, []);
  manager.close();
});

it('switching hosts requires an explicit fresh menu', async () => {
  const { manager, channel } = await fixture();
  manager.cachedServerList.push({ index: 7, name: 'other-host' });
  const writes = [];
  channel.write = text => writes.push(text);
  manager.readUntilIdle = async () => 'root@test-host#';
  await assert.rejects(manager.connectServer(7), { code: 'GATESHELL_CONNECT_FAILED' });
  assert.deepEqual(writes, []);
  assert.equal(manager.getCurrentServer().index, 6);
  manager.close();
});

it('failed selection discards uncertain cursor and connection state', async () => {
  const { manager } = await fixture();
  manager.phase = 'menu';
  manager.currentServerIndex = null;
  manager.readUntilIdle = async () => '';
  await assert.rejects(manager.connectServer(6), { code: 'GATESHELL_CONNECT_FAILED' });
  assert.equal(manager.hasChannel(), false);
});

it('refresh opens a new menu instead of sending exit into the old host', async () => {
  const { manager, channel } = await fixture();
  const writes = [];
  channel.write = text => writes.push(text);
  const replacement = new EventEmitter();
  replacement.write = () => {};
  replacement.destroy = () => replacement.emit('close');
  manager.sshClient = { shell: (_, cb) => cb(null, replacement) };
  manager.readUntilIdle = async () => '006: test-host 10.0.0.6:22 ssh root';
  const result = await manager.listServers({ refresh: true });
  assert.equal(manager.channel, replacement);
  assert.deepEqual(writes, []);
  assert.equal(result.phase, 'menu');
  assert.equal(result.currentServer, undefined);
  assert.equal(result.reusedCache, false);
  manager.close();
});
