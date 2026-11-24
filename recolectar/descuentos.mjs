#!/usr/bin/env node
// Rinde · lector semanal de descuentos de bancos (páginas oficiales de beneficios)
// node recolector/descuentos.mjs
// Lee las páginas de beneficios de cada banco, detecta los descuentos en supermercados y farmacias
// y actualiza descuentos.json. GitHub lo propone como "Pull request" para que el equipo lo apruebe con un clic.
// Reglas con "revisar" NO se usan en la app hasta que alguien las corrige y borra ese campo.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, '..');
const OVERRIDE = process.env.RINDE_HOST_OVERRIDE || '';
const PAUSA = +(process.env.RINDE_PAUSA_MS || 1200);
const MAX_LINKS = +(process.env.RINDE_MAX_LINKS || 40);
const HOY = new Date().toISOString().slice(0, 10);
const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fold = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/* ---------- bancos y páginas oficiales ----------
   inicio: páginas que se leen; seguir: patrón de links (del mismo sitio) que también se abren.
   tarjetas: qué tarjeta de Rinde corresponde según el texto (débito / crédito). */
const BANCOS = {
  bancoestado: {
    nombre: 'BancoEstado',
    inicio: ['https://www.bancoestado.cl/content/bancoestado-public/cl/es/home/home/todosuma---bancoestado-personas/todos-beneficios.html'],
    seguir: /beneficio|todosuma|supermercado|farmacia|unimarc|lider|jumbo|santa-isabel|tottus|acuenta|cruz-verde|salcobrand|ahumada/i,
    tarjetas: { debito: ['bestado'], credito: ['bestado-cr'] },
  },
  bancochile: {
    nombre: 'Banco de Chile',
    inicio: ['https://sitiospublicos.bancochile.cl/personas/beneficios'],
    seguir: /\/beneficios\/(detalle|promociones)\//i,
    tarjetas: { debito: ['bch-deb'], credito: ['bch'] },
  },
  santander: {
    nombre: 'Santander',
    inicio: Array.from({ length: 20 }, (_, i) => `https://banco.santander.cl/beneficios/promociones?page=${i + 1}`),
    seguir: /\/beneficios\/promociones\/[a-z0-9-]+/i,
    tarjetas: { debito: ['santander-deb'], credito: ['santander'] },
  },
  cencosud: {
    nombre: 'Tarjeta Cencosud Scotiabank',
    inicio: ['https://www.tarjetacencosud.cl/publico/beneficios/landing/descuentos-cencosud', 'https://www.tarjetacencosud.cl/publico/beneficios/landing/cupon-jumbo-santa-isabel', 'https://www.tarjetacencosud.cl/publico/beneficios/landing/rincon-jumbo'],
    seguir: /\/publico\/beneficios\/landing\//i,
    tarjetas: { debito: ['cencosud'], credito: ['cencosud'] },
  },
  falabella: {
    nombre: 'Banco Falabella / CMR',
    inicio: ['https://www.bancofalabella.cl/descuentos'],
    seguir: /\/descuentos\/detalle\//i,
    tarjetas: { debito: ['falabella-deb'], credito: ['cmr'] },
  },
  bci: {
    nombre: 'Bci / Lider Bci',
    inicio: ['https://www.bci.cl/beneficios', 'https://www.bci.cl/beneficios/beneficios-bci'],
    seguir: /beneficio/i,
    tarjetas: { debito: ['bci-deb'], credito: ['bci-cr'] },
  },
  scotiabank: {
    nombre: 'Scotiabank',
    inicio: ['https://www.scotiabankchile.cl/Personas/beneficios', 'https://www.scotiabankchile.cl/beneficios'],
    seguir: /beneficio/i,
    tarjetas: { debito: ['scotia-deb'], credito: ['scotia'] },
  },
  itau: {
    nombre: 'Itaú',
    inicio: ['https://itaubeneficios.cl/', 'https://www.itau.cl/personas/beneficios'],
    seguir: /beneficio|descuento|supermercado|farmacia/i,
    tarjetas: { debito: ['itau-deb'], credito: ['itau'] },
  },
  coopeuch: { nombre: 'Coopeuch', inicio: ['https://www.coopeuch.cl/beneficios'], seguir: /beneficio/i, tarjetas: { debito: ['coopeuch'], credito: ['coopeuch'] } },
  tenpo: { nombre: 'Tenpo', inicio: ['https://www.tenpo.cl/beneficios'], seguir: /beneficio/i, tarjetas: { debito: ['tenpo'], credito: ['tenpo'] } },
};

