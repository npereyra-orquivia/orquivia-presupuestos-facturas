import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,unlink,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {evaluateAuditReport,runNpmAudit,main} from '../scripts/audit-dependencies.mjs';

const severities=['info','low','moderate','high','critical'];
const finding=(name,severity='high',via)=>({name,severity,nodes:[`node_modules/${name}`],via:via||[{
  source:999,name,dependency:name,url:'https://example.test/advisory',range:'*',severity,
}]});
const report=(vulnerabilities={})=>({auditReportVersion:2,vulnerabilities,metadata:{vulnerabilities:{
  ...Object.fromEntries(severities.map(severity=>[severity,Object.values(vulnerabilities).filter(row=>row.severity===severity).length])),
  total:Object.keys(vulnerabilities).length,
}}});
const blocked=()=>report({other:finding('other')});

test('a complete clean audit passes without any package-specific exception',()=>{
  assert.deepEqual(evaluateAuditReport(report()),{findings:0});
});

test('high and critical advisories block both runtime and development dependencies',()=>{
  for(const severity of ['high','critical'])for(const scope of ['runtime-library','development-tool']) {
    const r=report({[scope]:finding(scope,severity)});
    r.metadata.dependencies={prod:scope==='runtime-library'?1:0,dev:scope==='development-tool'?1:0};
    assert.throws(()=>evaluateAuditReport(r),new RegExp(`altas o críticas: ${scope}`));
  }
});

test('the formerly excepted picomatch advisory and its ancestors block if reported again',()=>{
  const leaf={source:1247710,name:'picomatch',dependency:'picomatch',url:'https://github.com/advisories/GHSA-fc5q-39xc-vjpf',range:'<=4.0.7',severity:'high'};
  const r=report({picomatch:finding('picomatch','high',[leaf]),fdir:finding('fdir','high',['picomatch']),
    tinyglobby:finding('tinyglobby','high',['fdir','picomatch']),vite:finding('vite','high',['fdir','picomatch','tinyglobby'])});
  assert.throws(()=>evaluateAuditReport(r),/altas o críticas: picomatch, fdir, tinyglobby, vite/);
});

test('fails closed on malformed reports, incomplete metadata and registry errors',()=>{
  for(const r of [null,[],{}, {...report(),auditReportVersion:1},{...report(),error:{code:'ENOAUDIT'}},
    {...report(),metadata:{}},{...report(),vulnerabilities:[]}])assert.throws(()=>evaluateAuditReport(r),/malformado/);
  for(const mutate of [r=>delete r.vulnerabilities.other.nodes,r=>r.vulnerabilities.other.nodes=[],
    r=>r.vulnerabilities.other.nodes=[null],r=>r.vulnerabilities.other.nodes=[''],
    r=>r.vulnerabilities.other.via=[],r=>r.vulnerabilities.other.via=[null],
    r=>r.vulnerabilities.other.name='different',r=>r.vulnerabilities.other.severity='unknown',
    r=>delete r.vulnerabilities.other.severity]) {
    const r=blocked();mutate(r);assert.throws(()=>evaluateAuditReport(r),/Estructura/);
  }
});

test('missing, inconsistent and nonnumeric severity totals cannot hide findings',()=>{
  for(const severity of severities)for(const replacement of [undefined,-1,1,'0',NaN]) {
    const r=report();r.metadata.vulnerabilities[severity]=replacement;
    assert.throws(()=>evaluateAuditReport(r),/Recuento/);
  }
  for(const total of [undefined,-1,1,'0',NaN]) {
    const r=report();r.metadata.vulnerabilities.total=total;
    assert.throws(()=>evaluateAuditReport(r),/Recuento/);
  }
  const r=blocked();r.metadata.vulnerabilities.high=0;r.metadata.vulnerabilities.total=0;
  assert.throws(()=>evaluateAuditReport(r),/Recuento/);
});

test('lower-severity findings remain counted and visible without blocking publication',async t=>{
  const r=report(Object.fromEntries(['info','low','moderate'].map(severity=>[severity,finding(severity,severity)])));
  assert.deepEqual(evaluateAuditReport(r),{findings:3});
  const directory=await mkdtemp(join(tmpdir(),'orquivia-audit-'));
  const cli=join(directory,'npm-cli.cjs');
  const previousNpm=process.env.npm_execpath;
  const messages=[],warnings=[];
  t.mock.method(console,'log',message=>messages.push(message));
  t.mock.method(console,'warn',message=>warnings.push(message));
  try {
    await writeFile(cli,`process.stdout.write(${JSON.stringify(JSON.stringify(r))});`);
    process.env.npm_execpath=cli;
    assert.equal(await main(),0);
    assert.deepEqual(messages,['Audit: sin incidencias altas o críticas (3 avisos totales).']);
    assert.deepEqual(warnings,['Revisar aviso info: info (npm audit).','Revisar aviso low: low (npm audit).','Revisar aviso moderate: moderate (npm audit).']);
  } finally {
    if(previousNpm===undefined)delete process.env.npm_execpath;else process.env.npm_execpath=previousNpm;
    await unlink(cli);await rmdir(directory);
  }
});

test('npm audit runs through the current npm JS executable, without shell interpolation or dev omission',()=>{
  const env={npm_execpath:'C:\\Path with spaces\\npm-cli.js'};
  for(const status of [0,1]) {
    let called=false;
    const result=runNpmAudit({env,spawn:(command,args,options)=>{
      called=true;assert.equal(command,process.execPath);assert.deepEqual(args,[env.npm_execpath,'audit','--json','--include=dev']);
      assert.equal(options.shell,false);assert.equal(options.env,env);assert.equal(options.timeout,120_000);
      return {status,stdout:JSON.stringify(status?blocked():report())};
    }});
    assert.equal(called,true);assert.deepEqual(result,status?blocked():report());
  }
});

test('failed, interrupted, timed-out and malformed audit executions block publication',()=>{
  assert.throws(()=>runNpmAudit({env:{},spawn:()=>{throw new Error('must not execute');}}),/npm run/);
  for(const result of [{status:2,stdout:'{}'},{status:null,stdout:'{}'},
    {status:1,signal:'SIGTERM',stdout:'{}'},{status:1,error:new Error('timeout'),stdout:'{}'},
    {status:1,stdout:'<html>registry failed</html>'},{status:0,stdout:''}]) {
    assert.throws(()=>runNpmAudit({env:{npm_execpath:'/test/npm.js'},spawn:()=>result}),/no pudo|JSON válido/);
  }
});
