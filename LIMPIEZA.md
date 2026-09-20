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

---

# Lo que se comprueba y cuándo se comprobó

Las pruebas de `supabase/pruebas/` **se corren a mano**. No hay nada que las
dispare solo, así que lo único que dice si siguen pasando es la fecha de la
última vez que alguien las corrió.

**Una fecha vieja acá no es un error: es la señal de que hace mucho que nadie
lo comprueba.** Si tocás `es_agencia()`, `mi_rol()`, una policy o cualquiera de
las funciones `lead_*` / `etapa_*`, corré la prueba que corresponda y
actualizá la fecha en el mismo commit.

| prueba | qué asegura | última corrida |
|---|---|---|
| 1 — traducción de GHL | que un stage de GHL caiga en la etapa correcta | **2026-09-20** ✅ |
| 2 — reordenar no rompe | que mover una etapa de lugar no cambie a dónde van los leads | sin fecha anotada |
| 3 — usuario sin perfil | que quien no tiene perfil no pueda nada (ver abajo) | **2026-09-20** ✅ |
| 4 — etapas de otro cliente | que un cliente no lea las etapas de otro | sin fecha anotada |
| 5 — borrar una etapa | que los leads se muden en vez de quedar huérfanos | sin fecha anotada |
| 6 — estructura y permisos | que `anon` no ejecute ninguna función | parcial, ver abajo |

**Sobre la 1:** el 2026-09-20, al aplicar el `011`, se corrieron las 14 de la
prueba 1 más 3 del `007` —"Asistió a llamada", "Oferta presentada" y "No
asisitó a llamada" con el typo—. Los 17 en ✅, cero regresiones.

**Sobre la 6:** no se corrió entera. Sí se verificó, función por función y a
medida que se crearon, que `anon` no pueda ejecutar `lead_calificar`,
`lead_presento`, `portal_cuentas` ni `mi_cliente_nombre`. Falta la corrida
completa, que además lista las 45 variantes de stage y las que no se traducen.

**Las que dicen "sin fecha anotada"** corrieron alguna vez y dieron bien, pero
no quedó registro de cuándo. Vale la pena correrlas una vez y anotarlas: son
rápidas y las tres tocan cosas que ya cambiaron desde entonces (el `011` sumó
una etapa, el `013` sumó una columna a `etapas`).

## La prueba 3.d — corrida y pasada el 2026-09-20

`006_pruebas.sql`, prueba **3.d**: verifica que un usuario **sin perfil** no
pueda mover un lead de cualquier cliente con `lead_etapa()`. Es la más
importante de la prueba 3 — las otras tres frenan una etapa mal creada, esta
frena tocar los datos de un cliente.

Quedó sin correr mucho tiempo porque `leads` estaba vacía. **Corrida el
2026-09-20 con 288 filas en la tabla, y la prueba 3 entera dio ✅:**

```
mi_rol()             (NULL)  ← el rol es desconocido
es_agencia()         false   ← tiene que decir false, NUNCA null
etapa_crear          ✅ freno -> Solo la agencia puede crear etapas
etapa_borrar         ✅ freno -> Solo la agencia puede borrar etapas
etapas_reordenar     ✅ freno -> Solo la agencia puede reordenar etapas
lead_etapa           ✅ freno -> Ese lead no existe
```

El lead que usó era de Zentenio, o sea **ajeno** al usuario simulado. El
mensaje es el mismo que para un lead inexistente, así que el guarda tampoco
confirma que ese id exista.

El rollback no dejó nada: 0 etapas `hackeada`, las 12 en su orden, 288 leads y
los 4 de siempre en `compro`.

**Por qué queda anotado en vez de borrado:** esto no se corre solo. Si mañana
alguien toca `es_agencia()`, `mi_rol()` o cualquiera de las cuatro funciones,
hay que volver a correr la prueba 3 y actualizar esta fecha. Una fecha vieja
es la señal de que hace mucho que nadie lo comprueba.

⚠️ La trampa que la hacía mentir ya está arreglada en el arnés, pero conviene
saberla: si el lead se busca DESPUÉS de cambiar de rol, la RLS se lo esconde
al usuario sin perfil, la variable queda NULL y la prueba **se saltea sola**
diciendo "no hay leads" — con la tabla llena. Por eso la búsqueda va antes del
cambio de rol, y los resultados se juntan en variables para escribirlos recién
al volver a `postgres`.

---

# Mejoras futuras

## El tracker todavía deduce la presentación de la etapa

En [index.html:5419] el recorrido del lead arma el paso "Presentacion de
oferta" mirando `rules.presentaciones`, o sea la **etapa** de GHL. El propio
código lo marca como `approx:true` y lo explica: *"Como se infiere: Stage
actual de presentacion"*.

Eso quedó viejo. Desde el 017 hay un dato de verdad: `leads.presento_en`, que
dice en qué reunión se presentó la oferta (1, 2, 3…). El portal ya lo escribe.

**Qué falta:** que el tracker lea esa columna en vez de deducirla, y que el
paso deje de ser `approx`. Donde hoy dice "se infiere del stage" debería decir
"lo marcó el cliente el día tal, en la 1ª reunión".

**Por qué importa más de lo que parece:** deducirlo de la etapa da por sentado
que la oferta se presenta después de la segunda reunión, porque ése es el
orden del embudo. Quien presentó en la primera y quien presentó en la segunda
caen en la misma etapa y no se distinguen. Es justamente el número que hace
falta para saber si conviene ofertar antes.

**Cuidado al hacerlo:** `presento_en` va a estar en NULL para casi todos los
leads por un tiempo —sólo se llena cuando alguien lo marca en el portal—, así
que hay que mostrar las dos cosas y no reemplazar una por la otra de golpe: el
dato real cuando está, y la inferencia vieja marcada como tal cuando no.


Cosas que hoy están bien resueltas y que van a poder mejorarse cuando cambie
otra cosa. **No son pendientes**: hacerlas ahora rompería algo.

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
