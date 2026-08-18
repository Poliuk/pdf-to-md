/**
 * Builds dist/pdf-to-md.html: the whole app, pdf.js included, in one file that
 * runs by double-clicking it. No server, no side files, no network.
 *
 * pdf.js is handed to the page as blob URLs rather than pasted into the page
 * source, which keeps the engine an ES module (as it expects) and lets its
 * worker start the way it normally would.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const root = new URL('./', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

/** Fail loudly rather than emit a build that is quietly missing something. */
function expect(condition, message) {
  if (!condition) throw new Error(`build: ${message}`);
}

const [html, css, converter, app, pdfjs, worker] = await Promise.all([
  read('index.html'),
  read('assets/styles.css'),
  read('src/converter.js'),
  read('src/app.js'),
  read('vendor/pdf.min.mjs'),
  read('vendor/pdf.worker.min.mjs'),
]);

// The modules are concatenated into one inline script, so their import and
// export keywords have to go. Both files are ours, so the shapes are known.
const strip = (source, label) => {
  const withoutImports = source.replace(/^import[^;]*;\s*$/gm, '');
  expect(!/^\s*import\s/m.test(withoutImports), `unhandled import statement in ${label}`);
  return withoutImports.replace(/^export\s+(?=(const|function|async|class|let)\s)/gm, '');
};

expect(/from '\.\/converter\.js'/.test(app), 'app.js no longer imports converter.js');
expect(/from '\.\/engine\.js'/.test(app), 'app.js no longer imports engine.js');
expect(/loadEngine\b/.test(app) && /engineOptions\b/.test(app), 'app.js no longer uses the engine module');

// Stands in for src/engine.js: same two exports, sources carried inline.
const inlineEngine = `
const PDFJS_SOURCE = ${JSON.stringify(pdfjs)};
const WORKER_SOURCE = ${JSON.stringify(worker)};

const asModuleUrl = (source) => URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));

let engine = null;

async function loadEngine() {
  if (!engine) {
    const pdfjsLib = await import(asModuleUrl(PDFJS_SOURCE));
    pdfjsLib.GlobalWorkerOptions.workerSrc = asModuleUrl(WORKER_SOURCE);
    engine = pdfjsLib;
  }
  return engine;
}

// The single-file build carries no CMap folder, so documents that rely on the
// predefined CJK CMaps extract less cleanly here than in the served version.
function engineOptions() {
  return {};
}
`;

const script = `${inlineEngine}\n${strip(converter, 'converter.js')}\n${strip(app, 'app.js')}`;

let output = html;

const before = output;
output = output.replace(
  /<link rel="stylesheet" href="assets\/styles\.css" \/>/,
  () => `<style>\n${css}\n    </style>`,
);
expect(output !== before, 'stylesheet link not found in index.html');

// Inline code needs 'unsafe-inline'; everything else stays shut off.
output = output.replace(
  /content="default-src 'none';[^"]*"/,
  () => `content="default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob:; style-src 'unsafe-inline'; img-src 'self' data:; connect-src blob: data:; base-uri 'none'; form-action 'none'"`,
);
expect(/script-src 'unsafe-inline' blob:/.test(output), 'content security policy not found in index.html');

output = output.replace(
  /<script type="module" src="src\/app\.js"><\/script>/,
  () => `<script type="module">\n${script}\n</script>`,
);
expect(!/src="src\/app\.js"/.test(output), 'module script tag not found in index.html');

// A single file has no sibling to load, so say so on the page itself.
output = output.replace(
  /Powered by\s*\n?\s*<a href="https:\/\/mozilla\.github\.io\/pdf\.js\/"[^>]*>pdf\.js<\/a>, bundled locally\./,
  () =>
    'Single file. <a href="https://mozilla.github.io/pdf.js/" rel="noreferrer noopener">pdf.js</a> is built in.',
);
expect(/Single file\. <a href="https:\/\/mozilla\.github\.io\/pdf\.js\/"[^>]*>pdf\.js<\/a> is built in\./.test(output), 'colophon text not found in index.html');

await mkdir(new URL('dist/', root), { recursive: true });
await writeFile(new URL('dist/pdf-to-md.html', root), output);

const megabytes = (output.length / 1024 / 1024).toFixed(2);
console.log(`built dist/pdf-to-md.html (${megabytes} MB). Open it directly in a browser.`);
