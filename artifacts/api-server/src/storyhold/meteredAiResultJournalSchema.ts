// Shared schema is a dependency-free leaf so startup does not depend on the
// campaignPlay -> worldStudio -> storyStudio runtime import order.
export const meteredAiResultJournalSchemaSql = String.raw`
  CREATE TABLE IF NOT EXISTS storyhold.metered_ai_result_journal (
    id uuid PRIMARY KEY,
    player_id uuid NOT NULL REFERENCES storyhold.players(id) ON DELETE RESTRICT,
    world_id uuid NOT NULL REFERENCES storyhold.worlds(id) ON DELETE CASCADE,
    campaign_id uuid NOT NULL REFERENCES storyhold.campaigns(id) ON DELETE CASCADE,
    reservation_id uuid,
    operation text NOT NULL,
    request_id text NOT NULL,
    input_sha256 text NOT NULL,
    settlement_mode text NOT NULL DEFAULT 'metered'
      CHECK (settlement_mode IN ('metered', 'fixed')),
    fixed_credits integer CHECK (fixed_credits IS NULL OR fixed_credits >= 0),
    status text NOT NULL DEFAULT 'prepared'
      CHECK (status IN (
        'prepared', 'completed', 'billable_failed', 'uncertain', 'applied', 'failed'
      )),
    response_text text,
    response_sha256 text,
    last_error text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    applied_at timestamptz,
    UNIQUE (player_id, operation, request_id)
  );

  ALTER TABLE storyhold.metered_ai_result_journal
    ADD COLUMN IF NOT EXISTS settlement_mode text NOT NULL DEFAULT 'metered';
  ALTER TABLE storyhold.metered_ai_result_journal
    ADD COLUMN IF NOT EXISTS fixed_credits integer;
  DO $metered_ai_result_journal_migration$
  DECLARE
    status_definition text;
  BEGIN
    SELECT pg_get_constraintdef(oid)
      INTO status_definition
      FROM pg_constraint
     WHERE conrelid = 'storyhold.metered_ai_result_journal'::regclass
       AND conname = 'metered_ai_result_journal_status_check';

    IF status_definition IS NULL THEN
      ALTER TABLE storyhold.metered_ai_result_journal
        ADD CONSTRAINT metered_ai_result_journal_status_check
        CHECK (status IN (
          'prepared', 'completed', 'billable_failed', 'uncertain', 'applied', 'failed'
        ));
    ELSIF position('billable_failed' in status_definition) = 0
       OR position('uncertain' in status_definition) = 0 THEN
      -- Upgrade the one pre-release constraint shape once. Subsequent startup
      -- schema checks are read-only and do not repeatedly lock/rewrite it.
      ALTER TABLE storyhold.metered_ai_result_journal
        DROP CONSTRAINT metered_ai_result_journal_status_check;
      ALTER TABLE storyhold.metered_ai_result_journal
        ADD CONSTRAINT metered_ai_result_journal_status_check
        CHECK (status IN (
          'prepared', 'completed', 'billable_failed', 'uncertain', 'applied', 'failed'
        ));
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conrelid = 'storyhold.metered_ai_result_journal'::regclass
         AND conname = 'metered_ai_result_journal_settlement_mode_check'
    ) THEN
      ALTER TABLE storyhold.metered_ai_result_journal
        ADD CONSTRAINT metered_ai_result_journal_settlement_mode_check
        CHECK (settlement_mode IN ('metered', 'fixed'));
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conrelid = 'storyhold.metered_ai_result_journal'::regclass
         AND conname = 'metered_ai_result_journal_fixed_credits_check'
    ) THEN
      ALTER TABLE storyhold.metered_ai_result_journal
        ADD CONSTRAINT metered_ai_result_journal_fixed_credits_check
        CHECK (fixed_credits IS NULL OR fixed_credits >= 0);
    END IF;
  END
  $metered_ai_result_journal_migration$;

  CREATE INDEX IF NOT EXISTS metered_ai_result_journal_campaign
    ON storyhold.metered_ai_result_journal
      (campaign_id, status, created_at DESC);
`;
