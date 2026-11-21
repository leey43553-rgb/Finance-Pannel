import React, { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  Download,
  EyeOff,
  FileSpreadsheet,
  Link2,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { db } from '../db/database';
import {
  downloadInvoiceModelErrorsExcel,
  executeInvoiceModelImport,
  validateInvoiceModelItems,
  type InvoiceModelEditableItem,
  type ValidatedInvoiceModelItem,
} from '../services/excelService';
import { useAppStore } from '../store/useAppStore';
import { formatMoneyNumberOnly } from '../utils/money';

interface InvoiceModelPreviewPanelProps {
  items: InvoiceModelEditableItem[];
  onChangeItems: React.Dispatch<React.SetStateAction<InvoiceModelEditableItem[]>>;
  ignoredSheets: Array<{ fileName: string; sheetName: string; reason: string }>;
  fileCount: number;
  onImportSuccess?: (summary: {
    invoicesCreatedCount: number;
    clientsCreatedCount: number;
    campaignsCreatedCount: number;
    bcsLinkedCount: number;
  }) => void;
  onCancelFormMode?: () => void;
}

export const InvoiceModelPreviewPanel: React.FC<InvoiceModelPreviewPanelProps> = ({
  items,
  onChangeItems,
  ignoredSheets,
  fileCount,
  onImportSuccess,
  onCancelFormMode,
}) => {
  const pushToast = useAppStore((s) => s.pushToast);
  const settings = useLiveQuery(() => db.settings.get('company_settings'));
  const contacts = useLiveQuery(() => db.contacts.filter((c) => !c.deletedAt).toArray(), [], []);
  const customerInvoices = useLiveQuery(
    () => db.customerInvoices.filter((i) => !i.deletedAt).toArray(),
    [],
    []
  );
  const purchaseOrders = useLiveQuery(
    () => db.purchaseOrders.filter((p) => !p.deletedAt).toArray(),
    [],
    []
  );
  const companyProfiles = useLiveQuery(
    () => db.companyProfiles.filter((p) => !p.deletedAt).toArray(),
    [],
    []
  );

  const [selectedId, setSelectedId] = useState<string>(items[0]?.id || '');
  const [isImporting, setIsImporting] = useState(false);

  useEffect(() => {
    if (!items.some((i) => i.id === selectedId)) {
      setSelectedId(items[0]?.id || '');
    }
  }, [items, selectedId]);

  const validatedItems = useMemo<ValidatedInvoiceModelItem[]>(() => {
    return validateInvoiceModelItems({
      items,
      existingInvoices: customerInvoices,
      profiles: companyProfiles,
      contacts,
      purchaseOrders,
    });
  }, [items, customerInvoices, companyProfiles, contacts, purchaseOrders]);

  const counts = useMemo(() => {
    const active = validatedItems.filter((v) => !v.item.excluded);
    const valides = active.filter((v) => v.status === 'valide').length;
    const alertes = active.filter((v) => v.status === 'alerte').length;
    const doublons = active.filter((v) => v.status === 'doublon').length;
    const erreurs = active.filter((v) => v.status === 'erreur').length;
    const readyCount = active.filter(
      (v) => v.blockingErrors.length === 0 && !v.isDuplicate
    ).length;
    return { valides, alertes, doublons, erreurs, readyCount };
  }, [validatedItems]);

  const selectedValidated = useMemo(
    () => validatedItems.find((v) => v.item.id === selectedId) || validatedItems[0] || null,
    [validatedItems, selectedId]
  );

  const updateItem = (
    id: string,
    updater: (prev: InvoiceModelEditableItem) => InvoiceModelEditableItem
  ) => {
    onChangeItems((prev) => prev.map((it) => (it.id === id ? updater(it) : it)));
  };

  const recalcTotalsFromLines = (it: InvoiceModelEditableItem): InvoiceModelEditableItem => {
    const ht = Math.round(it.lines.reduce((s, l) => s + (Number(l.total) || 0), 0) * 100) / 100;
    const vatRate = Number.isFinite(it.totals.vatRate) ? it.totals.vatRate : 19;
    const vat = Math.round(ht * vatRate) / 100;
    const ttc = Math.round((ht + vat) * 100) / 100;
    return {
      ...it,
      totals: { ht, vatRate, vat, ttc },
    };
  };

  const handleConfirmImport = async () => {
    if (!settings || counts.readyCount === 0) return;
    setIsImporting(true);
    try {
      const res = await executeInvoiceModelImport({
        validatedItems,
        settings,
      });
      const details = [
        `${res.invoicesCreatedCount} facture(s) importée(s)`,
        res.clientsCreatedCount ? `${res.clientsCreatedCount} client(s) créé(s)` : '',
        res.campaignsCreatedCount ? `${res.campaignsCreatedCount} campagne(s) créée(s)` : '',
        res.bcsLinkedCount ? `${res.bcsLinkedCount} BC lié(s)` : '',
      ]
        .filter(Boolean)
        .join(' · ');

      pushToast({
        type: 'success',
        title: 'Importation réussie',
        message: details,
      });
      onImportSuccess?.(res);
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Échec de l’importation',
        message: err instanceof Error ? err.message : 'Erreur lors de l’enregistrement.',
      });
    } finally {
      setIsImporting(false);
    }
  };

  const hasReportItems =
    counts.alertes > 0 ||
    counts.doublons > 0 ||
    counts.erreurs > 0 ||
    ignoredSheets.length > 0;

  return (
    <div className="space-y-4">
      {/* Bannière détection automatique Mode 1 */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-blue-200 bg-blue-50/70 px-4 py-3">
        <div className="flex items-start gap-2.5">
          <FileSpreadsheet className="mt-0.5 h-4 w-4 shrink-0 text-[#1D4ED8]" />
          <div className="text-xs text-slate-800">
            <div className="font-semibold text-[#0F1E36]">
              Mode 1 détecté automatiquement : Modèle facture ({items.length} facture(s) trouvée(s)
              sur {fileCount} fichier(s))
            </div>
            <p className="mt-0.5 text-[11px] text-slate-600">
              Cliquez sur une ligne pour consulter les prestations détectées ou corriger les champs
              avant importation.
              {ignoredSheets.length > 0 && (
                <span className="ml-1 text-slate-500">
                  ({ignoredSheets.length} feuille(s) sans « FACTURE N° » ignorée(s))
                </span>
              )}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {hasReportItems && (
            <button
              type="button"
              onClick={() =>
                downloadInvoiceModelErrorsExcel({
                  validatedItems,
                  ignoredSheets,
                })
              }
              className="inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-white px-3 py-1.5 text-xs font-semibold text-amber-800 hover:bg-amber-50"
            >
              <Download className="h-3.5 w-3.5" />
              <span>Rapport d’erreurs / alertes (.xlsx)</span>
            </button>
          )}
          {onCancelFormMode && (
            <button
              type="button"
              onClick={onCancelFormMode}
              className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
            >
              Vider la liste
            </button>
          )}
        </div>
      </div>

      {/* Compteurs */}
      <div className="flex flex-wrap items-center gap-4 text-xs">
        <span className="inline-flex items-center gap-1 font-semibold text-emerald-700">
          <CheckCircle2 className="h-4 w-4" />
          {counts.valides} prête(s)
        </span>
        {counts.alertes > 0 && (
          <span className="inline-flex items-center gap-1 font-semibold text-orange-700">
            <AlertTriangle className="h-4 w-4" />
            {counts.alertes} avec alerte(s) (importables)
          </span>
        )}
        {counts.doublons > 0 && (
          <span className="inline-flex items-center gap-1 font-semibold text-amber-700">
            <AlertTriangle className="h-4 w-4" />
            {counts.doublons} doublon(s) bloqué(s)
          </span>
        )}
        {counts.erreurs > 0 && (
          <span className="inline-flex items-center gap-1 font-semibold text-red-700">
            <AlertTriangle className="h-4 w-4" />
            {counts.erreurs} erreur(s) bloquante(s)
          </span>
        )}
      </div>

      {/* Tableau récapitulatif des factures détectées */}
      <div className="max-h-64 overflow-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 border-b border-slate-200 bg-slate-50 font-semibold text-slate-600">
            <tr>
              <th className="px-2.5 py-2">Fichier / Feuille</th>
              <th className="px-2.5 py-2">N° Facture</th>
              <th className="px-2.5 py-2">Date</th>
              <th className="px-2.5 py-2">Client</th>
              <th className="px-2.5 py-2">Réf. BC</th>
              <th className="px-2.5 py-2 text-center">Lignes</th>
              <th className="px-2.5 py-2 text-right">HT</th>
              <th className="px-2.5 py-2 text-right">TVA</th>
              <th className="px-2.5 py-2 text-right">TTC</th>
              <th className="px-2.5 py-2">Société</th>
              <th className="px-2.5 py-2">État / Alertes</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {validatedItems.map((v) => {
              const it = v.item;
              const isSelected = selectedValidated?.item.id === it.id;
              const allMessages = [
                ...v.blockingErrors,
                ...(v.duplicateReason ? [v.duplicateReason] : []),
                ...v.warnings,
              ];
              return (
                <tr
                  key={it.id}
                  onClick={() => setSelectedId(it.id)}
                  className={`cursor-pointer transition-colors ${
                    it.excluded
                      ? 'bg-slate-100/80 opacity-60'
                      : isSelected
                      ? 'bg-blue-50/70'
                      : v.status === 'erreur'
                      ? 'bg-red-50/50 hover:bg-red-50'
                      : v.status === 'doublon'
                      ? 'bg-amber-50/50 hover:bg-amber-50'
                      : v.status === 'alerte'
                      ? 'bg-orange-50/40 hover:bg-orange-50/70'
                      : 'hover:bg-slate-50'
                  }`}
                >
                  <td className="px-2.5 py-2">
                    <div className="font-medium text-slate-800 truncate max-w-[140px]" title={it.fileName}>
                      {it.fileName}
                    </div>
                    <div className="text-[10px] text-slate-500">{it.sheet}</div>
                  </td>
                  <td className="px-2.5 py-2 font-mono font-semibold text-slate-900 whitespace-nowrap">
                    {it.number || '—'}
                  </td>
                  <td className="px-2.5 py-2 tabular-nums text-slate-700 whitespace-nowrap">
                    {it.date || '—'}
                  </td>
                  <td className="px-2.5 py-2 text-slate-800 max-w-[160px] truncate" title={it.client.name}>
                    {it.client.name || '—'}
                  </td>
                  <td className="px-2.5 py-2 text-slate-600 whitespace-nowrap">
                    {it.refBc || '—'}
                  </td>
                  <td className="px-2.5 py-2 text-center font-semibold text-slate-700">
                    {it.lines.length}
                  </td>
                  <td className="px-2.5 py-2 text-right tabular-nums text-slate-700 whitespace-nowrap">
                    {formatMoneyNumberOnly(Math.round(it.totals.ht * 100))}
                  </td>
                  <td className="px-2.5 py-2 text-right tabular-nums text-slate-600 whitespace-nowrap">
                    {formatMoneyNumberOnly(Math.round(it.totals.vat * 100))}
                  </td>
                  <td className="px-2.5 py-2 text-right font-semibold tabular-nums text-slate-900 whitespace-nowrap">
                    {formatMoneyNumberOnly(Math.round(it.totals.ttc * 100))}
                  </td>
                  <td className="px-2.5 py-2 text-[11px] text-slate-700 whitespace-nowrap">
                    {v.matchedCompanyProfile?.name || '—'}
                  </td>
                  <td className="px-2.5 py-2">
                    {it.excluded ? (
                      <span className="inline-flex items-center gap-1 rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-medium text-slate-700">
                        <EyeOff className="h-3 w-3" /> Exclue
                      </span>
                    ) : v.status === 'erreur' ? (
                      <span
                        title={allMessages.join(' | ')}
                        className="inline-block rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-800"
                      >
                        Erreur ({v.blockingErrors.length})
                      </span>
                    ) : v.status === 'doublon' ? (
                      <span
                        title={allMessages.join(' | ')}
                        className="inline-block rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800"
                      >
                        Doublon
                      </span>
                    ) : v.status === 'alerte' ? (
                      <span
                        title={allMessages.join(' | ')}
                        className="inline-block rounded bg-orange-100 px-1.5 py-0.5 text-[10px] font-semibold text-orange-800"
                      >
                        Alerte ({v.warnings.length})
                      </span>
                    ) : (
                      <span className="inline-block rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800">
                        Prête
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Panneau d'inspection & d'édition de la facture sélectionnée */}
      {selectedValidated && (
        <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-4 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-2.5">
            <div>
              <h4 className="text-sm font-semibold text-slate-900">
                Aperçu & modification : {selectedValidated.item.fileName} — feuille «{' '}
                {selectedValidated.item.sheet} »
              </h4>
              <div className="mt-1 flex flex-wrap items-center gap-3 text-[11px] text-slate-600">
                <span className="inline-flex items-center gap-1">
                  <Building2 className="h-3.5 w-3.5 text-slate-400" />
                  {selectedValidated.matchedClient ? (
                    <span className="text-emerald-700 font-medium">
                      Client existant associé : {selectedValidated.matchedClient.company || selectedValidated.matchedClient.name}
                    </span>
                  ) : (
                    <span className="text-blue-700 font-medium">
                      Nouveau client créé automatiquement à l’import
                    </span>
                  )}
                </span>
                {selectedValidated.matchedBc && (
                  <span className="inline-flex items-center gap-1 text-emerald-700 font-medium">
                    <Link2 className="h-3.5 w-3.5" />
                    BC reçu trouvé : {selectedValidated.matchedBc.poNumber}
                  </span>
                )}
              </div>
            </div>

            <label className="inline-flex items-center gap-1.5 rounded border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={Boolean(selectedValidated.item.excluded)}
                onChange={(e) =>
                  updateItem(selectedValidated.item.id, (prev) => ({
                    ...prev,
                    excluded: e.target.checked,
                  }))
                }
                className="rounded border-slate-300"
              />
              <span>Exclure cette facture du lot</span>
            </label>
          </div>

          {/* Messages d'erreurs / alertes / doublons */}
          {(selectedValidated.blockingErrors.length > 0 ||
            selectedValidated.duplicateReason ||
            selectedValidated.warnings.length > 0) && (
            <div className="space-y-1.5">
              {selectedValidated.blockingErrors.map((err, idx) => (
                <div
                  key={`err-${idx}`}
                  className="rounded border border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-800"
                >
                  <strong>Erreur :</strong> {err}
                </div>
              ))}
              {selectedValidated.duplicateReason && (
                <div className="rounded border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-800">
                  <strong>Doublon :</strong> {selectedValidated.duplicateReason}
                </div>
              )}
              {selectedValidated.warnings.map((w, idx) => (
                <div
                  key={`warn-${idx}`}
                  className="rounded border border-orange-200 bg-orange-50 px-3 py-1.5 text-xs text-orange-800"
                >
                  <strong>Avertissement :</strong> {w}
                </div>
              ))}
            </div>
          )}

          {/* Champs généraux éditables */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <label className="block text-[11px] font-semibold text-slate-700">N° Facture *</label>
              <input
                type="text"
                value={selectedValidated.item.number}
                onChange={(e) =>
                  updateItem(selectedValidated.item.id, (prev) => ({
                    ...prev,
                    number: e.target.value,
                  }))
                }
                className="mt-1 w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-mono"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-700">Date *</label>
              <input
                type="date"
                value={selectedValidated.item.date}
                onChange={(e) =>
                  updateItem(selectedValidated.item.id, (prev) => ({
                    ...prev,
                    date: e.target.value,
                  }))
                }
                className="mt-1 w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-700">Réf. BC client</label>
              <input
                type="text"
                value={selectedValidated.item.refBc}
                onChange={(e) =>
                  updateItem(selectedValidated.item.id, (prev) => ({
                    ...prev,
                    refBc: e.target.value,
                  }))
                }
                className="mt-1 w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-700">
                Société émettrice
              </label>
              <select
                value={selectedValidated.item.companyProfileId}
                onChange={(e) =>
                  updateItem(selectedValidated.item.id, (prev) => ({
                    ...prev,
                    companyProfileId: e.target.value,
                  }))
                }
                className="mt-1 w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium"
              >
                {companyProfiles.map((prof) => (
                  <option key={prof.id} value={prof.id}>
                    {prof.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Client + Campagne */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="sm:col-span-2">
              <label className="block text-[11px] font-semibold text-slate-700">Client *</label>
              <input
                type="text"
                value={selectedValidated.item.client.name}
                onChange={(e) =>
                  updateItem(selectedValidated.item.id, (prev) => ({
                    ...prev,
                    client: { ...prev.client, name: e.target.value },
                  }))
                }
                className="mt-1 w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-700">Campagne</label>
              <input
                type="text"
                value={selectedValidated.item.campaignName}
                onChange={(e) =>
                  updateItem(selectedValidated.item.id, (prev) => ({
                    ...prev,
                    campaignName: e.target.value,
                  }))
                }
                placeholder="Ex : CMP Coke Summer"
                className="mt-1 w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
              />
            </div>
            <div className="flex items-end pb-1">
              <label className="inline-flex items-center gap-1.5 text-xs text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={selectedValidated.item.createCampaign}
                  onChange={(e) =>
                    updateItem(selectedValidated.item.id, (prev) => ({
                      ...prev,
                      createCampaign: e.target.checked,
                    }))
                  }
                  className="rounded border-slate-300"
                />
                <span>Créer / associer la campagne</span>
              </label>
            </div>
          </div>

          {/* Coordonnées & identifiants fiscaux du client */}
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 lg:grid-cols-6">
            <div className="col-span-2">
              <label className="block text-[10px] font-semibold text-slate-600">Adresse</label>
              <input
                type="text"
                value={selectedValidated.item.client.address}
                onChange={(e) =>
                  updateItem(selectedValidated.item.id, (prev) => ({
                    ...prev,
                    client: { ...prev.client, address: e.target.value },
                  }))
                }
                className="mt-0.5 w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs"
              />
            </div>
            <div>
              <label className="block text-[10px] font-semibold text-slate-600">Ville</label>
              <input
                type="text"
                value={selectedValidated.item.client.city}
                onChange={(e) =>
                  updateItem(selectedValidated.item.id, (prev) => ({
                    ...prev,
                    client: { ...prev.client, city: e.target.value },
                  }))
                }
                className="mt-0.5 w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs"
              />
            </div>
            <div>
              <label className="block text-[10px] font-semibold text-slate-600">NIF client</label>
              <input
                type="text"
                value={selectedValidated.item.client.nif}
                onChange={(e) =>
                  updateItem(selectedValidated.item.id, (prev) => ({
                    ...prev,
                    client: { ...prev.client, nif: e.target.value },
                  }))
                }
                className="mt-0.5 w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs font-mono"
              />
            </div>
            <div>
              <label className="block text-[10px] font-semibold text-slate-600">RC client</label>
              <input
                type="text"
                value={selectedValidated.item.client.rc}
                onChange={(e) =>
                  updateItem(selectedValidated.item.id, (prev) => ({
                    ...prev,
                    client: { ...prev.client, rc: e.target.value },
                  }))
                }
                className="mt-0.5 w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs font-mono"
              />
            </div>
            <div>
              <label className="block text-[10px] font-semibold text-slate-600">AI client</label>
              <input
                type="text"
                value={selectedValidated.item.client.ai}
                onChange={(e) =>
                  updateItem(selectedValidated.item.id, (prev) => ({
                    ...prev,
                    client: { ...prev.client, ai: e.target.value },
                  }))
                }
                className="mt-0.5 w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs font-mono"
              />
            </div>
          </div>

          {/* Lignes de prestations détectées (éditables) */}
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-semibold text-slate-800">
                Lignes de la facture ({selectedValidated.item.lines.length})
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() =>
                    updateItem(selectedValidated.item.id, (prev) => recalcTotalsFromLines(prev))
                  }
                  className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100"
                >
                  <RefreshCw className="h-3 w-3" />
                  <span>Recalculer HT/TVA/TTC</span>
                </button>
                <button
                  type="button"
                  onClick={() =>
                    updateItem(selectedValidated.item.id, (prev) => ({
                      ...prev,
                      lines: [
                        ...prev.lines,
                        {
                          title: 'Prestation',
                          description: '',
                          qty: 1,
                          unit: 'u',
                          unitPrice: 0,
                          total: 0,
                        },
                      ],
                    }))
                  }
                  className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100"
                >
                  <Plus className="h-3 w-3" />
                  <span>Ajouter ligne</span>
                </button>
              </div>
            </div>

            <div className="overflow-x-auto rounded border border-slate-200 bg-white">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 bg-slate-50 font-semibold text-slate-600">
                  <tr>
                    <th className="px-2 py-1.5">Titre & Désignation</th>
                    <th className="px-2 py-1.5 w-20">Qté</th>
                    <th className="px-2 py-1.5 w-20">Unité</th>
                    <th className="px-2 py-1.5 w-28 text-right">Prix U. HT</th>
                    <th className="px-2 py-1.5 w-28 text-right">Total HT</th>
                    <th className="px-2 py-1.5 w-10"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {selectedValidated.item.lines.map((line, lIdx) => (
                    <tr key={lIdx}>
                      <td className="px-2 py-1.5 space-y-1">
                        <input
                          type="text"
                          value={line.title}
                          placeholder="Titre (ex: CMP Coke Summer)"
                          onChange={(e) =>
                            updateItem(selectedValidated.item.id, (prev) => ({
                              ...prev,
                              lines: prev.lines.map((x, idx) =>
                                idx === lIdx ? { ...x, title: e.target.value } : x
                              ),
                            }))
                          }
                          className="w-full rounded border border-slate-300 px-2 py-1 text-xs font-semibold"
                        />
                        <textarea
                          rows={2}
                          value={line.description}
                          placeholder="Détail de la prestation..."
                          onChange={(e) =>
                            updateItem(selectedValidated.item.id, (prev) => ({
                              ...prev,
                              lines: prev.lines.map((x, idx) =>
                                idx === lIdx ? { ...x, description: e.target.value } : x
                              ),
                            }))
                          }
                          className="w-full rounded border border-slate-300 px-2 py-1 text-[11px]"
                        />
                      </td>
                      <td className="px-2 py-1.5 align-top">
                        <input
                          type="number"
                          step="any"
                          value={line.qty}
                          onChange={(e) => {
                            const qty = Number(e.target.value) || 0;
                            updateItem(selectedValidated.item.id, (prev) =>
                              recalcTotalsFromLines({
                                ...prev,
                                lines: prev.lines.map((x, idx) =>
                                  idx === lIdx
                                    ? {
                                        ...x,
                                        qty,
                                        total: Math.round(qty * x.unitPrice * 100) / 100,
                                      }
                                    : x
                                ),
                              })
                            );
                          }}
                          className="w-full rounded border border-slate-300 px-2 py-1 text-xs tabular-nums"
                        />
                      </td>
                      <td className="px-2 py-1.5 align-top">
                        <input
                          type="text"
                          value={line.unit}
                          onChange={(e) =>
                            updateItem(selectedValidated.item.id, (prev) => ({
                              ...prev,
                              lines: prev.lines.map((x, idx) =>
                                idx === lIdx ? { ...x, unit: e.target.value } : x
                              ),
                            }))
                          }
                          className="w-full rounded border border-slate-300 px-2 py-1 text-xs"
                        />
                      </td>
                      <td className="px-2 py-1.5 align-top">
                        <input
                          type="number"
                          step="any"
                          value={line.unitPrice}
                          onChange={(e) => {
                            const unitPrice = Number(e.target.value) || 0;
                            updateItem(selectedValidated.item.id, (prev) =>
                              recalcTotalsFromLines({
                                ...prev,
                                lines: prev.lines.map((x, idx) =>
                                  idx === lIdx
                                    ? {
                                        ...x,
                                        unitPrice,
                                        total: Math.round(x.qty * unitPrice * 100) / 100,
                                      }
                                    : x
                                ),
                              })
                            );
                          }}
                          className="w-full rounded border border-slate-300 px-2 py-1 text-right text-xs tabular-nums"
                        />
                      </td>
                      <td className="px-2 py-1.5 align-top">
                        <input
                          type="number"
                          step="any"
                          value={line.total}
                          onChange={(e) => {
                            const total = Number(e.target.value) || 0;
                            updateItem(selectedValidated.item.id, (prev) =>
                              recalcTotalsFromLines({
                                ...prev,
                                lines: prev.lines.map((x, idx) =>
                                  idx === lIdx ? { ...x, total } : x
                                ),
                              })
                            );
                          }}
                          className="w-full rounded border border-slate-300 px-2 py-1 text-right text-xs font-semibold tabular-nums"
                        />
                      </td>
                      <td className="px-2 py-1.5 align-top text-center">
                        <button
                          type="button"
                          onClick={() =>
                            updateItem(selectedValidated.item.id, (prev) =>
                              recalcTotalsFromLines({
                                ...prev,
                                lines: prev.lines.filter((_, idx) => idx !== lIdx),
                              })
                            )
                          }
                          title="Supprimer cette ligne"
                          className="rounded p-1 text-red-600 hover:bg-red-50"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Totaux HT / TVA / TTC */}
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 pt-1">
              <div>
                <label className="block text-[10px] font-semibold text-slate-600">Total HT</label>
                <input
                  type="number"
                  step="any"
                  value={selectedValidated.item.totals.ht}
                  onChange={(e) => {
                    const ht = Number(e.target.value) || 0;
                    updateItem(selectedValidated.item.id, (prev) => ({
                      ...prev,
                      totals: { ...prev.totals, ht },
                    }));
                  }}
                  className="mt-0.5 w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs font-semibold tabular-nums"
                />
              </div>
              <div>
                <label className="block text-[10px] font-semibold text-slate-600">Taux TVA (%)</label>
                <input
                  type="number"
                  step="any"
                  value={selectedValidated.item.totals.vatRate}
                  onChange={(e) => {
                    const vatRate = Number(e.target.value) || 0;
                    updateItem(selectedValidated.item.id, (prev) => ({
                      ...prev,
                      totals: { ...prev.totals, vatRate },
                    }));
                  }}
                  className="mt-0.5 w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs tabular-nums"
                />
              </div>
              <div>
                <label className="block text-[10px] font-semibold text-slate-600">Montant TVA</label>
                <input
                  type="number"
                  step="any"
                  value={selectedValidated.item.totals.vat}
                  onChange={(e) => {
                    const vat = Number(e.target.value) || 0;
                    updateItem(selectedValidated.item.id, (prev) => ({
                      ...prev,
                      totals: { ...prev.totals, vat },
                    }));
                  }}
                  className="mt-0.5 w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs tabular-nums"
                />
              </div>
              <div>
                <label className="block text-[10px] font-semibold text-slate-600">Total TTC</label>
                <input
                  type="number"
                  step="any"
                  value={selectedValidated.item.totals.ttc}
                  onChange={(e) => {
                    const ttc = Number(e.target.value) || 0;
                    updateItem(selectedValidated.item.id, (prev) => ({
                      ...prev,
                      totals: { ...prev.totals, ttc },
                    }));
                  }}
                  className="mt-0.5 w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs font-bold text-slate-900 tabular-nums"
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Bouton de validation finale */}
      <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
        <button
          type="button"
          disabled={isImporting || counts.readyCount === 0}
          onClick={handleConfirmImport}
          className="inline-flex items-center gap-2 rounded-md bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          <CheckCircle2 className="h-4 w-4" />
          <span>
            {isImporting
              ? 'Importation en cours...'
              : `Importer ${counts.readyCount} facture(s) (${counts.alertes > 0 ? `dont ${counts.alertes} avec alerte` : 'prêtes'})`}
          </span>
        </button>
      </div>
    </div>
  );
};
