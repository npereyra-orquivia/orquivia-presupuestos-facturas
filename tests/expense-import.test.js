import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {prepareExpenseImport,executeExpenseImport} from '../src/expense-import.js';

const org='00000000-0000-4000-8000-000000000001',id='00000000-0000-4000-8000-000000000002';
const state=()=>({company:{name:'Orquívia'},clients:[],documents:[],payments:[],expenses:[]});
const receiptBytes=new TextEncoder().encode('%PDF-1.7\nTest original receipt');
const hash=async bytes=>Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');
async function pack(change=()=>{},extra={}){
  const manifest={format:'orquivia-expenses-v1',expenses:[{expense:{id,supplier:'Proveedor',description:'Gasto original',date:'2026-03-01',base:100,vatAmount:21,total:121,paymentStatus:'paid',paidDate:'2026-03-02',vatDeductibleAmount:0,reviewNeeded:false},receipts:[{name:'Original.pdf',path:'files/original.pdf',sha256:await hash(receiptBytes)}]}]};
  change(manifest);const zip=new JSZip();zip.file('manifest.json',JSON.stringify(manifest));zip.file('files/original.pdf',receiptBytes);for(const [name,bytes] of Object.entries(extra))zip.file(name,bytes);return new File([await zip.generateAsync({type:'uint8array'})],'Reviewed.zip');
}
test('import verifies original bytes, preserves existing state and omits repeat imports',async()=>{
  const current=state(),prepared=await prepareExpenseImport(await pack(),current,org);
  assert.equal(prepared.incoming.length,1);assert.equal(prepared.incoming[0].receipts[0].size,receiptBytes.length);assert.deepEqual(current.expenses,[]);
  const repeated=await prepareExpenseImport(await pack(),{...current,expenses:[prepared.incoming[0].expense]},org);
  assert.equal(repeated.incoming.length,0);assert.equal(repeated.skipped.length,1);
});
test('tampered, orphaned, invalid and traversing documents fail before upload',async()=>{
  await assert.rejects(prepareExpenseImport(await pack(m=>m.expenses[0].receipts[0].sha256='0'.repeat(64)),state(),org),/huella/);
  await assert.rejects(prepareExpenseImport(await pack(()=>{},{'files/orphan.pdf':receiptBytes}),state(),org),/no pertenecen/);
  await assert.rejects(prepareExpenseImport(await pack(m=>m.expenses[0].expense.total=999),state(),org),/paquete/);
  await assert.rejects(prepareExpenseImport(await pack(m=>m.expenses[0].receipts[0].path='../original.pdf'),state(),org),/ruta/);
});
test('a failed atomic save cleans only new objects and leaves old records intact',async()=>{
  const prepared=await prepareExpenseImport(await pack(),state(),org),deleted=[];let savedSnapshot;
  const backend={uploadReceipt:async(expenseId,file)=>({...prepared.incoming[0].expense.attachments[0],name:file.name}),deleteReceipt:async a=>deleted.push(a.path)};
  await assert.rejects(executeExpenseImport(prepared,{backend,commit:async change=>{savedSnapshot=state();change(savedSnapshot);return false}}),/no se ha guardado/);
  assert.equal(savedSnapshot.expenses.length,1);assert.equal(deleted.length,1);
});
test('successful import appends receipts with no deletion and refuses a concurrent duplicate',async()=>{
  const prepared=await prepareExpenseImport(await pack(),state(),org);let deletions=0;
  const backend={uploadReceipt:async()=>prepared.incoming[0].expense.attachments[0],deleteReceipt:async()=>{deletions++}};
  const current=state();const result=await executeExpenseImport(prepared,{backend,commit:async change=>{change(current);return true}});
  assert.equal(result.count,1);assert.equal(current.expenses.length,1);assert.equal(deletions,0);
  await assert.rejects(executeExpenseImport(prepared,{backend,commit:async change=>{change(current);return true}}),/ya se ha importado/);
  assert.equal(current.expenses.length,1);
});
