const MAX_AMOUNT = 1_000_000_000;
const MAX_PLANNING_BYTES = 750_000;
const SETTINGS = ['asOf','horizon','taxYear','corporateTaxRate','corporateTaxConfirmed','legalReservePending','minimumCash','cashBalanceOverride','profitOverride','pendingCosts','people','collectionDates'];
const PERSON = ['id','name','taxProfileKnown','externalSalary','employeeSS','retaAnnual','otherGeneralIncome','employmentExpense','otherSavings','sharePercent','isShareholder','employerContributionRate','retaPeriod','retaYear'];
const ITEM = ['id','label','kind','amountGross','vatRate','vatDeductible','treatment','recurrence','startDate','endDate','active','linkedRecordIds'];
const SCENARIO = ['id','name','people','dividendDate','notes'];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype,null].includes(Object.getPrototypeOf(value));
const precision = value => Math.abs(value * 100 - Math.round(value * 100)) < .00001;
const numeric = (value,min=0,max=MAX_AMOUNT) => typeof value === 'number' && Number.isFinite(value)
  && value >= min && value <= max && precision(value);
const date = value => typeof value === 'string' && /^(19\d{2}|20\d{2}|21\d{2}|2200)-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value+'T00:00:00Z')) && new Date(value+'T00:00:00Z').toISOString().slice(0,10) === value;
const unicode = value => { if(typeof value!=='string')return false;try{encodeURIComponent(value);return true;}catch{return false;} };
const id = (value,max=140) => unicode(value) && Array.from(value).length > 0 && Array.from(value).length <= max
  && value.trim() === value && !/\p{Cc}/u.test(value);
const text = (value,max,required=false) => unicode(value) && Array.from(value).length <= max
  && (!required || value.trim().length > 0) && !/\p{Cc}/u.test(value.replace(/[\n\t\r]/g,''));
const shape = (value,keys) => plain(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value,key)) && Object.keys(value).every(key => keys.includes(key));
const list = (value,max) => Array.isArray(value) && value.length <= max;
const uniqueIds = rows => new Set(rows.map(row=>row.id)).size === rows.length;

/** Strict transport boundary. All plans remain simulations, separate from issued records. */
export function validatePlanningState(value) {
  const fail = detail => { throw new Error(`La previsión no es válida: ${detail}.`); };
  if (!shape(value,['version','settings','items','scenarios']) || value.version !== 1) fail('formato incompatible');
  const s = value.settings;
  if (!shape(s,SETTINGS)) fail('configuración incompatible');
  if (!date(s.asOf) || !date(s.horizon) || s.asOf > s.horizon
    || (Date.parse(s.horizon+'T00:00:00Z')-Date.parse(s.asOf+'T00:00:00Z'))/86400000 > 3653) fail('fechas fuera del intervalo permitido');
  if (!Number.isInteger(s.taxYear) || s.taxYear < 1900 || s.taxYear > 2200
    || !numeric(s.corporateTaxRate,0,35) || typeof s.corporateTaxConfirmed !== 'boolean'
    || !numeric(s.legalReservePending) || !numeric(s.minimumCash)
    || ![null].includes(s.cashBalanceOverride) && !numeric(s.cashBalanceOverride,-MAX_AMOUNT)
    || ![null].includes(s.profitOverride) && !numeric(s.profitOverride,-MAX_AMOUNT)
    || !['gross','exclude'].includes(s.pendingCosts)) fail('importes o ejercicio incorrectos');
  if (!list(s.people,8) || s.people.length === 0 || !s.people.every(p=>shape(p,PERSON)) || !uniqueIds(s.people)) fail('personas repetidas o incompatibles');
  for (const p of s.people) {
    if (!id(p.id) || !text(p.name,120,true) || typeof p.taxProfileKnown !== 'boolean' || typeof p.isShareholder !== 'boolean'
      || !['externalSalary','employeeSS','retaAnnual','otherGeneralIncome','employmentExpense','otherSavings'].every(key=>numeric(p[key]))
      || !numeric(p.sharePercent,0,100) || !numeric(p.employerContributionRate,0,100)
      || !['initial','extension','ordinary'].includes(p.retaPeriod)
      || !Number.isInteger(p.retaYear) || p.retaYear < 1900 || p.retaYear > 2200) fail('datos personales incorrectos');
  }
  if (s.people.reduce((sum,p)=>sum+p.sharePercent,0)>100.000001) fail('participaciones superiores al 100 %');
  if (!plain(s.collectionDates) || Object.keys(s.collectionDates).length>500
    || !Object.entries(s.collectionDates).every(([key,value])=>id(key,160)&&!['__proto__','constructor','prototype'].includes(key)&&date(value))) fail('fechas de cobro incorrectas');
  if (!list(value.items,300) || !value.items.every(item=>shape(item,ITEM)) || !uniqueIds(value.items)) fail('partidas repetidas o incompatibles');
  for (const item of value.items) {
    if (!id(item.id) || !text(item.label,200,true) || !['expense','income'].includes(item.kind) || !numeric(item.amountGross)
      || item.vatRate !== null && !numeric(item.vatRate,0,100) || typeof item.vatDeductible !== 'boolean'
      || !['operating','asset','tax','transfer'].includes(item.treatment)
      || !['once','monthly','quarterly','yearly'].includes(item.recurrence)
      || !date(item.startDate) || item.endDate !== null && (!date(item.endDate) || item.endDate < item.startDate)
      || typeof item.active !== 'boolean' || !list(item.linkedRecordIds,500)
      || !item.linkedRecordIds.every(value=>id(value,160)) || new Set(item.linkedRecordIds).size!==item.linkedRecordIds.length) fail('partida incorrecta');
  }
  if (!list(value.scenarios,50) || !value.scenarios.every(scenario=>shape(scenario,SCENARIO)) || !uniqueIds(value.scenarios)) fail('escenarios repetidos o incompatibles');
  const people = new Set(s.people.map(p=>p.id));
  for (const scenario of value.scenarios) {
    if (!id(scenario.id) || !text(scenario.name,120,true) || !text(scenario.notes,2000)
      || scenario.dividendDate !== null && !date(scenario.dividendDate)
      || !list(scenario.people,8) || !scenario.people.every(p=>shape(p,['personId','workGross','dividendGross']))
      || new Set(scenario.people.map(p=>p.personId)).size!==scenario.people.length
      || !scenario.people.every(p=>people.has(p.personId)&&numeric(p.workGross)&&numeric(p.dividendGross))) fail('reparto de escenario incorrecto');
  }
  const serialized = JSON.stringify(value);
  if (new TextEncoder().encode(serialized).byteLength > MAX_PLANNING_BYTES) fail('supera el tamaño permitido');
  return JSON.parse(serialized);
}

export function planningValidationErrors(value) {
  try { validatePlanningState(value); return []; }
  catch (error) { return [error.message]; }
}
