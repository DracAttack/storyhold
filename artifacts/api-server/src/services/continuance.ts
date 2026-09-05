import { db, articlesTable, authorsTable, topicIdeasTable, type Author, type Article } from "@workspace/db";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { logger } from "../lib/logger";
import { recordTextUsage } from "./aiUsage";

const MODEL = "claude-sonnet-4-6";

interface ContinuanceProposal {
  shouldFollowUp: boolean;
  title?: string;
  angle?: string;
  reason?: string;
}

function extractJson<T>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(raw.slice(start)) as T;
  } catch {
    return null;
  }
}

async function proposeFollowUp(author: Author, article: Article): Promise<ContinuanceProposal> {
  const monthsOld = Math.max(
    1,
    Math.round(
      (Date.now() - new Date(article.publishedAt ?? article.createdAt).getTime()) /
        (1000 * 60 * 60 * 24 * 30),
    ),
  );
  const sys = `You are ${author.name}, a writer for BrainHook covering ${author.category}. ${author.voicePrompt}`;
  const firstParagraph = (article.body.find((b) => b.type === "paragraph")?.content ?? "").slice(0, 600);
  const user = `About ${monthsOld} month${monthsOld === 1 ? "" : "s"} ago you published this article:

Title: ${article.title}
Subhead: ${article.dek}
Opening: ${firstParagraph}

Has there been a notable development in ${author.category} since then that would justify a follow-up — a new study, a notable event, a shifted consensus, or a counter-finding that updates this piece? Be honest: if nothing genuinely new has happened, say so.

Respond with ONLY a JSON object:
{
  "shouldFollowUp": true | false,
  "title": "Working title for the follow-up (only if shouldFollowUp is true)",
  "angle": "One-sentence editorial angle for the follow-up (only if shouldFollowUp is true)",
  "reason": "One sentence explaining why this warrants (or doesn't warrant) a follow-up"
}`;

  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: sys,
    messages: [{ role: "user", content: user }],
  });
  recordTextUsage({ operation: "proposeFollowUp", model: MODEL, message, authorSlug: author.slug });
  const block = message.content[0];
  const text = block && block.type === "text" ? block.text : "";
  const parsed = extractJson<ContinuanceProposal>(text);
  return parsed ?? { shouldFollowUp: false };
}

export interface ContinuanceScanResult {
  ideasCreated: number;
  articlesScanned: number;
}

/**
 * For each active author, look at their recent published articles (30+ days
 * old, no existing follow-up idea), ask the LLM whether a follow-up is
 * warranted, and create a `topic_ideas` row with `continuesArticleId` set.
 *
 * Returns counts. Errors per-article are logged and skipped.
 */
export async function scanForContinuance(
  opts: { perAuthorLimit?: number; minAgeDays?: number } = {},
): Promise<ContinuanceScanResult> {
  const perAuthorLimit = opts.perAuthorLimit ?? 3;
  const minAgeDays = opts.minAgeDays ?? 30;
  const cutoff = new Date(Date.now() - minAgeDays * 24 * 60 * 60 * 1000);

  const authors = await db.select().from(authorsTable).where(eq(authorsTable.active, true));
  let ideasCreated = 0;
  let articlesScanned = 0;

  for (const author of authors) {
    const candidates = await db
      .select()
      .from(articlesTable)
      .where(
        and(
          eq(articlesTable.authorId, author.id),
          eq(articlesTable.status, "published"),
          isNull(articlesTable.quarantinedAt),
          sql`${articlesTable.publishedAt} <= ${cutoff}`,
        ),
      )
      .orderBy(desc(articlesTable.publishedAt))
      .limit(perAuthorLimit);

    for (const article of candidates) {
      // Skip if a follow-up idea already exists for this article.
      const [existing] = await db
        .select({ id: topicIdeasTable.id })
        .from(topicIdeasTable)
        .where(eq(topicIdeasTable.continuesArticleId, article.id))
        .limit(1);
      if (existing) continue;

      articlesScanned += 1;
      try {
        const proposal = await proposeFollowUp(author as Author, article);
        if (!proposal.shouldFollowUp || !proposal.title || !proposal.angle) continue;
        await db.insert(topicIdeasTable).values({
          authorId: author.id,
          title: proposal.title,
          angle: proposal.angle,
          status: "pending",
          continuesArticleId: article.id,
          notes: proposal.reason ? `Follow-up: ${proposal.reason}` : "Follow-up suggestion",
        });
        ideasCreated += 1;
      } catch (e) {
        logger.error({ err: e, articleId: article.id }, "Continuance proposal failed");
      }
    }
  }

  return { ideasCreated, articlesScanned };
}
