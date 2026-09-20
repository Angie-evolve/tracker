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

---

# Sabido y aceptado

No está muerto ni hay que arreglarlo. Está acá para que dentro de seis meses
nadie lo "descubra" y lo toque creyendo que es un descuido.

## `lp_eventos` acepta INSERT anónimo

La policy es `check=true` para `anon`, así que cualquiera con la publishable
key —que está en el `index.html` de un repo público— puede escribirle filas de
más. No puede leer: solo insertar.

Es el precio de medir desde el navegador: el snippet que se pega en las
landings de GHL corre sin sesión, y para escribir el evento necesita ese
permiso.

Si algún día molesta, se acota con un check de forma sobre las columnas, o se
mueve a una edge function que valide antes de insertar. **Hoy no se toca.**

## Los checkbox no muestran caja hasta tildarse

Es una regla global (`input[type=checkbox]` en el `<style>` de la app):
`border:0`, fondo transparente, y solo se dibuja el tilde al marcarse, con
una insinuación al pasar el mouse. **No es un error.** La señal de que ahí se
puede tocar es la etiqueta de al lado, que es clickeable.

Si algún día molesta, se cambia para todos a la vez. Uno solo con caja y el
resto sin ella hace que la app parezca parchada.

## Las reglas de la contraseña están escritas dos veces

`CLAVE_LARGO`, `CLAVE_SIMBOLOS` y `CLAVE_REGLAS` viven en `index.html` y otra
vez en `portal/index.html`. Son dos archivos sueltos, sin nada compartido, así
que no hay forma de tenerlas en un solo lugar sin inventar un build.

**Si cambian en Supabase, se tocan los dos.** El panel está en
Authentication → Providers → Email: "Minimum password length" y "Password
Requirements". Hoy: 12 y los cuatro grupos.

Dentro de cada archivo sí hay una sola fuente: la pista que se ve debajo del
campo se genera desde `CLAVE_REGLAS`, no está escrita a mano. Esa parte ya
falló una vez —el texto decía 8 y el servidor pedía 12— y por eso se generó.

No hay forma de leer las reglas desde el navegador para chequear que no se
separaron: la API valida el carnet antes que la contraseña, así que nunca
contesta cuáles son. El aviso de que se separaron es que aparezca el mensaje
"Esa contraseña no la acepta el sistema", que sólo puede salir si el servidor
rechazó algo que acá pasó.

## La lista de claves de metadata del formulario se mantiene a mano

El portal muestra las respuestas del formulario tal como vengan, porque las
preguntas cambian por cliente y no hay ninguna escrita en el código. Para eso
tiene que descartar lo que **no** es una pregunta, y GHL mezcla las tres cosas
en el mismo objeto:

- el id interno del campo, que repite la pregunta anterior (20 caracteres
  alfanuméricos sin espacios) — se descarta por su forma, no hace falta lista
- `utm_*` — se descarta por el prefijo
- todo lo demás: hoy `link_origen`, que es una URL de 469 caracteres

Esa última clase **no tiene ninguna forma que la distinga de una pregunta**.
Está escrita a mano en `META_FORM`, en `portal/index.html`. Si GHL o una
landing nueva suman otra, hay que agregarla ahí.

**La señal de que pasó:** en el bloque "formulario" de una tarjeta aparece una
"pregunta" que no es una pregunta — una URL, un código, un nombre en
minúsculas con guiones bajos. Si ves eso, la clave nueva va a `META_FORM`.

No se automatiza porque el remedio sería peor: una regla del tipo "descartar
todo lo que esté en minúsculas y sin espacios" se llevaría puesta una pregunta
legítima que se llame `presupuesto`, y eso no se nota nunca.

# Mejoras futuras

Cosas que hoy están bien resueltas y que van a poder mejorarse cuando cambie
otra cosa. **No son pendientes**: hacerlas ahora rompería algo.

## La prueba 3.d quedó sin correr

`006_pruebas.sql`, prueba **3.d**: verifica que un usuario **sin perfil** no
pueda mover un lead de cualquier cliente con `lead_etapa()`. Es la más
importante de la prueba 3 — las otras tres frenan una etapa mal creada, esta
frena tocar los datos de un cliente.

Hoy devuelve *"sin leads en la tabla, no se pudo probar"*, porque `leads`
está vacía. **Hay que volver a correrla apenas haya datos**, aunque sea uno.

Las otras tres de la prueba 3 sí corrieron y dieron ✅.

## El segundo candado de `leads`

`perfiles` tiene dos candados —sin grant de escritura para `authenticated` y
sin policy de escritura— y eso ahí es gratis: nadie escribe esa tabla desde el
navegador.

En `leads` hay **uno solo**: el grant queda y quien separa es la policy. No es
un descuido. La agencia sincroniza los leads que baja de GHL **desde el
navegador**, así que sacarle el grant a `authenticated` deja esa sincronización
sin forma de escribir.

El día que esa sincronización pase a una **edge function con `service_role`**,
el revoke pasa a ser gratis y ahí sí conviene agregarlo:

```sql
revoke insert, update, delete on public.leads from authenticated;
```

Está avisado también dentro de `005_portal_leads.sql`, al lado del grant.
