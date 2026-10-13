import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parse } from "yaml";

it("budgets Windows source packaging within the desktop job", () => {
  const workflow = parse(readFileSync(".github/workflows/linux-app.yml", "utf8"));
  const windows = workflow.jobs["test-windows-power"];
  const build = windows.steps.find(
    (step: { name: string }) => step.name === "Build Windows installer without publishing",
  );
  const packageMinutes = Number(build.env?.OPENCLAW_DOCKER_PACKAGE_BUILD_TIMEOUT_MS) / 60_000;

  expect(packageMinutes).toBeGreaterThanOrEqual(60);
  expect(windows["timeout-minutes"] - packageMinutes).toBeGreaterThanOrEqual(40);
  expect(workflow.env.OPENCLAW_DOCKER_PACKAGE_BUILD_TIMEOUT_MS).toBeUndefined();
  expect(JSON.stringify(workflow.jobs.build)).not.toContain(
    "OPENCLAW_DOCKER_PACKAGE_BUILD_TIMEOUT_MS",
  );
});
