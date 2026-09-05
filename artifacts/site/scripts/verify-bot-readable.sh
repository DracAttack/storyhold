#!/usr/bin/env bash
#
# Verify that the production site server returns bot-readable HTML — i.e. that
# the homepage, a category page, and an article page each contain meaningful
# VISIBLE content (article links, headings, body text) in the raw HTML, not just
# the empty React shell. This exercises the additive #root prerender that the
# prod Express server (server/index.ts) injects for crawlers / non-JS clients.
#
# Also verifies DefinedTerm JSON-LD blocks:
#   - Articles with concept annotations emit ≥1 DefinedTerm node inside the
#     single #seo-jsonld @graph array
#   - Each DefinedTerm is valid schema.org JSON with all required fields
#   - Nodes are deduplicated (each concept URL / glossary slug appears once)
#   - Articles with zero concept annotations have no DefinedTerm nodes in the graph
#
# Usage:
#   # Against the live site:
#   ./scripts/verify-bot-readable.sh
#
#   # Against a locally-built prod server:
#   #   1. NODE_ENV=production PORT=21238 BASE_PATH=/ pnpm --filter @workspace/site run build
#   #   2. PORT=21999 SEO_API_ORIGIN=http://localhost:80 node artifacts/site/dist/index.mjs &
#   #   3. BASE=http://localhost:21999 ./scripts/verify-bot-readable.sh
#
# Env:
#   BASE      Site origin to probe (default https://brainhook.net)
#   API_BASE  API origin used only to auto-discover a real category/article
#             slug (default: $BASE). Override when the API isn't on $BASE.
#   SLUG      Article slug to test (default: auto-discovered from the API)
#   CATEGORY  Category slug to test (default: auto-discovered from the API)
#
# Automated equivalent:
#   GET /api/healthz-seo?token=<CRON_TICK_TOKEN> on the API server runs the core
#   checks from this script programmatically and returns 200/503 JSON so
#   UptimeRobot (or any HTTP monitor) can alert on regressions after each prod
#   deploy. Configure a "keyword" monitor pointing at that URL with keyword "ok"
#   and attach Slack/email contacts. See artifacts/api-server/src/routes/healthz-seo.ts.

set -uo pipefail

BASE="${BASE:-https://brainhook.net}"
API_BASE="${API_BASE:-$BASE}"

fail=0
pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=1; }
skip() { printf '  \033[33mSKIP\033[0m %s\n' "$1"; }

# Assert the HTML in $1 contains the fixed string $2; label it $3.
check() {
  if printf '%s' "$1" | grep -qF -- "$2"; then pass "$3"; else bad "$3 (missing: $2)"; fi
}

# Run a Python3 validation helper.  HTML is passed via a temp file so the
# heredoc (<<'PYEOF') can supply the Python script via stdin without
# conflicting with the piped HTML payload — if we piped HTML directly into
# python3 while also providing a heredoc script, bash would connect the
# heredoc to stdin and the pipe would be silently discarded.
#
# Usage: run_py <html_var_name> <<'PYEOF'
#          ... python code that does: with open(sys.argv[1]) as f: html = f.read()
#        PYEOF
# Returns: stdout of the Python script.
_PY_TMPFILE=""
run_py() {
  local html="$1"
  _PY_TMPFILE="$(mktemp)"
  printf '%s' "$html" > "$_PY_TMPFILE"
  # Read Python script from heredoc (stdin); HTML file path is sys.argv[1].
  python3 - "$_PY_TMPFILE"
  local rc=$?
  rm -f "$_PY_TMPFILE"
  _PY_TMPFILE=""
  return $rc
}

