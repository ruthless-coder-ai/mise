/* ══════════════════════════════════════════════════════════
   Mise — photo → nutrition → your day's targets
   No build step. Everything lives in this browser.
   ══════════════════════════════════════════════════════════ */

'use strict';

/* ─────────────  config  ───────────── */

const STORE = {
  profile: 'mise.profile',
  api:     'mise.api',
  day:     d => `mise.log.${d}`,
};

const DEFAULT_PROFILE = {
  age: 29, weight: 60, height: 163, sex: 'female',
  activity: 1.375, goal: 1,
};

const DEFAULT_MODEL = 'gemini-3.6-flash';

/* Google retires model ids and refuses them for new keys. A saved setting would
   otherwise pin a device to a dead model forever, so migrate it on load. */
const RETIRED_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'];

function normalizeModel(m) {
  const v = (m || '').trim().replace(/^models\//, '');
  return !v || RETIRED_MODELS.includes(v) ? DEFAULT_MODEL : v;
}

/* The nutrients we chart. `goal` = aim to reach it. `limit` = stay under it. */
const NUTRIENTS = [
  { key: 'protein_g',       name: 'Protein',    unit: 'g',  mode: 'goal',  color: 'var(--moss)' },
  { key: 'carbs_g',         name: 'Carbs',      unit: 'g',  mode: 'goal',  color: 'var(--clay)' },
  { key: 'fat_g',           name: 'Fat',        unit: 'g',  mode: 'goal',  color: 'var(--amber)' },
  { key: 'fiber_g',         name: 'Fibre',      unit: 'g',  mode: 'goal',  color: 'var(--slate)' },
  { key: 'sugar_g',         name: 'Free sugar', unit: 'g',  mode: 'limit', color: 'var(--plum)' },
  { key: 'saturated_fat_g', name: 'Sat. fat',   unit: 'g',  mode: 'limit', color: 'var(--persimmon-2)' },
  { key: 'sodium_mg',       name: 'Sodium',     unit: 'mg', mode: 'limit', color: 'var(--persimmon)' },
];

const ALL_KEYS = ['calories', ...NUTRIENTS.map(n => n.key)];

/* ─────────────  targets  ───────────── */

/**
 * Mifflin–St Jeor BMR × activity × goal, then split into macros using
 * WHO/EFSA reference intakes:
 *   protein  1.2 g/kg body weight
 *   fat      30% of energy
 *   carbs    the remainder
 *   fibre    14 g per 1000 kcal
 *   free sugar / saturated fat  each capped at 10% of energy
 *   sodium   2000 mg ceiling (WHO)
 */
function computeTargets(p) {
  const s = p.sex === 'male' ? 5 : -161;
  const bmr = 10 * p.weight + 6.25 * p.height - 5 * p.age + s;
  const kcal = Math.round(bmr * p.activity * p.goal / 10) * 10;

  const protein = Math.round(1.2 * p.weight);
  const fat     = Math.round(kcal * 0.30 / 9);
  const carbs   = Math.max(50, Math.round((kcal - protein * 4 - fat * 9) / 4));

  return {
    bmr: Math.round(bmr),
    calories:        kcal,
    protein_g:       protein,
    carbs_g:         carbs,
    fat_g:           fat,
    fiber_g:         Math.round(kcal * 14 / 1000),
    sugar_g:         Math.round(kcal * 0.10 / 4),
    saturated_fat_g: Math.round(kcal * 0.10 / 9),
    sodium_mg:       2000,
  };
}

/* ─────────────  state  ───────────── */

const state = {
  profile: load(STORE.profile, DEFAULT_PROFILE),
  api:     load(STORE.api, { key: '', model: DEFAULT_MODEL }),
  date:    isoDate(new Date()),
  targets: null,
  shot:    null,   // { base64, mime, thumb }
  result:  null,   // parsed analysis
  proxy:   null,   // null = unknown, true = server key works, false = use local key
};
state.targets = computeTargets(state.profile);

{
  const fixed = normalizeModel(state.api.model);
  if (fixed !== state.api.model) { state.api.model = fixed; save(STORE.api, state.api); }
}

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : { ...fallback };
  } catch { return { ...fallback }; }
}
function save(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}
function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function readDay(date) {
  try { return JSON.parse(localStorage.getItem(STORE.day(date)) || '[]'); } catch { return []; }
}
function writeDay(date, entries) {
  try { localStorage.setItem(STORE.day(date), JSON.stringify(entries)); } catch {}
}

