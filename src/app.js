/**
 * UI layer: file intake, progress, and download. All work happens on this
 * page; no data leaves the browser and nothing is written to storage.
 */
import { pdfToMarkdown } from './converter.js';
import { loadEngine, engineOptions } from './engine.js';

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('file-input');
const results = document.getElementById('results');
const bulk = document.getElementById('bulk');
const template = document.getElementById('result-template');
const engineStatus = document.getElementById('engine-status');

/** In-memory only: cleared on reload, never persisted. */
const converted = [];
let queue = Promise.resolve();

loadEngine().then(
  () => {
    engineStatus.textContent = 'Engine ready — offline.';
    engineStatus.classList.add('ready');
  },
  (error) => {
    engineStatus.textContent = `Engine failed to load: ${error.message}`;
    engineStatus.classList.add('error');
  },
);

/* ------------------------------------------------------------------ */
/* Intake                                                              */
/* ------------------------------------------------------------------ */

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    fileInput.click();
  }
});

fileInput.addEventListener('change', () => {
  accept(fileInput.files);
  fileInput.value = '';
});

for (const type of ['dragenter', 'dragover']) {
  dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    dropzone.classList.add('is-active');
  });
}
for (const type of ['dragleave', 'drop']) {
  dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    if (type === 'drop' || event.target === dropzone) dropzone.classList.remove('is-active');
  });
}
dropzone.addEventListener('drop', (event) => accept(event.dataTransfer?.files));

// Dropping a file anywhere else should not make the browser navigate to it.
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => event.preventDefault());

function accept(fileList) {
  for (const file of [...(fileList || [])]) {
    if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
      // Convert one at a time: a single pdf.js worker, predictable memory.
      queue = queue.then(() => convert(file));
    } else {
      createCard(file.name).fail('Not a PDF — skipped.');
    }
  }
}

/* ------------------------------------------------------------------ */
/* Conversion                                                          */
/* ------------------------------------------------------------------ */

async function convert(file) {
  const card = createCard(file.name);
  try {
    const lib = await loadEngine();
    const data = new Uint8Array(await file.arrayBuffer());
    const started = performance.now();
    const { markdown, stats } = await pdfToMarkdown(lib, data, readOptions(), {
      onProgress: (done, total) => card.setProgress(done, total),
      onPassword: (reason) =>
        window.prompt(
          reason === 2
            ? `Incorrect password. Try again for "${file.name}":`
            : `"${file.name}" is password protected. Enter its password:`,
        ),
    });
    const elapsed = Math.max(1, Math.round(performance.now() - started));
    const name = file.name.replace(/\.pdf$/i, '') + '.md';

    card.finish({
      markdown,
      meta: `${stats.pages} page${stats.pages === 1 ? '' : 's'} · ${stats.words.toLocaleString()} words · ${elapsed} ms`,
      note: stats.likelyScanned
        ? 'Almost no text found — this looks like a scan of images. Recognising text from images (OCR) is not something this offline converter does.'
        : '',
      filename: name,
    });
    converted.push({ filename: name, markdown });
    bulk.hidden = false;
  } catch (error) {
    card.fail(describeError(error));
  }
}

function describeError(error) {
  const name = error?.name || '';
  if (name === 'PasswordException') return 'Password required — conversion cancelled.';
  if (name === 'InvalidPDFException') return 'This file is not a valid PDF.';
  return error?.message || 'Conversion failed.';
}

function readOptions() {
  const options = engineOptions();
  for (const input of document.querySelectorAll('[data-option]')) {
    options[input.dataset.option] = input.checked;
  }
  return options;
}

/* ------------------------------------------------------------------ */
/* Result cards                                                        */
/* ------------------------------------------------------------------ */

function createCard(filename) {
  const node = template.content.firstElementChild.cloneNode(true);
  const nameEl = node.querySelector('.result-name');
  const metaEl = node.querySelector('.result-meta');
  const noteEl = node.querySelector('.result-note');
  const bodyEl = node.querySelector('.result-body code');
  const progress = node.querySelector('.progress');
  const bar = node.querySelector('.progress-bar');
  const copyBtn = node.querySelector('[data-action="copy"]');
  const downloadBtn = node.querySelector('[data-action="download"]');

  nameEl.textContent = filename;
  metaEl.textContent = 'Reading…';
  copyBtn.disabled = true;
  downloadBtn.disabled = true;
  results.prepend(node);

  return {
    setProgress(done, total) {
      bar.style.width = `${Math.round((done / total) * 100)}%`;
      metaEl.textContent = `Converting page ${done} of ${total}…`;
    },
    finish({ markdown, meta, note, filename: outName }) {
      progress.hidden = true;
      metaEl.textContent = meta;
      bodyEl.textContent = markdown;
      if (note) {
        noteEl.textContent = note;
        noteEl.hidden = false;
      }
      copyBtn.disabled = false;
      downloadBtn.disabled = false;
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(markdown);
          flash(copyBtn, 'Copied');
        } catch {
          selectText(bodyEl);
          flash(copyBtn, 'Press ⌘C');
        }
      });
      downloadBtn.addEventListener('click', () => download(outName, markdown));
    },
    fail(message) {
      progress.hidden = true;
      node.classList.add('is-error');
      metaEl.textContent = message;
      bodyEl.textContent = '';
    },
  };
}

function flash(button, label) {
  const original = button.textContent;
  button.textContent = label;
  setTimeout(() => {
    button.textContent = original;
  }, 1400);
}

function selectText(element) {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

function download(filename, markdown) {
  const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

document.getElementById('download-all').addEventListener('click', () => {
  converted.forEach((file, i) => setTimeout(() => download(file.filename, file.markdown), i * 150));
});

document.getElementById('clear-all').addEventListener('click', () => {
  converted.length = 0;
  results.replaceChildren();
  bulk.hidden = true;
});
