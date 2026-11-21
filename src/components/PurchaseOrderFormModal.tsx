import React, { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Check, FileText, Paperclip, Upload, X } from 'lucide-react';
import { createId, db } from '../db/database';
import type {
  BcEmisStatus,
  BcRecuStatus,
  DocumentAttachment,
  PurchaseOrder,
  PurchaseOrderDirection,
} from '../db/types';
import {
  addAttachmentToPurchaseOrder,
  generateNextBcEmisNumber,
  removeAttachment,
  savePurchaseOrder,
} from '../services/documentActions';
import { computeCampaignDuration } from '../utils/documentHelpers';
import { computeInvoiceDocumentTotals } from '../utils/finance';
import {
  createDefaultEditableLine,
  editableToInvoiceLineInput,
  getEffectiveOutdoorCatalog,
  invoiceLineToEditable,
  type SmartEditableLine,
} from '../utils/guidedLineHelpers';
import {
  centimesToInputString,
  parseMoneyInputToCentimes,
} from '../utils/money';
import { useAppStore } from '../store/useAppStore';
import { useUiMode } from '../hooks/useUiMode';
import { MoreOptionsButton } from './MoreOptionsButton';
import { CampaignSelector } from './CampaignSelector';
import { readFileAsDataUrl } from './AttachmentPreviewModal';
import { SmartLineEditor } from './SmartLineEditor';

interface PendingFile {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  dataUrl: string;
}

interface PurchaseOrderFormModalProps {
  open: boolean;
  direction: PurchaseOrderDirection;
  existingPo?: PurchaseOrder;
  preselectedContactId?: string;
  onClose: () => void;
  onSaved?: (saved: PurchaseOrder) => void;
}

const MAX_FILE_WARN_BYTES = 10 * 1024 * 1024;

