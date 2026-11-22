import { createId, db, recordAudit } from '../db/database';
import type {
  BankAccount,
  ChequeBook,
  ChequeLeaf,
  CustomerInvoice,
  IncomingCheque,
  IncomingChequeStatus,
  LedgerEntry,
  OutgoingCheque,
  OutgoingChequeStatus,
  Payment,
  PaymentAllocation,
  SupplierInvoice,
} from '../db/types';
import { findDuplicateChequeNumbers, generateChequeSerialSequence } from '../utils/cheque';
import { formatDateFr } from '../utils/documentHelpers';
import {
  computeInvoicePaidCentimes,
  computeInvoiceRemainingCentimes,
  computeInvoiceStatus,
} from '../utils/finance';
import { convertToBaseDzd } from '../utils/money';
import { allocateExistingAdvanceToInvoices, refreshInvoiceStoredStatus } from './financeActions';

export async function saveBankAccount(params: {
  existingId?: string;
  bankName: string;
  accountName: string;
  accountNumber: string;
  rib: string;
  currency: string;
  openingBalanceCentimes: number;
  openingDate: string;
  notes: string;
  exchangeRateToDzd: number;
}): Promise<BankAccount> {
  if (!params.bankName.trim()) {
    throw new Error('Le nom de la banque est obligatoire.');
  }
  if (!params.accountName.trim()) {
    throw new Error('L’intitulé du compte est obligatoire.');
  }
  if (!params.openingDate) {
    throw new Error('La date d’ouverture est obligatoire.');
  }

  const now = new Date().toISOString();
  const existing = params.existingId ? await db.bankAccounts.get(params.existingId) : undefined;
  const bankId = existing?.id || createId('bank');

  const record: BankAccount = {
    id: bankId,
    bankName: params.bankName.trim(),
    accountName: params.accountName.trim(),
    accountNumber: params.accountNumber.trim(),
    rib: params.rib.trim(),
    currency: params.currency || 'DZD',
    openingBalanceCentimes: Math.round(params.openingBalanceCentimes),
    openingDate: params.openingDate,
    notes: params.notes.trim(),
    active: existing?.active ?? true,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };

  await db.transaction('rw', [db.bankAccounts, db.ledgerEntries], async () => {
    await db.bankAccounts.put(record);

    const existingOpening = await db.ledgerEntries
      .where('sourceId')
      .equals(bankId)
      .filter((e) => e.sourceType === 'solde_ouverture')
      .first();

    if (record.openingBalanceCentimes !== 0) {
      const rate = record.currency === 'DZD' ? 1 : Math.max(0.0001, params.exchangeRateToDzd || 1);
      const absBal = Math.abs(record.openingBalanceCentimes);
      const entry: LedgerEntry = {
        id: existingOpening?.id || createId('led'),
        date: record.openingDate,
        direction: record.openingBalanceCentimes >= 0 ? 'entree' : 'sortie',
        sourceType: 'solde_ouverture',
        sourceId: bankId,
        bankAccountId: bankId,
        label: `Solde d’ouverture ${record.bankName} — ${record.accountName}`,
        amountCentimes: absBal,
        currency: record.currency,
        exchangeRate: rate,
        baseDzdAmountCentimes: convertToBaseDzd(absBal, rate),
        status: 'valide',
        createdAt: existingOpening?.createdAt || now,
      };
      await db.ledgerEntries.put(entry);
    } else if (existingOpening) {
      await db.ledgerEntries.update(existingOpening.id, { status: 'annule' });
    }
  });

  await recordAudit({
    action: existing ? 'MODIFICATION' : 'CREATION',
    entityType: 'compte_bancaire',
    entityId: bankId,
    summary: `${existing ? 'Modification' : 'Création'} compte ${record.bankName} — ${record.accountName}`,
    before: existing,
    after: record,
  });

  return record;
}

export async function createChequeBook(params: {
  bankAccountId: string;
  startSerial: string;
  count: number;
  notes: string;
}): Promise<{ book: ChequeBook; leaves: ChequeLeaf[] }> {
  if (!params.bankAccountId) {
    throw new Error('Veuillez sélectionner un compte bancaire.');
  }

  const serials = generateChequeSerialSequence(params.startSerial, params.count);

  // Vérification stricte d'unicité sur la banque : aucun numéro existant (même annulé/rejeté) ne peut être réutilisé
  const existingLeaves = await db.chequeLeaves
    .where('bankAccountId')
    .equals(params.bankAccountId)
    .toArray();
  const existingOutgoing = await db.outgoingCheques
    .where('bankAccountId')
    .equals(params.bankAccountId)
    .toArray();

  const usedNumbers = new Set<string>([
    ...existingLeaves.map((l) => l.chequeNumber),
    ...existingOutgoing.map((o) => o.chequeNumber),
  ]);

  const duplicates = findDuplicateChequeNumbers(usedNumbers, serials);
  if (duplicates.length > 0) {
    throw new Error(
      `Numéro(s) de chèque déjà existant(s) pour cette banque (jamais réutilisables, même après annulation) : ${duplicates
        .slice(0, 5)
        .join(', ')}${duplicates.length > 5 ? '...' : ''}`
    );
  }

  const now = new Date().toISOString();
  const bookId = createId('book');
  const book: ChequeBook = {
    id: bookId,
    bankAccountId: params.bankAccountId,
    startSerial: params.startSerial.trim(),
    count: params.count,
    notes: params.notes.trim(),
    createdAt: now,
  };

  const leaves: ChequeLeaf[] = serials.map((num) => ({
    id: createId('leaf'),
    chequeBookId: bookId,
    bankAccountId: params.bankAccountId,
    chequeNumber: num,
    status: 'disponible',
    createdAt: now,
  }));

  await db.transaction('rw', [db.chequeBooks, db.chequeLeaves], async () => {
    await db.chequeBooks.put(book);
    await db.chequeLeaves.bulkPut(leaves);
  });

  const bank = await db.bankAccounts.get(params.bankAccountId);
  await recordAudit({
    action: 'CREATION',
    entityType: 'chequier',
    entityId: bookId,
    summary: `Création chéquier ${bank?.bankName || ''} (${serials[0]} → ${serials[serials.length - 1]}, ${serials.length} chèques)`,
    after: book,
  });

  return { book, leaves };
}

