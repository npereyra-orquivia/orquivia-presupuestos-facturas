# Operación y recuperación de Orquivia

## Referencia estable anterior a las mejoras

La versión operativa comprobada antes de este trabajo es **1.4.1**, commit `1625e0494638fb6c782e4f8cbdf02b08ec4d3bb2`, conservada en el tag remoto `v1.4.1`. Se creó y verificó además el bundle local `private/recovery/orquivia-v1.4.1-before-hardening.bundle`.

El tag y el bundle conservan código e historial de Git. No incluyen la base de datos real, los justificantes de Storage, las cuentas, las credenciales ni las conexiones de correo. Recuperar una interfaz anterior no implica recuperar una contabilidad anterior.

La dirección del portal sigue siendo `https://npereyra-orquivia.github.io/orquivia-presupuestos-facturas/`. Este trabajo mantiene GitHub Pages y Supabase.

## Estado de preparación de los puntos 1–9

Estado actualizado el **28 de octubre de 2026**. La referencia anterior 1.4.1 permanece conservada. El candidato 1.5.2 añade evidencia autenticada de las copias al panel y fija el certificado público utilizado por el ejecutor. Instalar el código o la migración no crea copias ni acredita una restauración. El detalle está en [BACKUP-EVIDENCE.md](BACKUP-EVIDENCE.md), [SECURITY-REVIEW-2026-10-27.md](SECURITY-REVIEW-2026-10-27.md) y [RPC-CONFLICTS.md](RPC-CONFLICTS.md).

| Punto | Preparación disponible | Activación o evidencia que falta |
|---|---|---|
| 1. Copias completas | Motor cifrado y workflow diario desactivado. Exportación operativa y código 1.4.1 guardados en Drive restringido, con descarga de vuelta verificada. Conexión técnica de Drive autorizada; carpeta restringida y credenciales de base de datos comprobadas. | Capturar la base de datos, Auth, originales y configuración completos; verificar la transferencia real. La copia parcial no los sustituye. |
| 2. Recuperación | Descifrado y extracción reales de los cuatro archivos del respaldo parcial comprobados; herramientas offline guardadas junto al contenedor. | Ensayo completo con datos reales, acceso, numeración y originales, en un destino aislado. La extracción de archivos no restaura el sistema. |
| 3. Producción | Auth, URLs, esquemas expuestos, RLS, membresías y buckets privados comprobados mediante panel y metadatos reales. Dependencia de correo parcheada. | Revisar advertencias específicas sin retirar permisos de funciones necesarias; repetir auditoría tras cambios de servidor. |
| 4. Cuentas técnicas | Procedimiento de acceso, bajas y recuperación. MFA de GitHub y Supabase activados por la titular y comprobados en sus paneles. | Comprobar recuperación de ambas cuentas, autenticador alternativo de Supabase, protección del correo y custodia separada de la clave de respaldo. |
| 5. Remitente automático | El portal ya utiliza `acceso@orquivia.com` como remitente de acceso. | Confirmar si continúa como alias de Nicole y, si se decide separarlo, crear un buzón y configurar su credencial propia con intervención de su titular. |
| 6. Supervisión | Workflow publicado cada seis horas; ejecución manual remota correcta para portal, recursos y Auth. | Comprobar la recepción de avisos de fallo. No cubre automáticamente errores autenticados, SMTP, cron ni copias. |
| 7. Capacidad | Panel con límites internos y tamaños declarados. El candidato añade una RPC solo para administradoras con MFA y un registro de intentos, copia verificada y ensayo, separado de los datos financieros. | Aplicar y comprobar la ampliación en entorno aislado y publicado. Sin evidencia real, la copia y la recuperación continúan pendientes. No se presenta este panel como cuota total del proveedor. |
| 8. Pruebas separadas | Proyecto independiente creado, esquema y buckets privados aplicados, registro público bloqueado y frontend de pruebas sin correo. Ensayo real de 36 comprobaciones con cuentas y datos ficticios: Auth, MFA, RLS, originales, historial, numeración, CAS y revocación de nuevos accesos. | Preparar cuentas humanas de prueba si se necesitan. No se han copiado datos reales ni configurado SMTP, Edge de correo o cron. El ensayo no sustituye la recuperación completa de producción. |
| 9. Publicación | CI remota correcta, revisión de secretos y dependencias, tres controles obligatorios, `main` protegido incluso para administradores y entorno de publicación restringido. | Aplicar el procedimiento de revisión y vuelta atrás en cada cambio; mantener compatibles los contratos de servidor. |

## Destino de las copias autorizado

Nicole indicó una carpeta privada de contabilidad de Google Drive, abierta en su navegador, para organizar el respaldo. Posteriormente autorizó una conexión técnica de copias separada del chat y completó su consentimiento con el permiso limitado `drive.file`. La credencial cifrada y los identificadores del destino permanecen en el registro privado de operación. La carpeta sigue restringida a las dos personas autorizadas; no se han ampliado permisos.

Comprobar los permisos de la carpeta antes de subir. Guardar únicamente el contenedor cifrado y documentación que no revele secretos. Conservar la clave de recuperación por separado, bajo control de la titular. No compartir, ampliar permisos, borrar documentos ni convertir una copia en un archivo público como parte de la organización.

Una subida manual mediante la pestaña no activa las copias diarias. La automatización necesita un destino y un mecanismo de autorización propios, acordados expresamente. No guardar contraseñas, tokens o claves en el repositorio, en un workflow, en el chat ni junto al contenedor de respaldo.

