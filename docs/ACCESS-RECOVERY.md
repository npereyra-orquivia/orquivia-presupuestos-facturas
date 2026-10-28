# Accesos, bajas y recuperación

Este procedimiento complementa el segundo factor y los permisos existentes. No introduce un acceso público de emergencia ni permite saltarse la verificación de identidad.

## Separar los tres tipos de acceso

- **Portal de Orquivia:** cuentas individuales de las personas autorizadas. Nicole administra; el rol de edición permite trabajo operativo. El portal no tiene un límite técnico de dos cuentas, pero todavía no dispone de un panel completo de altas y bajas.
- **Paneles técnicos:** GitHub y Supabase controlan código, publicación, usuarios e infraestructura. Un administrativo no necesita acceso a esos paneles para usar el portal.
- **Correo:** cada titular mantiene su buzón para enviar documentos. El SMTP de recuperación de Supabase es una conexión separada, aunque actualmente pueda utilizar la credencial del mismo buzón.

No compartir cuentas o factores entre personas. No conceder acceso al panel técnico para resolver una necesidad de edición dentro del portal.

## Preparación por las titulares

1. Comprobar el segundo factor de GitHub, Supabase y correo cuando el proveedor lo admita. El segundo factor del portal no protege automáticamente esas cuentas técnicas.
2. Guardar fuera del dispositivo habitual los códigos de recuperación que cada proveedor ofrezca. No asumir que el portal ofrece esos códigos: su recuperación excepcional requiere un operador autorizado.
3. Mantener actualizados los medios de recuperación y una forma de verificar personalmente la identidad de la titular.
4. Conservar un inventario de responsables y accesos sin contraseñas. Designar, si se necesita, una persona técnica de contingencia con permisos acordados; no añadir propietarios por iniciativa del operador.
5. Conservar la clave de las copias cifradas en un lugar distinto de las copias y comprobar que la titular puede recuperarla. No mostrarla en el chat, capturas o logs.

## Contraseña del portal olvidada

Utilizar «¿Has olvidado la contraseña?» en la dirección oficial. La titular recibe el enlace del servicio de acceso y completa el autenticador ya verificado antes de elegir la contraseña nueva. No pedirle que comunique contraseña o código por chat.

Si no llega el mensaje, comprobar primero el remitente, el estado de SMTP y el correo no deseado. Si `acceso@orquivia.com` sigue siendo un alias, una nueva contraseña del buzón personal puede requerir actualizar por separado la credencial SMTP guardada en Supabase. No cambiar las conexiones personales de envío de documentos como sustituto de esa comprobación.

El 28 de octubre de 2026 la titular confirmó que no dispone de más buzones en su plan y eligió mantener el buzón personal existente como autenticación SMTP y el alias de acceso como remitente. Se comprobó que esa es la configuración actual, sin crear cuentas adicionales ni contratar capacidad. Una contraseña nueva del buzón debe actualizarse en cada conexión que la utilice y en el paquete privado de recuperación; el alias no dispone de una contraseña independiente.

El cambio de contraseña debe introducirlo y confirmarlo la titular. Comprobar después el inicio normal y la verificación del portal. El cierre de sesiones y la expiración de JWT tienen sus propios plazos; no prometer revocación instantánea de todas las copias de tokens ya emitidos.

## Pérdida del móvil o del autenticador

1. La titular contacta con la responsable por un canal previamente conocido. No aceptar como prueba suficiente un correo nuevo o una petición recibida desde un canal desconocido.
2. La responsable verifica personalmente identidad, cuenta afectada, motivo y autorización. Si no puede verificarla, se mantiene el bloqueo y se usa el proceso de recuperación del proveedor correspondiente.
3. Un operador ya autorizado prepara una intervención limitada a esa cuenta, registra la autorización y conserva evidencia técnica sin códigos ni secretos.
4. Si existe sospecha de compromiso, revisar y limitar la membresía o las sesiones según el incidente antes de recuperar el uso. No desactivar MFA para toda la empresa.
5. La titular completa personalmente cualquier nueva credencial y el alta de su nuevo autenticador. El operador no solicita los códigos por chat ni deja una cuenta con acceso a documentos sin el segundo factor exigido.
6. Comprobar que el acceso normal vuelve a exigir MFA, revisar sesiones y dispositivos, y cerrar la incidencia con fecha, responsable y resultado.

No se incluye un script de restablecimiento masivo ni un bypass de MFA. La intervención concreta depende de la cuenta y del proveedor; debe prepararse y autorizarse antes de ejecutarla.

## Baja de una persona

Registrar la decisión de la responsable y su fecha. Desactivar la membresía de la empresa y comprobar que la cuenta deja de poder leer y guardar datos. Revisar por separado dispositivos de avisos, conexión de correo y cualquier acceso técnico que realmente tuviera.

Conservar autoría, historial, documentos emitidos y justificantes. Una baja no requiere borrar esos registros ni reutilizar otra identidad. La revocación no puede retirar archivos que la persona descargara cuando estaba autorizada.

Si existe una credencial compartida, evaluar su sustitución por la titular y actualizar únicamente los servicios que la usan. No restablecer indiscriminadamente las contraseñas de otras personas.

## Cambios en cuentas técnicas

Antes de cambiar factores, propietarios, permisos o credenciales técnicas, identificar el servicio, el alcance y los servicios dependientes. Preparar una vía de recuperación que no dependa del mismo dispositivo o de una única copia.

Las cuentas técnicas y los secretos no se exportan a documentación pública. Una copia de configuración debe estar cifrada y la recuperación debe ensayarse en aislamiento. La carpeta de Drive autorizada no debe contener la clave de recuperación junto al respaldo.

## Estado de comprobación

La revisión del 26 de octubre de 2026 confirmó un único Owner en la organización de Supabase. La comprobación del 27 de octubre confirmó que las dos membresías activas del portal exigen MFA y que ambas cuentas tienen un factor verificado. Son accesos distintos de los paneles técnicos.

En GitHub se comprobó que `main` exige una propuesta de cambio y tres comprobaciones obligatorias con la rama actualizada, aplica la protección a administradores y prohíbe forzar o borrar la rama. **El segundo factor de la cuenta propietaria de GitHub está verificado activo:** la pantalla de seguridad muestra la aplicación autenticadora configurada y como método preferido. También muestra los códigos de recuperación como consultados; no se abrieron ni leyeron sus valores durante la comprobación. No se han acreditado los factores ni los medios de recuperación de Supabase y correo, ni se han cambiado contraseñas o códigos de las titulares como parte de esta revisión.

Posteriormente, el 27 de octubre, la titular añadió un autenticador a su cuenta técnica de Supabase y se comprobó su presencia en Security. El proveedor recomienda otro autenticador de respaldo; no se ha acreditado esa segunda vía ni la protección del correo. No se abrieron QR, secretos ni códigos de las titulares.

La clave del respaldo cifrado se conserva separada de la carpeta restringida de Drive. La descarga y verificación del respaldo parcial no acredita una recuperación completa de cuentas y datos. Este procedimiento no declara completadas las acciones personales pendientes; el alcance comprobado y las limitaciones figuran en [la revisión del 27 de octubre](SECURITY-REVIEW-2026-10-27.md).
