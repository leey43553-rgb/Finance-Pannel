import React, { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Edit3,
  FileCheck2,
  FileText,
  Paperclip,
  Plus,
  Printer,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';
import { db } from '../db/database';
import type {
  BcEmisStatus,
  BcRecuStatus,
  PurchaseOrder,
  PurchaseOrderDirection,
} from '../db/types';
import {
  computeBcRecuInvoicingStatus,
  computeCampaignDuration,
  formatDateFr,
  resolveEffectiveCompanyProfile,
} from '../utils/documentHelpers';
import { addMoney, formatMoney } from '../utils/money';
import { buildPdfFileName } from '../utils/print';
import { PurchaseOrderFormModal } from '../components/PurchaseOrderFormModal';
import { ProformaFormModal } from '../components/ProformaFormModal';
import { InvoiceFormModal } from '../components/InvoiceFormModal';
import { AttachmentPreviewModal } from '../components/AttachmentPreviewModal';
import { PrintDocumentModal } from '../components/PrintDocumentModal';
import { PurchaseOrderImportModal } from '../components/PurchaseOrderImportModal';
import { SharedDocumentTemplate } from '../components/SharedDocumentTemplate';
import { SafeDeleteDialog } from '../components/SafeDeleteDialog';

const BC_RECU_STATUS_META: Record<
  BcRecuStatus,
  { label: string; badgeClass: string }
> = {
  recu: { label: 'Reçu', badgeClass: 'bg-slate-100 text-slate-700' },
  en_cours: { label: 'En cours', badgeClass: 'bg-blue-100 text-blue-800' },
  partiellement_facture: {
    label: 'Partiellement facturé',
    badgeClass: 'bg-amber-100 text-amber-800',
  },
  facture: { label: 'Facturé', badgeClass: 'bg-emerald-100 text-emerald-800' },
  annule: { label: 'Annulé', badgeClass: 'bg-red-100 text-red-700' },
};

const BC_EMIS_STATUS_META: Record<
  BcEmisStatus,
  { label: string; badgeClass: string }
> = {
  brouillon: { label: 'Brouillon', badgeClass: 'bg-slate-100 text-slate-700' },
  envoye: { label: 'Envoyé', badgeClass: 'bg-blue-100 text-blue-800' },
  recu: { label: 'Réceptionné', badgeClass: 'bg-amber-100 text-amber-800' },
  facture: { label: 'Facturé', badgeClass: 'bg-emerald-100 text-emerald-800' },
  annule: { label: 'Annulé', badgeClass: 'bg-red-100 text-red-700' },
};

export const PurchaseOrdersPage: React.FC = () => {
  const settings = useLiveQuery(() => db.settings.get('company_settings'));
  const purchaseOrders = useLiveQuery(
    () => db.purchaseOrders.filter((p) => !p.deletedAt).toArray(),
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

  const [direction, setDirection] = useState<PurchaseOrderDirection>('bc_recu');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('tous');
  const [companyFilter, setCompanyFilter] = useState<string>('auto');

  const [poModalOpen, setPoModalOpen] = useState(false);
  const [editingPo, setEditingPo] = useState<PurchaseOrder | undefined>(undefined);
  const [attModal, setAttModal] = useState<{
    parentId: string;
    parentType: 'bc_recu' | 'bc_emis';
    title: string;
  } | null>(null);
  const [proformaPrefillPo, setProformaPrefillPo] = useState<PurchaseOrder | undefined>(undefined);
  const [invoicePrefillPo, setInvoicePrefillPo] = useState<PurchaseOrder | undefined>(undefined);
  const [printTargetId, setPrintTargetId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; label: string } | null>(null);
  const [importModalOpen, setImportModalOpen] = useState(false);

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
    if (companyFilter === 'toutes') return null;
    if (companyFilter === 'auto') {
      return settings?.companyScopeFilter === 'active' ? activeFallbackProfile?.id || null : null;
    }
    return companyFilter;
  }, [companyFilter, settings?.companyScopeFilter, activeFallbackProfile?.id]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return purchaseOrders
      .filter((po) => po.direction === direction)
      .map((po) => {
        const contact = contactMap.get(po.contactId);
        const contactLabel = contact ? contact.company || contact.name : 'Inconnu';
        const linkedInvoices =
          direction === 'bc_recu'
            ? customerInvoices.filter(
                (inv) => inv.linkedBcRecuId === po.id && inv.status !== 'annulee'
              )
            : [];
        const effectiveStatus =
          direction === 'bc_recu'
            ? computeBcRecuInvoicingStatus({ bc: po, linkedInvoices })
            : (po.status as BcEmisStatus);
        const attCount = attachmentCounts.get(po.id) || 0;
        const duration = computeCampaignDuration(po.campaignStartDate, po.campaignEndDate);
        const issuerProfile = resolveEffectiveCompanyProfile({
          companyProfileId: po.companyProfileId,
          issuerSnapshot: po.issuerSnapshot,
          profileMap,
          fallbackProfile: activeFallbackProfile,
        });
        return {
          po,
          contact,
          contactLabel,
          linkedInvoices,
          effectiveStatus,
          attCount,
          duration,
          issuerProfile,
        };
      })
      .filter((r) => {
        if (effectiveCompanyFilterId && r.po.companyProfileId !== effectiveCompanyFilterId) {
          return false;
        }
        if (statusFilter !== 'tous' && r.effectiveStatus !== statusFilter) return false;
        if (q) {
          const hay = `${r.po.poNumber} ${r.contactLabel} ${r.po.campaignRef} ${r.po.description} ${r.issuerProfile?.name || ''}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => b.po.issueDate.localeCompare(a.po.issueDate));
  }, [
    purchaseOrders,
    direction,
    contactMap,
    profileMap,
    activeFallbackProfile,
    effectiveCompanyFilterId,
    customerInvoices,
    attachmentCounts,
    search,
    statusFilter,
  ]);

  const totalTtc = useMemo(() => {
    let sum = 0;
    for (const r of rows) {
      if (r.effectiveStatus !== 'annule') {
        sum = addMoney(sum, r.po.baseDzdTtcCentimes);
      }
    }
    return sum;
  }, [rows]);

  const printTarget = useMemo(
    () => rows.find((r) => r.po.id === printTargetId) || null,
    [rows, printTargetId]
  );

  const handleDirectionSwitch = (next: PurchaseOrderDirection) => {
    setDirection(next);
    setStatusFilter('tous');
  };

  return (
    <div className="space-y-5">
      {/* Switch principal BC reçu / BC émis */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1 rounded-md bg-slate-100 p-1">
            <button
              type="button"
              onClick={() => handleDirectionSwitch('bc_recu')}
              className={`inline-flex items-center gap-1.5 rounded px-3.5 py-1.5 text-xs font-semibold whitespace-nowrap ${
                direction === 'bc_recu'
                  ? 'bg-[#0F1E36] text-white shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <ArrowDownLeft className="h-3.5 w-3.5" />
              <span>BC reçu d’un client</span>
            </button>
            <button
              type="button"
              onClick={() => handleDirectionSwitch('bc_emis')}
              className={`inline-flex items-center gap-1.5 rounded px-3.5 py-1.5 text-xs font-semibold whitespace-nowrap ${
                direction === 'bc_emis'
                  ? 'bg-[#0F1E36] text-white shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <ArrowUpRight className="h-3.5 w-3.5" />
              <span>BC émis à un fournisseur</span>
            </button>
          </div>

          <div className="relative">
            <Search className="pointer-events-none absolute top-2.5 left-3 h-4 w-4 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={
                direction === 'bc_recu'
                  ? 'N° BC client, client, campagne...'
                  : 'N° BC émis, fournisseur, campagne...'
              }
              className="w-60 rounded-md border border-slate-300 py-1.5 pr-3 pl-9 text-sm"
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

          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
          >
            <option value="tous">Tous statuts</option>
            {Object.entries(
              direction === 'bc_recu' ? BC_RECU_STATUS_META : BC_EMIS_STATUS_META
            ).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setImportModalOpen(true)}
            className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
          >
            <Upload className="h-4 w-4 text-[#1D4ED8]" />
            <span>Importer un BC</span>
          </button>

          <button
            type="button"
            onClick={() => {
              setEditingPo(undefined);
              setPoModalOpen(true);
            }}
            className="inline-flex items-center gap-2 rounded-md bg-[#0F1E36] px-4 py-2 text-sm font-medium text-white hover:bg-[#1a2f52] whitespace-nowrap"
          >
            <Plus className="h-4 w-4" />
            <span>
              {direction === 'bc_recu' ? 'Nouveau BC reçu' : 'Nouveau BC fournisseur'}
            </span>
          </button>
        </div>
      </div>

      {/* Synthèse rapide */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-slate-200 bg-white p-3.5">
          <div className="text-xs text-slate-500">
            {direction === 'bc_recu' ? 'BC clients affichés' : 'BC fournisseurs affichés'}
          </div>
          <div className="mt-1 text-base font-bold text-slate-900 tabular-nums">{rows.length}</div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-3.5">
          <div className="text-xs text-slate-500">Montant cumulé TTC (hors annulés)</div>
          <div className="mt-1 text-base font-bold text-slate-900 tabular-nums">
            {formatMoney(totalTtc, defaultCurrency, currencies)}
          </div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-3.5">
          <div className="text-xs text-slate-500">
            {direction === 'bc_recu' ? 'En attente de facturation' : 'En cours / envoyés'}
          </div>
          <div className="mt-1 text-base font-bold text-amber-700 tabular-nums">
            {
              rows.filter((r) =>
                direction === 'bc_recu'
                  ? r.effectiveStatus === 'recu' ||
                    r.effectiveStatus === 'en_cours' ||
                    r.effectiveStatus === 'partiellement_facture'
                  : r.effectiveStatus === 'brouillon' || r.effectiveStatus === 'envoye'
              ).length
            }
          </div>
        </div>
      </div>

      {/* Tableau */}
      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-slate-200 bg-slate-50 font-semibold text-slate-600">
            <tr>
              <th className="px-3 py-2.5">N° BC</th>
              <th className="px-3 py-2.5">Société</th>
              <th className="px-3 py-2.5">
                {direction === 'bc_recu' ? 'Client' : 'Fournisseur'}
              </th>
              <th className="px-3 py-2.5">
                {direction === 'bc_recu' ? 'Date réception' : 'Date émission'}
              </th>
              <th className="px-3 py-2.5">Campagne & période</th>
              <th className="px-3 py-2.5 text-center">Pièces</th>
              <th className="px-3 py-2.5 text-right">Montant TTC</th>
              <th className="px-3 py-2.5">Statut</th>
              <th className="px-3 py-2.5 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-4 py-10 text-center text-sm text-slate-500">
                  Aucun bon de commande trouvé.
                </td>
              </tr>
            ) : (
              rows.map(
                ({
                  po,
                  contactLabel,
                  linkedInvoices,
                  effectiveStatus,
                  attCount,
                  duration,
                  issuerProfile,
                }) => {
                  const badge =
                    direction === 'bc_recu'
                      ? BC_RECU_STATUS_META[effectiveStatus as BcRecuStatus]
                      : BC_EMIS_STATUS_META[effectiveStatus as BcEmisStatus];

                  return (
                    <tr key={po.id} className="hover:bg-slate-50">
                      <td className="px-3 py-2.5 font-semibold text-slate-900 whitespace-nowrap">
                        <div className="inline-flex items-center gap-1.5">
                          <span>{po.poNumber}</span>
                          {(po.isImported || po.tags?.includes('Importé')) && (
                            <span className="rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-[#1D4ED8]">
                              Importé
                            </span>
                          )}
                        </div>
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
                      <td className="px-3 py-2.5 text-slate-800">{contactLabel}</td>
                      <td className="px-3 py-2.5 text-slate-600 tabular-nums whitespace-nowrap">
                        {formatDateFr(po.issueDate)}
                      </td>
                      <td className="px-3 py-2.5 text-slate-700">
                        <div className="font-medium">{po.campaignRef || '—'}</div>
                        {(po.campaignStartDate || po.campaignEndDate) && (
                          <div className="text-[11px] text-slate-500">
                            {formatDateFr(po.campaignStartDate)} → {formatDateFr(po.campaignEndDate)}
                            {duration.days > 0 ? ` (${duration.label})` : ''}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-center whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() =>
                            setAttModal({
                              parentId: po.id,
                              parentType: direction,
                              title: `Pièces jointes — BC ${po.poNumber}`,
                            })
                          }
                          title={
                            attCount > 0
                              ? 'Consulter / gérer les scans et PDF'
                              : 'Joindre un scan ou PDF'
                          }
                          className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium ${
                            attCount > 0
                              ? 'bg-blue-50 text-[#1D4ED8] hover:bg-blue-100'
                              : 'text-slate-400 hover:bg-slate-100 hover:text-slate-700'
                          }`}
                        >
                          <Paperclip className="h-3.5 w-3.5" />
                          <span>{attCount > 0 ? attCount : '+'}</span>
                        </button>
                      </td>
                      <td className="px-3 py-2.5 text-right font-semibold text-slate-900 tabular-nums whitespace-nowrap">
                        {po.totalTtcCentimes > 0
                          ? formatMoney(po.totalTtcCentimes, po.currency, currencies)
                          : '—'}
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        <span
                          className={`inline-block rounded px-2 py-0.5 text-[11px] font-medium ${
                            badge?.badgeClass || 'bg-slate-100 text-slate-700'
                          }`}
                        >
                          {badge?.label || effectiveStatus}
                        </span>
                        {linkedInvoices.length > 0 && (
                          <div className="mt-0.5 text-[10px] text-emerald-700">
                            Facture(s) : {linkedInvoices.map((i) => i.invoiceNumber).join(', ')}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1">
                          {direction === 'bc_recu' && effectiveStatus !== 'annule' && (
                            <>
                              <button
                                type="button"
                                onClick={() => setProformaPrefillPo(po)}
                                title="Créer le proforma depuis ce BC"
                                className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100"
                              >
                                <FileCheck2 className="h-3 w-3" />
                                <span>Proforma</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => setInvoicePrefillPo(po)}
                                title="Créer la facture depuis ce BC"
                                className="inline-flex items-center gap-1 rounded border border-emerald-300 bg-emerald-50 px-2 py-1 text-[11px] font-medium text-emerald-800 hover:bg-emerald-100"
                              >
                                <FileText className="h-3 w-3" />
                                <span>Facturer</span>
                              </button>
                            </>
                          )}
                          {direction === 'bc_emis' && (
                            <button
                              type="button"
                              onClick={() => setPrintTargetId(po.id)}
                              title="Aperçu & Impression PDF A4"
                              className="rounded p-1 text-slate-600 hover:bg-slate-100"
                            >
                              <Printer className="h-3.5 w-3.5" />
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => {
                              setEditingPo(po);
                              setPoModalOpen(true);
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
                                id: po.id,
                                label: `le bon de commande ${po.poNumber}`,
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
                }
              )
            )}
          </tbody>
        </table>
      </div>

      {/* Modale Création / Édition BC */}
      <PurchaseOrderFormModal
        open={poModalOpen}
        direction={direction}
        existingPo={editingPo}
        onClose={() => {
          setPoModalOpen(false);
          setEditingPo(undefined);
        }}
      />

      {/* Créer Proforma depuis BC reçu */}
      <ProformaFormModal
        open={Boolean(proformaPrefillPo)}
        prefillFromBc={proformaPrefillPo}
        onClose={() => setProformaPrefillPo(undefined)}
      />

      {/* Créer Facture depuis BC reçu */}
      <InvoiceFormModal
        open={Boolean(invoicePrefillPo)}
        mode="client"
        prefillFromBc={invoicePrefillPo}
        onClose={() => setInvoicePrefillPo(undefined)}
      />

      {/* Aperçu pièces jointes */}
      {attModal && (
        <AttachmentPreviewModal
          open={Boolean(attModal)}
          parentId={attModal.parentId}
          parentType={attModal.parentType}
          title={attModal.title}
          onClose={() => setAttModal(null)}
        />
      )}

      {/* Aperçu PDF A4 pour BC émis */}
      {printTarget && direction === 'bc_emis' && (() => {
        const resolvedProfile = printTarget.issuerProfile;
        return (
          <PrintDocumentModal
            open={Boolean(printTarget)}
            title={`Bon de commande ${printTarget.po.poNumber}`}
            fileName={buildPdfFileName(
              'bc_emis',
              printTarget.po.poNumber,
              printTarget.contactLabel
            )}
            settings={settings}
            companyProfile={resolvedProfile}
            fallbackPrintRoute={`/imprimer/bc/${printTarget.po.id}`}
            rawLayout
            onClose={() => setPrintTargetId(null)}
          >
          <SharedDocumentTemplate
            docKind="bc_emis"
            docNumber={printTarget.po.poNumber}
            issueDate={printTarget.po.issueDate}
            dueDate={printTarget.po.expectedDate}
            campaignRef={printTarget.po.campaignRef}
            campaignStartDate={printTarget.po.campaignStartDate}
            campaignEndDate={printTarget.po.campaignEndDate}
            showCampaignOnPrint={printTarget.po.showCampaignOnPrint}
            profile={resolvedProfile}
            settings={settings}
            contact={printTarget.contact}
            currency={printTarget.po.currency}
            lines={printTarget.po.lines}
            totalHtCentimes={printTarget.po.totalHtCentimes}
            totalTvaCentimes={printTarget.po.totalTvaCentimes}
            totalTtcCentimes={printTarget.po.totalTtcCentimes}
            amountInWordsOverride={printTarget.po.amountInWordsOverride}
            notes={printTarget.po.notes}
            unpriced={printTarget.po.unpriced}
          />
        </PrintDocumentModal>
        );
      })()}

      <SafeDeleteDialog
        open={Boolean(deleteTarget)}
        entityType="purchaseOrder"
        entityId={deleteTarget?.id || ''}
        entityLabel={deleteTarget?.label || ''}
        onClose={() => setDeleteTarget(null)}
      />

      <PurchaseOrderImportModal
        open={importModalOpen}
        defaultDirection={direction}
        onClose={() => setImportModalOpen(false)}
        onSaved={(saved) => {
          setDirection(saved.direction);
          setStatusFilter('tous');
        }}
        onCreateProforma={(po) => {
          setImportModalOpen(false);
          setDirection('bc_recu');
          setProformaPrefillPo(po);
        }}
        onCreateInvoice={(po) => {
          setImportModalOpen(false);
          setDirection('bc_recu');
          setInvoicePrefillPo(po);
        }}
        onPrintBcEmis={(po) => {
          setImportModalOpen(false);
          setDirection('bc_emis');
          setPrintTargetId(po.id);
        }}
      />
    </div>
  );
};
