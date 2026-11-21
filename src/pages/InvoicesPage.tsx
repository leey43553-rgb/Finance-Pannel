import React, { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  ArrowUpDown,
  Ban,
  Edit3,
  FileSpreadsheet,
  Paperclip,
  Plus,
  Printer,
  Search,
  Trash2,
  Wallet,
} from 'lucide-react';
import { db } from '../db/database';
import type { ComputedInvoiceStatus, CustomerInvoice, SupplierInvoice } from '../db/types';
import { cancelInvoice } from '../services/financeActions';
import { exportCustomerInvoiceToModelExcel } from '../services/excelService';
import { useAppStore } from '../store/useAppStore';
import { compareDocumentNumbers, resolveEffectiveCompanyProfile } from '../utils/documentHelpers';
import {
  computeInvoicePaidCentimes,
  computeInvoiceRemainingCentimes,
  computeInvoiceStatus,
} from '../utils/finance';
import { addMoney, formatMoney } from '../utils/money';
import { buildPdfFileName } from '../utils/print';
import { InvoiceFormModal } from '../components/InvoiceFormModal';
import { ExcelInvoiceImportModal } from '../components/ExcelInvoiceImportModal';
import { PaymentModal } from '../components/PaymentModal';
import { PrintDocumentModal } from '../components/PrintDocumentModal';
import { SharedDocumentTemplate } from '../components/SharedDocumentTemplate';
import { AttachmentPreviewModal } from '../components/AttachmentPreviewModal';
import { SafeDeleteDialog } from '../components/SafeDeleteDialog';
import { useUiMode } from '../hooks/useUiMode';

interface InvoicesPageProps {
  mode: 'client' | 'fournisseur';
}

const STATUS_LABELS: Record<ComputedInvoiceStatus, { label: string; colorClass: string }> = {
  impayee: { label: 'Impayée', colorClass: 'text-slate-700' },
  partielle: { label: 'Partielle', colorClass: 'text-amber-700' },
  payee: { label: 'Payée', colorClass: 'text-emerald-700' },
  en_retard: { label: 'En retard', colorClass: 'text-red-700 font-semibold' },
  annulee: { label: 'Annulée', colorClass: 'text-slate-400 line-through' },
};

