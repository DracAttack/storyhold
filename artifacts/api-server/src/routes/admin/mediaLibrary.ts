import { Router } from "express";
import { eq, inArray } from "drizzle-orm";
import { listPublicObjects, deletePublicObject } from "../../lib/objectStorage";
import { logger } from "../../lib/logger";
import { db, conceptsTable } from "@workspace/db";

const router = Router();

const GROUP_ORDER = [
  "hero-images",
  "share-cards",
  "glossary-cards",
  "glossary-cards-fb",
  "term-of-day-cards",
  "meme-artwork",
  "brand",
];

const GROUP_LABELS: Record<string, string> = {
  "hero-images": "Hero Images",
  "share-cards": "Share Cards",
  "glossary-cards": "Glossary Cards (9:16)",
  "glossary-cards-fb": "Glossary FB Cards (4:5)",
  "term-of-day-cards": "Term of Day Cards",
  "meme-artwork": "Meme Artwork",
  "brand": "Brand Assets",
};

/** The two glossary-card storage groups (reel 9:16 and FB feed 4:5). */
const GLOSSARY_GROUPS = ["glossary-cards", "glossary-cards-fb"] as const;

function slugFromGlossaryKey(key: string): string | null {
  const filename = key.split("/").pop() ?? "";
  // Pattern 1 (Satori og:image, legacy): <slug>-<8hexchars>.jpg
  const m1 = filename.match(/^(.+)-[0-9a-f]{8}\.jpg$/i);
  if (m1) return m1[1]!;
  // Pattern 2 (9:16 reel snapshot): <slug>-snap.png
  const m2 = filename.match(/^(.+)-snap\.png$/i);
  if (m2) return m2[1]!;
  // Pattern 3 (4:5 FB feed card): <slug>-card.png
  const m3 = filename.match(/^(.+)-card\.png$/i);
  if (m3) return m3[1]!;
  // Pattern 4 (transitional reel naming): <slug>-reel.png
  const m4 = filename.match(/^(.+)-reel\.png$/i);
  return m4 ? m4[1]! : null;
}

/**
 * Null out every concepts column that references a deleted glossary-card
 * object. Column ↔ prefix mapping:
 *   glossary-cards-fb/ → card_image_url (4:5 FB feed card)
 *   glossary-cards/    → reels_image_url (9:16 reel) + legacy
 *                        card_image_url / share_image (old snaps lived here)
 */
async function clearConceptCardRefs(key: string): Promise<void> {
  const objectUrl = `/api/storage/public-objects/${key}`;
  await db.update(conceptsTable).set({ shareImage: null }).where(eq(conceptsTable.shareImage, objectUrl));
  await db.update(conceptsTable).set({ cardImageUrl: null }).where(eq(conceptsTable.cardImageUrl, objectUrl));
  await db.update(conceptsTable).set({ reelsImageUrl: null }).where(eq(conceptsTable.reelsImageUrl, objectUrl));
}

// GET /admin/media-library
router.get("/media-library", async (_req, res) => {
  try {
    const files = await listPublicObjects();

    const groupMap = new Map<string, typeof files>();
    for (const f of files) {
      const slash = f.key.indexOf("/");
      const group = slash === -1 ? "other" : f.key.slice(0, slash);
      if (!groupMap.has(group)) groupMap.set(group, []);
      groupMap.get(group)!.push(f);
    }

    for (const items of groupMap.values()) {
      items.sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));
    }

    // Enrich both glossary-card groups with concept slug + id via DB lookup
    const glossaryRawByGroup = new Map(
      GLOSSARY_GROUPS.map((g) => [g, groupMap.get(g) ?? []] as const),
    );
    const slugsToFind = [
      ...new Set(
        [...glossaryRawByGroup.values()]
          .flat()
          .map((i) => slugFromGlossaryKey(i.key))
          .filter(Boolean) as string[],
      ),
    ];
    const conceptRows =
      slugsToFind.length > 0
        ? await db
            .select({
              id: conceptsTable.id,
              slug: conceptsTable.slug,
              termOfDayBlocked: conceptsTable.termOfDayBlocked,
              backfillRequested: conceptsTable.backfillRequested,
            })
            .from(conceptsTable)
            .where(inArray(conceptsTable.slug, slugsToFind))
        : [];
    const conceptBySlug = new Map(
      conceptRows.map(
        (c: { slug: string; id: string; termOfDayBlocked: boolean; backfillRequested: boolean }) =>
          [c.slug, c] as const,
      ),
    );

    for (const [group, raw] of glossaryRawByGroup) {
      if (raw.length === 0) continue;
      const enriched = raw.map((item) => {
        const slug = slugFromGlossaryKey(item.key);
        const concept = slug ? conceptBySlug.get(slug) : undefined;
        return {
          ...item,
          slug,
          conceptId: concept?.id ?? null,
          termOfDayBlocked: concept ? concept.termOfDayBlocked : null,
          backfillRequested: concept ? concept.backfillRequested : null,
        };
      });
      groupMap.set(group, enriched as typeof files);
    }

    const orderedKeys = [
      ...GROUP_ORDER.filter((g) => groupMap.has(g)),
      ...[...groupMap.keys()].filter((g) => !GROUP_ORDER.includes(g)),
    ];

    const groups = orderedKeys.map((name) => ({
      name,
      label: GROUP_LABELS[name] ?? name,
      items: groupMap.get(name) ?? [],
    }));

    res.json({ total: files.length, groups });
  } catch (err) {
    logger.warn({ err }, "media-library: failed to list objects");
    res.status(500).json({ error: "Failed to list media" });
  }
});

// DELETE /admin/media-library/group?group=<group-name>
// Bulk-delete every object in a named group and clear all DB references.
router.delete("/media-library/group", async (req, res) => {
  const group = req.query.group as string | undefined;
  if (!group || typeof group !== "string") {
    res.status(400).json({ error: "group required" });
    return;
  }

  try {
    const files = await listPublicObjects();
    const targets = files.filter((f) => {
      const slash = f.key.indexOf("/");
      return slash !== -1 && f.key.slice(0, slash) === group;
    });

    let deleted = 0;
    for (const f of targets) {
      const ok = await deletePublicObject(f.key).catch(() => false);
      if (!ok) continue;
      deleted++;

      if (f.key.startsWith("glossary-cards/") || f.key.startsWith("glossary-cards-fb/")) {
        await clearConceptCardRefs(f.key);
      }
    }

    logger.info({ group, deleted, total: targets.length }, "media-library: bulk group delete");
    res.json({ ok: true, deleted, total: targets.length });
  } catch (err) {
    logger.warn({ err, group }, "media-library: bulk group delete failed");
    res.status(500).json({ error: "delete_failed" });
  }
});

// DELETE /admin/media-library/item?key=<object-key>
// Removes an object from storage and clears any DB reference pointing to it.
router.delete("/media-library/item", async (req, res) => {
  const key = req.query.key as string | undefined;
  if (!key || typeof key !== "string") {
    res.status(400).json({ error: "key required" });
    return;
  }

  try {
    const deleted = await deletePublicObject(key);
    if (!deleted) {
      res.status(404).json({ error: "object_not_found" });
      return;
    }

    // Clear DB reference if it's a glossary card (either group)
    if (key.startsWith("glossary-cards/") || key.startsWith("glossary-cards-fb/")) {
      await clearConceptCardRefs(key);
    }

    logger.info({ key }, "media-library: deleted object");
    res.json({ ok: true });
  } catch (err) {
    logger.warn({ err, key }, "media-library: delete failed");
    res.status(500).json({ error: "delete_failed" });
  }
});

export default router;
