import { createId, db, recordAudit } from '../db/database';
import type {
  BcEmisStatus,
  BcRecuStatus,
  Campaign,
  CampaignStatus,
  ClientFiscalSnapshot,
  CompanyProfile,
  CustomerInvoice,
  DocumentAttachment,
  InvoiceLine,
  Proforma,
  ProformaStatus,
  PurchaseOrder,
  PurchaseOrderDirection,
} from '../db/types';
import {
  computeBcRecuInvoicingStatus,
  computeCampaignDuration,
  computeNextSequenceNumber,
  suggestCampaignStatus,
} from '../utils/documentHelpers';
import { computeInvoiceDocumentTotals } from '../utils/finance';
import { convertToBaseDzd } from '../utils/money';
import { generateNextInvoiceNumber, saveCustomerInvoice } from './financeActions';

// ============================================================================
// PROFILS SOCIÉTÉS ("Mes sociétés")
// ============================================================================

export function buildIssuerSnapshot(
  profile?: Partial<CompanyProfile>
): Partial<CompanyProfile> | undefined {
  if (!profile) return undefined;
  return {
    id: profile.id,
    name: profile.name,
    logoDataUrl: profile.logoDataUrl,
    address: profile.address,
    postalCode: profile.postalCode,
    city: profile.city,
    phone: profile.phone,
    fax: profile.fax,
    email: profile.email,
    nif: profile.nif,
    nis: profile.nis,
    rc: profile.rc,
    ai: profile.ai,
    rib: profile.rib,
    bankInfo: profile.bankInfo,
    primaryColor: profile.primaryColor,
    accentColor: profile.accentColor,
    footerNote: profile.footerNote,
    signatureDataUrl: profile.signatureDataUrl,
    signatureLabel: profile.signatureLabel,
  };
}

export async function saveCompanyProfile(params: {
  existingId?: string;
  name: string;
  logoDataUrl: string;
  address: string;
  postalCode?: string;
  city?: string;
  phone: string;
  fax?: string;
  email: string;
  nif: string;
  nis: string;
  rc: string;
  ai: string;
  rib?: string;
  bankInfo?: string;
  primaryColor: string;
  accentColor: string;
  footerNote?: string;
  signatureDataUrl?: string;
  signatureLabel?: string;
  applyThemeToApp?: boolean;
  isDefault?: boolean;
}): Promise<CompanyProfile> {
  if (!params.name.trim()) {
    throw new Error('Le nom / raison sociale de la société est obligatoire.');
  }
  const now = new Date().toISOString();
  const existing = params.existingId ? await db.companyProfiles.get(params.existingId) : undefined;
  const id = existing?.id || createId('prof');

  const record: CompanyProfile = {
    id,
    name: params.name.trim(),
    logoDataUrl: params.logoDataUrl,
    address: params.address.trim(),
    postalCode: params.postalCode?.trim() || '',
    city: params.city?.trim() || '',
    phone: params.phone.trim(),
    fax: params.fax?.trim() || '',
    email: params.email.trim(),
    nif: params.nif.trim(),
    nis: params.nis.trim(),
    rc: params.rc.trim(),
    ai: params.ai.trim(),
    rib: params.rib?.trim() || '',
    bankInfo: params.bankInfo?.trim() || '',
    primaryColor: params.primaryColor || '#FF33CC',
    accentColor: params.accentColor || '#6B2FA0',
    footerNote: params.footerNote?.trim() || '',
    signatureDataUrl: params.signatureDataUrl ?? existing?.signatureDataUrl ?? '',
    signatureLabel: (params.signatureLabel ?? existing?.signatureLabel ?? 'SERVICE COMMERCIAL').trim(),
    applyThemeToApp: params.applyThemeToApp ?? existing?.applyThemeToApp ?? true,
    isDefault: Boolean(params.isDefault ?? existing?.isDefault),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };

  await db.transaction('rw', [db.companyProfiles, db.settings], async () => {
    if (record.isDefault) {
      const all = await db.companyProfiles.toArray();
      for (const p of all) {
        if (p.id !== id && p.isDefault) {
          await db.companyProfiles.update(p.id, { isDefault: false });
        }
      }
    }
    await db.companyProfiles.put(record);
    if (record.isDefault) {
      await db.settings.update('company_settings', {
        companyName: record.name,
        logoDataUrl: record.logoDataUrl,
        address: record.address,
        phone: record.phone,
        email: record.email,
        nif: record.nif,
        nis: record.nis,
        rc: record.rc,
        ai: record.ai,
        activeCompanyProfileId: record.id,
        updatedAt: now,
      });
    }
  });

  await recordAudit({
    action: existing ? 'MODIFICATION' : 'CREATION',
    entityType: 'societe',
    entityId: id,
    summary: `${existing ? 'Modification' : 'Création'} société « ${record.name} »`,
    after: record,
  });

  return record;
}

