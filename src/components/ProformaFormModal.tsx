import React, { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Check, X } from 'lucide-react';
import { createId, db } from '../db/database';
import type {
  ClientFiscalSnapshot,
  Proforma,
  ProformaStatus,
  PurchaseOrder,
} from '../db/types';
import { generateNextProformaNumber, saveProforma } from '../services/documentActions';
import { computeCampaignDuration } from '../utils/documentHelpers';
import { computeInvoiceDocumentTotals } from '../utils/finance';
import {
  createDefaultEditableLine,
  editableToInvoiceLineInput,
  getEffectiveOutdoorCatalog,
  invoiceLineToEditable,
  type SmartEditableLine,
} from '../utils/guidedLineHelpers';
import { formatMoney } from '../utils/money';
import { amountCentimesToFrenchWords } from '../utils/numberToFrenchWords';
import { useAppStore } from '../store/useAppStore';
import { useUiMode } from '../hooks/useUiMode';
import { MoreOptionsButton } from './MoreOptionsButton';
import { CampaignSelector } from './CampaignSelector';
import { BcRecuSelector } from './BcRecuSelector';
import { AttachmentPreviewModal } from './AttachmentPreviewModal';
import { SmartLineEditor } from './SmartLineEditor';

interface ProformaFormModalProps {
  open: boolean;
  existingProforma?: Proforma;
  preselectedClientId?: string;
  prefillFromBc?: PurchaseOrder;
  onClose: () => void;
  onSaved?: (saved: Proforma) => void;
}

