import { money, escapeHTML as esc } from './domain.js';
import { validateAccountantClose, forecastInputs } from './accountant-close.js';

const date = value => value.split('-').reverse().join('/');
const field = (name, label, value, optional = false) => `<label class="field"><span>${label}</span><input type="number" name="${name}" min="0" step="0.01" value="${value ?? ''}" ${optional ? 'placeholder="Sin estimar"' : ''}></label>`;

export function accountantPanel(alignment) {
  const importer = `<input id="accountant-close-file" type="file" accept=".json,application/json" hidden><button type="button" class="button secondary" id="accountant-close-import">${alignment ? 'Actualizar cierre del gestor' : 'Importar cierre del gestor'}</button><p class="field-hint" data-close-permission></p>`;
  if (!alignment) return `<section class="card statement-accounting"><div class="card-header"><div><h2>Referencia del gestor</h2><p>Incorpora un cierre contable con su fecha y documentos de origen para conciliar los registros y preparar una previsión.</p></div></div><div class="accountant-body">${importer}</div></section>`;
  const { close:c, forecast:f, later, through, comparison } = alignment;
  return `<section class="card statement-accounting" aria-label="Cierre del gestor"><div class="card-header"><div><h2>Referencia del gestor · ${date(c.asOf)}</h2><p>${esc(c.source)} Los movimientos posteriores se muestran separados y no vuelven a sumar el histórico.</p></div></div><div class="accountant-body"><div class="statement-downloads"><a class="button secondary" href="#estados-financieros?desde=${c.from}&hasta=${c.asOf}">Ver el cierre del gestor</a>${importer}</div><div class="table-scroll"><table class="statement-table"><thead><tr><th>Conciliación hasta ${date(c.asOf)}</th><th class="amount">Gestor</th><th class="amount">Portal identificado</th><th class="amount">Diferencia</th></tr></thead><tbody>${comparison.map(row => `<tr><th scope="row">${esc(row.label)}</th><td class="amount">${money(row.accountant)}</td><td class="amount">${money(row.application)}</td><td class="amount">${money(row.difference)}</td></tr>`).join('')}</tbody></table></div><p class="field-hint">La diferencia de gastos es una conciliación pendiente, no una orden para marcar justificantes como deducibles. Los importes del gestor son la referencia contable del período cerrado.</p><details><summary>Fuentes, declaraciones y observaciones</summary><ul class="statement-method">${c.sources.map(source => `<li>${esc(source.name)}<small class="statement-source">SHA-256: ${esc(source.sha256)}</small></li>`).join('')}${c.notes.map(note => `<li>${esc(note)}</li>`).join('')}</ul><div class="table-scroll"><table class="statement-table"><thead><tr><th>Declaración presentada</th><th class="amount">Resultado</th></tr></thead><tbody>${c.taxFilings.map(row => `<tr><th scope="row">Modelo ${row.model} · ${row.quarter}T ${row.year}</th><td class="amount">${money(row.result)}</td></tr>`).join('')}</tbody></table></div><p class="field-hint">Los negativos del modelo 303 son cuotas a compensar según los documentos, no devoluciones ya cobradas. Estas referencias no crean pagos ni gastos adicionales. Se conservan las referencias y huellas de los originales; el archivo de importación no contiene los PDF.</p></details></div></section>
  <section class="card statement-accounting" aria-label="Previsión anual"><div class="card-header"><div><h2>Previsión a 31/12/${c.asOf.slice(0,4)}</h2><p>Parte del cierre del gestor y añade los registros posteriores hasta ${date(through < c.asOf ? c.asOf : through)}. Completa solo operaciones previstas que todavía no estén incluidas.</p></div></div><div class="accountant-body"><div class="statement-subtotal"><span>Resultado antes de impuestos del cierre del gestor</span><strong>${money(c.profitLoss.resultBeforeTax)}</strong></div><div class="statement-subtotal"><span>Resultado posterior con coste identificado</span><strong>${money(later?.summary.resultBeforePending ?? 0)}</strong></div>${later?.pending.length ? `<div class="statement-notice" role="note"><div><strong>Previsión parcial: quedan ${later.pending.length} revisiones posteriores al cierre</strong><p>Importes pendientes de valoración o tratamiento: ${money(alignment.pendingGross)}. No están descontados del subtotal. Los cargos bancarios requieren confirmar su fecha de devengo; algunos pueden pagar deudas ya contabilizadas por el gestor.</p></div></div>` : ''}<form id="accountant-forecast-form"><fieldset><div class="form-grid">${field('futureSales','Ventas futuras previstas, sin IVA',f.futureSales)}${field('futureCosts','Costes futuros previstos, sin IVA recuperable',f.futureCosts)}${field('payrollCost','Coste adicional de nómina para la empresa',f.payrollCost)}${field('taxProvision','Provisión estimada de Impuesto sobre Sociedades (opcional)',f.taxProvision,true)}</div><p class="field-hint">La nómina es un escenario de coste total para la empresa; no calcula tu neto personal ni sustituye una nómina real. Los presupuestos no se convierten automáticamente en ingresos y los dividendos no se contabilizan como gasto.</p><p class="field-hint" data-forecast-permission></p><button type="submit" class="button secondary">Guardar hipótesis</button></fieldset></form><div class="statement-subtotal"><span>Estimación antes de impuestos y partidas pendientes</span><strong>${money(alignment.beforeTax)}</strong></div><div class="statement-subtotal"><span>Estimación después de la provisión indicada</span><strong>${alignment.afterTax === null ? 'Por completar' : money(alignment.afterTax)}</strong></div><p class="field-hint">No es el beneficio definitivo ni el dividendo repartible. Faltan los ajustes del gestor, la revisión de las partidas pendientes y, si no se ha indicado, el impuesto estimado.</p></div></section>`;
}

