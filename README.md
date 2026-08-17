# PDF → Markdown

Convert PDF files to Markdown in the browser. Your files never leave the machine: there is no upload, no backend, and nothing is written to storage.

![No dependencies to install](https://img.shields.io/badge/dependencies-none-brightgreen) ![Runs offline](https://img.shields.io/badge/network-never-blue)

## Why it is actually offline

Three things, rather than a promise:

- **No network code.** The app contains no `fetch` to any remote host. [pdf.js](https://mozilla.github.io/pdf.js/) is vendored into `vendor/`, so nothing is pulled from a CDN at runtime.
- **A Content Security Policy that forbids it.** `index.html` declares `default-src 'none'` with no remote origin allowed anywhere. If some future change tried to phone home, the browser would block it rather than trust the code to behave.
- **No storage.** No `localStorage`, no `IndexedDB`, no cookies, no service worker. Converted text lives in a JavaScript variable and is gone when you close the tab.

You can confirm all of this yourself: open the browser devtools Network panel, convert a file, and watch nothing leave.

## Running it

**Option 1 — one file, no server.** Build it, then open the file:

```bash
npm run build
```

That writes `dist/pdf-to-md.html` (~1.7 MB), a single self-contained page with pdf.js built in. Double-click it, or open it from any folder, USB stick, or air-gapped machine. No install, no server, no internet.

**Option 2 — serve the source.** Browsers refuse to load ES modules over `file://`, so the unbundled version needs a static file server:

```bash
npm start
```

Then open <http://127.0.0.1:8123>. The server (`serve.mjs`, ~50 lines, no dependencies) only hands out files from this folder — it never sees a PDF. Any static server does the same job, for example `python3 -m http.server`.

Node is used only to build and to serve. The converter itself is plain browser JavaScript.

## What it converts

| PDF feature | Markdown output | How it is worked out |
| --- | --- | --- |
| Headings | `#` … `######` | Font size relative to body text; short bold lines also count |
| Paragraphs | Reflowed text | Line spacing and indentation, with wrapping undone |
| Hyphenated line breaks | Rejoined words | `environ-` + `ment` → `environment` |
| Bullet & numbered lists | `-` and `1.` | Leading marker glyphs; nesting from indentation |
| Bold / italic | `**` / `*` | Embedded font names and flags |
| Monospace runs | `` ` `` and fenced blocks | Font family, with indentation preserved |
| Tables | Pipe tables | Column positions repeating across consecutive rows |
| Hyperlinks | `[text](url)` | Link annotations matched to the text under them |
| Two-column layouts | Correct reading order | A near-empty vertical gutter splits the page |
| Repeated page headers/footers | Dropped | Same text in the top or bottom margin across pages |
| Sentences split across pages | Stitched together | Rejoined when the previous page ends mid-sentence |

Every one of these can be switched off individually under **Conversion options**, plus two that are off by default: page-break markers and YAML front matter from the PDF's metadata.

Encrypted PDFs are supported — you are prompted for the password, which is used locally and never stored.

## What it does not do

- **Scanned PDFs.** If a page is a photograph of text, there is no text to extract. The app detects this and says so rather than handing you an empty file. OCR would mean shipping a recognition model, which is a much larger project.
- **Complex tables.** Merged cells, nested tables, and borderless tables with ragged columns are approximated or missed. Markdown has no syntax for merged cells anyway.
- **Three or more columns**, and pages that switch between column counts mid-page. Two-column detection deliberately bails out rather than risk scrambling the text.
- **Images.** Text only; figures are skipped.
- **Right-to-left scripts** are extracted but not reordered.
- The **single-file build** omits the CJK CMap tables (they would triple its size), so some Chinese, Japanese, and Korean PDFs extract better through `npm start` than through `dist/pdf-to-md.html`.

Structure is inferred from geometry, because that is all a PDF really contains — it stores positioned glyphs, not documents. Expect good results on ordinary text documents and rough edges on unusual layouts.

## Project layout

```
index.html          markup, and the Content Security Policy
assets/styles.css   styling, light and dark
src/converter.js    the conversion engine — geometry in, Markdown out
src/app.js          file intake, progress, download
src/engine.js       loads pdf.js (build.mjs swaps this for an inline copy)
build.mjs           produces the single-file dist/pdf-to-md.html
serve.mjs           static file server for local development
vendor/             pdf.js, its worker, and the CMap tables (Apache 2.0)
```

`src/converter.js` has no imports and no DOM access. It takes the pdf.js module as an argument, which is what lets the same file run in the browser and under Node for testing.

## Updating pdf.js

```bash
npm pack pdfjs-dist@latest
```

Unpack it and copy `build/pdf.min.mjs`, `build/pdf.worker.min.mjs`, and `cmaps/` into `vendor/`, then run `npm run build` again. The build fails loudly if anything it expects to find has moved.

## Licence

MIT — see [LICENSE](LICENSE). Bundled pdf.js is Apache 2.0, see [vendor/LICENSE.pdfjs](vendor/LICENSE.pdfjs).
