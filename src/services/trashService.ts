import { db, recordAudit } from '../db/database';

export type TrashEntityType =
  | 'contact'
  | 'customerInvoice'
  | 'supplierInvoice'
  | 'proforma'
  | 'purchaseOrder'
  | 'campaign'
  | 'expense'
  | 'payment'
  | 'incomingCheque'
  | 'outgoingCheque'
  | 'chequeBook'
  | 'bankAccount'
  | 'companyProfile';

export interface LinkedCheckResult {
  hasLinks: boolean;
  warnings: string[];
  hasInvoicePayments?: boolean;
  invoicePaymentsCount?: number;
}

export interface TrashItemSummary {
  id: string;
  entityType: TrashEntityType;
  typeLabel: string;
  title: string;
  subtitle: string;
  deletedAt: string;
}

export async function inspectLinksBeforeDelete(
  entityType: TrashEntityType,
  id: string
): Promise<LinkedCheckResult> {
  const warnings: string[] = [];

  if (entityType === 'contact') {
    const [cinvs, sinvs, proformas, pos, camps, pays] = await Promise.all([
      db.customerInvoices.where('clientId').equals(id).filter((x) => !x.deletedAt).count(),
      db.supplierInvoices.where('supplierId').equals(id).filter((x) => !x.deletedAt).count(),
      db.proformas.where('clientId').equals(id).filter((x) => !x.deletedAt).count(),
      db.purchaseOrders.where('contactId').equals(id).filter((x) => !x.deletedAt).count(),
      db.campaigns.where('clientId').equals(id).filter((x) => !x.deletedAt).count(),
      db.payments.where('contactId').equals(id).filter((x) => !x.deletedAt).count(),
    ]);
    if (cinvs > 0) warnings.push(`${cinvs} facture(s) client`);
    if (sinvs > 0) warnings.push(`${sinvs} facture(s) fournisseur`);
    if (proformas > 0) warnings.push(`${proformas} proforma(s)`);
    if (pos > 0) warnings.push(`${pos} bon(s) de commande`);
    if (camps > 0) warnings.push(`${camps} campagne(s)`);
    if (pays > 0) warnings.push(`${pays} paiement(s)`);
  } else if (entityType === 'customerInvoice') {
    const allocs = await db.paymentAllocations.where('invoiceId').equals(id).toArray();
    const payments = allocs.length ? await db.payments.toArray() : [];
    const validIds = new Set(payments.filter((p) => p.status === 'valide' && !p.deletedAt).map((p) => p.id));
    const activeAllocs = allocs.filter((a) => validIds.has(a.paymentId));
    const linkedCheques = await db.incomingCheques
      .filter((c) => !c.deletedAt && c.allocatedInvoiceIds.includes(id))
      .count();
    if (activeAllocs.length > 0) {
      warnings.push(`${activeAllocs.length} règlement(s) affecté(s) à cette facture`);
    }
    if (linkedCheques > 0) {
      warnings.push(`${linkedCheques} chèque(s) reçu(s) mentionnant cette facture`);
    }
    return {
      hasLinks: warnings.length > 0,
      warnings,
      hasInvoicePayments: activeAllocs.length > 0,
      invoicePaymentsCount: activeAllocs.length,
    };
  } else if (entityType === 'supplierInvoice') {
    const allocs = await db.paymentAllocations.where('invoiceId').equals(id).count();
    if (allocs > 0) warnings.push(`${allocs} règlement(s) affecté(s)`);
  } else if (entityType === 'proforma') {
    const pf = await db.proformas.get(id);
    if (pf?.convertedInvoiceId) warnings.push('Une facture client issue de ce proforma');
  } else if (entityType === 'purchaseOrder') {
    const [cinvs, pfs, atts] = await Promise.all([
      db.customerInvoices.where('linkedBcRecuId').equals(id).filter((x) => !x.deletedAt).count(),
      db.proformas.where('linkedBcRecuId').equals(id).filter((x) => !x.deletedAt).count(),
      db.documentAttachments.where('parentId').equals(id).count(),
    ]);
    if (cinvs > 0) warnings.push(`${cinvs} facture(s) liée(s)`);
    if (pfs > 0) warnings.push(`${pfs} proforma(s) lié(s)`);
    if (atts > 0) warnings.push(`${atts} document(s) joint(s)`);
  } else if (entityType === 'campaign') {
    const [cinvs, pfs, pos] = await Promise.all([
      db.customerInvoices.where('campaignId').equals(id).filter((x) => !x.deletedAt).count(),
      db.proformas.where('campaignId').equals(id).filter((x) => !x.deletedAt).count(),
      db.purchaseOrders.where('campaignId').equals(id).filter((x) => !x.deletedAt).count(),
    ]);
    if (cinvs > 0) warnings.push(`${cinvs} facture(s)`);
    if (pfs > 0) warnings.push(`${pfs} proforma(s)`);
    if (pos > 0) warnings.push(`${pos} bon(s) de commande`);
  } else if (entityType === 'bankAccount') {
    const [inChq, outChq, books, leds] = await Promise.all([
      db.incomingCheques.where('targetBankAccountId').equals(id).filter((x) => !x.deletedAt).count(),
      db.outgoingCheques.where('bankAccountId').equals(id).filter((x) => !x.deletedAt).count(),
      db.chequeBooks.where('bankAccountId').equals(id).filter((x) => !x.deletedAt).count(),
      db.ledgerEntries.where('bankAccountId').equals(id).filter((x) => x.status === 'valide').count(),
    ]);
    if (inChq > 0) warnings.push(`${inChq} chèque(s) reçu(s)`);
    if (outChq > 0) warnings.push(`${outChq} chèque(s) émis`);
    if (books > 0) warnings.push(`${books} chéquier(s)`);
    if (leds > 0) warnings.push(`${leds} écriture(s) de trésorerie`);
  }

  return { hasLinks: warnings.length > 0, warnings };
}

