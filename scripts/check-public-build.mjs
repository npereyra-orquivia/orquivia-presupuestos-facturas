import fs from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve('dist'),files=[];
async function walk(dir){for(const entry of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,entry.name);if(entry.isDirectory())await walk(p);else files.push(p)}}
await walk(root);
if(files.some(p=>/initial-state|private|\.env|credentials|\.(pdf|docx?|xlsx?|rar|zip)$/i.test(path.relative(root,p))))throw new Error('El resultado público contiene un archivo privado.');
let privateState=null;try{privateState=JSON.parse(await fs.readFile('private/initial-state.json','utf8'))}catch{}
const sensitive=privateState?[privateState.company.iban,privateState.company.taxId,...privateState.clients.flatMap(c=>[c.name,c.taxId,c.email])].filter(s=>typeof s==='string'&&s.length>=8):[];
try{const imported=JSON.parse(await fs.readFile('private/imports/orquivia-expenses/manifest.json','utf8'));sensitive.push(...imported.expenses.flatMap(row=>[row.expense.supplierTaxId,row.expense.id,...row.receipts.map(receipt=>receipt.sha256)]).filter(value=>typeof value==='string'&&value.length>=8))}catch(error){if(error.code!=='ENOENT')throw error}
for(const file of files.filter(p=>/\.(js|html|css|json)$/i.test(p))){const text=await fs.readFile(file,'utf8');if(/sb_secret_[A-Za-z0-9_-]+/.test(text))throw new Error('El build contiene una clave secreta.');if(sensitive.some(value=>text.includes(value)))throw new Error('El build público contiene datos de los documentos privados.');}
console.log('Comprobación pública correcta: sin documentos, datos importados ni claves secretas.');
