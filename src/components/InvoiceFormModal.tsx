import React, { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Check, X } from 'lucide-react';
import { createId, db } from '../db/database';
import type {
  ClientFiscalSnapshot,
  CustomerInvoice,
  PurchaseOrder,
  SupplierInvoice,
} from '../db/types';
import {
  generateNextInvoiceNumber,
  saveCustomerInvoice,
  saveSupplierInvoice,
} from '../services/financeActions';
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
  convertToBaseDzd,
  formatMoney,
} from '../utils/money';
import { amountCentimesToFrenchWords } from '../utils/numberToFrenchWords';
import { useAppStore } from '../store/useAppStore';
import { useUiMode } from '../hooks/useUiMode';
import { MoreOptionsButton } from './MoreOptionsButton';
import { CampaignSelector } from './CampaignSelector';
import { BcRecuSelector } from './BcRecuSelector';
import { AttachmentPreviewModal } from './AttachmentPreviewModal';
import { SmartLineEditor } from './SmartLineEditor';

interface InvoiceFormModalProps {
  open: boolean;
  mode: 'client' | 'fournisseur';
  existingInvoice?: CustomerInvoice | SupplierInvoice;
  preselectedContactId?: string;
  prefillFromBc?: PurchaseOrder;
  onClose: () => void;
  onSaved?: (saved: CustomerInvoice | SupplierInvoice) => void;
}

