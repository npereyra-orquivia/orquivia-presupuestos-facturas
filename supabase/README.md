# Orquívia: empresa compartida en Supabase

La interfaz se publica en GitHub Pages; los datos reales y los justificantes privados permanecen en Supabase. Nicole administra la empresa y el saldo inicial; Liliana edita clientes, presupuestos, facturas, cobros y gastos en el mismo espacio. Los correos y contraseñas para crear sus cuentas se pasan al script de servidor mediante stdin, nunca al código público.

## Activar el proyecto

1. Aplica **las tres migraciones en orden**: `202610130001_orquivia.sql`, `202610140002_team_production.sql` y `202610140003_expenses.sql`. Con CLI enlazada al proyecto, `supabase db push` aplica las pendientes. La tercera amplía el estado compartido y crea el bucket privado `orquivia-receipts`; necesita el esquema `storage` del proyecto de Supabase. Si el entorno ya tiene las dos primeras, aplica solo la tercera. Mantén `orquivia_private` fuera de los esquemas expuestos de Data API; expón `public`.
2. Desactiva el registro público en Supabase Auth. Ninguna cuenta obtiene membresía automáticamente, aunque alguien consiga crear una cuenta en Auth.
3. Ejecuta `scripts/bootstrap-team.mjs` desde un entorno de operador con la clave privada del proyecto y los dos usuarios autorizados. Recibe un único objeto JSON por stdin con `url`, `serviceKey`, `admin: {email,password,name}`, `editor: {email,password,name}`, y opcionalmente `organizationId`, `statePath`, `requireMfa`, `overwrite`, `expectedVersion`, `expectedHash`. Las contraseñas iniciales deben tener al menos 16 caracteres.
4. Por defecto el script solo valida localmente y no hace llamadas de red. `apply:true` crea las cuentas que falten sin enviar invitaciones, confirma sus direcciones según la provisión autorizada, asigna Nicole como `admin` y Liliana como `editor`, exige MFA y opcionalmente importa el archivo privado indicado. Las cuentas que ya existan conservan sus contraseñas. No muestra ni guarda credenciales. Entrega las contraseñas por el canal privado elegido por sus titulares.
5. Configura únicamente URL y clave **publishable** (o **anon** antigua) en la interfaz/variables Vite. Ninguna clave `service_role`, `sb_secret_…` ni contraseña pertenece al navegador, GitHub o una variable `VITE_…`.

El script no revierte cuentas ya creadas si falla un paso posterior; comprueba el resultado antes de repetirlo. La pertenencia existente evita mover cuentas silenciosamente entre empresas. Un rerun correcto reutiliza la empresa de Nicole; una organización diferente debe indicarse explícitamente. La importación solo procede sobre un espacio recién creado en versión 1. Un resultado ya importado se reconoce mediante SHA-256 estable y se omite sin subir la versión. Si existen cambios posteriores, el script se detiene. Una sustitución deliberada requiere `overwrite:true`, la versión actual y el SHA-256 del estado actual en `expectedVersion` y `expectedHash`; el CAS de la base de datos sigue protegiendo cambios simultáneos.

Estos archivos describen el procedimiento de provisión y actualización. Antes de ejecutar una migración o importación sobre un proyecto existente, comprueba su historial de migraciones y conserva una copia del estado y de los justificantes.

## Acceso y sesiones

`orquivia_memberships` autoriza cada usuario mediante su UUID de Auth y un rol explícito. `anon` y usuarios autenticados ajenos a la empresa no pueden ver datos. Los miembros solo tienen lectura directa de tablas; escriben a través de RPC que vuelven a verificar la membresía. Solo un operador con clave de servidor puede provisionar usuarios, membresías o importar históricos. Liliana puede trabajar con documentos, cobros, gastos y sus adjuntos; los datos de empresa, saldo inicial, IBAN y correo para avisos los modifica Nicole.

