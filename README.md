# Orquívia · Presupuestos, facturas, gastos y caja

Portal en español para **GitHub Pages + Supabase**. Nicole y Liliana trabajan con los mismos clientes, presupuestos, facturas, cobros y gastos, cada una con su cuenta. Nicole administra la empresa y el saldo inicial; Liliana puede editar documentos, registrar cobros y gestionar gastos y justificantes. La página pública contiene la interfaz y la pantalla de acceso; los datos y los archivos privados de la empresa se cargan desde Supabase después de verificar la cuenta y el segundo factor.

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

1. Crea un proyecto y aplica **las siete migraciones en orden**: `202610130001_orquivia.sql`, `202610140002_team_production.sql`, `202610140003_expenses.sql`, `202610140004_personal_profiles.sql`, `202610140005_push_runtime.sql`, `202610140006_personal_identity.sql` y `202610140007_expense_quick_entry.sql`, dentro de `supabase/migrations/`. La tercera añade gastos y justificantes privados; la cuarta incorpora perfiles, fotos y dispositivos privados por usuaria; la quinta prepara el servicio de avisos; la sexta vincula cada petición personal a la usuaria que la inició y la séptima permite el registro rápido de gastos y sus desgloses pendientes de revisión. En un proyecto existente, aplica únicamente las migraciones pendientes. Expón `public` mediante Data API y mantén `orquivia_private` fuera de los esquemas expuestos.
2. Desactiva el registro público en Supabase Auth. Configura la URL del sitio y los destinos de autenticación para la dirección final de GitHub Pages, sin comodines abiertos.
3. Desde un entorno de operador, ejecuta `supabase/scripts/bootstrap-team.mjs` con su configuración por stdin. El script valida por defecto sin crear nada; `apply:true` provisiona las dos cuentas, asigna los roles y exige MFA. Las contraseñas iniciales tienen al menos 16 caracteres. La clave de servidor y las contraseñas se mantienen fuera del navegador y del repositorio.
4. Para importar el histórico, indica al script el archivo privado validado en `statePath`. La importación conserva números originales y advertencias; solo procede sobre un espacio nuevo o reconoce una importación idéntica ya realizada. Los cambios posteriores no se sobrescriben en un reintento.
5. Comprueba el acceso de las dos titulares, el alta y la verificación del autenticador, el rechazo de una cuenta ajena y los conflictos entre dos sesiones antes de dar por finalizado el despliegue.

La pertenencia a la empresa requiere una membresía explícita. Las políticas RLS y las funciones del servidor comprueban esa membresía y el nivel MFA antes de permitir leer o guardar datos. El navegador guarda la sesión en `sessionStorage`; la interfaz se bloquea al cerrar sesión, perder acceso o alcanzar 30 minutos de inactividad. El cambio de contraseña exige la contraseña actual y vuelve a pedir inicio de sesión. Las modificaciones se registran en una auditoría que las cuentas de la aplicación no pueden borrar.

## Publicar en GitHub Pages

1. Sube el código a la rama `main`. Revisa la lista de archivos antes de subirla: **no publiques** `private/`, `tmp/`, `output/`, `node_modules/`, `dist/`, `.env`, documentos originales, copias JSON, contraseñas ni claves de servidor. `.gitignore` excluye las carpetas y archivos locales habituales; una carga manual por navegador también debe respetar estas exclusiones.
2. En **Settings → Pages → Build and deployment**, selecciona **GitHub Actions**.
3. En **Settings → Secrets and variables → Actions → Variables**, configura `VITE_SUPABASE_URL` y `VITE_SUPABASE_PUBLISHABLE_KEY`. Son la URL del proyecto y su clave **publishable**, o la clave antigua **anon**. Nunca uses `service_role` ni `sb_secret_…` en una variable `VITE_…`.
4. Ejecuta el workflow **Publicar Orquívia en GitHub Pages** o haz un push a `main`. El workflow establece `VITE_APP_MODE=production`, instala las dependencias, ejecuta las pruebas y llama a `npm run build:production` antes de publicar.
5. Comprueba la dirección que muestra GitHub en el despliegue y en Settings → Pages. Las rutas relativas permiten servir el portal bajo `/nombre-del-repositorio/`.

