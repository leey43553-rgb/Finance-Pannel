import React, { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  ArrowRightCircle,
  ArrowUpDown,
  Edit3,
  FileCheck2,
  Paperclip,
  Plus,
  Printer,
  Search,
  Trash2,
} from 'lucide-react';
import { db } from '../db/database';
import type { Proforma, ProformaStatus } from '../db/types';
import { convertProformaToInvoice } from '../services/documentActions';
import { useAppStore } from '../store/useAppStore';
import {
  compareDocumentNumbers,
  formatDateFr,
  getEffectiveProformaStatus,
  resolveEffectiveCompanyProfile,
} from '../utils/documentHelpers';
import { addMoney, formatMoney } from '../utils/money';
import { buildPdfFileName } from '../utils/print';
import { ProformaFormModal } from '../components/ProformaFormModal';
import { AttachmentPreviewModal } from '../components/AttachmentPreviewModal';
import { PrintDocumentModal } from '../components/PrintDocumentModal';
import { SharedDocumentTemplate } from '../components/SharedDocumentTemplate';
import { SafeDeleteDialog } from '../components/SafeDeleteDialog';

const PROFORMA_STATUS_META: Record<
  ProformaStatus,
  { label: string; badgeClass: string }
> = {
  brouillon: { label: 'Brouillon', badgeClass: 'bg-slate-100 text-slate-700' },
  envoye: { label: 'Envoyé', badgeClass: 'bg-blue-100 text-blue-800' },
  accepte: { label: 'Accepté', badgeClass: 'bg-emerald-100 text-emerald-800' },
  refuse: { label: 'Refusé', badgeClass: 'bg-red-100 text-red-700' },
  expire: { label: 'Expiré', badgeClass: 'bg-amber-100 text-amber-800' },
  facture: { label: 'Facturé', badgeClass: 'bg-emerald-700 text-white' },
};

