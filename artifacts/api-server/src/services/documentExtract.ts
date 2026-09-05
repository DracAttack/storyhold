import { unzipSync, strFromU8 } from "fflate";

// --- Document (PDF / DOCX / PPTX / …) text extraction --------------------
// Pulls plain text out of binary primary-source documents so the Source Vault
// can ingest them the same way it ingests HTML articles. Extraction backends are
// lightweight, pure-JS, and loaded lazily (dynamic import) so a heavy/broken
// parser can never destabilize server boot — and none of them pull native
// binaries (a deliberate choice over a Java Tika sidecar). Logger-free so the
// pure detector stays unit-testable in isolation.

/** Document container formats we can extract text from. */
export type DocumentType =
  | "pdf"
  | "docx"
  | "pptx"
  | "xlsx"
  | "odt"
  | "odp"
  | "ods"
  | "epub"
  | "md"
  | "txt";

/** Thrown when a document is a known type but its bytes could not be parsed. */
export class DocumentExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentExtractionError";
  }
}

/** Result of extracting text from a document. */
export interface DocumentExtraction {
  text: string;
  title: string | null;
  extractionMethod: string;
  pageCount: number | null;
  /** Page text in source order when the extractor exposes real page boundaries. */
  pages?: string[];
  /** Non-destructive extraction-health report for storage and review UI. */
  diagnostics?: DocumentExtractionDiagnostics;
}

export type DocumentExtractionSeverity = "ok" | "warning" | "critical";

export interface DocumentExtractionMetrics {
  characterCount: number;
  nonWhitespaceCharacterCount: number;
  wordCount: number;
  lineCount: number;
  pageCount: number | null;
  extractedPageCount: number | null;
  emptyPageCount: number;
  sparsePageCount: number;
  replacementCharacterCount: number;
  controlCharacterCount: number;
  giantLineCount: number;
  maximumLineLength: number;
  repeatedHeaderFooterPageCount: number;
}

export interface DocumentExtractionDiagnostics {
  severity: DocumentExtractionSeverity;
  messages: string[];
  metrics: DocumentExtractionMetrics;
}

function severityAtLeast(
  current: DocumentExtractionSeverity,
  next: DocumentExtractionSeverity,
): DocumentExtractionSeverity {
  const rank: Record<DocumentExtractionSeverity, number> = {
    ok: 0,
    warning: 1,
    critical: 2,
  };
  return rank[next] > rank[current] ? next : current;
}

function normalizedBoundaryLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim().toLocaleLowerCase();
}

