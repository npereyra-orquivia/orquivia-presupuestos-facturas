# Orquívia · Presupuestos, facturas, gastos y caja

Portal en español para **GitHub Pages + Supabase**. Nicole y Liliana trabajan con los mismos clientes, presupuestos, facturas, cobros y gastos, cada una con su cuenta. Nicole administra la empresa y el saldo inicial; Liliana puede editar documentos, registrar cobros y gestionar gastos y justificantes. La página pública contiene la interfaz y la pantalla de acceso; los datos y los archivos privados de la empresa se cargan desde Supabase después de verificar la cuenta y el segundo factor.

La versión operativa es **1.2.2**. Incluye envío de presupuestos desde el correo de cada usuaria, firma personal, destinatarios en copia e historial combinado de cambios y envíos. Consulta [el despliegue y el respaldo de la 1.0](EMAIL-V1.1.md).

## Estados financieros

La pestaña **Estados financieros** permite elegir el período de pérdidas y ganancias y la fecha de corte del balance, descargar ambos en un PDF y exportar el detalle en CSV. Las ventas se reconocen por fecha de factura, sin IVA y aunque todavía no se hayan cobrado. Los presupuestos y los cobros no duplican los ingresos. El banco, los clientes pendientes de cobro y los proveedores pendientes de pago se muestran por separado.

El informe es provisional: las bases y cuotas de IVA desconocidas, constitución, suplidos y ajustes contables no se estiman para aparentar un resultado cerrado. El resultado parcial se distingue del resultado contable completo, que permanece por completar. El balance no añade capital ni beneficio para forzar su igualdad. Administración puede aportar capital declarado, financiación y saldo del extracto para una fecha concreta, indicando su fuente y si falta acreditar el desembolso del capital. Estos datos no modifican la caja ni generan movimientos bancarios. Las diferencias entre saldo aportado y calculado quedan pendientes de conciliación. El gestor debe completar existencias, amortizaciones, saldos fiscales y demás ajustes antes de considerar cerrados los estados.

Los paquetes de gastos revisados admiten movimientos sin archivo únicamente si incluyen una nota de justificante pendiente y mantienen la revisión del registro y del IVA. La importación conserva los identificadores y omite los duplicados; los registros y adjuntos siguen siendo privados. No se infiere IVA de un cargo bancario. Las retenciones bancarias temporales compensadas se separan del gasto corriente.

## Probar en el ordenador

Requiere Node.js 22.12 o posterior.

```sh
npm ci
npm run dev
```

Abre `http://127.0.0.1:5173/`. En Windows también puedes abrir `Abrir Orquivia.cmd`; mantén su ventana abierta mientras utilizas el portal.

La preparación local carga `private/initial-state.json`, si existe, mediante una ruta del servidor de desarrollo limitada a localhost. Conserva los cambios de esa preparación en `sessionStorage` de la pestaña. El archivo privado y esa ruta no se incluyen en el build publicado. No se importa nada a Supabase desde la preparación local. Para probar con datos ficticios, abre `http://127.0.0.1:5173/?demo=1`; sus PDF se identifican como documentos de prueba.

Los justificantes adjuntos en modo local se guardan en IndexedDB de ese navegador. No se sincronizan con Supabase ni se incluyen en el build. Desde **Informes y gestor**, descarga un expediente del período que necesites para conservar una copia de los archivos junto a sus registros.

## Preparar Supabase

Consulta [supabase/README.md](supabase/README.md) para el procedimiento completo de provisión, importación, seguridad y pruebas del entorno real.

