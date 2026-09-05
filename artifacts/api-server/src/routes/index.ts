import { Router, type IRouter } from "express";
import healthRouter from "./health";
import healthzSeoRouter from "./healthz-seo";
import cronRouter from "./cron";
import publicRouter from "./public";
import rssRouter from "./rss";
import adminAuth from "./admin/auth";
import adminAuthors from "./admin/authors";
import adminBeats from "./admin/beats";
import adminIdeas from "./admin/ideas";
import adminArticles from "./admin/articles";
import adminStats from "./admin/stats";
import adminNotifications from "./admin/notifications";
import adminSiteSettings from "./admin/siteSettings";
import adminAiSettings from "./admin/aiSettings";
import adminLlm from "./admin/llm";
import adminSchedule from "./admin/schedule";
import adminSubscribers from "./admin/subscribers";
import adminShares from "./admin/shares";
import adminReaderJourneys from "./admin/readerJourneys";
import adminPageViews from "./admin/pageViews";
import adminAiUsage from "./admin/aiUsage";
import adminUtmPresets from "./admin/utmPresets";
import adminDuplicates from "./admin/duplicates";
import adminTrends from "./admin/trends";
import adminSourceVault from "./admin/sourceVault";
import adminSourceHealth from "./admin/sourceHealth";
import adminFeeds from "./admin/feeds";
import adminSocialQueue from "./admin/socialQueue";
import adminMemes from "./admin/memes";
import adminEditorReview from "./admin/editorReview";
import adminBackCatalog from "./admin/backCatalog";
import adminCitations from "./admin/citations";
import adminConcepts from "./admin/concepts";
import adminConceptRadar from "./admin/conceptRadar";
import adminSourceGaps from "./admin/sourceGaps";
import adminTermOfDay from "./admin/termOfDay";
import adminMediaLibrary from "./admin/mediaLibrary";
import adminCoverageMap from "./admin/coverageMap";
import adminClaims from "./admin/claims";
import { requireAdmin } from "../lib/auth";
import { requireTrustedOrigin } from "../lib/origins";

const router: IRouter = Router();

router.use(healthRouter);
// Token-protected SEO smoke check — mirrors verify-bot-readable.sh. Designed to
// be pinged by UptimeRobot after each prod deploy (same CRON_TICK_TOKEN). Returns
// 200/503 so the monitor can alert the team when SSR meta-injection regresses.
router.use(healthzSeoRouter);
// Token-protected external scheduler tick (UptimeRobot). Public — must sit
// before the /admin CSRF + session guards so the pinger (no Origin/cookie) can
// reach it; the token is the only gate.
router.use(cronRouter);
router.use("/public", publicRouter);
router.use(rssRouter);

// CSRF defense-in-depth: every state-changing request under /admin (including
// login/logout) must originate from a trusted site origin. Safe methods pass.
router.use("/admin", requireTrustedOrigin);

// Auth routes (login is public, logout/me require auth via per-route guard)
router.use("/admin", adminAuth);

const admin: IRouter = Router();
admin.use(requireAdmin);
admin.use("/authors", adminAuthors);
admin.use("/beats", adminBeats);
admin.use(adminIdeas);
admin.use(adminArticles);
admin.use(adminStats);
admin.use(adminNotifications);
admin.use(adminSiteSettings);
admin.use(adminAiSettings);
admin.use(adminLlm);
admin.use(adminSchedule);
admin.use(adminSubscribers);
admin.use(adminShares);
admin.use(adminReaderJourneys);
admin.use(adminPageViews);
admin.use(adminAiUsage);
admin.use(adminUtmPresets);
admin.use(adminDuplicates);
admin.use(adminTrends);
admin.use(adminSourceVault);
admin.use(adminSourceHealth);
admin.use(adminFeeds);
admin.use(adminSocialQueue);
admin.use(adminMemes);
admin.use(adminEditorReview);
admin.use(adminBackCatalog);
admin.use(adminCitations);
admin.use(adminConcepts);
admin.use(adminConceptRadar);
admin.use(adminSourceGaps);
admin.use(adminTermOfDay);
admin.use(adminMediaLibrary);
admin.use(adminCoverageMap);
admin.use(adminClaims);

router.use("/admin", admin);

export default router;
