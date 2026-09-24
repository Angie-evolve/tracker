# Cosas muertas

Lo que encontramos que ya no lo usa nadie, anotado para no volver a
descubrirlo de cero. **Nada de acá se borra sin decidirlo aparte**: la zona
COMPARTIDA solo suma, y un `drop` no tiene vuelta atrás.

## `presento_en` y `oferta_presentada` — columnas, candidatas a borrar

Las dos guardaban lo mismo que hoy guarda `oferta_estado`, y las dos se
quedaron cortas. Es el mismo dato intentado tres veces en dos días, y lo
anoto con esa crudeza para que se vea por qué:

| columna | migración | qué guardaba | por qué no alcanzó |
|---|---|---|---|
| `presento_en` | 017 | número de reunión (1, 2, 3…) | un número no puede decir **No**, que es el estado que más se usa |
| `oferta_presentada` | 019 | boolean nulable | tres estados, y hacen falta cuatro: faltaba **Programada** |
| `oferta_estado` | 021 | texto con check | los cuatro. El quinto es un check más, no una columna más |

Cuánto hay adentro, medido el 2026-09-21: `presento_en` **vacía en los 287
leads**; `oferta_presentada` con **2 filas**, las dos en `false`, y las dos
copiadas a `oferta_estado` por el 021.

Mientras `oferta_presentada` exista, **las dos funciones escriben las dos
columnas** —`lead_oferta` y `lead_oferta_estado`— así que no se pueden
contradecir. Se comprobó: 0 contradicciones en 287 leads.

**Para borrarlas hacen falta dos cosas:** tu permiso, y comprobar antes que
nadie las lea. Hoy no las lee nadie: `git grep` no las encuentra fuera de
`supabase/` y del portal, que ya usa la nueva.

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
| 2 — reordenar no rompe | que mover una etapa de lugar no cambie a dónde van los leads | **2026-09-20** ✅ |
| 3 — usuario sin perfil | que quien no tiene perfil no pueda nada | **2026-09-20** ✅ |
| 4 — etapas de otro cliente | que un cliente no lea las etapas de otro | **2026-09-20** ✅ |
| 5 — borrar una etapa | que los leads se muden en vez de quedar huérfanos | **2026-09-20** ✅ |
| 6 — estructura y permisos | que `anon` no ejecute ninguna función | **2026-09-20** ⚠️ |

**La 1** se corrió al aplicar el `011`: las 14 de siempre más 3 del `007`
—"Asistió a llamada", "Oferta presentada" y "No asisitó a llamada" con el
typo—. Los 17 en ✅.

**La 2** es la que importaba después del `011`, porque ese cambio agregó
`asistio1` y reordenó todo. Dio vuelta el orden visual entero y las 8
traducciones siguieron dando igual. `orden` y `prioridad` siguen sin pisarse.

**La 5** movió **10** leads, no 1. El archivo esperaba 1 porque se escribió con
`leads` vacía; hoy se mudan todos los que estén en `reunion2` —9 reales más el
de prueba— y eso es exactamente lo que la función tiene que hacer. Lo que se
mira es la etapa del lead de prueba, que quedó en `reunion1`. La expectativa
vieja ya está corregida en el archivo.

**La 6 quedó con ⚠️ y conviene leer por qué.** Sus tres partes:

- **6.a** — la plantilla tiene 12 etapas, todas activas. `asistio1` es la única
  sin patrones de GHL, a propósito (ver el `011`).
- **6.c** — 54 variantes de stage sobre 2089 oportunidades, **0 sin traducir**.
  Antes del `007` eran 124 sin traducir sobre 1822.
- **6.b** — acá está el ⚠️. Se corrió mirando **todas** las funciones de
  `public`, no la lista escrita a mano del archivo, y aparecieron dos que
  `anon` podía ejecutar: `mi_rol()` y `mi_cliente()`. Ninguna era explotable
  —devuelven NULL sin sesión— pero rompían la regla. **Se cerraron en el
  `018`.**

### Lo que quedó abierto de la 6.b

Después del `018`, `anon` todavía puede ejecutar estas siete:

| función | devuelve | ¿se puede llamar? |
|---|---|---|
| `es_del_equipo` | boolean | **sí** |
| `rls_auto_enable` | event_trigger | no |
| `avisar_a_github` | trigger | no |
| `estaticos_tope` | trigger | no |
| `ia_jobs_limpiar` | trigger | no |
| `perfil_nuevo` | trigger | no |
| `tocar_actualizado` | trigger | no |

