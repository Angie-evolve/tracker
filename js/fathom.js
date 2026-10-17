/* ── Llamadas de Fathom ─────────────────────────────────────────────────────────────
   Separado de index.html el 17/10/2026 (paso 2 del plan del 23/09: partir el
   archivo de a una parte por vez, sin reescribir nada). Es el mismo codigo,
   en el mismo orden, con las mismas funciones globales: los onclick="" del
   HTML las siguen encontrando.

   ⚠️  SE CARGA ANTES QUE EL SCRIPT PRINCIPAL. Lo que el principal ejecuta al
   arrancar (timers, listeners) usa estas funciones, asi que tienen que
   existir primero. Por lo mismo, aca no puede haber nada que al CARGAR use
   algo del principal: solo declaraciones. */
// Quien prospecta. Sus llamadas con alguien de afuera abren tarjeta; las de
// cualquier otro, no, o cada daily interna crearia un prospecto.
/* Quien prospecta. Solo las llamadas de esta gente abren tarjeta de lead:
   una reunion de delivery con el equipo del cliente no es un prospecto nuevo.

   ⚠️  ESTA LISTA DECIDE QUE LEADS EXISTEN, Y HASTA AHORA NO SE PODIA EDITAR.
   `DB.comerciales` no se escribia en ningun lado, asi que siempre caia en el
   default -Joela sola- y las llamadas de cualquier otro morian en el limbo:
   Martin tenia 54 grabadas, entre ellas "David y Martin <> Presentacion de
   Gameplan", y ninguna abrio tarjeta. Ahora se elige en Usuarios.

   ⚠️  `[]` NO ES LO MISMO QUE NO HABER ELEGIDO NUNCA. Antes la lista vacia
   caia en el default igual, asi que sacar a la ultima persona la volvia a
   poner sola. Solo se cae al default cuando la clave no existe todavia. */
function _fathomComerciales(){
  var v=DB.comerciales;
  if(!Array.isArray(v)) return ['joela@theflowingcode.com'];
  return v.map(function(x){ return String(x).trim().toLowerCase(); }).filter(Boolean);
}
// El equipo: las personas cargadas mas los dominios corporativos que usen.
// Sirve para saber quien es "de afuera" en una reunion.
function _fathomEquipo(){
  var mails={}, doms={};
  var gen=/^(gmail|hotmail|outlook|yahoo|icloud|live|proton(mail)?)\./i;
  var grabaron=[];
  (DB.clients||[]).forEach(function(c){
    (c.fathomCalls||[]).forEach(function(l){
      if(l&&l.grabo) grabaron.push({email:l.grabo});
    });
  });
  (DB.personas||[]).concat(_fathomComerciales().map(function(e){return {email:e};}))
    .concat(DB.equipo||[]).concat(grabaron)
    .forEach(function(pn){
      var m=String((pn&&pn.email)||'').trim().toLowerCase();
      if(!m) return;
      mails[m]=1;
      var d=m.split('@')[1]||'';
      if(d && !gen.test(d+'.')) doms[d]=1;
    });
  return {mails:mails, doms:doms};
}
// Los invitados que no son del equipo. Si no hay ninguno la reunion es interna
// y no hay prospecto que crear.
function _fathomDeAfuera(fila){
  var eq=_fathomEquipo();
  return _fathomMails(fila).filter(function(m){
    return !eq.mails[m] && !eq.doms[m.split('@')[1]||''];
  });
}
/* Las cuentas de Fathom que hay guardadas, preguntandole al servidor.
   ⚠️  NO ALCANZA CON `p.fathomKeyGuardada`. Esa marca se escribe cuando
   alguien conecta y dice lo que PASO ese dia, no lo que hay hoy: si la fila
   despues desaparece, la pantalla se queda en verde para siempre. Angie y
   Joela figuraban "Fathom conectado" desde el 02/09 con la tabla sin una sola
   fila suya, y la busqueda hacia atras no las incluia sin que nada lo dijera.
   La tabla no se puede leer desde el navegador —RLS sin policies, guarda
   credenciales—, asi que va por la funcion, que devuelve todo menos la key. */
var _fathomCuentas=null;
async function fathomCuentasCargar(callado){
  var url=(localStorage.getItem('evold-fathom-hook')||'').trim();
  var sec=(localStorage.getItem('evold-fathom-hook-sec')||'').trim();
  if(!url||!sec){ _fathomCuentas={error:'sin webhook configurado'}; return _fathomCuentas; }
  try{
    var r=await fetch(url+(url.indexOf('?')>=0?'&':'?')+'s='+encodeURIComponent(sec)+'&accion=keys',
      {method:'POST', headers:{'Content-Type':'application/json'}, body:'{}'});
    var d=null; try{ d=await r.json(); }catch(e){}
    if(!r.ok||!d||!d.ok){ _fathomCuentas={error:(d&&d.error)||('HTTP '+r.status)}; }
    else _fathomCuentas={lista:(d.cuentas||[])};
  }catch(e){ _fathomCuentas={error:String(e&&e.message||e)}; }
  if(!callado && typeof personasModal==='function' && document.getElementById('pf-lista-marca')){
    personasModal();
  }
  return _fathomCuentas;
}
// Las de una persona. Sin respuesta todavia devuelve null, que no es lo mismo
// que "ninguna": una cosa es no saber y la otra es saber que no hay.
function fathomCuentasDe(mail){
  if(!_fathomCuentas||_fathomCuentas.error) return null;
  var k=String(mail||'').toLowerCase();
  return (_fathomCuentas.lista||[]).filter(function(x){
    return String(x.persona||'').toLowerCase()===k; });
}
/* Las cuentas que grabaron reuniones del equipo y NO tienen la key guardada.
   ⚠️  ES LA CAUSA MAS COMUN DE QUE UNA REUNION "NO APAREZCA" AL BUSCAR HACIA
       ATRAS, y no se ve por ningun lado: el webhook y la key son DOS COSAS
       DISTINTAS. Con el webhook puesto, lo que pasa de ahora en mas entra
       solo; pero para ir a buscar lo viejo hay que preguntarle a la cuenta, y
       eso necesita la key. Si no esta, esa cuenta es invisible hacia atras.
       Medido: joela@theflowingcode.com grabo 78 reuniones y no tiene key;
       mdlangierh@gmail.com, 56; melany@theflowingcode.com, 14. La busqueda
       solo alcanzaba a dos cuentas de cinco y el aviso decia "no aparece
       ninguna reunion", que manda a buscar el problema en el mail del cliente.
   Se deduce de quien grabo lo que YA esta cargado: es lo unico que el
   navegador sabe sin volver a preguntarle a Fathom. */
function _fathomCuentasSinKey(){
  // Sin saber quien esta conectado no se afirma nada: devolver una lista
  // adivinada seria peor que no decir nada.
  if(!_fathomCuentas || _fathomCuentas.error) return [];
  var conectadas={};
  (_fathomCuentas.lista||[]).forEach(function(k){
    conectadas[String(k.email||'').toLowerCase()]=1; });
  var graban={};
  (DB.clients||[]).forEach(function(c){
    (c.fathomCalls||[]).forEach(function(l){
      var g=String(l.grabo||'').trim().toLowerCase();
      if(g.indexOf('@')>0 && !conectadas[g]) graban[g]=(graban[g]||0)+1;
    });
  });
  return Object.keys(graban)
    .sort(function(a,b){ return graban[b]-graban[a]; })
    .map(function(m){ return {mail:m, n:graban[m]}; });
}
function personaFathomAbrir(mail){
  S._personaFathom=mail;
  personasModal();
  var i=document.getElementById('pf-key');
  if(i&&i.focus) i.focus();
}
async function personaFathomConectar(mail){
  var est=document.getElementById('pf-estado');
  var inp=document.getElementById('pf-key');
  var key=String((inp||{}).value||'').trim();
  var _di=function(t,c){ if(est){ est.textContent=t; est.style.color=c||'var(--text3)'; } };
  var url=(localStorage.getItem('evold-fathom-hook')||'').trim();
  var sec=(localStorage.getItem('evold-fathom-hook-sec')||'').trim();
  if(!url||!sec){
    _di('Falta configurar el webhook en Integraciones \u2192 Fathom por webhook.','var(--amberx)');
    return;
  }
  if(!key){ _di('Pega la API key primero.','var(--amberx)'); if(inp&&inp.focus) inp.focus(); return; }
  _di('Conectando con Fathom...');
  try{
    var r=await fetch(url+(url.indexOf('?')>=0?'&':'?')+'s='+encodeURIComponent(sec)+'&accion=alta',
      {method:'POST', headers:{'Content-Type':'application/json'},
       body:JSON.stringify({api_key:key, destino:url,
         // De quien es esta key. La funcion la guarda con ese mail para poder
         // buscar despues en las grabaciones de esta persona.
         email:mail, nombre:((DB.personas||[]).filter(function(x){
           return String(x.email||'').toLowerCase()===String(mail).toLowerCase(); })[0]||{}).nombre||''})});
    var d=null; try{ d=await r.json(); }catch(e){}
    if(!r.ok||!d||!d.ok){
      _di((d&&d.error)||('No pude conectarlo (HTTP '+r.status+')'),'var(--redx)');
      return;
    }
    // Se guarda de quien era la key segun Fathom. Si no coincide con el mail de
    // la ficha, se avisa en la lista: es el error facil de cometer, pegar la
    // propia key en la fila de otro y creer que quedaron los dos conectados.
    // Se busca la entrada real en DB.personas, no la copia que dibuja la lista.
    // Y si esa persona todavia no tiene entrada propia (esta solo en DB.equipo),
    // se crea: sin esto el estado se escribia sobre undefined y se perdia sin
    // que nada avisara.
    DB.personas=Array.isArray(DB.personas)?DB.personas:[];
    var k=String(mail).toLowerCase();
    var p=DB.personas.filter(function(x){
      return String(x.email||'').toLowerCase()===k; })[0];
    if(!p){ p={email:mail, nombre:'', tel:''}; DB.personas.push(p); }
    p.fathomAt=new Date().toISOString();
    p.fathomMail=d.duenio||'';
    // El id se guarda porque Fathom no deja listar los webhooks: si algun dia
    // hay que borrar este, sin el id no hay forma de identificarlo.
    p.fathomHookId=d.id||'';
    // Distingue "el webhook se creo" de "la key quedo guardada del lado del
    // servidor". Sin esto, quien conecto antes de que existiera la tabla figura
    // igual que quien conecto despues, y la busqueda no lo encuentra.
    p.fathomKeyGuardada=!!d.guardada;
    try{ save(); }catch(e){ console.error('no pude guardar el estado:', e); }
    S._personaFathom=null;
    // Lo que hay cambio, asi que lo de antes ya no sirve: se vuelve a
    // preguntar y la lista se repinta sola cuando llega la respuesta.
    _fathomCuentas=null;
    personasModal();
    // Que la key sea de otra cuenta NO es un error cuando se estan sumando
    // varias: es exactamente lo que pasa al conectarle a alguien su segundo
    // Fathom. Se dice cual quedo, sin el "ojo" de antes, que ahora asustaria
    // en el caso normal.
    var aviso=(d.duenio && String(d.duenio).toLowerCase()!==String(mail).toLowerCase())
      ? (' Quedo como cuenta '+d.duenio+'.') : '';
    /* ⚠️  A CIEGAS: Fathom no dijo de quien es la cuenta, cosa que pasa cuando
       todavia no tiene ninguna grabacion. Sin ese dato las dos cuentas de una
       misma persona caen en la misma fila y la segunda pisa a la primera, que
       es justo lo que esto vino a arreglar. Hay que decirlo. */
    if(d.a_ciegas){
      aviso+=' Ojo: Fathom no me dijo de que cuenta es —suele pasar cuando todavia'
            +' no tiene ninguna grabacion—, asi que quedo guardada como la unica de'
            +' esta persona. Si le sumas otra, esta se pierde.';
    }
    // Que el webhook se cree y que la key quede guardada son dos cosas: si la
    // segunda falla, la busqueda hacia atras no va a andar y hay que decirlo.
    if(!d.guardada){
      aviso+=' Pero la key NO quedo guardada'+(d.error_key?(': '+d.error_key):'')+'.';
    }
    if(typeof toast==='function'){
      toast((d.estado==='ya_estaba'?'Ya estaba conectado.':'Fathom conectado.')+aviso,
            aviso?'amber':undefined);
    }
  }catch(e){
    _di('No pude hablar con la funcion: '+e.message,'var(--redx)');
  }
}