1. Crea un proyecto y aplica **las trece migraciones en orden**: `202610130001_orquivia.sql`, `202610140002_team_production.sql`, `202610140003_expenses.sql`, `202610140004_personal_profiles.sql`, `202610140005_push_runtime.sql`, `202610140006_personal_identity.sql`, `202610140007_expense_quick_entry.sql`, `202610140008_vat_document_status.sql`, `202610140009_record_history.sql`, `202610140010_tax_records_missing_receipts.sql`, `202610150011_prepared_quotes.sql`, `202610150012_document_mail.sql` y `202610150013_mail_recipients.sql`, dentro de `supabase/migrations/`. La tercera añade gastos y justificantes privados; la cuarta incorpora perfiles, fotos y dispositivos privados por usuaria; la quinta prepara el servicio de avisos; la sexta vincula cada petición personal a la usuaria que la inició; la séptima permite el registro rápido de gastos y sus desgloses pendientes de revisión; la octava conserva la evidencia fiscal sin confirmar el IVA; la novena añade un historial por registro calculado por el servidor. En un proyecto existente, aplica únicamente las migraciones pendientes. Expón `public` mediante Data API y mantén `orquivia_private` fuera de los esquemas expuestos.
2. Desactiva el registro público en Supabase Auth. Configura la URL del sitio y los destinos de autenticación para la dirección final de GitHub Pages, sin comodines abiertos.
3. Desde un entorno de operador, ejecuta `supabase/scripts/bootstrap-team.mjs` con su configuración por stdin. El script valida por defecto sin crear nada; `apply:true` provisiona las dos cuentas, asigna los roles y exige MFA. Las contraseñas iniciales tienen al menos 16 caracteres. La clave de servidor y las contraseñas se mantienen fuera del navegador y del repositorio.
4. Para importar el histórico, indica al script el archivo privado validado en `statePath`. La importación conserva números originales y advertencias; solo procede sobre un espacio nuevo o reconoce una importación idéntica ya realizada. Los cambios posteriores no se sobrescriben en un reintento.
5. Comprueba el acceso de las dos titulares, el alta y la verificación del autenticador, el rechazo de una cuenta ajena y los conflictos entre dos sesiones antes de dar por finalizado el despliegue.

El acceso distingue los fallos temporales de red/servicio y el exceso de intentos de los rechazos de credenciales. Los estados particulares de una cuenta comparten un mensaje genérico para evitar revelar si una dirección existe. La contraseña del portal es independiente de la del buzón de Arsys.

**¿Has olvidado la contraseña?** solicita un enlace a Supabase Auth. Configura previamente un SMTP propio en **Authentication → Emails → SMTP Settings**; la conexión de correo personal para enviar presupuestos es independiente de este remitente de acceso. La **Site URL** debe ser la raíz oficial del portal y cualquier redirección adicional debe estar permitida de forma explícita. El portal acepta únicamente callbacks de recuperación, elimina sus credenciales de la dirección antes de continuar y verifica la sesión con Auth. Antes de elegir la nueva contraseña exige el autenticador TOTP ya verificado de la cuenta, sin sustituirlo ni desactivarlo. La recuperación mantiene los documentos cerrados, conserva un marcador de continuidad por pestaña y caduca a los 30 minutos. El cambio admite entre 12 y 128 caracteres, conserva los espacios, cierra las sesiones y pide un inicio de sesión normal; si un cierre falla, muestra esa incidencia. La contraseña nueva se introduce y guarda personalmente en el formulario, nunca en el chat, SQL ni archivos de configuración. No se requieren migraciones ni cambios de permisos para recuperar una cuenta existente.

La pertenencia a la empresa requiere una membresía explícita. Las políticas RLS y las funciones del servidor comprueban esa membresía y el nivel MFA antes de permitir leer o guardar datos. El navegador guarda la sesión en `sessionStorage`; la interfaz se bloquea al cerrar sesión, perder acceso o alcanzar 30 minutos de inactividad. El cambio de contraseña exige la contraseña actual y vuelve a pedir inicio de sesión. Las modificaciones se registran en una auditoría que las cuentas de la aplicación no pueden borrar.

El servidor compara la versión cargada al guardar o emitir, dentro de una transacción con bloqueo de fila. Si otra cuenta guardó antes, rechaza el segundo guardado completo. La interfaz conserva el formulario y muestra un aviso persistente para comparar los cambios y recuperar la versión actual de manera explícita. El historial de cada presupuesto, factura o gasto muestra la cuenta, la fecha y los campos modificados desde la aplicación de la migración 009. El servidor obtiene la identidad de la sesión y calcula los campos cambiados; no acepta una autoría indicada por el navegador. Los cambios anteriores permanecen en la auditoría general y no se reconstruyen como historial detallado.

