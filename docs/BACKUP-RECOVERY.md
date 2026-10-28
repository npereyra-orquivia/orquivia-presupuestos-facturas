# Copias cifradas y recuperación de Orquivia

## Estado y alcance

El código prepara, verifica y extrae una copia cifrada. **Su presencia en el repositorio no activa copias periódicas ni acredita una restauración real de Supabase.** El 28 de octubre de 2026 se comprobaron las conexiones cifradas de ambos proyectos y se realizó una captura real de PostgreSQL/Auth, roles sin contraseñas, Vault portable, configuración, código y los 42 originales de Storage. El contenedor de 19.699.449 bytes y 50 entradas se subió a Drive restringido y se descargó de vuelta, comprobando SHA-256, AES-GCM y cada entrada. El ensayo aislado con esa captura sigue pendiente.

La titular autorizó una conexión técnica separada de Google Drive con el único permiso `drive.file`; su credencial se guarda cifrada fuera del repositorio. La carpeta de copias fue creada por esa aplicación y situada en el destino de contabilidad autorizado. Sus permisos y los del archivo real se comprobaron frente a las dos personas autorizadas, sin acceso público, de dominio ni de grupos. Esto no conecta Drive al chat ni activa el workflow diario. La transferencia real ya está verificada; el ensayo aislado sigue siendo requisito para programar las copias.

El código estable anterior es `v1.4.1` (`1625e0494638fb6c782e4f8cbdf02b08ec4d3bb2`). Un tag o bundle Git respalda código; no contiene automáticamente la base de datos, cuentas ni documentos privados.

## Qué contiene una captura

El archivo `.orqbackup` cifra con AES-256-GCM autenticado el contenido y su manifiesto. No deja nombres de archivos, configuración ni datos del proyecto en claro dentro del contenedor. Incluye:

- `database.dump`: `pg_dump` en formato personalizado, incluyendo los esquemas y datos que pueda leer la conexión privilegiada: tablas de aplicación, cuentas Auth, políticas, historial y configuración privada. Un error de permisos aborta la captura; no se omiten esquemas silenciosamente.
- `database-roles.sql`: roles sin sus contraseñas de conexión. El destino necesita credenciales propias.
- `configuration/vault-secrets.json`: secretos portables de `vault.decrypted_secrets`, transmitidos directamente del proceso PostgreSQL al flujo cifrado. Los UUID, nombres y descripciones permiten volver a cifrarlos y remapear referencias. No se presupone que el cifrado de Vault de un proyecto funcione en otro.
- `source.tar`: archivos versionados de `HEAD`. La herramienta rechaza cambios pendientes en archivos seguidos; el código operativo debe estar confirmado antes de capturarlo.
- `configuration/auth.json`: configuración Auth consultada por la API de administración, también dentro del cifrado.
- `configuration/recovery.json`: paquete confirmado por la operadora para opciones y secretos externos que la API no devuelva, por ejemplo SMTP y secretos Edge.
- `storage/buckets.json`, `storage/inventory.json` y todos los objetos de Storage, obtenidos mediante paginación, incluidos originales y fotos de perfil.

La contraseña de la base de datos, la clave de servicio y el token de administración usados para capturar no se añaden por sí mismos al archivo. El paquete de recuperación sí puede contener contraseñas operativas: por ello la clave de cifrado se conserva **separada del archivo y de Google Drive**.

