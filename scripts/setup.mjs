#!/usr/bin/env node
/** Installs the checkout-backed PhoneUse skill and registers its managed stdio MCP launcher. */
import { access, cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

/** Install paths use the script's checkout rather than the invoking shell's directory. */
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** These runtime overrides must match between onboarding and later MCP sessions. */
const runtimeEnvironmentKeys = [
  'PHONEUSE_STATE_DIR',
  'PHONEUSE_PHONE_PORT',
  'PHONEUSE_ADMIN_PORT',
  'PHONEUSE_ADVERTISE_HOST',
];

/** Parses explicit install targets; no flags only show usage and never change user configuration. */
export function parseOptions(args) {
  const options = { skill: false, codex: false, print: false, help: args.length === 0 };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === '--skill') {
      options.skill = true;
    } else if (argument === '--codex') {
      options.codex = true;
      options.skill = true;
    } else if (argument === '--print') {
      options.print = true;
    } else if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else if (argument === '--skill-dir') {
      const value = args[++index];

      if (!value || value.startsWith('--')) {
        throw new Error('Provide a parent directory after --skill-dir.');
      }

      options.skillDir = resolve(value);
    } else {
      throw new Error(`Unknown setup option: ${argument}`);
    }
  }

  if (options.skillDir && !options.skill && !options.print && !options.help) {
    throw new Error('Use --skill or --codex with --skill-dir.');
  }

  return options;
}

/** Builds secret-free metadata and generic MCP configuration suitable for any stdio host. */
export function installationPlan(options, root = repositoryRoot, environment = process.env) {
  const nodePath = process.execPath;
  const mcpEntry = join(root, 'bridge/dist/src/mcp-launcher.js');
  const env = Object.fromEntries(
    runtimeEnvironmentKeys
      .filter((key) => environment[key] !== undefined)
      .map((key) => [
        key,
        key === 'PHONEUSE_STATE_DIR' ? resolve(environment[key]) : environment[key],
      ]),
  );

  return {
    repositoryRoot: root,
    nodePath,
    mcpEntry,
    skillDestination: join(options.skillDir ?? join(homedir(), '.agents/skills'), 'phoneuse'),
    mcpServers: {
      phoneuse: {
        command: nodePath,
        args: [mcpEntry],
        ...(Object.keys(env).length ? { env } : {}),
      },
    },
  };
}

/** Distinguishes absent files from permissions and other errors that must stop installation. */
async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }

    throw error;
  }
}

/** Refuses to overwrite another skill; repeat installs update only a matching checkout's files. */
async function checkSkillDestination(plan) {
  if (!(await exists(plan.skillDestination))) {
    return;
  }

  let saved;

  try {
    saved = JSON.parse(await readFile(join(plan.skillDestination, 'installation.json'), 'utf8'));
  } catch {
    throw new Error(
      `A skill already exists at ${plan.skillDestination}. Move it aside or choose --skill-dir before installing.`,
    );
  }

  if (saved.repositoryRoot !== plan.repositoryRoot) {
    throw new Error(
      'The installed PhoneUse skill belongs to another checkout. Move it aside or choose --skill-dir.',
    );
  }
}

/** Reads Codex metadata without logging the user's other configuration or environment variables. */
function checkCodexRegistration(plan) {
  execFileSync('codex', ['--version'], { stdio: 'pipe', timeout: 10_000 });
  const servers = JSON.parse(
    execFileSync('codex', ['mcp', 'list', '--json'], {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 10_000,
    }),
  );

  if (!Array.isArray(servers)) {
    throw new Error('Codex returned an unexpected MCP configuration. Upgrade Codex and try again.');
  }

  const existing = servers.find((server) => server.name === 'phoneuse');

  if (!existing) {
    return false;
  }

  const transport = existing.transport;

  if (
    transport?.type === 'stdio' &&
    transport.command === plan.nodePath &&
    Array.isArray(transport.args) &&
    transport.args.length === 1 &&
    transport.args[0] === plan.mcpEntry &&
    runtimeEnvironmentKeys.every(
      (key) => transport.env?.[key] === plan.mcpServers.phoneuse.env?.[key],
    )
  ) {
    return true;
  }

  throw new Error(
    'Codex already has a different phoneuse MCP registration. Review it with codex mcp get phoneuse, then remove it before installing this checkout.',
  );
}

