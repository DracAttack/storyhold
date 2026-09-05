import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db, sourceDocumentsTable, sourceVaultJobsTable } from "@workspace/db";
import { like, sql } from "drizzle-orm";
import { ingestUpload } from "./sourceVault";

// Ingestion-outcome regression for uploaded documents (Task #198's core
// guarantee). The pure type-detector is unit-tested elsewhere; here we lock the
// ACTUAL end-to-end status a document lands in after ingestUpload, so a future
// refactor of the quality gate or the upload lifecycle can't quietly start
// embedding bad data as if it were a good source. The four outcomes that must
// never regress:
//   1. a good extract is stored "extracted" (embeddable),
//   2. an unsupported file type is recorded "failed" (never silently stored),
//   3. a parse failure (DocumentExtractionError) is recorded "failed",
//   4. empty / low-quality text is held "low_quality" (out of embedding).
//
// Runs against the dev/test Postgres pointed to by DATABASE_URL (same style as
// sourceIngestQueue.test.ts / editorialScreen.test.ts). Every test-owned file
// uses FILENAME_PREFIX so the content-addressed rows and their job rows can be
// cleaned up without touching real uploads. Embedding is forced OFF for the run
// (perplexity provider with no API key → isEmbeddingConfigured() === false) so
// a good extract deterministically lands "extracted" without pulling the local
// MiniLM model — the quality-gate outcome, not embedding, is what's under test.

const FILENAME_PREFIX = "zz-test-upload-";

const savedEnv: Record<string, string | undefined> = {};
function forceEmbeddingOff(): void {
  for (const k of ["SOURCE_VAULT_EMBED_PROVIDER", "PERPLEXITY_API_KEY"]) {
    savedEnv[k] = process.env[k];
  }
  // Selecting perplexity without an API key makes isEmbeddingConfigured()
  // return false (fail-closed), so canEmbed is false on every path here.
  process.env.SOURCE_VAULT_EMBED_PROVIDER = "perplexity";
  delete process.env.PERPLEXITY_API_KEY;
}
function restoreEmbeddingEnv(): void {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

async function cleanup(): Promise<void> {
  // Job rows carry the filename under input->>'upload'; documents are the
  // content-addressed upload:// rows whose title is the (prefixed) filename.
  await db
    .delete(sourceVaultJobsTable)
    .where(sql`${sourceVaultJobsTable.input} ->> 'upload' LIKE ${`${FILENAME_PREFIX}%`}`);
  await db
    .delete(sourceDocumentsTable)
    .where(like(sourceDocumentsTable.title, `${FILENAME_PREFIX}%`));
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

before(forceEmbeddingOff);
beforeEach(cleanup);
after(async () => {
  await cleanup();
  restoreEmbeddingEnv();
});

test("a good extract is stored 'extracted' (never silently dropped)", async () => {
  // A long, multi-paragraph body clears the quality bar (score 100): plenty of
  // words and real paragraph structure, so nothing is flagged.
  const paragraph = Array.from({ length: 60 }, (_, i) => `sentence number ${i} about the topic`).join(" ");
  const body = `${paragraph}\n\n${paragraph}`;
  const res = await ingestUpload({
    filename: `${FILENAME_PREFIX}good.txt`,
    contentBase64: b64(body),
    contentType: "text/plain",
  });

  assert.equal(res.document.status, "extracted", "a good upload is stored extracted");
  assert.equal(res.embedded, false, "embedding is off, so nothing is embedded");
  assert.equal(res.document.error, null, "a good extract records no error");
  assert.ok(res.document.wordCount > 100, "the extracted word count is recorded");
});

test("an unsupported file type is recorded 'failed', never stored as a source", async () => {
  const res = await ingestUpload({
    filename: `${FILENAME_PREFIX}malware.exe`,
    contentBase64: b64("MZ not a document we can extract"),
    contentType: "application/octet-stream",
  });

  assert.equal(res.document.status, "failed", "an unsupported type is a failed document");
  assert.equal(res.embedded, false, "an unsupported upload is never embedded");
  assert.ok(res.document.error, "the failure reason is recorded on the document");
  assert.match(res.document.error ?? "", /[Uu]nsupported/, "the error explains the unsupported type");
});

test("a parse failure (DocumentExtractionError) is recorded 'failed'", async () => {
  // A .pptx (detected by extension) whose bytes are not a valid ZIP container:
  // unzipSync throws, extractDocumentText wraps it in DocumentExtractionError,
  // and ingestUpload must record it as failed rather than storing empty text.
  const res = await ingestUpload({
    filename: `${FILENAME_PREFIX}corrupt.pptx`,
    contentBase64: b64("this is definitely not a valid pptx zip archive"),
    contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  });

  assert.equal(res.document.status, "failed", "a parse failure is a failed document");
  assert.equal(res.embedded, false, "a corrupt upload is never embedded");
  assert.ok(res.document.error, "the extraction error is recorded on the document");
});

test("empty / low-quality text is held 'low_quality', not embedded", async () => {
  // A scanned image-only PDF yields empty text; a whitespace-only .txt is the
  // decode-side equivalent — it parses fine but has no usable content, so it must
  // be held below the quality bar rather than silently stored as a good source.
  const res = await ingestUpload({
    filename: `${FILENAME_PREFIX}empty.txt`,
    contentBase64: b64("   \n \t  \n   "),
    contentType: "text/plain",
  });

  assert.equal(res.document.status, "low_quality", "empty text is held as low_quality");
  assert.equal(res.embedded, false, "low-quality text is never embedded");
  assert.equal(res.document.wordCount, 0, "no usable words were extracted");
});
