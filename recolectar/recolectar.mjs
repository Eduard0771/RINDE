#!/usr/bin/env node
// Rinde · recolector de precios web
// Corre 1 vez al día (GitHub Actions) o a mano:  node recolector/recolectar.mjs [--prueba] [--cadenas=jumbo,lider]
// Lee el catálogo desde index.html, busca cada producto en las páginas web de cada cadena,
// elige el producto equivalente (misma marca, variedad y tamaño) y guarda precios.json en la raíz.
// No necesita instalar nada: solo Node 20 o más nuevo.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, '..');
const ARGS = process.argv.slice(2);
const PRUEBA = ARGS.includes('--prueba');
const SOLO = (ARGS.find(a => a.startsWith('--cadenas=')) || '').slice(10).split(',').filter(Boolean);
const OVERRIDE = process.env.RINDE_HOST_OVERRIDE || ''; // solo para pruebas locales
const PAUSA = +(process.env.RINDE_PAUSA_MS || 900);      // pausa entre búsquedas en la misma cadena
const HOY = new Date().toISOString().slice(0, 10);
const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const log = (...a) => console.log(...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------------- catálogo ---------------- */
function catalogo() {
  const s = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const a = s.indexOf('const P=[');
  if (a < 0) throw new Error('No encontré el catálogo ("const P=[") en index.html');
  const b = s.indexOf('\n];', a);
  const P = new Function('return ' + s.slice(a + 8, b + 3))();
  return P.map(r => {
    const tags = r[9] || [];
    return { id: r[0], name: r[1], brand: r[2], size: r[3], cat: r[4], tags,
      where: tags.includes('farm') ? 'farm' : tags.includes('ambos') ? 'ambos' : 'super' };
  });
}

/* ---------------- texto ---------------- */
const fold = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const compact = s => fold(s).replace(/[^a-z0-9]/g, '');
const STOP = new Set('de del la las el los con en y para x al a por'.split(' '));
const UNITW = /^(kg|kilos?|grs?|gramos|g|litros?|lts?|lt|l|ml|cc|cm3|mg|un|u|und|unid|unids|unidad|unidades|comprimidos?|comp|capsulas?|caps|tabletas?|rollos?|bolsitas?|sobres?|panales|toallitas)$/;
const words = s => fold(s).replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(w => w && !STOP.has(w) && !/^\d/.test(w) && !UNITW.test(w));
const UNIT = {
  kg: ['g', 1000], kilo: ['g', 1000], kilos: ['g', 1000], g: ['g', 1], gr: ['g', 1], grs: ['g', 1], gramos: ['g', 1],
  l: ['ml', 1000], lt: ['ml', 1000], lts: ['ml', 1000], litro: ['ml', 1000], litros: ['ml', 1000], ml: ['ml', 1], cc: ['ml', 1], cm3: ['ml', 1],
  mg: ['mg', 1],
};
const CUENTA = /^(un|u|und|unid|unids|unidad|unidades|comprimidos?|comp|capsulas?|caps|tabletas?|rollos?|bolsitas?|sobres?|panales|toallitas)$/;
function sizes(s) {
  const out = [];
  const t = fold(s).replace(/(\d),(\d)/g, '$1.$2');
  const re = /(\d+(?:\.\d+)?)\s*(kg|kilos?|grs?|gramos|g|litros?|lts?|lt|l|ml|cc|cm3|mg|unidades|unidad|unids?|und|un|u|comprimidos?|comp|capsulas?|caps|tabletas?|rollos?|bolsitas?|sobres?|panales|toallitas)(?![a-z])/g;
  let m;
  while ((m = re.exec(t))) {
    const v = +m[1], u = m[2];
    if (UNIT[u]) out.push({ v: v * UNIT[u][1], u: UNIT[u][0] });
    else if (CUENTA.test(u)) out.push({ v, u: 'un' });
  }
  // "x 16", "x16" (cantidad) cuando no viene seguido de una unidad de peso o volumen
  const re2 = /\bx\s*(\d+)(?![.\d])(?!\s*(?:kg|g|grs?|gramos|ml|cc|l|lt|lts|litros?|mg)(?![a-z]))/g;
  while ((m = re2.exec(t))) out.push({ v: +m[1], u: 'un' });
  return out;
}
const near = (a, b) => Math.abs(a - b) <= Math.max(a, b) * 0.03;
const VARIANTES = ['sin lactosa', 'sin azucar', 'entera', 'lactosa', 'light', 'zero', 'descremad', 'semidescremad', 'diet', 'integral', 'organic', 'infantil', 'forte', 'nocturn', 'retard', 'kids', 'proteina', 'vegan'];

function prepara(p) {
  const core = p.name.replace(/·.*/, '').trim();
  const generico = /^gen[eé]rico$/i.test(p.brand), granel = /^granel$/i.test(p.brand);
  const sz = sizes(p.size)[0] || null;
  const dosis = sizes(p.name).filter(x => x.u === 'mg').map(x => x.v);
  const ws = [...new Set(words(core))];
  const q = generico || granel ? core : `${p.brand} ${core}`;
  return { ...p, core, generico, granel, sz, dosis, ws, q, brandC: compact(p.brand), foldAll: fold(p.name + ' ' + p.brand) };
}

function tienePalabra(cands, w) {
  const need = Math.min(w.length, Math.max(4, w.length - 2));
  return cands.some(c => { let i = 0; while (i < c.length && i < w.length && c[i] === w[i]) i++; return i >= need || (i === c.length && c.length >= 4 && i === w.length); });
}

// ¿Este producto de la tienda es el mismo que el nuestro? Devuelve un puntaje (mayor = mejor) o -1.
function coincide(pp, c) {
  const texto = `${c.name} ${c.brand || ''}`;
  const cw = words(texto);
  if (!pp.generico && !pp.granel && pp.brandC && !compact(texto).includes(pp.brandC)) return -1;
  const faltan = pp.ws.filter(w => !tienePalabra(cw, w)).length;
  if (faltan > Math.floor((pp.ws.length - 1) / 4)) return -1;
  const ft = fold(texto);
  for (const v of VARIANTES) if (ft.includes(v) !== pp.foldAll.includes(v)) return -1; // variedad distinta (entera, sin lactosa, light…)
  const cs = sizes(`${c.name} ${c.extra || ''}`);
  for (const d of pp.dosis) if (!cs.some(x => x.u === 'mg' && near(x.v, d))) return -1;
  if (pp.sz && !(pp.sz.u === 'un' && pp.sz.v === 1)) {
    const mismos = cs.filter(x => x.u === pp.sz.u);
    if (mismos.length) { if (!mismos.some(x => near(x.v, pp.sz.v))) return -1; }
    else if (!(pp.granel && pp.sz.u === 'g' && !cs.some(x => x.u !== 'mg'))) return -1; // sin tamaño visible: no arriesgamos un precio equivocado
  }
  const extra = cw.filter(w => !tienePalabra(pp.ws.concat(words(pp.brand)), w)).length;
  return 10 - faltan * 2 - extra * 0.3;
}

/* ---------------- precios ---------------- */
function clp(x) {
  if (Array.isArray(x)) x = x[0];
  if (typeof x === 'number') return Number.isFinite(x) ? Math.round(x) : null;
  if (typeof x !== 'string') return null;
  let s = x.replace(/[^\d.,]/g, '');
  if (!s) return null;
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '').replace(/,.*/, '');
  else if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '').replace(/\..*/, '');
  else s = s.replace(',', '.');
  const v = Math.round(parseFloat(s));
  return Number.isFinite(v) ? v : null;
}
const okPrecio = v => v != null && v >= 50 && v <= 2000000;
const TARJETA = [[/cmr/i, 'cmr'], [/cencosud/i, 'cencosud'], [/tlmc|lider.?bci|tarjeta.?lider/i, 'bci']];
const LISTA = /list|normal|regular|old|before|antes|reference|referencia|was|withoutdiscount|sindescuento/i;
const NO_PRECIO = /per|unit|ppum|tax|iva|cuota|install|discount|ahorro|percent|porcentaje|currency|symbol|format|type|count|range|max|min|kilo|litro|medida|label|text|html/i;

