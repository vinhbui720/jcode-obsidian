export interface TasksDashboardOptions {
  globalFilter?: string;
}

export const DEFAULT_TASKS_DASHBOARD_PATH = "Tasks Dashboard.md";

export function normalizeTasksGlobalFilter(value: string | undefined): string {
  return (value ?? "").trim();
}

export function renderTasksDashboard(opts: TasksDashboardOptions = {}): string {
  const globalFilter = normalizeTasksGlobalFilter(opts.globalFilter);
  const filterLine = globalFilter ? `${globalFilter}\n` : "";
  const filterNote = globalFilter
    ? `\n> This dashboard only shows tasks matching \`${globalFilter}\`, because the jcode Tasks global filter setting is enabled.\n`
    : "";

  return `# Tasks Dashboard
${filterNote}
Use regular Markdown tasks anywhere in your vault, then view them here with the Obsidian Tasks plugin.

Examples:

\`\`\`md
- [ ] Submit assignment ⏫ 📅 2026-05-30
- [ ] Review flashcards 🔁 every day 📅 2026-05-24
- [ ] Start essay ⏳ 2026-05-25
\`\`\`

## Due today

\`\`\`tasks
${filterLine}not done
due today
sort by priority
sort by due
\`\`\`

## Overdue

\`\`\`tasks
${filterLine}not done
due before today
sort by due
\`\`\`

## Upcoming, next 14 days

\`\`\`tasks
${filterLine}not done
due after today
due before in 14 days
sort by due
sort by priority
\`\`\`

## No due date

\`\`\`tasks
${filterLine}not done
no due date
group by filename
sort by description
\`\`\`

## High priority

\`\`\`tasks
${filterLine}not done
priority is high
sort by due
\`\`\`

## Recurring

\`\`\`tasks
${filterLine}not done
is recurring
sort by due
\`\`\`
`;
}
