import { Router, type IRouter } from "express";
import { ObjectStorageService } from "../lib/objectStorage";
import { z } from "zod";

const router: IRouter = Router();
const storage = new ObjectStorageService();

const RequestUploadSchema = z.object({
  name: z.string(),
  size: z.number(),
  contentType: z.string(),
});

function getPublicBaseUrl(): string {
  // Prefer the canonical production base URL when set (e.g.
  // https://brainhook.net) so image URLs handed to Zernio/Facebook are stable;
  // fall back to the first Replit domain in development.
  const siteBase = process.env.SITE_BASE_URL?.trim();
  if (siteBase) return siteBase.replace(/\/+$/, "");
  const domains = process.env.REPLIT_DOMAINS;
  if (domains) {
    const first = domains.split(",")[0]?.trim();
    if (first) return `https://${first}`;
  }
  return "";
}

router.post("/uploads", async (req, res): Promise<void> => {
  const parsed = RequestUploadSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { contentType } = parsed.data;
  const allowed = ["image/png", "image/jpeg", "image/jpg", "image/webp"];
  if (!allowed.includes(contentType.toLowerCase())) {
    res.status(400).json({
      error: `Unsupported file type: ${contentType}. Only PNG, JPG, JPEG, and WEBP are accepted.`,
    });
    return;
  }

  const uploadURL = await storage.getObjectEntityUploadURL();
  const objectPath = storage.normalizeObjectEntityPath(uploadURL);

  const publicBase = getPublicBaseUrl();
  const imageUrl = `${publicBase}/bpdisms/api/storage${objectPath}`;

  res.json({ uploadURL, objectPath, imageUrl });
});

export default router;