Al recargar, aparece **Comprobando tu sesión…** mientras se verifica el acceso. Con una sesión válida, vuelves a la sección y al filtro donde estabas, por ejemplo **Gastos → Por revisar**. También se conservan las búsquedas de esa pestaña y el período elegido en **Informes y gestor**, separados por cuenta. La URL identifica la sección y el filtro; los términos de búsqueda permanecen en `sessionStorage` y no se añaden a la URL. Los botones Atrás y Adelante del navegador recuperan la navegación. La recarga conserva la navegación, pero no guarda automáticamente formularios pendientes. Una sesión caducada o bloqueada sigue requiriendo identificación antes de mostrar datos privados.

## Publicar en GitHub Pages

1. Sube el código a la rama `main`. Revisa la lista de archivos antes de subirla: **no publiques** `private/`, `tmp/`, `output/`, `node_modules/`, `dist/`, `.env`, documentos originales, copias JSON, contraseñas ni claves de servidor. `.gitignore` excluye las carpetas y archivos locales habituales; una carga manual por navegador también debe respetar estas exclusiones.
2. En **Settings → Pages → Build and deployment**, selecciona **GitHub Actions**.
3. En **Settings → Secrets and variables → Actions → Variables**, configura `VITE_SUPABASE_URL` y `VITE_SUPABASE_PUBLISHABLE_KEY`. Son la URL del proyecto y su clave **publishable**, o la clave antigua **anon**. Nunca uses `service_role` ni `sb_secret_…` en una variable `VITE_…`.
4. Ejecuta el workflow **Publicar Orquívia en GitHub Pages** o haz un push a `main`. El workflow establece `VITE_APP_MODE=production` y `VITE_DOCUMENT_MAIL=true`, instala las dependencias, ejecuta las pruebas de aplicación y correo/PostgreSQL y llama a `npm run build:production`. Después añade la redirección de la antigua dirección de pruebas y revisa el artefacto completo antes de publicar.
5. Comprueba la dirección que muestra GitHub en el despliegue y en Settings → Pages. Las rutas relativas permiten servir el portal bajo `/nombre-del-repositorio/`.

`build:production` se detiene si falta el modo de producción o una configuración pública válida. Después de compilar, revisa `dist` con `scripts/check-public-build.mjs`: rechaza documentos privados, nombres de archivos sensibles, claves `sb_secret_…` y, si existe el histórico local, los datos identificativos de sus clientes y de la empresa. Esta comprobación complementa la revisión de archivos; no sustituye las políticas de Supabase. El build normal sin configuración muestra una pantalla de preparación bloqueada y no da acceso al histórico local.

Para compilar la versión oficial desde un entorno local, configura esas cuatro variables en el entorno. Puedes usar `.env.example` como referencia para los valores públicos, pero `assert-production-config.mjs` lee las variables del proceso: hay que declararlas también en la terminal que ejecute `npm run build:production`.

## Trabajar con documentos