export async function setActiveCompanyProfile(profileId: string): Promise<void> {
  const prof = await db.companyProfiles.get(profileId);
  if (!prof || prof.deletedAt) throw new Error('Profil société introuvable.');
  const now = new Date().toISOString();
  await db.transaction('rw', [db.companyProfiles, db.settings], async () => {
    const all = await db.companyProfiles.toArray();
    for (const p of all) {
      await db.companyProfiles.update(p.id, { isDefault: p.id === profileId });
    }
    await db.settings.update('company_settings', {
      companyName: prof.name,
      logoDataUrl: prof.logoDataUrl,
      address: prof.address,
      phone: prof.phone,
      email: prof.email,
      nif: prof.nif,
      nis: prof.nis,
      rc: prof.rc,
      ai: prof.ai,
      activeCompanyProfileId: prof.id,
      updatedAt: now,
    });
  });
}

// ============================================================================
// CAMPAGNES
// ============================================================================

export async function saveCampaign(params: {
  existingId?: string;
  name: string;
  clientId: string;
  startDate: string;
  endDate: string;
  status?: CampaignStatus;
  notes?: string;
}): Promise<Campaign> {
  if (!params.name.trim()) throw new Error('Le nom de la campagne est obligatoire.');
  if (!params.clientId) throw new Error('Veuillez sélectionner un client.');
  if (!params.startDate || !params.endDate) {
    throw new Error('Les dates de début et de fin sont obligatoires.');
  }
  const dur = computeCampaignDuration(params.startDate, params.endDate);
  if (!dur.valid) {
    throw new Error(dur.label);
  }

  const now = new Date().toISOString();
  const existing = params.existingId ? await db.campaigns.get(params.existingId) : undefined;
  const status = params.status || suggestCampaignStatus(params.startDate, params.endDate);

  const record: Campaign = {
    id: existing?.id || createId('cmp'),
    name: params.name.trim(),
    clientId: params.clientId,
    startDate: params.startDate,
    endDate: params.endDate,
    status,
    notes: (params.notes || '').trim(),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };

  await db.campaigns.put(record);
  await recordAudit({
    action: existing ? 'MODIFICATION' : 'CREATION',
    entityType: 'campagne',
    entityId: record.id,
    summary: `${existing ? 'Modification' : 'Création'} campagne « ${record.name} »`,
    before: existing,
    after: record,
  });

  return record;
}

// ============================================================================
// BONS DE COMMANDE (BC REÇUS DES CLIENTS & BC ÉMIS AUX FOURNISSEURS)
// ============================================================================

export async function generateNextBcEmisNumber(
  year = new Date().getFullYear(),
  companyProfileId?: string
): Promise<string> {
  const existing = await db.purchaseOrders
    .filter((po) => po.direction === 'bc_emis')
    .toArray();
  return computeNextSequenceNumber({
    kind: 'bc_emis',
    existingNumbers: existing.map((po) => ({
      number: po.poNumber,
      date: po.issueDate,
      companyProfileId: po.companyProfileId,
    })),
    yearFull: year,
    companyProfileId,
  });
}

