# Orquívia 1.1 en pruebas

La versión estable permanece en la raíz de GitHub Pages y está etiquetada como
`v1.0.0` (commit `d5ad784`). El flujo protegido de `main` publica la misma 1.0 en
la raíz y toma la rama `codex/email-v1-1` para `/pruebas-v1-1/`. Comparten la empresa privada
de Supabase: la 1.1 no crea una segunda contabilidad.

Cada usuaria configura su propio correo y firma en **Mi espacio**. La contraseña
se introduce únicamente en ese formulario y se guarda mediante Supabase Vault;
el navegador no puede recuperarla. La conexión comprueba SMTP TLS/465 e IMAP
TLS/993, sin enviar mensajes ni leer la bandeja de entrada. Los servidores se
eligen de una lista cerrada de Arsys y se comprueban sus certificados.

**Enviar por correo** aparece en presupuestos preparados o enviados. Se revisan
destinatario, asunto, mensaje, firma y documento antes de pulsar enviar. El
servidor genera el PDF desde los datos canónicos, guarda la copia MIME inmutable
y registra un identificador único antes de contactar con Arsys. Solo la aceptación
SMTP permite marcar como enviado. Después se añade la misma copia a Enviados.
Si falla ese guardado, **Guardar solo la copia** no vuelve a enviar el correo.
Si el resultado SMTP es incierto, no se repite automáticamente.

Los campos **Para** y **CC** admiten varias direcciones separadas por comas o
punto y coma, hasta 20 personas distintas en total. Las direcciones duplicadas
se unifican. El mensaje completo y la firma se previsualizan mientras se edita.
Después de un intento terminado, **Preparar otro envío** permite revisar otros
destinatarios y enviar de nuevo con un identificador independiente; cada envío
queda en el historial. Un resultado parcial o incierto requiere revisar antes
de intentar otro envío para evitar duplicados.

La apertura consulta perfil e historial juntos y los conserva solo en memoria
durante 30 segundos por cuenta y documento. **Actualizar estado** fuerza una
lectura del servidor. Preparar otro envío reutiliza el contexto abierto y crea
un identificador nuevo sin otra espera; el resultado del envío actualiza la
confirmación y el historial directamente. Al cerrar sesión se descarta la caché.
Las comprobaciones de acceso y la validación del envío en el servidor permanecen
activas, también cuando la pantalla reutiliza datos recientes.

El historial del presupuesto combina cambios y envíos por fecha, conservando
actor, destinatarios, asunto y resultado. El cambio automático de estado se
integra en su correo correspondiente cuando la coincidencia es inequívoca;
los cambios manuales permanecen como entradas independientes. El botón
**Volver a enviar por correo** abre directamente un borrador editable con un
identificador nuevo. Los borradores pendientes conservan su contenido e
identificador; un resultado incierto o parcial sigue bloqueando otro intento.
La confirmación de éxito aparece al completar el envío, sin repetirse al reabrir.

El envío registra remitente, destinatario, fecha, estado, identificador y huella
del PDF. Se conserva el cambio manual de estado para correos enviados fuera
del portal. Los cambios simultáneos siguen usando las versiones de la empresa.
Si alguien modifica el presupuesto durante el envío, se conserva el documento
realmente enviado y no se sobrescribe el presupuesto actual.

Despliegue: aplicar las migraciones `202610150012_document_mail.sql` y
`202610150013_mail_recipients.sql`, ejecutar
`node scripts/bundle-mail-function.mjs` y publicar el resultado como función
`document-mail`. La función valida el JWT con Supabase Auth, exige AAL2 y
comprueba membresía activa. Ninguna RPC de correo puede ejecutarse con las
claves públicas ni por la sesión del navegador. Las nuevas tablas están en un
esquema privado, con RLS y sin permisos para anon/authenticated.

Verificación local: `npm test`, `node supabase/tests/document-mail-postgres.mjs`
y build de producción con `VITE_DOCUMENT_MAIL=true`. Los tests SMTP/IMAP usan
dobles de prueba: no envían correos. La prueba real requiere que cada usuaria
conecte su cuenta en el formulario y elija explícitamente un destinatario.
