import { execFile } from 'node:child_process';
import { parseArgs, promisify } from 'node:util';
import { ensureTyaHome, TYA_HOME_ENV } from '../core/home.js';
import { PayloadStore } from '../core/payload-store.js';
import { DEFAULT_PORT, startServer } from '../server/server.js';
import { TraceStore } from '../store/store.js';
import { err, out } from './util.js';

const HELP = `tya serve — Start the local web UI (localhost only)

Usage: tya serve [options]

Options:
  --port <N>   Port to listen on (default: ${DEFAULT_PORT}; if busy, the next
               port is tried, up to 10 attempts)
  --home <dir> Data directory override (default: $TYA_HOME or ~/.trace-your-agent)
  --no-open    Do not open the browser automatically
  -h, --help   Show this help
`;

const execFileAsync = promisify(execFile);

/** Open the URL in the default browser (macOS `open`). Failure is only a warning. */
async function openBrowser(url: string): Promise<void> {
  try {
    await execFileAsync('open', [url]);
  } catch (error) {
    err(`tya serve: warning: could not open the browser: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Resolve once SIGINT or SIGTERM arrives. */
function waitForShutdownSignal(): Promise<string> {
  return new Promise((resolveSignal) => {
    process.once('SIGINT', () => resolveSignal('SIGINT'));
    process.once('SIGTERM', () => resolveSignal('SIGTERM'));
  });
}

export async function runServeCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      port: { type: 'string' },
      home: { type: 'string' },
      'no-open': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
    strict: false,
  });
  if (values.help === true) {
    out(HELP);
    return 0;
  }

  let port = DEFAULT_PORT;
  if (values.port !== undefined) {
    port = Number(values.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      err('tya serve: --port must be an integer between 1 and 65535');
      return 1;
    }
  }

  const homeOverride = typeof values.home === 'string' ? values.home : undefined;
  const env = homeOverride !== undefined ? { ...process.env, [TYA_HOME_ENV]: homeOverride } : process.env;
  const home = ensureTyaHome(env);
  const store = new TraceStore(home.dbPath);
  try {
    const server = await startServer({
      store,
      payloads: new PayloadStore(home.homeDir),
      port,
    });
    out(`tya serve: listening on ${server.url}  (home: ${home.homeDir})`);
    if (values['no-open'] !== true) await openBrowser(server.url);

    const signal = await waitForShutdownSignal();
    out(`tya serve: ${signal} received, shutting down`);
    await server.close();
    return 0;
  } finally {
    store.close();
  }
}