export function bindAccountant(root, ctx, period) {
  const button = root.querySelector('#accountant-close-import'), input = root.querySelector('#accountant-close-file');
  if (!button || !input) return;
  const canEdit = ctx.getMode() !== 'cloud' || ctx.getBackend()?.workspaceInfo?.()?.role === 'admin';
  button.disabled = !canEdit;
  const permission = root.querySelector('[data-close-permission]'); if (permission) permission.textContent = canEdit ? '' : 'Solo administración puede importar un cierre contable.';
  button.onclick = () => { if (canEdit && !ctx.isBusy()) input.click(); };
  input.onchange = async () => {
    const file = input.files?.[0]; input.value = ''; if (!file || !canEdit || ctx.isBusy()) return;
    const current = ctx.operationScope?.();
    try {
      if (file.size > 200_000) throw new Error('El archivo de cierre supera 200 kB. Selecciona el JSON de conciliación, no una copia completa de la empresa.');
      const close = validateAccountantClose(JSON.parse(await file.text()), ctx.getState().company);
      if (current && !current()) return;
      ctx.confirmModal('Importar referencia del gestor', `Se guardará el cierre del ${date(close.asOf)} con ventas de ${money(close.profitLoss.sales)} y resultado antes de impuestos de ${money(close.profitLoss.resultBeforeTax)}. No se modificarán facturas, gastos, cobros ni saldos iniciales.`, async () => {
        if (current && !current()) return;
        if (await ctx.commit(state => { state.company.accountantClose = validateAccountantClose(close, state.company); }, 'Cierre del gestor guardado con sus fuentes.')) ctx.closeModal();
      });
    } catch (error) { ctx.toast(error.message, true); }
  };
  const form = root.querySelector('#accountant-forecast-form');
  if (form) {
    form.querySelector('fieldset').disabled = !canEdit;
    form.querySelector('[data-forecast-permission]').textContent = canEdit ? '' : 'Solo administración puede guardar las hipótesis compartidas.';
    form.onsubmit = async event => {
      event.preventDefault(); if (!canEdit || ctx.isBusy()) return;
      try { const values = forecastInputs(Object.fromEntries(new FormData(form))); await ctx.commit(state => { state.company.accountantForecast = values; }, 'Hipótesis de previsión guardadas.'); } catch (error) { ctx.toast(error.message, true); }
    };
  }
}
