import { escapeHTML as esc } from './domain.js';
import { validatePasswordChange } from './security.js';

export function renderAccess(container,{backend,logo,brandLogo=logo,onAuthenticated,message='',restoring=false}){
  container.inert=false;
  container.innerHTML=`<main class="access-page"><section class="access-intro"><a class="brand"><img class="brand-full" src="${brandLogo}" alt="Orquívia"></a><div><span class="eyebrow">TU EMPRESA, EN UN SOLO LUGAR</span><h1>De la primera propuesta<br>al último cobro.</h1><p>Presupuestos, facturas y seguimiento de tus proyectos.</p></div><small>Acceso privado a los documentos de Orquívia.</small></section><section class="access-card"><div id="auth-content"></div></section></main>`;
  const host=container.querySelector('#auth-content');
  const error=(m)=>{let p=host.querySelector('[role="alert"]');if(!p){p=document.createElement('p');p.className='auth-error';p.setAttribute('role','alert');host.append(p)}p.textContent=m};
  function checking(){
    container.querySelector('.access-page')?.classList.add('is-restoring');
    host.innerHTML=`<div class="access-session-check" role="status" aria-live="polite"><img class="access-session-logo" src="${esc(brandLogo)}" alt="Orquívia"><span class="access-session-spinner" aria-hidden="true"></span><h2>Comprobando tu sesión…</h2><p>Volverás a la página donde estabas.</p></div>`;
  }
  async function finish(existingUser,restored=false){
    try {const user=existingUser||await backend.currentUser();if(!user)throw new Error('Vuelve a iniciar sesión.');const state=await backend.loadState();await onAuthenticated({user,state,restored});}
    catch(e){if(e.code==='MFA_REQUIRED'){await mfa();return}throw e}
  }
  function login(){
    container.querySelector('.access-page')?.classList.remove('is-restoring');
    if(!backend){host.innerHTML='<div class="eyebrow">PORTAL EN PREPARACIÓN</div><h2>La conexión aún no está lista.</h2><p>El acceso se activará al terminar la configuración de Supabase. Los documentos de empresa requieren una cuenta autorizada.</p>';return}
    host.innerHTML=`<div class="eyebrow">BIENVENIDA A ORQUÍVIA</div><h2>Entra en tu espacio.</h2><p>Usa tu cuenta individual para trabajar con los documentos de la empresa.</p><form id="access-form"><label class="field"><span>Correo electrónico</span><input name="email" type="email" autocomplete="username" required></label><label class="field"><span>Contraseña</span><input name="password" type="password" autocomplete="current-password" required></label><button class="button primary full">Iniciar sesión</button></form><p class="field-hint">Usa la contraseña del portal Orquívia, que puede ser distinta de la del correo de Arsys. Puedes cambiarla desde Configuración después de entrar.</p>`;
    if(message)error(message);
    host.querySelector('form').onsubmit=async e=>{e.preventDefault();const b=e.target.querySelector('button');b.disabled=true;b.textContent='Conectando…';const f=new FormData(e.target);try{await backend.signIn(f.get('email'),f.get('password'));e.target.elements.password.value='';await finish();}catch(err){error(err.message);b.disabled=false;b.textContent='Iniciar sesión'}};
  }
  async function mfa(){
    container.querySelector('.access-page')?.classList.remove('is-restoring');
    host.innerHTML='<h2>Verificación en dos pasos</h2><p>Comprobando la protección de tu cuenta…</p>';
    try{const data=await backend.mfa.factors();const factor=(data.totp||data.all||[]).find(f=>f.status==='verified'&&f.factor_type==='totp');
      if(factor){verifyForm(factor.id);return}
      host.innerHTML='<h2>Protege tu cuenta.</h2><p>Configura tu aplicación de autenticación para acceder con contraseña y un código temporal.</p><button class="button primary full" id="enroll-totp">Configurar dos pasos</button>';
      host.querySelector('button').onclick=async()=>{try{const factor=await backend.mfa.enroll();verifyForm(factor.id,factor.totp);}catch(e){error(e.message)}};
    }catch(e){error(e.message)}
  }
  function verifyForm(factorId,totp){
    const qr=totp?.qr_code ? (totp.qr_code.startsWith('data:image/svg+xml')?totp.qr_code:'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(totp.qr_code)):null;
    host.innerHTML=`<h2>${totp?'Vincula tu autenticador.':'Confirma que eres tú.'}</h2><p>${totp?'Escanea el código con tu aplicación de autenticación y escribe los seis dígitos.':'Escribe el código de seis dígitos de tu aplicación de autenticación.'}</p>${qr?`<img class="totp-qr" src="${esc(qr)}" alt="Código para vincular tu cuenta">`:''}${totp?.secret?`<details class="totp-manual"><summary>Vincular manualmente</summary><code>${esc(totp.secret)}</code></details>`:''}<form id="totp-form"><label class="field"><span>Código de verificación</span><input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required></label><button class="button primary full">Verificar y entrar</button></form><button class="text-button" id="cancel-auth">Cerrar sesión</button>`;
    host.querySelector('form').onsubmit=async e=>{e.preventDefault();const b=e.target.querySelector('button');b.disabled=true;try{const challenge=await backend.mfa.challenge(factorId);await backend.mfa.verify(factorId,challenge.id,e.target.elements.code.value);e.target.elements.code.value='';await finish();}catch(err){error(err.message);b.disabled=false}};
    host.querySelector('#cancel-auth').onclick=async()=>{await backend.signOut();login()};
  }
  async function resume(){
    checking();
    if(!backend){login();return false}
    try{const user=await backend.currentUser();if(!user){login();return false}await finish(user,true);return true}
    catch(e){login();error(e.message);return false}
  }
  if(restoring)checking();else login();
  return { resume, enroll:mfa };
}

export function accountMarkup(){return `<section class="card settings-card"><div class="card-header"><div><h2>Tu cuenta</h2><p>Contraseña individual y verificación en dos pasos</p></div></div><form id="password-form"><label class="field"><span>Contraseña actual</span><input name="currentPassword" type="password" autocomplete="current-password" required></label><label class="field"><span>Nueva contraseña</span><input name="newPassword" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></label><label class="field"><span>Repite la nueva contraseña</span><input name="repeatPassword" type="password" autocomplete="new-password" required></label><p class="field-hint">Utiliza al menos 12 caracteres. Al cambiarla se cerrarán las sesiones y tendrás que entrar de nuevo.</p><button class="button secondary full">Cambiar contraseña</button></form><button class="text-button" data-action="mfa">Configurar o verificar dos pasos</button><button class="text-button" data-action="audit">Ver historial de cambios</button></section>`}
export function bindPasswordForm(form,{backend,onComplete,onError}){
  form.onsubmit=async e=>{e.preventDefault();const values=Object.fromEntries(new FormData(form)),errors=validatePasswordChange(values);if(errors.length){onError(errors.join(' '));return}const b=form.querySelector('button');b.disabled=true;try{await backend.changePassword(values.currentPassword,values.newPassword);form.reset();await backend.signOut();onComplete();}catch(err){onError(err.message);b.disabled=false}};
}
