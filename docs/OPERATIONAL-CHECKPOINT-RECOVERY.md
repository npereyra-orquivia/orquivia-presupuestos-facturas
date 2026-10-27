# Recuperar la exportación operativa histórica de Orquivia v1.4.1

Esta herramienta recupera **cuatro archivos históricos**, sin conectarse a ningún servicio. Permite abrir los datos exportados, los documentos históricos y el código estable aunque no se tenga acceso a GitHub. No restaura la aplicación completa ni su base de datos y no confirma que las copias completas de PostgreSQL, Auth, Storage o configuración estén preparadas o ensayadas.

El contenedor previsto es `Orquivia_2026-10-26_v1.4.1_exportacion_y_codigo.orqbackup`. Se identifica por su contenido autenticado, no por el nombre del archivo. Solo se acepta el alcance `operational-export-and-source-only`, la versión `1.4.1`, la revisión `1625e0494638fb6c782e4f8cbdf02b08ec4d3bb2` y exactamente estas rutas:

| Archivo recuperado | Contenido y límite de uso |
| --- | --- |
| `LEEME.json` | Alcance y limitaciones de la captura. |
| `export/empresa.json` | Exportación operativa del portal en la fecha de captura; no es un volcado de PostgreSQL. |
| `export/historico.zip` | Archivo de documentos históricos exportados por el portal. |
| `source/orquivia-v1.4.1.bundle` | Código e historial Git de la revisión estable; no contiene por sí mismo un servicio desplegado ni sus secretos. |

No se importan usuarios, contraseñas, perfiles personales, credenciales de correo ni configuración externa. Estos archivos describen el estado capturado el 26 de octubre de 2026; no garantizan incluir cambios posteriores.

## Material necesario

1. Node.js 22 o posterior instalado en un equipo de confianza. Para la verificación y extracción no se necesitan `npm install`, Git, PostgreSQL, Docker ni conexión a Internet.
2. El contenedor `.orqbackup` descargado de la carpeta restringida de Drive.
3. La clave de recuperación original, facilitada por la titular **por separado**. Es una clave base64 canónica de 32 bytes. El programa no puede recuperarla ni restablecerla.
4. Estas herramientas, conservando su estructura relativa. Pueden venir en un ZIP separado sin secretos:

```text
herramientas/
  scripts/backup/archive.mjs
  scripts/backup/export-checkpoint.mjs
  docs/OPERATIONAL-CHECKPOINT-RECOVERY.md
```

No es necesario descargar el repositorio ni iniciar sesión en GitHub. Si se entrega este material en un ZIP, comprobar su procedencia con la titular antes de ejecutarlo. El ZIP de herramientas puede conservarse con la copia cifrada; **la clave y los archivos extraídos sin cifrar no deben subirse a esa carpeta como parte de este procedimiento**.

## 1. Preparar una ubicación privada

Utilizar carpetas locales con acceso limitado a la persona encargada de la recuperación. La carpeta final de extracción debe ser **nueva, absoluta y estar fuera de `herramientas` y del repositorio**. El programa rechaza una carpeta final existente y no sobreescribe sus archivos.

Guardar la clave por un medio privado en un archivo de texto normal, por ejemplo `C:\RecuperacionPrivada\clave.txt`: solo la clave, opcionalmente con un salto de línea al final; sin comillas, espacios ni BOM. Limitar sus permisos desde el sistema operativo. No enviarla al chat, no guardarla en Git, no introducir su valor como argumento y no guardarla junto a la copia de Drive.

El programa admite alternativamente una variable `ORQUIVIA_BACKUP_KEY` inyectada por un almacén privado de secretos. Utilizar una sola fuente: si la variable está definida y se indica también `--key-file`, la ejecución se detiene por ambigüedad. Los siguientes ejemplos utilizan un archivo privado; las rutas son ejemplos y deben adaptarse.

## 2. Verificar sin extraer

Desde la carpeta `herramientas`, ejecutar en PowerShell:

```powershell
node scripts/backup/export-checkpoint.mjs verify --file "C:\RecuperacionPrivada\Orquivia_2026-10-26_v1.4.1_exportacion_y_codigo.orqbackup" --key-file "C:\RecuperacionPrivada\clave.txt"
```

El resultado correcto es un JSON con `status: "checkpoint-authenticated-and-verified"`, `entries: 4` y el alcance histórico indicado. La operación completa la autenticación AES-256-GCM y comprueba las sumas SHA-256 de los archivos, la revisión estable y las limitaciones de `LEEME.json`. No escribe archivos extraídos. Ante una clave incorrecta, modificación, truncamiento, contenido imprevisto o error de lectura, termina con código distinto de cero.

## 3. Extraer a una carpeta nueva

```powershell
node scripts/backup/export-checkpoint.mjs extract --file "C:\RecuperacionPrivada\Orquivia_2026-10-26_v1.4.1_exportacion_y_codigo.orqbackup" --key-file "C:\RecuperacionPrivada\clave.txt" --output-dir "C:\RecuperacionPrivada\extraido-v1.4.1"
```

El resultado correcto contiene `status: "checkpoint-extracted-and-verified"` y la carpeta final. El programa autentica antes de extraer, escribe en una carpeta temporal nueva, verifica de nuevo tamaño y SHA-256 leyendo los archivos del disco y publica la carpeta final al terminar. Ante un fallo, no confirma una extracción válida. No repetir sobre una carpeta existente; elegir otro destino nuevo o revisar manualmente el fallo.

Los archivos de clave y contenedor deben ser archivos locales normales; se rechazan enlaces simbólicos, URLs, rutas UNC, rutas de dispositivos Windows y flujos alternativos NTFS. El destino también debe ser local. Las entradas admitidas son únicamente las cuatro rutas anteriores, con un máximo de 512 MiB por archivo y 1 GiB de contenido total. El contenedor cifrado se limita a 1,5 GiB. Los archivos permanecen cifrados en Drive; los cuatro originales de la carpeta final estarán **sin cifrar** y requieren protección local.

## Qué significa una extracción correcta

Confirma que se han recuperado los bytes autenticados de la exportación histórica y del código. Los campos siguientes permanecen siempre en `false`:

```json
{
  "completeSystemBackup": false,
  "recoveryTested": false,
  "databaseRestored": false
}
```

`recoveryTested: false` se refiere a que **no se ha ensayado la recuperación completa del sistema o de su base de datos**. La extracción operativa verificada es una comprobación distinta y más limitada. No acredita la disponibilidad actual de todos los datos ni el cierre de los puntos de copias completas y restauración.

La herramienta no abre el ZIP interno, no ejecuta el código del bundle, no hace peticiones de red, no ejecuta SQL, no cambia permisos de Drive y no importa datos al portal. Un profesional puede revisar `LEEME.json`, abrir el ZIP con una herramienta local y analizar el JSON. Para reconstruir una aplicación necesita además la infraestructura, migraciones, cuentas y secretos externos autorizados; debe hacerlo primero en un entorno aislado y evitar importar el JSON sobre producción sin una revisión de duplicados y compatibilidad. El Git bundle requiere Git solo si se decide reconstruir el código después de esta extracción.

Para el procedimiento diferente de copia completa y ensayo de restauración, consultar [BACKUP-RECOVERY.md](BACKUP-RECOVERY.md). El CLI de copias completas sigue exigiendo sus componentes de PostgreSQL, Auth, Storage y configuración; este helper no debilita esos requisitos.

## Pruebas de la herramienta

Estas pruebas utilizan únicamente datos ficticios, sin Drive, claves reales ni servicios externos:

```text
node --test tests/backup-archive.test.js tests/export-checkpoint.test.js
```

Incluyen un arranque desde dos módulos copiados a una carpeta aislada, sin dependencias npm ni herramientas en `PATH`. Esto comprueba el mecanismo de extracción; no sustituye un ensayo de restauración completa con los datos reales.
