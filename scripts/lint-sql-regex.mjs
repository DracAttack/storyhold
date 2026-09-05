#!/usr/bin/env node
/**
 * lint-sql-regex.mjs
 *
 * Guards against the silent backslash-escape bug in Drizzle/pg `sql` tagged
 * template literals.  In a JavaScript template literal, a backslash followed
 * by a character that is not a recognised JS escape (like \s, \d, \w) silently
 * drops the backslash — "s+" rather than "\s+".  PostgreSQL then sees a bare
 * letter instead of a character-class shorthand.
 *
 * Rule: in the literal (non-interpolated) portions of `sql`…`` blocks, avoid
 * raw backslash-escape shorthands.  Use POSIX character classes instead:
 *   \s  →  [[:space:]]
 *   \d  →  [[:digit:]]
 *   \w  →  [[:alnum:]_]
 *   \S  →  [^[:space:]]
 *   \D  →  [^[:digit:]]
 *   \W  →  [^[:alnum:]_]
 *   \b  →  \y  (PG word-boundary)
 *   \n  →  a newline literal or chr(10)
 *   \t  →  a tab literal or chr(9)
 *
 * Double-backslash sequences (\\s, \\d, …) are fine — the double-backslash
 * is a legitimate JS escape that produces a single \s/\d/… in the string
 * value, which PostgreSQL's ARE engine understands.
 *
 * Content inside ${…} interpolations is JavaScript, not SQL text, so it is
 * excluded from the check.
 *
 * Usage:
 *   node scripts/lint-sql-regex.mjs [dir]
 *
 * Exits 0 when clean, 1 when violations are found.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const TARGET_DIR = process.argv[2] ?? "artifacts/api-server/src";

// Map of (source-level single-backslash char) → POSIX suggestion.
// Keys are one-character strings (the letter after the \).
const BAD_AFTER_SLASH = new Map([
  ["s", "[[:space:]]"],
  ["S", "[^[:space:]]"],
  ["d", "[[:digit:]]"],
  ["D", "[^[:digit:]]"],
  ["w", "[[:alnum:]_]"],
  ["W", "[^[:alnum:]_]"],
  ["b", "\\\\y (PG word boundary)"],
  ["B", "\\\\Y (PG non-word boundary)"],
  ["n", "a newline literal or chr(10)"],
  ["t", "a tab literal or chr(9)"],
]);

async function findTs(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await findTs(full)));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts"))
      out.push(full);
  }
  return out;
}

/**
 * Scan `src` and emit violation objects for every bad backslash-escape that
 * appears in the literal (non-interpolated) text of a sql`` tagged template.
 *
 * Algorithm — one linear pass over the source with a small state machine:
 *
 *   mode = NORMAL | IN_SQL_TEMPLATE | IN_INTERPOLATION
 *
 * In IN_SQL_TEMPLATE mode we examine each character for bad escapes.
 * ${ pushes us into IN_INTERPOLATION (brace depth tracked); } at depth 0
 * returns us to IN_SQL_TEMPLATE.
 * A bare backtick at depth 0 ends the template.
 *
 * Double-backslash handling: when we see `\` and the PREVIOUS non-`\`
 * character was also `\`, the pair is a JS `\\` escape (→ single `\` in
 * string), so the current `\` is already consumed as part of the pair and
 * the next character is NOT a regex escape.
 *
 * @param {string} src   Raw source of a TypeScript file.
 * @param {string} file  File path, used only in violation objects.
 */
