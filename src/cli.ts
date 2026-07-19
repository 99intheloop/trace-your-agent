#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { runDoctorCommand } from './cli/doctor.js';
import { runExportCommand } from './cli/export.js';
import { runHooksCommand } from './cli/hooks.js';
import { runIngestCommand } from './cli/ingest.js';
import { runPruneCommand } from './cli/prune.js';
import { runServeCommand } from './cli/serve.js';
import { runSessionsCommand } from './cli/sessions.js';
import { runShowCommand } from './cli/show.js';

/**
 * tya — trace-your-agent CLI.
 */

const SUBCOMMANDS = [
  ['doctor', 'Check environment: detect agent homes, readability, DB health'],
  ['ingest', 'Parse agent session logs into the local span store'],
  ['serve', 'Start the local web UI (localhost only)'],
  ['sessions', 'List recorded sessions'],
  ['show', 'Show the span tree of one session'],
  ['export', 'Export a session/trace (NDJSON or self-contained HTML)'],
  ['prune', 'Delete old payloads from local trace data'],
  ['install-hooks', 'Install the Claude Code SubagentStop hook for join capture'],
  ['uninstall-hooks', 'Remove the hook installed by install-hooks'],
] as const;

type Subcommand = (typeof SUBCOMMANDS)[number][0];

function printHelp(): void {
  const lines = SUBCOMMANDS.map(([name, desc]) => `    ${name.padEnd(16)}${desc}`).join('\n');
  process.stdout.write(`tya — trace-your-agent: local-first traces for Claude Code / Codex / Kimi Code

Usage: tya <command> [options]

Commands:
${lines}

Options:
  -h, --help      Show this help
  -v, --version   Show version

Environment:
  TYA_HOME        Data directory override (default: ~/.trace-your-agent)

Run \`tya <command> --help\` for command-specific options.
`);
}

function printVersion(): void {
  process.stdout.write('tya 0.1.0\n');
}

async function runSubcommand(command: Subcommand, args: string[]): Promise<number> {
  switch (command) {
    case 'doctor':
      return runDoctorCommand(args);
    case 'ingest':
      return runIngestCommand(args);
    case 'sessions':
      return runSessionsCommand(args);
    case 'show':
      return runShowCommand(args);
    case 'export':
      return runExportCommand(args);
    case 'prune':
      return runPruneCommand(args);
    case 'install-hooks':
      return runHooksCommand(args, true);
    case 'uninstall-hooks':
      return runHooksCommand(args, false);
    case 'serve':
      return runServeCommand(args);
  }
}

export async function main(argv: string[]): Promise<number> {
  // Global flags are only recognized BEFORE the subcommand; everything after
  // the subcommand name is passed through verbatim (node:util parseArgs would
  // otherwise swallow unknown subcommand flags in non-strict mode).
  let commandIndex = 0;
  while (commandIndex < argv.length && argv[commandIndex]?.startsWith('-')) commandIndex += 1;
  const { values } = parseArgs({
    args: argv.slice(0, commandIndex),
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.version === true) {
    printVersion();
    return 0;
  }

  const command = argv[commandIndex];
  const rest = argv.slice(commandIndex + 1);
  const known = SUBCOMMANDS.some(([name]) => name === command);

  if (values.help === true || command === undefined) {
    printHelp();
    return command === undefined && values.help !== true ? 1 : 0;
  }
  if (!known) {
    process.stderr.write(`tya: unknown command '${command}'\n\n`);
    printHelp();
    return 1;
  }
  return runSubcommand(command as Subcommand, rest);
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`tya: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
