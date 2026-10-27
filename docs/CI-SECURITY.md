# Verificación y publicación

La ampliación conserva GitHub Pages y el entorno `github-pages`. Los cambios de esta rama no están activos hasta incorporarlos a la rama principal y comprobar su ejecución en GitHub.

## Qué comprueba el workflow

- Los cambios propuestos a `main` ejecutan pruebas de aplicación, todas las suites `supabase/tests/*-postgres.mjs`, análisis de dependencias y revisión de secretos del historial Git.
- Las suites SQL usan bases de datos en memoria con datos ficticios y se ejecutan secuencialmente para limitar memoria. No conectan con la empresa real.
- La compilación de una propuesta usa una URL y una clave pública ficticias. No publica el artefacto ni utiliza las variables de producción.
- La publicación solo se permite desde `main`, después de superar los trabajos anteriores, y conserva el entorno `github-pages`.
- Las Actions están fijadas por SHA. El permiso de publicación y el token de identidad solo pertenecen al trabajo de despliegue; los trabajos de pruebas tienen lectura del repositorio.
- Se mantienen la comprobación del artefacto público y los recursos de compatibilidad de las versiones anteriores.

Gitleaks redacta los valores detectados y tiene desactivados los comentarios, los artefactos de resultados y el resumen de hallazgos. `.gitleaksignore` identifica exclusivamente una clave ficticia de una prueba en un commit histórico; no excluye directorios de pruebas ni futuras coincidencias. La licencia de la Action es gratuita para el propietario individual actual; comprobar sus condiciones si el repositorio se traslada a una organización.

Dependabot propone actualizaciones de npm y GitHub Actions semanalmente. Las propuestas no se incorporan automáticamente. `npm audit --audit-level=high` bloquea incidencias altas o críticas; los avisos de menor gravedad también requieren revisión, aunque no bloqueen ese comando.

## Ejecutar las verificaciones localmente

```powershell
npm ci
npm test
node scripts/verify-postgres.mjs
npm audit --audit-level=high
```

Las pruebas SQL no sustituyen las comprobaciones aisladas de Supabase Auth, Storage, recuperación de acceso, concurrencia con varias conexiones y entrega real de correo. No ejecutar pruebas de importación o restauración contra producción.

## Ajustes de GitHub que deben comprobarse por separado

La configuración remota no se activa editando un archivo del repositorio. Revisar la protección de `main` y exigir los trabajos «Pruebas de aplicación y permisos», «Revisar secretos en Git» y «Comprobar publicación y compatibilidad» antes de integrar cambios. Ajustar la revisión requerida al número real de personas autorizadas; no conceder acceso a otra cuenta solo para satisfacer una regla.

Comprobar también la protección del entorno `github-pages`, los permisos de las cuentas técnicas y las preferencias de avisos de ejecuciones fallidas. Un workflow presente no demuestra que esas protecciones o avisos estén configurados.

## Alcance de la supervisión

`operations-monitor.yml` comprueba la portada, la versión publicada, los recursos públicos y, si se configuran las dos variables públicas, la salud de Auth. Se programa cada seis horas en `main`; las ejecuciones programadas pueden retrasarse o dejar de ejecutarse según las condiciones de GitHub. No sustituye una supervisión con garantía de disponibilidad.

Una ejecución correcta no acredita una copia de seguridad, una restauración, un guardado autenticado ni un envío SMTP. El workflow no envía correos a clientes; las notificaciones de fallos dependen de las preferencias de GitHub de cada responsable. Consulta `MONITORING.md` para el contrato y los límites del comprobador.