El cliente guarda tokens en `sessionStorage`, no en almacenamiento persistente del navegador. `refreshAccess()` llama a la RPC `refresh_orquivia_access`, que vuelve a comprobar membresía y requisito MFA en el servidor sin devolver datos del espacio. La interfaz debe bloquearse ante `ACCESS_REVOKED`, `MFA_REQUIRED` y `SIGNED_OUT`; los dos primeros eventos vacían la empresa y la versión del cliente, por lo que tras recuperar acceso hay que cargar de nuevo. Cada lectura/escritura RPC también comprueba acceso. La revocación no puede borrar una copia que un usuario autorizado ya haya descargado.

El backend ofrece TOTP con `mfa.enroll`, `mfa.challenge`, `mfa.verify`, `mfa.factors` y `mfa.assuranceLevel`, además de cambio de contraseña comprobando primero la actual y cerrando otras sesiones de renovación. Supabase puede mantener un JWT ya emitido hasta su vencimiento; no se promete invalidación instantánea de todas las copias.

El script de provisión de producción configura explícitamente `require_mfa=true`; la interfaz permite inscribir el autenticador en el primer inicio de sesión antes de cargar datos. Las RPC y las políticas de lectura exigen `aal2`. El valor SQL por defecto sigue siendo `false` para migración y pruebas antiguas; un entorno de desarrollo puede pasar `requireMfa:false` expresamente. Prueba alta, verificación y recuperación con las dos titulares antes de dar por terminado el despliegue.

## Contrato de la aplicación

- `loadState()` resuelve la empresa por membresía y devuelve el estado compartido. Una cuenta ajena recibe `MEMBERSHIP_REQUIRED`; no se crea un espacio de demostración como sustituto de datos reales.
- `workspaceInfo()` devuelve `{organizationId,name,role,requireMfa}` después de cargar.
- `saveState(state)` compara la versión actual y guarda con CAS. Cada dispositivo debe cargar primero; un conflicto obliga a conciliar cambios y recargar. Los nuevos documentos se guardan como `draft`, con `number:''`.
- `issueDocument(documentId)` emite el borrador ya guardado y devuelve `{state,version,updatedAt,documentNumber}`. La interfaz sustituye su estado con ese resultado. El servidor asigna `F-AAAA-NNN` a facturas y `PR-AAAA-NNN` a presupuestos, en series separadas por empresa/tipo/año de emisión elegido.
- `auditLog()` permite consultar quién cambió el espacio, cuándo y en qué versión. Los miembros no pueden editar ni borrar el registro.

Los contadores y el registro permanente de numeración no son escribibles desde el navegador. Los números emitidos nunca se reutilizan ni se aceptan libremente del cliente. No se puede borrar un documento emitido ni revertirlo a borrador. Su número, tipo y fecha se conservan. Los datos de facturas emitidas quedan fijos, incluyendo título, forma de pago, metadatos originales y advertencias de importación. Solo notas, PO, contrato, vencimiento y revisión de cobro siguen siendo editables, además del estado derivado de cobros y el total calculado. Los conceptos de presupuestos emitidos pueden actualizarse conservando su identidad. Los cambios quedan auditados. Un proceso de facturas rectificativas requiere una ampliación específica.

La base de datos valida estructura y tipos JSON, precisión de importes/cantidades, calendarios reales, estados por tipo, sumas en céntimos, referencias a clientes/presupuestos/facturas, un único vínculo de factura por presupuesto y cobros positivos que no superen el total. No acepta un total almacenado distinto al calculado. El límite por empresa es 5 MB y 10000 registros por colección.

En el editor, la referencia interna del trabajo es opcional y no aparece en el PDF. PO es una referencia opcional de factura, que puede añadirse al convertir el presupuesto. La fecha prevista y la casilla de aceptación/contrato recibido son seguimiento opcional: modifican los avisos, sin aceptar automáticamente el presupuesto ni cambiar sus importes. Una factura convertida sigue como borrador editable hasta su emisión.

## Gastos y Storage privado

La migración `202610140003_expenses.sql` admite una colección `expenses` en el estado compartido, manteniendo compatibles los estados anteriores sin gastos. Valida proveedor, descripción, fechas, importes con precisión de céntimos, base más IVA igual al total, IVA confirmado entre cero y el IVA soportado, estado del pago y fecha cuando está pagado. Los importes reales del justificante son explícitos; un desglose sugerido por porcentaje no sustituye la revisión del documento.

