import { createClient } from 'npm:@supabase/supabase-js@2';
import { reminderLines } from '../_shared/reminders.js';
import { todayISO } from '../../../src/domain.js';

type Document = {
  id: string;
  kind: 'invoice' | 'quote';
  number?: string;
  clientId?: string;
  total?: number;
  status?: string;
  dueDate?: string;
  contractExpectedDate?: string;
  contractReceived?: boolean;
  clientSnapshot?: { name?: string };
};
type State = {
  company: { name?: string; emailNotifications?: boolean; notificationEmail?: string };
  clients: { id: string; name?: string }[];
  documents: Document[];
  payments: { documentId: string; amount: number }[];
};

async function sameSecret(actual: string, expected: string): Promise<boolean> {
  const digest = async (value: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  const [left, right] = await Promise.all([digest(actual), digest(expected)]);
  let different = 0;
  for (let index = 0; index < left.length; index++) different |= left[index] ^ right[index];
  return different === 0;
}

export default { fetch: async (request: Request) => {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const cronSecret = Deno.env.get('ORQUIVIA_CRON_SECRET');
  if (!cronSecret || !(await sameSecret(request.headers.get('x-orquivia-cron-secret') || '', cronSecret))) {
    return new Response('Unauthorized', { status: 401 });
  }
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  let serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  try {
    serviceKey = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}').default || serviceKey;
  } catch {
    return Response.json({ error: 'La configuración de claves del servidor no es válida.' }, { status: 503 });
  }
  const resendKey = Deno.env.get('RESEND_API_KEY');
  const from = Deno.env.get('ORQUIVIA_FROM_EMAIL');
  if (!supabaseUrl || !serviceKey || !resendKey || !from || /[\r\n]/.test(from)) {
    return Response.json({ error: 'Faltan secretos del servidor.' }, { status: 503 });
  }

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const today = todayISO();
  const madridHour = Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Madrid', hour: '2-digit', hourCycle: 'h23',
  }).format(new Date()));
  // The hourly job retries within office hours and follows DST automatically.
  if (madridHour < 9 || madridHour >= 19) return Response.json({ date: today, skipped: 'outside_delivery_hours' });
  let scanned = 0;
  let sent = 0;
  let failed = 0;
  let offset = 0;
  try {
    while (true) {
      const { data: workspaces, error } = await db.from('orquivia_team_workspaces')
        .select('organization_id,state').order('organization_id').range(offset, offset + 99);
      if (error) throw error;
      for (const workspace of workspaces || []) {
        scanned++;
        const state = workspace.state as State;
        const email = typeof state.company?.notificationEmail === 'string' ? state.company.notificationEmail.trim() : '';
        // Email reminders are opt-in, and go to the owner's chosen address only.
        if (state.company?.emailNotifications !== true || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;
        const lines = reminderLines(state, today);
        if (!lines.length) continue;
        const messagePayload = {
          from, to: [email], subject: `Orquívia · ${lines.length} pendientes · ${today}`,
          text: [
            `Resumen de ${typeof state.company.name === 'string' ? state.company.name : 'Orquívia'} para ${today}.`, '',
            ...lines.map((line: string) => `• ${line}`), '',
            'Revisa el portal y actualiza los cobros o la recepción del contrato.',
            'El estado se basa en los registros del portal. Comprueba tu banco antes de marcar un cobro.',
          ].join('\n'),
        };
        const leaseToken = crypto.randomUUID();
        const { data: claimedPayload, error: claimError } = await db.rpc('claim_orquivia_team_reminder', {
          p_organization_id: workspace.organization_id, p_date: today, p_lease_token: leaseToken,
          p_payload: messagePayload,
        });
        if (claimError) { failed++; console.error('No se pudo reservar un aviso diario.', claimError.code); continue; }
        if (!claimedPayload) continue;
        if (claimedPayload.to?.[0] !== email) {
          // Do not retry an immutable outbox message to an address the owner has replaced.
          await db.from('orquivia_team_reminder_deliveries')
            .update({ status: 'cancelled', error: 'Recipient changed; daily retry cancelled.' })
            .eq('organization_id', workspace.organization_id).eq('reminder_date', today).eq('lease_token', leaseToken);
          continue;
        }
        try {
          const emailResponse = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json',
              'Idempotency-Key': `orquivia-daily/${workspace.organization_id}/${today}`,
            },
            // Retries reuse exactly the stored body. Resend rejects the same key
            // with different parameters if the owner edited records meanwhile.
            body: JSON.stringify(claimedPayload),
            signal: AbortSignal.timeout(20_000),
          });
          const providerResult = await emailResponse.json();
          if (!emailResponse.ok) throw new Error(`Proveedor de correo: HTTP ${emailResponse.status}`);
          const { error: recordError } = await db.from('orquivia_team_reminder_deliveries')
            .update({ status: 'sent', sent_at: new Date().toISOString(), provider_id: String(providerResult.id || ''), error: null })
            .eq('organization_id', workspace.organization_id).eq('reminder_date', today).eq('lease_token', leaseToken);
          if (recordError) throw new Error('No se pudo registrar el aviso enviado.');
          sent++;
        } catch (deliveryError) {
          failed++;
          const message = deliveryError instanceof Error ? deliveryError.message : 'Error de entrega';
          await db.from('orquivia_team_reminder_deliveries')
            .update({ status: 'failed', error: message.slice(0, 300) })
            .eq('organization_id', workspace.organization_id).eq('reminder_date', today).eq('lease_token', leaseToken);
          console.error('Falló un aviso diario.', message);
        }
      }
      if (!workspaces || workspaces.length < 100) break;
      offset += 100;
    }
    return Response.json({ date: today, scanned, sent, failed }, { status: failed ? 502 : 200 });
  } catch (error) {
    console.error('No se pudo completar el resumen diario.', error instanceof Error ? error.message : 'database error');
    return Response.json({ error: 'No se pudo completar el resumen diario.', date: today, scanned, sent, failed }, { status: 500 });
  }
} };
