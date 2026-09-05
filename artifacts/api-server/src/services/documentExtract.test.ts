import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assessDocumentExtractionQuality,
  detectDocumentType,
  extractDocumentText,
  type DocumentType,
} from "./documentExtract";

test("content-type wins for OOXML/PDF documents", () => {
  assert.equal(detectDocumentType({ contentType: "application/pdf" }), "pdf");
  assert.equal(
    detectDocumentType({
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }),
    "docx",
  );
  assert.equal(
    detectDocumentType({
      contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    }),
    "pptx",
  );
  assert.equal(
    detectDocumentType({
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
    "xlsx",
  );
  assert.equal(
    detectDocumentType({ contentType: "application/vnd.oasis.opendocument.text" }),
    "odt",
  );
});

test("file extension is used when content-type is generic", () => {
  assert.equal(
    detectDocumentType({ contentType: "application/octet-stream", url: "https://x.com/report.docx" }),
    "docx",
  );
  assert.equal(detectDocumentType({ url: "upload://abc/deck.pptx" }), "pptx");
  assert.equal(detectDocumentType({ url: "https://x.com/data.xlsx?dl=1" }), "xlsx");
  assert.equal(detectDocumentType({ url: "file.odp" }), "odp");
});

test("PDF magic bytes are sniffable when nothing else identifies it", () => {
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]); // %PDF-1
  assert.equal(detectDocumentType({ bytes: pdf }), "pdf");
});

test("ZIP magic alone is ambiguous → not a document", () => {
  const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04]); // PK\x03\x04
  assert.equal(detectDocumentType({ bytes: zip }), null);
});

test("html/plain content resolves to null (caller's HTML path)", () => {
  assert.equal(detectDocumentType({ contentType: "text/html", url: "https://x.com/article" }), null);
  assert.equal(detectDocumentType({}), null);
  assert.equal(detectDocumentType({ url: "https://x.com/no-extension" }), null);
});

test("content-type takes priority over a conflicting extension", () => {
  assert.equal(
    detectDocumentType({ contentType: "application/pdf", url: "https://x.com/thing.docx" }),
    "pdf",
  );
});

// --- extraction round-trips over committed per-format fixtures -------------
// Guards against a silent break in the dynamically-imported parsers (unpdf,
// mammoth, fflate) — a dep bump or bundler-externals change could break real
// extraction while detectDocumentType() still passes. Each fixture holds known
// text; we assert it is recovered. Fixtures are committed under
// src/services/__fixtures__/documents (see that dir for how each is built).

function fixturesDir(): string {
  // The test runs both from source (cwd = artifact dir) and from the esbuild
  // bundle under dist-test/, so probe a few anchors and use whichever exists.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(process.cwd(), "src/services/__fixtures__/documents"),
    path.resolve(here, "__fixtures__/documents"),
    path.resolve(here, "../src/services/__fixtures__/documents"),
    path.resolve(here, "../../src/services/__fixtures__/documents"),
  ];
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error(`fixtures dir not found; tried:\n${candidates.join("\n")}`);
  return found;
}

function readFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(path.join(fixturesDir(), name)));
}

