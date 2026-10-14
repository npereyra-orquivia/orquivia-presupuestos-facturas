import './personal.css';
import { escapeHTML as esc } from './domain.js';
import { icon } from './icons.js';
import { DEFAULT_NOTIFICATIONS, validateAvatarFile } from './personal-backend.js';

export function profileName(profile, user, mode) {
  return profile?.displayName || user?.user_metadata?.name || user?.email?.split('@')[0] || (mode === 'demo' ? 'Nicole' : 'Mi cuenta');
}

export function avatarMarkup(name, photoUrl, extra = '') {
  const initial = Array.from(name.trim())[0]?.toLocaleUpperCase('es-ES') || 'N';
  return `<span class="avatar ${extra}" aria-hidden="true">${photoUrl ? `<img src="${esc(photoUrl)}" alt="">` : esc(initial)}</span>`;
}

function deviceMessageFor(device, cloud) {
  const capability = device?.capability;
  return !cloud ? 'Los avisos con la app cerrada se activan en el portal oficial.'
    : capability?.needsInstall ? 'En el iPhone, abre el portal en Safari, toca Compartir y «Añadir a pantalla de inicio». Después entra desde ese icono para activar los avisos.'
    : capability?.supported === false ? capability.guidance || 'Este navegador no admite avisos push. Puedes consultar los recordatorios en el portal.'
    : device?.checked && !device.ready ? 'No se ha podido conectar el servicio de avisos. Puedes guardar tus preferencias y volver a entrar para comprobarlo.'
    : !device?.ready ? 'Comprobando el servicio y este dispositivo…'
    : device.active ? 'Este dispositivo está registrado para tu cuenta. Los avisos siguen tus preferencias aunque cierres la app.'
    : 'Activa este dispositivo para recibir avisos aunque cierres la app. El navegador te pedirá permiso.';
}

