# Pruebas

**No son migraciones.** No cambian nada: cada prueba vive en su propia
transacción y termina en `rollback`. Por eso viven acá y no en
`migraciones/`, que es lo que reconstruye la base desde cero.

Se corren a mano, después de aplicar la migración del mismo número, y se
miran con los ojos: lo que importa es que las filas digan lo que tienen que
decir, no que el SQL no falle.
