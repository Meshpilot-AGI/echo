/**
 * Fully-spoken Hindi/English for amounts — NO digits anywhere in the output.
 *
 * Earlier the Hindi helper returned a hint like "2350 रुपय (Hindi words: 2
 * हज़ार 350 रुपय)" — which still contained the digits "2", "350" and "2350".
 * The LLM took the path of least resistance and read the digit prefix
 * verbatim ("2350 रुपय"), so the customer heard Arabic numerals in the
 * middle of a Hindi sentence. Since the placeholder is the ONLY thing the
 * LLM sees for the amount, we now return pure spoken words — there is no
 * digit option.
 *
 * Supports 1 – 99,99,999 (covers all realistic COD tickets up to ~1 crore).
 */

const HI_NUM_0_99 = [
  'शून्य','एक','दो','तीन','चार','पाँच','छह','सात','आठ','नौ',
  'दस','ग्यारह','बारह','तेरह','चौदह','पंद्रह','सोलह','सत्रह','अठारह','उन्नीस',
  'बीस','इक्कीस','बाईस','तेईस','चौबीस','पच्चीस','छब्बीस','सत्ताईस','अट्ठाईस','उनतीस',
  'तीस','इकत्तीस','बत्तीस','तैंतीस','चौंतीस','पैंतीस','छत्तीस','सैंतीस','अड़तीस','उनतालीस',
  'चालीस','इकतालीस','बयालीस','तैंतालीस','चौवालीस','पैंतालीस','छियालीस','सैंतालीस','अड़तालीस','उनचास',
  'पचास','इक्यावन','बावन','तिरपन','चौवन','पचपन','छप्पन','सत्तावन','अट्ठावन','उनसठ',
  'साठ','इकसठ','बासठ','तिरसठ','चौंसठ','पैंसठ','छियासठ','सड़सठ','अड़सठ','उनहत्तर',
  'सत्तर','इकहत्तर','बहत्तर','तिहत्तर','चौहत्तर','पचहत्तर','छिहत्तर','सतहत्तर','अठहत्तर','उनासी',
  'अस्सी','इक्यासी','बयासी','तिरासी','चौरासी','पचासी','छियासी','सत्तासी','अट्ठासी','नवासी',
  'नब्बे','इक्यानवे','बानवे','तिरानवे','चौरानवे','पंचानवे','छियानवे','सत्तानवे','अट्ठानवे','निन्यानवे',
];

export function hindiNumber(n) {
  if (n < 100) return HI_NUM_0_99[n];
  if (n < 1000) {
    const h = Math.floor(n / 100), rem = n % 100;
    return HI_NUM_0_99[h] + ' सौ' + (rem ? ' ' + hindiNumber(rem) : '');
  }
  if (n < 100000) {
    const k = Math.floor(n / 1000), rem = n % 1000;
    return hindiNumber(k) + ' हज़ार' + (rem ? ' ' + hindiNumber(rem) : '');
  }
  if (n < 10000000) {
    const l = Math.floor(n / 100000), rem = n % 100000;
    return hindiNumber(l) + ' लाख' + (rem ? ' ' + hindiNumber(rem) : '');
  }
  return String(n); // outside realistic COD range
}

export function hindiRupees(n) {
  const amt = Math.floor(Number(String(n).replace(/[^0-9.]/g, '')));
  if (!Number.isFinite(amt) || amt <= 0) return String(n);
  return `${hindiNumber(amt)} रुपय`;
}

const EN_NUM_0_19 = ['zero','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen'];
const EN_TENS     = ['','','twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety'];

export function englishNumber(n) {
  if (n < 20) return EN_NUM_0_19[n];
  if (n < 100) {
    const t = Math.floor(n / 10), u = n % 10;
    return EN_TENS[t] + (u ? '-' + EN_NUM_0_19[u] : '');
  }
  if (n < 1000) {
    const h = Math.floor(n / 100), rem = n % 100;
    return EN_NUM_0_19[h] + ' hundred' + (rem ? ' ' + englishNumber(rem) : '');
  }
  if (n < 100000) {
    const k = Math.floor(n / 1000), rem = n % 1000;
    return englishNumber(k) + ' thousand' + (rem ? ' ' + englishNumber(rem) : '');
  }
  if (n < 10000000) {
    const l = Math.floor(n / 100000), rem = n % 100000;
    return englishNumber(l) + ' lakh' + (rem ? ' ' + englishNumber(rem) : '');
  }
  return String(n);
}

export function englishRupees(n) {
  const amt = Math.floor(Number(String(n).replace(/[^0-9.]/g, '')));
  if (!Number.isFinite(amt) || amt <= 0) return String(n);
  return `${englishNumber(amt)} rupees`;
}
