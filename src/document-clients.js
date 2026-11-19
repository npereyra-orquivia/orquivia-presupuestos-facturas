const PREPARING_QUOTE_STATUSES = new Set(['draft', 'ready']);
const ISSUED_INVOICE_STATUSES = new Set(['issued', 'partial', 'paid', 'overdue']);

const isQuote = (doc) => doc?.kind === 'quote' || doc?.kind === 'budget';
const clientById = (clients = []) => new Map(clients.map(client => [client.id, client]));
const clone = (value) => structuredClone(value);

/** Draft parties follow the address book; issued documents retain their snapshot. */
export function documentClient(doc, clients = []) {
  const current = clients.find(client => client.id === doc?.clientId);
  const snapshot = doc?.clientSnapshot;
  return (doc?.status === 'draft' ? current || snapshot : snapshot || current)
    || { name: 'Cliente eliminado' };
}

/** Return to an unsaved editor after changing the global client address book. */
export function resumeDocumentWithClient(editor, client, { previousClient, persistedDocument } = {}) {
  const result = structuredClone(editor);
  const sameStoredClient = persistedDocument?.clientId === result.clientId;
  if (!previousClient) {
    result.clientId = client.id;
    delete result.clientSnapshot;
    if (result.kind === 'invoice') {
      if (client.billingEmail) result.billingEmail = client.billingEmail;
      else delete result.billingEmail;
    }
    return result;
  }
  if (result.status === 'draft') delete result.clientSnapshot;
  else if (sameStoredClient) {
    if (persistedDocument.clientSnapshot) result.clientSnapshot = structuredClone(persistedDocument.clientSnapshot);
    else delete result.clientSnapshot;
  } else result.clientSnapshot = structuredClone(client);
  if (result.kind === 'invoice' && result.billingEmail && result.billingEmail === billingDefault(previousClient)) {
    const email = sameStoredClient ? persistedDocument.billingEmail : billingDefault(client);
    if (email) result.billingEmail = email;
    else delete result.billingEmail;
  }
  return result;
}

function sameValue(a, b) {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length
    && keys.every(key => Object.hasOwn(b, key) && sameValue(a[key], b[key]));
}

function billingDefault(client) {
  return client?.billingEmail || client?.email || '';
}

function updateDefaultBillingEmail(doc, oldClient, currentClient) {
  if (doc.billingEmail && doc.billingEmail !== billingDefault(oldClient)) return;
  const email = billingDefault(currentClient);
  if (email) doc.billingEmail = email;
  else delete doc.billingEmail;
}

/**
 * Apply address-book changes to local documents without rewriting their history.
 * Cloud saves use the equivalent database rule, which also knows send history.
 */
export function syncDocumentClients(previous, next, { lockedQuoteIds = [], lockedDocumentIds = [] } = {}) {
  const oldClients = clientById(previous.clients || []);
  const currentClients = clientById(next.clients || []);
  const oldDocuments = new Map((previous.documents || []).map(doc => [doc.id, doc]));
  const lockedQuotes = new Set(lockedQuoteIds);
  const lockedDocuments = new Set(lockedDocumentIds);
  const linkedQuotes = new Set([...(previous.documents || []), ...(next.documents || [])]
    .filter(doc => doc.kind === 'invoice' && doc.status !== 'draft' && doc.quoteId).map(doc => doc.quoteId));

  for (const doc of next.documents || []) {
    if (!isQuote(doc) && doc.kind !== 'invoice') continue;
    const oldDoc = oldDocuments.get(doc.id);
    const currentClient = currentClients.get(doc.clientId);
    const oldClient = oldClients.get(doc.clientId);
    const sameParty = !oldDoc || oldDoc.clientId === doc.clientId;
    const masterChanged = sameParty && oldClient && currentClient && !sameValue(oldClient, currentClient);
    const preparingQuote = isQuote(doc) && PREPARING_QUOTE_STATUSES.has(doc.status)
      && (!oldDoc || (isQuote(oldDoc) && PREPARING_QUOTE_STATUSES.has(oldDoc.status)))
      && !lockedQuotes.has(doc.id) && !lockedDocuments.has(doc.id) && !linkedQuotes.has(doc.id);

    if (doc.status === 'draft') {
      // Conversion and copied drafts can still carry an older party snapshot.
      delete doc.clientSnapshot;
    } else if (preparingQuote && currentClient) {
      doc.clientSnapshot = clone(currentClient);
    } else if (isQuote(doc) && !doc.clientSnapshot && oldDoc && sameParty && oldClient
      && !lockedDocuments.has(doc.id)) {
      // A legacy historical document may predate snapshots. Freeze its old party
      // before a master-client edit would change the fallback used to render it.
      doc.clientSnapshot = clone(oldDoc.clientSnapshot || oldClient);
    }

    if (doc.kind !== 'invoice' || !masterChanged || lockedDocuments.has(doc.id)) continue;
    const draftInvoice = doc.status === 'draft' && (!oldDoc || oldDoc.status === 'draft');
    const readyInvoice = ISSUED_INVOICE_STATUSES.has(doc.status) && doc.deliveryStatus === 'ready'
      && oldDoc && ISSUED_INVOICE_STATUSES.has(oldDoc.status) && oldDoc.deliveryStatus === 'ready';
    if (draftInvoice || readyInvoice) updateDefaultBillingEmail(doc, oldClient, currentClient);
  }
  return next;
}
