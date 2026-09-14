# Invitar colaboradoras desde la app

Tres pasos, una sola vez. Los tres son en tu cuenta: la clave que hace falta
para crear cuentas abre la base entera, asi que no puede estar en la app.

## 1. Apagar el registro publico

**Antes que nada.** Hoy tu proyecto tiene el alta abierta: cualquiera puede
crearse una cuenta sin invitacion. No ve tus datos (el RLS los tapa), pero si
puede encolar trabajos de video que procesa tu worker de GitHub Actions.

Supabase -> Authentication -> Sign In / Providers -> Email -> desactivar
**Allow new users to sign up**.

No rompe nada: la app nunca llama a signup, y las invitaciones van por la via
de administrador, que no depende de ese permiso.

## 2. Exigir contrasenas seguras

Supabase -> Authentication -> **Password settings**:

- largo minimo: 10 o 12
- requisitos de caracteres: minusculas + mayusculas + numeros + simbolos
- **Leaked password protection**: rechaza contrasenas que ya aparecieron en
  filtraciones conocidas. Es la que mas sirve. Puede pedir plan pago.

Esto se aplica en el servidor, asi que vale para todas: invitadas nuevas y
cambios de contrasena de las que ya estan. Ninguna validacion en el navegador
sirve para esto, porque el endpoint se puede llamar directo salteandola.

## 3. Deployar la funcion

Desde la carpeta del repo:

    supabase functions deploy equipo --project-ref onnysveksgxtmspxgbow

No hace falta cargar ningun secret: `SUPABASE_URL` y
`SUPABASE_SERVICE_ROLE_KEY` ya vienen puestas en toda edge function.

Si no tenes el CLI, tambien se puede pegar el contenido de `index.ts` en
Supabase -> Edge Functions -> Deploy a new function, con el nombre **equipo**.

## Como se usa

En la app: los tres puntos de arriba a la derecha -> **Quien tiene acceso**.

- **Invitar** manda el mail y suma a la persona a `equipo_video`, que es la
  lista que el RLS mira para decidir quien ve los datos del equipo. La persona
  elige su propia contrasena desde el mail.
- **Sacar** hace las dos cosas que hacen falta: la borra de la lista y le
  banea la cuenta. Solo lo primero no alcanza, porque la cuenta seguiria viva
  y podria seguir encolando trabajos.
- Nadie puede sacarse a si misma, y solo quien ya esta en el equipo puede
  invitar: la funcion lo verifica con el token, no con lo que diga el pedido.

Sacar no borra nada de lo que la persona hizo. Para devolverle el acceso,
invitala de nuevo: si ya tiene cuenta, le levanta el ban y no le manda mail.
