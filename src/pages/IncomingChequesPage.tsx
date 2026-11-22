import React, { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowRightLeft, CheckCircle2, Edit3, Plus, Search, Trash2, X } from 'lucide-react';
import { db } from '../db/database';
import type { IncomingCheque, IncomingChequeStatus } from '../db/types';
import {
  allocateIncomingAdvanceCheque,
  createIncomingCheque,
  updateIncomingCheque,
  updateIncomingChequeStatus,
} from '../services/treasuryActions';
import { useAppStore } from '../store/useAppStore';
import { computeInvoicePaidCentimes, computeInvoiceRemainingCentimes } from '../utils/finance';
import {
  addMoney,
  centimesToInputString,
  formatMoney,
  parseMoneyInputToCentimes,
} from '../utils/money';
import { MoreOptionsButton } from '../components/MoreOptionsButton';
import { SafeDeleteDialog } from '../components/SafeDeleteDialog';
import { useUiMode } from '../hooks/useUiMode';

const INCOMING_STATUS_META: Record<
  IncomingChequeStatus,
  { label: string; className: string; badgeClass: string }
> = {
  recu: {
    label: 'Reçu',
    className: 'text-slate-700',
    badgeClass: 'bg-slate-100 text-slate-700 border-slate-200',
  },
  depose: {
    label: 'Déposé',
    className: 'text-amber-700',
    badgeClass: 'bg-amber-50 text-amber-800 border-amber-200',
  },
  en_attente: {
    label: 'Non payé (en attente)',
    className: 'text-amber-700',
    badgeClass: 'bg-amber-50 text-amber-800 border-amber-200',
  },
  encaisse: {
    label: 'Payé (encaissé)',
    className: 'text-emerald-700 font-semibold',
    badgeClass: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  },
  rejete: {
    label: 'Rejeté',
    className: 'text-red-700 font-semibold',
    badgeClass: 'bg-red-50 text-red-700 border-red-200',
  },
  annule: {
    label: 'Annulé',
    className: 'text-slate-400 line-through',
    badgeClass: 'bg-slate-100 text-slate-500 border-slate-200',
  },
};

