import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateAuditReport,runNpmAudit} from '../scripts/audit-dependencies.mjs';

const now=Date.parse('2026-11-18T12:00:00Z');
const leaf=()=>({source:1247710,name:'picomatch',dependency:'picomatch',url:'https://github.com/advisories/GHSA-fc5q-39xc-vjpf',range:'<=4.0.7',severity:'high'});
const finding=(name,via)=>({name,severity:'high',nodes:[`node_modules/${name}`],via});
const report=()=>({auditReportVersion:2,vulnerabilities:{
  picomatch:finding('picomatch',[leaf()]),fdir:finding('fdir',['picomatch']),
  tinyglobby:finding('tinyglobby',['fdir','picomatch']),vite:finding('vite',['fdir','picomatch','tinyglobby']),
},metadata:{vulnerabilities:{info:0,low:0,moderate:0,high:4,critical:0,total:4}}});
const lock=()=>({lockfileVersion:3,packages:Object.fromEntries(Object.entries({picomatch:'4.0.7',fdir:'6.5.0',tinyglobby:'0.2.17',vite:'7.3.7'}).map(([name,version])=>[`node_modules/${name}`,{version,dev:true}]))});
const evaluate=(r=report(),l=lock(),date=now)=>evaluateAuditReport(r,l,{now:date});

test('allows only the reviewed advisory and recursively proven development chain',()=>{
  assert.deepEqual(evaluate(),{findings:4,excepted:4});
});

test('the same advisory becomes blocking at its UTC expiry; clean audits still pass',()=>{
  assert.throws(()=>evaluate(report(),lock(),Date.parse('2026-11-25T00:00:00Z')),/caducado/);
  assert.deepEqual(evaluate(report(),lock(),Date.parse('2026-11-24T23:59:59Z')),{findings:4,excepted:4});
  const r={auditReportVersion:2,vulnerabilities:{},metadata:{vulnerabilities:{info:0,low:0,moderate:0,high:0,critical:0,total:0}}};
  assert.deepEqual(evaluate(r,{},Date.parse('2026-12-01')),{findings:0,excepted:0});
  assert.throws(()=>evaluate(r,lock(),NaN),/fecha/);
});

test('fails closed on malformed reports, incomplete metadata and registry errors',()=>{
  for(const r of [null,[],{}, {...report(),auditReportVersion:1},{...report(),error:{code:'ENOAUDIT'}},
    {...report(),metadata:{}},{...report(),vulnerabilities:[]}])assert.throws(()=>evaluate(r));
  for(const mutate of [r=>delete r.vulnerabilities.picomatch.nodes,r=>r.vulnerabilities.picomatch.nodes=[],
    r=>r.vulnerabilities.vite.via=[],r=>r.vulnerabilities.vite.via=[null],r=>r.vulnerabilities.vite.name='different',
    r=>r.metadata.vulnerabilities.high=3,r=>r.metadata.vulnerabilities.total=0]) {
    const r=report();mutate(r);assert.throws(()=>evaluate(r));
  }
});

test('an additional high or critical advisory cannot inherit the package-name exception',()=>{
  for(const severity of ['high','critical']) {
    const r=report();r.vulnerabilities.picomatch.via.push({...leaf(),source:999,url:'https://github.com/advisories/GHSA-other',severity});
    assert.throws(()=>evaluate(r),/Aviso sin excepción/);
  }
  for(const change of [{source:999},{url:'https://example.test/same-title'},{range:'*'},{severity:'critical'},
    {name:'other'},{dependency:'other'}]) {
    const r=report();Object.assign(r.vulnerabilities.picomatch.via[0],change);assert.throws(()=>evaluate(r),/Aviso sin excepción/);
  }
  for(const severity of ['high','critical']) {
    const r=report();r.vulnerabilities.other={...finding('other',[{...leaf(),source:999,severity}]),severity};
    r.metadata.vulnerabilities[severity]++;r.metadata.vulnerabilities.total++;
    assert.throws(()=>evaluate(r),/sin excepción: other/);
  }
});

test('runtime use, changed versions and extra nested copies are outside the exception',()=>{
  for(const name of ['picomatch','fdir','tinyglobby','vite'])for(const change of [{dev:false},{dev:undefined},{version:'99.0.0'}]) {
    const l=lock();Object.assign(l.packages[`node_modules/${name}`],change);assert.throws(()=>evaluate(report(),l),/no cubre/);
  }
  const l=lock();l.packages['node_modules/other/node_modules/picomatch']={version:'4.0.7',dev:true};
  assert.throws(()=>evaluate(report(),l),/otra instalación/);
  assert.throws(()=>evaluate(report(),{}),/package-lock/);
  const r=report();r.vulnerabilities.picomatch.nodes=['node_modules/other/node_modules/picomatch'];assert.throws(()=>evaluate(r),/Nodo/);
});

test('transitive references must resolve without cycles or unknown paths',()=>{
  for(const changes of [{vite:['unknown']},{picomatch:['vite']},{fdir:['tinyglobby'],tinyglobby:['fdir']}]) {
    const r=report();for(const [name,via] of Object.entries(changes))r.vulnerabilities[name].via=via;
    assert.throws(()=>evaluate(r),/Ciclo|sin excepción/);
  }
  const r=report();delete r.vulnerabilities.picomatch;r.metadata.vulnerabilities.high--;r.metadata.vulnerabilities.total--;
  assert.throws(()=>evaluate(r),/sin excepción: picomatch/);
});

test('lower-severity findings remain visible without weakening the existing high threshold',()=>{
  const r=report();r.vulnerabilities.other={...finding('other',[{...leaf(),source:999,severity:'moderate'}]),severity:'moderate'};
  r.metadata.vulnerabilities.moderate++;r.metadata.vulnerabilities.total++;
  assert.deepEqual(evaluate(r),{findings:5,excepted:4});
});

test('npm audit runs through the current npm JS executable, without shell interpolation or dev omission',()=>{
  const env={npm_execpath:'C:\\Path with spaces\\npm-cli.js'};
  let called=false;
  const result=runNpmAudit({env,spawn:(command,args,options)=>{
    called=true;assert.equal(command,process.execPath);assert.deepEqual(args,[env.npm_execpath,'audit','--json','--include=dev']);
    assert.equal(options.shell,false);assert.equal(options.env,env);assert.equal(options.timeout,120_000);
    return {status:1,stdout:JSON.stringify(report())};
  }});
  assert.equal(called,true);assert.deepEqual(result,report());
});

test('failed, interrupted, timed-out and malformed audit executions block publication',()=>{
  assert.throws(()=>runNpmAudit({env:{},spawn:()=>{throw new Error('must not execute');}}),/npm run/);
  for(const result of [{status:2,stdout:'{}'},{status:null,stdout:'{}'},
    {status:1,signal:'SIGTERM',stdout:'{}'},{status:1,error:new Error('timeout'),stdout:'{}'},
    {status:1,stdout:'<html>registry failed</html>'}]) {
    assert.throws(()=>runNpmAudit({env:{npm_execpath:'/test/npm.js'},spawn:()=>result}),/no pudo|JSON válido/);
  }
});
