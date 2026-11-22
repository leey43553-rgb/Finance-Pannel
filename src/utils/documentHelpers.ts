import type {
  BcRecuStatus,
  Campaign,
  CampaignStatus,
  CompanyProfile,
  CustomerInvoice,
  InvoiceLine,
  Proforma,
  ProformaStatus,
  PurchaseOrder,
} from '../db/types';
import { addMoney } from './money';

export function resolveEffectiveCompanyProfile(params: {
  companyProfileId?: string;
  issuerSnapshot?: Partial<CompanyProfile>;
  profileMap: Map<string, CompanyProfile>;
  fallbackProfile?: CompanyProfile;
}): CompanyProfile | undefined {
  const live = params.companyProfileId
    ? params.profileMap.get(params.companyProfileId)
    : undefined;
  const snap = params.issuerSnapshot;

  if (live && snap) {
    // Si la société existe toujours sous la même entité, refléter en direct logo/couleurs/cachet tout en gardant les champs snapshot
    return {
      ...snap,
      ...live,
      logoDataUrl: live.logoDataUrl || snap.logoDataUrl || '',
      signatureDataUrl: live.signatureDataUrl || snap.signatureDataUrl || '',
      primaryColor: live.primaryColor || snap.primaryColor || '#FF33CC',
      accentColor: live.accentColor || snap.accentColor || '#6B2FA0',
    } as CompanyProfile;
  }
  if (live) return live;
  if (snap) {
    return {
      id: snap.id || params.companyProfileId || 'snapshot',
      name: snap.name || params.fallbackProfile?.name || 'Entreprise',
      logoDataUrl: snap.logoDataUrl || '',
      address: snap.address || '',
      postalCode: snap.postalCode || '',
      city: snap.city || '',
      phone: snap.phone || '',
      fax: snap.fax || '',
      email: snap.email || '',
      nif: snap.nif || '',
      nis: snap.nis || '',
      rc: snap.rc || '',
      ai: snap.ai || '',
      rib: snap.rib || '',
      bankInfo: snap.bankInfo || '',
      primaryColor: snap.primaryColor || '#FF33CC',
      accentColor: snap.accentColor || '#6B2FA0',
      footerNote: snap.footerNote || '',
      signatureDataUrl: snap.signatureDataUrl || '',
      signatureLabel: snap.signatureLabel || 'SERVICE COMMERCIAL',
      applyThemeToApp: snap.applyThemeToApp ?? true,
      isDefault: false,
      createdAt: '',
      updatedAt: '',
    };
  }
  return params.fallbackProfile;
}

/**
 * Extrait la partie séquence et année sur un numéro de document de type :
 * "078/26", "PF N°012/26", "BC N°004/26", "FAC-2026-0001".
 */
export function parseDocumentNumberParts(docNumber: string): {
  yearTwoDigits: number;
  seq: number;
} | null {
  const clean = docNumber.trim();
  // Format "078/26" ou "PF N°012/26" ou "BC N°004/26"
  const matchSlash = clean.match(/(\d+)\s*\/\s*(\d{2,4})$/);
  if (matchSlash) {
    const seq = parseInt(matchSlash[1], 10);
    const yrRaw = parseInt(matchSlash[2], 10);
    const yearTwoDigits = yrRaw >= 100 ? yrRaw % 100 : yrRaw;
    if (Number.isFinite(seq) && Number.isFinite(yearTwoDigits)) {
      return { yearTwoDigits, seq };
    }
  }
  // Format legacy "FAC-2026-0001"
  const matchDash = clean.match(/(\d{4})-(\d+)$/);
  if (matchDash) {
    const yr = parseInt(matchDash[1], 10) % 100;
    const seq = parseInt(matchDash[2], 10);
    if (Number.isFinite(seq) && Number.isFinite(yr)) {
      return { yearTwoDigits: yr, seq };
    }
  }
  return null;
}

/**
 * Formate un numéro séquentiel intelligent :
 * - Facture client : "001/26"
 * - Proforma : "PF N°001/26"
 * - BC émis : "BC N°001/26"
 */
export function formatSmartDocNumber(
  kind: 'facture_client' | 'proforma' | 'bc_emis',
  seq: number,
  yearFull: number
): string {
  const yy = String(yearFull % 100).padStart(2, '0');
  const padded = String(Math.max(1, seq)).padStart(3, '0');
  if (kind === 'proforma') return `PF N°${padded}/${yy}`;
  if (kind === 'bc_emis') return `BC N°${padded}/${yy}`;
  return `${padded}/${yy}`;
}

/**
 * Calcule le prochain numéro disponible pour une année (et un profil société optionnel),
 * sans jamais réutiliser un numéro existant (même annulé ou en corbeille),
 * et repart automatiquement à 001 au changement d'année.
 */
