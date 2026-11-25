import { validatePlanningState } from './planning-state.js';

const MAX_BYTES=1_000_000;
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const shape=(value,keys)=>plain(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const unicode=value=>{if(typeof value!=='string')return false;try{encodeURIComponent(value);return true;}catch{return false;}};
const identifier=value=>unicode(value)&&Array.from(value).length>0&&Array.from(value).length<=140&&value.trim()===value&&!/\p{Cc}/u.test(value);
const label=value=>unicode(value)&&Array.from(value).length<=200&&value.trim().length>0&&!/\p{Cc}/u.test(value.replace(/[\n\r\t]/g,''));
const number=(value,max=1_000_000_000)=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=max&&Math.abs(value*100-Math.round(value*100))<.00001;
const list=(value,max)=>Array.isArray(value)&&value.length<=max;
const cents=value=>BigInt(Math.round(value*100));
const OPERATION_KEYS=['id','label','kind','personId','amount','deductible','employeeSSRate','employerSSRate','withholdingRate','vatRate','taxTreatmentConfirmed'];
const KINDS=['salary','administrator','professional','dividend','expense','legacy-work'];

/** Extra simulation operations live beside planning v1, preserving old-client reads. */
export function validatePlanningExtensions(value,planning){
  const fail=detail=>{throw new Error(`Las operaciones de la simulación no son válidas: ${detail}.`);};
  const base=validatePlanningState(planning);
  if(!shape(value,['version','people','scenarios'])||value.version!==1)fail('formato incompatible');
  const people=new Set(base.settings.people.map(p=>p.id)),scenarios=new Map(base.scenarios.map(s=>[s.id,s]));
  if(!list(value.people,8)||!value.people.every(p=>shape(p,['personId','taxRegion']))
    ||new Set(value.people.map(p=>p.personId)).size!==value.people.length
    ||!value.people.every(p=>identifier(p.personId)&&people.has(p.personId)&&['catalonia','other'].includes(p.taxRegion)))fail('perfiles fiscales incorrectos');
  if(!list(value.scenarios,50)||!value.scenarios.every(s=>shape(s,['scenarioId','operations']))
    ||new Set(value.scenarios.map(s=>s.scenarioId)).size!==value.scenarios.length)fail('escenarios repetidos o incompatibles');
  for(const entry of value.scenarios){
    if(!identifier(entry.scenarioId)||!scenarios.has(entry.scenarioId)||!list(entry.operations,50)
      ||!entry.operations.every(op=>shape(op,OPERATION_KEYS))
      ||new Set(entry.operations.map(op=>op.id)).size!==entry.operations.length)fail('operaciones repetidas o escenario inexistente');
    const aggregate=new Map([...people].map(id=>[id,{work:0n,dividend:0n}]));
    for(const op of entry.operations){
      if(!identifier(op.id)||!label(op.label)||!KINDS.includes(op.kind)||!number(op.amount)
        ||typeof op.deductible!=='boolean'||typeof op.taxTreatmentConfirmed!=='boolean'
        ||!number(op.employeeSSRate,100)||!number(op.employerSSRate,100)
        ||op.withholdingRate!==null&&!number(op.withholdingRate,100)||op.vatRate!==null&&!number(op.vatRate,100))fail('campos o importes incorrectos');
      if(op.kind==='expense'){if(op.personId!==null)fail('un gasto simulado no puede asignarse a una persona');}
      else{
        if(!identifier(op.personId)||!people.has(op.personId))fail('persona inexistente en una operación');
        aggregate.get(op.personId)[op.kind==='dividend'?'dividend':'work']+=cents(op.amount);
      }
    }
    const allocations=new Map(scenarios.get(entry.scenarioId).people.map(p=>[p.personId,p]));
    for(const [id,total] of aggregate){
      const row=allocations.get(id);
      if(total.work!==cents(row?.workGross||0)||total.dividend!==cents(row?.dividendGross||0)){
        throw Object.assign(new Error('Actualiza la página para modificar este escenario; contiene operaciones de una versión más reciente.'),{code:'PLANNING_CLIENT_UPDATE_REQUIRED'});
      }
    }
  }
  const serialized=JSON.stringify(value);
  if(new TextEncoder().encode(serialized).byteLength>MAX_BYTES)fail('se supera el límite de 1 MB');
  return JSON.parse(serialized);
}

export function planningExtensionsValidationErrors(value,planning){
  try{validatePlanningExtensions(value,planning);return [];}catch(error){return [error.message];}
}