function preciosDe(o, depth = 0, acc = { now: [], list: [], card: {} }) {
  if (!o || typeof o !== 'object' || depth > 4) return acc;
  if (Array.isArray(o)) { for (const x of o.slice(0, 6)) preciosDe(x, depth + 1, acc); return acc; }
  // forma {type:'cmrPrice', price:['1.290']} (Falabella/Tottus) o {name:'Tarjeta Cencosud', value: 1290}
  const tipo = typeof o.type === 'string' ? o.type : typeof o.priceType === 'string' ? o.priceType : '';
  for (const [k, v] of Object.entries(o)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) { preciosDe(v, depth + 1, acc); continue; }
    if (Array.isArray(v) && v.some(x => x && typeof x === 'object')) { preciosDe(v, depth + 1, acc); continue; }
    if (!/price|precio/i.test(k)) continue;
    const etiqueta = tipo + ' ' + k;
    const val = clp(v);
    if (!okPrecio(val)) continue;
    const t = TARJETA.find(([re]) => re.test(etiqueta));
    if (t) { acc.card[t[1]] = Math.min(acc.card[t[1]] || Infinity, val); continue; }
    if (LISTA.test(etiqueta)) { acc.list.push(val); continue; }
    if (NO_PRECIO.test(k)) continue;
    acc.now.push(val);
  }
  return acc;
}

