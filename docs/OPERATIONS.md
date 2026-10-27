# Operación y recuperación de Orquivia

## Referencia estable anterior a las mejoras

La versión operativa comprobada antes de este trabajo es **1.4.1**, commit `1625e0494638fb6c782e4f8cbdf02b08ec4d3bb2`, conservada en el tag remoto `v1.4.1`. Se creó y verificó además el bundle local `private/recovery/orquivia-v1.4.1-before-hardening.bundle`.

El tag y el bundle conservan código e historial de Git. No incluyen la base de datos real, los justificantes de Storage, las cuentas, las credenciales ni las conexiones de correo. Recuperar una interfaz anterior no implica recuperar una contabilidad anterior.

La dirección del portal sigue siendo `https://npereyra-orquivia.github.io/orquivia-presupuestos-facturas/`. Este trabajo mantiene GitHub Pages y Supabase.

## Estado de preparación de los puntos 1–9

Esta tabla describe la preparación de la ampliación del **26 de octubre de 2026**. La presencia de código no acredita su activación ni una ejecución real satisfactoria. Actualizar la evidencia al terminar cada paso.

| Punto | Preparación disponible | Activación o evidencia que falta |
|---|---|---|
| 1. Copias completas | Herramienta cifrada y procedimiento para capturar base de datos, originales y configuración. | Configurar credenciales y clave por un canal seguro; capturar, verificar y guardar una copia real fuera del proyecto. La ejecución diaria y la subida automática no están acreditadas. |
| 2. Recuperación | Verificación de integridad del contenedor y plan de restauración aislada. | Ensayo completo con datos reales, acceso, numeración y originales, en un destino aislado. Una verificación criptográfica no es un ensayo de recuperación. |
| 3. Producción | Revisión parcial del panel de Supabase y controles de acceso en código. | Terminar comprobación de Auth, esquemas expuestos, Storage y permisos del proyecto. |
| 4. Cuentas técnicas | Procedimiento de acceso, bajas y recuperación documentado. | Las titulares deben comprobar sus propios factores y medios de recuperación de GitHub, Supabase y correo. |
| 5. Remitente automático | El portal ya utiliza `acceso@orquivia.com` como remitente de acceso. | Confirmar si continúa como alias de Nicole y, si se decide separarlo, crear un buzón y configurar su credencial propia con intervención de su titular. |
| 6. Supervisión | Comprobador público y workflow preparados. | Publicarlos en `main`, comprobar una ejecución y la recepción de avisos. No cubre automáticamente errores autenticados, SMTP, cron ni copias. |
| 7. Capacidad | Panel de administración preparado con datos cargados, límites y tamaño declarado de archivos. | Comprobar la interfaz publicada. La cuota total de Supabase y la última copia requieren evidencia del servicio; no deben mostrarse como correctas sin ella. |
| 8. Pruebas separadas | Suites con datos ficticios e infraestructura en memoria. | Un backend independiente con Auth y Storage reales; configurar aislamiento y bloqueo de correos antes de usarlo. Una URL distinta contra producción no es aislamiento. |
| 9. Publicación | CI ampliada para propuestas, pruebas SQL, revisión de secretos y dependencias. | Comprobar su ejecución remota, protección de `main`, entorno de publicación y procedimiento de vuelta atrás. |

## Destino de las copias autorizado

Nicole indicó una carpeta privada de contabilidad de Google Drive, abierta en su navegador, para organizar el respaldo. La instrucción actual es utilizar **esa pestaña**, sin conectar Google Drive al chat ni crear una autorización persistente adicional. El identificador de esa carpeta permanece en el registro privado de operación.

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

En Sign In / Providers se verificó que el registro público, el enlace manual de identidades y las sesiones anónimas estaban desactivados, y la confirmación de correo activada. Todavía no se han acreditado las URLs de recuperación, límites de Auth, caducidad de JWT, MFA de las cuentas técnicas o exposición de esquemas. `scripts/operations/audit.sql` permite obtener metadatos agregados sin extraer registros financieros ni secretos; el resto requiere revisar las pantallas pertinentes.

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
