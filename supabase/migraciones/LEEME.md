# Migraciones

Cada cambio de la base va en un archivo numerado de esta carpeta, aunque se
corra a mano desde el SQL Editor de Supabase.

Adentro de cada archivo, escrito: **como se vuelve atras**. Sin eso, un cambio
que sale mal en la zona COMPARTIDA deja al tracker y al portal rotos a la vez,
y hay que reconstruir el rollback desde cero con la app caida.

El SQL viejo del editor vive todavia en `editor-ia/*.sql`, de antes de que
existiera esta carpeta.
