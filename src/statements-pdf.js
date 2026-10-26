import { jsPDF } from 'jspdf';
import { money, todayISO } from './domain.js';
import { normalizeOrquivia } from './brand.js';

const clean=value=>String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').replace(/[\u2010-\u2015\u2212]/g,'-').replace(/[\u00a0\u202f]/g,' ');
const known=value=>typeof value==='number'&&Number.isFinite(value);
const amount=value=>known(value)?clean(money(value)):'Por completar';
const date=value=>/^\d{4}-\d{2}-\d{2}$/.test(value || '')?value.split('-').reverse().join('/'):'Por completar';
const ink=[27,48,42],muted=[104,118,110],pale=[241,245,239],amber=[116,92,43];

/** Vector report. Missing data never becomes zero or a balancing equity entry. */
export function createStatementsPDF({company={},profitLoss:p,balance:b,logoData,generatedAt=todayISO(),demo=false}) {
  if(!p?.range||!Array.isArray(p.lines)||!b?.summary||!Array.isArray(b.assets)||!Array.isArray(b.liabilities))throw new Error('Faltan datos para preparar los estados financieros.');
  company={...company,name:normalizeOrquivia(company.name),legalName:normalizeOrquivia(company.legalName)};
  const pdf=new jsPDF({unit:'mm',format:'a4',compress:true}),left=19,right=191,width=172,bottom=271;
  const name=clean(company.legalName||company.name||'Orquivia');
  const generated=String(generatedAt).slice(0,10);
  pdf.setProperties({title:`Estados financieros provisionales - ${name} - ${date(b.asOf)}`,author:name,creator:'Orquivia'});
  let y=0;
  const shownSources=new Set();
  function text(value,x,y,size=9,{color=ink,style='normal',align='left'}={}){pdf.setFont('helvetica',style);pdf.setFontSize(size);pdf.setTextColor(...color);pdf.text(clean(value),x,y,{align});}
  function wrap(value,maxWidth=width,size=9,style='normal'){pdf.setFont('helvetica',style);pdf.setFontSize(size);return pdf.splitTextToSize(clean(value),maxWidth);}
  function nextPage(){pdf.addPage();text(name,left,18,9,{style:'bold'});text(`Fecha de corte: ${date(b.asOf)}`,right,18,8,{align:'right',color:muted});pdf.setDrawColor(217,226,217);pdf.line(left,23,right,23);y=33;}
  function ensure(height){if(y+height>bottom)nextPage();}
  function paragraph(value,{size=9,color=muted,step=4.5,gap=6}={}){const lines=wrap(value,width,size);for(const line of lines){ensure(step+1);text(line,left,y,size,{color});y+=step;}y+=gap;}
  function section(title,subtitle){ensure(subtitle?24:16);text(title,left,y,13,{style:'bold'});y+=8;if(subtitle)paragraph(subtitle,{size:9,gap:5});}
  function subheading(title){ensure(15);text(title,left,y,10,{style:'bold'});y+=8;}
  function source(value){if(value&&!shownSources.has(value)){shownSources.add(value);paragraph(value,{size:7,step:3.7,gap:3});}}
  function row(label,value,{total=false}={}){
    const lines=wrap(label,125,9,total?'bold':'normal');let consumed=0;
    while(consumed<lines.length){
      if(y+10>bottom)nextPage();
      const available=Math.max(1,Math.floor((bottom-y-5)/4.4)),chunk=lines.slice(consumed,consumed+available),height=Math.max(9,chunk.length*4.4+5);
      if(total){pdf.setFillColor(...pale);pdf.rect(left-1,y-4,width+2,height,'F');}
      chunk.forEach((line,index)=>text(line,left+1,y+index*4.4,9,{style:total?'bold':'normal'}));
      if(consumed===0)text(amount(value),right-1,y,known(value)?10:8,{align:'right',color:known(value)?ink:amber,style:total?'bold':'normal'});
      y+=height;consumed+=chunk.length;
    }
    pdf.setDrawColor(231,236,229);pdf.line(left,y-3,right,y-3);
  }
  function issue(entry){
    const value=known(entry.amount)?amount(entry.amount):'Por completar';
    const label=[entry.label||entry.description||'Por revisar',entry.date?date(entry.date):''].filter(Boolean).join(' - ');
    const lines=wrap(label,132,8);let consumed=0;
    const fullHeight=Math.max(10,lines.length*4+5);if(fullHeight<=bottom-33)ensure(fullHeight);
    while(consumed<lines.length){
      if(y+10>bottom)nextPage();
      const available=Math.max(1,Math.floor((bottom-y-5)/4)),chunk=lines.slice(consumed,consumed+available),height=Math.max(10,chunk.length*4+5);
      chunk.forEach((line,index)=>text(line,left,y+index*4,8));if(consumed===0)text(value,right,y,8,{align:'right',color:known(entry.amount)?ink:amber});y+=height;consumed+=chunk.length;
    }
  }

  if(logoData){const image=pdf.getImageProperties(logoData),ratio=image.width/image.height,w=Math.min(47,13*ratio);pdf.addImage(logoData,'PNG',left,15,w,w/ratio);}else text(company.name||'Orquivia',left,25,15,{style:'bold'});
  text('ESTADOS FINANCIEROS',right,21,12,{style:'bold',align:'right'});
  text(`Fecha de corte: ${date(b.asOf)}`,right,28,9,{color:muted,align:'right'});
  y=43;paragraph(name,{size:11,color:ink,gap:1});
  if(company.taxId)paragraph(`NIF: ${company.taxId}`,{size:8,gap:3});
  pdf.setFillColor(248,244,233);pdf.rect(left,y-3,width,18,'F');
  text('ESTADOS FINANCIEROS PROVISIONALES',left+4,y+2,9,{style:'bold',color:amber});
  text('Elaborados con los registros de la aplicación. Partidas pendientes en el anexo.',left+4,y+8,8,{color:amber});y+=25;
  section('Cuenta de pérdidas y ganancias',`Del ${date(p.range.from)} al ${date(p.range.to)}. Importes en euros. Criterio de devengo: fecha de factura o gasto, independiente de su cobro o pago.`);
  for(const entry of p.lines)row(entry.label,entry.amount,{total:/result|final|total/.test(entry.id || '')});
  y+=5;paragraph('El resultado antes de pendientes es un subtotal de las partidas identificadas. No representa el resultado definitivo del ejercicio. Los importes sin desglose o tratamiento confirmado no se han sustituido por cero.',{size:8});
  paragraph(`Gastos pendientes de valoración: ${amount(p.summary?.pendingExpenseGross)}. IVA pendiente de tratamiento: ${amount(p.summary?.pendingVATAmount)}. Importes adicionales pendientes: ${amount(p.summary?.pendingAdditionalAmount)}.`,{size:8});

  nextPage();section('Balance de situación',`Situación a ${date(b.asOf)}. Importes en euros. Se muestran las partidas identificadas con la información disponible.`);
  subheading('ACTIVO IDENTIFICADO');
  for(const entry of b.assets){row(entry.label,entry.amount);source(entry.source);}
  row('Suma de activos identificados',b.summary.knownAssets,{total:true});y+=6;
  subheading('PASIVO IDENTIFICADO');
  if(!b.liabilities.length)paragraph('No constan deudas identificadas en los registros disponibles. Esto no acredita la inexistencia de otras deudas.',{size:8});
  for(const entry of b.liabilities){row(entry.label,entry.amount);source(entry.source);}
  row('Suma de pasivos identificados',b.summary.knownLiabilities,{total:true});y+=6;
  subheading('PATRIMONIO NETO');
  if(!(b.equity || []).length)row('Patrimonio neto pendiente de completar',null);else for(const entry of b.equity){row(entry.label,entry.amount);source(entry.source);}
  y+=5;paragraph(b.summary.balanced?'La comprobación aritmética requiere confirmar también la integridad y el tratamiento contable de las partidas.':'No puede verificarse la igualdad entre activo, patrimonio neto y pasivo. No se ha añadido una partida artificial para cuadrar el balance.',{size:8,color:amber});
  const balancePending=[...(b.missing || []),...(b.pending || [])];
  if(balancePending.length)paragraph(`${balancePending.length} comprobaciones contables pendientes, detalladas en el anexo. El balance completo permanece por completar.`,{size:8,color:amber});

  const pending=p.pending || [],excluded=p.excluded || [];
  nextPage();section('Anexo de revisión y alcance','Las partidas siguientes permiten identificar qué falta antes de considerar cerrados los estados financieros. Los importes de referencia pueden ser brutos y no equivalen a costes netos confirmados.');
  if(balancePending.length){subheading(`Balance: ${balancePending.length} comprobaciones`);for(const entry of balancePending)issue(entry);y+=5;}
  subheading(`Pérdidas y ganancias: ${pending.length} revisiones`);
  if(!pending.length)paragraph('Sin revisiones específicas registradas para este período. El alcance sigue limitado a la información disponible.',{size:8});
  for(const entry of pending)issue(entry);
  if(excluded.length){y+=4;subheading('Movimientos separados del resultado');for(const entry of excluded)issue(entry);}
  y+=5;subheading('Criterios y límites de los datos');
  for(const value of [...new Set([...(p.limitations || []),...(b.limitations || [])])])paragraph(value,{size:8,step:4.1,gap:4});
  paragraph('Los originales, los libros contables y los ajustes del gestor permiten comprobar y completar este informe. No incluye una certificación, firma profesional ni presentación de cuentas anuales.',{size:8});
  const pages=pdf.getNumberOfPages();
  for(let page=1;page<=pages;page++){
    pdf.setPage(page);pdf.setDrawColor(217,226,217);pdf.line(left,280,right,280);
    text(demo?'DATOS DE DEMOSTRACIÓN':'Informe provisional - registros de la aplicación',left,286,7,{color:muted});
    text(`Generado: ${date(generated)} - Página ${page} de ${pages}`,right,286,7,{color:muted,align:'right'});
  }
  return pdf;
}
