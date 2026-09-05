import {
  STORYHOLD_SCENARIOS,
  auditStoryholdScenarioCatalog,
} from "../artifacts/site/src/lib/storyholdScenarios";

const issues = auditStoryholdScenarioCatalog();

if (issues.length > 0) {
  console.error(issues.join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `Storyhold scenario catalog passed: ${STORYHOLD_SCENARIOS.length} structurally valid openings.`,
  );
}
