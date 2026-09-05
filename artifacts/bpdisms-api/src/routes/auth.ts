import { Router, type IRouter } from "express";

const router: IRouter = Router();

// Mounted behind requireAdmin, so an unauthenticated caller gets 401 here.
// The web app calls this on load to decide whether to show the sign-in gate.
router.get("/me", (req, res) => {
  res.json({ email: req.session?.adminEmail ?? null });
});

export default router;