Las seis de trigger no se pueden invocar directo: Postgres no lo permite. Es el
mismo caso que tenía `etapa_sin_leads` antes del `007`, que se cerró igual por
la regla.

**La única llamable de verdad es `es_del_equipo`.** No está revisada todavía:
hay que ver qué devuelve sin sesión antes de decidir si se cierra.

La consulta que las encuentra mira todas las funciones de `public`, así que si
mañana aparece otra abierta, la detecta sola:

```sql
select p.proname
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.prokind = 'f'
   and has_function_privilege('anon', p.oid, 'execute');
```

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

Eso quedó viejo. Desde el 021 hay un dato de verdad: `leads.oferta_estado`,
con cuatro valores —pendiente, programada, sí, no— que el cliente marca en el
portal. En qué reunión pasó sale de cruzarlo con la etapa del lead.

*(Esta entrada decía `presento_en` y después `oferta_presentada`. Las dos se
quedaron cortas; ver "Cosas muertas".)*

**Qué falta:** que el tracker lea esa columna en vez de deducirla, y que el
paso deje de ser `approx`. Donde hoy dice "se infiere del stage" debería decir
"lo marcó el cliente el día tal, en la 1ª reunión".

**Por qué importa más de lo que parece:** deducirlo de la etapa da por sentado
que la oferta se presenta después de la segunda reunión, porque ése es el
orden del embudo. Quien presentó en la primera y quien presentó en la segunda
caen en la misma etapa y no se distinguen. Es justamente el número que hace
falta para saber si conviene ofertar antes.

**Cuidado al hacerlo:** `oferta_estado` va a estar en NULL para casi todos los
leads por un tiempo —sólo se llena cuando alguien lo marca en el portal—, así
que hay que mostrar las dos cosas y no reemplazar una por la otra de golpe: el
dato real cuando está, y la inferencia vieja marcada como tal cuando no.


Cosas que hoy están bien resueltas y que van a poder mejorarse cuando cambie
otra cosa. **No son pendientes**: hacerlas ahora rompería algo.

## "Presentación programada" de GHL cae en la etapa equivocada

El 021 archivó la etapa `presentacion`, porque lo que decía —que la oferta
está agendada— ahora lo dice la columna "Oferta". `etapa_desde_ghl` sólo mira
etapas activas, así que sus patrones —`presentaci`, `propuesta`, `presentad`,
`oferta`— dejaron de existir.

El problema es dónde cae ahora. Medido el 2026-09-21:

| lo que manda GHL | a dónde va |
|---|---|
| `Propuesta enviada` | NULL, sin traducir |
| `Presentación programada` | **`reunion1`** |

`reunion1` tiene el patrón `programad`, y "Presentación programada" termina en
"programada". Así que un lead con la oferta agendada quedaría marcado como
"Primera reunión programada": **dos pasos más atrás de donde está**.

**Hoy no mueve nada.** No hay ninguna sincronización que llame a esa función:
sin `pg_cron`, sin triggers en `leads`, sin workflow en `.github`, y el último
lead entró a mano el 19/09. Es una trampa para el día que se escriba, no un
error en curso.

**Qué habría que hacer ese día:** que la sincronización lea la etapa de GHL y
escriba `oferta_estado = 'programada'`, en vez de buscarle una etapa. Y si
además se quiere arreglar la traducción, sacarle `programad` a `reunion1` es
su propia migración, con la prueba 1 del 006 al lado: hoy ese patrón atrapa
leads que caen bien.

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

## "No pude sincronizar con GHL: Tardó demasiado" en Albet

Apareció el 22/09/2026 mirando Albet desde el celular. **Sin diagnosticar
todavía**: acá queda anotado para no perderlo.

El cartel sale de `syncGhl`, que escribe el motivo en `c.ghl._syncError`. El
texto "Tardó demasiado" es nuestro, no de GHL: lo pone el proxy cuando la
consulta se pasa del tiempo que se le da.

Lo que **no** se sabe y hay que medir antes de tocar nada:

- si es siempre en Albet o fue una vez,
- si tarda la consulta a GHL o el Apps Script, que además tiene cuota diaria,
- cuántas oportunidades tiene esa subcuenta: la traída va paginada y una
  cuenta grande puede pasarse del tiempo sin que haya nada roto.

Es distinto de los 401 de Razor Tech, que son token vencido. Este es tiempo,
no permiso.