# Auto-discover a real category + article slug when not supplied.
if [[ -z "${CATEGORY:-}" ]]; then
  CATEGORY="$(curl -fsS "$API_BASE/api/public/beats" 2>/dev/null \
    | grep -o '"slug":"[^"]*"' | head -1 | sed 's/.*"slug":"//;s/"//')"
fi
if [[ -z "${SLUG:-}" ]]; then
  SLUG="$(curl -fsS "$API_BASE/api/public/articles?limit=1" 2>/dev/null \
    | grep -o '"slug":"[^"]*"' | head -1 | sed 's/.*"slug":"//;s/"//')"
fi
if [[ -z "${AUTHOR:-}" ]]; then
  AUTHOR="$(curl -fsS "$API_BASE/api/public/authors" 2>/dev/null \
    | grep -o '"slug":"[^"]*"' | head -1 | sed 's/.*"slug":"//;s/"//')"
fi

echo "Probing $BASE (category=${CATEGORY:-?}, article=${SLUG:-?}, author=${AUTHOR:-?})"

echo "[ / ]"
HOME_HTML="$(curl -fsSL "$BASE/" 2>/dev/null)"
check "$HOME_HTML" 'href="/article/' "homepage has real article links"
check "$HOME_HTML" 'More stories' "homepage has 'More stories' heading"
check "$HOME_HTML" 'Brilliant ideas, delivered weekly' "homepage has newsletter block"
# Server-rendered global chrome (header + footer) so crawlers see the nav and can
# discover every category + the company/policy pages, not just the page body.
check "$HOME_HTML" "href=\"/category/$CATEGORY\"" "homepage footer links the category"
check "$HOME_HTML" 'href="/privacy"' "homepage footer has company/policy links"
check "$HOME_HTML" '<footer' "homepage has a server-rendered footer"

echo "[ /category/$CATEGORY ]"
CAT_HTML="$(curl -fsSL "$BASE/category/$CATEGORY" 2>/dev/null)"
check "$CAT_HTML" 'href="/article/' "category page has real article links"
check "$CAT_HTML" '<time' "category cards show a published date"
check "$CAT_HTML" 'min</span>' "category cards show reading time"

echo "[ /article/$SLUG ]"
ART_HTML="$(curl -fsSL "$BASE/article/$SLUG" 2>/dev/null)"
check "$ART_HTML" 'application/ld+json' "article emits Article JSON-LD"
check "$ART_HTML" 'More like this' "article has related-articles section"
check "$ART_HTML" 'href="/article/' "article has internal article links"
check "$ART_HTML" 'href="/author/' "article byline links to the author page"

if [[ -n "${AUTHOR:-}" ]]; then
  echo "[ /author/$AUTHOR ]"
  AUTHOR_HTML="$(curl -fsSL "$BASE/author/$AUTHOR" 2>/dev/null)"
  check "$AUTHOR_HTML" 'All stories by' "author page has its heading"
  check "$AUTHOR_HTML" 'href="/article/' "author page lists real article links"
fi

# ── Glossary page checks ─────────────────────────────────────────────────────
# Verify that /glossary renders a crawlable concept list and that /glossary/:slug
# returns valid DefinedTerm JSON-LD with all required schema.org fields.
echo ""

# Auto-discover a real concept slug from the API.
CONCEPT_PAGE_SLUG="$(curl -fsS "$API_BASE/api/public/concepts?limit=1" 2>/dev/null \
  | python3 -c "
import sys, json
try:
  d = json.load(sys.stdin)
  cs = d.get('concepts') or []
  print(cs[0]['slug'] if cs else '')
except Exception:
  print('')
" 2>/dev/null || echo "")"

if [[ -z "${CONCEPT_PAGE_SLUG:-}" ]]; then
  echo "[ /glossary ]"
  skip "glossary checks — no live concepts in DB yet (run the concept backfill first)"
  echo "[ /glossary/:slug ]"
  skip "glossary detail checks — no live concepts in DB yet"
else
  echo "[ /glossary ]"
  GLOSSARY_HTML="$(curl -fsSL "$BASE/glossary" 2>/dev/null)"
  check "$GLOSSARY_HTML" 'href="/glossary/' "glossary index has crawlable concept links"
  check "$GLOSSARY_HTML" 'Glossary' "glossary index has a heading"

  echo "[ /glossary/$CONCEPT_PAGE_SLUG ]"
  GDETAIL_HTML="$(curl -fsSL "$BASE/glossary/$CONCEPT_PAGE_SLUG" 2>/dev/null)"
  # Basic non-empty render check.
  check "$GDETAIL_HTML" 'application/ld+json' "glossary detail page emits JSON-LD"
  check "$GDETAIL_HTML" 'href="/glossary"' "glossary detail page links back to index"

  # Full DefinedTerm field validation via Python.
  GTERM_VALIDATION="$(run_py "$GDETAIL_HTML" <<'PYEOF'
import sys, re, json

with open(sys.argv[1]) as f:
    html = f.read()

# Find ANY ld+json block (glossary detail uses a single primary jsonLd block,
# not the seo-jsonld-term-N pattern used for article concept annotations).
blocks = re.findall(
    r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
    html, re.DOTALL
)

found = None
for raw in blocks:
    try:
        d = json.loads(raw.replace('\\u003c', '<'))
        if d.get('@type') == 'DefinedTerm':
            found = d
            break
    except Exception:
        pass

if found is None:
    print("MISSING_DEFINED_TERM_BLOCK")
    sys.exit(0)

errors = []
if found.get("@context") != "https://schema.org":
    errors.append(f"@context={found.get('@context')!r}, want 'https://schema.org'")
if not found.get("name"):
    errors.append("name is missing or empty")
if not found.get("description"):
    errors.append("description is missing or empty")
url = found.get("url", "")
if not url or "/glossary/" not in url:
    errors.append(f"url={url!r} does not contain /glossary/")
its = found.get("inDefinedTermSet")
if not isinstance(its, dict):
    errors.append("inDefinedTermSet is missing or not an object")
else:
    if its.get("@type") != "DefinedTermSet":
        errors.append(f"inDefinedTermSet.@type={its.get('@type')!r}, want 'DefinedTermSet'")
    if its.get("name") != "BrainHook Glossary":
        errors.append(f"inDefinedTermSet.name={its.get('name')!r}, want 'BrainHook Glossary'")
    its_url = its.get("url", "")
    if not its_url or "/glossary" not in its_url:
        errors.append(f"inDefinedTermSet.url={its_url!r} does not contain /glossary")

if errors:
    print("ERRORS: " + "; ".join(errors))
else:
    print("OK")
PYEOF
)"

  if [[ "$GTERM_VALIDATION" == "OK" ]]; then
    pass "glossary detail DefinedTerm JSON-LD passes schema.org field validation (@context, @type, name, description, url, inDefinedTermSet)"
  elif [[ "$GTERM_VALIDATION" == "MISSING_DEFINED_TERM_BLOCK" ]]; then
    bad "glossary detail page ($CONCEPT_PAGE_SLUG) did not emit a DefinedTerm JSON-LD block"
  else
    bad "glossary detail DefinedTerm field validation: $GTERM_VALIDATION"
  fi
fi

# ── DefinedTerm JSON-LD checks ──────────────────────────────────────────────
# Verify that concept-annotated articles include DefinedTerm nodes inside the
# single #seo-jsonld @graph array. Each node must pass schema.org DefinedTerm
# field validation. Articles with zero concept annotations must have no
# DefinedTerm nodes in the graph.
echo ""
echo "[ DefinedTerm JSON-LD ]"

# Step 1: check whether any live concepts exist in the system at all.
TOTAL_CONCEPTS="$(curl -fsS "$API_BASE/api/public/concepts?limit=1" 2>/dev/null \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('total',0))" 2>/dev/null \
  || echo 0)"

if [[ "${TOTAL_CONCEPTS:-0}" -eq 0 ]]; then
  skip "DefinedTerm checks — no live concepts in DB yet (run the concept backfill first)"
else
  # Step 2: scan up to 20 recent published articles to find one with concept
  # annotations. The backfill is incremental so not every article may be annotated.
  ARTICLE_SLUGS_LIST="$(curl -fsS "$API_BASE/api/public/articles?limit=20" 2>/dev/null \
    | grep -o '"slug":"[^"]*"' | sed 's/.*"slug":"//;s/"//')"

  CONCEPT_SLUG=""
  while IFS= read -r s && [[ -z "$CONCEPT_SLUG" ]]; do
    [[ -z "$s" ]] && continue
    HAS_C="$(curl -fsS "$API_BASE/api/public/articles/${s}/concepts" 2>/dev/null \
      | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if d.get('concepts') else 'no')" \
      2>/dev/null || echo no)"
    if [[ "$HAS_C" == "yes" ]]; then
      CONCEPT_SLUG="$s"
    fi
  done <<< "$ARTICLE_SLUGS_LIST"

  if [[ -z "$CONCEPT_SLUG" ]]; then
    skip "DefinedTerm checks — ${TOTAL_CONCEPTS} concept(s) exist but none annotate the 20 most-recent articles yet"
  else
    printf '  Concept-annotated article: %s\n' "$CONCEPT_SLUG"
    CTERM_HTML="$(curl -fsSL "$BASE/article/$CONCEPT_SLUG" 2>/dev/null)"

    # 3a. Single #seo-jsonld script must contain a @graph with ≥1 DefinedTerm.
    TERM_VALIDATION="$(run_py "$CTERM_HTML" <<'PYEOF'
import sys, re, json

with open(sys.argv[1]) as f:
    html = f.read()

# Extract the single #seo-jsonld script (now holds a @graph array).
m = re.search(r'<script[^>]*id="seo-jsonld"[^>]*>(.*?)</script>', html, re.DOTALL)
if not m:
    print("MISSING_BLOCK")
    sys.exit(0)

raw = m.group(1).replace('\\u003c', '<')
try:
    data = json.loads(raw)
except Exception as e:
    print(f"JSON_PARSE_ERROR: {e}")
    sys.exit(0)

graph = data.get("@graph", []) if isinstance(data.get("@graph"), list) else []
terms = [n for n in graph if n.get("@type") == "DefinedTerm"]
if not terms:
    print("MISSING_TERM")
    sys.exit(0)

errors = []
for term in terms:
    if term.get("@context") != "https://schema.org":
        errors.append(f"@context={term.get('@context')!r}, want 'https://schema.org'")
    if not term.get("name"):
        errors.append("name is missing or empty")
    if not term.get("description"):
        errors.append("description is missing or empty")
    url = term.get("url", "")
    if not url or "/glossary/" not in url:
        errors.append(f"url={url!r} does not contain /glossary/")
    its = term.get("inDefinedTermSet")
    if not isinstance(its, dict):
        errors.append("inDefinedTermSet is missing or not an object")
    else:
        if its.get("@type") != "DefinedTermSet":
            errors.append(f"inDefinedTermSet.@type={its.get('@type')!r}, want 'DefinedTermSet'")
        if its.get("name") != "BrainHook Glossary":
            errors.append(f"inDefinedTermSet.name={its.get('name')!r}, want 'BrainHook Glossary'")
        its_url = its.get("url", "")
        if not its_url or "/glossary" not in its_url:
            errors.append(f"inDefinedTermSet.url={its_url!r} does not contain /glossary")

if errors:
    print("ERRORS: " + "; ".join(errors))
else:
    print(f"OK ({len(terms)} term(s) in @graph)")
PYEOF
)"

    if [[ "$TERM_VALIDATION" == OK* ]]; then
      pass "DefinedTerm nodes in @graph pass schema.org validation — $TERM_VALIDATION"
    elif [[ "$TERM_VALIDATION" == "MISSING_BLOCK" ]]; then
      bad "#seo-jsonld script not found in article HTML"
    elif [[ "$TERM_VALIDATION" == "MISSING_TERM" ]]; then
      bad "#seo-jsonld @graph contains no DefinedTerm nodes"
    else
      bad "DefinedTerm field validation: $TERM_VALIDATION"
    fi

    # 3c. Deduplication guard — each concept's glossary URL must appear exactly
    # once across all DefinedTerm nodes in the @graph.
    DUP_CHECK="$(run_py "$CTERM_HTML" <<'PYEOF'
