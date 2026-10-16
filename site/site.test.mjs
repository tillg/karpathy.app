// Website checks (specs/changes/product-website): assemble _site/ with build.sh, then test the output.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, '_site');

before(() => {
  execFileSync(join(root, 'site/build.sh'), { stdio: 'inherit' });
});

test('build assembles _site', () => {
  assert.ok(existsSync(out));
});

test('build copies site/screenshots', () => {
  const src = join(root, 'site/screenshots');
  assert.ok(existsSync(src), 'no site/screenshots');
  for (const f of readdirSync(src)) assert.ok(existsSync(join(out, 'screenshots', f)), `_site/screenshots/${f} missing`);
});

const page = () => readFileSync(join(out, 'index.html'), 'utf8');
// Local references in the page: every href/src that isn't an absolute URL or a fragment.
const localRefs = (html) =>
  [...html.matchAll(/\b(?:href|src)="([^"]+)"/g)].map((m) => m[1]).filter((u) => !/^(?:[a-z]+:|#)/i.test(u));

test('index.html has title, lang, viewport and repo link', () => {
  const html = page();
  assert.match(html, /<html lang="[a-z]{2}"/);
  assert.match(html, /<title>[^<]*karpathy\.app[^<]*<\/title>/);
  assert.match(html, /<meta name="viewport" content="width=device-width/);
  assert.match(html, /href="https:\/\/github\.com\/tillg\/karpathy\.app"/);
});

// The page must also work under https://tillg.github.io/karpathy.app/ before DNS moves.
test('no root-absolute paths', () => {
  assert.deepEqual(localRefs(page()).filter((u) => u.startsWith('/')), []);
});

test('every local href/src exists in _site', () => {
  const missing = localRefs(page())
    .map((u) => u.split(/[?#]/)[0])
    .filter((u) => u && u !== './' && !existsSync(join(out, u)));
  assert.deepEqual(missing, []);
});

// Custom properties of the light :root block and of the one inside the dark-mode media query.
const tokens = (css) => {
  const block = (re) => {
    const body = css.match(re)?.[1] ?? '';
    return Object.fromEntries(
      [...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]),
    );
  };
  return {
    light: block(/^:root\s*\{([^}]*)\}/m),
    dark: block(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([^}]*)\}/),
  };
};

test("site tokens equal the app's (light and dark)", () => {
  const site = tokens(readFileSync(join(root, 'site/style.css'), 'utf8'));
  const app = tokens(readFileSync(join(root, 'apps/web/src/styles.css'), 'utf8'));
  for (const mode of ['light', 'dark']) {
    assert.ok(Object.keys(site[mode]).length > 0, `site/style.css has no ${mode} tokens`);
    for (const [name, value] of Object.entries(site[mode])) {
      assert.equal(value, app[mode][name], `${mode} ${name} differs from apps/web/src/styles.css`);
    }
  }
});

const section = (html, id) => html.match(new RegExp(`<section id="${id}"[\\s\\S]*?</section>`))?.[0] ?? '';

test("names the idea's origin: Karpathy's tweet and gist", () => {
  const origin = section(page(), 'origin');
  assert.ok(origin, 'no #origin section');
  assert.match(origin, /<blockquote cite="https:\/\/x\.com\/karpathy\/status\/2039805659525644595"/);
  assert.match(origin, /href="https:\/\/x\.com\/karpathy\/status\/2039805659525644595"/);
  assert.match(origin, /href="https:\/\/gist\.github\.com\/karpathy\/442a6bf555914893e9891c11519de94f"/);
  assert.match(origin, /<time datetime="2026-04-02"/);
});

test('the hero links to the origin', () => {
  const hero = page().match(/<section class="hero"[\s\S]*?<\/section>/)?.[0] ?? '';
  assert.match(hero, /href="#origin"/);
});

test('explains self-hosting and offers hosting by mail', () => {
  const html = page();
  const section = html.match(/<section id="self-host"[\s\S]*?<\/section>/)?.[0] ?? '';
  assert.ok(section, 'no #self-host section');
  for (const need of [/server/i, /Tailscale/, /secrets/i]) assert.match(section, need);
  assert.match(section, /href="mailto:till\.gartner@gmail\.com/);
});
