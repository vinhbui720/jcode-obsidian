export interface DailyNoteTemplateOptions {
  date: string;
  created: string;
  notificationPlaceholder?: string;
  tasksGlobalFilter?: string;
}

export const DEFAULT_DAILY_NOTE_FOLDER = "Daily Note";
export const DEFAULT_DAILY_NOTE_DATE_FORMAT = "YYYY-MM-DD";

export function dailyNotePath(
  date: string,
  folder = DEFAULT_DAILY_NOTE_FOLDER,
) {
  const cleanFolder =
    folder.trim().replace(/^\/+|\/+$/g, "") || DEFAULT_DAILY_NOTE_FOLDER;
  return `${cleanFolder}/${date}.md`;
}

export function renderDailyNoteTemplate(opts: DailyNoteTemplateOptions) {
  const notification =
    opts.notificationPlaceholder?.trim() ||
    `### Calendar

_Jcode will fill today's personal/work/study calendar here._

### Mail

_Jcode will fill nearest important/unread personal/work/study mail here._`;
  const globalFilter = opts.tasksGlobalFilter?.trim();
  const filterLine = globalFilter ? `${globalFilter}\n` : "";

  return `---
tags:
  - daily-note
date: ${opts.date}
created: ${opts.created}
---

# ${opts.date}

## Notification

<!-- jcode-daily-notification:start -->
${notification}
<!-- jcode-daily-notification:end -->

## Task

### Overdue

\`\`\`tasks
${filterLine}not done
due before today
sort by due
sort by priority
\`\`\`

### Today

\`\`\`tasks
${filterLine}not done
due today
sort by priority
sort by due
\`\`\`

### Upcoming

\`\`\`tasks
${filterLine}not done
due after today
due before in 7 days
sort by due
sort by priority
\`\`\`

## Note
`;
}

export function replaceDailyNotification(content: string, replacement: string) {
  const start = "<!-- jcode-daily-notification:start -->";
  const end = "<!-- jcode-daily-notification:end -->";
  const cleanReplacement = replacement.trim() || "_No notification result._";
  const pattern = new RegExp(
    `${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`,
  );
  const block = `${start}\n${cleanReplacement}\n${end}`;
  if (pattern.test(content)) return content.replace(pattern, block);

  const heading = /^## Notification\s*$/m;
  if (heading.test(content)) {
    return content.replace(heading, `## Notification\n\n${block}`);
  }

  return `${content.trimEnd()}\n\n## Notification\n\n${block}\n`;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function formatDailyBriefingPrompt(date: string, notePath: string) {
  return `/gog-vinh update ${notePath} for ${date}. Replace only the jcode-daily-notification block. Keep exactly two subsections: ### Calendar with today's personal/work/study events sorted by time, and ### Mail with nearest important/unread personal/work/study mail. Do not print the full briefing. Do not modify mail/calendar. Do not commit.`;
}
