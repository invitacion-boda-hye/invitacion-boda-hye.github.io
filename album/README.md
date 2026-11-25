# Álbum de fotos

El álbum es independiente de la invitación. `index.html` permite preparar hasta diez fotos por envío; las convierte localmente a JPEG y elimina los metadatos al redibujarlas. El backend verifica la estructura, tamaño y hash del objeto guardado en el bucket privado antes de confirmarlo. La validación estructural no equivale a decodificar íntegramente imágenes no confiables.

`admin.html` usa la misma sesión y membresía del panel RSVP. Permite habilitar o cerrar el álbum, establecer fechas y cuota, descargar y eliminar fotografías, generar un QR de la dirección elegida y limpiar cargas interrumpidas. La descarga ZIP contiene las fotos que se hayan cargado en la lista; usa «Cargar más» para incluir las siguientes páginas. Las fechas del panel se muestran en la zona horaria del dispositivo. La configuración inicial usa la zona America/Santiago: abre el 9 de enero de 2027 a las 00:00 y cierra el 17 de enero a las 00:00 (el 16 está incluido). El álbum comienza deshabilitado con 800 MB decimales, es decir, 800.000.000 bytes (aproximadamente 762,94 MiB).

## Instalación y operación posteriores a la revisión

1. Revisar y aplicar **en orden** las migraciones `202611240001_photo_album_phase1.sql` y `202611240002_photo_album_operations.sql` en el entorno que corresponda; este trabajo no ejecuta migraciones remotas.
2. Publicar la función `photo-album` con `verify_jwt = false`; la función valida sesión y membresía administrativa en cada operación privada. Configurar `ALLOWED_ORIGINS` para el origen del sitio. Las claves de servicio permanecen en el servidor.
3. Servir los archivos estáticos y abrir `album/admin.html`. Verificar la cuota de 800 MB y las fechas; habilitar el álbum solo cuando corresponda. Una reserva consume hasta 2 MiB hasta confirmarse o limpiarse. No se crean políticas públicas de Storage.
4. Comprobar la URL pública definitiva antes de generar, descargar e imprimir el QR. Las fotos almacenadas son privadas y no se muestran en la invitación.
5. Ejecutar periódicamente «Limpiar cargas interrumpidas» en administración, especialmente antes de revisar cuota. La operación retiene las reservas si falla el borrado de Storage, para permitir reintentos. El límite por IP es compartido; muchos invitados detrás de una misma red pueden tener que esperar diez minutos.

## Pruebas

`node --test tests/photo-album.test.cjs` prueba el handler con servicios simulados, sin conexiones externas. `supabase/tests/005_photo_album_invariants.sql` comprueba permisos, ventana, cuota, idempotencia y borrado dentro de una transacción que se revierte; ejecutarlo solo en Supabase local tras las migraciones. Para reconstruir los bundles desde la raíz: `album/node_modules/.bin/esbuild album/album.js --bundle --minify --outfile=album/album.bundle.js` y lo mismo con `album/admin.js` y `album/admin.bundle.js`.

Para la integración real hay una prueba preparada en `tests/photo-album-supabase-local.test.cjs`. Requiere una instancia Supabase **local y desechable**, con las migraciones aplicadas y la función servida localmente. Configura `ALBUM_LOCAL_SUPABASE_URL`, `ALBUM_LOCAL_ANON_KEY` y `ALBUM_LOCAL_SERVICE_KEY` con sus valores locales, además de `ALBUM_DISPOSABLE_SUPABASE=yes`, y ejecuta `node --test tests/photo-album-supabase-local.test.cjs`. La prueba rechaza destinos que no sean loopback y álbumes que ya contengan fotos; crea y elimina un usuario de prueba y restaura la configuración. Sin esas variables, queda omitida. Las claves nunca se deben copiar al repositorio.

Para verificar también el navegador contra esos servicios locales, sirve la función con `ALLOWED_ORIGINS=http://127.0.0.1:55555` y ejecuta `node --test tests/photo-album-supabase-browser-local.test.cjs` con las mismas variables. La prueba levanta su servidor web temporal en ese puerto, crea y elimina datos de prueba y restaura la configuración. Si se ejecutan ambas pruebas de integración juntas, usa `--test-concurrency=1` para que no compartan el álbum simultáneamente.