export async function cancelUnusedChequeLeaf(leafId: string, reason: string): Promise<void> {
  if (!reason.trim()) throw new Error('Le motif d’annulation est obligatoire.');
  const leaf = await db.chequeLeaves.get(leafId);
  if (!leaf) throw new Error('Feuillet introuvable.');
  if (leaf.status !== 'disponible') {
    throw new Error('Seul un feuillet disponible non utilisé peut être annulé directement.');
  }

  await db.chequeLeaves.update(leafId, { status: 'annule' });
  await recordAudit({
    action: 'ANNULATION',
    entityType: 'feuillet_cheque',
    entityId: leafId,
    summary: `Annulation du feuillet N° ${leaf.chequeNumber} (numéro définitivement retiré)`,
    reason: reason.trim(),
  });
}

export async function createOutgoingCheque(params: {
  bankAccountId: string;
  chequeLeafId?: string;
  chequeNumber?: string;
  beneficiary: string;
  contactId?: string;
  issueDate: string;
  amountCentimes: number;
  currency: string;
  exchangeRate: number;
  purpose: string;
  linkedType: OutgoingCheque['linkedType'];
  linkedId?: string;
  initialStatus: 'prepare' | 'remis' | 'depose' | 'en_attente';
  notes: string;
}): Promise<OutgoingCheque> {
  if (!params.bankAccountId) throw new Error('Veuillez sélectionner la banque émettrice.');
  if (!params.beneficiary.trim()) throw new Error('Le nom du bénéficiaire est obligatoire.');
  if (!params.issueDate) throw new Error('La date de sortie est obligatoire.');
  if (params.amountCentimes <= 0) throw new Error('Le montant doit être supérieur à zéro.');
  if (!params.purpose.trim()) throw new Error('L’objet / motif du chèque est obligatoire.');

  let finalChequeNumber = (params.chequeNumber || '').trim();
  let chequeBookId = '';

  if (params.chequeLeafId) {
    const leaf = await db.chequeLeaves.get(params.chequeLeafId);
    if (!leaf || leaf.bankAccountId !== params.bankAccountId) {
      throw new Error('Feuillet de chèque introuvable pour cette banque.');
    }
    if (leaf.status !== 'disponible') {
      throw new Error(`Le chèque N° ${leaf.chequeNumber} n’est pas disponible (statut : ${leaf.status}).`);
    }
    finalChequeNumber = leaf.chequeNumber;
    chequeBookId = leaf.chequeBookId;
  } else {
    if (!finalChequeNumber) {
      throw new Error('Veuillez sélectionner un chèque dans le chéquier ou saisir son numéro.');
    }
    const dupLeaf = await db.chequeLeaves
      .where('[bankAccountId+chequeNumber]')
      .equals([params.bankAccountId, finalChequeNumber])
      .first();
    const dupOut = await db.outgoingCheques
      .where('bankAccountId')
      .equals(params.bankAccountId)
      .filter((c) => c.chequeNumber === finalChequeNumber)
      .first();
    if (dupLeaf || dupOut) {
      throw new Error(
        `Le chèque N° ${finalChequeNumber} existe déjà sur cette banque et ne peut jamais être réutilisé.`
      );
    }
  }

  const now = new Date().toISOString();
  const chequeId = createId('ochq');
  const baseDzdAmountCentimes = convertToBaseDzd(params.amountCentimes, params.exchangeRate);

  const record: OutgoingCheque = {
    id: chequeId,
    bankAccountId: params.bankAccountId,
    chequeBookId,
    chequeLeafId: params.chequeLeafId || '',
    chequeNumber: finalChequeNumber,
    beneficiary: params.beneficiary.trim(),
    contactId: params.contactId || undefined,
    issueDate: params.issueDate,
    amountCentimes: params.amountCentimes,
    currency: params.currency,
    exchangeRate: params.exchangeRate,
    baseDzdAmountCentimes,
    purpose: params.purpose.trim(),
    linkedType: params.linkedType,
    linkedId: params.linkedId || undefined,
    status: params.initialStatus,
    notes: params.notes.trim(),
    createdAt: now,
    updatedAt: now,
  };

  await db.transaction('rw', [db.outgoingCheques, db.chequeLeaves], async () => {
    await db.outgoingCheques.put(record);
    if (params.chequeLeafId) {
      await db.chequeLeaves.update(params.chequeLeafId, {
        status: params.initialStatus,
        outgoingChequeId: chequeId,
      });
    }
  });

  await recordAudit({
    action: 'CREATION',
    entityType: 'cheque_emis',
    entityId: chequeId,
    summary: `Émission chèque N° ${record.chequeNumber} pour ${record.beneficiary} (${record.purpose})`,
    after: record,
  });

  return record;
}

