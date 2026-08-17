/**
 * PDF -> Markdown conversion engine.
 *
 * Everything here is pure client-side logic. It takes a pdf.js library object
 * and the raw bytes of a PDF, and returns a Markdown string. Nothing is stored,
 * uploaded, or cached.
 *
 * The strategy is entirely geometric: PDFs have no notion of paragraphs,
 * headings or lists, only positioned glyph runs. We reconstruct structure from
 * the position, size and font of every text item on the page.
 */

export const DEFAULT_OPTIONS = {
  headings: true, // infer heading levels from font size / weight
  lists: true, // infer bullet + numbered lists
  tables: true, // infer pipe tables from column alignment
  emphasis: true, // bold / italic / inline code
  links: true, // hyperlink annotations
  dehyphenate: true, // rejoin words split across lines
  stripRunningHeads: true, // drop repeated page headers / footers
  columns: true, // detect two-column page layouts
  pageBreaks: false, // emit a marker between pages
  frontMatter: false, // emit YAML front matter from PDF metadata
  cMapUrl: null, // local folder of pdf.js CMaps, for CJK documents
};

/** Fraction of an em treated as a word space when items are adjacent. */
const SPACE_RATIO = 0.22;
/** Vertical band at the top/bottom of a page searched for running heads. */
const MARGIN_BAND = 0.09;

const BULLET_RE = /^[ \t]*([•▪▫◦‣·⁃∙○●■□❑✓✔–—*+-])[ \t]+/u;
const ORDERED_RE = /^[ \t]*\(?(\d{1,3})[.)][ \t]+/;
const PAGE_NUM_RE = /^(page\s*)?[-–—(\[]?\s*(\d{1,4}|[ivxlcdm]{1,7})\s*[)\]–—-]?(\s*(of|\/)\s*\d{1,4})?$/i;
const SENTENCE_END_RE = /[.!?:;"”')\]]\s*$/;

/**
 * Convert a PDF into Markdown.
 *
 * @param {object} pdfjsLib  the pdf.js module namespace
 * @param {Uint8Array} data  raw PDF bytes (consumed by pdf.js)
 * @param {object} [options] see DEFAULT_OPTIONS
 * @param {object} [hooks]   { onProgress(done, total), onPassword(reason) }
 * @returns {Promise<{markdown: string, stats: object}>}
 */
export async function pdfToMarkdown(pdfjsLib, data, options = {}, hooks = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const loadingTask = pdfjsLib.getDocument({
    data,
    // Text extraction only: never build font faces or run embedded JS.
    disableFontFace: true,
    isEvalSupported: false,
    // Substitute local system fonts instead of downloading the standard font
    // set — the names alone are all this converter needs.
    useSystemFonts: true,
    ...(opts.cMapUrl ? { cMapUrl: opts.cMapUrl, cMapPacked: true } : {}),
  });

  if (hooks.onPassword) {
    loadingTask.onPassword = (updateCallback, reason) => {
      const password = hooks.onPassword(reason);
      if (password === null || password === undefined) {
        loadingTask.destroy();
        return;
      }
      updateCallback(password);
    };
  }

  const doc = await loadingTask.promise;
  try {
    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      try {
        pages.push(await extractPage(pdfjsLib, page, n, opts));
      } finally {
        page.cleanup();
      }
      hooks.onProgress?.(n, doc.numPages);
    }

    // Headers and footers have to go before columns are worked out: they sit
    // outside the column flow and would otherwise be read as part of it.
    if (opts.stripRunningHeads) stripRunningHeads(pages);
    if (opts.columns) {
      for (const page of pages) {
        page.lines = layoutColumns(page.lines.flatMap((line) => line.glyphs), page.width, page.number);
      }
    }

    const metrics = measureDocument(pages);
    const flow = [];
    for (const page of pages) {
      // page.lines already arrive in reading order, columns resolved.
      const ordered = page.lines;
      ordered.forEach((line, i) => {
        // A gap of null means "no meaningful vertical relationship to the
        // previous line" (start of a page or of a new column).
        line.gapBefore = i === 0 ? null : ordered[i - 1].y <= line.y ? line.y - ordered[i - 1].y : null;
        line.flowBreak = line.gapBefore === null;
      });
      if (ordered.length) ordered[0].pageStart = true;
      flow.push(...ordered);
    }

    // Tables first: a bold table header must not be mistaken for a heading.
    if (opts.tables) markTables(flow, metrics);
    if (opts.headings) assignHeadings(flow, metrics);

    const nodes = buildNodes(flow, metrics, opts);
    const body = nodes.map((node) => renderNode(node, opts)).filter(Boolean).join('\n\n');

    let markdown = body;
    if (opts.frontMatter) {
      const front = await buildFrontMatter(doc);
      if (front) markdown = `${front}\n\n${body}`;
    }
    markdown = tidy(markdown);

    const text = flow.map((l) => l.text).join(' ');
    return {
      markdown,
      stats: {
        pages: doc.numPages,
        characters: text.length,
        words: text.trim() ? text.trim().split(/\s+/).length : 0,
        // No extractable text almost always means a scan: pages are images.
        likelyScanned: text.replace(/\s/g, '').length < doc.numPages * 40,
      },
    };
  } finally {
    await loadingTask.destroy();
  }
}

