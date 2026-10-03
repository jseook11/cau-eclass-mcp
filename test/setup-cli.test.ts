import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import YAML from 'yaml';

import { formatCredentialStoreFailure, parseArgs } from '../scripts/setup.js';
import { decryptSecretFile, encryptSecretFile, type EncFile } from '../src/credential-store.js';

function runSetupCli(
  args: string[],
  input: string,
  env: NodeJS.ProcessEnv = {},
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const childEnv = { ...process.env };
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete childEnv[key];
      else childEnv[key] = value;
    }
    const child = spawn('pnpm', ['exec', 'tsx', 'scripts/setup.ts', ...args], {
      cwd: process.cwd(),
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
    child.stdin.end(input);
  });
}

test('parseArgs accepts --target encrypted', () => {
  const opts = parseArgs([
    '--target', 'encrypted',
    '--username', 'alice',
    '--generate-master-key-file', './private/master.key',
  ]);
  assert.equal(opts.target, 'encrypted');
  assert.equal(opts.username, 'alice');
  assert.equal(opts.generateMasterKeyFile, path.resolve('./private/master.key'));
});

test('setup --target encrypted stores ciphertext in secrets.enc', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-setup-enc-'));
  const encPath = path.join(dir, 'secrets.enc');
  const key = crypto.randomBytes(32);
  const result = await runSetupCli([
    '--target', 'encrypted',
    '--username', 'enc_user',
    '--password-stdin',
    '--no-doctor',
  ], 'topsecretpw\n', {
    ECLASS_CREDENTIAL_BACKEND: 'encrypted',
    ECLASS_SECRET_KEY: key.toString('base64'),
    ECLASS_ENC_STORE_PATH: encPath,
    ECLASS_SECRET_STORE_PATH: path.join(dir, 'legacy.json'),
  });
  assert.equal(result.code, 0, result.output);
  const onDisk = await fs.readFile(encPath, 'utf8');
  assert.ok(!onDisk.includes('topsecretpw'), 'plaintext password must not appear on disk');
  const secrets = decryptSecretFile(key, JSON.parse(onDisk) as EncFile);
  assert.deepEqual(Object.values(secrets).flatMap(Object.values), ['topsecretpw']);
  await fs.rm(dir, { recursive: true, force: true });
});