export async function updateOutgoingChequeStatus(params: {
  chequeId: string;
  nextStatus: OutgoingChequeStatus;
  clearingDate?: string;
  rejectionDate?: string;
  reason?: string;
}): Promise<void> {
  const cheque = await db.outgoingCheques.get(params.chequeId);
  if (!cheque) throw new Error('Chèque émis introuvable.');
  if (cheque.status === 'annule') {
    throw new Error('Un chèque annulé ne peut plus changer de statut et son numéro n’est jamais réutilisable.');
  }

  if ((params.nextStatus === 'annule' || params.nextStatus === 'rejete') && !params.reason?.trim()) {
    throw new Error('Un motif est obligatoire pour rejeter ou annuler un chèque.');
  }

  if (params.nextStatus === 'encaisse' && !params.clearingDate) {
    throw new Error('Veuillez saisir la date d’encaissement.');
  }

  const now = new Date().toISOString();
  const impactedSupplierInvoiceIds = new Set<string>();

  await db.transaction(
    'rw',
    [
      db.outgoingCheques,
      db.chequeLeaves,
      db.ledgerEntries,
      db.payments,
      db.paymentAllocations,
      db.supplierInvoices,
    ],
    async () => {
      await db.outgoingCheques.update(cheque.id, {
        status: params.nextStatus,
        clearingDate:
          params.nextStatus === 'encaisse' ? params.clearingDate : cheque.clearingDate,
        rejectedAt:
          params.nextStatus === 'rejete'
            ? params.rejectionDate || now.slice(0, 10)
            : cheque.rejectedAt,
        rejectionReason:
          params.nextStatus === 'rejete' ? params.reason?.trim() : cheque.rejectionReason,
        cancelReason:
          params.nextStatus === 'annule' || params.nextStatus === 'rejete'
            ? params.reason?.trim()
            : cheque.cancelReason,
        cancelledAt: params.nextStatus === 'annule' ? now : cheque.cancelledAt,
        updatedAt: now,
      });

      if (cheque.chequeLeafId) {
        await db.chequeLeaves.update(cheque.chequeLeafId, {
          status: params.nextStatus,
        });
      }

      // Un chèque émis n'entre dans le grand livre QU'UNE SEULE FOIS lorsqu'il passe à "encaisse"
      if (params.nextStatus === 'encaisse') {
        const existingLed = await db.ledgerEntries
          .where('sourceId')
          .equals(cheque.id)
          .filter((e) => e.sourceType === 'cheque_emis_encaisse' && e.status === 'valide')
          .first();

        if (!existingLed) {
          const ledger: LedgerEntry = {
            id: createId('led'),
            date: params.clearingDate!,
            direction: 'sortie',
            sourceType: 'cheque_emis_encaisse',
            sourceId: cheque.id,
            bankAccountId: cheque.bankAccountId,
            contactId: cheque.contactId,
            label: `Chèque émis encaissé ${cheque.chequeNumber} — ${cheque.beneficiary} (${cheque.purpose})`,
            amountCentimes: cheque.amountCentimes,
            currency: cheque.currency,
            exchangeRate: cheque.exchangeRate,
            baseDzdAmountCentimes: cheque.baseDzdAmountCentimes,
            status: 'valide',
            createdAt: now,
          };
          await db.ledgerEntries.put(ledger);
        }

        // Si lié à une facture fournisseur, créer le paiement et l'allocation correspondants si pas déjà créés
        if (cheque.linkedType === 'fournisseur_facture' && cheque.linkedId && cheque.contactId) {
          const existingPay = await db.payments
            .filter((p) => p.chequeId === cheque.id && p.status === 'valide')
            .first();
          if (!existingPay) {
            const payId = createId('pay');
            const payment: Payment = {
              id: payId,
              direction: 'sortant',
              contactId: cheque.contactId,
              date: params.clearingDate!,
              amountCentimes: cheque.amountCentimes,
              currency: cheque.currency,
              exchangeRate: cheque.exchangeRate,
              baseDzdAmountCentimes: cheque.baseDzdAmountCentimes,
              method: 'cheque',
              bankAccountId: cheque.bankAccountId,
              chequeId: cheque.id,
              reference: `CHQ ${cheque.chequeNumber}`,
              notes: cheque.purpose,
              isAdvance: false,
              status: 'valide',
              createdAt: now,
              updatedAt: now,
            };
            await db.payments.put(payment);

            const inv = await db.supplierInvoices.get(cheque.linkedId);
            if (inv && inv.status !== 'annulee') {
              const existingAllocs = await db.paymentAllocations
                .where('invoiceId')
                .equals(inv.id)
                .toArray();
              const allPayments = await db.payments.toArray();
              const validIds = new Set(allPayments.filter((p) => p.status === 'valide').map((p) => p.id));
              const alreadyPaid = computeInvoicePaidCentimes(inv.id, existingAllocs, validIds);
              const rem = computeInvoiceRemainingCentimes(inv.totalTtcCentimes, alreadyPaid, inv.status);
              const allocAmt = Math.min(rem, cheque.amountCentimes);

              if (allocAmt > 0) {
                const alloc: PaymentAllocation = {
                  id: createId('alloc'),
                  paymentId: payId,
                  invoiceType: 'fournisseur',
                  invoiceId: inv.id,
                  amountCentimes: allocAmt,
                  createdAt: now,
                };
                await db.paymentAllocations.put(alloc);

                const newPaid = alreadyPaid + allocAmt;
                const computed = computeInvoiceStatus({
                  storedStatus: inv.status,
                  totalTtcCentimes: inv.totalTtcCentimes,
                  paidCentimes: newPaid,
                  dueDate: inv.dueDate,
                });
                const stored: SupplierInvoice['status'] =
                  computed === 'en_retard' ? (newPaid > 0 ? 'partielle' : 'impayee') : computed;
                await db.supplierInvoices.update(inv.id, { status: stored, updatedAt: now });
              }
            }
          }
        }
      } else if (params.nextStatus === 'rejete' || params.nextStatus === 'annule') {
        // Si ce chèque avait généré une écriture ou paiement auparavant, on les annule proprement
        const leds = await db.ledgerEntries.where('sourceId').equals(cheque.id).toArray();
        for (const l of leds) {
          await db.ledgerEntries.update(l.id, { status: 'annule' });
        }
        const pays = await db.payments.filter((p) => p.chequeId === cheque.id).toArray();
        for (const p of pays) {
          await db.payments.update(p.id, {
            status: 'annule',
            cancelReason: params.reason?.trim(),
            cancelledAt: now,
            updatedAt: now,
          });
          const payLeds = await db.ledgerEntries.where('sourceId').equals(p.id).toArray();
          for (const l of payLeds) {
            await db.ledgerEntries.update(l.id, { status: 'annule' });
          }
          const allocs = await db.paymentAllocations.where('paymentId').equals(p.id).toArray();
          for (const a of allocs) {
            if (a.invoiceType === 'fournisseur') impactedSupplierInvoiceIds.add(a.invoiceId);
          }
        }
        if (cheque.linkedType === 'fournisseur_facture' && cheque.linkedId) {
          impactedSupplierInvoiceIds.add(cheque.linkedId);
        }
      }
    }
  );

  for (const invId of impactedSupplierInvoiceIds) {
    await refreshInvoiceStoredStatus('fournisseur', invId);
  }

  await recordAudit({
    action: params.nextStatus === 'encaisse' ? 'ENCAISSEMENT' : params.nextStatus === 'annule' ? 'ANNULATION' : 'MODIFICATION',
    entityType: 'cheque_emis',
    entityId: cheque.id,
    summary: `Chèque émis ${cheque.chequeNumber} passé au statut « ${params.nextStatus} »`,
    before: cheque,
    reason: params.reason,
  });
}

