import * as XLSX from 'xlsx';
import type { CompanyProfile } from '../../db/types';
import {
  detectBcDirectionAndProfile,
  normCompare,
  normSpace,
  parseFrenchOrIsoDate,
  parseLocalizedNumber,
  parseQuantityAndUnit,
  type ParsedBcIssuer,
  type ParsedBcLine,
  type ParsedBcParty,
  type ParsedBcTotals,
  type ParsedPurchaseOrder,
} from './parsePurchaseOrder';

interface SheetCellEntry {
  r: number;
  c: number;
  v: string | number | boolean | Date;
  t: string;
  cell: XLSX.CellObject;
}

function readWorksheetCells(ws: XLSX.WorkSheet): SheetCellEntry[] {
  const out: SheetCellEntry[] = [];
  for (const addr of Object.keys(ws)) {
    if (addr[0] === '!') continue;
    const { r, c } = XLSX.utils.decode_cell(addr);
    const cell = ws[addr] as XLSX.CellObject | undefined;
    if (!cell || cell.v === undefined || cell.v === null || normSpace(cell.v) === '') continue;
    out.push({ r, c, v: cell.v as string | number | boolean | Date, t: normSpace(cell.v), cell });
  }
  return out.sort((a, b) => a.r - b.r || a.c - b.c);
}

const isCellLabel = (t: string): boolean => /:\s*$/.test(t);

function rightOf(all: SheetCellEntry[], label: SheetCellEntry): SheetCellEntry | null {
  const first = all.find((x) => x.r === label.r && x.c > label.c);
  if (!first || isCellLabel(first.t)) return null;
  return first;
}

function belowOf(all: SheetCellEntry[], label: SheetCellEntry): SheetCellEntry | null {
  const first = all.find((x) => x.r === label.r + 1 && Math.abs(x.c - label.c) <= 1);
  if (!first || isCellLabel(first.t)) return null;
  return first;
}

/**
 * Analyseur de feuille Excel au format « Modèle Bon de Commande » (un BC par feuille).
 * Retourne null si la feuille ne ressemble pas à un modèle BC.
 */
