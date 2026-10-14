// Share the portal's exact cent rounding, date validation and status rules.
// Deploy with Supabase CLI --use-api so the external source dependency is included.
import { alerts, money, outstanding } from '../../../src/domain.js';

export function reminderLines(state, today) {
  const documents = Array.isArray(state?.documents) ? state.documents : [];
  const payments = Array.isArray(state?.payments) ? state.payments : [];
  const clients = Array.isArray(state?.clients) ? state.clients : [];
  const byId = new Map(documents.map((document) => [document.id, document]));
  return alerts(documents, payments, today).map((alert) => {
    const document = byId.get(alert.documentId);
    const client = document.clientSnapshot?.name || clients.find((entry) => entry.id === document.clientId)?.name || 'Cliente';
    const label = `${document.kind === 'invoice' ? 'Factura' : 'Presupuesto'} ${document.number || document.id} · ${client}`;
    if (alert.type === 'review') return `${label}: estado del cobro por revisar. Confirma en el banco y actualiza el portal; el histórico no permite asumir si se pagó.`;
    return alert.type === 'payment'
      ? `${label}: ${money(outstanding(document, payments))} por cobrar; vencimiento ${alert.date}.`
      : `${label}: contrato pendiente desde ${alert.date}.`;
  });
}