export async function updateOutgoingCheque(params: {
  chequeId: string;
  beneficiary: string;
  contactId?: string;
  issueDate: string;
  amountCentimes: number;
  currency: string;
  exchangeRate: number;
  purpose: string;
  linkedType: OutgoingCheque['linkedType'];
  linkedId?: string;
  notes: string;
  chequeNumber?: string;
}): Promise<OutgoingCheque> {
  const cheque = await db.outgoingCheques.get(params.chequeId);
  if (!cheque || cheque.deletedAt) throw new Error('Chèque émis introuvable.');
  if (!params.beneficiary.trim()) throw new Error('Le bénéficiaire est obligatoire.');
  if (!params.issueDate) throw new Error('La date est obligatoire.');
  if (params.amountCentimes <= 0) throw new Error('Le montant doit être supérieur à zéro.');

  const now = new Date().toISOString();
  const baseDzd = convertToBaseDzd(params.amountCentimes, params.exchangeRate);
  const updated: OutgoingCheque = {
    ...cheque,
    chequeNumber: params.chequeNumber?.trim() || cheque.chequeNumber,
    beneficiary: params.beneficiary.trim(),
    contactId: params.contactId || undefined,
    issueDate: params.issueDate,
    amountCentimes: params.amountCentimes,
    currency: params.currency,
    exchangeRate: params.exchangeRate,
    baseDzdAmountCentimes: baseDzd,
    purpose: params.purpose.trim() || cheque.purpose,
    linkedType: params.linkedType,
    linkedId: params.linkedId || undefined,
    notes: params.notes.trim(),
    updatedAt: now,
  };
  await db.outgoingCheques.put(updated);
  await recordAudit({
    action: 'MODIFICATION',
    entityType: 'cheque_emis',
    entityId: cheque.id,
    summary: `Modification chèque émis N° ${updated.chequeNumber}`,
    before: cheque,
    after: updated,
  });
  return updated;
}