/* ------------------------------------------------------------------ */
/* Extraction                                                          */
/* ------------------------------------------------------------------ */

async function extractPage(pdfjsLib, page, pageNumber, opts) {
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const hasText = content.items.some((item) => typeof item.str === 'string' && item.str.trim());

  // Text extraction alone never hands the real fonts to this side of the
  // worker, and their names are what tell bold from italic from monospace.
  // Walking the operator list does, so we pay for it only on pages that have
  // text worth styling.
  if (hasText && (opts.emphasis || opts.headings)) {
    try {
      await page.getOperatorList();
    } catch {
      /* styling degrades to plain text */
    }
  }

  const fontCache = new Map();
  const links = opts.links ? await extractLinks(page, viewport) : [];

  const glyphs = [];
  for (const item of content.items) {
    if (typeof item.str !== 'string' || !item.str.trim()) continue;
    // Map text-space coordinates into viewport space so that y grows downward
    // and page rotation is already applied.
    const m = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const size = Math.hypot(item.transform[2], item.transform[3]) || Math.hypot(m[2], m[3]);
    if (!size) continue;
    const font = fontMeta(page, content, item.fontName, fontCache);
    const x = m[4];
    const y = m[5];
    glyphs.push({
      str: item.str,
      x,
      y,
      width: item.width || size * 0.5 * item.str.length,
      size,
      bold: font.bold,
      italic: font.italic,
      mono: font.mono,
      url: linkAt(links, x + (item.width || 0) / 2, y - size * 0.3),
    });
  }

  return {
    number: pageNumber,
    width: viewport.width,
    height: viewport.height,
    lines: groupLines(glyphs, pageNumber),
  };
}

/**
 * pdf.js exposes the real font (with bold/italic flags) through commonObjs
 * once text content has been parsed; the CSS family in `styles` is the
 * fallback when a font could not be loaded.
 */
function fontMeta(page, content, fontKey, cache) {
  if (cache.has(fontKey)) return cache.get(fontKey);
  let name = '';
  let bold = false;
  let italic = false;
  try {
    if (page.commonObjs.has(fontKey)) {
      const font = page.commonObjs.get(fontKey);
      name = font?.name || '';
      bold = !!font?.bold;
      italic = !!font?.italic;
    }
  } catch {
    /* font not available - fall back to name sniffing below */
  }
  const family = content.styles?.[fontKey]?.fontFamily || '';
  const probe = `${name} ${family}`;
  if (!bold) bold = /bold|black|heavy|semib|demib/i.test(probe);
  if (!italic) italic = /italic|oblique/i.test(probe);
  const mono = /mono|courier|consol|menlo|inconsolata|typewriter/i.test(probe);
  const meta = { name, bold, italic, mono };
  cache.set(fontKey, meta);
  return meta;
}

async function extractLinks(page, viewport) {
  let annotations = [];
  try {
    annotations = await page.getAnnotations({ intent: 'display' });
  } catch {
    return [];
  }
  const links = [];
  for (const a of annotations) {
    if (a.subtype !== 'Link' || !a.url || !a.rect) continue;
    // The rect is in PDF space; map both corners and take the bounding box so
    // that page rotation is handled.
    const [x1, y1] = viewport.convertToViewportPoint(a.rect[0], a.rect[1]);
    const [x2, y2] = viewport.convertToViewportPoint(a.rect[2], a.rect[3]);
    links.push({
      url: a.url,
      left: Math.min(x1, x2),
      right: Math.max(x1, x2),
      top: Math.min(y1, y2),
      bottom: Math.max(y1, y2),
    });
  }
  return links;
}

