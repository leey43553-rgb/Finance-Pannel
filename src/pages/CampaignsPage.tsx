import React, { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  ArrowUpDown,
  Calendar,
  ClipboardList,
  Edit3,
  Eye,
  FileCheck2,
  FileText,
  Link2,
  Megaphone,
  Paperclip,
  Plus,
  Search,
  Trash2,
  Unlink,
  X,
} from 'lucide-react';
import { db } from '../db/database';
import type {
  Campaign,
  CampaignStatus,
  CustomerInvoice,
  Proforma,
  PurchaseOrder,
} from '../db/types';
import { linkOrUnlinkDocumentToCampaign, saveCampaign } from '../services/documentActions';
import {
  computeBcRecuInvoicingStatus,
  computeCampaignDuration,
  formatDateFr,
  getEffectiveCampaignStatus,
  getEffectiveProformaStatus,
} from '../utils/documentHelpers';
import { computeInvoicePaidCentimes } from '../utils/finance';
import { addMoney, formatMoney, subtractMoney } from '../utils/money';
import { useAppStore } from '../store/useAppStore';
import { CampaignFormModal } from '../components/CampaignFormModal';
import { PurchaseOrderFormModal } from '../components/PurchaseOrderFormModal';
import { ProformaFormModal } from '../components/ProformaFormModal';
import { InvoiceFormModal } from '../components/InvoiceFormModal';
import { AttachmentPreviewModal } from '../components/AttachmentPreviewModal';
import { SafeDeleteDialog } from '../components/SafeDeleteDialog';

const CAMPAIGN_STATUS_META: Record<
  CampaignStatus,
  { label: string; badgeClass: string }
> = {
  prevue: { label: 'Prévue', badgeClass: 'bg-slate-100 text-slate-700' },
  en_cours: { label: 'En cours', badgeClass: 'bg-blue-100 text-blue-800' },
  terminee: { label: 'Terminée', badgeClass: 'bg-emerald-100 text-emerald-800' },
  annulee: { label: 'Annulée', badgeClass: 'bg-red-100 text-red-700' },
};

const MONTH_OPTIONS = [
  { value: '01', label: 'Janvier' },
  { value: '02', label: 'Février' },
  { value: '03', label: 'Mars' },
  { value: '04', label: 'Avril' },
  { value: '05', label: 'Mai' },
  { value: '06', label: 'Juin' },
  { value: '07', label: 'Juillet' },
  { value: '08', label: 'Août' },
  { value: '09', label: 'Septembre' },
  { value: '10', label: 'Octobre' },
  { value: '11', label: 'Novembre' },
  { value: '12', label: 'Décembre' },
];

type SortColumn =
  | 'name'
  | 'client'
  | 'startDate'
  | 'endDate'
  | 'duration'
  | 'invoicedTtc'
  | 'collected'
  | 'remaining'
  | 'status';

type InlineEditCell =
  | { id: string; field: 'name'; value: string }
  | { id: string; field: 'clientId'; value: string }
  | { id: string; field: 'startDate'; value: string }
  | { id: string; field: 'endDate'; value: string }
  | { id: string; field: 'status'; value: CampaignStatus }
  | { id: string; field: 'notes'; value: string };