const $ = sel => document.querySelector(sel);

/* ─────────────  photo intake  ───────────── */

const dropzone  = $('#dropzone');
const fileInput = $('#fileInput');
const preview   = $('#preview');

dropzone.addEventListener('click', e => {
  if (e.target.id !== 'clearShot') fileInput.click();
});
dropzone.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
});
['dragenter', 'dragover'].forEach(t =>
  dropzone.addEventListener(t, e => { e.preventDefault(); dropzone.classList.add('is-over'); }));
['dragleave', 'drop'].forEach(t =>
  dropzone.addEventListener(t, e => { e.preventDefault(); dropzone.classList.remove('is-over'); }));
dropzone.addEventListener('drop', e => {
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) takePhoto(f);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) takePhoto(fileInput.files[0]);
});
$('#clearShot').addEventListener('click', e => { e.stopPropagation(); resetShot(); });

async function takePhoto(file) {
  if (!file.type.startsWith('image/')) return setStatus('That file is not an image.', true);
  setStatus('Preparing image…');
  try {
    const full  = await downscale(file, 1024, 0.85);
    const thumb = await downscale(file, 128, 0.6);
    state.shot = { base64: full.split(',')[1], mime: 'image/jpeg', thumb };
    preview.src = full;
    preview.hidden = false;
    $('#dropEmpty').hidden = true;
    $('#clearShot').hidden = false;
    $('#analyzeBtn').disabled = false;
    $('#result').hidden = true;
    setStatus('Ready. Read the plate when you are.');
  } catch (err) {
    setStatus('Could not read that image. ' + err.message, true);
  }
}

function resetShot() {
  state.shot = null;
  state.result = null;
  preview.hidden = true;
  preview.removeAttribute('src');
  $('#dropEmpty').hidden = false;
  $('#clearShot').hidden = true;
  $('#analyzeBtn').disabled = true;
  $('#result').hidden = true;
  fileInput.value = '';
  setStatus('');
}

/** Shrink to `max` on the long edge and re-encode as JPEG — keeps uploads small. */
function downscale(file, max, quality) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width  = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
    img.src = url;
  });
}

function setStatus(msg, isError = false) {
  const el = $('#status');
  el.textContent = msg;
  el.classList.toggle('is-error', !!isError);
}

/* ─────────────  the vision call  ───────────── */

const PROMPT = `You are a nutrition analyst looking at a photograph of a meal.

Identify every distinct food component you can see, including cooking oil, sauces, dressings and drinks. Recognise dishes from any cuisine — pay particular attention to East and Southeast Asian dishes, and name them specifically (e.g. "char siu", "mapo tofu", "pho bo") rather than generically.

For each component estimate the cooked weight in grams as served in the photo, using the plate, bowl, cutlery or hand in frame for scale. Then give the nutrition for THAT estimated portion — not per 100 g.

Rules:
- Be realistic about hidden fats: stir-fried and restaurant food carries far more oil than home-steamed food.
- sugar_g means free/added sugars, not the sugar naturally present in whole fruit or plain milk.
- If the image contains no food at all, return an empty items array and say so in notes.
- Set confidence to "low" when the dish is ambiguous, portion scale is unclear, or ingredients are hidden.
- Keep notes to one or two short sentences: what you assumed, and what could be off.`;

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    dish_name:  { type: 'STRING', description: 'Short name for the meal as a whole' },
    confidence: { type: 'STRING', enum: ['high', 'medium', 'low'] },
    notes:      { type: 'STRING' },
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name:            { type: 'STRING' },
          estimated_grams: { type: 'NUMBER' },
          calories:        { type: 'NUMBER' },
          protein_g:       { type: 'NUMBER' },
          carbs_g:         { type: 'NUMBER' },
          sugar_g:         { type: 'NUMBER' },
          fat_g:           { type: 'NUMBER' },
          saturated_fat_g: { type: 'NUMBER' },
          fiber_g:         { type: 'NUMBER' },
          sodium_mg:       { type: 'NUMBER' },
        },
        required: ['name', 'estimated_grams', 'calories', 'protein_g', 'carbs_g',
                   'sugar_g', 'fat_g', 'saturated_fat_g', 'fiber_g', 'sodium_mg'],
      },
    },
  },
  required: ['dish_name', 'confidence', 'notes', 'items'],
};