`build:production` se detiene si falta el modo de producción o una configuración pública válida. Después de compilar, revisa `dist` con `scripts/check-public-build.mjs`: rechaza documentos privados, nombres de archivos sensibles, claves `sb_secret_…` y, si existe el histórico local, los datos identificativos de sus clientes y de la empresa. Esta comprobación complementa la revisión de archivos; no sustituye las políticas de Supabase. El build normal sin configuración muestra una pantalla de preparación bloqueada y no da acceso al histórico local.

Para compilar la versión oficial desde un entorno local, configura esas tres variables en el entorno. Puedes usar `.env.example` como referencia para los valores públicos, pero `assert-production-config.mjs` lee las variables del proceso: hay que declararlas también en la terminal que ejecute `npm run build:production`.

## Trabajar con documentos

- Completa los datos fiscales de la empresa y del cliente antes de emitir. Puedes crear una factura directamente o convertir un presupuesto en una factura vinculada.
- En el desplegable **Cliente** puedes buscar una ficha o elegir **Crear cliente**. Al guardar o cancelar la ficha vuelves al documento conservando lo que habías escrito. Los calendarios permiten elegir la fecha o introducirla en el campo.
- Los borradores no tienen número definitivo. Al emitir, el servidor asigna una secuencia anual independiente para presupuestos (`PR-AAAA-NNN`) y facturas (`F-AAAA-NNN`). La conversión conserva el número del presupuesto y asigna a la factura el siguiente número de su propia serie. Los números históricos importados se conservan y cuentan para la secuencia correspondiente.
- Los documentos emitidos no pueden borrarse, volver a borrador ni cambiar de número, tipo o fecha. Los conceptos y datos fiscales de una factura emitida quedan fijos. Sus notas, referencia **PO / orden de pedido**, vencimiento y seguimiento de contrato siguen siendo editables. Las rectificativas requieren una ampliación específica.
- Descarga el PDF desde el detalle. Los importes se calculan en céntimos, con IVA, descuentos y retenciones; los documentos largos se reparten en varias páginas. Al emitir se conserva una copia de los datos de empresa y cliente.
- Verifica los movimientos bancarios y usa **Registrar cobro** para registrar pagos completos o parciales. El portal no tiene conexión con el banco. Las facturas históricas cuyo pago no está acreditado quedan **por revisar** y no se cuentan como deuda confirmada hasta revisar el cobro.
- La **Referencia interna del trabajo** es opcional: ayuda a encontrar el documento en el portal y no aparece en el PDF. El campo **PO / orden de pedido** aparece en la factura y también es opcional; puedes completarlo al convertir un presupuesto o después de emitir la factura.
- **Seguimiento opcional de la aceptación o contrato** permite anotar una fecha prevista y generar un aviso hasta marcar **Aceptación / contrato recibido**. Puedes dejar ambos campos vacíos. Este seguimiento no cambia el estado ni los importes del presupuesto; la aceptación del presupuesto se gestiona por separado. Las advertencias de importación señalan las fechas o importes originales que requieren revisión.
- Exporta listas a CSV y descarga una copia JSON desde Configuración. La restauración de una copia local es independiente de la importación administrada del espacio compartido.

Los cambios de otra sesión se detectan mediante una versión en el servidor para impedir sobrescrituras silenciosas. Si aparece un conflicto, recarga y concilia los cambios antes de volver a guardar.

## Registrar gastos

En **Gastos → Nuevo gasto**, indica el **concepto / nombre del gasto**, el **total con IVA incluido** y añade **una foto o un archivo como justificante**. La fecha del justificante se propone como hoy. Puedes guardar el IVA como **Por revisar**, seleccionar su porcentaje o introducir el importe que figura en el documento cuando haya varios tipos de IVA.

La casilla **Ya está pagado** aparece marcada al crear un gasto: comprueba que corresponde al pago real y desmárcala si está pendiente. En **Más detalles** puedes cambiar las fechas del justificante y del pago y completar el proveedor, NIF, número de factura o ticket, categoría, notas y desglose para el gestor. El proveedor y esos datos complementarios son opcionales. Los importes cuyo IVA está por revisar cuentan en el total y, si están pagados, en caja; su base e IVA quedan pendientes de confirmar.

Puedes **Adjuntar archivos** descargados del correo o usar **Tomar una foto**. En un móvil compatible, esta opción abre la cámara; el navegador puede ofrecer también su selector de archivos. Se admiten PDF, fotos JPEG/PNG/WebP/GIF/HEIC/HEIF y documentos Word, Excel, OpenDocument y RTF: hasta **10 archivos por gasto**, de **10 MB por archivo** (10 485 760 bytes). Los archivos se suben al guardar el gasto y permanecen privados en Supabase Storage. Los formatos de archivo no se convierten.

