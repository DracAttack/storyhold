# Storyhold

## What This Repository Is

Storyhold is an interactive-fiction and role-playing platform. It lets an author turn uploaded manuscripts into a searchable Lorekeeper Vault, then use that canon for guided play; it also supports original RPG campaigns created without a manuscript.

This is a pnpm TypeScript workspace. The source of truth for the hosted app is the root `.replit`, `package.json`, `pnpm-workspace.yaml`, and `pnpm-lock.yaml` files. Do not scaffold a replacement application or replace the workspace configuration when importing this repository.

## Application Structure

- `artifacts/api-server` — Express 5 application server. It owns auth, Lorekeeper data, campaigns, uploads, credit accounting, and Storyhold's AI provider gateway. It listens on port 3000.
- `artifacts/site` — React 19 and Vite customer interface.
- `lib/content-utils` — shared Storyhold title capitalization.
- `lib/api-client-react` — shared fetch/error utilities; the retired magazine's generated client has been removed.
- `lib/db` — compatibility schema/client for the optional Perplexity embedding usage ledger. Storyhold's primary schema and PostgreSQL adapter live in `artifacts/api-server/src/storyhold` and `src/local.ts`.
- `scripts` — Storyhold validation, local-development helpers, and optional local-model tools.

## Runtime and Deployment

- Runtime: Node 20, Python 3.12, web, and PostgreSQL 16 as declared in `.replit`.
- Deployment target: Autoscale.
- Build: `pnpm run storyhold:build`.
- Production start: `pnpm run storyhold:start`.
- Development run button currently calls `pnpm run storyhold:local`, a Windows local-model launcher. This inherited configuration needs a separate hosted-development command before using the Run button on Linux; production build/start above use different commands.
- Validation: `pnpm run typecheck` and `pnpm run storyhold:audit-scenarios`.

Use the committed `pnpm-lock.yaml` for dependency installation. Do not manually install packages one by one or substitute npm/yarn. The root preinstall script enforces using pnpm; it does not install pnpm.

## Database

Storyhold requires PostgreSQL for accounts, sessions, worlds, documents, Lorekeeper evidence, campaigns, and credits.

- Replit development and production databases are separate.
- Replit must provision a native **production** PostgreSQL database before an Autoscale publish can be healthy.
- `DATABASE_URL` is platform-managed. Do not hard-code `helium`, copy a development connection string into Secrets, or point production to laptop storage.
- PGlite is a local-development fallback only. It is not a production database for an Autoscale deployment.
- Production also requires private Replit App Storage (`PRIVATE_OBJECT_DIR`) for uploaded source documents and `SESSION_SECRET` or `STORYHOLD_CAUSAL_SECRET` of at least 32 characters for session security. The storage SDK is a required dependency.
- Development schema creation uses the explicitly gated `storyhold:schema:development` command. Published instances wait for the Storyhold schema release marker; removing unused source files must never drop database tables or rewrite stored worlds.

## AI and Local Models

Premium AI providers are optional until their Storyhold-specific secret is configured. The gateway supports OpenRouter, OpenAI, Anthropic, xAI, Kimi, Perplexity, and Gemini. Keep the SDKs actually imported by the gateway installed; credentials and live provider calls are not needed to build. Leave a lane disabled unless its own key and approved model have been deliberately configured.

The six-model local Canon Intake stack — GLiNER2, coreference, NLI, MiniLM, BGE, and local Qwen — is designed for a capable local machine or a dedicated worker. Its installer downloads Python packages, model weights, and a quantized Qwen GGUF. Do **not** run the Windows PowerShell/CUDA installers or require loopback model endpoints in a normal Replit Autoscale web instance. Hosted intake should use the server's provider gateway or a future worker service.

Browser WebLLM is an optional client-side capability, not a server requirement.

## Secrets and Privacy

- Put only actual provider keys and production-only values in Replit Secrets.
- Never commit `.storyhold.env`, `DATABASE_URL`, provider keys, or customer documents.
- The checked-in `.storyhold.env.example` is a reference for local development, not a list to copy wholesale into a hosted deployment.

## Important Guardrails for Agents

- Preserve the Storyhold data model and canonical IDs. Do not replace it with generic chat, blog, or news-site scaffolding.
- Do not expose internal model names, pipeline stages, or provider mechanics in customer-facing copy.
- Do not enable local CUDA/model download scripts on Autoscale.
- Treat `training/`, benchmark scripts, screenshots, and local recovery tools as development assets unless a task explicitly targets them.