export const ProformasPage: React.FC = () => {
  const pushToast = useAppStore((s) => s.pushToast);
  const settings = useLiveQuery(() => db.settings.get('company_settings'));
  const proformas = useLiveQuery(
    () => db.proformas.filter((p) => !p.deletedAt).toArray(),
    [],
    []
  );
  const contacts = useLiveQuery(
    () => db.contacts.filter((c) => !c.deletedAt).toArray(),
    [],
    []
  );
  const companyProfiles = useLiveQuery(
    () => db.companyProfiles.filter((p) => !p.deletedAt).toArray(),
    [],
    []
  );
  const customerInvoices = useLiveQuery(
    () => db.customerInvoices.filter((i) => !i.deletedAt).toArray(),
    [],
    []
  );
  const attachments = useLiveQuery(() => db.documentAttachments.toArray(), [], []);

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'tous' | ProformaStatus>('tous');
  const [companyFilter, setCompanyFilter] = useState<string>('auto');
  const [sortBy, setSortBy] = useState<'date' | 'number' | 'ttc'>('date');
  const [sortAsc, setSortAsc] = useState(false);

  const [formOpen, setFormOpen] = useState(false);
  const [editingProforma, setEditingProforma] = useState<Proforma | undefined>(undefined);
  const [printTargetId, setPrintTargetId] = useState<string | null>(null);
  const [attModal, setAttModal] = useState<{ parentId: string; title: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; label: string } | null>(null);
  const [convertingId, setConvertingId] = useState<string | null>(null);

  const defaultCurrency = settings?.defaultCurrency || 'DZD';
  const currencies = settings?.enabledCurrencies;

  const contactMap = useMemo(() => new Map(contacts.map((c) => [c.id, c])), [contacts]);
  const profileMap = useMemo(
    () => new Map(companyProfiles.map((p) => [p.id, p])),
    [companyProfiles]
  );
  const invoiceMap = useMemo(
    () => new Map(customerInvoices.map((i) => [i.id, i])),
    [customerInvoices]
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
    if (companyFilter === 'toutes') return null;
    if (companyFilter === 'auto') {
      return settings?.companyScopeFilter === 'active' ? activeFallbackProfile?.id || null : null;
    }
    return companyFilter;
  }, [companyFilter, settings?.companyScopeFilter, activeFallbackProfile?.id]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const mapped = proformas
      .map((pf) => {
        const contact = contactMap.get(pf.clientId);
        const clientLabel =
          pf.clientSnapshot?.company ||
          pf.clientSnapshot?.name ||
          contact?.company ||
          contact?.name ||
          'Client inconnu';
        const effectiveStatus = getEffectiveProformaStatus(pf);
        const convertedInv = pf.convertedInvoiceId
          ? invoiceMap.get(pf.convertedInvoiceId)
          : undefined;
        const bcAttCount = pf.linkedBcRecuId
          ? attachmentCounts.get(pf.linkedBcRecuId) || 0
          : 0;
        const issuerProfile = resolveEffectiveCompanyProfile({
          companyProfileId: pf.companyProfileId,
          issuerSnapshot: pf.issuerSnapshot,
          profileMap,
          fallbackProfile: activeFallbackProfile,
        });
        return { pf, contact, clientLabel, effectiveStatus, convertedInv, bcAttCount, issuerProfile };
      })
      .filter((r) => {
        if (effectiveCompanyFilterId && r.pf.companyProfileId !== effectiveCompanyFilterId) {
          return false;
        }
        if (statusFilter !== 'tous' && r.effectiveStatus !== statusFilter) return false;
        if (q) {
          const hay = `${r.pf.proformaNumber} ${r.clientLabel} ${r.pf.bcNumber} ${r.pf.campaignRef} ${r.pf.description} ${r.issuerProfile?.name || ''}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });

    mapped.sort((a, b) => {
      let cmp = 0;
      if (sortBy === 'date') cmp = a.pf.issueDate.localeCompare(b.pf.issueDate);
      else if (sortBy === 'number')
        cmp = compareDocumentNumbers(a.pf.proformaNumber, b.pf.proformaNumber);
      else cmp = a.pf.baseDzdTtcCentimes - b.pf.baseDzdTtcCentimes;
      return sortAsc ? cmp : -cmp;
    });

    return mapped;
  }, [
    proformas,
    contactMap,
    profileMap,
    activeFallbackProfile,
    effectiveCompanyFilterId,
    invoiceMap,
    attachmentCounts,
    search,
    statusFilter,
    sortBy,
    sortAsc,
  ]);

  const totalPendingTtc = useMemo(() => {
    let sum = 0;
    for (const r of rows) {
      if (r.effectiveStatus !== 'refuse' && r.effectiveStatus !== 'expire') {
        sum = addMoney(sum, r.pf.baseDzdTtcCentimes);
      }
    }
    return sum;
  }, [rows]);

  const printTarget = useMemo(
    () => rows.find((r) => r.pf.id === printTargetId) || null,
    [rows, printTargetId]
  );

  const handleConvertToInvoice = async (pf: Proforma) => {
    setConvertingId(pf.id);
    try {
      const invoice = await convertProformaToInvoice(pf.id);
      pushToast({
        type: 'success',
        title: `Facture ${invoice.invoiceNumber} créée`,
        message: `Le proforma ${pf.proformaNumber} a été transformé en facture client.`,
      });
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Conversion impossible',
        message: err instanceof Error ? err.message : 'Erreur',
      });
    } finally {
      setConvertingId(null);
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
      {/* Note métier importante */}
      <div className="flex items-center gap-2.5 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2.5 text-xs text-blue-900">
        <FileCheck2 className="h-4 w-4 shrink-0 text-[#1D4ED8]" />
        <span>
          Les factures proforma sont des devis commerciaux : elles ne sont <strong>jamais</strong> comptabilisées dans le chiffre d’affaires, les créances, la trésorerie ou le grand livre tant qu’elles ne sont pas transformées en facture.
        </span>
      </div>

      {/* Barre filtres + création */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative">
            <Search className="pointer-events-none absolute top-2.5 left-3 h-4 w-4 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Rechercher N° proforma, client, BC, campagne..."
              className="w-64 rounded-md border border-slate-300 py-1.5 pr-3 pl-9 text-sm"
            />
          </div>

          {companyProfiles.length > 0 && (
            <select
              value={companyFilter}
              onChange={(e) => setCompanyFilter(e.target.value)}
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
                { id: 'tous', label: 'Tous' },
                { id: 'brouillon', label: 'Brouillons' },
                { id: 'envoye', label: 'Envoyés' },
                { id: 'accepte', label: 'Acceptés' },
                { id: 'facture', label: 'Facturés' },
                { id: 'expire', label: 'Expirés' },
                { id: 'refuse', label: 'Refusés' },
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
        </div>

        <button
          type="button"
          onClick={() => {
            setEditingProforma(undefined);
            setFormOpen(true);
          }}
          className="inline-flex items-center gap-2 rounded-md bg-[#0F1E36] px-4 py-2 text-sm font-medium text-white hover:bg-[#1a2f52] whitespace-nowrap"
        >
          <Plus className="h-4 w-4" />
          <span>Nouveau proforma</span>
        </button>
      </div>

      {/* Résumé */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-slate-200 bg-white p-3.5">
          <div className="text-xs text-slate-500">Proformas affichés</div>
          <div className="mt-1 text-base font-bold text-slate-900 tabular-nums">{rows.length}</div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-3.5">
          <div className="text-xs text-slate-500">Montant total devis TTC (hors expirés/refusés)</div>
          <div className="mt-1 text-base font-bold text-slate-900 tabular-nums">
            {formatMoney(totalPendingTtc, defaultCurrency, currencies)}
          </div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-3.5">
          <div className="text-xs text-slate-500">Déjà transformés en facture</div>
          <div className="mt-1 text-base font-bold text-emerald-700 tabular-nums">
            {rows.filter((r) => r.effectiveStatus === 'facture').length}
          </div>
        </div>
      </div>

      {/* Tableau */}
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
                  <span>N° Proforma</span>
                  <ArrowUpDown className="h-3 w-3" />
                </button>
              </th>
              <th className="px-3 py-2.5">Société</th>
              <th className="px-3 py-2.5">Client</th>
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
              <th className="px-3 py-2.5">Validité</th>
              <th className="px-3 py-2.5">BC / Campagne</th>
              <th className="px-3 py-2.5 text-right">
                <button
                  type="button"
                  onClick={() => toggleSort('ttc')}
                  className="inline-flex items-center gap-1 hover:text-slate-900"
                >
                  <span>Total TTC</span>
                  <ArrowUpDown className="h-3 w-3" />
                </button>
              </th>
              <th className="px-3 py-2.5">Statut</th>
              <th className="px-3 py-2.5 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-4 py-10 text-center text-sm text-slate-500">
                  Aucun proforma trouvé.
                </td>
              </tr>
            ) : (
              rows.map(({ pf, clientLabel, effectiveStatus, convertedInv, bcAttCount, issuerProfile }) => {
                const st = PROFORMA_STATUS_META[effectiveStatus];
                return (
                  <tr key={pf.id} className="hover:bg-slate-50">
                    <td className="px-3 py-2.5 font-semibold text-slate-900 whitespace-nowrap">
                      {pf.proformaNumber}
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-slate-700">
                        <span
                          className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: issuerProfile?.primaryColor || '#FF33CC' }}
                        />
                        <span>{issuerProfile?.name || '—'}</span>
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-slate-800">{clientLabel}</td>
                    <td className="px-3 py-2.5 text-slate-600 tabular-nums whitespace-nowrap">
                      {formatDateFr(pf.issueDate)}
                    </td>
                    <td className="px-3 py-2.5 text-slate-600 tabular-nums whitespace-nowrap">
                      {formatDateFr(pf.validUntil)} ({pf.validityDays} j)
                    </td>
                    <td className="px-3 py-2.5 text-slate-600">
                      <div className="flex items-center gap-1.5">
                        <span>
                          {[pf.bcNumber, pf.campaignRef].filter(Boolean).join(' · ') || '—'}
                        </span>
                        {pf.linkedBcRecuId && bcAttCount > 0 && (
                          <button
                            type="button"
                            onClick={() =>
                              setAttModal({
                                parentId: pf.linkedBcRecuId!,
                                title: `Pièces jointes — BC ${pf.bcNumber || ''}`,
                              })
                            }
                            title="Voir la pièce jointe du BC reçu"
                            className="inline-flex items-center gap-0.5 rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-[#1D4ED8] hover:bg-blue-100"
                          >
                            <Paperclip className="h-3 w-3" />
                            <span>{bcAttCount}</span>
                          </button>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right font-semibold text-slate-900 tabular-nums whitespace-nowrap">
                      {formatMoney(pf.totalTtcCentimes, pf.currency, currencies)}
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      <span
                        className={`inline-block rounded px-2 py-0.5 text-[11px] font-medium ${st.badgeClass}`}
                      >
                        {st.label}
                      </span>
                      {convertedInv && (
                        <div className="mt-0.5 text-[10px] text-emerald-700">
                          → Facture {convertedInv.invoiceNumber}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1">
                        {effectiveStatus !== 'facture' && (
                          <button
                            type="button"
                            disabled={convertingId === pf.id}
                            onClick={() => handleConvertToInvoice(pf)}
                            title="Transformer en facture client"
                            className="inline-flex items-center gap-1 rounded border border-emerald-300 bg-emerald-50 px-2 py-1 text-[11px] font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
                          >
                            <ArrowRightCircle className="h-3 w-3" />
                            <span>Transformer en facture</span>
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setPrintTargetId(pf.id)}
                          title="Aperçu & Impression PDF A4"
                          className="rounded p-1 text-slate-600 hover:bg-slate-100"
                        >
                          <Printer className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingProforma(pf);
                            setFormOpen(true);
                          }}
                          title="Modifier"
                          className="rounded p-1 text-slate-600 hover:bg-slate-100"
                        >
                          <Edit3 className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setDeleteTarget({
                              id: pf.id,
                              label: `le proforma ${pf.proformaNumber}`,
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
        </table>
      </div>

      {/* Modale Création / Modification */}
      <ProformaFormModal
        open={formOpen}
        existingProforma={editingProforma}
        onClose={() => {
          setFormOpen(false);
          setEditingProforma(undefined);
        }}
      />

      {/* Aperçu PDF A4 unifié */}
      {printTarget && (() => {
        const resolvedProfile = printTarget.issuerProfile;
        return (
          <PrintDocumentModal
            open={Boolean(printTarget)}
            title={`Proforma ${printTarget.pf.proformaNumber}`}
            fileName={buildPdfFileName(
              'proforma',
              printTarget.pf.proformaNumber,
              printTarget.clientLabel
            )}
            settings={settings}
            companyProfile={resolvedProfile}
            fallbackPrintRoute={`/imprimer/proforma/${printTarget.pf.id}`}
            rawLayout
            onClose={() => setPrintTargetId(null)}
          >
          <SharedDocumentTemplate
            docKind="proforma"
            docNumber={printTarget.pf.proformaNumber}
            issueDate={printTarget.pf.issueDate}
            bcNumber={printTarget.pf.bcNumber}
            campaignRef={printTarget.pf.campaignRef}
            campaignStartDate={printTarget.pf.campaignStartDate}
            campaignEndDate={printTarget.pf.campaignEndDate}
            showCampaignOnPrint={printTarget.pf.showCampaignOnPrint}
            validityDays={printTarget.pf.validityDays}
            validUntil={printTarget.pf.validUntil}
            paymentConditions={printTarget.pf.paymentConditions}
            deliveryDelay={printTarget.pf.deliveryDelay}
            profile={resolvedProfile}
            settings={settings}
            contact={printTarget.contact}
            clientSnapshot={printTarget.pf.clientSnapshot}
            currency={printTarget.pf.currency}
            lines={printTarget.pf.lines}
            totalHtCentimes={printTarget.pf.totalHtCentimes}
            totalTvaCentimes={printTarget.pf.totalTvaCentimes}
            totalTtcCentimes={printTarget.pf.totalTtcCentimes}
            amountInWordsOverride={printTarget.pf.amountInWordsOverride}
            notes={printTarget.pf.notes}
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
        entityType="proforma"
        entityId={deleteTarget?.id || ''}
        entityLabel={deleteTarget?.label || ''}
        onClose={() => setDeleteTarget(null)}
      />
    </div>
  );
};
