# Copias programadas: preparadas, sin activar

`.github/workflows/backup.yml` declara una ejecución diaria a las 02:43 UTC y una ejecución manual. **Publicar este archivo no activa ninguna copia.** El trabajo se omite mientras las variables de repositorio `ORQUIVIA_BACKUPS_ENABLED` y `ORQUIVIA_BACKUP_RESTORE_REHEARSED` no sean exactamente `true`. No se han creado credenciales, autorizado OAuth ni configurado estas variables por añadir el código.

El destino elegido hoy mediante una pestaña de Google Drive no autoriza acceso automatizado. La conexión permanente requiere una aprobación separada de la operadora, un cliente OAuth propio con el único alcance `https://www.googleapis.com/auth/drive.file` y la selección de la carpeta para ese cliente mediante Picker o un flujo compatible. No se usa el conector general del chat. Pegar el ID o abrir la carpeta no concede acceso a ese cliente.

## Antes de activar

1. Revisar y proteger el environment GitHub `orquivia-backup`, limitado a despliegues de `main` y a las personas autorizadas a gestionar sus secretos. La guarda del workflow y el wrapper también rechazan ramas, forks, eventos PR y ejecuciones fuera de Actions. No hay permiso de escritura en GitHub.
2. Aprobar la conexión OAuth anterior y comprobar la carpeta My Drive restringida exclusivamente a las personas autorizadas, sin grupos ni acceso público o por dominio. Guardar su lista canónica en `ORQUIVIA_DRIVE_ALLOWED_EMAILS`: 1–20 direcciones ASCII en minúsculas, separadas por comas, sin espacios ni duplicados. La herramienta exige que el conjunto de permisos de personas coincida exactamente con esa lista; revisa la carpeta antes de la subida y la carpeta más el archivo al terminar, sin cambiar permisos. No usar una carpeta de unidad compartida ni suponer que un enlace restringido basta para el cliente OAuth.
3. Preparar las credenciales de lectura privilegiada de Supabase, conexión directa o session pooler y paquete de recuperación completo. Mantener `verifiedAt` y secretos externos actualizados tras cada cambio; el paquete debe declarar `captureMode: "drift-checked"`. Nunca añadirlos al código ni al chat.
4. Generar una clave independiente y guardar una segunda vía de recuperación en el gestor de contraseñas, separada de Drive. Cargar la clave de ejecución mediante GitHub Secrets. No puede recuperarse el archivo perdiendo esa clave.
5. Realizar primero una captura manual, verificarla, subirla al destino autorizado y completar **un ensayo real de restauración aislada** conforme a [BACKUP-RECOVERY.md](BACKUP-RECOVERY.md). Registrar fecha, commit, duración, alcance, diferencias y resultado fuera del repositorio público. Una verificación del archivo o un plan de restauración no cumple este paso.
6. Solo tras revisar ese resultado y aprobar el funcionamiento diario, establecer las dos variables de activación en `true` y comprobar una ejecución manual del workflow. Revisar su fallo/notificación con la cuenta operadora antes de confiar en la periodicidad. `ORQUIVIA_BACKUP_RESTORE_REHEARSED` es la declaración de quien activa el sistema; el código no inventa ni certifica ese ensayo.

## Configuración de GitHub

Variables **del repositorio** para las guardas previas al inicio del trabajo:

| Variable | Valor tras la aprobación |
|---|---|
| `ORQUIVIA_BACKUPS_ENABLED` | `true`; dejar ausente o `false` mientras no esté listo |
| `ORQUIVIA_BACKUP_RESTORE_REHEARSED` | `true` solo tras el ensayo documentado |

Variables del environment `orquivia-backup` (también pueden ser de repositorio):

| Variable | Uso |
|---|---|
| `ORQUIVIA_DRIVE_UPLOAD_ENABLED` | `true` únicamente tras autorizar el cliente OAuth |
| `ORQUIVIA_DRIVE_FOLDER_ID` | Carpeta restringida seleccionada para ese cliente |

