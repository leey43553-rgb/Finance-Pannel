import type { CompanyProfile } from '../../db/types';

export interface ParsedBcLine {
  title: string;
  description: string;
  qty: number | null;
  unit: string;
  unitPrice: number | null;
  total: number | null;
}

export interface ParsedBcTotals {
  ht: number | null;
  vatRate: number;
  vat: number | null;
  ttc: number | null;
}

export interface ParsedBcIssuer {
  name: string;
  rc: string;
  nif: string;
  ai: string;
  nis: string;
  address: string;
  email: string;
  phone: string;
}

export interface ParsedBcParty {
  name: string;
  address: string;
  email: string;
  phone: string;
  fax: string;
  rc: string;
  nif: string;
  ai: string;
  nis: string;
}

export interface ParsedPurchaseOrder {
  direction: 'emis' | 'recu';
  matchedCompanyProfileId?: string;
  number: string;
  year: number | null;
  date: string | null;
  city: string;
  issuer: ParsedBcIssuer;
  party: ParsedBcParty;
  lines: ParsedBcLine[];
  totals: ParsedBcTotals | null;
  campaign: string;
  startDate: string | null;
  endDate: string | null;
  delivery: string;
  paymentTerms: string;
  amountInWords: string;
  warnings: string[];
  confidence: Record<string, number>;
  isScannedOcr?: boolean;
}

/** Élément texte positionné (sortie pdfjs ou OCR). y est normalisé de haut en bas (croissant). */
export interface PositionedTextItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
  page?: number;
  confidence?: number;
}

export interface PositionedTextRow {
  page: number;
  y: number;
  text: string;
  segments: Array<{ text: string; x: number; width: number; confidence?: number }>;
  items: PositionedTextItem[];
  confidence?: number;
}

export interface ParsePurchaseOrderOptions {
  companyProfiles?: CompanyProfile[];
  isScannedOcr?: boolean;
  extraWarnings?: string[];
}