const NAMEK = ['productName', 'displayName', 'nameComplete', 'name', 'title', 'productTitle', 'nombre'];
const IMGK = /^(image|imageUrl|images|defaultImage|mediaUrls|thumbnail|img|imagen|imagenes|picture|photo|mainImage)$/i;
const EANK = /^(ean|ean13|gtin|gtin13|gtin14|gtin8|barcode|upc|codigoBarra|codigo_barra|ean_code)$/i;
const URLK = /^(url|link|href|productUrl|pdpUrl|linkText)$/i;
const BRANDK = /^(brand|marca|brandName)$/i;
const SIZEK = /size|format|presentacion|contenido|measurement|medida|unidad|netContent|volume|peso|weight/i;

function primerTexto(v) {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) { for (const x of v) { const t = primerTexto(x); if (t) return t; } return ''; }
  if (v && typeof v === 'object') return primerTexto(v.url || v.imageUrl || v.src || v.href || v.name || v.value || '');
  return '';
}
function buscaClave(o, re, depth = 0) {
  if (!o || typeof o !== 'object' || depth > 3) return null;
  const arr = Array.isArray(o) ? o.slice(0, 3) : Object.entries(o);
  if (Array.isArray(o)) { for (const x of arr) { const r = buscaClave(x, re, depth + 1); if (r != null) return r; } return null; }
  for (const [k, v] of arr) if (re.test(k) && v != null && v !== '') return v;
  for (const [, v] of arr) if (v && typeof v === 'object') { const r = buscaClave(v, re, depth + 1); if (r != null) return r; }
  return null;
}

