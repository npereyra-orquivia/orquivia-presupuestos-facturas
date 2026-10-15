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

El envío registra remitente, destinatario, fecha, estado, identificador y huella
del PDF. Se conserva el cambio manual de estado para correos enviados fuera
del portal. Los cambios simultáneos siguen usando las versiones de la empresa.
Si alguien modifica el presupuesto durante el envío, se conserva el documento
realmente enviado y no se sobrescribe el presupuesto actual.

Despliegue: aplicar la migración `202610150012_document_mail.sql`, ejecutar
`node scripts/bundle-mail-function.mjs` y publicar el resultado como función
`document-mail`. La función valida el JWT con Supabase Auth, exige AAL2 y
comprueba membresía activa. Ninguna RPC de correo puede ejecutarse con las
claves públicas ni por la sesión del navegador. Las nuevas tablas están en un
esquema privado, con RLS y sin permisos para anon/authenticated.

Verificación local: `npm test`, `node supabase/tests/document-mail-postgres.mjs`
y build de producción con `VITE_DOCUMENT_MAIL=true`. Los tests SMTP/IMAP usan
dobles de prueba: no envían correos. La prueba real requiere que cada usuaria
conecte su cuenta en el formulario y elija explícitamente un destinatario.
