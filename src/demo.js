import { todayISO, totals } from './domain.js';
export const emptyState = () => ({ company: { name:'Orquívia', legalName:'', taxId:'', address:'', email:'', phone:'', iban:'', bic:'', vat:21, withholding:0, paymentTerms:30, emailNotifications:false, notificationEmail:'' }, clients:[], documents:[], payments:[] });
const offset = (n) => { const d=new Date(`${todayISO()}T12:00:00Z`); d.setUTCDate(d.getUTCDate()+n); return d.toISOString().slice(0,10); };
export function demoState() {
  const s=emptyState();
  s.clients=[
    {id:'c1',name:'Estudio Norte',taxId:'',email:'',address:'Barcelona',contact:'Clara Martín'},
    {id:'c2',name:'Habitat & Co.',taxId:'',email:'',address:'Madrid',contact:'Pablo García'},
    {id:'c3',name:'Luma Arquitectura',taxId:'',email:'',address:'Valencia',contact:'Elena Torres'},
    {id:'c4',name:'Espacio Verde',taxId:'',email:'',address:'Girona',contact:'Marta Soler'},
  ];
  const year=todayISO().slice(0,4);
  const records=[
    ['d1','invoice','F-'+year+'-001','c1','Planimetría y revisión de planos',145, -36,-6,'issued',null],
    ['d2','invoice','F-'+year+'-002','c2','Proyecto de espacio comercial',1250,-21,9,'issued',null],
    ['d3','quote','PR-'+year+'-001','c3','Diseño de interiores',2400,-4,26,'sent',offset(-1)],
    ['d4','invoice','F-'+year+'-003','c4','Documentación técnica',600,-16,14,'issued',null],
    ['d5','quote','PR-'+year+'-002','c1','Levantamiento de planos',850,-2,28,'accepted',offset(4)],
    ['d6','invoice','F-'+year+'-004','c3','Asesoría y coordinación',420,-3,27,'issued',null],
  ];
  s.documents=records.map(([id,kind,number,clientId,title,price,date,due,status,contractExpectedDate]) => {
    const doc={id,kind,number,clientId,title,date:offset(date),dueDate:offset(due),status,contractExpectedDate,contractReceived:false,items:[{description:title,detail: kind==='invoice'&&price===145?'Gestión, revisión y organización de planos de unidades comerciales.':'',quantity:1,price}],vat:21,discount:0,withholding:0,notes:'',po:'',paymentMethod:'Transferencia bancaria'};
    doc.total=totals(doc).total; return doc;
  });
  s.payments=[{id:'p1',documentId:'d4',amount:726,date:offset(-4),reference:'Cobro de ejemplo'},{id:'p2',documentId:'d2',amount:500,date:offset(-2),reference:'Anticipo de ejemplo'}];
  return s;
}
