import { Storage } from "@google-cloud/storage";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";
const storage = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
    type: "external_account",
    credential_source: {
      url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
      format: { type: "json", subject_token_field_name: "access_token" },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
});

const searchPath = process.env.PUBLIC_OBJECT_SEARCH_PATHS.split(",")[0].trim();
const trimmed = searchPath.startsWith("/") ? searchPath.slice(1) : searchPath;
const slash = trimmed.indexOf("/");
const bucketName = trimmed.slice(0, slash);
const prefix = trimmed.slice(slash + 1);

const tmp = path.join(tmpdir(), "hero-opt-" + Date.now());
mkdirSync(tmp, { recursive: true });

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const { rows } = await client.query(
  "SELECT id, slug, hero_image FROM articles WHERE hero_image LIKE '/api/storage/public-objects/hero-images/%.png'",
);
console.log(`Found ${rows.length} PNG heroes to optimize`);

let totalBefore = 0, totalAfter = 0, ok = 0, fail = 0;
for (const row of rows) {
  const fileKey = row.hero_image.replace("/api/storage/public-objects/", "");
  const oldName = path.basename(fileKey);
  const newName = oldName.replace(/\.png$/i, ".jpg");
  const newKey = fileKey.replace(/\.png$/i, ".jpg");
  const objectName = `${prefix}/${fileKey}`;
  const newObjectName = `${prefix}/${newKey}`;
  const localPng = path.join(tmp, oldName);
  const localJpg = path.join(tmp, newName);

  try {
    const file = storage.bucket(bucketName).file(objectName);
    const [buf] = await file.download();
    writeFileSync(localPng, buf);
    totalBefore += buf.length;

    execFileSync("magick", [
      localPng,
      "-resize", "1600x1600>",
      "-strip",
      "-interlace", "Plane",
      "-quality", "82",
      localJpg,
    ]);
    const jpgBuf = readFileSync(localJpg);
    totalAfter += jpgBuf.length;

    await storage.bucket(bucketName).file(newObjectName).save(jpgBuf, {
      contentType: "image/jpeg",
      resumable: false,
      metadata: { cacheControl: "public, max-age=31536000, immutable" },
    });

    const newUrl = `/api/storage/public-objects/${newKey}`;
    await client.query("UPDATE articles SET hero_image=$1 WHERE id=$2", [newUrl, row.id]);

    // delete original PNG
    try { await file.delete(); } catch (e) { console.warn("delete failed:", e.message); }

    ok++;
    console.log(`OK ${row.slug.slice(0,50).padEnd(50)} ${(buf.length/1024).toFixed(0)}KB -> ${(jpgBuf.length/1024).toFixed(0)}KB`);
  } catch (e) {
    fail++;
    console.error(`FAIL ${row.slug}: ${e.message}`);
  }
}

console.log(`\nDone. ${ok} ok, ${fail} fail. ${(totalBefore/1024/1024).toFixed(1)}MB -> ${(totalAfter/1024/1024).toFixed(1)}MB`);
rmSync(tmp, { recursive: true, force: true });
await client.end();