# Plan de arquitectura y seguridad

Diagnóstico medido el 2026-09-23 sobre el commit `da66b01` y sobre la base de
producción. Nada de lo que sigue está estimado. La propuesta completa, con las
cinco fases y el checklist, está en el artifact
`https://claude.ai/artifact/1M1tKZdFbPQuoXnYofU8su`; acá queda lo accionable,
para que viva en el repo y no en un chat.

## Lo que se midió

| Qué | Cuánto |
|---|---|
| JavaScript en un solo `<script>` | 64.150 líneas, 3,49 M caracteres |
| Funciones en el ámbito global | 2.507 (mediana 13 líneas; 95 pasan 100, 12 pasan 300) |
| Tests, build, linter, tipos | 0 de cada uno |
| Accesos directos a `DB.` / `S.` | 1.039 / 886 |
| `save()` sueltos / `fetch()` crudos | 517 / 150 |
| `onclick=` inline / `innerHTML` / `esc()` | 1.325 / 491 / 1.732 |
| Historial de git | 1.590 commits, **limpio**: dos pases, ningún secreto |

Las cinco funciones más largas son las que más se tocan: `renderTab` (784),
`_lpPaginaHtml` (703), `renderVentasTab` (668), `p360Html` (639) y
`showTickets` (482).

**El dato que ordena todo lo demás:** de seis fallas encontradas en un día de
trabajo, **cinco fueron de lógica** —el badge LIVE, "próximos a lanzar", un
interruptor que mandaba lo contrario de lo que mostraba, el buscador incompleto
y 54 llamadas invisibles—. Ninguna la habría atajado un hosting distinto.
Todas las habría atajado un test.

## Fase 0 — cerrojo. No toca la app

- [ ] **Rotar cinco tokens de GHL.** Quedaron escritos completos en un chat el
      2026-09-23, al imprimir sin enmascarar el campo `ghl` de varias fichas.
      No se listan acá los nombres a propósito: este repo es público y el
      CLAUDE.md dice que los nombres de clientes no entran a git. Para
      identificarlos:
      `select datos->>'name' from clientes where datos->'ghl'->>'token' ilike 'pit-%';`
      y cruzar con los cinco que aparecen en la conversación de esa fecha.
- [ ] **Prender secret scanning y push protection.** Hoy están apagados, y son
      gratis en repos públicos. Bloquean el push si alguna vez se pega una clave.
- [ ] **Proteger `main`.** Hoy no tiene protección: todo push va directo a
      producción, sin diff previo ni forma de revisar.
- [ ] **Versionar tres Edge Functions.** `GHL`, `Google-calendar` y
      `segumiento-agendas-de-equipo-c-cliente` sólo existen desplegadas. Si se
      borran, se perdieron. Se bajan con
      `npx supabase functions download <slug>`.
- [ ] **Alargar tres secretos.** `evold-gcal-fn-sec`, `evold-ghl-fn-sec` y
      `evold-hf-fn-sec` tienen **6 caracteres**. Es corto para lo que protegen.
      Se hace al rotarlos, no aparte.

## Fase 1 — la red de seguridad, antes que cualquier refactor

Herramientas: esbuild, Vitest, Biome, GitHub Actions. Todas gratis y estándar.

- [ ] `package.json` y toolchain, **sin cambiar cómo se sirve la app**.
- [ ] Extraer a `src/dominio/` las funciones puras que deciden plata y estado.
- [ ] ~25 tests sobre `_lanzaCuenta`, `adsDot`, `_p360DiasCampanas`,
      `_fathomMatchClient` y `_metaObjetivoResultado`. Se escriben **contra el
      código roto primero**: si no fallan, no prueban nada.
- [ ] CI que corra tests y lint en cada push, obligatorio para mergear.
- [ ] Chequeo de versión en la app. Hoy GitHub Pages cachea 10 minutos y ya
      pasó dos veces que se mirara una versión sin los cambios publicados.

## Fase 2 — cortar el archivo, por dominio

⚠️ **Los 1.325 `onclick=` inline exigen que las funciones sigan siendo
globales.** Cualquier modularización tiene que exponer explícitamente en
`window` lo que el HTML llama, o la app deja de responder a los clics. Ese
puente es lo que permite cortar sin un big bang, y es lo primero que hay que
construir.

