const UNITS = [
  'zéro',
  'un',
  'deux',
  'trois',
  'quatre',
  'cinq',
  'six',
  'sept',
  'huit',
  'neuf',
  'dix',
  'onze',
  'douze',
  'treize',
  'quatorze',
  'quinze',
  'seize',
  'dix-sept',
  'dix-huit',
  'dix-neuf',
];

const TENS = [
  '',
  '',
  'vingt',
  'trente',
  'quarante',
  'cinquante',
  'soixante',
  'soixante',
  'quatre-vingt',
  'quatre-vingt',
];

function convertUnder100(n: number): string {
  if (n < 20) return UNITS[n];
  const ten = Math.floor(n / 10);
  const unit = n % 10;

  if (ten === 7 || ten === 9) {
    const sub = 10 + unit;
    if (sub === 11 && ten === 7) return 'soixante et onze';
    return `${TENS[ten]}-${UNITS[sub]}`;
  }

  if (unit === 0) {
    if (ten === 8) return 'quatre-vingts';
    return TENS[ten];
  }

  if (unit === 1 && ten !== 8) {
    return `${TENS[ten]} et un`;
  }

  return `${TENS[ten]}-${UNITS[unit]}`;
}

function convertUnder1000(n: number): string {
  if (n < 100) return convertUnder100(n);
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;

  let prefix = hundreds === 1 ? 'cent' : `${UNITS[hundreds]} cent`;
  if (rest === 0) {
    return hundreds > 1 ? `${prefix}s` : prefix;
  }
  return `${prefix} ${convertUnder100(rest)}`;
}

export function integerToFrenchWords(num: number): string {
  const n = Math.floor(Math.abs(num));
  if (n === 0) return 'zéro';

  const parts: string[] = [];

  const billions = Math.floor(n / 1_000_000_000);
  const millions = Math.floor((n % 1_000_000_000) / 1_000_000);
  const thousands = Math.floor((n % 1_000_000) / 1_000);
  const remainder = n % 1_000;

  if (billions > 0) {
    parts.push(
      `${integerToFrenchWords(billions)} milliard${billions > 1 ? 's' : ''}`
    );
  }
  if (millions > 0) {
    parts.push(
      `${integerToFrenchWords(millions)} million${millions > 1 ? 's' : ''}`
    );
  }
  if (thousands > 0) {
    if (thousands === 1) parts.push('mille');
    else parts.push(`${convertUnder1000(thousands)} mille`);
  }
  if (remainder > 0) {
    parts.push(convertUnder1000(remainder));
  }

  return parts.join(' ').trim();
}

const CURRENCY_LABELS: Record<
  string,
  { singular: string; plural: string; centSingular: string; centPlural: string }
> = {
  DZD: {
    singular: 'Dinar Algérien',
    plural: 'Dinars Algériens',
    centSingular: 'centime',
    centPlural: 'centimes',
  },
  EUR: {
    singular: 'Euro',
    plural: 'Euros',
    centSingular: 'centime',
    centPlural: 'centimes',
  },
  USD: {
    singular: 'Dollar Américain',
    plural: 'Dollars Américains',
    centSingular: 'cent',
    centPlural: 'cents',
  },
  GBP: {
    singular: 'Livre Sterling',
    plural: 'Livres Sterling',
    centSingular: 'penny',
    centPlural: 'pence',
  },
};

/**
 * Convertit un montant en centimes entiers en lettres françaises officielles.
 * Ex: 62475000 (624 750,00 DZD) -> "six cent vingt-quatre mille sept cent cinquante Dinars Algériens"
 */
export function amountCentimesToFrenchWords(
  centimes: number,
  currencyCode = 'DZD'
): string {
  const safe = Math.abs(Math.round(Number.isFinite(centimes) ? centimes : 0));
  const major = Math.floor(safe / 100);
  const minor = safe % 100;

  const meta = CURRENCY_LABELS[currencyCode] || {
    singular: currencyCode,
    plural: currencyCode,
    centSingular: 'centime',
    centPlural: 'centimes',
  };

  const majorWords = integerToFrenchWords(major);
  const majorUnit = major > 1 ? meta.plural : meta.singular;

  if (minor === 0) {
    return `${majorWords} ${majorUnit}`;
  }

  const minorWords = integerToFrenchWords(minor);
  const minorUnit = minor > 1 ? meta.centPlural : meta.centSingular;
  return `${majorWords} ${majorUnit} et ${minorWords} ${minorUnit}`;
}
