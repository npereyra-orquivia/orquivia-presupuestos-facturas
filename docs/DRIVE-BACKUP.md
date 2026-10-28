# Copias cifradas en Google Drive

## Estado de esta integración

El 28 de octubre de 2026 la titular completó el consentimiento real para una conexión técnica independiente con el único permiso `drive.file`. La credencial se guarda cifrada fuera del repositorio. Se creó una carpeta propia de la aplicación dentro del destino de contabilidad autorizado y se comprobó por API que sus permisos coinciden exactamente con las dos personas autorizadas. Se subió un respaldo real cifrado de 19.699.449 bytes, comprobando los permisos del archivo y su checksum; su descarga de vuelta superó la verificación de SHA-256, AES-GCM y sus 50 entradas. **La copia automática sigue desactivada y el ensayo de restauración sigue pendiente.** No usa el conector del chat ni las cookies de una pestaña.

Una ejecución terminada con éxito confirma la autenticación del archivo local, sus componentes de recuperación, la subida de sus bytes cifrados, el tamaño y la suma de comprobación devuelta por Drive. No confirma que se haya ensayado la restauración de la base de datos.

## Autorización antes de automatizar

La titular debe aprobar expresamente una conexión técnica de copias, distinta de conectar Drive al chat. El operador prepara una aplicación OAuth y la titular completa el consentimiento. El permiso admitido es exclusivamente `https://www.googleapis.com/auth/drive.file`; el helper rechaza una respuesta de token que incluya otros permisos o que no declare su alcance.

