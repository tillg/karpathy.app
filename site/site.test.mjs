// Website checks (specs/changes/product-website): assemble _site/ with build.sh, then test the output.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
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

// Exactly the three device shots: nothing stray (e.g. .DS_Store) gets deployed.
test('build copies exactly the three screenshots', () => {
  const shots = ['ipad.webp', 'iphone.webp', 'mac.webp'];
  assert.deepEqual(readdirSync(join(root, 'site/screenshots')).sort(), shots);
  assert.deepEqual(readdirSync(join(out, 'screenshots')).sort(), shots);
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
  assert.match(origin, /<time datetime="2026-04-04"/);
});

// Pixel size of a WebP file, from its first chunk: VP8X (extended), VP8 (lossy) or VP8L (lossless).
const webpSize = (buf) => {
  const chunk = buf.toString('ascii', 12, 16);
  if (chunk === 'VP8X') return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
  if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  if (chunk === 'VP8L') {
    const b = buf.readUInt32LE(21);
    return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
  }
  throw new Error(`not a WebP: ${chunk}`);
};

test('shows the app on Mac, iPad and iPhone', () => {
  const shots = section(page(), 'screenshots');
  assert.ok(shots, 'no #screenshots section');
  const imgs = [...shots.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
  const attr = (img, name) => img.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
  assert.deepEqual(imgs.map((i) => attr(i, 'src')), ['screenshots/mac.webp', 'screenshots/ipad.webp', 'screenshots/iphone.webp']);
  for (const img of imgs) {
    const src = attr(img, 'src');
    assert.ok(attr(img, 'alt')?.trim(), `${src}: no alt`);
    assert.equal(attr(img, 'loading'), 'lazy', `${src}: not lazy`);
    const { width, height } = webpSize(readFileSync(join(out, src)));
    assert.deepEqual([Number(attr(img, 'width')), Number(attr(img, 'height'))], [width, height], `${src}: width/height`);
  }
});

test('screenshots stay under 400 KB', () => {
  const dir = join(root, 'site/screenshots');
  for (const f of readdirSync(dir)) assert.ok(statSync(join(dir, f)).size <= 400 * 1024, `${f} is over 400 KB`);
});

test('the hero links to the origin', () => {
  const hero = page().match(/<section class="hero"[\s\S]*?<\/section>/)?.[0] ?? '';
  assert.match(hero, /href="#origin"/);
});

test('explains self-hosting and offers hosting by mail', () => {
  const selfHost = section(page(), 'self-host');
  assert.ok(selfHost, 'no #self-host section');
  for (const need of [/server/i, /Tailscale/, /secrets/i]) assert.match(selfHost, need);
  assert.match(selfHost, /href="mailto:till\.gartner@gmail\.com/);
});