Cada gasto admite hasta **10 adjuntos**, de **10 MB** (10 485 760 bytes) cada uno. El bucket `orquivia-receipts` tiene `public=false`, limita tamaño y tipos MIME, y admite PDF, JPEG/PNG/WebP/GIF/HEIC/HEIF, Word, Excel, OpenDocument y RTF. El cliente valida nombre, extensión, MIME y firma inicial del formato antes de subir. La opción de foto usa el selector/cámara que ofrezca el navegador; los bytes originales se conservan.

Los objetos usan rutas `organizationId/expenseId/attachmentId.ext`, con UUID y una extensión admitida. Las políticas de Storage verifican la membresía de esa empresa y el segundo factor cuando es obligatorio. No hay lectura anónima, sobrescritura ni traslado de originales desde la aplicación. Las políticas restrictivas mantienen esa frontera aunque posteriormente se añadan políticas generales para otros buckets.

El procedimiento de guardado es:

1. `uploadReceipt(expenseId,file)` sube cada original con un nombre nuevo y `upsert:false`.
2. `saveState(state)` guarda los metadatos `{id,name,path,mimeType,size}` junto al gasto mediante CAS. El servidor exige que cada objeto exista, pertenezca a la empresa y coincida en tamaño y MIME.
3. Para retirar un adjunto, guarda primero el gasto sin su referencia y después llama a `deleteReceipt(attachment)`. La base de datos impide eliminar un objeto que siga referenciado y serializa la eliminación con los guardados del espacio. La interfaz intenta limpiar las nuevas subidas si el guardado falla.

`downloadReceipt(attachment)` descarga con acceso autenticado y sin caché. `receiptUrl(attachment)` puede generar una URL firmada de 60 segundos, que también da acceso a quien la reciba durante su vigencia; la exportación del trimestre usa la descarga autenticada. Los archivos y sus referencias nunca se copian a GitHub Pages. El historial registra cambios y número de gastos; no guarda el contenido binario en la auditoría.

## Trimestre, copias y saldo

`quarterlyReport(state,year,quarter)` reúne facturas emitidas y gastos por la fecha del documento. Sus movimientos de cobro y pago se contabilizan por su propia fecha, incluso cuando el documento corresponde a otro trimestre. Se separan IVA repercutido, IVA soportado registrado e IVA confirmado para revisión. La selección de IVA confirmado no determina por sí sola la deducibilidad ni presenta una declaración.

`quarterCSV` genera el listado y `buildQuarterBundle` prepara un ZIP con `registro-trimestre.csv`, `resumen.txt`, las facturas PDF y los justificantes originales. La exportación usa una instantánea validada y se detiene si falta un archivo o no coincide su tamaño, para evitar un expediente parcial. El límite es 300 MB. La **copia JSON incluye metadatos y rutas de adjuntos, no los archivos**; guarda también los expedientes ZIP. Restaurar los metadatos en otra base no transfiere automáticamente los objetos de Storage.

El saldo inicial se guarda en `company.openingBalance` y `company.openingBalanceDate` y solo puede modificarlo la administradora. Representa el saldo **al comienzo del día elegido**, antes de cualquier movimiento. `cashSummary` suma los cobros registrados y resta los gastos pagados desde esa fecha hasta el día actual. La previsión añade pendientes de cobro confirmados y resta gastos pendientes. Las facturas con cobro por confirmar se excluyen de los cobros previstos. La conciliación bancaria es manual.

## Importar los documentos originales

Los archivos privados y el JSON histórico validado deben permanecer fuera de `public/`, `dist/` y del repositorio publicado. El script de servidor lee `statePath` y llama a `import_orquivia_state`, que solo acepta la clave privilegiada y compara la versión para no sobrescribir cambios simultáneos.

Conserva números originales como `2026-002`; el servidor eleva el contador correspondiente sin renumerarlos. Los originales `2026-002` y `F-2026-002` representan la misma secuencia de factura y no pueden coexistir dentro de esa serie. Las series de presupuestos y facturas son independientes.

