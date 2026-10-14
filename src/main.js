import './style.css';
import './controls.css';
import { enhanceControls } from './controls.js';
import { cashCard, expensesPage, bindExpenses, expenseModal, openingBalanceModal } from './expense-ui.js';
import { reportsPage, bindReports } from './reports-ui.js';
import { expenseImportModal } from './expense-import.js';
import { icon } from './icons.js';
import { todayISO, money, escapeHTML as esc, totals, paidAmount, outstanding, status, alerts, nextNumber, createInvoiceFromQuote, validateDocument } from './domain.js';
import { demoState, emptyState } from './demo.js';
import { createBackend } from './backend.js';
import { publicConfigIsValid, prepareRestore, sessionShouldLock } from './security.js';
import { renderAccess, accountMarkup, bindPasswordForm } from './auth-ui.js';
import { defaultPersonalProfile, validateProfile } from './personal-backend.js';
import { personalPage, bindPersonal, profileName, avatarMarkup } from './personal-ui.js';
import { registerPWA, pushCapability, devicePushSubscription, enableDevicePush, disableDevicePush } from './push-client.js';
import { defaultViewState, sanitizeViewState, parseViewRoute, applyViewRoute, viewRouteHash, readViewState, writeViewState, readActivityTime, writeActivityTime } from './view-state.js';

