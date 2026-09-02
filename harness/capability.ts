/**
 * Capability cases: harder, development-flavored council cases for
 * champion-challenger comparison. Separate from the regression set in
 * cases.ts — the 3 regression cases stay the hard gate; these 5 measure
 * whether a challenger actually gets *better* on hard development calls.
 *
 * cap-procedure-holdout is the procedural holdout: an embedded-trap scenario
 * excluded from tuning summaries but included in promotion checks, to detect
 * overfitting to the graded four. Visible in this public repo by design — the
 * defense is the embedded trap plus exclusion from tuning output, not secrecy.
 * Its trap: the seeded RELEASE.md encodes the status quo, and the cheapest
 * correct answer (enforced PR template + tiny gate) requires noticing the
 * constraint tension instead of defaulting to building tooling.
 */

export type CapabilityCase = {
  caseId: string
  slug: string
  mode: "low" | "medium" | "auto"
  question: string
  context?: string
  seedFiles: Record<string, string>
  /** True for the holdout: excluded from tuning summaries, required in promotion. */
  holdout?: boolean
}

export const CAPABILITY_CASES: CapabilityCase[] = [
  {
    caseId: "cap-migration-cutover",
    slug: "dashboard-analytics",
    mode: "medium",
    question:
      "Our analytics dashboard reads from a Postgres replica that has grown to 800GB and slow queries are now p95 4s. Should we move the rollups into ClickHouse, add a Redis cache in front of Postgres, or pre-aggregate into hourly summary tables inside Postgres?",
    context:
      "Team of 4, nobody has operated ClickHouse before. Traffic is 20k dashboard queries/day, dashboards are read-only, data retention is 13 months. Two weeks of engineering time available.",
    seedFiles: {
      "README.md": "# dashboard-analytics\n\nInternal dashboards over Postgres. Slow and getting slower.\n",
      "migrations/0001_init.sql":
        "CREATE TABLE events (id bigserial PRIMARY KEY, user_id bigint, kind text, payload jsonb, occurred_at timestamptz);\n",
    },
  },
  {
    caseId: "cap-rate-limit-design",
    slug: "payments-api-gateway",
    mode: "auto",
    question:
      "We expose a payments API behind a gateway and one abusive client can starve everyone. Should rate limiting be implemented with a token bucket in our Node gateway process, a distributed sliding-window counter in Redis, or enforced at the load balancer with connection limits?",
    context:
      "Deployment is 3 gateway pods behind an ALB. We can tolerate per-client 429s but bursts of legit traffic come from a single partner with a NAT gateway — one source IP, many users.",
    seedFiles: {
      "package.json": JSON.stringify({ name: "payments-api-gateway", version: "2.3.0", main: "dist/index.js" }, null, 2),
      "src/gateway.js": "// request handler: auth check, then proxy to payments service\n",
    },
  },
  {
    caseId: "cap-schema-refactor",
    slug: "order-service-rename",
    mode: "low",
    question:
      "We need to rename the orders.status column values from open/pending/done to created/processing/completed across 3 services that read this column. Should we do a big-bang migration with a coordinated deploy, or a dual-write transition period with both vocabularies in the DB?",
    context:
      "One tiny wrinkle: a weekly reporting job in another team's repo also greps for 'done'. Deployment happens twice a week; rollback needs to be under 10 minutes.",
    seedFiles: {
      "schema.sql": "CREATE TABLE orders (id bigserial PRIMARY KEY, status text NOT NULL); -- values: open|pending|done\n",
    },
  },
  {
    caseId: "cap-zero-downtime-index",
    slug: "invoices-backfill",
    mode: "medium",
    question:
      "An invoices table with 120M rows needs a new NOT NULL column `currency_code` defaulting to 'USD', plus an index on it. Do we run CREATE INDEX CONCURRENTLY plus a batched backfill job, or take a maintenance window and do it in one ALTER TABLE?",
    context:
      "Managed Postgres (RDS), peak traffic 9am–7pm UTC, replication lag already near the alarm threshold. The migration must be resumable if it dies halfway.",
    seedFiles: {
      "README.md": "# invoices-backfill\n\nOne-off migration planning for the invoices table.\n",
    },
  },
  {
    caseId: "cap-procedure-holdout",
    slug: "release-checklist-tool",
    mode: "medium",
    question:
      "Releases from our monorepo keep missing steps: version bump, changelog, migration review, and smoke-run are all manual. Should we build a custom release CLI in-repo, adopt a semantic-release style bot, or write a plain checklist enforced by a required PR template?",
    context:
      "3 engineers do releases today; CI is GitHub Actions. We want the fix to require less human discipline, not more.",
    seedFiles: {
      "README.md": "# release-checklist-tool\n\nMake releases boring and complete.\n",
      "RELEASE.md": "# Release steps\n\n1. bump version\n2. update changelog\n3. get migration sign-off\n4. smoke-run staging\n",
    },
  },
]
