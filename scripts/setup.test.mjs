/** Exercises checkout-backed installation in disposable skill and Codex directories. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { installationPlan, parseOptions } from './setup.mjs';

/** Actual CLI entry point ensures installations work even outside the checkout. */
const entry = join(dirname(fileURLToPath(import.meta.url)), 'setup.mjs');

/** Runs setup without shell interpolation, including paths with spaces. */
function run(args, cwd, env = process.env) {
  return spawnSync(process.execPath, [entry, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 15_000,
  });
}

test('setup defaults to help and print mode only returns secret-free local configuration', () => {
  assert.equal(parseOptions([]).help, true);
  assert.throws(() => parseOptions(['--skill-dir']), /Provide a parent directory/);
  assert.throws(() => parseOptions(['--unknown']), /Unknown setup option/);
  const printed = run(['--print'], tmpdir());
  assert.equal(printed.status, 0, printed.stderr);
  const plan = JSON.parse(printed.stdout);
  assert.equal(plan.mcpServers.phoneuse.command, process.execPath);
  assert.match(plan.mcpEntry, /bridge\/dist\/src\/mcp-launcher.js$/);
  assert.equal(plan.mcpServers.phoneuse.args[0], plan.mcpEntry);
  assert.equal(Object.keys(plan.mcpServers.phoneuse).length, 2);
  const customized = installationPlan({}, '/tmp/PhoneUse', {
    PHONEUSE_ADMIN_PORT: '19001',
    PHONEUSE_STATE_DIR: '/tmp/private state',
    PRIVATE_TOKEN: 'must not be forwarded',
  });
  assert.deepEqual(customized.mcpServers.phoneuse.env, {
    PHONEUSE_STATE_DIR: '/tmp/private state',
    PHONEUSE_ADMIN_PORT: '19001',
  });
  assert.equal(
    installationPlan({ skillDir: '/tmp/skill parent' }).skillDestination,
    '/tmp/skill parent/phoneuse',
  );
  const help = run([], tmpdir());
  assert.equal(help.status, 0);
  assert.match(help.stdout, /npm run setup/);
});

test('skill install works from an unrelated cwd, updates itself and refuses another skill', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phoneuse-skill-install-'));
  const parent = join(root, 'skill parent');

  try {
    const installed = run(['--skill', '--skill-dir', parent], root);
    assert.equal(installed.status, 0, installed.stderr);
    const metadata = JSON.parse(await readFile(join(parent, 'phoneuse/installation.json'), 'utf8'));
    assert.equal(metadata.repositoryRoot, resolve(dirname(entry), '..'));
    assert.equal(metadata.nodePath, process.execPath);
    assert.match(await readFile(join(parent, 'phoneuse/SKILL.md'), 'utf8'), /name: phoneuse/);
    assert.equal(run(['--skill', '--skill-dir', parent], root).status, 0);
    const conflictingParent = join(root, 'other skills');
    await mkdir(join(conflictingParent, 'phoneuse'), { recursive: true });
    await writeFile(join(conflictingParent, 'phoneuse/SKILL.md'), "User's existing skill");
    const refused = run(['--skill', '--skill-dir', conflictingParent], root);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /already exists/);
    assert.equal(
      await readFile(join(conflictingParent, 'phoneuse/SKILL.md'), 'utf8'),
      "User's existing skill",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** Availability check avoids requiring Codex for users who only use another MCP host. */
const codexAvailable = spawnSync('codex', ['--version'], { stdio: 'ignore' }).status === 0;

test(
  'Codex install and repeat setup preserve unrelated MCP entries and reject conflicting phoneuse entries',
  { skip: !codexAvailable },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'phoneuse-codex-install-'));
    const codexHome = join(root, 'codex home');
    const env = { ...process.env, CODEX_HOME: codexHome, PHONEUSE_ADMIN_PORT: '19001' };
    const args = ['--codex', '--skill-dir', join(root, 'skills')];

    try {
      await mkdir(codexHome);
      execFileSync('codex', ['mcp', 'add', 'unrelated', '--', process.execPath, 'unrelated.js'], {
        env,
        stdio: 'pipe',
      });
      const installed = run(args, root, env);
      assert.equal(installed.status, 0, installed.stderr);
      const metadata = JSON.parse(
        execFileSync('codex', ['mcp', 'get', 'phoneuse', '--json'], { env, encoding: 'utf8' }),
      );
      assert.equal(metadata.transport.command, process.execPath);
      assert.match(metadata.transport.args[0], /mcp-launcher.js$/);
      assert.equal(metadata.transport.env.PHONEUSE_ADMIN_PORT, '19001');
      const differentEnvironment = { ...env, PHONEUSE_ADMIN_PORT: '19002' };
      const refusedEnvironment = run(args, root, differentEnvironment);
      assert.equal(refusedEnvironment.status, 1);
      assert.match(refusedEnvironment.stderr, /different phoneuse MCP registration/);
      const repeated = run(args, root, env);
      assert.equal(repeated.status, 0, repeated.stderr);
      assert.match(repeated.stdout, /already registered/);
      const blockedParent = join(root, 'not a directory');
      await writeFile(blockedParent, 'Preserve this file');
      execFileSync('codex', ['mcp', 'remove', 'phoneuse'], { env, stdio: 'pipe' });
      const failedSkill = run(['--codex', '--skill-dir', blockedParent], root, env);
      assert.equal(failedSkill.status, 1);
      const afterFailure = JSON.parse(
        execFileSync('codex', ['mcp', 'list', '--json'], { env, encoding: 'utf8' }),
      );
      assert.equal(
        afterFailure.some((server) => server.name === 'phoneuse'),
        false,
      );
      assert.equal(await readFile(blockedParent, 'utf8'), 'Preserve this file');
      assert.equal(run(args, root, env).status, 0);
      assert.equal(
        JSON.parse(
          execFileSync('codex', ['mcp', 'get', 'unrelated', '--json'], { env, encoding: 'utf8' }),
        ).transport.args[0],
        'unrelated.js',
      );
      execFileSync('codex', ['mcp', 'remove', 'phoneuse'], { env, stdio: 'pipe' });
      execFileSync('codex', ['mcp', 'add', 'phoneuse', '--', process.execPath, 'another.js'], {
        env,
        stdio: 'pipe',
      });
      const refused = run(args, root, env);
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /different phoneuse MCP registration/);
      assert.equal(
        JSON.parse(
          execFileSync('codex', ['mcp', 'get', 'phoneuse', '--json'], { env, encoding: 'utf8' }),
        ).transport.args[0],
        'another.js',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