function linkAt(links, x, y) {
  for (const l of links) {
    if (x >= l.left && x <= l.right && y >= l.top && y <= l.bottom) return l.url;
  }
  return null;
}

/** Cluster glyphs sharing a baseline into lines. */
function groupLines(glyphs, pageNumber) {
  const sorted = glyphs.slice().sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  let current = null;
  for (const g of sorted) {
    // Half an em keeps sub/superscripts on their line without swallowing the
    // next one, whose leading is normally >= 1.1 em.
    const tolerance = Math.max(1.5, g.size * 0.5);
    if (!current || Math.abs(g.y - current.anchorY) > tolerance) {
      current = { anchorY: g.y, glyphs: [] };
      lines.push(current);
    }
    current.glyphs.push(g);
  }
  return lines.map((line) => finalizeLine(line, pageNumber)).filter((line) => line.text !== '');
}

/**
 * Detect a two-column layout and return the lines in reading order.
 *
 * Columns have to be resolved before lines are formed: two columns share
 * baselines, so grouping by y alone welds the left and right column into one
 * line. Bails out unless the evidence is strong, since a wrong split scrambles
 * the page.
 */
function layoutColumns(glyphs, pageWidth, pageNumber) {
  const plain = groupLines(glyphs, pageNumber);
  if (glyphs.length < 12) return plain;

  const gutter = findGutter(glyphs, pageWidth);
  if (!gutter) return plain;

  // A line with a glyph physically inside the gutter runs the full width of
  // the page (a title or a banner). A left/right pair that merely shares a
  // baseline leaves the gutter empty.
  const banner = plain.filter((line) =>
    line.glyphs.some((g) => g.x < gutter.right && g.x + g.width > gutter.left),
  );
  const bannerGlyphs = new Set(banner.flatMap((line) => line.glyphs));

  const left = [];
  const right = [];
  for (const g of glyphs) {
    if (bannerGlyphs.has(g)) continue;
    (g.x + g.width / 2 < gutter.center ? left : right).push(g);
  }
  if (left.length < glyphs.length * 0.2 || right.length < glyphs.length * 0.2) return plain;

  const leftLines = groupLines(left, pageNumber);
  const rightLines = groupLines(right, pageNumber);
  if (!leftLines.length || !rightLines.length) return plain;

  // Banner lines are only safe to hoist when they sit above both columns.
  // Interleaved ones mean the layout is more complex than two columns.
  const columnTop = Math.min(leftLines[0].y, rightLines[0].y);
  if (banner.some((line) => line.y > columnTop)) return plain;

  return [...banner.sort(byReadingOrder), ...leftLines, ...rightLines];
}

/** Find a tall, near-empty vertical band around the middle of the page. */
function findGutter(glyphs, pageWidth) {
  const bins = 150;
  const scale = bins / pageWidth;
  const occupancy = new Array(bins).fill(0);
  for (const g of glyphs) {
    const from = Math.max(0, Math.floor(g.x * scale));
    const to = Math.min(bins - 1, Math.ceil((g.x + g.width) * scale));
    for (let i = from; i <= to; i++) occupancy[i]++;
  }

  const peak = Math.max(...occupancy);
  if (!peak) return null;
  // Tolerate a couple of full-width lines crossing an otherwise clear gutter.
  const quiet = Math.max(1, peak * 0.04);

  let best = null;
  let start = -1;
  for (let i = 0; i <= bins; i++) {
    const isQuiet = i < bins && occupancy[i] < quiet;
    if (isQuiet && start === -1) start = i;
    if (!isQuiet && start !== -1) {
      const width = i - start;
      const center = (start + i) / 2 / bins;
      if (width >= bins * 0.025 && center > 0.35 && center < 0.65 && (!best || width > best.width)) {
        best = { width, left: (start / bins) * pageWidth, right: (i / bins) * pageWidth, center: center * pageWidth };
      }
      start = -1;
    }
  }
  return best;
}

