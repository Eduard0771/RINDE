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
  if (pp.sz && pp.sz.u !== 'un' && !/pack|\bx\s*\d/.test(pp.foldAll)) {
    const cuenta = cs.filter(x => x.u === 'un').some(x => x.v > 1);
    if (cuenta || /\b(pack|six ?pack|display|caja de \d+)\b/.test(ft)) return -1;
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
    if (/ppum|perunit|unitprice|pricePerUnit|porUnidad/i.test(k)) continue;
    if (typeof v === 'string' && /\bx\s*(kg|kilo|litro|lt|l|un|unidad|100)/i.test(v)) continue;
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
const IMGK = /^(image|imageUrl|image_url|imageURL|thumbnail_url|photo_url|img_url|images|defaultImage|mediaUrls|thumbnail|img|imagen|imagenes|picture|photo|mainImage)$/i;
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

// Unimarc (BFF): {availableProducts:[{price:{price:"$1.190",listPrice:"$1.350"}, item:{...}}]}
function leeUnimarc(j, base) {
  const out = [];
  for (const p of j.availableProducts || []) {
    if (!p || typeof p !== 'object') continue;
    const pr = p.price || {};
    const v = clp(pr.price);
    if (!okPrecio(v)) continue;
    const l = clp(pr.listPrice || pr.priceWithoutDiscount);
    // los datos del producto pueden venir en p.item, p.product o en p mismo
    const it = [p.item, p.product, p.sku, p].find(x => x && typeof x === 'object' && (x.nameComplete || x.name || x.productName || x.description)) || p;
    const name = it.nameComplete || it.productName || it.name || it.description || '';
    if (!name) continue;
    const eanRaw = it.ean || it.ean13 || buscaClave(it, EANK);
    let img = primerTexto(it.images || it.image || it.imageUrl || buscaClave(it, IMGK));
    if (img && img.startsWith('//')) img = 'https:' + img;
    let url = it.detailUrl || it.slug || it.linkText || it.url || '';
    if (url && !/^https?:/.test(url)) url = url.startsWith('/') ? base + url : `${base}/product/${url}`;
    out.push({
      name, brand: primerTexto(it.brand || it.brandName || ''), v, l: l && l > v ? l : null, card: {},
      ean: eanRaw != null && /^\d{8,14}$/.test(String(eanRaw).trim()) ? String(eanRaw).trim() : null,
      img: /^https?:\/\//.test(img) ? vtexImg(img) : '', url,
      extra: [it.netContent, it.netContentLevelSmall, it.measurementUnit && it.unitMultiplier ? `${it.unitMultiplier} ${it.measurementUnit}` : ''].filter(Boolean).join(' '),
      agotado: pr.availableQuantity === 0,
    });
  }
  return out;
}

// Salesforce Commerce Cloud (Farmacias Ahumada): tarjetas <div class="product" data-pid="..."> en el HTML
function txt(h) { return decode((h || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(); }
function leeSFCC(html, base) {
  const out = [];
  const partes = html.split(/<div[^>]+class="[^"]*\bproduct\b[^"]*"[^>]*data-pid=|<div[^>]+data-pid=[^>]+class="[^"]*\bproduct\b/i).slice(1);
  for (const t0 of partes.slice(0, 60)) {
    const t = t0.slice(0, 12000);
    // datos de analítica que suelen venir en un atributo JSON
    let g = null;
    const gm = t.match(/data-(?:gtm[\w-]*|product[\w-]*|analytics[\w-]*|impression[\w-]*)=(?:'([^']{20,})'|"([^"]{20,})")/i);
    if (gm) { try { g = JSON.parse(decode(gm[1] || gm[2])); if (Array.isArray(g)) g = g[0]; } catch { g = null; } }
    const name = txt((t.match(/class="[^"]*(?:pdp-link|product-name|tile-name|product-tile__name)[^"]*"[^>]*>([\s\S]{0,400}?)<\/(?:a|div|h\d|p|span)>/i) || [])[1])
      || (g && (g.name || g.item_name)) || decode((t.match(/<img[^>]+alt="([^"]{3,200})"/i) || [])[1] || '');
    if (!name) continue;
    const ventas = t.match(/class="[^"]*\bsales\b[^"]*"[\s\S]{0,300}?content="([\d.]+)"/i) || t.match(/class="[^"]*\bvalue\b[^"]*"[^>]*content="([\d.]+)"/i);
    let v = ventas ? Math.round(parseFloat(ventas[1])) : null;
    if (!okPrecio(v) && g) v = clp(g.price || g.item_price);
    if (!okPrecio(v)) { const m = txt(t.match(/class="[^"]*\bsales\b[^"]*"[^>]*>([\s\S]{0,200}?)<\/span>/i)?.[1]); v = clp(m); }
    if (!okPrecio(v)) continue;
    const lista = t.match(/class="[^"]*(?:strike-through|\blist\b)[^"]*"[\s\S]{0,300}?content="([\d.]+)"/i);
    const l = lista ? Math.round(parseFloat(lista[1])) : null;
    let img = (t.match(/<img[^>]+(?:data-src|src)="([^"]+\.(?:jpe?g|png|webp)[^"]*)"/i) || [])[1] || '';
    img = decode(img); if (img.startsWith('//')) img = 'https:' + img; else if (img.startsWith('/')) img = base + img;
    let url = decode((t.match(/<a[^>]+href="([^"]+\.html[^"]*)"/i) || t.match(/<a[^>]+href="(\/[^"#]{4,})"/i) || [])[1] || '');
    if (url.startsWith('/')) url = base + url;
    const brand = txt((t.match(/class="[^"]*(?:brand)[^"]*"[^>]*>([\s\S]{0,200}?)<\/(?:a|div|span|p)>/i) || [])[1]) || (g && (g.brand || g.item_brand)) || '';
    out.push({ name, brand, v, l: l && l > v ? l : null, card: {}, ean: null, img, url, extra: '', agotado: false });
  }
  return out;
}

// Algolia (Salcobrand): la clave pública de búsqueda está en el JavaScript de la página
function algoliaFuente(base, pagina) {
  const st = { app: '', key: '', idx: [], cual: '' };
  const f = {
    tipo: 'algolia', base, st,
    async preparar() {
      if (st.app) return;
      const r = await pide(base + pagina);
      const scripts = [...new Set([...r.body.matchAll(/src="([^"]+\.js[^"]*)"/g)].map(m => m[1]))]
        .map(u => u.startsWith('//') ? 'https:' + u : u.startsWith('/') ? base + u : u)
        .filter(u => /pack|search|algolia|application|main|app/i.test(u)).slice(0, 12);
      const textos = [r.body];
      for (const u of scripts) { try { textos.push((await pide(u)).body); } catch {} }
      st.snips = [];
      for (const t of textos) {
        for (const m of t.matchAll(/algolia|sb_variant_|x-algolia|ALGOLIA/g)) if (st.snips.length < 8) st.snips.push(t.slice(Math.max(0, m.index - 200), m.index + 250).replace(/\s+/g, ' '));
        const a = t.match(/(?:applicationId|appId|app_id|ALGOLIA_APP(?:LICATION)?_ID|algoliaAppId)["']?\s*[:=]\s*["']([A-Z0-9]{10})["']/i);
        const k = t.match(/(?:searchApiKey|search_api_key|apiKey|api_key|ALGOLIA_(?:SEARCH_)?(?:API_)?KEY|algoliaApiKey|searchKey)["']?\s*[:=]\s*["']([a-f0-9]{32})["']/i);
        if (a && !st.app) st.app = a[1];
        if (k && !st.key) st.key = k[1];
        if (!st.app) { const m = t.match(/algoliasearch\(\s*["']([A-Z0-9]{10})["']\s*,\s*["']([a-f0-9]{32})["']/i); if (m) { st.app = m[1]; st.key = m[2]; } }
        for (const m of t.matchAll(/["']((?:[a-z0-9]+_)*(?:product|products|variant|variants|sku|skus|catalog|search)(?:_[a-z0-9]+)*)["']/gi)) st.idx.push(m[1]);
        for (const m of t.matchAll(/indexName["']?\s*[:=]\s*["']([\w.-]{3,80})["']/g)) st.idx.unshift(m[1]);
      }
      if (!st.app || !st.key) for (const t of textos) { // última opción: cualquier ID de 10 letras y clave de 32 caracteres cerca de "algolia"
        for (const m of t.matchAll(/algolia/gi)) {
          const w = t.slice(Math.max(0, m.index - 1500), m.index + 1500);
          if (!st.app) st.app = (w.match(/["']([A-Z0-9]{10})["']/) || [])[1] || '';
          if (!st.key) st.key = (w.match(/["']([a-f0-9]{32})["']/) || [])[1] || '';
        }
      }
      for (const ix of [...st.idx]) if (/_$/.test(ix)) st.idx.unshift(ix + 'production', ix + 'prod', ix + 'cl');
      st.idx = [...new Set(st.idx.filter(x => !/_$/.test(x)))].slice(0, 14);
      st.scripts = scripts.length;
      if (!st.app || !st.key) throw new Error(`no encontré la clave de Algolia (${scripts.length} scripts revisados)`);
      // elegir el índice que responde con productos
      for (const ix of st.idx) {
        try {
          const rr = await this.consulta(ix, PRUEBA_Q.farm);
          if (rr.status < 400 && /"hits":\[\{/.test(rr.body)) { st.cual = ix; break; }
        } catch {}
      }
      if (!st.cual) throw new Error(`Algolia ${st.app}: ningún índice respondió (${st.idx.join(', ')})`);
    },
    consulta(ix, q) {
      return pide(`https://${st.app.toLowerCase()}-dsn.algolia.net/1/indexes/${encodeURIComponent(ix)}/query`, {
        method: 'POST',
        headers: { 'x-algolia-application-id': st.app, 'x-algolia-api-key': st.key, 'content-type': 'application/json', origin: base, referer: base + '/' },
        body: JSON.stringify({ query: q, hitsPerPage: 30 }),
      });
    },
    pedir(q) { return this.consulta(st.cual, decodeURIComponent(q)); },
  };
  return f;
}

const ENT = { aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ', uuml: 'ü', nbsp: ' ', reg: '®', deg: '°' };
function decode(s) { return s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16))).replace(/&([a-z]+);/gi, (m, n) => ENT[n] || m).replace(/&quot;|&#34;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'); }
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
    if (j && Array.isArray(j.availableProducts)) { const u = leeUnimarc(j, base); if (u.length) return u; }
    if (j && Array.isArray(j.hits)) for (const h of j.hits) if (h && h.objectID && !h.url && (h.slug || h.handle)) h.url = `${base}/products/${h.slug || h.handle}`;
    return escanea(j);
  }
  if (/data-pid=/.test(res.body)) { const sf = leeSFCC(res.body, base); if (sf.length) return sf; }
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
  lider: { tipo: 'super', pausa: 5000, descanso: 120000, fuentes: [liderBff, web('https://super.lider.cl', '/search?q={q}'), web('https://www.lider.cl', '/supermercado/search?query={q}')] },
  unimarc: { tipo: 'super', fuentes: [{
      tipo: 'unimarc-bff', base: 'https://www.unimarc.cl',
      pedir: q => pide('https://bff-unimarc-ecommerce.unimarc.cl/catalog/product/search', {
        method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://www.unimarc.cl', referer: 'https://www.unimarc.cl/', source: 'web', version: '1.0.0' },
        body: JSON.stringify({ from: '0', orderBy: '', searching: decodeURIComponent(q), to: '39', userTriggered: true, promotionsOnly: false }),
      }),
    }, vtex('https://www.unimarc.cl'), vtexIS('https://www.unimarc.cl'), web('https://www.unimarc.cl', '/search?q={q}')] },
  tottus: { tipo: 'super', fuentes: [web('https://www.tottus.cl', '/tottus-cl/buscar?Ntt={q}'), web('https://www.tottus.cl', '/buscar?Ntt={q}')] },
  acuenta: { tipo: 'super', fuentes: [vtex('https://www.acuenta.cl'), web('https://www.acuenta.cl', '/search?q={q}')] },
  cruzverde: { tipo: 'farm', fuentes: [cruzVerdeApi, web('https://www.cruzverde.cl', '/search?q={q}')] },
  salcobrand: { tipo: 'farm', fuentes: [algoliaFuente('https://salcobrand.cl', '/search_result?query=paracetamol'), web('https://salcobrand.cl', '/search_result?query={q}'), web('https://salcobrand.cl', '/search?q={q}')] },
  ahumada: { tipo: 'farm', fuentes: [
    web('https://www.farmaciasahumada.cl', '/on/demandware.store/Sites-ahumada-cl-Site/default/Search-ShowAjax?q={q}'),
    web('https://www.farmaciasahumada.cl', '/search?q={q}')] },
  simi: { tipo: 'farm', fuentes: [vtex('https://www.drsimi.cl'), vtexIS('https://www.drsimi.cl'), web('https://www.drsimi.cl', '/{q}?_q={q}&map=ft')] },
};
const PRUEBA_Q = { super: 'leche entera', farm: 'paracetamol' };

async function buscar(f, q) {
  const res = f.pedir ? await f.pedir(q) : await pide(f.url(q));
  if (res.status >= 400) return { status: res.status, items: [], body: res.body };
  return { status: res.status, items: lee(res, f.base), body: res.body };
}

async function eligeFuente(id, cad, diag) {
  for (const f of cad.fuentes) {
    const d = { tipo: f.tipo, url: f.url ? f.url(encodeURIComponent(PRUEBA_Q[cad.tipo])) : '(API)' };
    try {
      if (f.preparar) await f.preparar();
      const r = await buscar(f, encodeURIComponent(PRUEBA_Q[cad.tipo]));
      d.status = r.status; d.productos = r.items.length; d.ejemplos = r.items.slice(0, 4).map(x => `${x.name} · $${x.v}`);
      if (f.st) d.algolia = { app: f.st.app, indice: f.st.cual, indices: f.st.idx, scripts: f.st.scripts };
      if (r.items.length) d.ejemplo = r.items[0];
      if (r.body && /availableProducts/.test(r.body)) { try { d.unimarcItem = JSON.stringify(JSON.parse(r.body).availableProducts[0]).slice(0, 3000); } catch {} }
      if (!r.items.length && r.body) { // pistas para ajustar esta cadena
        const b = r.body;
        d.titulo = (b.match(/<title[^>]*>([^<]{0,120})/i) || [])[1] || '';
        d.largo = b.length;
        d.inicio = b.slice(0, 300).replace(/\s+/g, ' ');
        d.pistas = [...new Set([...b.matchAll(/["'(]((?:https?:)?\/\/[^"'()\s]{6,200}|\/[^"'()\s]{3,200})["')]/g)].map(m => m[1])
          .filter(x => /api|bff|graphql|search|busca|catalog|product|algolia|\.json/i.test(x) && !/\.(png|jpe?g|svg|webp|gif|css|woff2?|ico)(\?|$)/i.test(x)))].slice(0, 30);
        const i = b.search(/\$\s?\d{1,3}(\.\d{3})+/);
        if (i >= 0) d.muestra = b.slice(Math.max(0, i - 900), i + 300).replace(/\s+/g, ' ');
        const pidI = b.search(/data-pid=/);
        if (pidI >= 0) d.tarjeta = b.slice(pidI, pidI + 2500).replace(/\s+/g, ' ');
        const k = b.search(/algolia|applicationId|appId/i);
        if (k >= 0) d.algolia = b.slice(Math.max(0, k - 150), k + 250).replace(/\s+/g, ' ');
      }
    } catch (e) { d.error = String(e.message || e).slice(0, 200); if (f.st) d.algolia = { app: f.st.app, tieneClave: !!f.st.key, indices: f.st.idx, scripts: f.st.scripts, trozos: f.st.snips }; }
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
    if (fallos >= 3 && fallos < 12) await sleep(cad.descanso || 20000); // la página pide calma: esperar y seguir
    if (cad.descanso && n % 60 === 0) await sleep(cad.descanso); // cadenas sensibles: descanso cada 60 búsquedas
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
  const conserva = (id, saltar) => {
    let n = 0;
    for (const [pid, x] of Object.entries((viejo && viejo.p) || {})) if (x.c && x.c[id] && x.c[id].d >= limite && !(saltar && saltar[pid])) {
      pon(pid, id, x.c[id]); n++;
      const pp = out.p[pid];
      if (x.e) pp.e = [...new Set([...(pp.e || []), ...x.e])];
      if (x.i && !pp.i) pp.i = x.i;
    }
    return n;
  };
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
      const extra = conserva(id, r);
      out.cadenas[id].n += extra;
      if (extra) out.cadenas[id].conservados = extra;
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
