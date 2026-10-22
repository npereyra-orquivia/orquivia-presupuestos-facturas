import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultViewState, sanitizeViewState, parseViewRoute, applyViewRoute, viewRouteHash,
  viewStorageKey, readViewState, writeViewState, readActivityTime, writeActivityTime } from '../src/view-state.js';
import { sessionShouldLock } from '../src/security.js';
import { renderAccess } from '../src/auth-ui.js';

const today = '2026-10-14', options = { today };
const nicole = 'f85f320a-8b56-4e22-a929-900055a613f7', liliana = 'b5e82a35-b946-4d29-8f53-945eac02cccf';
function storage() {
  const rows = new Map();
  return { rows, getItem: key => rows.has(key) ? rows.get(key) : null, setItem: (key, value) => rows.set(key, String(value)) };
}

test('refresh can restore Gastos / Por revisar without putting the search in the URL', () => {
  const tab = storage(), view = { ...defaultViewState(today), page: 'expenses', expenses: { filter: 'review', query: 'Comisión bancaria' } };
  writeViewState(tab, nicole, view, options);
  const hash = viewRouteHash(view, options);
  assert.equal(hash, '#gastos?estado=review');
  assert.ok(!hash.includes('bancaria'));
  const resumed = applyViewRoute(readViewState(tab, nicole, options), parseViewRoute({ hash }), options);
  assert.equal(resumed.page, 'expenses');
  assert.deepEqual(resumed.expenses, { filter: 'review', query: 'Comisión bancaria' });
});

test('report year, quarter and whole-history URLs restore the chosen period', () => {
  for (const reports of [{ type: 'quarter', year: 2025, quarter: 2 }, { type: 'year', year: 2024, quarter: 4 }, { type: 'all', year: 2026, quarter: 4 }]) {
    const original = { ...defaultViewState(today), page: 'reports', reports };
    const hash = viewRouteHash(original, options), resumed = applyViewRoute(defaultViewState(today), parseViewRoute({ hash }), options);
    assert.equal(resumed.page, 'reports');
    assert.equal(resumed.reports.type, reports.type);
    if (reports.type !== 'all') assert.equal(resumed.reports.year, reports.year);
    if (reports.type === 'quarter') assert.equal(resumed.reports.quarter, reports.quarter);
  }
});

test('financial statement dates survive refresh and account storage without persisting financial input data',()=>{
  const tab=storage(),view={...defaultViewState(today),page:'statements',statements:{from:'2026-03-01',to:'2026-10-13',capital:3000,source:'private'}};
  writeViewState(tab,nicole,view,options);
  const hash=viewRouteHash(view,options);assert.equal(hash,'#estados-financieros?desde=2026-03-01&hasta=2026-10-13');
  const restored=applyViewRoute(readViewState(tab,nicole,options),parseViewRoute({hash}),options);
  assert.equal(restored.page,'statements');assert.deepEqual(restored.statements,{from:'2026-03-01',to:'2026-10-13'});
  assert.ok(!tab.getItem(viewStorageKey(nicole)).includes('private'));
});
test('financial statement routes reject impossible dates, future cutoffs and reversed periods',()=>{
  const route=parseViewRoute({hash:'#estados-financieros?desde=2026-02-30&hasta=2027-01-01'});
  assert.deepEqual(applyViewRoute(defaultViewState(today),route,options).statements,{from:'2026-01-01',to:today});
  assert.deepEqual(sanitizeViewState({statements:{from:'2026-10-14',to:'2026-09-30'}},options).statements,{from:'2026-01-01',to:'2026-09-30'});
});

test('back and forward routes recover separate document filters without crossing sections', () => {
  const saved = sanitizeViewState({ quotes: { filter: 'accepted', query: 'Proyecto' }, invoices: { filter: 'paid', query: 'Cliente' } }, options);
  const invoice = applyViewRoute(saved, parseViewRoute({ hash: '#facturas?estado=overdue' }), options);
  assert.deepEqual(invoice.invoices, { filter: 'overdue', query: 'Cliente' });
  assert.deepEqual(invoice.quotes, { filter: 'accepted', query: 'Proyecto' });
  const back = applyViewRoute(invoice, parseViewRoute({ hash: '#presupuestos?estado=accepted' }), options);
  assert.equal(back.page, 'quotes');
  assert.deepEqual(back.quotes, { filter: 'accepted', query: 'Proyecto' });
});

