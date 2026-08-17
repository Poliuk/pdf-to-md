/**
 * Loads the bundled pdf.js engine from the local vendor folder.
 *
 * `npm run build` swaps this module for one that carries pdf.js inline, so the
 * single-file build has no side files to fetch. Keep the exported shape
 * (loadEngine, engineOptions) in step with build.mjs.
 */
const PDFJS_URL = new URL('../vendor/pdf.min.mjs', import.meta.url);
const WORKER_URL = new URL('../vendor/pdf.worker.min.mjs', import.meta.url);
const CMAP_URL = new URL('../vendor/cmaps/', import.meta.url);

let engine = null;

export async function loadEngine() {
  if (!engine) {
    const pdfjsLib = await import(PDFJS_URL.href);
    pdfjsLib.GlobalWorkerOptions.workerSrc = WORKER_URL.href;
    engine = pdfjsLib;
  }
  return engine;
}

/** Engine-level conversion options, separate from the user's checkboxes. */
export function engineOptions() {
  return { cMapUrl: CMAP_URL.href };
}
