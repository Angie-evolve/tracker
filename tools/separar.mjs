// Separa una parte de index.html a js/<archivo>.js (paso 2 del plan del 23/09).
//
//   node tools/separar.mjs index.html index.html js/meta.js '^_?meta' 'Meta Ads' meta.js
//     args: <index entrada> <index salida> <modulo salida> <regex de nombres>
//           <titulo del modulo> <nombre publicado del modulo>
//
// Mueve TODAS las declaraciones de nivel superior cuyo nombre matchea, con el
// comentario que tienen arriba, en el mismo orden, y agrega el <script src>
// antes del principal. Falla (y no escribe nada que sirva) si al final falta o
// sobra alguna declaracion. Antes de usarlo, revisar con el mismo regex que:
// ninguna variable que se mueve use algo del principal al CARGAR, ningun
// nombre este repetido en la app, y los cambios sin commitear no toquen esas
// funciones (si hay, correrlo sobre HEAD y sobre la copia de trabajo y
// comparar que el modulo salga igual).
import fs from 'fs';
import * as acorn from 'acorn';
const [,,inF,outF,modF,reTxt,mod,pub]=process.argv; const RE=new RegExp(reTxt,'i');
const html=fs.readFileSync(inF,'utf8');
const ab=html.search(/^<script>\s*$/m), ci=html.lastIndexOf('</script>'); const ini=html.indexOf('>',ab)+1;
const src=html.slice(ini,ci);
const ast=acorn.parse(src,{ecmaVersion:'latest',sourceType:'script'});
const nombres=n=>n.type==='FunctionDeclaration'?[n.id.name]:n.type==='VariableDeclaration'?n.declarations.map(d=>d.id.name):[];
const todosArr=ast.body.flatMap(nombres); const todos=new Set(todosArr);
const tramos=[];
ast.body.forEach((n,i)=>{ const ns=nombres(n); if(!ns.length || !ns.every(k=>RE.test(k))) return;
  // con su comentario de arriba: desde el fin de la sentencia anterior
  let a=i?ast.body[i-1].end:0; const gap=src.slice(a,n.start); const nl=gap.indexOf('\n'); if(nl>=0) a+=nl+1;
  tramos.push([a,n.end,ns]); });
let resto='', ult=0, modulo='';
for(const [a,b] of tramos){ resto+=src.slice(ult,a); modulo+=src.slice(a,b)+'\n'; ult=b; }
resto+=src.slice(ult);
const cab=`/* ── ${mod} ─────────────────────────────────────────────────────────────
   Separado de index.html el 17/10/2026 (paso 2 del plan del 23/09: partir el
   archivo de a una parte por vez, sin reescribir nada). Es el mismo codigo,
   en el mismo orden, con las mismas funciones globales: los onclick="" del
   HTML las siguen encontrando.

   ⚠️  SE CARGA ANTES QUE EL SCRIPT PRINCIPAL. Lo que el principal ejecuta al
   arrancar (timers, listeners) usa estas funciones, asi que tienen que
   existir primero. Por lo mismo, aca no puede haber nada que al CARGAR use
   algo del principal: solo declaraciones. */
`;
fs.writeFileSync(modF, cab+modulo);
const tag=`<script src="js/${pub}?v=DEV"></script>\n`;
const outHtml=html.slice(0,ab)+tag+html.slice(ab,ini)+resto+html.slice(ci);
fs.writeFileSync(outF,outHtml);
// comprobacion: mismas declaraciones, ni una mas ni una menos
const a2=acorn.parse(resto,{ecmaVersion:'latest'}), m2=acorn.parse(cab+modulo,{ecmaVersion:'latest'});
const despues=[...a2.body.flatMap(nombres),...m2.body.flatMap(nombres)];
const faltan=[...todos].filter(k=>!despues.includes(k)), sobran=despues.length-todosArr.length;
console.log(modF.split('/').pop(),'| movidas:',tramos.length,'| lineas modulo:',(cab+modulo).split('\n').length,'| faltan:',faltan,'| diferencia de cantidad:',sobran);
if(faltan.length||sobran) process.exit(1);