- Completa los datos fiscales de la empresa y del cliente antes de emitir. Puedes crear una factura directamente o convertir un presupuesto en una factura vinculada.
- En el desplegable **Cliente** puedes buscar una ficha o elegir **Crear cliente**. Al guardar o cancelar la ficha vuelves al documento conservando lo que habías escrito. Los calendarios permiten elegir la fecha o introducirla en el campo.
- Los borradores no tienen número definitivo. **Preparar presupuesto** asigna su número y lo deja como **Preparado**, todavía sin enviar. Puedes marcarlo **Enviado** en el desplegable cuando lo entregues al cliente; cambiar el estado no manda correos. **Enviar por correo** permite revisar el mensaje, la firma, el PDF, los destinatarios y las copias antes de enviarlo desde el buzón personal; el envío aceptado queda registrado y actualiza el estado automáticamente. Si ya se envió, **Volver a enviar por correo** prepara otro borrador. Al preparar un presupuesto o emitir una factura, el servidor asigna una secuencia anual independiente (`PR-AAAA-NNN` y `F-AAAA-NNN`). La conversión conserva el número del presupuesto y asigna a la factura el siguiente número de su propia serie. Los números históricos importados se conservan y cuentan para la secuencia correspondiente.
- Los presupuestos muestran el importe sin IVA y la nota **IVA no incluido**. El tipo configurado en **IVA al facturar** se conserva para la factura vinculada, cuyo PDF desglosa el IVA. Los importes de las listas y el CSV de presupuestos siguen el mismo criterio sin IVA. El separador de miles aparece desde 1.000; las vistas y PDF mantienen los importes completos y el símbolo €.
- Los documentos emitidos no pueden borrarse, volver a borrador ni cambiar de número, tipo o fecha. Los conceptos y datos fiscales de una factura emitida quedan fijos. Sus notas, referencia **PO / orden de pedido**, vencimiento y seguimiento de contrato siguen siendo editables. Las rectificativas requieren una ampliación específica.
- Descarga el PDF desde el detalle. Los importes se calculan en céntimos, con IVA, descuentos y retenciones; los documentos largos se reparten en varias páginas. Al emitir se conserva una copia de los datos de empresa y cliente.
- Verifica los movimientos bancarios y usa **Registrar cobro** para registrar pagos completos o parciales. El portal no tiene conexión con el banco. Las facturas históricas cuyo pago no está acreditado quedan **por revisar** y no se cuentan como deuda confirmada hasta revisar el cobro.
- La **Referencia interna del trabajo** es opcional: ayuda a encontrar el documento en el portal y no aparece en el PDF. El campo **PO / orden de pedido** aparece en la factura y también es opcional; puedes completarlo al convertir un presupuesto o después de emitir la factura.
- **Seguimiento opcional de la aceptación o contrato** permite anotar una fecha prevista y generar un aviso hasta marcar **Aceptación / contrato recibido**. Puedes dejar ambos campos vacíos. Este seguimiento no cambia el estado ni los importes del presupuesto; la aceptación del presupuesto se gestiona por separado. Las advertencias de importación señalan las fechas o importes originales que requieren revisión.
- Exporta listas a CSV y descarga una copia JSON desde Configuración. La restauración de una copia local es independiente de la importación administrada del espacio compartido.

Los cambios de otra sesión se detectan mediante una versión en el servidor para impedir sobrescrituras silenciosas. Si aparece un conflicto, recarga y concilia los cambios antes de volver a guardar.

## Registrar gastos

En **Gastos → Nuevo gasto**, indica el **concepto / nombre del gasto**, el **total con IVA incluido** y añade **una foto o un archivo como justificante**. La fecha del justificante se propone como hoy. En **IVA del justificante** puedes seleccionar su porcentaje, introducir el importe que figura en el documento cuando haya varios tipos o conservarlo como **Por revisar**. Si el documento dice que incluye IVA sin indicar el desglose, selecciona **IVA incluido, sin desglose**; si no da información de IVA, elige **Justificante sin datos de IVA**. Estas dos opciones conservan el total y la evidencia para el gestor sin inventar un porcentaje ni una cuota. **Sin IVA** solo corresponde cuando se ha confirmado que el gasto no lleva IVA.

La casilla **Ya está pagado** aparece marcada al crear un gasto: comprueba que corresponde al pago real y desmárcala si está pendiente. En **Más detalles** puedes cambiar las fechas del justificante y del pago y completar el proveedor, NIF, número de factura o ticket, categoría, notas y desglose para el gestor. El proveedor y esos datos complementarios son opcionales. Los importes con IVA sin confirmar cuentan en el total y, si están pagados, en caja; su base e IVA fiscales permanecen desconocidos y se exportan vacíos en el CSV, también cuando se ha anotado que el IVA está incluido o que el justificante no da datos de IVA.