function aCandidato(o) {
  let name = '';
  for (const k of NAMEK) if (typeof o[k] === 'string' && o[k].length >= 3 && o[k].length <= 180 && /[a-z]/i.test(o[k])) { name = o[k]; break; }
  if (!name) return null;
  const pr = preciosDe(o);
  if (!pr.now.length && !Object.keys(pr.card).length) return null;
  const v = pr.now.length ? Math.min(...pr.now) : Math.min(...Object.values(pr.card));
  const l = pr.list.length ? Math.max(...pr.list) : null;
  const eanRaw = buscaClave(o, EANK);
  const ean = eanRaw != null && /^\d{8,14}$/.test(String(eanRaw).trim()) ? String(eanRaw).trim() : null;
  let img = primerTexto(buscaClave(o, IMGK));
  if (img && img.startsWith('//')) img = 'https:' + img;
  if (img && !/^https?:\/\//.test(img)) img = '';
  let url = primerTexto(buscaClave(o, URLK));
  const brand = primerTexto(buscaClave(o, BRANDK));
  const extras = [];
  for (const [k, x] of Object.entries(o)) if (SIZEK.test(k) && (typeof x === 'string' || typeof x === 'number')) extras.push(`${x}`);
  const disp = buscaClave(o, /^(isAvailable|IsAvailable|available|inStock|availability)$/);
  const agotado = disp === false || (typeof disp === 'string' && /outofstock|soldout|agotado/i.test(disp));
  const card = Object.fromEntries(Object.entries(pr.card).filter(([, x]) => x < v));
  return { name, brand, v, l: l && l > v ? l : null, card, ean, img, url, extra: extras.join(' '), agotado };
}

function escanea(raiz) {
  // Recorre cualquier JSON y saca los objetos que parecen productos (nombre + precio).
  // Primero mira los hijos: si un objeto contiene productos, el objeto mismo no se cuenta como producto.
  const out = [];
  const visto = new Set();
  (function walk(o, depth) {
    if (!o || typeof o !== 'object' || depth > 40 || out.length > 300) return 0;
    let n = 0;
    if (Array.isArray(o)) { for (const x of o) n += walk(x, depth + 1); return n; }
    for (const v of Object.values(o)) if (v && typeof v === 'object') n += walk(v, depth + 1);
    if (n) return n;
    const c = aCandidato(o);
    if (!c) return 0;
    const key = c.name + '|' + c.v;
    if (visto.has(key)) return 1;
    visto.add(key); out.push(c); return 1;
  })(raiz, 0);
  return out;
}

// Formato VTEX (Jumbo, Santa Isabel, Unimarc, Dr. Simi…): lo leemos directo porque es muy común en Chile.
function vtexImg(u) { return u ? u.replace(/\/ids\/(\d+)(-\d+-\d+)?\//, '/ids/$1-300-300/') : ''; }
function leeVtex(arr, base) {
  const out = [];
  for (const p of arr) {
    if (!p || !Array.isArray(p.items)) continue;
    for (const it of p.items.slice(0, 3)) {
      const of = it.sellers && it.sellers[0] && it.sellers[0].commertialOffer;
      if (!of) continue;
      const v = clp(of.Price);
      if (!okPrecio(v)) continue;
      const l = clp(of.ListPrice || of.PriceWithoutDiscount);
      let url = p.link || (p.linkText ? `${base}/${p.linkText}/p` : '');
      if (url && url.startsWith('/')) url = base + url;
      out.push({
        name: it.nameComplete || p.productName || it.name || '', brand: p.brand || '', v, l: l && l > v ? l : null, card: {},
        ean: it.ean && /^\d{8,14}$/.test(it.ean) ? it.ean : null,
        img: vtexImg(it.images && it.images[0] && it.images[0].imageUrl),
        url, extra: [it.measurementUnit && it.unitMultiplier && it.measurementUnit !== 'un' ? `${it.unitMultiplier} ${it.measurementUnit}` : ''].join(' '),
        agotado: of.IsAvailable === false || of.AvailableQuantity === 0,
      });
    }
  }
  return out;
}

function decode(s) { return s.replace(/&quot;|&#34;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'); }
function jsonDeHtml(html) {
  const out = [];
  const intenta = t => { try { out.push(JSON.parse(t)); return true; } catch { return false; } };
  for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const t = m[1].trim();
    if (!t || t.length < 20) continue;
    if ((t[0] === '{' || t[0] === '[') && intenta(t)) continue;
    const s1 = t.match(/=\s*"((?:[^"\\]|\\.){40,})"\s*;?\s*$/); // window.__X = "{\"...\"}"
    if (s1) { try { const inner = JSON.parse('"' + s1[1] + '"'); if (intenta(inner)) continue; } catch {} }
    const i = t.search(/[{[]/), j = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
    if (i >= 0 && j > i) intenta(t.slice(i, j + 1));
  }
  for (const m of html.matchAll(/\sdata-[\w-]+=(?:'([^']{20,})'|"([^"]{20,})")/g)) {
    const t = decode(m[1] || m[2]).trim();
    if (t[0] === '{' || t[0] === '[') intenta(t);
  }
  return out;
}

/* ---------------- red ---------------- */
function reescribe(u) {
  if (!OVERRIDE) return u;
  const x = new URL(u);
  return `${OVERRIDE}/${x.host}${x.pathname}${x.search}`;
}
async function pide(u, op = {}) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 20000);
  try {
    const r = await fetch(reescribe(u), {
      ...op, signal: c.signal, redirect: 'follow',
      headers: { 'user-agent': UA, 'accept-language': 'es-CL,es;q=0.9', accept: 'application/json, text/html;q=0.9, */*;q=0.8', ...(op.headers || {}) },
    });
    const body = await r.text();
    return { status: r.status, body, ctype: r.headers.get('content-type') || '', headers: r.headers };
  } finally { clearTimeout(t); }
}
function lee(res, base) {
  const b = res.body.trim();
  if (b[0] === '[' || b[0] === '{') {
    let j; try { j = JSON.parse(b); } catch { return []; }
    if (Array.isArray(j) && j.length && j[0] && Array.isArray(j[0].items)) return leeVtex(j, base);
    if (j && Array.isArray(j.products) && j.products[0] && Array.isArray(j.products[0].items)) return leeVtex(j.products, base);
    return escanea(j);
  }
  const blobs = jsonDeHtml(res.body);
  const out = [];
  for (const j of blobs) {
    if (Array.isArray(j) && j[0] && Array.isArray(j[0].items)) out.push(...leeVtex(j, base));
    else out.push(...escanea(j));
  }
  return out;
}

/* ---------------- cadenas y fuentes ----------------
   Cada cadena prueba sus fuentes en orden y se queda con la primera que devuelve productos.
   Si una página cambia, basta agregar o corregir una línea aquí. */
const vtex = base => ({ tipo: 'vtex', base, url: q => `${base}/api/catalog_system/pub/products/search?ft=${q}&_from=0&_to=29` });
const vtexIS = base => ({ tipo: 'vtex-is', base, url: q => `${base}/api/io/_v/api/intelligent-search/product_search/?query=${q}&count=30&page=1&locale=es-CL` });
const web = (base, ruta) => ({ tipo: 'web', base, url: q => base + ruta.replaceAll('{q}', q) });
const liderBff = {
  tipo: 'lider-api', base: 'https://www.lider.cl',
  pedir: q => pide('https://apps.lider.cl/supermercado/bff/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-channel': 'SOD', tenant: 'supermercado', origin: 'https://www.lider.cl', referer: 'https://www.lider.cl/' },
    body: JSON.stringify({ query: decodeURIComponent(q), page: 1, facets: [], sortBy: '', hitsPerPage: 30 }),
  }),
};
let cvCookie = '';
const cruzVerdeApi = {
  tipo: 'cruzverde-api', base: 'https://www.cruzverde.cl',
  preparar: async () => {
    const r = await pide('https://api.cruzverde.cl/customer-service/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://www.cruzverde.cl' }, body: '{}' });
    const sc = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [r.headers.get('set-cookie') || ''];
    cvCookie = sc.map(x => x.split(';')[0]).filter(Boolean).join('; ');
  },
  pedir: q => pide(`https://api.cruzverde.cl/product-service/products/search?limit=40&offset=0&sort=&q=${q}`, { headers: { cookie: cvCookie, origin: 'https://www.cruzverde.cl' } }),
};

