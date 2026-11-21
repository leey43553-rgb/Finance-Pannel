import * as XLSX from 'xlsx';

export interface ParsedInvoiceCompanyFiscal {
  rc: string;
  nif: string;
  ai: string;
  nis: string;
}

export interface ParsedInvoiceClientInfo {
  name: string;
  address: string;
  postalCode: string;
  city: string;
  phone: string;
  email: string;
  rc: string;
  ai: string;
  nif: string;
  nis: string;
}

export interface ParsedInvoiceLine {
  title: string;
  description: string;
  qty: number;
  unit: string;
  unitPrice: number;
  total: number;
}

export interface ParsedInvoiceTotals {
  ht: number;
  vatRate: number;
  vat: number;
  ttc: number;
}

export interface ParsedInvoiceSheet {
  sheet: string;
  kind: 'facture' | 'proforma';
  number: string;
  year: number | null;
  date: string | null;
  city: string;
  refBc: string;
  company: ParsedInvoiceCompanyFiscal;
  client: ParsedInvoiceClientInfo;
  lines: ParsedInvoiceLine[];
  totals: ParsedInvoiceTotals;
  issues: string[];
}

interface SheetCellEntry {
  r: number;
  c: number;
  v: string | number | boolean | Date;
  t: string;
  cell: XLSX.CellObject;
}

const norm = (s: unknown): string =>
  String(s ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();

const toNum = (v: unknown): number => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  const s = norm(v).replace(/\s/g, '').replace(',', '.');
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
};

function cells(ws: XLSX.WorkSheet): SheetCellEntry[] {
  const out: SheetCellEntry[] = [];
  for (const addr of Object.keys(ws)) {
    if (addr[0] === '!') continue;
    const { r, c } = XLSX.utils.decode_cell(addr);
    const cell = ws[addr] as XLSX.CellObject | undefined;
    if (!cell || cell.v === undefined || cell.v === null || norm(cell.v) === '') continue;
    out.push({ r, c, v: cell.v as string | number | boolean | Date, t: norm(cell.v), cell });
  }
  return out.sort((a, b) => a.r - b.r || a.c - b.c);
}

const isLabel = (t: string): boolean => /:\s*$/.test(t);

/** Valeur de la première cellule non vide à droite d'une étiquette, en s'arrêtant à l'étiquette suivante. */
function rightOf(all: SheetCellEntry[], label: SheetCellEntry): SheetCellEntry | null {
  const first = all.find((x) => x.r === label.r && x.c > label.c);
  if (!first || isLabel(first.t)) return null;
  return first;
}

/**
 * Analyseur pur pour les feuilles Excel au format « Modèle facture » (une facture par feuille).
 * Retourne null si la feuille ne contient pas d'en-tête « FACTURE N°... ».
 */