/** Checks installation conflicts before onboarding downloads tools or builds the Android app. */
export async function preflightSetup(options, { requireBuilt = false } = {}) {
  const plan = installationPlan(options);

  if (Number(process.versions.node.split('.')[0]) < 22) {
    throw new Error('PhoneUse requires Node 22 or later.');
  }

  if (requireBuilt) {
    try {
      await access(plan.mcpEntry, constants.R_OK);
      await access(join(repositoryRoot, 'node_modules/@modelcontextprotocol/sdk/package.json'));
    } catch {
      throw new Error('PhoneUse is not built. Run npm ci and npm run build, then run setup again.');
    }
  }

  try {
    execFileSync('openssl', ['version'], { stdio: 'pipe', timeout: 10_000 });
  } catch {
    throw new Error('OpenSSL is required. Install it and run setup again.');
  }

  if (options.skill || options.codex) {
    await checkSkillDestination(plan);
  }

  let registered = false;

  if (options.codex) {
    try {
      registered = checkCodexRegistration(plan);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error(
          'Codex CLI was not found. Install it or use --skill and configure MCP manually.',
        );
      }

      // Child process errors may contain user configuration in stdout; do not print them.
      if (error.status !== undefined || error.signal) {
        throw new Error(
          'Could not read Codex MCP configuration. Check codex mcp list before retrying.',
        );
      }

      throw error;
    }
  }

  return { plan, registered };
}

/** Validates prerequisites before writes, then installs only the explicitly selected targets. */
export async function setup(args = process.argv.slice(2)) {
  const options = parseOptions(args);

  if (options.help) {
    console.log(
      `PhoneUse setup\n\nRun npm ci and npm run build first.\n\n  npm run setup -- --codex                 Install skill and register Codex MCP\n  npm run setup -- --skill                 Install skill only\n  npm run setup -- --skill --skill-dir DIR Use another skill parent directory\n  npm run setup -- --print                 Preview paths and generic MCP JSON\n\nThe checkout must stay at this path. Start a new agent session after installation.\nAndroid installation, pairing, and enabling phone control remain on-device steps.`,
    );
    return;
  }

  if (options.print) {
    console.log(JSON.stringify(installationPlan(options), null, 2));
    return;
  }

  const { plan, registered } = await preflightSetup(options, { requireBuilt: true });

  if (options.skill) {
    try {
      await mkdir(dirname(plan.skillDestination), { recursive: true });
      await cp(join(repositoryRoot, 'skills/phoneuse'), plan.skillDestination, { recursive: true });
      await writeFile(
        join(plan.skillDestination, 'installation.json'),
        `${JSON.stringify(
          { repositoryRoot, nodePath: plan.nodePath, mcpEntry: plan.mcpEntry },
          null,
          2,
        )}\n`,
      );
    } catch {
      throw new Error(
        `Could not install the skill at ${plan.skillDestination}. Check directory permissions. Codex MCP configuration was not changed.`,
      );
    }

    console.log(`Installed PhoneUse skill: ${plan.skillDestination}`);
  }

  if (options.codex && !registered) {
    try {
      const environmentArgs = Object.entries(plan.mcpServers.phoneuse.env ?? {}).flatMap(
        ([key, value]) => ['--env', `${key}=${value}`],
      );
      execFileSync(
        'codex',
        ['mcp', 'add', 'phoneuse', ...environmentArgs, '--', plan.nodePath, plan.mcpEntry],
        {
          stdio: 'pipe',
          timeout: 10_000,
        },
      );
    } catch {
      throw new Error(
        'The skill was installed, but Codex MCP registration failed. Check codex mcp list, then rerun setup to finish registration.',
      );
    }
  }

  if (options.codex) {
    console.log(`PhoneUse MCP ${registered ? 'already registered' : 'registered'} with Codex.`);
  }

  console.log(
    'Start a new agent session, then ask it to use PhoneUse. Pair and allow control on the phone.',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  setup().catch((error) => {
    console.error(error instanceof Error ? error.message : 'PhoneUse setup failed.');
    process.exitCode = 1;
  });
}