export const InvoicesPage: React.FC<InvoicesPageProps> = ({ mode }) => {
  const pushToast = useAppStore((s) => s.pushToast);
  const { isSimple } = useUiMode();
  const settings = useLiveQuery(() => db.settings.get('company_settings'));
  const contacts = useLiveQuery(() => db.contacts.filter((c) => !c.deletedAt).toArray(), [], []);
  const customerInvoices = useLiveQuery(
    () => db.customerInvoices.filter((i) => !i.deletedAt).toArray(),
    [],
    []
  );
  const supplierInvoices = useLiveQuery(
    () => db.supplierInvoices.filter((i) => !i.deletedAt).toArray(),
    [],
    []
  );
  const payments = useLiveQuery(() => db.payments.filter((p) => !p.deletedAt).toArray(), [], []);
  const allocations = useLiveQuery(() => db.paymentAllocations.toArray(), [], []);
  const companyProfiles = useLiveQuery(
    () => db.companyProfiles.filter((p) => !p.deletedAt).toArray(),
    [],
    []
  );
  const attachments = useLiveQuery(() => db.documentAttachments.toArray(), [], []);

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'toutes' | ComputedInvoiceStatus>('toutes');
  const [companyFilter, setCompanyFilter] = useState<string>('auto');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [sortBy, setSortBy] = useState<'date' | 'number' | 'ttc' | 'remaining'>('date');
  const [sortAsc, setSortAsc] = useState(false);

  const [formOpen, setFormOpen] = useState(false);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [onlyImported, setOnlyImported] = useState(false);
  const [editingInvoice, setEditingInvoice] = useState<
    CustomerInvoice | SupplierInvoice | undefined
  >(undefined);
  const [paymentTarget, setPaymentTarget] = useState<{
    contactId: string;
    invoiceId: string;
  } | null>(null);
  const [printInvoiceId, setPrintInvoiceId] = useState<string | null>(null);
  const [attModal, setAttModal] = useState<{ parentId: string; title: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; label: string } | null>(null);

  const [cancelTarget, setCancelTarget] = useState<{
    id: string;
    number: string;
  } | null>(null);
  const [cancelReason, setCancelReason] = useState('');

  // Édition rapide inline sur N° BC / Réf / Notes
  const [inlineEdit, setInlineEdit] = useState<{
    id: string;
    field: 'bcNumber' | 'campaignRef' | 'supplierRef' | 'dueDate';
    value: string;
  } | null>(null);

  const defaultCurrency = settings?.defaultCurrency || 'DZD';
  const currencies = settings?.enabledCurrencies;

  const contactMap = useMemo(() => new Map(contacts.map((c) => [c.id, c])), [contacts]);
  const profileMap = useMemo(
    () => new Map(companyProfiles.map((p) => [p.id, p])),
    [companyProfiles]
  );
  const attachmentCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of attachments) {
      map.set(a.parentId, (map.get(a.parentId) || 0) + 1);
    }
    return map;
  }, [attachments]);
  const activeFallbackProfile = useMemo(
    () =>
      companyProfiles.find((p) => p.id === settings?.activeCompanyProfileId) ||
      companyProfiles.find((p) => p.isDefault) ||
      companyProfiles[0],
    [companyProfiles, settings?.activeCompanyProfileId]
  );

  const effectiveCompanyFilterId = useMemo(() => {
    if (mode !== 'client') return null;
    if (companyFilter === 'toutes') return null;
    if (companyFilter === 'auto') {
      return settings?.companyScopeFilter === 'active' ? activeFallbackProfile?.id || null : null;
    }
    return companyFilter;
  }, [mode, companyFilter, settings?.companyScopeFilter, activeFallbackProfile?.id]);

  const enrichedRows = useMemo(() => {
    const validPaymentIds = new Set(
      payments.filter((p) => p.status === 'valide').map((p) => p.id)
    );
    const rawList = mode === 'client' ? customerInvoices : supplierInvoices;
    const q = search.trim().toLowerCase();

    const mapped = rawList
      .map((inv) => {
        const contactId =
          mode === 'client'
            ? (inv as CustomerInvoice).clientId
            : (inv as SupplierInvoice).supplierId;
        const contact = contactMap.get(contactId);
        const contactLabel = contact ? contact.company || contact.name : 'Inconnu';
        const paid = computeInvoicePaidCentimes(inv.id, allocations, validPaymentIds);
        const remaining = computeInvoiceRemainingCentimes(
          inv.totalTtcCentimes,
          paid,
          inv.status
        );
        const computedStatus = computeInvoiceStatus({
          storedStatus: inv.status,
          totalTtcCentimes: inv.totalTtcCentimes,
          paidCentimes: paid,
          dueDate: inv.dueDate,
        });
        const issuerProfile =
          mode === 'client'
            ? resolveEffectiveCompanyProfile({
                companyProfileId: (inv as CustomerInvoice).companyProfileId,
                issuerSnapshot: (inv as CustomerInvoice).issuerSnapshot,
                profileMap,
                fallbackProfile: activeFallbackProfile,
              })
            : activeFallbackProfile;
        return { inv, contactId, contactLabel, paid, remaining, computedStatus, issuerProfile };
      })
      .filter((row) => {
        if (effectiveCompanyFilterId && mode === 'client') {
          const cid = (row.inv as CustomerInvoice).companyProfileId;
          if (cid !== effectiveCompanyFilterId) return false;
        }
        if (statusFilter !== 'toutes' && row.computedStatus !== statusFilter) return false;
        if (onlyImported && mode === 'client' && !(row.inv as CustomerInvoice).isImported) {
          return false;
        }
        if (dateFrom && row.inv.issueDate < dateFrom) return false;
        if (dateTo && row.inv.issueDate > dateTo) return false;
        if (q) {
          const extra =
            mode === 'client'
              ? `${(row.inv as CustomerInvoice).bcNumber} ${(row.inv as CustomerInvoice).campaignRef} ${row.issuerProfile?.name || ''}`
              : (row.inv as SupplierInvoice).supplierRef;
          const hay = `${row.inv.invoiceNumber} ${row.contactLabel} ${row.inv.description} ${extra}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });

    mapped.sort((a, b) => {
      let cmp = 0;
      if (sortBy === 'date') cmp = a.inv.issueDate.localeCompare(b.inv.issueDate);
      else if (sortBy === 'number')
        cmp = compareDocumentNumbers(a.inv.invoiceNumber, b.inv.invoiceNumber);
      else if (sortBy === 'ttc') cmp = a.inv.baseDzdTtcCentimes - b.inv.baseDzdTtcCentimes;
      else if (sortBy === 'remaining') cmp = a.remaining - b.remaining;
      return sortAsc ? cmp : -cmp;
    });

    return mapped;
  }, [
    mode,
    customerInvoices,
    supplierInvoices,
    contacts,
    contactMap,
    profileMap,
    activeFallbackProfile,
    effectiveCompanyFilterId,
    payments,
    allocations,
    search,
    statusFilter,
    onlyImported,
    dateFrom,
    dateTo,
    sortBy,
    sortAsc,
  ]);

  const totals = useMemo(() => {
    let ht = 0;
    let tva = 0;
    let ttc = 0;
    let paid = 0;
    let remaining = 0;
    for (const r of enrichedRows) {
      if (r.computedStatus === 'annulee') continue;
      ht = addMoney(ht, Math.round(r.inv.totalHtCentimes * r.inv.exchangeRate));
      tva = addMoney(tva, Math.round(r.inv.totalTvaCentimes * r.inv.exchangeRate));
      ttc = addMoney(ttc, r.inv.baseDzdTtcCentimes);
      paid = addMoney(paid, Math.round(r.paid * r.inv.exchangeRate));
      remaining = addMoney(remaining, Math.round(r.remaining * r.inv.exchangeRate));
    }
    return { ht, tva, ttc, paid, remaining };
  }, [enrichedRows]);

  const printTarget = useMemo(
    () => enrichedRows.find((r) => r.inv.id === printInvoiceId) || null,
    [enrichedRows, printInvoiceId]
  );

  const commitInlineEdit = async () => {
    if (!inlineEdit) return;
    const val = inlineEdit.value.trim();
    const now = new Date().toISOString();
    if (mode === 'client') {
      const patch: Partial<CustomerInvoice> = { updatedAt: now };
      if (inlineEdit.field === 'bcNumber') patch.bcNumber = val;
      else if (inlineEdit.field === 'campaignRef') patch.campaignRef = val;
      else if (inlineEdit.field === 'dueDate') patch.dueDate = val;
      await db.customerInvoices.update(inlineEdit.id, patch);
    } else {
      const patch: Partial<SupplierInvoice> = { updatedAt: now };
      if (inlineEdit.field === 'supplierRef') patch.supplierRef = val;
      else if (inlineEdit.field === 'dueDate') patch.dueDate = val;
      await db.supplierInvoices.update(inlineEdit.id, patch);
    }
    setInlineEdit(null);
  };

  const handleConfirmCancel = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cancelTarget) return;
    try {
      await cancelInvoice({
        invoiceType: mode,
        invoiceId: cancelTarget.id,
        reason: cancelReason,
      });
      pushToast({
        type: 'info',
        title: 'Facture annulée',
        message: `${cancelTarget.number} conservée dans le journal d’audit.`,
      });
      setCancelTarget(null);
      setCancelReason('');
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Annulation impossible',
        message: err instanceof Error ? err.message : 'Erreur',
      });
    }
  };

  const toggleSort = (col: typeof sortBy) => {
    if (sortBy === col) setSortAsc(!sortAsc);
    else {
      setSortBy(col);
      setSortAsc(col !== 'date');
    }
  };

  return (
    <div className="space-y-5">
      {/* Filtres & Bouton création */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative">
            <Search className="pointer-events-none absolute top-2.5 left-3 h-4 w-4 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Rechercher N°, tiers, BC, campagne..."
              className="w-64 rounded-md border border-slate-300 py-1.5 pr-3 pl-9 text-sm"
            />
          </div>

          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            title="Date de début"
            className="rounded-md border border-slate-300 px-2.5 py-1.5 text-xs"
          />
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            title="Date de fin"
            className="rounded-md border border-slate-300 px-2.5 py-1.5 text-xs"
          />

          {mode === 'client' && companyProfiles.length > 0 && (
            <select
              value={companyFilter}
              onChange={(e) => setCompanyFilter(e.target.value)}
              title="Filtrer par société émettrice"
              className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
            >
              <option value="auto">
                {settings?.companyScopeFilter === 'active'
                  ? `Société active (${activeFallbackProfile?.name || '—'})`
                  : 'Toutes les sociétés'}
              </option>
              {settings?.companyScopeFilter === 'active' && (
                <option value="toutes">Toutes les sociétés</option>
              )}
              {companyProfiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}

          <div className="flex flex-wrap items-center gap-1 rounded-md bg-slate-100 p-1">
            {(
              [
                { id: 'toutes', label: 'Toutes' },
                { id: 'impayee', label: 'Impayées' },
                { id: 'partielle', label: 'Partielles' },
                { id: 'en_retard', label: 'En retard' },
                { id: 'payee', label: 'Payées' },
                { id: 'annulee', label: 'Annulées' },
              ] as const
            ).map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setStatusFilter(s.id)}
                className={`rounded px-2.5 py-1 text-xs font-medium whitespace-nowrap ${
                  statusFilter === s.id
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
          {mode === 'client' && customerInvoices.some((i) => i.isImported) && (
            <button
              type="button"
              onClick={() => setOnlyImported(!onlyImported)}
              className={`rounded-md border px-2.5 py-1 text-xs font-medium whitespace-nowrap ${
                onlyImported
                  ? 'border-[#1D4ED8] bg-blue-50 text-[#1D4ED8]'
                  : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'
              }`}
            >
              Importées Excel
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {mode === 'client' && (
            <button
              type="button"
              onClick={() => setImportModalOpen(true)}
              className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
            >
              <FileSpreadsheet className="h-4 w-4 text-emerald-700" />
              <span>Importer Excel (.xlsx)</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => {
              setEditingInvoice(undefined);
              setFormOpen(true);
            }}
            className="inline-flex items-center gap-2 rounded-md bg-[#0F1E36] px-4 py-2 text-sm font-medium text-white hover:bg-[#1a2f52] whitespace-nowrap"
          >
            <Plus className="h-4 w-4" />
            <span>
              {mode === 'client' ? 'Nouvelle facture client' : 'Nouvelle facture fournisseur'}
            </span>
          </button>
        </div>
      </div>

      {/* Synthèse rapide */}
      <div className={`grid grid-cols-2 gap-4 ${isSimple ? 'sm:grid-cols-3' : 'sm:grid-cols-5'}`}>
        {!isSimple && (
          <>
            <div className="rounded-lg border border-slate-200 bg-white p-3.5">
              <div className="text-xs text-slate-500">Total HT</div>
              <div className="mt-1 text-sm font-bold text-slate-900 tabular-nums">
                {formatMoney(totals.ht, defaultCurrency, currencies)}
              </div>
            </div>
            <div className="rounded-lg border border-slate-200 bg-white p-3.5">
              <div className="text-xs text-slate-500">Total TVA</div>
              <div className="mt-1 text-sm font-bold text-slate-900 tabular-nums">
                {formatMoney(totals.tva, defaultCurrency, currencies)}
              </div>
            </div>
          </>
        )}
        <div className="rounded-lg border border-slate-200 bg-white p-3.5">
          <div className="text-xs text-slate-500">Total TTC</div>
          <div className="mt-1 text-sm font-bold text-slate-900 tabular-nums">
            {formatMoney(totals.ttc, defaultCurrency, currencies)}
          </div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-3.5">
          <div className="text-xs text-slate-500">Payé (validé)</div>
          <div className="mt-1 text-sm font-bold text-emerald-700 tabular-nums">
            {formatMoney(totals.paid, defaultCurrency, currencies)}
          </div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-3.5">
          <div className="text-xs text-slate-500">Reste à {mode === 'client' ? 'encaisser' : 'payer'}</div>
          <div className="mt-1 text-sm font-bold text-red-700 tabular-nums">
            {formatMoney(totals.remaining, defaultCurrency, currencies)}
          </div>
        </div>
      </div>

      {/* Tableau des factures */}
      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-slate-200 bg-slate-50 font-semibold text-slate-600">
            <tr>
              <th className="px-3 py-2.5">
                <button
                  type="button"
                  onClick={() => toggleSort('number')}
                  className="inline-flex items-center gap-1 hover:text-slate-900"
                >
                  <span>N° Facture</span>
                  <ArrowUpDown className="h-3 w-3" />
                </button>
              </th>
              {mode === 'client' && <th className="px-3 py-2.5">Société</th>}
              <th className="px-3 py-2.5">{mode === 'client' ? 'Client' : 'Fournisseur'}</th>
              <th className="px-3 py-2.5">
                <button
                  type="button"
                  onClick={() => toggleSort('date')}
                  className="inline-flex items-center gap-1 hover:text-slate-900"
                >
                  <span>Date</span>
                  <ArrowUpDown className="h-3 w-3" />
                </button>
              </th>
              <th className="px-3 py-2.5">Échéance</th>
              {!isSimple && (
                <>
                  <th className="px-3 py-2.5">{mode === 'client' ? 'N° BC / Campagne' : 'Réf. fournisseur'}</th>
                  <th className="px-3 py-2.5 text-right">HT</th>
                  <th className="px-3 py-2.5 text-right">TVA</th>
                </>
              )}
              <th className="px-3 py-2.5 text-right">
                <button
                  type="button"
                  onClick={() => toggleSort('ttc')}
                  className="inline-flex items-center gap-1 hover:text-slate-900"
                >
                  <span>TTC</span>
                  <ArrowUpDown className="h-3 w-3" />
                </button>
              </th>
              <th className="px-3 py-2.5 text-right">Payé</th>
              <th className="px-3 py-2.5 text-right">
                <button
                  type="button"
                  onClick={() => toggleSort('remaining')}
                  className="inline-flex items-center gap-1 hover:text-slate-900"
                >
                  <span>Reste</span>
                  <ArrowUpDown className="h-3 w-3" />
                </button>
              </th>
              <th className="px-3 py-2.5">Statut</th>
              <th className="px-3 py-2.5 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {enrichedRows.length === 0 ? (
              <tr>
                <td
                  colSpan={isSimple ? (mode === 'client' ? 10 : 9) : mode === 'client' ? 13 : 12}
                  className="px-4 py-8 text-center text-sm text-slate-500"
                >
                  Aucune facture trouvée pour ces critères.
                </td>
              </tr>
            ) : (
              enrichedRows.map(({ inv, contactId, contactLabel, paid, remaining, computedStatus, issuerProfile }) => {
                const statusMeta = STATUS_LABELS[computedStatus];
                const isCancelled = computedStatus === 'annulee';
                return (
                  <tr key={inv.id} className="hover:bg-slate-50">
                    <td className="px-3 py-2.5 font-semibold text-slate-900 whitespace-nowrap">
                      <div className="inline-flex items-center gap-1.5">
                        <span>{inv.invoiceNumber}</span>
                        {mode === 'client' && (inv as CustomerInvoice).isImported && (
                          <span
                            title={
                              (inv as CustomerInvoice).importedFromFile
                                ? `Importée depuis : ${(inv as CustomerInvoice).importedFromFile}`
                                : 'Facture importée depuis Excel'
                            }
                            className="rounded border border-emerald-200 bg-emerald-50 px-1 py-0.5 text-[10px] font-medium text-emerald-700"
                          >
                            Importée
                          </span>
                        )}
                        {mode === 'client' &&
                          (inv as CustomerInvoice).linkedBcRecuId &&
                          (attachmentCounts.get((inv as CustomerInvoice).linkedBcRecuId!) || 0) > 0 && (
                            <button
                              type="button"
                              onClick={() =>
                                setAttModal({
                                  parentId: (inv as CustomerInvoice).linkedBcRecuId!,
                                  title: `Pièce jointe BC — ${(inv as CustomerInvoice).bcNumber || inv.invoiceNumber}`,
                                })
                              }
                              title="Voir le scan / PDF du bon de commande client"
                              className="inline-flex items-center gap-0.5 rounded bg-blue-50 px-1 py-0.5 text-[10px] font-medium text-[#1D4ED8] hover:bg-blue-100"
                            >
                              <Paperclip className="h-3 w-3" />
                            </button>
                          )}
                      </div>
                    </td>
                    {mode === 'client' && (
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-slate-700">
                          <span
                            className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                            style={{ backgroundColor: issuerProfile?.primaryColor || '#FF33CC' }}
                          />
                          <span>{issuerProfile?.name || '—'}</span>
                        </span>
                      </td>
                    )}
                    <td className="px-3 py-2.5 text-slate-800">{contactLabel}</td>
                    <td className="px-3 py-2.5 text-slate-600 tabular-nums whitespace-nowrap">
                      {inv.issueDate}
                    </td>
                    <td className="px-3 py-2.5 text-slate-600 tabular-nums whitespace-nowrap">
                      {inlineEdit?.id === inv.id && inlineEdit.field === 'dueDate' ? (
                        <input
                          type="date"
                          autoFocus
                          value={inlineEdit.value}
                          onChange={(e) =>
                            setInlineEdit({ ...inlineEdit, value: e.target.value })
                          }
                          onBlur={commitInlineEdit}
                          onKeyDown={(e) => e.key === 'Enter' && commitInlineEdit()}
                          className="rounded border border-[#1D4ED8] px-1 py-0.5 text-xs"
                        />
                      ) : (
                        <span
                          onDoubleClick={() =>
                            !isCancelled &&
                            setInlineEdit({ id: inv.id, field: 'dueDate', value: inv.dueDate })
                          }
                          title="Double-cliquez pour modifier l’échéance"
                          className="cursor-text"
                        >
                          {inv.dueDate}
                        </span>
                      )}
                    </td>
                    {!isSimple && (
                      <>
                        <td className="px-3 py-2.5 text-slate-600">
                          {mode === 'client' ? (
                            <div className="flex items-center gap-1.5">
                              {inlineEdit?.id === inv.id && inlineEdit.field === 'bcNumber' ? (
                                <input
                                  type="text"
                                  autoFocus
                                  value={inlineEdit.value}
                                  onChange={(e) =>
                                    setInlineEdit({ ...inlineEdit, value: e.target.value })
                                  }
                                  onBlur={commitInlineEdit}
                                  onKeyDown={(e) => e.key === 'Enter' && commitInlineEdit()}
                                  className="w-28 rounded border border-[#1D4ED8] px-1.5 py-0.5 text-xs"
                                />
                              ) : (
                                <span
                                  onDoubleClick={() =>
                                    !isCancelled &&
                                    setInlineEdit({
                                      id: inv.id,
                                      field: 'bcNumber',
                                      value: (inv as CustomerInvoice).bcNumber,
                                    })
                                  }
                                  title="Double-cliquez pour modifier N° BC"
                                  className="cursor-text"
                                >
                                  {[(inv as CustomerInvoice).bcNumber, (inv as CustomerInvoice).campaignRef]
                                    .filter(Boolean)
                                    .join(' · ') || '—'}
                                </span>
                              )}
                            </div>
                          ) : (
                            (inv as SupplierInvoice).supplierRef || '—'
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-right text-slate-600 tabular-nums whitespace-nowrap">
                          {formatMoney(inv.totalHtCentimes, inv.currency)}
                        </td>
                        <td className="px-3 py-2.5 text-right text-slate-600 tabular-nums whitespace-nowrap">
                          {formatMoney(inv.totalTvaCentimes, inv.currency)}
                        </td>
                      </>
                    )}
                    <td className="px-3 py-2.5 text-right font-semibold text-slate-900 tabular-nums whitespace-nowrap">
                      {formatMoney(inv.totalTtcCentimes, inv.currency)}
                    </td>
                    <td className="px-3 py-2.5 text-right text-emerald-700 tabular-nums whitespace-nowrap">
                      {formatMoney(paid, inv.currency)}
                    </td>
                    <td className="px-3 py-2.5 text-right font-semibold text-red-700 tabular-nums whitespace-nowrap">
                      {formatMoney(remaining, inv.currency)}
                    </td>
                    <td className={`px-3 py-2.5 whitespace-nowrap ${statusMeta.colorClass}`}>
                      {statusMeta.label}
                    </td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1">
                        {!isCancelled && remaining > 0 && (
                          <button
                            type="button"
                            onClick={() =>
                              setPaymentTarget({ contactId, invoiceId: inv.id })
                            }
                            title={mode === 'client' ? 'Enregistrer paiement' : 'Régler facture'}
                            className="rounded p-1 text-emerald-700 hover:bg-emerald-50"
                          >
                            <Wallet className="h-3.5 w-3.5" />
                          </button>
                        )}
                        {mode === 'client' && (
                          <button
                            type="button"
                            onClick={() => {
                              exportCustomerInvoiceToModelExcel({
                                invoice: inv as CustomerInvoice,
                                profile: issuerProfile,
                                contact: contactMap.get(contactId),
                              });
                              pushToast({
                                type: 'success',
                                title: 'Excel facture exporté',
                                message: `Facture ${inv.invoiceNumber} exportée au format Modèle facture (.xlsx).`,
                              });
                            }}
                            title="Exporter au format Excel (.xlsx)"
                            className="rounded p-1 text-emerald-700 hover:bg-emerald-50"
                          >
                            <FileSpreadsheet className="h-3.5 w-3.5" />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setPrintInvoiceId(inv.id)}
                          title="Aperçu & Impression PDF A4"
                          className="rounded p-1 text-slate-600 hover:bg-slate-100"
                        >
                          <Printer className="h-3.5 w-3.5" />
                        </button>
                        {!isCancelled && (
                          <>
                            <button
                              type="button"
                              onClick={() => {
                                setEditingInvoice(inv);
                                setFormOpen(true);
                              }}
                              title="Modifier"
                              className="rounded p-1 text-slate-600 hover:bg-slate-100"
                            >
                              <Edit3 className="h-3.5 w-3.5" />
                            </button>
                            {paid === 0 && (
                              <button
                                type="button"
                                onClick={() =>
                                  setCancelTarget({ id: inv.id, number: inv.invoiceNumber })
                                }
                                title="Annuler la facture"
                                className="rounded p-1 text-amber-600 hover:bg-amber-50"
                              >
                                <Ban className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </>
                        )}
                        <button
                          type="button"
                          onClick={() =>
                            setDeleteTarget({
                              id: inv.id,
                              label: `la facture ${inv.invoiceNumber}`,
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

      {/* Modale Création / Édition */}
      <InvoiceFormModal
        open={formOpen}
        mode={mode}
        existingInvoice={editingInvoice}
        onClose={() => {
          setFormOpen(false);
          setEditingInvoice(undefined);
        }}
      />

      {mode === 'client' && (
        <ExcelInvoiceImportModal
          open={importModalOpen}
          onClose={() => setImportModalOpen(false)}
        />
      )}

      {/* Modale Paiement rapide */}
      {paymentTarget && (
        <PaymentModal
          open={Boolean(paymentTarget)}
          direction={mode === 'client' ? 'entrant' : 'sortant'}
          preselectedContactId={paymentTarget.contactId}
          preselectedInvoiceId={paymentTarget.invoiceId}
          onClose={() => setPaymentTarget(null)}
        />
      )}

      {/* Modale Annulation avec motif obligatoire */}
      {cancelTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <form
            onSubmit={handleConfirmCancel}
            className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-6 shadow-xl space-y-4"
          >
            <h3 className="text-base font-semibold text-slate-900">
              Annuler la facture {cancelTarget.number} ?
            </h3>
            <p className="text-xs text-slate-600">
              Une facture annulée n’est jamais supprimée définitivement : elle reste archivée dans l’historique et le journal d’audit.
            </p>
            <div>
              <label className="block text-xs font-medium text-slate-700">
                Motif d’annulation *
              </label>
              <input
                type="text"
                required
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                placeholder="Ex : Erreur de saisie client, commande annulée..."
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setCancelTarget(null);
                  setCancelReason('');
                }}
                className="rounded-md border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700"
              >
                Fermer
              </button>
              <button
                type="submit"
                className="rounded-md bg-red-600 px-4 py-2 text-xs font-medium text-white hover:bg-red-700"
              >
                Confirmer l’annulation
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Aperçu impression A4 unifié */}
      {printTarget && (() => {
        const resolvedProfile = printTarget.issuerProfile;
        return (
          <PrintDocumentModal
            open={Boolean(printTarget)}
            title={`Facture ${printTarget.inv.invoiceNumber}`}
            fileName={buildPdfFileName(
              mode === 'client' ? 'facture' : 'facture_fournisseur',
              printTarget.inv.invoiceNumber,
              printTarget.contactLabel
            )}
            settings={settings}
            companyProfile={resolvedProfile}
            fallbackPrintRoute={`/imprimer/${mode === 'client' ? 'facture' : 'facture-fournisseur'}/${printTarget.inv.id}`}
            rawLayout
            onExportExcel={
              mode === 'client'
                ? () => {
                    exportCustomerInvoiceToModelExcel({
                      invoice: printTarget.inv as CustomerInvoice,
                      profile: resolvedProfile,
                      contact: contactMap.get(printTarget.contactId),
                    });
                    pushToast({
                      type: 'success',
                      title: 'Excel facture exporté',
                      message: `Facture ${printTarget.inv.invoiceNumber} exportée au format Modèle facture (.xlsx).`,
                    });
                  }
                : undefined
            }
            onClose={() => setPrintInvoiceId(null)}
          >
          <SharedDocumentTemplate
            docKind={mode === 'client' ? 'facture' : 'facture_fournisseur'}
            docNumber={printTarget.inv.invoiceNumber}
            issueDate={printTarget.inv.issueDate}
            dueDate={printTarget.inv.dueDate}
            bcNumber={mode === 'client' ? (printTarget.inv as CustomerInvoice).bcNumber : undefined}
            supplierRef={
              mode === 'fournisseur' ? (printTarget.inv as SupplierInvoice).supplierRef : undefined
            }
            campaignRef={
              mode === 'client' ? (printTarget.inv as CustomerInvoice).campaignRef : undefined
            }
            campaignStartDate={
              mode === 'client' ? (printTarget.inv as CustomerInvoice).campaignStartDate : undefined
            }
            campaignEndDate={
              mode === 'client' ? (printTarget.inv as CustomerInvoice).campaignEndDate : undefined
            }
            showCampaignOnPrint={
              mode === 'client'
                ? (printTarget.inv as CustomerInvoice).showCampaignOnPrint
                : false
            }
            profile={resolvedProfile}
            settings={settings}
            contact={contactMap.get(printTarget.contactId)}
            clientSnapshot={
              mode === 'client' ? (printTarget.inv as CustomerInvoice).clientSnapshot : undefined
            }
            currency={printTarget.inv.currency}
            lines={printTarget.inv.lines}
            totalHtCentimes={printTarget.inv.totalHtCentimes}
            totalTvaCentimes={printTarget.inv.totalTvaCentimes}
            totalTtcCentimes={printTarget.inv.totalTtcCentimes}
            paidCentimes={printTarget.paid}
            remainingCentimes={printTarget.remaining}
            amountInWordsOverride={
              mode === 'client'
                ? (printTarget.inv as CustomerInvoice).amountInWordsOverride
                : undefined
            }
            notes={printTarget.inv.notes}
          />
        </PrintDocumentModal>
        );
      })()}

      {attModal && (
        <AttachmentPreviewModal
          open={Boolean(attModal)}
          parentId={attModal.parentId}
          parentType="bc_recu"
          title={attModal.title}
          readOnly
          onClose={() => setAttModal(null)}
        />
      )}

      <SafeDeleteDialog
        open={Boolean(deleteTarget)}
        entityType={mode === 'client' ? 'customerInvoice' : 'supplierInvoice'}
        entityId={deleteTarget?.id || ''}
        entityLabel={deleteTarget?.label || ''}
        onClose={() => setDeleteTarget(null)}
      />
    </div>
  );
};