export async function createIncomingCheque(params: {
  clientId: string;
  issuerBank: string;
  chequeNumber: string;
  chequeDate: string;
  entryDate: string;
  amountCentimes: number;
  currency: string;
  exchangeRate: number;
  targetBankAccountId: string | null;
  allocatedInvoiceIds: string[];
  allocatedAmounts?: Record<string, number>;
  isAdvance?: boolean;
  notes: string;
}): Promise<IncomingCheque> {
  if (!params.clientId) throw new Error('Veuillez sélectionner le client.');
  if (!params.issuerBank.trim()) throw new Error('Veuillez indiquer la banque émettrice.');
  if (!params.chequeNumber.trim()) throw new Error('Le numéro du chèque est obligatoire.');
  if (!params.chequeDate) throw new Error('La date du chèque est obligatoire.');
  if (!params.entryDate) throw new Error('La date d’entrée est obligatoire.');
  if (params.amountCentimes <= 0) throw new Error('Le montant doit être supérieur à zéro.');

  const now = new Date().toISOString();
  const id = createId('ichq');
  const isAdvance = params.isAdvance ?? params.allocatedInvoiceIds.length === 0;
  const record: IncomingCheque = {
    id,
    clientId: params.clientId,
    issuerBank: params.issuerBank.trim(),
    chequeNumber: params.chequeNumber.trim(),
    chequeDate: params.chequeDate,
    entryDate: params.entryDate,
    amountCentimes: params.amountCentimes,
    currency: params.currency,
    exchangeRate: params.exchangeRate,
    baseDzdAmountCentimes: convertToBaseDzd(params.amountCentimes, params.exchangeRate),
    targetBankAccountId: params.targetBankAccountId,
    status: 'recu',
    isAdvance,
    allocatedInvoiceIds: isAdvance ? [] : params.allocatedInvoiceIds,
    allocatedAmounts: isAdvance ? undefined : params.allocatedAmounts,
    notes: params.notes.trim(),
    createdAt: now,
    updatedAt: now,
  };

  await db.incomingCheques.put(record);
  await recordAudit({
    action: 'CREATION',
    entityType: 'cheque_recu',
    entityId: id,
    summary: `Réception chèque client N° ${record.chequeNumber} (${record.issuerBank})${
      isAdvance ? ' — Avance client' : ''
    }`,
    after: record,
  });

  return record;
}

export async function updateIncomingCheque(params: {
  chequeId: string;
  clientId: string;
  issuerBank: string;
  chequeNumber: string;
  chequeDate: string;
  entryDate: string;
  amountCentimes: number;
  currency: string;
  exchangeRate: number;
  targetBankAccountId: string | null;
  allocatedInvoiceIds: string[];
  allocatedAmounts?: Record<string, number>;
  isAdvance?: boolean;
  notes: string;
}): Promise<IncomingCheque> {
  const existing = await db.incomingCheques.get(params.chequeId);
  if (!existing || existing.deletedAt) throw new Error('Chèque reçu introuvable.');
  if (!params.clientId) throw new Error('Veuillez sélectionner le client.');
  if (!params.issuerBank.trim()) throw new Error('Veuillez indiquer la banque émettrice.');
  if (!params.chequeNumber.trim()) throw new Error('Le numéro du chèque est obligatoire.');
  if (!params.chequeDate) throw new Error('La date du chèque est obligatoire.');
  if (!params.entryDate) throw new Error('La date d’entrée est obligatoire.');
  if (params.amountCentimes <= 0) throw new Error('Le montant doit être supérieur à zéro.');

  const now = new Date().toISOString();
  const baseDzdAmountCentimes = convertToBaseDzd(params.amountCentimes, params.exchangeRate);
  const isAdvance = params.isAdvance ?? params.allocatedInvoiceIds.length === 0;

  const updated: IncomingCheque = {
    ...existing,
    clientId: params.clientId,
    issuerBank: params.issuerBank.trim(),
    chequeNumber: params.chequeNumber.trim(),
    chequeDate: params.chequeDate,
    entryDate: params.entryDate,
    amountCentimes: params.amountCentimes,
    currency: params.currency,
    exchangeRate: params.exchangeRate,
    baseDzdAmountCentimes,
    targetBankAccountId: params.targetBankAccountId,
    isAdvance,
    allocatedInvoiceIds: isAdvance ? [] : params.allocatedInvoiceIds,
    allocatedAmounts: isAdvance ? undefined : params.allocatedAmounts,
    notes: params.notes.trim(),
    updatedAt: now,
  };

  await db.incomingCheques.put(updated);

  if (existing.linkedPaymentId) {
    const linkedPay = await db.payments.get(existing.linkedPaymentId);
    if (linkedPay && linkedPay.status === 'valide') {
      await db.payments.update(linkedPay.id, {
        contactId: updated.clientId,
        amountCentimes: updated.amountCentimes,
        currency: updated.currency,
        exchangeRate: updated.exchangeRate,
        baseDzdAmountCentimes,
        bankAccountId: updated.targetBankAccountId,
        reference: `CHQ ${updated.chequeNumber}`,
        notes: updated.notes,
        updatedAt: now,
      });
    }
  }

  await recordAudit({
    action: 'MODIFICATION',
    entityType: 'cheque_recu',
    entityId: updated.id,
    summary: `Modification chèque reçu N° ${updated.chequeNumber}`,
    before: existing,
    after: updated,
  });

  return updated;
}

