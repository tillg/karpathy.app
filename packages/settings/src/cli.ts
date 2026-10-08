// The settings CLI (`just settings …`): render the files the components read, show or check the settings.
//   render <env> --out <dir> --secrets <dir> [--compose-dir <dir>]
//   show <env>          the merged settings, secrets as references
//   get <env> <path>    one value, e.g. `get test ai.model`
//   check               every environment validates
//   --list-secrets <env> the secret names the environment uses, one per line
// All take --dir <settings dir> (default deploy/settings/) and --no-local (ignore <env>.local.yaml).
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Document, isMap, visit } from 'yaml';
import { environments, loadSettings, SETTINGS_DIR } from './load.js';
import { renderBackendSettings, renderComposeEnv, renderIngestConfig, renderOpencodeEnv } from './render.js';
import { resolveSecrets, secretRefs } from './secrets.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string' },
    secrets: { type: 'string' },
    'compose-dir': { type: 'string' },
    dir: { type: 'string', default: SETTINGS_DIR },
    'list-secrets': { type: 'string' },
    /** Ignore <env>.local.yaml (tests of the committed files). */
    'no-local': { type: 'boolean', default: false },
  },
});
const dir = values.dir!;
const overlay = !values['no-local'];

function usage(): never {
  console.error('usage: settings render <env> --out <dir> --secrets <dir> [--compose-dir <dir>] | show <env> | get <env> <path> | check | --list-secrets <env>');
  process.exit(2);
}

function run(): void {
  if (values['list-secrets']) {
    const names = new Set(secretRefs(loadSettings(values['list-secrets'], { dir, overlay })).map((r) => r.name));
    console.log([...names].join('\n'));
    return;
  }
  const [cmd, env] = positionals;
  if (cmd === 'check') {
    for (const e of environments(dir)) loadSettings(e, { dir, overlay });
    return;
  }
  if (cmd === 'get' && env && positionals[2]) {
    let v: unknown = loadSettings(env, { dir, overlay });
    for (const k of positionals[2].split('.')) v = (v as Record<string, unknown> | undefined)?.[k];
    if (v === undefined) throw new Error(`${env}: no setting ${positionals[2]}`);
    console.log(typeof v === 'string' ? v : JSON.stringify(v));
    return;
  }
  if (cmd === 'show' && env) {
    const doc = new Document(loadSettings(env, { dir, overlay }));
    visit(doc, { Map: (_, node) => void (isMap(node) && node.has('secret') && (node.flow = true)) });
    process.stdout.write(doc.toString({ lineWidth: 0 }));
    return;
  }
  if (cmd === 'render' && env && values.out && values.secrets) {
    const settings = loadSettings(env, { dir, overlay });
    const secrets = resolveSecrets(settings, values.secrets);
    const out = resolve(values.out);
    const settingsDir = values['compose-dir'] ? relative(resolve(values['compose-dir']), out) : undefined;
    mkdirSync(out, { recursive: true });
    const write = (name: string, content: string, mode = 0o644) => {
      writeFileSync(join(out, name), content, { mode });
      chmodSync(join(out, name), mode);
    };
    write('.env', renderComposeEnv(settings, secrets, { settingsDir }), 0o600);
    write('opencode.env', renderOpencodeEnv(settings, secrets), 0o600);
    write('settings.json', renderBackendSettings(settings, secrets));
    write('ingest.json', renderIngestConfig(settings, secrets), 0o600);
    return;
  }
  usage();
}

try {
  run();
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