const CADENAS = [
  ['lider', /\b(super ?)?lider\b|express de lider/], ['jumbo', /\bjumbo\b/], ['santaisabel', /santa isabel/], ['unimarc', /\bunimarc\b/],
  ['tottus', /\btottus\b/], ['acuenta', /\bacuenta\b|a cuenta super/], ['cruzverde', /cruz verde/], ['salcobrand', /salcobrand/],
  ['ahumada', /\bahumada\b/], ['simi', /dr\.? ?simi|farmacias similares/],
];
const DIAS = [['domingo', 0], ['lunes', 1], ['martes', 2], ['miercoles', 3], ['jueves', 4], ['viernes', 5], ['sabado', 6]];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/* ---------- red ---------- */
function reescribe(u) { if (!OVERRIDE) return u; const x = new URL(u); return `${OVERRIDE}/${x.host}${x.pathname}${x.search}`; }
async function pide(u) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), 20000);
  try {
    const r = await fetch(reescribe(u), { signal: c.signal, redirect: 'follow', headers: { 'user-agent': UA, 'accept-language': 'es-CL,es;q=0.9', accept: 'text/html,application/json;q=0.9,*/*;q=0.8' } });
    return { status: r.status, body: await r.text() };
  } finally { clearTimeout(t); }
}

