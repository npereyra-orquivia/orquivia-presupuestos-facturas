import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';
import { notificationCandidates, notificationDeliveryHour, notificationPreferences, privatePushPayload } from '../../../src/notification-rules.js';
import { todayISO } from '../../../src/domain.js';
import { sameSecret, validPushSubscription, validVapidConfiguration } from '../_shared/push-security.js';

type PushTarget = {
  id: string;
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
  notification_preferences: object;
  state: object;
};

export default { fetch: async (request: Request) => {
  if (!['GET','POST'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  let serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  try { serviceKey = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}').default || serviceKey; }
  catch { return Response.json({ error: 'Invalid server configuration' }, { status: 503 }); }
  if (!supabaseUrl || !serviceKey) {
    return Response.json({ error: 'Push delivery is not configured' }, { status: 503 });
  }
  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  let settings;
  try {
    const { data, error } = await db.rpc('get_orquivia_push_runtime_config');
    if (error || !data?.cronSecret) throw new Error('Configuration unavailable');
    settings = data;
    if (!settings.publicKey && request.method === 'GET') {
      const keys = webpush.generateVAPIDKeys();
      const initialized = await db.rpc('initialize_orquivia_push_runtime', {
        p_public_key: keys.publicKey, p_private_key: keys.privateKey,
        p_subject: 'mailto:npereyra@orquivia.com',
      });
      if (initialized.error || !initialized.data?.publicKey) throw new Error('Configuration unavailable');
      settings = initialized.data;
    }
  } catch { return Response.json({ error: 'Push delivery is not configured' }, { status: 503 }); }
  if (request.method === 'GET') {
    // Only the public application-server key is exposed; no subscription/records.
    return Response.json({ publicKey: settings.publicKey }, { headers: { 'Cache-Control': 'public, max-age=3600' } });
  }
  if (!(await sameSecret(request.headers.get('x-orquivia-push-secret') || '', settings.cronSecret))) {
    return new Response('Unauthorized', { status: 401 });
  }
  const vapidDetails = { publicKey: settings.publicKey, privateKey: settings.privateKey, subject: settings.subject };
  if (!validVapidConfiguration(vapidDetails.publicKey, vapidDetails.privateKey, vapidDetails.subject)) {
    return Response.json({ error: 'Push delivery is not configured' }, { status: 503 });
  }
  const now = new Date();
  const today = todayISO(now);
  const hour = notificationDeliveryHour(now);
  const counts = { scanned: 0, eligible: 0, sent: 0, expired: 0, failed: 0 };
  try {
    const { data: targets, error } = await db.rpc('list_orquivia_push_targets');
    if (error) throw new Error('Cannot read push targets');
    if (!Array.isArray(targets) || targets.length > 500) throw new Error('Invalid push target batch');
    for (const target of targets as PushTarget[]) {
      counts.scanned++;
      const preferences = notificationPreferences(target.notification_preferences);
      if (!preferences.enabled || hour < preferences.hour) continue;
      const pending = notificationCandidates(target.state, preferences, today);
      if (!pending.length) continue;
      if (!validPushSubscription(target.subscription)) {
        const { error: disableError } = await db.from('orquivia_push_subscriptions').update({ active: false }).eq('id', target.id);
        if (disableError) counts.failed++; else counts.expired++;
        continue;
      }
      counts.eligible++;
      const lease = crypto.randomUUID();
      const { data: payload, error: claimError } = await db.rpc('claim_orquivia_push_delivery', {
        p_subscription_id: target.id, p_date: today, p_lease_token: lease,
        p_payload: privatePushPayload(today, pending.length),
      });
      if (claimError) { counts.failed++; continue; }
      if (!payload) continue;
      let deliveryStatus = 'failed';
      let deliveryError: string | null = null;
      try {
        const details = webpush.generateRequestDetails(target.subscription, JSON.stringify(payload), {
          vapidDetails, TTL: 3600, urgency: 'normal', topic: `orquivia-${today}`, contentEncoding: 'aes128gcm',
        });
        // Native fetch provides a total deadline and refuses redirects to a different host.
        const response = await fetch(details.endpoint, {
          method: details.method, headers: details.headers, body: details.body,
          redirect: 'error', signal: AbortSignal.timeout(15_000),
        });
        if (response.ok) {
          deliveryStatus = 'sent';
          counts.sent++;
        } else if (response.status === 404 || response.status === 410) {
          const { error: disableError } = await db.from('orquivia_push_subscriptions').update({ active: false }).eq('id', target.id);
          if (disableError) throw new Error('Cannot deactivate expired subscription');
          deliveryStatus = 'cancelled';
          deliveryError = 'Subscription expired';
          counts.expired++;
        } else {
          throw new Error(`Push provider HTTP ${response.status}`);
        }
        await response.body?.cancel();
      } catch (error) {
        // Endpoint URLs and provider response bodies are capabilities; never log them.
        deliveryError = error instanceof Error && /^Push provider HTTP \d{3}$/.test(error.message)
          ? error.message : 'Push delivery unavailable';
        counts.failed++;
      }
      const { data: finished, error: finishError } = await db.rpc('finish_orquivia_push_delivery', {
        p_subscription_id: target.id, p_date: today, p_lease_token: lease,
        p_status: deliveryStatus, p_error: deliveryError,
      });
      if (finishError || finished !== true) counts.failed++;
    }
    await db.rpc('record_orquivia_push_run', { p_success: counts.failed === 0 });
    return Response.json({ date: today, ...counts }, { status: counts.failed ? 502 : 200 });
  } catch {
    await db.rpc('record_orquivia_push_run', { p_success: false });
    return Response.json({ error: 'Cannot complete push reminders', date: today, ...counts }, { status: 500 });
  }
} };