export const PurchaseOrderFormModal: React.FC<PurchaseOrderFormModalProps> = ({
  open,
  direction,
  existingPo,
  preselectedContactId,
  onClose,
  onSaved,
}) => {
  const pushToast = useAppStore((s) => s.pushToast);
  const { isSimple } = useUiMode();
  const settings = useLiveQuery(() => db.settings.get('company_settings'));
  const profiles = useLiveQuery(
    () => db.companyProfiles.filter((p) => !p.deletedAt).toArray(),
    [],
    []
  );
  const contacts = useLiveQuery(
    () => db.contacts.filter((c) => !c.deletedAt).toArray(),
    [],
    []
  );
  const existingAttachments = useLiveQuery(
    () =>
      existingPo
        ? db.documentAttachments.where('parentId').equals(existingPo.id).toArray()
        : Promise.resolve([] as DocumentAttachment[]),
    [existingPo?.id],
    []
  );

  const [companyProfileId, setCompanyProfileId] = useState('');
  const [poNumber, setPoNumber] = useState('');
  const [contactId, setContactId] = useState('');
  const [issueDate, setIssueDate] = useState('');
  const [expectedDate, setExpectedDate] = useState('');
  const [status, setStatus] = useState<BcRecuStatus | BcEmisStatus>('recu');

  // Campagne
  const [campaignId, setCampaignId] = useState<string | undefined>(undefined);
  const [campaignRef, setCampaignRef] = useState('');
  const [campaignStartDate, setCampaignStartDate] = useState('');
  const [campaignEndDate, setCampaignEndDate] = useState('');
  const [showCampaignOnPrint, setShowCampaignOnPrint] = useState(true);

  const [currency, setCurrency] = useState('DZD');
  const [exchangeRateText, setExchangeRateText] = useState('1');
  const [description, setDescription] = useState('');
  const [notes, setNotes] = useState('');

  // Montants optionnels sur BC reçu
  const [directHtText, setDirectHtText] = useState('');
  const [directTtcText, setDirectTtcText] = useState('');
  const [lines, setLines] = useState<SmartEditableLine[]>([]);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [showMoreOptions, setShowMoreOptions] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const defaultTva = settings?.defaultTvaRate ?? 19;
  const showAdvancedFields = !isSimple || showMoreOptions;

  useEffect(() => {
    if (!open) return;
    setError('');
    setShowMoreOptions(false);
    setPendingFiles([]);
    const today = new Date().toISOString().slice(0, 10);
    const activeProf =
      profiles.find((p) => p.id === settings?.activeCompanyProfileId) ||
      profiles.find((p) => p.isDefault) ||
      profiles[0];

    if (existingPo) {
      setCompanyProfileId(existingPo.companyProfileId || activeProf?.id || '');
      setPoNumber(existingPo.poNumber);
      setContactId(existingPo.contactId);
      setIssueDate(existingPo.issueDate);
      setExpectedDate(existingPo.expectedDate || '');
      setStatus(existingPo.status);
      setCampaignId(existingPo.campaignId);
      setCampaignRef(existingPo.campaignRef || '');
      setCampaignStartDate(existingPo.campaignStartDate || '');
      setCampaignEndDate(existingPo.campaignEndDate || '');
      setShowCampaignOnPrint(existingPo.showCampaignOnPrint ?? true);
      setCurrency(existingPo.currency);
      setExchangeRateText(String(existingPo.exchangeRate));
      setDescription(existingPo.description);
      setNotes(existingPo.notes);
      setDirectHtText(
        existingPo.totalHtCentimes > 0 ? centimesToInputString(existingPo.totalHtCentimes) : ''
      );
      setDirectTtcText(
        existingPo.totalTtcCentimes > 0 ? centimesToInputString(existingPo.totalTtcCentimes) : ''
      );
      setLines(existingPo.lines.map((l) => invoiceLineToEditable(l)));
    } else {
      const profId = activeProf?.id || '';
      setCompanyProfileId(profId);
      if (direction === 'bc_emis') {
        generateNextBcEmisNumber(new Date().getFullYear(), profId).then((n) => setPoNumber(n));
        setStatus('brouillon');
      } else {
        setPoNumber('');
        setStatus('recu');
      }
      setContactId(preselectedContactId || '');
      setIssueDate(today);
      setExpectedDate('');
      setCampaignId(undefined);
      setCampaignRef('');
      setCampaignStartDate('');
      setCampaignEndDate('');
      setShowCampaignOnPrint(true);
      setCurrency(settings?.defaultCurrency || 'DZD');
      setExchangeRateText('1');
      setDescription('');
      setNotes('');
      setDirectHtText('');
      setDirectTtcText('');
      setLines(
        direction === 'bc_emis'
          ? [createDefaultEditableLine(createId('line'), defaultTva)]
          : []
      );
    }
  }, [open, existingPo, direction, preselectedContactId]);

  const contactOptions = useMemo(() => {
    return contacts.filter((c) => {
      if (c.archived && c.id !== contactId) return false;
      if (direction === 'bc_recu') return c.type === 'client' || c.type === 'les_deux';
      return c.type === 'fournisseur' || c.type === 'les_deux';
    });
  }, [contacts, direction, contactId]);

  const campaignDuration = useMemo(
    () => computeCampaignDuration(campaignStartDate, campaignEndDate),
    [campaignStartDate, campaignEndDate]
  );

  const computedTotals = useMemo(() => {
    const parsed = lines.map(editableToInvoiceLineInput);
    return computeInvoiceDocumentTotals(parsed);
  }, [lines]);

  const selectedProfile = useMemo(
    () =>
      profiles.find((p) => p.id === companyProfileId) ||
      profiles.find((p) => p.id === settings?.activeCompanyProfileId) ||
      profiles[0],
    [profiles, companyProfileId, settings?.activeCompanyProfileId]
  );

  if (!open) return null;

  const headerAccentBg =
    selectedProfile?.applyThemeToApp !== false
      ? selectedProfile?.accentColor || '#0F1E36'
      : '#0F1E36';

  const handleFilesSelected = async (files: FileList | null) => {
    if (!files) return;
    for (const file of Array.from(files)) {
      if (file.size > MAX_FILE_WARN_BYTES) {
        pushToast({
          type: 'warning',
          title: 'Fichier volumineux (> 10 Mo)',
          message: `« ${file.name} » fait ${(file.size / (1024 * 1024)).toFixed(1)} Mo.`,
        });
      }
      const dataUrl = await readFileAsDataUrl(file);
      if (existingPo) {
        await addAttachmentToPurchaseOrder({
          parentId: existingPo.id,
          parentType: direction,
          fileName: file.name,
          mimeType: file.type || 'application/octet-stream',
          sizeBytes: file.size,
          dataUrl,
        });
      } else {
        setPendingFiles((prev) => [
          ...prev,
          {
            id: createId('pend'),
            fileName: file.name,
            mimeType: file.type || 'application/octet-stream',
            sizeBytes: file.size,
            dataUrl,
          },
        ]);
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!campaignDuration.valid) {
      setError(campaignDuration.label);
      return;
    }
    setBusy(true);
    try {
      const directHt = directHtText ? parseMoneyInputToCentimes(directHtText) : 0;
      const directTtc = directTtcText ? parseMoneyInputToCentimes(directTtcText) : 0;

      const saved = await savePurchaseOrder({
        existingId: existingPo?.id,
        direction,
        poNumber,
        companyProfileId: companyProfileId || settings?.activeCompanyProfileId,
        contactId,
        issueDate,
        expectedDate: expectedDate || undefined,
        campaignId,
        campaignRef,
        campaignStartDate: campaignStartDate || undefined,
        campaignEndDate: campaignEndDate || undefined,
        showCampaignOnPrint,
        currency,
        exchangeRate: parseFloat(exchangeRateText.replace(',', '.')) || 1,
        description,
        notes,
        status,
        lines: lines.map((l) => {
          const parsed = editableToInvoiceLineInput(l);
          return { ...parsed, description: parsed.description.trim() };
        }),
        directHtCentimes: Number.isNaN(directHt) ? 0 : directHt,
        directTtcCentimes: Number.isNaN(directTtc) ? 0 : directTtc,
      });

      for (const pf of pendingFiles) {
        await addAttachmentToPurchaseOrder({
          parentId: saved.id,
          parentType: direction,
          fileName: pf.fileName,
          mimeType: pf.mimeType,
          sizeBytes: pf.sizeBytes,
          dataUrl: pf.dataUrl,
        });
      }

      pushToast({
        type: 'success',
        title: existingPo
          ? 'Bon de commande mis à jour'
          : direction === 'bc_recu'
          ? 'BC reçu enregistré'
          : 'BC émis enregistré',
        message: saved.poNumber,
      });
      onSaved?.(saved);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur lors de la sauvegarde.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
      <div className="flex max-h-[94vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
        <div
          className="flex items-center justify-between border-b border-slate-200 px-6 py-4 text-white"
          style={{ backgroundColor: headerAccentBg }}
        >
          <h2 className="text-base font-semibold">
            {existingPo
              ? `Modifier ${existingPo.poNumber}`
              : direction === 'bc_recu'
              ? 'Nouveau BC reçu d’un client'
              : 'Nouveau BC émis à un fournisseur'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-slate-200 hover:bg-black/20 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 space-y-5">
          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">
              {error}
            </div>
          )}

          {profiles.length > 0 && (
            <div className="rounded-lg border border-slate-200 bg-slate-50/80 p-3 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3 flex-1 min-w-[240px]">
                {selectedProfile?.logoDataUrl && (
                  <img
                    src={selectedProfile.logoDataUrl}
                    alt={selectedProfile.name}
                    className="h-9 w-16 rounded border border-slate-200 bg-white object-contain p-0.5 shrink-0"
                  />
                )}
                <div className="flex-1 max-w-sm">
                  <label className="block text-[11px] font-semibold text-slate-700">
                    {direction === 'bc_recu' ? 'Société destinataire *' : 'Société émettrice *'}
                  </label>
                  <select
                    value={companyProfileId}
                    onChange={async (e) => {
                      const pid = e.target.value;
                      setCompanyProfileId(pid);
                      if (!existingPo && direction === 'bc_emis') {
                        const yr =
                          parseInt((issueDate || '').slice(0, 4), 10) || new Date().getFullYear();
                        const n = await generateNextBcEmisNumber(yr, pid);
                        setPoNumber(n);
                      }
                    }}
                    className="mt-0.5 w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm font-medium"
                  >
                    {profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {selectedProfile && (
                <div className="flex items-center gap-2 text-[11px] text-slate-600">
                  <span className="inline-flex items-center gap-1 rounded border border-slate-200 bg-white px-2 py-1">
                    <span
                      className="inline-block h-2.5 w-2.5 rounded-sm"
                      style={{ backgroundColor: selectedProfile.primaryColor }}
                    />
                    <span
                      className="inline-block h-2.5 w-2.5 rounded-sm"
                      style={{ backgroundColor: selectedProfile.accentColor }}
                    />
                    <span className="font-medium">Société sélectionnée</span>
                  </span>
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
            <div>
              <label className="block text-xs font-medium text-slate-700">
                {direction === 'bc_recu' ? 'N° BC du client *' : 'N° BC *'}
              </label>
              <input
                type="text"
                required
                value={poNumber}
                onChange={(e) => setPoNumber(e.target.value)}
                placeholder={direction === 'bc_recu' ? 'Ex : 38/26/RL' : 'BC N°001/26'}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-medium"
              />
            </div>

            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-slate-700">
                {direction === 'bc_recu' ? 'Client *' : 'Fournisseur *'}
              </label>
              <select
                required
                value={contactId}
                onChange={(e) => setContactId(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
              >
                <option value="">— Sélectionner —</option>
                {contactOptions.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.company ? `${c.company} (${c.name || 'Contact'})` : c.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700">
                {direction === 'bc_recu' ? 'Date de réception *' : 'Date d’émission *'}
              </label>
              <input
                type="date"
                required
                value={issueDate}
                onChange={(e) => setIssueDate(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
          </div>

          {/* Bloc Campagne */}
          <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-4 space-y-3">
            <div className="text-xs font-semibold text-slate-800">Campagne & Période</div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-slate-700">Campagne</label>
                <div className="mt-1">
                  <CampaignSelector
                    clientId={direction === 'bc_recu' ? contactId : ''}
                    campaignId={campaignId}
                    campaignRef={campaignRef}
                    onChange={(sel) => {
                      setCampaignId(sel.campaignId);
                      setCampaignRef(sel.campaignRef);
                      if (sel.startDate) setCampaignStartDate(sel.startDate);
                      if (sel.endDate) setCampaignEndDate(sel.endDate);
                    }}
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700">Date de début</label>
                <input
                  type="date"
                  value={campaignStartDate}
                  onChange={(e) => setCampaignStartDate(e.target.value)}
                  className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2.5 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700">Date de fin</label>
                <input
                  type="date"
                  value={campaignEndDate}
                  onChange={(e) => setCampaignEndDate(e.target.value)}
                  className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2.5 py-2 text-sm"
                />
              </div>
            </div>
            {campaignStartDate && campaignEndDate && (
              <div
                className={`text-xs font-medium ${
                  campaignDuration.valid ? 'text-slate-600' : 'text-red-600'
                }`}
              >
                {campaignDuration.valid
                  ? `Durée calculée : ${campaignDuration.label} (${campaignDuration.days} jours)`
                  : campaignDuration.label}
              </div>
            )}
          </div>

          {/* Zone Joindre le document (Drag & Drop PDF/JPG/PNG) */}
          <div className="space-y-2">
            <label className="block text-xs font-semibold text-slate-800">
              Joindre le document (scan PDF, JPG, PNG — stocké localement)
            </label>
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                handleFilesSelected(e.dataTransfer.files);
              }}
              className={`rounded-lg border-2 border-dashed p-4 text-center transition-colors ${
                dragOver
                  ? 'border-[#1D4ED8] bg-blue-50'
                  : 'border-slate-300 bg-slate-50 hover:border-slate-400'
              }`}
            >
              <Upload className="mx-auto h-6 w-6 text-slate-400" />
              <div className="mt-1.5 text-xs text-slate-600">
                Glissez-déposez vos fichiers ici, ou{' '}
                <label className="cursor-pointer font-semibold text-[#1D4ED8] hover:underline">
                  parcourir l’ordinateur
                  <input
                    type="file"
                    multiple
                    accept=".pdf,image/png,image/jpeg,image/webp"
                    onChange={(e) => handleFilesSelected(e.target.files)}
                    className="hidden"
                  />
                </label>
              </div>
              <div className="mt-0.5 text-[11px] text-slate-400">
                Formats acceptés : PDF, JPG, PNG (recommandé ≤ 10 Mo par fichier)
              </div>
            </div>

            {(existingAttachments.length > 0 || pendingFiles.length > 0) && (
              <div className="flex flex-wrap gap-2 pt-1">
                {existingAttachments.map((att) => (
                  <div
                    key={att.id}
                    className="inline-flex items-center gap-2 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs"
                  >
                    <Paperclip className="h-3.5 w-3.5 text-[#1D4ED8]" />
                    <span className="max-w-[180px] truncate font-medium text-slate-800">
                      {att.fileName}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeAttachment(att.id)}
                      className="text-slate-400 hover:text-red-600"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
                {pendingFiles.map((pf) => (
                  <div
                    key={pf.id}
                    className="inline-flex items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-2.5 py-1.5 text-xs"
                  >
                    <FileText className="h-3.5 w-3.5 text-[#1D4ED8]" />
                    <span className="max-w-[180px] truncate font-medium text-slate-800">
                      {pf.fileName}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setPendingFiles((prev) => prev.filter((x) => x.id !== pf.id))
                      }
                      className="text-slate-400 hover:text-red-600"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Montants optionnels sur BC reçu ou Lignes sur BC émis */}
          {direction === 'bc_recu' && lines.length === 0 ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div>
                <label className="block text-xs font-medium text-slate-700">
                  Montant HT (si connu, optionnel)
                </label>
                <input
                  type="text"
                  value={directHtText}
                  onChange={(e) => setDirectHtText(e.target.value)}
                  placeholder="0,00"
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-right tabular-nums"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700">
                  Montant TTC (si connu, optionnel)
                </label>
                <input
                  type="text"
                  value={directTtcText}
                  onChange={(e) => setDirectTtcText(e.target.value)}
                  placeholder="0,00"
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-right tabular-nums"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700">Statut</label>
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value as BcRecuStatus)}
                  className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
                >
                  <option value="recu">Reçu</option>
                  <option value="en_cours">En cours</option>
                  <option value="partiellement_facture">Partiellement facturé</option>
                  <option value="facture">Facturé</option>
                  <option value="annule">Annulé</option>
                </select>
              </div>
            </div>
          ) : (
            <SmartLineEditor
              title="Lignes du bon de commande"
              lines={lines}
              computedLines={computedTotals.lines}
              currency={currency}
              defaultTva={defaultTva}
              showAdvancedFields={showAdvancedFields}
              catalog={getEffectiveOutdoorCatalog(settings)}
              campaignStartDate={campaignStartDate}
              campaignEndDate={campaignEndDate}
              minLines={direction === 'bc_recu' ? 0 : 1}
              allowDiscount={false}
              onChange={setLines}
            />
          )}

          {direction === 'bc_recu' && lines.length === 0 && (
            <div className="flex flex-wrap items-center gap-4">
              <button
                type="button"
                onClick={() =>
                  setLines([
                    createDefaultEditableLine(createId('line'), defaultTva, {
                      description: campaignRef || '',
                      unit: 'forfait',
                      unitPriceText: directHtText || '0,00',
                    }),
                  ])
                }
                className="text-xs font-medium text-[#1D4ED8] hover:underline"
              >
                + Détailler par lignes libres (optionnel)
              </button>
              <button
                type="button"
                onClick={() =>
                  setLines([
                    createDefaultEditableLine(createId('line'), defaultTva, {
                      lineMode: 'guidee',
                      unit: 'mois',
                    }),
                  ])
                }
                className="text-xs font-medium text-[#1D4ED8] hover:underline"
              >
                + Détailler en saisie guidée (publicité)
              </button>
            </div>
          )}

          {isSimple && (
            <MoreOptionsButton
              expanded={showMoreOptions}
              onToggle={() => setShowMoreOptions((v) => !v)}
            />
          )}

          {showAdvancedFields && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-xs font-medium text-slate-700">Objet / Description</label>
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              {direction === 'bc_emis' && (
                <div>
                  <label className="block text-xs font-medium text-slate-700">Statut BC émis</label>
                  <select
                    value={status}
                    onChange={(e) => setStatus(e.target.value as BcEmisStatus)}
                    className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
                  >
                    <option value="brouillon">Brouillon</option>
                    <option value="envoye">Envoyé</option>
                    <option value="recu">Reçu</option>
                    <option value="facture">Facturé</option>
                    <option value="annule">Annulé</option>
                  </select>
                </div>
              )}
              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-slate-700">Notes</label>
                <textarea
                  rows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
            </div>
          )}

          <div className="flex justify-end gap-3 border-t border-slate-200 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Annuler
            </button>
            <button
              type="submit"
              disabled={busy || !campaignDuration.valid}
              style={{ backgroundColor: headerAccentBg }}
              className="inline-flex items-center gap-2 rounded-md px-5 py-2 text-sm font-medium text-white hover:opacity-95 disabled:opacity-60"
            >
              <Check className="h-4 w-4" />
              <span>{busy ? 'Enregistrement...' : 'Enregistrer le bon de commande'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
