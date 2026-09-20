# Tracker — cómo trabajar acá

## Lo que es público
El repo y el sitio son **públicos** (GitHub Pages). Nada que no pueda leer
cualquiera entra a un archivo versionado. Ninguna credencial, nunca.

Los tokens no pasan por el chat. Las claves viven en secretos de Supabase o
en el Llavero de macOS. Si necesitás una, pedime que la cargue yo.

## La app
Un solo `index.html`, JS de navegador, sin build ni framework.
**Nunca lo reescribas entero: solo el bloque que te pida.**

## Base de datos
- Leer: `sbq`, libre.
- Escribir: `sbw` / `sbsql`, **solo avisándome antes**.
- Las 13 tablas tienen RLS prendida. `anon` no puede leer ninguna; lo único
  que puede es INSERT en `lp_eventos`, que es el tracking de las landings.
  **Ese estado no se toca**, y no se "desactiva un momento" para destrabar
  nada. Si algo falla por permisos, avisame: el problema es otro.
- `fathom_keys` y `gcal_cuentas` tienen RLS y cero policies **a propósito**:
  guardan credenciales. No les agregues policies.
- Las policies de `clientes`, `config` y `llamadas_fathom` exigen **rol
  agencia**. Toda cuenta nueva nace como `cliente` sin acceso: para darle
  acceso a alguien hay que agregarle el perfil.
- `perfiles` tiene **dos candados**: sin grant de escritura para
  `authenticated`, y sin policy de escritura. Así nadie puede ascenderse a
  `agencia` desde la app. El día que exista la pantalla de Personas hay que
  agregar **los dos**, en el mismo commit que la pantalla.

## Verificar antes de decir que está hecho
1. Extraer el `<script>` y `node --check`.
2. Diff de la lista de funciones contra `git show HEAD:index.html`.
3. Probar en `http://localhost:8731` entrando con "Entrar sin sincronizar".
4. Recién ahí commit y push.

Los scripts de Python con `assert` que falla **no escriben nada**: si el ancla
no matchea, corregila y volvé a correr. Y al insertar código, revisá que no
te comiste la función de al lado.

## Este archivo
Cuando cambiemos algo que este archivo describe, **se actualiza en el mismo
commit**. Un CLAUDE.md desactualizado miente, y se le cree.

## Cosas que ya me equivoqué acá
- **Agendada ≠ hecha.** Que exista una cita no prueba que la reunión ocurrió.
  Nunca desbloquees un cobro ni muevas una reunión por una cita *adivinada*.
- **No afirmes un diagnóstico sin medirlo.** Si no lo podés medir, decí que no
  lo podés medir y poné el dato en pantalla para que lo vea yo.
- **Caché.** GitHub Pages cachea 10 min. Para probar en vivo, URL con `?v=`.
- Los comentarios del código explican **por qué**, no qué hace la línea.
  En español, como el resto del archivo.

## Las tres zonas

Cada archivo de este repo pertenece a una zona. **La zona se deduce de la ruta,
no del criterio.**

| Ruta | Zona |
|---|---|
| `index.html`, `editor-ia/` | **LIBRE** |
| `portal/` | **CLIENTE** |
| `supabase/`, y cualquier SQL | **COMPARTIDA** |

Reglas que valen para las tres:

- **Al empezar cualquier tarea, decime en qué zona vas a trabajar, antes de
  tocar nada.** Una línea alcanza.
- **Si no podés ubicar un archivo, tratalo como COMPARTIDA y preguntame.**
- **Un cambio no puede tocar dos zonas en el mismo commit.** Si la tarea
  necesita las dos, son dos commits, y el de la zona COMPARTIDA va primero.

### Zona LIBRE — el tracker de la agencia

`index.html`, `editor-ia/`. Lo usamos Martín y Angie. Si se rompe, nos rompe a
nosotros y lo arreglamos mañana.

- Editá directo. Mostrame el diff como siempre, pero no hace falta que pidas
  permiso antes de cada cambio.
- Igual vale la regla de siempre: nunca reescribas `index.html` entero.

### Zona CLIENTE — la pantalla del portal

`portal/`. La ven clientes. Si se rompe, lo ve gente de afuera de la agencia.

- Antes de editar: decime en una línea **qué va a ver distinto el cliente**.
- Después de editar: probalo y contame **cómo** lo comprobaste.
- Nunca publiques sin que yo te lo diga.
- **Ninguna clave ni token acá, de ningún tipo.** El portal no habla con
  Anthropic, ni con Meta, ni con GHL. Solo lee y escribe filas de Supabase.
- Todo lo que agregues tiene que funcionar en un teléfono.

### Zona COMPARTIDA — base de datos y funciones

`supabase/`, y cualquier SQL en cualquier lado. Afecta al tracker y al portal a
la vez, y el cliente se entera antes que yo.

- **Solo cambios que suman:** agregar tabla, columna, policy o función.
  **Nada de `drop`, `rename`, ni cambiar el tipo de una columna que ya existe.**
  Si te parece que hay que borrar algo, proponémelo y esperá; no lo hagas.
- Cada cambio va en un archivo numerado en `supabase/migraciones/`, aunque lo
  corras a mano. En el mismo archivo, escribí **cómo se vuelve atrás**.
- Después de aplicar: comprobá que **el tracker Y el portal** siguen andando, y
  decime cómo lo comprobaste.

### Estructura

```
/
├── CLAUDE.md
├── index.html              ← LIBRE      el tracker
├── editor-ia/              ← LIBRE
├── portal/                 ← CLIENTE    la pantalla de leads
└── supabase/
    ├── migraciones/        ← COMPARTIDA el SQL, numerado
    └── functions/          ← COMPARTIDA
```