const app=document.querySelector('#app'), modalRoot=document.querySelector('#modal-root');
const logo=`${import.meta.env.BASE_URL}orquivia-logo.png`;
const brandLogo=`${import.meta.env.BASE_URL}orquivia-logo-full.svg`,markLogo=`${import.meta.env.BASE_URL}orquivia-logo-mark.svg`;
const documentLogo=`${import.meta.env.BASE_URL}orquivia-logo-wordmark.png`;
const production=!import.meta.env.DEV || import.meta.env.VITE_APP_MODE==='production';
const demoAllowed=!production&&new URLSearchParams(location.search).has('demo');
const storageKey=demoAllowed?'orquivia.demo.v1':'orquivia.local.private.v2';
const localStore=demoAllowed?localStorage:sessionStorage;
const loadDemo=()=>{try{return validateState(JSON.parse(localStore.getItem(storageKey)))}catch{return demoAllowed?demoState():emptyState()}};
let state=emptyState(),page='dashboard',query='',filter='all',mode='locked',user=null,backend=null,busy=false,editor=null,previousFocus=null;
let lastActivityAt=Date.now(),accessUI=null,accessGeneration=0;
let viewState=defaultViewState(todayISO()),lastLocationKey='';
let appControlsCleanup=null,modalControlDisposers=[],modalCancel=null,personalBindingCleanup=null;
let personalProfile=defaultPersonalProfile(),personalPhotoUrl='',personalLoading=false,personalError='',personalBusy=false;
let personalDevice={capability:pushCapability(),ready:false,active:false,config:null};
let sidebarCollapsed=localStorage.getItem('orquivia.sidebar.collapsed')==='true';
let pendingAlertView=false;
let config={url:import.meta.env.VITE_SUPABASE_URL||'',anonKey:import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY||''};
if(!production)try{const saved=JSON.parse(localStorage.getItem('orquivia.connection')||'null');if(saved)config=saved}catch{}
const labels={dashboard:'Resumen',quotes:'Presupuestos',invoices:'Facturas',expenses:'Gastos',reports:'Informes y gestor',clients:'Clientes',reminders:'Recordatorios',settings:'Configuración',personal:'Mi espacio'};
function lockPrivate(message='',{restoring=false}={}){
  const generation=++accessGeneration,activeBackend=backend;
  appControlsCleanup?.();appControlsCleanup=null;resetPersonal();
  state=emptyState();user=null;mode='locked';editor=null;busy=false;viewState=defaultViewState(todayISO());closeModal(true);
  accessUI=renderAccess(app,{backend,logo,brandLogo,message,restoring,onAuthenticated:async({user:account,state:loaded,restored})=>{
    if(generation!==accessGeneration||backend!==activeBackend)return;
    const storedActivity=readActivityTime(sessionStorage,account.id),now=Date.now();
    if(restored&&storedActivity!==null&&sessionShouldLock({lastActivityAt:storedActivity,now})){
      await activeBackend.signOut();
      if(generation===accessGeneration)lockPrivate('La sesión se cerró tras 30 minutos sin actividad.');
      return;
    }
    user=account;state=validateState(loaded);mode='cloud';lastActivityAt=restored&&storedActivity!==null?storedActivity:now;
    writeActivityTime(sessionStorage,account.id,lastActivityAt);restoreNavigation();render();loadPersonal();
  }});
}
function connectBackend(){
  backend?.dispose();const active=createBackend(config);backend=active;
  active.onAuthStateChange((event,current)=>{
    if(backend!==active)return;
    if(mode==='cloud'&&(['SIGNED_OUT','ACCESS_REVOKED','MFA_REQUIRED'].includes(event)||(current&&user&&current.id!==user.id))){
      lockPrivate(event==='SIGNED_OUT'?'Sesión cerrada.':'Verifica tu acceso antes de continuar.',{restoring:event==='MFA_REQUIRED'});
      if(event==='MFA_REQUIRED')accessUI.resume().catch(e=>toast(e.message,true));
    }else if(event==='TOKEN_REFRESHED')user=current;
  });return active;
}
const statusLabels={draft:'Borrador',sent:'Enviado',accepted:'Aceptado',rejected:'Rechazado',issued:'Pendiente',paid:'Pagada',partial:'Pago parcial',overdue:'Vencida',review:'Cobro por confirmar'};
const clientFor=d=>d.clientSnapshot||state.clients.find(c=>c.id===d.clientId)||{name:'Cliente eliminado'};
const docName=d=>d.number||'Borrador';
const formatDate=s=>s ? new Intl.DateTimeFormat('es-ES',{day:'2-digit',month:'short',year:'numeric',timeZone:'UTC'}).format(new Date(s+'T12:00:00Z')):'—';
const badge=d=>{const v=status(d,state.payments);return `<span class="badge ${v}"><i></i>${statusLabels[v]||esc(v)}</span>`};
const field=(label,name,value='',type='text',extra='')=>`<label class="field"><span>${label}</span><input name="${name}" type="${type}" value="${esc(String(value??''))}" ${extra}></label>`;
const selectField=(label,name,options,value)=>`<label class="field"><span>${label}</span><select name="${name}">${options.map(([v,l])=>`<option value="${esc(v)}" ${v===value?'selected':''}>${esc(l)}</option>`).join('')}</select></label>`;
function toast(message,error=false){const t=document.createElement('div');t.className=`toast ${error?'error':''}`;t.textContent=message;document.querySelector('#toast-root').append(t);setTimeout(()=>t.remove(),6000)}
function validateState(value){return prepareRestore(value,{today:todayISO()})}
async function commit(change,message){
  if(mode==='locked'){toast('Inicia sesión antes de guardar.',true);return false}
  if(busy){toast('Espera a que termine el guardado.');return false}
  busy=true;const next=structuredClone(state);
  try{change(next);next.documents.forEach(d=>d.total=totals(d).total);if(mode==='cloud')await backend.saveState(next);else localStore.setItem(storageKey,JSON.stringify(validateState(next)));state=next;if(message)toast(message);render();return true;}
  catch(e){toast(e.code==='VERSION_CONFLICT'?'Hay cambios desde otra sesión. Recarga los datos en Configuración antes de continuar.':`No se pudo guardar: ${e.message}`,true);return false;}
  finally{busy=false;}
}
function viewIdentity(){return mode==='cloud'?user?.id:mode}
function activateView(){page=viewState.page;query=viewState[page]?.query||'';filter=viewState[page]?.filter||'all'}
function persistNavigation(historyMode='replace'){
  if(mode==='locked')return;
  viewState.page=page;writeViewState(sessionStorage,viewIdentity(),viewState,{today:todayISO()});
  const url=new URL(location.href);url.hash=viewRouteHash(viewState,{today:todayISO()});
  if(['alerts','reminders'].includes(url.searchParams.get('view')))url.searchParams.delete('view');
  if(url.href!==location.href)try{window.history[historyMode==='push'?'pushState':'replaceState'](null,'',url)}catch{}
  lastLocationKey=location.hash+'|'+location.search;
}
function restoreNavigation(){
  viewState=readViewState(sessionStorage,viewIdentity(),{today:todayISO()});
  viewState=applyViewRoute(viewState,pendingAlertView?{page:'reminders'}:parseViewRoute(location),{today:todayISO()});
  pendingAlertView=false;activateView();persistNavigation();
}
function setViewState(section,patch,{history='replace'}={}){
  if(mode==='locked'||!['quotes','invoices','expenses','reports'].includes(section))return;
  viewState=sanitizeViewState({...viewState,[section]:{...viewState[section],...patch}},{today:todayISO()});
  activateView();persistNavigation(history);
}
function navTo(value){if(!Object.hasOwn(labels,value))return;const changed=page!==value;viewState.page=value;activateView();persistNavigation(changed?'push':'replace');render();window.scrollTo(0,0)}
function restoreHistoryView(){
  const key=location.hash+'|'+location.search;
  if(mode==='locked'||key===lastLocationKey)return;
  const route=parseViewRoute(location)||{page:'dashboard'};
  viewState=applyViewRoute(viewState,route,{today:todayISO()});activateView();persistNavigation();render();window.scrollTo(0,0);
}
window.addEventListener('popstate',restoreHistoryView);
window.addEventListener('hashchange',restoreHistoryView);
function render(){
  appControlsCleanup?.();appControlsCleanup=null;personalBindingCleanup?.();personalBindingCleanup=null;
  if(mode==='locked'){lockPrivate();return}
  const due=alerts(state.documents,state.payments),name=profileName(personalProfile,user,mode);
  app.innerHTML=`<aside class="sidebar ${sidebarCollapsed?'is-collapsed':''}" id="primary-sidebar"><a class="brand" href="#" data-nav="dashboard" aria-label="Orquívia · Resumen"><img class="brand-full" src="${brandLogo}" alt="Orquívia"><img class="brand-mark" src="${markLogo}" alt=""></a><button class="icon-btn sidebar-toggle" data-action="sidebar-toggle" aria-controls="primary-sidebar" aria-expanded="${!sidebarCollapsed}" aria-label="${sidebarCollapsed?'Desplegar barra lateral':'Plegar barra lateral'}" title="${sidebarCollapsed?'Desplegar barra lateral':'Plegar barra lateral'}">${icon('chevron')}</button><div class="workspace-label">TU ESPACIO DE TRABAJO</div><nav aria-label="Navegación principal">${Object.entries(labels).filter(([id])=>id!=='personal').map(([id,label])=>`<button data-nav="${id}" aria-label="${label}" title="${label}" class="nav-item ${page===id?'active':''}">${icon({dashboard:'grid',quotes:'quote',invoices:'invoice',expenses:'euro',reports:'report',clients:'clients',reminders:'bell',settings:'settings'}[id])}<span>${label}</span>${id==='reminders'&&due.length?`<b>${due.length}</b>`:''}</button>`).join('')}</nav><div class="sidebar-bottom"><div class="help-card">${icon('shield')}<strong>Todo tiene su seguimiento</strong><p>Fechas, contratos y cobros en un mismo lugar.</p><button data-nav="reminders">Ver recordatorios ${icon('arrow')}</button></div><div class="profile"><button class="profile-main" data-nav="personal" aria-label="Mi espacio · ${esc(name)}" title="Mi espacio · ${esc(name)}">${avatarMarkup(name,personalPhotoUrl)}<span class="profile-copy"><strong>${esc(name)}</strong><small>${esc(state.company.name||'Orquívia')}</small></span></button>${mode==='cloud'?`<button class="icon-btn" data-action="logout" aria-label="Cerrar sesión">${icon('logout')}</button>`:''}</div></div></aside><div class="shell ${sidebarCollapsed?'is-collapsed':''}"><header class="topbar"><div class="breadcrumb"><button class="icon-btn mobile-menu" data-action="menu" aria-label="Abrir menú">${icon('menu')}</button><span>Mi empresa</span>${icon('chevron')}<strong>${labels[page]}</strong></div><div class="topbar-right"><span class="connection ${mode==='cloud'?'connected':''}"><i></i>${mode==='cloud'?'Conectado a Supabase':mode==='demo'?'Modo de prueba':'Preparación local'}</span><button class="notification-btn icon-btn" data-nav="reminders" aria-label="Ver ${due.length} recordatorios">${icon('bell')}${due.length?'<i></i>':''}</button><button class="topbar-profile" data-nav="personal" aria-label="Abrir mi espacio · ${esc(name)}" title="Mi espacio">${avatarMarkup(name,personalPhotoUrl,'small')}</button></div></header><main><div class="demo-strip ${mode==='cloud'?'hidden':''}">${icon('info')}<span>${mode==='demo'?'Datos de ejemplo.':'Datos reales en preparación local. Todavía no están publicados.'}</span><button data-nav="settings">Preparar mi empresa ${icon('arrow')}</button></div>${page==='dashboard'?dashboard():page==='quotes'||page==='invoices'?documentsPage():page==='expenses'?expensesPage(state,viewState.expenses):page==='reports'?reportsPage(state,viewState.reports):page==='clients'?clientsPage():page==='reminders'?remindersPage():page==='personal'?personalPage({profile:personalProfile,user,photoUrl:personalPhotoUrl,mode,loading:personalLoading,error:personalError,device:personalDevice,account:mode==='cloud'?accountMarkup():''}):settingsPage()}</main><footer class="app-footer"><span>Orquívia · Un poco menos de administración, un poco más de calma.</span><span>${mode==='cloud'?'Sesión privada · '+esc(user?.email||''):'Preparación en este ordenador'}</span></footer></div>`;
  bindApp();bindExpenses(app,expenseContext());bindReports(app,expenseContext());personalBindingCleanup=bindPersonal(app,personalContext());appControlsCleanup=enhanceControls(app);
}
function heading(eyebrow,title,description,action=''){return `<div class="page-heading"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p>${description}</p></div>${action}</div>`}
const newButton=(kind='quote')=>`<button class="button primary" data-action="new" data-kind="${kind}">${icon('plus')}${kind==='invoice'?'Nueva factura':'Nuevo presupuesto'}</button>`;
function dashboard(){
  const invoices=state.documents.filter(d=>d.kind==='invoice'&&d.status!=='draft');
  const confirmed=invoices.filter(d=>!d.paymentReviewNeeded);
  const pending=confirmed.reduce((n,d)=>n+outstanding(d,state.payments),0), paid=confirmed.reduce((n,d)=>n+paidAmount(d,state.payments),0);
  const overdue=invoices.filter(d=>status(d,state.payments)==='overdue');
  const quotes=state.documents.filter(d=>d.kind==='quote'&&['sent','accepted'].includes(d.status));
  const month=todayISO().slice(0,7);const billed=invoices.filter(d=>d.date.startsWith(month)).reduce((n,d)=>n+totals(d).total,0);
  const a=alerts(state.documents,state.payments);
  return heading('TU NEGOCIO, EN UN VISTAZO','Cada proyecto, bajo control.','Prepara documentos, organiza tus cobros y adelántate a los plazos.',newButton())+reviewBanner()+cashCard(state)+`<section class="stats-grid" aria-label="Resumen del negocio"><article class="stat"><div class="stat-top"><span>Pendiente de cobro</span><span class="stat-icon green">${icon('euro')}</span></div><strong>${money(pending)}</strong><small>${confirmed.filter(d=>outstanding(d,state.payments)>0).length} facturas por cobrar</small></article><article class="stat"><div class="stat-top"><span>Facturado este mes</span><span class="stat-icon blue">${icon('invoice')}</span></div><strong>${money(billed)}</strong><small>Según la fecha de emisión</small></article><article class="stat"><div class="stat-top"><span>Facturas vencidas</span><span class="stat-icon orange">${icon('clock')}</span></div><strong>${overdue.length}<span class="stat-unit">${overdue.length===1?'factura':'facturas'}</span></strong><small class="${overdue.length?'text-danger':''}">${money(overdue.reduce((n,d)=>n+outstanding(d,state.payments),0))} por revisar</small></article><article class="stat"><div class="stat-top"><span>Presupuestos en curso</span><span class="stat-icon purple">${icon('quote')}</span></div><strong>${quotes.length}<span class="stat-unit">proyectos</span></strong><small>${quotes.filter(d=>d.status==='accepted').length} aceptados · ${quotes.filter(d=>d.status==='sent').length} enviados</small></article></section><div class="overview-grid"><section class="card evolution"><div class="card-header"><div><h2>La evolución de tu actividad</h2><p>Facturación emitida por mes</p></div><span class="period">Últimos 6 meses ${icon('down')}</span></div>${chart(invoices)}<div class="chart-legend"><i></i>Facturado <span>Incluye IVA y retenciones</span></div></section><section class="card collection"><div class="card-header"><div><h2>El estado de tus cobros</h2><p>Facturas emitidas</p></div>${icon('euro')}</div><div class="donut" style="--percent:${paid+pending?Math.min(100,paid/(paid+pending)*100):0}%"><div><small>Ya cobrado</small><strong>${money(paid)}</strong></div></div><div class="collection-legend"><div><span><i class="green-dot"></i>Cobrado</span><strong>${money(paid)}</strong></div><div><span><i class="pale-dot"></i>Pendiente</span><strong>${money(pending)}</strong></div></div></section></div><div class="lower-grid"><section class="card documents-card"><div class="card-header"><div><h2>Tus últimos documentos</h2><p>De la primera propuesta al último cobro</p></div><button class="text-button" data-nav="invoices">Ver facturas ${icon('arrow')}</button></div>${table(state.documents.slice().sort((a,b)=>b.date.localeCompare(a.date)).slice(0,5),true)}</section><section class="card reminder-card"><div class="card-header"><h2>Para tener en cuenta</h2><span class="count-chip">${a.length}</span></div>${a.slice(0,3).map(alertCard).join('')||`<div class="calm-state">${icon('check')}<h3>Todo al día</h3><p>Los avisos de cobros y contratos aparecerán aquí.</p></div>`}<button class="text-button bottom-link" data-nav="reminders">Todos los recordatorios ${icon('arrow')}</button></section></div>`;
}
function reviewBanner(){
  const count=state.documents.filter(d=>d.kind==='invoice'&&d.paymentReviewNeeded).length;
  return count?'<div class="note-banner">'+icon('info')+'<p>'+count+' facturas importadas tienen el cobro por confirmar. Sus importes no se incluyen en el saldo pendiente hasta revisar los pagos.</p><button class="text-button" data-nav="reminders">Revisar</button></div>':'';
}
function chart(invoices){
  const months=[];const current=new Date(todayISO()+'T12:00:00Z');
  for(let n=5;n>=0;n--){const d=new Date(Date.UTC(current.getUTCFullYear(),current.getUTCMonth()-n,1));const key=d.toISOString().slice(0,7);months.push({label:new Intl.DateTimeFormat('es-ES',{month:'short',timeZone:'UTC'}).format(d).replace('.',''),value:invoices.filter(v=>v.date.startsWith(key)).reduce((s,v)=>s+totals(v).total,0)})}
  const max=Math.max(100,...months.map(m=>m.value));
  return `<div class="bar-chart"><div class="chart-y">${[max,max*.75,max*.5,max*.25,0].map(v=>`<span>${Math.round(v).toLocaleString('es-ES')} €</span>`).join('')}</div><div class="chart-plot"><div class="chart-grid"><i></i><i></i><i></i><i></i><i></i></div><div class="chart-bars">${months.map((m,i)=>`<div class="chart-column"><div class="bar ${i===5?'current':''}" style="height:${Math.max(m.value?2:0,m.value/max*100)}%" title="${m.label}: ${money(m.value)}"><span>${money(m.value)}</span></div><small>${m.label}</small></div>`).join('')}</div></div></div>`;
}
function table(docs,compact=false){return `<div class="table-scroll"><table><thead><tr><th>Documento / cliente</th>${compact?'':'<th>Emisión</th>'}<th>Importe</th><th>Estado</th><th>${compact?'':'Vencimiento'}</th></tr></thead><tbody>${docs.map(d=>`<tr><td><button class="doc-link" data-action="view" data-id="${esc(d.id)}"><span class="doc-icon ${d.kind}">${icon(d.kind==='invoice'?'invoice':'quote')}</span><span><strong>${esc(docName(d))}</strong><small>${esc(clientFor(d).name)}</small></span></button></td>${compact?'':`<td class="date-cell">${formatDate(d.date)}</td>`}<td class="amount">${money(totals(d).total)}</td><td>${badge(d)}</td><td>${compact?`<button class="icon-btn" data-action="view" data-id="${esc(d.id)}" aria-label="Ver ${esc(docName(d))}">${icon('chevron')}</button>`:`<span class="date-cell">${formatDate(d.dueDate)}</span>`}</td></tr>`).join('')||'<tr><td colspan="5"><div class="empty-state">Aquí empieza tu próximo proyecto.<br><small>Crea un documento para verlo en esta lista.</small></div></td></tr>'}</tbody></table></div>`}
function documentsPage(){
  const kind=page==='invoices'?'invoice':'quote';let docs=state.documents.filter(d=>d.kind===kind).filter(d=>`${d.number} ${clientFor(d).name} ${d.title||''}`.toLowerCase().includes(query.toLowerCase())).filter(d=>filter==='all'||status(d,state.payments)===filter);
  const filters=kind==='invoice'?['all','draft','review','issued','partial','overdue','paid']:['all','draft','sent','accepted','rejected'];
  return heading('DOCUMENTOS',kind==='invoice'?'Facturas claras. Cobros al día.':'De una buena idea a un nuevo proyecto.',kind==='invoice'?'Registra cada pago y conoce exactamente lo que queda por cobrar.':'Crea una propuesta, sigue su estado y conviértela en factura.',newButton(kind))+`<section class="card"><div class="list-toolbar"><div class="search-box">${icon('search')}<input id="search" placeholder="Buscar número, cliente o concepto…" value="${esc(query)}" aria-label="Buscar documentos"></div><button class="button secondary" data-action="csv">${icon('download')}Exportar CSV</button></div><div class="tabs" role="group" aria-label="Filtrar por estado">${filters.map(f=>`<button data-filter="${f}" class="${filter===f?'selected':''}">${f==='all'?'Todas':statusLabels[f]}<span>${state.documents.filter(d=>d.kind===kind&&(f==='all'||status(d,state.payments)===f)).length}</span></button>`).join('')}</div>${table(docs.sort((a,b)=>b.date.localeCompare(a.date)))}<div class="table-footer">${docs.length} ${kind==='invoice'?'facturas':'presupuestos'}<span>Selecciona un documento para ver sus detalles</span></div></section>`;
}
function clientsPage(){return heading('PERSONAS Y EMPRESAS','Tus clientes, siempre a mano.','Guarda sus datos una vez y reutilízalos en cada documento.',`<button class="button primary" data-action="new-client">${icon('plus')}Nuevo cliente</button>`)+`<div class="clients-grid">${state.clients.map((c,i)=>{const docs=state.documents.filter(d=>d.clientId===c.id);const pending=docs.filter(d=>d.kind==='invoice'&&d.status!=='draft'&&!d.paymentReviewNeeded).reduce((n,d)=>n+outstanding(d,state.payments),0);return `<article class="card client-card"><div class="client-head"><span class="client-avatar tone-${i%4}">${esc(c.name.split(' ').map(s=>s[0]).slice(0,2).join(''))}</span><button class="icon-btn" data-action="edit-client" data-id="${esc(c.id)}" aria-label="Editar ${esc(c.name)}">${icon('edit')}</button></div><h2>${esc(c.name)}</h2><p>${esc(c.contact||c.taxId||'Datos por completar')}</p><div class="client-contact">${icon('mail')}<span>${esc(c.email||'Sin email')}</span></div><div class="client-footer"><span>${docs.length} documentos</span><strong>${money(pending)} <small>pendiente</small></strong></div></article>`}).join('')||`<div class="card empty-state">Añade tu primer cliente para empezar a preparar documentos.</div>`}</div>`}
function alertCard(a){const d=state.documents.find(d=>d.id===a.documentId);return `<article class="alert-item ${a.severity}"><span class="alert-icon">${icon(a.type==='contract'?'quote':'clock')}</span><div><strong>${esc(a.title)}</strong><p>${esc(clientFor(d).name)} · ${esc(docName(d))}</p><small>${a.type==='payment'?money(outstanding(d,state.payments))+' · ':''}${formatDate(a.date)}</small></div><button class="icon-btn" data-action="view" data-id="${esc(d.id)}" aria-label="Revisar ${esc(docName(d))}">${icon('chevron')}</button></article>`}
function remindersPage(){const a=alerts(state.documents,state.payments);const upcoming=state.documents.filter(d=>d.status!=='draft'&&d.status!=='rejected').flatMap(d=>[{type:'payment',date:d.kind==='invoice'&&!d.paymentReviewNeeded&&outstanding(d,state.payments)>0?d.dueDate:null},{type:'contract',date:!d.contractReceived?d.contractExpectedDate:null}].filter(x=>x.date&&x.date>todayISO()).map(x=>({...x,d}))).sort((a,b)=>a.date.localeCompare(b.date));return heading('QUE NO SE TE PASE','Un aviso a tiempo cambia todo.','Revisa los cobros y contratos cuya fecha ha llegado.',`<button class="button secondary" data-action="browser-notifications">${icon('bell')}Personalizar mis avisos</button>`)+`<div class="reminders-layout"><section class="card"><div class="card-header"><h2>Necesitan tu atención</h2><span class="count-chip">${a.length}</span></div>${a.map(alertCard).join('')||'<div class="empty-state">Todo al día. No tienes plazos pendientes de revisar.</div>'}</section><section class="card"><div class="card-header"><h2>Lo que viene</h2>${icon('clock')}</div>${upcoming.slice(0,15).map(({d,type,date})=>`<article class="upcoming-item"><div class="date-tile"><strong>${new Date(date+'T12:00:00Z').getUTCDate()}</strong><small>${new Intl.DateTimeFormat('es-ES',{month:'short',timeZone:'UTC'}).format(new Date(date+'T12:00:00Z'))}</small></div><div><strong>${type==='contract'?'Recibir contrato':'Recibir pago'}</strong><p>${esc(clientFor(d).name)} · ${esc(docName(d))}</p></div><button class="icon-btn" data-action="view" data-id="${esc(d.id)}" aria-label="Ver documento">${icon('chevron')}</button></article>`).join('')||'<div class="empty-state">Los próximos plazos aparecerán aquí.</div>'}</section></div><div class="note-banner">${icon('info')}<p>Configura tus preferencias en Mi espacio y activa los avisos en cada dispositivo. En el iPhone, añade primero Orquívia a la pantalla de inicio. Los pagos se confirman al registrarlos.</p></div>`}
function settingsPage(){
  const c=state.company,admin=mode!=='cloud'||backend.workspaceInfo()?.role==='admin';
  return heading('A TU MEDIDA','El espacio de Orquívia.','Datos de empresa, cuenta individual y copias de seguridad.')+
  '<div class="settings-grid"><form id="company-form" class="card settings-card"><div class="card-header"><div><h2>Datos de la empresa</h2><p>Aparecen en los nuevos presupuestos y facturas</p></div>'+icon('settings')+'</div>'+
  (admin?'':'<p class="field-hint">La administradora gestiona los datos fiscales y bancarios de la empresa.</p>')+
  '<fieldset '+(admin?'':'disabled')+'><div class="form-grid">'+
  field('Nombre comercial','name',c.name,'text','required')+field('Razón social','legalName',c.legalName)+field('NIF / CIF','taxId',c.taxId)+field('Email','email',c.email,'email')+
  field('Teléfono','phone',c.phone)+field('Dirección completa','address',c.address)+field('IBAN','iban',c.iban)+field('SWIFT / BIC','bic',c.bic)+
  field('IVA por defecto (%)','vat',c.vat,'number','min="0" max="100" step="0.01"')+field('Retención por defecto (%)','withholding',c.withholding,'number','min="0" max="100" step="0.01"')+
  field('Plazo de pago (días)','paymentTerms',c.paymentTerms,'number','min="0" max="365"')+field('Email para tus recordatorios','notificationEmail',c.notificationEmail,'email')+
  '</div><label class="field"><span>Texto de privacidad del documento</span><textarea name="privacyText" rows="4">'+esc(c.privacyText||'')+'</textarea></label><label class="checkbox-label"><input type="checkbox" name="emailNotifications" '+(c.emailNotifications?'checked':'')+'>Quiero recibir un resumen diario de mis plazos por email</label><p class="field-hint">El servicio de avisos debe estar configurado en Supabase.</p><div class="form-footer"><button class="button primary">Guardar datos</button></div></fieldset></form><div class="settings-side">'+
  (mode==='cloud'?'<section class="card settings-card"><h2>Tu espacio personal</h2><p class="settings-copy">Tu foto, preferencias de avisos y seguridad de la cuenta.</p><button class="button secondary" data-nav="personal">Abrir mi espacio</button></section>'+'<section class="card settings-card"><h2>Empresa compartida</h2><p class="settings-copy">Nicole y Liliana trabajan sobre los mismos documentos. Los cambios se guardan en Supabase y quedan en el historial.</p><button class="button secondary" data-action="reload">Recargar datos de la empresa</button></section>':
  '<section class="card settings-card"><div class="card-header"><h2>Conectar el proyecto de Supabase</h2>'+icon('shield')+'</div><form id="connection-form">'+field('URL de tu proyecto','url',config.url,'url','required placeholder="https://tu-proyecto.supabase.co"')+field('Clave pública (publishable)','anonKey',config.anonKey,'password','required autocomplete="off" placeholder="sb_publishable_…"')+'<p class="field-hint">La importación definitiva se realizará desde el servidor. Las claves secretas se rechazan en este formulario.</p><button class="button secondary full">Conectar e iniciar sesión</button></form></section>')+
  '<section class="card settings-card"><h2>Copias de seguridad</h2><p class="settings-copy">La copia JSON contiene datos privados y las referencias de los justificantes. Los archivos se descargan desde Informes y gestor, por trimestre, año o todo el histórico.</p><div class="backup-actions"><button class="button secondary" data-action="backup">'+icon('download')+'Descargar copia</button>'+
  (mode==='cloud'?'<p class="field-hint">Las restauraciones de la empresa se realizan mediante el procedimiento de administración, conservando la numeración y el historial.</p>':'<label class="button secondary">'+icon('upload')+'Restaurar copia<input id="restore-input" class="visually-hidden" type="file" accept=".json,application/json"></label>')+
  '</div></section></div></div>';
}
function bindApp(){
  app.querySelectorAll('[data-nav]').forEach(b=>b.onclick=e=>{e.preventDefault();navTo(b.dataset.nav)});
  app.querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>action(b.dataset.action,b.dataset.id,b.dataset.kind));
  app.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{setViewState(page,{filter:b.dataset.filter});render()});
  const search=app.querySelector('#search');if(search)search.oninput=()=>{const pos=search.selectionStart;setViewState(page,{query:search.value});render();const n=app.querySelector('#search');n.focus();n.setSelectionRange(pos,pos)};
  const companyForm=app.querySelector('#company-form');if(companyForm)companyForm.onsubmit=async e=>{e.preventDefault();const f=new FormData(companyForm),c=Object.fromEntries(f);for(const key of ['vat','withholding','paymentTerms'])c[key]=Number(c[key]);c.emailNotifications=f.has('emailNotifications');if(c.emailNotifications&&!c.notificationEmail){toast('Añade el email al que quieres recibir los recordatorios.',true);return}await commit(s=>Object.assign(s.company,c),'Datos de empresa guardados.')};
  const passwordForm=app.querySelector('#password-form');
  if(passwordForm)bindPasswordForm(passwordForm,{backend,onError:m=>toast(m,true),onComplete:()=>lockPrivate('Contraseña cambiada. Entra de nuevo con la nueva contraseña.')});
  const connectionForm=app.querySelector('#connection-form');
  if(connectionForm)connectionForm.onsubmit=async e=>{
    e.preventDefault();const f=new FormData(connectionForm),candidate={url:f.get('url').trim(),anonKey:f.get('anonKey').trim()};
    if(!publicConfigIsValid(candidate)){toast('Usa la URL de Supabase y una clave pública publishable o anon.',true);return}
    config=candidate;localStorage.setItem('orquivia.connection',JSON.stringify(config));connectBackend();lockPrivate();
  };
  const restore=app.querySelector('#restore-input');if(restore)restore.onchange=async()=>{const file=restore.files[0];if(!file)return;try{if(file.size>10*1024*1024)throw new Error('La copia supera 10 MB.');const parsed=JSON.parse(await file.text());const incoming=validateState(parsed.state||parsed);confirmModal('Restaurar copia','Se sustituirán los datos de este espacio por los de la copia seleccionada. Descarga una copia actual antes de continuar.',async()=>{if(await commit(s=>Object.assign(s,incoming),'Copia restaurada.'))closeModal()});}catch(e){toast(e.message,true)}};
}
function safePublicKey(key){return publicConfigIsValid({url:config.url,anonKey:key})}
async function action(name,id,kind){const d=state.documents.find(x=>x.id===id);
  if(name==='new-expense')expenseModal(expenseContext());
  if(name==='expense-import')expenseImportModal(expenseContext());
  if(name==='opening-balance')openingBalanceModal(expenseContext());
  if(name==='new')documentModal(null,kind||'quote');
  if(name==='view'&&d)detailModal(d);
  if(name==='new-client')clientModal();
  if(name==='edit-client')clientModal(state.clients.find(c=>c.id===id));
  if(name==='sidebar-toggle'){
    sidebarCollapsed=!sidebarCollapsed;localStorage.setItem('orquivia.sidebar.collapsed',String(sidebarCollapsed));
    app.querySelector('.sidebar')?.classList.toggle('is-collapsed',sidebarCollapsed);app.querySelector('.shell')?.classList.toggle('is-collapsed',sidebarCollapsed);
    const toggle=app.querySelector('.sidebar-toggle'),label=sidebarCollapsed?'Desplegar barra lateral':'Plegar barra lateral';toggle?.setAttribute('aria-expanded',String(!sidebarCollapsed));toggle?.setAttribute('aria-label',label);toggle?.setAttribute('title',label);
  }
  if(name==='reload-personal')await loadPersonal();
  if(name==='menu')document.querySelector('.sidebar').classList.toggle('mobile-open');
  if(name==='backup')download(JSON.stringify({version:1,exportedAt:new Date().toISOString(),state},null,2),`orquivia-copia-${todayISO()}.json`,'application/json');
  if(name==='csv')exportCSV();
  if(name==='clear-demo')confirmModal('Empezar sin ejemplos','Se eliminarán los clientes, documentos y cobros de este navegador. Tus datos de empresa se conservarán.',async()=>{if(await commit(s=>{s.clients=[];s.documents=[];s.payments=[]},'Tu espacio está listo.'))closeModal()});
  if(name==='reset-demo')confirmModal('Restablecer la demostración','Se sustituirán los datos locales por los ejemplos originales.',async()=>{if(await commit(s=>Object.assign(s,demoState()),'Ejemplos restablecidos.'))closeModal()});
  if(name==='reload')try{state=validateState(await backend.loadState()||emptyState());render();toast('Datos de la nube recargados.')}catch(e){toast(e.message,true)};
  if(name==='logout')try{await backend.signOut();lockPrivate('Sesión cerrada.')}catch(e){toast(e.message,true)};
  if(name==='browser-notifications')navTo('personal');
  if(name==='mfa'){lockPrivate();await accessUI.enroll();}
  if(name==='audit')try{const entries=await backend.auditLog();openModal(modalHeader('Historial de cambios')+'<div class="audit-list">'+entries.map(v=>'<p><strong>'+esc(v.actor_email||'Administración')+'</strong> · '+esc(v.event)+'<small>'+esc(new Date(v.created_at).toLocaleString('es-ES',{timeZone:'Europe/Madrid'}))+' · versión '+esc(v.workspace_version)+'</small></p>').join('')+'</div>');}catch(e){toast(e.message,true)};

}
function disposeModalControls(){modalControlDisposers.splice(0).forEach(dispose=>dispose())}
function registerModalCleanup(dispose){modalControlDisposers.push(dispose);return()=>{const index=modalControlDisposers.indexOf(dispose);if(index>=0)modalControlDisposers.splice(index,1)}}
function enhanceModal(onCreateClient){modalControlDisposers.push(enhanceControls(modalRoot,{onCreateClient}))}
function expenseContext(){return {getState:()=>state,getMode:()=>mode,getIdentity:()=>user?.id||mode,getBackend:()=>backend,getViewState:section=>structuredClone(viewState[section]),setViewState,registerModalCleanup,modalRoot,logo:documentLogo,openModal,modalHeader,closeModal,confirmModal,commit,render,toast,validate:validateState,isBusy:()=>busy,setBusy:value=>busy=value,enhance:()=>enhanceModal()}}
function openModal(content,wide=false){disposeModalControls();modalCancel=null;previousFocus=document.activeElement;app.inert=true;modalRoot.innerHTML=`<div class="modal-backdrop"><section class="modal ${wide?'wide':''}" role="dialog" aria-modal="true" aria-label="Detalle de Orquívia">${content}</section></div>`;document.body.classList.add('modal-open');modalRoot.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>closeModal());modalRoot.querySelector('.modal-backdrop').onclick=e=>{if(e.target===e.currentTarget)closeModal()};setTimeout(()=>modalRoot.querySelector('input,select,button')?.focus(),0)}
function closeModal(force=false){if(busy&&!force)return;if(!force&&modalCancel){const back=modalCancel;modalCancel=null;back();return}modalCancel=null;disposeModalControls();modalRoot.innerHTML='';app.inert=false;document.body.classList.remove('modal-open');editor=null;previousFocus?.focus()}
document.addEventListener('keydown',e=>{if(!modalRoot.childElementCount)return;if(e.key==='Escape')closeModal();if(e.key==='Tab'){const nodes=[...modalRoot.querySelectorAll('button,input,select,textarea,a[href],[tabindex="0"]')].filter(n=>!n.disabled&&n.tabIndex>=0&&n.offsetParent!==null&&!n.closest('[hidden]'));if(!nodes.length)return;const first=nodes[0],last=nodes.at(-1);if(e.shiftKey&&document.activeElement===first){last.focus();e.preventDefault()}else if(!e.shiftKey&&document.activeElement===last){first.focus();e.preventDefault()}}});
function modalHeader(title,subtitle=''){return `<div class="modal-heading"><div><h2>${esc(title)}</h2>${subtitle?`<p>${esc(subtitle)}</p>`:''}</div><button class="icon-btn" data-close aria-label="Cerrar">${icon('close')}</button></div>`}
function confirmModal(title,message,cb){openModal(modalHeader(title)+`<p class="confirm-copy">${esc(message)}</p><div class="modal-actions"><button class="button secondary" data-close>Cancelar</button><button id="confirm-button" class="button primary">Continuar</button></div>`);modalRoot.querySelector('#confirm-button').onclick=cb}
function clientModal(client,{onSaved,onCancel}={}){openModal(modalHeader(client?'Editar cliente':'Nuevo cliente',onSaved?'Al guardar volverás a tu documento con este cliente seleccionado.':'Sus datos estarán disponibles al crear documentos.')+`<form id="client-form"><div class="form-grid">${field('Nombre / razón social','name',client?.name,'text','required')}${field('NIF / CIF','taxId',client?.taxId)}${field('Persona de contacto','contact',client?.contact)}${field('Email','email',client?.email,'email')}${field('Dirección completa','address',client?.address)}</div><div class="modal-actions">${client?'<button type="button" class="text-button danger" id="delete-client">Eliminar cliente</button>':''}<button type="button" class="button secondary" data-close>Cancelar</button><button class="button primary">Guardar cliente</button></div></form>`);modalCancel=onCancel||null;
  modalRoot.querySelector('#client-form').onsubmit=async e=>{e.preventDefault();const c={...Object.fromEntries(new FormData(e.target)),id:client?.id||crypto.randomUUID()};c.name=c.name.trim();if(!c.name)return;if(await commit(s=>{if(client)s.clients=s.clients.map(v=>v.id===c.id?c:v);else s.clients.push(c)},'Cliente guardado.')){modalCancel=null;if(onSaved)onSaved(c);else closeModal()}};
  modalRoot.querySelector('#delete-client')?.addEventListener('click',()=>{if(state.documents.some(d=>d.clientId===client.id)){toast('Este cliente tiene documentos asociados. Conserva su ficha para mantener el historial.',true);return}confirmModal('Eliminar cliente',`Se eliminará la ficha de ${client.name}.`,async()=>{if(await commit(s=>s.clients=s.clients.filter(c=>c.id!==client.id),'Cliente eliminado.'))closeModal()})});
}
const addDays=(date,n)=>{const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)};
function updateContract(s,id,checked){const doc=s.documents.find(d=>d.id===id);const projectId=doc.quoteId||doc.id;s.documents.filter(d=>d.id===projectId||d.quoteId===projectId).forEach(d=>d.contractReceived=checked);}
function documentModal(doc,kind='quote',prepared=null){
  if(!state.clients.length){clientModal(null,{onSaved:client=>documentModal(doc,kind,prepared?{...prepared,clientId:client.id}:null)});return}
  editor=structuredClone(prepared||doc||{id:crypto.randomUUID(),kind,number:'',clientId:state.clients[0].id,date:todayISO(),dueDate:addDays(todayISO(),state.company.paymentTerms??30),contractExpectedDate:'',contractReceived:false,title:'',status:'draft',items:[{description:'',detail:'',quantity:1,price:0}],vat:state.company.vat??21,withholding:state.company.withholding??0,discount:0,notes:'',po:'',paymentMethod:'Transferencia bancaria'});
  const selected=editor; const invoice=editor.kind==='invoice';
  openModal(modalHeader(doc?'Editar '+docName(doc):invoice?'Nueva factura':'Nuevo presupuesto','Los importes y la vista previa se actualizan al escribir.')+`<form id="document-form"><div class="editor-layout"><div class="editor-fields"><div class="form-grid">${selectField('Tipo de documento','kind',[['quote','Presupuesto'],['invoice','Factura']],editor.kind)}${field('Número','number',editor.number,'text','readonly placeholder="Se asigna al emitir"')}${selectField('Cliente','clientId',state.clients.map(c=>[c.id,c.name]),editor.clientId)}<div class="internal-reference">${field('Referencia interna del trabajo (opcional)','title',editor.title)}<p class="field-hint">Sirve para encontrar el trabajo en el portal. No aparece en el PDF.</p></div>${field('Fecha de emisión','date',editor.date,'date','required')}${field(invoice?'Vencimiento de pago':'Válido hasta','dueDate',editor.dueDate,'date',doc?.importWarnings?.length?'':'required')}<div data-invoice-field ${invoice?'':'hidden'}>${field('PO / orden de pedido (opcional)','po',editor.po)}<p class="editor-help">La referencia que facilita el cliente para tramitar la factura.</p></div></div><div class="section-label"><h3>Conceptos</h3><span>Importes sin impuestos</span></div><div id="line-items">${lineRows(editor.items)}</div><button class="text-button" id="add-line" type="button">${icon('plus')}Añadir concepto</button><div class="form-grid tax-fields">${field('IVA (%)','vat',editor.vat,'number','min="0" max="100" step="0.01" required')}${field('Descuento (%)','discount',editor.discount,'number','min="0" max="100" step="0.01" required')}${field('Retención (%)','withholding',editor.withholding,'number','min="0" max="100" step="0.01" required')}${selectField('Método de pago','paymentMethod',[['Transferencia bancaria','Transferencia bancaria'],['Tarjeta','Tarjeta'],['Efectivo','Efectivo'],['Otro','Otro']],editor.paymentMethod)}</div><label class="field"><span>Comentarios y condiciones</span><textarea name="notes" rows="3" placeholder="Condiciones del servicio, alcance del proyecto…">${esc(editor.notes||'')}</textarea></label><details class="contract-followup" ${editor.contractExpectedDate||editor.contractReceived?'open':''}><summary>Seguimiento opcional de la aceptación o contrato</summary><p>Úsalo si esperas una confirmación o contrato. Solo controla un recordatorio; no cambia el presupuesto, su estado ni sus importes.</p>${field('Fecha prevista (opcional)','contractExpectedDate',editor.contractExpectedDate,'date')}<label class="checkbox-label"><input type="checkbox" name="contractReceived" ${editor.contractReceived?'checked':''}>Aceptación / contrato recibido</label></details><p class="field-hint">El número definitivo se asigna al emitir. Las series de facturas y presupuestos son independientes por año.</p></div><div class="editor-preview"><div class="preview-label">${icon('quote')}VISTA PREVIA DEL DOCUMENTO</div><div id="live-preview">${documentPreview(editor)}</div></div></div><div class="modal-actions"><button class="button secondary" type="button" data-close>Cancelar</button>${doc&&doc.status!=='draft'?'':'<button class="button secondary" name="intent" value="draft">Guardar borrador</button>'}<button class="button primary" name="intent" value="issued">${icon('check')}${doc&&doc.status!=='draft'?'Guardar cambios':invoice?'Emitir factura':'Emitir presupuesto'}</button></div></form>`,true);
  editor=selected;const form=modalRoot.querySelector('#document-form');if(doc)form.elements.kind.disabled=true;
  const fiscalLocked=doc?.kind==='invoice'&&doc.status!=='draft';
  if(fiscalLocked){for(const name of ['date','number','clientId','title','vat','discount','withholding','paymentMethod']){const input=form.elements[name];if(input.tagName==='SELECT')input.disabled=true;else input.readOnly=true;}form.querySelectorAll('[data-line]').forEach(v=>v.readOnly=true);form.querySelector('#add-line').disabled=true;form.querySelectorAll('[data-remove-line]').forEach(v=>v.disabled=true);}
  const sync=()=>{const f=new FormData(form);const oldClient=editor.clientId;Object.assign(editor,Object.fromEntries(f));if(oldClient!==editor.clientId)delete editor.clientSnapshot;for(const k of ['vat','discount','withholding'])editor[k]=Number(f.get(k));editor.contractReceived=f.has('contractReceived');editor.items=[...form.querySelectorAll('.line-row')].map(r=>({description:r.querySelector('[data-line="description"]').value,detail:r.querySelector('[data-line="detail"]').value,quantity:Number(r.querySelector('[data-line="quantity"]').value),price:Number(r.querySelector('[data-line="price"]').value)}));modalRoot.querySelector('#live-preview').innerHTML=documentPreview(editor)};
  enhanceModal(()=>{sync();const saved=structuredClone(editor);clientModal(null,{onSaved:client=>{saved.clientId=client.id;delete saved.clientSnapshot;documentModal(doc,saved.kind,saved)},onCancel:()=>documentModal(doc,saved.kind,saved)})});
  form.oninput=sync;
  form.querySelector('[name="kind"]').onchange=()=>{sync();if(!doc){editor.number='';form.elements.number.value=editor.number;if(editor.kind==='quote'){editor.po='';form.elements.po.value='';}}form.querySelector('[data-invoice-field]').hidden=editor.kind!=='invoice';form.querySelector('[name="dueDate"]').closest('label').querySelector('span').textContent=editor.kind==='invoice'?'Vencimiento de pago':'Válido hasta';form.querySelector('[value="issued"]').innerHTML=icon('check')+(doc&&doc.status!=='draft'?'Guardar cambios':editor.kind==='invoice'?'Emitir factura':'Emitir presupuesto');sync()};
  const bindLines=()=>form.querySelectorAll('[data-remove-line]').forEach(b=>b.onclick=()=>{if(form.querySelectorAll('.line-row').length===1){toast('El documento debe tener al menos un concepto.');return}b.closest('.line-row').remove();sync()});bindLines();
  form.querySelector('#add-line').onclick=()=>{sync();editor.items.push({description:'',detail:'',quantity:1,price:0});form.querySelector('#line-items').innerHTML=lineRows(editor.items);bindLines();sync()};
  form.onsubmit=async e=>{
    e.preventDefault();sync();const issuing=e.submitter?.value==='issued',wasDraft=!doc||doc.status==='draft';
    const errors=validateDocument(editor);
    if(doc&&editor.kind!==doc.kind)errors.push('Conserva el tipo del documento. Usa Convertir en factura para crear su factura vinculada.');
    if(doc?.kind==='invoice'&&doc.status!=='draft'&&!issuing)errors.push('Una factura emitida debe conservar su estado.');
    if(issuing){const c=doc?.companySnapshot||state.company,cli=doc?.clientSnapshot||state.clients.find(c=>c.id===editor.clientId)||{};
      if(!c.legalName||!c.taxId||!c.address)errors.push('Completa la razón social, NIF y dirección de tu empresa.');
      if(editor.kind==='invoice'&&(!cli.taxId||!cli.address))errors.push('Completa el NIF y dirección del cliente.');
      if(wasDraft&&!editor.dueDate)errors.push('Indica el vencimiento o la fecha de validez.');
    }
    if(errors.length){toast(errors.join(' '),true);return}
    const next=structuredClone(editor);
    next.status=wasDraft?'draft':doc.status;
    if(wasDraft)next.number='';
    if(mode!=='cloud'&&issuing&&wasDraft){next.number=nextNumber(next.kind,state.documents,Number(next.date.slice(0,4)));next.status=next.kind==='invoice'?'issued':'sent';next.companySnapshot=structuredClone(state.company);next.clientSnapshot=structuredClone(state.clients.find(c=>c.id===next.clientId));}
    if(!await commit(s=>{const index=s.documents.findIndex(v=>v.id===next.id);if(index>=0)s.documents[index]=next;else s.documents.push(next);updateContract(s,next.id,next.contractReceived)},issuing&&wasDraft&&mode==='cloud'?'Borrador guardado.':'Documento guardado.'))return;
    if(mode==='cloud'&&issuing&&wasDraft){
      busy=true;
      try{const result=await backend.issueDocument(next.id);state=validateState(result.state);busy=false;render();closeModal();toast('Documento emitido: '+result.documentNumber);}
      catch(err){busy=false;documentModal(state.documents.find(v=>v.id===next.id));toast('El borrador está guardado, pero no se ha emitido. '+err.message,true);}
    }else closeModal();
  };
}
function lineRows(items){return items.map((v,i)=>`<div class="line-row"><div class="line-description"><span class="concept-label">Concepto / servicio</span><input data-line="description" value="${esc(v.description)}" placeholder="Concepto o servicio" required aria-label="Concepto ${i+1}"><textarea data-line="detail" placeholder="Descripción detallada (opcional)" rows="2" aria-label="Detalle ${i+1}">${esc(v.detail||'')}</textarea></div><label><span>Cantidad</span><input data-line="quantity" type="number" value="${v.quantity}" min="0.001" step="0.001" required></label><label><span>Precio (€)</span><input data-line="price" type="number" value="${v.price}" min="0" step="0.01" required></label><button type="button" class="icon-btn danger" data-remove-line aria-label="Quitar concepto ${i+1}">${icon('trash')}</button></div>`).join('')}
function documentPreview(d){const c=clientFor(d),t=totals(d),company=d.companySnapshot||state.company;return `<article class="paper"><div class="paper-header"><img class="document-brand" src="${documentLogo}" alt="Orquívia"><div><h2>${d.kind==='invoice'?'FACTURA':'PRESUPUESTO'}</h2><p>Número: <strong>${esc(docName(d))}</strong><br>Fecha: ${formatDate(d.date)}</p></div></div><div class="paper-parties"><div><small>${d.kind==='invoice'?'Factura de':'Presupuesto de'}</small><strong>${esc(company.legalName||company.name)}</strong><span>${esc(company.taxId||'NIF / CIF por completar')}</span><span>${esc(company.address||'Dirección por completar')}</span><span>${esc(company.email)}</span></div><div class="paper-client"><small>Cliente</small><strong>${esc(c.name)}</strong><span>${esc(c.taxId)}</span><span>${esc(c.address)}</span><span>${esc(c.email)}</span></div></div><table class="paper-table"><thead><tr><th>CONCEPTO</th><th>CANT.</th><th>PRECIO</th><th>SUBTOTAL</th></tr></thead><tbody>${d.items.map(v=>`<tr><td><strong>${esc(v.description||'Tu concepto')}</strong>${v.detail?`<p>${esc(v.detail)}</p>`:''}</td><td>${v.quantity||0}</td><td>${money(v.price||0)}</td><td>${money(totals({items:[v]}).subtotal)}</td></tr>`).join('')}</tbody></table>${d.po?`<p class="paper-note">PO: ${esc(d.po)}</p>`:''}<div class="paper-totals">${t.discountAmount?`<div><span>Subtotal</span><span>${money(t.subtotal)}</span></div><div><span>Descuento ${d.discount}%</span><span>-${money(t.discountAmount)}</span></div>`:''}<div><span>Base imponible</span><span>${money(t.base)}</span></div><div><span>IVA ${d.vat}%</span><span>${money(t.vatAmount)}</span></div>${t.withholdingAmount?`<div><span>Retención ${d.withholding}%</span><span>-${money(t.withholdingAmount)}</span></div>`:''}<strong>${money(t.total)}</strong></div>${d.notes?`<p class="paper-note">${esc(d.notes)}</p>`:''}<p class="paper-valid">${d.kind==='invoice'?'Vencimiento de pago':'Válido hasta'}: ${formatDate(d.dueDate)}</p><div class="paper-footer"><div><strong>Método de pago</strong><span>${esc(d.paymentMethod||'Transferencia bancaria')}</span></div><div><strong>Cuenta bancaria</strong><span>${esc(company.iban||'IBAN por completar')}</span></div></div>${mode==='demo'?'<div class="paper-demo">DOCUMENTO DE PRUEBA</div>':''}</article>`}
function detailModal(d){const invoice=d.kind==='invoice', payments=state.payments.filter(p=>p.documentId===d.id);openModal(modalHeader(docName(d),clientFor(d).name)+`<div class="detail-layout"><div class="detail-paper">${documentPreview(d)}</div><aside class="detail-sidebar">${d.importWarnings?.length?`<div class="import-warnings"><strong>Revisión del archivo importado</strong>${d.importWarnings.map(w=>`<p>${esc(w)}</p>`).join('')}</div>`:''}<div class="detail-state">${badge(d)}<h3>${money(totals(d).total)}</h3>${invoice?(d.paymentReviewNeeded?'<p>El cobro de esta factura necesita confirmación.</p>':`<p>Pendiente: <strong>${money(outstanding(d,state.payments))}</strong></p>`):''}</div><button class="button primary full" id="pdf-button">${icon('download')}Descargar PDF</button><button class="button secondary full" id="edit-document">${icon('edit')}Editar documento</button>${invoice&&d.status!=='draft'&&outstanding(d,state.payments)>0?`<button class="button secondary full" id="record-payment">${icon('euro')}Registrar cobro</button>`:''}${!invoice&&d.status!=='rejected'?`<button class="button secondary full" id="convert-document">${icon('invoice')}Convertir en factura</button>`:''}${!invoice&&d.status!=='draft'?selectField('Estado del presupuesto','quote-status',[['sent','Enviado'],['accepted','Aceptado'],['rejected','Rechazado']],d.status):''}${invoice&&d.paymentReviewNeeded?'<button class="button secondary full" id="confirm-unpaid">Confirmar que sigue pendiente</button>':''}<div class="detail-box"><h4>${icon('clock')}Fechas de seguimiento</h4><p>${invoice?'Vencimiento':'Válido hasta'}<strong>${formatDate(d.dueDate)}</strong></p><p>Contrato previsto<strong>${formatDate(d.contractExpectedDate)}</strong></p><label class="checkbox-label"><input id="contract-check" type="checkbox" ${d.contractReceived?'checked':''}>Contrato recibido</label></div>${invoice?`<div class="detail-box"><h4>Historial de cobros</h4>${payments.map(p=>`<div class="payment-entry"><div><strong>${money(p.amount)}</strong><small>${formatDate(p.date)}</small><small>${esc(p.reference||'Sin referencia')}</small></div><button class="icon-btn danger" data-delete-payment="${esc(p.id)}" aria-label="Eliminar cobro">${icon('trash')}</button></div>`).join('')||'<p>Todavía no hay cobros registrados.</p>'}</div>`:''}${d.status==='draft'?`<button class="text-button danger" id="delete-document">${icon('trash')}Eliminar borrador</button>`:''}</aside></div>`,true);
  modalRoot.querySelector('#pdf-button').onclick=async()=>{try{const {downloadPDF}=await import('./pdf.js');await downloadPDF(d,d.companySnapshot||state.company,clientFor(d),{logoUrl:documentLogo,demo:mode==='demo'});toast('PDF descargado.')}catch(e){toast('No se pudo generar el PDF: '+e.message,true)}};
  modalRoot.querySelector('#edit-document').onclick=()=>documentModal(d);
  modalRoot.querySelector('#confirm-unpaid')?.addEventListener('click',()=>confirmModal('Confirmar saldo pendiente','Confirma esta opción después de revisar tus registros de cobro. A partir de ahora la factura se incluirá en los vencimientos y en el saldo pendiente.',async()=>{if(await commit(s=>s.documents.find(v=>v.id===d.id).paymentReviewNeeded=false,'Estado del cobro confirmado.'))detailModal(state.documents.find(v=>v.id===d.id))}));

  modalRoot.querySelector('#record-payment')?.addEventListener('click',()=>paymentModal(d));
  modalRoot.querySelector('#convert-document')?.addEventListener('click',async()=>{const existing=state.documents.find(v=>v.quoteId===d.id);if(existing){detailModal(existing);toast('Este presupuesto ya tiene una factura vinculada.');return}const next=createInvoiceFromQuote(d,state.documents,todayISO());delete next.companySnapshot;delete next.clientSnapshot;for(const key of ['sourceMetadata','originalNumber','importWarnings','reviewRequired','paymentReviewNeeded'])delete next[key];next.number='';next.dueDate=addDays(todayISO(),state.company.paymentTerms??30);if(await commit(s=>s.documents.push(next),'Factura creada como borrador.'))documentModal(next)});
  modalRoot.querySelector('[name="quote-status"]')?.addEventListener('change',async e=>{const v=e.target.value;if(await commit(s=>s.documents.find(v=>v.id===d.id).status=v,'Estado actualizado.'))detailModal(state.documents.find(v=>v.id===d.id));else detailModal(d)});
  modalRoot.querySelector('#contract-check').onchange=async e=>{const checked=e.target.checked;if(await commit(s=>updateContract(s,d.id,checked),checked?'Contrato marcado como recibido.':'Contrato marcado como pendiente.'))detailModal(state.documents.find(v=>v.id===d.id));else detailModal(d)};
  modalRoot.querySelectorAll('[data-delete-payment]').forEach(b=>b.onclick=()=>confirmModal('Eliminar registro de cobro','Esta acción quitará el registro del portal y recalculará el saldo pendiente. No realiza movimientos bancarios.',async()=>{if(await commit(s=>s.payments=s.payments.filter(p=>p.id!==b.dataset.deletePayment),'Registro de cobro eliminado.'))detailModal(state.documents.find(v=>v.id===d.id))}));
  modalRoot.querySelector('#delete-document')?.addEventListener('click',()=>{if(payments.length){toast('Esta factura tiene cobros registrados. Elimina los registros de cobro antes de quitarla.',true);return}if(state.documents.some(v=>v.quoteId===d.id)){toast('Este presupuesto tiene una factura vinculada. Conserva el documento para mantener su historial.',true);return}confirmModal('Eliminar '+d.number,'Se eliminará este documento de tu espacio. Esta acción no puede deshacerse.',async()=>{if(await commit(s=>s.documents=s.documents.filter(v=>v.id!==d.id),'Documento eliminado.'))closeModal()})});
}
function paymentModal(d){const remaining=outstanding(d,state.payments);openModal(modalHeader('Registrar cobro',`${d.number} · Pendiente: ${money(remaining)}`)+`<form id="payment-form"><div class="form-grid">${field('Importe recibido (€)','amount',remaining,'number',`min="0.01" max="${remaining}" step="0.01" required`)}${field('Fecha del cobro','date',todayISO(),'date',`min="${d.date}" max="${todayISO()}" required`)}</div>${field('Referencia / nota','reference','','text','placeholder="Transferencia, anticipo, justificante…"')}<p class="field-hint">Confirma el importe recibido en tu cuenta antes de registrarlo. Puedes registrar cobros parciales.</p><div class="modal-actions"><button class="button secondary" type="button" data-close>Cancelar</button><button class="button primary">${icon('check')}Guardar cobro</button></div></form>`);enhanceModal();modalRoot.querySelector('#payment-form').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target),amount=Math.round(Number(f.get('amount'))*100)/100;if(!Number.isFinite(amount)||amount<=0||amount>outstanding(d,state.payments)||f.get('date')>todayISO()||f.get('date')<d.date){toast('Revisa el importe y la fecha del cobro.',true);return}const p={id:crypto.randomUUID(),documentId:d.id,amount,date:f.get('date'),reference:f.get('reference')};if(await commit(s=>{s.payments.push(p);s.documents.find(v=>v.id===d.id).paymentReviewNeeded=false},'Cobro registrado.'))detailModal(state.documents.find(v=>v.id===d.id))}}
function download(content,name,type){const url=URL.createObjectURL(new Blob([content],{type})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
function exportCSV(){const cell=v=>{let text=String(v??'');if(/^[=+\-@\t\r]/.test(text))text="'"+text;return '"'+text.replaceAll('"','""')+'"'};const kind=page==='invoices'?'invoice':'quote';const rows=[['Número','Tipo','Cliente','Emisión','Vencimiento','Base','IVA','Total','Cobrado','Pendiente','Estado'],...state.documents.filter(d=>d.kind===kind).map(d=>{const t=totals(d);return[d.number,d.kind==='invoice'?'Factura':'Presupuesto',clientFor(d).name,d.date,d.dueDate,t.base,t.vatAmount,t.total,d.kind==='invoice'&&!d.paymentReviewNeeded?paidAmount(d,state.payments):'',d.kind==='invoice'&&!d.paymentReviewNeeded?outstanding(d,state.payments):'',statusLabels[status(d,state.payments)]]})];download('\uFEFF'+rows.map(r=>r.map(cell).join(';')).join('\r\n'),`orquivia-${page}-${todayISO()}.csv`,'text/csv;charset=utf-8')}
function loginModal(){lockPrivate()}

function resetPersonal(){
  personalBindingCleanup?.();personalBindingCleanup=null;if(personalPhotoUrl)URL.revokeObjectURL(personalPhotoUrl);
  personalPhotoUrl='';personalProfile=defaultPersonalProfile();personalLoading=false;personalError='';personalBusy=false;
  personalDevice={capability:pushCapability(),ready:false,active:false,config:null};
}
async function loadPersonal(){
  const accountId=user?.id,activeBackend=backend,capturedMode=mode;
  personalLoading=true;personalError='';if(page==='personal')render();
  try{
    const profile=mode==='cloud'?await activeBackend.personal.loadProfile():JSON.parse(localStore.getItem(storageKey+'.profile')||'null')||defaultPersonalProfile();
    if(mode!==capturedMode||user?.id!==accountId||backend!==activeBackend)return;
    personalProfile=profile;
    if(profile.avatar&&mode==='cloud')try{
      const blob=await activeBackend.personal.downloadAvatar(profile.avatar);
      if(mode!==capturedMode||user?.id!==accountId||backend!==activeBackend)return;
      if(personalPhotoUrl)URL.revokeObjectURL(personalPhotoUrl);personalPhotoUrl=URL.createObjectURL(blob);
    }catch{if(mode!==capturedMode||user?.id!==accountId||backend!==activeBackend)return;toast('Tu perfil está cargado, pero no se pudo abrir la foto.',true)}
    await refreshPersonalDevice({renderResult:false});
    if(mode!==capturedMode||user?.id!==accountId||backend!==activeBackend)return;
    personalLoading=false;if(!modalRoot.childElementCount)render();
  }catch(error){
    if(mode!==capturedMode||user?.id!==accountId||backend!==activeBackend)return;
    personalLoading=false;personalError=error.message;if(page==='personal')render();
  }
}
async function refreshPersonalDevice({renderResult=true}={}){
  const accountId=user?.id,activeBackend=backend;personalDevice.capability=pushCapability();
  if(mode!=='cloud')return;
  try{
    const config=await activeBackend.personal.getPushConfig(),subscription=await devicePushSubscription();
    const registrations=subscription?await activeBackend.personal.subscriptions():[];
    if(mode!=='cloud'||user?.id!==accountId||backend!==activeBackend)return;
    personalDevice={capability:pushCapability(),config,checked:true,ready:Boolean(config?.publicKey&&config.configured),active:Boolean(subscription&&registrations.some(r=>r.endpoint===subscription.endpoint))};
  }catch(error){if(mode!=='cloud'||user?.id!==accountId)return;personalDevice={capability:pushCapability(),checked:true,ready:false,active:false,config:null,error:error.message}}
  if(renderResult&&page==='personal'&&!personalBusy&&!modalRoot.childElementCount)render();
}
async function savePersonal(next,{file,removePhoto=false}={}){
  if(mode==='locked')throw new Error('Entra de nuevo para guardar tu perfil.');
  if(personalBusy)throw new Error('Espera a que termine el guardado.');
  if(personalLoading||personalError)throw new Error('Carga tu perfil antes de guardar.');
  const accountId=user?.id,activeBackend=backend,capturedMode=mode,oldAvatar=personalProfile.avatar;
  const candidate=validateProfile(next);let uploaded=null,saved=false;personalBusy=true;
  try{
    if(removePhoto)candidate.avatar=null;
    if(file&&mode==='cloud'){uploaded=await activeBackend.personal.uploadAvatar(file);candidate.avatar=uploaded}
    if(mode!==capturedMode||user?.id!==accountId||backend!==activeBackend)throw new Error('La sesión cambió. Vuelve a entrar para guardar tu perfil.');
    const result=mode==='cloud'?await activeBackend.personal.saveProfile(candidate):candidate;saved=true;
    if(mode!==capturedMode||user?.id!==accountId||backend!==activeBackend)throw new Error('La sesión cambió. Vuelve a entrar para ver tu perfil.');
    personalProfile=result;
    if(mode!=='cloud')localStore.setItem(storageKey+'.profile',JSON.stringify({...result,avatar:null}));
    if(file||removePhoto){if(personalPhotoUrl)URL.revokeObjectURL(personalPhotoUrl);personalPhotoUrl=file?URL.createObjectURL(file):''}
    if(oldAvatar&&(uploaded||removePhoto)&&mode==='cloud')try{await activeBackend.personal.deleteAvatar(oldAvatar)}catch{toast('El perfil se guardó; la foto anterior queda privada y pendiente de limpiar.',true)}
    toast('Tus preferencias y perfil se han guardado.');render();
  }catch(error){if(uploaded&&!saved)try{await activeBackend.personal.deleteAvatar(uploaded)}catch{}throw error}
  finally{personalBusy=false}
}
async function enablePersonalPush(draft=personalProfile,photoOptions={}){
  if(mode!=='cloud'||personalLoading||personalError)throw new Error('Entra en tu cuenta para activar este dispositivo.');
  if(!personalDevice.ready)throw new Error('El servicio de avisos todavía no está preparado.');
  const accountId=user.id,activeBackend=backend;
  const assertOwner=()=>{if(mode!=='cloud'||user?.id!==accountId||backend!==activeBackend)throw new Error('La sesión cambió. Entra de nuevo antes de activar los avisos.');};
  await enableDevicePush({backend:{savePushSubscription:subscription=>{assertOwner();return activeBackend.personal.savePushSubscription(subscription)}},publicKey:personalDevice.config.publicKey});
  assertOwner();
  await savePersonal({...draft,notifications:{...draft.notifications,enabled:true}},photoOptions);
  await refreshPersonalDevice();toast('Este dispositivo recibirá avisos según tus preferencias.');
}
async function disablePersonalPush(){await disableDevicePush({backend:backend.personal});await refreshPersonalDevice({renderResult:false});toast('Avisos desactivados en este dispositivo.');}
function personalContext(){return {getProfile:()=>personalProfile,getDevice:()=>personalDevice,name:()=>profileName(personalProfile,user,mode),save:savePersonal,toast,enablePush:enablePersonalPush,disablePush:disablePersonalPush}}
registerPWA({onOpenAlerts:()=>{if(mode==='locked')pendingAlertView=true;else navTo('reminders')}}).catch(()=>{});

for(const event of ['pointerdown','keydown','touchstart'])document.addEventListener(event,()=>{
  const now=Date.now();
  if(mode==='cloud'&&sessionShouldLock({lastActivityAt,now}))return;
  lastActivityAt=now;if(mode==='cloud')writeActivityTime(sessionStorage,user.id,lastActivityAt);
},{passive:true});
setInterval(async()=>{
  if(mode!=='cloud')return;
  if(sessionShouldLock({lastActivityAt})){try{await backend.signOut()}finally{lockPrivate('La sesión se cerró tras 30 minutos sin actividad.')}return}
  try{await backend.refreshAccess()}catch(e){if(['ACCESS_REVOKED','MFA_REQUIRED','MEMBERSHIP_REQUIRED','AUTH_REQUIRED','AUTH_ERROR','AUTH_CHANGED'].includes(e.code))lockPrivate(e.message)}
},30000);
setInterval(()=>{if(mode!=='locked'&&page!=='personal'&&!modalRoot.childElementCount&&!document.querySelector('[data-receipt-viewer]')&&!busy&&!personalBusy&&!document.activeElement?.closest('input,textarea,select,[role="combobox"]')&&!app.querySelector('[role="combobox"][aria-expanded="true"]')){render()}},60000);
if(window.top!==window.self){app.textContent='Abre Orquívia directamente en su página para iniciar sesión.';}
else if(publicConfigIsValid(config)){
  connectBackend();lockPrivate('',{restoring:true});
  await accessUI.resume();
}else if(production){lockPrivate();}
else{
  mode=demoAllowed?'demo':'local';state=loadDemo();
  if(!demoAllowed&&!localStore.getItem(storageKey))try{
    const res=await fetch('/__local-import',{cache:'no-store'});
    if(res.ok){state=validateState(await res.json());localStore.setItem(storageKey,JSON.stringify(state));}
  }catch(e){toast('No se pudo preparar la importación local: '+e.message,true)}
  restoreNavigation();render();loadPersonal();
}