Orden sugerido: `fathom` → `meta` → `ghl` → `panel360` → `ventas`. Después,
una capa de datos para que `DB` y `save()` dejen de tocarse desde 1.500
lugares, y un esquema del cliente documentado y validado al guardar —hoy
`contacto`, `contactoEmail` y `contactEmail` conviven, y por eso el buscador
del panel no encontraba por nombre de contacto.

## Fase 3 — secretos y hosting, en ese orden

- [ ] **Sacar los tokens de las filas.** 12 de GHL y 13 de Meta viven en
      `clientes.datos`, y la policy `cartera_alcanza` deja que cualquier cuenta
      de agencia que alcance ese cliente los lea por la API con su propia
      sesión. El patrón correcto ya existe y funciona: `fathom_keys`, con RLS y
      cero policies, accesible sólo desde una Edge Function.
- [ ] **Recortar la policy de `config`.** Nueve campos sensibles y la condición
      es `mi_rol() = 'agencia'`, sin recorte por cartera: cualquier cuenta de
      agencia los lee todos.
- [ ] **Hosting con dominio propio y headers de caché**, y recién ahí el repo a
      privado. Hoy es público **obligado**: es la condición de GitHub Pages
      gratis.
- [ ] Antes de cortar Pages: agregar las URLs nuevas a Supabase → Auth →
      Redirect URLs, o los logins se rompen.
- [ ] Al pasar el repo a privado, **revisar el cron de
      `.github/workflows/editor-ia-worker.yml`**. Corre cada 10 minutos y su
      propio comentario dice que los minutos son gratis porque el repo es
      público. En privado empieza a consumir cuota.

## Lo que queda pendiente de decidir

- Alcance de la Fase 1: 25 tests sobre lo que ya falló (2–3 días) o cobertura
  amplia desde el arranque (dos semanas).
- Hosting: Cloudflare Pages permite uso comercial en el plan gratis; Vercel lo
  prohíbe en el suyo y cobra Pro.
- Ejecución: secuencial, o agentes en paralelo por dominio. En paralelo conviene
  **recién con los tests andando**; antes, nadie sabría quién rompió qué.

## Fuera del plan, anotado el 2026-09-23

- **Joela y Angie figuran con Fathom conectado y no tienen key guardada.** Sus
  webhooks existen, así que las llamadas nuevas entran; lo que no funciona es la
  búsqueda hacia atrás. Se arregla reconectando desde Usuarios. No se sabe por
  qué desaparecieron esas dos filas: las tres se conectaron el mismo día y la
  tercera sobrevivió.
- **La lista de "abre leads" nunca se había guardado.** Caía siempre en el
  default del código —una sola persona—, así que las llamadas de todos los demás
  se guardaban sin abrir tarjeta. Ya es editable desde Usuarios; falta marcarla.

## `ruta[].pasos` — datos vivos sin pantalla donde verlos

El 2026-09-24 se saco el editor de pasos de "Etapas del cliente", porque las
tareas de cada etapa pasaron a la plantilla nueva —que es por cliente y se
copia— y tener las dos pantallas era tener dos listas distintas para la misma
etapa: Onboarding decia cinco pasos en una y dos tareas en la otra.

**El dato NO se borro, y no es olvido.** Quedan 12 pasos cargados: 4 en Alta
Cliente, 5 en Onboarding y 3 en Estrategia. `_citaEtapaPara` los sigue leyendo:
busca los que dicen "agendar" para decidir de que etapa es una reunion que no
reconocio ni por titulo ni por calendario. Vaciarlos romperia ese
reconocimiento sin que nadie lo haya pedido.

⚠️  **Entonces hoy hay datos que cambian el comportamiento y no se pueden ver
    ni editar desde ninguna pantalla.** Es deuda, y esta es la unica anotacion
    que existe de eso. Las dos salidas, cuando se decida:

- Mover esa heuristica a la plantilla nueva. Requiere que las tareas digan
  "agendar" algo, y las 25 actuales no lo dicen: seria un cambio de
  comportamiento, no una mudanza.
- O devolverle una pantalla a `pasos`, aceptando que es un dato de otra cosa
  -reconocer reuniones- y no una lista de tareas.

Aparte quedaron 34 tildes viejas en 6 clientes (`c.rutaPasos`) que apuntan a
etapas que ya no existen —"Sprint de lanzamiento", "Estrategia 1",
"Estrategia 2"—, nombres de una version anterior de la ruta. Estan muertas: no
se muestran en ningun lado. Se pueden borrar sin consecuencia el dia que se
haga limpieza de `clientes.datos`.
