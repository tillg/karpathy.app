// The settings CLI (`just settings …`): render the files the components read, show or check the settings.
//   render <env> --out <dir> --secrets <dir> [--compose-dir <dir>]
//   show <env>          the merged settings, secrets as references
//   check               every environment validates
//   --list-secrets <env> the secret names the environment uses, one per line
// All take --dir <settings dir> (default deploy/settings/).
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Document, isMap, visit } from 'yaml';
import { environments, loadSettings, SETTINGS_DIR } from './load.js';
import { renderBackendSettings, renderComposeEnv, renderOpencodeEnv, renderOpencodeProviders } from './render.js';
import { resolveSecrets, secretRefs } from './secrets.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string' },
    secrets: { type: 'string' },
    'compose-dir': { type: 'string' },
    dir: { type: 'string', default: SETTINGS_DIR },
    'list-secrets': { type: 'string' },
  },
});
const dir = values.dir!;

function usage(): never {
  console.error('usage: settings render <env> --out <dir> --secrets <dir> [--compose-dir <dir>] | show <env> | check | --list-secrets <env>');
  process.exit(2);
}

function run(): void {
  if (values['list-secrets']) {
    const names = new Set(secretRefs(loadSettings(values['list-secrets'], { dir })).map((r) => r.name));
    console.log([...names].join('\n'));
    return;
  }
  const [cmd, env] = positionals;
  if (cmd === 'check') {
    for (const e of environments(dir)) loadSettings(e, { dir });
    return;
  }
  if (cmd === 'show' && env) {
    const doc = new Document(loadSettings(env, { dir }));
    visit(doc, { Map: (_, node) => void (isMap(node) && node.has('secret') && (node.flow = true)) });
    process.stdout.write(doc.toString({ lineWidth: 0 }));
    return;
  }
  if (cmd === 'render' && env && values.out && values.secrets) {
    const settings = loadSettings(env, { dir });
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
    write('opencode-providers.json', JSON.stringify(renderOpencodeProviders(settings), null, 2) + '\n');
    write('settings.json', renderBackendSettings(settings, secrets));
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