export async function savePurchaseOrder(params: {
  existingId?: string;
  direction: PurchaseOrderDirection;
  poNumber: string;
  companyProfileId?: string;
  contactId: string;
  issueDate: string;
  expectedDate?: string;
  campaignId?: string;
  campaignRef: string;
  campaignStartDate?: string;
  campaignEndDate?: string;
  showCampaignOnPrint?: boolean;
  currency: string;
  exchangeRate: number;
  description: string;
  amountInWordsOverride?: string;
  delivery?: string;
  paymentTerms?: string;
  tags?: string[];
  isImported?: boolean;
  importedFromFile?: string;
  unpriced?: boolean;
  allowDuplicateNumber?: boolean;
  notes: string;
  status?: BcRecuStatus | BcEmisStatus;
  lines: Array<
    Partial<InvoiceLine> & {
      description: string;
      quantity: number;
      unitPriceCentimes: number;
      discountPercent: number;
      tvaRate: number;
    }
  >;
  // Option montants directs sur BC reçu s'il n'y a pas de lignes détaillées
  directHtCentimes?: number;
  directTtcCentimes?: number;
}): Promise<PurchaseOrder> {
  if (!params.poNumber.trim()) {
    throw new Error('Le numéro de bon de commande est obligatoire.');
  }
  if (!params.contactId) {
    throw new Error(
      params.direction === 'bc_recu'
        ? 'Veuillez sélectionner un client.'
        : 'Veuillez sélectionner un fournisseur.'
    );
  }
  if (!params.issueDate) {
    throw new Error('La date du bon de commande est obligatoire.');
  }
  if (params.campaignStartDate && params.campaignEndDate) {
    const dur = computeCampaignDuration(params.campaignStartDate, params.campaignEndDate);
    if (!dur.valid) throw new Error(dur.label);
  }

  const now = new Date().toISOString();
  const existing = params.existingId ? await db.purchaseOrders.get(params.existingId) : undefined;
  const cleanNumber = params.poNumber.trim();

  if (params.direction === 'bc_emis' && !params.allowDuplicateNumber) {
    const dup = await db.purchaseOrders
      .filter((p) => p.direction === 'bc_emis' && p.poNumber === cleanNumber && !p.deletedAt)
      .first();
    if (dup && dup.id !== existing?.id) {
      throw new Error(`Le numéro « ${cleanNumber} » est déjà utilisé.`);
    }
  }

  const validLines = params.lines.filter((l) => l.description.trim() || l.unitPriceCentimes > 0);
  let computed = computeInvoiceDocumentTotals(validLines);

  if (params.direction === 'bc_recu' && computed.totalTtcCentimes === 0) {
    const ht = Math.round(params.directHtCentimes || 0);
    const ttc = Math.round(params.directTtcCentimes || 0);
    if (ht > 0 || ttc > 0) {
      const finalHt = ht > 0 ? ht : Math.round(ttc / 1.19);
      const finalTtc = ttc > 0 ? ttc : Math.round(finalHt * 1.19);
      const tva = Math.max(0, finalTtc - finalHt);
      computed = {
        lines: validLines.length
          ? computed.lines
          : [
              {
                id: createId('line'),
                description: params.description.trim() || params.campaignRef.trim() || `BC ${cleanNumber}`,
                quantity: 1,
                unit: 'forfait',
                unitPriceCentimes: finalHt,
                discountPercent: 0,
                tvaRate: finalHt > 0 ? Math.round((tva * 100) / finalHt) : 19,
                htCentimes: finalHt,
                tvaCentimes: tva,
                ttcCentimes: finalTtc,
              },
            ],
        totalHtCentimes: finalHt,
        totalTvaCentimes: tva,
        totalTtcCentimes: finalTtc,
      };
    }
  }

  const id = existing?.id || createId('po');
  const attachmentsCount = existing
    ? await db.documentAttachments.where('parentId').equals(existing.id).count()
    : 0;

  const selectedProfile = params.companyProfileId
    ? await db.companyProfiles.get(params.companyProfileId)
    : undefined;
  const issuerSnapshot =
    selectedProfile &&
    (!existing?.issuerSnapshot || existing.companyProfileId !== params.companyProfileId)
      ? buildIssuerSnapshot(selectedProfile)
      : existing?.issuerSnapshot || buildIssuerSnapshot(selectedProfile);

  const defaultStatus = params.direction === 'bc_recu' ? 'recu' : 'brouillon';
  const resolvedTags =
    params.tags ?? existing?.tags ?? (params.isImported ? ['Importé'] : undefined);

  const record: PurchaseOrder = {
    id,
    direction: params.direction,
    poNumber: cleanNumber,
    companyProfileId: params.companyProfileId,
    issuerSnapshot,
    contactId: params.contactId,
    issueDate: params.issueDate,
    expectedDate: params.expectedDate,
    campaignId: params.campaignId || undefined,
    campaignRef: params.campaignRef.trim(),
    campaignStartDate: params.campaignStartDate || undefined,
    campaignEndDate: params.campaignEndDate || undefined,
    showCampaignOnPrint: params.showCampaignOnPrint ?? true,
    currency: params.currency || 'DZD',
    exchangeRate: params.exchangeRate > 0 ? params.exchangeRate : 1,
    description: params.description.trim(),
    lines: computed.lines,
    totalHtCentimes: computed.totalHtCentimes,
    totalTvaCentimes: computed.totalTvaCentimes,
    totalTtcCentimes: computed.totalTtcCentimes,
    baseDzdTtcCentimes: convertToBaseDzd(
      computed.totalTtcCentimes,
      params.exchangeRate > 0 ? params.exchangeRate : 1
    ),
    status: params.status || existing?.status || defaultStatus,
    linkedInvoiceIds: existing?.linkedInvoiceIds || [],
    linkedProformaIds: existing?.linkedProformaIds || [],
    convertedExpenseId: existing?.convertedExpenseId,
    attachmentsCount,
    amountInWordsOverride: params.amountInWordsOverride?.trim() || undefined,
    delivery: params.delivery?.trim() || existing?.delivery || undefined,
    paymentTerms: params.paymentTerms?.trim() || existing?.paymentTerms || undefined,
    tags: resolvedTags,
    isImported: params.isImported ?? existing?.isImported,
    importedFromFile: params.importedFromFile ?? existing?.importedFromFile,
    unpriced: params.unpriced ?? existing?.unpriced,
    notes: params.notes.trim(),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };

  await db.purchaseOrders.put(record);
  await recordAudit({
    action: existing ? 'MODIFICATION' : 'CREATION',
    entityType: params.direction,
    entityId: record.id,
    summary: `${existing ? 'Modification' : 'Création'} ${
      params.direction === 'bc_recu' ? 'BC reçu' : 'BC émis'
    } ${record.poNumber}`,
    before: existing,
    after: record,
  });

  return record;
}