test('notification links still open Recordatorios and explicit page routes win over a legacy query', () => {
  assert.deepEqual(parseViewRoute({ hash: '#recordatorios' }), { page: 'reminders' });
  assert.deepEqual(parseViewRoute({ search: '?view=alerts' }), { page: 'reminders' });
  assert.deepEqual(parseViewRoute({ search: '?view=reminders' }), { page: 'reminders' });
  assert.equal(parseViewRoute({ search: '?view=other' }), null);
  assert.deepEqual(parseViewRoute({ hash: '#gastos?estado=review', search: '?view=alerts' }), { page: 'expenses', expenses: { filter: 'review' } });
});

test('unknown URL paths and invalid period/filter values cannot become application state', () => {
  for (const hash of ['#https://evil.test', '#<script>', '#constructor', '#__proto__', '#%67astos']) assert.equal(parseViewRoute({ hash }), null, hash);
  assert.deepEqual(parseViewRoute({ hash: '#gastos?estado=accepted&query=secreto' }), { page: 'expenses' });
  assert.deepEqual(parseViewRoute({ hash: '#informes?periodo=constructor&ano=9999&trimestre=NaN' }), { page: 'reports', reports: {} });
  assert.deepEqual(parseViewRoute({ hash: '#informes?periodo=quarter&ano=2026.5&trimestre=0' }), { page: 'reports', reports: { type: 'quarter' } });
  assert.deepEqual(applyViewRoute(defaultViewState(today), { page: 'expenses', expenses: { filter: 'paid', query: 'URL secret' } }, options).expenses, { filter: 'paid', query: '' });
});

test('stored preferences are scoped per account and contain only allowlisted UI fields', () => {
  const tab = storage();
  const privateExtras = { page: 'expenses', expenses: { filter: 'review', query: 'Ticket', documents: ['invoice'] }, password: 'secret', documents: ['invoice'], accessToken: 'secret' };
  writeViewState(tab, nicole, privateExtras, options);
  assert.deepEqual(readViewState(tab, liliana, options), defaultViewState(today));
  const raw = tab.getItem(viewStorageKey(nicole));
  assert.ok(!raw.includes('secret') && !raw.includes('documents'));
  assert.equal(readViewState(tab, nicole, options).expenses.filter, 'review');
  assert.equal(viewStorageKey('npereyra@orquivia.com'), null);
  assert.notEqual(viewStorageKey('local'), viewStorageKey('demo'));
  writeViewState(tab, '../../other', privateExtras, options);
  assert.equal(tab.rows.size, 1);
});

test('malformed or unavailable session storage safely falls back to current-quarter defaults', () => {
  const tab = storage(); tab.setItem(viewStorageKey(nicole), '{invalid JSON');
  assert.deepEqual(readViewState(tab, nicole, options), defaultViewState(today));
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.deepEqual(readViewState(blocked, nicole, options), defaultViewState(today));
  assert.doesNotThrow(() => writeViewState(blocked, nicole, { page: 'expenses' }, options));
  const dirty = sanitizeViewState({ page: 'unknown', reports: { type: 'all', year: [], quarter: true }, expenses: { filter: 'review', query: 'a\u0000b\nc' + 'z'.repeat(300) } }, options);
  assert.equal(dirty.page, 'dashboard');
  assert.deepEqual(dirty.reports, { type: 'all', year: 2026, quarter: 4 });
  assert.ok(!dirty.expenses.query.includes('\u0000') && !dirty.expenses.query.includes('\n'));
  assert.equal(dirty.expenses.query.length, 200);
});