const CADENAS = {
  jumbo: { tipo: 'super', fuentes: [vtex('https://www.jumbo.cl'), vtexIS('https://www.jumbo.cl'), web('https://www.jumbo.cl', '/busqueda?ft={q}'), web('https://www.jumbo.cl', '/search?q={q}')] },
  santaisabel: { tipo: 'super', fuentes: [vtex('https://www.santaisabel.cl'), vtexIS('https://www.santaisabel.cl'), web('https://www.santaisabel.cl', '/busqueda?ft={q}'), web('https://www.santaisabel.cl', '/search?q={q}')] },
  lider: { tipo: 'super', pausa: 3500, fuentes: [liderBff, web('https://super.lider.cl', '/search?q={q}'), web('https://www.lider.cl', '/supermercado/search?query={q}')] },
  unimarc: { tipo: 'super', fuentes: [vtex('https://www.unimarc.cl'), vtexIS('https://www.unimarc.cl'), web('https://www.unimarc.cl', '/search?q={q}')] },
  tottus: { tipo: 'super', fuentes: [web('https://www.tottus.cl', '/tottus-cl/buscar?Ntt={q}'), web('https://www.tottus.cl', '/buscar?Ntt={q}')] },
  acuenta: { tipo: 'super', fuentes: [vtex('https://www.acuenta.cl'), web('https://www.acuenta.cl', '/search?q={q}')] },
  cruzverde: { tipo: 'farm', fuentes: [cruzVerdeApi, web('https://www.cruzverde.cl', '/search?q={q}')] },
  salcobrand: { tipo: 'farm', fuentes: [vtex('https://salcobrand.cl'), web('https://salcobrand.cl', '/search_result?query={q}'), web('https://salcobrand.cl', '/search?q={q}')] },
  ahumada: { tipo: 'farm', fuentes: [web('https://www.farmaciasahumada.cl', '/search?q={q}')] },
  simi: { tipo: 'farm', fuentes: [vtex('https://www.drsimi.cl'), vtexIS('https://www.drsimi.cl'), web('https://www.drsimi.cl', '/{q}?_q={q}&map=ft')] },
};
const PRUEBA_Q = { super: 'leche entera', farm: 'paracetamol' };

