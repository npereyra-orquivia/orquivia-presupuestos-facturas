# Evidencia operativa de las copias

La migración `202610280017_operations_evidence.sql` prepara un registro independiente del estado financiero. Instalarla no crea una copia ni acredita una recuperación.

## Lectura del panel

`load_orquivia_backup_health` comprueba la identidad capturada, la membresía activa, el rol `admin` y AAL2, incluso si la organización no exigiera MFA en otro flujo. El navegador no tiene acceso directo a la tabla privada y no recibe credenciales, rutas, identificadores de Drive ni valores contables.

El panel recibe la hora del servidor y conserva una referencia monotónica local al recibirla. El tiempo transcurrido se suma a esa hora, sin tratar la hora del dispositivo como prueba del momento de la copia. Después de 36 horas sin copia nueva se muestra la falta de actualización; un intento sin finalizar durante tres horas deja de mostrarse como «en curso». Un último fallo, una consulta fallida o evidencia inválida no conservan el estado verde de una copia anterior.

La consulta actualiza solo este panel. No sustituye el formulario de empresa abierto ni sus cambios sin guardar. Si la RPC aún no está instalada, la interfaz compatible mantiene el estado pendiente. El panel continúa diferenciando los límites internos del JSON y registros de las cuotas totales del proveedor.

## Reporte del ejecutor

El reporte está desactivado por defecto y necesita, además de la preparación de copia y Drive ya documentada:

- Variable de repositorio `ORQUIVIA_BACKUP_HEALTH_REPORT_ENABLED=true`.
- Secreto de ejecución `ORQUIVIA_BACKUP_ORGANIZATION_ID` con la organización concreta autorizada.
- La credencial de servidor ya utilizada por la captura, conservada exclusivamente como secreto del ejecutor.

La credencial de servidor es privilegiada y omite RLS; el hecho de que esta rutina tenga un payload limitado no convierte el token en una credencial general de solo lectura.

`record_orquivia_backup_attempt` solo puede invocarse con `service_role`. Registra un intento antes de capturar y lo vincula a una identidad de ejecución. Una finalización de otro intento o un resultado incompatible se rechazan con HTTP 409. Los campos admitidos son cerrados y acotados. No se almacenan mensajes remotos ni diagnósticos arbitrarios.

El scheduler solo envía éxito después de comprobar la captura y la subida, incluidos checksum y personas autorizadas. Los conteos y tamaños de originales proceden del manifiesto autenticado que el uploader acaba de verificar, y el hash identifica el contenedor cifrado. No se vuelve a leer todo el respaldo solo para producir esa presentación.

Un fallo no provoca otra captura ni otra subida. Si se pierde la respuesta al registrar evidencia, puede existir una copia válida aunque el job termine con error; revisar el destino y el mismo intento antes de repetir. Si el reporte no llega al servidor, el panel no lo inventa: su evidencia previa terminará caducando. Este registro no acredita por sí solo la entrega de correos de alertas ni detecta todos los trabajos que nunca arrancaron.

## Ensayo de recuperación separado

Ningún código de captura o scheduler invoca `record_orquivia_restore_evidence`. El flag de preparación `ORQUIVIA_BACKUP_RESTORE_REHEARSED` no escribe evidencia de restauración.

Después de revisar un informe concreto de ensayo, la operadora puede registrar mediante el canal de servidor su SHA-256, commit de origen, fecha y alcance. El alcance `business-data-and-originals` acredita datos y originales; no se presenta como recuperación de cuentas o segundo factor. `full-system` queda reservado a un informe que realmente cubra ese alcance. La función almacena una atestación de la operadora y la referencia de su informe, no inspecciona automáticamente un archivo externo ni prueba el ensayo por su cuenta.

Una actualización no puede sustituir el último ensayo por uno anterior o cambiar su alcance bajo la misma fecha. El informe y sus pruebas deben custodiarse por el procedimiento privado de operación; no introducir datos contables, rutas o secretos en este registro.

## Certificado PostgreSQL del ejecutor

El workflow usa el certificado **público** `scripts/backup/certs/supabase-root-2021.crt`, obtenido del enlace de descarga mostrado por Supabase en sus ajustes SSL. Antes de cargar credenciales, `verify-certificate.mjs` comprueba su huella DER SHA-256 fijada, condición de CA, autofirma y validez temporal. Una rotación o caducidad exige revisar el nuevo certificado oficial; no se rebaja la verificación TLS para resolverla.

La ruta se pasa en `ORQUIVIA_BACKUP_PG_SSL_ROOT_CERT`. La conexión sigue utilizando `sslmode=verify-full`; el código general no sustituye la configuración de confianza de otros operadores. El archivo no contiene ninguna clave privada.