function buildPayload(base64, mime) {
  return {
    contents: [{
      role: 'user',
      parts: [{ text: PROMPT }, { inline_data: { mime_type: mime, data: base64 } }],
    }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
      responseSchema: SCHEMA,
    },
  };
}

/** Try the server-side proxy first; fall back to a key held in this browser. */
async function analyzePhoto(base64, mime) {
  if (state.proxy !== false) {
    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base64, mime, model: state.api.model || DEFAULT_MODEL }),
      });
      if (res.ok) { state.proxy = true; return parseGemini(await res.json()); }
      if (res.status !== 404 && res.status !== 405 && res.status !== 501) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Server returned ${res.status}`);
      }
      state.proxy = false;              // no function deployed — use the local key
    } catch (err) {
      if (state.proxy === true) throw err;
      state.proxy = false;
    }
  }

  const key = state.api.key.trim();
  if (!key) {
    const e = new Error('No API key yet. Open “Targets & setup” and paste a free Gemini key.');
    e.needsKey = true;
    throw e;
  }

  const model = state.api.model || DEFAULT_MODEL;
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(buildPayload(base64, mime)),
    }
  );
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = data?.error?.message || `Request failed (${res.status})`;
    if (res.status === 429) throw new Error('Free-tier rate limit hit. Wait a minute and try again.');
    // Google retires model ids over time; point at the field that fixes it.
    if (/no longer available|not found|is not supported/i.test(msg)) {
      throw new Error(`${msg} — change it under “Targets & setup → Model”.`);
    }
    throw new Error(msg);
  }
  return parseGemini(data);
}

function parseGemini(data) {
  const text = (data?.candidates?.[0]?.content?.parts || [])
    .map(p => p.text).filter(Boolean).join('');
  if (!text) throw new Error('The model returned nothing readable.');
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new Error('The model returned malformed JSON.'); }
  parsed.items = (parsed.items || []).map(it => {
    const clean = { name: String(it.name || 'Unnamed'), estimated_grams: num(it.estimated_grams) };
    ALL_KEYS.forEach(k => { clean[k] = num(it[k]); });
    return clean;
  });
  return parsed;
}

const num = v => (Number.isFinite(+v) && +v >= 0 ? +v : 0);

/* ─────────────  analyse flow  ───────────── */

$('#analyzeBtn').addEventListener('click', async () => {
  if (!state.shot) return;
  const btn = $('#analyzeBtn');
  btn.classList.add('is-busy');
  btn.disabled = true;
  setStatus('Reading the plate… this takes a few seconds.');
  try {
    const result = await analyzePhoto(state.shot.base64, state.shot.mime);
    if (!result.items.length) {
      setStatus(result.notes || 'No food found in that photo.', true);
      $('#result').hidden = true;
    } else {
      showResult(result);
      setStatus('');
    }
  } catch (err) {
    setStatus(err.message, true);
    if (err.needsKey) $('#settings').showModal();
  } finally {
    btn.classList.remove('is-busy');
    btn.disabled = false;
  }
});

$('#sampleBtn').addEventListener('click', () => {
  state.shot = { base64: null, mime: null, thumb: SAMPLE.thumb };
  preview.src = SAMPLE.thumb;
  preview.hidden = false;
  $('#dropEmpty').hidden = true;
  $('#clearShot').hidden = false;
  showResult(structuredClone(SAMPLE.analysis));
  setStatus('Sample data — no API call made.');
});

function showResult(result) {
  state.result = result;
  $('#dishName').textContent = result.dish_name || 'Unnamed meal';
  const conf = $('#confidence');
  const level = ['high', 'medium', 'low'].includes(result.confidence) ? result.confidence : 'medium';
  conf.textContent = level + ' confidence';
  conf.dataset.level = level;
  $('#dishNotes').textContent = result.notes || '';

  $('#itemsBody').innerHTML = result.items.map(it => `
    <tr>
      <td class="items__name">${esc(it.name)}</td>
      <td class="num">${Math.round(it.estimated_grams)}</td>
      <td class="num">${Math.round(it.calories)}</td>
      <td class="num">${Math.round(it.protein_g)}</td>
      <td class="num">${Math.round(it.carbs_g)}</td>
      <td class="num">${Math.round(it.fat_g)}</td>
    </tr>`).join('');

  $('#portion').value = 1;
  updatePortion();
  $('#result').hidden = false;
  $('#result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function sumItems(items, factor = 1) {
  const t = {};
  ALL_KEYS.forEach(k => { t[k] = items.reduce((a, it) => a + (it[k] || 0), 0) * factor; });
  return t;
}

$('#portion').addEventListener('input', updatePortion);
function updatePortion() {
  const f = +$('#portion').value;
  $('#portionOut').innerHTML = f.toFixed(2).replace(/0$/, '') + '&times;';
  if (state.result) $('#entryKcal').textContent = Math.round(sumItems(state.result.items, f).calories);
}

$('#logBtn').addEventListener('click', () => {
  if (!state.result) return;
  const f = +$('#portion').value;
  const entry = {
    id: `${Date.now()}-${Math.round(performance.now())}`,
    time: new Date().toTimeString().slice(0, 5),
    name: state.result.dish_name || 'Meal',
    portion: f,
    thumb: state.shot?.thumb || '',
    totals: sumItems(state.result.items, f),
  };
  const entries = readDay(state.date);
  entries.push(entry);
  writeDay(state.date, entries);
  resetShot();
  renderDay();
  setStatus('Added to the ledger.');
});

/* ─────────────  ledger rendering  ───────────── */

function renderDay() {
  const entries = readDay(state.date);
  const t = state.targets;
  const total = {};
  ALL_KEYS.forEach(k => { total[k] = entries.reduce((a, e) => a + (e.totals?.[k] || 0), 0); });

  /* hero */
  const kcal = Math.round(total.calories);
  const pct  = t.calories ? kcal / t.calories : 0;
  $('#kcalNum').textContent    = kcal.toLocaleString();
  $('#kcalTarget').textContent = t.calories.toLocaleString();
  setArc($('#kcalArc'), 50, Math.min(pct, 1),
         pct > 1.05 ? 'var(--persimmon)' : pct > 0.9 ? 'var(--moss)' : 'var(--persimmon-2)');

  const left = t.calories - kcal;
  $('#kcalLeft').textContent = Math.abs(left).toLocaleString();
  $('#kcalLeftWord').textContent = left >= 0 ? 'kcal left' : 'kcal over';
  $('#kcalKicker').textContent =
    !entries.length ? 'Nothing logged yet'
    : pct > 1.05    ? 'Over the day’s energy'
    : pct > 0.9     ? 'On target'
                    : 'Room to eat';
  $('#mealCount').textContent    = entries.length;
  $('#proteinQuick').textContent = `${Math.round(total.protein_g)} g`;
  $('#fibreQuick').textContent   = `${Math.round(total.fiber_g)} g`;

  /* nutrient dials */
  $('#dials').innerHTML = NUTRIENTS.map(n => {
    const val    = total[n.key];
    const target = t[n.key];
    const p      = target ? val / target : 0;
    const over   = p > 1.02;
    const dec    = n.unit === 'mg' ? 0 : (val < 10 && val > 0 ? 1 : 0);
    return `
      <div class="tile" data-over="${over}" title="${n.mode === 'limit' ? 'Stay under' : 'Aim for'} ${target} ${n.unit}">
        <div class="tile__dial">
          <svg viewBox="0 0 100 100" class="dial" aria-hidden="true">
            <circle class="dial__track" cx="50" cy="50" r="42" />
            <circle class="dial__fill" data-key="${n.key}" cx="50" cy="50" r="42" />
          </svg>
          <span class="tile__pct">${Math.round(p * 100)}%</span>
        </div>
        <span class="tile__name">${n.name}</span>
        <span class="tile__val"><b>${val.toFixed(dec)}</b><span> / ${target}${n.unit}</span></span>
      </div>`;
  }).join('');

  requestAnimationFrame(() => {
    NUTRIENTS.forEach(n => {
      const val = total[n.key], target = t[n.key];
      const p = target ? val / target : 0;
      setArc($(`.dial__fill[data-key="${n.key}"]`), 42, Math.min(p, 1),
             p > 1.02 ? 'var(--persimmon)' : n.color);
    });
  });

  /* log list */
  const list = $('#logList');
  list.innerHTML = entries.map((e, i) => `
    <li class="log__item" style="animation-delay:${i * 40}ms">
      ${e.thumb ? `<img class="log__thumb" src="${e.thumb}" alt="" />`
                : `<span class="log__thumb"></span>`}
      <div class="log__body">
        <p class="log__name">${esc(e.name)}</p>
        <p class="log__sub">${e.time} · ${e.portion !== 1 ? e.portion.toFixed(2).replace(/0$/, '') + '× · ' : ''}${Math.round(e.totals.protein_g)}p ${Math.round(e.totals.carbs_g)}c ${Math.round(e.totals.fat_g)}f</p>
      </div>
      <span class="log__kcal">${Math.round(e.totals.calories)}</span>
      <button class="log__del" data-id="${e.id}" aria-label="Remove ${esc(e.name)}">&times;</button>
    </li>`).join('');
  $('#logEmpty').hidden = entries.length > 0;

  list.querySelectorAll('.log__del').forEach(btn => {
    btn.addEventListener('click', () => {
      writeDay(state.date, readDay(state.date).filter(e => e.id !== btn.dataset.id));
      renderDay();
    });
  });
}

/** Fill an SVG ring to `frac` (0–1) of its circumference. */
function setArc(circle, r, frac, color) {
  if (!circle) return;
  const c = 2 * Math.PI * r;
  circle.style.strokeDasharray = `${(c * Math.max(0, Math.min(frac, 1))).toFixed(2)} ${c.toFixed(2)}`;
  if (color) circle.style.stroke = color;
}

$('#clearDay').addEventListener('click', () => {
  if (!readDay(state.date).length) return;
  if (confirm('Remove every entry logged for this day?')) {
    writeDay(state.date, []);
    renderDay();
  }
});

/* ─────────────  date navigation  ───────────── */

function shiftDay(delta) {
  const d = new Date(state.date + 'T12:00:00');
  d.setDate(d.getDate() + delta);
  state.date = isoDate(d);
  renderDate();
  renderDay();
}
$('#prevDay').addEventListener('click', () => shiftDay(-1));
$('#nextDay').addEventListener('click', () => shiftDay(1));

function renderDate() {
  const today = isoDate(new Date());
  const d = new Date(state.date + 'T12:00:00');
  const yest = new Date(); yest.setDate(yest.getDate() - 1);
  const label = state.date === today ? 'Today'
              : state.date === isoDate(yest) ? 'Yesterday'
              : d.toLocaleDateString(undefined, { weekday: 'long' });
  $('#dateLabel').textContent = label;
  $('#dateFull').textContent  = d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
  $('#nextDay').disabled = state.date >= today;
  $('#logDayWord').textContent = label.toLowerCase();
}

/* ─────────────  settings  ───────────── */

const sheet = $('#settings');
$('#openSettings').addEventListener('click', () => { fillSettings(); sheet.showModal(); });

function fillSettings() {
  const p = state.profile;
  $('#fAge').value = p.age;
  $('#fWeight').value = p.weight;
  $('#fHeight').value = p.height;
  $('#fSex').value = p.sex;
  $('#fActivity').value = String(p.activity);
  $('#fGoal').value = String(p.goal);
  $('#fKey').value = state.api.key;
  $('#fModel').value = state.api.model || DEFAULT_MODEL;
  $('#proxyState').textContent = state.proxy === true
    ? 'This site is using a server-side key — the field above is ignored.'
    : 'No server-side key detected, so the key above is used directly from your browser.';
  previewTargets();
}

function readForm() {
  return {
    age: +$('#fAge').value || DEFAULT_PROFILE.age,
    weight: +$('#fWeight').value || DEFAULT_PROFILE.weight,
    height: +$('#fHeight').value || DEFAULT_PROFILE.height,
    sex: $('#fSex').value,
    activity: +$('#fActivity').value,
    goal: +$('#fGoal').value,
  };
}

function previewTargets() {
  const t = computeTargets(readForm());
  $('#calcOut').innerHTML = `
    BMR <b>${t.bmr}</b> kcal &nbsp;→&nbsp; daily energy <b>${t.calories}</b> kcal<br />
    Protein <b>${t.protein_g} g</b> · Carbs <b>${t.carbs_g} g</b> · Fat <b>${t.fat_g} g</b> · Fibre <b>${t.fiber_g} g</b><br />
    Ceilings — free sugar <b>${t.sugar_g} g</b> · sat. fat <b>${t.saturated_fat_g} g</b> · sodium <b>${t.sodium_mg} mg</b>`;
}
['#fAge', '#fWeight', '#fHeight', '#fSex', '#fActivity', '#fGoal']
  .forEach(sel => $(sel).addEventListener('input', previewTargets));

function applySettings() {
  state.profile = readForm();
  state.api = { key: $('#fKey').value.trim(), model: normalizeModel($('#fModel').value) };
  state.targets = computeTargets(state.profile);
  save(STORE.profile, state.profile);
  save(STORE.api, state.api);
  renderDay();
  updateKeyNotice();
}

/* Submit is the reliable signal — some engines never dispatch `close` for a
   method="dialog" form. Applying twice is harmless: it re-reads the same fields. */
$('#settingsForm').addEventListener('submit', e => {
  if ((e.submitter?.value ?? sheet.returnValue) === 'save') applySettings();
});
sheet.addEventListener('close', () => {
  if (sheet.returnValue === 'save') applySettings();
});

/* ─────────────  sample  ───────────── */

const SAMPLE = {
  thumb: 'data:image/svg+xml;utf8,' + encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300">
      <rect width="400" height="300" fill="#EDE5D5"/>
      <circle cx="200" cy="150" r="108" fill="#FBF7EF" stroke="#D6CBB6" stroke-width="2"/>
      <circle cx="200" cy="150" r="82" fill="none" stroke="#E3DACA" stroke-width="1.5"/>
      <path d="M150 176c0-30 22-52 50-52s50 22 50 52z" fill="#C8481F" opacity=".82"/>
      <circle cx="168" cy="128" r="21" fill="#4F6B3E" opacity=".78"/>
      <circle cx="232" cy="126" r="17" fill="#B8830E" opacity=".8"/>
      <text x="200" y="272" font-family="IBM Plex Mono, monospace" font-size="13"
            fill="#8B8073" text-anchor="middle" letter-spacing="2">SAMPLE PLATE</text>
    </svg>`),
  analysis: {
    dish_name: 'Chicken rice with pak choi',
    confidence: 'medium',
    notes: 'Assumed a standard restaurant bowl and about a teaspoon of oil in the greens. Sauce sugar and salt are the least certain figures.',
    items: [
      { name: 'Steamed jasmine rice', estimated_grams: 180, calories: 234, protein_g: 4.7, carbs_g: 51, sugar_g: 0.1, fat_g: 0.5, saturated_fat_g: 0.1, fiber_g: 0.7, sodium_mg: 2 },
      { name: 'Poached chicken thigh, skin on', estimated_grams: 120, calories: 218, protein_g: 24, carbs_g: 0, sugar_g: 0, fat_g: 13, saturated_fat_g: 3.6, fiber_g: 0, sodium_mg: 96 },
      { name: 'Pak choi in garlic oil', estimated_grams: 90, calories: 62, protein_g: 1.6, carbs_g: 3.1, sugar_g: 1.2, fat_g: 5.1, saturated_fat_g: 0.8, fiber_g: 1.5, sodium_mg: 210 },
      { name: 'Ginger–soy sauce', estimated_grams: 25, calories: 46, protein_g: 1.1, carbs_g: 3.4, sugar_g: 2.8, fat_g: 3.1, saturated_fat_g: 0.4, fiber_g: 0.2, sodium_mg: 720 },
    ],
  },
};

/* ─────────────  boot  ───────────── */

$('#noticeBtn').addEventListener('click', () => { fillSettings(); sheet.showModal(); });

/**
 * Ask the deployment once whether it holds a key of its own, so the prompt below
 * is honest on every device. An empty body is the cheapest question we can ask:
 *   501 → no server key      400 → a key is configured, we just sent no image
 *   404/405 → no function at all
 */
async function probeProxy() {
  try {
    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    state.proxy = res.status === 400 || res.ok;
  } catch {
    state.proxy = false;
  }
  updateKeyNotice();
}

function updateKeyNotice() {
  $('#keyNotice').hidden = state.proxy === true || !!state.api.key;
}

renderDate();
renderDay();
updateKeyNotice();
probeProxy();
if (!localStorage.getItem(STORE.profile)) {
  setStatus('Targets are set for 60 kg, age 29 — adjust them under “Targets & setup”.');
}