## Observaciones de Supabase

En el panel consultado el 26 de octubre de 2026:

- Proyecto de producción `tfaglecwycbamibnhqmq`, región `eu-west-1`, organización en plan Free.
- La organización mostraba una única cuenta con rol Owner. Esto es distinto de las cuentas de Nicole y Liliana dentro del portal.
- Security Advisor mostraba **0 errores y 11 advertencias**. El resultado del asesor no constituye una auditoría completa.
- Entre las advertencias figuran RPC `SECURITY DEFINER` de perfiles, avisos e historial. Estas funciones incorporan controles de membresía, identidad y MFA en el código; no se deben retirar permisos necesarios solo para reducir un contador.
- También aparecen advertencias relacionadas con `public.rls_auto_enable()` para acceso público y autenticado, la extensión `pg_net` en `public` y la protección de contraseñas filtradas desactivada.

Revisar cada advertencia contra la definición y los permisos reales antes de cambiarla. `rls_auto_enable()` es una función de trigger: comprobar su tipo, los triggers que la usan y los permisos necesarios; no alterar automáticamente esos objetos. No mover extensiones ni activar opciones de pago sin analizar el impacto y obtener la autorización correspondiente.

El 27 de octubre se completó la comprobación de URLs, límites de Auth, JWT y exposición de esquemas. El registro público, el enlace manual de identidades y las sesiones anónimas están desactivados; la confirmación de correo está activada. Las dos membresías del portal requieren MFA y tienen un factor verificado. Los metadatos no muestran tablas públicas sin RLS, escritura directa de aplicación para `anon`/`authenticated`, RPC anónimas de aplicación ni buckets públicos. El esquema privado no está expuesto en la Data API. El detalle y las limitaciones están en el registro de revisión; no se han cambiado datos financieros.

El 28 de octubre se activó SSL obligatorio, primero en pruebas y después en producción. Tras sus reinicios se comprobaron conexiones nativas con `verify-full` y transacciones explícitas de solo lectura: certificado y hostname válidos en el cliente, y `pg_stat_ssl` confirmando TLS en el tramo pooler–Postgres. El portal público continuó disponible. El ajuste gobierna ambos tramos del pooler según la [documentación de Supabase](https://supabase.com/docs/guides/platform/ssl-enforcement). No se cambiaron contraseñas, claves API, datos contables ni permisos de acceso.

## Publicar una ampliación

1. Confirmar que el árbol de trabajo contiene únicamente los cambios previstos y anotar el commit de producción actual.
2. Conservar la referencia estable y realizar una copia de datos y archivos antes de migraciones que puedan afectar a producción. Verificar esa copia y su clave.
3. Ejecutar las pruebas de aplicación, todas las suites SQL y el build público. Las comprobaciones locales no acreditan Auth, Storage o correo reales.
4. Probar el candidato en un entorno aislado con datos ficticios. No reutilizar destinatarios reales ni habilitar trabajos de correo o cron de producción.
5. Documentar la combinación compatible de interfaz, migraciones y funciones Edge. Aplicar solo migraciones necesarias y comprobar sus resultados antes de publicar la interfaz correspondiente.
6. Publicar mediante la rama y el entorno protegidos; comprobar la versión que devuelve `version.json` y el resultado del despliegue.
7. Comprobar entrada con la cuenta autorizada, navegación, lectura de un documento, visor de originales, configuración y panel de estado. Las pruebas de emisión o envío requieren datos y destinatarios de prueba expresamente autorizados.
8. Registrar versión, fecha, comprobaciones, limitaciones pendientes y destino del respaldo. No anunciar la copia o la recuperación como terminadas sin evidencia.

Ver `CI-SECURITY.md` para los trabajos de verificación y `MONITORING.md` para el alcance de la supervisión pública.

## Volver a la interfaz 1.4.1

La primera opción ante una regresión de interfaz es volver a publicar código compatible. No restaurar una copia antigua de la base de datos ni sustituir el estado financiero para deshacer un cambio visual.

- Crear una corrección revisable a partir de la rama operativa que restaure la interfaz de `v1.4.1`, conservando los controles y migraciones de servidor que sigan siendo necesarios.
- Si solo se añadieron pantallas y herramientas operativas, retirar esa ampliación y volver a compilar; el estado y los originales actuales se conservan.
- Si se cambiaron contratos RPC, esquemas o Edge Functions, comprobar primero que el código antiguo sigue siendo compatible. Un tag no revierte esos cambios.
- Ejecutar las pruebas y publicar por el mismo workflow. Mantener la URL estable y comprobar la versión y la entrada.
- No forzar `main`, reutilizar numeración, reenviar correos inciertos ni borrar información para hacer coincidir un estado antiguo.

Una restauración de datos es una operación diferente, reservada a una pérdida o corrupción confirmada y a un plan autorizado con el servicio aislado.

## Incidencias y seguimiento

Ante una incidencia, anotar hora, operación, versión y código técnico; excluir documentos, contraseñas y tokens de los registros compartidos. Distinguir una caída del portal, una sesión expirada, un fallo de guardado y un resultado de correo incierto antes de actuar.

Un correo incierto no se reenvía automáticamente. Un fallo de copia no se presenta como copia válida. Una cuenta revocada no se vuelve a habilitar para resolver un error de permisos sin revisar la autorización.

Revisar periódicamente ejecuciones y avisos, cuota, copias y restauraciones; revisar también permisos y dependencias cuando entren usuarios o servicios nuevos. La frecuencia y el responsable deben quedar acordados al activar la operación continua.