Secretos **del environment `orquivia-backup`**, no variables `VITE_`:

- `ORQUIVIA_BACKUP_KEY`, `ORQUIVIA_BACKUP_DATABASE_URL`, `ORQUIVIA_BACKUP_SERVICE_ROLE_KEY` y `ORQUIVIA_BACKUP_ACCESS_TOKEN`.
- `ORQUIVIA_BACKUP_RECOVERY_JSON`, con el paquete de recuperación real y revisado.
- `ORQUIVIA_DRIVE_CLIENT_ID`, `ORQUIVIA_DRIVE_CLIENT_SECRET` y `ORQUIVIA_DRIVE_REFRESH_TOKEN`.
- `ORQUIVIA_DRIVE_ALLOWED_EMAILS`, con la lista privada completa de personas autorizadas. No guardar sus direcciones reales en Git; no se admiten grupos aunque su dirección aparezca en la lista.

Los secretos se inyectan únicamente en el paso de captura/subida. La preparación de herramientas y checkout no los reciben. El URL de origen está fijado al proyecto de producción esperado y el wrapper lo comprueba. TLS usa `verify-full` con la confianza del sistema; un fallo de certificado exige revisar la confianza, nunca desactivar TLS.

## Ejecución y límites

El runner GitHub Linux usa la imagen oficial `postgres:17-bookworm`, fijada por digest, para `pg_dump`, `pg_dumpall` y `psql` 17; prepara Git desde Debian y Node 22 con las Actions oficiales fijadas a SHA. No se instala ni ejecuta Docker Desktop en el PC de Nicole. No se inicia una base de datos local ni se instala el árbol npm: los scripts de copia solo usan módulos nativos de Node. Revisar periódicamente el digest y los parches mediante un cambio revisable.

El wrapper crea un directorio único y privado dentro de `RUNNER_TEMP`, **fuera del repositorio**. Captura a un flujo cifrado, autentica el archivo completo y comprueba que las huellas de base de datos, Auth y Storage siguen iguales. Después llama una sola vez al helper de Drive, que verifica de nuevo el archivo, los permisos y la integridad remota. No crea dumps ni paquetes de secretos en claro en disco. No publica artifacts ni añade el contenedor cifrado al repositorio. El runner efímero elimina su espacio al terminar; no se promete conservar allí una copia fallida.

La ejecución está serializada y tiene un máximo de 120 minutos. No reintenta toda la operación automáticamente, ni enmascara un cambio concurrente: si cambia el origen, falla. Ante una subida incierta se revisa el mismo intento y su sesión; no pulsar reejecutar a ciegas porque podría duplicar un archivo ya recibido. El helper tiene sus propios límites y comprobaciones de sesión, descritos en su código y pruebas. El job no borra copias anteriores: acordar y comprobar una política de retención antes de automatizar borrados.

GitHub puede retrasar u omitir ejecuciones programadas y aplica cuotas/minutos de Actions; las 02:43 son UTC y no cambian con el horario de verano. Una ejecución correcta solo acredita captura y subida verificadas y **siempre devuelve `recoveryTested: false`**. El primer ensayo no demuestra que cada futura versión se restaure: repetir ensayos periódicos y tras cambios importantes. Las huellas reducen inconsistencias, pero no son una instantánea atómica de todos los servicios.

El aviso inicial de fallos corresponde a GitHub Actions y a la configuración de notificaciones de cada mantenedora. Aún no hay un vigilante externo que detecte un workflow que no se haya iniciado. Hasta comprobar ese circuito y una restauración real, no describir las copias como operativas.

Referencias de ejecución: [contenedores en GitHub Actions](https://docs.github.com/en/actions/how-tos/write-workflows/choose-where-workflows-run/run-jobs-in-a-container), [imagen oficial PostgreSQL](https://github.com/docker-library/postgres/tree/master/17/bookworm) y [alcance Drive por archivo](https://developers.google.com/workspace/drive/api/guides/api-specific-auth).
