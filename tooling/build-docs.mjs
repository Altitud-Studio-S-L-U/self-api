import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const source = readFileSync(path.join(root, 'docs', 'technical-guide.html'));
const html = new TextDecoder('utf-8', { fatal: true }).decode(source);
const sourceHash = createHash('sha256').update(source).digest('hex');
const version=JSON.parse(readFileSync(path.join(root,'package.json'),'utf8')).version;
assert(html.includes(`Keepseam Client ${version}`),'Technical source must identify the current package version.');
const target = path.join(root, 'docs', 'technical-guide.pdf');
const pages = 24;
assert(!/<script\b|<(?:iframe|img|link)\b|@import|url\s*\(/i.test(html), 'Technical source must be self-contained and script-free.');
const check = (pdf) => {
  const encoded = pdf.toString('latin1');
  assert(encoded.startsWith('%PDF-'), 'Technical guide must be a genuine PDF.');
  assert(encoded.includes(`source-sha256=${sourceHash}`), 'Technical PDF is stale; regenerate it after changing its HTML source.');
  assert(encoded.includes(`client-version=${version} |`),'Technical PDF does not identify the current client version.');
  assert.equal((encoded.match(/\/Type\s*\/Page\b/g) || []).length, pages, 'Unexpected technical guide page count.');
};
if (args.length === 1 && args[0] === '--check') {
  check(readFileSync(target));
  console.log(`Technical PDF: source hash and ${pages} pages PASS.`);
} else {
  assert(args.length === 2 && args[0] === '--playwright-root', 'Usage: node tooling/build-docs.mjs --check | --playwright-root <installed package root>');
  const require = createRequire(path.resolve(args[1], 'package.json'));
  assert.equal(require('@playwright/test/package.json').version, '1.63.0', 'Use reviewed Playwright 1.63.0 and its bundled Chromium.');
  const browser = await require('@playwright/test').chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ locale: 'es-ES', timezoneId: 'UTC', viewport: { width: Math.floor(182 * 96 / 25.4), height: Math.floor(269 * 96 / 25.4) }, reducedMotion: 'reduce' });
    await page.route('**/*', (route) => route.abort());
    await page.setContent(html, { waitUntil: 'load' });
    await page.emulateMedia({ media: 'print' });
    await page.evaluate(async (title) => { document.title = title; await document.fonts.ready; }, `Keepseam Client | client-version=${version} | source-sha256=${sourceHash}`);
    const layout = await page.evaluate(() => [...document.querySelectorAll('.page')].map((section, index) => ({
      page: index + 1,
      content: section.scrollHeight,
      box: section.clientHeight,
      gap: section.querySelector('footer').getBoundingClientRect().top - Math.max(...[...section.children].filter((child) => child.tagName !== 'FOOTER').map((child) => child.getBoundingClientRect().bottom)),
    })));
    assert.equal(layout.length, pages);
    assert(layout.every((entry) => entry.content <= entry.box + 1 && entry.gap >= 8), `A4 guide overflows: ${JSON.stringify(layout)}`);
    const raw = await page.pdf({ format: 'A4', margin: { top: '14mm', right: '14mm', bottom: '14mm', left: '14mm' }, printBackground: true, preferCSSPageSize: true, tagged: true });
    // Fixed width keeps PDF offsets intact and gives repeatable metadata.
    const pdf = Buffer.from(raw.toString('latin1').replace(/D:\d{14}\+00'00'/g, "D:20261011000000+00'00'"), 'latin1');
    check(pdf);
    writeFileSync(target, pdf);
    console.log(`Technical guide: ${pages} A4 pages, ${pdf.length} bytes, SHA256 ${createHash('sha256').update(pdf).digest('hex')}.`);
  } finally {
    await browser.close();
  }
}
