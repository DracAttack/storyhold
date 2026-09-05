# SEO Strategy

## In scope
- Public reader-facing BrainHook routes in `artifacts/site`
- Homepage, article pages, category pages, author pages
- Public trust / policy pages (`/about`, `/contact`, `/privacy`, `/terms`, `/editorial-policy`, `/corrections`)
- Host-root crawl files served by `artifacts/api-server` (`/robots.txt`, `/sitemap.xml`, `/rss.xml`, `/indexnow-key.txt`, `/ads.txt`)

## Out of scope
- Authenticated and admin routes under `/admin/**`
- Internal API JSON routes except where they directly power crawl files or SSR SEO output
- `mockup-sandbox`
- `bpdisms` and `bpdisms-api` standalone product surfaces

## Target audience
- Readers looking for research-backed magazine content about science, psychology, human behavior, and related current events.

## Primary keywords
- Unknown — likely publication-level rather than a single commercial keyword. Update when an editorial keyword strategy is available.

## Current rendering model
- `artifacts/site` is a React + Vite app with production Node SSR/meta injection in `artifacts/site/server/index.ts`.
- Public routes are hybrid: key public pages are SSR/prerendered in production; dev remains SPA.

## Dismissed categories
- None yet.

## Notes
- Current `robots.txt` intentionally distinguishes search/social access from some AI-training/bulk crawlers in code comments. Treat that as current posture, but not as a user-approved dismissal unless explicitly documented later.