export const CampaignsPage: React.FC = () => {
  const pushToast = useAppStore((s) => s.pushToast);
  const settings = useLiveQuery(() => db.settings.get('company_settings'));
  const campaigns = useLiveQuery(
    () => db.campaigns.filter((c) => !c.deletedAt).toArray(),
    [],
    []
  );
  const contacts = useLiveQuery(
    () => db.contacts.filter((c) => !c.deletedAt).toArray(),
    [],
    []
  );
  const purchaseOrders = useLiveQuery(
    () => db.purchaseOrders.filter((p) => !p.deletedAt).toArray(),
    [],
    []
  );
  const proformas = useLiveQuery(
    () => db.proformas.filter((p) => !p.deletedAt).toArray(),
    [],
    []
  );
  const customerInvoices = useLiveQuery(
    () => db.customerInvoices.filter((i) => !i.deletedAt).toArray(),
    [],
    []
  );
  const payments = useLiveQuery(
    () => db.payments.filter((p) => !p.deletedAt).toArray(),
    [],
    []
  );
  const allocations = useLiveQuery(() => db.paymentAllocations.toArray(), [], []);
  const attachments = useLiveQuery(() => db.documentAttachments.toArray(), [], []);

  const [search, setSearch] = useState('');
  const [clientFilter, setClientFilter] = useState('tous');
  const [yearFilter, setYearFilter] = useState('toutes');
  const [monthFilter, setMonthFilter] = useState('tous');
  const [statusFilter, setStatusFilter] = useState<'tous' | CampaignStatus>('tous');
  const [sortBy, setSortBy] = useState<SortColumn>('startDate');
  const [sortAsc, setSortAsc] = useState(false);

  const [editingCell, setEditingCell] = useState<InlineEditCell | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editingCampaign, setEditingCampaign] = useState<Campaign | undefined>(undefined);
  const [detailCampaignId, setDetailCampaignId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; label: string } | null>(null);

  // Rattachement rapide de documents existants dans la fiche campagne
  const [attachBcId, setAttachBcId] = useState('');
  const [attachPfId, setAttachPfId] = useState('');
  const [attachInvId, setAttachInvId] = useState('');

  // Modales rapides depuis le détail campagne
  const [poModalOpen, setPoModalOpen] = useState(false);
  const [editingPo, setEditingPo] = useState<PurchaseOrder | undefined>(undefined);
  const [proformaModalOpen, setProformaModalOpen] = useState(false);
  const [editingProforma, setEditingProforma] = useState<Proforma | undefined>(undefined);
  const [prefillPoForProforma, setPrefillPoForProforma] = useState<PurchaseOrder | undefined>(undefined);
  const [invoiceModalOpen, setInvoiceModalOpen] = useState(false);
  const [editingInvoice, setEditingInvoice] = useState<CustomerInvoice | undefined>(undefined);
  const [prefillPoForInvoice, setPrefillPoForInvoice] = useState<PurchaseOrder | undefined>(undefined);
  const [attModal, setAttModal] = useState<{ parentId: string; title: string } | null>(null);

  const defaultCurrency = settings?.defaultCurrency || 'DZD';
  const currencies = settings?.enabledCurrencies;

  const contactMap = useMemo(() => new Map(contacts.map((c) => [c.id, c])), [contacts]);

  const attachmentCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of attachments) {
      map.set(a.parentId, (map.get(a.parentId) || 0) + 1);
    }
    return map;
  }, [attachments]);

  const validPaymentIds = useMemo(
    () => new Set(payments.filter((p) => p.status === 'valide').map((p) => p.id)),
    [payments]
  );

  const clientOptions = useMemo(
    () =>
      contacts
        .filter((c) => c.type === 'client' || c.type === 'les_deux')
        .sort((a, b) => (a.company || a.name).localeCompare(b.company || b.name, 'fr')),
    [contacts]
  );

  const yearOptions = useMemo(() => {
    const set = new Set<string>();
    for (const cmp of campaigns) {
      const y = (cmp.startDate || '').slice(0, 4);
      if (/^\d{4}$/.test(y)) set.add(y);
    }
    return Array.from(set).sort((a, b) => b.localeCompare(a));
  }, [campaigns]);

  const enrichedRows = useMemo(() => {
    const q = search.trim().toLowerCase();

    const list = campaigns
      .map((cmp) => {
        const client = contactMap.get(cmp.clientId);
        const clientLabel = client ? client.company || client.name : 'Client inconnu';
        const effectiveStatus = getEffectiveCampaignStatus(cmp);
        const duration = computeCampaignDuration(cmp.startDate, cmp.endDate);
        const nameLower = cmp.name.trim().toLowerCase();

        const cmpBcs = purchaseOrders.filter(
          (po) =>
            po.direction === 'bc_recu' &&
            (po.campaignId === cmp.id ||
              (!po.campaignId &&
                po.contactId === cmp.clientId &&
                po.campaignRef.trim().toLowerCase() === nameLower))
        );

        const cmpProformas = proformas.filter(
          (pf) =>
            pf.campaignId === cmp.id ||
            (!pf.campaignId &&
              pf.clientId === cmp.clientId &&
              pf.campaignRef.trim().toLowerCase() === nameLower)
        );

        const cmpInvoices = customerInvoices.filter(
          (inv) =>
            inv.campaignId === cmp.id ||
            (!inv.campaignId &&
              inv.clientId === cmp.clientId &&
              inv.campaignRef.trim().toLowerCase() === nameLower)
        );

        let proformaTotalBase = 0;
        for (const pf of cmpProformas) {
          const eff = getEffectiveProformaStatus(pf);
          if (eff === 'refuse') continue;
          proformaTotalBase = addMoney(proformaTotalBase, pf.baseDzdTtcCentimes);
        }

        let invoicedHtBase = 0;
        let invoicedTtcBase = 0;
        let collectedBase = 0;
        const cmpInvoiceIds = new Set<string>();

        for (const inv of cmpInvoices) {
          if (inv.status === 'annulee') continue;
          cmpInvoiceIds.add(inv.id);
          invoicedHtBase = addMoney(
            invoicedHtBase,
            Math.round(inv.totalHtCentimes * inv.exchangeRate)
          );
          invoicedTtcBase = addMoney(invoicedTtcBase, inv.baseDzdTtcCentimes);
          const paidNative = computeInvoicePaidCentimes(inv.id, allocations, validPaymentIds);
          collectedBase = addMoney(
            collectedBase,
            Math.round(paidNative * inv.exchangeRate)
          );
        }

        const remainingBase = Math.max(0, subtractMoney(invoicedTtcBase, collectedBase));

        const allocByPayment = new Map<string, number>();
        for (const a of allocations) {
          if (
            a.invoiceType === 'client' &&
            cmpInvoiceIds.has(a.invoiceId) &&
            validPaymentIds.has(a.paymentId)
          ) {
            allocByPayment.set(
              a.paymentId,
              addMoney(allocByPayment.get(a.paymentId) || 0, a.amountCentimes)
            );
          }
        }
        const cmpPayments = payments
          .filter((p) => allocByPayment.has(p.id))
          .map((p) => ({
            payment: p,
            allocatedForCampaign: allocByPayment.get(p.id) || 0,
          }))
          .sort((a, b) => b.payment.date.localeCompare(a.payment.date));

        return {
          cmp,
          clientLabel,
          effectiveStatus,
          duration,
          cmpBcs,
          cmpProformas,
          cmpInvoices,
          cmpPayments,
          proformaTotalBase,
          invoicedHtBase,
          invoicedTtcBase,
          collectedBase,
          remainingBase,
        };
      })
      .filter((row) => {
        if (clientFilter !== 'tous' && row.cmp.clientId !== clientFilter) return false;
        if (yearFilter !== 'toutes' && !(row.cmp.startDate || '').startsWith(yearFilter))
          return false;
        if (monthFilter !== 'tous' && (row.cmp.startDate || '').slice(5, 7) !== monthFilter)
          return false;
        if (statusFilter !== 'tous' && row.effectiveStatus !== statusFilter) return false;
        if (q) {
          const hay = `${row.cmp.name} ${row.clientLabel} ${row.cmp.notes}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });

    list.sort((a, b) => {
      let cmp = 0;
      switch (sortBy) {
        case 'name':
          cmp = a.cmp.name.localeCompare(b.cmp.name, 'fr');
          break;
        case 'client':
          cmp = a.clientLabel.localeCompare(b.clientLabel, 'fr');
          break;
        case 'startDate':
          cmp = (a.cmp.startDate || '').localeCompare(b.cmp.startDate || '');
          break;
        case 'endDate':
          cmp = (a.cmp.endDate || '').localeCompare(b.cmp.endDate || '');
          break;
        case 'duration':
          cmp = a.duration.days - b.duration.days;
          break;
        case 'invoicedTtc':
          cmp = a.invoicedTtcBase - b.invoicedTtcBase;
          break;
        case 'collected':
          cmp = a.collectedBase - b.collectedBase;
          break;
        case 'remaining':
          cmp = a.remainingBase - b.remainingBase;
          break;
        case 'status':
          cmp = a.effectiveStatus.localeCompare(b.effectiveStatus);
          break;
      }
      return sortAsc ? cmp : -cmp;
    });

    return list;
  }, [
    campaigns,
    contactMap,
    purchaseOrders,
    proformas,
    customerInvoices,
    payments,
    allocations,
    validPaymentIds,
    search,
    clientFilter,
    yearFilter,
    monthFilter,
    statusFilter,
    sortBy,
    sortAsc,
  ]);

  const totals = useMemo(() => {
    let invoicedTtc = 0;
    let collected = 0;
    let remaining = 0;
    for (const r of enrichedRows) {
      invoicedTtc = addMoney(invoicedTtc, r.invoicedTtcBase);
      collected = addMoney(collected, r.collectedBase);
      remaining = addMoney(remaining, r.remainingBase);
    }
    return { invoicedTtc, collected, remaining };
  }, [enrichedRows]);

  const detailRow = useMemo(
    () => enrichedRows.find((r) => r.cmp.id === detailCampaignId) || null,
    [enrichedRows, detailCampaignId]
  );

  const attachableDocs = useMemo(() => {
    if (!detailRow) return { bcs: [], pfs: [], invs: [] };
    const attachedBcIds = new Set(detailRow.cmpBcs.map((b) => b.id));
    const attachedPfIds = new Set(detailRow.cmpProformas.map((p) => p.id));
    const attachedInvIds = new Set(detailRow.cmpInvoices.map((i) => i.id));
    return {
      bcs: purchaseOrders.filter(
        (p) => p.direction === 'bc_recu' && !attachedBcIds.has(p.id)
      ),
      pfs: proformas.filter((p) => !attachedPfIds.has(p.id)),
      invs: customerInvoices.filter((i) => i.status !== 'annulee' && !attachedInvIds.has(i.id)),
    };
  }, [detailRow, purchaseOrders, proformas, customerInvoices]);

  const toggleSort = (col: SortColumn) => {
    if (sortBy === col) setSortAsc(!sortAsc);
    else {
      setSortBy(col);
      setSortAsc(col === 'name' || col === 'client');
    }
  };

  const commitInlineEdit = async (overrideCell?: InlineEditCell) => {
    const cell = overrideCell || editingCell;
    if (!cell) return;
    const cmp = campaigns.find((c) => c.id === cell.id);
    setEditingCell(null);
    if (!cmp) return;

    const nextName = cell.field === 'name' ? cell.value.trim() : cmp.name;
    const nextClientId = cell.field === 'clientId' ? cell.value : cmp.clientId;
    const nextStart = cell.field === 'startDate' ? cell.value : cmp.startDate;
    const nextEnd = cell.field === 'endDate' ? cell.value : cmp.endDate;
    const nextStatus = cell.field === 'status' ? cell.value : cmp.status;
    const nextNotes = cell.field === 'notes' ? cell.value.trim() : cmp.notes;

    if (
      nextName === cmp.name &&
      nextClientId === cmp.clientId &&
      nextStart === cmp.startDate &&
      nextEnd === cmp.endDate &&
      nextStatus === cmp.status &&
      nextNotes === cmp.notes
    ) {
      return;
    }

    try {
      await saveCampaign({
        existingId: cmp.id,
        name: nextName || cmp.name,
        clientId: nextClientId,
        companyProfileId: cmp.companyProfileId,
        startDate: nextStart,
        endDate: nextEnd,
        status: nextStatus,
        notes: nextNotes,
        propagateToLinkedDocs: true,
        propagateClient: nextClientId !== cmp.clientId,
      });
      pushToast({ type: 'success', title: 'Campagne mise à jour' });
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Modification impossible',
        message: err instanceof Error ? err.message : 'Erreur',
      });
    }
  };

  const handleLinkDoc = async (docType: 'bc' | 'proforma' | 'invoice', docId: string) => {
    if (!detailRow || !docId) return;
    try {
      await linkOrUnlinkDocumentToCampaign({
        campaignId: detailRow.cmp.id,
        docType,
        docId,
        link: true,
      });
      if (docType === 'bc') setAttachBcId('');
      else if (docType === 'proforma') setAttachPfId('');
      else setAttachInvId('');
      pushToast({ type: 'success', title: 'Document rattaché à la campagne' });
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Erreur',
        message: err instanceof Error ? err.message : 'Erreur',
      });
    }
  };

  const handleUnlinkDoc = async (
    e: React.MouseEvent,
    docType: 'bc' | 'proforma' | 'invoice',
    docId: string
  ) => {
    e.stopPropagation();
    if (!detailRow) return;
    try {
      await linkOrUnlinkDocumentToCampaign({
        campaignId: detailRow.cmp.id,
        docType,
        docId,
        link: false,
      });
      pushToast({ type: 'info', title: 'Document détaché de la campagne' });
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Erreur',
        message: err instanceof Error ? err.message : 'Erreur',
      });
    }
  };

  return (
    <div className="space-y-5">
      {/* Barre filtres + bouton création */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="relative">
            <Search className="pointer-events-none absolute top-2.5 left-3 h-4 w-4 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Rechercher campagne, client..."
              className="w-56 rounded-md border border-slate-300 py-1.5 pr-3 pl-9 text-sm"
            />
          </div>

          <select
            value={clientFilter}
            onChange={(e) => setClientFilter(e.target.value)}
            className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
          >
            <option value="tous">Tous les clients</option>
            {clientOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.company || c.name}
              </option>
            ))}
          </select>

          <select
            value={yearFilter}
            onChange={(e) => setYearFilter(e.target.value)}
            className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
          >
            <option value="toutes">Toutes années</option>
            {yearOptions.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>

          <select
            value={monthFilter}
            onChange={(e) => setMonthFilter(e.target.value)}
            className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
          >
            <option value="tous">Tous mois</option>
            {MONTH_OPTIONS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>

          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as 'tous' | CampaignStatus)}
            className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
          >
            <option value="tous">Tous statuts</option>
            <option value="prevue">Prévue</option>
            <option value="en_cours">En cours</option>
            <option value="terminee">Terminée</option>
            <option value="annulee">Annulée</option>
          </select>
        </div>

        <button
          type="button"
          onClick={() => {
            setEditingCampaign(undefined);
            setFormOpen(true);
          }}
          className="inline-flex items-center gap-2 rounded-md bg-[#0F1E36] px-4 py-2 text-sm font-medium text-white hover:bg-[#1a2f52] whitespace-nowrap"
        >
          <Plus className="h-4 w-4" />
          <span>Nouvelle campagne</span>
        </button>
      </div>

      {/* KPI Synthèse */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="rounded-lg border border-slate-200 bg-white p-3.5">
          <div className="text-xs text-slate-500">Campagnes affichées</div>
          <div className="mt-1 text-base font-bold text-slate-900 tabular-nums">
            {enrichedRows.length}
          </div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-3.5">
          <div className="text-xs text-slate-500">Total facturé TTC</div>
          <div className="mt-1 text-base font-bold text-slate-900 tabular-nums">
            {formatMoney(totals.invoicedTtc, defaultCurrency, currencies)}
          </div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-3.5">
          <div className="text-xs text-slate-500">Total encaissé</div>
          <div className="mt-1 text-base font-bold text-emerald-700 tabular-nums">
            {formatMoney(totals.collected, defaultCurrency, currencies)}
          </div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-3.5">
          <div className="text-xs text-slate-500">Reste à encaisser</div>
          <div className="mt-1 text-base font-bold text-red-700 tabular-nums">
            {formatMoney(totals.remaining, defaultCurrency, currencies)}
          </div>
        </div>
      </div>

      {/* Tableau des campagnes */}
      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-slate-200 bg-slate-50 font-semibold text-slate-600">
            <tr>
              <th className="px-3 py-2.5">
                <button
                  type="button"
                  onClick={() => toggleSort('name')}
                  className="inline-flex items-center gap-1 hover:text-slate-900"
                >
                  <span>Campagne</span>
                  <ArrowUpDown className="h-3 w-3" />
                </button>
              </th>
              <th className="px-3 py-2.5">
                <button
                  type="button"
                  onClick={() => toggleSort('client')}
                  className="inline-flex items-center gap-1 hover:text-slate-900"
                >
                  <span>Client</span>
                  <ArrowUpDown className="h-3 w-3" />
                </button>
              </th>
              <th className="px-3 py-2.5">
                <button
                  type="button"
                  onClick={() => toggleSort('startDate')}
                  className="inline-flex items-center gap-1 hover:text-slate-900"
                >
                  <span>Début</span>
                  <ArrowUpDown className="h-3 w-3" />
                </button>
              </th>
              <th className="px-3 py-2.5">
                <button
                  type="button"
                  onClick={() => toggleSort('endDate')}
                  className="inline-flex items-center gap-1 hover:text-slate-900"
                >
                  <span>Fin</span>
                  <ArrowUpDown className="h-3 w-3" />
                </button>
              </th>
              <th className="px-3 py-2.5">
                <button
                  type="button"
                  onClick={() => toggleSort('duration')}
                  className="inline-flex items-center gap-1 hover:text-slate-900"
                >
                  <span>Durée</span>
                  <ArrowUpDown className="h-3 w-3" />
                </button>
              </th>
              <th className="px-3 py-2.5 text-center">Docs liés</th>
              <th className="px-3 py-2.5 text-right">
                <button
                  type="button"
                  onClick={() => toggleSort('invoicedTtc')}
                  className="inline-flex items-center gap-1 hover:text-slate-900"
                >
                  <span>Facturé TTC</span>
                  <ArrowUpDown className="h-3 w-3" />
                </button>
              </th>
              <th className="px-3 py-2.5 text-right">
                <button
                  type="button"
                  onClick={() => toggleSort('collected')}
                  className="inline-flex items-center gap-1 hover:text-slate-900"
                >
                  <span>Encaissé</span>
                  <ArrowUpDown className="h-3 w-3" />
                </button>
              </th>
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
              <th className="px-3 py-2.5">
                <button
                  type="button"
                  onClick={() => toggleSort('status')}
                  className="inline-flex items-center gap-1 hover:text-slate-900"
                >
                  <span>Statut</span>
                  <ArrowUpDown className="h-3 w-3" />
                </button>
              </th>
              <th className="px-3 py-2.5 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {enrichedRows.length === 0 ? (
              <tr>
                <td colSpan={11} className="px-4 py-10 text-center text-sm text-slate-500">
                  Aucune campagne trouvée pour ces critères.
                </td>
              </tr>
            ) : (
              enrichedRows.map((row) => {
                const st = CAMPAIGN_STATUS_META[row.effectiveStatus];
                const isEditingName =
                  editingCell?.id === row.cmp.id && editingCell.field === 'name';
                const isEditingNotes =
                  editingCell?.id === row.cmp.id && editingCell.field === 'notes';
                const isEditingClient =
                  editingCell?.id === row.cmp.id && editingCell.field === 'clientId';
                const isEditingStart =
                  editingCell?.id === row.cmp.id && editingCell.field === 'startDate';
                const isEditingEnd =
                  editingCell?.id === row.cmp.id && editingCell.field === 'endDate';
                const isEditingStatus =
                  editingCell?.id === row.cmp.id && editingCell.field === 'status';

                return (
                  <tr
                    key={row.cmp.id}
                    onClick={() => setDetailCampaignId(row.cmp.id)}
                    className="cursor-pointer hover:bg-slate-50"
                  >
                    <td
                      className="px-3 py-2.5 font-semibold text-slate-900"
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        setEditingCell({ id: row.cmp.id, field: 'name', value: row.cmp.name });
                      }}
                      title="Double-cliquez pour modifier le nom"
                    >
                      {isEditingName ? (
                        <input
                          type="text"
                          autoFocus
                          value={editingCell.value}
                          onChange={(e) =>
                            setEditingCell({ ...editingCell, value: e.target.value })
                          }
                          onBlur={() => commitInlineEdit()}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              commitInlineEdit();
                            } else if (e.key === 'Escape') {
                              setEditingCell(null);
                            }
                          }}
                          onClick={(e) => e.stopPropagation()}
                          className="w-full rounded border border-[#1D4ED8] bg-white px-2 py-1 text-xs font-semibold"
                        />
                      ) : (
                        <div className="flex items-center gap-1.5">
                          <Megaphone className="h-3.5 w-3.5 shrink-0 text-[#1D4ED8]" />
                          <span>{row.cmp.name}</span>
                        </div>
                      )}
                      {isEditingNotes ? (
                        <input
                          type="text"
                          autoFocus
                          value={editingCell.value}
                          onChange={(e) =>
                            setEditingCell({ ...editingCell, value: e.target.value })
                          }
                          onBlur={() => commitInlineEdit()}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              commitInlineEdit();
                            } else if (e.key === 'Escape') {
                              setEditingCell(null);
                            }
                          }}
                          onClick={(e) => e.stopPropagation()}
                          placeholder="Notes..."
                          className="mt-1 w-full rounded border border-[#1D4ED8] bg-white px-1.5 py-0.5 text-[11px] font-normal"
                        />
                      ) : row.cmp.notes ? (
                        <div
                          onDoubleClick={(e) => {
                            e.stopPropagation();
                            setEditingCell({
                              id: row.cmp.id,
                              field: 'notes',
                              value: row.cmp.notes,
                            });
                          }}
                          className="mt-0.5 max-w-[220px] truncate text-[10px] font-normal text-slate-500"
                          title={row.cmp.notes}
                        >
                          {row.cmp.notes}
                        </div>
                      ) : null}
                    </td>

                    <td
                      className="px-3 py-2.5 text-slate-700"
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        setEditingCell({
                          id: row.cmp.id,
                          field: 'clientId',
                          value: row.cmp.clientId,
                        });
                      }}
                      title="Double-cliquez pour changer le client"
                    >
                      {isEditingClient ? (
                        <select
                          autoFocus
                          value={editingCell.value}
                          onChange={(e) =>
                            commitInlineEdit({
                              id: row.cmp.id,
                              field: 'clientId',
                              value: e.target.value,
                            })
                          }
                          onBlur={() => setEditingCell(null)}
                          onClick={(e) => e.stopPropagation()}
                          className="rounded border border-[#1D4ED8] bg-white px-1.5 py-1 text-xs"
                        >
                          {clientOptions.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.company || c.name}
                            </option>
                          ))}
                        </select>
                      ) : (
                        row.clientLabel
                      )}
                    </td>

                    <td
                      className="px-3 py-2.5 text-slate-600 tabular-nums whitespace-nowrap"
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        setEditingCell({
                          id: row.cmp.id,
                          field: 'startDate',
                          value: row.cmp.startDate || '',
                        });
                      }}
                      title="Double-cliquez pour modifier la date de début"
                    >
                      {isEditingStart ? (
                        <input
                          type="date"
                          autoFocus
                          value={editingCell.value}
                          onChange={(e) =>
                            setEditingCell({ ...editingCell, value: e.target.value })
                          }
                          onBlur={() => commitInlineEdit()}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitInlineEdit();
                            else if (e.key === 'Escape') setEditingCell(null);
                          }}
                          onClick={(e) => e.stopPropagation()}
                          className="rounded border border-[#1D4ED8] bg-white px-1.5 py-0.5 text-xs"
                        />
                      ) : row.cmp.startDate ? (
                        formatDateFr(row.cmp.startDate)
                      ) : (
                        '—'
                      )}
                    </td>

                    <td
                      className="px-3 py-2.5 text-slate-600 tabular-nums whitespace-nowrap"
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        setEditingCell({
                          id: row.cmp.id,
                          field: 'endDate',
                          value: row.cmp.endDate || '',
                        });
                      }}
                      title="Double-cliquez pour modifier la date de fin"
                    >
                      {isEditingEnd ? (
                        <input
                          type="date"
                          autoFocus
                          value={editingCell.value}
                          onChange={(e) =>
                            setEditingCell({ ...editingCell, value: e.target.value })
                          }
                          onBlur={() => commitInlineEdit()}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitInlineEdit();
                            else if (e.key === 'Escape') setEditingCell(null);
                          }}
                          onClick={(e) => e.stopPropagation()}
                          className="rounded border border-[#1D4ED8] bg-white px-1.5 py-0.5 text-xs"
                        />
                      ) : row.cmp.endDate ? (
                        formatDateFr(row.cmp.endDate)
                      ) : (
                        '—'
                      )}
                    </td>

                    <td className="px-3 py-2.5 text-slate-700 whitespace-nowrap">
                      {row.cmp.startDate && row.cmp.endDate ? row.duration.label : '—'}
                    </td>

                    <td className="px-3 py-2.5 text-center text-slate-600 whitespace-nowrap">
                      {row.cmpBcs.length} BC · {row.cmpProformas.length} PF · {row.cmpInvoices.length} Fac
                    </td>
                    <td className="px-3 py-2.5 text-right font-semibold text-slate-900 tabular-nums whitespace-nowrap">
                      {formatMoney(row.invoicedTtcBase, defaultCurrency, currencies)}
                    </td>
                    <td className="px-3 py-2.5 text-right text-emerald-700 tabular-nums whitespace-nowrap">
                      {formatMoney(row.collectedBase, defaultCurrency, currencies)}
                    </td>
                    <td
                      className={`px-3 py-2.5 text-right font-semibold tabular-nums whitespace-nowrap ${
                        row.remainingBase > 0 ? 'text-red-700' : 'text-slate-600'
                      }`}
                    >
                      {formatMoney(row.remainingBase, defaultCurrency, currencies)}
                    </td>

                    <td
                      className="px-3 py-2.5 whitespace-nowrap"
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        setEditingCell({
                          id: row.cmp.id,
                          field: 'status',
                          value: row.cmp.status,
                        });
                      }}
                      title="Double-cliquez pour changer le statut"
                    >
                      {isEditingStatus ? (
                        <select
                          autoFocus
                          value={editingCell.value}
                          onChange={(e) =>
                            commitInlineEdit({
                              id: row.cmp.id,
                              field: 'status',
                              value: e.target.value as CampaignStatus,
                            })
                          }
                          onBlur={() => setEditingCell(null)}
                          onClick={(e) => e.stopPropagation()}
                          className="rounded border border-[#1D4ED8] bg-white px-1.5 py-0.5 text-xs"
                        >
                          <option value="prevue">Prévue</option>
                          <option value="en_cours">En cours</option>
                          <option value="terminee">Terminée</option>
                          <option value="annulee">Annulée</option>
                        </select>
                      ) : (
                        <span
                          className={`inline-block rounded px-2 py-0.5 text-[11px] font-medium ${st.badgeClass}`}
                        >
                          {st.label}
                        </span>
                      )}
                    </td>

                    <td
                      className="px-3 py-2.5 text-right whitespace-nowrap"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => setDetailCampaignId(row.cmp.id)}
                          title="Détails de la campagne"
                          className="rounded p-1 text-[#1D4ED8] hover:bg-blue-50"
                        >
                          <Eye className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingCampaign(row.cmp);
                            setFormOpen(true);
                          }}
                          title="Modifier toute la campagne"
                          className="rounded p-1 text-slate-600 hover:bg-slate-100"
                        >
                          <Edit3 className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setDeleteTarget({
                              id: row.cmp.id,
                              label: `la campagne « ${row.cmp.name} »`,
                            })
                          }
                          title="Supprimer"
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
          {enrichedRows.length > 0 && (
            <tfoot className="border-t-2 border-slate-300 bg-slate-50 font-bold text-slate-900">
              <tr>
                <td colSpan={6} className="px-3 py-2.5 text-right text-xs">
                  TOTAUX ({enrichedRows.length} campagne{enrichedRows.length > 1 ? 's' : ''}) :
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap">
                  {formatMoney(totals.invoicedTtc, defaultCurrency, currencies)}
                </td>
                <td className="px-3 py-2.5 text-right text-emerald-700 tabular-nums whitespace-nowrap">
                  {formatMoney(totals.collected, defaultCurrency, currencies)}
                </td>
                <td className="px-3 py-2.5 text-right text-red-700 tabular-nums whitespace-nowrap">
                  {formatMoney(totals.remaining, defaultCurrency, currencies)}
                </td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      <p className="text-xs text-slate-500">
        Astuce : double-cliquez sur le nom, le client, les dates ou le statut d’une ligne pour modifier directement, ou cliquez sur l’icône crayon pour tout modifier et mettre à jour les documents liés.
      </p>

      {/* Modale Détail complet de la campagne */}
      {detailRow && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-2xl">
            <div className="flex items-start justify-between gap-4 border-b border-slate-200 bg-[#0F1E36] px-6 py-4 text-white">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <Megaphone className="h-5 w-5 text-blue-300" />
                  <h2 className="text-base font-semibold">{detailRow.cmp.name}</h2>
                  <span
                    className={`rounded px-2 py-0.5 text-[11px] font-medium ${
                      CAMPAIGN_STATUS_META[detailRow.effectiveStatus].badgeClass
                    }`}
                  >
                    {CAMPAIGN_STATUS_META[detailRow.effectiveStatus].label}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-slate-300">
                  <span>
                    Client : <strong className="text-white">{detailRow.clientLabel}</strong>
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Calendar className="h-3.5 w-3.5" />
                    {detailRow.cmp.startDate && detailRow.cmp.endDate
                      ? `Du ${formatDateFr(detailRow.cmp.startDate)} au ${formatDateFr(detailRow.cmp.endDate)} (${detailRow.duration.label})`
                      : 'Dates non définies'}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setEditingCampaign(detailRow.cmp);
                    setFormOpen(true);
                  }}
                  className="inline-flex items-center gap-1.5 rounded-md border border-slate-500 bg-slate-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700"
                >
                  <Edit3 className="h-3.5 w-3.5" />
                  <span>Modifier</span>
                </button>
                <button
                  type="button"
                  onClick={() => setDetailCampaignId(null)}
                  className="rounded p-1 text-slate-300 hover:bg-slate-800 hover:text-white"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-5">
              {detailRow.cmp.notes && (
                <div className="rounded-md border border-slate-200 bg-slate-50 px-3.5 py-2 text-xs text-slate-700">
                  <strong>Notes :</strong> {detailRow.cmp.notes}
                </div>
              )}

              {/* 5 KPI financiers de la campagne */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
                  <div className="text-[11px] text-slate-500">Total devis / proforma</div>
                  <div className="mt-1 text-sm font-bold text-slate-800 tabular-nums">
                    {formatMoney(detailRow.proformaTotalBase, defaultCurrency, currencies)}
                  </div>
                </div>
                <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
                  <div className="text-[11px] text-slate-500">Total facturé HT</div>
                  <div className="mt-1 text-sm font-bold text-slate-900 tabular-nums">
                    {formatMoney(detailRow.invoicedHtBase, defaultCurrency, currencies)}
                  </div>
                </div>
                <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
                  <div className="text-[11px] text-slate-500">Total facturé TTC</div>
                  <div className="mt-1 text-sm font-bold text-slate-900 tabular-nums">
                    {formatMoney(detailRow.invoicedTtcBase, defaultCurrency, currencies)}
                  </div>
                </div>
                <div className="rounded-md border border-slate-200 bg-emerald-50/70 p-3">
                  <div className="text-[11px] text-emerald-700">Encaissé</div>
                  <div className="mt-1 text-sm font-bold text-emerald-700 tabular-nums">
                    {formatMoney(detailRow.collectedBase, defaultCurrency, currencies)}
                  </div>
                </div>
                <div className="rounded-md border border-slate-200 bg-red-50/70 p-3">
                  <div className="text-[11px] text-red-700">Reste à encaisser</div>
                  <div className="mt-1 text-sm font-bold text-red-700 tabular-nums">
                    {formatMoney(detailRow.remainingBase, defaultCurrency, currencies)}
                  </div>
                </div>
              </div>

              {/* Actions rapides */}
              <div className="flex flex-wrap items-center justify-between gap-2 border-y border-slate-200 py-3">
                <span className="text-xs font-semibold text-slate-700">
                  Documents liés à cette campagne
                </span>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setEditingPo(undefined);
                      setPoModalOpen(true);
                    }}
                    className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    <ClipboardList className="h-3.5 w-3.5" />
                    <span>+ Nouveau BC reçu</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setEditingProforma(undefined);
                      setPrefillPoForProforma(undefined);
                      setProformaModalOpen(true);
                    }}
                    className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    <FileCheck2 className="h-3.5 w-3.5" />
                    <span>+ Nouveau Proforma</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setEditingInvoice(undefined);
                      setPrefillPoForInvoice(undefined);
                      setInvoiceModalOpen(true);
                    }}
                    className="inline-flex items-center gap-1.5 rounded-md bg-[#0F1E36] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#1a2f52]"
                  >
                    <FileText className="h-3.5 w-3.5" />
                    <span>+ Nouvelle facture</span>
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
                {/* BC Reçus */}
                <div className="rounded-lg border border-slate-200 flex flex-col">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-xs font-semibold text-slate-700">
                    <span>Bons de commande reçus ({detailRow.cmpBcs.length})</span>
                    {attachableDocs.bcs.length > 0 && (
                      <div className="flex items-center gap-1">
                        <select
                          value={attachBcId}
                          onChange={(e) => setAttachBcId(e.target.value)}
                          className="max-w-[160px] rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[11px] font-normal"
                        >
                          <option value="">Rattacher un BC...</option>
                          {attachableDocs.bcs.map((b) => (
                            <option key={b.id} value={b.id}>
                              BC {b.poNumber}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          disabled={!attachBcId}
                          onClick={() => handleLinkDoc('bc', attachBcId)}
                          className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-40"
                        >
                          <Link2 className="h-3 w-3" />
                        </button>
                      </div>
                    )}
                  </div>
                  {detailRow.cmpBcs.length === 0 ? (
                    <div className="p-4 text-center text-xs text-slate-500">
                      Aucun BC reçu rattaché à cette campagne.
                    </div>
                  ) : (
                    <div className="divide-y divide-slate-100">
                      {detailRow.cmpBcs.map((po) => {
                        const attCount = attachmentCounts.get(po.id) || 0;
                        const bcStatus = computeBcRecuInvoicingStatus({
                          bc: po,
                          linkedInvoices: detailRow.cmpInvoices.filter(
                            (inv) => inv.linkedBcRecuId === po.id
                          ),
                        });
                        return (
                          <div
                            key={po.id}
                            onClick={() => {
                              setEditingPo(po);
                              setPoModalOpen(true);
                            }}
                            className="flex cursor-pointer items-center justify-between gap-2 px-4 py-2.5 text-xs hover:bg-slate-50"
                          >
                            <div>
                              <div className="flex items-center gap-1.5 font-semibold text-slate-900">
                                <span>BC N° {po.poNumber}</span>
                                {attCount > 0 && (
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setAttModal({
                                        parentId: po.id,
                                        title: `Pièces jointes — BC ${po.poNumber}`,
                                      });
                                    }}
                                    title="Voir les pièces jointes"
                                    className="inline-flex items-center gap-0.5 rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-[#1D4ED8] hover:bg-blue-100"
                                  >
                                    <Paperclip className="h-3 w-3" />
                                    <span>{attCount}</span>
                                  </button>
                                )}
                              </div>
                              <div className="text-[11px] text-slate-500">
                                Reçu le {formatDateFr(po.issueDate)} · Statut : {bcStatus}
                              </div>
                            </div>
                            <div className="flex items-center gap-1.5">
                              <span className="font-semibold text-slate-900 tabular-nums">
                                {formatMoney(po.totalTtcCentimes, po.currency, currencies)}
                              </span>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setEditingInvoice(undefined);
                                  setPrefillPoForInvoice(po);
                                  setInvoiceModalOpen(true);
                                }}
                                className="rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-700 hover:bg-slate-100"
                              >
                                Facturer
                              </button>
                              <button
                                type="button"
                                onClick={(e) => handleUnlinkDoc(e, 'bc', po.id)}
                                title="Détacher de la campagne"
                                className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
                              >
                                <Unlink className="h-3 w-3" />
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Proformas */}
                <div className="rounded-lg border border-slate-200 flex flex-col">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-xs font-semibold text-slate-700">
                    <span>Devis / Proformas ({detailRow.cmpProformas.length})</span>
                    {attachableDocs.pfs.length > 0 && (
                      <div className="flex items-center gap-1">
                        <select
                          value={attachPfId}
                          onChange={(e) => setAttachPfId(e.target.value)}
                          className="max-w-[160px] rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[11px] font-normal"
                        >
                          <option value="">Rattacher un proforma...</option>
                          {attachableDocs.pfs.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.proformaNumber}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          disabled={!attachPfId}
                          onClick={() => handleLinkDoc('proforma', attachPfId)}
                          className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-40"
                        >
                          <Link2 className="h-3 w-3" />
                        </button>
                      </div>
                    )}
                  </div>
                  {detailRow.cmpProformas.length === 0 ? (
                    <div className="p-4 text-center text-xs text-slate-500">
                      Aucun proforma rattaché à cette campagne.
                    </div>
                  ) : (
                    <div className="divide-y divide-slate-100">
                      {detailRow.cmpProformas.map((pf) => {
                        const eff = getEffectiveProformaStatus(pf);
                        return (
                          <div
                            key={pf.id}
                            onClick={() => {
                              setEditingProforma(pf);
                              setPrefillPoForProforma(undefined);
                              setProformaModalOpen(true);
                            }}
                            className="flex cursor-pointer items-center justify-between gap-2 px-4 py-2.5 text-xs hover:bg-slate-50"
                          >
                            <div>
                              <div className="font-semibold text-slate-900">{pf.proformaNumber}</div>
                              <div className="text-[11px] text-slate-500">
                                {formatDateFr(pf.issueDate)} · Statut : {eff}
                              </div>
                            </div>
                            <div className="flex items-center gap-1.5">
                              <span className="font-semibold text-slate-900 tabular-nums">
                                {formatMoney(pf.totalTtcCentimes, pf.currency, currencies)}
                              </span>
                              <button
                                type="button"
                                onClick={(e) => handleUnlinkDoc(e, 'proforma', pf.id)}
                                title="Détacher de la campagne"
                                className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
                              >
                                <Unlink className="h-3 w-3" />
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Factures clients */}
                <div className="rounded-lg border border-slate-200 flex flex-col">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-xs font-semibold text-slate-700">
                    <span>Factures clients ({detailRow.cmpInvoices.length})</span>
                    {attachableDocs.invs.length > 0 && (
                      <div className="flex items-center gap-1">
                        <select
                          value={attachInvId}
                          onChange={(e) => setAttachInvId(e.target.value)}
                          className="max-w-[160px] rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[11px] font-normal"
                        >
                          <option value="">Rattacher une facture...</option>
                          {attachableDocs.invs.map((inv) => (
                            <option key={inv.id} value={inv.id}>
                              Facture {inv.invoiceNumber}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          disabled={!attachInvId}
                          onClick={() => handleLinkDoc('invoice', attachInvId)}
                          className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-40"
                        >
                          <Link2 className="h-3 w-3" />
                        </button>
                      </div>
                    )}
                  </div>
                  {detailRow.cmpInvoices.length === 0 ? (
                    <div className="p-4 text-center text-xs text-slate-500">
                      Aucune facture client rattachée à cette campagne.
                    </div>
                  ) : (
                    <div className="divide-y divide-slate-100">
                      {detailRow.cmpInvoices.map((inv) => {
                        const paid = computeInvoicePaidCentimes(
                          inv.id,
                          allocations,
                          validPaymentIds
                        );
                        const rem = Math.max(0, inv.totalTtcCentimes - paid);
                        return (
                          <div
                            key={inv.id}
                            onClick={() => {
                              setEditingInvoice(inv);
                              setPrefillPoForInvoice(undefined);
                              setInvoiceModalOpen(true);
                            }}
                            className="flex cursor-pointer items-center justify-between gap-2 px-4 py-2.5 text-xs hover:bg-slate-50"
                          >
                            <div>
                              <div className="font-semibold text-slate-900">
                                Facture {inv.invoiceNumber}
                              </div>
                              <div className="text-[11px] text-slate-500">
                                {formatDateFr(inv.issueDate)}
                                {inv.bcNumber ? ` · BC ${inv.bcNumber}` : ''}
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <div className="text-right tabular-nums">
                                <div className="font-semibold text-slate-900">
                                  {formatMoney(inv.totalTtcCentimes, inv.currency, currencies)}
                                </div>
                                <div
                                  className={`text-[11px] ${
                                    inv.status === 'annulee'
                                      ? 'text-slate-400'
                                      : rem > 0
                                      ? 'text-red-600'
                                      : 'text-emerald-700'
                                  }`}
                                >
                                  {inv.status === 'annulee'
                                    ? 'Annulée'
                                    : rem > 0
                                    ? `Reste : ${formatMoney(rem, inv.currency, currencies)}`
                                    : 'Payée'}
                                </div>
                              </div>
                              <button
                                type="button"
                                onClick={(e) => handleUnlinkDoc(e, 'invoice', inv.id)}
                                title="Détacher de la campagne"
                                className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
                              >
                                <Unlink className="h-3 w-3" />
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Paiements reçus sur la campagne */}
                <div className="rounded-lg border border-slate-200">
                  <div className="border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-xs font-semibold text-slate-700">
                    Paiements affectés à la campagne ({detailRow.cmpPayments.length})
                  </div>
                  {detailRow.cmpPayments.length === 0 ? (
                    <div className="p-4 text-center text-xs text-slate-500">
                      Aucun paiement affecté aux factures de cette campagne.
                    </div>
                  ) : (
                    <div className="divide-y divide-slate-100">
                      {detailRow.cmpPayments.map(({ payment, allocatedForCampaign }) => (
                        <div
                          key={payment.id}
                          className="flex items-center justify-between gap-2 px-4 py-2.5 text-xs"
                        >
                          <div>
                            <div className="font-semibold text-slate-900">
                              {formatDateFr(payment.date)} · {payment.method.toUpperCase()}
                            </div>
                            <div className="text-[11px] text-slate-500">
                              {payment.reference || payment.notes || 'Règlement'}
                            </div>
                          </div>
                          <span className="font-semibold text-emerald-700 tabular-nums">
                            {formatMoney(allocatedForCampaign, payment.currency, currencies)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modales */}
      <CampaignFormModal
        open={formOpen}
        existingCampaign={editingCampaign}
        onClose={() => {
          setFormOpen(false);
          setEditingCampaign(undefined);
        }}
      />

      {detailRow && (
        <>
          <PurchaseOrderFormModal
            open={poModalOpen}
            direction="bc_recu"
            existingPo={editingPo}
            preselectedContactId={detailRow.cmp.clientId}
            onClose={() => {
              setPoModalOpen(false);
              setEditingPo(undefined);
            }}
          />
          <ProformaFormModal
            open={proformaModalOpen}
            existingProforma={editingProforma}
            preselectedClientId={detailRow.cmp.clientId}
            prefillFromBc={prefillPoForProforma}
            onClose={() => {
              setProformaModalOpen(false);
              setEditingProforma(undefined);
              setPrefillPoForProforma(undefined);
            }}
          />
          <InvoiceFormModal
            open={invoiceModalOpen}
            mode="client"
            existingInvoice={editingInvoice}
            preselectedContactId={detailRow.cmp.clientId}
            prefillFromBc={prefillPoForInvoice}
            onClose={() => {
              setInvoiceModalOpen(false);
              setEditingInvoice(undefined);
              setPrefillPoForInvoice(undefined);
            }}
          />
        </>
      )}

      {attModal && (
        <AttachmentPreviewModal
          open={Boolean(attModal)}
          parentId={attModal.parentId}
          parentType="bc_recu"
          title={attModal.title}
          onClose={() => setAttModal(null)}
        />
      )}

      <SafeDeleteDialog
        open={Boolean(deleteTarget)}
        entityType="campaign"
        entityId={deleteTarget?.id || ''}
        entityLabel={deleteTarget?.label || ''}
        onClose={() => setDeleteTarget(null)}
        onDeleted={() => {
          if (deleteTarget && detailCampaignId === deleteTarget.id) {
            setDetailCampaignId(null);
          }
        }}
      />
    </div>
  );
};