Si no tienes ticket, marca **No tengo justificante** y escribe el motivo (hasta 2000 caracteres). Puedes guardar el concepto, importe y pago sin archivo; se conserva una advertencia visible y la nota se incluye en el CSV y el expediente. Esta anotación completa la revisión operativa, salvo que vuelvas a marcar **Revisar este justificante con el gestor**, pero no confirma una base fiscal, un IVA ni una deducción. Añadir después un justificante elimina la anotación actual de falta de archivo, conservando el historial de cambios.

Puedes **Adjuntar archivos** descargados del correo o usar **Tomar una foto**. En un móvil compatible, esta opción abre la cámara; el navegador puede ofrecer también su selector de archivos. Se admiten PDF, fotos JPEG/PNG/WebP/GIF/HEIC/HEIF y documentos Word, Excel, OpenDocument y RTF: hasta **10 archivos por gasto**, de **10 MB por archivo** (10 485 760 bytes). Los archivos se suben al guardar el gasto y permanecen privados en Supabase Storage. Los formatos de archivo no se convierten.

La lista de **Gastos** muestra todo el histórico. Busca por concepto, proveedor o número y filtra por **Todos**, **Pagados**, **Pendientes** o **Por revisar**. Selecciona el concepto para editar el registro. El saldo inicial y el saldo según el registro se consultan en **Resumen**.

## Ver justificantes

Al abrir un gasto por su concepto o el número de **archivos** de la columna **Justificantes**, se muestran sus datos y la vista previa juntos. En una pantalla amplia, el formulario queda a la izquierda y el justificante a la derecha; en móvil, la vista previa aparece debajo. Una foto o archivo recién adjuntado se muestra automáticamente, antes de guardar. Pulsa **Ver** junto a otro adjunto para cambiar la vista o **Ampliar visor** para abrirlo más grande; al cerrar el visor se conserva el borrador del formulario.

**Pagados** indica el estado del pago; **Por revisar** reúne los justificantes marcados para el gestor, sin archivo o con IVA pendiente que aún no se ha clasificado. Un mismo gasto puede estar en ambos filtros. Para completar su revisión operativa, consulta sus notas y documento y desmarca **Revisar este justificante con el gestor** en **Más detalles**, conservando su estado de pago. Si faltan datos de IVA, puedes elegir **IVA incluido, sin desglose** o **Justificante sin datos de IVA** según la evidencia: con un archivo adjunto y sin otras marcas pendientes, el gasto sale de **Por revisar**. Su clasificación fiscal sigue visible para el gestor y no se confirma automáticamente el IVA ni su deducibilidad.

El visor muestra **PDF y fotos** dentro del portal. Permite cambiar de justificante, pasar páginas del PDF, ampliar, ajustar y girar la vista. Si el PDF tiene contraseña, la pide para abrirlo y no la guarda. El soporte de HEIC/HEIF depende del navegador; si no puede mostrar una imagen, aparece una explicación. Para Word, Excel y otros formatos, utiliza **Descargar original**. Esta opción también está disponible para PDF y fotos y conserva el archivo original intacto.

Los justificantes guardados se cargan mediante la sesión privada y el visor se cierra al bloquear o cerrar la sesión. La vista previa no modifica ni sustituye los originales.

## Informes y gestor

**Resumen** muestra los totales de todo el histórico: facturación emitida, gastos de proveedores, cobros y salidas de dinero. **Informes y gestor** calcula los mismos totales para el trimestre, año o histórico elegido. Los documentos usan la fecha de emisión; el dinero usa la fecha real del movimiento. El total de gastos incluye el IVA registrado y resta los abonos. Las salidas de dinero suman los pagos brutos de gastos e impuestos; las devoluciones se muestran aparte y se restan para obtener la salida neta.

El gráfico mensual sitúa los cobros y devoluciones por encima del cero y los pagos por debajo, con una escala común en euros. Los pagos se desglosan por categoría y separan los impuestos. **Ver datos por mes** permite consultar los importes exactos. El gráfico y sus totales son independientes del saldo inicial de caja; el expediente incluye también el desglose de pagos brutos, devoluciones y movimientos netos.

