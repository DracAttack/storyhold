/** Operator-only CSV: excludes prompts, player IDs and request IDs. */
export function providerCostCsv(rows: readonly Record<string, unknown>[]): string {
  const quote = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const spreadsheetText = (value: unknown) => {
    const text = String(value ?? "");
    // CSV quoting alone does not stop spreadsheet formulas. Guard formula
    // prefixes even after whitespace/control characters, including tabs.
    return /^[\s\u0000-\u001f]*[=+\-@]/u.test(text) || /^[\t\r\n]/u.test(text)
      ? `'${text}` : text;
  };
  const usd = (value: unknown) => {
    // PostgreSQL BIGINT aggregates arrive as strings. Retain every microdollar
    // instead of converting through floating-point arithmetic.
    const micros = BigInt(String(value ?? 0));
    const magnitude = micros < 0n ? -micros : micros;
    return `${micros < 0n ? "-" : ""}${magnitude / 1_000_000n}.${String(magnitude % 1_000_000n).padStart(6, "0")}`;
  };
  return [
    ["Provider", "Model", "Completed Cost (USD)", "Billable Failure Cost (USD)",
      "Completed Requests", "Billable Failure Requests", "Total Requests", "Total Cost (USD)"],
    ...rows.map((row) => [spreadsheetText(row.provider), spreadsheetText(row.model),
      usd(row.completed_cost_micros), usd(row.failed_cost_micros),
      row.completed_requests, row.failed_requests, row.requests, usd(row.cost_micros)]),
  ].map((row) => row.map(quote).join(",")).join("\r\n") + "\r\n";
}