No basta con exportar JSON del portal ni con descargar la base de datos: las copias de base de datos de Supabase no incluyen los bytes de Storage. Referencia: [Database Backups](https://supabase.com/docs/guides/platform/backups).

## Requisitos antes de ejecutar

1. Herramientas oficiales `pg_dump`, `pg_dumpall`, `psql` y `git`. Usar PostgreSQL compatible con el servidor; no desactivar la validación de certificados para resolver errores de conexión.
2. URL HTTPS exacta del proyecto Supabase; conexión directa o **session pooler**, nunca transaction pooler. La herramienta usa `sslmode=verify-full`; si el sistema no dispone de la cadena de confianza, indicar un certificado raíz válido.
3. Credenciales de operadora introducidas por un canal seguro. No pegarlas en el chat, el código, comandos con valores literales, capturas, logs ni documentos públicos.
4. Clave aleatoria independiente de 32 bytes en Base64 canónico. Guardar la recuperación en el gestor de contraseñas elegido y comprobar que una segunda vía autorizada permite recuperarla. Perderla hace irrecuperable la copia.
5. Directorio de destino **fuera del repositorio**, no `public/`, `dist/`, `private/` ni una carpeta sincronizada sin revisar sus permisos. La captura se cifra antes de escribir el contenedor a disco.
6. Paquete de configuración revisado y modo `captureMode: "drift-checked"`: el motor verifica huellas del origen antes y después y aborta si cambian. Es preferible una ventana de poco uso. El dump es transaccional, pero Auth API, Vault y Storage se leen por mecanismos distintos; no se promete una instantánea atómica de todos los servicios.

La herramienta compara antes y después: inventario completo de Storage, configuración Auth y una huella calculada dentro de PostgreSQL de las tablas de aplicación, Auth, Vault, Storage y cron. PostgreSQL solo devuelve el SHA-256; no envía su contenido al registro de ejecución. Cualquier cambio detectado o permiso insuficiente aborta la publicación. Esto reduce inconsistencias, pero no equivale a una instantánea atómica entre servicios: un cambio y reversión durante la captura puede no detectarse. El modo `drift-checked` exige estas comprobaciones en cada captura; no supone que el origen esté bloqueado. Por compatibilidad, la CLI manual también acepta el antiguo `confirmedQuietCapture: true`, pero sus comprobaciones siguen activas y el workflow diario exige el modo nuevo. La confirmación de integridad del paquete es una declaración de la operadora, no prueba la vigencia de secretos externos: hay que revisarla tras cada cambio de configuración.

## Variables de ejecución

Configurar las variables mediante un mecanismo seguro del operador o un almacén de secretos de ejecución; no guardar valores en Git. Ninguna variable `VITE_` puede contener estos secretos.

| Variable | Uso |
|---|---|
| `ORQUIVIA_BACKUP_KEY` | Clave independiente de 256 bits en Base64 |
| `ORQUIVIA_BACKUP_SUPABASE_URL` | URL pública exacta del proyecto de origen |
| `ORQUIVIA_BACKUP_DATABASE_URL` | Conexión PostgreSQL de operadora; la contraseña se pasa al proceso por entorno, nunca por argumentos |
| `ORQUIVIA_BACKUP_SERVICE_ROLE_KEY` | Credencial privilegiada de servidor para descargar los originales privados |
| `ORQUIVIA_BACKUP_ACCESS_TOKEN` | Token de administración para leer la configuración Auth |
| `ORQUIVIA_BACKUP_RECOVERY_JSON` | Paquete de recuperación completo confirmado por la operadora |
| `ORQUIVIA_BACKUP_OUTPUT_DIR` | Destino absoluto privado fuera del repositorio |
| `ORQUIVIA_BACKUP_PG_SSL_ROOT_CERT` | Opcional: archivo de certificado raíz; el valor por defecto es `system` |
| `ORQUIVIA_BACKUP_PG_DUMP`, `ORQUIVIA_BACKUP_PG_DUMPALL`, `ORQUIVIA_BACKUP_PSQL` | Opcional: rutas a las herramientas oficiales |

El paquete de recuperación debe contener `edgeSecrets`, `edgeFunctions`, `authSmtp`, `storageConfiguration`, `verifiedAt` UTC, `confirmedComplete: true` y `captureMode: "drift-checked"`. El archivo `backup-recovery.example.json` es solo un esquema vacío y **no cumple los requisitos de captura**: su confirmación de integridad es falsa. La operadora verifica valores reales y vigencia antes de confirmarla. Confirmar no significa que el software haya verificado secretos externos ni ensayado su recuperación.

Los errores de subprocesos y respuestas remotas se sustituyen por códigos genéricos para evitar exponer credenciales o contenido. No habilitar trazas de shell ni imprimir el entorno.

## Capturar y comprobar

Con las variables ya cargadas de forma segura:

```text
node scripts/backup/cli.mjs create
node scripts/backup/cli.mjs verify --file RUTA_ABSOLUTA_AL_ARCHIVO.orqbackup
```

`create` escribe un nombre único, calcula SHA-256 por entrada, autentica y vuelve a leer el archivo completo antes de publicarlo con su nombre final. Si falta una fuente, cambian tamaños o huellas de origen, o se detecta un error, falla y retira el archivo parcial de esa ejecución. No reemplaza copias existentes. La revisión del código que se archiva es el commit inmutable de la captura, aunque `HEAD` cambie mientras se ejecuta.

Un resultado `captured-and-verified` o `authenticated-and-verified` acredita integridad del contenedor, **no recuperación completa del sistema**. Siempre muestra `recoveryTested: false` mientras no exista un ensayo real documentado.

Los límites de seguridad iniciales son 100.000 entradas, 20 GB de contenido total y 2 GB por entrada, con procesamiento en fragmentos. Ampliarlos exige revisar almacenamiento, tiempo de ejecución y verificación; no son una promesa de capacidad de la cuenta de Google Drive.

Para subir por navegador: entrar en la carpeta autorizada, revisar sus permisos, crear una subcarpeta de copias del portal y subir únicamente el `.orqbackup` verificado. Conservar fecha, versión y resultado del ensayo en un índice sin datos contables. No subir la clave ni un directorio de recuperación extraído. No borrar copias anteriores automáticamente.

## Preparar el ensayo aislado

`restore-plan` y `extract` rechazan el proyecto de origen y la producción de Orquivia, exigen un destino Supabase distinto y la confirmación exacta `ISOLATED:REFERENCIA_DEL_DESTINO`. La conexión del destino se indica en `ORQUIVIA_RESTORE_DATABASE_URL` y debe coincidir con esa referencia.

```text
node scripts/backup/cli.mjs restore-plan --file RUTA_ABSOLUTA_AL_ARCHIVO.orqbackup --target-url https://REFERENCIA_DEL_DESTINO.supabase.co --ack-isolated ISOLATED:REFERENCIA_DEL_DESTINO
```

Este comando produce un plan y **no ejecuta ninguna mutación**.

La extracción offline opcional autentica primero todo el archivo y escribe únicamente en un directorio nuevo fuera del repositorio, rechazando destinos existentes, enlaces y rutas de escape:

```text
node scripts/backup/cli.mjs extract --file RUTA_ABSOLUTA_AL_ARCHIVO.orqbackup --target-url https://REFERENCIA_DEL_DESTINO.supabase.co --ack-isolated ISOLATED:REFERENCIA_DEL_DESTINO --output-dir DIRECTORIO_NUEVO_ABSOLUTO
```

Los archivos extraídos están **en claro e incluyen datos y secretos**. Mantenerlos en una ubicación privada aislada; no sincronizarlos con Drive. Se escriben en un directorio temporal privado, se comprueban tamaño y hash de los bytes realmente escritos a disco y solo después se publica el directorio final. La extracción no ejecuta SQL ni configura Supabase, y no cuenta como restauración de la base de datos.

## Ensayo real: pasos que deben verificarse

1. Crear un destino separado sin conexión al portal operativo. Desactivar o bloquear SMTP de salida, cron, Edge y cualquier conexión hacia producción **antes de importar**. Un dump puede contener trabajos programados y credenciales del origen.
2. Seguir el procedimiento oficial de restauración lógica de Supabase para la versión y extensiones concretas. Revisar propietarios, roles gestionados y permisos; no ejecutar a ciegas todo el SQL en producción.
3. Recrear los secretos de Vault con el mecanismo del destino y remapear todos sus UUID referenciados, incluidos `orquivia_private.mail_profiles.secret_id`. Nunca reutilizar sin comprobación el cifrado de otro proyecto.
4. Recuperar los originales por Storage API sin sobrescribir, respetando sus nombres y privacidad. Comparar conteos, tamaños y SHA-256 con el manifiesto.
5. Configurar URLs, Auth, funciones y secretos propios del destino. Mantener los correos bloqueados o limitados a un buzón de pruebas expresamente autorizado; no activar el cron importado.
6. Probar acceso y segundo factor con cuentas de prueba, revocación, numeración sin duplicados, documentos emitidos, vínculos a originales y exportaciones. Las claves y sesiones de producción no se reutilizan como acceso de prueba.
7. Registrar duración, fecha, versión, diferencias, datos recuperados y resultado. Solo entonces puede indicarse «restauración comprobada» para ese ensayo.

Un cambio de interfaz se revierte usando la versión estable del código; no se restaura un estado contable antiguo para deshacer una pantalla. Cualquier restauración sobre producción exige una intervención y autorización específica, fuera de estos comandos.

## Política inicial propuesta

- Captura diaria cuando exista ejecución autorizada independiente y aviso si no se produce una copia válida.
- Copias versionadas en destino separado; acordar retención antes de eliminar versiones. La sincronización de borrados no es una copia de seguridad.
- Verificación de cada archivo cifrado y ensayo aislado periódico, y tras cambios importantes de esquema o credenciales.
- Revisar accesos de operadora y guardar claves por separado, con un procedimiento de recuperación autorizado.

La periodicidad y los avisos no quedan activos por publicar esta documentación. Deben configurarse y comprobarse con las credenciales y el destino elegidos.

El workflow diario queda preparado y desactivado por defecto. Su autorización, secretos, pruebas y límites se describen en [SCHEDULED-BACKUP.md](SCHEDULED-BACKUP.md).
