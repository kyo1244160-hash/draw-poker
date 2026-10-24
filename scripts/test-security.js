'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { safeSocketOn, validPacket, createRateLimiter } = require('../server/security/socketSafety');
const { signLoadTestIdentity, verifyLoadTestIdentity, allowedLoadTestTarget } = require('../server/security/loadTestIdentity');
const { publicRanking } = require('../server/security/publicRanking');
const { redactLogText } = require('../server/security/logPrivacy');

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test('deployment rejects unsupported and unpatched Node.js runtimes', () => {
  const { isSupportedNode } = require('../server/security/runtimeVersion');
  for (const version of ['18.20.8', '20.20.0', '24.14.0', '24.22.0', '25.0.0', '26.0.0', '24.22.1-rc.1']) {
    assert.equal(isSupportedNode(version), false, version);
  }
  for (const version of ['24.22.1', '24.22.2', '24.23.0']) assert.equal(isSupportedNode(version), true, version);
});

test('socket events reject null, arrays, bad identifiers, duplicate/out-of-range cards and invalid amounts', () => {
  for (const event of ['t:getMyTable', 'joinRoom', 'betAction', 'drawCards', 'spectate', '3c:bet', 'z:requestGameState']) {
    for (const payload of [null, undefined, [], true, 42, 'bad']) assert.equal(validPacket(event, payload), false);
  }
  for (const payload of [{ roomId: {} }, { roomId: 'x'.repeat(65) }, { amount: NaN }, { amount: Infinity },
    { amount: -1 }, { indices: [0, 0] }, { indices: [5] }, { indices: [1.5] }]) {
    assert.equal(validPacket('betAction', payload), false);
  }
  assert.equal(validPacket('betAction', { roomId: 'test', action: 'raise', amount: 0 }), true);
  assert.equal(validPacket('drawCards', { roomId: 'test', indices: [] }), true);
  assert.equal(validPacket('drawCards', { roomId: 'test', indices: [0, 4] }), true);
});

test('socket wrapper contains synchronous exceptions and rejected promises', async () => {
  const socket = new EventEmitter();
  socket.connected = true;
  const errors = [];
  socket.on('error', payload => errors.push(payload));
  const on = safeSocketOn(socket);
  let calls = 0;
  on('t:getMyTable', ({ tournamentId }) => { calls++; assert.equal(tournamentId, 'test'); });
  socket.emit('t:getMyTable', null);
  socket.emit('t:getMyTable', { tournamentId: 'test' });
  on('sync', () => { throw new Error('secret-value'); });
  on('async', async () => { throw new Error('secret-value'); });
  socket.emit('sync');
  socket.emit('async');
  await flush();
  assert.equal(calls, 1);
  assert.equal(errors.length, 3);
  assert.ok(!JSON.stringify(errors).includes('secret-value'));
});

test('rate limit survives connection changes, expires, and bounds unique keys', () => {
  const allow = createRateLimiter(2, 1000, 2);
  assert.equal(allow('account', 1000), true);
  assert.equal(allow('account', 1001), true);
  assert.equal(allow('account', 1002), false);
  assert.equal(allow('other', 1003), true);
  assert.equal(allow('third', 1004), false);
  assert.equal(allow('account', 2001), true);
});

test('real Socket.IO connections remain usable after malformed packets', async () => {
  const http = require('node:http').createServer();
  const server = new (require('socket.io').Server)(http);
  server.on('connection', socket => {
    const on = safeSocketOn(socket);
    for (const event of ['joinRoom', 't:getMyTable', 'betAction']) {
      on(event, ({ roomId }) => socket.emit('accepted', roomId));
    }
  });
  let client;
  let timeout;
  try {
    await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
    client = require('socket.io-client').io(`http://127.0.0.1:${http.address().port}`, {
      transports: ['websocket'], reconnection: false, forceNew: true,
    });
    let errors = 0;
    client.on('error', () => errors++);
    await new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('local Socket.IO test timed out')), 5000);
      client.on('connect_error', reject);
      client.on('accepted', value => {
        try { assert.equal(value, 'valid-room'); assert.equal(errors, 3); resolve(); } catch (err) { reject(err); }
      });
      client.on('connect', () => {
        for (const event of ['joinRoom', 't:getMyTable', 'betAction']) client.emit(event, null);
        client.emit('betAction', { roomId: 'valid-room', action: 'check' });
      });
    });
  } finally {
    clearTimeout(timeout);
    client?.disconnect();
    await new Promise(resolve => server.close(resolve));
  }
});

