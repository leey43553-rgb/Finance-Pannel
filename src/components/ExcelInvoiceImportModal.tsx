import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Upload,
  X,
} from 'lucide-react';
import { db } from '../db/database';
import {
  autoDetectColumnMapping,
  downloadExcelImportTemplate,
  downloadImportErrorsExcel,
  executeValidatedImport,
  IMPORT_SCHEMAS,
  parseExcelBuffer,
  processInvoiceImportFiles,
  validateImportRows,
  type InvoiceModelEditableItem,
  type ParsedExcelSheet,
} from '../services/excelService';
import { useAppStore } from '../store/useAppStore';
import { InvoiceModelPreviewPanel } from './InvoiceModelPreviewPanel';

interface ExcelInvoiceImportModalProps {
  open: boolean;
  onClose: () => void;
}

export const ExcelInvoiceImportModal: React.FC<ExcelInvoiceImportModalProps> = ({
  open,
  onClose,
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
  const bankAccounts = useLiveQuery(
    () => db.bankAccounts.filter((b) => !b.deletedAt).toArray(),
    [],
    []
  );
  const companyProfiles = useLiveQuery(
    () => db.companyProfiles.filter((p) => !p.deletedAt).toArray(),
    [],
    []
  );

  // Jeton monotone + clé de session React pour éliminer tout état obsolète entre fichiers
  const fileTokenRef = useRef(0);
  const [sessionKey, setSessionKey] = useState(0);

  // Mode auto-détecté ('form' = Modèle facture, 'table' = Tableau registre)
  const [detectedMode, setDetectedMode] = useState<'idle' | 'form' | 'table'>('idle');
  const [detectedSheetNames, setDetectedSheetNames] = useState<string[]>([]);
  const [isDragging, setIsDragging] = useState(false);

  // État Mode 1 (Modèle facture)
  const [formItems, setFormItems] = useState<InvoiceModelEditableItem[]>([]);
  const [formIgnoredSheets, setFormIgnoredSheets] = useState<
    Array<{ fileName: string; sheetName: string; reason: string }>
  >([]);
  const [loadedFileNames, setLoadedFileNames] = useState<string[]>([]);

  // État Mode 2 (Tableau registre)
  const [rawBuffer, setRawBuffer] = useState<ArrayBuffer | null>(null);
  const [parsedSheet, setParsedSheet] = useState<ParsedExcelSheet | null>(null);
  const [fileName, setFileName] = useState('');
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const [columnMapping, setColumnMapping] = useState<Record<string, string>>({});
  const [groupByInvoiceNumber, setGroupByInvoiceNumber] = useState(true);
  const [createMissingCampaigns, setCreateMissingCampaigns] = useState(true);
  const [createPaymentsForPaidRows, setCreatePaymentsForPaidRows] = useState(false);
  const [isImporting, setIsImporting] = useState(false);

  const defaultProfileId =
    settings?.activeCompanyProfileId ||
    companyProfiles.find((p) => p.isDefault)?.id ||
    companyProfiles[0]?.id ||
    '';
  const effectiveProfileId = selectedProfileId || defaultProfileId;

  const schema = IMPORT_SCHEMAS.factures_clients;
  const defaultCurrency = settings?.defaultCurrency || 'DZD';

  const resetModal = useCallback(() => {
    fileTokenRef.current += 1;
    setSessionKey((k) => k + 1);
    setDetectedMode('idle');
    setDetectedSheetNames([]);
    setFormItems([]);
    setFormIgnoredSheets([]);
    setLoadedFileNames([]);
    setRawBuffer(null);
    setParsedSheet(null);
    setFileName('');
    setColumnMapping({});
    setIsDragging(false);
  }, []);

  // Réinitialiser TOUT l'état d'importation à chaque ouverture de la fenêtre
  useEffect(() => {
    if (open) {
      resetModal();
    }
  }, [open, resetModal]);

  // Toujours calculer validationResults en direct depuis [parsedSheet?.rows, columnMapping] (jamais en state)
  const tableRows = parsedSheet?.rows;
  const validationResults = useMemo(() => {
    if (detectedMode !== 'table' || !tableRows || tableRows.length === 0) return [];
    return validateImportRows({
      type: 'factures_clients',
      rows: tableRows,
      mapping: columnMapping,
      options: { groupInvoicesByNumber: groupByInvoiceNumber },
      ctx: {
        contacts,
        customerInvoices,
        supplierInvoices: [],
        expenses: [],
        incomingCheques: [],
        outgoingCheques: [],
        chequeLeafKeys: new Set<string>(),
        bankAccounts,
        defaultTvaRate: settings?.defaultTvaRate ?? 19,
        defaultCurrency,
      },
    });
  }, [
    detectedMode,
    tableRows,
    columnMapping,
    groupByInvoiceNumber,
    contacts,
    customerInvoices,
    bankAccounts,
    settings,
    defaultCurrency,
  ]);

  const stats = useMemo(() => {
    const valides = validationResults.filter((r) => r.status === 'valide');
    const doublons = validationResults.filter((r) => r.status === 'doublon');
    const erreurs = validationResults.filter((r) => r.status === 'erreur');
    const distinctInvoices = groupByInvoiceNumber
      ? new Set(valides.map((r) => r.mapped.invoiceNumber.trim().toLowerCase())).size
      : valides.length;
    return { valides, doublons, erreurs, distinctInvoices };
  }, [validationResults, groupByInvoiceNumber]);

  if (!open) return null;

  const handleClose = () => {
    if (isImporting) return;
    resetModal();
    onClose();
  };

  const handleSelectImportFiles = async (fileList: FileList | File[]) => {
    const files = Array.from(fileList).filter((f) => /\.(xlsx|xls|csv)$/i.test(f.name));
    if (files.length === 0) {
      pushToast({
        type: 'warning',
        title: 'Format non pris en charge',
        message: 'Sélectionnez un ou plusieurs fichiers Excel (.xlsx, .xls, .csv).',
      });
      return;
    }

    // 1. Vider tout l'état précédent immédiatement avant d'analyser le nouveau fichier
    resetModal();
    const myToken = fileTokenRef.current;

    try {
      const buffers = await Promise.all(
        files.map(async (f) => ({
          fileName: f.name,
          buffer: await f.arrayBuffer(),
        }))
      );
      if (fileTokenRef.current !== myToken) return;

      const prepared = await processInvoiceImportFiles({
        files: buffers,
        profiles: companyProfiles,
        fallbackCompanyProfileId: effectiveProfileId,
        existingInvoices: customerInvoices,
        contacts,
        purchaseOrders,
      });
      if (fileTokenRef.current !== myToken) return;

      setSessionKey((k) => k + 1);

      if (prepared.mode === 'form') {
        setDetectedMode('form');
        setDetectedSheetNames(prepared.sheetNames);
        setFormItems(prepared.formItems);
        setFormIgnoredSheets(prepared.ignoredSheets);
        setLoadedFileNames(prepared.fileNames);
        setRawBuffer(null);
        setParsedSheet(null);
        setFileName('');
        setColumnMapping({});

        pushToast({
          type: 'info',
          title: 'Mode détecté : Modèle facture',
          message: `${prepared.formItems.length} facture(s) détectée(s) (feuille : ${prepared.sheetNames.join(', ')}).`,
        });
        return;
      }

      setDetectedMode('table');
      setDetectedSheetNames(prepared.activeSheetName ? [prepared.activeSheetName] : []);
      setRawBuffer(buffers[0].buffer);
      setParsedSheet(prepared.parsedSheet);
      setFileName(prepared.fileNames[0]);
      setLoadedFileNames(prepared.fileNames);
      setFormItems([]);
      setFormIgnoredSheets([]);
      setColumnMapping({ ...prepared.columnMapping });

      pushToast({
        type: 'info',
        title: 'Mode détecté : Tableau registre',
        message: `${prepared.parsedSheet?.rows.length || 0} ligne(s) détectée(s) dans « ${prepared.activeSheetName} ».`,
      });
    } catch (err) {
      if (fileTokenRef.current !== myToken) return;
      resetModal();
      pushToast({
        type: 'error',
        title: 'Lecture Excel impossible',
        message: err instanceof Error ? err.message : 'Fichier invalide.',
      });
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      await handleSelectImportFiles(e.target.files);
    }
    e.target.value = '';
  };

  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      await handleSelectImportFiles(e.dataTransfer.files);
    }
  };

  const handleSheetChange = async (sheetName: string) => {
    if (!rawBuffer) return;
    const myToken = fileTokenRef.current;
    try {
      const parsed = await parseExcelBuffer(rawBuffer, sheetName);
      if (fileTokenRef.current !== myToken) return;
      setSessionKey((k) => k + 1);
      setParsedSheet(parsed);
      setDetectedSheetNames([parsed.sheetName]);
      setColumnMapping(autoDetectColumnMapping('factures_clients', parsed.headers));
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Feuille illisible',
        message: err instanceof Error ? err.message : 'Cette feuille semble vide.',
      });
    }
  };

  const handleConfirmTableImport = async () => {
    if (!settings || stats.valides.length === 0) return;
    setIsImporting(true);
    try {
      const res = await executeValidatedImport({
        type: 'factures_clients',
        validRows: stats.valides,
        settings,
        companyProfileId: effectiveProfileId,
        fileName,
        groupByInvoiceNumber,
        createMissingCampaigns,
        createPaymentsForPaidRows,
      });
      const invCount = res.invoicesCreatedCount ?? stats.distinctInvoices;
      const details = [
        `${invCount} facture(s) créée(s) (${res.importedCount} ligne(s))`,
        res.campaignsCreatedCount ? `${res.campaignsCreatedCount} campagne(s) ajoutée(s)` : '',
        res.paymentsCreatedCount ? `${res.paymentsCreatedCount} règlement(s) enregistré(s)` : '',
      ]
        .filter(Boolean)
        .join(' · ');

      pushToast({
        type: 'success',
        title: 'Importation des factures réussie',
        message: details,
      });
      resetModal();
      onClose();
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
      <div className="flex max-h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
        {/* En-tête */}
        <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <FileSpreadsheet className="h-5 w-5 text-[#0F1E36]" />
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Importer des factures clients depuis Excel (.xlsx / .csv)
              </h2>
              <p className="text-xs text-slate-600">
                Mode détecté :{' '}
                <strong
                  className={
                    detectedMode === 'form'
                      ? 'text-emerald-700'
                      : detectedMode === 'table'
                      ? 'text-[#1D4ED8]'
                      : 'text-slate-700'
                  }
                >
                  {detectedMode === 'form'
                    ? 'Modèle facture'
                    : detectedMode === 'table'
                    ? 'Tableau registre'
                    : 'En attente d’un fichier'}
                </strong>
                {detectedSheetNames.length > 0 && (
                  <span className="ml-2 text-slate-500">
                    · Feuille(s) : <strong className="text-slate-800">{detectedSheetNames.join(', ')}</strong>
                  </span>
                )}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="rounded p-1.5 text-slate-500 hover:bg-slate-200 hover:text-slate-900"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Corps scrollable */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* Étape 1 : Sélection / Glisser-déposer multi-fichiers */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            className={`rounded-lg border-2 border-dashed p-4 transition-colors space-y-3 ${
              isDragging
                ? 'border-[#1D4ED8] bg-blue-50/70'
                : 'border-slate-300 bg-slate-50/70'
            }`}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  1. Choisir ou glisser-déposer vos fichiers Excel
                </h3>
                <p className="text-xs text-slate-600">
                  Sélectionnez un ou plusieurs classeurs contenant vos factures (feuilles « Modèle
                  facture ») ou un tableau registre.
                </p>
              </div>
              <button
                type="button"
                onClick={() => downloadExcelImportTemplate('factures_clients')}
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                <Download className="h-3.5 w-3.5 text-[#1D4ED8]" />
                <span>Télécharger le modèle registre (.xlsx)</span>
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-md bg-[#0F1E36] px-4 py-2 text-xs font-semibold text-white hover:bg-[#1a2f52]">
                <Upload className="h-4 w-4" />
                <span>
                  {loadedFileNames.length > 0
                    ? 'Choisir d’autres fichiers Excel...'
                    : 'Choisir un ou plusieurs fichiers (.xlsx, .xls, .csv)'}
                </span>
                <input
                  type="file"
                  multiple
                  accept=".xlsx,.xls,.csv"
                  onChange={handleFileChange}
                  className="hidden"
                />
              </label>

              {loadedFileNames.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-700">
                  <span>
                    {loadedFileNames.length === 1 ? 'Fichier :' : 'Fichiers :'}{' '}
                    <strong>{loadedFileNames.join(', ')}</strong>
                    {detectedMode === 'table' && parsedSheet && (
                      <span className="ml-1 text-slate-500">
                        ({parsedSheet.rows.length} ligne(s) de données)
                      </span>
                    )}
                  </span>
                  {detectedMode === 'table' && parsedSheet && parsedSheet.sheetNames.length > 1 && (
                    <label className="inline-flex items-center gap-1.5">
                      <span className="text-slate-500">Feuille :</span>
                      <select
                        value={parsedSheet.sheetName}
                        onChange={(e) => handleSheetChange(e.target.value)}
                        className="rounded border border-slate-300 bg-white px-2 py-1 text-xs font-medium"
                      >
                        {parsedSheet.sheetNames.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* MODE 1 : Modèle facture — n'affiche JAMAIS l'écran de correspondance de colonnes ni le tableau d'erreurs registre */}
          {detectedMode === 'form' && formItems.length > 0 && (
            <InvoiceModelPreviewPanel
              key={`form-${sessionKey}`}
              items={formItems}
              onChangeItems={setFormItems}
              ignoredSheets={formIgnoredSheets}
              fileCount={loadedFileNames.length}
              onCancelFormMode={resetModal}
              onImportSuccess={() => {
                resetModal();
                onClose();
              }}
            />
          )}

          {/* MODE 2 : Tableau registre (uniquement si aucune feuille modèle facture détectée) */}
          {detectedMode === 'table' && parsedSheet && (
            <div key={`table-${sessionKey}`} className="space-y-5">
              <div className="rounded-lg border border-slate-200 bg-white p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h3 className="text-sm font-semibold text-slate-900">
                    2. Mode tableau registre — Options d’importation
                  </h3>
                  {companyProfiles.length > 0 && (
                    <label className="inline-flex items-center gap-2 text-xs text-slate-700">
                      <span className="font-medium">Société émettrice :</span>
                      <select
                        value={effectiveProfileId}
                        onChange={(e) => setSelectedProfileId(e.target.value)}
                        className="rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-900"
                      >
                        {companyProfiles.map((prof) => (
                          <option key={prof.id} value={prof.id}>
                            {prof.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 text-xs text-slate-700">
                  <label className="flex items-start gap-2 rounded border border-slate-200 bg-slate-50 p-2.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={groupByInvoiceNumber}
                      onChange={(e) => setGroupByInvoiceNumber(e.target.checked)}
                      className="mt-0.5 rounded border-slate-300"
                    />
                    <span>
                      <strong>Regrouper par N° Facture</strong>
                      <span className="block text-[11px] text-slate-500">
                        Plusieurs lignes avec le même N° deviennent une seule facture multi-lignes.
                      </span>
                    </span>
                  </label>

                  <label className="flex items-start gap-2 rounded border border-slate-200 bg-slate-50 p-2.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={createMissingCampaigns}
                      onChange={(e) => setCreateMissingCampaigns(e.target.checked)}
                      className="mt-0.5 rounded border-slate-300"
                    />
                    <span>
                      <strong>Créer les campagnes absentes</strong>
                      <span className="block text-[11px] text-slate-500">
                        Si une campagne nommée dans Excel n’existe pas, elle est créée pour ce client.
                      </span>
                    </span>
                  </label>

                  <label className="flex items-start gap-2 rounded border border-slate-200 bg-slate-50 p-2.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={createPaymentsForPaidRows}
                      onChange={(e) => setCreatePaymentsForPaidRows(e.target.checked)}
                      className="mt-0.5 rounded border-slate-300"
                    />
                    <span>
                      <strong>Règlement si « Payée »</strong>
                      <span className="block text-[11px] text-slate-500">
                        Si la colonne Statut vaut « Payée », crée aussi un paiement validé au grand livre.
                      </span>
                    </span>
                  </label>
                </div>
              </div>

              <div className="rounded-lg border border-slate-200 bg-white p-4 space-y-3">
                <div>
                  <h3 className="text-sm font-semibold text-slate-900">
                    3. Correspondance des colonnes
                  </h3>
                  <p className="text-xs text-slate-500">
                    Indiquez au moins <strong>N° Facture</strong>, <strong>Client</strong>,{' '}
                    <strong>Date</strong> et soit <strong>Montant HT</strong>, soit{' '}
                    <strong>Qté + Prix unitaire HT</strong>, soit <strong>Montant TTC</strong>.
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
                  {schema.fields.map((field) => (
                    <div key={`${sessionKey}-${field.key}`} className="rounded border border-slate-200 bg-slate-50 p-2">
                      <label className="block text-[11px] font-semibold text-slate-800">
                        {field.label} {field.required && <span className="text-red-600">*</span>}
                      </label>
                      <select
                        value={columnMapping[field.key] || ''}
                        onChange={(e) =>
                          setColumnMapping((prev) => ({
                            ...prev,
                            [field.key]: e.target.value,
                          }))
                        }
                        className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                      >
                        <option value="">— Non mappé —</option>
                        {parsedSheet.headers.map((h) => (
                          <option key={h} value={h}>
                            {h}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-lg border border-slate-200 bg-white p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-4 text-xs">
                    <span className="inline-flex items-center gap-1 font-semibold text-emerald-700">
                      <CheckCircle2 className="h-4 w-4" />
                      {stats.valides.length} ligne(s) valide(s) → {stats.distinctInvoices} facture(s)
                    </span>
                    <span className="inline-flex items-center gap-1 font-semibold text-amber-700">
                      <AlertTriangle className="h-4 w-4" />
                      {stats.doublons.length} doublon(s)
                    </span>
                    <span className="inline-flex items-center gap-1 font-semibold text-red-700">
                      <AlertTriangle className="h-4 w-4" />
                      {stats.erreurs.length} erreur(s)
                    </span>
                  </div>

                  {(stats.erreurs.length > 0 || stats.doublons.length > 0) && (
                    <button
                      type="button"
                      onClick={() => downloadImportErrorsExcel(validationResults, 'factures_clients')}
                      className="inline-flex items-center gap-1.5 rounded-md border border-red-300 bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-100"
                    >
                      <Download className="h-3.5 w-3.5" />
                      <span>Rapport d’erreurs (.xlsx)</span>
                    </button>
                  )}
                </div>

                <div className="max-h-64 overflow-auto rounded border border-slate-200">
                  <table className="w-full text-left text-xs">
                    <thead className="sticky top-0 border-b border-slate-200 bg-slate-50 font-semibold text-slate-600">
                      <tr>
                        <th className="px-2.5 py-2">Ligne</th>
                        <th className="px-2.5 py-2">Contrôle</th>
                        <th className="px-2.5 py-2">Détail</th>
                        <th className="px-2.5 py-2">N° Facture</th>
                        <th className="px-2.5 py-2">Client</th>
                        <th className="px-2.5 py-2">Date</th>
                        <th className="px-2.5 py-2">Campagne / BC</th>
                        <th className="px-2.5 py-2 text-right">HT / TTC</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {validationResults.map((row) => (
                        <tr
                          key={`${sessionKey}-${row.rowIndex}`}
                          className={
                            row.status === 'erreur'
                              ? 'bg-red-50/50'
                              : row.status === 'doublon'
                              ? 'bg-amber-50/50'
                              : 'hover:bg-slate-50'
                          }
                        >
                          <td className="px-2.5 py-1.5 text-slate-500 tabular-nums">{row.rowIndex}</td>
                          <td className="px-2.5 py-1.5 font-semibold whitespace-nowrap">
                            {row.status === 'valide' ? (
                              <span className="text-emerald-700">Valide</span>
                            ) : row.status === 'doublon' ? (
                              <span className="text-amber-700">Doublon</span>
                            ) : (
                              <span className="text-red-700">Erreur</span>
                            )}
                          </td>
                          <td className="px-2.5 py-1.5 text-slate-700">{row.message}</td>
                          <td className="px-2.5 py-1.5 font-mono text-slate-900">
                            {row.mapped.invoiceNumber || '—'}
                          </td>
                          <td className="px-2.5 py-1.5 text-slate-800">{row.mapped.clientName || '—'}</td>
                          <td className="px-2.5 py-1.5 text-slate-600 tabular-nums">
                            {row.mapped.issueDate || '—'}
                          </td>
                          <td className="px-2.5 py-1.5 text-slate-600">
                            {[row.mapped.campaignRef, row.mapped.bcNumber].filter(Boolean).join(' · ') ||
                              '—'}
                          </td>
                          <td className="px-2.5 py-1.5 text-right tabular-nums text-slate-800">
                            {row.mapped.htAmount || row.mapped.ttcAmount || row.mapped.unitPrice || '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Pied de modale */}
        <div className="flex items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3">
          <button
            type="button"
            onClick={handleClose}
            disabled={isImporting}
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100"
          >
            Fermer
          </button>
          {detectedMode === 'table' && parsedSheet && (
            <button
              type="button"
              disabled={isImporting || stats.valides.length === 0}
              onClick={handleConfirmTableImport}
              className="inline-flex items-center gap-2 rounded-md bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              <CheckCircle2 className="h-4 w-4" />
              <span>
                {isImporting
                  ? 'Importation en cours...'
                  : `Importer ${stats.distinctInvoices} facture(s) (${stats.valides.length} ligne(s))`}
              </span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
