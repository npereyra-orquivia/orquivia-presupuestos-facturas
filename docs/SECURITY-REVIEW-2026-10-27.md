# Revisión de seguridad y operación · 27 de octubre de 2026

## Alcance y versión

Se comprobó la configuración de producción mediante la CLI y consultas de metadatos de Supabase, la configuración de GitHub y los resultados de publicación y supervisión. La versión **1.5.0** está publicada desde el commit `ab1773595002da83524d4139db02212f48cc1d0c`. La dirección oficial permanece en [el portal de Orquivia](https://npereyra-orquivia.github.io/orquivia-presupuestos-facturas/).

Este registro distingue comprobaciones realizadas de tareas pendientes. No es una certificación, una prueba de penetración completa ni una garantía de ausencia de vulnerabilidades. No contiene registros financieros, credenciales, claves de recuperación ni identificadores privados del respaldo.

## Producción comprobada

| Control | Evidencia del 27 de octubre |
|---|---|
| Base de datos | El servidor consultado utiliza PostgreSQL **17.11**. |
| RLS | **0** tablas del esquema `public` sin RLS activada. La presencia de RLS se complementa con las pruebas de permisos; por sí sola no demuestra que toda política sea correcta. |
| Escritura directa | **0** permisos de escritura directa sobre las tablas de aplicación para los roles `anon` y `authenticated`. Las operaciones autorizadas utilizan las funciones de aplicación correspondientes. |
| Acceso anónimo | **0** RPC de aplicación ejecutables por el rol anónimo. |
| Membresía y segundo factor | Las **2** membresías activas exigen MFA y las **2** cuentas tienen un factor verificado. Los factores del portal son distintos de los de los paneles técnicos y el proveedor de correo. |
| Archivos | **0** buckets públicos. El esquema privado de aplicación no está expuesto en la Data API. |
| Alta y acceso Auth | Registro público, sesiones anónimas y enlace manual de identidades **desactivados**; confirmación de correo **activada**. |
| URLs de Auth | Site URL coincide con la raíz exacta del portal oficial; la lista adicional de redirecciones está vacía. |
| Tokens | Caducidad de JWT: **3.600 segundos**. Detección de reutilización de refresh tokens activada; intervalo de reutilización: **10 segundos**. Esto no implica revocación instantánea de todos los JWT ya emitidos. |

Estas comprobaciones describen la configuración observada en esa fecha. Nuevas tablas, funciones, buckets o cambios de Auth requieren revisar de nuevo permisos y exposición.

## Código, publicación y correo

- `main` exige una propuesta de cambio y **tres comprobaciones obligatorias**, con la rama actualizada antes de integrar. La protección se aplica también a administradores; no permite forzar ni borrar la rama. El segundo factor de la cuenta propietaria de GitHub se comprobó **activo** en la pantalla de seguridad: aplicación autenticadora configurada y establecida como método preferido.
- La validación asociada a la primera publicación incluyó **366 pruebas de aplicación** y **645 comprobaciones SQL**. Tras ampliar las herramientas, la última ejecución de aplicación terminó con **384 pruebas aprobadas y 1 omitida** por la falta de permisos para crear enlaces simbólicos en Windows. Las 645 comprobaciones SQL no han cambiado. La auditoría de dependencias no detectó vulnerabilidades y Gitleaks no detectó secretos en el alcance revisado. Son resultados de esas ejecuciones, no una garantía para cambios futuros.
- La función Edge `document-mail` se desplegó mediante la CLI con su bundle compilado y **Nodemailer 10.2.1**. La fuente anterior se conservó en un respaldo privado. El despliegue no equivale a una prueba de entrega a destinatarios reales.
- La supervisión pública comprobó el portal, sus recursos JavaScript y CSS y la salud de Auth. Su [ejecución manual 40496306750](https://github.com/npereyra-orquivia/orquivia-presupuestos-facturas/actions/runs/40496306750) terminó correctamente; el workflow está programado cada **6 horas**. No prueba operaciones autenticadas, entrega SMTP, trabajos cron, copias completas ni capacidad de restauración.
- Se conserva la referencia estable anterior **v1.4.1** para recuperar código compatible. Volver a una interfaz anterior no requiere restaurar datos contables antiguos.

## Respaldo comprobado y sus límites

Se creó un **respaldo parcial cifrado de la exportación operativa y del código**, se subió manualmente a Google Drive y se comprobó su descarga de vuelta mediante la integridad del archivo y la autenticación del contenedor. La carpeta permanece restringida a Nicole y Liliana; no se amplió su acceso. La clave de recuperación se conserva separada de Drive.

Ese respaldo **no es una captura completa de PostgreSQL y Auth** ni acredita una restauración completa del sistema. No se ha autorizado ni activado OAuth para copias automáticas de Drive. Una pestaña abierta y una subida manual no constituyen una conexión permanente.

Las herramientas de captura, verificación y recuperación documentan su alcance y los requisitos pendientes en [BACKUP-RECOVERY.md](BACKUP-RECOVERY.md). La preparación de una ejecución programada no debe describirse como una copia diaria operativa antes de completar su autorización y ensayo.

## Pendiente antes de declarar completada la operación

1. Comprobar los medios de recuperación de Supabase y la protección del correo. El autenticador de Supabase fue añadido por la titular y verificado posteriormente el mismo día; queda pendiente su segunda vía de recuperación. Seguir [ACCESS-RECOVERY.md](ACCESS-RECOVERY.md).
2. Preparar por un canal seguro las credenciales y la configuración necesarias para una captura completa de PostgreSQL, Auth, Vault y archivos, y verificarla. No introducir secretos en Git ni en la documentación pública.
3. Obtener una autorización OAuth separada y limitada para Drive si se desea automatizar las copias, comprobar el destino restringido y completar una subida y descarga reales con ese mecanismo. La autorización de la subida manual no sustituye ese consentimiento.
4. Realizar y documentar una **restauración completa en un destino aislado**, con correo y tareas de producción bloqueados. Verificar cuentas, MFA, permisos, numeración y originales, además de la integridad del contenedor.
5. Mantener separado el backend de staging que ya se creó y comprobó con 36 pruebas reales y datos ficticios. No trasladar allí SMTP, cron ni usuarios reales como consecuencia de ese ensayo. Queda pendiente el ensayo distinto de restauración completa.
6. Completar la revisión de cuentas técnicas, el eventual buzón propio para el remitente automático y el circuito de avisos de fallos. La supervisión pública no cubre por sí sola un trabajo que nunca llegó a iniciarse.

El ensayo del backend independiente comprobó dos sesiones MFA reales, permisos, archivos, historial y una carrera de guardados con exactamente un avance y un HTTP 409 para la otra sesión. Las 47 comprobaciones SQL nuevas verifican además que la migración 016 no altera datos ni permisos. El total local es de 692 comprobaciones SQL y 386 pruebas de aplicación correctas, con una prueba de symlinks omitida por permisos de Windows.

Un archivo entregado durante un acceso autorizado puede conservarse en la caché por usuaria; la revocación se comprobó con una petición nueva sin reutilizar esa respuesta y con la denegación de nuevas URLs firmadas. Las URLs ya emitidas y las copias descargadas tienen sus propios límites y no se retiran prometiendo revocación instantánea.

Los pasos que requieren identidad, factores, credenciales o consentimiento los completa la titular mediante el canal del servicio correspondiente. Hasta que exista evidencia del ensayo completo y de la ejecución autorizada, no indicar que las copias completas o la recuperación del sistema están operativas.
