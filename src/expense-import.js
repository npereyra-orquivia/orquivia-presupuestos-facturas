import JSZip from 'jszip';
import { validateReceiptFile, validateCloudState } from './backend.js';
import { validateWorkspace, todayISO, escapeHTML as esc, money } from './domain.js';

const MAX_PACK_BYTES=150*1024*1024, MAX_TOTAL_BYTES=100*1024*1024, MAX_EXPENSES=500;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH=/^[0-9a-f]{64}$/;
const fields=['id','kind','supplier','supplierTaxId','description','date','reference','category','base','vatAmount','additionalAmount','total','vatRate','vatReviewNeeded','vatDeductibleAmount','reviewNeeded','paymentStatus','paidDate','cashAmount','cashMovements','notes'];
const safePath=value=>typeof value==='string' && !value.includes('\\') && !value.startsWith('/') && value.split('/').every(part=>part&&part!=='.'&&part!=='..') && !/[\u0000-\u001f\u007f]/u.test(value);
const signature=e=>e.reference?.trim()?`${e.supplierTaxId?.trim().toUpperCase()||e.supplier.trim().toUpperCase()}|${e.reference.trim().toUpperCase()}|${e.date}|${e.total}`:null;

// Bound decompression before assembling the file; a compressed archive must not allocate unlimited memory.
async function boundedBytes(entry,limit){
  return new Promise((resolve,reject)=>{
    let size=0,failed=false;const chunks=[],stream=entry.internalStream('uint8array');
    stream.on('data',chunk=>{if(failed)return;size+=chunk.length;if(size>limit){failed=true;stream.pause();reject(new Error('El archivo descomprimido supera el límite permitido.'));return}chunks.push(chunk)});
    stream.on('error',error=>{if(!failed){failed=true;reject(error)}});
    stream.on('end',()=>{if(failed)return;const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}resolve(bytes)});
    stream.resume();
  });
}

