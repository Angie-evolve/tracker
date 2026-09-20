-- ============================================================================
-- 009_atribucion.sql
--
-- QUE ARREGLA
-- `origen` quedo mezclando tres cosas distintas. El mapeo del 008 decia
-- `origen <- op->>'source'`, pero en GHL `source` NO es un texto: es un objeto
-- con diez claves. Asi cargado, la tarjeta del portal mostraba el JSON entero
-- -600 caracteres con fbclid incluido- y de paso empujaba el boton de WhatsApp
-- fuera de la pantalla.
--
-- El primer arreglo fue un coalesce: campania, si no fuente, si no anuncio. Da
-- la misma cobertura (99 de 267) pero mezcla: un lead dice "Embudo B" y otro
-- dice "AD B2C", y el cliente no tiene como saber cual esta viendo.
--
-- EL TRACKER YA TENIA ESTO RESUELTO, y con tres campos separados
-- (`ghlAtribucion`, en index.html):
--     fuenteOf   -> de donde vino: "Landing (Meta)", "Landing", "Meta"...
--     campaignOf -> la campania
--     adOf       -> el anuncio
-- Se copian esas tres, en tres columnas, en vez de aplastarlas en una.
--
-- ⚠️  `origen` NO se borra -la zona COMPARTIDA solo suma- pero deja de usarse.
--     El portal lo busca en la cadena ['origen','source','fuente','utm_source'],
--     asi que dejandolo vacio cae solo en `fuente` sin tocar el portal.
--
-- TODO ES ADITIVO. Dos columnas nuevas. `campania` ya existia desde el 005.
-- ============================================================================

begin;

alter table public.leads
  add column if not exists fuente  text;   -- de donde vino (fuenteOf)

alter table public.leads
  add column if not exists anuncio text;   -- que anuncio lo trajo (adOf)

commit;


-- ════════════════════════════════════════════════════════════════════════════
-- COMPROBAR
-- ════════════════════════════════════════════════════════════════════════════

select column_name, data_type
  from information_schema.columns
 where table_schema = 'public' and table_name = 'leads'
   and column_name in ('fuente','campania','anuncio','origen')
 order by column_name;

-- ⚠️  Cuatro filas, las cuatro `text`.


-- ════════════════════════════════════════════════════════════════════════════
-- EL MAPEO — para cuando el sync llene `leads`
-- ════════════════════════════════════════════════════════════════════════════
--
--   fuente    <- la logica de fuenteOf, que mira el referrer ADEMAS de los utm:
--                  referrer http y utmSource meta/facebook/instagram -> 'Landing (Meta)'
--                  referrer http a secas                             -> 'Landing'
--                  utmSource meta/fb/ig, o referrer de fb/ig          -> 'Meta'
--                  si no, el utmSource crudo
--                  si no, formAnswers['Lead Source'] o ['source']
--   campania  <- op->'source'->>'utmCampaign'
--   anuncio   <- formAnswers['utm_ad'], si no source.utmAd, si no source.utmContent
--   origen    <- NADA. Queda vacia a proposito.
--
-- ⚠️  OJO CON adOf: en el tracker pasa por `resolveAdLabel`, que convierte los
--     IDs de Meta en el nombre real del anuncio cruzando contra el arbol
--     campanas->adsets->ads. Ese arbol vive en `clientes.datos`, en
--     conversionLines[].metaCampaigns, y lo sincroniza el NAVEGADOR. Un sync
--     que corra del lado del servidor no lo tiene a mano: va a guardar el ID
--     crudo donde el tracker muestra un nombre. Hay que decidirlo antes de
--     escribir el sync, no despues.
--
-- ⚠️  `paisOf` no se copia: sobre los 267 de Zentenio da 0 de 267, porque esos
--     leads no traen timezone ni en `geo` ni en `formAnswers`. La funcion esta
--     bien; el dato no esta. Si algun dia llega, es otra columna.
--
-- ════════════════════════════════════════════════════════════════════════════
-- VOLVER ATRAS
-- ════════════════════════════════════════════════════════════════════════════
/*
begin;
  alter table public.leads drop column if exists anuncio;
  alter table public.leads drop column if exists fuente;
commit;
*/
-- ============================================================================
