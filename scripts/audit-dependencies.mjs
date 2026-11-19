import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const SEVERITIES=['info','low','moderate','high','critical'];
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const own=(value,key)=>Object.hasOwn(value,key);
const fail=message=>{throw new Error(message);};

export function evaluateAuditReport(report) {
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
  if(blocking.length)fail(`Incidencias altas o críticas: ${blocking.join(', ')}.`);
  return {findings:total};
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
    const result=evaluateAuditReport(report);
    console.log(`Audit: sin incidencias altas o críticas (${result.findings} avisos totales).`);
    const lower=Object.entries(report.vulnerabilities).filter(([,finding])=>!['high','critical'].includes(finding.severity));
    for(const [name,finding] of lower)console.warn(`Revisar aviso ${finding.severity}: ${name} (npm audit).`);
    return 0;
  } catch(error) {
    console.error(`Audit bloqueado: ${error.message}`);
    return 1;
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)process.exitCode=await main();