async function buscar(f, q) {
  const res = f.pedir ? await f.pedir(q) : await pide(f.url(q));
  if (res.status >= 400) return { status: res.status, items: [] };
  return { status: res.status, items: lee(res, f.base) };
}

async function eligeFuente(id, cad, diag) {
  for (const f of cad.fuentes) {
    const d = { tipo: f.tipo, url: f.url ? f.url(encodeURIComponent(PRUEBA_Q[cad.tipo])) : '(API)' };
    try {
      if (f.preparar) await f.preparar();
      const r = await buscar(f, encodeURIComponent(PRUEBA_Q[cad.tipo]));
      d.status = r.status; d.productos = r.items.length; d.ejemplos = r.items.slice(0, 4).map(x => `${x.name} · $${x.v}`);
    } catch (e) { d.error = String(e.message || e).slice(0, 160); }
    diag.pruebas.push(d);
    log(`  ${id} · ${f.tipo}: ${d.error ? 'error ' + d.error : `HTTP ${d.status}, ${d.productos} productos`}`);
    if (d.productos > 0) return f;
    await sleep(PAUSA);
  }
  return null;
}

async function recolectaCadena(id, cad, productos, diag) {
  const res = {};
  const f = await eligeFuente(id, cad, diag);
  if (!f) { diag.estado = 'sin acceso (ninguna fuente respondió con productos)'; return null; }
  diag.fuente = f.tipo;
  const lista = productos.filter(p => p.where === 'ambos' || p.where === cad.tipo);
  const todos = PRUEBA ? lista.slice(0, 6) : lista;
  let fallos = 0, n = 0;
  for (const p of todos) {
    n++;
    let items = [];
    try {
      const r = await buscar(f, encodeURIComponent(p.q));
      items = r.items;
      fallos = r.status >= 400 ? fallos + 1 : 0;
    } catch (e) { fallos++; }
    if (fallos >= 3 && fallos < 12) await sleep(20000); // la página pide calma: esperar y seguir
    if (fallos >= 12) { diag.estado = `cortado tras ${n} búsquedas (la página dejó de responder)`; break; }
    const ok = [];
    for (const c of items) { if (c.agotado) continue; const sc = coincide(p, c); if (sc >= 0) ok.push({ c, sc }); }
    let mejor = null;
    if (ok.length) {
      const top = Math.max(...ok.map(x => x.sc));
      // marca específica: el más parecido (empate → el más barato). Genérico o granel: el más barato de los que calzan bien.
      const buenos = ok.filter(x => x.sc >= top - (p.generico || p.granel ? 1.5 : 0));
      mejor = buenos.sort((a, b) => a.c.v - b.c.v)[0].c;
    }
    if (mejor) {
      res[p.id] = mejor;
      if (diag.muestras.length < 40) diag.muestras.push({ id: p.id, rinde: `${p.brand} · ${p.name} · ${p.size}`, tienda: mejor.name, precio: mejor.v });
    } else if (diag.sin.length < 60) diag.sin.push(`${p.id} (${items.length} resultados)`);
    if (n % 50 === 0) log(`  ${id}: ${n}/${todos.length} buscados, ${Object.keys(res).length} con precio`);
    await sleep(cad.pausa || PAUSA);
  }
  diag.buscados = n; diag.conPrecio = Object.keys(res).length;
  diag.estado = diag.estado || 'ok';
  return res;
}

