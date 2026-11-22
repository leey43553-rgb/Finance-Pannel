import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowLeft, Download, FileSpreadsheet, Loader2, Printer } from 'lucide-react';
import { db } from '../db/database';
import { SharedDocumentTemplate, type SharedDocumentKind } from '../components/SharedDocumentTemplate';
import { exportCustomerInvoiceToModelExcel } from '../services/excelService';
import { useAppStore } from '../store/useAppStore';
import {
  computeInvoicePaidCentimes,
  computeInvoiceRemainingCentimes,
} from '../utils/finance';
import {
  buildPdfFileName,
  printCurrentViewAsPdf,
  printWithSettings,
  triggerBrowserPrint,
} from '../utils/print';
import { resolveEffectiveCompanyProfile } from '../utils/documentHelpers';

export const PrintDocumentPage: React.FC = () => {
  const { kind: paramKind, id } = useParams<{ kind?: string; id?: string }>();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const pushToast = useAppStore((s) => s.pushToast);

  const kind =
    paramKind || (location.pathname.includes('lot-factures') ? 'lot-factures' : undefined);
  const batchIds = useMemo(
    () =>
      (searchParams.get('ids') || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    [searchParams]
  );

  const sheetRef = useRef<HTMLDivElement>(null);
  const autoPrintedRef = useRef(false);
  const [isExporting, setIsExporting] = useState(false);

  const settings = useLiveQuery(() => db.settings.get('company_settings'));
  const profiles = useLiveQuery(
    () => db.companyProfiles.filter((p) => !p.deletedAt).toArray(),
    [],
    []
  );
  const contacts = useLiveQuery(() => db.contacts.filter((c) => !c.deletedAt).toArray(), [], []);
  const customerInvoice = useLiveQuery(
    async () => (kind === 'facture' && id ? db.customerInvoices.get(id) : undefined),
    [kind, id]
  );
  const batchInvoices = useLiveQuery(
    async () => {
      if (kind !== 'lot-factures' || batchIds.length === 0) return [];
      const found = await db.customerInvoices.where('id').anyOf(batchIds).toArray();
      const map = new Map(found.filter((i) => !i.deletedAt).map((i) => [i.id, i]));
      return batchIds
        .map((bid) => map.get(bid))
        .filter((inv): inv is NonNullable<typeof inv> => Boolean(inv));
    },
    [kind, batchIds.join(',')]
  );
  const supplierInvoice = useLiveQuery(
    async () =>
      kind === 'facture-fournisseur' && id ? db.supplierInvoices.get(id) : undefined,
    [kind, id]
  );
  const proforma = useLiveQuery(
    async () => (kind === 'proforma' && id ? db.proformas.get(id) : undefined),
    [kind, id]
  );
  const purchaseOrder = useLiveQuery(
    async () => (kind === 'bc' && id ? db.purchaseOrders.get(id) : undefined),
    [kind, id]
  );
  const payments = useLiveQuery(() => db.payments.filter((p) => !p.deletedAt).toArray(), [], []);
  const allocations = useLiveQuery(() => db.paymentAllocations.toArray(), [], []);

  const contactMap = useMemo(() => new Map(contacts.map((c) => [c.id, c])), [contacts]);
  const profileMap = useMemo(() => new Map(profiles.map((p) => [p.id, p])), [profiles]);

  const fallbackProfile = useMemo(
    () =>
      profiles.find((p) => p.id === settings?.activeCompanyProfileId) ||
      profiles.find((p) => p.isDefault) ||
      profiles[0],
    [profiles, settings?.activeCompanyProfileId]
  );

  const validPaymentIds = useMemo(
    () => new Set(payments.filter((p) => p.status === 'valide').map((p) => p.id)),
    [payments]
  );

  const batchItems = useMemo(() => {
    if (kind !== 'lot-factures' || !batchInvoices || batchInvoices.length === 0) return [];
    return batchInvoices.map((inv) => {
      const contact = contactMap.get(inv.clientId);
      const paid = computeInvoicePaidCentimes(inv.id, allocations, validPaymentIds);
      const remaining = computeInvoiceRemainingCentimes(inv.totalTtcCentimes, paid, inv.status);
      const profile = resolveEffectiveCompanyProfile({
        companyProfileId: inv.companyProfileId,
        issuerSnapshot: inv.issuerSnapshot,
        profileMap,
        fallbackProfile,
      });
      return {
        id: inv.id,
        docKind: 'facture' as SharedDocumentKind,
        docNumber: inv.invoiceNumber,
        issueDate: inv.issueDate,
        dueDate: inv.dueDate,
        bcNumber: inv.bcNumber,
        campaignRef: inv.campaignRef,
        campaignStartDate: inv.campaignStartDate,
        campaignEndDate: inv.campaignEndDate,
        showCampaignOnPrint: inv.showCampaignOnPrint,
        contact,
        clientSnapshot: inv.clientSnapshot,
        profile,
        currency: inv.currency,
        lines: inv.lines,
        totalHtCentimes: inv.totalHtCentimes,
        totalTvaCentimes: inv.totalTvaCentimes,
        totalTtcCentimes: inv.totalTtcCentimes,
        paidCentimes: paid,
        remainingCentimes: remaining,
        amountInWordsOverride: inv.amountInWordsOverride,
        notes: inv.notes,
      };
    });
  }, [kind, batchInvoices, contactMap, allocations, validPaymentIds, profileMap, fallbackProfile]);

  const resolved = useMemo(() => {
    if (kind === 'facture' && customerInvoice) {
      const contact = contactMap.get(customerInvoice.clientId);
      const paid = computeInvoicePaidCentimes(customerInvoice.id, allocations, validPaymentIds);
      const remaining = computeInvoiceRemainingCentimes(
        customerInvoice.totalTtcCentimes,
        paid,
        customerInvoice.status
      );
      const profile = resolveEffectiveCompanyProfile({
        companyProfileId: customerInvoice.companyProfileId,
        issuerSnapshot: customerInvoice.issuerSnapshot,
        profileMap,
        fallbackProfile,
      });
      return {
        docKind: 'facture' as SharedDocumentKind,
        docNumber: customerInvoice.invoiceNumber,
        issueDate: customerInvoice.issueDate,
        dueDate: customerInvoice.dueDate,
        bcNumber: customerInvoice.bcNumber,
        campaignRef: customerInvoice.campaignRef,
        campaignStartDate: customerInvoice.campaignStartDate,
        campaignEndDate: customerInvoice.campaignEndDate,
        showCampaignOnPrint: customerInvoice.showCampaignOnPrint,
        contact,
        clientSnapshot: customerInvoice.clientSnapshot,
        profile,
        currency: customerInvoice.currency,
        lines: customerInvoice.lines,
        totalHtCentimes: customerInvoice.totalHtCentimes,
        totalTvaCentimes: customerInvoice.totalTvaCentimes,
        totalTtcCentimes: customerInvoice.totalTtcCentimes,
        paidCentimes: paid,
        remainingCentimes: remaining,
        amountInWordsOverride: customerInvoice.amountInWordsOverride,
        notes: customerInvoice.notes,
        fileName: buildPdfFileName(
          'facture',
          customerInvoice.invoiceNumber,
          customerInvoice.clientSnapshot?.company || contact?.company || contact?.name
        ),
      };
    }

    if (kind === 'proforma' && proforma) {
      const contact = contactMap.get(proforma.clientId);
      const profile = resolveEffectiveCompanyProfile({
        companyProfileId: proforma.companyProfileId,
        issuerSnapshot: proforma.issuerSnapshot,
        profileMap,
        fallbackProfile,
      });
      return {
        docKind: 'proforma' as SharedDocumentKind,
        docNumber: proforma.proformaNumber,
        issueDate: proforma.issueDate,
        bcNumber: proforma.bcNumber,
        campaignRef: proforma.campaignRef,
        campaignStartDate: proforma.campaignStartDate,
        campaignEndDate: proforma.campaignEndDate,
        showCampaignOnPrint: proforma.showCampaignOnPrint,
        validityDays: proforma.validityDays,
        validUntil: proforma.validUntil,
        paymentConditions: proforma.paymentConditions,
        deliveryDelay: proforma.deliveryDelay,
        contact,
        clientSnapshot: proforma.clientSnapshot,
        profile,
        currency: proforma.currency,
        lines: proforma.lines,
        totalHtCentimes: proforma.totalHtCentimes,
        totalTvaCentimes: proforma.totalTvaCentimes,
        totalTtcCentimes: proforma.totalTtcCentimes,
        amountInWordsOverride: proforma.amountInWordsOverride,
        notes: proforma.notes,
        fileName: buildPdfFileName(
          'proforma',
          proforma.proformaNumber,
          proforma.clientSnapshot?.company || contact?.company || contact?.name
        ),
      };
    }

    if (kind === 'bc' && purchaseOrder) {
      const contact = contactMap.get(purchaseOrder.contactId);
      const profile = resolveEffectiveCompanyProfile({
        companyProfileId: purchaseOrder.companyProfileId,
        issuerSnapshot: purchaseOrder.issuerSnapshot,
        profileMap,
        fallbackProfile,
      });
      return {
        docKind: 'bc_emis' as SharedDocumentKind,
        docNumber: purchaseOrder.poNumber,
        issueDate: purchaseOrder.issueDate,
        dueDate: purchaseOrder.expectedDate,
        campaignRef: purchaseOrder.campaignRef,
        campaignStartDate: purchaseOrder.campaignStartDate,
        campaignEndDate: purchaseOrder.campaignEndDate,
        showCampaignOnPrint: purchaseOrder.showCampaignOnPrint,
        contact,
        profile,
        currency: purchaseOrder.currency,
        lines: purchaseOrder.lines,
        totalHtCentimes: purchaseOrder.totalHtCentimes,
        totalTvaCentimes: purchaseOrder.totalTvaCentimes,
        totalTtcCentimes: purchaseOrder.totalTtcCentimes,
        amountInWordsOverride: purchaseOrder.amountInWordsOverride,
        notes: purchaseOrder.notes,
        unpriced: purchaseOrder.unpriced,
        fileName: buildPdfFileName(
          'bc_emis',
          purchaseOrder.poNumber,
          contact?.company || contact?.name
        ),
      };
    }

    if (kind === 'facture-fournisseur' && supplierInvoice) {
      const contact = contactMap.get(supplierInvoice.supplierId);
      const paid = computeInvoicePaidCentimes(supplierInvoice.id, allocations, validPaymentIds);
      const remaining = computeInvoiceRemainingCentimes(
        supplierInvoice.totalTtcCentimes,
        paid,
        supplierInvoice.status
      );
      return {
        docKind: 'facture_fournisseur' as SharedDocumentKind,
        docNumber: supplierInvoice.invoiceNumber,
        issueDate: supplierInvoice.issueDate,
        dueDate: supplierInvoice.dueDate,
        supplierRef: supplierInvoice.supplierRef,
        contact,
        profile: fallbackProfile,
        currency: supplierInvoice.currency,
        lines: supplierInvoice.lines,
        totalHtCentimes: supplierInvoice.totalHtCentimes,
        totalTvaCentimes: supplierInvoice.totalTvaCentimes,
        totalTtcCentimes: supplierInvoice.totalTtcCentimes,
        paidCentimes: paid,
        remainingCentimes: remaining,
        notes: supplierInvoice.notes,
        fileName: buildPdfFileName(
          'facture_fournisseur',
          supplierInvoice.invoiceNumber,
          contact?.company || contact?.name
        ),
      };
    }

    return null;
  }, [
    kind,
    customerInvoice,
    supplierInvoice,
    proforma,
    purchaseOrder,
    contactMap,
    profileMap,
    fallbackProfile,
    allocations,
    validPaymentIds,
  ]);

  const isBatchMode = kind === 'lot-factures';
  const hasReadyDocument = isBatchMode ? batchItems.length > 0 : Boolean(resolved);
  const currentPrintRoute = `${location.pathname}${location.search}`;
  const printSettings = settings?.printSettings;
  const isLandscape = printSettings?.orientation === 'landscape';
  const paperSize = printSettings?.paperSize || 'A4';
  const exportFileName = isBatchMode
    ? `Lot_Factures_${batchItems.length}_documents.pdf`
    : resolved?.fileName || 'document.pdf';

  useEffect(() => {
    if (hasReadyDocument && searchParams.get('autoPrint') === '1' && !autoPrintedRef.current) {
      autoPrintedRef.current = true;
      const timer = setTimeout(() => {
        const res = triggerBrowserPrint();
        if (!res.ok) {
          pushToast({
            type: 'warning',
            title: 'Impression bloquée par l’aperçu',
            message:
              res.error || "Ouvrez l'application dans un onglet séparé pour imprimer",
          });
        }
      }, 350);
      return () => clearTimeout(timer);
    }
  }, [hasReadyDocument, searchParams, pushToast]);

  const handleExportPdf = async () => {
    if (!hasReadyDocument) return;
    setIsExporting(true);
    try {
      if (!window.electronAPI?.printToPDF && !sheetRef.current) {
        throw new Error('Élément A4 du document introuvable.');
      }
      const res = await printCurrentViewAsPdf(exportFileName, {
        companyName: resolved?.profile?.name || batchItems[0]?.profile?.name || settings?.companyName,
        rawLayout: true,
        landscape: isLandscape,
        paperSize,
        printRoute: currentPrintRoute,
        element: sheetRef.current,
      });
      if (!res.ok) {
        pushToast({
          type: 'error',
          title: 'Export PDF impossible',
          message: res.error || 'Une erreur est survenue lors de la création du PDF.',
        });
      } else if (!res.canceled) {
        pushToast({
          type: 'success',
          title: res.method === 'electron' ? 'PDF enregistré' : 'PDF A4 téléchargé',
          message:
            res.method === 'electron' && res.filePath
              ? res.filePath
              : `${res.fileName || exportFileName} généré au format ${paperSize}.`,
          undoLabel:
            res.method === 'electron' && res.filePath ? 'Ouvrir le dossier' : undefined,
          onUndo:
            res.method === 'electron' && res.filePath
              ? () => {
                  window.electronAPI?.openFolder(res.filePath!);
                }
              : undefined,
        });
      }
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Erreur lors de l’export PDF',
        message: err instanceof Error ? err.message : 'Erreur inconnue.',
      });
    } finally {
      setIsExporting(false);
    }
  };

  const handleDirectPrint = async () => {
    try {
      const printRes = await printWithSettings({
        printRoute: currentPrintRoute,
        printSettings,
      });
      if (!printRes.ok) {
        pushToast({
          type: 'warning',
          title: printRes.blockedByIframe
            ? 'Impression bloquée par l’aperçu'
            : 'Impression impossible',
          message:
            printRes.error || "Ouvrez l'application dans un onglet séparé pour imprimer",
        });
      }
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Impression impossible',
        message:
          err instanceof Error
            ? err.message
            : "Ouvrez l'application dans un onglet séparé pour imprimer",
      });
    }
  };

  if (!hasReadyDocument) {
    return (
      <div className="min-h-screen bg-slate-100 p-8 flex flex-col items-center justify-center gap-4">
        <div className="rounded-lg border border-slate-200 bg-white p-6 text-center shadow-sm max-w-md">
          <h1 className="text-base font-semibold text-slate-900">
            {isBatchMode ? 'Aucune facture sélectionnée' : 'Document introuvable'}
          </h1>
          <p className="mt-1 text-xs text-slate-600">
            Ce document est en cours de chargement ou a été supprimé.
          </p>
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="mt-4 inline-flex items-center gap-2 rounded-md bg-slate-900 px-4 py-2 text-xs font-medium text-white"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span>Retour</span>
          </button>
        </div>
      </div>
    );
  }

  const pageMarginCss =
    printSettings?.margins === 'none'
      ? '0'
      : printSettings?.margins === 'minimum'
        ? '5mm'
        : '0';
  const accentBtnColor =
    resolved?.profile?.accentColor || batchItems[0]?.profile?.accentColor || '#6B2FA0';

  return (
    <div
      data-print-ready="true"
      className="min-h-screen bg-slate-200 py-6 px-4 print:bg-white print:p-0"
    >
      <style>{`@media print { @page { size: ${paperSize} ${printSettings?.orientation || 'portrait'}; margin: ${pageMarginCss}; } }`}</style>

      <div className="no-print mx-auto mb-4 flex max-w-[210mm] items-center justify-between rounded-lg border border-slate-300 bg-white px-4 py-3 shadow-sm">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span>Retour</span>
          </button>
          {isBatchMode && (
            <span className="text-xs font-semibold text-slate-700">
              Lot de {batchItems.length} facture(s) prête(s) à imprimer
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={isExporting}
            onClick={handleExportPdf}
            className="inline-flex items-center gap-1.5 rounded-md px-3.5 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
            style={{ backgroundColor: accentBtnColor }}
          >
            {isExporting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            <span>{isExporting ? 'Génération du PDF…' : `Exporter PDF (${paperSize})`}</span>
          </button>
          {kind === 'facture' && customerInvoice && resolved && (
            <button
              type="button"
              onClick={() => {
                exportCustomerInvoiceToModelExcel({
                  invoice: customerInvoice,
                  profile: resolved.profile,
                  contact: resolved.contact,
                });
                pushToast({
                  type: 'success',
                  title: 'Excel facture exporté',
                  message: `Facture ${customerInvoice.invoiceNumber} exportée au format Modèle facture (.xlsx).`,
                });
              }}
              className="inline-flex items-center gap-1.5 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-800 hover:bg-emerald-100"
            >
              <FileSpreadsheet className="h-3.5 w-3.5" />
              <span>Excel (.xlsx)</span>
            </button>
          )}
          <button
            type="button"
            onClick={handleDirectPrint}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-xs font-medium text-slate-800 hover:bg-slate-50"
          >
            <Printer className="h-3.5 w-3.5" />
            <span>Imprimer</span>
          </button>
        </div>
      </div>

      <div ref={sheetRef} className="print-area mx-auto w-[210mm] bg-transparent print:bg-white">
        {isBatchMode ? (
          <div className="space-y-6 print:space-y-0">
            {batchItems.map((item) => (
              <SharedDocumentTemplate
                key={item.id}
                docKind={item.docKind}
                docNumber={item.docNumber}
                issueDate={item.issueDate}
                dueDate={item.dueDate}
                bcNumber={item.bcNumber}
                campaignRef={item.campaignRef}
                campaignStartDate={item.campaignStartDate}
                campaignEndDate={item.campaignEndDate}
                showCampaignOnPrint={item.showCampaignOnPrint}
                profile={item.profile}
                settings={settings}
                contact={item.contact}
                clientSnapshot={item.clientSnapshot}
                currency={item.currency}
                lines={item.lines}
                totalHtCentimes={item.totalHtCentimes}
                totalTvaCentimes={item.totalTvaCentimes}
                totalTtcCentimes={item.totalTtcCentimes}
                paidCentimes={item.paidCentimes}
                remainingCentimes={item.remainingCentimes}
                amountInWordsOverride={item.amountInWordsOverride}
                notes={item.notes}
              />
            ))}
          </div>
        ) : (
          resolved && (
            <SharedDocumentTemplate
              docKind={resolved.docKind}
              docNumber={resolved.docNumber}
              issueDate={resolved.issueDate}
              dueDate={resolved.dueDate}
              bcNumber={resolved.bcNumber}
              supplierRef={resolved.supplierRef}
              campaignRef={resolved.campaignRef}
              campaignStartDate={resolved.campaignStartDate}
              campaignEndDate={resolved.campaignEndDate}
              showCampaignOnPrint={resolved.showCampaignOnPrint}
              validityDays={resolved.validityDays}
              validUntil={resolved.validUntil}
              paymentConditions={resolved.paymentConditions}
              deliveryDelay={resolved.deliveryDelay}
              profile={resolved.profile}
              settings={settings}
              contact={resolved.contact}
              clientSnapshot={resolved.clientSnapshot}
              currency={resolved.currency}
              lines={resolved.lines}
              totalHtCentimes={resolved.totalHtCentimes}
              totalTvaCentimes={resolved.totalTvaCentimes}
              totalTtcCentimes={resolved.totalTtcCentimes}
              paidCentimes={resolved.paidCentimes}
              remainingCentimes={resolved.remainingCentimes}
              amountInWordsOverride={resolved.amountInWordsOverride}
              notes={resolved.notes}
              unpriced={resolved.unpriced}
            />
          )
        )}
      </div>
    </div>
  );
};