export async function addAttachmentToPurchaseOrder(params: {
  parentId: string;
  parentType: 'bc_recu' | 'bc_emis';
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  dataUrl: string;
}): Promise<DocumentAttachment> {
  const doc: DocumentAttachment = {
    id: createId('att'),
    parentType: params.parentType,
    parentId: params.parentId,
    fileName: params.fileName,
    mimeType: params.mimeType,
    sizeBytes: params.sizeBytes,
    dataUrl: params.dataUrl,
    createdAt: new Date().toISOString(),
  };
  await db.documentAttachments.put(doc);
  const count = await db.documentAttachments.where('parentId').equals(params.parentId).count();
  await db.purchaseOrders.update(params.parentId, { attachmentsCount: count });
  return doc;
}

export async function replaceAttachmentFile(params: {
  attachmentId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  dataUrl: string;
}): Promise<void> {
  await db.documentAttachments.update(params.attachmentId, {
    fileName: params.fileName,
    mimeType: params.mimeType,
    sizeBytes: params.sizeBytes,
    dataUrl: params.dataUrl,
  });
}

export async function removeAttachment(attachmentId: string): Promise<void> {
  const att = await db.documentAttachments.get(attachmentId);
  if (!att) return;
  await db.documentAttachments.delete(attachmentId);
  const count = await db.documentAttachments.where('parentId').equals(att.parentId).count();
  await db.purchaseOrders.update(att.parentId, { attachmentsCount: count });
}

export async function syncBcRecuInvoicingStatus(bcRecuId?: string): Promise<void> {
  if (!bcRecuId) return;
  const bc = await db.purchaseOrders.get(bcRecuId);
  if (!bc || bc.deletedAt || bc.direction !== 'bc_recu') return;

  const linkedInvoices = await db.customerInvoices
    .where('linkedBcRecuId')
    .equals(bcRecuId)
    .toArray();
  const nextStatus = computeBcRecuInvoicingStatus({ bc, linkedInvoices });
  const linkedIds = linkedInvoices.filter((i) => !i.deletedAt).map((i) => i.id);
  await db.purchaseOrders.update(bcRecuId, {
    status: nextStatus,
    linkedInvoiceIds: linkedIds,
    updatedAt: new Date().toISOString(),
  });
}

