import { createId, db, recordAudit } from '../../db/database';
import type {
  BcEmisStatus,
  BcRecuStatus,
  Campaign,
  CompanyProfile,
  Contact,
  DocumentAttachment,
  PurchaseOrder,
  PurchaseOrderDirection,
} from '../../db/types';
import {
  addAttachmentToPurchaseOrder,
  saveCampaign,
  savePurchaseOrder,
} from '../documentActions';
import { saveContact } from '../financeActions';
import { centimesToInputString, parseMoneyInputToCentimes } from '../../utils/money';
import {
  normCompare,
  parseFrenchOrIsoDate,
  type ParsedBcLine,
  type ParsedPurchaseOrder,
} from './parsePurchaseOrder';

export interface BcCounterpartyDraft {
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

export interface EditableImportedBcLine {
  id: string;
  title: string;
  description: string;
  qtyText: string;
  unit: string;
  unitPriceText: string;
  totalText: string;
}

export interface EditableImportedBcDraft {
  direction: PurchaseOrderDirection;
  companyProfileId: string;
  poNumber: string;
  issueDate: string;
  city: string;
  status: BcRecuStatus | BcEmisStatus;
  selectedContactId: string; // '' = créer nouveau ou auto-associer
  party: BcCounterpartyDraft;
  campaignId?: string;
  campaignRef: string;
  campaignStartDate: string;
  campaignEndDate: string;
  createOrLinkCampaign: boolean;
  delivery: string;
  paymentTerms: string;
  vatRateText: string;
  amountInWordsOverride: string;
  notes: string;
  currency: string;
  lines: EditableImportedBcLine[];
}

export function arrayBufferToDataUrl(buffer: ArrayBuffer, mimeType: string): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  const base64 = btoa(binary);
  const safeMime = mimeType || 'application/octet-stream';
  return `data:${safeMime};base64,${base64}`;
}

