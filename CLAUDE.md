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
- Las 12 tablas tienen RLS prendida y `anon` sin GRANT. **Ese estado no se
  toca**, y no se "desactiva un momento" para destrabar nada. Si algo falla
  por permisos, avisame: el problema es otro.
- `fathom_keys` y `gcal_cuentas` tienen RLS y cero policies **a propósito**:
  guardan credenciales. No les agregues policies.
- Estoy armando un portal para clientes. **No se crea ningún usuario con rol
  cliente** hasta que las policies de `clientes`, `config` y `llamadas_fathom`
  exijan rol de agencia.

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
