import type { AdminUsage } from '../server/admin-usage.ts';

const element = (id: string) => document.getElementById(id)!;
const button = element('refresh') as HTMLButtonElement;
const money = (value: number | null) => value === null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value);
const count = (value: number | null) => value === null ? '—' : value.toLocaleString('en-US');

try {
  document.documentElement.dataset.theme = localStorage.getItem('bluesky.theme') === 'dark' ? 'dark' : 'light';
} catch { /* Use the default theme when storage is unavailable. */ }

function notices(id: string, messages: string[]) {
  element(id).replaceChildren(...messages.map(message => {
    const p = document.createElement('p');
    p.className = 'notice';
    p.textContent = message;
    return p;
  }));
}

async function refresh() {
  button.disabled = true;
  element('status').textContent = 'Loading usage…';
  try {
    const response = await fetch('/admin/usage', { cache: 'no-store' });
    if (response.status === 401) { window.location.assign('/?next=/admin'); return; }
    if (!response.ok) throw new Error('Usage could not be loaded. Try refreshing later.');
    const report = await response.json() as AdminUsage;
    element('x-balance').textContent = money(report.x.remaining);
    element('or-balance').textContent = money(report.openRouter.remaining);
    element('or-key').textContent = `Current key today: ${money(report.openRouter.todayKeySpend)} spent · Key budget remaining: ${report.openRouter.keyRemaining === null ? 'No key limit reported' : money(report.openRouter.keyRemaining)}`;
    notices('x-notices', report.x.notices);
    notices('or-notices', report.openRouter.notices);
    element('daily').replaceChildren(...report.daily.map(row => {
      const tr = document.createElement('tr');
      for (const text of [row.date, count(row.xPosts), money(row.openRouterSpend), count(row.openRouterRequests), count(row.openRouterTokens)]) {
        const td = document.createElement('td'); td.textContent = text; tr.append(td);
      }
      return tr;
    }));
    element('status').textContent = `Updated ${new Date(report.updatedAt).toLocaleString()} · Provider reports may be delayed.`;
  } catch (error) {
    element('status').textContent = error instanceof Error ? error.message : 'Usage could not be loaded.';
  } finally { button.disabled = false; }
}

button.addEventListener('click', () => { void refresh(); });
void refresh();