La carpeta debe haber sido seleccionada o compartida con esa aplicación mediante Google Picker o un selector compatible. Conocer el enlace o el identificador de una carpeta existente no concede acceso a la aplicación. Este permiso alcanza los archivos autorizados o creados por la aplicación; no es un permiso de lectura de todo Drive. Consulta la [descripción oficial de los permisos de Drive](https://developers.google.com/workspace/drive/api/guides/api-specific-auth).

El acceso sin una pestaña abierta necesita un token de actualización obtenido mediante el consentimiento de la titular. El helper únicamente usa un token ya autorizado; no crea credenciales, no abre consentimientos ni amplía permisos. La [documentación de OAuth de Google](https://developers.google.com/identity/protocols/oauth2/web-server#offline) describe ese acceso delegado.

## Configuración privada del operador

Guardar estas variables en el almacén privado de secretos del ejecutor de copias, nunca en Git, `VITE_…`, el navegador, logs o documentos de Drive:

| Variable | Uso |
| --- | --- |
| `ORQUIVIA_DRIVE_UPLOAD_ENABLED` | Debe ser exactamente `true`, después de la autorización. |
| `ORQUIVIA_DRIVE_FOLDER_ID` | Identificador de la carpeta de copias autorizada; no se admite una URL. |
| `ORQUIVIA_DRIVE_ALLOWED_EMAILS` | Lista privada obligatoria de 1–20 personas: correos ASCII en minúsculas, separados por comas, sin espacios ni duplicados. |
| `ORQUIVIA_DRIVE_CLIENT_ID` | Identificador de la aplicación OAuth de copias. |
| `ORQUIVIA_DRIVE_CLIENT_SECRET` | Secreto de esa aplicación. |
| `ORQUIVIA_DRIVE_REFRESH_TOKEN` | Token de actualización delegado por la titular. |
| `ORQUIVIA_BACKUP_KEY` | Clave base64 de 32 bytes usada por la herramienta de copia. |

La clave de recuperación debe conservarse también por separado en el medio privado elegido por la titular. No subirla junto con los archivos cifrados. No introducir secretos en argumentos de la línea de comandos.

La lista de personas se guarda como secreto del ejecutor, nunca con direcciones reales en el repositorio. Su formato canónico es, por ejemplo, `owner@example.test,reviewer@example.test` (direcciones ficticias). Incluir a todas las personas que deban aparecer en los permisos, incluida la propietaria y la cuenta que sube el archivo. La carpeta y el archivo deben tener **exactamente ese conjunto**; una persona extra o una autorizada ausente impiden confirmar la copia. Si cambian las personas autorizadas, revisar tanto los permisos como la lista por el procedimiento de operadora; el helper no los ajusta.

Ejecutar con Node.js 22 o posterior, usando un archivo generado por `scripts/backup/cli.mjs`:

```text
node scripts/backup/drive-upload.mjs --file /ruta/privada/orquivia-fecha-identificador.orqbackup
```

El programa no crea la carpeta, no mueve archivos y no altera sus permisos. Solo admite archivos locales normales con extensión `.orqbackup`, rechaza enlaces simbólicos y verifica su cifrado y estructura antes de contactar con Google. No acepta JSON, claves sueltas ni un ZIP de documentos sin cifrar.

## Controles de destino y de subida

- Comprueba que el destino existe, es una carpeta de Mi unidad, no está en la papelera y permite añadir archivos. Las unidades compartidas no están admitidas por este helper.
- Comprueba todas las páginas de permisos de la carpeta antes de crear el archivo y vuelve a revisar la carpeta y el archivo al terminar. Cada permiso debe ser de tipo `user`, incluir un `emailAddress` ASCII válido de la lista y tener rol `owner`, `writer`, `commenter` o `reader`. Normaliza a minúsculas las direcciones que devuelve Drive, sin colapsar alias. Al completar todas las páginas, el conjunto debe coincidir con la lista completa. Rechaza grupos, acceso `anyone`, de dominio, direcciones ausentes, personas extra, roles de unidades compartidas y cualquier permiso no comprobable. No concede, elimina ni corrige permisos. El archivo nuevo solo puede inspeccionarse después de existir; antes de su creación se comprueba la carpeta de la que heredará permisos.
- Renueva credenciales solo en el endpoint OAuth oficial de Google. Envía el contenido cifrado únicamente al endpoint de subida de Drive autorizado y rechaza redirecciones y otras ubicaciones de sesión.
- La sesión puede conservar la proyección exacta de campos solicitada e incluir una credencial opaca `session_crd`, observada en la respuesta real de Google. Ambas permanecen privadas. Solo se admiten esos parámetros opcionales acotados, sin duplicados, en el mismo origen HTTPS y ruta de subida; no se admiten proyecciones diferentes ni parámetros arbitrarios.
- Usa una sesión reanudable, fragmentos de hasta 8 MiB y límites de tiempo, solicitudes y tamaño. Tras una respuesta de subida incierta pregunta a la misma sesión qué bytes recibió antes de continuar. Nunca crea automáticamente un segundo archivo como respuesta al fallo.
- Contrasta el nombre, padre, tamaño y checksum binario devueltos por Drive con el archivo local. El MD5 se utiliza como checksum de transporte ofrecido por Drive; la autenticidad del respaldo procede de AES-GCM y de las verificaciones SHA-256 del contenedor. Contrasta también el SHA-256 de Drive cuando esté disponible.

Las sesiones y offsets siguen el [protocolo de subidas reanudables de Google Drive](https://developers.google.com/workspace/drive/api/guides/manage-uploads). La sesión se usa durante esa ejecución: no se imprime ni se guarda para repetirla después.

## Resultado y errores

Una ejecución correcta devuelve `status: uploaded-and-verified` y `recoveryTested: false`. Los mensajes del proceso son cerrados y no incluyen claves, tokens, URLs de sesión, cuerpos de respuesta, identificadores de carpeta ni rutas privadas.

Si una subida queda incierta, se corta o falla una comprobación después de crear el archivo, revisar en Drive el nombre y tamaño antes de repetirla. Puede existir un archivo y el programa no lo borra ni modifica sus permisos. No programar reintentos ciegos de todo el proceso. El helper no elimina respaldos anteriores; una política de conservación requiere su procedimiento separado.

Antes de programar ejecuciones diarias hay que completar la autorización, probar una subida y una descarga reales y verificar de nuevo el contenedor descargado. Habilitar avisos de ejecuciones fallidas y realizar el ensayo de recuperación descrito en [BACKUP-RECOVERY.md](BACKUP-RECOVERY.md).

Pruebas sin Google ni credenciales reales:

```text
node --test tests/drive-backup-upload.test.js
```
