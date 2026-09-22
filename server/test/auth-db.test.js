import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AuthStore } from '../src/auth-db.js';

function withStore(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpmv-auth-'));
  const store = new AuthStore(path.join(dir, 'auth.db'));
  try { return run(store); }
  finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

test('OAuth state can only be consumed once', () => withStore(store => {
  store.createState('state-hash', 'verifier', Date.now() + 60_000);
  assert.equal(store.consumeState('state-hash').verifier, 'verifier');
  assert.equal(store.consumeState('state-hash'), undefined);
}));

test('blacklisting a user immediately revokes all sessions', () => withStore(store => {
  store.createSession({
    tokenHash: 'token-hash', discordId: '11111111111111111', username: 'mod', avatar: null,
    role: 'moderator', accessToken: 'access', refreshToken: 'refresh', tokenExpiresAt: Date.now() + 60_000,
    rolesCheckedAt: Date.now(), expiresAt: Date.now() + 60_000,
  });
  assert.ok(store.getSession('token-hash'));
  store.block('11111111111111111', '22222222222222222');
  assert.equal(store.getSession('token-hash'), undefined);
  assert.equal(store.isBlocked('11111111111111111'), true);
  assert.equal(store.listBlacklist()[0].addedBy, '22222222222222222');
  assert.equal(store.unblock('11111111111111111'), true);
  assert.equal(store.isBlocked('11111111111111111'), false);
}));
