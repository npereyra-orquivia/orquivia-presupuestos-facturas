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

La revisión del 26 de octubre de 2026 confirmó un único Owner en la organización de Supabase. No comprobó ni cambió los factores de las cuentas técnicas, sus códigos de recuperación, las contraseñas de las titulares o los permisos de GitHub. Este documento es el procedimiento; no acredita que esas acciones personales se hayan completado.
