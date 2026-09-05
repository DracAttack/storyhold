import { Router, type IRouter } from "express";
import { testConnection } from "../services/zernio";

const router: IRouter = Router();

router.post("/zernio/test", async (_req, res): Promise<void> => {
  const result = await testConnection();
  res.json(result);
});

export default router;