export async function softDeleteEntity(params: {
  entityType: TrashEntityType;
  id: string;
  keepPaymentsAsAdvance?: boolean;
}): Promise<{ label: string }> {
  const now = new Date().toISOString();
  let label = 'Élément';

  switch (params.entityType) {
    case 'contact': {
      const c = await db.contacts.get(params.id);
      if (!c) throw new Error('Contact introuvable.');
      label = c.company || c.name;
      await db.contacts.update(params.id, { deletedAt: now, updatedAt: now });
      break;
    }
    case 'customerInvoice': {
      const inv = await db.customerInvoices.get(params.id);
      if (!inv) throw new Error('Facture introuvable.');
      label = `Facture ${inv.invoiceNumber}`;
      await db.transaction(
        'rw',
        [db.customerInvoices, db.paymentAllocations, db.payments, db.ledgerEntries],
        async () => {
          await db.customerInvoices.update(params.id, { deletedAt: now, updatedAt: now });
          const allocs = await db.paymentAllocations.where('invoiceId').equals(params.id).toArray();
          if (allocs.length > 0) {
            if (params.keepPaymentsAsAdvance !== false) {
              for (const a of allocs) {
                await db.paymentAllocations.delete(a.id);
                await db.payments.update(a.paymentId, { isAdvance: true, updatedAt: now });
              }
            } else {
              for (const a of allocs) {
                await db.paymentAllocations.update(a.id, {
                  deletedInvoiceLabel: 'Facture supprimée',
                });
              }
            }
          }
        }
      );
      break;
    }
    case 'supplierInvoice': {
      const inv = await db.supplierInvoices.get(params.id);
      if (!inv) throw new Error('Facture fournisseur introuvable.');
      label = `Facture fournisseur ${inv.invoiceNumber}`;
      await db.supplierInvoices.update(params.id, { deletedAt: now, updatedAt: now });
      const allocs = await db.paymentAllocations.where('invoiceId').equals(params.id).toArray();
      for (const a of allocs) {
        await db.paymentAllocations.update(a.id, { deletedInvoiceLabel: 'Facture supprimée' });
      }
      break;
    }
    case 'proforma': {
      const pf = await db.proformas.get(params.id);
      if (!pf) throw new Error('Proforma introuvable.');
      label = `Proforma ${pf.proformaNumber}`;
      await db.proformas.update(params.id, { deletedAt: now, updatedAt: now });
      break;
    }
    case 'purchaseOrder': {
      const po = await db.purchaseOrders.get(params.id);
      if (!po) throw new Error('Bon de commande introuvable.');
      label = `BC ${po.poNumber}`;
      await db.purchaseOrders.update(params.id, { deletedAt: now, updatedAt: now });
      break;
    }
    case 'campaign': {
      const camp = await db.campaigns.get(params.id);
      if (!camp) throw new Error('Campagne introuvable.');
      label = `Campagne ${camp.name}`;
      await db.campaigns.update(params.id, { deletedAt: now, updatedAt: now });
      break;
    }
    case 'expense': {
      const exp = await db.expenses.get(params.id);
      if (!exp) throw new Error('Dépense introuvable.');
      label = `Dépense ${exp.beneficiary}`;
      await db.transaction('rw', [db.expenses, db.ledgerEntries], async () => {
        await db.expenses.update(params.id, { deletedAt: now, updatedAt: now });
        const leds = await db.ledgerEntries.where('sourceId').equals(params.id).toArray();
        for (const l of leds) {
          await db.ledgerEntries.update(l.id, { status: 'annule' });
        }
      });
      break;
    }
    case 'payment': {
      const pay = await db.payments.get(params.id);
      if (!pay) throw new Error('Paiement introuvable.');
      label = `Paiement ${pay.reference || pay.date}`;
      await db.transaction('rw', [db.payments, db.ledgerEntries], async () => {
        await db.payments.update(params.id, { deletedAt: now, updatedAt: now });
        const leds = await db.ledgerEntries.where('sourceId').equals(params.id).toArray();
        for (const l of leds) {
          await db.ledgerEntries.update(l.id, { status: 'annule' });
        }
      });
      break;
    }
    case 'incomingCheque': {
      const c = await db.incomingCheques.get(params.id);
      if (!c) throw new Error('Chèque reçu introuvable.');
      label = `Chèque reçu ${c.chequeNumber}`;
      await db.incomingCheques.update(params.id, { deletedAt: now, updatedAt: now });
      break;
    }
    case 'outgoingCheque': {
      const c = await db.outgoingCheques.get(params.id);
      if (!c) throw new Error('Chèque émis introuvable.');
      label = `Chèque émis ${c.chequeNumber}`;
      await db.outgoingCheques.update(params.id, { deletedAt: now, updatedAt: now });
      break;
    }
    case 'chequeBook': {
      const b = await db.chequeBooks.get(params.id);
      if (!b) throw new Error('Chéquier introuvable.');
      label = `Chéquier ${b.startSerial}`;
      await db.chequeBooks.update(params.id, { deletedAt: now });
      break;
    }
    case 'bankAccount': {
      const b = await db.bankAccounts.get(params.id);
      if (!b) throw new Error('Compte bancaire introuvable.');
      label = `${b.bankName} — ${b.accountName}`;
      await db.bankAccounts.update(params.id, { deletedAt: now, active: false, updatedAt: now });
      break;
    }
    case 'companyProfile': {
      const p = await db.companyProfiles.get(params.id);
      if (!p) throw new Error('Société introuvable.');
      label = p.name;
      await db.companyProfiles.update(params.id, { deletedAt: now, updatedAt: now });
      break;
    }
  }

  await recordAudit({
    action: 'SUPPRESSION',
    entityType: params.entityType,
    entityId: params.id,
    summary: `Mise en corbeille : ${label}`,
  });

  return { label };
}