test('load-test identity requires authentic, unexpired, separately scoped signatures', () => {
  const secret = 'test-secret-not-for-production';
  const now = 1800000000000;
  const token = signLoadTestIdentity('bot_load_test', 'TestBot', secret, now);
  assert.equal(verifyLoadTestIdentity(token, secret, now).accountId, 'bot_load_test');
  assert.equal(verifyLoadTestIdentity(undefined, secret, now), null);
  assert.equal(verifyLoadTestIdentity(token, 'wrong-secret', now), null);
  assert.equal(verifyLoadTestIdentity(token, secret, now + 120000), null);
  const [payload, signature] = token.split('.');
  const changed = Buffer.from(JSON.stringify({ accountId: 'bot_load_victim', nickname: 'TestBot', exp: now / 1000 + 120 })).toString('base64url');
  assert.equal(verifyLoadTestIdentity(`${changed}.${signature}`, secret, now), null);
  assert.equal(verifyLoadTestIdentity(signLoadTestIdentity('real-account', 'TestBot', secret, now), secret, now), null);
  const normalSignature = require('crypto').createHmac('sha256', secret).update(payload).digest('base64url');
  assert.equal(verifyLoadTestIdentity(`${payload}.${normalSignature}`, secret, now), null);
});

test('load-test destinations are restricted before sending credentials', () => {
  const env = { NEXTAUTH_URL: 'https://poker.example', PORT: '3000' };
  assert.equal(allowedLoadTestTarget('https://poker.example', env), true);
  for (const url of ['https://attacker.example', 'https://poker.example.attacker.example',
    'https://user:password@poker.example', 'https://poker.example/?token=test', 'https://poker.example/path']) {
    assert.equal(allowedLoadTestTarget(url, env), false);
  }
});

test('public rankings never serialize private account fields or Google fallback names', () => {
  const output = publicRanking([{ nickname: null, google_name: 'PrivateName', account_id: '12345678901234567890',
    email: 'private@example.com', total_points: 100, tournament_count: 1 }]);
  assert.deepEqual(output, [{ nickname: '名無し', total_points: 100, tournament_count: 1 }]);
});

test('diagnostic logs remove credentials, email addresses, account IDs and URL parameters', () => {
  const output = redactLogText('https://user:pass@example.com/path?token=abc#secret private@example.com 12345678901234567890 Bearer private-token socket:abcdef.sig password=secret');
  for (const secret of ['user:pass', '?token', '#secret', 'private@example.com', '12345678901234567890', 'private-token', 'abcdef.sig', 'password=secret']) {
    assert.ok(!output.includes(secret));
  }
  assert.ok(output.includes('https://example.com/path'));
});

const tc = require('../server/poker/threeCardManager');
function setupTable(t, callback) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  tc.setPhaseChangeCallback(callback);
  const table = tc.getOrCreateAvailableRoom();
  t.after(() => {
    tc.setPhaseChangeCallback(null);
    for (const player of [...table.players]) tc.leaveTable(table.id, player.socketId);
  });
  return table;
}

test('leaving after a wager retains the participant through settlement and blocks resetting the balance', async t => {
  const settled = [];
  const table = setupTable(t, (_id, phase) => {
    if (phase === 'result') settled.push(...table.players.map(p => ({ accountId: p.accountId, net: p.result.net })));
  });
  assert.equal(tc.joinTable(table.id, 'socket-a', 'A', 'account-a', 100), 'ok');
  assert.equal(tc.placeBet(table.id, 'socket-a', { ante: 10 }).ok, true);
  assert.equal(table.phase, 'action');
  table.players[0].hand = ['2S', '5H', '9D'];
  tc.leaveTable(table.id, 'socket-a');
  assert.equal(table.players.length, 1);
  assert.equal(tc.joinTable(table.id, 'socket-new', 'A', 'account-a', 100), 'accountBusy');
  await flush();
  assert.deepEqual(settled, [{ accountId: 'account-a', net: -10 }]);
  t.mock.timers.tick(5001);
  assert.equal(table.players.length, 0);
  assert.equal(table.phase, 'waiting');
});