// ============================================================================
// PROFORMAS
// ============================================================================

export async function generateNextProformaNumber(
  year = new Date().getFullYear(),
  companyProfileId?: string
): Promise<string> {
  const existing = await db.proformas.toArray();
  return computeNextSequenceNumber({
    kind: 'proforma',
    existingNumbers: existing.map((p) => ({
      number: p.proformaNumber,
      date: p.issueDate,
      companyProfileId: p.companyProfileId,
    })),
    yearFull: year,
    companyProfileId,
  });
}

export async function saveProforma(params: {
  existingId?: string;
  proformaNumber: string;
  companyProfileId?: string;
  clientId: string;
  clientSnapshot?: ClientFiscalSnapshot;
  updateContactFiscal?: boolean;
  issueDate: string;
  validityDays: number;
  validUntil: string;
  paymentConditions: string;
  deliveryDelay: string;
  bcNumber: string;
  linkedBcRecuId?: string;
  campaignId?: string;
  campaignRef: string;
  campaignStartDate?: string;
  campaignEndDate?: string;
  showCampaignOnPrint?: boolean;
  currency: string;
  exchangeRate: number;
  description: string;
  amountInWordsOverride?: string;
  notes: string;
  status?: ProformaStatus;
  lines: Array<
    Partial<InvoiceLine> & {
      description: string;
      quantity: number;
      unitPriceCentimes: number;
      discountPercent: number;
      tvaRate: number;
    }
  >;
}): Promise<Proforma> {
  if (!params.proformaNumber.trim()) {
    throw new Error('Le numéro de proforma est obligatoire.');
  }
  if (!params.clientId) {
    throw new Error('Veuillez sélectionner un client.');
  }
  if (!params.issueDate) {
    throw new Error('La date du proforma est obligatoire.');
  }
  if (params.campaignStartDate && params.campaignEndDate) {
    const dur = computeCampaignDuration(params.campaignStartDate, params.campaignEndDate);
    if (!dur.valid) throw new Error(dur.label);
  }
  if (!params.lines.length || params.lines.every((l) => !l.description.trim())) {
    throw new Error('Veuillez saisir au moins une ligne.');
  }

  const normalizedNumber = params.proformaNumber.trim();
  const existing = params.existingId ? await db.proformas.get(params.existingId) : undefined;
  const dup = await db.proformas
    .filter(
      (p) =>
        !p.deletedAt &&
        p.proformaNumber === normalizedNumber &&
        (!params.companyProfileId || !p.companyProfileId || p.companyProfileId === params.companyProfileId)
    )
    .first();
  if (dup && dup.id !== existing?.id) {
    throw new Error(`Le numéro de proforma « ${normalizedNumber} » existe déjà.`);
  }

  const computed = computeInvoiceDocumentTotals(params.lines);
  if (computed.totalTtcCentimes <= 0) {
    throw new Error('Le montant total TTC doit être supérieur à zéro.');
  }

  const now = new Date().toISOString();
  const rate = params.exchangeRate > 0 ? params.exchangeRate : 1;

  const selectedProfile = params.companyProfileId
    ? await db.companyProfiles.get(params.companyProfileId)
    : undefined;
  const issuerSnapshot =
    selectedProfile &&
    (!existing?.issuerSnapshot || existing.companyProfileId !== params.companyProfileId)
      ? buildIssuerSnapshot(selectedProfile)
      : existing?.issuerSnapshot || buildIssuerSnapshot(selectedProfile);

  const record: Proforma = {
    id: existing?.id || createId('pf'),
    proformaNumber: normalizedNumber,
    companyProfileId: params.companyProfileId,
    issuerSnapshot,
    clientId: params.clientId,
    clientSnapshot: params.clientSnapshot,
    issueDate: params.issueDate,
    validityDays: params.validityDays || 30,
    validUntil: params.validUntil || params.issueDate,
    paymentConditions: params.paymentConditions.trim(),
    deliveryDelay: params.deliveryDelay.trim(),
    bcNumber: params.bcNumber.trim(),
    linkedBcRecuId: params.linkedBcRecuId || undefined,
    campaignId: params.campaignId || undefined,
    campaignRef: params.campaignRef.trim(),
    campaignStartDate: params.campaignStartDate || undefined,
    campaignEndDate: params.campaignEndDate || undefined,
    showCampaignOnPrint: params.showCampaignOnPrint ?? true,
    currency: params.currency || 'DZD',
    exchangeRate: rate,
    description: params.description.trim(),
    lines: computed.lines,
    totalHtCentimes: computed.totalHtCentimes,
    totalTvaCentimes: computed.totalTvaCentimes,
    totalTtcCentimes: computed.totalTtcCentimes,
    baseDzdTtcCentimes: convertToBaseDzd(computed.totalTtcCentimes, rate),
    status: params.status || existing?.status || 'brouillon',
    convertedInvoiceId: existing?.convertedInvoiceId,
    amountInWordsOverride: params.amountInWordsOverride?.trim() || undefined,
    notes: params.notes.trim(),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };

  await db.proformas.put(record);

  if (params.updateContactFiscal && params.clientSnapshot) {
    await db.contacts.update(params.clientId, {
      address: params.clientSnapshot.address,
      phone: params.clientSnapshot.phone || '',
      email: params.clientSnapshot.email || '',
      nif: params.clientSnapshot.nif || '',
      nis: params.clientSnapshot.nis || '',
      rc: params.clientSnapshot.rc || '',
      ai: params.clientSnapshot.ai || '',
      updatedAt: now,
    });
  }

  if (record.linkedBcRecuId) {
    const bc = await db.purchaseOrders.get(record.linkedBcRecuId);
    if (bc && !bc.deletedAt) {
      const pfIds = Array.from(new Set([...(bc.linkedProformaIds || []), record.id]));
      await db.purchaseOrders.update(bc.id, { linkedProformaIds: pfIds, updatedAt: now });
    }
  }

  await recordAudit({
    action: existing ? 'MODIFICATION' : 'CREATION',
    entityType: 'proforma',
    entityId: record.id,
    summary: `${existing ? 'Modification' : 'Création'} proforma ${record.proformaNumber}`,
    before: existing,
    after: record,
  });

  return record;
}

