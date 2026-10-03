import test from 'node:test';
import assert from 'node:assert/strict';

import {
  KEYCHAIN_SERVICE,
  getEclassPassword,
  getSecretEnvWarning,
} from '../src/secrets.js';
import { describeCredentialEnvironment } from '../src/credential-store.js';

test('getEclassPassword ignores env password without override flag', async () => {
  let credentialRead = false;
  await assert.rejects(
    () => getEclassPassword('test-user', 'env-password', async () => {
      credentialRead = true;
      return null;
    }, '0'),
    Error,
  );
  assert.equal(credentialRead, true);
});

test('getEclassPassword uses env password when override flag is enabled', async () => {
  const password = await getEclassPassword('test-user', 'env-password', async () => {
    throw new Error('keychain should not be queried');
  }, '1');

  assert.equal(password, 'env-password');
});

test('getEclassPassword uses keyed username account', async () => {
  const password = await getEclassPassword('test-user', '', async (service, account) => {
    assert.equal(service, KEYCHAIN_SERVICE);
    assert.equal(account, 'test-user');
    return 'pw';
  }, '0');
  assert.equal(password, 'pw');
});

test('getEclassPassword error names the active backend and next action', async () => {
  const noop = async () => null;
  const diagnostics = await describeCredentialEnvironment();
  await assert.rejects(
    () => getEclassPassword('alice', '', noop, '0'),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes(diagnostics.backend));
      assert.ok(err.message.includes('pnpm run setup'));
      return true;
    },
  );
});

test('getSecretEnvWarning distinguishes ignored and active env secrets', () => {
  const previous = process.env.ALLOW_PLAINTEXT_ENV_SECRETS;
  try {
    delete process.env.ALLOW_PLAINTEXT_ENV_SECRETS;
    const ignored = getSecretEnvWarning('ECLASS_PASSWORD', '비밀번호', 'warning-secret-do-not-print');
    process.env.ALLOW_PLAINTEXT_ENV_SECRETS = '1';
    const active = getSecretEnvWarning('ECLASS_PASSWORD', '비밀번호', 'warning-secret-do-not-print');
    assert.ok(ignored);
    assert.ok(active);
    assert.notEqual(ignored, active);
    for (const warning of [ignored, active]) {
      assert.ok(warning.includes('ECLASS_PASSWORD'));
      assert.ok(!warning.includes('warning-secret-do-not-print'));
    }
    assert.equal(getSecretEnvWarning('ECLASS_PASSWORD', '비밀번호', ''), null);
  } finally {
    if (previous === undefined) delete process.env.ALLOW_PLAINTEXT_ENV_SECRETS;
    else process.env.ALLOW_PLAINTEXT_ENV_SECRETS = previous;
  }
});