// ---- Action items de las llamadas (Fathom via Gmail) ----
// Trae los recaps de Fathom del mail y los convierte en candidatos a ticket,
// la misma cola de revision que usan los mensajes de WhatsApp. No auto-crea:
// Fathom a veces lista como "action item" cosas que no son tarea (contexto,
// decisiones), asi que vos confirmas cual entra.
// ---- Sincronizacion automatica de LLAMADAS (no solo tareas) ----
// Usa los mismos recaps de Fathom que ya llegan a Gmail, pero en vez de sacar
// solo action items, arma la llamada completa (titulo, fecha, resumen, riesgos),
// la asigna al cliente por las palabras clave del mapeo y llena fathomCalls + hitos.
// 100% automatico: sin pegar JSON, sin boton por cliente.
// ---- Llamadas que llegan solas desde Fathom -------------------------------
// La sincronizacion vieja lee los mails de recap de UNA casilla de Gmail, asi
// que solo entran las llamadas de quien tenga ese buzon. Esto es al reves:
// cada persona pone un webhook en su propio Fathom, las llamadas caen en
// Supabase apenas terminan, y aca solo se bajan y se asignan al cliente.
// Ademas queda registrado quien la grabo, que antes se perdia.
// Las llamadas que llegaron y no son de nadie, tal como las devolvio la ultima
// sincronizacion. `null` es "todavia no se sincronizo en esta sesion", que no
// es lo mismo que "no hay ninguna": decir "nada pendiente" sin haber mirado es
// la forma mas facil de que algo se pierda.
var _fathomSinCliente=null;
var _fathomSinClienteAt=0;
async function fathomWebhookSync(silent){
  if(!SB.token){ if(!silent) toast('Entra con tu cuenta para sincronizar.','amber'); return {added:0}; }
  var filas;
  try{
    /* ⚠️  EN TANDAS HASTA AGOTAR, NO LAS PRIMERAS 60. Con un `limit` fijo y
       orden descendente, las que no enganchan se quedan en `procesada=false`
       y ocupan el cupo para siempre: las de mas atras no llegan nunca al
       matcher, asi que crear el cliente despues no las rescata. Se detecto
       midiendo: 132 sin procesar y 72 de ellas -toda la primera quincena de
       septiembre- fuera del alcance de la sincronizacion.
       El tope de vueltas es para que un error del lado del servidor no deje
       el bucle girando; 12 tandas de 200 son 2400 llamadas, muy por encima de
       lo que la agencia acumula entre sincronizaciones. */
    filas=[];
    var _tanda=200, _desde=0, _vuelta=0;
    while(_vuelta<12){
      var _p=await sbFetch('llamadas_fathom?procesada=eq.false&order=recibida_at.desc'
        +'&limit='+_tanda+'&offset='+_desde);
      if(!_p||!_p.length) break;
      filas=filas.concat(_p);
      if(_p.length<_tanda) break;
      _desde+=_tanda; _vuelta++;
    }
  }catch(e){
    // Si la tabla no existe todavia, no es un error: es que falta el paso 1.
    if(/relation|does not exist|404/i.test(e.message||'')){
      if(!silent) toast('Falta crear la tabla llamadas_fathom en Supabase.','amber');
      return {added:0};
    }
    if(!silent) toast('No pude leer las llamadas: '+e.message,'red');
    return {added:0};
  }
  if(!filas||!filas.length){ if(!silent) toast('Sin llamadas nuevas.'); return {added:0}; }

  var added=0, sinCliente=[], tocados={}, marcar=[];
  filas.forEach(function(f){
    var c=null;
    // Si alguien ya la asigno a mano desde el tracker, se respeta.
    if(f.cliente_id) c=DB.clients.find(function(x){ return String(x.id)===String(f.cliente_id); });
    if(!c) c=_fathomMatchClient(f.titulo||'', f);
    // Ningun cliente la reconoce. Si la grabo alguien que prospecta y habia
    // gente de afuera, es un lead: abre su tarjeta en el tablero en vez de
    // quedar en el limbo esperando que alguien la asigne a mano.
    if(!c) c=_fathomProspectoDe(f);
    if(!c){ sinCliente.push(f); return; }
    c.fathomCalls=c.fathomCalls||[];
    var id='fw-'+f.recording_id;
    var items=(f.action_items||[]).map(function(it){
      return (it&&(it.description||it.texto||it.text))||String(it||''); }).filter(Boolean);
    var _ya=_fathomExistente(c, f.recording_id, f.url, f.titulo, f.fecha);
    if(_ya){
      // La misma reunion grabada por otra persona del equipo. No entra de
      // nuevo, pero si trae la transcripcion que a la guardada le faltaba, se
      // la queda: la copia que llega primero no siempre es la mas completa.
      if(_fathomCompletar(_ya, {
        transcript:f.transcripcion||'', summary:f.resumen||'', duration:f.duracion||'',
        url:f.url||'', grabo:f.grabo_mail||'', grabaNombre:f.grabo_nombre||'',
        actionItems:items,
        participantes:(typeof _fathomMails==='function')?_fathomMails(f):[]
      })) tocados[c.id]=true;
      marcar.push(f.recording_id);
      return;
    }
    c.fathomCalls.unshift({
      id:id, title:f.titulo||'Llamada',
      date:f.fecha?new Date(f.fecha).toLocaleDateString('es-AR'):new Date().toLocaleDateString('es-AR'),
      duration:f.duracion||'', sentiment:'satisfecho',
      summary:f.resumen||'', transcript:f.transcripcion||'',
      actionItems:items, riskFlags:[], url:f.url||'',
      // Lo que la sincronizacion por Gmail no podia saber.
      grabo:f.grabo_mail||'', grabaNombre:f.grabo_nombre||'',
      // Quien estuvo en la llamada. Sin esto no hay forma de darse cuenta de
      // que una tarjeta junto reuniones de dos personas distintas.
      participantes:(typeof _fathomMails==='function')?_fathomMails(f):[],
      _cid:c.id
    });
    tocados[c.id]=true; marcar.push(f.recording_id); added++;
  });

  /* ⚠️  SE MIRA `tocados`, NO `added`. Cuando la llamada ya estaba y lo unico
     que llego fue la transcripcion que le faltaba, `_fathomCompletar` marca el
     cliente como tocado pero `added` sigue en cero: con `if(added)` eso no se
     guardaba nunca y el dato nuevo se perdia al cerrar la pestaña. */
  if(Object.keys(tocados).length){
    Object.keys(tocados).forEach(function(cid){
      var c=DB.clients.find(function(x){ return String(x.id)===String(cid); });
      if(!c) return;
      _llDuracionesDe(c);
      (c.fathomCalls||[]).forEach(function(cl){ if(cl._cid===c.id) _fathomUpsertMilestone(c,cl); });
      _fathomSortMilestones(c);
      queHaceAuto(c);
    });
    save();
    /* ⚠️  HAY QUE ESPERAR LA SUBIDA ANTES DE MARCARLAS PROCESADAS.
       El comentario de abajo decia "recien despues de guardar", pero `save()`
       NO sube a la nube: escribe en el navegador y programa `sbSubir()` para
       DOS SEGUNDOS despues. El PATCH se hacia enseguida, asi que en esos dos
       segundos alcanzaba con cerrar la pestaña, recargar o perder la red para
       que la llamada quedara marcada como procesada en la base con el cliente
       sin subir. Y como ya esta procesada, la sincronizacion no la vuelve a
       mirar nunca: se pierde en silencio, sin error y sin aviso.
       Medido sobre los datos de verdad: 15 llamadas de clientes reales
       -cliente V, cliente BA, Matias Bote, Martin Oyola, cliente AG, cliente AV...-
       marcadas procesadas y que no estan en la ficha de nadie.
       `sbSubir` sube solo lo que cambio, asi que llamarla aca no repite
       trabajo: el timer que dejo `save()` la encuentra sin nada que hacer. */
    if(SB.listo){
      try{ await sbSubir(); }
      catch(e){
        // Sin subida confirmada NO se marcan: es preferible volver a bajarlas
        // la proxima vez que perderlas.
        console.warn('no pude subir antes de marcar las llamadas:', e && e.message);
        marcar.length=0;
        if(!silent) toast('Las llamadas entraron pero no pude subirlas. '
          +'Se vuelven a intentar en la proxima sincronizacion.','amber');
      }
    }
    if(S.view==='client') renderClient(); else if(S.view==='overview') showOverview();
  }
  if(marcar.length){
    try{
      await sbFetch('llamadas_fathom?recording_id=in.('+marcar.map(function(x){
        return '"'+String(x).replace(/"/g,'')+'"'; }).join(',')+')',
        {method:'PATCH', body:JSON.stringify({procesada:true})});
    }catch(e){ console.warn('no pude marcarlas procesadas:', e.message); }
  }
  // Las que no matchearon quedan sin procesar a proposito: se listan para
  // asignarlas a mano, y hasta que eso pase siguen apareciendo.
  if(!silent){
    if(added) toast(added+' llamada'+(added===1?'':'s')+' nueva'+(added===1?'':'s')
      +(sinCliente.length?(' \u00b7 '+sinCliente.length+' sin cliente'):''));
    else if(sinCliente.length) toast(sinCliente.length+' llamada'+(sinCliente.length===1?'':'s')
      +' sin cliente: asignalas en Integraciones.','amber');
    else toast('Sin llamadas nuevas.');
  }
  /* ⚠️  LAS QUE NO ENGANCHARON SE GUARDAN, NO SOLO SE CUENTAN. Antes de esto
     el unico rastro era un numero en Integraciones -"3 sin cliente"- y un
     toast que se va solo. La llamada de David con Martin estuvo un dia entero
     ahi sin que nadie pudiera verla, y termino con el cliente cargado a mano y
     sin sus llamadas. Ahora la lista viaja hasta "Datos que faltan", que es
     donde se mira que quedo pendiente. */
  _fathomSinCliente=sinCliente;
  _fathomSinClienteAt=Date.now();
  return {added:added, sinCliente:sinCliente.length,
          clientes:Object.keys(tocados).map(function(cid){
            var c2=DB.clients.find(function(x){ return String(x.id)===String(cid); });
            return c2?c2.name:'';
          }).filter(Boolean)};
}
// La pantalla que explica como conectarlo, con la URL ya armada para copiar.
function fathomHookModal(){
  var url=(localStorage.getItem('evold-fathom-hook')||'').trim();
  var sec=(localStorage.getItem('evold-fathom-hook-sec')||'').trim();
  var full=url?(url+(url.indexOf('?')>=0?'&':'?')+'s='+encodeURIComponent(sec||'')):'';
  var inp='width:100%;box-sizing:border-box;margin-top:5px';
  var paso=function(n, t, cuerpo){
    return '<div style="display:flex;gap:12px;padding:12px 0;border-bottom:1px solid var(--border)">'
      +'<span style="font-family:var(--font-mono,monospace);font-size:.7rem;color:var(--text3);'
        +'flex:none;padding-top:2px">'+n+'</span>'
      +'<div style="flex:1;min-width:0">'
        +'<div style="font-size:12.5px;color:var(--text)">'+t+'</div>'
        +'<div style="font-size:11.5px;color:var(--text3);line-height:1.6;margin-top:4px">'
          +cuerpo+'</div>'
      +'</div>'
    +'</div>';
  };
  document.getElementById('modal-root').innerHTML=
    '<div class="modal-overlay" onclick="if(event.target===this)closeModal()">'
    +'<div class="modal" style="max-width:870px;max-height:88vh;overflow-y:auto">'
      +'<div class="modal-title">Fathom por webhook</div>'
      +'<div class="modal-sub">Las llamadas caen solas apenas terminan, de todo el equipo. '
        +'Se configura una vez.</div>'
      +paso(1,'Crear la tabla en Supabase',
        'SQL Editor \u2192 New query \u2192 pegar el archivo <b>1-supabase-tabla.sql</b> \u2192 Run.')
      +paso(2,'Desplegar la funcion',
        'Edge Functions \u2192 Deploy a new function \u2192 Via Editor. Nombre: <b>fathom</b>. '
        +'Pegar <b>2-edge-function.ts</b>. <b style="color:var(--amberx)">Desmarcar "Verify JWT"</b>: '
        +'Fathom no manda ese token y si queda prendido rebota todo.')
      +paso(3,'Guardar el secreto',
        'En la funcion \u2192 Secrets \u2192 nueva: nombre <b>FATHOM_SECRETO</b>, valor una palabra '
        +'inventada. Pegala tambien aca abajo.')
      +paso(4,'Pegar la URL de la funcion',
        'La da Supabase al desplegar. Termina en <span class="mono">/functions/v1/fathom</span>.')
      +'<div style="margin-top:14px">'
        +'<div style="font-size:11px;color:var(--text3)">URL de la funcion</div>'
        +'<input id="fh-url" value="'+esc(url)+'" style="'+inp+'" '
          +'placeholder="https://xxxx.supabase.co/functions/v1/fathom">'
        +'<div style="font-size:11px;color:var(--text3);margin-top:9px">El secreto</div>'
        +'<input id="fh-sec" value="'+esc(sec)+'" style="'+inp+'" placeholder="una palabra tuya">'
        +'<div style="display:flex;justify-content:flex-end;margin-top:8px">'
          +'<button class="btn btn-sm btn-primary" onclick="fathomHookGuardar()">Guardar</button>'
        +'</div>'
      +'</div>'
      +(full
        ?('<div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border)">'
          +'<div style="font-size:12.5px;color:var(--text);margin-bottom:4px">'
            +'5. Cada uno conecta su Fathom desde aca</div>'
          +'<div style="font-size:11.5px;color:var(--text3);line-height:1.6;margin-bottom:10px">'
            +'Fathom saco la pantalla de webhooks de su interfaz: ahora solo se crean por API. '
            +'Asi que en vez de pegar la URL a mano, cada persona genera su API key en '
            +'<b>Fathom \u2192 Settings \u2192 API Access \u2192 Add \u2192 Generate Api Key</b>, la pega aca '
            +'y toca el boton. Con eso alcanza: la URL la pone el sistema. '
            +'La key queda guardada del lado del servidor \u2014no en este navegador\u2014 '
            +'porque hace falta para dos cosas: crear el webhook, que trae las reuniones '
            +'nuevas, y poder ir a buscar las viejas.</div>'
          +'<input id="fh-apikey" placeholder="Pega tu API key de Fathom" '
            +'style="width:100%;box-sizing:border-box;font-family:ui-monospace,Menlo,monospace;'
            +'font-size:11px">'
          +'<div style="display:flex;align-items:center;gap:10px;margin-top:8px">'
            +'<button class="btn btn-sm btn-primary" onclick="fathomAltaWebhook()">'
              +'Conectar mi Fathom</button>'
            +'<span id="fh-alta-estado" style="font-size:11.5px;color:var(--text3)"></span>'
          +'</div>'
          +'<div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border)">'
            +'<div style="font-size:11px;color:var(--text3);margin-bottom:6px">'
              +'Si preferis hacerlo a mano o por terminal, esta es la URL de destino:</div>'
            +'<textarea readonly rows="2" onclick="this.select()" style="width:100%;'
              +'font-family:ui-monospace,Menlo,monospace;font-size:11px;resize:vertical">'
              +esc(full)+'</textarea>'
            +'<div style="display:flex;justify-content:flex-end;margin-top:7px">'
              +'<button class="btn btn-sm" onclick="fathomHookCopiar()">Copiar la URL</button>'
            +'</div>'
          +'</div>'
        +'</div>')
        :'')
      +'<div id="fh-rev" style="margin-top:14px"></div>'
      +'<div class="modal-footer">'
        +(url?('<button class="btn" onclick="fathomSinClienteModal()">Sin cliente</button>'
          // Con todo conectado y las llamadas entrando igual sin texto, lo unico
          // que contesta por que es mirar la fila cruda que dejo el webhook.
          +'<button class="btn" onclick="fathomRevisar()">Revisar lo que llega</button>'
          +'<button class="btn" onclick="fathomWebhookSync()">Traer ahora</button>'):'')
        +'<button class="btn btn-primary" onclick="closeModal()">Listo</button>'
      +'</div>'
    +'</div></div>';
}
// Mira las ultimas filas que dejo el webhook en Supabase, tal como llegaron.
// Con el equipo conectado y las llamadas entrando sin texto, la pregunta es si
// el campo viene vacio o si la columna directamente no existe en la tabla, y
// eso solo lo contesta la fila cruda.
async function fathomRevisar(){
  var out=document.getElementById('fh-rev');
  if(!out) return;
  var pinta=function(h){ out.innerHTML=h; };
  var caja=function(cuerpo){
    return '<div style="border:1px solid var(--border);border-radius:var(--radius);'
      +'padding:11px 13px;font-size:11.5px;line-height:1.6;color:var(--text2)">'+cuerpo+'</div>';
  };
  if(!SB.token){ pinta(caja('Entra con tu cuenta para poder mirar la tabla.')); return; }
  pinta(caja('Leyendo las ultimas filas...'));
  var filas;
  try{
    filas=await sbFetch('llamadas_fathom?select=*&order=recibida_at.desc&limit=5');
  }catch(e){
    pinta(caja('<span style="color:var(--redx)">No pude leer la tabla: '+esc(e.message)+'</span>'));
    return;
  }
  if(!filas||!filas.length){
    pinta(caja('La tabla existe pero esta vacia: todavia no llego ninguna llamada.'));
    return;
  }
  // Que columnas trae la tabla de verdad. Si transcripcion no esta, no hay nada
  // que tildar en Fathom: falta la columna y el webhook la descarta al insertar.
  var cols=Object.keys(filas[0]);
  var hayCol=cols.indexOf('transcripcion')>=0;
  var conTexto=filas.filter(function(f){ return String(f.transcripcion||'').length>40; }).length;
  var cab;
  if(!hayCol){
    cab='<b style="color:var(--redx)">La tabla no tiene la columna transcripcion.</b> '
      +'Por eso ninguna llamada la trae: el webhook la manda y la fila la descarta al '
      +'insertar. Se arregla con un ALTER TABLE en Supabase, no tocando Fathom.';
  } else if(!conTexto){
    cab='<b style="color:var(--amberx)">La columna existe pero llega vacia en las '
      +filas.length+' ultimas.</b> El webhook de Fathom manda la transcripcion solo si el '
      +'campo esta tildado al crearlo, asi que esto se resuelve en el alta del webhook.';
  } else {
    cab='<b style="color:var(--accent)">'+conTexto+' de '+filas.length
      +' llegaron con transcripcion.</b> Si igual no la ves en un cliente, el problema esta '
      +'en la asignacion de esa llamada, no en lo que manda Fathom.';
  }
  var lineas=filas.map(function(f){
    var t=String(f.transcripcion||'').length;
    var r=String(f.resumen||'').length;
    return '<div style="display:flex;gap:8px;align-items:baseline;padding:3px 0;'
        +'border-top:1px solid var(--border)">'
      +'<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;'
        +'white-space:nowrap">'+esc(f.titulo||'sin titulo')
        +(f.grabo_mail?('<span style="color:var(--text3)"> \u00b7 '+esc(f.grabo_mail)+'</span>'):'')
        +'</span>'
      +'<span style="flex:none;color:'+(t?'var(--accent)':'var(--text3)')+'">'
        +(t?(t+' car. de transcripcion'):'sin transcripcion')+'</span>'
      +'<span style="flex:none;color:var(--text3)">'+(r?(r+' de resumen'):'sin resumen')+'</span>'
    +'</div>';
  }).join('');
  pinta(caja(cab
    +'<div style="margin-top:9px">'+lineas+'</div>'
    +'<div style="margin-top:9px;color:var(--text3);font-size:10.5px">'
      +'Columnas de la tabla: '+esc(cols.join(', '))+'</div>'));
}
function fathomHookGuardar(){
  var u=String((document.getElementById('fh-url')||{}).value||'').trim();
  var s=String((document.getElementById('fh-sec')||{}).value||'').trim();
  if(u && !/^https:\/\/.+\/functions\/v1\//.test(u)){
    toast('Esa no parece la URL de una funcion. Termina en /functions/v1/fathom','amber'); return;
  }
  localStorage.setItem('evold-fathom-hook', u);
  localStorage.setItem('evold-fathom-hook-sec', s);
  // La tarjeta de atras lee localStorage al dibujarse, asi que sin esto seguia
  // diciendo "No conectado" despues de guardar y parecia que no habia andado.
  if(typeof renderTab==='function') renderTab();
  fathomHookModal();
  toast(u?'Guardado. Ahora pegá la URL en el Fathom de cada uno.':'Borrado.');
}
// Da de alta el webhook en la cuenta de Fathom de quien esta mirando la
// pantalla. El navegador no puede llamar a api.fathom.ai (CORS), asi que se lo
// pide a la edge function, que ya tiene el secreto y sabe su propia URL.
// La API key no se guarda en ningun lado: se manda y se olvida.
async function fathomAltaWebhook(){
  var est=document.getElementById('fh-alta-estado');
  var inp=document.getElementById('fh-apikey');
  var key=String((inp||{}).value||'').trim();
  var url=(localStorage.getItem('evold-fathom-hook')||'').trim();
  var sec=(localStorage.getItem('evold-fathom-hook-sec')||'').trim();
  var _di=function(t,c){ if(est){ est.textContent=t; est.style.color=c||'var(--text3)'; } };
  if(!url||!sec){ _di('Falta guardar la URL y el secreto aca arriba.','var(--amberx)'); return; }
  if(!key){ _di('Pega tu API key primero.','var(--amberx)'); if(inp&&inp.focus) inp.focus(); return; }
  _di('Conectando con Fathom...');
  try{
    var r=await fetch(url+(url.indexOf('?')>=0?'&':'?')+'s='+encodeURIComponent(sec)+'&accion=alta',
      {method:'POST', headers:{'Content-Type':'application/json'},
       body:JSON.stringify({api_key:key, destino:url,
         // Este modal se conecta suelto, sin fila de persona: no sabe de quien
         // es la key. La funcion cae al dueno que le diga Fathom.
         email:'', nombre:''})});
    var d=null; try{ d=await r.json(); }catch(e){}
    if(!r.ok||!d||!d.ok){
      _di((d&&d.error)||('No pude conectarlo (HTTP '+r.status+')'),'var(--redx)');
      return;
    }
    if(inp) inp.value='';   // no dejarla a la vista despues de usarla
    _di(d.estado==='ya_estaba'
      ? 'Ya estaba conectado. No hice nada.'
      : 'Listo. Tus proximas llamadas van a caer solas.','var(--accent)');
    if(typeof renderTab==='function') renderTab();
  }catch(e){
    _di('No pude hablar con la funcion: '+e.message,'var(--redx)');
  }
}
function fathomHookCopiar(){
  var url=(localStorage.getItem('evold-fathom-hook')||'').trim();
  var sec=(localStorage.getItem('evold-fathom-hook-sec')||'').trim();
  var full=url+(url.indexOf('?')>=0?'&':'?')+'s='+encodeURIComponent(sec||'');
  navigator.clipboard.writeText(full).then(function(){ toast('URL copiada.'); },
    function(){ toast('No pude copiar. Seleccionala a mano.','amber'); });
}
// Por que una llamada no abrio tarjeta de lead sola. El modal listaba el titulo
// y nada mas, asi que un lead que borraste hace meses se veia igual que uno que
// nadie reconocio: los dos "sin cliente", sin forma de distinguirlos.
function _fathomPorQueNoLead(fila){
  var grabo=String((fila&&fila.grabo_mail)||'').trim().toLowerCase();
  if(_fathomComerciales().indexOf(grabo)<0){
    return {texto:'no abre lead: '+(grabo||'quien la grabo')+' no esta en comerciales'};
  }
  var afuera=_fathomDeAfuera(fila);
  if(!afuera.length) return {texto:'no abre lead: nadie de afuera en la llamada'};
  var mail=afuera[0];
  if((DB.prospectosNo||[]).indexOf(mail)>=0) return {texto:mail, mail:mail, borrado:true};
  return {texto:mail};
}
// Saca un mail de la lista de borrados y vuelve a bajar la llamada en el acto.
// Las que no matchean quedan sin procesar, asi que la tarjeta se rearma sola.
async function fathomReponerMail(mail){
  var m=String(mail||'').trim().toLowerCase();
  if(!m) return;
  var L=DB.prospectosNo||[];
  var i=L.indexOf(m);
  if(i>=0){ L.splice(i,1); save(); }
  // Sacarlo de la lista no alcanzaba: las llamadas con las que se habia armado
  // la tarjeta ya estaban marcadas procesadas, asi que la sincronizacion no las
  // volvia a bajar y el lead no reaparecia nunca. Hay que destildarlas.
  toast('Buscando sus llamadas\u2026');
  var filas=[];
  try{ filas=await sbFetch('llamadas_fathom?order=recibida_at.desc&limit=300')||[]; }
  catch(e){ toast('No pude leer las llamadas: '+e.message,'red'); return; }
  var suyas=filas.filter(function(f){
    return (typeof _fathomMails==='function') && _fathomMails(f).indexOf(m)>=0;
  });
  if(!suyas.length){
    toast('Lo saque de la lista, pero no hay ninguna llamada guardada con ese '
      +'mail: la tarjeta se va a armar con la proxima.','amber');
    return;
  }
  var ids=suyas.filter(function(f){ return f.procesada; })
               .map(function(f){ return f.recording_id; });
  if(ids.length){
    try{
      await sbFetch('llamadas_fathom?recording_id=in.('+ids.map(function(x){
        return '"'+String(x).replace(/"/g,'')+'"'; }).join(',')+')',
        {method:'PATCH', body:JSON.stringify({procesada:false})});
    }catch(e){ toast('No pude destildarlas: '+e.message,'red'); return; }
  }
  try{ await fathomWebhookSync(true); }catch(e){}
  if(typeof showTickets==='function') showTickets();
  var mr=document.getElementById('modal-root');
  if(mr && /Llamadas sin cliente/.test(mr.innerHTML||'')) fathomSinClienteModal();
  toast(suyas.length+' llamada'+(suyas.length===1?'':'s')+' recuperada'
    +(suyas.length===1?'':'s')+'. Buscalo en el tablero del Panel 360.');
}
// Las que llegaron pero no matchean con ningun cliente. Se asignan a mano y a
// la vez se aprende la palabra clave, para que la proxima entre sola.
/* A quien NOMBRA LA TRANSCRIPCION. Es lo unico que queda cuando el titulo no
   dice nada y no hay invitados de afuera, que es exactamente lo que pasa con
   las reuniones espontaneas: Fathom las titula "Impromptu Google Meet Meeting"
   y, como no hubo invitacion de calendario, en `participantes` figura solo
   quien grabo. La reunion donde se cerro la venta de cliente AI es una de esas
   -48 minutos con Marcelo, y en la ficha no figuraba por ningun lado-.
   ⚠️  SUGIERE, NO ASIGNA. Que a un cliente lo nombren en una reunion no la
       hace suya: "Marce y Martin" es interna y nombra a Marcelo, y las de
       cliente C y cliente T tambien lo mencionan. La decision queda en el select de
       al lado, que ya estaba. Si esto asignara solo, seria el mismo error que
       ya cometimos con un nombre de pila suelto.
   ⚠️  Palabras de menos de cuatro letras afuera: "zen" aparece adentro de
       cualquier cosa y no identifica a nadie. */
/* CUANTO SE PARECE ESTA REUNION A LAS QUE EL CLIENTE YA TIENE.
   Tres senales, todas sacadas de lo que ya esta guardado. Ninguna decide:
   las tres se muestran para que la decision la tome quien mira.
     · cerca      los dias hasta la llamada mas cercana de ese cliente. Una
                  reunion pegada a otra suya casi siempre es del mismo hilo;
                  una a dos meses de distancia merece una mirada.
     · deQue      la primera linea del resumen de Fathom, que es donde dice el
                  proposito. Con eso se ve si fue auditoria, venta u onboarding
                  sin abrir la grabacion.
     · donde      el pedazo de transcripcion alrededor de la primera mencion.
                  Es lo que resuelve "?son la misma persona?": si en una dice
                  que tiene una panaderia y en otra que vende un software, se
                  ve leyendo dos renglones. */
function _fathomContexto(fila, c){
  var out={};
  // 1. Que tan cerca esta de las llamadas que el cliente ya tiene.
  var f=fila&&fila.fecha ? new Date(fila.fecha).getTime() : 0;
  if(f && c){
    var mejor=null;
    (c.fathomCalls||[]).forEach(function(l){
      var d2=(typeof _fechaLL==='function')?_fechaLL(l):null;
      var t=d2?d2.getTime():Date.parse(String(l.date||'').split('/').reverse().join('-'));
      if(!t||isNaN(t)) return;
      var dias=Math.round(Math.abs(f-t)/86400000);
      if(mejor===null||dias<mejor.dias) mejor={dias:dias, t:l.title||''};
    });
    if(mejor) out.cerca=mejor;
  }
  // 2. De que se hablo, segun el resumen que manda Fathom.
  var r=String((fila&&fila.resumen)||'').replace(/[#*_>`]/g,' ').replace(/\s+/g,' ').trim();
  if(r){
    // El resumen arranca con "Proposito de la reunion". Se saca el rotulo y se
    // deja la oracion, que es lo unico que hace falta leer.
    r=r.replace(/^\s*(prop[oó]sito de la reuni[oó]n|purpose of (the )?meeting)\s*:?\s*/i,'');
    out.deQue=r.split(/(?<=[.!?])\s/)[0].slice(0,150);
  }
  // 3. Donde lo nombra, con lo que hay alrededor.
  var t2=String((fila&&fila.transcripcion)||'');
  if(t2 && c){
    var n=_n(t2);
    var palabras=_fathomAliasUnicos(c)
      .concat(((c.fathomKeywords||[])).map(function(k){ return _n(k); }))
      .filter(function(w){ return w && w.length>=4; });
    var i=-1, largo=0;
    palabras.forEach(function(w){
      var j=n.indexOf(w);
      if(j>=0 && (i<0 || j<i)){ i=j; largo=w.length; }
    });
    if(i>=0){
      var a2=Math.max(0, i-90), b2=Math.min(t2.length, i+largo+110);
      out.donde=(a2>0?'\u2026':'')+t2.slice(a2,b2).replace(/\s+/g,' ').trim()+(b2<t2.length?'\u2026':'');
    }
  }
  return out;
}
/* ⚠️  ESTO ESTABA COSTANDO 690ms POR CADA DIBUJADO DE LA FICHA, medido con
       los datos de verdad: 57 clientes y 120 llamadas sueltas. La primera
       version llamaba a `_fathomAliasUnicos` adentro del bucle, y esa funcion
       recorre TODOS los clientes para ver que palabra no comparte ninguno:
       daba 57x120 = 6.840 recorridas completas por ficha. En la computadora se
       notaba como un tironeo; en el telefono deja la pantalla en negro.
    Se arregla con dos caches: las palabras de cada cliente se calculan una
    sola vez, y el resultado por llamada se guarda por `recording_id`. */
var _fathomIdx=null, _fathomIdxN=-1;
function _fathomIndicePalabras(){
  var n=(DB.clients||[]).length;
  if(_fathomIdx && _fathomIdxN===n) return _fathomIdx;
  var idx=[];
  (DB.clients||[]).forEach(function(c){
    if(c.archived) return;
    var ws=_fathomAliasUnicos(c)
      .concat(((c.fathomKeywords||[])).map(function(k){ return _n(k); }))
      /* ⚠️  ACA SI ENTRA EL NOMBRE DE PILA DEL CONTACTO, y en `_fathomAlias`
         no. Son dos cosas distintas: alla las palabras ASIGNAN solas, aca
         solo PROPONEN y la confirma una persona. La reunion donde Grace cerro
         el acuerdo la nombra 344 veces y no dice "Rippleinsights" ni
         "Portillo" en ningun lado: sin el nombre de pila no habia con que
         encontrarla. El riesgo de otra Grace existe, y por eso esto sugiere
         en vez de guardar. */
      .concat([_n(c.contacto).split(/\s+/)[0]||''])
      .filter(function(w){ return w && w.length>=4; });
    if(ws.length) idx.push({c:c, ws:ws});
  });
  _fathomIdx=idx; _fathomIdxN=n; _fathomNombraCache={};
  return idx;
}
var _fathomNombraCache={};
function _fathomQuienNombra(fila){
  var k=String((fila&&fila.recording_id)||'');
  var idx=_fathomIndicePalabras();
  if(k && _fathomNombraCache[k]) return _fathomNombraCache[k];
  // Los primeros 30 mil caracteres alcanzan: si a alguien lo nombran, lo
  // nombran en la presentacion. Escanear los 60 mil de una reunion larga por
  // cada uno de los 57 clientes es lo que hacia la diferencia.
  var t=_n(String((fila&&fila.transcripcion)||'').slice(0,30000));
  if(!t) return [];
  var out=[];
  idx.forEach(function(e){
    var n=0, por=[], peso=0;
    e.ws.forEach(function(w){
      var i=0, k=0;
      while((i=t.indexOf(w,i))>=0){ k++; i+=w.length; }
      if(!k) return;
      n+=k; por.push({w:w, k:k});
      /* ⚠️  NO TODAS LAS PALABRAS VALEN LO MISMO. "cliente AI" aporta "stock",
         que en una reunion de negocios aparece por cualquier motivo: asi se
         sugirio cliente AI para la reunion de Lorena Maruf, donde se hablaba de
         inventario. "marcelo garavagno" no le pasa a nadie por casualidad.
         Las largas pesan mas para que la sugerencia fuerte quede primero. */
      peso += k * (w.length>=12 ? 4 : w.length>=8 ? 3 : w.length>=6 ? 2 : 1);
    });
    if(n) out.push({c:e.c, n:n, peso:peso,
                    por:por.sort(function(a,b){ return b.w.length-a.w.length; })});
  });
  out=out.sort(function(a,b){ return (b.peso||b.n)-(a.peso||a.n); }).slice(0,3);
  if(k) _fathomNombraCache[k]=out;
  return out;
}
async function fathomSinClienteModal(){
  var filas=[];
  try{ filas=await sbFetch('llamadas_fathom?procesada=eq.false&order=recibida_at.desc&limit=40')||[]; }
  catch(e){ toast('No pude leerlas: '+e.message,'red'); return; }
  var pend=filas.filter(function(f){ return !_fathomMatchClient(f.titulo||'', f); });
  var cls=(DB.clients||[]).filter(function(c){ return !c.archived; })
    .sort(function(a,b){ return String(a.name||'').localeCompare(String(b.name||'')); });
  document.getElementById('modal-root').innerHTML=
    '<div class="modal-overlay" onclick="if(event.target===this)closeModal()">'
    +'<div class="modal" style="max-width:870px;max-height:86vh;overflow-y:auto">'
      +'<div class="modal-title">Llamadas sin cliente</div>'
      +'<div class="modal-sub">Llegaron por el webhook pero el titulo no coincide con ningun '
        +'cliente. Al asignarlas se guarda la palabra clave, asi las proximas de ese cliente '
        +'entran solas.</div>'
      +(pend.length
        ? pend.map(function(f){
            return '<div style="display:flex;align-items:center;gap:10px;padding:10px 0;'
                +'border-bottom:1px solid var(--border)">'
              +'<div style="flex:1;min-width:0">'
                +'<div style="font-size:12.5px;color:var(--text);overflow:hidden;'
                  +'text-overflow:ellipsis;white-space:nowrap">'+esc(f.titulo||'Sin titulo')+'</div>'
                +(function(){
                  var q=_fathomPorQueNoLead(f);
                  return '<div style="font-size:11px;color:'
                    +(q.borrado?'var(--amber,#d0a04a)':'var(--text3)')+';margin-top:2px">'
                  +esc(f.grabo_nombre||f.grabo_mail||'')
                  +(f.fecha?(' \u00b7 '+new Date(f.fecha).toLocaleDateString('es-AR')):'')
                  +(q.texto?(' \u00b7 '+esc(q.texto)):'')
                  +(q.borrado?(' \u00b7 <a href="javascript:void(0)" '
                    +'onclick="fathomReponerMail(\''+esc(q.mail)+'\')" '
                    +'style="color:var(--accent);text-decoration:none">volver a permitir</a>'):'')
                  +'</div>';
                })()
                // Quien aparece nombrado adentro de la reunion. Para un
                // "Impromptu Google Meet Meeting" es el unico rastro que hay.
                +(function(){
                    var s2=_fathomQuienNombra(f);
                    if(!s2.length) return '';
                    var ctx=_fathomContexto(f, s2[0].c);
                    return '<div style="font-size:11px;color:var(--text3);margin-top:3px;'
                        +'line-height:1.5">La nombran adentro: '
                      +s2.map(function(x){
                          return '<span onclick="fathomAsignar(\''+esc(f.recording_id)+'\','
                              +x.c.id+')" style="cursor:pointer;color:var(--accent);'
                              +'text-decoration:underline;text-decoration-style:dotted;'
                              +'text-underline-offset:2px">'+esc(x.c.name||'')+'</span>'
                            +' <span style="color:var(--text3)">\u00d7'+x.n+'</span>';
                        }).join(' \u00b7 ')
                      // Los dias hasta la llamada mas cercana del primero de
                      // la lista: pegada a otra suya casi siempre es del
                      // mismo hilo, a dos meses merece una mirada.
                      +(ctx.cerca
                        ? (' \u00b7 a '+ctx.cerca.dias+' dia'+(ctx.cerca.dias===1?'':'s')
                           +' de \u201c'+esc(String(ctx.cerca.t).slice(0,34))+'\u201d')
                        : ' \u00b7 sin otra llamada suya cerca')
                    +'</div>'
                    +(ctx.deQue
                      ? ('<div style="font-size:11px;color:var(--text2);margin-top:3px;'
                         +'line-height:1.5">De que se hablo: '+esc(ctx.deQue)+'</div>')
                      : '')
                    // El pedazo donde lo nombran. Es lo que deja ver en dos
                    // renglones si es la misma persona o un homonimo: si en
                    // una tiene una panaderia y en otra vende un software,
                    // se lee y listo.
                    +(ctx.donde
                      ? ('<div style="font-size:10.5px;color:var(--text3);margin-top:4px;'
                         +'line-height:1.5;padding-left:9px;border-left:2px solid var(--border2);'
                         +'font-style:italic">'+esc(ctx.donde)+'</div>')
                      : '');
                  })()
              +'</div>'
              +'<select onchange="fathomAsignar(\''+esc(f.recording_id)+'\',this.value)" '
                +'style="width:170px;flex:none;font-size:11.5px">'
                +'<option value="">Asignar a...</option>'
                +cls.map(function(c){
                  return '<option value="'+c.id+'">'+esc(c.name||'')+'</option>'; }).join('')
              +'</select>'
            +'</div>';
          }).join('')
        : '<div style="font-size:12.5px;color:var(--text3);padding:10px 0">'
          +'No hay ninguna esperando.</div>')
      +'<div class="modal-footer">'
        +'<button class="btn btn-primary" onclick="closeModal()">Listo</button>'
      +'</div>'
    +'</div></div>';
}
async function fathomAsignar(recId, clientId, desdeFicha){
  if(!clientId) return;
  var c=DB.clients.find(function(x){ return String(x.id)===String(clientId); });
  if(!c) return;
  var filas=[];
  try{ filas=await sbFetch('llamadas_fathom?recording_id=eq.'+encodeURIComponent(recId))||[]; }
  catch(e){ toast('No pude leerla: '+e.message,'red'); return; }
  var f=filas[0];
  if(!f) return;
  // Se aprende del titulo: la palabra que no es del cliente ni generica suele
  // ser su nombre escrito distinto. Con eso la proxima entra sola.
  var t=String(f.titulo||'');
  var partes=t.split(/[-–—|:&]|<>/).map(function(x){ return x.trim(); }).filter(Boolean);
  /* ⚠️  SOLO SE APRENDE SI EL TITULO TIENE UN SEPARADOR. Sin esa condicion,
     asignar una "Impromptu Google Meet Meeting" guardaba ESE TITULO ENTERO
     como palabra del cliente: no hay guion que cortar, asi que la unica parte
     era el titulo completo, y pasaba el filtro porque no empieza con ninguna
     de las genericas. A partir de ahi TODAS las reuniones espontaneas del
     equipo enganchaban con ese cliente.
     Paso de verdad: a cliente AI le entraron veinte llamadas ajenas de una, y
     desde la pantalla se veia como que el boton "no hacia nada".
   ⚠️  Y LA LISTA DE GENERICAS SE AMPLIA. Tenia nueve palabras y le faltaban
     justo las que Fathom pone solo -impromptu, instant, google, meet- y las
     de las reuniones internas. */
  var _genKw=/^(impromptu|instant|google|meet|meeting|zoom|huddle|call|llamada|reunion|reunión|diagnostico|venta|ventas|onboarding|strategy|estrategia|seguimiento|daily|weekly|catchup|check|sync|interno|evolve|the flowing code|flowing|entrenamiento|capacitacion|capacitación|webinar|demo|soporte|software partners|presentacion|presentación|gameplan)/i;
  /* ⚠️  NI UNA PALABRA DEL NOMBRE DE ALGUIEN DEL EQUIPO. Los titulos internos
     empiezan por ahi -"Nacho y Martin <> cliente AW x Evolve"- y aprender
     "Nacho y Martin" le da al cliente todas las reuniones internas. Es la
     misma defensa que ya tiene `_fathomAlias`, que aca faltaba. */
  var _equipoW={};
  (DB.personas||[]).forEach(function(pp){
    _n(pp&&pp.nombre).split(/\s+/).forEach(function(w){ if(w&&w.length>2) _equipoW[w]=1; });
  });
  var kw=(partes.length>1)
    ? partes.filter(function(x){
        if(x.length<=3 || _genKw.test(x)) return false;
        return !_n(x).split(/\s+/).some(function(w){ return _equipoW[w]; });
      })[0]
    : null;
  if(kw){
    c.fathomKeywords=c.fathomKeywords||[];
    if(!c.fathomKeywords.some(function(k){ return _n(k)===_n(kw); })) c.fathomKeywords.push(kw);
  }
  try{
    /* ⚠️  TAMBIEN SE DESMARCA `procesada`. Poner el `cliente_id` no alcanza:
       `fathomWebhookSync` solo mira las que estan SIN procesar, asi que una
       llamada ya procesada se quedaba con el cliente asignado en la base y no
       entraba nunca a la ficha. Es lo que paso con la reunion de 48 minutos
       de cliente AI: se le puso el cliente, se sincronizo, y la ficha siguio
       sin ella. */
    await sbFetch('llamadas_fathom?recording_id=eq.'+encodeURIComponent(recId),
      {method:'PATCH', body:JSON.stringify({cliente_id:String(clientId), procesada:false})});
  }catch(e){ toast('No pude asignarla: '+e.message,'red'); return; }
  /* ⚠️  SE SACA DE LAS DOS LISTAS. La de sueltas y, sobre todo, la de
     candidatas de este cliente: esa es la que dibuja las tarjetas de la
     ficha, y sin limpiarla la pregunta seguia abajo aunque la llamada ya
     estuviera sumada arriba. Se veia como que el boton no hacia nada, otra
     vez, pero esta vez por el lado del cache. */
  if(Array.isArray(_fathomSinCliente)){
    _fathomSinCliente=_fathomSinCliente.filter(function(x){
      return String(x.recording_id)!==String(recId); });
  }
  Object.keys(_fathomSugPorCli||{}).forEach(function(k2){
    if(!Array.isArray(_fathomSugPorCli[k2])) return;
    _fathomSugPorCli[k2]=_fathomSugPorCli[k2].filter(function(x){
      return String(x.recording_id)!==String(recId); });
  });
  save();
  await fathomWebhookSync(true);
  // Desde la ficha se vuelve a la ficha. Abrir el modal de "sin cliente"
  // sacaba del cliente que se estaba mirando.
  /* ⚠️  REPINTAR SIN DEPENDER DE `S.view`. Si no vale 'client' -y no siempre
     vale, segun por donde se entro a la ficha- no se repintaba nada y el
     boton parecia muerto, aunque la llamada ya se hubiera asignado. */
  if(desdeFicha){
    try{ if(typeof renderClient==='function') renderClient();
         else if(typeof renderTab==='function') renderTab(); }catch(e){}
  }
  else fathomSinClienteModal();
  toast('Asignada a '+(c.name||'')+(kw?(' \u00b7 aprendi "'+kw+'"'):'')+'.');
}
/* La pregunta de la ficha: "?esta llamada es de este cliente?".
   ⚠️  EL "NO" SE GUARDA. Si no, la misma sugerencia vuelve a aparecer en el
       proximo dibujado y hay que descartarla una y otra vez. Se guarda en el
       cliente, que es de quien es la respuesta: la misma reunion le puede
       corresponder a otro. */
function fathomSugNo(recId, clientId){
  var c=DB.clients.find(function(x){ return String(x.id)===String(clientId); });
  if(!c) return;
  c.fathomNo=Array.isArray(c.fathomNo)?c.fathomNo:[];
  if(c.fathomNo.indexOf(String(recId))<0) c.fathomNo.push(String(recId));
  save();
  if(S.view==='client') renderClient();
}
// Carga perezosa de las sueltas. `_fathomSinCliente` se llena al sincronizar,
// pero la ficha se puede abrir sin haber sincronizado en esta sesion, y
// entonces no habria nada que sugerir sin que se note por que.
var _fathomSueltasPidiendo=false;
async function _fathomSueltasCargar(){
  if(Array.isArray(_fathomSinCliente)||_fathomSueltasPidiendo||!SB.token) return;
  _fathomSueltasPidiendo=true;
  try{
    // 60 y no 120: cada fila trae su transcripcion entera, y 120 son mas de
    // cuatro megas por sesion. Las mas nuevas son las que importan.
    var filas=await sbFetch('llamadas_fathom?procesada=eq.false&order=fecha.desc&limit=60')||[];
    _fathomSinCliente=filas.filter(function(f){ return !_fathomMatchClient(f.titulo||'', f); });
    /* ⚠️  EL CALCULO SE HACE ACA, UNA VEZ Y EN TANDAS, NO EN EL DIBUJADO.
       Aunque este cacheado, llenar el cache de 60 llamadas de una sola vez
       bloquea el hilo medio segundo y la pantalla queda en negro mientras
       tanto. Cortando cada diez y cediendo el turno, la app sigue respondiendo
       y las sugerencias aparecen cuando estan. */
    _fathomIdx=null; _fathomNombraCache={};
    for(var i=0;i<_fathomSinCliente.length;i++){
      _fathomQuienNombra(_fathomSinCliente[i]);
      if(i%10===9) await new Promise(function(r){ setTimeout(r,0); });
    }
  }catch(e){ _fathomSinCliente=[]; }
  _fathomSueltasPidiendo=false;
  if(S.view==='client') renderClient();
}
// Las sueltas que nombran a ESTE cliente y todavia no se contestaron.
/* ⚠️  UN TITULO QUE NOMBRA A OTRA PERSONA NO SE SUGIERE. "Reunion con Lorena
       Maruf" aparecia como candidata de cliente AI porque adentro se hablaba de
       inventario y la palabra "stock" esta en su transcripcion. Pero el titulo
       ya dice de quien es la reunion, y no es de este cliente: preguntarlo es
       hacer perder el tiempo con algo que se descarta leyendo el encabezado.
       Solo se descarta cuando el titulo tiene la forma "Reunion con <alguien>"
       y ese alguien no es ninguna de las palabras del cliente. Un titulo
       generico -"Impromptu Google Meet Meeting"- no dice nada de nadie, asi
       que ese sigue preguntandose, que es justo el caso que hay que resolver. */
function _fathomTituloEsDeOtro(f, c){
  var t=_n(String((f&&f.titulo)||''));
  var m=t.match(/^reunion con\s+(.+)$/);
  if(!m) return false;
  var quien=m[1].trim();
  if(!quien) return false;
  var mias=_fathomAliasUnicos(c)
    .concat(((c.fathomKeywords||[])).map(function(k){ return _n(k); }))
    .concat([_n(c.contacto)])
    .filter(Boolean);
  // Alcanza con que UNA palabra del cliente aparezca en el nombre del titulo.
  return !mias.some(function(w){
    return w.length>=4 && (quien.indexOf(w)>=0 || w.indexOf(quien)>=0);
  });
}
/* ⚠️  LA BUSQUEDA LA HACE LA BASE, NO EL NAVEGADOR. La primera version se
       bajaba las 60 llamadas mas nuevas -con transcripcion entera, mas de
       cuatro megas- y filtraba aca. Dos problemas: el peso, y sobre todo que
       el tope por fecha dejaba afuera todo lo anterior a unos dias atras. La
       reunion de Rippleinsights es del 17/09 y no entraba en las 60 mas
       nuevas, asi que su ficha seguia diciendo que no habia nada aunque la
       llamada estuviera guardada.
       Ahora se le pide a Postgres las que mencionan A ESTE CLIENTE, sin tope
       de fecha y trayendo un puñado de filas en vez de sesenta. */
var _fathomSugPorCli={}, _fathomSugPidiendo={};
async function _fathomSugerirCargar(c){
  var k=String(c&&c.id||'');
  if(!k || _fathomSugPorCli[k] || _fathomSugPidiendo[k] || !SB.token) return;
  /* ⚠️  SOLO PALABRAS SUELTAS Y EL NOMBRE DEL CLIENTE. `_fathomAliasUnicos`
     incluye tambien los titulos de los documentos -"dataset y oferta -
     Prueba"-, que como palabra a buscar dentro de una transcripcion no dicen
     nada y solo hacen la consulta mas pesada. Lo que sirve es el apellido, el
     dominio, la marca: una palabra sola.
     Y el minimo es 5 y no 4: con 4 entra "stock", que aparece en cualquier
     reunion de negocios. */
  var _nom=_n(c.name);
  var ws=_fathomAliasUnicos(c)
    .concat(((c.fathomKeywords||[])).map(function(k2){ return _n(k2); }))
    // El nombre de pila del contacto: es lo unico que nombra a la persona en
    // una reunion que no dice la empresa por ningun lado.
    .concat([_n(c.contacto).split(/\s+/)[0]||''])
    .filter(function(w){
      if(!w || w.length<5) return false;
      return w.indexOf(' ')<0 || w===_nom;
    });
  if(!ws.length){ _fathomSugPorCli[k]=[]; return; }
  _fathomSugPidiendo[k]=true;
  try{
    // `or=(...)`: una condicion por palabra. Las comas y los parentesis de
    // adentro romperian la consulta, asi que se sacan de la palabra.
    var cond=ws.slice(0,6).map(function(w){
      return 'transcripcion.ilike.*'+encodeURIComponent(w.replace(/[(),*]/g,' ').trim())+'*';
    }).join(',');
    /* ⚠️  SIN FILTRAR POR `procesada`. Ese era el criterio equivocado: una
       llamada marcada como procesada puede no estar en la ficha de NADIE -es
       justo lo que pasa con las que se perdieron-, y filtrando por ahi
       quedaban invisibles para siempre. Las dos reuniones de Rippleinsights
       estan procesadas y sin ficha: con el filtro viejo no aparecian nunca.
       Lo que de verdad hay que descartar es lo que YA esta en alguna ficha, y
       eso el navegador lo sabe sin preguntar. */
    var r=await sbFetch('llamadas_fathom?or=('+cond+')&order=fecha.desc&limit=10')||[];
    var ya={};
    (DB.clients||[]).forEach(function(x){
      (x.fathomCalls||[]).forEach(function(l){
        var i=String(l.id||'').replace(/^(fw|fathom)-/,'');
        if(i) ya[i]=1;
      });
    });
    _fathomSugPorCli[k]=r.filter(function(f){ return !ya[String(f.recording_id)]; });
  }catch(e){ _fathomSugPorCli[k]=[]; }
  _fathomSugPidiendo[k]=false;
  if(typeof renderClient==='function'){ try{ renderClient(); }catch(e){} }
}
function _fathomCandidatasDe(c){
  if(!c) return [];
  var k=String(c.id||'');
  var pool=_fathomSugPorCli[k];
  if(!Array.isArray(pool)){ try{ _fathomSugerirCargar(c); }catch(e){} return []; }
  var no=(c.fathomNo||[]).map(String);
  // Cinturon: lo que ya esta en la ficha no se vuelve a preguntar, aunque
  // haya quedado en el cache de antes.
  var ya={};
  (c.fathomCalls||[]).forEach(function(l){
    var i=String(l.id||'').replace(/^(fw|fathom)-/,'');
    if(i) ya[i]=1;
  });
  /* Ordenadas por cuantas veces lo nombran. Las fuertes primero: la reunion
     donde Grace cerro el acuerdo la nombra 264 veces y una interna donde
     aparece al pasar, nueve. Las dos se preguntan -decidir es de quien mira-
     pero no tienen por que salir mezcladas. */
  return pool.filter(function(f){
    if(ya[String(f.recording_id)]) return false;
    if(no.indexOf(String(f.recording_id))>=0) return false;
    if(_fathomTituloEsDeOtro(f, c)) return false;
    var s2=_fathomQuienNombra(f);
    return s2.length && String(s2[0].c.id)===String(c.id);
  }).sort(function(a,b){
    var pa=(_fathomQuienNombra(a)[0]||{}).n||0;
    var pb=(_fathomQuienNombra(b)[0]||{}).n||0;
    return pb-pa;
  }).slice(0,4);
}
function _fathomSugerenciasHtml(c){
  var cand=_fathomCandidatasDe(c);
  if(!cand.length) return '';
  return cand.map(function(f){
    var ctx=_fathomContexto(f, c);
    var sug0=(_fathomQuienNombra(f)[0])||{};
    return '<div style="background:var(--bg2);border:1px solid var(--border2);'
        +'border-radius:var(--radius-lg);padding:12px 14px;margin-bottom:8px">'
      +'<div style="font-size:12px;color:var(--text2);margin-bottom:6px">'
        +'&iquest;Esta llamada es de <b style="color:var(--text);font-weight:500">'
        +esc(c.name||'')+'</b>?</div>'
      +'<div style="font-size:12.5px;color:var(--text)">'+esc(f.titulo||'Sin titulo')+'</div>'
      +'<div style="font-size:11px;color:var(--text3);margin-top:2px;line-height:1.5">'
        +esc(f.grabo_nombre||f.grabo_mail||'')
        +(f.fecha?(' \u00b7 '+new Date(f.fecha).toLocaleDateString('es-AR')):'')
        +(ctx.cerca?(' \u00b7 a '+ctx.cerca.dias+' dia'+(ctx.cerca.dias===1?'':'s')
           +' de \u201c'+esc(String(ctx.cerca.t).slice(0,30))+'\u201d'):'')
        /* ⚠️  DECIR POR QUE PALABRA. Sin esto, "cliente AI" sugerida por la
           palabra "stock" y sugerida por "marcelo garavagno" se ven igual, y
           la primera es basura. Con la palabra a la vista se descarta de un
           vistazo, sin abrir nada. */
        +((sug0.por&&sug0.por.length)
          ? (' \u00b7 por \u00ab'+esc(sug0.por[0].w)+'\u00bb'
             +(sug0.por.length>1?(' y '+(sug0.por.length-1)+' mas'):''))
          : '')
        /* ⚠️  AVISAR CUANDO LA COINCIDENCIA ES FLOJA. Una sola palabra corta
           -"stock", "potential"- aparece en cualquier reunion de negocios por
           motivos que no tienen nada que ver: asi se sugirio cliente AI para la
           reunion de Lorena Maruf, donde se hablaba de inventario. Mostrarla
           igual pero marcada es mejor que esconderla: la buena del 24/09
           tambien coincide solo por "stock", asi que un filtro se la llevaria
           puesta. */
        +((sug0.por&&sug0.por.length===1&&String(sug0.por[0].w).length<7)
          ? ('<span style="color:var(--amberx)"> \u00b7 coincidencia floja, '
             +'conviene abrirla</span>')
          : '')
        // El link, para confirmar sin salir a buscarlo a Fathom.
        +(f.url?(' \u00b7 <a href="'+esc(f.url)+'" target="_blank" rel="noopener" '
          +'style="color:var(--accent);text-decoration:none;border-bottom:1px dotted '
          +'var(--accent)">ver la grabacion</a>'):'')
      +'</div>'
      +(ctx.deQue?('<div style="font-size:11px;color:var(--text2);margin-top:4px;'
        +'line-height:1.5">'+esc(ctx.deQue)+'</div>'):'')
      +(ctx.donde?('<div style="font-size:10.5px;color:var(--text3);margin-top:5px;'
        +'line-height:1.5;padding-left:9px;border-left:2px solid var(--border2);'
        +'font-style:italic">'+esc(ctx.donde)+'</div>'):'')
      +'<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px">'
        +'<button class="btn btn-sm" onclick="fathomSugNo(\''+esc(f.recording_id)+'\','+c.id+')">'
          +'No es de este cliente</button>'
        +'<button class="btn btn-sm btn-primary" '
          +'onclick="fathomAsignar(\''+esc(f.recording_id)+'\','+c.id+',true)">'
          +'Si, sumala</button>'
      +'</div>'
    +'</div>';
  }).join('');
}

// Los mails de los que estuvieron en la reunion. Es el dato que el titulo no
// tiene: quien titula escribe como quiere —"Dblanit" por "cliente P", o
// "Impromptu meeting"— pero el invitado es siempre el mismo.
// La misma grabacion entra por dos puertas —el webhook y la busqueda hacia
// atras— y cada una le pone su propio prefijo al id: fw- y fathom-. Comparar
// ids enteros no la reconocia, y quedaba dos veces en la ficha con dos titulos
// distintos. Se compara el id sin prefijo, y tambien la url.
// El nombre del prospecto sale de quien vino de afuera. Si el invitado no trae
// nombre se usa la parte de antes del arroba, que igual es reconocible.
function _fathomNombreDe(fila, mail){
  var ps=(fila&&(fila.participantes||fila.calendar_invitees))||[];
  var n='';
  if(Array.isArray(ps)) ps.forEach(function(x){
    var m=String((x&&(x.email||x.mail))||'').trim().toLowerCase();
    if(m===mail && x && x.name) n=String(x.name).trim();
  });
  if(n) return n;
  var loc=String(mail||'').split('@')[0]
    .replace(/[._-]+/g,' ').replace(/\s*\d+\s*$/,'').trim();
  return loc.replace(/\b\w/g,function(l){ return l.toUpperCase(); }) || mail;
}
// Busca o abre el prospecto de una llamada suelta. Devuelve null cuando no
// corresponde crear nada, que es la mayoria de las veces.
function _fathomProspectoDe(fila){
  var grabo=String((fila&&fila.grabo_mail)||'').trim().toLowerCase();
  if(_fathomComerciales().indexOf(grabo)<0) return null;
  var afuera=_fathomDeAfuera(fila);
  if(!afuera.length) return null;
  var mail=afuera[0];
  // Si ya se abrio una tarjeta por este mail, la llamada se suma a esa: dos
  // llamadas con la misma persona son el mismo lead avanzando, no dos leads.
  var ya=(DB.clients||[]).find(function(x){
    return esProspecto(x) && String(x.email||'').toLowerCase()===mail;
  });
  if(ya) return ya;
  // Los que se borraron a mano no se recrean. Era el unico motivo por el que
  // una tarjeta borrada volvia sola.
  if((DB.prospectosNo||[]).indexOf(mail)>=0) return null;
  var nom=_fathomNombreDe(fila, mail);
  var c={ id:Date.now()+Math.floor(Math.random()*1000),
    name:nom, email:mail, prospecto:true, archived:true, conversionLines:[],
    avatar:nom.split(' ').map(function(w){return w[0]||'';}).join('').slice(0,2).toUpperCase(),
    altaAt:new Date().toISOString(), tasks:[], fathomCalls:[] };
  DB.clients.push(c);
  return c;
}
// La clave con la que dos filas son la MISMA reunion aunque vengan de dos
// grabaciones distintas: titulo y dia. Cada persona del equipo tiene su propio
// webhook de Fathom, asi que una reunion con dos de los nuestros llega dos
// veces, cada copia con su recording_id y su url. Mirando solo esos dos campos
// la reunion entraba duplicada.
// La guardada dice "8/9/2026" —dia/mes, formato de aca— y la que llega del
// webhook viene en ISO. new Date() lee "8/9/2026" como 9 de agosto, asi que
// comparandolas crudas la misma reunion daba dos dias distintos.
function _fathomDia(v){
  var t=String(v||'').trim();
  if(!t) return '';
  var dm=/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if(dm) return dm[3]+'-'+(+dm[2])+'-'+(+dm[1]);
  var iso=/^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if(iso) return iso[1]+'-'+(+iso[2])+'-'+(+iso[3]);
  // Con hora se pasa a local, que es como se guarda el texto que se muestra.
  var d=new Date(t);
  return isNaN(d.getTime()) ? t
    : (d.getFullYear()+'-'+(d.getMonth()+1)+'-'+d.getDate());
}
function _fathomClaveReunion(titulo, fecha){
  return _n(titulo).replace(/\s+/g,' ')+'|'+_fathomDia(fecha);
}
// Devuelve la llamada que ya esta, no un booleano: cuando la copia nueva trae
// algo que a la vieja le falta —la transcripcion, la duracion, el resumen— se
// completa en vez de descartarse. Asi unificar no pierde datos.
function _fathomExistente(c, recId, url, titulo, fecha){
  var rid=String(recId||'').trim();
  var u=String(url||'').trim();
  var clave=_fathomClaveReunion(titulo, fecha);
  var porReunion=(clave!=='|');
  return (c.fathomCalls||[]).filter(function(x){
    if(u && x.url && String(x.url).trim()===u) return true;
    if(rid && String(x.id||'').replace(/^(fw|fathom)-/,'')===rid) return true;
    return porReunion && _fathomClaveReunion(x.title, x.date)===clave;
  })[0]||null;
}
function _fathomYaEsta(c, recId, url, titulo, fecha){
  return !!_fathomExistente(c, recId, url, titulo, fecha);
}
// Lo que la copia nueva puede aportarle a la que ya estaba guardada.
function _fathomCompletar(viejo, nuevo){
  var campos=['transcript','summary','duration','url','grabo','grabaNombre'];
  var cambio=false;
  campos.forEach(function(k){
    if(!String(viejo[k]||'').trim() && String(nuevo[k]||'').trim()){
      viejo[k]=nuevo[k]; cambio=true;
    }
  });
  if(!(viejo.actionItems||[]).length && (nuevo.actionItems||[]).length){
    viejo.actionItems=nuevo.actionItems; cambio=true;
  }
  // Los participantes se suman: cada grabacion ve la lista desde su lado.
  var ps=(viejo.participantes||[]).slice();
  (nuevo.participantes||[]).forEach(function(m){ if(ps.indexOf(m)<0){ ps.push(m); cambio=true; } });
  if(ps.length) viejo.participantes=ps;
  // La transcripcion recien llegada puede traer la duracion adentro.
  if(typeof _llCompletarDuracion==='function' && _llCompletarDuracion(viejo)) cambio=true;
  return cambio;
}
function _fathomMails(fila){
  var ps=(fila&&(fila.participantes||fila.calendar_invitees))||[];
  if(!Array.isArray(ps)) return [];
  return ps.map(function(x){
    var m=(x&&(x.email||x.mail))||(typeof x==='string'?x:'');
    return String(m||'').trim().toLowerCase();
  }).filter(function(m){ return m.indexOf('@')>0; });
}
// Que le corresponde a un cliente: sus mails y su dominio, salvo los genericos.
// gmail.com lo comparte medio mundo y asignaria cualquier reunion.
function _fathomSenas(c){
  var mails=[c.email,c.contactoEmail].filter(Boolean)
    .map(function(m){ return String(m).trim().toLowerCase(); });
  var gen=/^(gmail|hotmail|outlook|yahoo|icloud|live|proton(mail)?)\./i;
  var doms=mails.map(function(m){ return m.split('@')[1]||''; })
    .filter(function(d){ return d && !gen.test(d+'.'); });
  // El nombre sin espacios ni acentos. Casi ninguna ficha tiene el mail
  // cargado, pero el dominio del invitado suele SER el nombre del cliente:
  // cliente P.com es cliente P, redzeppelin.cl es cliente AR. Comparar contra
  // eso asigna sin que haya que cargar nada.
  return {mails:mails, doms:doms, clave:_n(c.name).replace(/[^a-z0-9]/g,'')};
}
// La etiqueta principal del dominio: lo de antes del primer punto. Sirve para
// .com y para .com.ar por igual, que es lo que hay en la libreta.
function _fathomDomClave(dom){
  return String(dom||'').split('.')[0].replace(/[^a-z0-9]/g,'');
}
// Las palabras que identifican al cliente sin que nadie las escriba. Salen de
// lo que ya esta cargado en su ficha y en su material: el nombre, el dominio
// de sus mails, el zip de marca, el contrato, los documentos.
// "Zen" no puede quedarse con las reuniones de cliente BA: se compara por palabra
// entera y no por "contiene". Las escritas a mano siguen siendo por "contiene":
// si alguien escribio un pedazo, lo escribio a proposito.
function _fathomContiene(mn, t){
  t=String(t||'');
  if(!t) return false;
  var i=mn.indexOf(t);
  while(i>=0){
    var a=(i===0)?'':mn.charAt(i-1);
    var b=mn.charAt(i+t.length);
    if(!/[a-z0-9]/.test(a) && !/[a-z0-9]/.test(b)) return true;
    i=mn.indexOf(t, i+1);
  }
  return false;
}
function _fathomAlias(c){
  var out=[], meter=function(v){
    var t=_n(v).replace(/[^a-z0-9 ]/g,' ').trim();
    if(t) out.push(t);
  };
  meter(c.name);
  // Cada palabra del nombre por separado, MENOS la primera: "cliente AR"
  // tiene que reconocer un titulo que diga solo "Zeppelin", pero "Martin Oyola"
  // no puede quedarse con "Martin". En una marca la primera palabra casi nunca
  // es la distintiva; en el nombre de una persona es el nombre de pila, y las
  // reuniones internas se titulan justamente asi: "Mela y Martin", "Dani y
  // Martin". Con eso, seis llamadas ajenas cayeron en la ficha de un cliente.
  _n(c.name).split(/\s+/).filter(Boolean).slice(1).forEach(meter);
  /* EL NOMBRE DE LA PERSONA DE CONTACTO. Las reuniones se titulan con el
     nombre de quien vino, no con el de la empresa: "cliente AI" no aparece por
     ningun lado en "Reunion con Garavagno marcelo".

     ⚠️  NO VALE LA MISMA REGLA QUE EL NOMBRE DE LA FICHA. Ahi se meten todas
         las palabras menos la primera porque en una marca la segunda es la
         distintiva -"cliente AR" tiene que reconocer "Zeppelin"-. En el
         nombre de una persona la del medio es el segundo nombre: el contacto
         de cliente C es "Fede Jose Tanco", y metiendo desde la segunda quedaba
         "jose" suelto como palabra del cliente. Probado contra las llamadas
         de verdad: "R2 con Jose pablo Suarez ghibaudo" -que no tiene nada que
         ver- se le asignaba a cliente C.
         Por eso de la persona va el nombre ENTERO y solo el APELLIDO, que es
         lo unico que identifica.

     ⚠️  Y SI EL CONTACTO ES UNA SOLA PALABRA NO ENTRA: es un nombre de pila
         -hoy hay cinco fichas asi: Marcelo, Gabriel, David, Grace, Mateo- y
         suelto se quedaria con las reuniones de cualquier homonimo. Para esos
         alcanza con completar el apellido en la ficha. */
  var _cw=_n(c.contacto).split(/\s+/).filter(Boolean);
  if(_cw.length>1){ meter(c.contacto); meter(_cw[_cw.length-1]); }
  else if(_cw.length===1){
    /* ⚠️  EL APELLIDO SE DEDUCE DEL MAIL cuando el contacto quedo cargado con
       el nombre de pila solo. Un nombre suelto no puede ser palabra del
       cliente -cualquier Marcelo se llevaria sus reuniones- pero la parte de
       adelante del mail suele ser nombre y apellido pegados: "Marcelo" +
       marcelogaravagno@ da "garavagno", que si identifica a una persona.
       Solo se deduce si el mail EMPIEZA con el nombre: asi no se inventa nada
       cuando la casilla no tiene esa forma.
       Medido sobre las fichas de verdad: sale el apellido de cliente AI
       (garavagno), cliente G (tortolo) y Rippleinsights (portillo), y dos
       de los tres aparecen en transcripciones que esas fichas no tenian. */
    var _loc=_n(String(c.email||c.contactoEmail||'').split('@')[0]).replace(/[._-]/g,'');
    if(_loc.indexOf(_cw[0])===0 && _loc.length>_cw[0].length+2){
      meter(_loc.slice(_cw[0].length));
    }
  }
  meter((c.marca||{}).de);
  meter((c.contract||{}).fileName);
  // El dominio solo sirve cuando es propio. De un gmail sale "gmail", que no
  // identifica a nadie y engancharia cualquier reunion que lo nombre.
  var prov=/^(gmail|hotmail|outlook|yahoo|icloud|live|proton|protonmail|aol|me|mac)$/;
  [c.email, c.contactoEmail].forEach(function(m){
    var d=String(m||'').split('@')[1]||'';
    var cl=d?_fathomDomClave(d):'';
    if(cl && !prov.test(cl)) meter(cl);
  });
  (c.docs||[]).forEach(function(d){ meter(d.titulo||d.nombre); });
  var gen=/^(diagnostico|venta|onboarding|reunion|llamada|meeting|call|strategy|seguimiento|contrato|propuesta|brief|transcripcion|documento|copia|final|firmado|pdf|docx|cliente|empresa|proyecto|sitio|web|www|com|landing)$/;
  // Ninguna palabra del nombre de alguien del equipo puede identificar a un
  // cliente: son las que encabezan los titulos de las reuniones internas, asi
  // que enganchan todo lo que no tiene nada que ver.
  var equipo={};
  (DB.personas||[]).forEach(function(p){
    _n(p&&p.nombre).split(/\s+/).forEach(function(w){ if(w) equipo[w]=1; });
  });
  var vistas={};
  return out.filter(function(t){
    if(t.length<4 || gen.test(t) || vistas[t] || equipo[t]) return false;
    vistas[t]=1; return true;
  });
}
// Solo sirven las que no comparte con nadie. Una palabra que le calza a dos
// clientes no distingue a ninguno, y es asi como una llamada termina en la
// ficha equivocada: preferimos no reconocerla y que quede para asignar a mano.
function _fathomAliasUnicos(c){
  var otros={};
  (DB.clients||[]).forEach(function(x){
    if(x.id===c.id) return;
    _fathomAlias(x).forEach(function(t){ otros[t]=1; });
    var n=_n(x.name); if(n) otros[n]=1;
  });
  return _fathomAlias(c).filter(function(t){ return !otros[t]; });
}
// La caja deja de estar siempre a la vista: se abre solo si hace falta, y
// arriba muestra lo que ya reconoce sin que nadie escriba nada.
function _fathomMapeoHtml(c){
  var man=(c.fathomKeywords||[]);
  var auto=_fathomAliasUnicos(c);
  var est='flex:1;padding:6px 10px;font-size:12px;border:1px solid var(--border2);'
    +'border-radius:6px;background:var(--bg3);color:var(--strong);font-family:var(--font);'
    +'outline:none';
  var chip=function(t){
    return '<span style="font-size:10.5px;color:var(--text2);background:var(--bg3);'
      +'border-radius:99px;padding:2px 8px">'+esc(t)+'</span>';
  };
  // Cuantas de las que ya estan cargadas no calzan con ninguna palabra de esta
  // ficha. Son las candidatas a haber entrado por error.
  var raras=(typeof _llNoCalzan==='function')?_llNoCalzan(c).length:0;
  var cuerpo='<div style="font-size:10px;color:var(--text3);margin-bottom:6px;'
      +'font-weight:500">Mapeo de cliente - palabras clave en titulo de reunion</div>'
    +'<div style="display:flex;gap:8px">'
      +'<input type="text" value="'+esc(man.join(', '))+'" '
        +'placeholder="Ej: Vado Devs, Vado, Perla" '
        +'onchange="updateFathomKeywords('+c.id+',this.value)" style="'+est+'">'
    +'</div>'
    +'<div style="font-size:10.5px;color:var(--text3);line-height:1.55;margin-top:7px">'
      +'Solo hace falta si las reuniones se titulan distinto del nombre de la ficha. '
      +'Lo que escribas aca le gana a todo lo demas.</div>'
    +(raras?('<div style="font-size:10.5px;color:var(--text3);line-height:1.55;margin-top:9px;'
        +'padding-top:9px;border-top:1px solid var(--border)">'
      +'<b style="color:var(--amberx)">'+raras+' llamada'+(raras===1?'':'s')+'</b> de esta ficha '
      +'no menciona'+(raras===1?'':'n')+' a este cliente por ningun lado. '
      +'<span onclick="llRevisarModal('+c.id+')" style="cursor:pointer;color:var(--accent);'
        +'text-decoration:underline;text-decoration-style:dotted;text-underline-offset:2px">'
      +'Revisarlas</span>.</div>'):'');
  return '<details style="margin-top:10px">'
    +'<summary style="font-size:11px;color:var(--text3);cursor:pointer">'
      +'Como se reconocen sus reuniones'
      +(man.length?(' · '+man.length+' palabra'+(man.length===1?'':'s')+' a mano'):'')
      +(raras?(' · <span style="color:var(--amberx)">'+raras
        +' que no menciona'+(raras===1?'':'n')+' a este cliente</span>'):'')
    +'</summary>'
    +'<div style="background:var(--bg2);border:1px solid var(--border);'
      +'border-radius:var(--radius-md);padding:10px 12px;margin-top:7px">'
      +(auto.length
        ? ('<div style="font-size:10px;color:var(--text3);margin-bottom:6px;font-weight:500">'
            +'Reconoce solo, de lo que ya esta cargado</div>'
          +'<div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:11px">'
            +auto.slice(0,12).map(chip).join('')
            +(auto.length>12?('<span style="font-size:10.5px;color:var(--text3)">y '
              +(auto.length-12)+' mas</span>'):'')
          +'</div>')
        : ('<div style="font-size:10.5px;color:var(--amberx);line-height:1.55;'
            +'margin-bottom:11px">No hay ninguna palabra que lo distinga de los otros '
            +'clientes. Cargale el contrato o el zip de marca en Material, o escribi una '
            +'aca abajo.</div>'))
      +cuerpo
    +'</div>'
  +'</details>';
}
function _fathomMatchClient(meeting, fila){
  var mn=_n(meeting);
  var byKw=mn&&DB.clients.find(function(c){
    return (c.fathomKeywords||[]).some(function(k){ return k && mn.indexOf(_n(k))>=0; });
  });
  if(byKw) return byKw;
  var byName=mn&&DB.clients.find(function(c){
    var n=_n(c.name);
    if(!n) return false;
    // Un prospecto se llama como la persona. Con el nombre de pila solo,
    // "Sebastian" se quedaba con las reuniones de cualquier otro Sebastian: la
    // tarjeta termino con dos negocios adentro y dos llamadas de venta de
    // personas distintas. Con nombre y apellido el titulo alcanza para
    // distinguir; con una sola palabra manda el mail, que es con lo que se
    // creo el prospecto. Una palabra clave escrita a mano le gana a esto.
    if(typeof esProspecto==='function' && esProspecto(c)
       && n.split(/\s+/).filter(Boolean).length<2) return false;
    return _fathomContiene(mn, n);
  });
  if(byName) return byName;
  // Lo que ya esta cargado en la ficha alcanza para reconocerla sin que nadie
  // escriba una palabra clave: el zip de marca, el contrato, los documentos.
  var byAlias=mn&&DB.clients.find(function(c){
    // Misma regla que arriba: el nombre de pila de un prospecto no alcanza,
    // y el alias no puede ser la puerta de atras que la saltee.
    if(typeof esProspecto==='function' && esProspecto(c)
       && _n(c.name).split(/\s+/).filter(Boolean).length<2) return false;
    return _fathomAliasUnicos(c).some(function(t){ return _fathomContiene(mn, t); });
  });
  if(byAlias) return byAlias;
  // Ultimo recurso y el mas confiable de los tres: quien estuvo en la llamada.
  // Va al final igual, porque si escribiste una palabra clave a mano esa gana:
  // sabes algo que el invitado no dice.
  var mails=_fathomMails(fila);
  if(!mails.length) return null;
  // Los genericos no dicen de quien es la reunion: medio equipo tiene gmail.
  var gen=/^(gmail|hotmail|outlook|yahoo|icloud|live|proton(mail)?)\./i;
  return DB.clients.find(function(c){
    var s2=_fathomSenas(c);
    return mails.some(function(m){
      var dom=m.split('@')[1]||'';
      if(s2.mails.indexOf(m)>=0) return true;
      if(dom && s2.doms.indexOf(dom)>=0) return true;
      // Comparacion exacta contra la etiqueta, no "contiene": con "contiene",
      // un cliente llamado "Zen" se quedaria con las reuniones de cliente BA.com.
      return !!(dom && s2.clave && !gen.test(dom+'.') && _fathomDomClave(dom)===s2.clave);
    });
  })||null;
}
function _fathomUpsertMilestone(c, cl){
  if(!c.milestones) c.milestones=[];
  // Una llamada sin resumir igual paso, y el hito tiene que existir. Sin este
  // texto el cuerpo quedaba vacio y el hito no decia nada.
  var cab=cl.summary||(cl.transcript
    ? 'Sin resumir todavia. Tiene la transcripcion cargada.'
    : 'Sin resumen. Cargala o pega la transcripcion para resumirla.');
  var body=cab+(cl.actionItems&&cl.actionItems.length?'\n\nAction items: '+cl.actionItems.join(', '):'')+(cl.riskFlags&&cl.riskFlags.length?'\n\nRiesgos: '+cl.riskFlags.join(', '):'');
  var tipo=cl.sentiment==='satisfecho'?'hito':'alerta';
  var tags=[cl.sentiment==='satisfecho'?'Llamada':'Llamada - atencion',cl.duration].filter(Boolean);
  var ex=c.milestones.find(function(m){return m.fathomId===cl.id;});
  if(ex){ ex.type=tipo; ex.title=cl.title; ex.date=cl.date; ex.body=body; ex.tags=tags; }
  else { c.milestones.push({type:tipo,title:cl.title,date:cl.date,body:body,tags:tags,fathomId:cl.id}); }
}
function _fathomSortMilestones(c){
  if(!c.milestones) return;
  c.milestones.sort(function(a,b){return String(b.date||'').split('/').reverse().join('').localeCompare(String(a.date||'').split('/').reverse().join(''));});
}
// Heuristica: la llamada parece estar en ingles (para no gastar API en las que ya estan en castellano)
function _fathomPareceIngles(cl){
  var s=(cl.title||'')+' '+(cl.summary||'')+' '+((cl.actionItems||[]).join(' '))+' '+((cl.riskFlags||[]).join(' '));
  return /[a-z]/i.test(s) && !/[áéíóúñ¿¡]/i.test(s) && /\b(the|to|and|for|with|send|book|edit|call|meeting|review|schedule|next|week|new|ready|feedback|shoot|coordinate|refresh)\b/i.test(s);
}
// Traduce al castellano titulo, resumen, action items y riesgos de un set de llamadas, en una sola llamada a la API.
async function _fathomTraducirLlamadas(calls){
  var apiKey=localStorage.getItem('evold-anthropic-key');
  if(!apiKey || !calls || !calls.length) return false;
  var payload=calls.map(function(cl,i){ return {i:i, title:cl.title||'', summary:cl.summary||'', actionItems:cl.actionItems||[], riskFlags:cl.riskFlags||[]}; });
  try{
    var r=await fetch('https://api.anthropic.com/v1/messages',{
      method:'POST',
      headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'},
      body:JSON.stringify({model:'claude-sonnet-5',max_tokens:2500,messages:[{role:'user',content:
        'Traduci al castellano rioplatense TODOS los textos de estas llamadas de trabajo (title, summary, actionItems y riskFlags). '
        +'Manten nombres propios, nombres de clientes, siglas y numeros tal cual. Los action items van cortos y en imperativo. '
        +'Devolve SOLO un JSON array con la MISMA estructura y los mismos indices "i", sin markdown ni explicaciones:\n\n'+JSON.stringify(payload)}]})
    });
    var d=await r.json();
    if(d.error) return false;
    var txt=(d.content||[]).filter(function(b){return b.type==='text';}).map(function(b){return b.text;}).join('');
    var ini=txt.indexOf('['), fin=txt.lastIndexOf(']');
    if(ini<0||fin<=ini) return false;
    var arr=JSON.parse(txt.slice(ini,fin+1));
    arr.forEach(function(tr){
      var cl=calls[tr.i]; if(!cl) return;
      if(tr.title) cl.title=tr.title;
      if(tr.summary) cl.summary=tr.summary;
      if(Array.isArray(tr.actionItems)) cl.actionItems=tr.actionItems;
      if(Array.isArray(tr.riskFlags)) cl.riskFlags=tr.riskFlags;
    });
    return true;
  }catch(e){ return false; }
}
async function syncFathomFromGmail(silent){
  var url=fathomProxyUrl();
  if(!url){ if(!silent) toast('Configura el script de Fathom','red'); return {added:0}; }
  if(!silent) toast('Sincronizando llamadas de Fathom...');
  var d;
  try{
    var r=await proxyFetch(url+(url.indexOf('?')>=0?'&':'?')+'secret=evolve-tracker&action=fathom_recaps&days=60');
    d=await r.json();
  }catch(e){ if(!silent) toast('Error de red leyendo el mail','red'); return {added:0}; }
  if(!d||!d.ok){ if(!silent) toast('No se pudo leer el mail ('+((d&&d.error)||'revisa el script')+')','red'); return {added:0}; }
  var recaps=d.recaps||[];
  var added=0, nuevas=[], clientesTocados={};
  recaps.forEach(function(rc){
    var c=_fathomMatchClient(rc.meeting||rc.title||'');
    if(!c) return;
    var id=rc.id||('fathom-'+_n(rc.meeting||rc.title||'')+'-'+String(rc.date||'').replace(/\D/g,''));
    c.fathomCalls=c.fathomCalls||[];
    if(c.fathomCalls.some(function(x){return x.id===id;})) return;
    var items=(rc.actionItems||[]).map(function(it){return (it&&it.texto)?it.texto:String(it||'');}).filter(Boolean);
    var risks=rc.riskFlags||rc.riesgos||[];
    var sentiment=rc.sentiment||(risks.length?'atencion':'satisfecho');
    var call={ id:id, title:rc.meeting||rc.title||'Llamada', date:rc.date||new Date().toLocaleDateString('es-AR'),
      duration:rc.duration||'', sentiment:sentiment, summary:rc.summary||rc.body||rc.recap||'',
      actionItems:items, riskFlags:risks, initials:rc.initials||'', _cid:c.id };
    c.fathomCalls.unshift(call);
    nuevas.push(call); clientesTocados[c.id]=true; added++;
  });

  // Ademas de las nuevas, recuperar las ya guardadas que quedaron en ingles (p. ej. importadas antes de la traduccion)
  var viejasIngles=[];
  DB.clients.forEach(function(c){
    (c.fathomCalls||[]).forEach(function(cl){
      if(nuevas.indexOf(cl)<0 && _fathomPareceIngles(cl)){ cl._cid=c.id; viejasIngles.push(cl); clientesTocados[c.id]=true; }
    });
  });

  var paraTraducir=nuevas.concat(viejasIngles);
  var hayApiKey=!!localStorage.getItem('evold-anthropic-key');
  if(paraTraducir.length && hayApiKey){
    if(!silent) toast('Traduciendo '+paraTraducir.length+' llamada'+(paraTraducir.length>1?'s':'')+' al castellano...');
    await _fathomTraducirLlamadas(paraTraducir);
  }

  // (Re)construir los hitos con el texto ya traducido
  Object.keys(clientesTocados).forEach(function(cid){
    var c=DB.clients.find(function(x){return String(x.id)===String(cid);});
    if(!c) return;
    (c.fathomCalls||[]).forEach(function(cl){ if(cl._cid===c.id) _fathomUpsertMilestone(c,cl); });
    _fathomSortMilestones(c);
  });

  localStorage.setItem('evold-fathom-sync-at',String(Date.now()));
  save();
  if(S.view==='client') renderClient(); else if(S.view==='overview') showOverview();
  if(!silent){
    var nClients=Object.keys(clientesTocados).length;
    if(added) toast(added+' llamada'+(added>1?'s':'')+' nueva'+(added>1?'s':'')+(paraTraducir.length&&!hayApiKey?' (configura tu API key para traducir)':''));
    else if(viejasIngles.length && hayApiKey) toast(viejasIngles.length+' llamada'+(viejasIngles.length>1?'s':'')+' traducida'+(viejasIngles.length>1?'s':''));
    else if(viejasIngles.length && !hayApiKey) toast('Configura tu API key de Anthropic para traducir','red');
    else toast('Sin llamadas nuevas');
  }
  return {added:added, clients:Object.keys(clientesTocados).length};
}
// Auto-sync en segundo plano al abrir la app (maximo una vez cada 10 min).
// La busqueda hacia atras existia pero habia que ir cliente por cliente a
// apretar el boton, y un cliente nuevo arrancaba sin nada de su historial.
// Esto la corre sola: un cliente por vuelta, no todos de una, porque cada uno
// es una consulta a Fathom por cada key del equipo y en tandas se cae.
// Un link /calls/NNN lo abre solo quien grabo, y el webhook manda ese: toda
// llamada grabada por otro llega inservible para el resto del equipo. La
// busqueda por API key devuelve el /share/, que abre cualquiera, y el backfill
// ya reemplaza los privados de paso. Lo que faltaba era que volviera a pasar
// por un cliente que ya se habia buscado, que es el caso de todos los que
// tienen llamadas viejas.
function _fathomPrivadas(c){
  return (c.fathomCalls||[]).filter(function(x){
    return x.url && String(x.url).indexOf('/share/')<0;
  });
}
// Solo las que todavia no se intentaron. Sin esta marca, un link que Fathom no
// va a devolver nunca dejaria a ese cliente para siempre primero en la cola y
// ningun otro se buscaria jamas.
function _fathomLinksPendientes(c){
  var hechos=(c.fathomLinksTry||[]);
  return _fathomPrivadas(c).filter(function(x){
    return hechos.indexOf(String(x.id||''))<0;
  });
}
function _fathomPendiente(){
  var lista=(DB.clients||[]).filter(function(c){
    if(c.archivado || !_fathomFiltro(c)) return false;
    return !c.fathomBuscadoAt || _fathomLinksPendientes(c).length>0;
  });
  return lista.length?lista[0]:null;
}
// Una reunion es de este cliente si alguno de sus invitados lo es. La funcion
// ya filtra, pero se vuelve a chequear aca: una version vieja desplegada
// devolvia la agenda entera y el tracker la cargaba sin mirar. Si la respuesta
// no trae invitados es justamente esa version vieja, y entonces solo se acepta
// lo que el filtro por dominio de la API ya garantiza por su cuenta.
function _fathomEsDe(f, m){
  if(!Array.isArray(m.invitados)) return f.doms.length>0;
  return m.invitados.some(function(x){
    var mail=String(x||'').trim().toLowerCase();
    var dom=mail.split('@')[1]||'';
    return (mail && f.mails.indexOf(mail)>=0) || (dom && f.doms.indexOf(dom)>=0);
  });
}
// La llamada encontrada se carga con el titulo que le puso Fathom. La busqueda
// a mano lo reescribe con el nombre de la etapa porque la esta importando como
// esa etapa; aca no hay etapa que suponer.
function _fathomImportar(c, m){
  var f=m.fecha?new Date(m.fecha):new Date();
  c.fathomCalls=c.fathomCalls||[];
  c.fathomCalls.unshift({
    id:'fathom-'+(m.recording_id||Date.now()),
    title:m.title||'Llamada',
    tituloFathom:m.title||'',
    date:('0'+f.getDate()).slice(-2)+'/'+('0'+(f.getMonth()+1)).slice(-2)+'/'+f.getFullYear(),
    duration:m.duracion||'', sentiment:'satisfecho',
    summary:m.resumen||'',
    actionItems:(m.action_items||[]).map(function(a){
      return (a&&(a.description||a.texto||a.text))||String(a||''); }).filter(Boolean),
    riskFlags:[],
    initials:(c.name||'?').split(' ').map(function(w){return w[0];}).join('')
      .substring(0,2).toUpperCase(),
    _cid:c.id, importada:true, url:m.url||'', transcript:m.transcripcion||''
  });
}
// Todas las llamadas que quedaron con el link privado, de todos los clientes.
// El backfill arregla de a un cliente por vuelta y nunca reintenta lo que fallo,
// asi que la cola crece mas rapido de lo que se vacia: por eso una llamada la
// abre cualquiera y la de al lado da cartel de permisos.
function _fathomPrivadasTodas(){
  return (DB.clients||[]).map(function(c){
    return {c:c, calls:_fathomPrivadas(c)};
  }).filter(function(g){ return g.calls.length>0; });
}
function _fathomPrivadasCuenta(){
  var n=0;
  _fathomPrivadasTodas().forEach(function(g){ n+=g.calls.length; });
  return n;
}
// Un pedido por cliente y no uno por llamada: la API devuelve todas las
// reuniones de esos mails juntas, y pedirlas de a una solo multiplica la espera.
async function fathomArreglarTodos(){
  var url=(localStorage.getItem('evold-fathom-hook')||'').trim();
  var sec=(localStorage.getItem('evold-fathom-hook-sec')||'').trim();
  if(!url||!sec){ toast('Falta configurar el webhook en Integraciones.','amber'); return; }
  var grupos=_fathomPrivadasTodas();
  if(!grupos.length){ toast('No hay ningun link privado.'); return; }
  var arreglados=0, noAparecen=0, sinMail=[], cuentas=0;
  for(var i=0;i<grupos.length;i++){
    var g=grupos[i];
    var f=_fathomFiltro(g.c);
    if(!f){ sinMail.push(g.c.name||''); continue; }
    toast('Revisando '+(i+1)+' de '+grupos.length+': '+(g.c.name||''));
    var d=null;
    try{
      var r=await fetch(url+(url.indexOf('?')>=0?'&':'?')+'s='+encodeURIComponent(sec)
          +'&accion=buscar',
        {method:'POST', headers:{'Content-Type':'application/json'},
         body:JSON.stringify({emails:f.mails, dominios:f.doms, transcripcion:false})});
      d=await r.json();
    }catch(e){ d=null; }
    if(!d||!d.ok) continue;
    if(d.cuentas) cuentas=Math.max(cuentas, Number(d.cuentas)||0);
    var porId={};
    (d.items||[]).forEach(function(m){
      if(m&&m.url&&String(m.url).indexOf('/share/')>=0) porId[String(m.recording_id||'')]=m.url;
    });
    g.calls.forEach(function(cl){
      var rid=String(cl.id||'').replace(/^(fw|fathom)-/,'');
      if(!porId[rid]){ noAparecen++; return; }
      cl.url=porId[rid]; arreglados++;
      // Se saca de la lista de intentos: quedo arreglada, no fallada.
      g.c.fathomLinksTry=(g.c.fathomLinksTry||[]).filter(function(x){
        return x!==String(cl.id||''); });
    });
  }
  if(arreglados) save();
  var msg=arreglados+' link'+(arreglados===1?'':'s')+' arreglado'+(arreglados===1?'':'s');
  if(noAparecen) msg+=' \u00b7 '+noAparecen+' sin link publico en Fathom';
  if(sinMail.length) msg+=' \u00b7 '+sinMail.length+' cliente'
    +(sinMail.length===1?'':'s')+' sin mail en la ficha';
  if(!cuentas && !arreglados) msg='Ninguna cuenta de Fathom contesto. Se conectan desde '
    +'Personas, con la fila de cada uno.';
  toast(msg, arreglados?undefined:'amber');
  if(typeof renderTab==='function') renderTab();
  var mr=document.getElementById('modal-root');
  if(mr&&/Links privados/.test(mr.innerHTML||'')) fathomLinksModal();
}
// La pantalla que junta todo: cuantos quedan, de que cliente son, y por que uno
// no se puede arreglar. Antes esto solo se veia llamada por llamada, adentro de
// cada ficha, que es justo donde no se mira.
function fathomLinksModal(){
  var grupos=_fathomPrivadasTodas();
  var total=0; grupos.forEach(function(g){ total+=g.calls.length; });
  var hook=(localStorage.getItem('evold-fathom-hook')||'').trim();
  var cuerpo;
  if(!total){
    cuerpo='<div style="font-size:12.5px;color:var(--text3);padding:10px 0">'
      +'No queda ninguna. Todas las llamadas guardadas tienen link publico.</div>';
  } else {
    cuerpo=grupos.map(function(g){
      var f=_fathomFiltro(g.c);
      return '<div style="padding:10px 0;border-bottom:1px solid var(--border)">'
        +'<div style="display:flex;align-items:baseline;gap:8px">'
          +'<span style="font-size:12.5px;color:var(--text)">'+esc(g.c.name||'')+'</span>'
          +'<span style="font-size:11px;color:var(--text3)">'+g.calls.length
            +(g.calls.length===1?' llamada':' llamadas')+'</span>'
          +(f?'':'<span style="font-size:11px;color:var(--amberx)">'
            +'sin mail en la ficha \u2014 no hay con que buscarla</span>')
        +'</div>'
        +'<div style="font-size:11px;color:var(--text3);margin-top:3px;line-height:1.6">'
          +g.calls.map(function(cl){
            return esc(cl.title||'Llamada')+(cl.date?(' \u00b7 '+esc(cl.date)):'');
          }).join('<br>')
        +'</div>'
      +'</div>';
    }).join('');
  }
  document.getElementById('modal-root').innerHTML=
    '<div class="modal-overlay" onclick="if(event.target===this)closeModal()">'
    +'<div class="modal" style="max-width:640px;max-height:86vh;overflow-y:auto">'
      +'<div class="modal-title">Links privados</div>'
      +'<div class="modal-sub">El webhook guarda el link que Fathom manda, y ese solo lo abre '
        +'quien grabo: al resto del equipo le sale un cartel de permisos. El link publico '
        +'(<span class="mono">/share/</span>) hay que pedirselo a la API de Fathom, y para eso '
        +'la persona que grabo tiene que tener su cuenta conectada en Personas. '
        +'La transcripcion y el resumen se ven igual sin el link.</div>'
      +cuerpo
      +'<div class="modal-footer">'
        +(total&&hook?'<button class="btn btn-primary" onclick="fathomArreglarTodos()">'
          +'Arreglar los '+total+'</button>':'')
        +'<button class="btn" onclick="closeModal()">Cerrar</button>'
      +'</div>'
    +'</div></div>';
}
async function _fathomBackfillUno(){
  var url=(localStorage.getItem('evold-fathom-hook')||'').trim();
  var sec=(localStorage.getItem('evold-fathom-hook-sec')||'').trim();
  if(!url||!sec) return;
  var c=_fathomPendiente();
  if(!c) return;
  var f=_fathomFiltro(c);
  // Se marca antes de pedir, no despues: si la consulta falla y se reintentara
  // en cada vuelta, un cliente sin reuniones en Fathom quedaria golpeando la
  // API cada cuatro minutos para siempre.
  c.fathomBuscadoAt=new Date().toISOString();
  // Se anota por cuales links se intento antes de pedir, por el mismo motivo
  // que la fecha: si la consulta falla, no puede quedar reintentando eterno.
  c.fathomLinksTry=(c.fathomLinksTry||[])
    .concat(_fathomLinksPendientes(c).map(function(x){ return String(x.id||''); }));
  save();
  try{
    var r=await fetch(url+(url.indexOf('?')>=0?'&':'?')+'s='+encodeURIComponent(sec)+'&accion=buscar',
      {method:'POST', headers:{'Content-Type':'application/json'},
       body:JSON.stringify({emails:f.mails, dominios:f.doms, transcripcion:true})});
    var d=null; try{ d=await r.json(); }catch(e){}
    if(!r.ok||!d||!d.ok) return;
    // Las que ya estan pero quedaron con el link privado (/calls/NNN) se
    // arreglan de paso: ese link solo lo abre quien grabo, y el resto del
    // equipo se come un cartel de permisos.
    var arreglados=0;
    (d.items||[]).forEach(function(m){
      if(!m.url || m.url.indexOf('/share/')<0) return;
      var rid=String(m.recording_id||'');
      (c.fathomCalls||[]).forEach(function(x){
        var xid=String(x.id||'').replace(/^(fw|fathom)-/,'');
        if(xid!==rid || x.url===m.url) return;
        if(String(x.url||'').indexOf('/share/')>=0) return;
        x.url=m.url; arreglados++;
      });
    });
    if(arreglados) save();
    var nuevas=(d.items||[]).filter(function(m){
      return m.url && !_fathomYaEsta(c, m.recording_id, m.url, m.title||m.meeting_title, m.created_at||m.scheduled_start_time)
        && _fathomEsDe(f, m);
    });
    if(!nuevas.length) return;
    nuevas.forEach(function(m){ _fathomImportar(c, m); });
    save();
    _fathomAvisar({added:nuevas.length, clientes:[c.name]});
  }catch(e){ console.warn('[fathom backfill]', e); }
}
// Cuantas llamadas entraron sin que las vieras, para marcar el titulo de la
// pestana: si el aviso salta con la pestana en segundo plano, el toast se
// pierde y uno vuelve sin enterarse de nada.
var _fathomPend=0, _fathomTituloBase='';
function _fathomTitulo(){
  if(!_fathomTituloBase) _fathomTituloBase=document.title.replace(/^\(\d+\)\s*/,'');
  document.title=_fathomPend ? ('('+_fathomPend+') '+_fathomTituloBase) : _fathomTituloBase;
}
function _fathomVisto(){
  if(!_fathomPend) return;
  _fathomPend=0; _fathomTitulo();
}
// La sincronizacion cargaba la llamada en silencio: aparecia en la ficha y uno
// se enteraba de casualidad al entrar. Avisar es la mitad del trabajo.
function _fathomAvisar(r){
  var n=r.added;
  var quienes=(r.clientes||[]).slice(0,3).join(', ');
  toast(n+' llamada'+(n===1?'':'s')+' nueva'+(n===1?'':'s')
        +(quienes?(' \u00b7 '+quienes):'')
        +((r.clientes||[]).length>3?' y mas':''));
  if(document.hidden){ _fathomPend+=n; _fathomTitulo(); }
  try{
    if(typeof renderSidebar==='function') renderSidebar();
    if(S.view==='tickets' && typeof showTickets==='function') showTickets();
  }catch(e){}
}
// Corria una sola vez, 1,5s despues de abrir. Una llamada que termina mientras
// trabajas no aparecia hasta recargar, que es justo cuando no vas a recargar.
var _fathomLatido=null;
function fathomVigilar(){
  if(_fathomLatido) return;
  _fathomLatido=setInterval(autoSyncFathom, 4*60*1000);
  document.addEventListener('visibilitychange', function(){
    if(document.hidden) return;
    _fathomVisto();
    autoSyncFathom();
  });
}
function autoSyncFathom(){
  // El webhook es el unico camino automatico. Antes tambien se escaneaba el
  // mail con un Apps Script, pero ese proxy hay que redeployarlo cada vez y
  // fallaba por CORS en cada carga sin que nadie se enterara.
  if((localStorage.getItem('evold-fathom-hook')||'').trim()){
    fathomWebhookSync(true).then(function(r){
      try{
        localStorage.setItem('evold-fathom-hook-pend', String((r&&r.sinCliente)||0));
        // Es la unica senal visible de que el sistema esta mirando. La escribia
        // solo el escaneo de mail, asi que el cartel decia "sinc. auto" de hace
        // dias con el webhook trayendo llamadas al dia.
        localStorage.setItem('evold-fathom-sync-at', String(Date.now()));
      }catch(e){}
      if(r&&r.added) _fathomAvisar(r);
      // Despues del webhook, y de a uno: el historial es lo que menos apura.
      _fathomBackfillUno();
    }).catch(function(e){ console.warn('[fathom webhook]', e); });
  }
}

function scanFathomRecaps(){
  var _url=fathomProxyUrl();
  if(!_url){ toast('Configura el script de Fathom','red'); return; }
  toast('Buscando recaps de Fathom en el mail...');
  fetch(_url+(_url.indexOf('?')>=0?'&':'?')+'secret=evolve-tracker&action=fathom_recaps&days=14')
    .then(function(r){return r.json();})
    .then(function(d){
      if(!d||!d.ok){ toast('No se pudo leer el mail ('+((d&&d.error)||'actualiza el addon del script')+')','red'); return; }
      var recaps=d.recaps||[];
      if(!recaps.length){ toast('Sin recaps de Fathom en los ultimos 14 dias'); return; }
      // Aplanar los action items, cada uno con el nombre de la reunion como pista de cliente
      var cand=[];
      recaps.forEach(function(rc){
        (rc.actionItems||[]).forEach(function(it){
          // El nombre de la reunion suele contener el cliente: lo intentamos matchear
          var cli=DB.clients.find(function(c){
            return _n(rc.meeting).indexOf(_n(c.name))>=0;
          });
          cand.push({
            texto:it.texto,
            responsable:it.responsable||'',
            cliente:cli?cli.name:'',
            evidencia:'Llamada: '+rc.meeting+' ('+rc.date+')',
            origen:'Llamada'
          });
        });
      });
      window._convCand={tareas:cand,cierres:[],estados:[]};
      openConvReviewModal();
      toast(cand.length+' tareas de '+recaps.length+' llamada'+(recaps.length>1?'s':''));
      // Si hay API key, traducir al castellano en una sola llamada (no una por tarea).
      traducirCandidatos();
    })
    .catch(function(e){ toast('Error de red leyendo el mail','red'); });
}
// "25/9/2026" es lo que guarda Fathom. Date.parse lo lee como mes/dia y corre
// las fechas: el 25/9 se volvia invalido y el 5/9 aparecia en mayo.
function _calFechaFathom(str){
  var m=String(str||'').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if(!m) { var d0=new Date(str); return isNaN(d0.getTime())?null:d0; }
  var d=new Date(+m[3], +m[2]-1, +m[1], 12, 0, 0);
  return isNaN(d.getTime())?null:d;
}
// Antes de mover, mostrar que implica. Arrastrar es un gesto barato y esto
// reescribe el historial del cliente: conviene ver que se va a dar por hecho.
// Cargar lo que falta sin salir del popup. Para una etapa de llamada crea la
// entrada en fathomCalls con un titulo que matchee su regex — si el titulo no
// matchea, la etapa sigue sin marcarse y no se entiende por que. Para el
// documento va a Material, que es donde viven los links del cliente.
// Buscar en Fathom las reuniones de este cliente. El webhook solo trae lo
// nuevo; esto es para lo viejo. Filtra por el mail del contacto y por el
// dominio, que agarra al resto de su equipo.
// Con que mails y dominios se le pregunta a Fathom por un cliente. Lo usan la
// busqueda a mano y la automatica: si fueran dos copias, arreglar el filtro en
// una dejaria a la otra trayendo cualquier cosa.
function _fathomFiltro(c){
  // Del lado del cliente casi nunca hay una sola persona: en cliente AQ son
  // tres socios y a la reunion entra cualquiera de ellos. Buscar solo por el
  // mail de la ficha fallaba cuando el que estuvo fue otro, asi que entran
  // tambien los del equipo cargado.
  var crudos=[c.email, c.contactoEmail];
  (c.equipo||[]).forEach(function(x){ crudos.push(_eqMail(x)); });
  var visto={}, mails=[];
  crudos.forEach(function(m){
    var t=String(m||'').trim().toLowerCase();
    if(t.indexOf('@')<0 || visto[t]) return;
    visto[t]=1; mails.push(t);
  });
  if(!mails.length) return null;
  // Del mail sale el dominio, salvo que sea una casilla personal: filtrar por
  // gmail.com traeria todas las reuniones de todos los clientes.
  var genericos=/^(gmail|hotmail|outlook|yahoo|icloud|live|proton(mail)?)\./i;
  // Los tres socios comparten dominio: sin deduplicar se manda tres veces el
  // mismo y el mensaje de error lo repite.
  var vd={}, doms=[];
  mails.forEach(function(m){
    var d=String(m).split('@')[1]||'';
    if(!d || genericos.test(d+'.') || vd[d]) return;
    vd[d]=1; doms.push(d);
  });
  return {mails:mails, doms:doms};
}
// Cuantas quedaron duplicadas de antes del arreglo. Se cuenta en vez de
// limpiarlas solo: borrar llamadas sin que nadie lo pida es de las cosas que no
// se pueden deshacer.
function _fathomDuplicadas(c){
  var vistas={}, dup=0;
  (c.fathomCalls||[]).forEach(function(x){
    var k=_fathomClaveReunion(x.title, x.date);
    if(vistas[k]) dup++; else vistas[k]=1;
  });
  return dup;
}
function fathomUnificar(clientId){
  var c=DB.clients.find(function(x){return x.id===clientId;});
  if(!c) return;
  var n=_fathomDuplicadas(c);
  if(!n){ toast('No hay llamadas repetidas.'); return; }
  if(!confirm('Unificar '+n+(n===1?' llamada repetida':' llamadas repetidas')+'?\n\n'
    +'La misma reunion grabada por dos personas del equipo entro dos veces. Se deja una '
    +'sola y se le pasa lo que la otra tenga y a ella le falte.')) return;
  var quedan=[], porClave={};
  (c.fathomCalls||[]).forEach(function(x){
    var k=_fathomClaveReunion(x.title, x.date);
    if(porClave[k]){ _fathomCompletar(porClave[k], x); return; }
    porClave[k]=x; quedan.push(x);
  });
  c.fathomCalls=quedan;
  save();
  if(typeof renderTab==='function') renderTab();
  toast(n+(n===1?' llamada unificada':' llamadas unificadas'));
}
/* ── Traer del historial de Fathom lo que el webhook no alcanzo ──────────────
   ⚠️  ESTO EXISTE PORQUE EL WEBHOOK SOLO TRAE LO QUE PASA DESDE QUE SE
       CONFIGURO. `llamadas_fathom` arranca el 3 de septiembre de 2026, que es
       cuando se dio de alta: todo lo de antes -las ventas viejas, los leads
       que despues compraron- no entro nunca y no hay forma de que entre solo.
       Rippleinsights se cargo el 25/09 con la venta ya hecha por Joela, y su
       ficha quedo en cero llamadas para siempre.
   ⚠️  `accion=buscar` SI VE EL HISTORIAL COMPLETO de cada cuenta conectada, y
       hasta ahora se usaba solo para reparar el link de llamadas que YA
       estaban. Es la misma busqueda, usada para traerlas.
   ⚠️  SE BUSCA POR LOS MAILS DEL CLIENTE, NO POR EL TITULO. Es lo unico que no
       depende de como se haya titulado la reunion, que es justo lo que falla
       cuando la grabacion se llama "Reunion con <la persona>". Sin ningun mail
       cargado no hay busqueda posible, y la funcion lo dice en vez de
       devolver cero en silencio. */
async function fathomTraerHistorial(clientId){
  var c=DB.clients.find(function(x){ return x.id===clientId; });
  if(!c) return;
  var url=(localStorage.getItem('evold-fathom-hook')||'').trim();
  var sec=(localStorage.getItem('evold-fathom-hook-sec')||'').trim();
  if(!url||!sec){ toast('Falta configurar el webhook en Integraciones.','amber'); return; }
  var f=_fathomFiltro(c);
  if(!f){
    toast('Este cliente no tiene ningun mail cargado, y el mail es con lo que se busca. '
      +'Cargalo en la ficha, o suma a quien estuvo en la llamada en Equipo.','amber');
    return;
  }
  toast('Buscando en Fathom las reuniones de '+(c.name||'')+'...');
  var d=null;
  try{
    var r=await fetch(url+(url.indexOf('?')>=0?'&':'?')+'s='+encodeURIComponent(sec)+'&accion=buscar',
      {method:'POST', headers:{'Content-Type':'application/json'},
       // Con transcripcion: es lo que alimenta los generadores y el asistente.
       body:JSON.stringify({emails:f.mails, dominios:f.doms, transcripcion:true})});
    d=await r.json();
  }catch(e){ toast('No pude hablar con Fathom: '+(e&&e.message||''),'red'); return; }
  if(!d||!d.ok){ toast((d&&d.error)||'Fathom no contesto bien.','red'); return; }

  var items=d.items||[];
  if(!items.length){
    // Decir CON QUE se busco, no solo que no encontro: el error mas comun es
    // un mail mal escrito, y asi se ve de una.
    // Antes de mandar a revisar el mail del cliente: fijarse si el problema es
    // que a la cuenta que la grabo no se le puede preguntar.
    var _sin=[];
    try{ await fathomCuentasCargar(true); _sin=_fathomCuentasSinKey(); }catch(e){}
    toast('Busque en '+(Number(d.cuentas)||0)+' cuenta'+((Number(d.cuentas)||0)===1?'':'s')
      +' de Fathom por '+f.mails.join(', ')
      +(f.doms.length?(' y por el dominio '+f.doms.join(', ')):'')
      +' y no aparece ninguna reunion.'
      +(_sin.length
        ? (' Ojo: '+_sin.length+' cuenta'+(_sin.length===1?'':'s')+' que graba'
           +(_sin.length===1?'':'n')+' no tiene'+(_sin.length===1?'':'n')+' la key guardada ('
           +_sin.slice(0,3).map(function(x){ return x.mail+' \u00b7 '+x.n; }).join(', ')
           +(_sin.length>3?', y mas':'')
           +'). El webhook trae lo nuevo, pero para buscar hacia atras hace falta la '
           +'key: se conecta desde Personas.')
        : ' Si los mails estan bien, la grabo alguien que todavia no conecto su Fathom.')
      ,'amber');
    return;
  }

  var _items=function(m){
    return (m.action_items||[]).map(function(it){
      return (it&&(it.description||it.texto||it.text))||String(it||''); }).filter(Boolean);
  };
  var _invit=function(m){
    return (m.invitados||[]).map(function(x){
      return String((x&&x.email)||x||'').trim().toLowerCase();
    }).filter(function(x){ return x.indexOf('@')>0; });
  };

  /* ⚠️  NO TODO LO QUE DEVUELVE LA BUSQUEDA ES DEL CLIENTE. Fathom filtra por
     quien figura invitado en el calendario, y alcanza con que al cliente lo
     hayan invitado a una reunion para que esa reunion salga: asi aparecio una
     interna del equipo -Joela, Delia y Martin hablando de pipeline- en la
     ficha de Rippleinsights.
     Las que el reconocedor identifica como del cliente entran solas. Las
     demas NO se agregan: quedan como pregunta, con su contexto y su link, y
     se confirman de un clic. Es la misma tarjeta que ya se usa para las
     sueltas, asi que no hay dos formas distintas de decidir lo mismo. */
  var nuevas=0, completadas=0, yaEstaban=0, aPreguntar=[];
  c.fathomCalls=c.fathomCalls||[];
  items.forEach(function(m){
    var rid=String(m.recording_id||'');
    var ya=_fathomExistente(c, rid, m.url, m.title, m.fecha);
    if(ya){
      yaEstaban++;
      // La copia de Fathom puede traer lo que a la guardada le falta.
      if(_fathomCompletar(ya, {transcript:m.transcripcion||'', summary:m.resumen||'',
          duration:m.duracion||'', url:m.url||'', grabo:m.grabo||'',
          actionItems:_items(m), participantes:_invit(m)})) completadas++;
      return;
    }
    /* ⚠️  ENTRA SOLA SOLO SI EL TITULO LA IDENTIFICA. Coincidir por el mail
       del invitado NO alcanza, y es lo que hacia `_fathomMatchClient` como
       ultimo recurso: a un cliente lo pueden haber invitado a una reunion
       interna, y entonces esa reunion se da por suya. Paso de verdad, con una
       de Joela, Delia y Martin hablando de pipeline que tenia a Grace
       invitada. Por el mail entro la busqueda -y esta bien que la traiga-,
       pero para guardarla sin preguntar hace falta algo mas firme. */
    var _mn=_n(m.title||'');
    var suya=_mn && _fathomAliasUnicos(c)
      .concat(((c.fathomKeywords||[])).map(function(k){ return _n(k); }))
      .concat([_n(c.name)])
      .filter(Boolean)
      .some(function(w){ return w.length>=4 && _fathomContiene(_mn, w); });
    if(!suya){
      aPreguntar.push({recording_id:rid, titulo:m.title||'', fecha:m.fecha||null,
        grabo_mail:m.grabo||'', url:m.url||'', transcripcion:m.transcripcion||'',
        resumen:m.resumen||'', participantes:(m.invitados||[])});
      return;
    }
    c.fathomCalls.unshift({
      id:'fathom-'+rid, title:m.title||'Llamada',
      date:m.fecha?new Date(m.fecha).toLocaleDateString('es-AR'):'',
      duration:m.duracion||'', sentiment:'satisfecho',
      summary:m.resumen||'', transcript:m.transcripcion||'',
      actionItems:_items(m), riskFlags:[], url:m.url||'',
      grabo:m.grabo||'', participantes:_invit(m), _cid:c.id
    });
    nuevas++;
  });
  // Las dudosas se suman a las que ya se preguntan en la ficha.
  if(aPreguntar.length){
    var _k=String(c.id);
    var _ya={};
    (_fathomSugPorCli[_k]||[]).forEach(function(x){ _ya[String(x.recording_id)]=1; });
    _fathomSugPorCli[_k]=(_fathomSugPorCli[_k]||[])
      .concat(aPreguntar.filter(function(x){ return !_ya[String(x.recording_id)]; }));
  }

  if(nuevas||completadas||aPreguntar.length){
    if(nuevas||completadas) _llDuracionesDe(c);
    (c.fathomCalls||[]).forEach(function(cl){ if(cl._cid===c.id) _fathomUpsertMilestone(c,cl); });
    _fathomSortMilestones(c);
    save();
    if(S.view==='client') renderClient();
  }
  /* ⚠️  EL MENSAJE TIENE QUE DECIR SI LA FICHA CAMBIO O NO, Y ESO NO ES LO
     MISMO QUE CUANTAS REUNIONES DEVOLVIO FATHOM. La primera version decia
     "Fathom devolvio 1 reunion y todas ya estaban", y se leyo como "trajo
     una": se fue a la ficha a buscar el cambio y no habia ninguno. Ahora
     empieza por lo que cambio -o por que no cambio nada- y el numero de
     Fathom va despues, como explicacion. */
  toast(nuevas
    ? (nuevas+' llamada'+(nuevas===1?'':'s')+' agregada'+(nuevas===1?'':'s')+' a la ficha'
       +(aPreguntar.length?(' · '+aPreguntar.length+' para confirmar abajo'):'')
       +(completadas?(' · '+completadas+' completada'+(completadas===1?'':'s')):'')
       +(yaEstaban?(' · '+yaEstaban+' ya estaba'+(yaEstaban===1?'':'n')):''))
    : (aPreguntar.length
      ? ('Fathom devolvio '+aPreguntar.length+' reunion'+(aPreguntar.length===1?'':'es')
         +' que no reconozco como de este cliente. Te las dejo abajo para que '
         +(aPreguntar.length===1?'la confirmes':'las confirmes')+'.')
    : (completadas
        ? ('Ninguna nueva. Complete '+completadas+' que ya estaba'+(completadas===1?'':'n')
           +' con el texto o el link que le faltaba.')
        // Cuando no cambio nada, el dato util es cuantas vio Fathom y con que
        // busco: si el cliente tuvo mas reuniones que esas, el problema esta
        // en el mail con el que entro al calendario, no en el tracker.
        : ('La ficha no cambia: Fathom tiene '+items.length+' reunion'
           +(items.length===1?'':'es')+' de este cliente en '+(Number(d.cuentas)||0)
           +' cuenta'+((Number(d.cuentas)||0)===1?'':'s')+' conectada'
           +((Number(d.cuentas)||0)===1?'':'s')+', y ya esta'+(items.length===1?'':'n')
           +' en la ficha. Busque por '+f.mails.join(', ')
           +'. Si hubo mas, entraron con otro mail.'))));
}
function fathomCallsHTML(c){
  const calls = c.fathomCalls||[];
  const _dup=_fathomDuplicadas(c);
  // Las candidatas se piden por cliente y a la base; cuando llegan, repintan
  // la ficha solas.
  const sug=_fathomSugerenciasHtml(c);
  const btnTraer='<button class="btn btn-sm" style="margin-left:8px" '
    +'onclick="fathomTraerHistorial('+c.id+')" '
    +'title="Le pregunta a Fathom por las reuniones de este cliente y trae las que '
    +'falten. Sirve para las anteriores al webhook, que no entran solas.">'
    +'Traer de Fathom</button>';
  const btnAgregar=_masBoton(c.id)+btnTraer
    +(_dup?('<button class="btn btn-sm" style="margin-left:8px;color:var(--amberx)" '
      +'onclick="fathomUnificar('+c.id+')" title="La misma reunion grabada por dos personas '
      +'del equipo entro dos veces">Unificar '+_dup+' repetida'+(_dup===1?'':'s')+'</button>'):'');
  if(!calls.length){
    return '<div style="background:var(--bg2);border:1px dashed var(--border2);border-radius:var(--radius-lg);padding:20px;text-align:center">'
      +'<div style="font-size:13px;color:var(--text2);margin-bottom:3px">Sin llamadas sincronizadas</div>'
      +'<div style="font-size:11px;color:var(--text3);margin-bottom:12px;line-height:1.55">Se sincronizan solas, pero solo las que pasaron desde que se conecto Fathom. Si son anteriores, traelas del historial.</div>'
      +btnAgregar
      +'</div>'
      +_ticketsDe(c).sort(function(a,b){ return _tsTicket(b)-_tsTicket(a); })
        .map(function(t){ return '<div style="margin-top:8px">'+renderTaskRow(t, c.id, 'tl')+'</div>'; }).join('')
      +sug
      +citasProximasHtml(c);
  }
  const opps = (c.ghl&&c.ghl.opportunities)||[];
  const lastCall = calls[0];
  const pendingItems = calls.reduce(function(s,cl){return s+(cl.actionItems?cl.actionItems.length:0);},0);
  const satisfied = calls.filter(function(cl){return cl.sentiment==='satisfecho';}).length;
  const sentiment = satisfied/calls.length>=0.6?'Activo':'En riesgo';
  const sentColor = sentiment==='Activo'?'#C8FF47':'#BA7517';
  // Horas en llamada: el tiempo que la agencia le puso a este cliente. Ya
  // estaba en cada llamada como texto y no lo sumaba nadie.
  var minTotal=calls.reduce(function(s,cl){ return s+_durMin(cl.duration); },0);
  var sinDur=calls.filter(function(cl){ return !_durMin(cl.duration); }).length;
  let html = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-bottom:12px">'
    +'<div style="background:var(--bg2);border-radius:var(--radius-md);padding:10px 12px;text-align:center"><div style="font-size:18px;font-weight:500;color:var(--text)">'+calls.length+'</div><div style="font-size:10px;color:var(--text3)">Llamadas</div></div>'
    +'<div style="background:var(--bg2);border-radius:var(--radius-md);padding:10px 12px;text-align:center"><div style="font-size:18px;font-weight:500;color:'+sentColor+'">'+sentiment+'</div><div style="font-size:10px;color:var(--text3)">Estado</div></div>'
    +'<div style="background:var(--bg2);border-radius:var(--radius-md);padding:10px 12px;text-align:center"><div style="font-size:18px;font-weight:500;color:var(--text)">'+pendingItems+'</div><div style="font-size:10px;color:var(--text3)">Action items</div></div>'
    +'<div style="background:var(--bg2);border-radius:var(--radius-md);padding:10px 12px;text-align:center">'
      +'<div style="font-size:18px;font-weight:500;color:'+(minTotal?'var(--text)':'var(--text3)')+'">'
      +(minTotal?_horasTexto(minTotal):'sin datos')+'</div>'
      +'<div style="font-size:10px;color:var(--text3)" title="'
      +(minTotal?'':'La duracion sale sola del .vtt de Fathom, o se escribe al editar cada llamada')+'">'
      +(minTotal?('Horas en llamada'+(sinDur?(' \u00b7 faltan '+sinDur):''))
        :'Horas en llamada \u00b7 cargala al editar')+'</div></div>'
    +'<div style="background:var(--bg2);border-radius:var(--radius-md);padding:10px 12px;text-align:center"><div style="font-size:14px;font-weight:500;color:var(--text)">'+(lastCall?lastCall.date:'--')+'</div><div style="font-size:10px;color:var(--text3)">Ultima llamada</div></div>'
    +'</div>';
  // Se dibujan todas y las que pasan de 3 arrancan ocultas. Mostrarlas es
  // cambiar un display, no volver a construir la lista.
  // Con cuatro o mas, las llamadas van en una rueda que gira sin fin (Angie,
  // 12/10/2026); con menos, la lista de siempre.
  /* Llamadas y tickets del cliente en una sola linea de tiempo, de la mas
     reciente a la mas vieja (Angie, 13/10/2026). */
  var _tsTxt=function(txt){
    var m=String(txt||'').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if(m) return new Date(+m[3],+m[2]-1,+m[1]).getTime();
    var d=Date.parse(String(txt||'')); return isNaN(d)?0:d;
  };
  var _items=[];
  var _callsOrd=calls.map(function(x,k){ return {x:x,k:k,t:_tsTxt(x.date)}; })
    .sort(function(a,b){ return (b.t-a.t)||(a.k-b.k); }).map(function(o){ return o.x; });
  _callsOrd.forEach(function(cl, _i){
    var sat = cl.sentiment==='satisfecho';
    const linkedOpp = opps.find(function(o){return o.id===cl.linkedOppId;});
    const isSqlLinked = linkedOpp && linkedOpp._sql;
    var abierta = _tlAbierta(c.id, cl.id, _i===0);
    var chips = (isSqlLinked?'<span class="tl-chip sql" style="margin-right:6px">SQL ✓</span>':'')
      +'<span class="tl-chip '+(sat?'ok':'atn')+'">'+(sat?'Satisfecho':'Atencion')+'</span>';
    // Las acciones van siempre: grabacion, resumen, transcripcion, IA, editar, borrar.
    var acc = '';
    if(cl.url){
      // Un link /calls/NNN es privado: solo lo abre quien grabo. Decirlo antes evita el cartel.
      var priv=(String(cl.url).indexOf('/share/')<0);
      var quien=String(cl.grabaNombre||cl.grabo||'').trim();
      acc += '<a class="tl-b pri" href="'+esc(cl.url)+'" target="_blank" rel="noopener" '
        +(priv?('title="Grabacion privada'+(quien?(' de '+esc(quien)):'')
                +'. Fathom la abre solo para quien grabo; el resto ve un cartel de permisos. '
                +'La transcripcion la tenes aca al lado." '):'')
        +'>Ver grabación'+(priv?(quien?(' · privada de '+esc(_p360Corto(quien))):' · privada'):'')+'</a>';
      if(priv) acc += '<button class="tl-b" onclick="fcArreglarLink('+c.id+',\''+cl.id+'\')" '
        +'title="Le pide a Fathom el link publico de esta grabacion, el que abre cualquiera">Pedir el link público</button>';
    }
    if(cl.transcript) acc += '<button class="tl-b" onclick="fcVerTranscript(\''+cl.id+'\')">'
      +((S._fcTrAbiertos||{})[cl.id]?'Ocultar transcripción':'Transcripción')+'</button>';
    if(cl.summary) acc += '<button class="tl-b" onclick="fcVerResumen(\''+cl.id+'\')">'
      +((S._fcAbiertos||{})[cl.id]?'Ocultar resumen':'Ver resumen')+'</button>';
    acc += cl.transcript
      ? ('<button class="tl-b" onclick="resumirLlamada('+c.id+',\''+cl.id+'\')" '+(cl._resumiendo?'disabled':'')+'>'
          +(cl._resumiendo?'Resumiendo...':(cl.summary?'Volver a resumir':'Resumir con IA'))+'</button>')
      : '<span class="tl-date">Sin transcripción</span>';
    acc += '<button class="tl-b mudo" onclick="abrirLlamadaModal('+c.id+',\''+cl.id+'\')">Editar</button>'
      +'<button class="tl-b mudo" onclick="borrarLlamada('+c.id+',\''+cl.id+'\')">Borrar</button>';
    var cuerpo = ((cl.summary&&(S._fcAbiertos||{})[cl.id])?('<div class="fc-res">'+_fcResumen(cl.summary)+'</div>'):'')
      +((cl.transcript&&(S._fcTrAbiertos||{})[cl.id])
        ?('<div class="fc-res" style="max-height:340px;overflow:auto;white-space:pre-wrap;font-size:11.5px;line-height:1.6">'
          +esc(cl.transcript)+'</div>'):'');
    _items.push({t:_tsTxt(cl.date), h: tlCard({
      tipo:'call', etiqueta:'Llamada',
      fecha: esc(cl.date||'')+(cl.duration?(' · '+esc(cl.duration)):''),
      titulo: esc(cl.title||'Llamada'),
      chips: chips, acciones: acc, cuerpo: cuerpo, abierta: abierta,
      toggle: "tlToggle("+c.id+",'"+cl.id+"',"+(_i===0?'true':'false')+")"
    }) });
  });
  _ticketsDe(c).forEach(function(t){ _items.push({t:_tsTicket(t), h:renderTaskRow(t, c.id, 'tl')}); });
  _items.sort(function(a,b){ return b.t-a.t; });
  var _n=_items.length;
  var _rueda = _n>=4;
  var _cards = _items.map(function(it, i){
    // Sin rueda, las que pasan de 3 arrancan ocultas; el boton las muestra.
    return (!_rueda && i>=3)
      ? it.h.replace('<div class="tl ', '<div data-callx="1" style="display:none" class="tl ')
      : it.h;
  }).join('');
  var _nT=_n-calls.length;
  html += _rueda
    ? ('<div class="tl-rueda-ayuda">'+calls.length+' llamada'+(calls.length===1?'':'s')
       +(_nT?(' y '+_nT+' ticket'+(_nT===1?'':'s')):'')
       +' \u00b7 deslizá para recorrerlas, vuelve al principio solo</div>'
       +'<div class="tl-rueda" id="rueda-'+c.id+'"><div class="tl-rueda-in">'+_cards+'</div></div>')
    : _cards;
  if(!_rueda && _n>3){
    html += '<button class="btn btn-sm" id="fc-ver" onclick="verTodasLasLlamadas(this)" '
      +'style="font-size:11px;padding:3px 9px;margin-top:2px">Ver las otras '+(_n-3)+'</button>';
  }
  // Solo si hay algo que completar y de donde sacarlo.
  var _recuperables=calls.filter(function(cl){
    return !_durMin(cl.duration) && _llDuracionDeTranscript(cl.transcript||'');
  }).length;
  if(_recuperables){
    html += '<button class="btn btn-sm" onclick="calcularDuraciones('+c.id+')" '
      +'style="font-size:11px;padding:3px 9px;margin-top:2px;margin-left:6px">'
      +'Calcular '+_recuperables+' duracion'+(_recuperables===1?'':'es')+'</button>';
  }
  html += '<div style="margin-top:10px">'+btnAgregar+'</div>';
  // Las preguntas van despues de las llamadas que ya estan y antes de lo que
  // viene: se leen en el mismo lugar donde se ve que falta algo.
  if(sug) html += '<div style="margin-top:12px">'+sug+'</div>';
  // Lo que viene va abajo de lo que ya paso: se lee la ficha de arriba para
  // abajo como una linea de tiempo, y la ultima fila es la proxima reunion.
  html += citasProximasHtml(c);
  return html;
}

function linkFathomCall(clientId, callId, oppId){
  const c=DB.clients.find(x=>x.id===clientId);
  if(!c) return;
  const call=(c.fathomCalls||[]).find(cl=>cl.id===callId);
  if(!call) return;
  call.linkedOppId = oppId||null;
  save();
  renderTab();
}


function openFathomKeyModal(){
  openAnthropicKeyModal();
}

function saveFathomAnthropicKey(){
  const key=document.getElementById('anthropic-key-input2').value.trim();
  if(!key){toast('Ingresa una API key','red');return;}
  localStorage.setItem('evold-anthropic-key',key);
  closeModal();
  toast('API key guardada OK');
}

function updateFathomKeywords(clientId, val){
  const c=DB.clients.find(x=>x.id===clientId);
  if(!c) return;
  c.fathomKeywords=val.split(',').map(s=>s.trim()).filter(Boolean);
  save();
  /* ⚠️  REPINTAR NO ES COSMETICO. Lo que se escribe aca se muestra en tres
     lugares mas de la MISMA pantalla -los chips de "reconoce solo", el bloque
     MAPEO de abajo y el contador de llamadas que no mencionan al cliente- y
     ninguno se enteraba: se guardaba, salia "Guardado OK", y abajo seguia el
     valor viejo. Dos valores distintos del mismo dato, uno al lado del otro,
     y no hay forma de saber cual mando.
     Va con `onchange`, no con `oninput`, asi que el repintado pasa al salir
     del campo y no le come el foco a nadie mientras escribe. */
  if(typeof renderTab==='function') renderTab();
  toast('Guardado OK');
}

function openImportFathomModal(clientId){
  document.getElementById('modal-root').innerHTML=`
    <div class="modal-overlay" onclick="if(event.target===this)closeModal()">
      <div class="modal" style="max-width:750px">
        <div class="modal-title">Importar llamadas de Fathom</div>
        <div class="modal-sub">Pega el JSON generado por Claude con las llamadas del cliente.</div>
        <div class="form-row">
          <label class="form-label">JSON de llamadas</label>
          <textarea id="fathom-json-input" rows="10" placeholder='[{"id":"fathom-123","title":"Catch up","date":"02/06/2026","duration":"30 min","sentiment":"satisfecho","summary":"...","actionItems":[],"riskFlags":[],"initials":"PG"}]' style="font-family:var(--mono);font-size:11px"></textarea>
        </div>
        <div class="modal-footer">
          <button class="btn" onclick="closeModal()">Cancelar</button>
          <button class="btn btn-primary" onclick="importFathomJSON(${clientId})">Importar</button>
        </div>
      </div>
    </div>`;
}

function importFathomJSON(clientId){
  const c=DB.clients.find(x=>x.id===clientId);
  if(!c) return;
  const raw=document.getElementById('fathom-json-input').value.trim();
  let calls=[];
  try{
    const clean=raw.replace(/` + '```' + `json|` + '```' + `/g,'').trim();
    calls=JSON.parse(clean);
    if(!Array.isArray(calls)) throw new Error();
  }catch(e){
    toast('JSON invalido, revisa el formato','red');
    return;
  }
  if(!calls.length){toast('No hay llamadas en el JSON','red');return;}
  c.fathomCalls=calls;
  const existingIds=new Set((c.milestones||[]).map(m=>m.fathomId).filter(Boolean));
  const newMilestones=calls
    .filter(cl=>!existingIds.has(cl.id))
    .map(cl=>({
      type:cl.sentiment==='satisfecho'?'hito':'alerta',
      title:cl.title,
      date:cl.date,
      body:cl.summary+(cl.actionItems&&cl.actionItems.length?'\n\nAction items: '+cl.actionItems.join(', '):'')+(cl.riskFlags&&cl.riskFlags.length?'\n\nRiesgos: '+cl.riskFlags.join(', '):''),
      tags:[cl.sentiment==='satisfecho'?'Llamada':'Llamada - atencion',cl.duration].filter(Boolean),
      fathomId:cl.id
    }));
  if(!c.milestones) c.milestones=[];
  c.milestones=[...c.milestones,...newMilestones];
  c.milestones.sort((a,b)=>b.date.split('/').reverse().join('').localeCompare(a.date.split('/').reverse().join('')));
  save();closeModal();renderTab();
  toast(calls.length+' llamadas importadas');
}
// Fathom puede vivir en su propio proyecto. Si no se configura, usa el de Tickets.
function fathomProxyUrl(){
  return (localStorage.getItem('evold-fathom-proxy')||'').trim() || ticketsProxyUrl();
}