export function personalPage({ profile, user, photoUrl, mode, loading, error, device, account }) {
  const name = profileName(profile, user, mode), n = profile?.notifications || DEFAULT_NOTIFICATIONS;
  const blocked = loading || Boolean(error), cloud = mode === 'cloud';
  const hours = Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${n.hour === h ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('');
  const capability = device?.capability;
  const deviceMessage = deviceMessageFor(device, cloud);
  return `<div class="page-heading"><div><div class="eyebrow">TU ZONA PERSONAL</div><h1>Tu espacio, a tu manera.</h1><p>Tu foto, tu cuenta y los avisos que te ayudan a estar al día.</p></div></div>
    ${error ? `<div class="note-banner">${icon('info')}<p>${esc(error)}</p><button class="text-button" data-action="reload-personal">Volver a cargar</button></div>` : ''}
    <div class="personal-grid"><section class="card personal-profile"><div class="card-header"><div><h2>Así te ve tu espacio</h2><p>Tu perfil es personal y no cambia los datos de Orquívia.</p></div></div>
      <form id="profile-form"><fieldset ${blocked ? 'disabled' : ''}><div class="profile-photo-row"><span id="profile-photo-preview">${avatarMarkup(name, photoUrl, 'large')}</span><div><strong>${esc(name)}</strong><p>${esc(user?.email || 'Perfil de prueba')}</p><div class="photo-actions"><label class="button secondary">${icon('upload')}Cambiar foto<input id="profile-photo" class="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp"></label><button class="text-button" type="button" id="remove-profile-photo" ${!photoUrl ? 'hidden' : ''}>Quitar foto</button></div></div></div>
      <label class="field"><span>Cómo quieres aparecer</span><input name="displayName" value="${esc(name)}" maxlength="100" required autocomplete="nickname"></label>
      <p class="field-hint">La inicial de tu nombre aparece cuando no tienes foto. Tu foto se guarda privada.</p>
      <div class="form-footer"><button class="button primary">Guardar perfil</button></div></fieldset></form></section>
    <section class="card personal-notifications"><div class="card-header"><div><h2>Un aviso en el momento justo</h2><p>Estas preferencias pertenecen a tu cuenta.</p></div>${icon('bell')}</div>
      <form id="preferences-form"><fieldset ${blocked ? 'disabled' : ''}><label class="checkbox-label notification-master"><input type="checkbox" name="enabled" ${n.enabled ? 'checked' : ''}>Quiero recibir recordatorios</label>
      <div class="notification-types"><label class="checkbox-label"><input type="checkbox" name="payment" ${n.payment ? 'checked' : ''}>Cobros pendientes</label><label class="checkbox-label"><input type="checkbox" name="contract" ${n.contract ? 'checked' : ''}>Aceptación o contrato pendiente</label><label class="checkbox-label"><input type="checkbox" name="review" ${n.review ? 'checked' : ''}>Registros que necesito revisar</label></div>
      <div class="form-grid"><label class="field"><span>Avisar antes del plazo (días)</span><input name="daysBefore" type="number" min="0" max="30" step="1" required value="${n.daysBefore}"></label><label class="field"><span>Repetir pendientes cada (días)</span><input name="repeatDays" type="number" min="0" max="30" step="1" required value="${n.repeatDays}"></label><label class="field"><span>Hora del aviso · España peninsular</span><select name="hour">${hours}</select></label><label class="checkbox-label same-day"><input type="checkbox" name="onDueDate" ${n.onDueDate ? 'checked' : ''}>Avisar también el mismo día</label></div>
      <p class="field-hint">Con 2 y 2 recibirás un aviso dos días antes y recordatorios cada dos días si sigue pendiente. Un 0 desactiva esa antelación o repetición. El servicio revisa los avisos cada hora, en el minuto 20; se enviarán a partir de la hora elegida. Al registrar el cobro o recibir el contrato, ese aviso deja de ser necesario.</p>
      <div class="form-footer"><button class="button primary">Guardar preferencias</button></div></fieldset></form>
      <div class="device-notifications"><div class="device-status"><span class="device-indicator ${device?.active ? 'active' : ''}"></span><strong>${device?.active ? 'Avisos activos en este dispositivo' : 'Avisos en este dispositivo'}</strong></div><p id="device-notification-description">${esc(deviceMessage)}</p><button class="button secondary" id="enable-device-push" ${!cloud || blocked || !capability?.supported || !device?.ready ? 'disabled' : ''}>${icon('bell')}${device?.active ? 'Comprobar y renovar este dispositivo' : 'Activar avisos en este dispositivo'}</button>${device?.active ? '<button class="text-button" id="disable-device-push">Desactivar este dispositivo</button>' : ''}<p class="field-hint">Los avisos muestran un mensaje general. Los importes y clientes se consultan después de entrar en Orquívia.</p><div id="personal-device-feedback" role="status" aria-live="polite"></div></div></section>
    <div class="personal-account">${account}</div></div>`;
}

async function preparePhoto(file) {
  if (!file || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 20 * 1024 * 1024) throw new Error('Elige una foto JPG, PNG o WebP de hasta 20 MB.');
  const sourceUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = sourceUrl;
    await image.decode();
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('No se pudo leer la foto.');
    const side = Math.min(image.naturalWidth, image.naturalHeight), canvas = document.createElement('canvas');
    canvas.width = 512; canvas.height = 512;
    const context = canvas.getContext('2d');
    context.fillStyle = '#f7f8f5'; context.fillRect(0, 0, 512, 512);
    context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, 512, 512);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .88));
    if (!blob) throw new Error('No se pudo preparar la foto.');
    const result = new File([blob], 'perfil.jpg', { type: 'image/jpeg' });
    await validateAvatarFile(result);
    return result;
  } finally { URL.revokeObjectURL(sourceUrl); }
}