La lista de **Gastos** muestra todo el histórico. Busca por concepto, proveedor o número y filtra por **Todos**, **Pagados**, **Pendientes** o **Por revisar**. Selecciona el concepto para editar el registro. El saldo inicial y el saldo según el registro se consultan en **Resumen**.

## Ver justificantes

Al abrir un gasto por su concepto o el número de **archivos** de la columna **Justificantes**, se muestran sus datos y la vista previa juntos. En una pantalla amplia, el formulario queda a la izquierda y el justificante a la derecha; en móvil, la vista previa aparece debajo. Una foto o archivo recién adjuntado se muestra automáticamente, antes de guardar. Pulsa **Ver** junto a otro adjunto para cambiar la vista o **Ampliar visor** para abrirlo más grande; al cerrar el visor se conserva el borrador del formulario.

**Pagados** indica el estado del pago; **Por revisar** reúne los justificantes marcados para el gestor, con IVA pendiente de confirmar o sin archivo. Un mismo gasto puede estar en ambos filtros. Para completar su revisión, consulta sus notas y documento, confirma el IVA cuando corresponda y desmarca **Revisar este justificante con el gestor** en **Más detalles**, conservando su estado de pago.

El visor muestra **PDF y fotos** dentro del portal. Permite cambiar de justificante, pasar páginas del PDF, ampliar, ajustar y girar la vista. Si el PDF tiene contraseña, la pide para abrirlo y no la guarda. El soporte de HEIC/HEIF depende del navegador; si no puede mostrar una imagen, aparece una explicación. Para Word, Excel y otros formatos, utiliza **Descargar original**. Esta opción también está disponible para PDF y fotos y conserva el archivo original intacto.

Los justificantes guardados se cargan mediante la sesión privada y el visor se cierra al bloquear o cerrar la sesión. La vista previa no modifica ni sustituye los originales.

## Informes y gestor

En **Informes y gestor**, elige **Un trimestre**, **Un año completo** o **Todo el histórico** para reunir las facturas emitidas y los gastos del período. Selecciona el año y, cuando corresponda, el trimestre. Puedes descargar:

- **Descargar listado CSV**, con facturas emitidas y gastos, sus importes, estados y referencias a justificantes.
- **Descargar expediente**, un ZIP con el CSV, un resumen, los PDF de las facturas emitidas y los justificantes originales de los gastos. Si un adjunto registrado no puede recuperarse completo, la exportación se detiene y no crea un paquete parcial. El paquete admite hasta 300 MB; para históricos mayores, exporta por año o trimestre.

Los documentos se agrupan por su fecha de emisión o de justificante; los movimientos de caja usan sus propias fechas de cobro y pago. La evaluación del período muestra ventas sin IVA, bases de gastos desglosados, diferencia de bases, cobros y pagos registrados y totales mensuales. La diferencia queda **Por revisar** cuando hay gastos con IVA pendiente; compara las bases registradas y no representa el beneficio fiscal ni el saldo bancario.

El IVA repercutido, el IVA soportado registrado y el IVA confirmado por la usuaria se distinguen en los informes y el resumen del expediente. Confirmar un importe prepara su revisión y no determina que sea deducible. El gestor revisa los justificantes y presenta las declaraciones; la aplicación prepara el expediente.

**Importar gastos revisados** acepta paquetes ZIP preparados con los datos revisados y sus justificantes originales. Comprueba el paquete, muestra los registros nuevos y los que necesitan revisión y omite los duplicados reconocidos antes de importar. Esta opción se utiliza en la empresa conectada a Supabase.

La **copia JSON de Configuración contiene únicamente los datos y las referencias de los adjuntos**, no sus bytes. Conserva también los ZIP de los expedientes para respaldar los justificantes.

## Saldo registrado y previsión

Nicole puede configurar un **saldo inicial al comienzo de un día**, antes de sus movimientos. Desde esa fecha, el portal calcula **saldo inicial + cobros registrados − gastos pagados**, hasta el día actual. Los documentos pendientes no alteran el saldo actual. La previsión añade cobros pendientes confirmados y resta gastos pendientes; excluye las facturas históricas cuyo cobro sigue por confirmar.

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