export function dataUrlToUint8Array(dataUrl: string): Uint8Array {
  const commaIdx = dataUrl.indexOf(',');
  const base64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function normDigits(value?: string): string {
  return (value || '').replace(/\D+/g, '');
}

function normRc(value?: string): string {
  return (value || '').replace(/[^a-zA-Z0-9]+/g, '').toUpperCase();
}

function companyWords(value?: string): string[] {
  const stop = new Set([
    'sarl',
    'eurl',
    'spa',
    'sas',
    'snc',
    'ets',
    'epe',
    'ste',
    'societe',
    'entreprise',
  ]);
  return normCompare(value || '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2 && !stop.has(w));
}

function diceSimilarity(a: string, b: string): number {
  const sa = normCompare(a).replace(/[^a-z0-9]/g, '');
  const sb = normCompare(b).replace(/[^a-z0-9]/g, '');
  if (!sa || !sb) return 0;
  if (sa === sb) return 1;
  if (sa.length < 2 || sb.length < 2) return 0;
  const bigramsA = new Map<string, number>();
  for (let i = 0; i < sa.length - 1; i += 1) {
    const bg = sa.slice(i, i + 2);
    bigramsA.set(bg, (bigramsA.get(bg) || 0) + 1);
  }
  let intersection = 0;
  for (let i = 0; i < sb.length - 1; i += 1) {
    const bg = sb.slice(i, i + 2);
    const cnt = bigramsA.get(bg) || 0;
    if (cnt > 0) {
      bigramsA.set(bg, cnt - 1);
      intersection += 1;
    }
  }
  return (2 * intersection) / (sa.length - 1 + (sb.length - 1));
}

export function isSimilarContactName(a?: string, b?: string): boolean {
  const na = normCompare(a || '');
  const nb = normCompare(b || '');
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length >= 5 && nb.length >= 5 && (na.includes(nb) || nb.includes(na))) {
    return true;
  }
  const wa = companyWords(a);
  const wb = companyWords(b);
  if (wa.length > 0 && wb.length > 0) {
    const setA = new Set(wa);
    const shared = wb.filter((w) => setA.has(w));
    if (shared.length >= Math.min(wa.length, wb.length) && shared.length >= 1) {
      return true;
    }
  }
  return diceSimilarity(na, nb) >= 0.78;
}

export function extractCounterpartyFromParsedBc(
  parsed: ParsedPurchaseOrder,
  directionOverride?: PurchaseOrderDirection
): BcCounterpartyDraft {
  const dir: PurchaseOrderDirection =
    directionOverride || (parsed.direction === 'emis' ? 'bc_emis' : 'bc_recu');

  if (dir === 'bc_emis') {
    return {
      name: parsed.party.name || '',
      address: parsed.party.address || '',
      email: parsed.party.email || '',
      phone: parsed.party.phone || '',
      fax: parsed.party.fax || '',
      rc: parsed.party.rc || '',
      nif: parsed.party.nif || '',
      ai: parsed.party.ai || '',
      nis: parsed.party.nis || '',
    };
  }

  // Pour un BC reçu d'un client : le client est l'émetteur du BC (ou fallback party si issuer vide)
  const hasIssuerInfo = Boolean(
    parsed.issuer.name || parsed.issuer.nif || parsed.issuer.rc || parsed.issuer.email
  );
  if (hasIssuerInfo) {
    return {
      name: parsed.issuer.name || parsed.party.name || '',
      address: parsed.issuer.address || '',
      email: parsed.issuer.email || '',
      phone: parsed.issuer.phone || '',
      fax: '',
      rc: parsed.issuer.rc || '',
      nif: parsed.issuer.nif || '',
      ai: parsed.issuer.ai || '',
      nis: parsed.issuer.nis || '',
    };
  }
  return {
    name: parsed.party.name || '',
    address: parsed.party.address || '',
    email: parsed.party.email || '',
    phone: parsed.party.phone || '',
    fax: parsed.party.fax || '',
    rc: parsed.party.rc || '',
    nif: parsed.party.nif || '',
    ai: parsed.party.ai || '',
    nis: parsed.party.nis || '',
  };
}

export function matchContactForBc(params: {
  direction: PurchaseOrderDirection;
  party: Pick<BcCounterpartyDraft, 'name' | 'nif' | 'rc'>;
  existingContacts: Contact[];
}): { contact: Contact | null; matchReason: 'nif' | 'rc' | 'name' | null } {
  const active = params.existingContacts.filter((c) => !c.deletedAt);
  const preferredPool = active.filter((c) =>
    params.direction === 'bc_recu'
      ? c.type === 'client' || c.type === 'les_deux'
      : c.type === 'fournisseur' || c.type === 'les_deux'
  );
  const pools = [preferredPool, active];

  const targetNif = normDigits(params.party.nif);
  const targetRc = normRc(params.party.rc);
  const targetName = params.party.name?.trim() || '';

  for (const pool of pools) {
    if (targetNif) {
      const byNif = pool.find((c) => normDigits(c.nif) === targetNif);
      if (byNif) return { contact: byNif, matchReason: 'nif' };
    }
    if (targetRc) {
      const byRc = pool.find((c) => normRc(c.rc) === targetRc);
      if (byRc) return { contact: byRc, matchReason: 'rc' };
    }
    if (targetName) {
      const byName = pool.find(
        (c) =>
          isSimilarContactName(c.company, targetName) ||
          isSimilarContactName(c.name, targetName)
      );
      if (byName) return { contact: byName, matchReason: 'name' };
    }
  }

  return { contact: null, matchReason: null };
}

export function normalizePoNumberForCompare(poNumber: string): string {
  return normCompare(poNumber)
    .replace(/^(?:bc\s*n[°ºo.]?|bon\s*de\s*commande\s*n[°ºo.]?|n[°ºo.]?)\s*/i, '')
    .replace(/\s+/g, '');
}

export function extractYearFromPo(poNumber: string, issueDate?: string): string {
  if (issueDate && /^\d{4}/.test(issueDate)) {
    return issueDate.slice(0, 4);
  }
  const m = poNumber.match(/\/(\d{2,4})(?:\/|$)/);
  if (m) {
    return m[1].length === 2 ? `20${m[1]}` : m[1];
  }
  return '';
}

export function findDuplicatePurchaseOrder(params: {
  direction: PurchaseOrderDirection;
  poNumber: string;
  issueDate?: string;
  contactId?: string;
  existingOrders: PurchaseOrder[];
}): PurchaseOrder | undefined {
  const targetNum = normalizePoNumberForCompare(params.poNumber);
  if (!targetNum) return undefined;
  const targetYear = extractYearFromPo(params.poNumber, params.issueDate);

  return params.existingOrders.find((po) => {
    if (po.deletedAt) return false;
    if (po.direction !== params.direction) return false;
    if (normalizePoNumberForCompare(po.poNumber) !== targetNum) return false;
    const poYear = extractYearFromPo(po.poNumber, po.issueDate);
    if (targetYear && poYear && targetYear !== poYear) return false;
    if (params.contactId && po.contactId && po.contactId !== params.contactId) {
      return false;
    }
    return true;
  });
}

function formatNumberInput(val: number | null): string {
  if (val === null || val === undefined || !Number.isFinite(val)) return '';
  return String(val).replace('.', ',');
}

function formatMoneyInput(val: number | null): string {
  if (val === null || val === undefined || !Number.isFinite(val)) return '';
  return centimesToInputString(Math.round(val * 100));
}

export function parsedLineToEditable(line: ParsedBcLine): EditableImportedBcLine {
  return {
    id: createId('bcl'),
    title: line.title || '',
    description: line.description || '',
    qtyText: formatNumberInput(line.qty),
    unit: line.unit || '',
    unitPriceText: formatMoneyInput(line.unitPrice),
    totalText: formatMoneyInput(line.total),
  };
}

export function createInitialImportedBcDraft(params: {
  parsed: ParsedPurchaseOrder;
  companyProfiles: CompanyProfile[];
  existingContacts: Contact[];
  defaultCurrency?: string;
  fallbackProfileId?: string;
}): EditableImportedBcDraft {
  const { parsed, companyProfiles, existingContacts } = params;
  const dir: PurchaseOrderDirection = parsed.direction === 'emis' ? 'bc_emis' : 'bc_recu';
  const activeProfiles = companyProfiles.filter((p) => !p.deletedAt);
  const profileId =
    parsed.matchedCompanyProfileId ||
    params.fallbackProfileId ||
    activeProfiles.find((p) => p.isDefault)?.id ||
    activeProfiles[0]?.id ||
    '';

  const party = extractCounterpartyFromParsedBc(parsed, dir);
  const matched = matchContactForBc({
    direction: dir,
    party,
    existingContacts,
  });

  const issueDate =
    parsed.date ||
    parseFrenchOrIsoDate(parsed.date || '') ||
    new Date().toISOString().slice(0, 10);

  return {
    direction: dir,
    companyProfileId: profileId,
    poNumber: parsed.number || '',
    issueDate,
    city: parsed.city || '',
    status: dir === 'bc_recu' ? 'recu' : 'brouillon',
    selectedContactId: matched.contact?.id || '',
    party,
    campaignId: undefined,
    campaignRef: parsed.campaign || '',
    campaignStartDate: parsed.startDate || '',
    campaignEndDate: parsed.endDate || '',
    createOrLinkCampaign: dir === 'bc_recu' && Boolean(parsed.campaign?.trim()),
    delivery: parsed.delivery || '',
    paymentTerms: parsed.paymentTerms || '',
    vatRateText: String(parsed.totals?.vatRate ?? 19),
    amountInWordsOverride: parsed.amountInWords || '',
    notes: '',
    currency: params.defaultCurrency || 'DZD',
    lines: parsed.lines.map(parsedLineToEditable),
  };
}

export function parseDecimalOptional(raw: string): number | null {
  const clean = (raw || '').trim().replace(/\s|\u00a0|\u202f/g, '').replace(',', '.');
  if (!clean) return null;
  const n = Number(clean);
  return Number.isFinite(n) ? n : null;
}

export function parseMoneyOptionalCentimes(raw: string): number | null {
  const clean = (raw || '').trim();
  if (!clean) return null;
  const c = parseMoneyInputToCentimes(clean);
  return Number.isNaN(c) ? null : c;
}

export function computeDraftTotals(draft: EditableImportedBcDraft): {
  unpriced: boolean;
  htCentimes: number;
  tvaCentimes: number;
  ttcCentimes: number;
  vatRate: number;
} {
  const vatRate = Math.max(0, parseDecimalOptional(draft.vatRateText) ?? 19);
  let hasAnyPrice = false;
  let htCentimes = 0;

  for (const line of draft.lines) {
    const qty = parseDecimalOptional(line.qtyText);
    const puCentimes = parseMoneyOptionalCentimes(line.unitPriceText);
    const totalCentimes = parseMoneyOptionalCentimes(line.totalText);

    if (puCentimes !== null || totalCentimes !== null) {
      hasAnyPrice = true;
    }

    if (totalCentimes !== null) {
      htCentimes += totalCentimes;
    } else if (puCentimes !== null) {
      const effectiveQty = qty !== null ? qty : 1;
      htCentimes += Math.round(effectiveQty * puCentimes);
    }
  }

  if (!hasAnyPrice) {
    return { unpriced: true, htCentimes: 0, tvaCentimes: 0, ttcCentimes: 0, vatRate };
  }

  const tvaCentimes = Math.round((htCentimes * vatRate) / 100);
  return {
    unpriced: false,
    htCentimes,
    tvaCentimes,
    ttcCentimes: htCentimes + tvaCentimes,
    vatRate,
  };
}

export async function ensureBcContactSaved(params: {
  direction: PurchaseOrderDirection;
  selectedContactId?: string;
  party: BcCounterpartyDraft;
}): Promise<{ contact: Contact; created: boolean }> {
  const existingContacts = await db.contacts.filter((c) => !c.deletedAt).toArray();
  const desiredType = params.direction === 'bc_recu' ? 'client' : 'fournisseur';

  let existing: Contact | undefined = params.selectedContactId
    ? existingContacts.find((c) => c.id === params.selectedContactId)
    : undefined;

  if (!existing) {
    const matched = matchContactForBc({
      direction: params.direction,
      party: params.party,
      existingContacts,
    });
    if (matched.contact) {
      existing = matched.contact;
    }
  }

  if (existing) {
    const nextType: Contact['type'] =
      existing.type !== desiredType && existing.type !== 'les_deux' ? 'les_deux' : existing.type;
    const patch: Partial<Contact> = {};
    if (nextType !== existing.type) patch.type = nextType;
    if (!existing.address && params.party.address) patch.address = params.party.address.trim();
    if (!existing.phone && params.party.phone) patch.phone = params.party.phone.trim();
    if (!existing.email && params.party.email) patch.email = params.party.email.trim();
    if (!existing.nif && params.party.nif) patch.nif = params.party.nif.trim();
    if (!existing.rc && params.party.rc) patch.rc = params.party.rc.trim();
    if (!existing.ai && params.party.ai) patch.ai = params.party.ai.trim();
    if (!existing.nis && params.party.nis) patch.nis = params.party.nis.trim();

    if (Object.keys(patch).length > 0) {
      patch.updatedAt = new Date().toISOString();
      await db.contacts.update(existing.id, patch);
      existing = { ...existing, ...patch };
    }
    return { contact: existing, created: false };
  }

  const companyName = params.party.name.trim();
  if (!companyName) {
    throw new Error(
      params.direction === 'bc_recu'
        ? 'Veuillez saisir le nom du client ou sélectionner un client existant.'
        : 'Veuillez saisir le nom du fournisseur ou sélectionner un fournisseur existant.'
    );
  }

  const created = await saveContact({
    type: desiredType,
    name: companyName,
    company: companyName,
    address: params.party.address.trim(),
    phone: [params.party.phone, params.party.fax].filter(Boolean).join(' / ').trim(),
    email: params.party.email.trim(),
    nif: params.party.nif.trim(),
    nis: params.party.nis.trim(),
    rc: params.party.rc.trim(),
    ai: params.party.ai.trim(),
    notes: 'Créé automatiquement lors de l’import de bon de commande.',
  });

  return { contact: created, created: true };
}

export async function ensureBcCampaignSaved(params: {
  clientId: string;
  campaignId?: string;
  campaignRef: string;
  startDate?: string;
  endDate?: string;
  fallbackDate: string;
}): Promise<Campaign | null> {
  if (params.campaignId) {
    const existing = await db.campaigns.get(params.campaignId);
    if (existing && !existing.deletedAt) return existing;
  }

  const name = params.campaignRef.trim();
  if (!name) return null;

  const clientCampaigns = await db.campaigns
    .filter((c) => !c.deletedAt && c.clientId === params.clientId)
    .toArray();
  const match = clientCampaigns.find((c) => normCompare(c.name) === normCompare(name));
  if (match) return match;

  const sDate = params.startDate || params.fallbackDate || new Date().toISOString().slice(0, 10);
  const eDate =
    params.endDate && params.endDate >= sDate
      ? params.endDate
      : sDate;

  return saveCampaign({
    name,
    clientId: params.clientId,
    startDate: sDate,
    endDate: eDate,
    notes: 'Créée automatiquement lors de l’import BC',
  });
}

export interface SaveImportedBcResult {
  purchaseOrder: PurchaseOrder;
  contact: Contact;
  contactCreated: boolean;
  campaign: Campaign | null;
  attachment: DocumentAttachment;
}

export async function saveImportedPurchaseOrder(params: {
  draft: EditableImportedBcDraft;
  sourceFile: {
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    rawBuffer: ArrayBuffer;
  };
}): Promise<SaveImportedBcResult> {
  const { draft, sourceFile } = params;
  if (!draft.poNumber.trim()) {
    throw new Error('Le numéro de bon de commande est obligatoire.');
  }
  if (!draft.issueDate) {
    throw new Error('La date du bon de commande est obligatoire.');
  }

  const { contact, created: contactCreated } = await ensureBcContactSaved({
    direction: draft.direction,
    selectedContactId: draft.selectedContactId,
    party: draft.party,
  });

  let campaign: Campaign | null = null;
  let effectiveCampaignId = draft.campaignId;
  const fallbackCampaignTitle =
    draft.campaignRef.trim() || draft.lines[0]?.title.trim() || '';

  if (draft.direction === 'bc_recu' && draft.createOrLinkCampaign && fallbackCampaignTitle) {
    campaign = await ensureBcCampaignSaved({
      clientId: contact.id,
      campaignId: draft.campaignId,
      campaignRef: fallbackCampaignTitle,
      startDate: draft.campaignStartDate || undefined,
      endDate: draft.campaignEndDate || undefined,
      fallbackDate: draft.issueDate,
    });
    effectiveCampaignId = campaign?.id;
  }

  const totalsInfo = computeDraftTotals(draft);
  const vatRate = totalsInfo.vatRate;

  const invoiceLines = draft.lines
    .filter((l) => l.title.trim() || l.description.trim() || l.unitPriceText.trim())
    .map((l) => {
      const fullDesc = [l.title.trim(), l.description.trim()].filter(Boolean).join('\n');
      const qtyNum = parseDecimalOptional(l.qtyText);
      const puCentimes = parseMoneyOptionalCentimes(l.unitPriceText);
      const explicitTotalCentimes = parseMoneyOptionalCentimes(l.totalText);

      const safeQty = qtyNum !== null ? qtyNum : 0;
      const safePu =
        puCentimes !== null
          ? puCentimes
          : explicitTotalCentimes !== null && safeQty > 0
          ? Math.round(explicitTotalCentimes / safeQty)
          : explicitTotalCentimes !== null
          ? explicitTotalCentimes
          : 0;

      const manualTotalLocked =
        explicitTotalCentimes !== null &&
        (puCentimes === null ||
          Math.abs(Math.round((qtyNum ?? 1) * puCentimes) - explicitTotalCentimes) > 1);

      return {
        id: l.id || createId('line'),
        description: fullDesc || 'Prestation',
        quantity: safeQty > 0 ? safeQty : puCentimes !== null || explicitTotalCentimes !== null ? 1 : 0,
        unit: l.unit.trim() || 'u',
        unitPriceCentimes: safePu,
        discountPercent: 0,
        tvaRate: totalsInfo.unpriced ? 0 : vatRate,
        htCentimes: explicitTotalCentimes ?? undefined,
        manualTotalLocked,
      };
    });

  const savedPo = await savePurchaseOrder({
    direction: draft.direction,
    poNumber: draft.poNumber.trim(),
    companyProfileId: draft.companyProfileId || undefined,
    contactId: contact.id,
    issueDate: draft.issueDate,
    campaignId: effectiveCampaignId,
    campaignRef: (draft.campaignRef || campaign?.name || '').trim(),
    campaignStartDate: draft.campaignStartDate || undefined,
    campaignEndDate: draft.campaignEndDate || undefined,
    showCampaignOnPrint: Boolean(draft.campaignRef.trim() || draft.campaignStartDate),
    currency: draft.currency || 'DZD',
    exchangeRate: 1,
    description:
      draft.campaignRef.trim() ||
      draft.lines[0]?.title.trim() ||
      `BC importé (${sourceFile.fileName})`,
    amountInWordsOverride: draft.amountInWordsOverride.trim() || undefined,
    delivery: draft.delivery.trim() || undefined,
    paymentTerms: draft.paymentTerms.trim() || undefined,
    tags: ['Importé'],
    isImported: true,
    importedFromFile: sourceFile.fileName,
    unpriced: totalsInfo.unpriced,
    allowDuplicateNumber: true,
    notes: [
      draft.notes.trim(),
      draft.delivery.trim() ? `Livraison : ${draft.delivery.trim()}` : '',
      draft.paymentTerms.trim() ? `Paiement : ${draft.paymentTerms.trim()}` : '',
    ]
      .filter(Boolean)
      .join(' · '),
    status:
      draft.direction === 'bc_recu'
        ? (draft.status as BcRecuStatus) || 'recu'
        : (draft.status as BcEmisStatus) || 'brouillon',
    lines: invoiceLines,
  });

  const dataUrl = arrayBufferToDataUrl(sourceFile.rawBuffer, sourceFile.mimeType);
  const attachment = await addAttachmentToPurchaseOrder({
    parentId: savedPo.id,
    parentType: draft.direction,
    fileName: sourceFile.fileName,
    mimeType: sourceFile.mimeType,
    sizeBytes: sourceFile.sizeBytes,
    dataUrl,
  });

  await recordAudit({
    action: 'IMPORT',
    entityType: draft.direction,
    entityId: savedPo.id,
    summary: `Import ${draft.direction === 'bc_recu' ? 'BC reçu' : 'BC émis'} ${savedPo.poNumber} depuis ${sourceFile.fileName}`,
    after: { poId: savedPo.id, contactId: contact.id, attachmentId: attachment.id },
  });

  return {
    purchaseOrder: { ...savedPo, attachmentsCount: 1 },
    contact,
    contactCreated,
    campaign,
    attachment,
  };
}
