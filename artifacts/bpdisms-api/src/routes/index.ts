import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import storageRouter from "./storage";
import uploadsRouter from "./uploads";
import postsRouter from "./posts";
import postingSlotsRouter from "./postingSlots";
import settingsRouter from "./settings";
import zernioTestRouter from "./zernioTest";
import zernioAnalyticsRouter from "./zernioAnalytics";

// The admin gate lives in app.ts (it runs before this router and allowlists
// /healthz + the two GET storage image routes). Routes here assume the request
// is either public-open or already admin-authenticated.
const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(storageRouter);
router.use(uploadsRouter);
router.use(postsRouter);
router.use(postingSlotsRouter);
router.use(settingsRouter);
router.use(zernioTestRouter);
router.use(zernioAnalyticsRouter);

export default router;