Cuando el PDF no demuestra si se pagó una factura, usa `paymentReviewNeeded:true` y `status:'issued'`. El portal y los correos piden revisar el cobro sin presumir que está impagado. Al confirmar un cobro, se registra el pago y se retira esa marca. Si una fecha original es incoherente, conserva la evidencia en `sourceMetadata`, deja `dueDate:null` y añade `importWarnings`; no inventes una fecha. Guarda discrepancias del total original en los metadatos y usa el cálculo consistente para operar.

Los espacios antiguos por usuario quedan conservados pero inaccesibles a la interfaz nueva. Un operador puede exportarlos y validarlos para una importación explícita; no se crean membresías a partir de ellos.

## Avisos con el portal cerrado

Los avisos dentro del portal se calculan al abrirlo. Los correos necesitan un servicio desplegado y activado:

1. Configura Resend con dominio verificado y los secretos Edge `RESEND_API_KEY`, `ORQUIVIA_FROM_EMAIL`, `ORQUIVIA_CRON_SECRET`. Supabase proporciona `SUPABASE_SECRET_KEYS.default` o la antigua `SUPABASE_SERVICE_ROLE_KEY` al servidor; nunca al frontend.
2. Desde la raíz, despliega `supabase functions deploy daily-reminders --no-verify-jwt --use-api`. Se incluye `src/domain.js` para usar exactamente las reglas del portal. La función valida su secreto de cron en cada llamada.
3. Activa pg_cron, pg_net y Vault; en Vault guarda `orquivia_project_url` y `orquivia_cron_secret`. Ejecuta `schedule-reminders.sql`.
4. Nicole activa la casilla y configura el correo para avisos. Sin consentimiento booleano explícito no hay envíos.

Se comprueba cada hora y se envía como máximo un resumen **por empresa**, entre 09:00 y 19:00 de Europe/Madrid, aunque haya dos cuentas. `orquivia_team_reminder_deliveries` conserva el mensaje para reintentos idempotentes. Si cambia el destinatario, se cancela el reintento al anterior. No se escribe a clientes. No hay conexión bancaria ni garantía de entrega; consulta logs de Edge, Cron y entrega, y considera que un proyecto pausado no puede enviar. Para apagar el trabajo: `select cron.unschedule('orquivia-daily-reminders');`.

## Verificación local

`npm test` prueba dominio y cliente con transporte simulado. Para ejecutar PostgreSQL real en memoria sin Docker:

```powershell
npm install --prefix supabase/.verification --no-save --no-package-lock @electric-sql/pglite
node supabase/tests/team-postgres.mjs
```

El conjunto de comprobaciones con PGlite cubre las tres migraciones, acceso compartido, RLS, permisos y requisito MFA, refresco de acceso en servidor, CAS, fechas/importes, bloqueo fiscal y de evidencia original, campos de seguimiento editables, numeración/importación, auditoría, deduplicación de correo por empresa, revocación, gastos y las políticas de originales privados. El esquema de Storage del runner es una representación local para probar las políticas SQL; no ejecuta el gateway de Supabase Storage. PGlite usa una conexión exclusiva: tampoco verifica concurrencia entre conexiones, Supabase Auth/gateway, JWT reales ni cron/correo desplegados. `tests/workspace_security.sql` añade pgTAP para `supabase test db` en el entorno local completo. Antes de producción, prueba las dos cuentas en Supabase, un tercero ajeno, dos ventanas editando, recuperación de acceso y subir, descargar y retirar un justificante privado; no reinicies una base real para ejecutar tests.

Fuentes: [RLS y permisos](https://supabase.com/docs/guides/database/postgres/row-level-security), [funciones SQL](https://supabase.com/docs/guides/database/functions), [crear usuarios desde servidor](https://supabase.com/docs/reference/javascript/auth-admin-createuser), [cron y Vault](https://supabase.com/docs/guides/functions/schedule-functions), [idempotencia Resend](https://resend.com/docs/dashboard/emails/idempotency-keys).
