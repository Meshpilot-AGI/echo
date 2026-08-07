/**
 * Collapse a raw Shopify product title into a short speakable category
 * ("sunglasses", "shirt", ...) in the caller's language. Fed to the prompt
 * so Priya never has to read a full SKU out loud.
 *
 * Strategy: scan the SKU's lowercased words for the first keyword that maps
 * to a category. Falls back to the raw title trimmed to ≤ 3 words if no
 * keyword matches (which is better than a 10-word SKU but still a signal
 * that CATEGORY_MAP needs a new entry). Returns empty string if input is
 * empty so the caller can drop to the "आपका product" / "your product"
 * default.
 *
 * Adding a new category is one line. Brand names are NEVER entries — the
 * whole point is to get brands out of the spoken text.
 *
 * COD-confirm profile-local. Other profiles that need product naming should
 * either depend on this module explicitly or ship their own equivalent —
 * not be lifted into the engine.
 */
export const CATEGORY_MAP = {
  // keyword           [ en_spoken,   hi_spoken  ]
  sunglass:            ['sunglasses', 'चश्मे'],
  sunglasses:          ['sunglasses', 'चश्मे'],
  glasses:             ['glasses',    'चश्मे'],
  spectacle:           ['glasses',    'चश्मे'],
  spectacles:          ['glasses',    'चश्मे'],
  goggle:              ['goggles',    'चश्मे'],
  goggles:             ['goggles',    'चश्मे'],
  shade:               ['sunglasses', 'चश्मे'],
  shades:              ['sunglasses', 'चश्मे'],
  shirt:               ['shirt',      'शर्ट'],
  tshirt:              ['t-shirt',    'टी-शर्ट'],
  't-shirt':           ['t-shirt',    'टी-शर्ट'],
  tee:                 ['t-shirt',    'टी-शर्ट'],
  hoodie:              ['hoodie',     'हुडी'],
  jacket:              ['jacket',     'जैकेट'],
  jean:                ['jeans',      'जीन्स'],
  jeans:               ['jeans',      'जीन्स'],
  trouser:             ['trousers',   'ट्राउज़र'],
  trousers:            ['trousers',   'ट्राउज़र'],
  pant:                ['trousers',   'ट्राउज़र'],
  pants:               ['trousers',   'ट्राउज़र'],
  short:               ['shorts',     'शॉर्ट्स'],
  shorts:              ['shorts',     'शॉर्ट्स'],
  cap:                 ['cap',        'टोपी'],
  hat:                 ['hat',        'टोपी'],
  shoe:                ['shoes',      'जूते'],
  shoes:               ['shoes',      'जूते'],
  sneaker:             ['sneakers',   'स्नीकर्स'],
  sneakers:            ['sneakers',   'स्नीकर्स'],
  boot:                ['boots',      'बूट्स'],
  boots:               ['boots',      'बूट्स'],
  sandal:              ['sandals',    'चप्पल'],
  sandals:             ['sandals',    'चप्पल'],
  slipper:             ['slippers',   'चप्पल'],
  slippers:            ['slippers',   'चप्पल'],
  watch:               ['watch',      'घड़ी'],
  wristwatch:          ['watch',      'घड़ी'],
  bag:                 ['bag',        'बैग'],
  backpack:            ['backpack',   'बैग'],
  handbag:             ['handbag',    'हैंडबैग'],
  wallet:              ['wallet',     'वॉलेट'],
  ring:                ['ring',       'अंगूठी'],
  bracelet:            ['bracelet',   'कंगन'],
  necklace:            ['necklace',   'हार'],
  chain:               ['chain',      'चेन'],
  earring:             ['earrings',   'बालियाँ'],
  earrings:            ['earrings',   'बालियाँ'],
  perfume:             ['perfume',    'परफ्यूम'],
  deodorant:           ['deodorant',  'डीओ'],
  cream:               ['cream',      'क्रीम'],
  lotion:              ['lotion',     'लोशन'],
  shampoo:             ['shampoo',    'शैम्पू'],
  serum:               ['serum',      'सीरम'],
  oil:                 ['oil',        'तेल'],
};

export function speakableProduct(raw, lang) {
  const title = String(raw || '').trim();
  if (!title) return '';
  const isEn = lang === 'en-IN';
  const idx = isEn ? 0 : 1;

  const tokens = title.toLowerCase().split(/[^a-zऀ-ॿ]+/).filter(Boolean);
  for (const t of tokens) {
    if (CATEGORY_MAP[t]) return CATEGORY_MAP[t][idx];
  }

  // No category keyword matched. Don't read the full SKU — trim to first 3
  // tokens of the original title so we emit *something* but limit prosody
  // damage. Seeing this in the wild means CATEGORY_MAP needs a new entry.
  const trimmed = title.split(/\s+/).slice(0, 3).join(' ');
  if (trimmed !== title) {
    console.warn(`[speakableProduct] no category match for "${title}" — trimmed to "${trimmed}". Consider adding a CATEGORY_MAP entry.`);
  }
  return trimmed;
}