export function parseInvoiceSheet(
  ws: XLSX.WorkSheet | undefined,
  sheetName = ''
): ParsedInvoiceSheet | null {
  if (!ws) return null;
  const all = cells(ws);
  let titleCell = all.find((x) =>
    /^FACTURE\s*(PROFORMA\s*)?N\s*[°ºo.]?\s*:?\s*\S+/i.test(x.t)
  );
  let splitNumberFromRight = '';
  if (!titleCell) {
    const labelOnly = all.find((x) =>
      /^FACTURE\s*(PROFORMA\s*)?N\s*[°ºo.]?\s*:?$/i.test(x.t)
    );
    if (labelOnly) {
      const right = rightOf(all, labelOnly);
      if (right && /\S+/.test(right.t)) {
        titleCell = labelOnly;
        splitNumberFromRight = right.t;
      }
    }
  }
  if (!titleCell) return null;

  const issues: string[] = [];

  // ---- Numéro / Année / Type
  const m = titleCell.t.match(/^FACTURE\s*(PROFORMA)?\s*N\s*[°ºo.]?\s*:?\s*([\w./-]+)/i);
  const number = splitNumberFromRight
    ? norm(splitNumberFromRight)
    : m?.[2]
    ? norm(m[2])
    : '';
  const yy = number.match(/\/(\d{2,4})$/);
  const year = yy ? (yy[1].length === 2 ? 2000 + Number(yy[1]) : Number(yy[1])) : null;
  const kind: 'facture' | 'proforma' = m?.[1] || /PROFORMA/i.test(titleCell.t) ? 'proforma' : 'facture';

  // ---- Date (« Alger le 20/08/2026 » ou date Excel près du titre)
  let date: string | null = null;
  let city = '';
  for (const x of all) {
    const d = x.t.match(/^(.*?)\s*le\s*(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/i);
    if (d && x.r <= titleCell.r + 2) {
      city = norm(d[1]);
      const yr = d[4].length === 2 ? 2000 + Number(d[4]) : Number(d[4]);
      date = `${yr}-${String(d[3]).padStart(2, '0')}-${String(d[2]).padStart(2, '0')}`;
      break;
    }
    if (x.cell.t === 'n' && x.cell.w && x.r >= titleCell.r && x.r <= titleCell.r + 2 && x.c > titleCell.c) {
      const p = XLSX.SSF.parse_date_code(Number(x.v));
      if (p && p.y > 1990) {
        date = `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
        const leftCity = all.find((l) => l.r === x.r && l.c < x.c && /\ble\s*:?$/i.test(l.t));
        if (leftCity) {
          city = norm(leftCity.t.replace(/\ble\s*:?$/i, ''));
        }
        break;
      }
    }
  }
  if (!date) {
    issues.push('Date introuvable (cellule « Ville le JJ/MM/AAAA » attendue près du titre)');
  }

  // ---- Ref bc
  const refCell = all.find((x) => /^Ref\.?\s*bc\s*:?/i.test(x.t));
  const refBc = refCell ? norm(refCell.t.replace(/^Ref\.?\s*bc\s*:?/i, '')) : '';

  // ---- Bande fiscale société émettrice (au-dessus du titre)
  const band = all.find((x) => x.r < titleCell.r && /RC\s*:/i.test(x.t) && /NIF/i.test(x.t));
  const pick = (re: RegExp): string => {
    if (!band) return '';
    const match = band.t.match(re);
    return match?.[1] ? norm(match[1]) : '';
  };
  const company: ParsedInvoiceCompanyFiscal = {
    rc: pick(/RC\s*:\s*([^\s-][^\s]*)/i),
    nif: pick(/NIF\s*:\s*(\d+)/i),
    ai: pick(/AI\s*:\s*(\d+)/i),
    nis: pick(/NIS\s*:\s*(\d+)/i),
  };

  // ---- Bloc client (étiquettes + valeurs à droite)
  const label = (re: RegExp) =>
    all.find((x) => re.test(x.t) && x.r >= titleCell.r - 1 && x.r < titleCell.r + 9);
  const val = (re: RegExp): string => {
    const l = label(re);
    if (!l) return '';
    const v = rightOf(all, l);
    return v ? norm(v.t) : '';
  };

  const client: ParsedInvoiceClientInfo = {
    name: val(/^NOM\s*:?$/i),
    address: val(/^Adresse\s*:?$/i),
    postalCode: val(/^Code\s*postal\s*:?$/i),
    city: val(/^Ville\s*:?$/i),
    phone: val(/^Tel\b.*:?$/i),
    email: val(/^E-?mail\s*:?$/i),
    rc: '',
    ai: '',
    nif: '',
    nis: '',
  };

  for (const x of all) {
    if (x.r <= titleCell.r || x.r > titleCell.r + 9 || x === band) continue;
    const f = x.t.match(/^(RC|AI|NIF|NIS)\s*[:.]?\s*(.+)$/i);
    if (f && !/NIF.*AI|RC.*NIF/i.test(x.t)) {
      const fieldKey = f[1].toLowerCase() as 'rc' | 'ai' | 'nif' | 'nis';
      client[fieldKey] = norm(f[2]);
    }
  }
  if (!client.name) {
    issues.push('Nom du client introuvable (étiquette « NOM : » absente ou cellule à droite vide)');
  }

  // ---- Tableau des lignes
  const header = all.find((x) => /^D[ée]signation$/i.test(x.t));
  if (!header) {
    return {
      sheet: sheetName,
      kind,
      number,
      year,
      date,
      city,
      refBc,
      company,
      client,
      lines: [],
      totals: { ht: 0, vatRate: 19, vat: 0, ttc: 0 },
      issues: [...issues, 'Tableau des lignes introuvable (en-tête « Désignation » absent)'],
    };
  }

  const colOf = (re: RegExp): number | undefined =>
    all.find((x) => x.r === header.r && re.test(x.t))?.c;
  const cols = {
    n: colOf(/^N\s*[°o]?$/i),
    des: header.c,
    qty: colOf(/^Quantit/i),
    unit: colOf(/^Unit/i),
    price: colOf(/^Prix/i),
    total: colOf(/^Total/i),
  };

  // La cellule Désignation est souvent fusionnée et commence une colonne à gauche de son en-tête (C:E sous D)
  const desStart = cols.n !== undefined ? cols.n + 1 : header.c;
  const totalHtCell = all.find((x) => x.r > header.r && /^TOTAL\s*H\.?T/i.test(x.t));
  const endRow = totalHtCell ? totalHtCell.r : Infinity;
  const body = all.filter((x) => x.r > header.r && x.r < endRow);

  // Une nouvelle ligne commence sur une ligne qui possède un prix numérique
  const priceCells =
    cols.price !== undefined
      ? body.filter((x) => x.c === cols.price && !Number.isNaN(toNum(x.v)))
      : [];

  const lines: ParsedInvoiceLine[] = [];
  priceCells.forEach((pc, i) => {
    const r0 = pc.r;
    const r1 = i + 1 < priceCells.length ? priceCells[i + 1].r : endRow;
    const rStart = i === 0 ? header.r + 1 : r0;
    const inBlock = body.filter((x) => x.r >= rStart && x.r < r1);
    const desText = inBlock
      .filter((x) => x.c >= desStart && x.c < (cols.qty ?? 99))
      .map((x) => String(x.v).replace(/\u00a0/g, ' '))
      .join('\n');
    const parts = desText
      .split(/\n|\s{3,}/)
      .map(norm)
      .filter(Boolean);

    const qtyCell = cols.qty !== undefined ? inBlock.find((x) => x.c === cols.qty) : undefined;
    let qty = NaN;
    let unit = '';
    if (qtyCell) {
      const q = norm(qtyCell.v).match(/^([\d\s.,]+)\s*(.*)$/);
      if (q) {
        qty = toNum(q[1]);
        unit = q[2];
      }
    }
    const unitCell = cols.unit !== undefined ? inBlock.find((x) => x.c === cols.unit) : undefined;
    const facesOrUnit = unitCell ? norm(unitCell.v) : '';
    if (!unit && facesOrUnit && Number.isNaN(toNum(facesOrUnit))) {
      unit = facesOrUnit;
    }

    const price = toNum(pc.v);
    const totalCell =
      cols.total !== undefined
        ? inBlock.find((x) => x.c === cols.total && !Number.isNaN(toNum(x.v)))
        : undefined;
    let total = totalCell ? toNum(totalCell.v) : NaN;
    if (Number.isNaN(qty)) qty = 1;
    const computed = Math.round(qty * price * 100) / 100;
    if (Number.isNaN(total)) total = computed;
    if (Math.abs(total - computed) > 0.01) {
      issues.push(`Ligne ${i + 1} : total ${total} ≠ quantité × prix ${computed}`);
    }

    lines.push({
      title: parts[0] || '',
      description: parts.slice(1).join('\n'),
      qty,
      unit: unit || 'u',
      unitPrice: price,
      total,
    });
  });

  if (!lines.length) {
    issues.push('Aucune ligne de facture trouvée (aucun « Prix Ht » numérique détecté sous l’en-tête)');
  }

  // ---- Totaux
  const numRight = (re: RegExp): { l: SheetCellEntry | null; v: number } => {
    const l = all.find((x) => x.r >= endRow && re.test(x.t)) || null;
    if (!l) return { l: null, v: NaN };
    const v = all.find((x) => x.r === l.r && x.c > l.c && !Number.isNaN(toNum(x.v)));
    return { l, v: v ? toNum(v.v) : NaN };
  };

  const ht = numRight(/^TOTAL\s*H\.?T/i);
  const tva = numRight(/^TVA/i);
  const ttc = numRight(/^TOTAL\s*TTC/i);
  const vatRate = tva.l
    ? Number((tva.l.t.match(/(\d+(?:[.,]\d+)?)\s*%/) || [, '19'])[1].replace(',', '.'))
    : 19;
  const sumLines = Math.round(lines.reduce((s, l) => s + l.total, 0) * 100) / 100;

  const totals: ParsedInvoiceTotals = {
    ht: Number.isNaN(ht.v) ? sumLines : ht.v,
    vatRate: Number.isFinite(vatRate) ? vatRate : 19,
    vat: Number.isNaN(tva.v)
      ? Math.round(sumLines * (Number.isFinite(vatRate) ? vatRate : 19)) / 100
      : tva.v,
    ttc: ttc.v,
  };
  if (Number.isNaN(totals.ttc)) {
    totals.ttc = Math.round((totals.ht + totals.vat) * 100) / 100;
  }
  if (Math.abs(totals.ht - sumLines) > 0.01) {
    issues.push(`TOTAL HT ${totals.ht} ≠ somme des lignes ${sumLines}`);
  }

  return {
    sheet: sheetName,
    kind,
    number,
    year,
    date,
    city,
    refBc,
    company,
    client,
    lines,
    totals,
    issues,
  };
}

export function parseWorkbook(wb: XLSX.WorkBook): ParsedInvoiceSheet[] {
  return wb.SheetNames.map((n) => parseInvoiceSheet(wb.Sheets[n], n)).filter(
    (x): x is ParsedInvoiceSheet => x !== null
  );
}

export interface WorkbookInvoiceScanResult {
  mode: 'form' | 'table';
  sheetNames: string[];
  invoices: Array<ParsedInvoiceSheet & { fileName: string }>;
  ignoredSheets: Array<{ fileName: string; sheetName: string; reason: string }>;
}

/**
 * Lit un buffer Excel sans perdre les valeurs numériques/formules ni le texte formaté.
 */
export function readInvoiceExcelBuffer(buffer: ArrayBuffer): XLSX.WorkBook {
  return XLSX.read(buffer, { type: 'array', cellText: true, cellNF: true });
}

/**
 * Scanne toutes les feuilles d'un ou plusieurs classeurs pour détecter le Mode 1 (« Modèle facture »).
 * Si au moins une feuille correspond à une facture mise en page, retourne mode = 'form' et la liste
 * complète de toutes les feuilles factures (sans jamais retomber en mode tableau sur ces feuilles).
 */
export function scanWorkbooksForInvoiceForms(
  files: Array<{ fileName: string; buffer: ArrayBuffer }>
): WorkbookInvoiceScanResult {
  const invoices: Array<ParsedInvoiceSheet & { fileName: string }> = [];
  const ignoredSheets: Array<{ fileName: string; sheetName: string; reason: string }> = [];
  const sheetNames: string[] = [];

  for (const file of files) {
    const wb = readInvoiceExcelBuffer(file.buffer);
    for (const sheetName of wb.SheetNames) {
      sheetNames.push(sheetName);
      const parsed = parseInvoiceSheet(wb.Sheets[sheetName], sheetName);
      if (parsed) {
        invoices.push({ ...parsed, fileName: file.fileName });
      } else {
        ignoredSheets.push({
          fileName: file.fileName,
          sheetName,
          reason:
            'Aucune cellule commençant par « FACTURE N°... » trouvée — feuille non reconnue comme un modèle facture.',
        });
      }
    }
  }

  return {
    mode: invoices.length > 0 ? 'form' : 'table',
    sheetNames,
    invoices,
    ignoredSheets,
  };
}

export interface ExportInvoiceModelParams {
  kind?: 'facture' | 'proforma';
  number: string;
  issueDate: string;
  city?: string;
  refBc?: string;
  company: {
    name?: string;
    address?: string;
    phone?: string;
    email?: string;
    rc?: string;
    nif?: string;
    ai?: string;
    nis?: string;
    bankInfo?: string;
  };
  client: {
    name: string;
    address?: string;
    postalCode?: string;
    city?: string;
    phone?: string;
    email?: string;
    rc?: string;
    ai?: string;
    nif?: string;
    nis?: string;
  };
  lines: Array<{
    title: string;
    description?: string;
    qty: number;
    unit?: string;
    unitPrice: number;
    total: number;
  }>;
  totals: {
    ht: number;
    vatRate: number;
    vat: number;
    ttc: number;
  };
}

function isoToFrDate(iso: string): string {
  const parts = (iso || '').split('-');
  if (parts.length !== 3) return iso;
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

function sanitizeWorksheetName(raw: string): string {
  const cleaned = raw.replace(/[\\/?*:[\]]+/g, '-').trim() || 'Facture';
  return cleaned.slice(0, 31);
}

/**
 * Construit un classeur Excel au format exact « Modèle facture » afin que tout export Excel
 * d'une facture puisse être ré-importé fidèlement (aller-retour complet).
 */
export function buildInvoiceModelWorkbook(params: ExportInvoiceModelParams): XLSX.WorkBook {
  const ws: XLSX.WorkSheet = {};
  const setCell = (
    r: number,
    c: number,
    v: string | number,
    opts?: { forceText?: boolean; formula?: string }
  ) => {
    const addr = XLSX.utils.encode_cell({ r, c });
    if (opts?.forceText) {
      ws[addr] = { t: 's', v: String(v), z: '@' };
    } else if (typeof v === 'number' && Number.isFinite(v)) {
      const cell: XLSX.CellObject = { t: 'n', v };
      if (opts?.formula) cell.f = opts.formula;
      ws[addr] = cell;
    } else {
      ws[addr] = { t: 's', v: String(v) };
    }
  };

  // En-tête société (lignes 1-4)
  if (params.company.name) setCell(1, 1, params.company.name);
  if (params.company.address) setCell(2, 6, params.company.address);
  if (params.company.phone) setCell(3, 6, params.company.phone);
  if (params.company.email) setCell(4, 6, params.company.email);

  // Bande fiscale (B6 -> r=5, c=1)
  const fiscalParts = [
    params.company.rc ? `RC: ${params.company.rc}` : '',
    params.company.nif ? `NIF: ${params.company.nif}` : '',
    params.company.ai ? `AI: ${params.company.ai}` : '',
    params.company.nis ? `NIS: ${params.company.nis}` : '',
  ].filter(Boolean);
  if (fiscalParts.length > 0) {
    setCell(5, 1, fiscalParts.join(' - '));
  }

  // Titre & Date (C8 / G8 -> r=7)
  const prefix = params.kind === 'proforma' ? 'FACTURE PROFORMA N°' : 'FACTURE N°';
  setCell(7, 2, `${prefix}${params.number}`, { forceText: true });
  setCell(7, 6, `${params.city?.trim() || 'Alger'} le ${isoToFrDate(params.issueDate)}`);

  // Ref BC & Bloc Client (r=9..14)
  if (params.refBc?.trim()) {
    setCell(9, 2, `Ref bc : ${params.refBc.trim()}`);
  }
  setCell(9, 5, 'Client :');
  setCell(10, 5, 'NOM :');
  setCell(10, 6, params.client.name || '');

  if (params.client.rc) setCell(11, 2, `RC ${params.client.rc}`);
  setCell(11, 5, 'Adresse :');
  if (params.client.address) setCell(11, 6, params.client.address);

  if (params.client.ai) setCell(12, 2, `AI ${params.client.ai}`);
  setCell(12, 5, 'Code postal:');
  if (params.client.postalCode) {
    setCell(12, 6, params.client.postalCode, { forceText: true });
  }
  setCell(12, 7, 'Ville :');
  if (params.client.city) setCell(12, 8, params.client.city);

  if (params.client.nif) setCell(13, 2, `NIF ${params.client.nif}`);
  setCell(13, 5, 'Tel & Fax:');
  if (params.client.phone) setCell(13, 6, params.client.phone, { forceText: true });

  if (params.client.nis) setCell(14, 2, `NIS ${params.client.nis}`);
  setCell(14, 5, 'Email:');
  if (params.client.email) setCell(14, 6, params.client.email);

  // En-tête du tableau (ligne 17 -> r=16)
  const headerRow = 16;
  setCell(headerRow, 1, 'N');
  setCell(headerRow, 3, 'Désignation');
  setCell(headerRow, 5, 'Quantité ');
  setCell(headerRow, 6, 'Unité ');
  setCell(headerRow, 7, 'Prix Ht ');
  setCell(headerRow, 8, 'Total');

  // Lignes de prestations
  let currentRow = headerRow + 1;
  params.lines.forEach((line, idx) => {
    const fullDesc = line.description?.trim()
      ? `${line.title}\n${line.description.trim()}`
      : line.title;
    const unitText = (line.unit || 'u').trim();
    const qtyLabel = unitText && unitText !== 'u' ? `${line.qty} ${unitText}` : line.qty;

    setCell(currentRow, 1, idx + 1);
    setCell(currentRow, 2, fullDesc);
    setCell(currentRow, 5, qtyLabel);
    if (unitText === 'u' || !unitText) {
      setCell(currentRow, 6, 'u');
    } else {
      setCell(currentRow, 6, 1);
    }
    setCell(currentRow, 7, line.unitPrice);
    setCell(currentRow, 8, line.total);
    currentRow += 1;
  });

  // Totaux
  const totalsRow = Math.max(currentRow + 2, 24);
  setCell(totalsRow, 7, 'TOTAL  HT ');
  setCell(totalsRow, 8, params.totals.ht);

  setCell(totalsRow + 1, 7, `TVA${params.totals.vatRate}%`);
  setCell(totalsRow + 1, 8, params.totals.vat);

  setCell(totalsRow + 2, 7, 'TOTAL TTC');
  setCell(totalsRow + 2, 8, params.totals.ttc);

  // Pied bancaire
  if (params.company.bankInfo) {
    setCell(totalsRow + 5, 1, params.company.bankInfo);
  }

  ws['!ref'] = XLSX.utils.encode_range({
    s: { r: 0, c: 0 },
    e: { r: totalsRow + 6, c: 8 },
  });
  ws['!cols'] = [
    { wch: 3 },
    { wch: 6 },
    { wch: 36 },
    { wch: 24 },
    { wch: 10 },
    { wch: 14 },
    { wch: 14 },
    { wch: 16 },
    { wch: 18 },
  ];

  const wb = XLSX.utils.book_new();
  const prefixName = params.kind === 'proforma' ? 'Proforma' : 'Facture';
  XLSX.utils.book_append_sheet(wb, ws, sanitizeWorksheetName(`${prefixName} ${params.number}`));
  return wb;
}

export function downloadInvoiceModelExcel(
  params: ExportInvoiceModelParams,
  fileName?: string
): void {
  const wb = buildInvoiceModelWorkbook(params);
  const cleanNum = params.number.replace(/[/\\:*?"<>|]+/g, '-');
  const cleanClient = (params.client.name || 'Client').replace(/[/\\:*?"<>|]+/g, '-').trim();
  const outName = fileName || `Facture_${cleanNum}_${cleanClient}.xlsx`;
  XLSX.writeFile(wb, outName.endsWith('.xlsx') ? outName : `${outName}.xlsx`);
}