export function bindPersonal(root, ctx) {
  const profileForm = root.querySelector('#profile-form'), preferences = root.querySelector('#preferences-form');
  if (!profileForm) return () => {};
  let file = null, removePhoto = false, previewUrl = null, preparing = false, photoRequest = 0, operationPending = false;
  const preview = profileForm.querySelector('#profile-photo-preview'), remove = profileForm.querySelector('#remove-profile-photo');
  const showPreview = url => { preview.innerHTML = avatarMarkup(profileForm.elements.displayName.value || ctx.name(), url, 'large'); remove.hidden = !url; };
  profileForm.elements.displayName.addEventListener('input', () => { if (!preview.querySelector('img')) showPreview(null); });
  profileForm.querySelector('#profile-photo').onchange = async event => {
    const candidate = event.target.files[0]; if (!candidate) return;
    const request = ++photoRequest; preparing = true;
    try { const prepared = await preparePhoto(candidate); if (!profileForm.isConnected || request !== photoRequest) return; file = prepared; removePhoto = false; if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = URL.createObjectURL(file); showPreview(previewUrl); }
    catch (error) { if (profileForm.isConnected && request === photoRequest) ctx.toast(error.message, true); }
    finally { if (request === photoRequest) preparing = false; event.target.value = ''; }
  };
  remove.onclick = () => { photoRequest++; preparing = false; file = null; removePhoto = true; if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = null; showPreview(null); };
  function currentDraft() {
    if (preparing) throw new Error('Espera a que termine de prepararse la foto.');
    if (!profileForm.reportValidity() || !preferences.reportValidity()) return null;
    const values = new FormData(preferences), notifications = {};
    for (const key of ['enabled', 'payment', 'contract', 'review', 'onDueDate']) notifications[key] = values.has(key);
    for (const key of ['daysBefore', 'repeatDays', 'hour']) notifications[key] = Number(values.get(key));
    return { ...ctx.getProfile(), displayName: profileForm.elements.displayName.value.trim(), notifications };
  }
  // Freeze both forms together: each save includes the pending photo and both
  // form values, so edits made during transport must not be silently discarded.
  async function runLocked(action) {
    if (operationPending || !profileForm.isConnected) return;
    operationPending = true;
    const controls = [...root.querySelectorAll('#profile-form input,#profile-form button,#preferences-form input,#preferences-form select,#preferences-form button,#enable-device-push,#disable-device-push')];
    const previousDisabled = controls.map(control => control.disabled);
    controls.forEach(control => { control.disabled = true; });
    let succeeded = false;
    try { await action(); succeeded = true; }
    catch (error) { if (profileForm.isConnected) ctx.toast(error.message, true); }
    finally { controls.forEach((control, index) => { if (control.isConnected) control.disabled = previousDisabled[index]; }); operationPending = false; }
    return succeeded;
  }
  const saveForms = async event => {
    event.preventDefault();
    let draft;
    try { draft = currentDraft(); } catch (error) { ctx.toast(error.message, true); return; }
    if (draft) await runLocked(() => ctx.save(draft, { file, removePhoto }));
  };
  profileForm.onsubmit = saveForms;
  preferences.onsubmit = saveForms;
  const deviceAction = (selector, prepareTask, onComplete) => {
    const button = root.querySelector(selector); if (!button) return;
    button.onclick = async () => {
      // Read valid values before disabling controls (FormData omits disabled inputs).
      let task;
      try { task = prepareTask(); } catch (error) { ctx.toast(error.message, true); return; }
      if (typeof task === 'function' && await runLocked(task) && button.isConnected) onComplete?.();
    };
  };
  deviceAction('#enable-device-push', () => { const draft = currentDraft(); if (draft) return () => ctx.enablePush(draft, { file, removePhoto }); });
  deviceAction('#disable-device-push', () => ctx.disablePush, () => {
    const device = ctx.getDevice?.(); if (!device) return;
    root.querySelector('.device-indicator')?.classList.toggle('active', Boolean(device.active));
    root.querySelector('.device-status strong').textContent = device.active ? 'Avisos activos en este dispositivo' : 'Avisos en este dispositivo';
    root.querySelector('#device-notification-description').textContent = deviceMessageFor(device, true);
    const enable = root.querySelector('#enable-device-push');
    enable.innerHTML = `${icon('bell')}${device.active ? 'Comprobar y renovar este dispositivo' : 'Activar avisos en este dispositivo'}`;
    enable.disabled = !device.capability?.supported || !device.ready;
    root.querySelector('#disable-device-push').hidden = !device.active;
  });
  return () => { photoRequest++; preparing = false; if (previewUrl) URL.revokeObjectURL(previewUrl); };
}
