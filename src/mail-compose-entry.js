const terminalStatuses = new Set(['sent', 'archive_pending', 'failed']);
const copy = value => structuredClone(value);

function recentFirst(history) {
  return history.map((job, index) => ({ job, index,
    time: Date.parse(job?.createdAt || job?.created_at || '') }))
    .filter(entry => entry.job && typeof entry.job === 'object')
    .sort((a, b) => {
      const aTime = Number.isFinite(a.time) ? a.time : -Infinity;
      const bTime = Number.isFinite(b.time) ? b.time : -Infinity;
      return (aTime === bTime ? 0 : aTime > bTime ? -1 : 1) || a.index - b.index;
    }).map(entry => entry.job);
}

function withRecipientMetadata(draft, job) {
  return { ...draft, to: copy(job.to ?? draft.to), cc: copy(job.cc || []), subject: job.subject ?? draft.subject };
}

/** Choose an editable draft without turning a pending attempt into a new send. */
export function resolveMailComposeEntry({ savedDraft, history = [], defaultDraft, preferDefaultRecipients = false, createId = () => crypto.randomUUID() }) {
  const ordered = recentFirst(history);
  const draft = { ...copy(defaultDraft || {}), ...(savedDraft ? copy(savedDraft) : {}) };
  // A partial result stays blocked even if contradictory metadata says "sent".
  // Unknown states are also held for review rather than treated as permission
  // to create another message.
  const blocked = ordered.find(job => job.errorCode === 'SMTP_PARTIAL' || !terminalStatuses.has(job.status));
  if (blocked) {
    return { draft: savedDraft ? draft : { ...withRecipientMetadata(draft, blocked), idempotencyKey: blocked.id }, job: copy(blocked) };
  }
  if (savedDraft) {
    const previous = ordered.find(job => job.id === savedDraft.idempotencyKey);
    // No visible result can mean an unsent draft or an attempt whose response
    // has not arrived. Preserve its UUID so replay protection remains intact.
    return { draft: previous ? { ...draft, ...(Object.hasOwn(draft, 'attachments') ? { attachments: [] } : {}),
      ...(preferDefaultRecipients ? { to: copy(defaultDraft.to) } : {}), idempotencyKey: createId() } : draft, job: null };
  }
  // A stored billing contact takes precedence over the recipient of a completed
  // attempt. Keep the latter in history rather than silently choosing it again.
  return { draft: { ...(ordered[0] ? withRecipientMetadata(draft, ordered[0]) : draft),
    ...(preferDefaultRecipients ? { to: copy(defaultDraft.to) } : {}), idempotencyKey: createId() }, job: null };
}
