import test from 'node:test';
import assert from 'node:assert/strict';
import { money, formatNumber, totals, documentAmounts, createInvoiceFromQuote, validateWorkspace, alerts } from '../src/domain.js';
import { parseViewRoute, applyViewRoute, defaultViewState } from '../src/view-state.js';

const quote = () => ({ id:'quote-1',kind:'quote',status:'ready',number:'PR-2026-004',
  clientId:'client-1',date:'2026-10-14',dueDate:'2026-11-14',items:[{description:'Servicio',quantity:1,price:6000}],
  vat:21,discount:0,withholding:0,total:7260 });

test('four-digit money always has a thousands separator and retains decimals, negatives and currency', () => {
  for(const [value,formatted] of [[999.99,'999,99'],[1000,'1.000,00'],[6000,'6.000,00'],[15000,'15.000,00'],
    [15000000.5,'15.000.000,50'],[-1234.56,'-1.234,56']]){
    assert.ok(money(value).includes(formatted),money(value));assert.ok(money(value).endsWith('€'));
  }
  assert.equal(formatNumber(1000.125),'1.000,125');
  assert.equal(formatNumber(5000,{maximumFractionDigits:0}),'5.000');
});

test('quotes display their price without VAT while invoices and stored canonical tax values are preserved', () => {
  const q=quote(),original=structuredClone(q);
  assert.equal(documentAmounts(q).total,6000);assert.equal(documentAmounts(q).vatIncluded,false);
  assert.equal(totals(q).total,7260);assert.deepEqual(q,original);
  const invoice=createInvoiceFromQuote(q,[q],'2026-10-15');
  assert.equal(invoice.vat,21);assert.equal(documentAmounts(invoice).total,7260);assert.equal(documentAmounts(invoice).vatIncluded,true);
  const reduced={...q,discount:10,withholding:15};
  assert.equal(documentAmounts(reduced).total,4590); // 5.400 − 810, retaining the explicit withholding.
  assert.equal(documentAmounts(reduced).total,Number((totals(reduced).total-totals(reduced).vatAmount).toFixed(2)));
});

test('prepared quotes require a number, restore their own filter and do not create contract reminders before sending', () => {
  const q={...quote(),contractExpectedDate:'2026-10-14',contractReceived:false};
  const state={company:{name:'Company'},clients:[{id:'client-1',name:'Client'}],documents:[q],payments:[]};
  assert.deepEqual(validateWorkspace(state,'2026-10-15'),[]);
  assert.ok(validateWorkspace({...state,documents:[{...q,number:''}]},'2026-10-15').length);
  assert.ok(validateWorkspace({...state,documents:[{...q,kind:'invoice'}]},'2026-10-15').length);
  assert.equal(alerts([q],[],'2026-10-15').length,0);
  assert.equal(alerts([{...q,status:'sent'}],[],'2026-10-15').length,1);
  const route=parseViewRoute({hash:'#presupuestos?estado=ready'});
  assert.equal(applyViewRoute(defaultViewState('2026-10-15'),route).quotes.filter,'ready');
});
