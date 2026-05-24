/**
 * Tests for Obsidian Tasks dashboard query generation.
 * Run: npx tsx tests/obsidian-tasks.smoke.ts
 */
import {
  normalizeTasksGlobalFilter,
  renderTasksDashboard,
} from "../src/obsidian-tasks";

let failures = 0;
function truthy(v: unknown, label: string) {
  if (!v) {
    failures++;
    console.error(`FAIL ${label}: value was falsy`);
  } else {
    console.log(`PASS ${label}`);
  }
}
function eq<T>(a: T, b: T, label: string) {
  if (a !== b) {
    failures++;
    console.error(
      `FAIL ${label}\n  expected: ${String(b)}\n  actual:   ${String(a)}`,
    );
  } else {
    console.log(`PASS ${label}`);
  }
}

function testNormalize() {
  eq(
    normalizeTasksGlobalFilter(" #task "),
    "#task",
    "global filter trims whitespace",
  );
  eq(
    normalizeTasksGlobalFilter(undefined),
    "",
    "undefined global filter becomes empty",
  );
}

function testDashboardWithoutFilter() {
  const md = renderTasksDashboard();
  truthy(md.includes("```tasks"), "dashboard includes Tasks code blocks");
  truthy(md.includes("due today"), "dashboard includes due today query");
  truthy(md.includes("due before today"), "dashboard includes overdue query");
  truthy(md.includes("no due date"), "dashboard includes no due date query");
  truthy(
    !md.includes("#task\nnot done"),
    "dashboard omits global filter when blank",
  );
}

function testDashboardWithFilter() {
  const md = renderTasksDashboard({ globalFilter: "#task" });
  truthy(md.includes("`#task`"), "dashboard explains global filter");
  truthy(
    md.includes("#task\nnot done\ndue today"),
    "dashboard prefixes due today query with global filter",
  );
  truthy(
    md.includes("#task\nnot done\nis recurring"),
    "dashboard prefixes recurring query with global filter",
  );
}

testNormalize();
testDashboardWithoutFilter();
testDashboardWithFilter();

if (failures > 0) {
  console.error(`\n${failures} TEST(S) FAILED`);
  process.exit(1);
}
console.log("\nAll obsidian-tasks tests passed.");