/** Pure, deterministic assessment. It reports problems but never rejects text. */
export function assessDocumentExtractionQuality(params: {
  text: string;
  pages?: readonly string[] | null;
  pageCount?: number | null;
}): DocumentExtractionDiagnostics {
  const text = params.text ?? "";
  const explicitPages = params.pages ? [...params.pages] : null;
  const derivedPages = explicitPages ?? (text.includes("\f") ? text.split(/\f/gu) : null);
  const reportedPageCount = params.pageCount ?? null;
  const nonWhitespaceCharacterCount = (text.match(/\S/gu) ?? []).length;
  const wordCount = (text.match(/[\p{L}\p{N}]+(?:['\u2019-][\p{L}\p{N}]+)*/gu) ?? []).length;
  const replacementCharacterCount = (text.match(/\uFFFD/gu) ?? []).length;
  const controlCharacterCount = (
    text.match(/[\u0000-\u0008\u000B\u000E-\u001F\u007F-\u009F]/gu) ?? []
  ).length;
  const lines = text
    .replace(/\f/gu, "\n")
    .split(/\r?\n/gu);
  const lineLengths = lines.map((line) => line.length);
  const maximumLineLength = Math.max(0, ...lineLengths);
  const giantLineCount = lineLengths.filter((length) => length >= 2_000).length;
  const pages = derivedPages ?? [];
  const pageNonWhitespace = pages.map((page) => (page.match(/\S/gu) ?? []).length);
  const emptyPageCount = pageNonWhitespace.filter((count) => count === 0).length;
  const sparsePageCount = pageNonWhitespace.filter((count) => count > 0 && count < 80).length;

  const repeatedPageIndexes = new Set<number>();
  if (pages.length >= 3) {
    const positions: Array<{ index: number; position: "header" | "footer"; text: string }> = [];
    pages.forEach((page, index) => {
      const pageLines = page
        .split(/\r?\n/gu)
        .map(normalizedBoundaryLine)
        .filter(Boolean);
      const header = pageLines[0] ?? "";
      const footer = pageLines.at(-1) ?? "";
      if (header.length >= 3 && header.length <= 160) positions.push({ index, position: "header", text: header });
      if (footer.length >= 3 && footer.length <= 160) positions.push({ index, position: "footer", text: footer });
    });
    const counts = new Map<string, number>();
    for (const entry of positions) {
      const key = `${entry.position}\u0000${entry.text}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const threshold = Math.max(3, Math.ceil(pages.length * 0.5));
    for (const entry of positions) {
      if ((counts.get(`${entry.position}\u0000${entry.text}`) ?? 0) >= threshold) {
        repeatedPageIndexes.add(entry.index);
      }
    }
  }

  let severity: DocumentExtractionSeverity = "ok";
  const messages: string[] = [];
  const report = (next: DocumentExtractionSeverity, message: string) => {
    severity = severityAtLeast(severity, next);
    messages.push(message);
  };

  if (nonWhitespaceCharacterCount === 0) {
    report(
      "critical",
      "No extractable text was found; this may be an image-only or scanned document that needs OCR.",
    );
  }
  if (replacementCharacterCount > 0) {
    const replacementRatio = replacementCharacterCount / Math.max(1, nonWhitespaceCharacterCount);
    report(
      replacementCharacterCount >= 10 || replacementRatio >= 0.01 ? "critical" : "warning",
      `The extracted text contains ${replacementCharacterCount} Unicode replacement ${replacementCharacterCount === 1 ? "character" : "characters"}, suggesting damaged or incorrectly decoded text.`,
    );
  }
  if (controlCharacterCount > 0) {
    const controlRatio = controlCharacterCount / Math.max(1, text.length);
    report(
      controlCharacterCount >= 10 || controlRatio >= 0.01 ? "critical" : "warning",
      `The extracted text contains ${controlCharacterCount} unexpected control ${controlCharacterCount === 1 ? "character" : "characters"}.`,
    );
  }
  if (reportedPageCount != null && explicitPages && reportedPageCount !== explicitPages.length) {
    report(
      "warning",
      `The parser reported ${reportedPageCount} pages but returned boundaries for ${explicitPages.length}.`,
    );
  }
  if (pages.length >= 3) {
    const suspiciousSparseCount = sparsePageCount + emptyPageCount;
    if (suspiciousSparseCount >= Math.max(2, Math.ceil(pages.length * 0.25))) {
      report(
        suspiciousSparseCount > pages.length / 2 ? "critical" : "warning",
        `${suspiciousSparseCount} of ${pages.length} extracted pages contain implausibly little selectable text.`,
      );
    }
  }
  if (
    giantLineCount > 0 ||
    (nonWhitespaceCharacterCount >= 5_000 && lines.filter((line) => line.trim()).length <= 2)
  ) {
    report(
      maximumLineLength >= 10_000 ? "critical" : "warning",
      `The extraction contains ${giantLineCount} giant ${giantLineCount === 1 ? "line" : "lines"} (maximum ${maximumLineLength.toLocaleString()} characters), suggesting collapsed paragraph or page structure.`,
    );
  }
  if (repeatedPageIndexes.size > 0) {
    report(
      "warning",
      `Repeated header or footer text appears on ${repeatedPageIndexes.size} pages and should be excluded from narrative analysis when possible.`,
    );
  }

  return {
    severity,
    messages,
    metrics: {
      characterCount: text.length,
      nonWhitespaceCharacterCount,
      wordCount,
      lineCount: lines.length,
      pageCount: reportedPageCount ?? (derivedPages ? derivedPages.length : null),
      extractedPageCount: derivedPages ? derivedPages.length : null,
      emptyPageCount,
      sparsePageCount,
      replacementCharacterCount,
      controlCharacterCount,
      giantLineCount,
      maximumLineLength,
      repeatedHeaderFooterPageCount: repeatedPageIndexes.size,
    },
  };
}

function withDiagnostics(
  extraction: Omit<DocumentExtraction, "diagnostics">,
): DocumentExtraction {
  return {
    ...extraction,
    diagnostics: assessDocumentExtractionQuality({
      text: extraction.text,
      pages: extraction.pages,
      pageCount: extraction.pageCount,
    }),
  };
}

// content-type → type (checked first; most authoritative when the server sets it)
const CONTENT_TYPE_MAP: Array<[RegExp, DocumentType]> = [
  [/application\/pdf/i, "pdf"],
  [/officedocument\.wordprocessingml\.document/i, "docx"],
  [/officedocument\.presentationml\.presentation/i, "pptx"],
  [/officedocument\.spreadsheetml\.sheet/i, "xlsx"],
  [/opendocument\.text/i, "odt"],
  [/opendocument\.presentation/i, "odp"],
  [/opendocument\.spreadsheet/i, "ods"],
  [/application\/epub\+zip/i, "epub"],
  [/^text\/(?:markdown|x-markdown)/i, "md"],
  [/^text\/plain/i, "txt"],
];

// file extension → type (fallback when content-type is generic, e.g. uploads)
const EXTENSION_MAP: Record<string, DocumentType> = {
  pdf: "pdf",
  docx: "docx",
  pptx: "pptx",
  xlsx: "xlsx",
  odt: "odt",
  odp: "odp",
  ods: "ods",
  epub: "epub",
  md: "md",
  markdown: "md",
  txt: "txt",
  text: "txt",
};

function extensionOf(urlOrName: string): string | null {
  // Strip query/hash, take the last path segment's extension.
  const clean = urlOrName.split(/[?#]/)[0] ?? urlOrName;
  const seg = clean.split(/[/\\]/).pop() ?? clean;
  const dot = seg.lastIndexOf(".");
  if (dot < 0 || dot === seg.length - 1) return null;
  return seg.slice(dot + 1).toLowerCase();
}

/**
 * Decide whether some bytes are a document we can extract (and which format), or
 * null when they should be treated as HTML/plain text (the caller's default
 * path). Priority: content-type → file extension → magic bytes. ZIP-container
 * formats (docx/pptx/…) share the `PK` magic and are indistinguishable by magic
 * alone, so those rely on content-type or extension; only PDF is magic-sniffable.
 * Pure — no I/O.
 */
export function detectDocumentType(params: {
  contentType?: string | null;
  url?: string | null;
  bytes?: Uint8Array | null;
}): DocumentType | null {
  const ct = params.contentType ?? "";
  for (const [re, type] of CONTENT_TYPE_MAP) {
    if (re.test(ct)) return type;
  }

  const ext = params.url ? extensionOf(params.url) : null;
  if (ext && EXTENSION_MAP[ext]) return EXTENSION_MAP[ext];

  // Magic bytes: only PDF is unambiguous ("%PDF"). ZIP (PK\x03\x04) could be any
  // OOXML/ODF doc OR an unrelated archive, so we don't guess a specific type.
  const b = params.bytes;
  if (
    b &&
    b.length >= 4 &&
    b[0] === 0x25 &&
    b[1] === 0x50 &&
    b[2] === 0x44 &&
    b[3] === 0x46
  ) {
    return "pdf";
  }

  return null;
}

/** Decode the small set of XML entities that appear in OOXML/ODF text nodes. */
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) =>
      String.fromCodePoint(parseInt(h, 16)),
    )
    .replace(/&amp;/g, "&"); // last, so a literal &amp; is not double-decoded
}

/**
 * Extract text from a single PPTX slide XML. Concatenates the runs (`<a:t>`)
 * within each paragraph and inserts a newline at every paragraph end (`</a:p>`)
 * and explicit break (`<a:br/>`) so paragraph structure survives.
 */
function pptxSlideText(xml: string): string {
  const withBreaks = xml.replace(/<a:br\s*\/>/g, "</a:p>");
  const re = /<a:t>([\s\S]*?)<\/a:t>|<\/a:p>/g;
  let out = "";
  for (const m of withBreaks.matchAll(re)) {
    if (m[1] !== undefined) out += decodeEntities(m[1]);
    else out += "\n";
  }
  return out;
}

/** Extract text from an ODF (odt/odp/ods) content.xml body. */
function odfText(xml: string): string {
  const bodyMatch = xml.match(/<office:body[\s\S]*?<\/office:body>/);
  const body = bodyMatch ? bodyMatch[0] : xml;
  const withBreaks = body
    .replace(/<text:(?:p|h)\b[^>]*>/g, "\n")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(withBreaks);
}

/** Extract shared-string text from an XLSX workbook. */
function xlsxText(entries: Record<string, Uint8Array>): string {
  const ss = entries["xl/sharedStrings.xml"];
  if (!ss) return "";
  const xml = strFromU8(ss);
  const parts: string[] = [];
  for (const m of xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) {
    parts.push(decodeEntities(m[1] ?? ""));
  }
  return parts.join("\n");
}

function zipPath(base: string, relative: string): string {
  const parts = `${base}/${relative}`.split("/");
  const clean: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") clean.pop();
    else clean.push(part);
  }
  return clean.join("/");
}

function xmlAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)) {
    attributes[match[1] ?? ""] = decodeEntities(match[2] ?? "");
  }
  return attributes;
}

function htmlText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, "")
      .replace(/<style\b[\s\S]*?<\/style>/gi, "")
      .replace(
        /<(?:br|\/p|\/div|\/li|\/h[1-6]|\/section|\/article)\s*\/?>/gi,
        "\n",
      )
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s+/g, "\n")
      .replace(/\n{3,}/g, "\n\n"),
  ).trim();
}

function epubText(entries: Record<string, Uint8Array>): {
  text: string;
  title: string | null;
  chapterCount: number;
} {
  const container = entries["META-INF/container.xml"];
  if (!container) throw new Error("EPUB container.xml missing");
  const containerXml = strFromU8(container);
  const rootTag = containerXml.match(/<rootfile\b[^>]*>/i)?.[0];
  const opfPath = rootTag ? xmlAttributes(rootTag)["full-path"] : null;
  if (!opfPath || !entries[opfPath])
    throw new Error("EPUB package document missing");

  const opf = strFromU8(entries[opfPath]!);
  const opfDir = opfPath.includes("/")
    ? opfPath.slice(0, opfPath.lastIndexOf("/"))
    : "";
  const titleMatch = opf.match(/<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/i);
  const title = titleMatch?.[1]
    ? decodeEntities(titleMatch[1].replace(/<[^>]+>/g, "")).trim()
    : null;

  const manifest = new Map<string, string>();
  for (const match of opf.matchAll(/<item\b[^>]*>/gi)) {
    const attrs = xmlAttributes(match[0]);
    if (!attrs.id || !attrs.href) continue;
    const mediaType = attrs["media-type"] ?? "";
    if (!/xhtml|html/i.test(mediaType)) continue;
    manifest.set(
      attrs.id,
      zipPath(
        opfDir,
        decodeURIComponent(attrs.href.split("#")[0] ?? attrs.href),
      ),
    );
  }

  const chapterPaths: string[] = [];
  for (const match of opf.matchAll(/<itemref\b[^>]*>/gi)) {
    const idref = xmlAttributes(match[0]).idref;
    const chapterPath = idref ? manifest.get(idref) : null;
    if (chapterPath && entries[chapterPath]) chapterPaths.push(chapterPath);
  }
  if (chapterPaths.length === 0) {
    chapterPaths.push(
      ...Object.keys(entries)
        .filter((name) => /\.(?:xhtml|html|htm)$/i.test(name))
        .sort(),
    );
  }

  const chapters = chapterPaths
    .map((name) => htmlText(strFromU8(entries[name]!)))
    .filter((chapter) => chapter.length > 0);
  return {
    text: chapters.join("\n\n"),
    title: title || null,
    chapterCount: chapters.length,
  };
}

/**
 * Extract plain text from a document's bytes, routed by format. Heavy parsers
 * (pdfjs via unpdf, mammoth) are dynamically imported so they load only when a
 * matching document actually arrives. Throws DocumentExtractionError when the
 * bytes are a known type but cannot be parsed (corrupt / password-protected);
 * an empty text result (e.g. a scanned image-only PDF) is returned, not thrown —
 * the caller's quality gate flags it as low-quality rather than silently storing.
 */
export async function extractDocumentText(
  bytes: Uint8Array,
  type: DocumentType,
): Promise<DocumentExtraction> {
  try {
    switch (type) {
      case "txt":
      case "md": {
        // Plain UTF-8 text — no parser needed, just decode the bytes.
        return withDiagnostics({
          text: strFromU8(bytes),
          title: null,
          extractionMethod: "utf8",
          pageCount: null,
        });
      }
      case "pdf": {
        const { getDocumentProxy, extractText, getMeta } =
          await import("unpdf");
        const pdf = await getDocumentProxy(new Uint8Array(bytes));
        const { totalPages, text } = await extractText(pdf, {
          mergePages: false,
        });
        const pages = text.map((page) => page.replace(/\r\n?/gu, "\n"));
        // Form feed is the standard plain-text page delimiter. The page array
        // also preserves empty pages and boundaries without caller heuristics.
        const fullText = pages.join("\n\n\f\n\n");
        // Title: prefer the PDF's embedded metadata Title; fall back to a
        // first-line heuristic over the extracted text (journal PDFs usually
        // open with the paper title). Callers still run the result through
        // their own junk-title guards.
        let title: string | null = null;
        try {
          const meta = await getMeta(pdf);
          const raw = (meta?.info as Record<string, unknown> | undefined)
            ?.Title;
          if (typeof raw === "string" && raw.trim().length >= 8)
            title = raw.trim();
        } catch {
          // Metadata parsing is best-effort; the text heuristic below still runs.
        }
        if (!title) {
          const firstLines = fullText
            .split(/\n+/)
            .map((l) => l.replace(/\s+/g, " ").trim())
            .filter((l) => l.length > 0)
            .slice(0, 8);
          // A plausible title line: substantive length, mostly letters, not a
          // journal header (volume/issue/DOI/date lines) or an all-caps banner.
          const candidate = firstLines.find(
            (l) =>
              l.length >= 20 &&
              l.length <= 220 &&
              /[a-z]/.test(l) &&
              !/\b(vol\.?|volume|issue|no\.|doi|issn|https?:|copyright|©|received|accepted|published)\b/i.test(
                l,
              ),
          );
          if (candidate) title = candidate;
        }
        return withDiagnostics({
          text: fullText,
          title,
          extractionMethod: "unpdf",
          pageCount: totalPages ?? null,
          pages,
        });
      }
      case "docx": {
        const mod = (await import("mammoth")) as {
          extractRawText?: (o: {
            buffer: Buffer;
          }) => Promise<{ value: string }>;
          default?: {
            extractRawText: (o: {
              buffer: Buffer;
            }) => Promise<{ value: string }>;
          };
        };
        const extractRawText =
          mod.extractRawText ?? mod.default?.extractRawText;
        if (!extractRawText)
          throw new Error("mammoth.extractRawText unavailable");
        const { value } = await extractRawText({ buffer: Buffer.from(bytes) });
        return withDiagnostics({
          text: value,
          title: null,
          extractionMethod: "mammoth",
          pageCount: null,
        });
      }
      case "pptx": {
        const entries = unzipSync(bytes);
        const slideNames = Object.keys(entries)
          .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
          .sort((a, b) => {
            const na = Number(a.match(/slide(\d+)\.xml$/)?.[1] ?? 0);
            const nb = Number(b.match(/slide(\d+)\.xml$/)?.[1] ?? 0);
            return na - nb;
          });
        const slides = slideNames.map((n) =>
          pptxSlideText(strFromU8(entries[n]!)).trim(),
        );
        return withDiagnostics({
          text: slides.filter((s) => s.length > 0).join("\n\n"),
          title: null,
          extractionMethod: "pptx-xml",
          pageCount: slideNames.length,
          pages: slides,
        });
      }
      case "xlsx": {
        const entries = unzipSync(bytes);
        return withDiagnostics({
          text: xlsxText(entries),
          title: null,
          extractionMethod: "xlsx-xml",
          pageCount: null,
        });
      }
      case "odt":
      case "odp":
      case "ods": {
        const entries = unzipSync(bytes);
        const content = entries["content.xml"];
        if (!content) throw new Error("ODF content.xml missing");
        return withDiagnostics({
          text: odfText(strFromU8(content)),
          title: null,
          extractionMethod: "odf-xml",
          pageCount: null,
        });
      }
      case "epub": {
        const entries = unzipSync(bytes);
        const extracted = epubText(entries);
        return withDiagnostics({
          text: extracted.text,
          title: extracted.title,
          extractionMethod: "epub-spine",
          pageCount: extracted.chapterCount,
        });
      }
    }
  } catch (err) {
    throw new DocumentExtractionError(
      `Failed to extract ${type}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