import sys, re, json

with open(sys.argv[1]) as f:
    html = f.read()

m = re.search(r'<script[^>]*id="seo-jsonld"[^>]*>(.*?)</script>', html, re.DOTALL)
if not m:
    print("MISSING_BLOCK")
    sys.exit(0)

try:
    data = json.loads(m.group(1).replace('\\u003c', '<'))
    graph = data.get("@graph", []) if isinstance(data.get("@graph"), list) else []
    terms = [n for n in graph if n.get("@type") == "DefinedTerm"]
except Exception:
    print("PARSE_ERROR")
    sys.exit(0)

urls = [t.get("url", "") for t in terms]
dupes = [u for u in urls if urls.count(u) > 1]
if dupes:
    print(f"DUPLICATE_URLS: {list(set(dupes))}")
else:
    print(f"OK ({len(urls)} DefinedTerm node(s), all unique)")
PYEOF
)"

    if [[ "$DUP_CHECK" == OK* ]]; then
      pass "DefinedTerm nodes are deduplicated — $DUP_CHECK"
    else
      bad "DefinedTerm deduplication failed: $DUP_CHECK"
    fi

    # Step 4: zero-concept regression guard.
    # Use the SLUG auto-discovered at the top of the script (most-recent article).
    # If that article also has concepts (possible after a full backfill), skip.
    if [[ -n "${SLUG:-}" ]] && [[ "$SLUG" != "$CONCEPT_SLUG" ]]; then
      ZERO_HAS_C="$(curl -fsS "$API_BASE/api/public/articles/${SLUG}/concepts" 2>/dev/null \
        | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if d.get('concepts') else 'no')" \
        2>/dev/null || echo unknown)"
      if [[ "$ZERO_HAS_C" == "no" ]]; then
        # Zero-concept article: its @graph must contain no DefinedTerm nodes.
        ZERO_CHECK="$(run_py "$ART_HTML" <<'PYEOF'