test('settlement failures retain the account and retry before another hand starts', async t => {
  let attempts = 0;
  const table = setupTable(t, async (_id, phase) => {
    if (phase === 'result' && ++attempts === 1) throw new Error('database unavailable');
  });
  tc.joinTable(table.id, 'socket-b', 'B', 'account-b', 100);
  tc.placeBet(table.id, 'socket-b', { ante: 10 });
  tc.leaveTable(table.id, 'socket-b');
  await flush();
  assert.equal(table.settlementPending, true);
  assert.equal(tc.joinTable(table.id, 'socket-new', 'B', 'account-b', 100), 'accountBusy');
  t.mock.timers.tick(5001);
  await flush();
  assert.equal(attempts, 2);
  assert.equal(table.settlementPending, false);
  t.mock.timers.tick(5001);
  assert.equal(table.players.length, 0);
});

test('leaving in betting does not erase a committed wager when others have not bet', async t => {
  let net;
  const table = setupTable(t, (_id, phase) => {
    if (phase === 'result') net = table.players.find(p => p.accountId === 'account-c').result.net;
  });
  tc.joinTable(table.id, 'socket-c', 'C', 'account-c', 100);
  tc.joinTable(table.id, 'socket-d', 'D', 'account-d', 100);
  tc.placeBet(table.id, 'socket-c', { ante: 10 });
  tc.leaveTable(table.id, 'socket-c');
  assert.equal(table.players.length, 2);
  tc.placeBet(table.id, 'socket-d', { ante: 10 });
  table.players[0].hand = ['2S', '5H', '9D'];
  tc.playerAction(table.id, 'socket-d', 'fold');
  await flush();
  assert.equal(net, -10);
  t.mock.timers.tick(5001);
});

test('settlement ledger rolls back failed updates and applies repeated results only once', async () => {
  let balance = 100;
  const ledger = new Set();
  let fail = true;
  const fakeSql = () => Promise.resolve([]);
  fakeSql.begin = async callback => {
    const before = new Set(ledger);
    const previousBalance = balance;
    try {
      return await callback(async (strings, ...args) => {
        const query = strings.join('?');
        if (query.includes('INSERT INTO three_card_settlements')) {
          const key = `${args[0]}:${args[1]}`;
          if (ledger.has(key)) return [];
          ledger.add(key);
          return [{ hand_id: args[0] }];
        }
        if (query.includes('INSERT INTO points')) {
          if (fail) throw new Error('write failed');
          balance = Math.max(0, balance + args[2]);
          return [];
        }
        throw new Error('unexpected query');
      });
    } catch (err) {
      ledger.clear();
      for (const key of before) ledger.add(key);
      balance = previousBalance;
      throw err;
    }
  };
  const clientPath = require.resolve('../server/db/client');
  const pointsPath = require.resolve('../server/db/points');
  const oldClient = require.cache[clientPath];
  const oldPoints = require.cache[pointsPath];
  require.cache[clientPath] = { id: clientPath, filename: clientPath, loaded: true, exports: fakeSql };
  delete require.cache[pointsPath];
  try {
    const { applyThreeCardResult } = require(pointsPath);
    await assert.rejects(applyThreeCardResult('account', -10, 'hand'));
    assert.equal(ledger.size, 0);
    fail = false;
    await applyThreeCardResult('account', -10, 'hand');
    await applyThreeCardResult('account', -10, 'hand');
    assert.equal(balance, 90);
    assert.equal(ledger.size, 1);
  } finally {
    if (oldClient) require.cache[clientPath] = oldClient; else delete require.cache[clientPath];
    if (oldPoints) require.cache[pointsPath] = oldPoints; else delete require.cache[pointsPath];
  }
});
