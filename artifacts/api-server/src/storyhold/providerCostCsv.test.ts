import assert from "node:assert/strict";
import test from "node:test";
import { providerCostCsv } from "./providerCostCsv";

const row = {
  provider: "openrouter", model: "sample-model", completed_cost_micros: "1234567",
  failed_cost_micros: "73000", completed_requests: 3, failed_requests: 1,
  requests: 4, cost_micros: "1307567",
};

test("provider CSV has exact microdollar costs and separate completed/failure request counts", () => {
  assert.equal(providerCostCsv([row]),
    '"Provider","Model","Completed Cost (USD)","Billable Failure Cost (USD)","Completed Requests","Billable Failure Requests","Total Requests","Total Cost (USD)"\r\n'
    + '"openrouter","sample-model","1.234567","0.073000","3","1","4","1.307567"\r\n');
  assert.ok(providerCostCsv([{ ...row, cost_micros: "9007199254740993" }]).includes('"9007199254.740993"'));
  assert.equal(providerCostCsv([]).split("\r\n").length, 2, "empty exports retain column headings");
});

test("provider CSV quotes separators, quotes, Unicode and line breaks without creating spreadsheet formulas", () => {
  const csv = providerCostCsv([{ ...row, provider: 'provider,"quoted"', model: "模型\nversion" }]);
  assert.ok(csv.includes('"provider,""quoted""","模型\nversion"'));
  for (const value of ["=1+1", "+SUM(A1)", "-1+1", "@SUM(A1)", " \t=1+1", "\tformula", "\rformula", "\nformula"]) {
    const output = providerCostCsv([{ ...row, provider: value, model: value }]);
    assert.ok(output.includes(`"'${value}","'${value}"`), `unsafe spreadsheet value: ${JSON.stringify(value)}`);
  }
  assert.doesNotMatch(csv, /player_id|request_id|prompt/u);
});