En **Informes y gestor**, elige **Un trimestre**, **Un año completo** o **Todo el histórico** para reunir las facturas emitidas y los gastos del período. Selecciona el año y, cuando corresponda, el trimestre. Puedes descargar:

- **Descargar listado CSV**, con facturas emitidas y gastos, sus importes, estados y referencias a justificantes.
- **Descargar expediente**, un ZIP con el CSV, un resumen, los PDF de las facturas emitidas y los justificantes originales de los gastos. Si un adjunto registrado no puede recuperarse completo, la exportación se detiene y no crea un paquete parcial. El paquete admite hasta 300 MB; para históricos mayores, exporta por año o trimestre.

Los documentos se agrupan por su fecha de emisión o de justificante; los movimientos de caja usan sus propias fechas de cobro y pago. La evaluación del período muestra ventas sin IVA, bases de gastos desglosados, diferencia de bases, cobros y pagos registrados y totales mensuales. La diferencia queda **Por revisar** cuando hay gastos con IVA pendiente; compara las bases registradas y no representa el beneficio fiscal ni el saldo bancario.

El IVA repercutido, el IVA soportado registrado y el IVA confirmado por la usuaria se distinguen en los informes y el resumen del expediente. Los gastos con **IVA incluido, sin desglose** o **Justificante sin datos de IVA** conservan esa indicación en el listado y dejan vacías las columnas de base, cuota de IVA e IVA confirmado: desconocido no equivale a cero. Cerrar su revisión operativa no rellena esas columnas ni los incorpora a los totales de IVA conocido. Confirmar un importe prepara su revisión y no determina que sea deducible. El gestor revisa los justificantes y presenta las declaraciones; la aplicación prepara el expediente.

**Importar gastos revisados** acepta paquetes ZIP preparados con los datos revisados y sus justificantes originales. Comprueba el paquete, muestra los registros nuevos y los que necesitan revisión y omite los duplicados reconocidos antes de importar. Esta opción se utiliza en la empresa conectada a Supabase.

La **copia JSON de Configuración contiene únicamente los datos y las referencias de los adjuntos**, no sus bytes. Conserva también los ZIP de los expedientes para respaldar los justificantes.

En **Declaraciones y pagos de impuestos**, guarda los modelos **111** y **303** con ejercicio, trimestre fiscal, fecha de presentación, resultado y documento original. Un resultado cero se archiva como **Sin ingreso**, sin movimiento de caja. Un pago confirmado usa su fecha real de cargo; una devolución confirmada usa un importe negativo. **Pago por confirmar** no afecta a caja ni a la previsión; **Pendiente de pago** se incluye en la previsión. Si un impuesto ya forma parte de un suplido registrado en un gasto del gestor, vincúlalo con **Incluido en un pago al gestor** para evitar descontarlo dos veces. Las declaraciones aparecen por su ejercicio y trimestre fiscal, aunque se presenten después; sus pagos aparecen por la fecha real del movimiento. Se exportan como registros separados y sus PDF originales se incluyen en la carpeta `declaraciones` del expediente. No se mezclan con las bases de gastos ni con su IVA soportado. La aplicación archiva las declaraciones, pero no las presenta ni realiza pagos.

## Saldo registrado y previsión

Nicole puede configurar un **saldo inicial al comienzo de un día**, antes de sus movimientos. Sirve para empezar a utilizar el portal desde una fecha concreta sin introducir todos los movimientos anteriores: anota el saldo real disponible al comienzo de ese día y registra los cobros y pagos desde entonces. Por ejemplo, un saldo inicial de **2.500 €**, un cobro posterior de **600 €** y un gasto pagado de **100 €** producen un saldo registrado de **3.000 €**. El saldo inicial no es una factura, un ingreso por ventas ni un gasto, y no genera IVA.

