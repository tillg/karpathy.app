// Menu bar and header-block styles for the interactive feature report (specs/research/features), which is not
// built by md2html; the other reports get their menu bar from reports.json. It loads this file with
// <script src="../../reports-nav.js" defer></script>. To add a report, add a line to REPORTS
// and that script tag to the report's <head>.
const REPORTS = [
  ['research/features/feature-report.html', 'Features'],
  ['research/browser-only/browser-only-report.html', 'Browser-only'],
  ['changes/v1/v1-plan.html', 'V1 plan'],
  ['research/prod-env/prod-env-report.html', 'Prod environment'],
  ['changes/voice_interaction/voice-interaction-report.html', 'Voice'],
];

const base = document.currentScript.src;
const style = document.createElement('style');
style.textContent = `
.reports-nav { display: flex; align-items: center; gap: 4px;
  padding: 8px 16px; overflow-x: auto; white-space: nowrap; scrollbar-width: none;
  background: var(--card, var(--surface, Canvas)); border-bottom: 1px solid var(--line, var(--border, rgba(127,127,127,.25)));
  font: 500 14px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif; }
.reports-nav::-webkit-scrollbar { display: none; }
.reports-nav .brand { display: flex; align-items: center; gap: 8px; margin-right: 8px; color: var(--muted, GrayText); }
.reports-nav .brand img { width: 20px; height: 20px; border-radius: 5px; }
.reports-nav a.item { padding: 6px 12px; border-radius: 999px; color: var(--fg, var(--text, CanvasText)); text-decoration: none; }
.reports-nav a.item:hover { background: rgba(127,127,127,.12); }
.reports-nav a.item[aria-current="page"] { background: var(--accent, #1f5bd6); color: #fff; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .reports-nav a.item[aria-current="page"] { color: #111; } }
:root[data-theme="dark"] .reports-nav a.item[aria-current="page"] { color: #111; }

.report-meta { display: flex; flex-wrap: wrap; gap: 8px 24px; margin: 4px 0 16px; padding: 0; font-size: .88rem; }
.report-meta div { display: flex; align-items: baseline; gap: 6px; }
.report-meta dt { color: var(--muted, GrayText); }
.report-meta dd { margin: 0; font-weight: 600; font-variant-numeric: tabular-nums; }
.report-status { display: inline-block; padding: 1px 10px; border-radius: 999px; font-size: .8rem; font-weight: 600; }
.report-status.research { color: #1f5bd6; background: rgba(31,91,214,.12); }
.report-status.ongoing { color: #8a5a00; background: rgba(240,160,0,.18); }
.report-status.implemented { color: #1e7b3a; background: rgba(30,123,58,.13); }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .report-status.research { color: #8ab4ff; }
  :root:not([data-theme="light"]) .report-status.ongoing { color: #f0c36a; } :root:not([data-theme="light"]) .report-status.implemented { color: #7fd49a; } }
:root[data-theme="dark"] .report-status.research { color: #8ab4ff; }
:root[data-theme="dark"] .report-status.ongoing { color: #f0c36a; }
:root[data-theme="dark"] .report-status.implemented { color: #7fd49a; }
`;
document.head.append(style);

const nav = document.createElement('nav');
nav.className = 'reports-nav';
nav.setAttribute('aria-label', 'Reports');
const brand = document.createElement('span');
brand.className = 'brand';
const icon = document.createElement('img');
icon.src = new URL('../assets/icons/icon-192.png', base).href;
icon.alt = '';
brand.append(icon, 'Reports');
nav.append(brand);
for (const [path, label] of REPORTS) {
  const a = document.createElement('a');
  a.className = 'item';
  a.href = new URL(path, base).href;
  a.textContent = label;
  if (new URL(path, base).pathname === location.pathname) a.setAttribute('aria-current', 'page');
  nav.append(a);
}
document.body.prepend(nav);
