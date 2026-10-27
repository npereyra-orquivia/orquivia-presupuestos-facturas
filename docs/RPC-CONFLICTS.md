# Conflictos entre ediciones y respuesta HTTP

La migración `202610270016_rpc_conflict_http.sql` mantiene los bloqueos, la comparación de versión y los mensajes existentes. Cambia únicamente el SQLSTATE de seis conflictos de negocio de `40001` a `PT409`, que PostgREST devuelve como HTTP 409.

Supabase documenta que un `RAISE 40001` intencionado puede provocar reintentos internos indefinidos en PostgREST 14. No debe usarse para indicar que una persona necesita recargar un documento: ese mismo intento no podrá guardar una versión obsoleta aunque se repita. [Incidencia y solución oficiales](https://supabase.com/kb/troubleshooting/high-cpu-and-infinite-transaction-retries-when-using-custom-error-codes-in-rpc-functions).

## Comportamiento conservado

Si dos sesiones guardan sobre la misma versión, solo una puede avanzar la versión. La otra recibe `VERSION_CONFLICT`, conserva su borrador local y debe recargar antes de guardar, emitir o enviar. Los conflictos de firma y conexión conservan `PROFILE_CONFLICT`. La interfaz también sigue reconociendo `40001` para errores nativos y compatibilidad.

Un intento de emisión con una versión antigua no reserva un número ni modifica el documento. Un conflicto de perfil no reemplaza su firma ni su credencial. Un intento de preparar un envío obsoleto no crea un trabajo de correo.

## Aplicación y comprobación

La migración usa una lista exacta de seis firmas de función y comprueba sus definiciones antes y después. Es transaccional e idempotente; una función ausente o desconocida aborta todo el cambio. Conserva OID, propietario, permisos, parámetros, `SECURITY DEFINER` y `search_path`. No actualiza tablas de la empresa, originales, numeración, historial ni secretos.

La suite `supabase/tests/rpc-conflicts-postgres.mjs` comprueba esas propiedades, los seis errores, los permisos y los intentos posteriores válidos con datos ficticios. El ensayo en el proyecto independiente comprueba además HTTP 409 real, ausencia de reintentos del cliente y un único avance de versión con dos sesiones AAL2 concurrentes.

Antes de aplicarla al servidor, conservar las seis definiciones instaladas por un canal privado y comprobar primero el entorno separado. Una prueba WASM no demuestra el comportamiento de PostgREST. No volver a ejecutar intencionadamente errores `40001` de negocio en un servidor afectado para medirlos.

Las peticiones que ya estuvieran en un bucle no se detienen necesariamente al cambiar la función. Identificar sus procesos mediante registros y metadatos, y detener solo las peticiones confirmadas; no reiniciar producción ni cancelar sesiones ajenas a ciegas. Cambiar la interfaz a una versión anterior no exige restaurar las funciones con el error de reintentos.