export const ProformaFormModal: React.FC<ProformaFormModalProps> = ({
  open,
  existingProforma,
  preselectedClientId,
  prefillFromBc,
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

  const [companyProfileId, setCompanyProfileId] = useState('');
  const [proformaNumber, setProformaNumber] = useState('');
  const [clientId, setClientId] = useState('');
  const [issueDate, setIssueDate] = useState('');
  const [validityDays, setValidityDays] = useState('30');
  const [validUntil, setValidUntil] = useState('');
  const [paymentConditions, setPaymentConditions] = useState('50 % à la commande, 50 % à la livraison');
  const [deliveryDelay, setDeliveryDelay] = useState('Sous 7 jours ouvrables');
  const [status, setStatus] = useState<ProformaStatus>('brouillon');

  // Campagne & BC
  const [bcNumber, setBcNumber] = useState('');
  const [linkedBcRecuId, setLinkedBcRecuId] = useState<string | undefined>(undefined);
  const [campaignId, setCampaignId] = useState<string | undefined>(undefined);
  const [campaignRef, setCampaignRef] = useState('');
  const [campaignStartDate, setCampaignStartDate] = useState('');
  const [campaignEndDate, setCampaignEndDate] = useState('');
  const [showCampaignOnPrint, setShowCampaignOnPrint] = useState(true);

  const [currency, setCurrency] = useState('DZD');
  const [exchangeRateText, setExchangeRateText] = useState('1');
  const [description, setDescription] = useState('');
  const [amountInWordsOverride, setAmountInWordsOverride] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<SmartEditableLine[]>([]);
  const [showMoreOptions, setShowMoreOptions] = useState(false);
  const [previewBcAttId, setPreviewBcAttId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const defaultTva = settings?.defaultTvaRate ?? 19;
  const showAdvancedFields = !isSimple || showMoreOptions;

  const computeValidUntil = (startIso: string, daysVal: number) => {
    const base = startIso ? new Date(`${startIso}T00:00:00Z`) : new Date();
    const res = new Date(base.getTime() + Math.max(1, daysVal) * 86400000);
    return res.toISOString().slice(0, 10);
  };

  useEffect(() => {
    if (!open) return;
    setError('');
    setShowMoreOptions(false);
    const today = new Date().toISOString().slice(0, 10);
    const activeProf =
      profiles.find((p) => p.id === settings?.activeCompanyProfileId) ||
      profiles.find((p) => p.isDefault) ||
      profiles[0];

    if (existingProforma) {
      setCompanyProfileId(existingProforma.companyProfileId || activeProf?.id || '');
      setProformaNumber(existingProforma.proformaNumber);
      setClientId(existingProforma.clientId);
      setIssueDate(existingProforma.issueDate);
      setValidityDays(String(existingProforma.validityDays || 30));
      setValidUntil(existingProforma.validUntil);
      setPaymentConditions(existingProforma.paymentConditions || '');
      setDeliveryDelay(existingProforma.deliveryDelay || '');
      setStatus(existingProforma.status);
      setBcNumber(existingProforma.bcNumber || '');
      setLinkedBcRecuId(existingProforma.linkedBcRecuId);
      setCampaignId(existingProforma.campaignId);
      setCampaignRef(existingProforma.campaignRef || '');
      setCampaignStartDate(existingProforma.campaignStartDate || '');
      setCampaignEndDate(existingProforma.campaignEndDate || '');
      setShowCampaignOnPrint(existingProforma.showCampaignOnPrint ?? true);
      setCurrency(existingProforma.currency);
      setExchangeRateText(String(existingProforma.exchangeRate));
      setDescription(existingProforma.description);
      setAmountInWordsOverride(existingProforma.amountInWordsOverride || '');
      setNotes(existingProforma.notes);
      setLines(existingProforma.lines.map((l) => invoiceLineToEditable(l)));
    } else if (prefillFromBc) {
      const profId = prefillFromBc.companyProfileId || activeProf?.id || '';
      setCompanyProfileId(profId);
      generateNextProformaNumber(new Date().getFullYear(), profId).then((n) =>
        setProformaNumber(n)
      );
      setClientId(prefillFromBc.contactId);
      setIssueDate(today);
      setValidityDays('30');
      setValidUntil(computeValidUntil(today, 30));
      setPaymentConditions('50 % à la commande, 50 % à la livraison');
      setDeliveryDelay('Sous 7 jours ouvrables');
      setStatus('brouillon');
      setBcNumber(prefillFromBc.poNumber);
      setLinkedBcRecuId(prefillFromBc.id);
      setCampaignId(prefillFromBc.campaignId);
      setCampaignRef(prefillFromBc.campaignRef || '');
      setCampaignStartDate(prefillFromBc.campaignStartDate || '');
      setCampaignEndDate(prefillFromBc.campaignEndDate || '');
      setShowCampaignOnPrint(prefillFromBc.showCampaignOnPrint ?? true);
      setCurrency(prefillFromBc.currency || settings?.defaultCurrency || 'DZD');
      setExchangeRateText(String(prefillFromBc.exchangeRate || 1));
      setDescription(prefillFromBc.description || prefillFromBc.campaignRef || '');
      setAmountInWordsOverride('');
      setNotes(prefillFromBc.notes || '');
      setLines(
        prefillFromBc.lines.length > 0
          ? prefillFromBc.lines.map((l) => invoiceLineToEditable(l, createId('line')))
          : [
              createDefaultEditableLine(createId('line'), defaultTva, {
                description: prefillFromBc.campaignRef || `Devis BC ${prefillFromBc.poNumber}`,
                unit: 'forfait',
              }),
            ]
      );
    } else {
      const profId = activeProf?.id || '';
      setCompanyProfileId(profId);
      generateNextProformaNumber(new Date().getFullYear(), profId).then((n) =>
        setProformaNumber(n)
      );
      setClientId(preselectedClientId || '');
      setIssueDate(today);
      setValidityDays('30');
      setValidUntil(computeValidUntil(today, 30));
      setPaymentConditions('50 % à la commande, 50 % à la livraison');
      setDeliveryDelay('Sous 7 jours ouvrables');
      setStatus('brouillon');
      setBcNumber('');
      setLinkedBcRecuId(undefined);
      setCampaignId(undefined);
      setCampaignRef('');
      setCampaignStartDate('');
      setCampaignEndDate('');
      setShowCampaignOnPrint(true);
      setCurrency(settings?.defaultCurrency || 'DZD');
      setExchangeRateText('1');
      setDescription('');
      setAmountInWordsOverride('');
      setNotes('');
      setLines([createDefaultEditableLine(createId('line'), defaultTva)]);
    }
  }, [open, existingProforma, prefillFromBc, preselectedClientId]);

  const clientOptions = useMemo(
    () =>
      contacts.filter(
        (c) => (!c.archived || c.id === clientId) && (c.type === 'client' || c.type === 'les_deux')
      ),
    [contacts, clientId]
  );

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

  const rateVal = parseFloat(exchangeRateText.replace(',', '.'));
  const safeRate = Number.isFinite(rateVal) && rateVal > 0 ? rateVal : 1;
  const autoWordsHint = amountCentimesToFrenchWords(computedTotals.totalTtcCentimes, currency);
  const headerAccentBg =
    selectedProfile?.applyThemeToApp !== false
      ? selectedProfile?.accentColor || '#0F1E36'
      : '#0F1E36';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!campaignDuration.valid) {
      setError(campaignDuration.label);
      return;
    }
    setBusy(true);
    try {
      const selectedClient = contacts.find((c) => c.id === clientId);
      const snapshot: ClientFiscalSnapshot | undefined = selectedClient
        ? {
            company: selectedClient.company || selectedClient.name,
            name: selectedClient.name,
            address: selectedClient.address,
            postalCode: selectedClient.postalCode,
            city: selectedClient.city,
            phone: selectedClient.phone,
            email: selectedClient.email,
            nif: selectedClient.nif,
            nis: selectedClient.nis,
            rc: selectedClient.rc,
            ai: selectedClient.ai,
          }
        : undefined;

      const saved = await saveProforma({
        existingId: existingProforma?.id,
        proformaNumber,
        companyProfileId: companyProfileId || undefined,
        clientId,
        clientSnapshot: snapshot,
        issueDate,
        validityDays: parseInt(validityDays, 10) || 30,
        validUntil,
        paymentConditions,
        deliveryDelay,
        bcNumber,
        linkedBcRecuId,
        campaignId,
        campaignRef,
        campaignStartDate: campaignStartDate || undefined,
        campaignEndDate: campaignEndDate || undefined,
        showCampaignOnPrint,
        currency,
        exchangeRate: safeRate,
        description,
        amountInWordsOverride,
        notes,
        status,
        lines: lines.map((l) => {
          const parsed = editableToInvoiceLineInput(l);
          return { ...parsed, description: parsed.description.trim() };
        }),
      });

      pushToast({
        type: 'success',
        title: existingProforma ? 'Proforma mis à jour' : 'Proforma créé',
        message: saved.proformaNumber,
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
      <div className="flex max-h-[94vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
        <div
          className="flex items-center justify-between border-b border-slate-200 px-6 py-4 text-white"
          style={{ backgroundColor: headerAccentBg }}
        >
          <h2 className="text-base font-semibold">
            {existingProforma
              ? `Modifier ${existingProforma.proformaNumber}`
              : 'Nouveau Proforma / Devis'}
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

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
            {profiles.length > 0 && (
              <div className="sm:col-span-4 rounded-lg border border-slate-200 bg-slate-50/80 p-3 flex flex-wrap items-center justify-between gap-3">
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
                      Société émettrice *
                    </label>
                    <select
                      value={companyProfileId}
                      onChange={async (e) => {
                        const pid = e.target.value;
                        setCompanyProfileId(pid);
                        if (!existingProforma) {
                          const n = await generateNextProformaNumber(
                            parseInt((issueDate || '').slice(0, 4), 10) || new Date().getFullYear(),
                            pid
                          );
                          setProformaNumber(n);
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
                  <div className="flex flex-wrap items-center gap-2.5 text-[11px] text-slate-600">
                    <span className="inline-flex items-center gap-1 rounded border border-slate-200 bg-white px-2 py-1">
                      <span
                        className="inline-block h-2.5 w-2.5 rounded-sm"
                        style={{ backgroundColor: selectedProfile.primaryColor }}
                      />
                      <span
                        className="inline-block h-2.5 w-2.5 rounded-sm"
                        style={{ backgroundColor: selectedProfile.accentColor }}
                      />
                      <span className="font-medium">Modèle couleur</span>
                    </span>
                    {selectedProfile.bankInfo && (
                      <span className="max-w-xs truncate text-slate-500" title={selectedProfile.bankInfo}>
                        {selectedProfile.bankInfo}
                      </span>
                    )}
                  </div>
                )}
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-slate-700">N° Proforma *</label>
              <input
                type="text"
                value={proformaNumber}
                onChange={(e) => setProformaNumber(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-medium"
              />
            </div>

            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-slate-700">Client *</label>
              <select
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
              >
                <option value="">— Sélectionner —</option>
                {clientOptions.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.company ? `${c.company} (${c.name || 'Contact'})` : c.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700">Date proforma *</label>
              <input
                type="date"
                value={issueDate}
                onChange={(e) => {
                  const d = e.target.value;
                  setIssueDate(d);
                  setValidUntil(computeValidUntil(d, parseInt(validityDays, 10) || 30));
                }}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
          </div>

          {/* Bloc Campagne & Ref BC */}
          <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-semibold text-slate-800">
                Campagne & Bon de commande client
              </span>
              <label className="inline-flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showCampaignOnPrint}
                  onChange={(e) => setShowCampaignOnPrint(e.target.checked)}
                />
                <span>Afficher sur le document imprimé</span>
              </label>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-slate-700">Campagne</label>
                <div className="mt-1">
                  <CampaignSelector
                    clientId={clientId}
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

              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-slate-700">Ref BC</label>
                <div className="mt-1">
                  <BcRecuSelector
                    clientId={clientId}
                    bcNumber={bcNumber}
                    linkedBcRecuId={linkedBcRecuId}
                    onChange={(val) => {
                      setBcNumber(val.bcNumber);
                      setLinkedBcRecuId(val.linkedBcRecuId);
                      if (val.campaignId) setCampaignId(val.campaignId);
                      if (val.campaignRef && !campaignRef) setCampaignRef(val.campaignRef);
                      if (val.startDate && !campaignStartDate) setCampaignStartDate(val.startDate);
                      if (val.endDate && !campaignEndDate) setCampaignEndDate(val.endDate);
                    }}
                    onPreviewAttachment={(id) => setPreviewBcAttId(id)}
                  />
                </div>
              </div>

              <div className="sm:col-span-2 flex items-end pb-2">
                {campaignStartDate && campaignEndDate && (
                  <span
                    className={`text-xs font-medium ${
                      campaignDuration.valid ? 'text-slate-600' : 'text-red-600'
                    }`}
                  >
                    {campaignDuration.valid
                      ? `Durée calculée : ${campaignDuration.label} (${campaignDuration.days} jours)`
                      : campaignDuration.label}
                  </span>
                )}
              </div>
            </div>
          </div>

          {showAdvancedFields && (
            <div className="grid grid-cols-1 gap-4 rounded-lg border border-slate-200 bg-white p-4 sm:grid-cols-4">
              <div>
                <label className="block text-xs font-medium text-slate-700">Validité (jours)</label>
                <input
                  type="number"
                  min={1}
                  value={validityDays}
                  onChange={(e) => {
                    setValidityDays(e.target.value);
                    const days = parseInt(e.target.value, 10);
                    if (Number.isFinite(days) && days > 0) {
                      setValidUntil(computeValidUntil(issueDate, days));
                    }
                  }}
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm tabular-nums"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700">Valable jusqu’au</label>
                <input
                  type="date"
                  value={validUntil}
                  onChange={(e) => setValidUntil(e.target.value)}
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700">Statut</label>
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value as ProformaStatus)}
                  disabled={status === 'facture'}
                  className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
                >
                  <option value="brouillon">Brouillon</option>
                  <option value="envoye">Envoyé</option>
                  <option value="accepte">Accepté</option>
                  <option value="refuse">Refusé</option>
                  <option value="expire">Expiré</option>
                  {status === 'facture' && <option value="facture">Facturé</option>}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs font-medium text-slate-700">Devise</label>
                  <select
                    value={currency}
                    onChange={(e) => {
                      const code = e.target.value;
                      setCurrency(code);
                      const cfg = settings?.enabledCurrencies.find((c) => c.code === code);
                      setExchangeRateText(String(cfg?.rateToDzd || 1));
                    }}
                    className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2.5 py-2 text-sm"
                  >
                    {(settings?.enabledCurrencies || []).map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.code}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700">Taux DZD</label>
                  <input
                    type="text"
                    disabled={currency === 'DZD'}
                    value={exchangeRateText}
                    onChange={(e) => setExchangeRateText(e.target.value)}
                    className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-2 text-sm text-right tabular-nums disabled:bg-slate-100"
                  />
                </div>
              </div>
              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-slate-700">
                  Conditions de paiement
                </label>
                <input
                  type="text"
                  value={paymentConditions}
                  onChange={(e) => setPaymentConditions(e.target.value)}
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-slate-700">Délai</label>
                <input
                  type="text"
                  value={deliveryDelay}
                  onChange={(e) => setDeliveryDelay(e.target.value)}
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
            </div>
          )}

          {isSimple && (
            <div className="flex items-center justify-between">
              <MoreOptionsButton
                expanded={showMoreOptions}
                onToggle={() => setShowMoreOptions((v) => !v)}
              />
              {!showMoreOptions && (
                <span className="text-[11px] text-slate-500">
                  Valable jusqu’au {validUntil} ({validityDays} j) · TVA {defaultTva} %
                </span>
              )}
            </div>
          )}

          {/* Lignes du proforma (libre ou guidée par ligne) */}
          <SmartLineEditor
            title="Lignes du proforma"
            lines={lines}
            computedLines={computedTotals.lines}
            currency={currency}
            defaultTva={defaultTva}
            showAdvancedFields={showAdvancedFields}
            catalog={getEffectiveOutdoorCatalog(settings)}
            campaignStartDate={campaignStartDate}
            campaignEndDate={campaignEndDate}
            onChange={setLines}
          />

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {showAdvancedFields ? (
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700">
                    Montant en lettres (personnalisable si besoin)
                  </label>
                  <input
                    type="text"
                    value={amountInWordsOverride}
                    onChange={(e) => setAmountInWordsOverride(e.target.value)}
                    placeholder={autoWordsHint}
                    className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-xs"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700">Notes</label>
                  <textarea
                    rows={2}
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>
              </div>
            ) : (
              <div />
            )}

            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 space-y-1.5 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-600">Total HT</span>
                <span className="font-medium text-slate-900 tabular-nums">
                  {formatMoney(computedTotals.totalHtCentimes, currency)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-600">Total TVA</span>
                <span className="font-medium text-slate-900 tabular-nums">
                  {formatMoney(computedTotals.totalTvaCentimes, currency)}
                </span>
              </div>
              <div className="flex justify-between border-t border-slate-200 pt-2 text-base font-bold">
                <span className="text-slate-900">Total TTC</span>
                <span className="text-[#0F1E36] tabular-nums">
                  {formatMoney(computedTotals.totalTtcCentimes, currency)}
                </span>
              </div>
            </div>
          </div>

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
              <span>{busy ? 'Enregistrement...' : 'Enregistrer le proforma'}</span>
            </button>
          </div>
        </form>
      </div>

      {previewBcAttId && (
        <AttachmentPreviewModal
          open={Boolean(previewBcAttId)}
          parentId={previewBcAttId}
          title={`Pièce jointe BC ${bcNumber}`}
          readOnly
          onClose={() => setPreviewBcAttId(null)}
        />
      )}
    </div>
  );
};
