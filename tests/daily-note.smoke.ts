import assert from "node:assert/strict";
import {
  dailyNotePath,
  formatDailyBriefingPrompt,
  renderDailyNoteTemplate,
  replaceDailyNotification,
} from "../src/daily-note";

console.log("Daily note smoke tests");

assert.equal(dailyNotePath("2026-05-24"), "Daily Note/2026-05-24.md");
assert.equal(dailyNotePath("2026-05-24", "/Daily Note/"), "Daily Note/2026-05-24.md");

const note = renderDailyNoteTemplate({
  date: "2026-05-24",
  created: "2026-05-24T20:03:00+07:00",
  tasksGlobalFilter: "#task",
});

assert.match(note, /tags:\n  - daily-note/);
assert.match(note, /date: 2026-05-24/);
assert.match(note, /## Notification/);
assert.match(note, /## Task/);
assert.match(note, /### Overdue/);
assert.match(note, /due before today/);
assert.match(note, /### Today/);
assert.match(note, /due today/);
assert.match(note, /### Upcoming/);
assert.match(note, /due before in 7 days/);
assert.match(note, /## Note/);
assert.match(note, /```tasks\n#task\nnot done/);

const filled = replaceDailyNotification(note, "### Calendar\n- 09:00 Standup");
assert.match(filled, /<!-- jcode-daily-notification:start -->\n### Calendar\n- 09:00 Standup\n<!-- jcode-daily-notification:end -->/);
assert.equal((filled.match(/### Calendar/g) ?? []).length, 1);

const prompt = formatDailyBriefingPrompt("2026-05-24", "Daily Note/2026-05-24.md");
assert.match(prompt, /\/gog-vinh/);
assert.match(prompt, /Daily Note\/2026-05-24\.md/);
assert.match(prompt, /personal, work, and study/);
assert.match(prompt, /Do not print the full briefing as your final answer/);
assert.match(prompt, /Do not commit git changes/);
assert.match(prompt, /Do not send, delete, archive, or modify any email\/calendar item/);

console.log("PASS daily-note");