export async function restoreFromTrash(
  entityType: TrashEntityType,
  id: string
): Promise<void> {
  const now = new Date().toISOString();
  switch (entityType) {
    case 'contact':
      await db.contacts.update(id, { deletedAt: undefined, updatedAt: now });
      break;
    case 'customerInvoice':
      await db.customerInvoices.update(id, { deletedAt: undefined, updatedAt: now });
      break;
    case 'supplierInvoice':
      await db.supplierInvoices.update(id, { deletedAt: undefined, updatedAt: now });
      break;
    case 'proforma':
      await db.proformas.update(id, { deletedAt: undefined, updatedAt: now });
      break;
    case 'purchaseOrder':
      await db.purchaseOrders.update(id, { deletedAt: undefined, updatedAt: now });
      break;
    case 'campaign':
      await db.campaigns.update(id, { deletedAt: undefined, updatedAt: now });
      break;
    case 'expense': {
      const exp = await db.expenses.get(id);
      await db.expenses.update(id, { deletedAt: undefined, updatedAt: now });
      if (exp && exp.status === 'valide') {
        const leds = await db.ledgerEntries.where('sourceId').equals(id).toArray();
        for (const l of leds) await db.ledgerEntries.update(l.id, { status: 'valide' });
      }
      break;
    }
    case 'payment': {
      const pay = await db.payments.get(id);
      const shouldRevalidate = Boolean(pay && pay.deletedAt && pay.status === 'annule');
      await db.payments.update(id, {
        deletedAt: undefined,
        ...(shouldRevalidate
          ? { status: 'valide', cancelReason: undefined, cancelledAt: undefined }
          : {}),
        updatedAt: now,
      });
      if (pay && (pay.status === 'valide' || shouldRevalidate)) {
        const leds = await db.ledgerEntries.where('sourceId').equals(id).toArray();
        for (const l of leds) await db.ledgerEntries.update(l.id, { status: 'valide' });
        if (pay.chequeId) {
          const chqLeds = await db.ledgerEntries.where('sourceId').equals(pay.chequeId).toArray();
          for (const l of chqLeds) await db.ledgerEntries.update(l.id, { status: 'valide' });
        }
        const allocs = await db.paymentAllocations.where('paymentId').equals(id).toArray();
        const { refreshInvoiceStoredStatus } = await import('./financeActions');
        for (const a of allocs) {
          await refreshInvoiceStoredStatus(a.invoiceType, a.invoiceId);
        }
      }
      break;
    }
    case 'incomingCheque':
      await db.incomingCheques.update(id, { deletedAt: undefined, updatedAt: now });
      break;
    case 'outgoingCheque':
      await db.outgoingCheques.update(id, { deletedAt: undefined, updatedAt: now });
      break;
    case 'chequeBook':
      await db.chequeBooks.update(id, { deletedAt: undefined });
      break;
    case 'bankAccount':
      await db.bankAccounts.update(id, { deletedAt: undefined, active: true, updatedAt: now });
      break;
    case 'companyProfile':
      await db.companyProfiles.update(id, { deletedAt: undefined, updatedAt: now });
      break;
  }

  await recordAudit({
    action: 'RESTAURATION',
    entityType,
    entityId: id,
    summary: `Restauration depuis la corbeille (${entityType})`,
  });
}