export async function prepareExpenseImport(pack,state,organizationId){
  if(!UUID.test(organizationId))throw new Error('Falta la empresa activa para importar.');
  if(!pack||pack.size<=0||pack.size>MAX_PACK_BYTES)throw new Error('El paquete de importación supera 150 MB o está vacío.');
  const zip=await JSZip.loadAsync(await pack.arrayBuffer(),{createFolders:false});
  const entries=Object.values(zip.files).filter(entry=>!entry.dir);
  if(entries.length>MAX_EXPENSES*10+1||entries.some(entry=>!safePath(entry.name)||entry.unsafeOriginalName&&entry.unsafeOriginalName!==entry.name))throw new Error('El paquete contiene rutas o archivos no válidos.');
  const manifestFile=zip.file('manifest.json');if(!manifestFile)throw new Error('Falta manifest.json en el paquete revisado.');
  const manifest=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await boundedBytes(manifestFile,1024*1024)));
  if(manifest?.format!=='orquivia-expenses-v1'||!Array.isArray(manifest.expenses)||!manifest.expenses.length||manifest.expenses.length>MAX_EXPENSES)throw new Error('El paquete de gastos no tiene un formato válido.');
  const usedFiles=new Set(['manifest.json']),ids=new Set(),keys=new Set(),existingIds=new Set((state.expenses||[]).map(e=>e.id)),existingKeys=new Set((state.expenses||[]).map(signature).filter(Boolean));
  const incoming=[],skipped=[],allExpenses=[],fileCache=new Map();let totalBytes=0;
  for(const row of manifest.expenses){
    if(!row?.expense||!Array.isArray(row.receipts)||row.receipts.length<1||row.receipts.length>10)throw new Error('Cada gasto necesita entre uno y diez justificantes.');
    const expense=Object.fromEntries(fields.filter(key=>Object.hasOwn(row.expense,key)).map(key=>[key,row.expense[key]]));
    expense.supplier??='';expense.attachments=[];
    if(!UUID.test(expense.id)||ids.has(expense.id))throw new Error('Hay identificadores de gasto repetidos o no válidos.');ids.add(expense.id);
    const key=signature(expense);if(key&&keys.has(key))throw new Error('El paquete repite un mismo documento de proveedor.');if(key)keys.add(key);
    const receipts=[];
    for(const receipt of row.receipts){
      if(!safePath(receipt.path)||!receipt.path.startsWith('files/')||!HASH.test(receipt.sha256)||typeof receipt.name!=='string'||/[\\/\u0000-\u001f\u007f]/u.test(receipt.name))throw new Error('Hay un justificante sin nombre, ruta o huella válidos.');
      usedFiles.add(receipt.path);
      let stored=fileCache.get(receipt.path);
      if(!stored){
        const entry=zip.file(receipt.path);if(!entry)throw new Error(`Falta el justificante ${receipt.name}.`);
        const bytes=await boundedBytes(entry,10*1024*1024);totalBytes+=bytes.length;if(totalBytes>MAX_TOTAL_BYTES)throw new Error('Los justificantes superan 100 MB. Importa en paquetes más pequeños.');
        const sha=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join('');
        if(sha!==receipt.sha256)throw new Error(`La huella del justificante ${receipt.name} no coincide.`);
        stored={bytes,sha};fileCache.set(receipt.path,stored);
      }
      if(stored.sha!==receipt.sha256)throw new Error('Se ha declarado una huella diferente para el mismo archivo.');
      const file=new File([stored.bytes],receipt.name),info=await validateReceiptFile(file),id=crypto.randomUUID();
      receipts.push(file);expense.attachments.push({id,name:info.name,path:`${organizationId}/${expense.id}/${id}.${info.extension}`,mimeType:info.mimeType,size:info.size});
    }
    allExpenses.push(expense);
    if(existingIds.has(expense.id)||(key&&existingKeys.has(key)))skipped.push(expense);
    else incoming.push({expense,receipts});
  }
  if(entries.some(entry=>!usedFiles.has(entry.name)))throw new Error('El paquete incluye archivos que no pertenecen a los gastos declarados.');
  // All rows, including duplicates, are validated before the first remote upload.
  const errors=[...validateWorkspace({...structuredClone(state),expenses:allExpenses},todayISO()),...validateWorkspace({...structuredClone(state),expenses:[...(state.expenses||[]),...incoming.map(row=>row.expense)]},todayISO())];
  if(errors.length)throw new Error(`Revisa el paquete: ${errors.slice(0,3).join(' ')}`);
  validateCloudState({...structuredClone(state),expenses:[...(state.expenses||[]),...incoming.map(row=>row.expense)]});
  return {incoming,skipped,totalBytes};
}

export async function executeExpenseImport(prepared,{backend,commit,getState,onProgress,checkAccess=()=>{}}){
  const uploaded=[],rows=[];let saved=false;
  try{
    for(const [index,row] of prepared.incoming.entries()){
      checkAccess();const expense={...row.expense,attachments:[]};
      for(const file of row.receipts){checkAccess();const attachment=await backend.uploadReceipt(expense.id,file);uploaded.push(attachment);expense.attachments.push(attachment)}
      rows.push(expense);await onProgress?.(index+1,prepared.incoming.length);
    }
    checkAccess();
    saved=await commit(state=>{
      const existing=state.expenses||[],ids=new Set(existing.map(e=>e.id)),keys=new Set(existing.map(signature).filter(Boolean));
      if(rows.some(e=>ids.has(e.id)||signature(e)&&keys.has(signature(e))))throw new Error('Algún gasto ya se ha importado desde otra sesión. Recarga y vuelve a revisar el paquete.');
      state.expenses=[...existing,...rows];
    });
    if(!saved)throw new Error('La importación no se ha guardado. Los registros anteriores se conservan.');
    return {count:rows.length,attachments:uploaded.length};
  }catch(error){
    // A response may be lost after a successful server commit. Linked objects are never deleted by Storage RLS.
    if(!saved){for(const attachment of uploaded){try{await backend.deleteReceipt(attachment)}catch{}}}
    throw error;
  }
}