test('encrypted setup with a wrong key preserves the store and keeps secrets out of errors', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-setup-wrong-key-'));
  const encPath = path.join(dir, 'secrets.enc');
  const originalKey = crypto.randomBytes(32);
  const configuredKey = crypto.randomBytes(32).toString('base64');
  const password = 'must-never-appear-in-error-output';
  try {
    await fs.writeFile(
      encPath,
      JSON.stringify(encryptSecretFile(originalKey, {}), null, 2) + '\n',
      { mode: 0o600 },
    );
    const originalStore = await fs.readFile(encPath, 'utf8');
    const result = await runSetupCli([
      '--target', 'encrypted',
      '--username', 'enc_user',
      '--password-stdin',
      '--no-doctor',
    ], `${password}\n`, {
      ECLASS_CREDENTIAL_BACKEND: 'encrypted',
      ECLASS_SECRET_KEY: configuredKey,
      ECLASS_SECRET_KEY_FILE: undefined,
      ECLASS_ENC_STORE_PATH: encPath,
      ECLASS_SECRET_STORE_PATH: path.join(dir, 'legacy.json'),
    });

    assert.equal(result.code, 1, result.output);
    assert.equal(await fs.readFile(encPath, 'utf8'), originalStore);
    assert.doesNotMatch(result.output, new RegExp(password));
    assert.doesNotMatch(
      result.output,
      new RegExp(configuredKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Hermes setup rejects unsafe encrypted store permissions without changing config or credentials', async (t) => {
  if (os.platform() === 'win32') return t.skip('POSIX permission test');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-setup-unsafe-enc-'));
  const hermesConfigPath = path.join(dir, 'config.yaml');
  const encPath = path.join(dir, 'secrets.enc');
  const key = crypto.randomBytes(32);
  try {
    await fs.writeFile(hermesConfigPath, YAML.stringify({ mcp_servers: {} }));
    await fs.writeFile(
      encPath,
      JSON.stringify(encryptSecretFile(key, {}), null, 2) + '\n',
      { mode: 0o600 },
    );
    await fs.chmod(encPath, 0o644);
    const originalStore = await fs.readFile(encPath, 'utf8');

    const result = await runSetupCli([
      '--target', 'hermes',
      '--config', hermesConfigPath,
      '--username', 'enc_user',
      '--password-stdin',
      '--no-doctor',
    ], 'do-not-print-this-password\n', {
      ECLASS_CREDENTIAL_BACKEND: 'encrypted',
      ECLASS_SECRET_KEY: key.toString('base64'),
      ECLASS_SECRET_KEY_FILE: undefined,
      ECLASS_ENC_STORE_PATH: encPath,
      ECLASS_SECRET_STORE_PATH: path.join(dir, 'legacy.json'),
    });

    assert.equal(result.code, 1, result.output);
    assert.equal(await fs.readFile(encPath, 'utf8'), originalStore);
    assert.doesNotMatch(result.output, /do-not-print-this-password/);
    const unchanged = YAML.parse(await fs.readFile(hermesConfigPath, 'utf8')) as any;
    assert.deepEqual(unchanged.mcp_servers, {});
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('credential failure formatter redacts passwords and master keys from error causes', () => {
  const password = 'formatter-password-value';
  const masterKey = crypto.randomBytes(32).toString('base64');
  const output = formatCredentialStoreFailure(
    new Error(`keytar failure password=${password} api_key=${masterKey}`),
    {
      target: 'hermes',
      resolvedBackend: 'keytar',
      secretValues: [password, masterKey],
    },
  );

  assert.ok(output.trim().length > 0);
  assert.doesNotMatch(output, new RegExp(password));
  assert.doesNotMatch(
    output,
    new RegExp(masterKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  );
});

test('setup --target encrypted fails closed without a master key and never prints one', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-setup-no-key-'));
  try {
    const result = await runSetupCli([
      '--target', 'encrypted',
      '--username', 'enc_user',
      '--password-stdin',
      '--no-doctor',
    ], 'topsecretpw\n', {
      ECLASS_CREDENTIAL_BACKEND: undefined,
      ECLASS_SECRET_KEY: undefined,
      ECLASS_SECRET_KEY_FILE: undefined,
      ECLASS_ENC_STORE_PATH: path.join(dir, 'secrets.enc'),
      ECLASS_SECRET_STORE_PATH: path.join(dir, 'legacy.json'),
    });
    assert.equal(result.code, 1, result.output);
    assert.doesNotMatch(result.output, /topsecretpw/);
    assert.doesNotMatch(result.output, /ECLASS_SECRET_KEY=[A-Za-z0-9+/=_-]{20,}/);
    await assert.rejects(() => fs.stat(path.join(dir, 'secrets.enc')));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('setup generates an exclusive raw 0600 master-key file without printing the key', async (t) => {
  if (os.platform() === 'win32') return t.skip('POSIX permission test');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-setup-generate-key-'));
  const keyPath = path.join(dir, 'private', 'master.key');
  const encPath = path.join(dir, 'store', 'secrets.enc');
  try {
    const result = await runSetupCli([
      '--target', 'encrypted',
      '--username', 'enc_user',
      '--password-stdin',
      '--generate-master-key-file', keyPath,
      '--no-doctor',
    ], 'topsecretpw\n', {
      ECLASS_CREDENTIAL_BACKEND: undefined,
      ECLASS_SECRET_KEY: undefined,
      ECLASS_SECRET_KEY_FILE: undefined,
      ECLASS_ENC_STORE_PATH: encPath,
      ECLASS_SECRET_STORE_PATH: path.join(dir, 'legacy.json'),
    });
    assert.equal(result.code, 0, result.output);
    const key = await fs.readFile(keyPath);
    assert.equal(key.length, 32);
    assert.equal((await fs.stat(path.dirname(keyPath))).mode & 0o777, 0o700);
    assert.equal((await fs.stat(keyPath)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(encPath)).mode & 0o777, 0o600);
    assert.doesNotMatch(result.output, new RegExp(key.toString('base64').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const encrypted = JSON.parse(await fs.readFile(encPath, 'utf8')) as EncFile;
    assert.deepEqual(Object.values(decryptSecretFile(key, encrypted)).flatMap(Object.values), ['topsecretpw']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('setup does not require .mcp.json when Hermes config exists', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-setup-'));
  const hermesConfigPath = path.join(dir, 'config.yaml');
  const encPath = path.join(dir, 'secrets.enc');
  const key = crypto.randomBytes(32);
  await fs.writeFile(hermesConfigPath, YAML.stringify({
    existing_key: 'kept',
    mcp_servers: {},
  }));

  const result = await runSetupCli([
    '--target', 'hermes',
    '--config', hermesConfigPath,
    '--username', 'my_id',
    '--password-stdin',
    '--allow-plaintext-env',
    '--no-doctor',
  ], 'secret\n', {
    ECLASS_CREDENTIAL_BACKEND: 'encrypted',
    ECLASS_SECRET_KEY: key.toString('base64'),
    ECLASS_SECRET_KEY_FILE: undefined,
    ECLASS_ENC_STORE_PATH: encPath,
    ECLASS_SECRET_STORE_PATH: path.join(dir, 'legacy.json'),
  });

  assert.equal(result.code, 0, result.output);
  const written = YAML.parse(await fs.readFile(hermesConfigPath, 'utf8')) as any;
  assert.equal(written.existing_key, 'kept');
  assert.equal(written.mcp_servers.eclass.env.ECLASS_USERNAME, 'my_id');
  assert.equal(written.mcp_servers.eclass.env.ECLASS_PASSWORD, 'secret');
  assert.equal(written.mcp_servers.eclass.env.ALLOW_PLAINTEXT_ENV_SECRETS, '1');
  const encrypted = JSON.parse(await fs.readFile(encPath, 'utf8')) as EncFile;
  assert.deepEqual(decryptSecretFile(key, encrypted), {}, 'a plaintext password opt-in leaves no credentials in the secure cache');

  await fs.rm(dir, { recursive: true, force: true });
});

test('Hermes plaintext override rejects legacy or unconfigured secure backends before changing config', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-setup-plaintext-backend-'));
  try {
    for (const testCase of [
      {
        name: 'legacy file',
        env: {
          ECLASS_CREDENTIAL_BACKEND: 'file',
          ECLASS_SECRET_KEY: undefined,
          ECLASS_SECRET_KEY_FILE: undefined,
        },
      },
      {
        name: 'encrypted without key',
        env: {
          ECLASS_CREDENTIAL_BACKEND: 'encrypted',
          ECLASS_SECRET_KEY: undefined,
          ECLASS_SECRET_KEY_FILE: undefined,
        },
      },
    ]) {
      const hermesConfigPath = path.join(dir, `${testCase.name.replace(/\s+/g, '-')}.yaml`);
      await fs.writeFile(hermesConfigPath, YAML.stringify({ mcp_servers: {} }));
      const result = await runSetupCli([
        '--target', 'hermes',
        '--config', hermesConfigPath,
        '--username', 'my_id',
        '--password-stdin',
        '--allow-plaintext-env',
        '--no-doctor',
      ], 'must-not-be-written\n', {
        ...testCase.env,
        ECLASS_ENC_STORE_PATH: path.join(dir, 'secrets.enc'),
        ECLASS_SECRET_STORE_PATH: path.join(dir, 'legacy.json'),
      });

      assert.equal(result.code, 1, `${testCase.name}: ${result.output}`);
      assert.doesNotMatch(result.output, /must-not-be-written/);
      const unchanged = YAML.parse(await fs.readFile(hermesConfigPath, 'utf8')) as any;
      assert.deepEqual(unchanged.mcp_servers, {});
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Hermes plaintext override probes encrypted storage and rejects a wrong key before changing config', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-setup-plaintext-wrong-key-'));
  const hermesConfigPath = path.join(dir, 'config.yaml');
  const encPath = path.join(dir, 'secrets.enc');
  try {
    await fs.writeFile(hermesConfigPath, YAML.stringify({ mcp_servers: {} }));
    await fs.writeFile(
      encPath,
      `${JSON.stringify(encryptSecretFile(crypto.randomBytes(32), {}))}\n`,
      { mode: 0o600 },
    );
    const originalStore = await fs.readFile(encPath, 'utf8');

    const result = await runSetupCli([
      '--target', 'hermes',
      '--config', hermesConfigPath,
      '--username', 'my_id',
      '--password-stdin',
      '--allow-plaintext-env',
      '--no-doctor',
    ], 'must-not-be-written\n', {
      ECLASS_CREDENTIAL_BACKEND: 'encrypted',
      ECLASS_SECRET_KEY: crypto.randomBytes(32).toString('base64'),
      ECLASS_SECRET_KEY_FILE: undefined,
      ECLASS_ENC_STORE_PATH: encPath,
      ECLASS_SECRET_STORE_PATH: path.join(dir, 'legacy.json'),
    });

    assert.equal(result.code, 1, result.output);
    assert.equal(await fs.readFile(encPath, 'utf8'), originalStore);
    assert.doesNotMatch(result.output, /must-not-be-written/);
    const unchanged = YAML.parse(await fs.readFile(hermesConfigPath, 'utf8')) as any;
    assert.deepEqual(unchanged.mcp_servers, {});
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('setup creates an explicit .mcp.json privately and strips plaintext secrets', async (t) => {
  if (os.platform() === 'win32') return t.skip('POSIX permission test');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-setup-mcp-json-'));
  const configPath = path.join(dir, 'nested', 'client.json');
  const encPath = path.join(dir, 'credentials', 'secrets.enc');
  const key = crypto.randomBytes(32);
  try {
    const result = await runSetupCli([
      '--target', 'mcp-json',
      '--config', configPath,
      '--username', 'mcp_user',
      '--password-stdin',
      '--no-doctor',
    ], 'temporary-password\n', {
      ECLASS_CREDENTIAL_BACKEND: 'encrypted',
      ECLASS_SECRET_KEY: key.toString('base64'),
      ECLASS_ENC_STORE_PATH: encPath,
      ECLASS_SECRET_STORE_PATH: path.join(dir, 'legacy.json'),
    });

    assert.equal(result.code, 0, result.output);
    assert.doesNotMatch(result.output, /temporary-password/);
    const encrypted = JSON.parse(await fs.readFile(encPath, 'utf8')) as EncFile;
    assert.deepEqual(Object.values(decryptSecretFile(key, encrypted)).flatMap(Object.values), ['temporary-password']);
    const written = JSON.parse(await fs.readFile(configPath, 'utf8')) as {
      mcpServers: { eclass: { env: Record<string, string> } };
    };
    assert.equal(written.mcpServers.eclass.env.ECLASS_USERNAME, 'mcp_user');
    assert.equal(written.mcpServers.eclass.env.ECLASS_PASSWORD, undefined);
    assert.equal(written.mcpServers.eclass.env.ALLOW_PLAINTEXT_ENV_SECRETS, undefined);
    assert.equal((await fs.stat(configPath)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(encPath)).mode & 0o777, 0o600);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('--allow-plaintext-env is rejected for targets that cannot persist it', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-setup-plaintext-scope-'));
  const configPath = path.join(dir, 'client.json');
  try {
    for (const target of ['mcp-json', 'both', 'encrypted']) {
      const result = await runSetupCli([
        '--target', target,
        ...(target === 'mcp-json' ? ['--config', configPath] : []),
        '--username', 'scope_user',
        '--password-stdin',
        '--allow-plaintext-env',
        '--no-doctor',
      ], 'must-not-be-used\n');
      assert.equal(result.code, 1, `${target}: ${result.output}`);
      assert.doesNotMatch(result.output, /must-not-be-used/);
    }
    await assert.rejects(() => fs.stat(configPath));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('--config is rejected for ambiguous both and irrelevant encrypted targets', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-setup-config-scope-'));
  const configPath = path.join(dir, 'must-not-be-created.json');
  try {
    for (const target of ['both', 'encrypted']) {
      const result = await runSetupCli([
        '--target', target,
        '--config', configPath,
        '--username', 'scope_user',
        '--password-stdin',
        '--no-doctor',
      ], 'must-not-be-used\n');
      assert.equal(result.code, 1, `${target}: ${result.output}`);
      assert.doesNotMatch(result.output, /must-not-be-used/);
    }
    await assert.rejects(() => fs.stat(configPath));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('setup with a read-only credential backend leaves Hermes config unchanged', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-setup-keyring-'));
  const hermesConfigPath = path.join(dir, 'config.yaml');
  await fs.writeFile(hermesConfigPath, YAML.stringify({ mcp_servers: {} }));

  const result = await runSetupCli([
    '--target', 'hermes',
    '--config', hermesConfigPath,
    '--username', 'my_id',
    '--password-stdin',
    '--no-doctor',
  ], 'read-only-backend-password\n', {
    ECLASS_CREDENTIAL_BACKEND: 'file',
    ECLASS_SECRET_STORE_PATH: path.join(dir, 'secrets.json'),
  });

  assert.equal(result.code, 1, result.output);
  assert.doesNotMatch(result.output, /read-only-backend-password/);
  await assert.rejects(() => fs.stat(path.join(dir, 'secrets.json')), { code: 'ENOENT' });

  const written = YAML.parse(await fs.readFile(hermesConfigPath, 'utf8')) as any;
  assert.deepEqual(written.mcp_servers, {});

  await fs.rm(dir, { recursive: true, force: true });
});