async function main() {
  const productos = catalogo().map(prepara);
  log(`Rinde · recolector de precios · ${HOY} · ${productos.length} productos${PRUEBA ? ' (modo prueba)' : ''}`);
  const ids = Object.keys(CADENAS).filter(c => !SOLO.length || SOLO.includes(c));
  const diag = {};
  const resultados = {};
  await Promise.all(ids.map(async id => {
    diag[id] = { pruebas: [], muestras: [], sin: [] };
    try { resultados[id] = await recolectaCadena(id, CADENAS[id], productos, diag[id]); }
    catch (e) { diag[id].estado = 'error: ' + (e.message || e); resultados[id] = null; }
    log(`✔ ${id}: ${diag[id].estado} · ${diag[id].conPrecio || 0} productos con precio`);
  }));

  // Mezcla con el archivo anterior: si una cadena falló hoy, se conservan sus precios hasta 7 días.
  const archivo = path.join(ROOT, 'precios.json');
  let viejo = null;
  try { viejo = JSON.parse(fs.readFileSync(archivo, 'utf8')); } catch {}
  const limite = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const out = { v: 1, actualizado: new Date().toISOString(), cadenas: {}, p: {} };
  const pon = (pid, cad, e) => { (out.p[pid] = out.p[pid] || { c: {} }).c[cad] = e; };
  for (const id of Object.keys(CADENAS)) {
    const r = resultados[id];
    if (r && Object.keys(r).length) {
      out.cadenas[id] = { fecha: HOY, n: Object.keys(r).length, fuente: diag[id].fuente };
      for (const [pid, c] of Object.entries(r)) {
        const e = { v: c.v, d: HOY, n: c.name.slice(0, 90) };
        if (c.l) e.l = c.l;
        if (Object.keys(c.card).length) e.t = c.card;
        if (c.url) e.u = c.url.length > 300 ? c.url.slice(0, 300) : c.url;
        pon(pid, id, e);
        const pp = out.p[pid];
        if (c.ean) pp.e = [...new Set([...(pp.e || []), c.ean])];
        if (c.img && !pp.i) pp.i = c.img;
      }
    } else if (viejo && viejo.cadenas && viejo.cadenas[id] && viejo.cadenas[id].fecha >= limite) {
      out.cadenas[id] = { ...viejo.cadenas[id], conservado: true };
      for (const [pid, x] of Object.entries(viejo.p || {})) if (x.c && x.c[id] && x.c[id].d >= limite) {
        pon(pid, id, x.c[id]);
        const pp = out.p[pid];
        if (x.e) pp.e = [...new Set([...(pp.e || []), ...x.e])];
        if (x.i && !pp.i) pp.i = x.i;
      }
    }
  }
  const total = Object.keys(out.p).length;
  if (!total && viejo) { log('⚠ Hoy no llegó ningún precio: dejo precios.json como estaba.'); }
  else fs.writeFileSync(archivo, JSON.stringify(out));
  fs.writeFileSync(path.join(DIR, 'diagnostico.json'), JSON.stringify({ fecha: new Date().toISOString(), prueba: PRUEBA, cadenas: diag }, null, 1));

  // Resumen legible (se ve en la pestaña Actions de GitHub)
  let md = `## Precios Rinde · ${HOY}\n\n${total} productos con al menos un precio real.\n\n| Cadena | Estado | Fuente | Con precio |\n|---|---|---|---|\n`;
  for (const id of ids) md += `| ${id} | ${diag[id].estado || '-'} | ${diag[id].fuente || '-'} | ${diag[id].conPrecio || 0} |\n`;
  md += `\nDetalle completo: recolector/diagnostico.json\n`;
  log('\n' + md);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
}

main().catch(e => { console.error(e); process.exit(1); });