export function expenseImportModal(ctx){
  if(ctx.getMode()!=='cloud'){ctx.toast('La importación de originales se realiza en la empresa conectada a Supabase.',true);return}
  ctx.openModal(ctx.modalHeader('Importar gastos revisados','Selecciona un paquete con los datos revisados y sus justificantes originales.')+`<p class="field-hint">El paquete se comprueba antes de subir archivos. Los gastos que ya existan se omiten automáticamente.</p><label class="button secondary import-picker">Seleccionar paquete ZIP<input type="file" id="expense-import-pack" accept=".zip,application/zip"></label><div id="import-preview"></div><p class="import-status" aria-live="polite"></p><div class="form-footer"><button class="button secondary" data-close>Cancelar</button><button class="button primary" id="expense-import-save" disabled>Importar gastos</button></div>`,true);
  const root=ctx.modalRoot,input=root.querySelector('#expense-import-pack'),button=root.querySelector('#expense-import-save'),status=root.querySelector('.import-status'),preview=root.querySelector('#import-preview');
  let prepared=null;
  input.onchange=async()=>{
    prepared=null;button.disabled=true;input.disabled=true;preview.innerHTML='';status.textContent='Comprobando datos y justificantes…';ctx.setBusy(true);
    try{
      const backend=ctx.getBackend(),organizationId=backend.workspaceInfo()?.id||backend.workspaceInfo()?.organizationId;
      prepared=await prepareExpenseImport(input.files[0],ctx.getState(),organizationId);
      const sum=prepared.incoming.reduce((v,row)=>v+row.expense.total,0),reviews=prepared.incoming.filter(row=>row.expense.reviewNeeded||row.expense.vatReviewNeeded).length;
      preview.innerHTML=`<div class="import-summary"><div><strong>${prepared.incoming.length}</strong><span>Gastos nuevos</span></div><div><strong>${money(sum)}</strong><span>Total de documentos</span></div><div><strong>${prepared.skipped.length}</strong><span>Duplicados omitidos</span></div><div><strong>${reviews}</strong><span>Para revisar</span></div></div><div class="import-list">${prepared.incoming.map(({expense:e})=>`<p><strong>${esc(e.description)}</strong> · ${money(e.total)}<small>${esc(e.date)} · ${esc(e.supplier||'Proveedor sin indicar')} · ${e.paymentStatus==='paid'?'Pago documentado':'Pago por confirmar'}${e.vatReviewNeeded?' · IVA por revisar':''}</small></p>`).join('')}</div>`;
      status.textContent=prepared.incoming.length?'Paquete comprobado. Los originales se guardarán en el espacio privado de la empresa.':'Todos los gastos del paquete ya están registrados.';button.disabled=!prepared.incoming.length;
    }catch(error){prepared=null;status.textContent=error.message;ctx.toast(error.message,true)}finally{input.disabled=false;ctx.setBusy(false)}
  };
  button.onclick=async()=>{
    if(!prepared||ctx.isBusy())return;
    const backend=ctx.getBackend();ctx.setBusy(true);root.querySelectorAll('button,input').forEach(control=>control.disabled=true);
    try{
      const result=await executeExpenseImport(prepared,{backend,getState:ctx.getState,checkAccess:()=>{if(ctx.getMode()!=='cloud'||ctx.getBackend()!==backend)throw new Error('La sesión ha cambiado. Inicia sesión de nuevo antes de importar.')},onProgress:(done,total)=>{status.textContent=`Guardando justificantes: ${done} / ${total} gastos…`},commit:async change=>{ctx.setBusy(false);return ctx.commit(change)}});
      ctx.toast(`${result.count} gastos importados con ${result.attachments} justificantes privados.`);ctx.closeModal();
    }catch(error){ctx.toast(error.message,true);status.textContent=error.message;root.querySelectorAll('button,input').forEach(control=>control.disabled=false)}finally{ctx.setBusy(false)}
  };
}
