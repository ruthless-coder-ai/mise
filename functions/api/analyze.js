/**
 * Cloudflare Pages Function — POST /api/analyze
 *
 * Optional. Deploy the site with a GEMINI_API_KEY environment variable and the
 * browser never sees the key: the frontend calls this endpoint, gets a 200, and
 * stops asking for a local key. Without the variable this returns 501 and the
 * app falls back to a key the user pastes into the settings sheet.
 */

const DEFAULT_MODEL = 'gemini-3.6-flash';
const RETIRED_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'];

const PROMPT = `You are a nutrition analyst looking at a photograph of a meal.

Identify every distinct food component you can see, including cooking oil, sauces, dressings and drinks. Recognise dishes from any cuisine — pay particular attention to East and Southeast Asian dishes, and name them specifically (e.g. "char siu", "mapo tofu", "pho bo") rather than generically.

For each component estimate the cooked weight in grams as served in the photo, using the plate, bowl, cutlery or hand in frame for scale. Then give the nutrition for THAT estimated portion — not per 100 g.

Rules:
- Be realistic about hidden fats: stir-fried and restaurant food carries far more oil than home-steamed food.
- sugar_g means free/added sugars, not the sugar naturally present in whole fruit or plain milk.
- If the image contains no food at all, return an empty items array and say so in notes.
- Set confidence to "low" when the dish is ambiguous, portion scale is unclear, or ingredients are hidden.
- Keep notes to one or two short sentences: what you assumed, and what could be off.`;

const NUM = { type: 'NUMBER' };

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    dish_name: { type: 'STRING' },
    confidence: { type: 'STRING', enum: ['high', 'medium', 'low'] },
    notes: { type: 'STRING' },
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' },
          estimated_grams: NUM, calories: NUM, protein_g: NUM, carbs_g: NUM,
          sugar_g: NUM, fat_g: NUM, saturated_fat_g: NUM, fiber_g: NUM, sodium_mg: NUM,
        },
        required: ['name', 'estimated_grams', 'calories', 'protein_g', 'carbs_g',
                   'sugar_g', 'fat_g', 'saturated_fat_g', 'fiber_g', 'sodium_mg'],
      },
    },
  },
  required: ['dish_name', 'confidence', 'notes', 'items'],
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

export async function onRequestPost({ request, env }) {
  if (!env.GEMINI_API_KEY) {
    return json({ error: 'No server-side key configured.' }, 501);
  }

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Malformed request body.' }, 400); }

  const { base64, mime } = body || {};
  if (typeof base64 !== 'string' || !base64) {
    return json({ error: 'Missing image data.' }, 400);
  }
  // ~4/3 expansion: 8 MB of base64 is roughly a 6 MB photo. Plenty for a 1024px JPEG.
  if (base64.length > 8_000_000) {
    return json({ error: 'Image too large.' }, 413);
  }

  const asked = String(body.model || '');
  const model = /^[a-zA-Z0-9._-]+$/.test(asked) && !RETIRED_MODELS.includes(asked)
    ? asked
    : DEFAULT_MODEL;

  const upstream = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [
            { text: PROMPT },
            { inline_data: { mime_type: mime || 'image/jpeg', data: base64 } },
          ],
        }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: 'application/json',
          responseSchema: SCHEMA,
        },
      }),
    }
  );

  const data = await upstream.json().catch(() => null);
  if (!upstream.ok) {
    const message = data?.error?.message || `Upstream error ${upstream.status}`;
    return json({ error: upstream.status === 429 ? 'Rate limit hit — try again shortly.' : message },
                upstream.status === 429 ? 429 : 502);
  }
  return json(data);
}
