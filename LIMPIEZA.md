# Cosas muertas

Lo que encontramos que ya no lo usa nadie, anotado para no volver a
descubrirlo de cero. **Nada de acá se borra sin decidirlo aparte**: la zona
COMPARTIDA solo suma, y un `drop` no tiene vuelta atrás.

## `latido` — tabla, candidata a borrar

Dos columnas (`id`, `visto`) y una sola fila, del **4/8/2026**.

- Sin lector ni escritor en todo el repo: `git grep -i latido` fuera de
  `index.html` no devuelve nada, y en `index.html` los matches son variables
  de timers (`_fathomLatido`, `_citasLatido`), no la tabla.
- Nadie tiene permiso de escribirla, ni siquiera `service_role`.
- Parece haber sido un ping de arranque para confirmar que Supabase contesta.
  Ese lector ya no existe.

Desde `002_latido_sin_anon.sql` tampoco la puede leer `anon`.

## `demartinmarquez@gmail.com` en `equipo_video` — fila de más

No existe como usuario en `auth.users`, así que esa entrada no le da acceso a
nadie. Las tres cuentas reales son `mdlangierh@`, `ashn10291@` y
`melany@theflowingcode.com`.

O el mail está mal escrito, o sobra.