test('the idle marker survives refresh per account and cannot be advanced by saving navigation', () => {
  const tab = storage(), now = Date.UTC(2026, 9, 14, 12), inactive = now - 30 * 60 * 1000;
  writeActivityTime(tab, nicole, inactive);
  writeViewState(tab, nicole, { page: 'expenses' }, options);
  assert.equal(readActivityTime(tab, nicole), inactive);
  assert.equal(readActivityTime(tab, liliana), null);
  assert.equal(sessionShouldLock({ lastActivityAt: readActivityTime(tab, nicole), now }), true);
  writeActivityTime(tab, nicole, now + 1000);
  assert.equal(sessionShouldLock({ lastActivityAt: readActivityTime(tab, nicole), now }), true);
  tab.setItem('orquivia.activity.v1.' + nicole, 'not a time');
  assert.equal(readActivityTime(tab, nicole), 0);
  assert.equal(sessionShouldLock({ lastActivityAt: readActivityTime(tab, nicole), now }), true);
});

function accessFixture() {
  const classes = new Set(), page = { classList: { add: value => classes.add(value), remove: value => classes.delete(value) } };
  const markup = [], form = {}, button = {}, host = {
    get innerHTML() { return markup.at(-1) || ''; }, set innerHTML(value) { markup.push(value); },
    querySelector(selector) { return selector === 'form' ? form : selector === '#cancel-auth' ? button : null; },
  };
  const container = { innerHTML: '', querySelector: selector => selector === '#auth-content' ? host : selector === '.access-page' ? page : null };
  return { container, host, markup, classes };
}
function deferred() { let resolve; const promise = new Promise(done => resolve = done); return { promise, resolve }; }

test('startup shows a session check until both authenticated user and private workspace are verified', async () => {
  const fixture = accessFixture(), session = deferred(), workspace = deferred(); let authenticated = null;
  const backend = { currentUser: () => session.promise, loadState: () => workspace.promise };
  const ui = renderAccess(fixture.container, { backend, logo: 'logo.svg', restoring: true, onAuthenticated: value => authenticated = value });
  assert.match(fixture.host.innerHTML, /Comprobando tu sesión/);
  assert.equal(fixture.classes.has('is-restoring'), true);
  const resumed = ui.resume();
  assert.ok(fixture.markup.every(value => !value.includes('id="access-form"')));
  session.resolve({ id: nicole });
  await Promise.resolve();
  assert.equal(authenticated, null);
  assert.match(fixture.host.innerHTML, /Comprobando tu sesión/);
  const state = { company: { name: 'Orquívia' } };
  workspace.resolve(state); await resumed;
  assert.deepEqual(authenticated, { user: { id: nicole }, state, restored: true });
  assert.ok(fixture.markup.every(value => !value.includes('id="access-form"')));
});

test('a genuine missing session shows login only after the restoration check resolves', async () => {
  const fixture = accessFixture(), session = deferred(); let loaded = false;
  const backend = { currentUser: () => session.promise, loadState: async () => loaded = true };
  const ui = renderAccess(fixture.container, { backend, logo: 'logo.svg', restoring: true, onAuthenticated: () => assert.fail('No authorized user') });
  const resumed = ui.resume();
  assert.ok(!fixture.host.innerHTML.includes('access-form'));
  session.resolve(null); assert.equal(await resumed, false);
  assert.match(fixture.host.innerHTML, /id="access-form"/);
  assert.equal(fixture.classes.has('is-restoring'), false);
  assert.equal(loaded, false);
});

test('restoration still requires the real MFA challenge before any private screen can appear', async () => {
  const fixture = accessFixture(); let authenticated = false;
  const backend = { currentUser: async () => ({ id: nicole }), loadState: async () => { throw Object.assign(new Error('MFA'), { code: 'MFA_REQUIRED' }); },
    mfa: { factors: async () => ({ totp: [{ id: 'factor', status: 'verified', factor_type: 'totp' }] }) } };
  const ui = renderAccess(fixture.container, { backend, logo: 'logo.svg', restoring: true, onAuthenticated: () => authenticated = true });
  await ui.resume();
  assert.equal(authenticated, false);
  assert.match(fixture.host.innerHTML, /Confirma que eres tú/);
  assert.match(fixture.host.innerHTML, /id="totp-form"/);
  assert.equal(fixture.classes.has('is-restoring'), false);
  assert.ok(fixture.markup.every(value => !value.includes('id="access-form"')));
});