/* ---------- texto ---------- */
function decode(s) {
  return s.replace(/&nbsp;/g, ' ').replace(/&quot;|&#34;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&aacute;/g, 'á').replace(/&eacute;/g, 'é').replace(/&iacute;/g, 'í').replace(/&oacute;/g, 'ó').replace(/&uacute;/g, 'ú').replace(/&ntilde;/g, 'ñ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&');
}
function textoDeHtml(html) {
  const t = html.replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/?(p|div|li|h[1-6]|br|tr|section|article|header|footer|ul|ol|span class="[^"]*title[^"]*")\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decode(t).split('\n').map(x => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
}
function jsonDeHtml(html) {
  const out = [];
  for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const t = m[1].trim(); if (t.length < 30) continue;
    const i = t.search(/[{[]/), j = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
    if (i >= 0 && j > i) { try { out.push(JSON.parse(t.slice(i, j + 1))); } catch {} }
  }
  return out;
}
// Objetos JSON con textos (título, descripción, legal) → un bloque por objeto
function bloquesJson(raiz) {
  const out = [];
  (function walk(o, d) {
    if (!o || typeof o !== 'object' || d > 30) return;
    if (Array.isArray(o)) { o.forEach(x => walk(x, d + 1)); return; }
    const strs = Object.values(o).filter(v => typeof v === 'string' && v.length >= 3 && v.length < 4000 && !/^https?:|^\/|^[\w-]+$/.test(v));
    const txt = decode(strs.join(' · ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
    if (txt.length >= 25 && /%/.test(txt)) out.push(txt);
    Object.values(o).forEach(v => { if (v && typeof v === 'object') walk(v, d + 1); });
  })(raiz, 0);
  return out;
}
// Ventanas de líneas alrededor de cada mención de una cadena
function bloquesTexto(lineas) {
  const out = [];
  lineas.forEach((l, i) => {
    const f = fold(l).replace(/lider ?bci/g, '');
    if (CADENAS.some(([, re]) => re.test(f))) out.push(lineas.slice(Math.max(0, i - 3), i + 7).join(' · '));
  });
  return out;
}

/* ---------- interpretar un beneficio ---------- */
const limpia = t => decode(String(t)).replace(/<[^>]*>/g, ' ').replace(/\\[rnt]/g, ' ').replace(/[\w:-]+="[^"]*"/g, ' ')
  .replace(/["{}\[\]<>]+/g, ' ').replace(/(\s*·\s*)+/g, ' · ').replace(/\s+/g, ' ').trim();
const num = s => +String(s).replace(/\./g, '').replace(/,\d+$/, '');
function fechaDe(f) {
  const hoy = new Date();
  let m = f.match(/(?:hasta|vence|vigencia[^0-9]{0,20}al?|al)\s+(?:el\s+)?(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)(?:\s+(?:de|del)\s+(\d{4}))?/);
  if (m) {
    const mes = MESES.indexOf(m[2]); let y = m[3] ? +m[3] : hoy.getFullYear();
    if (!m[3] && mes < hoy.getMonth() - 6) y++;
    return `${y}-${String(mes + 1).padStart(2, '0')}-${String(+m[1]).padStart(2, '0')}`;
  }
  m = f.match(/(?:hasta|vence|al)\s+(?:el\s+)?(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})/);
  if (m) { const y = m[3].length === 2 ? 2000 + +m[3] : +m[3]; return `${y}-${String(+m[2]).padStart(2, '0')}-${String(+m[1]).padStart(2, '0')}`; }
  return '';
}
function diasDe(f) {
  if (/todos los dias|todos los días|cualquier dia|7 dias/.test(f)) return [0, 1, 2, 3, 4, 5, 6];
  const set = new Set();
  if (/fines? de semana/.test(f)) { set.add(6); set.add(0); }
  for (const m of f.matchAll(/de (lunes|martes|miercoles|jueves|viernes|sabado|domingo) a (lunes|martes|miercoles|jueves|viernes|sabado|domingo)/g)) {
    const a = DIAS.find(d => d[0] === m[1])[1], b = DIAS.find(d => d[0] === m[2])[1];
    for (let k = a; ; k = (k + 1) % 7) { set.add(k); if (k === b) break; }
  }
  for (const [n, k] of DIAS) if (new RegExp(`\\b${n}(s|es)?\\b`).test(f)) set.add(k);
  return [...set].sort();
}
function interpreta(bloque, banco, fuente) {
  const f = fold(limpia(bloque));
  const sinCard = f.replace(/lider ?bci/g, '');
  const chains = CADENAS.filter(([, re]) => re.test(sinCard)).map(([id]) => id);
  if (!chains.length || chains.length > 4) return null;
  // el % que está más cerca de la cadena, sin cruzar a otro rubro (restaurantes, combustible…)
  const segs = f.split(' · ');
  const conCadena = segs.map(x => CADENAS.some(([, re]) => re.test(x.replace(/lider ?bci/g, ''))));
  const OTRO = /restaurant|cine|combustible|copec|shell|viaje|vestuario|ropa|tecnolog|hotel|delivery|comida|bencina|zapatilla|gimnasio/;
  let pct = 0, dist = 99;
  segs.forEach((x, i) => {
    const m = x.match(/(\d{1,2})\s?%/); if (!m) return;
    if (OTRO.test(x) && !conCadena[i]) return;
    const d = Math.min(...conCadena.map((c, j) => c ? Math.abs(i - j) : 99));
    if (d < dist && d <= 2) { dist = d; pct = +m[1]; }
  });
  if (!pct) return null;
  if (pct < 2 || pct > 60) return null;
  const tm = f.match(/tope[^$\d]{0,40}\$\s?([\d.]+)/) || f.match(/maximo de descuento[^$\d]{0,20}\$\s?([\d.]+)/);
  const mm = f.match(/compras? (?:minima|sobre|desde|superiores? a|mayores? a|igual o superior a)[^$\d]{0,25}\$\s?([\d.]+)/) || f.match(/monto minimo[^$\d]{0,25}\$\s?([\d.]+)/);
  const days = diasDe(f);
  const deb = /debito|cuentarut|cuenta rut|rutpay|prepago/.test(f), cre = /credito/.test(f);
  const B = BANCOS[banco];
  let cards = deb && !cre ? B.tarjetas.debito : cre && !deb ? B.tarjetas.credito : [...new Set([...B.tarjetas.debito, ...B.tarjetas.credito])];
  if (/lider ?bci/.test(f)) cards = ['bci'];
  const noOnline = /no (aplica|es valido|valido|considera)[^.]{0,25}(online|app|web|internet|despacho)/.test(f);
  const soloOnline = !noOnline && (/(solo|exclusiv\w*|solamente|unicamente)[^.]{0,30}(online|app|sitio web|web|despacho|internet)/.test(f) || /(compras?|pagando)[^.]{0,15}(online|en la app|por internet|en el sitio web)/.test(f)) && !/tienda|presencial|sala|local/.test(f);
  const devolucion = /devolucion|cashback/.test(f);
  const hasta = fechaDe(f);
  const revisar = [];
  if (!days.length) revisar.push('no se detectaron los días');
  if (/hasta (el )?\d{1,2} ?%/.test(f)) revisar.push('el % dice "hasta": confirmar el porcentaje real');
  if (chains.length > 2) revisar.push('menciona varias cadenas: confirmar en cuáles aplica');
  const r = {
    banco, card: null, cards, chains, days, pct,
    tope: tm ? num(tm[1]) : 0, min: mm ? num(mm[1]) : 0,
    hasta, fuente, texto: limpia(bloque).slice(0, 260), detectado: HOY, auto: true,
  };
  if (devolucion) r.tipo = 'devolución';
  if (soloOnline) r.soloOnline = true;
  if (revisar.length) r.revisar = revisar.join('; ');
  r.id = crypto.createHash('sha1').update([banco, cards.join(), chains.join(), days.join(), pct, r.tope].join('|')).digest('hex').slice(0, 10);
  return r;
}

/* ---------- recorrido por banco ---------- */
async function leeBanco(id, B, diag) {
  const vistos = new Set(), cola = [...B.inicio], reglas = new Map();
  let paginas = 0, ok = 0;
  while (cola.length && paginas < B.inicio.length + MAX_LINKS) {
    const u = cola.shift(); if (vistos.has(u)) continue; vistos.add(u); paginas++;
    let res;
    try { res = await pide(u); } catch (e) { diag.paginas.push({ url: u, error: String(e.message || e).slice(0, 120) }); continue; }
    const d = { url: u, status: res.status };
    diag.paginas.push(d);
    if (res.status >= 400) { await sleep(PAUSA); continue; }
    ok++;
    const esInicio = B.inicio.includes(u);
    const bloques = bloquesTexto(textoDeHtml(res.body)).map(t => ({ t, debil: esInicio }));
    for (const j of jsonDeHtml(res.body)) bloques.push(...bloquesJson(j).map(t => ({ t })));
    if (/^\s*[{[]/.test(res.body)) { try { bloques.push(...bloquesJson(JSON.parse(res.body)).map(t => ({ t }))); } catch {} }
    let n = 0;
    for (const b of bloques) { const r = interpreta(b.t, id, u); if (r && !reglas.has(r.id)) { if (b.debil) r.debil = true; reglas.set(r.id, r); n++; } }
    d.beneficios = n;
    if (!n) { // pistas para ajustar: título, tamaño y direcciones de datos que usa la página
      d.titulo = (res.body.match(/<title[^>]*>([^<]{0,120})/i) || [])[1] || '';
      d.largo = res.body.length;
      d.pistas = [...new Set([...res.body.matchAll(/["'(]((?:https?:)?\/\/[^"'()\s]{6,200}|\/[^"'()\s]{3,200})["')]/g)].map(m => m[1])
        .filter(x => /api|graphql|\.json|beneficio|promocion|descuento|contentful|strapi|cms|wp-json|algolia/i.test(x) && !/\.(png|jpe?g|svg|webp|gif|css|woff2?)(\?|$)/i.test(x)))].slice(0, 25);
    }
    if (B.inicio.includes(u)) {
      // Links a cada beneficio: de etiquetas <a> y también de textos JSON dentro de la página (sitios hechos con JavaScript)
      const base = new URL(u), cands = new Map();
      const mira = (raw, texto) => {
        let href; try { href = new URL(decode(raw).replace(/\\\//g, '/').replace(/\\+$/, ''), u).href.split('#')[0]; } catch { return; }
        if (new URL(href).host !== base.host || vistos.has(href) || cola.includes(href) || !B.seguir.test(href)) return;
        const txt = fold(texto + ' ' + href).replace(/[-_/]+/g, ' ');
        const p = CADENAS.some(([, re]) => re.test(txt)) ? 2 : /supermercado|farmacia/.test(txt) ? 1 : 0;
        if (p) cands.set(href, Math.max(p, cands.get(href) || 0));
      };
      for (const m of res.body.matchAll(/<a\b[^>]*href="([^"#]+)"[^>]*>([\s\S]{0,300}?)<\/a>/gi)) mira(m[1], m[2].replace(/<[^>]+>/g, ' '));
      for (const m of res.body.matchAll(/["'](\/[^"'\s<>]{3,200}|https?:\/\/[^"'\s<>]{6,200})["']/g)) mira(m[1], '');
      [...cands.entries()].sort((a, b) => b[1] - a[1]).forEach(([h]) => cola.push(h));
    }
    await sleep(PAUSA);
  }
  diag.leidas = ok;
  // Lo leído en la portada (texto suelto) se descarta si la página propia del beneficio dio esa misma cadena
  const todas = [...reglas.values()];
  const fuertes = new Set(todas.filter(r => !r.debil).flatMap(r => r.chains));
  const final = todas.filter(r => !r.debil || !r.chains.some(c => fuertes.has(c))).map(({ debil, ...r }) => r);
  return ok ? final : null; // null = no se pudo leer el banco (no se borra nada suyo)
}

async function main() {
  const archivo = path.join(ROOT, 'descuentos.json');
  let actual = { reglas: [] };
  try { actual = JSON.parse(fs.readFileSync(archivo, 'utf8')); } catch {}
  const diag = {}, nuevas = {}, leidos = new Set();
  await Promise.all(Object.entries(BANCOS).map(async ([id, B]) => {
    diag[id] = { paginas: [] };
    try { const r = await leeBanco(id, B, diag[id]); if (r) { nuevas[id] = r; leidos.add(id); } }
    catch (e) { diag[id].error = String(e.message || e); }
    console.log(`✔ ${B.nombre}: ${leidos.has(id) ? (nuevas[id] || []).length + ' beneficios en super/farmacia' : 'no se pudo leer'}`);
  }));

  // Un mismo beneficio suele aparecer varias veces en la página (título, detalle, legal): se juntan en una sola regla
  for (const id of Object.keys(nuevas)) {
    const g = new Map();
    for (const r of nuevas[id]) {
      const k = [r.cards.join(), r.chains.join(), r.pct, r.fuente].join('|');
      const a = g.get(k);
      if (!a) { g.set(k, { ...r }); continue; }
      if (!a.days.length && r.days.length) a.days = r.days;
      a.tope = Math.max(a.tope, r.tope); a.min = Math.max(a.min, r.min);
      if (!a.hasta && r.hasta) a.hasta = r.hasta;
      if (r.soloOnline === undefined) delete a.soloOnline;
      if (r.texto.length > a.texto.length && /\d\s?%/.test(r.texto)) a.texto = r.texto;
    }
    nuevas[id] = [...g.values()].map(r => {
      const rev = String(r.revisar || '').split('; ').filter(x => x && !(x.includes('días') && r.days.length));
      if (rev.length) r.revisar = rev.join('; '); else delete r.revisar;
      r.id = crypto.createHash('sha1').update([r.banco, r.cards.join(), r.chains.join(), r.pct, r.fuente].join('|')).digest('hex').slice(0, 10);
      return r;
    });
  }
  // Expandir a una regla por tarjeta (la app usa una tarjeta por regla)
  const detectadas = [];
  for (const id of Object.keys(nuevas)) for (const r of nuevas[id]) for (const c of r.cards) {
    const { cards, ...x } = r; detectadas.push({ ...x, card: c, id: r.id + '-' + c });
  }
  const viejas = actual.reglas || [];
  const porId = new Map(viejas.map(r => [r.id, r]));
  const vence = r => r.hasta && r.hasta < HOY;
  const final = [], agregadas = [], quitadas = [];
  for (const r of viejas) {
    if (vence(r)) { quitadas.push([r, 'venció']); continue; }
    if (r.auto && leidos.has(r.banco) && !detectadas.some(x => x.id === r.id)) { quitadas.push([r, 'ya no aparece en la página del banco']); continue; }
    final.push(r);
  }
  for (const r of detectadas) {
    if (vence(r) || porId.has(r.id)) continue;
    final.push(r); agregadas.push(r);
  }
  const salida = { ...actual, actualizado: HOY, reglas: final };
  delete salida.ejemplo;
  if (!actual.nota) salida.nota = 'Descuentos verificados por el equipo. Reglas con "revisar" no se usan hasta corregirlas y borrar ese campo.';
  fs.writeFileSync(archivo, JSON.stringify(salida, null, 1));
  fs.writeFileSync(path.join(DIR, 'descuentos-diagnostico.json'), JSON.stringify({ fecha: new Date().toISOString(), bancos: diag }, null, 1));

  const N = c => (globalThis.CHAIN_N || {})[c] || c;
  const dtxt = d => d.length === 7 ? 'todos los días' : d.map(k => DIAS.find(x => x[1] === k)[0]).join(', ') || '¿?';
  let md = `## Descuentos de bancos · semana del ${HOY}\n\n`;
  md += `Revisa cada línea con su link oficial. Si todo está bien, aprieta **Merge pull request**. Las marcadas ⚠️ no se usan en la app hasta que alguien edite \`descuentos.json\`, corrija el dato y borre el campo \`revisar\`.\n\n`;
  md += `### Nuevos (${agregadas.length})\n\n| Tarjeta | % | Días | Tope | Mín. | Dónde | Vence | Fuente |\n|---|---|---|---|---|---|---|---|\n`;
  for (const r of agregadas) md += `| ${r.revisar ? '⚠️ ' : ''}${r.card} | ${r.pct}%${r.tipo ? ' (' + r.tipo + ')' : ''}${r.soloOnline ? ' solo online' : ''} | ${dtxt(r.days)} | ${r.tope ? '$' + r.tope.toLocaleString('es-CL') : '-'} | ${r.min ? '$' + r.min.toLocaleString('es-CL') : '-'} | ${r.chains.map(N).join(', ')} | ${r.hasta || '-'} | [link](${r.fuente}) |\n`;
  if (agregadas.some(r => r.revisar)) md += `\n⚠️ Por revisar:\n` + agregadas.filter(r => r.revisar).map(r => `- ${r.card} ${r.pct}% en ${r.chains.join(', ')}: ${r.revisar}. Texto: "${r.texto.replace(/\|/g, '/')}"`).join('\n') + '\n';
  md += `\n### Se quitan (${quitadas.length})\n\n` + (quitadas.map(([r, why]) => `- ${r.card} ${r.pct}% en ${r.chains.join(', ')} (${why})`).join('\n') || '-') + '\n';
  md += `\n### Bancos leídos\n\n` + Object.entries(BANCOS).map(([id, B]) => `- ${B.nombre}: ${leidos.has(id) ? `${(nuevas[id] || []).length} beneficios (${diag[id].leidas} páginas)` : 'no se pudo leer (sus descuentos se mantienen)'}`).join('\n') + '\n';
  fs.writeFileSync(path.join(DIR, 'descuentos-pr.md'), md);
  console.log('\n' + md);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
}
main().catch(e => { console.error(e); process.exit(1); });