export function computeNextSequenceNumber(params: {
  kind: 'facture_client' | 'proforma' | 'bc_emis';
  existingNumbers: Array<{
    number: string;
    date: string;
    companyProfileId?: string;
  }>;
  yearFull: number;
  companyProfileId?: string;
}): string {
  const targetYY = params.yearFull % 100;
  let maxSeq = 0;

  for (const item of params.existingNumbers) {
    if (
      params.companyProfileId &&
      item.companyProfileId &&
      item.companyProfileId !== params.companyProfileId
    ) {
      continue;
    }
    const parsed = parseDocumentNumberParts(item.number);
    if (parsed && parsed.yearTwoDigits === targetYY) {
      if (parsed.seq > maxSeq) maxSeq = parsed.seq;
      continue;
    }
    const docYear = parseInt((item.date || '').slice(0, 4), 10);
    if (docYear === params.yearFull && parsed && parsed.seq > maxSeq) {
      maxSeq = parsed.seq;
    }
  }

  return formatSmartDocNumber(params.kind, maxSeq + 1, params.yearFull);
}

/**
 * Compare deux numéros de facture/proforma numériquement par année puis par séquence.
 * Ex: "078/26" avant "079/26", et "001/27" après "150/26".
 */
export function compareDocumentNumbers(a: string, b: string): number {
  const pa = parseDocumentNumberParts(a);
  const pb = parseDocumentNumberParts(b);
  if (pa && pb) {
    if (pa.yearTwoDigits !== pb.yearTwoDigits) {
      return pa.yearTwoDigits - pb.yearTwoDigits;
    }
    return pa.seq - pb.seq;
  }
  return a.localeCompare(b, 'fr');
}

/**
 * Calcule la durée d'une campagne entre date de début et date de fin.
 */
export function computeCampaignDuration(
  startDate?: string,
  endDate?: string
): {
  valid: boolean;
  days: number;
  monthsFloat: number;
  label: string;
} {
  if (!startDate || !endDate) {
    return { valid: true, days: 0, monthsFloat: 0, label: '—' };
  }
  const d1 = new Date(`${startDate}T00:00:00Z`);
  const d2 = new Date(`${endDate}T00:00:00Z`);
  if (Number.isNaN(d1.getTime()) || Number.isNaN(d2.getTime())) {
    return { valid: false, days: 0, monthsFloat: 0, label: 'Dates invalides' };
  }
  if (d2.getTime() < d1.getTime()) {
    return {
      valid: false,
      days: 0,
      monthsFloat: 0,
      label: 'La date de fin doit être postérieure ou égale à la date de début',
    };
  }

  const diffDays = Math.round((d2.getTime() - d1.getTime()) / 86400000) + 1;

  // Calcul exact des mois calendaires (ex: 05/07 -> 05/09 = 2 mois)
  const startY = d1.getUTCFullYear();
  const startM = d1.getUTCMonth();
  const startD = d1.getUTCDate();
  const endY = d2.getUTCFullYear();
  const endM = d2.getUTCMonth();
  const endD = d2.getUTCDate();

  let wholeMonths = (endY - startY) * 12 + (endM - startM);
  let remainingDays = endD - startD;
  if (remainingDays < 0) {
    wholeMonths -= 1;
    const prevMonthLastDay = new Date(Date.UTC(endY, endM, 0)).getUTCDate();
    remainingDays = prevMonthLastDay - startD + endD;
  }

  // Tolérance d'un jour (ex: 01/07 au 31/07 = 1 mois)
  const monthDaysCount = new Date(Date.UTC(endY, endM + 1, 0)).getUTCDate();
  if (startD === 1 && endD === monthDaysCount) {
    wholeMonths += 1;
    remainingDays = 0;
  }

  let label = `${diffDays} jour${diffDays > 1 ? 's' : ''}`;
  if (wholeMonths >= 1 && remainingDays === 0) {
    label = `${wholeMonths} mois`;
  } else if (wholeMonths >= 1 && remainingDays > 0 && remainingDays <= 31) {
    label = `${wholeMonths} mois et ${remainingDays} jour${remainingDays > 1 ? 's' : ''}`;
  }

  const monthsFloat = wholeMonths >= 1 && remainingDays === 0
    ? wholeMonths
    : Number((diffDays / 30).toFixed(2));

  return { valid: true, days: diffDays, monthsFloat, label };
}

/**
 * Suggère automatiquement le statut d'une campagne d'après ses dates.
 */
export function suggestCampaignStatus(
  startDate: string,
  endDate: string,
  referenceDate = new Date().toISOString().slice(0, 10)
): CampaignStatus {
  if (!startDate || !endDate) return 'prevue';
  if (referenceDate < startDate) return 'prevue';
  if (referenceDate > endDate) return 'terminee';
  return 'en_cours';
}