export async function updateIncomingChequeStatus(params: {
  chequeId: string;
  nextStatus: IncomingChequeStatus;
  targetBankAccountId?: string | null;
  depositDate?: string;
  clearingDate?: string;
  rejectionDate?: string;
  reason?: string;
}): Promise<void> {
  const cheque = await db.incomingCheques.get(params.chequeId);
  if (!cheque) throw new Error('Chèque reçu introuvable.');
  if (cheque.status === 'annule') {
    throw new Error('Un chèque annulé ne peut plus être modifié.');
  }

  if ((params.nextStatus === 'rejete' || params.nextStatus === 'annule') && !params.reason?.trim()) {
    throw new Error('Un motif est obligatoire pour rejeter ou annuler ce chèque.');
  }

  const targetBank =
    params.targetBankAccountId !== undefined
      ? params.targetBankAccountId
      : cheque.targetBankAccountId;

  if (params.nextStatus === 'encaisse') {
    if (!targetBank) {
      throw new Error('Veuillez sélectionner la banque sur laquelle le chèque est encaissé.');
    }
    if (!params.clearingDate) {
      throw new Error('Veuillez indiquer la date d’encaissement.');
    }
  }

  const now = new Date().toISOString();
  const rejDate = params.rejectionDate || now.slice(0, 10);
  const impactedInvoiceIds = new Set<string>(cheque.allocatedInvoiceIds || []);

  await db.transaction(
    'rw',
    [
      db.incomingCheques,
      db.ledgerEntries,
      db.payments,
      db.paymentAllocations,
      db.customerInvoices,
    ],
    async () => {
      await db.incomingCheques.update(cheque.id, {
        status: params.nextStatus,
        targetBankAccountId: targetBank,
        depositDate: params.depositDate || cheque.depositDate,
        clearingDate:
          params.nextStatus === 'encaisse' ? params.clearingDate : cheque.clearingDate,
        rejectedAt: params.nextStatus === 'rejete' ? rejDate : cheque.rejectedAt,
        rejectionReason:
          params.nextStatus === 'rejete' ? params.reason?.trim() : cheque.rejectionReason,
        cancelReason:
          params.nextStatus === 'rejete' || params.nextStatus === 'annule'
            ? params.reason?.trim()
            : cheque.cancelReason,
        cancelledAt: params.nextStatus === 'annule' ? now : cheque.cancelledAt,
        updatedAt: now,
      });

      if (params.nextStatus === 'encaisse') {
        const existingLed = await db.ledgerEntries
          .where('sourceId')
          .equals(cheque.id)
          .filter((e) => e.sourceType === 'cheque_recu_encaisse' && e.status === 'valide')
          .first();

        if (!existingLed) {
          const client = await db.contacts.get(cheque.clientId);
          const clientLabel = client ? client.company || client.name : 'Client';

          await db.ledgerEntries.put({
            id: createId('led'),
            date: params.clearingDate!,
            direction: 'entree',
            sourceType: 'cheque_recu_encaisse',
            sourceId: cheque.id,
            bankAccountId: targetBank,
            contactId: cheque.clientId,
            label: `Chèque reçu encaissé ${cheque.chequeNumber} — ${clientLabel}`,
            amountCentimes: cheque.amountCentimes,
            currency: cheque.currency,
            exchangeRate: cheque.exchangeRate,
            baseDzdAmountCentimes: cheque.baseDzdAmountCentimes,
            status: 'valide',
            createdAt: now,
          });
        }

        // Créer le paiement client + allocations aux factures sélectionnées (si non déjà créé)
        if (!cheque.linkedPaymentId) {
          const payId = createId('pay');
          let remainingBudget = cheque.amountCentimes;
          const allPayments = await db.payments.toArray();
          const validPaymentIds = new Set(
            allPayments.filter((p) => p.status === 'valide' && !p.deletedAt).map((p) => p.id)
          );

          const allocs: PaymentAllocation[] = [];
          const targetInvIds = cheque.isAdvance ? [] : cheque.allocatedInvoiceIds;
          for (const invId of targetInvIds) {
            if (remainingBudget <= 0) break;
            const inv = await db.customerInvoices.get(invId);
            if (!inv || inv.status === 'annulee') continue;
            const existingAllocs = await db.paymentAllocations
              .where('invoiceId')
              .equals(inv.id)
              .toArray();
            const paid = computeInvoicePaidCentimes(inv.id, existingAllocs, validPaymentIds);
            const rem = computeInvoiceRemainingCentimes(inv.totalTtcCentimes, paid, inv.status);
            const requested = cheque.allocatedAmounts?.[invId];
            const take = Math.min(remainingBudget, rem, requested && requested > 0 ? requested : rem);
            if (take > 0) {
              allocs.push({
                id: createId('alloc'),
                paymentId: payId,
                invoiceType: 'client',
                invoiceId: inv.id,
                amountCentimes: take,
                createdAt: now,
              });
              remainingBudget -= take;

              const newPaid = paid + take;
              const computed = computeInvoiceStatus({
                storedStatus: inv.status,
                totalTtcCentimes: inv.totalTtcCentimes,
                paidCentimes: newPaid,
                dueDate: inv.dueDate,
              });
              const stored: CustomerInvoice['status'] =
                computed === 'en_retard' ? (newPaid > 0 ? 'partielle' : 'impayee') : computed;
              await db.customerInvoices.update(inv.id, { status: stored, updatedAt: now });
            }
          }

          const payment: Payment = {
            id: payId,
            direction: 'entrant',
            contactId: cheque.clientId,
            date: params.clearingDate!,
            amountCentimes: cheque.amountCentimes,
            currency: cheque.currency,
            exchangeRate: cheque.exchangeRate,
            baseDzdAmountCentimes: cheque.baseDzdAmountCentimes,
            method: 'cheque',
            bankAccountId: targetBank,
            chequeId: cheque.id,
            reference: `CHQ ${cheque.chequeNumber}`,
            notes: cheque.notes,
            isAdvance: Boolean(cheque.isAdvance) || remainingBudget > 0,
            status: 'valide',
            createdAt: now,
            updatedAt: now,
          };

          await db.payments.put(payment);
          if (allocs.length) {
            await db.paymentAllocations.bulkPut(allocs);
          }
          await db.incomingCheques.update(cheque.id, {
            linkedPaymentId: payId,
            isAdvance: payment.isAdvance,
          });
        }
      } else if (params.nextStatus === 'rejete' || params.nextStatus === 'annule') {
        const leds = await db.ledgerEntries.where('sourceId').equals(cheque.id).toArray();
        for (const l of leds) {
          await db.ledgerEntries.update(l.id, { status: 'annule' });
        }

        const linkedPays = await db.payments
          .filter((p) => p.id === cheque.linkedPaymentId || p.chequeId === cheque.id)
          .toArray();
        for (const p of linkedPays) {
          await db.payments.update(p.id, {
            status: 'annule',
            cancelReason: params.reason?.trim(),
            cancelledAt: now,
            updatedAt: now,
          });
          const payLeds = await db.ledgerEntries.where('sourceId').equals(p.id).toArray();
          for (const l of payLeds) {
            await db.ledgerEntries.update(l.id, { status: 'annule' });
          }
          const allocs = await db.paymentAllocations.where('paymentId').equals(p.id).toArray();
          for (const a of allocs) {
            if (a.invoiceType === 'client') {
              impactedInvoiceIds.add(a.invoiceId);
            }
          }
        }
      }
    }
  );

  // Recalculer automatiquement les statuts des factures impactées (ex: Payée -> Non payée / Partielle)
  if (params.nextStatus === 'rejete' || params.nextStatus === 'annule') {
    for (const invId of impactedInvoiceIds) {
      await refreshInvoiceStoredStatus('client', invId);
      if (params.nextStatus === 'rejete') {
        const inv = await db.customerInvoices.get(invId);
        if (inv) {
          const rejLine = `Chèque N° ${cheque.chequeNumber} rejeté le ${formatDateFr(rejDate)} : ${params.reason?.trim()}`;
          const nextNotes = inv.notes ? `${inv.notes}\n${rejLine}` : rejLine;
          await db.customerInvoices.update(inv.id, {
            notes: nextNotes,
            updatedAt: now,
          });
        }
      }
    }
  }

  await recordAudit({
    action: params.nextStatus === 'encaisse' ? 'ENCAISSEMENT' : params.nextStatus === 'annule' ? 'ANNULATION' : 'MODIFICATION',
    entityType: 'cheque_recu',
    entityId: cheque.id,
    summary: `Chèque reçu ${cheque.chequeNumber} passé au statut « ${params.nextStatus} »`,
    before: cheque,
    reason: params.reason,
  });
}