import sys, re, json

with open(sys.argv[1]) as f:
    html = f.read()

m = re.search(r'<script[^>]*id="seo-jsonld"[^>]*>(.*?)</script>', html, re.DOTALL)
if not m:
    print("MISSING_BLOCK")
    sys.exit(0)

try:
    data = json.loads(m.group(1).replace('\\u003c', '<'))
    graph = data.get("@graph", []) if isinstance(data.get("@graph"), list) else []
    terms = [n for n in graph if n.get("@type") == "DefinedTerm"]
    if terms:
        print(f"UNEXPECTED_TERMS: {len(terms)} DefinedTerm node(s) found")
    else:
        print("OK (no DefinedTerm nodes)")
except Exception as e:
    print(f"PARSE_ERROR: {e}")
PYEOF
)"
        if [[ "$ZERO_CHECK" == OK* ]]; then
          pass "zero-concept article ($SLUG) has no DefinedTerm nodes in @graph"
        else
          bad "zero-concept article ($SLUG) $ZERO_CHECK"
        fi
      else
        skip "zero-concept regression — article $SLUG also has concept annotations; all recent articles may be annotated"
      fi
    fi
  fi
fi

if [[ "$fail" -eq 0 ]]; then
  printf '\n\033[32mAll bot-readable checks passed.\033[0m\n'
else
  printf '\n\033[31mSome checks failed — the page may be serving the bare React shell.\033[0m\n'
fi
exit "$fail"