export function parseBcExcelSheet(
  ws: XLSX.WorkSheet | undefined,
  sheetName = '',
  companyProfiles: CompanyProfile[] = []
): ParsedPurchaseOrder | null {
  if (!ws) return null;
  const all = readWorksheetCells(ws);
  if (all.length === 0) return null;

  // Chercher la cellule titre "BON DE COMMANDE N°...", "BC N°...", "Commande N°..."
  let titleCell = all.find((x) =>
    /^(?:BON\s*DE\s*COMMANDE|COMMANDE|B\.?\s*C\.?)\s*(?:N\s*[°ºo.]?|No)?\s*:?\s*\S+/i.test(x.t) ||
    /^N\s*[°ºo.]?\s*(?:de\s*)?commande\s*:?\s*\S+/i.test(x.t)
  );
  let splitNumFromRight = '';
  if (!titleCell) {
    const labelOnly = all.find((x) =>
      /^(?:BON\s*DE\s*COMMANDE|COMMANDE|B\.?\s*C\.?)\s*(?:N\s*[°ºo.]?|No)?\s*:?$/i.test(x.t) ||
      /^N\s*[°ºo.]?\s*(?:de\s*)?commande\s*:?$/i.test(x.t)
    );
    if (labelOnly) {
      const right = rightOf(all, labelOnly);
      if (right && /\d/.test(right.t)) {
        titleCell = labelOnly;
        splitNumFromRight = right.t;
      }
    }
  }
  if (!titleCell) return null;

  const warnings: string[] = [];

  // 1. Numéro & année
  let number = splitNumFromRight;
  if (!number) {
    const m = titleCell.t.match(
      /(?:BON\s*DE\s*COMMANDE|COMMANDE|B\.?\s*C\.?|N\s*[°ºo.]?\s*(?:de\s*)?commande)\s*(?:N\s*[°ºo.]?|No)?\s*[:.]?\s*([A-Z0-9][A-Z0-9./\-]*)/i
    );
    number = m?.[1] ? normSpace(m[1]) : '';
  }
  const mYr = number.match(/\/(\d{2,4})(?:\/|$|-)/) || number.match(/(?:^|-)((?:19|20)\d{2})(?:-|$)/);
  let year: number | null = mYr
    ? mYr[1].length === 2
      ? 2000 + Number(mYr[1])
      : Number(mYr[1])
    : null;

  // 2. Date & Ville
  let date: string | null = null;
  let city = '';
  for (const x of all) {
    if (x.r > titleCell.r + 3) continue;
    const cityDateMatch = x.t.match(/^(.*?)[,\s]+\ble\s*[:.]?\s*(.+)$/i);
    if (cityDateMatch) {
      const parsed = parseFrenchOrIsoDate(cityDateMatch[2]);
      if (parsed) {
        date = parsed;
        const cCand = normSpace(cityDateMatch[1]);
        if (cCand && cCand.length <= 32 && !/\d/.test(cCand)) city = cCand;
        break;
      }
    }
    if (x.cell.t === 'n' && x.cell.w && x.r >= titleCell.r - 1 && x.r <= titleCell.r + 3 && x.c >= titleCell.c) {
      const p = XLSX.SSF.parse_date_code(Number(x.v));
      if (p && p.y > 1990) {
        date = `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
        const leftCity = all.find((l) => l.r === x.r && l.c < x.c && /\ble\s*:?$/i.test(l.t));
        if (leftCity) {
          city = normSpace(leftCity.t.replace(/\ble\s*:?$/i, ''));
        }
        break;
      }
    }
    if (!date) {
      const directDate = parseFrenchOrIsoDate(x.t);
      if (directDate && x.r >= titleCell.r - 2 && x.r <= titleCell.r + 2) {
        date = directDate;
        break;
      }
    }
  }
  if (!year && date) year = Number(date.slice(0, 4));
  if (!date) warnings.push('Date du bon de commande introuvable');
  if (!number) warnings.push('Numéro du bon de commande introuvable');

  // 3. Émetteur (en-tête + bande fiscale au-dessus du titre)
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

  const band = all.find((x) => x.r < titleCell.r && /RC\s*:/i.test(x.t) && /NIF/i.test(x.t));
  if (band) {
    const pick = (re: RegExp): string => {
      const m = band.t.match(re);
      return m?.[1] ? normSpace(m[1]) : '';
    };
    issuer.rc = pick(/RC\s*(?:N\s*[°ºo.]?)?\s*[:.]?\s*([^\s-][^\s]*)/i);
    issuer.nif = pick(/NIF\s*(?:N\s*[°ºo.]?)?\s*[:.]?\s*(\d+)/i);
    issuer.ai = pick(/AI\s*(?:N\s*[°ºo.]?)?\s*[:.]?\s*(\d+)/i);
    issuer.nis = pick(/NIS\s*(?:N\s*[°ºo.]?)?\s*[:.]?\s*(\d+)/i);
  }

  for (const x of all) {
    if (x.r >= titleCell.r || x === band) continue;
    const mEmail = x.t.match(/^(?:E-?mail|Courriel)\s*[:.]\s*(.+)$/i);
    if (mEmail && !issuer.email) {
      issuer.email = normSpace(mEmail[1]);
      continue;
    }
    const mTel = x.t.match(/^(?:T[ée]l(?:[ée]phone)?)\s*[:.]\s*(.+)$/i);
    if (mTel && !issuer.phone) {
      issuer.phone = normSpace(mTel[1]);
      continue;
    }
    const mRc = x.t.match(/^R\.?C\.?\s*[:.]\s*(.+)$/i);
    if (mRc && !issuer.rc) {
      issuer.rc = normSpace(mRc[1]);
      continue;
    }
    const mNif = x.t.match(/^N\.?I\.?F\.?\s*[:.]\s*(\d+)/i);
    if (mNif && !issuer.nif) {
      issuer.nif = normSpace(mNif[1]);
      continue;
    }
    const mAi = x.t.match(/^A\.?I\.?\s*[:.]\s*(\d+)/i);
    if (mAi && !issuer.ai) {
      issuer.ai = normSpace(mAi[1]);
      continue;
    }
    const mNis = x.t.match(/^N\.?I\.?S\.?\s*[:.]\s*(\d+)/i);
    if (mNis && !issuer.nis) {
      issuer.nis = normSpace(mNis[1]);
      continue;
    }
    if (/^(?:SARL|EURL|SPA|EPE|SAS|SNC|ETS)\b/i.test(x.t) && !issuer.name) {
      issuer.name = x.t;
    } else if (/\b(?:rue|route|safex|alger|oran|mohammadia|lot|cite|zone)\b/i.test(x.t) && !issuer.address) {
      issuer.address = x.t;
    } else if (!issuer.name && x.r <= 2 && !/@/.test(x.t)) {
      issuer.name = x.t;
    }
  }

  // 4. Bloc autre partie ("Client :", "Fournisseur :", "NOM :", etc.)
  const headerRowCell = all.find((x) => /^(?:D[ée]signation|Description|Libell[ée])$/i.test(x.t));
  const partySearchMaxRow = headerRowCell ? headerRowCell.r : titleCell.r + 12;

  const findPartyVal = (re: RegExp): string => {
    const lbl = all.find((x) => x.r >= titleCell.r - 2 && x.r < partySearchMaxRow && re.test(x.t));
    if (!lbl) return '';
    // D'abord valeur sur la même cellule après ":"
    const sameCellVal = lbl.t.replace(re, '').trim();
    if (sameCellVal) return normSpace(sameCellVal);
    const rCell = rightOf(all, lbl);
    if (rCell) return normSpace(rCell.t);
    const bCell = belowOf(all, lbl);
    return bCell ? normSpace(bCell.t) : '';
  };

  const party: ParsedBcParty = {
    name: findPartyVal(/^(?:Client|Fournisseur|Destinataire)\s*:\s*/i) || findPartyVal(/^(?:NOM|Raison\s*sociale)\s*:\s*/i),
    address: findPartyVal(/^(?:Adresse|Adr\.?)\s*:\s*/i),
    email: findPartyVal(/^(?:E-?mail|Courriel)\s*:\s*/i),
    phone: findPartyVal(/^(?:T[ée]l(?:[ée]phone)?(?:\s*&\s*Fax)?|Mobile)\s*:\s*/i),
    fax: findPartyVal(/^Fax\s*:\s*/i),
    rc: '',
    nif: '',
    ai: '',
    nis: '',
  };

  // Code postal + ville éventuels sur la feuille client
  const cpVal = findPartyVal(/^Code\s*postal\s*:\s*/i);
  const cityVal = findPartyVal(/^Ville\s*:\s*/i);
  if (cpVal || cityVal) {
    const extra = [cpVal, cityVal].filter(Boolean).join(' ');
    if (extra && party.address && !party.address.toLowerCase().includes(extra.toLowerCase())) {
      party.address = `${party.address}, ${extra}`;
    }
  }

  for (const x of all) {
    if (x.r < titleCell.r || x.r >= partySearchMaxRow || x === band) continue;
    const f = x.t.match(/^(RC|AI|NIF|NIS)\s*(?:N\s*[°ºo.]?)?\s*[:.]?\s*(.+)$/i);
    if (f && !/NIF.*AI|RC.*NIF/i.test(x.t)) {
      const key = f[1].toLowerCase() as 'rc' | 'ai' | 'nif' | 'nis';
      if (!party[key]) party[key] = normSpace(f[2]);
    }
  }

  // Détection direction + société
  const allText = all.map((c) => c.t).join('\n');
  const detected = detectBcDirectionAndProfile({
    issuer,
    party,
    rawText: allText,
    companyProfiles,
  });
  if (detected.direction === 'emis' && detected.matchedCompanyProfileId && !issuer.name) {
    const prof = companyProfiles.find((p) => p.id === detected.matchedCompanyProfileId);
    if (prof) issuer.name = prof.name;
  }

  // 5. Tableau des lignes
  const lines: ParsedBcLine[] = [];
  let endRow = Infinity;
  let totals: ParsedBcTotals | null = null;
  let campaign = '';
  let startDate: string | null = null;
  let endDate: string | null = null;
  let delivery = '';
  let paymentTerms = '';
  let amountInWords = '';

  // Extraire champs optionnels (campagne, livraison, paiement, arrêté)
  for (const x of all) {
    const campM = x.t.match(/^(?:Campagne|Objet|Projet)\s*:\s*(.*)$/i);
    if (campM && !campaign) {
      campaign = normSpace(campM[1]) || rightOf(all, x)?.t || '';
    }
    const delM = x.t.match(/^(?:Lieu\s*de\s*livraison|Livraison|D[ée]lai(?:\s*de\s*(?:livraison|r[ée]alisation))?)\s*:\s*(.*)$/i);
    if (delM && !delivery) {
      delivery = normSpace(delM[1]) || rightOf(all, x)?.t || '';
    }
    const payM = x.t.match(/^(?:Conditions?\s*de\s*paiement|Paiement|Mode\s*de\s*paiement)\s*:\s*(.*)$/i);
    if (payM && !paymentTerms) {
      paymentTerms = normSpace(payM[1]) || rightOf(all, x)?.t || '';
    }
    const pM = normCompare(x.t).match(/\bdu\s+(.+?)\s+au\s+(.+)$/);
    if (pM && !startDate && !endDate) {
      startDate = parseFrenchOrIsoDate(pM[1]);
      endDate = parseFrenchOrIsoDate(pM[2]);
    }
    const arrM = x.t.match(/Arr[êe]t[ée]\s+le\s+pr[ée]sent\s+bon\s+de\s+commande\s+[àa]\s+la\s+somme\s+de\s*:?\s*(.*)$/i);
    if (arrM) {
      amountInWords = normSpace(arrM[1]) || rightOf(all, x)?.t || belowOf(all, x)?.t || '';
    }
  }

  if (headerRowCell) {
    const colOf = (re: RegExp): number | undefined =>
      all.find((x) => x.r === headerRowCell.r && re.test(x.t))?.c;
    const cols = {
      n: colOf(/^N\s*[°ºo]?$/i),
      des: headerRowCell.c,
      qty: colOf(/^(?:Quantit|Qt[ée]|Qty)/i),
      unit: colOf(/^Unit/i),
      price: colOf(/^(?:Prix|P\.?U)/i),
      total: colOf(/^(?:Total|Montant)/i),
    };

    const desStart = cols.n !== undefined ? cols.n + 1 : headerRowCell.c;
    const totalHtCell = all.find((x) => x.r > headerRowCell.r && /^TOTAL\s*H\.?T/i.test(x.t));
    endRow = totalHtCell ? totalHtCell.r : Infinity;
    const body = all.filter((x) => x.r > headerRowCell.r && x.r < endRow);

    // Regrouper par ligne Excel r
    const rowIndices = Array.from(new Set(body.map((b) => b.r))).sort((a, b) => a - b);

    for (const r of rowIndices) {
      const rowCells = body.filter((x) => x.r === r);
      const nCell = cols.n !== undefined ? rowCells.find((x) => x.c === cols.n) : undefined;
      const nVal = nCell ? parseLocalizedNumber(nCell.v) : null;
      const desEndCol = cols.qty ?? cols.price ?? cols.total ?? 99;
      const desText = rowCells
        .filter((x) => x.c >= desStart && x.c < desEndCol)
        .map((x) => String(x.v).replace(/\u00a0/g, ' '))
        .join(' ')
        .trim();

      const qtyCell = cols.qty !== undefined ? rowCells.find((x) => x.c === cols.qty) : undefined;
      const unitCell = cols.unit !== undefined ? rowCells.find((x) => x.c === cols.unit) : undefined;
      const priceCell = cols.price !== undefined ? rowCells.find((x) => x.c === cols.price) : undefined;
      const totalCell = cols.total !== undefined ? rowCells.find((x) => x.c === cols.total) : undefined;

      const parsedQty = qtyCell ? parseQuantityAndUnit(String(qtyCell.v)) : { qty: null, unit: '' };
      const unitVal = unitCell ? normSpace(unitCell.v) : parsedQty.unit;
      const unitPrice = priceCell ? parseLocalizedNumber(priceCell.v) : null;
      const totalVal = totalCell ? parseLocalizedNumber(totalCell.v) : null;

      const isNewLine =
        (nVal !== null && nVal > 0 && Number.isInteger(nVal)) ||
        (cols.n === undefined && (unitPrice !== null || totalVal !== null || lines.length === 0));

      if (isNewLine && (desText || parsedQty.qty !== null || unitPrice !== null)) {
        const parts = desText.split(/\n|\s{3,}/).map(normSpace).filter(Boolean);
        lines.push({
          title: parts[0] || '',
          description: parts.slice(1).join('\n'),
          qty: parsedQty.qty,
          unit: unitVal,
          unitPrice,
          total: totalVal,
        });
      } else if (lines.length > 0 && desText) {
        const prev = lines[lines.length - 1];
        prev.description = prev.description ? `${prev.description}\n${desText}` : desText;
      }
    }

    // Totaux (null si aucun montant)
    const numRight = (re: RegExp): { l: SheetCellEntry | null; v: number | null } => {
      const l = all.find((x) => x.r >= endRow && re.test(x.t)) || null;
      if (!l) return { l: null, v: null };
      const vCell = all.find((x) => x.r === l.r && x.c > l.c && parseLocalizedNumber(x.v) !== null);
      return { l, v: vCell ? parseLocalizedNumber(vCell.v) : null };
    };

    const htRes = numRight(/^TOTAL\s*H\.?T/i);
    const tvaRes = numRight(/^TVA/i);
    const ttcRes = numRight(/^TOTAL\s*TTC/i);
    const vatRate = tvaRes.l
      ? Number((tvaRes.l.t.match(/(\d+(?:[.,]\d+)?)\s*%/) || [, '19'])[1].replace(',', '.'))
      : 19;

    const hasLinePrices = lines.some((l) => l.unitPrice !== null || l.total !== null);
    if (htRes.v !== null || tvaRes.v !== null || ttcRes.v !== null || hasLinePrices) {
      let ht = htRes.v;
      if (ht === null && hasLinePrices) {
        ht = Math.round(
          lines.reduce((s, l) => s + (l.total ?? (l.qty ?? 1) * (l.unitPrice ?? 0)), 0) * 100
        ) / 100;
      }
      const vat = tvaRes.v !== null ? tvaRes.v : ht !== null ? Math.round(ht * vatRate) / 100 : null;
      const ttc = ttcRes.v !== null ? ttcRes.v : ht !== null ? Math.round((ht + (vat || 0)) * 100) / 100 : null;
      totals = {
        ht,
        vatRate: Number.isFinite(vatRate) ? vatRate : 19,
        vat,
        ttc,
      };
    }
  } else {
    warnings.push('Tableau des lignes introuvable (en-tête « Désignation » absent)');
  }

  if (lines.length === 0) warnings.push('Aucune ligne détectée dans le tableau');

  const confidence: Record<string, number> = {
    number: number ? 0.98 : 0,
    date: date ? 0.98 : 0,
    city: city ? 0.95 : 0,
    direction: detected.matchedCompanyProfileId ? 0.98 : 0.75,
    issuerName: issuer.name ? 0.95 : 0,
    issuerNif: issuer.nif ? 0.98 : 0,
    issuerRc: issuer.rc ? 0.98 : 0,
    partyName: party.name ? 0.98 : 0,
    partyAddress: party.address ? 0.95 : 0,
    partyEmail: party.email ? 0.95 : 0,
    partyPhone: party.phone ? 0.95 : 0,
    lines: lines.length > 0 ? 0.98 : 0,
    totals: 0.95,
    overall: number && date && lines.length > 0 ? 0.96 : 0.65,
  };

  return {
    direction: detected.direction,
    matchedCompanyProfileId: detected.matchedCompanyProfileId,
    number,
    year,
    date,
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
    isScannedOcr: false,
  };
}

export function parseBcExcelWorkbook(
  buffer: ArrayBuffer,
  companyProfiles: CompanyProfile[] = []
): Array<{ sheetName: string; parsed: ParsedPurchaseOrder }> {
  const wb = XLSX.read(buffer, { type: 'array', cellText: true, cellNF: true });
  const results: Array<{ sheetName: string; parsed: ParsedPurchaseOrder }> = [];
  for (const sheetName of wb.SheetNames) {
    const parsed = parseBcExcelSheet(wb.Sheets[sheetName], sheetName, companyProfiles);
    if (parsed) {
      results.push({ sheetName, parsed });
    }
  }
  return results;
}