Desde la fecha elegida, el portal calcula **saldo inicial + cobros registrados − gastos pagados − pagos fiscales separados**, hasta el día actual. Las devoluciones fiscales confirmadas aumentan el saldo; los impuestos incluidos en otro gasto no se vuelven a descontar. Un cobro o pago de ese mismo día se suma o resta una vez, porque el saldo inicial representa el comienzo del día. Los movimientos anteriores quedan fuera de este cálculo. Si prefieres reconstruir la caja desde el inicio de la empresa, elige el saldo real y una fecha anteriores al primer movimiento registrado; no es obligatorio empezar desde cero.

El histórico documental es independiente del punto de partida de caja: puedes conservar e informar facturas y gastos anteriores sin volver a contabilizar sus pagos anteriores a la fecha elegida. Un documento antiguo cobrado o pagado después de esa fecha sí afecta a caja en la fecha de su movimiento. Los documentos pendientes no alteran el saldo actual. La previsión añade cobros pendientes confirmados y resta gastos pendientes; excluye las facturas históricas cuyo cobro sigue por confirmar.

El saldo representa los movimientos registrados en el portal. Revisa y concilia el resultado con la cuenta bancaria y registra los gastos o cobros que falten; no hay conexión automática con el banco.

## Recordatorios

En **Mi espacio**, cada usuaria elige si quiere recordatorios de cobros pendientes, aceptación o contrato y registros por revisar. Puede indicar cuántos días antes del plazo recibir un aviso, incluir el mismo día, repetir pendientes cada cierto número de días y elegir la hora de España peninsular. Un `0` desactiva la antelación o la repetición. Los recordatorios personales están **desactivados por defecto** y se guardan separados de la información de la empresa.

Para recibirlos con el portal cerrado hacen falta el servicio push y el cron desplegados, las preferencias activadas, el registro de ese dispositivo y el permiso del navegador. Pulsa **Activar avisos en este dispositivo** desde Mi espacio. El servidor comprueba los pendientes cada hora, en el minuto 20, y envía como máximo un resumen por dispositivo y día, a partir de la hora elegida; no promete llegar en el minuto exacto seleccionado. Las notificaciones muestran un mensaje general: los clientes, importes y documentos se consultan después de iniciar sesión. **Desactivar este dispositivo** retira su registro; las preferencias personales siguen disponibles para otros dispositivos.

En un **iPhone**, abre el portal oficial en Safari, toca **Compartir → Añadir a pantalla de inicio** y entra desde ese nuevo icono. Después inicia sesión, abre Mi espacio y activa los avisos en el dispositivo cuando el sistema lo permita. Los avisos web en iPhone requieren una versión de iOS compatible (16.4 o posterior) y abrir el acceso instalado. La web app requiere conexión para cargar datos; no guarda documentos financieros en una caché del service worker.

El despliegue del servicio y del cron se describe en [supabase/README.md](supabase/README.md). Los correos de empresa son una alternativa independiente que requiere configurar su proveedor y su propio cron. Preparar el código de un servicio no lo activa.

## Perfil y barra lateral

Pulsa tu nombre o tu avatar para abrir **Mi espacio**. Puedes cambiar el nombre que ves en el portal y elegir o quitar una foto. El nombre y la foto pertenecen solo a esa cuenta y no modifican los datos fiscales, documentos ni cobros de Orquívia. Las imágenes elegidas se recortan y reducen en el navegador antes de guardarlas en el bucket privado `orquivia-avatars`; se admiten JPG, PNG y WebP, y el archivo guardado no supera 2 MB. Sin foto aparece la inicial del nombre personal. La zona de seguridad permite cambiar la contraseña.

El botón junto al logo pliega la barra lateral y conserva los iconos de navegación con sus etiquetas al pasar el cursor. La preferencia de plegado se conserva en ese navegador.

## Comprobaciones

```sh
npm test
npm run build
node scripts/check-public-build.mjs
```

Para el build publicable con configuración de producción válida:

```sh
npm run build:production
```

La carpeta `dist` es el resultado estático. Las pruebas de PostgreSQL y sus límites se describen en [supabase/README.md](supabase/README.md); las pruebas locales no verifican Supabase Auth, el gateway, el correo ni la concurrencia real del proyecto desplegado.