/**
 * Affecte un chèque d'avance client à une ou plusieurs factures.
 * Crée (ou utilise) le paiement associé et diminue automatiquement le solde d'avance disponible.
 */
export async function allocateIncomingAdvanceCheque(params: {
  chequeId: string;
  targetBankAccountId?: string | null;
  clearingDate?: string;
  allocations: Array<{ invoiceId: string; amountCentimes: number }>;
}): Promise<{ paymentId: string }> {
  const cheque = await db.incomingCheques.get(params.chequeId);
  if (!cheque || cheque.deletedAt) throw new Error('Chèque reçu introuvable.');
  if (cheque.status === 'rejete' || cheque.status === 'annule') {
    throw new Error('Un chèque rejeté ou annulé ne peut pas être affecté.');
  }

  const validAllocs = params.allocations.filter((a) => a.amountCentimes > 0);
  if (validAllocs.length === 0) {
    throw new Error('Veuillez sélectionner au moins une facture et un montant.');
  }

  const now = new Date().toISOString();
  const totalRequested = validAllocs.reduce((s, a) => s + a.amountCentimes, 0);

  // Cas 1 : Le chèque est déjà encaissé avec un paiement existant -> affecter l'avance restante
  if (cheque.linkedPaymentId && cheque.status === 'encaisse') {
    await allocateExistingAdvanceToInvoices({
      paymentId: cheque.linkedPaymentId,
      invoiceType: 'client',
      allocations: validAllocs,
    });
    const payAllocs = await db.paymentAllocations
      .where('paymentId')
      .equals(cheque.linkedPaymentId)
      .toArray();
    const pay = await db.payments.get(cheque.linkedPaymentId);
    const totalUsed = payAllocs.reduce((s, a) => s + a.amountCentimes, 0);
    const nextAmounts: Record<string, number> = { ...(cheque.allocatedAmounts || {}) };
    for (const a of validAllocs) {
      nextAmounts[a.invoiceId] = (nextAmounts[a.invoiceId] || 0) + a.amountCentimes;
    }
    const nextIds = Array.from(
      new Set([...cheque.allocatedInvoiceIds, ...validAllocs.map((a) => a.invoiceId)])
    );
    await db.incomingCheques.update(cheque.id, {
      allocatedInvoiceIds: nextIds,
      allocatedAmounts: nextAmounts,
      isAdvance: pay ? totalUsed < pay.amountCentimes : false,
      updatedAt: now,
    });
    return { paymentId: cheque.linkedPaymentId };
  }

  // Cas 2 : Chèque encore en portefeuille (reçu / déposé / en attente) -> encaissement + création du paiement + affectations
  if (totalRequested > cheque.amountCentimes) {
    throw new Error('Le montant affecté dépasse le montant du chèque.');
  }
  const bankId =
    params.targetBankAccountId !== undefined
      ? params.targetBankAccountId
      : cheque.targetBankAccountId;
  const dateStr = params.clearingDate || now.slice(0, 10);
  const payId = createId('pay');
  const isStillAdvance = totalRequested < cheque.amountCentimes;
  const client = await db.contacts.get(cheque.clientId);
  const clientLabel = client ? client.company || client.name : 'Client';

  const payment: Payment = {
    id: payId,
    direction: 'entrant',
    contactId: cheque.clientId,
    date: dateStr,
    amountCentimes: cheque.amountCentimes,
    currency: cheque.currency,
    exchangeRate: cheque.exchangeRate,
    baseDzdAmountCentimes: cheque.baseDzdAmountCentimes,
    method: 'cheque',
    bankAccountId: bankId,
    chequeId: cheque.id,
    reference: `CHQ ${cheque.chequeNumber}`,
    notes: cheque.notes,
    isAdvance: isStillAdvance,
    status: 'valide',
    createdAt: now,
    updatedAt: now,
  };

  const allocRecords: PaymentAllocation[] = validAllocs.map((a) => ({
    id: createId('alloc'),
    paymentId: payId,
    invoiceType: 'client',
    invoiceId: a.invoiceId,
    amountCentimes: a.amountCentimes,
    createdAt: now,
  }));

  const ledger: LedgerEntry = {
    id: createId('led'),
    date: dateStr,
    direction: 'entree',
    sourceType: 'cheque_recu_encaisse',
    sourceId: cheque.id,
    bankAccountId: bankId,
    contactId: cheque.clientId,
    label: `Chèque reçu encaissé ${cheque.chequeNumber} — ${clientLabel}`,
    amountCentimes: cheque.amountCentimes,
    currency: cheque.currency,
    exchangeRate: cheque.exchangeRate,
    baseDzdAmountCentimes: cheque.baseDzdAmountCentimes,
    status: 'valide',
    createdAt: now,
  };

  const nextAmounts: Record<string, number> = {};
  for (const a of validAllocs) {
    nextAmounts[a.invoiceId] = (nextAmounts[a.invoiceId] || 0) + a.amountCentimes;
  }

  await db.transaction(
    'rw',
    [db.incomingCheques, db.payments, db.paymentAllocations, db.ledgerEntries],
    async () => {
      await db.payments.put(payment);
      await db.paymentAllocations.bulkPut(allocRecords);
      await db.ledgerEntries.put(ledger);
      await db.incomingCheques.update(cheque.id, {
        status: 'encaisse',
        targetBankAccountId: bankId,
        clearingDate: dateStr,
        linkedPaymentId: payId,
        allocatedInvoiceIds: validAllocs.map((a) => a.invoiceId),
        allocatedAmounts: nextAmounts,
        isAdvance: isStillAdvance,
        updatedAt: now,
      });
    }
  );

  for (const a of validAllocs) {
    await refreshInvoiceStoredStatus('client', a.invoiceId);
  }

  await recordAudit({
    action: 'ENCAISSEMENT',
    entityType: 'cheque_recu',
    entityId: cheque.id,
    summary: `Affectation avance chèque ${cheque.chequeNumber} sur ${validAllocs.length} facture(s)`,
    after: allocRecords,
  });

  return { paymentId: payId };
}
