import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const EXPIRES_AT=Date.parse('2026-11-25T00:00:00Z');
const ADVISORY_URL='https://github.com/advisories/GHSA-fc5q-39xc-vjpf';
const VERSIONS=Object.freeze({picomatch:'4.0.7',fdir:'6.5.0',tinyglobby:'0.2.17',vite:'7.3.7'});
const SEVERITIES=['info','low','moderate','high','critical'];
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const own=(value,key)=>Object.hasOwn(value,key);
const fail=message=>{throw new Error(message);};

// Only the single advisory leaf is excepted. Ancestor findings must resolve to
// that leaf through the audited graph; package names alone never waive alerts.
export function evaluateAuditReport(report,lock,{now=Date.now()}={}) {
  if(!Number.isFinite(now))fail('No se pudo comprobar la fecha de la excepción.');
  if(!object(report)||report.auditReportVersion!==2||own(report,'error')||!object(report.vulnerabilities)
    ||!object(report.metadata)||!object(report.metadata.vulnerabilities))fail('Informe npm audit malformado o incompleto.');
  const findings=report.vulnerabilities;
  const counts=Object.fromEntries(SEVERITIES.map(severity=>[severity,0]));
  for(const [name,finding] of Object.entries(findings)) {
    if(!object(finding)||finding.name!==name||!SEVERITIES.includes(finding.severity)
      ||!Array.isArray(finding.via)||!finding.via.length||!Array.isArray(finding.nodes)||!finding.nodes.length
      ||finding.nodes.some(node=>typeof node!=='string'||!node)
      ||finding.via.some(via=>typeof via!=='string'&&!object(via)))fail('Estructura de vulnerabilidad no reconocida.');
    counts[finding.severity]++;
  }
  const total=Object.keys(findings).length;
  for(const severity of SEVERITIES)if(report.metadata.vulnerabilities[severity]!==counts[severity])fail('Recuento npm audit incoherente.');
  if(report.metadata.vulnerabilities.total!==total)fail('Recuento npm audit incoherente.');
  const blocking=Object.keys(findings).filter(name=>['high','critical'].includes(findings[name].severity));
  // An expired waiver does not block an already patched, clean dependency tree.
  if(!blocking.length)return {findings:total,excepted:0};
  if(now>=EXPIRES_AT)fail('La excepción temporal de picomatch ha caducado; revisar y actualizar dependencias.');
  if(!object(lock)||lock.lockfileVersion!==3||!object(lock.packages))fail('package-lock.json no reconocido.');
  // Pin the complete reviewed development-only chain, including nodes which a
  // future audit response might no longer list as transitive findings.
  for(const [name,version] of Object.entries(VERSIONS)) {
    const path=`node_modules/${name}`,entry=lock.packages[path];
    if(!object(entry)||entry.version!==version||entry.dev!==true)fail(`La excepción no cubre la versión o el uso en producción de ${name}.`);
    if(Object.keys(lock.packages).some(key=>key!==path&&key.endsWith(`/node_modules/${name}`)))fail(`Existe otra instalación no revisada de ${name}.`);
  }
  const resolved=new Set();
  function check(name,ancestors=new Set()) {
    if(ancestors.has(name))fail('Ciclo en las dependencias del informe npm audit.');
    if(resolved.has(name))return;
    if(!own(findings,name)||!own(VERSIONS,name))fail(`Vulnerabilidad sin excepción: ${name}.`);
    const finding=findings[name];
    if(finding.severity!=='high'||finding.nodes.length!==1||finding.nodes[0]!==`node_modules/${name}`)fail(`Nodo o gravedad no cubiertos: ${name}.`);
    const next=new Set(ancestors);next.add(name);
    for(const via of finding.via) {
      if(typeof via==='string')check(via,next);
      else if(name!=='picomatch'||finding.via.length!==1||via.source!==1247710
        ||via.url!==ADVISORY_URL||via.name!=='picomatch'||via.dependency!=='picomatch'
        ||via.range!=='<=4.0.7'||via.severity!=='high')fail(`Aviso sin excepción: ${name}.`);
    }
    resolved.add(name);
  }
  for(const name of blocking)check(name);
  return {findings:total,excepted:blocking.length};
}

export function runNpmAudit({env=process.env,spawn=spawnSync}={}) {
  // npm supplies its own JS entry point when invoked by `npm run audit:security`.
  // Passing it as an argument handles Windows paths with spaces without a shell.
  if(typeof env.npm_execpath!=='string'||!env.npm_execpath)fail('Ejecuta esta comprobación con npm run audit:security.');
  const result=spawn(process.execPath,[env.npm_execpath,'audit','--json','--include=dev'],{
    shell:false,encoding:'utf8',timeout:120_000,maxBuffer:10*1024*1024,env,windowsHide:true,
  });
  if(result.error||result.signal||![0,1].includes(result.status))fail('npm audit no pudo completarse; la publicación permanece bloqueada.');
  try{return JSON.parse(result.stdout);}catch{fail('npm audit no devolvió JSON válido; la publicación permanece bloqueada.');}
}

export async function main() {
  try {
    const report=runNpmAudit();
    const lock=JSON.parse(await readFile(new URL('../package-lock.json',import.meta.url),'utf8'));
    const result=evaluateAuditReport(report,lock);
    console.log(result.excepted
      ?`Audit: ${result.excepted} avisos derivados exclusivamente de GHSA-fc5q-39xc-vjpf, excepción de desarrollo hasta 2026-11-25 UTC. Ver docs/CI-SECURITY.md.`
      :`Audit: sin incidencias altas o críticas (${result.findings} avisos totales).`);
    const lower=Object.entries(report.vulnerabilities).filter(([,finding])=>!['high','critical'].includes(finding.severity));
    for(const [name,finding] of lower)console.warn(`Revisar aviso ${finding.severity}: ${name} (npm audit).`);
    return 0;
  } catch(error) {
    console.error(`Audit bloqueado: ${error.message}`);
    return 1;
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)process.exitCode=await main();