export function stripAccents(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export function normSpace(value: unknown): string {
  return String(value ?? '')
    .replace(/\u00a0|\u202f/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

export function normCompare(value: string): string {
  return stripAccents(normSpace(value)).toLowerCase();
}

function normDigits(value?: string): string {
  return (value || '').replace(/\D+/g, '');
}

function normRc(value?: string): string {
  return (value || '').replace(/[^a-zA-Z0-9]+/g, '').toUpperCase();
}

function companyCoreTokens(name?: string): string[] {
  const stop = new Set(['sarl', 'eurl', 'spa', 'sas', 'snc', 'ets', 'epe', 'ste', 'societe', 'entreprise']);
  return normCompare(name || '')
    .split(/[^a-z0-9]+/)
    .filter((tok) => tok.length >= 3 && !stop.has(tok));
}

function isSameCompanyName(a?: string, b?: string): boolean {
  const ta = companyCoreTokens(a);
  const tb = companyCoreTokens(b);
  if (ta.length === 0 || tb.length === 0) return false;
  const setA = new Set(ta);
  const overlap = tb.filter((t) => setA.has(t));
  return overlap.length >= Math.min(ta.length, tb.length) || overlap.length >= 2;
}

const FRENCH_MONTHS: Record<string, number> = {
  janvier: 1,
  janv: 1,
  jan: 1,
  fevrier: 2,
  fevr: 2,
  fev: 2,
  mars: 3,
  mar: 3,
  avril: 4,
  avr: 4,
  mai: 5,
  juin: 6,
  juillet: 7,
  juil: 7,
  aout: 8,
  septembre: 9,
  sept: 9,
  sep: 9,
  octobre: 10,
  oct: 10,
  novembre: 11,
  nov: 11,
  decembre: 12,
  dec: 12,
};

export function parseFrenchOrIsoDate(raw: string): string | null {
  const clean = normCompare(raw);
  if (!clean) return null;

  // YYYY-MM-DD
  const iso = clean.match(/\b((?:19|20)\d{2})[/.-](\d{1,2})[/.-](\d{1,2})\b/);
  if (iso) {
    const y = Number(iso[1]);
    const m = Number(iso[2]);
    const d = Number(iso[3]);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }

  // DD/MM/YYYY or DD-MM-YYYY or DD.MM.YYYY (accept 2 or 4 digit year)
  const dmy = clean.match(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/);
  if (dmy) {
    const d = Number(dmy[1]);
    const m = Number(dmy[2]);
    const yRaw = Number(dmy[3]);
    const y = dmy[3].length === 2 ? 2000 + yRaw : yRaw;
    if (y >= 1990 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }

  // "15 février 2026" / "1er mars 2026"
  const txt = clean.match(/\b(\d{1,2})(?:er|e)?\s+([a-z]{3,10})\.?\s+((?:19|20)\d{2}|\d{2})\b/);
  if (txt) {
    const d = Number(txt[1]);
    const month = FRENCH_MONTHS[txt[2]];
    const y = txt[3].length === 2 ? 2000 + Number(txt[3]) : Number(txt[3]);
    if (month && y >= 1990 && y <= 2100 && d >= 1 && d <= 31) {
      return `${y}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }

  return null;
}

export function parseLocalizedNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  let s = normSpace(raw)
    .replace(/(?:da|dzd|eur|usd|€|\$)$/i, '')
    .replace(/\u00a0|\u202f/g, ' ')
    .trim();
  if (!s) return null;
  // Accepter espaces milliers: "624 750,00" ou "1 200.50"
  s = s.replace(/\s+/g, '');
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) {
    s = s.replace(/,/g, '');
  } else {
    s = s.replace(',', '.');
  }
  if (!/^-?\d+(?:\.\d+)?$/.test(s)) return null;
  const num = Number(s);
  return Number.isFinite(num) ? num : null;
}

export function parseQuantityAndUnit(raw: string): { qty: number | null; unit: string } {
  const s = normSpace(raw);
  if (!s) return { qty: null, unit: '' };
  const m = s.match(/^(\d[\d\s.,]*)\s*(.*)$/);
  if (m) {
    const qty = parseLocalizedNumber(m[1]);
    const unit = normSpace(m[2]);
    if (qty !== null) {
      return { qty, unit };
    }
  }
  return { qty: null, unit: '' };
}

/**
 * Regroupe des éléments PDF/OCR positionnés en lignes horizontales selon y (tolérance verticale).
 */
export function groupPositionedItemsIntoRows(items: PositionedTextItem[]): PositionedTextRow[] {
  const valid = items
    .map((it) => ({ ...it, str: normSpace(it.str) }))
    .filter((it) => it.str.length > 0);
  if (valid.length === 0) return [];

  const heights = valid.map((i) => i.height).filter((h) => h > 0).sort((a, b) => a - b);
  const medianHeight = heights.length > 0 ? heights[Math.floor(heights.length / 2)] : 10;
  const yTolerance = Math.max(3.5, medianHeight * 0.55);

  const byPage = new Map<number, PositionedTextItem[]>();
  for (const it of valid) {
    const p = it.page || 1;
    const arr = byPage.get(p) || [];
    arr.push(it);
    byPage.set(p, arr);
  }

  const rows: PositionedTextRow[] = [];
  const pages = Array.from(byPage.keys()).sort((a, b) => a - b);

  for (const page of pages) {
    const pageItems = (byPage.get(page) || []).slice().sort((a, b) => a.y - b.y || a.x - b.x);
    const groups: Array<{ y: number; items: PositionedTextItem[] }> = [];

    for (const item of pageItems) {
      let target = groups.find((g) => Math.abs(g.y - item.y) <= yTolerance);
      if (!target) {
        target = { y: item.y, items: [item] };
        groups.push(target);
      } else {
        target.items.push(item);
        target.y = target.items.reduce((s, x) => s + x.y, 0) / target.items.length;
      }
    }

    groups.sort((a, b) => a.y - b.y);

    for (const g of groups) {
      const sorted = g.items.slice().sort((a, b) => a.x - b.x);
      // Reconstruire segments séparés par un large espace horizontal (tableaux / blocs côte-à-côte)
      const segments: PositionedTextRow['segments'] = [];
      let curText = '';
      let curStartX = sorted[0].x;
      let curEndX = sorted[0].x + Math.max(sorted[0].width, sorted[0].str.length * 4);
      const segConfs: number[] = [];

      const flushSegment = () => {
        const trimmed = normSpace(curText);
        if (trimmed) {
          const avgConf =
            segConfs.length > 0 ? segConfs.reduce((a, b) => a + b, 0) / segConfs.length : undefined;
          segments.push({
            text: trimmed,
            x: curStartX,
            width: Math.max(1, curEndX - curStartX),
            confidence: avgConf,
          });
        }
      };

      const gapThreshold = Math.max(22, medianHeight * 2.2);
      for (let i = 0; i < sorted.length; i += 1) {
        const it = sorted[i];
        const estWidth = Math.max(it.width || 0, it.str.length * Math.max(3.5, medianHeight * 0.45));
        if (i === 0) {
          curText = it.str;
          curStartX = it.x;
          curEndX = it.x + estWidth;
          if (typeof it.confidence === 'number') segConfs.push(it.confidence);
          continue;
        }
        const gap = it.x - curEndX;
        if (gap > gapThreshold) {
          flushSegment();
          curText = it.str;
          curStartX = it.x;
          curEndX = it.x + estWidth;
          segConfs.length = 0;
          if (typeof it.confidence === 'number') segConfs.push(it.confidence);
        } else {
          const needsSpace = gap > 1.5 && !curText.endsWith(' ') && !it.str.startsWith(' ');
          curText += (needsSpace ? ' ' : '') + it.str;
          curEndX = Math.max(curEndX, it.x + estWidth);
          if (typeof it.confidence === 'number') segConfs.push(it.confidence);
        }
      }
      flushSegment();

      const allConfs = sorted.map((s) => s.confidence).filter((c): c is number => typeof c === 'number');
      const rowConf =
        allConfs.length > 0 ? allConfs.reduce((a, b) => a + b, 0) / allConfs.length : undefined;

      rows.push({
        page,
        y: g.y,
        text: segments.map((s) => s.text).join(' | '),
        segments,
        items: sorted,
        confidence: rowConf,
      });
    }
  }

  return rows;
}

function normalizePlainTextToRows(input: string | string[]): PositionedTextRow[] {
  const rawLines = Array.isArray(input)
    ? input
    : input.includes('\n')
    ? input.split(/\r?\n/)
    : input.split(/\s*\|\s*/);

  const expanded: string[] = [];
  for (const line of rawLines) {
    const clean = normSpace(line);
    if (!clean) continue;
    // Si une ligne contient des séparateurs "|" explicites (comme une fixture), découper proprement
    // sauf si c'est clairement un en-tête de tableau "N° | Désignation | ..." qu'on garde sur une ligne
    if (clean.includes('|') && !isTableHeaderText(clean)) {
      const subs = clean.split(/\s*\|\s*/).map(normSpace).filter(Boolean);
      expanded.push(...subs);
    } else {
      expanded.push(clean);
    }
  }

  return expanded.map((text, idx) => ({
    page: 1,
    y: idx * 20,
    text,
    segments: [{ text, x: 0, width: text.length * 6 }],
    items: [],
  }));
}

function isTableHeaderText(raw: string): boolean {
  const n = normCompare(raw);
  const hits = [
    /\bdesignation\b|\bdescription\b|\blibelle\b|\barticle\b/.test(n),
    /\bquantite\b|\bqte\b|\bqty\b/.test(n),
    /\bprix\b|\bp\.?u\b|\bpu\b/.test(n),
    /\btotal\b|\bmontant\b/.test(n),
    /\bn\s*[°ºo]?\b/.test(n),
  ].filter(Boolean).length;
  return /\bdesignation\b|\blibelle\b|\bdescription\b/.test(n) && hits >= 2;
}

function extractFiscalTokensFromText(text: string): Partial<ParsedBcIssuer> {
  const out: Partial<ParsedBcIssuer> = {};
  const clean = normSpace(text);

  const rcMatch = clean.match(
    /\bR\.?\s*C\.?\s*(?:N\s*[°ºo.]?)?\s*[:.]?\s*([A-Z0-9][A-Z0-9/\-.\s]{3,28}?)(?=\s*(?:\s[-–—]\s|\||$|N\.?I\.?F\b|A\.?I\b|N\.?I\.?S\b|I\.?F\b|T[ée]l|Fax|E-?mail))/i
  );
  if (rcMatch?.[1]) out.rc = normSpace(rcMatch[1]);

  const nifMatch = clean.match(
    /\b(?:N\.?\s*I\.?\s*F|I\.?\s*F)\s*(?:N\s*[°ºo.]?)?\s*[:.]?\s*([0-9][0-9\s]{6,22})(?=\s*(?:\s[-–—]\s|\||$|R\.?C\b|A\.?I\b|N\.?I\.?S\b|T[ée]l|Fax|E-?mail|[A-Za-z]))/i
  );
  if (nifMatch?.[1]) out.nif = nifMatch[1].replace(/\s+/g, '');

  const aiMatch = clean.match(
    /\b(?:A\.?\s*I|Art(?:icle)?\.?\s*Imp(?:osition)?)\s*(?:N\s*[°ºo.]?)?\s*[:.]?\s*([0-9][0-9\s]{5,20})(?=\s*(?:\s[-–—]\s|\||$|R\.?C\b|N\.?I\.?F\b|N\.?I\.?S\b|T[ée]l|Fax|E-?mail|[A-Za-z]))/i
  );
  if (aiMatch?.[1]) out.ai = aiMatch[1].replace(/\s+/g, '');

  const nisMatch = clean.match(
    /\bN\.?\s*I\.?\s*S\s*(?:N\s*[°ºo.]?)?\s*[:.]?\s*([0-9][0-9\s]{6,22})(?=\s*(?:\s[-–—]\s|\||$|R\.?C\b|N\.?I\.?F\b|A\.?I\b|T[ée]l|Fax|E-?mail|[A-Za-z]))/i
  );
  if (nisMatch?.[1]) out.nis = nisMatch[1].replace(/\s+/g, '');

  return out;
}

function isAnyKnownLabel(text: string): boolean {
  const n = normCompare(text);
  return (
    /^(?:client|fournisseur|destinataire|entreprise|societe|raison sociale|nom|a l'attention de|adresse|adr|code postal|cp|ville|wilaya|email|e-?mail|courriel|mail|tel(?:\s*&\s*fax)?|telephone|mobile|gsm|fax|rc|r\.c|nif|n\.i\.f|ai|a\.i|nis|n\.i\.s|contact)\s*(?:n\s*[°o.]?)?\s*:?/i.test(
      n
    ) ||
    /^(?:bon de commande|bc\s*n|commande\s*n|n[°o]?\s*de\s*commande|total\s*ht|tva|total\s*ttc|arrete|campagne|objet|livraison|lieu de livraison|delai|conditions? de paiement|paiement)/i.test(
      n
    )
  );
}

function isPartyStartLabel(text: string): { matched: boolean; value: string } {
  const clean = normSpace(text);
  const m = clean.match(
    /^(?:Client|Fournisseur|Destinataire|À\s*l['’]attention\s*de|A\s*l['’]attention\s*de|Pour\s*le\s*compte\s*de)\s*[:.]?\s*(.*)$/i
  );
  if (m) return { matched: true, value: normSpace(m[1]) };
  const mNom = clean.match(/^(?:NOM|Raison\s*sociale)\s*:\s*(.*)$/i);
  if (mNom) return { matched: true, value: normSpace(mNom[1]) };
  return { matched: false, value: '' };
}

function isHeaderAddressLike(text: string): boolean {
  const n = normCompare(text);
  return (
    /\b(?:rue|route|rn|nationale|avenue|av\.|boulevard|bd|cite|zone|lot|bp|safex|pins maritimes|mohammadia|etage|imm|bt|quartier|hay|commune|wilaya|alger|oran|constantine|setif|annaba|blida|bejaia|tizi)\b/.test(
      n
    ) || /,\s*[a-z]+/.test(n)
  );
}

export function detectBcDirectionAndProfile(params: {
  issuer: Partial<ParsedBcIssuer>;
  party: Partial<ParsedBcParty>;
  rawText: string;
  companyProfiles?: CompanyProfile[];
}): { direction: 'emis' | 'recu'; matchedCompanyProfileId?: string } {
  const profiles = (params.companyProfiles || []).filter((p) => !p.deletedAt);
  if (profiles.length === 0) {
    return { direction: 'recu' };
  }

  const issuerNif = normDigits(params.issuer.nif);
  const issuerRc = normRc(params.issuer.rc);

  // 1. Vérifier si l'émetteur correspond à l'une de nos sociétés -> BC ÉMIS
  for (const prof of profiles) {
    const pNif = normDigits(prof.nif);
    const pRc = normRc(prof.rc);
    if (issuerNif && pNif && issuerNif === pNif) {
      return { direction: 'emis', matchedCompanyProfileId: prof.id };
    }
    if (issuerRc && pRc && issuerRc === pRc) {
      return { direction: 'emis', matchedCompanyProfileId: prof.id };
    }
    if (params.issuer.name && isSameCompanyName(params.issuer.name, prof.name)) {
      return { direction: 'emis', matchedCompanyProfileId: prof.id };
    }
  }

  // 2. Sinon c'est un BC REÇU : essayer d'identifier laquelle de nos sociétés est destinataire
  const partyNif = normDigits(params.party.nif);
  const partyRc = normRc(params.party.rc);
  const rawNorm = normCompare(params.rawText);

  for (const prof of profiles) {
    const pNif = normDigits(prof.nif);
    const pRc = normRc(prof.rc);
    if (partyNif && pNif && partyNif === pNif) {
      return { direction: 'recu', matchedCompanyProfileId: prof.id };
    }
    if (partyRc && pRc && partyRc === pRc) {
      return { direction: 'recu', matchedCompanyProfileId: prof.id };
    }
    if (params.party.name && isSameCompanyName(params.party.name, prof.name)) {
      return { direction: 'recu', matchedCompanyProfileId: prof.id };
    }
  }

  // Recherche dans le texte global du document
  for (const prof of profiles) {
    const pNif = normDigits(prof.nif);
    const pRc = normRc(prof.rc);
    if (pNif && rawNorm.replace(/\s+/g, '').includes(pNif)) {
      return { direction: 'recu', matchedCompanyProfileId: prof.id };
    }
    if (pRc && rawNorm.replace(/[^a-z0-9]/g, '').includes(pRc.toLowerCase())) {
      return { direction: 'recu', matchedCompanyProfileId: prof.id };
    }
    const tokens = companyCoreTokens(prof.name);
    if (tokens.length >= 2 && tokens.every((t) => rawNorm.includes(t))) {
      return { direction: 'recu', matchedCompanyProfileId: prof.id };
    }
  }

  return { direction: 'recu' };
}

interface TableCols {
  n?: number;
  des?: number;
  qty?: number;
  unit?: number;
  price?: number;
  total?: number;
}

function detectPositionedTableColumns(row: PositionedTextRow): TableCols | null {
  const items = row.items.length > 0 ? row.items : [];
  if (items.length < 2) return null;

  const cols: TableCols = {};
  for (const it of items) {
    const n = normCompare(it.str);
    const cx = it.x + Math.max(it.width, it.str.length * 4) / 2;
    if (/^(?:n\s*[°ºo]?|no|num|item|#)$/.test(n) && cols.n === undefined) {
      cols.n = cx;
    } else if (/(?:designation|description|libelle|article|prestation)/.test(n) && cols.des === undefined) {
      cols.des = cx;
    } else if (/^(?:quantite|qte|qty)$/.test(n) && cols.qty === undefined) {
      cols.qty = cx;
    } else if (/^(?:unite|u\.?)$/.test(n) && cols.unit === undefined) {
      cols.unit = cx;
    } else if (/(?:prix|p\.?u|pu|tarif)/.test(n) && cols.price === undefined) {
      cols.price = cx;
    } else if (/(?:total|montant)/.test(n)) {
      cols.total = cx;
    }
  }

  const foundCount = Object.keys(cols).length;
  if (cols.des !== undefined && foundCount >= 2) {
    return cols;
  }
  return null;
}

function assignItemToTableColumn(item: PositionedTextItem, cols: TableCols): keyof TableCols {
  const cx = item.x + Math.max(item.width, item.str.length * 4) / 2;
  const entries = (Object.entries(cols) as Array<[keyof TableCols, number | undefined]>).filter(
    (e): e is [keyof TableCols, number] => typeof e[1] === 'number'
  );
  // Si Désignation est une grande colonne large à gauche de Quantité, utiliser la borne milieu
  entries.sort((a, b) => a[1] - b[1]);

  // Pour les colonnes numériques (qty, unit, price, total), utiliser la frontière entre des et la première colonne droite
  let bestKey: keyof TableCols = 'des';
  let bestDist = Infinity;
  for (const [k, pos] of entries) {
    const dist =
      k === 'des' && cols.qty !== undefined && cx >= (pos + cols.qty) / 2
        ? Math.abs(cx - pos) + 40
        : Math.abs(cx - pos);
    if (dist < bestDist) {
      bestDist = dist;
      bestKey = k;
    }
  }
  // Si item est clairement entre cols.n et cols.qty (large colonne Désignation)
  if (
    cols.n !== undefined &&
    cols.des !== undefined &&
    cx > (cols.n + cols.des) / 2 &&
    (cols.qty === undefined || cx < (cols.des + cols.qty) / 2)
  ) {
    return 'des';
  }
  return bestKey;
}

function isUnitContinuationToken(rest: string): boolean {
  return /^(?:m2|m²|m3|m³|metre|mètre|cm|mm|kg|g|l|mois|jour|jours|j|an|ans|u|unite|unités|face|faces|panneau|panneaux|%|x|×)\b/i.test(
    normCompare(rest)
  );
}

/**
 * Analyseur pur pour Bons de Commande (texte PDF, lignes OCR, ou texte brut).
 */
export function parsePurchaseOrder(
  input: string | string[] | PositionedTextItem[] | PositionedTextRow[],
  options: ParsePurchaseOrderOptions = {}
): ParsedPurchaseOrder {
  const isScannedOcr = Boolean(options.isScannedOcr);
  let rows: PositionedTextRow[];
  let hasPositionedItems = false;

  if (typeof input === 'string') {
    rows = normalizePlainTextToRows(input);
  } else if (Array.isArray(input) && input.length === 0) {
    rows = [];
  } else if (Array.isArray(input) && typeof input[0] === 'string') {
    rows = normalizePlainTextToRows(input as string[]);
  } else if (Array.isArray(input) && 'str' in (input[0] as object)) {
    rows = groupPositionedItemsIntoRows(input as PositionedTextItem[]);
    hasPositionedItems = true;
  } else {
    rows = (input as PositionedTextRow[]).slice();
    hasPositionedItems = rows.some((r) => r.items && r.items.length > 0);
  }

  const allText = rows.map((r) => r.text).join('\n');
  const rowConfs = rows.map((r) => (typeof r.confidence === 'number' ? r.confidence : isScannedOcr ? 0.65 : 0.96));
  const confAt = (rowIndex: number, fallback = isScannedOcr ? 0.65 : 0.96): number => {
    if (rowIndex < 0 || rowIndex >= rowConfs.length) return fallback;
    const c = rowConfs[rowIndex];
    return Number(Math.max(0, Math.min(1, c)).toFixed(2));
  };

  const warnings: string[] = [];
  if (isScannedOcr) {
    warnings.push("Lecture automatique d'un scan : vérifiez chaque champ");
  }
  if (options.extraWarnings?.length) {
    warnings.push(...options.extraWarnings);
  }

  const confidence: Record<string, number> = {};

  // --------------------------------------------------------------------------
  // 1. LOCALISER L'EN-TÊTE DU TABLEAU & LE BLOC TOTAUX / PIED
  // --------------------------------------------------------------------------
  let tableHeaderStartIdx = -1;
  let tableHeaderEndIdx = -1;
  let tableCols: TableCols | null = null;

  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    if (hasPositionedItems) {
      const cols = detectPositionedTableColumns(r);
      if (cols) {
        tableHeaderStartIdx = i;
        tableHeaderEndIdx = i;
        tableCols = cols;
        break;
      }
    }
    if (isTableHeaderText(r.text)) {
      tableHeaderStartIdx = i;
      tableHeaderEndIdx = i;
      break;
    }
    // Cas où la fixture sépare les colonnes d'en-tête sur 3 à 6 lignes consécutives :
    // "N°" / "Désignation" / "Quantité" / "Prix u" / "Total"
    const nTok = normCompare(r.text);
    if (/^(?:n\s*[°ºo]?|designation)$/.test(nTok)) {
      const windowSlice = rows.slice(i, Math.min(rows.length, i + 6));
      const joined = windowSlice.map((x) => x.text).join(' ');
      if (isTableHeaderText(joined)) {
        let lastTokIdx = i;
        for (let k = i; k < Math.min(rows.length, i + 6); k += 1) {
          const t = normCompare(rows[k].text);
          if (/^(?:n\s*[°ºo]?|no|designation|description|libelle|quantite|qte|qty|unite|prix.*|p\.?u|pu|total.*|montant.*)$/.test(t)) {
            lastTokIdx = k;
          } else {
            break;
          }
        }
        if (lastTokIdx > i) {
          tableHeaderStartIdx = i;
          tableHeaderEndIdx = lastTokIdx;
          break;
        }
      }
    }
  }

  let tableEndIdx = rows.length;
  const searchTotalFrom = tableHeaderEndIdx >= 0 ? tableHeaderEndIdx + 1 : 0;
  for (let i = searchTotalFrom; i < rows.length; i += 1) {
    const n = normCompare(rows[i].text);
    if (/^(?:total\s*h\.?t|sous[\s-]*total|montant\s*h\.?t|t\.?v\.?a\b|total\s*t\.?t\.?c|arrete\s+le\s+present)/.test(n)) {
      tableEndIdx = i;
      break;
    }
  }

  // --------------------------------------------------------------------------
  // 2. EXTRAIRE NUMÉRO BC, DATE, VILLE, CAMPAGNE, LIVRAISON, PAIEMENT
  // --------------------------------------------------------------------------
  let bcNumber = '';
  let bcNumberRow = -1;
  let bcYear: number | null = null;
  let bcDate: string | null = null;
  let bcDateRow = -1;
  let city = '';
  let campaign = '';
  let startDate: string | null = null;
  let endDate: string | null = null;
  let delivery = '';
  let paymentTerms = '';
  let amountInWords = '';

  const headerRowsLimit = tableHeaderStartIdx >= 0 ? tableHeaderStartIdx : rows.length;

  // Parcourir tous les segments pour numéro BC, date, campagne, etc.
  for (let i = 0; i < rows.length; i += 1) {
    const segs = rows[i].segments.length > 0 ? rows[i].segments : [{ text: rows[i].text, x: 0, width: 100 }];
    for (const seg of segs) {
      const t = normSpace(seg.text);
      const n = normCompare(t);

      // Numéro BC
      if (!bcNumber && i <= headerRowsLimit) {
        const mPrimary = t.match(
          /(?:Bon\s*de\s*commande|Commande|B\.?\s*C\.?)\s*(?:N\s*[°ºo.]?|No|Num[ée]ro)?\s*[:.]?\s*([A-Z0-9][A-Z0-9./\-]*)/i
        );
        const mNdeCmd = t.match(
          /N\s*[°ºo.]?\s*(?:de\s*)?(?:bon\s*de\s*)?commande\s*[:.]?\s*([A-Z0-9][A-Z0-9./\-]*)/i
        );
        const mRef = !mPrimary && !mNdeCmd ? t.match(/^R[ée]f(?:[ée]rence)?\.?\s*[:.]?\s*([A-Z0-9][A-Z0-9./\-]*)/i) : null;
        const candidate = mPrimary?.[1] || mNdeCmd?.[1] || mRef?.[1] || '';
        if (candidate && /\d/.test(candidate)) {
          bcNumber = candidate.replace(/[.,;]+$/, '');
          bcNumberRow = i;
        }
      }

      // Ville + Date ("Alger le : 15-02-2026" ou "Alger, le 15 février 2026")
      if (!bcDate && i <= headerRowsLimit + 2) {
        const cityDateMatch = t.match(/^(.*?)[,\s]+\ble\s*[:.]?\s*(.+)$/i);
        if (cityDateMatch) {
          const parsed = parseFrenchOrIsoDate(cityDateMatch[2]);
          if (parsed) {
            bcDate = parsed;
            bcDateRow = i;
            const cCand = normSpace(cityDateMatch[1].replace(/^(?:fait\s+a|a)\s+/i, ''));
            if (cCand && cCand.length <= 32 && !/\d/.test(cCand) && !/commande|facture/i.test(cCand)) {
              city = cCand;
            }
          }
        }
        if (!bcDate && /^date\s*[:.]?\s*(.+)$/i.test(t)) {
          const mDateLabel = t.match(/^date\s*[:.]?\s*(.+)$/i);
          if (mDateLabel) {
            const parsed = parseFrenchOrIsoDate(mDateLabel[1]);
            if (parsed) {
              bcDate = parsed;
              bcDateRow = i;
            }
          }
        }
        if (!bcDate && /^le\s*[:.]?\s*(.+)$/i.test(t)) {
          const mLe = t.match(/^le\s*[:.]?\s*(.+)$/i);
          if (mLe) {
            const parsed = parseFrenchOrIsoDate(mLe[1]);
            if (parsed) {
              bcDate = parsed;
              bcDateRow = i;
            }
          }
        }
      }

      // Campagne / Objet
      if (!campaign) {
        const mCamp = t.match(/^(?:Campagne|Objet|Projet|Intitul[ée])\s*[:.]\s*(.+)$/i);
        if (mCamp?.[1]) {
          campaign = normSpace(mCamp[1]);
        }
      }

      // Période / Du ... au ...
      const mPeriod = n.match(/\bdu\s+(.+?)\s+au\s+(.+?)(?:\s*$|\s*[|(])/i);
      if (mPeriod && !startDate && !endDate) {
        const sd = parseFrenchOrIsoDate(mPeriod[1]);
        const ed = parseFrenchOrIsoDate(mPeriod[2]);
        if (sd) startDate = sd;
        if (ed) endDate = ed;
      }

      // Lieu / délai de livraison
      if (!delivery) {
        const mDel = t.match(/^(?:Lieu\s*de\s*livraison|Adresse\s*de\s*livraison|Livraison|D[ée]lai(?:\s*de\s*(?:livraison|r[ée]alisation|ex[ée]cution))?)\s*[:.]\s*(.+)$/i);
        if (mDel?.[1]) {
          delivery = normSpace(mDel[1]);
        }
      }

      // Conditions de paiement
      if (!paymentTerms) {
        const mPay = t.match(/^(?:Conditions?\s*de\s*paiement|Mode\s*de\s*paiement|Paiement|R[èe]glement)\s*[:.]\s*(.+)$/i);
        if (mPay?.[1]) {
          paymentTerms = normSpace(mPay[1]);
        }
      }

      // Arrêté à la somme de :
      const mWords = t.match(/Arr[êe]t[ée]\s+le\s+pr[ée]sent\s+bon\s+de\s+commande\s+[àa]\s+la\s+somme\s+de\s*:?\s*(.*)$/i);
      if (mWords) {
        let w = normSpace(mWords[1]);
        if (!w && i + 1 < rows.length) {
          const next = normSpace(rows[i + 1].text);
          if (next && !isAnyKnownLabel(next) && !/cachet|signature|email|tel/i.test(next)) {
            w = next;
          }
        }
        if (w) amountInWords = w;
      }
    }
  }

  // Fallback date sans "le"
  if (!bcDate) {
    for (let i = 0; i < Math.min(rows.length, headerRowsLimit + 1); i += 1) {
      const parsed = parseFrenchOrIsoDate(rows[i].text);
      if (parsed) {
        bcDate = parsed;
        bcDateRow = i;
        break;
      }
    }
  }

  if (bcNumber) {
    const mYr = bcNumber.match(/\/(\d{2,4})(?:\/|$|-)/) || bcNumber.match(/(?:^|-)((?:19|20)\d{2})(?:-|$)/);
    if (mYr) {
      bcYear = mYr[1].length === 2 ? 2000 + Number(mYr[1]) : Number(mYr[1]);
    }
  }
  if (!bcYear && bcDate) {
    bcYear = Number(bcDate.slice(0, 4));
  }

  // --------------------------------------------------------------------------
  // 3. EXTRAIRE ÉMETTEUR (ISSUER) ET DESTINATAIRE (PARTY)
  // --------------------------------------------------------------------------
  const issuer: ParsedBcIssuer = {
    name: '',
    rc: '',
    nif: '',
    ai: '',
    nis: '',
    address: '',
    email: '',
    phone: '',
  };
  const party: ParsedBcParty = {
    name: '',
    address: '',
    email: '',
    phone: '',
    fax: '',
    rc: '',
    nif: '',
    ai: '',
    nis: '',
  };

  let inPartyBlock = false;
  let partyBlockStartRow = -1;
  let pendingPartyField: keyof ParsedBcParty | null = null;
  let lastPartyField: keyof ParsedBcParty | null = null;
  const issuerHeaderCandidates: Array<{ text: string; row: number }> = [];

  let partyNameRow = -1;
  let partyAddrRow = -1;
  let partyEmailRow = -1;
  let partyPhoneRow = -1;
  let issuerBandRow = -1;

  for (let i = 0; i < headerRowsLimit; i += 1) {
    const segs = rows[i].segments.length > 0 ? rows[i].segments : [{ text: rows[i].text, x: 0, width: 100 }];

    for (const seg of segs) {
      const t = normSpace(seg.text);
      if (!t) continue;

      // Ne pas confondre ligne "Bon de commande n°..." ou "Alger le : ..." avec un nom ou une adresse
      if (
        /^(?:Bon\s*de\s*commande|Commande\s*N|B\.?\s*C\.?\s*N|N\s*[°ºo]?\s*(?:de\s*)?commande)/i.test(t) ||
        (i === bcDateRow && /\ble\s*[:.]?\s*\d/i.test(t))
      ) {
        // Si un bloc party était ouvert mais on rencontre une section document majeure plus bas, fermer pending
        pendingPartyField = null;
        continue;
      }

      // Début du bloc autre partie ("Client :", "Fournisseur :", "Destinataire :")
      const startParty = isPartyStartLabel(t);
      if (startParty.matched) {
        inPartyBlock = true;
        if (partyBlockStartRow < 0) partyBlockStartRow = i;
        if (startParty.value) {
          party.name = startParty.value;
          partyNameRow = i;
          pendingPartyField = null;
          lastPartyField = 'name';
        } else {
          pendingPartyField = 'name';
        }
        continue;
      }

      // Champs explicites
      const fiscal = extractFiscalTokensFromText(t);
      const hasAnyFiscal = Boolean(fiscal.rc || fiscal.nif || fiscal.ai || fiscal.nis);

      if (inPartyBlock) {
        const mAddr = t.match(/^(?:Adresse|Adr\.?)\s*[:.]?\s*(.*)$/i);
        if (mAddr) {
          const v = normSpace(mAddr[1]);
          if (v) {
            party.address = v;
            partyAddrRow = i;
            pendingPartyField = null;
            lastPartyField = 'address';
          } else {
            pendingPartyField = 'address';
          }
          continue;
        }
        const mEmail = t.match(/^(?:E-?mail|Courriel|Mail)\s*[:.]?\s*(.*)$/i);
        if (mEmail) {
          const v = normSpace(mEmail[1]);
          if (v) {
            party.email = v;
            partyEmailRow = i;
            pendingPartyField = null;
            lastPartyField = 'email';
          } else {
            pendingPartyField = 'email';
          }
          continue;
        }
        const mFax = t.match(/^Fax\s*[:.]?\s*(.*)$/i);
        if (mFax) {
          const v = normSpace(mFax[1]);
          if (v) {
            party.fax = v;
            pendingPartyField = null;
            lastPartyField = 'fax';
          } else {
            pendingPartyField = 'fax';
          }
          continue;
        }
        const mTel = t.match(/^(?:T[ée]l(?:[ée]phone)?(?:\s*&\s*Fax)?|Mobile|GSM)\s*[:.]?\s*(.*)$/i);
        if (mTel) {
          const v = normSpace(mTel[1]);
          if (v) {
            party.phone = v;
            partyPhoneRow = i;
            pendingPartyField = null;
            lastPartyField = 'phone';
          } else {
            pendingPartyField = 'phone';
          }
          continue;
        }

        if (hasAnyFiscal) {
          if (fiscal.rc && !party.rc) party.rc = fiscal.rc;
          if (fiscal.nif && !party.nif) party.nif = fiscal.nif;
          if (fiscal.ai && !party.ai) party.ai = fiscal.ai;
          if (fiscal.nis && !party.nis) party.nis = fiscal.nis;
          pendingPartyField = null;
          lastPartyField = null;
          continue;
        }

        // Si un label inconnu (Campagne, Livraison...) apparaît, stopper pendingPartyField
        if (isAnyKnownLabel(t)) {
          pendingPartyField = null;
          lastPartyField = null;
          continue;
        }

        // Valeur sous le label (ligne suivante sans étiquette)
        if (pendingPartyField) {
          party[pendingPartyField] = t;
          if (pendingPartyField === 'name') partyNameRow = i;
          if (pendingPartyField === 'address') partyAddrRow = i;
          if (pendingPartyField === 'email') partyEmailRow = i;
          if (pendingPartyField === 'phone') partyPhoneRow = i;
          lastPartyField = pendingPartyField;
          pendingPartyField = null;
          continue;
        }

        // Continuation multi-ligne de l'adresse (uniquement si juste après Adresse et avant autre champ)
        if (lastPartyField === 'address' && party.address && !/@/.test(t) && !/^\+?\d[\d\s\-/]{5,}$/.test(t)) {
          party.address = `${party.address} ${t}`.trim();
          continue;
        }

        continue;
      }

      // --- Zone émetteur (avant le bloc Client / Fournisseur) ---
      if (hasAnyFiscal) {
        if (fiscal.rc && !issuer.rc) issuer.rc = fiscal.rc;
        if (fiscal.nif && !issuer.nif) issuer.nif = fiscal.nif;
        if (fiscal.ai && !issuer.ai) issuer.ai = fiscal.ai;
        if (fiscal.nis && !issuer.nis) issuer.nis = fiscal.nis;
        issuerBandRow = i;
        continue;
      }

      const mEmail = t.match(/^(?:E-?mail|Courriel|Mail)\s*[:.]\s*(.+)$/i);
      if (mEmail) {
        if (!issuer.email) issuer.email = normSpace(mEmail[1]);
        continue;
      }

      const mTel = t.match(/^(?:T[ée]l(?:[ée]phone)?(?:\s*&\s*Fax)?|Mobile|GSM)\s*[:.]\s*(.+)$/i);
      if (mTel) {
        if (!issuer.phone) issuer.phone = normSpace(mTel[1]);
        continue;
      }

      const mAddr = t.match(/^(?:Adresse|Adr\.?|Si[èe]ge)\s*[:.]\s*(.+)$/i);
      if (mAddr) {
        if (!issuer.address) issuer.address = normSpace(mAddr[1]);
        continue;
      }

      if (!isAnyKnownLabel(t)) {
        // Extraire email / tél inline si collés sans préfixe "Email:"
        const bareEmail = t.match(/^([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})$/i);
        if (bareEmail && !issuer.email) {
          issuer.email = bareEmail[1];
          continue;
        }
        issuerHeaderCandidates.push({ text: t, row: i });
      }
    }
  }

  // Scanner le pied de page après les totaux pour compléter l'émetteur si manquant (ex: pied rose Email/Tel ou bande fiscale en pied)
  for (let i = Math.min(rows.length, tableEndIdx); i < rows.length; i += 1) {
    const t = rows[i].text;
    const fiscal = extractFiscalTokensFromText(t);
    if (fiscal.rc && !issuer.rc) issuer.rc = fiscal.rc;
    if (fiscal.nif && !issuer.nif) issuer.nif = fiscal.nif;
    if (fiscal.ai && !issuer.ai) issuer.ai = fiscal.ai;
    if (fiscal.nis && !issuer.nis) issuer.nis = fiscal.nis;
    const mEmail = t.match(/(?:E-?mail|Courriel)\s*[:.]\s*([^\s/|]+@[^\s/|]+)/i);
    if (mEmail && !issuer.email) issuer.email = normSpace(mEmail[1]);
    const mTel = t.match(/(?:T[ée]l|Tel)\s*[:.]\s*([^|/\n]+)/i);
    if (mTel && !issuer.phone) issuer.phone = normSpace(mTel[1]);
  }

  // Classer les lignes brutes de l'en-tête émetteur entre Nom et Adresse
  for (const cand of issuerHeaderCandidates) {
    if (!issuer.name && !isHeaderAddressLike(cand.text)) {
      issuer.name = cand.text;
    } else if (!issuer.address && isHeaderAddressLike(cand.text)) {
      issuer.address = cand.text;
    } else if (issuer.address && isHeaderAddressLike(cand.text)) {
      issuer.address = `${issuer.address}, ${cand.text}`;
    } else if (!issuer.name) {
      issuer.name = cand.text;
    }
  }

  // Détection automatique de direction & société
  const detected = detectBcDirectionAndProfile({
    issuer,
    party,
    rawText: allText,
    companyProfiles: options.companyProfiles,
  });

  if (detected.direction === 'emis' && detected.matchedCompanyProfileId && !issuer.name) {
    const prof = (options.companyProfiles || []).find((p) => p.id === detected.matchedCompanyProfileId);
    if (prof) issuer.name = prof.name;
  }

  // --------------------------------------------------------------------------
  // 4. PARSER LE TABLEAU DES LIGNES
  // --------------------------------------------------------------------------
  const lines: ParsedBcLine[] = [];
  const lineConfidences: number[] = [];

  if (tableHeaderEndIdx >= 0) {
    const bodyStart = tableHeaderEndIdx + 1;
    let lastNum = 0;

    for (let i = bodyStart; i < tableEndIdx; i += 1) {
      const row = rows[i];
      const text = normSpace(row.text);
      if (!text) continue;

      if (tableCols && row.items.length > 0) {
        const buckets: Record<keyof TableCols, string[]> = {
          n: [],
          des: [],
          qty: [],
          unit: [],
          price: [],
          total: [],
        };
        for (const it of row.items) {
          const col = assignItemToTableColumn(it, tableCols);
          buckets[col].push(it.str);
        }

        const nStr = normSpace(buckets.n.join(' '));
        const desStr = normSpace(buckets.des.join(' '));
        const qtyStr = normSpace(buckets.qty.join(' '));
        const unitStr = normSpace(buckets.unit.join(' '));
        const priceStr = normSpace(buckets.price.join(' '));
        const totalStr = normSpace(buckets.total.join(' '));

        const nParsed = /^\d{1,3}$/.test(nStr) ? Number(nStr) : NaN;
        const parsedQty = parseQuantityAndUnit(qtyStr);
        const unitPrice = priceStr ? parseLocalizedNumber(priceStr) : null;
        const totalVal = totalStr ? parseLocalizedNumber(totalStr) : null;

        const startsNew =
          (Number.isFinite(nParsed) && nParsed > 0) ||
          (tableCols.n === undefined && (unitPrice !== null || totalVal !== null)) ||
          lines.length === 0;

        if (startsNew && (desStr || parsedQty.qty !== null || unitPrice !== null)) {
          if (Number.isFinite(nParsed)) lastNum = nParsed;
          else lastNum += 1;

          lines.push({
            title: desStr || (nStr && !Number.isFinite(nParsed) ? nStr : ''),
            description: '',
            qty: parsedQty.qty,
            unit: unitStr || parsedQty.unit,
            unitPrice,
            total: totalVal,
          });
          lineConfidences.push(confAt(i));
        } else if (lines.length > 0 && desStr) {
          const prev = lines[lines.length - 1];
          prev.description = prev.description ? `${prev.description}\n${desStr}` : desStr;
        }
        continue;
      }

      // Mode texte / segments (ex: fixture ou OCR sans colonnes X alignées)
      // Cas 1 : La ligne commence par un numéro de ligne "1 Fouilles..." ou "1 | Fouilles..."
      const mNumRow = text.match(/^(\d{1,3})\s*(?:[.)\-|]|\s)\s*(.+)$/);
      let matchedNewLine = false;
      if (mNumRow) {
        const candidateNum = Number(mNumRow[1]);
        const rest = normSpace(mNumRow[2]);
        const expectedSequential =
          (lines.length === 0 && candidateNum === 1) ||
          (candidateNum > lastNum && candidateNum <= lastNum + 3);
        if (expectedSequential && rest && !isUnitContinuationToken(rest)) {
          matchedNewLine = true;
          lastNum = candidateNum;

          // Vérifier s'il y a des colonnes numériques en fin de ligne séparées par "|", "\t", ou >= 2 espaces
          let rawDes = rest;
          let qty: number | null = null;
          let unit = '';
          let unitPrice: number | null = null;
          let total: number | null = null;

          const multiCols = row.segments.length > 1
            ? row.segments.map((s) => s.text)
            : rest.split(/\s*\|\s*|\t|\s{2,}/).map(normSpace).filter(Boolean);

          if (multiCols.length >= 2) {
            // Si segments du row ont déjà été découpés, retirer le numéro du premier segment
            const firstSeg = normSpace(multiCols[0].replace(/^\d{1,3}\s*(?:[.)\-]|\s)\s*/, ''));
            const tailCols = multiCols.slice(1);
            // Extraire les valeurs numériques des colonnes de droite
            const rightValues = tailCols.map((c) => {
              const num = parseLocalizedNumber(c);
              if (num !== null) return { num, unit: '' };
              const qu = parseQuantityAndUnit(c);
              return qu.qty !== null ? { num: qu.qty, unit: qu.unit } : null;
            });

            if (rightValues.some((v) => v !== null)) {
              rawDes = firstSeg;
              const nums = rightValues.filter((v): v is { num: number; unit: string } => v !== null);
              if (nums.length >= 3) {
                qty = nums[0].num;
                unit = nums[0].unit;
                unitPrice = nums[1].num;
                total = nums[2].num;
              } else if (nums.length === 2) {
                qty = nums[0].num;
                unit = nums[0].unit;
                // Heuristique: si col 2 est très grande sans col 3, soit PU soit Total
                unitPrice = nums[1].num;
              } else if (nums.length === 1) {
                qty = nums[0].num;
                unit = nums[0].unit;
              }
            }
          }

          lines.push({
            title: rawDes,
            description: '',
            qty,
            unit,
            unitPrice,
            total,
          });
          lineConfidences.push(confAt(i));
        }
      }

      if (!matchedNewLine) {
        if (lines.length > 0) {
          const prev = lines[lines.length - 1];
          prev.description = prev.description ? `${prev.description}\n${text}` : text;
        } else {
          // Ligne sans numéro au tout début
          lines.push({
            title: text,
            description: '',
            qty: null,
            unit: '',
            unitPrice: null,
            total: null,
          });
          lineConfidences.push(confAt(i));
        }
      }
    }
  }

  // --------------------------------------------------------------------------
  // 5. EXTRAIRE LES TOTAUX (Total HT, TVA %, Total TTC) — null si tous vides !
  // --------------------------------------------------------------------------
  let ht: number | null = null;
  let vat: number | null = null;
  let ttc: number | null = null;
  let vatRate = 19;
  let totalsRow = -1;

  const extractRightNumberOnRowOrNext = (rowIndex: number, labelRegex: RegExp): number | null => {
    const r = rows[rowIndex];
    const segs = r.segments.length > 0 ? r.segments : [{ text: r.text, x: 0, width: 100 }];
    for (let sIdx = 0; sIdx < segs.length; sIdx += 1) {
      if (labelRegex.test(normCompare(segs[sIdx].text))) {
        const afterLabel = normSpace(segs[sIdx].text.replace(labelRegex, ''));
        const inlineNum = parseLocalizedNumber(afterLabel.replace(/^[:=\s]+/, ''));
        if (inlineNum !== null) return inlineNum;
        if (sIdx + 1 < segs.length) {
          const nextSegNum = parseLocalizedNumber(segs[sIdx + 1].text);
          if (nextSegNum !== null) return nextSegNum;
        }
      }
    }
    if (rowIndex + 1 < rows.length && !isAnyKnownLabel(rows[rowIndex + 1].text)) {
      return parseLocalizedNumber(rows[rowIndex + 1].text);
    }
    return null;
  };

  for (let i = Math.max(0, tableEndIdx); i < rows.length; i += 1) {
    const n = normCompare(rows[i].text);
    if (/\btotal\s*h\.?t\b|\bsous[\s-]*total\b|\bmontant\s*h\.?t\b/.test(n)) {
      totalsRow = totalsRow < 0 ? i : totalsRow;
      const v = extractRightNumberOnRowOrNext(i, /^.*?(?:total\s*h\.?t|sous[\s-]*total|montant\s*h\.?t)\s*[:.]?/i);
      if (v !== null) ht = v;
    } else if (/\btva\b/.test(n)) {
      totalsRow = totalsRow < 0 ? i : totalsRow;
      const mRate = n.match(/tva\s*(\d+(?:[.,]\d+)?)\s*%/i);
      if (mRate) {
        const parsedRate = Number(mRate[1].replace(',', '.'));
        if (Number.isFinite(parsedRate)) vatRate = parsedRate;
      }
      const v = extractRightNumberOnRowOrNext(i, /^.*?tva(?:\s*\d+(?:[.,]\d+)?\s*%)?\s*[:.]?/i);
      if (v !== null) vat = v;
    } else if (/\btotal\s*t\.?t\.?c\b|\bmontant\s*t\.?t\.?c\b|\bnet\s*a\s*payer\b/.test(n)) {
      totalsRow = totalsRow < 0 ? i : totalsRow;
      const v = extractRightNumberOnRowOrNext(i, /^.*?(?:total\s*t\.?t\.?c|montant\s*t\.?t\.?c|net\s*a\s*payer)\s*[:.]?/i);
      if (v !== null) ttc = v;
    }
  }

  // Ne jamais inventer de totaux si aucun prix / total n'existe sur le document
  const hasLineAmounts = lines.some((l) => l.total !== null || l.unitPrice !== null);
  let totals: ParsedBcTotals | null = null;

  if (ht !== null || vat !== null || ttc !== null || hasLineAmounts) {
    if (ht === null && hasLineAmounts) {
      const sumLines = lines.reduce((sum, l) => {
        if (l.total !== null) return sum + l.total;
        if (l.qty !== null && l.unitPrice !== null) return sum + l.qty * l.unitPrice;
        return sum;
      }, 0);
      ht = Math.round(sumLines * 100) / 100;
    }
    if (vat === null && ht !== null) {
      vat = Math.round(ht * vatRate) / 100;
    }
    if (ttc === null && ht !== null) {
      ttc = Math.round((ht + (vat || 0)) * 100) / 100;
    }
    totals = { ht, vatRate, vat, ttc };
  }

  // --------------------------------------------------------------------------
  // 6. SCORE DE CONFIANCE ET AVERTISSEMENTS
  // --------------------------------------------------------------------------
  confidence.number = bcNumber ? confAt(bcNumberRow) : 0;
  confidence.date = bcDate ? confAt(bcDateRow) : 0;
  confidence.city = city ? confAt(bcDateRow) : 0;
  confidence.direction = detected.matchedCompanyProfileId ? (isScannedOcr ? 0.85 : 0.98) : 0.7;
  confidence.issuerName = issuer.name ? confAt(0) : 0;
  confidence.issuerNif = issuer.nif ? confAt(issuerBandRow) : 0;
  confidence.issuerRc = issuer.rc ? confAt(issuerBandRow) : 0;
  confidence.partyName = party.name ? confAt(partyNameRow) : 0;
  confidence.partyAddress = party.address ? confAt(partyAddrRow) : 0;
  confidence.partyEmail = party.email ? confAt(partyEmailRow) : 0;
  confidence.partyPhone = party.phone ? confAt(partyPhoneRow) : 0;
  confidence.lines =
    lines.length > 0 && lineConfidences.length > 0
      ? Number((lineConfidences.reduce((a, b) => a + b, 0) / lineConfidences.length).toFixed(2))
      : 0;
  confidence.totals = totals ? confAt(totalsRow) : isScannedOcr ? 0.5 : 0.9;

  const keyScores = [confidence.number, confidence.date, confidence.partyName, confidence.lines];
  confidence.overall = Number(
    (keyScores.reduce((a, b) => a + b, 0) / keyScores.length).toFixed(2)
  );

  if (!bcNumber) warnings.push('Numéro du bon de commande introuvable');
  if (!bcDate) warnings.push('Date du bon de commande introuvable');
  if (!party.name && !issuer.name) warnings.push('Nom du client / fournisseur introuvable');
  if (lines.length === 0) warnings.push('Aucune ligne détectée dans le tableau');

  return {
    direction: detected.direction,
    matchedCompanyProfileId: detected.matchedCompanyProfileId,
    number: bcNumber,
    year: bcYear,
    date: bcDate,
    city,
    issuer,
    party,
    lines,
    totals,
    campaign,
    startDate,
    endDate,
    delivery,
    paymentTerms,
    amountInWords,
    warnings,
    confidence,
    isScannedOcr,
  };
}
