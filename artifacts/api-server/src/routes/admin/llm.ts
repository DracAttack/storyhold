import { Router, type IRouter } from "express";
import { LLM_MODELS } from "../../services/llm";

const router: IRouter = Router();

router.get("/llm/models", (_req, res) => {
  res.json({ items: LLM_MODELS });
});

export default router;