export const IncomingChequesPage: React.FC = () => {
  const pushToast = useAppStore((s) => s.pushToast);
  const { isSimple } = useUiMode();
  const settings = useLiveQuery(() => db.settings.get('company_settings'));
  const incomingCheques = useLiveQuery(
    async () => (await db.incomingCheques.toArray()).filter((x) => !x.deletedAt),
    [],
    []
  );
  const contacts = useLiveQuery(
    async () => (await db.contacts.toArray()).filter((x) => !x.deletedAt),
    [],
    []
  );
  const bankAccounts = useLiveQuery(
    async () => (await db.bankAccounts.toArray()).filter((x) => !x.deletedAt),
    [],
    []
  );
  const customerInvoices = useLiveQuery(
    async () => (await db.customerInvoices.toArray()).filter((x) => !x.deletedAt),
    [],
    []
  );
  const payments = useLiveQuery(
    async () => (await db.payments.toArray()).filter((x) => !x.deletedAt),
    [],
    []
  );
  const allocations = useLiveQuery(() => db.paymentAllocations.toArray(), [], []);

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'tous' | 'avances' | IncomingChequeStatus>(
    'tous'
  );

  // Modale ajout / modification chèque reçu
  const [modalOpen, setModalOpen] = useState(false);
  const [editingChequeId, setEditingChequeId] = useState<string | null>(null);
  const [showMoreOptions, setShowMoreOptions] = useState(false);
  const [cClientId, setCClientId] = useState('');
  const [cIssuerBank, setCIssuerBank] = useState('');
  const [cNumber, setCNumber] = useState('');
  const [cChequeDate, setCChequeDate] = useState(new Date().toISOString().slice(0, 10));
  const [cEntryDate, setCEntryDate] = useState(new Date().toISOString().slice(0, 10));
  const [cAmountText, setCAmountText] = useState('0,00');
  const [cCurrency, setCCurrency] = useState('DZD');
  const [cExchangeRate, setCExchangeRate] = useState('1');
  const [cTargetBankId, setCTargetBankId] = useState('');
  const [cIsAdvance, setCIsAdvance] = useState(false);
  const [cInvoiceIds, setCInvoiceIds] = useState<string[]>([]);
  const [cNotes, setCNotes] = useState('');

  // Modale changement de statut / encaissement / rejet
  const [statusTarget, setStatusTarget] = useState<{
    cheque: IncomingCheque;
    nextStatus: IncomingChequeStatus;
  } | null>(null);
  const [tBankId, setTBankId] = useState('');
  const [tDate, setTDate] = useState(new Date().toISOString().slice(0, 10));
  const [tReason, setTReason] = useState('');

  // Modale affectation chèque d'avance à une ou plusieurs factures
  const [allocateTarget, setAllocateTarget] = useState<IncomingCheque | null>(null);
  const [allocBankId, setAllocBankId] = useState('');
  const [allocDate, setAllocDate] = useState(new Date().toISOString().slice(0, 10));
  const [allocAmounts, setAllocAmounts] = useState<Record<string, string>>({});

  const [deleteTarget, setDeleteTarget] = useState<{ id: string; label: string } | null>(null);

  const defaultCurrency = settings?.defaultCurrency || 'DZD';
  const currencies = settings?.enabledCurrencies;
  const showAdvancedFields = !isSimple || showMoreOptions;

  const contactMap = useMemo(() => new Map(contacts.map((c) => [c.id, c])), [contacts]);
  const bankMap = useMemo(() => new Map(bankAccounts.map((b) => [b.id, b])), [bankAccounts]);
  const invoiceMap = useMemo(
    () => new Map(customerInvoices.map((i) => [i.id, i])),
    [customerInvoices]
  );

  const paymentAllocatedMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of allocations) {
      map.set(a.paymentId, (map.get(a.paymentId) || 0) + a.amountCentimes);
    }
    return map;
  }, [allocations]);

  const paymentMap = useMemo(() => new Map(payments.map((p) => [p.id, p])), [payments]);

  const getChequeAdvanceRemaining = (c: IncomingCheque): number => {
    if (c.status === 'annule' || c.status === 'rejete') return 0;
    if (c.linkedPaymentId) {
      const pay = paymentMap.get(c.linkedPaymentId);
      if (!pay || pay.status !== 'valide') return 0;
      const used = paymentAllocatedMap.get(pay.id) || 0;
      return Math.max(0, pay.amountCentimes - used);
    }
    if (c.isAdvance || c.allocatedInvoiceIds.length === 0) {
      return c.amountCentimes;
    }
    return 0;
  };

  const clientOptions = useMemo(
    () =>
      contacts.filter(
        (c) => !c.archived && (c.type === 'client' || c.type === 'les_deux')
      ),
    [contacts]
  );

  const getClientUnpaidInvoices = (clientId: string) => {
    if (!clientId) return [];
    const validIds = new Set(payments.filter((p) => p.status === 'valide').map((p) => p.id));
    return customerInvoices
      .filter((inv) => inv.clientId === clientId && inv.status !== 'annulee')
      .map((inv) => {
        const paid = computeInvoicePaidCentimes(inv.id, allocations, validIds);
        const rem = computeInvoiceRemainingCentimes(inv.totalTtcCentimes, paid, inv.status);
        return { inv, rem };
      })
      .filter((x) => x.rem > 0);
  };

  const clientUnpaidInvoices = useMemo(
    () => getClientUnpaidInvoices(cClientId),
    [cClientId, customerInvoices, payments, allocations]
  );

  const allocateUnpaidInvoices = useMemo(
    () => (allocateTarget ? getClientUnpaidInvoices(allocateTarget.clientId) : []),
    [allocateTarget, customerInvoices, payments, allocations]
  );

  const filteredCheques = useMemo(() => {
    const q = search.trim().toLowerCase();
    return incomingCheques
      .filter((c) => {
        if (statusFilter === 'avances') {
          const isAdv =
            (c.isAdvance || c.allocatedInvoiceIds.length === 0 || getChequeAdvanceRemaining(c) > 0) &&
            c.status !== 'annule' &&
            c.status !== 'rejete';
          if (!isAdv) return false;
        } else if (statusFilter !== 'tous' && c.status !== statusFilter) {
          return false;
        }
        const client = contactMap.get(c.clientId);
        const clientName = client ? client.company || client.name : '';
        if (q) {
          const hay = `${c.chequeNumber} ${clientName} ${c.issuerBank} ${c.notes}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => b.entryDate.localeCompare(a.entryDate));
  }, [incomingCheques, statusFilter, search, contactMap, paymentMap, paymentAllocatedMap]);

  const totals = useMemo(() => {
    let pending = 0;
    let cleared = 0;
    let rejected = 0;
    let advances = 0;
    for (const c of incomingCheques) {
      if (c.status === 'encaisse') cleared = addMoney(cleared, c.baseDzdAmountCentimes);
      else if (c.status === 'rejete') rejected = addMoney(rejected, c.baseDzdAmountCentimes);
      else if (c.status !== 'annule') pending = addMoney(pending, c.baseDzdAmountCentimes);

      const advRem = getChequeAdvanceRemaining(c);
      if (advRem > 0) {
        const advDzd = Math.round(advRem * (c.exchangeRate || 1));
        advances = addMoney(advances, advDzd);
      }
    }
    return { pending, cleared, rejected, advances };
  }, [incomingCheques, paymentMap, paymentAllocatedMap]);

  const openCreateModal = () => {
    const today = new Date().toISOString().slice(0, 10);
    setEditingChequeId(null);
    setCClientId('');
    setCIssuerBank('');
    setCNumber('');
    setCChequeDate(today);
    setCEntryDate(today);
    setCAmountText('0,00');
    setCCurrency(defaultCurrency);
    setCExchangeRate('1');
    setCTargetBankId(bankAccounts[0]?.id || '');
    setCIsAdvance(false);
    setCInvoiceIds([]);
    setCNotes('');
    setShowMoreOptions(false);
    setModalOpen(true);
  };

  const openEditModal = (c: IncomingCheque) => {
    setEditingChequeId(c.id);
    setCClientId(c.clientId);
    setCIssuerBank(c.issuerBank);
    setCNumber(c.chequeNumber);
    setCChequeDate(c.chequeDate);
    setCEntryDate(c.entryDate);
    setCAmountText(centimesToInputString(c.amountCentimes));
    setCCurrency(c.currency);
    setCExchangeRate(String(c.exchangeRate || 1));
    setCTargetBankId(c.targetBankAccountId || '');
    setCIsAdvance(Boolean(c.isAdvance) && c.allocatedInvoiceIds.length === 0);
    setCInvoiceIds([...c.allocatedInvoiceIds]);
    setCNotes(c.notes || '');
    setShowMoreOptions(false);
    setModalOpen(true);
  };

  const handleSaveCheque = async (e: React.FormEvent) => {
    e.preventDefault();
    const amount = parseMoneyInputToCentimes(cAmountText);
    if (Number.isNaN(amount) || amount <= 0) {
      pushToast({ type: 'error', title: 'Montant invalide' });
      return;
    }
    const rate = parseFloat(cExchangeRate.replace(',', '.'));
    const safeRate = Number.isFinite(rate) && rate > 0 ? rate : 1;
    const isAdv = cIsAdvance || cInvoiceIds.length === 0;

    try {
      if (editingChequeId) {
        await updateIncomingCheque({
          chequeId: editingChequeId,
          clientId: cClientId,
          issuerBank: cIssuerBank,
          chequeNumber: cNumber,
          chequeDate: cChequeDate,
          entryDate: cEntryDate,
          amountCentimes: amount,
          currency: cCurrency,
          exchangeRate: safeRate,
          targetBankAccountId: cTargetBankId || null,
          allocatedInvoiceIds: isAdv ? [] : cInvoiceIds,
          isAdvance: isAdv,
          notes: cNotes,
        });
        pushToast({ type: 'success', title: 'Chèque reçu modifié' });
      } else {
        await createIncomingCheque({
          clientId: cClientId,
          issuerBank: cIssuerBank,
          chequeNumber: cNumber,
          chequeDate: cChequeDate,
          entryDate: cEntryDate,
          amountCentimes: amount,
          currency: cCurrency,
          exchangeRate: safeRate,
          targetBankAccountId: cTargetBankId || null,
          allocatedInvoiceIds: isAdv ? [] : cInvoiceIds,
          isAdvance: isAdv,
          notes: cNotes,
        });
        pushToast({
          type: 'success',
          title: 'Chèque reçu enregistré',
          message: isAdv
            ? 'Enregistré comme avance client (à affecter ultérieurement à une facture).'
            : 'Le montant n’entrera en trésorerie qu’une fois le chèque encaissé.',
        });
      }
      setModalOpen(false);
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Erreur de validation',
        message: err instanceof Error ? err.message : 'Erreur',
      });
    }
  };

  const handleConfirmStatus = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!statusTarget) return;
    try {
      await updateIncomingChequeStatus({
        chequeId: statusTarget.cheque.id,
        nextStatus: statusTarget.nextStatus,
        targetBankAccountId: tBankId || statusTarget.cheque.targetBankAccountId,
        depositDate: statusTarget.nextStatus === 'depose' ? tDate : undefined,
        clearingDate: statusTarget.nextStatus === 'encaisse' ? tDate : undefined,
        rejectionDate: statusTarget.nextStatus === 'rejete' ? tDate : undefined,
        reason: tReason || undefined,
      });
      pushToast({
        type: 'success',
        title: 'Statut du chèque mis à jour',
        message:
          statusTarget.nextStatus === 'encaisse'
            ? 'Le grand livre et les factures associées ont été mis à jour.'
            : statusTarget.nextStatus === 'rejete'
            ? 'Les factures associées ont été remises en attente de règlement.'
            : undefined,
      });
      setStatusTarget(null);
      setTReason('');
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Erreur',
        message: err instanceof Error ? err.message : 'Erreur',
      });
    }
  };

  const openAllocateModal = (cheque: IncomingCheque) => {
    const unpaid = getClientUnpaidInvoices(cheque.clientId);
    const maxAvail = getChequeAdvanceRemaining(cheque);
    let budget = maxAvail;
    const initial: Record<string, string> = {};
    for (const { inv, rem } of unpaid) {
      if (budget > 0) {
        const take = Math.min(budget, rem);
        initial[inv.id] = centimesToInputString(take);
        budget -= take;
      } else {
        initial[inv.id] = '0,00';
      }
    }
    setAllocBankId(cheque.targetBankAccountId || bankAccounts.find((b) => b.active)?.id || '');
    setAllocDate(cheque.clearingDate || new Date().toISOString().slice(0, 10));
    setAllocAmounts(initial);
    setAllocateTarget(cheque);
  };

  const handleConfirmAllocate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!allocateTarget) return;
    const allocs: Array<{ invoiceId: string; amountCentimes: number }> = [];
    for (const [invoiceId, txt] of Object.entries(allocAmounts)) {
      const c = parseMoneyInputToCentimes(txt);
      if (!Number.isNaN(c) && c > 0) {
        allocs.push({ invoiceId, amountCentimes: c });
      }
    }
    try {
      await allocateIncomingAdvanceCheque({
        chequeId: allocateTarget.id,
        targetBankAccountId: allocBankId || allocateTarget.targetBankAccountId,
        clearingDate: allocDate,
        allocations: allocs,
      });
      pushToast({
        type: 'success',
        title: 'Avance chèque affectée',
        message: `${allocs.length} facture(s) mise(s) à jour.`,
      });
      setAllocateTarget(null);
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Affectation impossible',
        message: err instanceof Error ? err.message : 'Erreur',
      });
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative">
            <Search className="pointer-events-none absolute top-2.5 left-3 h-4 w-4 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="N° chèque, client, banque..."
              className="w-60 rounded-md border border-slate-300 py-1.5 pr-3 pl-9 text-sm"
            />
          </div>

          <select
            value={statusFilter}
            onChange={(e) =>
              setStatusFilter(e.target.value as 'tous' | 'avances' | IncomingChequeStatus)
            }
            className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
          >
            <option value="tous">Tous statuts</option>
            <option value="avances">Avances (non affectées)</option>
            {Object.entries(INCOMING_STATUS_META).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={() => setStatusFilter((prev) => (prev === 'avances' ? 'tous' : 'avances'))}
            className={`rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors ${
              statusFilter === 'avances'
                ? 'border-blue-600 bg-blue-50 text-blue-800'
                : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
            }`}
          >
            Avances seulement
          </button>
        </div>

        <button
          type="button"
          onClick={openCreateModal}
          className="inline-flex items-center gap-2 rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
        >
          <Plus className="h-4 w-4" />
          <span>Ajouter un chèque reçu</span>
        </button>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="text-xs text-slate-500">En attente d’encaissement</div>
          <div className="mt-1 text-lg font-bold text-amber-700 tabular-nums">
            {formatMoney(totals.pending, defaultCurrency, currencies)}
          </div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="text-xs text-slate-500">Encaissés (trésorerie réelle)</div>
          <div className="mt-1 text-lg font-bold text-emerald-700 tabular-nums">
            {formatMoney(totals.cleared, defaultCurrency, currencies)}
          </div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="text-xs text-slate-500">Rejetés</div>
          <div className="mt-1 text-lg font-bold text-red-700 tabular-nums">
            {formatMoney(totals.rejected, defaultCurrency, currencies)}
          </div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="text-xs text-slate-500">Avances non affectées</div>
          <div className="mt-1 text-lg font-bold text-[#1D4ED8] tabular-nums">
            {formatMoney(totals.advances, defaultCurrency, currencies)}
          </div>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-slate-200 bg-slate-50 font-semibold text-slate-600">
            <tr>
              <th className="px-3 py-2.5">N° Chèque</th>
              <th className="px-3 py-2.5">Client</th>
              <th className="px-3 py-2.5">Banque émettrice</th>
              <th className="px-3 py-2.5">Date entrée</th>
              <th className="px-3 py-2.5">Date chèque</th>
              <th className="px-3 py-2.5">Facture(s) / Type</th>
              <th className="px-3 py-2.5 text-right">Montant</th>
              <th className="px-3 py-2.5">Statut</th>
              <th className="px-3 py-2.5 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {filteredCheques.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-4 py-8 text-center text-sm text-slate-500">
                  Aucun chèque reçu enregistré.
                </td>
              </tr>
            ) : (
              filteredCheques.map((c) => {
                const client = contactMap.get(c.clientId);
                const clientName = client ? client.company || client.name : 'Client';
                const invList = c.allocatedInvoiceIds
                  .map((id) => invoiceMap.get(id)?.invoiceNumber || id)
                  .join(', ');
                const meta = INCOMING_STATUS_META[c.status];
                const isTerminal = c.status === 'annule' || c.status === 'rejete';
                const targetBank = c.targetBankAccountId
                  ? bankMap.get(c.targetBankAccountId)
                  : null;
                const advRemaining = getChequeAdvanceRemaining(c);

                return (
                  <tr key={c.id} className="hover:bg-slate-50">
                    <td className="px-3 py-2.5 font-mono font-semibold text-slate-900 whitespace-nowrap">
                      {c.chequeNumber}
                    </td>
                    <td className="px-3 py-2.5 font-medium text-slate-900">{clientName}</td>
                    <td className="px-3 py-2.5 text-slate-700">{c.issuerBank}</td>
                    <td className="px-3 py-2.5 text-slate-600 tabular-nums whitespace-nowrap">
                      {c.entryDate}
                    </td>
                    <td className="px-3 py-2.5 text-slate-600 tabular-nums whitespace-nowrap">
                      {c.chequeDate}
                    </td>
                    <td className="px-3 py-2.5 text-slate-700">
                      {invList ? (
                        <div>
                          <span>{invList}</span>
                          {advRemaining > 0 && (
                            <div className="text-[10px] font-medium text-[#1D4ED8]">
                              Reste en avance : {formatMoney(advRemaining, c.currency, currencies)}
                            </div>
                          )}
                        </div>
                      ) : (
                        <span className="inline-flex rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-[#1D4ED8]">
                          Avance (non affectée)
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right font-semibold text-emerald-700 tabular-nums whitespace-nowrap">
                      {formatMoney(c.amountCentimes, c.currency, currencies)}
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      <span
                        className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium ${meta.badgeClass}`}
                      >
                        {meta.label}
                      </span>
                      {c.status === 'encaisse' && c.clearingDate && (
                        <div className="mt-0.5 text-[10px] font-normal text-slate-500">
                          {c.clearingDate} {targetBank ? `· ${targetBank.bankName}` : ''}
                        </div>
                      )}
                      {c.status === 'rejete' && (c.rejectionReason || c.cancelReason) && (
                        <div className="mt-0.5 text-[10px] font-normal text-red-600">
                          {c.rejectedAt ? `${c.rejectedAt} · ` : ''}
                          {c.rejectionReason || c.cancelReason}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1.5">
                        {!isTerminal && advRemaining > 0 && (
                          <button
                            type="button"
                            onClick={() => openAllocateModal(c)}
                            className="inline-flex items-center gap-1 rounded border border-blue-300 bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-800 hover:bg-blue-100"
                          >
                            <ArrowRightLeft className="h-3 w-3" />
                            <span>Affecter à une facture</span>
                          </button>
                        )}
                        {!isTerminal && (
                          <>
                            {c.status !== 'encaisse' && (
                              <button
                                type="button"
                                onClick={() => {
                                  setTBankId(c.targetBankAccountId || bankAccounts[0]?.id || '');
                                  setTDate(new Date().toISOString().slice(0, 10));
                                  setTReason('');
                                  setStatusTarget({ cheque: c, nextStatus: 'encaisse' });
                                }}
                                className="inline-flex items-center gap-1 rounded border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-800 hover:bg-emerald-100"
                              >
                                <CheckCircle2 className="h-3 w-3" />
                                <span>Encaisser</span>
                              </button>
                            )}
                            <select
                              value={c.status}
                              onChange={(e) => {
                                const next = e.target.value as IncomingChequeStatus;
                                if (next === c.status) return;
                                if (
                                  next === 'encaisse' ||
                                  next === 'depose' ||
                                  next === 'rejete' ||
                                  next === 'annule'
                                ) {
                                  setTBankId(c.targetBankAccountId || bankAccounts[0]?.id || '');
                                  setTDate(new Date().toISOString().slice(0, 10));
                                  setTReason('');
                                  setStatusTarget({ cheque: c, nextStatus: next });
                                } else {
                                  updateIncomingChequeStatus({ chequeId: c.id, nextStatus: next });
                                }
                              }}
                              className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[11px]"
                            >
                              {Object.entries(INCOMING_STATUS_META).map(([k, v]) => (
                                <option key={k} value={k}>
                                  {v.label}
                                </option>
                              ))}
                            </select>
                          </>
                        )}
                        <button
                          type="button"
                          onClick={() => openEditModal(c)}
                          title="Modifier ce chèque"
                          className="rounded p-1 text-slate-600 hover:bg-slate-100"
                        >
                          <Edit3 className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setDeleteTarget({
                              id: c.id,
                              label: `Chèque reçu N° ${c.chequeNumber}`,
                            })
                          }
                          title="Supprimer (corbeille)"
                          className="rounded p-1 text-red-600 hover:bg-red-50"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Modale Ajout / Modification Chèque Reçu */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-200 bg-[#0F1E36] px-6 py-4 text-white">
              <h2 className="text-base font-semibold">
                {editingChequeId
                  ? `Modifier le chèque reçu N° ${cNumber}`
                  : 'Nouveau chèque reçu (client)'}
              </h2>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="rounded p-1 text-slate-300 hover:bg-slate-800"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <form onSubmit={handleSaveCheque} className="flex-1 overflow-y-auto p-6 space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className="block text-xs font-medium text-slate-700">Client *</label>
                  <select
                    required
                    value={cClientId}
                    onChange={(e) => {
                      setCClientId(e.target.value);
                      setCInvoiceIds([]);
                    }}
                    className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
                  >
                    <option value="">— Sélectionner un client —</option>
                    {clientOptions.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.company || c.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700">Banque émettrice *</label>
                  <input
                    type="text"
                    required
                    value={cIssuerBank}
                    onChange={(e) => setCIssuerBank(e.target.value)}
                    placeholder="Ex : BEA, BNA, CPA, Société Générale..."
                    className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700">
                    N° de chèque (texte) *
                  </label>
                  <input
                    type="text"
                    required
                    value={cNumber}
                    onChange={(e) => setCNumber(e.target.value)}
                    placeholder="0045891"
                    className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-sm"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700">Montant *</label>
                  <input
                    type="text"
                    required
                    value={cAmountText}
                    onChange={(e) => setCAmountText(e.target.value)}
                    className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-right font-semibold tabular-nums"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700">Date d’entrée *</label>
                  <input
                    type="date"
                    required
                    value={cEntryDate}
                    onChange={(e) => setCEntryDate(e.target.value)}
                    className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700">Date du chèque *</label>
                  <input
                    type="date"
                    required
                    value={cChequeDate}
                    onChange={(e) => setCChequeDate(e.target.value)}
                    className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700">
                    Banque destinataire (dépôt)
                  </label>
                  <select
                    value={cTargetBankId}
                    onChange={(e) => setCTargetBankId(e.target.value)}
                    className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
                  >
                    <option value="">— À définir lors de la remise —</option>
                    {bankAccounts
                      .filter((b) => b.active)
                      .map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.bankName} — {b.accountName}
                        </option>
                      ))}
                  </select>
                </div>

                <div className="flex items-end pb-1">
                  <label className="flex cursor-pointer items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-800 w-full">
                    <input
                      type="checkbox"
                      checked={cIsAdvance}
                      onChange={(e) => {
                        setCIsAdvance(e.target.checked);
                        if (e.target.checked) setCInvoiceIds([]);
                      }}
                    />
                    <span>Avance (non liée à une facture)</span>
                  </label>
                </div>

                {isSimple && (
                  <div className="sm:col-span-2">
                    <MoreOptionsButton
                      expanded={showMoreOptions}
                      onToggle={() => setShowMoreOptions((v) => !v)}
                    />
                  </div>
                )}

                {showAdvancedFields && (
                  <>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-xs font-medium text-slate-700">Devise</label>
                        <select
                          value={cCurrency}
                          onChange={(e) => {
                            const code = e.target.value;
                            setCCurrency(code);
                            const cfg = currencies?.find((x) => x.code === code);
                            setCExchangeRate(String(cfg?.rateToDzd || 1));
                          }}
                          className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2.5 py-2 text-sm"
                        >
                          {(currencies || [{ code: 'DZD', name: 'Dinar', symbol: 'DA', rateToDzd: 1 }]).map(
                            (c) => (
                              <option key={c.code} value={c.code}>
                                {c.code}
                              </option>
                            )
                          )}
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-700">Taux DZD</label>
                        <input
                          type="text"
                          disabled={cCurrency === 'DZD'}
                          value={cExchangeRate}
                          onChange={(e) => setCExchangeRate(e.target.value)}
                          className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-2 text-sm text-right tabular-nums disabled:bg-slate-100"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700">Notes</label>
                      <input
                        type="text"
                        value={cNotes}
                        onChange={(e) => setCNotes(e.target.value)}
                        className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                      />
                    </div>
                  </>
                )}
              </div>

              {cClientId && !cIsAdvance && (
                <div className="space-y-2 border-t border-slate-200 pt-3">
                  <label className="block text-xs font-semibold text-slate-800">
                    Facture(s) réglée(s) par ce chèque
                  </label>
                  {clientUnpaidInvoices.length === 0 ? (
                    <div className="rounded bg-slate-50 p-2.5 text-xs text-slate-500">
                      Aucune facture impayée pour ce client (sera compté comme avance client).
                    </div>
                  ) : (
                    <div className="max-h-40 overflow-y-auto divide-y divide-slate-200 rounded border border-slate-200">
                      {clientUnpaidInvoices.map(({ inv, rem }) => {
                        const checked = cInvoiceIds.includes(inv.id);
                        return (
                          <label
                            key={inv.id}
                            className="flex cursor-pointer items-center justify-between px-3 py-2 text-xs hover:bg-slate-50"
                          >
                            <div className="flex items-center gap-2">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={(e) =>
                                  setCInvoiceIds((prev) =>
                                    e.target.checked
                                      ? [...prev, inv.id]
                                      : prev.filter((x) => x !== inv.id)
                                  )
                                }
                              />
                              <span className="font-medium text-slate-900">{inv.invoiceNumber}</span>
                              <span className="text-slate-500">{inv.issueDate}</span>
                            </div>
                            <span className="font-semibold text-red-700 tabular-nums">
                              Reste : {formatMoney(rem, inv.currency)}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              <div className="flex justify-end gap-3 border-t border-slate-200 pt-4">
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700"
                >
                  Annuler
                </button>
                <button
                  type="submit"
                  className="rounded-md bg-emerald-600 px-5 py-2 text-sm font-medium text-white hover:bg-emerald-700"
                >
                  {editingChequeId ? 'Enregistrer les modifications' : 'Enregistrer le chèque reçu'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modale mise à jour statut / encaissement / rejet */}
      {statusTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <form
            onSubmit={handleConfirmStatus}
            className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-6 shadow-xl space-y-4"
          >
            <h3 className="text-base font-semibold text-slate-900">
              Chèque N° {statusTarget.cheque.chequeNumber} →{' '}
              {INCOMING_STATUS_META[statusTarget.nextStatus].label}
            </h3>

            {(statusTarget.nextStatus === 'encaisse' || statusTarget.nextStatus === 'depose') && (
              <>
                <div>
                  <label className="block text-xs font-medium text-slate-700">
                    Banque destinataire *
                  </label>
                  <select
                    required
                    value={tBankId}
                    onChange={(e) => setTBankId(e.target.value)}
                    className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
                  >
                    <option value="">— Choisir une banque —</option>
                    {bankAccounts
                      .filter((b) => b.active)
                      .map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.bankName} — {b.accountName}
                        </option>
                      ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700">
                    {statusTarget.nextStatus === 'encaisse'
                      ? 'Date d’encaissement *'
                      : 'Date de dépôt *'}
                  </label>
                  <input
                    type="date"
                    required
                    value={tDate}
                    onChange={(e) => setTDate(e.target.value)}
                    className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>
              </>
            )}

            {(statusTarget.nextStatus === 'rejete' || statusTarget.nextStatus === 'annule') && (
              <>
                {statusTarget.nextStatus === 'rejete' && (
                  <div>
                    <label className="block text-xs font-medium text-slate-700">
                      Date du rejet *
                    </label>
                    <input
                      type="date"
                      required
                      value={tDate}
                      onChange={(e) => setTDate(e.target.value)}
                      className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                    />
                  </div>
                )}
                <div>
                  <label className="block text-xs font-medium text-slate-700">Motif *</label>
                  <input
                    type="text"
                    required
                    value={tReason}
                    onChange={(e) => setTReason(e.target.value)}
                    placeholder="Ex : Provision insuffisante, signature non conforme..."
                    className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>
                <p className="text-[11px] text-slate-500">
                  Si ce chèque payait une facture, celle-ci repassera automatiquement en « Non payée » (ou « Partielle ») avec mention du rejet.
                </p>
              </>
            )}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setStatusTarget(null)}
                className="rounded-md border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700"
              >
                Fermer
              </button>
              <button
                type="submit"
                className="rounded-md bg-[#0F1E36] px-4 py-2 text-xs font-medium text-white"
              >
                Valider
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Modale affectation chèque d'avance à une ou plusieurs factures */}
      {allocateTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <form
            onSubmit={handleConfirmAllocate}
            className="w-full max-w-xl rounded-lg border border-slate-200 bg-white p-6 shadow-xl space-y-4"
          >
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-base font-semibold text-slate-900">
                  Affecter l’avance — Chèque N° {allocateTarget.chequeNumber}
                </h3>
                <p className="mt-0.5 text-xs text-slate-500">
                  Montant disponible :{' '}
                  <strong className="text-[#1D4ED8] tabular-nums">
                    {formatMoney(
                      getChequeAdvanceRemaining(allocateTarget),
                      allocateTarget.currency,
                      currencies
                    )}
                  </strong>
                </p>
              </div>
              <button
                type="button"
                onClick={() => setAllocateTarget(null)}
                className="rounded p-1 text-slate-400 hover:bg-slate-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {allocateTarget.status !== 'encaisse' && (
              <div className="grid grid-cols-1 gap-3 rounded-md border border-slate-200 bg-slate-50 p-3 sm:grid-cols-2">
                <div>
                  <label className="block text-xs font-medium text-slate-700">
                    Banque d’encaissement *
                  </label>
                  <select
                    required
                    value={allocBankId}
                    onChange={(e) => setAllocBankId(e.target.value)}
                    className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
                  >
                    <option value="">— Choisir une banque —</option>
                    {bankAccounts
                      .filter((b) => b.active)
                      .map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.bankName} — {b.accountName}
                        </option>
                      ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700">
                    Date d’encaissement *
                  </label>
                  <input
                    type="date"
                    required
                    value={allocDate}
                    onChange={(e) => setAllocDate(e.target.value)}
                    className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
                  />
                </div>
              </div>
            )}

            {allocateUnpaidInvoices.length === 0 ? (
              <div className="rounded border border-slate-200 bg-slate-50 p-4 text-center text-xs text-slate-500">
                Ce client n’a actuellement aucune facture impayée à solder.
              </div>
            ) : (
              <div className="max-h-60 overflow-y-auto divide-y divide-slate-200 rounded border border-slate-200">
                {allocateUnpaidInvoices.map(({ inv, rem }) => (
                  <div
                    key={inv.id}
                    className="flex items-center justify-between gap-3 px-3 py-2.5 text-xs"
                  >
                    <div>
                      <div className="font-semibold text-slate-900">{inv.invoiceNumber}</div>
                      <div className="text-[11px] text-slate-500">
                        {inv.issueDate} · Reste dû :{' '}
                        <span className="font-medium text-red-700 tabular-nums">
                          {formatMoney(rem, inv.currency)}
                        </span>
                      </div>
                    </div>
                    <input
                      type="text"
                      value={allocAmounts[inv.id] ?? '0,00'}
                      onChange={(e) =>
                        setAllocAmounts((prev) => ({ ...prev, [inv.id]: e.target.value }))
                      }
                      className="w-32 rounded border border-slate-300 px-2 py-1 text-right font-semibold tabular-nums"
                    />
                  </div>
                ))}
              </div>
            )}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setAllocateTarget(null)}
                className="rounded-md border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700"
              >
                Fermer
              </button>
              <button
                type="submit"
                disabled={allocateUnpaidInvoices.length === 0}
                className="rounded-md bg-[#0F1E36] px-4 py-2 text-xs font-medium text-white hover:bg-[#1a2f52] disabled:opacity-50"
              >
                Affecter l’avance
              </button>
            </div>
          </form>
        </div>
      )}

      <SafeDeleteDialog
        open={Boolean(deleteTarget)}
        entityType="incomingCheque"
        entityId={deleteTarget?.id || ''}
        entityLabel={deleteTarget?.label || ''}
        onClose={() => setDeleteTarget(null)}
      />
    </div>
  );
};
