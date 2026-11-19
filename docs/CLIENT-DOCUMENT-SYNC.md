# Clientes y documentos en preparación

Desde la versión 1.9.0, el selector de cliente de un presupuesto o factura permite crear una ficha o editar la seleccionada. El formulario vuelve al documento con sus conceptos, importes y condiciones pendientes intactos. Cancelar la ficha no guarda sus cambios.

Los borradores consultan la ficha actual del cliente; una conversión desde un presupuesto no arrastra su antigua copia del destinatario. Los presupuestos preparados actualizan su copia en el mismo guardado que la ficha general cuando todavía no tienen evidencia de envío, cambio posterior de estado ni una factura emitida vinculada. Una factura vinculada que sigue siendo borrador permite actualizar ambos documentos.

Los presupuestos enviados, aceptados o rechazados conservan el cliente histórico. Volver a marcar un presupuesto enviado como preparado no permite cambiarlo: se consulta el historial del servidor. Cualquier intento de correo, incluso fallido, conserva también la copia para evitar alterar un envío en curso o un documento que pudo haberse entregado. Una corrección explícita de estado posterior a preparar el presupuesto se trata de forma conservadora porque el historial guarda los campos modificados, no sus valores anteriores.

Las facturas emitidas, incluidas las etiquetadas como preparadas para enviar, mantienen su identidad fiscal y el registro de numeración. Su correo de facturación es un campo independiente: un valor heredado puede seguir la ficha general mientras la factura continúe preparada sin historial de envío; un destinatario personalizado se conserva. Los borradores de correo ya redactados mantienen los destinatarios que eligió la usuaria.

La sincronización se ejecuta dentro del guardado del servidor con autenticación, pertenencia a la empresa, segundo factor y comparación de versión. La respuesta incluye el estado canónico guardado; la interfaz lo adopta antes de actualizar la vista. No se modifica el registro fiscal, la numeración, los importes ni los originales de correos. Las modificaciones de la ficha y las copias de cliente quedan en el historial del mismo guardado.

Las copias antiguas de presupuestos sin destinatario congelado se fijan con la evidencia histórica disponible o el último cliente efectivo conocido. Si un presupuesto antiguo sin copia está en un envío pendiente o incierto, se conserva su JSON exacto hasta cerrar el resultado, para no romper la comprobación de entrega. Una factura histórica sin copia fiscal del cliente no se reescribe para inventar datos que no quedaron registrados.

No hay tablas nuevas ni cambio del formato de las copias: el estado JSON sigue incluyéndose íntegramente. La migración no edita documentos existentes por adelantado; las reglas se aplican en los siguientes guardados. Una pestaña anterior puede ignorar el nuevo estado de respuesta sin borrar las copias históricas que el servidor ya haya fijado.

Validación: pruebas de resolución y vuelta al editor, respuestas canónicas y sesiones, y PostgreSQL aislado con datos ficticios para concurrencia, historial de estado, envíos principales y relacionados, guardados desde pestañas anteriores y preservación fiscal.