export function getEffectiveCampaignStatus(
  campaign: Pick<Campaign, 'startDate' | 'endDate' | 'status'>,
  referenceDate = new Date().toISOString().slice(0, 10)
): CampaignStatus {
  if (campaign.status) return campaign.status;
  return suggestCampaignStatus(campaign.startDate, campaign.endDate, referenceDate);
}

/**
 * Statut effectif d'un proforma (passe automatiquement à 'expire' après validUntil si brouillon/envoyé).
 */
export function getEffectiveProformaStatus(
  proforma: Pick<Proforma, 'status' | 'validUntil' | 'convertedInvoiceId'>,
  referenceDate = new Date().toISOString().slice(0, 10)
): ProformaStatus {
  if (proforma.convertedInvoiceId || proforma.status === 'facture') return 'facture';
  if (proforma.status === 'accepte' || proforma.status === 'refuse' || proforma.status === 'expire') {
    return proforma.status;
  }
  if (proforma.validUntil && proforma.validUntil < referenceDate) {
    return 'expire';
  }
  return proforma.status;
}

/**
 * Calcule le statut de facturation d'un BC reçu en fonction des factures clients liées.
 */
export function computeBcRecuInvoicingStatus(params: {
  bc: PurchaseOrder;
  linkedInvoices: CustomerInvoice[];
}): BcRecuStatus {
  if (params.bc.status === 'annule') return 'annule';
  const activeInvoices = params.linkedInvoices.filter(
    (inv) => !inv.deletedAt && inv.status !== 'annulee'
  );
  if (activeInvoices.length === 0) {
    return params.bc.status === 'en_cours' ? 'en_cours' : 'recu';
  }
  if (params.bc.totalTtcCentimes > 0) {
    const invoicedTotal = activeInvoices.reduce(
      (sum, inv) => addMoney(sum, inv.totalTtcCentimes),
      0
    );
    if (invoicedTotal < params.bc.totalTtcCentimes) {
      return 'partiellement_facture';
    }
  }
  return 'facture';
}

export function formatDateFr(isoDate?: string): string {
  if (!isoDate) return '—';
  const parts = isoDate.split('-');
  if (parts.length !== 3) return isoDate;
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

export interface DocumentLinePageChunk {
  pageIndex: number;
  startIndex: number;
  lines: InvoiceLine[];
}

function estimateInvoiceLineWeight(line: InvoiceLine): number {
  const descLines = (line.description || '').split('\n');
  let visualLines = 0;
  for (const part of descLines) {
    visualLines += Math.max(1, Math.ceil(part.length / 54));
  }
  return Math.max(1, 0.7 + visualLines * 0.52);
}

/**
 * Découpe les lignes d'une facture/proforma/BC en feuilles A4 explicites
 * afin que chaque page garde son en-tête de tableau et son pied de page fixe.
 */
export function computeTemplatePageChunks(
  lines: InvoiceLine[],
  options?: { hasCampaignBanner?: boolean; hasFooterNotes?: boolean }
): DocumentLinePageChunk[] {
  if (!lines || lines.length === 0) {
    return [{ pageIndex: 0, startIndex: 0, lines: [] }];
  }

  const firstPageMaxWithTotals = options?.hasCampaignBanner ? 9.5 : 10.5;
  const firstPageMaxWithoutTotals = options?.hasCampaignBanner ? 14 : 15;
  const nextPageMaxWithTotals = options?.hasFooterNotes ? 14 : 15.5;
  const nextPageMaxWithoutTotals = 19.5;

  const totalWeight = lines.reduce((sum, l) => sum + estimateInvoiceLineWeight(l), 0);
  if (totalWeight <= firstPageMaxWithTotals) {
    return [{ pageIndex: 0, startIndex: 0, lines }];
  }

  const chunks: DocumentLinePageChunk[] = [];
  let cursor = 0;
  let pageIndex = 0;

  while (cursor < lines.length) {
    const isFirst = pageIndex === 0;
    const capacity = isFirst ? firstPageMaxWithoutTotals : nextPageMaxWithoutTotals;
    const capacityWithTotals = isFirst ? firstPageMaxWithTotals : nextPageMaxWithTotals;

    const remainingLines = lines.slice(cursor);
    const remainingWeight = remainingLines.reduce(
      (sum, l) => sum + estimateInvoiceLineWeight(l),
      0
    );

    if (remainingWeight <= capacityWithTotals) {
      chunks.push({ pageIndex, startIndex: cursor, lines: remainingLines });
      cursor = lines.length;
      break;
    }

    let acc = 0;
    let takeCount = 0;
    while (cursor + takeCount < lines.length) {
      const w = estimateInvoiceLineWeight(lines[cursor + takeCount]);
      if (takeCount > 0 && acc + w > capacity) {
        break;
      }
      acc += w;
      takeCount += 1;
    }

    chunks.push({
      pageIndex,
      startIndex: cursor,
      lines: lines.slice(cursor, cursor + takeCount),
    });
    cursor += takeCount;
    pageIndex += 1;
  }

  return chunks;
}
