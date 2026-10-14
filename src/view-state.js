// Navigation contains only allowlisted sections and filters. Search terms stay in
// this tab's sessionStorage and are scoped to an authenticated account.
const ROUTES = Object.freeze({
  dashboard: 'resumen', quotes: 'presupuestos', invoices: 'facturas', expenses: 'gastos',
  reports: 'informes', clients: 'clientes', reminders: 'recordatorios', settings: 'configuracion', personal: 'mi-espacio',
});
const DOCUMENT_FILTERS = Object.freeze({
  quotes: ['all', 'draft', 'sent', 'accepted', 'rejected'],
  invoices: ['all', 'draft', 'review', 'issued', 'partial', 'overdue', 'paid'],
  expenses: ['all', 'paid', 'pending', 'review'],
});
const own = (value, key) => value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, key) ? value[key] : undefined;
const member = (value, list, fallback) => list.includes(value) ? value : fallback;
const integer = (value, minimum, maximum, fallback) => {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
};
const term = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200) : '';

export function defaultViewState(today = new Date().toISOString().slice(0, 10)) {
  const year = integer(today.slice(0, 4), 1900, 2200, 2026), month = integer(today.slice(5, 7), 1, 12, 1);
  return { page: 'dashboard', quotes: { filter: 'all', query: '' }, invoices: { filter: 'all', query: '' },
    expenses: { filter: 'all', query: '' }, reports: { type: 'quarter', year, quarter: Math.ceil(month / 3) } };
}

export function sanitizeViewState(value, { today } = {}) {
  const result = defaultViewState(today);
  result.page = member(own(value, 'page'), Object.keys(ROUTES), result.page);
  for (const section of Object.keys(DOCUMENT_FILTERS)) {
    const input = own(value, section);
    result[section] = { filter: member(own(input, 'filter'), DOCUMENT_FILTERS[section], 'all'), query: term(own(input, 'query')) };
  }
  const period = own(value, 'reports');
  result.reports = { type: member(own(period, 'type'), ['quarter', 'year', 'all'], result.reports.type),
    year: integer(own(period, 'year'), 1900, 2200, result.reports.year), quarter: integer(own(period, 'quarter'), 1, 4, result.reports.quarter) };
  return result;
}

/** An absent/unknown route returns null so the saved section remains usable. */
export function parseViewRoute({ hash = '', search = '' } = {}) {
  const [path, params = ''] = String(hash).replace(/^#\/?/, '').split('?', 2);
  const page = Object.entries(ROUTES).find(([id, route]) => route === path || id === path)?.[0];
  if (!page) return ['alerts', 'reminders'].includes(new URLSearchParams(search).get('view')) ? { page: 'reminders' } : null;
  const route = { page }, query = new URLSearchParams(params);
  if (DOCUMENT_FILTERS[page]) {
    const filter = query.get('estado');
    if (DOCUMENT_FILTERS[page].includes(filter)) route[page] = { filter };
  }
  if (page === 'reports') {
    const period = {};
    if (['quarter', 'year', 'all'].includes(query.get('periodo'))) period.type = query.get('periodo');
    const year = integer(query.get('ano'), 1900, 2200, null), quarter = integer(query.get('trimestre'), 1, 4, null);
    if (year !== null) period.year = year;
    if (quarter !== null) period.quarter = quarter;
    route.reports = period;
  }
  return route;
}

export function applyViewRoute(value, route, options) {
  const view = sanitizeViewState(value, options);
  if (!route || !Object.hasOwn(ROUTES, route.page)) return view;
  view.page = route.page;
  if (DOCUMENT_FILTERS[route.page] && own(route, route.page)) view[route.page] = { ...view[route.page], ...route[route.page], query: view[route.page].query };
  if (route.page === 'reports') view.reports = { ...view.reports, ...own(route, 'reports') };
  return sanitizeViewState(view, options);
}

export function viewRouteHash(value, options) {
  const view = sanitizeViewState(value, options), parameters = new URLSearchParams();
  if (DOCUMENT_FILTERS[view.page]) parameters.set('estado', view[view.page].filter);
  if (view.page === 'reports') {
    parameters.set('periodo', view.reports.type);
    if (view.reports.type !== 'all') parameters.set('ano', view.reports.year);
    if (view.reports.type === 'quarter') parameters.set('trimestre', view.reports.quarter);
  }
  return '#' + ROUTES[view.page] + (parameters.size ? '?' + parameters : '');
}

function identitySuffix(identity) {
  return typeof identity === 'string' && /^(?:demo|local|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(identity) ? identity.toLowerCase() : null;
}
export function viewStorageKey(identity) {
  const suffix = identitySuffix(identity);
  return suffix ? 'orquivia.view.v1.' + suffix : null;
}
export function readViewState(storage, identity, options) {
  const key = viewStorageKey(identity);
  try { return sanitizeViewState(key ? JSON.parse(storage.getItem(key) || 'null') : null, options); }
  catch { return defaultViewState(options?.today); }
}
export function writeViewState(storage, identity, value, options) {
  const key = viewStorageKey(identity);
  if (!key) return;
  try { storage.setItem(key, JSON.stringify(sanitizeViewState(value, options))); } catch {}
}
export function readActivityTime(storage, identity) {
  const suffix = identitySuffix(identity);
  if (!suffix) return null;
  try { const value = storage.getItem('orquivia.activity.v1.' + suffix); return value === null ? null : integer(value, 0, Number.MAX_SAFE_INTEGER, 0); }
  catch { return null; }
}
export function writeActivityTime(storage, identity, value) {
  const suffix = identitySuffix(identity);
  if (!suffix || !Number.isSafeInteger(value) || value < 0) return;
  try { storage.setItem('orquivia.activity.v1.' + suffix, String(value)); } catch {}
}