export async function convertProformaToInvoice(proformaId: string): Promise<CustomerInvoice> {
  const pf = await db.proformas.get(proformaId);
  if (!pf || pf.deletedAt) throw new Error('Proforma introuvable.');
  if (pf.convertedInvoiceId) {
    const existingInv = await db.customerInvoices.get(pf.convertedInvoiceId);
    if (existingInv && !existingInv.deletedAt) {
      throw new Error(`Ce proforma a déjà été transformé en facture (${existingInv.invoiceNumber}).`);
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const dueDate = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const year = new Date().getFullYear();
  const invoiceNumber = await generateNextInvoiceNumber('client', year, pf.companyProfileId);

  const invoice = await saveCustomerInvoice({
    invoiceNumber,
    companyProfileId: pf.companyProfileId,
    clientId: pf.clientId,
    clientSnapshot: pf.clientSnapshot,
    issueDate: today,
    dueDate,
    bcNumber: pf.bcNumber,
    linkedBcRecuId: pf.linkedBcRecuId,
    proformaId: pf.id,
    campaignId: pf.campaignId,
    campaignRef: pf.campaignRef,
    campaignStartDate: pf.campaignStartDate,
    campaignEndDate: pf.campaignEndDate,
    showCampaignOnPrint: pf.showCampaignOnPrint,
    currency: pf.currency,
    exchangeRate: pf.exchangeRate,
    description: pf.description,
    amountInWordsOverride: pf.amountInWordsOverride,
    notes: pf.notes,
    lines: pf.lines.map((l) => ({
      ...l,
      id: createId('line'),
    })),
  });

  await db.proformas.update(pf.id, {
    status: 'facture',
    convertedInvoiceId: invoice.id,
    updatedAt: new Date().toISOString(),
  });

  await recordAudit({
    action: 'CREATION',
    entityType: 'proforma_conversion',
    entityId: pf.id,
    summary: `Transformation du proforma ${pf.proformaNumber} en facture ${invoice.invoiceNumber}`,
    after: { proformaId: pf.id, invoiceId: invoice.id },
  });

  return invoice;
}