function finalizeLine(line, pageNumber) {
  const glyphs = line.glyphs.sort((a, b) => a.x - b.x);
  const runs = [];
  const cells = [];
  let cursor = null;
  let previous = null;

  for (const g of glyphs) {
    // Some generators paint text twice to fake bold; drop the duplicate.
    if (previous && previous.str === g.str && Math.abs(g.x - previous.x) < previous.size * 0.3) continue;

    let text = g.str;
    let gap = 0;
    if (previous) {
      gap = g.x - (previous.x + previous.width);
      const spaceWidth = Math.max(previous.size, g.size) * SPACE_RATIO;
      if (gap > spaceWidth && !/\s$/.test(text) && runs.length && !/\s$/.test(runs[runs.length - 1].text)) {
        text = ` ${text}`;
      }
    }

    // A gap far wider than a word space reads as a column separator.
    const cellBreak = !previous || gap > Math.max(g.size * 1.3, 7);
    if (cellBreak) cells.push({ x: g.x, text: g.str });
    else cells[cells.length - 1].text += text;

    if (cursor && cursor.bold === g.bold && cursor.italic === g.italic && cursor.mono === g.mono && cursor.url === g.url) {
      cursor.text += text;
    } else {
      cursor = { text, bold: g.bold, italic: g.italic, mono: g.mono, url: g.url };
      runs.push(cursor);
    }
    previous = g;
  }

  const text = runs.map((r) => r.text).join('').replace(/\s+/g, ' ').trim();
  return {
    page: pageNumber,
    glyphs,
    y: line.anchorY,
    x: glyphs.length ? glyphs[0].x : 0,
    right: glyphs.reduce((max, g) => Math.max(max, g.x + g.width), 0),
    size: dominantSize(glyphs),
    bold: glyphs.every((g) => g.bold),
    mono: glyphs.every((g) => g.mono),
    runs,
    cells: cells.map((c) => ({ x: c.x, text: c.text.trim() })).filter((c) => c.text),
    text,
  };
}

/** The size that covers the most characters on a line. */
function dominantSize(glyphs) {
  const weights = new Map();
  for (const g of glyphs) {
    const key = Math.round(g.size * 2) / 2;
    weights.set(key, (weights.get(key) || 0) + g.str.length);
  }
  let best = 0;
  let bestWeight = -1;
  for (const [size, weight] of weights) {
    if (weight > bestWeight) {
      best = size;
      bestWeight = weight;
    }
  }
  return best;
}

const byReadingOrder = (a, b) => a.y - b.y || a.x - b.x;

/* ------------------------------------------------------------------ */
/* Document level metrics                                              */
/* ------------------------------------------------------------------ */

function measureDocument(pages) {
  const sizeWeights = new Map();
  const gaps = [];
  for (const page of pages) {
    for (const line of page.lines) {
      const key = Math.round(line.size * 2) / 2;
      sizeWeights.set(key, (sizeWeights.get(key) || 0) + line.text.length);
    }
    const ordered = page.lines.slice().sort(byReadingOrder);
    for (let i = 1; i < ordered.length; i++) {
      const gap = ordered[i].y - ordered[i - 1].y;
      if (gap > 0.4 * ordered[i].size && gap < 3.5 * ordered[i].size) gaps.push(gap);
    }
  }

  let bodySize = 12;
  let bestWeight = -1;
  for (const [size, weight] of sizeWeights) {
    if (weight > bestWeight) {
      bodySize = size;
      bestWeight = weight;
    }
  }

  // The most common gap is the body leading; anything much larger separates
  // blocks. The mode beats the median here because it ignores the long tail of
  // section spacing.
  const gapCounts = new Map();
  for (const gap of gaps) {
    const key = Math.round(gap);
    gapCounts.set(key, (gapCounts.get(key) || 0) + 1);
  }
  let lineGap = bodySize * 1.2;
  let bestCount = 0;
  for (const [gap, count] of gapCounts) {
    if (count > bestCount) {
      lineGap = gap;
      bestCount = count;
    }
  }
  return { bodySize, lineGap, sizeWeights };
}

/**
 * Remove page headers and footers: text that repeats in the top or bottom
 * margin across pages, plus bare page numbers there.
 */
function stripRunningHeads(pages) {
  if (pages.length < 3) return;
  const seen = new Map();
  for (const page of pages) {
    const marked = new Set();
    for (const line of page.lines) {
      if (!inMargin(line, page)) continue;
      const key = normalizeRunningHead(line.text);
      if (!key || marked.has(key)) continue;
      marked.add(key);
      seen.set(key, (seen.get(key) || 0) + 1);
    }
  }
  const threshold = Math.max(2, Math.ceil(pages.length * 0.5));
  for (const page of pages) {
    page.lines = page.lines.filter((line) => {
      if (!inMargin(line, page)) return true;
      if (PAGE_NUM_RE.test(line.text)) return false;
      return (seen.get(normalizeRunningHead(line.text)) || 0) < threshold;
    });
  }
}

