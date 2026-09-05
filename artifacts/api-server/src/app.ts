import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import webhooksRouter from "./routes/webhooks";
import { logger } from "./lib/logger";
import { sessionMiddleware } from "./lib/auth";
import { isTrustedOrigin } from "./lib/origins";

const app: Express = express();

app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return { id: req.id, method: req.method, url: req.url?.split("?")[0] };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);

// Restrict cross-origin credentialed requests to trusted origins only. We never
// use `origin: true` (reflect any origin) together with credentials. Requests
// without an Origin header (curl, server-to-server, same-origin navigations, RSS
// readers) are not CORS-controlled and pass through; browser cross-origin
// requests must present a trusted origin.
app.use(
  cors({
    credentials: true,
    origin(origin, callback) {
      if (!origin || isTrustedOrigin(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
  }),
);
// Inbound provider webhooks are mounted BEFORE express.json so their handlers
// receive the raw request bytes — Svix/Resend signature verification must run
// over the exact payload that was signed (a re-serialized JSON body would not
// match). These routes verify their own signatures and need no session/CSRF.
app.use("/api/webhooks", express.raw({ type: "*/*", limit: "2mb" }), webhooksRouter);

// Hero-image and meme-image uploads send base64-encoded photos (8–15 MB).
// Those routes are auth-gated, so the generous limit is applied only to the
// /api/admin subtree. All public and other non-admin routes are capped at 256 KB
// to prevent unauthenticated request-amplification attacks. Body parsers in
// Express are skipped when the body has already been read, so the admin parser
// must be mounted first — it wins on /api/admin and the global one covers the rest.
app.use("/api/admin", express.json({ limit: "20mb" }));
app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: true }));

app.use(sessionMiddleware);

import storageRouter from "./routes/storage";
import seoRouter from "./routes/seo";
import rssRouter from "./routes/rss";
app.use("/api", storageRouter);
// Root-mounted SEO endpoints (sitemap, robots, IndexNow key, feed) so search
// engines and partners can reach them at the conventional host-root paths. The
// reverse proxy routes these specific paths to this service (see artifact.toml).
app.use(seoRouter);
app.use(rssRouter);
app.use("/api", router);

export default app;