export async function permanentlyDeleteFromTrash(
  entityType: TrashEntityType,
  id: string
): Promise<void> {
  switch (entityType) {
    case 'contact':
      await db.contacts.delete(id);
      break;
    case 'customerInvoice':
      await db.customerInvoices.delete(id);
      break;
    case 'supplierInvoice':
      await db.supplierInvoices.delete(id);
      break;
    case 'proforma':
      await db.proformas.delete(id);
      break;
    case 'purchaseOrder':
      await db.documentAttachments.where('parentId').equals(id).delete();
      await db.purchaseOrders.delete(id);
      break;
    case 'campaign':
      await db.campaigns.delete(id);
      break;
    case 'expense':
      await db.expenses.delete(id);
      break;
    case 'payment':
      await db.paymentAllocations.where('paymentId').equals(id).delete();
      await db.payments.delete(id);
      break;
    case 'incomingCheque':
      await db.incomingCheques.delete(id);
      break;
    case 'outgoingCheque':
      await db.outgoingCheques.delete(id);
      break;
    case 'chequeBook':
      await db.chequeBooks.delete(id);
      break;
    case 'bankAccount':
      await db.bankAccounts.delete(id);
      break;
    case 'companyProfile':
      await db.companyProfiles.delete(id);
      break;
  }

  await recordAudit({
    action: 'SUPPRESSION',
    entityType,
    entityId: id,
    summary: `Suppression définitive depuis la corbeille (${entityType})`,
  });
}