function inMargin(line, page) {
  return line.y < page.height * MARGIN_BAND || line.y > page.height * (1 - MARGIN_BAND);
}

/** Digits vary from page to page, so blank them before comparing. */
function normalizeRunningHead(text) {
  return text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
}

/* ------------------------------------------------------------------ */
/* Structure inference                                                 */
/* ------------------------------------------------------------------ */

function assignHeadings(flow, metrics) {
  const counts = new Map();
  for (const line of flow) {
    const key = Math.round(line.size * 2) / 2;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const headingSizes = [...counts.keys()]
    .filter((size) => size >= metrics.bodySize * 1.1)
    .sort((a, b) => b - a)
    .slice(0, 6);
  const levelBySize = new Map(headingSizes.map((size, i) => [size, i + 1]));
  const boldLevel = Math.min(6, headingSizes.length + 1);

  flow.forEach((line, i) => {
    if (line.table) return;
    const key = Math.round(line.size * 2) / 2;
    if (levelBySize.has(key) && line.text.length <= 200) {
      line.heading = levelBySize.get(key);
      return;
    }
    // A short, fully bold line followed by normal text is a heading even when
    // it is set at body size.
    if (!line.bold || line.text.length > 90 || SENTENCE_END_RE.test(line.text)) return;
    if (line.cells.length > 1) return;
    if (BULLET_RE.test(line.text) || ORDERED_RE.test(line.text)) return;
    const next = flow[i + 1];
    if (next && !next.bold && next.page === line.page) line.heading = boldLevel;
  });
}

/**
 * Mark consecutive multi-cell lines that share column positions as table rows.
 */
function markTables(flow, metrics) {
  let i = 0;
  let groupId = 0;
  while (i < flow.length) {
    if (flow[i].cells.length < 2 || flow[i].heading) {
      i++;
      continue;
    }
    let j = i;
    while (
      j + 1 < flow.length &&
      flow[j + 1].cells.length >= 2 &&
      !flow[j + 1].heading &&
      flow[j + 1].page === flow[j].page &&
      flow[j + 1].gapBefore !== null &&
      flow[j + 1].gapBefore < metrics.lineGap * 2.2
    ) {
      j++;
    }
    const rows = flow.slice(i, j + 1);
    if (rows.length >= 2) {
      const columns = clusterColumns(rows, metrics.bodySize);
      // Every row must fit the same column grid, otherwise this is prose that
      // merely happens to have wide word spacing.
      if (columns.length >= 2 && rows.every((r) => r.cells.length >= 2 && r.cells.length <= columns.length)) {
        const id = ++groupId;
        for (const row of rows) {
          row.table = id;
          row.columns = columns;
        }
      }
    }
    i = j + 1;
  }
}

function clusterColumns(rows, bodySize) {
  const xs = rows.flatMap((r) => r.cells.map((c) => c.x)).sort((a, b) => a - b);
  const tolerance = Math.max(bodySize, 8);
  const columns = [];
  for (const x of xs) {
    const last = columns[columns.length - 1];
    if (last && x - last.x <= tolerance) {
      last.x = (last.x * last.n + x) / (last.n + 1);
      last.n++;
    } else {
      columns.push({ x, n: 1 });
    }
  }
  // Columns supported by a single row are noise.
  return columns.filter((c) => c.n >= Math.max(2, rows.length * 0.5)).map((c) => c.x);
}

/** Turn the flat line flow into a list of block-level nodes. */
function buildNodes(flow, metrics, opts) {
  const nodes = [];
  const paragraphGap = metrics.lineGap * 1.45;
  let current = null;

  const close = () => {
    current = null;
  };

  for (const line of flow) {
    if (line.table) {
      if (current?.type === 'table' && current.id === line.table) current.rows.push(line);
      else {
        close();
        current = { type: 'table', id: line.table, columns: line.columns, rows: [line] };
        nodes.push(current);
      }
      continue;
    }

    if (line.heading) {
      close();
      nodes.push({ type: 'heading', level: line.heading, line });
      continue;
    }

    if (line.mono) {
      if (current?.type === 'code' && line.gapBefore !== null && line.gapBefore < paragraphGap) {
        current.lines.push(line);
      } else {
        close();
        current = { type: 'code', lines: [line] };
        nodes.push(current);
      }
      continue;
    }

    const marker = opts.lists ? matchMarker(line) : null;
    if (marker) {
      const item = { marker: marker.kind, number: marker.number, x: line.x, lines: [marker.line] };
      const sameKind = current?.type === 'list' && current.items[current.items.length - 1].marker === marker.kind;
      if (sameKind && line.gapBefore !== null && line.gapBefore < paragraphGap * 1.6) {
        current.items.push(item);
      } else {
        close();
        current = { type: 'list', items: [item] };
        nodes.push(current);
      }
      continue;
    }

    // Wrapped continuation of the current list item: indented past the marker.
    if (current?.type === 'list' && line.gapBefore !== null && line.gapBefore < paragraphGap) {
      const lastItem = current.items[current.items.length - 1];
      if (line.x > lastItem.x + metrics.bodySize * 0.4) {
        lastItem.lines.push(line);
        continue;
      }
    }

    if (current?.type === 'paragraph') {
      const first = current.lines[0];
      const continues =
        line.gapBefore !== null
          ? line.gapBefore < paragraphGap && line.x < first.x + metrics.bodySize * 1.2
          : // Across a page or column break, only join a sentence left hanging.
            !SENTENCE_END_RE.test(current.lines[current.lines.length - 1].text) && /^[a-z(]/.test(line.text);
      if (continues) {
        current.lines.push(line);
        continue;
      }
    }

    close();
    current = { type: 'paragraph', lines: [line] };
    nodes.push(current);
  }

  if (opts.pageBreaks) return insertPageBreaks(nodes);
  return nodes;
}

function insertPageBreaks(nodes) {
  const out = [];
  let page = null;
  for (const node of nodes) {
    const nodePage = firstLine(node)?.page;
    if (page !== null && nodePage !== page) out.push({ type: 'pagebreak', page: nodePage });
    page = nodePage;
    out.push(node);
  }
  return out;
}

function firstLine(node) {
  if (node.type === 'heading') return node.line;
  if (node.type === 'table') return node.rows[0];
  if (node.type === 'list') return node.items[0].lines[0];
  return node.lines?.[0];
}

/**
 * Match a list marker against the raw run text, so that the marker can be cut
 * from the styled runs and not just from the plain text.
 */
function matchMarker(line) {
  const raw = line.runs.map((r) => r.text).join('');
  const bullet = BULLET_RE.exec(raw);
  if (bullet) return { kind: 'bullet', line: withoutPrefix(line, bullet[0].length) };
  const ordered = ORDERED_RE.exec(raw);
  if (ordered) return { kind: 'ordered', number: Number(ordered[1]), line: withoutPrefix(line, ordered[0].length) };
  return null;
}

function withoutPrefix(line, length) {
  const runs = [];
  let remaining = length;
  for (const run of line.runs) {
    if (remaining <= 0) runs.push(run);
    else if (run.text.length <= remaining) remaining -= run.text.length;
    else {
      runs.push({ ...run, text: run.text.slice(remaining) });
      remaining = 0;
    }
  }
  return { ...line, runs, text: runs.map((r) => r.text).join('').replace(/\s+/g, ' ').trim() };
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function renderNode(node, opts) {
  switch (node.type) {
    case 'pagebreak':
      return `<!-- page ${node.page} -->`;
    case 'heading': {
      const text = renderRuns(node.line.runs, { ...opts, emphasis: false }).trim();
      return text ? `${'#'.repeat(node.level)} ${text}` : '';
    }
    case 'code': {
      const base = Math.min(...node.lines.map((l) => l.x));
      const body = node.lines
        .map((l) => ' '.repeat(Math.max(0, Math.round((l.x - base) / Math.max(l.size * 0.55, 1)))) + l.text)
        .join('\n');
      return `\`\`\`\n${body}\n\`\`\``;
    }
    case 'list': {
      const levels = [...new Set(node.items.map((i) => Math.round(i.x)))].sort((a, b) => a - b);
      return node.items
        .map((item, i) => {
          const depth = Math.min(3, levels.indexOf(Math.round(item.x)));
          const marker = item.marker === 'ordered' ? `${item.number ?? i + 1}.` : '-';
          const text = joinLines(item.lines, opts);
          return `${'  '.repeat(depth)}${marker} ${text}`;
        })
        .join('\n');
    }
    case 'table':
      return renderTable(node, opts);
    default: {
      const text = joinLines(node.lines, opts);
      return text ? escapeBlockStart(text) : '';
    }
  }
}

function renderTable(node, opts) {
  const width = node.columns.length;
  const grid = node.rows.map((row) => {
    const cells = new Array(width).fill('');
    for (const cell of row.cells) {
      let index = 0;
      let bestDistance = Infinity;
      node.columns.forEach((cx, i) => {
        const distance = Math.abs(cx - cell.x);
        if (distance < bestDistance) {
          bestDistance = distance;
          index = i;
        }
      });
      cells[index] = cells[index] ? `${cells[index]} ${cell.text}` : cell.text;
    }
    return cells.map((c) => escapeInline(c, opts).replace(/\|/g, '\\|'));
  });

  const [header, ...body] = grid;
  const lines = [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`];
  for (const row of body) lines.push(`| ${row.join(' | ')} |`);
  return lines.join('\n');
}

/** Join the lines of a paragraph, undoing PDF line wrapping. */
function joinLines(lines, opts) {
  let out = '';
  for (const line of lines) {
    const piece = renderRuns(line.runs, opts);
    if (!out) {
      out = piece;
      continue;
    }
    // "environ-\nment" is one word; "well-\nknown" keeps its hyphen.
    if (opts.dehyphenate && /[a-zÀ-ɏ]-$/.test(out) && /^[a-zÀ-ɏ]/.test(piece.trimStart())) {
      out = out.replace(/-$/, '') + piece.trimStart();
    } else {
      out = `${out.replace(/\s+$/, '')} ${piece.trimStart()}`;
    }
  }
  return out.trim();
}

function renderRuns(runs, opts) {
  let out = '';
  for (const run of runs) {
    const raw = run.text;
    if (!raw) continue;
    const leading = raw.match(/^\s*/)[0];
    const trailing = raw.length > leading.length ? raw.match(/\s*$/)[0] : '';
    const core = raw.slice(leading.length, raw.length - trailing.length);
    if (!core) {
      out += raw;
      continue;
    }

    let piece;
    if (opts.emphasis && run.mono) {
      // Inline code is verbatim; pick a fence longer than any run of backticks.
      const ticks = '`'.repeat(longestBacktickRun(core) + 1);
      piece = `${ticks}${core}${ticks}`;
    } else {
      piece = escapeInline(core, opts);
      if (opts.emphasis) {
        if (run.bold) piece = `**${piece}**`;
        if (run.italic) piece = `*${piece}*`;
      }
    }
    if (opts.links && run.url) piece = `[${piece}](${encodeURI(run.url).replace(/[()]/g, (c) => (c === '(' ? '%28' : '%29'))})`;
    out += leading + piece + trailing;
  }
  return out;
}

function longestBacktickRun(text) {
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  return longest;
}

function escapeInline(text, opts) {
  if (opts.escape === false) return text;
  return text
    .replace(/([\\`*[\]<>])/g, '\\$1')
    // Underscores only start emphasis at a word boundary, so leave the ones
    // inside identifiers like snake_case alone.
    .replace(/(^|\W)_|_(?=\W|$)/g, (m) => m.replace('_', '\\_'));
}

/**
 * Stop a paragraph's first characters from being read as block syntax. Only
 * punctuation can carry a backslash escape, so an ordered-list lookalike is
 * defused on its delimiter rather than on its digits.
 */
function escapeBlockStart(text) {
  return text
    .replace(/^(\s*)(\d{1,9})([.)][ \t])/, (m, space, digits, delimiter) => `${space}${digits}\\${delimiter}`)
    .replace(/^(\s*)(#{1,6}[ \t]|[>|]|=+[ \t]*$)/, (m, space, token) => `${space}\\${token}`);
}

function tidy(markdown) {
  return `${markdown
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()}\n`;
}

async function buildFrontMatter(doc) {
  let info = {};
  try {
    ({ info } = await doc.getMetadata());
  } catch {
    return '';
  }
  const fields = [
    ['title', info?.Title],
    ['author', info?.Author],
    ['subject', info?.Subject],
    ['keywords', info?.Keywords],
  ].filter(([, value]) => typeof value === 'string' && value.trim());
  if (!fields.length) return '';
  const yaml = fields.map(([key, value]) => `${key}: ${JSON.stringify(value.trim())}`).join('\n');
  return `---\n${yaml}\n---`;
}