function scanFile(src, file) {
  const violations = [];
  let i = 0;
  let lineNo = 1;
  let lineStart = 0; // char offset of the start of the current line

  // Helper: current column (1-based).
  const col = () => i - lineStart + 1;

  // Advance i, keeping lineNo and lineStart in sync.
  function advance() {
    if (src[i] === "\n") {
      lineNo++;
      lineStart = i + 1;
    }
    i++;
  }

  while (i < src.length) {
    // ── NORMAL mode: scan for sql` ──────────────────────────────────────────
    // Look for the literal text "sql`".  Require the char before "sql" to NOT
    // be an identifier character (so "mysql`" doesn't match).
    if (
      src[i] === "s" &&
      src.slice(i, i + 4) === "sql`" &&
      (i === 0 || !/[a-zA-Z0-9_$]/.test(src[i - 1]))
    ) {
      // Skip "sql`" (4 chars)
      for (let k = 0; k < 4; k++) advance();

      // ── IN_SQL_TEMPLATE mode ─────────────────────────────────────────────
      let braceDepth = 0;
      // Track whether the immediately preceding character (in the literal
      // portion) was a backslash that was ITSELF the second half of a \\
      // escape pair.  We use a simple "previous char was a backslash"
      // counter: consecutive backslashes toggle whether the CURRENT one is
      // escaped.
      let consecutiveBackslashes = 0;

      while (i < src.length) {
        const ch = src[i];

        if (braceDepth > 0) {
          // ── IN_INTERPOLATION: just track braces and skip ─────────────────
          // We do NOT want to descend into nested template literals here
          // (they are JS code, not SQL).  Track brace depth only.
          if (ch === "{") braceDepth++;
          else if (ch === "}") {
            braceDepth--;
            if (braceDepth === 0) {
              consecutiveBackslashes = 0; // reset on re-entry to SQL text
            }
          }
          advance();
          continue;
        }

        // braceDepth === 0 → we are in the literal text of the sql template.

        if (ch === "`") {
          // End of the sql`` template.
          advance();
          break;
        }

        if (ch === "$" && i + 1 < src.length && src[i + 1] === "{") {
          // Start of interpolation.
          advance(); // $
          advance(); // {
          braceDepth = 1;
          consecutiveBackslashes = 0;
          continue;
        }

        if (ch === "\\") {
          const nextCh = src[i + 1];
          consecutiveBackslashes++;

          if (consecutiveBackslashes % 2 === 0) {
            // Even count: this backslash is the second of a \\ pair.
            // The pair is a JS \\-escape; the next character is a normal SQL
            // char, not a regex shorthand produced by a JS escape.
            advance();
            continue;
          }

          // Odd count: this is a lone \ that WILL silently drop in the string.
          // Check if the following character is a problematic regex shorthand.
          if (nextCh !== undefined) {
            const suggestion = BAD_AFTER_SLASH.get(nextCh);
            if (suggestion !== undefined) {
              const violationLine = lineNo;
              const violationCol = col();
              violations.push({
                file,
                line: violationLine,
                col: violationCol,
                escape: `\\${nextCh}`,
                fix: suggestion,
              });
            }
          }

          advance();
          continue;
        }

        // Any other character resets the consecutive-backslash counter.
        consecutiveBackslashes = 0;
        advance();
      }
      // End of sql`` template; continue in NORMAL mode.
      continue;
    }

    advance();
  }

  return violations;
}

async function main() {
  const files = await findTs(TARGET_DIR);
  let totalViolations = 0;

  for (const file of files) {
    const src = await readFile(file, "utf8");
    if (!src.includes("sql`")) continue;

    const fileViolations = scanFile(src, file);

    if (fileViolations.length > 0) {
      totalViolations += fileViolations.length;
      const rel = path.relative(process.cwd(), file);
      for (const v of fileViolations) {
        console.error(
          `${rel}:${v.line}:${v.col}: ` +
            `SQL regex shorthand '${v.escape}' in literal sql\`\` text — ` +
            `use ${v.fix} (POSIX class) instead; ` +
            `JS template literals silently drop this backslash before PostgreSQL sees it`
        );
      }
    }
  }

  if (totalViolations === 0) {
    console.log(
      `lint-sql-regex: OK — no bare backslash-escape shorthand found in sql\`\` ` +
        `template literals (${files.length} files scanned)`
    );
    process.exit(0);
  } else {
    console.error(`\nlint-sql-regex: ${totalViolations} violation(s) found.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("lint-sql-regex: fatal error:", err);
  process.exit(2);
});