export async function listAllTrashItems(): Promise<TrashItemSummary[]> {
  const [
    contacts,
    cinvs,
    sinvs,
    pfs,
    pos,
    camps,
    exps,
    pays,
    ichqs,
    ochqs,
    books,
    banks,
    profiles,
  ] = await Promise.all([
    db.contacts.filter((x) => Boolean(x.deletedAt)).toArray(),
    db.customerInvoices.filter((x) => Boolean(x.deletedAt)).toArray(),
    db.supplierInvoices.filter((x) => Boolean(x.deletedAt)).toArray(),
    db.proformas.filter((x) => Boolean(x.deletedAt)).toArray(),
    db.purchaseOrders.filter((x) => Boolean(x.deletedAt)).toArray(),
    db.campaigns.filter((x) => Boolean(x.deletedAt)).toArray(),
    db.expenses.filter((x) => Boolean(x.deletedAt)).toArray(),
    db.payments.filter((x) => Boolean(x.deletedAt)).toArray(),
    db.incomingCheques.filter((x) => Boolean(x.deletedAt)).toArray(),
    db.outgoingCheques.filter((x) => Boolean(x.deletedAt)).toArray(),
    db.chequeBooks.filter((x) => Boolean(x.deletedAt)).toArray(),
    db.bankAccounts.filter((x) => Boolean(x.deletedAt)).toArray(),
    db.companyProfiles.filter((x) => Boolean(x.deletedAt)).toArray(),
  ]);

  const items: TrashItemSummary[] = [
    ...contacts.map((c) => ({
      id: c.id,
      entityType: 'contact' as const,
      typeLabel: c.type === 'fournisseur' ? 'Fournisseur' : 'Client',
      title: c.company || c.name,
      subtitle: c.phone || c.email || 'Contact',
      deletedAt: c.deletedAt!,
    })),
    ...cinvs.map((i) => ({
      id: i.id,
      entityType: 'customerInvoice' as const,
      typeLabel: 'Facture client',
      title: `Facture ${i.invoiceNumber}`,
      subtitle: i.issueDate,
      deletedAt: i.deletedAt!,
    })),
    ...sinvs.map((i) => ({
      id: i.id,
      entityType: 'supplierInvoice' as const,
      typeLabel: 'Facture fournisseur',
      title: `Facture ${i.invoiceNumber}`,
      subtitle: i.issueDate,
      deletedAt: i.deletedAt!,
    })),
    ...pfs.map((p) => ({
      id: p.id,
      entityType: 'proforma' as const,
      typeLabel: 'Proforma',
      title: p.proformaNumber,
      subtitle: p.issueDate,
      deletedAt: p.deletedAt!,
    })),
    ...pos.map((po) => ({
      id: po.id,
      entityType: 'purchaseOrder' as const,
      typeLabel: po.direction === 'bc_recu' ? 'BC reçu' : 'BC émis',
      title: po.poNumber,
      subtitle: po.issueDate,
      deletedAt: po.deletedAt!,
    })),
    ...camps.map((c) => ({
      id: c.id,
      entityType: 'campaign' as const,
      typeLabel: 'Campagne',
      title: c.name,
      subtitle: `${c.startDate} → ${c.endDate}`,
      deletedAt: c.deletedAt!,
    })),
    ...exps.map((e) => ({
      id: e.id,
      entityType: 'expense' as const,
      typeLabel: 'Dépense',
      title: e.beneficiary,
      subtitle: `${e.date} · ${e.description}`,
      deletedAt: e.deletedAt!,
    })),
    ...pays.map((p) => ({
      id: p.id,
      entityType: 'payment' as const,
      typeLabel: 'Paiement',
      title: p.reference || p.method,
      subtitle: p.date,
      deletedAt: p.deletedAt!,
    })),
    ...ichqs.map((c) => ({
      id: c.id,
      entityType: 'incomingCheque' as const,
      typeLabel: 'Chèque reçu',
      title: `Chèque N° ${c.chequeNumber}`,
      subtitle: c.entryDate,
      deletedAt: c.deletedAt!,
    })),
    ...ochqs.map((c) => ({
      id: c.id,
      entityType: 'outgoingCheque' as const,
      typeLabel: 'Chèque émis',
      title: `Chèque N° ${c.chequeNumber}`,
      subtitle: c.beneficiary,
      deletedAt: c.deletedAt!,
    })),
    ...books.map((b) => ({
      id: b.id,
      entityType: 'chequeBook' as const,
      typeLabel: 'Chéquier',
      title: `Carnet ${b.startSerial}`,
      subtitle: `${b.count} feuillets`,
      deletedAt: b.deletedAt!,
    })),
    ...banks.map((b) => ({
      id: b.id,
      entityType: 'bankAccount' as const,
      typeLabel: 'Banque',
      title: `${b.bankName} — ${b.accountName}`,
      subtitle: b.currency,
      deletedAt: b.deletedAt!,
    })),
    ...profiles.map((p) => ({
      id: p.id,
      entityType: 'companyProfile' as const,
      typeLabel: 'Profil société',
      title: p.name,
      subtitle: p.nif || p.rc || 'Société',
      deletedAt: p.deletedAt!,
    })),
  ];

  return items.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}