function simpleTextPdf(pageTexts: string[]): Uint8Array {
  const fontId = 3 + pageTexts.length * 2;
  const objects = new Map<number, string>();
  objects.set(1, "<< /Type /Catalog /Pages 2 0 R >>");
  objects.set(
    2,
    `<< /Type /Pages /Kids [${pageTexts.map((_, index) => `${3 + index * 2} 0 R`).join(" ")}] /Count ${pageTexts.length} >>`,
  );
  pageTexts.forEach((pageText, index) => {
    const pageId = 3 + index * 2;
    const contentId = pageId + 1;
    const escaped = pageText.replace(/\\/gu, "\\\\").replace(/\(/gu, "\\(").replace(/\)/gu, "\\)");
    const stream = `BT /F1 18 Tf 72 700 Td (${escaped}) Tj ET`;
    objects.set(
      pageId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`,
    );
    objects.set(contentId, `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  });
  objects.set(fontId, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (let id = 1; id <= fontId; id += 1) {
    offsets[id] = Buffer.byteLength(pdf);
    pdf += `${id} 0 obj\n${objects.get(id)}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${fontId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= fontId; id += 1) {
    pdf += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${fontId + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf, "ascii"));
}

const EXTRACTION_CASES: Array<{ file: string; type: DocumentType; expect: string }> = [
  { file: "sample.txt", type: "txt", expect: "Hello Txt Fixture" },
  { file: "sample.pdf", type: "pdf", expect: "Hello Pdf Fixture" },
  { file: "sample.docx", type: "docx", expect: "Hello Docx Fixture" },
  { file: "sample.pptx", type: "pptx", expect: "Hello Pptx Fixture" },
  { file: "sample.xlsx", type: "xlsx", expect: "Hello Xlsx Fixture" },
  { file: "sample.odt", type: "odt", expect: "Hello Odt Fixture" },
  { file: "sample.odp", type: "odp", expect: "Hello Odp Fixture" },
  { file: "sample.ods", type: "ods", expect: "Hello Ods Fixture" },
];

for (const { file, type, expect } of EXTRACTION_CASES) {
  test(`extractDocumentText recovers known text from ${file}`, async () => {
    const result = await extractDocumentText(readFixture(file), type);
    assert.ok(
      result.text.includes(expect),
      `expected extracted ${type} text to include ${JSON.stringify(expect)}, got ${JSON.stringify(result.text)}`,
    );
    assert.equal(result.extractionMethod.length > 0, true);
    assert.ok(result.diagnostics);
  });
}

test("extractDocumentText returns empty text (not an error) for an image-only PDF", async () => {
  // A scanned/image-only PDF has no text layer; extraction must yield empty
  // text so the caller's quality gate flags it low-quality — it must NOT throw.
  const result = await extractDocumentText(readFixture("scanned.pdf"), "pdf");
  assert.equal(result.text.trim(), "");
  assert.equal(result.diagnostics?.severity, "critical");
  assert.match(result.diagnostics?.messages.join(" ") ?? "", /scanned document|needs OCR/iu);
});

test("PDF extraction preserves ordered page boundaries", async () => {
  const result = await extractDocumentText(
    simpleTextPdf(["First Page Boundary", "Second Page Boundary"]),
    "pdf",
  );

  assert.equal(result.pageCount, 2);
  assert.equal(result.pages?.length, 2);
  assert.match(result.pages?.[0] ?? "", /First Page Boundary/);
  assert.match(result.pages?.[1] ?? "", /Second Page Boundary/);
  assert.match(result.text, /First Page Boundary[\s\S]*\f[\s\S]*Second Page Boundary/);
  assert.equal(result.diagnostics?.metrics.extractedPageCount, 2);
});

test("quality assessment reports corruption without discarding text", () => {
  const text = `Readable beginning ${"\uFFFD".repeat(12)}\u0000\u0001 readable ending`;
  const diagnostics = assessDocumentExtractionQuality({ text });

  assert.equal(diagnostics.severity, "critical");
  assert.equal(diagnostics.metrics.replacementCharacterCount, 12);
  assert.equal(diagnostics.metrics.controlCharacterCount, 2);
  assert.match(diagnostics.messages.join(" "), /replacement/iu);
  assert.match(diagnostics.messages.join(" "), /control/iu);
});

test("quality assessment detects sparse pages, repeated headers, and collapsed lines", () => {
  const repeatedPages = Array.from({ length: 4 }, (_, index) =>
    `ASHES — Reader Copy\nChapter material ${index} ${"substantive narrative detail ".repeat(8)}\nPage ${index + 1}`,
  );
  const repeated = assessDocumentExtractionQuality({
    text: repeatedPages.join("\n\n\f\n\n"),
    pages: repeatedPages,
    pageCount: 4,
  });
  assert.equal(repeated.metrics.repeatedHeaderFooterPageCount, 4);
  assert.match(repeated.messages.join(" "), /Repeated header or footer/iu);

  const sparsePages = ["Title", "x", "y", `${"normal text ".repeat(30)}`];
  const sparse = assessDocumentExtractionQuality({
    text: sparsePages.join("\f"),
    pages: sparsePages,
    pageCount: 4,
  });
  assert.equal(sparse.metrics.sparsePageCount, 3);
  assert.match(sparse.messages.join(" "), /implausibly little selectable text/iu);

  const collapsed = assessDocumentExtractionQuality({ text: "word ".repeat(2_100) });
  assert.ok(collapsed.metrics.giantLineCount > 0);
  assert.match(collapsed.messages.join(" "), /collapsed paragraph or page structure/iu);
});

test("quality assessment leaves ordinary structured prose healthy", () => {
  const pages = Array.from({ length: 3 }, (_, index) =>
    `Chapter ${index + 1}\n${Array.from({ length: 6 }, (_, line) =>
      `This is normally wrapped narrative material from chapter ${index + 1}, line ${line + 1}.`
    ).join("\n")}`,
  );
  const diagnostics = assessDocumentExtractionQuality({
    text: pages.join("\n\n\f\n\n"),
    pages,
    pageCount: 3,
  });

  assert.equal(diagnostics.severity, "ok");
  assert.deepEqual(diagnostics.messages, []);
});
