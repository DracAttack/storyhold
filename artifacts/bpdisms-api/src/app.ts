import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { sessionMiddleware, requireAdmin, requireTrustedOrigin, isTrustedOrigin } from "./lib/auth";

const app: Express = express();

// Behind the Replit reverse proxy: needed for req.ip and the shared session
// cookie's `secure` flag in production, matching api-server.
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// Was `cors()` (reflect ANY origin) — that let any third-party page drive this
// API from a visitor's browser. Now mirrors the main API: credentialed CORS
// only for trusted site origins; requests without an Origin header (curl,
// health checks, same-origin navigations, and server-side image fetches from
// Zernio/Facebook) are not CORS-controlled and pass.
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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Read the shared BrainHook admin session (cookie `cm.sid`, set by the main
// API's /admin/login). See src/lib/auth.ts for the full rationale.
if (sessionMiddleware) app.use(sessionMiddleware);

// Admin gate. Everything under /bpdisms/api requires the shared admin session
// (mutations additionally require a trusted Origin — CSRF defense-in-depth)
// EXCEPT:
//   - /healthz                    — deployment health check.
//   - GET /storage/public-objects/* and GET /storage/objects/* — meme image
//     serving. Zernio and Facebook fetch these image URLs server-side with NO
//     admin cookie, so gating them would break Facebook posting. Meme images
//     are public content by design; the upload/write endpoints stay gated.
app.use("/bpdisms/api", (req, res, next) => {
  const isOpen =
    req.path === "/healthz" ||
    (req.method === "GET" && req.path.startsWith("/storage/public-objects/")) ||
    (req.method === "GET" && req.path.startsWith("/storage/objects/"));
  if (isOpen) {
    next();
    return;
  }
  requireAdmin(req, res, () => requireTrustedOrigin(req, res, next));
});

app.use("/bpdisms/api", router);

export default app;
