import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { getAiSettings, updateAiSetting, resetAiSetting } from "../../services/aiSettings";
import { isAiFunctionKey, findMissingPlaceholders } from "../../services/aiRegistry";

const router: IRouter = Router();

router.get("/ai-settings", async (_req, res) => {
  const view = await getAiSettings();
  res.json(view);
});

router.patch("/ai-settings/:key", async (req, res) => {
  const { key } = req.params;
  if (!isAiFunctionKey(key)) {
    res.status(404).json({ error: "Unknown AI function" });
    return;
  }
  const parsed = z
    .object({
      enabled: z.boolean().optional(),
      directive: z.string().nullable().optional(),
      model: z.string().nullable().optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body" });
    return;
  }
  // Reject a directive override that drops a required {{TOKEN}} placeholder
  // (image prompts only). Without the token, the per-call builder can't inject
  // the article subject / author persona / beat brief, silently producing a
  // generic, off-subject image. A blank directive is allowed (it resets to the
  // default at resolve time).
  if (typeof parsed.data.directive === "string") {
    const missing = findMissingPlaceholders(key, parsed.data.directive);
    if (missing.length > 0) {
      res.status(400).json({
        error: `Directive is missing required placeholder${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`,
        missingPlaceholders: missing,
      });
      return;
    }
  }
  const fn = await updateAiSetting(key, parsed.data);
  res.json(fn);
});

router.post("/ai-settings/:key/reset", async (req, res) => {
  const { key } = req.params;
  if (!isAiFunctionKey(key)) {
    res.status(404).json({ error: "Unknown AI function" });
    return;
  }
  const fn = await resetAiSetting(key);
  res.json(fn);
});

export default router;