export const InvoiceFormModal: React.FC<InvoiceFormModalProps> = ({
  open,
  mode,
  existingInvoice,
  preselectedContactId,
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
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [supplierRef, setSupplierRef] = useState('');
  const [contactId, setContactId] = useState('');
  const [issueDate, setIssueDate] = useState('');
  const [dueDate, setDueDate] = useState('');

  // Bloc Campagne & BC
  const [bcNumber, setBcNumber] = useState('');
  const [linkedBcRecuId, setLinkedBcRecuId] = useState<string | undefined>(undefined);
  const [campaignId, setCampaignId] = useState<string | undefined>(undefined);
  const [campaignRef, setCampaignRef] = useState('');
  const [campaignStartDate, setCampaignStartDate] = useState('');
  const [campaignEndDate, setCampaignEndDate] = useState('');
  const [showCampaignOnPrint, setShowCampaignOnPrint] = useState(true);

  // Snapshot client fiscal sur la facture
  const [snapAddress, setSnapAddress] = useState('');
  const [snapNif, setSnapNif] = useState('');
  const [snapRc, setSnapRc] = useState('');
  const [snapAi, setSnapAi] = useState('');
  const [updateContactFiscal, setUpdateContactFiscal] = useState(false);

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

  useEffect(() => {
    if (!open) return;
    setError('');
    setShowMoreOptions(false);
    setUpdateContactFiscal(false);
    const today = new Date().toISOString().slice(0, 10);
    const in30Days = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const activeProf =
      profiles.find((p) => p.id === settings?.activeCompanyProfileId) ||
      profiles.find((p) => p.isDefault) ||
      profiles[0];

    if (existingInvoice) {
      setInvoiceNumber(existingInvoice.invoiceNumber);
      setCurrency(existingInvoice.currency);
      setExchangeRateText(String(existingInvoice.exchangeRate));
      setIssueDate(existingInvoice.issueDate);
      setDueDate(existingInvoice.dueDate);
      setDescription(existingInvoice.description);
      setNotes(existingInvoice.notes);

      if (mode === 'client') {
        const ci = existingInvoice as CustomerInvoice;
        setCompanyProfileId(ci.companyProfileId || activeProf?.id || '');
        setAmountInWordsOverride(ci.amountInWordsOverride || '');
        setContactId(ci.clientId);
        setBcNumber(ci.bcNumber || '');
        setLinkedBcRecuId(ci.linkedBcRecuId);
        setCampaignId(ci.campaignId);
        setCampaignRef(ci.campaignRef || '');
        setCampaignStartDate(ci.campaignStartDate || '');
        setCampaignEndDate(ci.campaignEndDate || '');
        setShowCampaignOnPrint(ci.showCampaignOnPrint ?? true);

        const c = contacts.find((x) => x.id === ci.clientId);
        setSnapAddress(ci.clientSnapshot?.address ?? c?.address ?? '');
        setSnapNif(ci.clientSnapshot?.nif ?? c?.nif ?? '');
        setSnapRc(ci.clientSnapshot?.rc ?? c?.rc ?? '');
        setSnapAi(ci.clientSnapshot?.ai ?? c?.ai ?? '');
      } else {
        const si = existingInvoice as SupplierInvoice;
        setAmountInWordsOverride('');
        setContactId(si.supplierId);
        setSupplierRef(si.supplierRef);
      }

      setLines(existingInvoice.lines.map((l) => invoiceLineToEditable(l)));
    } else if (prefillFromBc && mode === 'client') {
      const profId = prefillFromBc.companyProfileId || activeProf?.id || '';
      setCompanyProfileId(profId);
      generateNextInvoiceNumber('client', new Date().getFullYear(), profId).then((num) =>
        setInvoiceNumber(num)
      );
      setContactId(prefillFromBc.contactId);
      const c = contacts.find((x) => x.id === prefillFromBc.contactId);
      setSnapAddress(c?.address || '');
      setSnapNif(c?.nif || '');
      setSnapRc(c?.rc || '');
      setSnapAi(c?.ai || '');
      setIssueDate(today);
      setDueDate(in30Days);
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
      if (prefillFromBc.lines.length > 0) {
        setLines(prefillFromBc.lines.map((l) => invoiceLineToEditable(l, createId('line'))));
      } else {
        setLines([
          createDefaultEditableLine(createId('line'), defaultTva, {
            description: prefillFromBc.campaignRef || `Prestation BC ${prefillFromBc.poNumber}`,
            unit: 'forfait',
          }),
        ]);
      }
    } else {
      const profId = activeProf?.id || '';
      setCompanyProfileId(profId);
      generateNextInvoiceNumber(mode, new Date().getFullYear(), profId).then((num) =>
        setInvoiceNumber(num)
      );
      setSupplierRef('');
      setContactId(preselectedContactId || '');
      const c = contacts.find((x) => x.id === preselectedContactId);
      setSnapAddress(c?.address || '');
      setSnapNif(c?.nif || '');
      setSnapRc(c?.rc || '');
      setSnapAi(c?.ai || '');
      setIssueDate(today);
      setDueDate(in30Days);
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
  }, [open, existingInvoice, prefillFromBc, mode, preselectedContactId]);

  const handleProfileChange = async (newProfId: string) => {
    setCompanyProfileId(newProfId);
    if (!existingInvoice && mode === 'client') {
      const yr = parseInt((issueDate || '').slice(0, 4), 10) || new Date().getFullYear();
      const num = await generateNextInvoiceNumber('client', yr, newProfId);
      setInvoiceNumber(num);
    }
  };

  const handleClientChange = (cid: string) => {
    setContactId(cid);
    const c = contacts.find((x) => x.id === cid);
    if (c) {
      setSnapAddress(c.address || '');
      setSnapNif(c.nif || '');
      setSnapRc(c.rc || '');
      setSnapAi(c.ai || '');
    }
  };

  const contactOptions = useMemo(() => {
    return contacts.filter((c) => {
      if (c.archived && c.id !== contactId) return false;
      if (mode === 'client') return c.type === 'client' || c.type === 'les_deux';
      return c.type === 'fournisseur' || c.type === 'les_deux';
    });
  }, [contacts, mode, contactId]);

  const campaignDuration = useMemo(
    () => computeCampaignDuration(campaignStartDate, campaignEndDate),
    [campaignStartDate, campaignEndDate]
  );

  const computedTotals = useMemo(() => {
    const parsedLines = lines.map(editableToInvoiceLineInput);
    return computeInvoiceDocumentTotals(parsedLines);
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
  const baseDzdTotal = convertToBaseDzd(computedTotals.totalTtcCentimes, safeRate);
  const autoWordsHint = amountCentimesToFrenchWords(computedTotals.totalTtcCentimes, currency);
  const headerAccentBg =
    mode === 'client' && selectedProfile?.applyThemeToApp !== false
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
      const payloadLines = lines.map((l) => {
        const parsed = editableToInvoiceLineInput(l);
        return { ...parsed, description: parsed.description.trim() };
      });

      let savedDoc: CustomerInvoice | SupplierInvoice;
      if (mode === 'client') {
        const selectedContact = contacts.find((c) => c.id === contactId);
        const snapshot: ClientFiscalSnapshot | undefined = selectedContact
          ? {
              company: selectedContact.company || selectedContact.name,
              name: selectedContact.name,
              address: snapAddress,
              postalCode: selectedContact.postalCode,
              city: selectedContact.city,
              phone: selectedContact.phone,
              email: selectedContact.email,
              nif: snapNif,
              nis: selectedContact.nis,
              rc: snapRc,
              ai: snapAi,
            }
          : undefined;

        savedDoc = await saveCustomerInvoice({
          existingId: existingInvoice?.id,
          invoiceNumber,
          companyProfileId: companyProfileId || undefined,
          clientId: contactId,
          clientSnapshot: snapshot,
          updateContactFiscal: updateContactFiscal,
          issueDate,
          dueDate,
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
          lines: payloadLines,
        });
      } else {
        savedDoc = await saveSupplierInvoice({
          existingId: existingInvoice?.id,
          invoiceNumber,
          supplierRef,
          supplierId: contactId,
          issueDate,
          dueDate,
          currency,
          exchangeRate: safeRate,
          description,
          notes,
          lines: payloadLines,
        });
      }

      pushToast({
        type: 'success',
        title: existingInvoice ? 'Facture mise à jour' : 'Facture créée',
        message: savedDoc.invoiceNumber,
      });
      onSaved?.(savedDoc);
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
            {existingInvoice
              ? `Modifier la facture ${existingInvoice.invoiceNumber}`
              : mode === 'client'
              ? 'Nouvelle facture client'
              : 'Nouvelle facture fournisseur'}
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
            {mode === 'client' && profiles.length > 0 && (
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
                      onChange={(e) => handleProfileChange(e.target.value)}
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
              <label className="block text-xs font-medium text-slate-700">N° Facture *</label>
              <input
                type="text"
                value={invoiceNumber}
                onChange={(e) => setInvoiceNumber(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-medium"
              />
            </div>

            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-slate-700">
                {mode === 'client' ? 'Client *' : 'Fournisseur *'}
              </label>
              <select
                value={contactId}
                onChange={(e) => handleClientChange(e.target.value)}
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
              <label className="block text-xs font-medium text-slate-700">Date facture *</label>
              <input
                type="date"
                value={issueDate}
                onChange={(e) => setIssueDate(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
          </div>

          {/* Bloc Campagne & BC reçu (toujours visible pour les factures clients) */}
          {mode === 'client' && (
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
                      clientId={contactId}
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
                      clientId={contactId}
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
          )}

          {showAdvancedFields && (
            <div className="grid grid-cols-1 gap-4 rounded-lg border border-slate-200 bg-white p-4 sm:grid-cols-4">
              {mode === 'fournisseur' && (
                <div>
                  <label className="block text-xs font-medium text-slate-700">
                    Réf. facture fournisseur
                  </label>
                  <input
                    type="text"
                    value={supplierRef}
                    onChange={(e) => setSupplierRef(e.target.value)}
                    placeholder="Ex : F-904/26"
                    className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-slate-700">Date d’échéance</label>
                <input
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700">Objet / Résumé</label>
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Résumé de la prestation"
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                />
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

              {mode === 'client' && contactId && (
                <>
                  <div>
                    <label className="block text-xs font-medium text-slate-700">
                      Adresse client (sur facture)
                    </label>
                    <input
                      type="text"
                      value={snapAddress}
                      onChange={(e) => setSnapAddress(e.target.value)}
                      className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-xs"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700">NIF client</label>
                    <input
                      type="text"
                      value={snapNif}
                      onChange={(e) => setSnapNif(e.target.value)}
                      className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-xs"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700">RC client</label>
                    <input
                      type="text"
                      value={snapRc}
                      onChange={(e) => setSnapRc(e.target.value)}
                      className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-xs"
                    />
                  </div>
                  <div className="flex items-end pb-1">
                    <label className="inline-flex items-center gap-1.5 text-xs text-slate-700 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={updateContactFiscal}
                        onChange={(e) => setUpdateContactFiscal(e.target.checked)}
                      />
                      <span>Mettre à jour la fiche client</span>
                    </label>
                  </div>
                </>
              )}
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
                  TVA {defaultTva} % · Échéance {dueDate} · {currency}
                </span>
              )}
            </div>
          )}

          {/* Lignes de facturation (libre ou guidée par ligne) */}
          <SmartLineEditor
            title="Lignes de facturation"
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

          {/* Totaux & Notes */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {showAdvancedFields ? (
              <div className="space-y-3">
                {mode === 'client' && (
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
                )}
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
              {currency !== 'DZD' && (
                <div className="flex justify-between text-xs text-slate-500">
                  <span>Équivalent DZD (taux {safeRate})</span>
                  <span className="tabular-nums">{formatMoney(baseDzdTotal, 'DZD')}</span>
                </div>
              )}
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
              <span>{busy ? 'Enregistrement...' : 'Enregistrer la facture'}</span>
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
