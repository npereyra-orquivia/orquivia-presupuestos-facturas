import { escapeHTML as esc } from './domain.js';
import { validatePasswordChange } from './security.js';

export function renderAccess(container,{backend,logo,brandLogo=logo,onAuthenticated,message='',restoring=false,recoveryRedirectTo}){
  container.inert=false;
  container.innerHTML=`<main class="access-page"><section class="access-intro"><a class="brand"><img class="brand-full" src="${brandLogo}" alt="Orquivia"></a><div><span class="eyebrow">TU EMPRESA, EN UN SOLO LUGAR</span><h1>De la primera propuesta<br>al último cobro.</h1><p>Presupuestos, facturas y seguimiento de tus proyectos.</p></div><small>Acceso privado a los documentos de Orquivia.</small></section><section class="access-card"><div id="auth-content"></div></section></main>`;
  const host=container.querySelector('#auth-content');
  let revision=0,recoveryActive=false;
  const active=(version)=>version===revision&&container.querySelector('#auth-content')===host&&host.isConnected!==false;
  const nextView=()=>{container.querySelector('.access-page')?.classList.remove('is-restoring');return ++revision};
  const error=(m,version=revision)=>{if(!active(version))return;let p=host.querySelector('[role="alert"]');if(!p){p=document.createElement('p');p.className='auth-error';p.setAttribute('role','alert');host.append(p)}p.textContent=m};
  function checking(){
    const version=nextView();
    container.querySelector('.access-page')?.classList.add('is-restoring');
    host.innerHTML=`<div class="access-session-check" role="status" aria-live="polite"><img class="access-session-logo" src="${esc(brandLogo)}" alt="Orquivia"><span class="access-session-spinner" aria-hidden="true"></span><h2>Comprobando tu sesión…</h2><p>Volverás a la página donde estabas.</p></div>`;
    return version;
  }
  async function finish(existingUser,restored=false,version=revision){
    if(recoveryActive||!active(version))return;
    try {const user=existingUser||await backend.currentUser();if(!active(version)||recoveryActive)return;if(!user)throw new Error('Vuelve a iniciar sesión.');const state=await backend.loadState();if(active(version)&&!recoveryActive)await onAuthenticated({user,state,restored});}
    catch(e){if(!active(version))return;if(e.code==='MFA_REQUIRED'){await mfa();return}throw e}
  }
  function login({notice='',warning='',showMessage=true}={}){
    const version=nextView();recoveryActive=false;
    if(!backend){host.innerHTML='<div class="eyebrow">PORTAL EN PREPARACIÓN</div><h2>La conexión aún no está lista.</h2><p>El acceso se activará al terminar la configuración de Supabase. Los documentos de empresa requieren una cuenta autorizada.</p>';return}
    host.innerHTML=`<div class="eyebrow">BIENVENIDA A ORQUIVIA</div><h2>Entra en tu espacio.</h2><p>Usa tu cuenta individual para trabajar con los documentos de la empresa.</p>${notice?`<p role="status">${esc(notice)}</p>`:''}<form id="access-form"><label class="field"><span>Correo electrónico</span><input name="email" type="email" autocomplete="username" required></label><label class="field"><span>Contraseña</span><input name="password" type="password" autocomplete="current-password" required></label><button class="button primary full">Iniciar sesión</button></form><button class="text-button" id="forgot-password" type="button">¿Has olvidado la contraseña?</button><p class="field-hint">Usa la contraseña del portal Orquivia, que puede ser distinta de la del correo de Arsys. Puedes cambiarla desde Configuración después de entrar.</p>`;
    if(warning||(showMessage&&message))error(warning||message,version);
    const forgot=host.querySelector('#forgot-password');if(forgot)forgot.onclick=()=>requestRecovery(host.querySelector('form').elements.email?.value||'');
    host.querySelector('form').onsubmit=async e=>{e.preventDefault();if(!active(version))return;const b=e.target.querySelector('button');b.disabled=true;b.textContent='Conectando…';const f=new FormData(e.target);try{await backend.signIn(f.get('email'),f.get('password'));e.target.elements.password.value='';if(active(version))await finish(null,false,version);}catch(err){if(active(version)){error(err.message,version);b.disabled=false;b.textContent='Iniciar sesión'}}};
  }
  async function mfa(){
    if(recoveryActive)return recover();
    const version=nextView();
    host.innerHTML='<h2>Verificación en dos pasos</h2><p>Comprobando la protección de tu cuenta…</p>';
    try{const data=await backend.mfa.factors();if(!active(version))return;const factor=(data.totp||data.all||[]).find(f=>f.status==='verified'&&f.factor_type==='totp');
      if(factor){verifyForm(factor.id);return}
      host.innerHTML='<h2>Protege tu cuenta.</h2><p>Configura tu aplicación de autenticación para acceder con contraseña y un código temporal.</p><button class="button primary full" id="enroll-totp">Configurar dos pasos</button>';
      host.querySelector('button').onclick=async()=>{try{const factor=await backend.mfa.enroll();if(active(version))verifyForm(factor.id,factor.totp);}catch(e){error(e.message,version)}};
    }catch(e){error(e.message,version)}
  }
  function verifyForm(factorId,totp){
    const version=nextView();
    const qr=totp?.qr_code ? (totp.qr_code.startsWith('data:image/svg+xml')?totp.qr_code:'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(totp.qr_code)):null;
    host.innerHTML=`<h2>${totp?'Vincula tu autenticador.':'Confirma que eres tú.'}</h2><p>${totp?'Escanea el código con tu aplicación de autenticación y escribe los seis dígitos.':'Escribe el código de seis dígitos de tu aplicación de autenticación.'}</p>${qr?`<img class="totp-qr" src="${esc(qr)}" alt="Código para vincular tu cuenta">`:''}${totp?.secret?`<details class="totp-manual"><summary>Vincular manualmente</summary><code>${esc(totp.secret)}</code></details>`:''}<form id="totp-form"><label class="field"><span>Código de verificación</span><input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required></label><button class="button primary full">Verificar y entrar</button></form><button class="text-button" id="cancel-auth">Cerrar sesión</button>`;
    host.querySelector('form').onsubmit=async e=>{e.preventDefault();if(!active(version))return;const b=e.target.querySelector('button');b.disabled=true;try{const challenge=await backend.mfa.challenge(factorId);if(!active(version))return;await backend.mfa.verify(factorId,challenge.id,e.target.elements.code.value);e.target.elements.code.value='';if(active(version))await finish(null,false,version);}catch(err){if(active(version)){error(err.message,version);b.disabled=false}}};
    host.querySelector('#cancel-auth').onclick=async()=>{try{await backend.signOut();if(active(version))login({showMessage:false})}catch(e){error(e.message,version)}};
  }
  function requestRecovery(email=''){
    const version=nextView();
    host.innerHTML=`<div class="eyebrow">RECUPERAR ACCESO</div><h2>Restablece tu contraseña.</h2><p>Te enviaremos un enlace para elegir una nueva contraseña del portal. Conservarás tu verificación en dos pasos.</p><form id="recovery-request-form"><label class="field"><span>Correo electrónico</span><input name="email" type="email" autocomplete="username" value="${esc(email)}" required></label><button class="button primary full">Enviar enlace de recuperación</button></form><button class="text-button" type="button" id="back-to-login">Volver al inicio de sesión</button>`;
    host.querySelector('#back-to-login').onclick=()=>login({showMessage:false});
    host.querySelector('form').onsubmit=async e=>{e.preventDefault();if(!active(version))return;const b=e.target.querySelector('button');b.disabled=true;b.textContent='Solicitando enlace…';try{await backend.requestPasswordRecovery(new FormData(e.target).get('email'),{redirectTo:recoveryRedirectTo});if(!active(version))return;const confirmed=nextView();host.innerHTML='<h2>Revisa tu correo.</h2><p role="status">Si el correo corresponde a una cuenta autorizada, recibirás un enlace para restablecer la contraseña. Revisa también la carpeta de correo no deseado.</p><button class="button secondary full" type="button" id="back-to-login">Volver al inicio de sesión</button>';host.querySelector('#back-to-login').onclick=()=>{if(active(confirmed))login({showMessage:false})};}catch(err){if(active(version)){error(err.message,version);b.disabled=false;b.textContent='Enviar enlace de recuperación'}}};
  }
  function recoveryCancel(version){
    const cancel=host.querySelector('#cancel-recovery');
    cancel.onclick=async()=>{if(!active(version))return;cancel.disabled=true;try{await backend.signOut();if(active(version))login({showMessage:false})}catch(err){if(active(version)){error(err.message,version);cancel.disabled=false}}};
    return cancel;
  }
  function recoveryProblem(message){
    const version=nextView();
    host.innerHTML='<div class="eyebrow">RECUPERAR ACCESO</div><h2>No se pudo continuar.</h2><p>La recuperación no abre los documentos de la empresa. Cierra esta recuperación para volver a solicitar un enlace si lo necesitas.</p><button class="button secondary full" type="button" id="cancel-recovery">Volver al inicio de sesión</button>';
    recoveryCancel(version);error(message,version);
    return false;
  }
  function showRecoveryStatus(status){
    if(!status?.user)return recoveryProblem('El enlace de recuperación ha caducado o ya no es válido. Solicita uno nuevo.');
    if(!status.factorId)return recoveryProblem('Esta cuenta no tiene un autenticador verificado. Contacta con la administradora para recuperar el acceso sin desactivar la protección de la cuenta.');
    if(status.requiresMfa){recoveryVerifyForm(status.factorId);return true}
    recoveryPasswordForm();return true;
  }
  function recoveryVerifyForm(factorId){
    const version=nextView();
    host.innerHTML='<div class="eyebrow">RECUPERAR ACCESO</div><h2>Confirma que eres tú.</h2><p>Antes de cambiar la contraseña, escribe los seis dígitos de tu aplicación de autenticación.</p><form id="recovery-totp-form"><label class="field"><span>Código de verificación</span><input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required></label><button class="button primary full">Confirmar y continuar</button></form><button class="text-button" type="button" id="cancel-recovery">Cancelar recuperación</button>';
    const cancel=recoveryCancel(version);
    host.querySelector('form').onsubmit=async e=>{e.preventDefault();if(!active(version))return;const b=e.target.querySelector('button');b.disabled=true;cancel.disabled=true;try{const challenge=await backend.mfa.challenge(factorId);if(!active(version))return;await backend.mfa.verify(factorId,challenge.id,e.target.elements.code.value);e.target.elements.code.value='';if(!active(version))return;const status=await backend.recoveryStatus();if(!active(version))return;if(status?.requiresMfa)throw new Error('No se pudo confirmar la verificación. Vuelve a intentarlo con un código nuevo.');showRecoveryStatus(status);}catch(err){if(active(version)){error(err.message,version);b.disabled=false;cancel.disabled=false}}finally{e.target.elements.code.value=''}};
  }
  function recoveryPasswordForm(){
    const version=nextView();
    host.innerHTML='<div class="eyebrow">RECUPERAR ACCESO</div><h2>Elige tu nueva contraseña.</h2><p>Usa entre 12 y 128 caracteres. El cambio cerrará las sesiones y después tendrás que iniciar sesión con la nueva contraseña y tu autenticador.</p><form id="recovery-password-form"><label class="field"><span>Nueva contraseña</span><input name="newPassword" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></label><label class="field"><span>Repite la nueva contraseña</span><input name="repeatPassword" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></label><button class="button primary full">Guardar nueva contraseña</button></form><button class="text-button" type="button" id="cancel-recovery">Cancelar recuperación</button>';
    const cancel=recoveryCancel(version);
    host.querySelector('form').onsubmit=async e=>{e.preventDefault();if(!active(version))return;const values=Object.fromEntries(new FormData(e.target)),errors=[],length=Array.from(values.newPassword||'').length;if(length<12||length>128)errors.push('La nueva contraseña debe tener entre 12 y 128 caracteres.');if(values.newPassword!==values.repeatPassword)errors.push('La confirmación no coincide con la nueva contraseña.');if(errors.length){error(errors.join(' '),version);return}const b=e.target.querySelector('button');b.disabled=true;cancel.disabled=true;b.textContent='Guardando contraseña…';try{const result=await backend.completePasswordRecovery(values.newPassword);if(!active(version))return;if(!result?.completed)throw new Error('No se pudo confirmar el cambio de contraseña. Vuelve a intentarlo.');e.target.reset();login({notice:'Contraseña actualizada. Inicia sesión con tu nueva contraseña y tu autenticador.',warning:result.warning||'',showMessage:false});}catch(err){if(active(version)){error(err.message,version);b.disabled=false;cancel.disabled=false;b.textContent='Guardar nueva contraseña'}}finally{e.target.elements.newPassword.value='';e.target.elements.repeatPassword.value=''}};
  }
  async function recover(credentials=null){
    const version=nextView();recoveryActive=true;
    host.innerHTML='<div class="access-session-check" role="status" aria-live="polite"><span class="access-session-spinner" aria-hidden="true"></span><h2>Comprobando el enlace…</h2><p>Estamos preparando la recuperación segura de tu cuenta.</p></div>';
    try{const status=credentials?await backend.beginPasswordRecovery(credentials):await backend.recoveryStatus();if(!active(version))return false;return showRecoveryStatus(status)}catch(err){if(active(version))return recoveryProblem(err.message);return false}
  }
  async function resume(){
    if(recoveryActive||backend?.hasPasswordRecovery?.())return recover();
    const version=checking();
    if(!backend){login();return false}
    try{const user=await backend.currentUser();if(!active(version))return false;if(!user){login();return false}await finish(user,true,version);return true}
    catch(e){if(active(version)){login();error(e.message)}return false}
  }
  if(restoring)checking();else login();
  return { resume, enroll:mfa, recover, resumeRecovery:()=>recover() };
}

export function accountMarkup(){return `<section class="card settings-card"><div class="card-header"><div><h2>Tu cuenta</h2><p>Contraseña individual y verificación en dos pasos</p></div></div><form id="password-form"><label class="field"><span>Contraseña actual</span><input name="currentPassword" type="password" autocomplete="current-password" required></label><label class="field"><span>Nueva contraseña</span><input name="newPassword" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></label><label class="field"><span>Repite la nueva contraseña</span><input name="repeatPassword" type="password" autocomplete="new-password" required></label><p class="field-hint">Utiliza al menos 12 caracteres. Al cambiarla se cerrarán las sesiones y tendrás que entrar de nuevo.</p><button class="button secondary full">Cambiar contraseña</button></form><button class="text-button" data-action="mfa">Configurar o verificar dos pasos</button><button class="text-button" data-action="audit">Ver historial de cambios</button></section>`}
export function bindPasswordForm(form,{backend,onComplete,onError}){
  form.onsubmit=async e=>{e.preventDefault();const values=Object.fromEntries(new FormData(form)),errors=validatePasswordChange(values);if(errors.length){onError(errors.join(' '));return}const b=form.querySelector('button');b.disabled=true;try{await backend.changePassword(values.currentPassword,values.newPassword);form.reset();await backend.signOut();onComplete();}catch(err){onError(err.message);b.disabled=false}};
}
