import React, { useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  FileUp,
  Loader2,
  Printer,
  RotateCcw,
  Upload,
} from 'lucide-react';
import { DEVELOPER_BRAND } from '../constants/branding';
import { db } from '../db/database';
import type { ComputedInvoiceStatus } from '../db/types';
import {
  autoDetectColumnMapping,
  downloadExcelImportTemplate,
  downloadImportErrorsExcel,
  executeValidatedImport,
  exportReportToExcel,
  IMPORT_SCHEMAS,
  parseExcelBuffer,
  processInvoiceImportFiles,
  validateImportRows,
  type ExcelColumnDef,
  type ExcelImportType,
  type InvoiceModelEditableItem,
  type ParsedExcelSheet,
} from '../services/excelService';
import { InvoiceModelPreviewPanel } from '../components/InvoiceModelPreviewPanel';
import { useAppStore } from '../store/useAppStore';
import {
  computeContactAccountSummary,
  computeInvoicePaidCentimes,
  computeInvoiceRemainingCentimes,
  computeInvoiceStatus,
  computeLedgerTotals,
  computePaymentUnallocatedCentimes,
} from '../utils/finance';
import { addMoney, formatMoney, subtractMoney } from '../utils/money';
import {
  buildPdfFileName,
  buildStandaloneReportHtml,
  printCurrentViewAsPdf,
  printWithSettings,
} from '../utils/print';
import { useUiMode } from '../hooks/useUiMode';
import { computeBcRecuInvoicingStatus, formatDateFr } from '../utils/documentHelpers';

type ReportKind =
  | 'situation_globale'
  | 'recettes_depenses_mensuelles'
  | 'depenses_beneficiaire'
  | 'factures_clients_fournisseurs'
  | 'factures_impayees'
  | 'releve_client'
  | 'releve_fournisseur'
  | 'cheques_par_banque'
  | 'soldes_banques'
  | 'avances'
  | 'bc_recus_non_factures';

const REPORT_MENU: Array<{ id: ReportKind; label: string; advancedOnly?: boolean }> = [
  { id: 'situation_globale', label: 'Situation financière globale' },
  { id: 'recettes_depenses_mensuelles', label: 'Recettes et dépenses mensuelles' },
  { id: 'depenses_beneficiaire', label: 'Dépenses par bénéficiaire' },
  { id: 'factures_clients_fournisseurs', label: 'Factures clients & fournisseurs' },
  { id: 'factures_impayees', label: 'Factures impayées' },
  { id: 'bc_recus_non_factures', label: 'BC reçus non facturés' },
  { id: 'releve_client', label: 'Relevé de compte client' },
  { id: 'releve_fournisseur', label: 'Relevé de compte fournisseur', advancedOnly: true },
  { id: 'cheques_par_banque', label: 'Chèques par banque' },
  { id: 'soldes_banques', label: 'Soldes des banques et caisse' },
  { id: 'avances', label: 'Avances clients & fournisseurs' },
];

const STATUS_LABELS: Record<string, string> = {
  impayee: 'Impayée',
  partielle: 'Partielle',
  payee: 'Payée',
  en_retard: 'En retard',
  annulee: 'Annulée',
  recu: 'Reçu',
  prepare: 'Préparé',
  remis: 'Remis',
  depose: 'Déposé',
  en_attente: 'En attente',
  encaisse: 'Encaissé',
  rejete: 'Rejeté',
  annule: 'Annulé',
};

export const ReportsPage: React.FC = () => {
  const pushToast = useAppStore((s) => s.pushToast);
  const { isSimple } = useUiMode();

  const settings = useLiveQuery(() => db.settings.get('company_settings'));
  const contacts = useLiveQuery(
    async () => (await db.contacts.toArray()).filter((x) => !x.deletedAt),
    [],
    []
  );
  const bankAccounts = useLiveQuery(
    async () => (await db.bankAccounts.toArray()).filter((x) => !x.deletedAt),
    [],
    []
  );
  const chequeLeaves = useLiveQuery(() => db.chequeLeaves.toArray(), [], []);
  const customerInvoices = useLiveQuery(
    async () => (await db.customerInvoices.toArray()).filter((x) => !x.deletedAt),
    [],
    []
  );
  const supplierInvoices = useLiveQuery(
    async () => (await db.supplierInvoices.toArray()).filter((x) => !x.deletedAt),
    [],
    []
  );
  const purchaseOrders = useLiveQuery(
    async () => (await db.purchaseOrders.toArray()).filter((x) => !x.deletedAt),
    [],
    []
  );
  const payments = useLiveQuery(
    async () => (await db.payments.toArray()).filter((x) => !x.deletedAt),
    [],
    []
  );
  const allocations = useLiveQuery(() => db.paymentAllocations.toArray(), [], []);
  const expenses = useLiveQuery(
    async () => (await db.expenses.toArray()).filter((x) => !x.deletedAt),
    [],
    []
  );
  const incomingCheques = useLiveQuery(
    async () => (await db.incomingCheques.toArray()).filter((x) => !x.deletedAt),
    [],
    []
  );
  const outgoingCheques = useLiveQuery(
    async () => (await db.outgoingCheques.toArray()).filter((x) => !x.deletedAt),
    [],
    []
  );
  const ledgerEntries = useLiveQuery(
    async () => (await db.ledgerEntries.toArray()).filter((x) => x.status === 'valide'),
    [],
    []
  );

  const [mainTab, setMainTab] = useState<'rapports' | 'import'>('rapports');
  const [reportType, setReportType] = useState<ReportKind>('situation_globale');

  // Filtres communs des rapports
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [clientFilter, setClientFilter] = useState('tous');
  const [supplierFilter, setSupplierFilter] = useState('tous');
  const [bankFilter, setBankFilter] = useState('toutes');
  const [currencyFilter, setCurrencyFilter] = useState('toutes');
  const [statusFilter, setStatusFilter] = useState('tous');

  const companyProfiles = useLiveQuery(
    async () => (await db.companyProfiles.toArray()).filter((x) => !x.deletedAt),
    [],
    []
  );

  // État assistant d'importation Excel (avec jeton monotone + clé de session anti-état obsolète)
  const reportFileTokenRef = useRef(0);
  const [reportSessionKey, setReportSessionKey] = useState(0);
  const [importType, setImportType] = useState<ExcelImportType>('clients');
  const [importBuffer, setImportBuffer] = useState<ArrayBuffer | null>(null);
  const [parsedSheet, setParsedSheet] = useState<ParsedExcelSheet | null>(null);
  const [importFileName, setImportFileName] = useState('');
  const [invoiceFormItems, setInvoiceFormItems] = useState<InvoiceModelEditableItem[]>([]);
  const [invoiceFormIgnoredSheets, setInvoiceFormIgnoredSheets] = useState<
    Array<{ fileName: string; sheetName: string; reason: string }>
  >([]);
  const [invoiceFormFiles, setInvoiceFormFiles] = useState<string[]>([]);
  const [invoiceFormSheets, setInvoiceFormSheets] = useState<string[]>([]);
  const [isDraggingImport, setIsDraggingImport] = useState(false);
  const [columnMapping, setColumnMapping] = useState<Record<string, string>>({});
  const [groupInvoicesByNumber, setGroupInvoicesByNumber] = useState(true);
  const [createPaymentsForPaidRows, setCreatePaymentsForPaidRows] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [isExportingPdf, setIsExportingPdf] = useState(false);
  const reportPrintRef = useRef<HTMLDivElement>(null);

  const defaultCurrency = settings?.defaultCurrency || 'DZD';
  const currencies = settings?.enabledCurrencies;
  const today = new Date().toISOString().slice(0, 10);

  const contactMap = useMemo(() => new Map(contacts.map((c) => [c.id, c])), [contacts]);
  const bankMap = useMemo(() => new Map(bankAccounts.map((b) => [b.id, b])), [bankAccounts]);
  const validPaymentIds = useMemo(
    () => new Set(payments.filter((p) => p.status === 'valide').map((p) => p.id)),
    [payments]
  );

  const clientContacts = useMemo(
    () => contacts.filter((c) => c.type === 'client' || c.type === 'les_deux'),
    [contacts]
  );
  const supplierContacts = useMemo(
    () => contacts.filter((c) => c.type === 'fournisseur' || c.type === 'les_deux'),
    [contacts]
  );

  const inDateRange = (d: string) => {
    if (dateFrom && d < dateFrom) return false;
    if (dateTo && d > dateTo) return false;
    return true;
  };

  // Génération dynamique des colonnes, lignes, totaux et résumé pour le rapport sélectionné
  const reportData = useMemo(() => {
    let title = REPORT_MENU.find((r) => r.id === reportType)?.label || 'Rapport';
    let columns: ExcelColumnDef[] = [];
    let rows: Array<Record<string, string | number>> = [];
    let totalsRow: Record<string, string | number> | undefined;
    let summaryCards: Array<{ label: string; value: string; tone?: 'green' | 'red' | 'amber' | 'neutral' }> = [];

    if (reportType === 'situation_globale') {
      const filteredLedger = ledgerEntries.filter((e) => {
        if (e.status !== 'valide') return false;
        if (currencyFilter !== 'toutes' && e.currency !== currencyFilter) return false;
        if (bankFilter !== 'toutes') {
          if (bankFilter === 'cash' && e.bankAccountId !== null) return false;
          if (bankFilter !== 'cash' && e.bankAccountId !== bankFilter) return false;
        }
        return inDateRange(e.date);
      });
      const totals = computeLedgerTotals(filteredLedger);

      let opIn = 0;
      let opOut = 0;
      for (const e of filteredLedger) {
        if (e.sourceType === 'solde_ouverture') continue;
        if (e.direction === 'entree') opIn = addMoney(opIn, e.baseDzdAmountCentimes);
        else opOut = addMoney(opOut, e.baseDzdAmountCentimes);
      }

      let unpaidClients = 0;
      for (const inv of customerInvoices) {
        if (inv.status === 'annulee') continue;
        if (currencyFilter !== 'toutes' && inv.currency !== currencyFilter) continue;
        const paid = computeInvoicePaidCentimes(inv.id, allocations, validPaymentIds);
        const rem = computeInvoiceRemainingCentimes(inv.totalTtcCentimes, paid, inv.status);
        if (rem > 0 && inv.totalTtcCentimes > 0) {
          unpaidClients = addMoney(
            unpaidClients,
            Math.round((inv.baseDzdTtcCentimes * rem) / inv.totalTtcCentimes)
          );
        }
      }

      let unpaidSuppliers = 0;
      for (const inv of supplierInvoices) {
        if (inv.status === 'annulee') continue;
        if (currencyFilter !== 'toutes' && inv.currency !== currencyFilter) continue;
        const paid = computeInvoicePaidCentimes(inv.id, allocations, validPaymentIds);
        const rem = computeInvoiceRemainingCentimes(inv.totalTtcCentimes, paid, inv.status);
        if (rem > 0 && inv.totalTtcCentimes > 0) {
          unpaidSuppliers = addMoney(
            unpaidSuppliers,
            Math.round((inv.baseDzdTtcCentimes * rem) / inv.totalTtcCentimes)
          );
        }
      }

      let pendingInChq = 0;
      for (const c of incomingCheques) {
        if (c.status === 'recu' || c.status === 'depose' || c.status === 'en_attente') {
          pendingInChq = addMoney(pendingInChq, c.baseDzdAmountCentimes);
        }
      }

      let pendingOutChq = 0;
      for (const c of outgoingCheques) {
        if (
          c.status === 'prepare' ||
          c.status === 'remis' ||
          c.status === 'depose' ||
          c.status === 'en_attente'
        ) {
          pendingOutChq = addMoney(pendingOutChq, c.baseDzdAmountCentimes);
        }
      }

      const netProjected =
        totals.netBalanceBaseDzd + pendingInChq - pendingOutChq + unpaidClients - unpaidSuppliers;

      columns = [
        { header: 'Indicateur financier', key: 'label', type: 'text' },
        { header: 'Catégorie', key: 'category', type: 'text' },
        { header: `Montant (${defaultCurrency})`, key: 'amount', type: 'text' },
      ];
      rows = [
        {
          label: 'Trésorerie disponible réelle (Banques + Caisse)',
          category: 'Réel (Grand livre)',
          amount: formatMoney(totals.netBalanceBaseDzd, defaultCurrency, currencies),
        },
        {
          label: 'Recettes d’exploitation encaissées sur la période',
          category: 'Flux réels',
          amount: formatMoney(opIn, defaultCurrency, currencies),
        },
        {
          label: 'Dépenses & sorties réelles sur la période',
          category: 'Flux réels',
          amount: formatMoney(opOut, defaultCurrency, currencies),
        },
        {
          label: 'Créances clients (factures impayées)',
          category: 'À recevoir',
          amount: formatMoney(unpaidClients, defaultCurrency, currencies),
        },
        {
          label: 'Dettes fournisseurs (factures impayées)',
          category: 'À payer',
          amount: formatMoney(unpaidSuppliers, defaultCurrency, currencies),
        },
        {
          label: 'Chèques reçus en attente d’encaissement',
          category: 'Chèques en attente',
          amount: formatMoney(pendingInChq, defaultCurrency, currencies),
        },
        {
          label: 'Chèques émis en attente d’encaissement',
          category: 'Chèques en attente',
          amount: formatMoney(pendingOutChq, defaultCurrency, currencies),
        },
        {
          label: 'Position nette globale prévisionnelle',
          category: 'Synthèse',
          amount: formatMoney(netProjected, defaultCurrency, currencies),
        },
      ];
      summaryCards = [
        { label: 'Trésorerie réelle', value: formatMoney(totals.netBalanceBaseDzd, defaultCurrency, currencies) },
        { label: 'À recevoir (Clients)', value: formatMoney(unpaidClients, defaultCurrency, currencies), tone: 'green' },
        { label: 'À payer (Fournisseurs)', value: formatMoney(unpaidSuppliers, defaultCurrency, currencies), tone: 'red' },
        { label: 'Position nette prévisionnelle', value: formatMoney(netProjected, defaultCurrency, currencies), tone: netProjected >= 0 ? 'green' : 'red' },
      ];
    } else if (reportType === 'recettes_depenses_mensuelles') {
      const monthly = new Map<string, { inCentimes: number; outCentimes: number }>();
      for (const e of ledgerEntries) {
        if (e.status !== 'valide' || e.sourceType === 'solde_ouverture') continue;
        if (!inDateRange(e.date)) continue;
        if (currencyFilter !== 'toutes' && e.currency !== currencyFilter) continue;
        if (bankFilter !== 'toutes') {
          if (bankFilter === 'cash' && e.bankAccountId !== null) continue;
          if (bankFilter !== 'cash' && e.bankAccountId !== bankFilter) continue;
        }
        const ym = e.date.slice(0, 7);
        const cur = monthly.get(ym) || { inCentimes: 0, outCentimes: 0 };
        if (e.direction === 'entree') cur.inCentimes = addMoney(cur.inCentimes, e.baseDzdAmountCentimes);
        else cur.outCentimes = addMoney(cur.outCentimes, e.baseDzdAmountCentimes);
        monthly.set(ym, cur);
      }
      const sorted = Array.from(monthly.entries()).sort((a, b) => a[0].localeCompare(b[0]));
      let sumIn = 0;
      let sumOut = 0;

      columns = [
        { header: 'Mois', key: 'month', type: 'text' },
        { header: `Recettes (${defaultCurrency})`, key: 'recettes', type: 'text' },
        { header: `Dépenses (${defaultCurrency})`, key: 'depenses', type: 'text' },
        { header: `Solde net (${defaultCurrency})`, key: 'net', type: 'text' },
      ];
      rows = sorted.map(([ym, v]) => {
        sumIn = addMoney(sumIn, v.inCentimes);
        sumOut = addMoney(sumOut, v.outCentimes);
        const net = subtractMoney(v.inCentimes, v.outCentimes);
        return {
          month: ym,
          recettes: formatMoney(v.inCentimes, defaultCurrency, currencies),
          depenses: formatMoney(v.outCentimes, defaultCurrency, currencies),
          net: formatMoney(net, defaultCurrency, currencies),
        };
      });
      const totalNet = subtractMoney(sumIn, sumOut);
      totalsRow = {
        month: 'TOTAL PÉRIODE',
        recettes: formatMoney(sumIn, defaultCurrency, currencies),
        depenses: formatMoney(sumOut, defaultCurrency, currencies),
        net: formatMoney(totalNet, defaultCurrency, currencies),
      };
      summaryCards = [
        { label: 'Total Recettes', value: formatMoney(sumIn, defaultCurrency, currencies), tone: 'green' },
        { label: 'Total Dépenses', value: formatMoney(sumOut, defaultCurrency, currencies), tone: 'red' },
        { label: 'Résultat net', value: formatMoney(totalNet, defaultCurrency, currencies), tone: totalNet >= 0 ? 'green' : 'red' },
      ];
    } else if (reportType === 'depenses_beneficiaire') {
      const byBen = new Map<string, { count: number; total: number; lastDate: string }>();
      for (const exp of expenses) {
        if (exp.status !== 'valide') continue;
        if (!inDateRange(exp.date)) continue;
        if (currencyFilter !== 'toutes' && exp.currency !== currencyFilter) continue;
        if (bankFilter !== 'toutes') {
          if (bankFilter === 'cash' && exp.bankAccountId !== null) continue;
          if (bankFilter !== 'cash' && exp.bankAccountId !== bankFilter) continue;
        }
        const cur = byBen.get(exp.beneficiary) || { count: 0, total: 0, lastDate: exp.date };
        cur.count += 1;
        cur.total = addMoney(cur.total, exp.baseDzdAmountCentimes);
        if (exp.date > cur.lastDate) cur.lastDate = exp.date;
        byBen.set(exp.beneficiary, cur);
      }
      const list = Array.from(byBen.entries()).sort((a, b) => b[1].total - a[1].total);
      let grand = 0;

      columns = [
        { header: 'Bénéficiaire', key: 'beneficiary', type: 'text' },
        { header: 'Nombre de dépenses', key: 'count', type: 'number' },
        { header: 'Dernière dépense', key: 'lastDate', type: 'date' },
        { header: `Total (${defaultCurrency})`, key: 'total', type: 'text' },
      ];
      rows = list.map(([ben, v]) => {
        grand = addMoney(grand, v.total);
        return {
          beneficiary: ben,
          count: v.count,
          lastDate: v.lastDate,
          total: formatMoney(v.total, defaultCurrency, currencies),
        };
      });
      totalsRow = {
        beneficiary: 'TOTAL',
        count: list.reduce((acc, x) => acc + x[1].count, 0),
        lastDate: '',
        total: formatMoney(grand, defaultCurrency, currencies),
      };
      summaryCards = [
        { label: 'Bénéficiaires distincts', value: String(list.length) },
        { label: 'Total des dépenses', value: formatMoney(grand, defaultCurrency, currencies), tone: 'red' },
      ];
    } else if (
      reportType === 'factures_clients_fournisseurs' ||
      reportType === 'factures_impayees'
    ) {
      const items: Array<{
        kind: string;
        number: string;
        tier: string;
        date: string;
        dueDate: string;
        ttc: number;
        paid: number;
        rem: number;
        baseRem: number;
        currency: string;
        status: ComputedInvoiceStatus;
      }> = [];

      for (const inv of customerInvoices) {
        if (!inDateRange(inv.issueDate)) continue;
        if (clientFilter !== 'tous' && inv.clientId !== clientFilter) continue;
        if (supplierFilter !== 'tous') continue;
        if (currencyFilter !== 'toutes' && inv.currency !== currencyFilter) continue;

        const paid = computeInvoicePaidCentimes(inv.id, allocations, validPaymentIds);
        const rem = computeInvoiceRemainingCentimes(inv.totalTtcCentimes, paid, inv.status);
        const st = computeInvoiceStatus({
          storedStatus: inv.status,
          totalTtcCentimes: inv.totalTtcCentimes,
          paidCentimes: paid,
          dueDate: inv.dueDate,
          referenceDate: today,
        });
        if (reportType === 'factures_impayees' && (rem <= 0 || inv.status === 'annulee')) continue;
        if (statusFilter !== 'tous' && st !== statusFilter) continue;

        const c = contactMap.get(inv.clientId);
        const baseRem =
          inv.totalTtcCentimes > 0 ? Math.round((inv.baseDzdTtcCentimes * rem) / inv.totalTtcCentimes) : 0;
        items.push({
          kind: 'Client',
          number: inv.invoiceNumber,
          tier: c ? c.company || c.name : 'Client',
          date: inv.issueDate,
          dueDate: inv.dueDate,
          ttc: inv.totalTtcCentimes,
          paid,
          rem,
          baseRem,
          currency: inv.currency,
          status: st,
        });
      }

      for (const inv of supplierInvoices) {
        if (!inDateRange(inv.issueDate)) continue;
        if (supplierFilter !== 'tous' && inv.supplierId !== supplierFilter) continue;
        if (clientFilter !== 'tous') continue;
        if (currencyFilter !== 'toutes' && inv.currency !== currencyFilter) continue;

        const paid = computeInvoicePaidCentimes(inv.id, allocations, validPaymentIds);
        const rem = computeInvoiceRemainingCentimes(inv.totalTtcCentimes, paid, inv.status);
        const st = computeInvoiceStatus({
          storedStatus: inv.status,
          totalTtcCentimes: inv.totalTtcCentimes,
          paidCentimes: paid,
          dueDate: inv.dueDate,
          referenceDate: today,
        });
        if (reportType === 'factures_impayees' && (rem <= 0 || inv.status === 'annulee')) continue;
        if (statusFilter !== 'tous' && st !== statusFilter) continue;

        const s = contactMap.get(inv.supplierId);
        const baseRem =
          inv.totalTtcCentimes > 0 ? Math.round((inv.baseDzdTtcCentimes * rem) / inv.totalTtcCentimes) : 0;
        items.push({
          kind: 'Fournisseur',
          number: inv.invoiceNumber,
          tier: s ? s.company || s.name : 'Fournisseur',
          date: inv.issueDate,
          dueDate: inv.dueDate,
          ttc: inv.totalTtcCentimes,
          paid,
          rem,
          baseRem,
          currency: inv.currency,
          status: st,
        });
      }

      items.sort((a, b) => b.date.localeCompare(a.date));

      columns = [
        { header: 'Type', key: 'kind', type: 'text' },
        { header: 'N° Facture', key: 'number', type: 'text' },
        { header: 'Client / Fournisseur', key: 'tier', type: 'text' },
        { header: 'Date', key: 'date', type: 'date' },
        { header: 'Échéance', key: 'dueDate', type: 'date' },
        { header: 'Total TTC', key: 'ttc', type: 'text' },
        { header: 'Payé', key: 'paid', type: 'text' },
        { header: 'Reste dû', key: 'rem', type: 'text' },
        { header: 'Statut', key: 'status', type: 'text' },
      ];
      rows = items.map((x) => ({
        kind: x.kind,
        number: x.number,
        tier: x.tier,
        date: x.date,
        dueDate: x.dueDate,
        ttc: formatMoney(x.ttc, x.currency, currencies),
        paid: formatMoney(x.paid, x.currency, currencies),
        rem: formatMoney(x.rem, x.currency, currencies),
        status: STATUS_LABELS[x.status] || x.status,
      }));

      const totalClientRem = items
        .filter((x) => x.kind === 'Client' && x.status !== 'annulee')
        .reduce((a, x) => addMoney(a, x.baseRem), 0);
      const totalSupplierRem = items
        .filter((x) => x.kind === 'Fournisseur' && x.status !== 'annulee')
        .reduce((a, x) => addMoney(a, x.baseRem), 0);

      summaryCards = [
        { label: 'Factures affichées', value: String(items.length) },
        { label: 'Reste dû clients', value: formatMoney(totalClientRem, defaultCurrency, currencies), tone: 'green' },
        { label: 'Reste dû fournisseurs', value: formatMoney(totalSupplierRem, defaultCurrency, currencies), tone: 'red' },
      ];
    } else if (reportType === 'releve_client' || reportType === 'releve_fournisseur') {
      const isClient = reportType === 'releve_client';
      const targetList = isClient ? clientContacts : supplierContacts;
      const selectedId = isClient ? clientFilter : supplierFilter;
      const filteredContacts =
        selectedId !== 'tous' ? targetList.filter((c) => c.id === selectedId) : targetList;

      columns = [
        { header: isClient ? 'Client' : 'Fournisseur', key: 'tier', type: 'text' },
        { header: `Total facturé (${defaultCurrency})`, key: 'invoiced', type: 'text' },
        { header: `Total payé (${defaultCurrency})`, key: 'paid', type: 'text' },
        { header: `Reste impayé (${defaultCurrency})`, key: 'unpaid', type: 'text' },
        { header: `Avances disponibles (${defaultCurrency})`, key: 'advance', type: 'text' },
      ];

      let gInvoiced = 0;
      let gPaid = 0;
      let gUnpaid = 0;
      let gAdv = 0;

      rows = filteredContacts.map((c) => {
        const invList = isClient
          ? customerInvoices
              .filter((i) => i.clientId === c.id && inDateRange(i.issueDate))
              .map((i) => ({
                id: i.id,
                contactId: i.clientId,
                totalTtcCentimes: i.totalTtcCentimes,
                baseDzdTtcCentimes: i.baseDzdTtcCentimes,
                status: i.status,
              }))
          : supplierInvoices
              .filter((i) => i.supplierId === c.id && inDateRange(i.issueDate))
              .map((i) => ({
                id: i.id,
                contactId: i.supplierId,
                totalTtcCentimes: i.totalTtcCentimes,
                baseDzdTtcCentimes: i.baseDzdTtcCentimes,
                status: i.status,
              }));

        const summary = computeContactAccountSummary({
          contactId: c.id,
          direction: isClient ? 'client' : 'fournisseur',
          invoices: invList,
          payments: payments.filter((p) => inDateRange(p.date)),
          allocations,
        });

        gInvoiced = addMoney(gInvoiced, summary.totalInvoicedBaseDzd);
        gPaid = addMoney(gPaid, summary.totalAllocatedToInvoicesBaseDzd);
        gUnpaid = addMoney(gUnpaid, summary.totalUnpaidBaseDzd);
        gAdv = addMoney(gAdv, summary.availableAdvanceBaseDzd);

        return {
          tier: c.company || c.name,
          invoiced: formatMoney(summary.totalInvoicedBaseDzd, defaultCurrency, currencies),
          paid: formatMoney(summary.totalAllocatedToInvoicesBaseDzd, defaultCurrency, currencies),
          unpaid: formatMoney(summary.totalUnpaidBaseDzd, defaultCurrency, currencies),
          advance: formatMoney(summary.availableAdvanceBaseDzd, defaultCurrency, currencies),
        };
      });

      totalsRow = {
        tier: 'TOTAL',
        invoiced: formatMoney(gInvoiced, defaultCurrency, currencies),
        paid: formatMoney(gPaid, defaultCurrency, currencies),
        unpaid: formatMoney(gUnpaid, defaultCurrency, currencies),
        advance: formatMoney(gAdv, defaultCurrency, currencies),
      };
      summaryCards = [
        { label: 'Total facturé', value: formatMoney(gInvoiced, defaultCurrency, currencies) },
        { label: 'Total réglé', value: formatMoney(gPaid, defaultCurrency, currencies), tone: 'green' },
        { label: 'Total impayé', value: formatMoney(gUnpaid, defaultCurrency, currencies), tone: 'red' },
        { label: 'Avances', value: formatMoney(gAdv, defaultCurrency, currencies), tone: 'amber' },
      ];
    } else if (reportType === 'cheques_par_banque') {
      const chqRows: Array<{
        sens: string;
        bank: string;
        chequeNumber: string;
        tier: string;
        date: string;
        purpose: string;
        amount: string;
        status: string;
        baseAmt: number;
        isIn: boolean;
      }> = [];

      for (const c of incomingCheques) {
        if (!inDateRange(c.entryDate)) continue;
        if (bankFilter !== 'toutes' && bankFilter !== 'cash' && c.targetBankAccountId !== bankFilter) continue;
        if (clientFilter !== 'tous' && c.clientId !== clientFilter) continue;
        if (currencyFilter !== 'toutes' && c.currency !== currencyFilter) continue;
        if (statusFilter !== 'tous' && c.status !== statusFilter) continue;
        const client = contactMap.get(c.clientId);
        const bank = c.targetBankAccountId ? bankMap.get(c.targetBankAccountId) : null;
        chqRows.push({
          sens: 'Reçu (Client)',
          bank: bank ? `${bank.bankName} — ${bank.accountName}` : `Émettrice : ${c.issuerBank}`,
          chequeNumber: c.chequeNumber,
          tier: client ? client.company || client.name : 'Client',
          date: c.entryDate,
          purpose: c.issuerBank,
          amount: formatMoney(c.amountCentimes, c.currency, currencies),
          status: STATUS_LABELS[c.status] || c.status,
          baseAmt: c.baseDzdAmountCentimes,
          isIn: true,
        });
      }

      for (const c of outgoingCheques) {
        if (!inDateRange(c.issueDate)) continue;
        if (bankFilter !== 'toutes' && bankFilter !== 'cash' && c.bankAccountId !== bankFilter) continue;
        if (currencyFilter !== 'toutes' && c.currency !== currencyFilter) continue;
        if (statusFilter !== 'tous' && c.status !== statusFilter) continue;
        const bank = bankMap.get(c.bankAccountId);
        chqRows.push({
          sens: 'Émis (Sortie)',
          bank: bank ? `${bank.bankName} — ${bank.accountName}` : 'Banque',
          chequeNumber: c.chequeNumber,
          tier: c.beneficiary,
          date: c.issueDate,
          purpose: c.purpose,
          amount: formatMoney(c.amountCentimes, c.currency, currencies),
          status: STATUS_LABELS[c.status] || c.status,
          baseAmt: c.baseDzdAmountCentimes,
          isIn: false,
        });
      }

      chqRows.sort((a, b) => b.date.localeCompare(a.date));
      columns = [
        { header: 'Sens', key: 'sens', type: 'text' },
        { header: 'Banque', key: 'bank', type: 'text' },
        { header: 'N° Chèque', key: 'chequeNumber', type: 'text' },
        { header: 'Tiers / Bénéficiaire', key: 'tier', type: 'text' },
        { header: 'Date', key: 'date', type: 'date' },
        { header: 'Objet / Banque émettrice', key: 'purpose', type: 'text' },
        { header: 'Montant', key: 'amount', type: 'text' },
        { header: 'Statut', key: 'status', type: 'text' },
      ];
      rows = chqRows.map((x) => ({
        sens: x.sens,
        bank: x.bank,
        chequeNumber: x.chequeNumber,
        tier: x.tier,
        date: x.date,
        purpose: x.purpose,
        amount: x.amount,
        status: x.status,
      }));
      const totalIn = chqRows.filter((x) => x.isIn).reduce((a, x) => addMoney(a, x.baseAmt), 0);
      const totalOut = chqRows.filter((x) => !x.isIn).reduce((a, x) => addMoney(a, x.baseAmt), 0);
      summaryCards = [
        { label: 'Chèques affichés', value: String(chqRows.length) },
        { label: 'Total chèques reçus', value: formatMoney(totalIn, defaultCurrency, currencies), tone: 'green' },
        { label: 'Total chèques émis', value: formatMoney(totalOut, defaultCurrency, currencies), tone: 'red' },
      ];
    } else if (reportType === 'soldes_banques') {
      const cashTotals = computeLedgerTotals(
        ledgerEntries.filter((e) => e.bankAccountId === null && (!dateTo || e.date <= dateTo))
      );

      columns = [
        { header: 'Compte', key: 'account', type: 'text' },
        { header: 'RIB / Numéro', key: 'rib', type: 'text' },
        { header: 'Devise', key: 'currency', type: 'text' },
        { header: 'Solde en devise', key: 'nativeBalance', type: 'text' },
        { header: `Équivalent (${defaultCurrency})`, key: 'dzdBalance', type: 'text' },
      ];

      let totalDzd = cashTotals.netBalanceBaseDzd;
      rows = [
        {
          account: 'Caisse espèces',
          rib: 'Caisse principale',
          currency: defaultCurrency,
          nativeBalance: formatMoney(cashTotals.netBalanceBaseDzd, defaultCurrency, currencies),
          dzdBalance: formatMoney(cashTotals.netBalanceBaseDzd, defaultCurrency, currencies),
        },
      ];

      for (const b of bankAccounts) {
        if (bankFilter !== 'toutes' && bankFilter !== b.id) continue;
        if (currencyFilter !== 'toutes' && b.currency !== currencyFilter) continue;
        let native = 0;
        let baseDzd = 0;
        for (const e of ledgerEntries) {
          if (e.status !== 'valide' || e.bankAccountId !== b.id) continue;
          if (dateTo && e.date > dateTo) continue;
          native =
            e.direction === 'entree'
              ? addMoney(native, e.amountCentimes)
              : subtractMoney(native, e.amountCentimes);
          baseDzd =
            e.direction === 'entree'
              ? addMoney(baseDzd, e.baseDzdAmountCentimes)
              : subtractMoney(baseDzd, e.baseDzdAmountCentimes);
        }
        totalDzd = addMoney(totalDzd, baseDzd);
        rows.push({
          account: `${b.bankName} — ${b.accountName}`,
          rib: b.rib || b.accountNumber || '—',
          currency: b.currency,
          nativeBalance: formatMoney(native, b.currency, currencies),
          dzdBalance: formatMoney(baseDzd, defaultCurrency, currencies),
        });
      }

      totalsRow = {
        account: 'TOTAL TRÉSORERIE',
        rib: '',
        currency: defaultCurrency,
        nativeBalance: '',
        dzdBalance: formatMoney(totalDzd, defaultCurrency, currencies),
      };
      summaryCards = [
        { label: 'Caisse espèces', value: formatMoney(cashTotals.netBalanceBaseDzd, defaultCurrency, currencies) },
        { label: 'Total Trésorerie (DZD)', value: formatMoney(totalDzd, defaultCurrency, currencies), tone: 'green' },
      ];
    } else if (reportType === 'avances') {
      const advRows = payments
        .filter((p) => p.status === 'valide' && inDateRange(p.date))
        .map((p) => {
          const unalloc = computePaymentUnallocatedCentimes(p, allocations);
          return { p, unalloc };
        })
        .filter((x) => x.unalloc > 0)
        .filter((x) => {
          if (clientFilter !== 'tous' && x.p.contactId !== clientFilter) return false;
          if (supplierFilter !== 'tous' && x.p.contactId !== supplierFilter) return false;
          if (currencyFilter !== 'toutes' && x.p.currency !== currencyFilter) return false;
          return true;
        });

      columns = [
        { header: 'Type', key: 'direction', type: 'text' },
        { header: 'Tiers', key: 'tier', type: 'text' },
        { header: 'Date', key: 'date', type: 'date' },
        { header: 'Référence', key: 'ref', type: 'text' },
        { header: 'Montant versé', key: 'total', type: 'text' },
        { header: 'Solde avance disponible', key: 'unallocated', type: 'text' },
      ];

      let totalClientAdv = 0;
      let totalSupplierAdv = 0;
      rows = advRows.map(({ p, unalloc }) => {
        const c = contactMap.get(p.contactId);
        const baseUnalloc =
          p.amountCentimes > 0 ? Math.round((p.baseDzdAmountCentimes * unalloc) / p.amountCentimes) : 0;
        if (p.direction === 'entrant') totalClientAdv = addMoney(totalClientAdv, baseUnalloc);
        else totalSupplierAdv = addMoney(totalSupplierAdv, baseUnalloc);

        return {
          direction: p.direction === 'entrant' ? 'Avance client' : 'Avance fournisseur',
          tier: c ? c.company || c.name : 'Tiers',
          date: p.date,
          ref: p.reference || p.method,
          total: formatMoney(p.amountCentimes, p.currency, currencies),
          unallocated: formatMoney(unalloc, p.currency, currencies),
        };
      });
      summaryCards = [
        { label: 'Avances reçues (clients)', value: formatMoney(totalClientAdv, defaultCurrency, currencies), tone: 'amber' },
        { label: 'Avances versées (fournisseurs)', value: formatMoney(totalSupplierAdv, defaultCurrency, currencies), tone: 'green' },
      ];
    } else if (reportType === 'bc_recus_non_factures') {
      const bcRows = purchaseOrders
        .filter((po) => po.direction === 'bc_recu')
        .filter((po) => inDateRange(po.issueDate))
        .filter((po) => clientFilter === 'tous' || po.contactId === clientFilter)
        .filter((po) => currencyFilter === 'toutes' || po.currency === currencyFilter)
        .map((po) => {
          const linkedInvs = customerInvoices.filter(
            (inv) => inv.linkedBcRecuId === po.id && inv.status !== 'annulee'
          );
          const effectiveStatus = computeBcRecuInvoicingStatus({
            bc: po,
            linkedInvoices: linkedInvs,
          });
          const invoicedTotal = linkedInvs.reduce(
            (s, i) => addMoney(s, i.totalTtcCentimes),
            0
          );
          const remaining = Math.max(0, po.totalTtcCentimes - invoicedTotal);
          return { po, effectiveStatus, invoicedTotal, remaining };
        })
        .filter(
          (x) =>
            x.effectiveStatus === 'recu' ||
            x.effectiveStatus === 'en_cours' ||
            x.effectiveStatus === 'partiellement_facture'
        )
        .sort((a, b) => b.po.issueDate.localeCompare(a.po.issueDate));

      columns = [
        { header: 'N° BC reçu', key: 'poNumber', type: 'text' },
        { header: 'Date réception', key: 'issueDate', type: 'date' },
        { header: 'Client', key: 'client', type: 'text' },
        { header: 'Campagne', key: 'campaign', type: 'text' },
        { header: 'Montant estimé', key: 'total', type: 'text' },
        { header: 'Déjà facturé', key: 'invoiced', type: 'text' },
        { header: 'Reste à facturer', key: 'remaining', type: 'text' },
        { header: 'Statut', key: 'status', type: 'text' },
      ];

      let totalBc = 0;
      let totalRem = 0;
      rows = bcRows.map(({ po, effectiveStatus, invoicedTotal, remaining }) => {
        const c = contactMap.get(po.contactId);
        totalBc = addMoney(totalBc, po.totalTtcCentimes);
        totalRem = addMoney(totalRem, remaining);
        const label =
          effectiveStatus === 'partiellement_facture'
            ? 'Partiellement facturé'
            : effectiveStatus === 'en_cours'
            ? 'En cours'
            : 'Reçu (non facturé)';
        return {
          poNumber: po.poNumber,
          issueDate: formatDateFr(po.issueDate),
          client: c ? c.company || c.name : 'Client',
          campaign: po.campaignRef || '—',
          total: po.totalTtcCentimes > 0 ? formatMoney(po.totalTtcCentimes, po.currency, currencies) : '—',
          invoiced: invoicedTotal > 0 ? formatMoney(invoicedTotal, po.currency, currencies) : '0,00 DA',
          remaining: po.totalTtcCentimes > 0 ? formatMoney(remaining, po.currency, currencies) : 'À chiffrer',
          status: label,
        };
      });
      summaryCards = [
        { label: 'BC reçus en attente', value: String(bcRows.length) },
        { label: 'Montant total estimé', value: formatMoney(totalBc, defaultCurrency, currencies) },
        { label: 'Reste à facturer', value: formatMoney(totalRem, defaultCurrency, currencies), tone: 'amber' },
      ];
    }

    const filterSummaryParts: string[] = [];
    if (dateFrom || dateTo) filterSummaryParts.push(`Période : ${dateFrom || '...'} → ${dateTo || '...'}`);
    if (clientFilter !== 'tous') {
      const c = contactMap.get(clientFilter);
      if (c) filterSummaryParts.push(`Client : ${c.company || c.name}`);
    }
    if (supplierFilter !== 'tous') {
      const s = contactMap.get(supplierFilter);
      if (s) filterSummaryParts.push(`Fournisseur : ${s.company || s.name}`);
    }
    if (bankFilter !== 'toutes') {
      const b = bankMap.get(bankFilter);
      filterSummaryParts.push(
        bankFilter === 'cash' ? 'Compte : Caisse espèces' : `Banque : ${b?.bankName || bankFilter}`
      );
    }
    if (currencyFilter !== 'toutes') filterSummaryParts.push(`Devise : ${currencyFilter}`);
    if (statusFilter !== 'tous') filterSummaryParts.push(`Statut : ${STATUS_LABELS[statusFilter] || statusFilter}`);

    return {
      title,
      columns,
      rows,
      totalsRow,
      summaryCards,
      filterSummary: filterSummaryParts.join(' · ') || 'Tous les enregistrements',
    };
  }, [
    reportType,
    dateFrom,
    dateTo,
    clientFilter,
    supplierFilter,
    bankFilter,
    currencyFilter,
    statusFilter,
    ledgerEntries,
    customerInvoices,
    supplierInvoices,
    purchaseOrders,
    payments,
    allocations,
    expenses,
    incomingCheques,
    outgoingCheques,
    bankAccounts,
    contactMap,
    bankMap,
    validPaymentIds,
    clientContacts,
    supplierContacts,
    defaultCurrency,
    currencies,
    today,
  ]);

  // Validation import Excel (dérivée directement de [parsedSheet?.rows, columnMapping])
  const parsedRows = parsedSheet?.rows;
  const validationResults = useMemo(() => {
    if (!parsedRows || parsedRows.length === 0) return [];
    const chequeLeafKeys = new Set(
      chequeLeaves.map((l) => `${l.bankAccountId}::${l.chequeNumber.trim()}`)
    );
    return validateImportRows({
      type: importType,
      rows: parsedRows,
      mapping: columnMapping,
      options: { groupInvoicesByNumber },
      ctx: {
        contacts,
        customerInvoices,
        supplierInvoices,
        expenses,
        incomingCheques,
        outgoingCheques,
        chequeLeafKeys,
        bankAccounts,
        defaultTvaRate: settings?.defaultTvaRate ?? 19,
        defaultCurrency,
      },
    });
  }, [
    parsedRows,
    importType,
    columnMapping,
    groupInvoicesByNumber,
    contacts,
    customerInvoices,
    supplierInvoices,
    expenses,
    incomingCheques,
    outgoingCheques,
    chequeLeaves,
    bankAccounts,
    settings,
    defaultCurrency,
  ]);

  const importStats = useMemo(() => {
    const valides = validationResults.filter((r) => r.status === 'valide');
    const doublons = validationResults.filter((r) => r.status === 'doublon');
    const erreurs = validationResults.filter((r) => r.status === 'erreur');
    return { valides, doublons, erreurs };
  }, [validationResults]);

  const resetReportImportState = () => {
    reportFileTokenRef.current += 1;
    setReportSessionKey((k) => k + 1);
    setInvoiceFormItems([]);
    setInvoiceFormIgnoredSheets([]);
    setInvoiceFormFiles([]);
    setInvoiceFormSheets([]);
    setImportBuffer(null);
    setParsedSheet(null);
    setImportFileName('');
    setColumnMapping({});
  };

  const processReportImportFiles = async (fileList: FileList | File[]) => {
    const files = Array.from(fileList).filter((f) => /\.(xlsx|xls|csv)$/i.test(f.name));
    if (files.length === 0) return;

    // Réinitialiser TOUT l'état avant de lire le nouveau fichier
    resetReportImportState();
    const myToken = reportFileTokenRef.current;

    try {
      const buffers = await Promise.all(
        files.map(async (f) => ({
          fileName: f.name,
          buffer: await f.arrayBuffer(),
        }))
      );
      if (reportFileTokenRef.current !== myToken) return;

      // Tester parseInvoiceSheet() en priorité sur chaque feuille de chaque fichier
      const prepared = await processInvoiceImportFiles({
        files: buffers,
        profiles: companyProfiles,
        fallbackCompanyProfileId: settings?.activeCompanyProfileId,
        existingInvoices: customerInvoices,
        contacts,
        purchaseOrders,
      });
      if (reportFileTokenRef.current !== myToken) return;

      setReportSessionKey((k) => k + 1);

      if (prepared.mode === 'form') {
        setImportType('factures_clients');
        setInvoiceFormItems(prepared.formItems);
        setInvoiceFormIgnoredSheets(prepared.ignoredSheets);
        setInvoiceFormFiles(prepared.fileNames);
        setInvoiceFormSheets(prepared.sheetNames);
        setImportFileName(prepared.fileNames.join(', '));
        setImportBuffer(null);
        setParsedSheet(null);
        setColumnMapping({});
        pushToast({
          type: 'info',
          title: 'Mode détecté : Modèle facture',
          message: `${prepared.formItems.length} facture(s) extraite(s) (feuille : ${prepared.sheetNames.join(', ')}).`,
        });
        return;
      }

      const first = buffers[0];
      const parsed =
        importType === 'factures_clients' && prepared.parsedSheet
          ? prepared.parsedSheet
          : await parseExcelBuffer(first.buffer);
      if (reportFileTokenRef.current !== myToken) return;

      const detectedMapping =
        importType === 'factures_clients' && prepared.parsedSheet
          ? { ...prepared.columnMapping }
          : autoDetectColumnMapping(importType, parsed.headers);

      setImportBuffer(first.buffer);
      setParsedSheet(parsed);
      setImportFileName(first.fileName);
      setInvoiceFormItems([]);
      setInvoiceFormIgnoredSheets([]);
      setInvoiceFormFiles([]);
      setInvoiceFormSheets([]);
      setColumnMapping(detectedMapping);
      pushToast({
        type: 'info',
        title: 'Mode détecté : Tableau registre',
        message: `${parsed.rows.length} ligne(s) détectée(s) dans « ${parsed.sheetName} ».`,
      });
    } catch (err) {
      if (reportFileTokenRef.current !== myToken) return;
      resetReportImportState();
      pushToast({
        type: 'error',
        title: 'Lecture Excel impossible',
        message: err instanceof Error ? err.message : 'Fichier invalide.',
      });
    }
  };

  const handleExcelFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      await processReportImportFiles(e.target.files);
    }
    e.target.value = '';
  };

  const handleSheetSelect = async (sheetName: string) => {
    if (!importBuffer) return;
    const myToken = reportFileTokenRef.current;
    try {
      const parsed = await parseExcelBuffer(importBuffer, sheetName);
      if (reportFileTokenRef.current !== myToken) return;
      setReportSessionKey((k) => k + 1);
      setParsedSheet(parsed);
      setColumnMapping(autoDetectColumnMapping(importType, parsed.headers));
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Feuille illisible',
        message: err instanceof Error ? err.message : 'Feuille vide ou invalide.',
      });
    }
  };

  const handleConfirmImport = async () => {
    if (!settings || importStats.valides.length === 0) return;
    setIsImporting(true);
    try {
      const res = await executeValidatedImport({
        type: importType,
        validRows: importStats.valides,
        settings,
        fileName: importFileName,
        groupByInvoiceNumber: groupInvoicesByNumber,
        createMissingCampaigns: true,
        createPaymentsForPaidRows,
      });
      const msg =
        importType === 'factures_clients' && res.invoicesCreatedCount !== undefined
          ? `${res.invoicesCreatedCount} facture(s) créée(s) (${res.importedCount} ligne(s), ${importStats.doublons.length} doublon(s) ignoré(s)).`
          : `${res.importedCount} enregistrement(s) ajouté(s) (${importStats.doublons.length} doublon(s) ignoré(s)).`;
      pushToast({
        type: 'success',
        title: 'Importation réussie',
        message: msg,
      });
      setImportBuffer(null);
      setParsedSheet(null);
      setImportFileName('');
      setColumnMapping({});
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

  const currentSchema = IMPORT_SCHEMAS[importType];

  return (
    <div className="space-y-5">
      {/* Navigation principale Rapports / Import Excel (masquée à l'impression) */}
      <div className="no-print flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white p-3.5">
        <div className="flex items-center gap-1 rounded-md bg-slate-100 p-1">
          <button
            type="button"
            onClick={() => setMainTab('rapports')}
            className={`inline-flex items-center gap-2 rounded px-4 py-1.5 text-sm font-medium whitespace-nowrap ${
              mainTab === 'rapports' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
            }`}
          >
            <FileSpreadsheet className="h-4 w-4" />
            <span>Rapports & Exports (Excel / PDF)</span>
          </button>
          <button
            type="button"
            onClick={() => setMainTab('import')}
            className={`inline-flex items-center gap-2 rounded px-4 py-1.5 text-sm font-medium whitespace-nowrap ${
              mainTab === 'import' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
            }`}
          >
            <FileUp className="h-4 w-4" />
            <span>Assistant d’importation Excel</span>
          </button>
        </div>

        {mainTab === 'rapports' && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() =>
                exportReportToExcel({
                  title: reportData.title,
                  companyName: settings?.companyName || 'Gestion Financière',
                  filterSummary: reportData.filterSummary,
                  columns: reportData.columns,
                  rows: reportData.rows,
                  totalsRow: reportData.totalsRow,
                  fileName: `${reportType}-${today}.xlsx`,
                })
              }
              className="inline-flex items-center gap-2 rounded-md border border-emerald-300 bg-emerald-50 px-3.5 py-2 text-xs font-semibold text-emerald-800 hover:bg-emerald-100 whitespace-nowrap"
            >
              <Download className="h-4 w-4" />
              <span>Exporter Excel (.xlsx)</span>
            </button>
            <button
              type="button"
              disabled={isExportingPdf}
              onClick={async () => {
                setIsExportingPdf(true);
                try {
                  const fileName = buildPdfFileName('rapport', `${reportType}-${today}`);
                  const ps = settings?.printSettings;
                  const htmlContent = buildStandaloneReportHtml({
                    title: reportData.title,
                    filterSummary: reportData.filterSummary,
                    columns: reportData.columns,
                    rows: reportData.rows,
                    totalsRow: reportData.totalsRow,
                    summaryCards: reportData.summaryCards,
                    settings,
                    printSettings: ps,
                  });
                  const res = await printCurrentViewAsPdf(fileName, {
                    companyName: settings?.companyName,
                    landscape: ps?.orientation === 'landscape',
                    paperSize: ps?.paperSize || 'A4',
                    htmlContent,
                    element: reportPrintRef.current,
                  });
                  if (!res.ok) {
                    pushToast({
                      type: 'error',
                      title: 'Export PDF impossible',
                      message: res.error || 'Échec de génération du rapport PDF.',
                    });
                  } else if (!res.canceled) {
                    pushToast({
                      type: 'success',
                      title: res.method === 'electron' ? 'PDF enregistré' : 'PDF téléchargé',
                      message: res.filePath || fileName,
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
                  setIsExportingPdf(false);
                }
              }}
              className="inline-flex items-center gap-2 rounded-md bg-[#0F1E36] px-4 py-2 text-xs font-semibold text-white hover:bg-[#1a2f52] whitespace-nowrap disabled:opacity-60"
            >
              {isExportingPdf ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              <span>{isExportingPdf ? 'Génération du PDF…' : 'Exporter PDF (A4)'}</span>
            </button>
            <button
              type="button"
              onClick={async () => {
                const ps = settings?.printSettings;
                const htmlContent = buildStandaloneReportHtml({
                  title: reportData.title,
                  filterSummary: reportData.filterSummary,
                  columns: reportData.columns,
                  rows: reportData.rows,
                  totalsRow: reportData.totalsRow,
                  summaryCards: reportData.summaryCards,
                  settings,
                  printSettings: ps,
                });
                const printRes = await printWithSettings({
                  htmlContent,
                  printSettings: ps,
                });
                if (!printRes.ok) {
                  pushToast({
                    type: 'warning',
                    title: printRes.blockedByIframe
                      ? 'Impression bloquée par l’aperçu'
                      : 'Impression impossible',
                    message:
                      printRes.error ||
                      "Utilisez « Exporter PDF (A4) » ou ouvrez l'application dans un onglet séparé.",
                  });
                }
              }}
              className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
            >
              <Printer className="h-4 w-4" />
              <span>Imprimer</span>
            </button>
          </div>
        )}
      </div>

      {mainTab === 'rapports' ? (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-12 print:block">
          {/* Liste des 10 rapports (masquée à l'impression) */}
          <div className="no-print lg:col-span-3 space-y-1.5 rounded-lg border border-slate-200 bg-white p-3 h-fit">
            <div className="px-2 py-1 text-xs font-semibold uppercase tracking-wider text-slate-500">
              Choisir un rapport
            </div>
            {REPORT_MENU.filter((item) => !isSimple || !item.advancedOnly).map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setReportType(item.id)}
                className={`w-full rounded-md px-3 py-2 text-left text-xs font-medium transition-colors ${
                  reportType === item.id
                    ? 'bg-[#0F1E36] text-white'
                    : 'text-slate-700 hover:bg-slate-100'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>

          <div className="lg:col-span-9 space-y-4">
            {/* Barre de filtres (masquée à l'impression) */}
            <div className="no-print rounded-lg border border-slate-200 bg-white p-4">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                <div>
                  <label className="block text-[11px] font-medium text-slate-600">Date début</label>
                  <input
                    type="date"
                    value={dateFrom}
                    onChange={(e) => setDateFrom(e.target.value)}
                    className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-600">Date fin</label>
                  <input
                    type="date"
                    value={dateTo}
                    onChange={(e) => setDateTo(e.target.value)}
                    className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-600">Client</label>
                  <select
                    value={clientFilter}
                    onChange={(e) => setClientFilter(e.target.value)}
                    className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                  >
                    <option value="tous">Tous clients</option>
                    {clientContacts.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.company || c.name}
                      </option>
                    ))}
                  </select>
                </div>
                {!isSimple && (
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600">Fournisseur</label>
                    <select
                      value={supplierFilter}
                      onChange={(e) => setSupplierFilter(e.target.value)}
                      className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                    >
                      <option value="tous">Tous fournisseurs</option>
                      {supplierContacts.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.company || s.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <div>
                  <label className="block text-[11px] font-medium text-slate-600">Banque / Caisse</label>
                  <select
                    value={bankFilter}
                    onChange={(e) => setBankFilter(e.target.value)}
                    className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                  >
                    <option value="toutes">Toutes</option>
                    <option value="cash">Caisse espèces</option>
                    {bankAccounts.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.bankName} — {b.accountName}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-600">
                    {isSimple ? 'Statut' : 'Devise / Statut'}
                  </label>
                  <div className="mt-1 flex gap-1">
                    {!isSimple && (
                      <select
                        value={currencyFilter}
                        onChange={(e) => setCurrencyFilter(e.target.value)}
                        className="w-1/2 rounded border border-slate-300 bg-white px-1.5 py-1 text-xs"
                      >
                        <option value="toutes">Dev.</option>
                        {(currencies || []).map((c) => (
                          <option key={c.code} value={c.code}>
                            {c.code}
                          </option>
                        ))}
                      </select>
                    )}
                    <select
                      value={statusFilter}
                      onChange={(e) => setStatusFilter(e.target.value)}
                      className={`${isSimple ? 'w-full' : 'w-1/2'} rounded border border-slate-300 bg-white px-1.5 py-1 text-xs`}
                    >
                      <option value="tous">Statut</option>
                      {Object.entries(STATUS_LABELS).map(([k, v]) => (
                        <option key={k} value={k}>
                          {v}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
              <div className="mt-2.5 flex justify-end">
                <button
                  type="button"
                  onClick={() => {
                    setDateFrom('');
                    setDateTo('');
                    setClientFilter('tous');
                    setSupplierFilter('tous');
                    setBankFilter('toutes');
                    setCurrencyFilter('toutes');
                    setStatusFilter('tous');
                  }}
                  className="inline-flex items-center gap-1 text-xs font-medium text-slate-600 hover:text-slate-900"
                >
                  <RotateCcw className="h-3 w-3" />
                  <span>Réinitialiser les filtres</span>
                </button>
              </div>
            </div>

            {/* Zone imprimable A4 (Logo + Entreprise + Date + Titre + Totaux + Tableau) */}
            <div
              ref={reportPrintRef}
              className="print-area rounded-lg border border-slate-200 bg-white p-6 space-y-5"
            >
              {/* En-tête A4 Entreprise */}
              <div className="flex items-start justify-between border-b border-slate-300 pb-4">
                <div className="flex items-start gap-4">
                  {settings?.logoDataUrl ? (
                    <img
                      src={settings.logoDataUrl}
                      alt={settings.companyName || 'Logo'}
                      className="h-14 w-14 rounded border border-slate-200 bg-white object-contain p-1"
                    />
                  ) : (
                    <div className="flex h-14 w-14 items-center justify-center rounded border border-slate-200 bg-slate-50 text-slate-500">
                      <Building2 className="h-6 w-6" />
                    </div>
                  )}
                  <div>
                    <h2 className="text-base font-bold text-slate-900">
                      {settings?.companyName || 'Gestion Financière'}
                    </h2>
                    {settings?.address && (
                      <p className="text-xs text-slate-600">{settings.address}</p>
                    )}
                    <p className="text-[11px] text-slate-500">
                      {[
                        settings?.nif ? `NIF : ${settings.nif}` : '',
                        settings?.nis ? `NIS : ${settings.nis}` : '',
                        settings?.rc ? `RC : ${settings.rc}` : '',
                        settings?.ai ? `AI : ${settings.ai}` : '',
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  </div>
                </div>

                <div className="text-right">
                  <div className="text-sm font-bold text-[#0F1E36]">{reportData.title}</div>
                  <div className="mt-0.5 text-xs text-slate-600">
                    Édité le {new Date().toLocaleDateString('fr-FR')}
                  </div>
                  <div className="mt-0.5 text-[11px] text-slate-500">{reportData.filterSummary}</div>
                </div>
              </div>

              {/* Cartes de synthèse */}
              {reportData.summaryCards.length > 0 && (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {reportData.summaryCards.map((card) => (
                    <div key={card.label} className="rounded border border-slate-200 bg-slate-50 p-3">
                      <div className="text-[11px] text-slate-500">{card.label}</div>
                      <div
                        className={`mt-1 text-sm font-bold tabular-nums ${
                          card.tone === 'green'
                            ? 'text-emerald-700'
                            : card.tone === 'red'
                            ? 'text-red-700'
                            : card.tone === 'amber'
                            ? 'text-amber-700'
                            : 'text-slate-900'
                        }`}
                      >
                        {card.value}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Tableau du rapport */}
              <div className="overflow-x-auto rounded border border-slate-200">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-slate-200 bg-slate-50 font-semibold text-slate-700">
                    <tr>
                      {reportData.columns.map((col) => (
                        <th key={col.key} className="px-3 py-2.5 whitespace-nowrap">
                          {col.header}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {reportData.rows.length === 0 ? (
                      <tr>
                        <td
                          colSpan={reportData.columns.length}
                          className="px-4 py-8 text-center text-sm text-slate-500"
                        >
                          Aucune donnée correspondante aux filtres sélectionnés.
                        </td>
                      </tr>
                    ) : (
                      reportData.rows.map((row, idx) => (
                        <tr key={idx} className="hover:bg-slate-50">
                          {reportData.columns.map((col) => (
                            <td
                              key={col.key}
                              className={`px-3 py-2 ${
                                col.type === 'number' || String(row[col.key] ?? '').endsWith('DA')
                                  ? 'tabular-nums'
                                  : ''
                              }`}
                            >
                              {row[col.key]}
                            </td>
                          ))}
                        </tr>
                      ))
                    )}
                  </tbody>
                  {reportData.totalsRow && (
                    <tfoot className="border-t-2 border-slate-300 bg-slate-100 font-bold text-slate-900">
                      <tr>
                        {reportData.columns.map((col) => (
                          <td key={col.key} className="px-3 py-2.5 tabular-nums">
                            {reportData.totalsRow?.[col.key] ?? ''}
                          </td>
                        ))}
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>

              <div className="flex items-center justify-between border-t border-slate-200 pt-3 text-[11px] text-slate-500">
                <span>
                  {settings?.companyName || 'Gestion Financière'} — Édité hors-ligne le{' '}
                  {new Date().toLocaleDateString('fr-FR')}
                </span>
                <span>{DEVELOPER_BRAND}</span>
              </div>
            </div>
          </div>
        </div>
      ) : (
        /* ASSISTANT D'IMPORTATION EXCEL */
        <div className="space-y-5">
          {/* Étape 1 : Choix du type + Modèle téléchargeable */}
          <div className="rounded-lg border border-slate-200 bg-white p-5 space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h2 className="text-base font-semibold text-slate-900">
                  1. Choisir le type de données à importer & Modèle Excel
                </h2>
                <p className="mt-1 text-xs text-slate-500">
                  Les numéros de chèques sont conservés en texte (zéros initiaux préservés). Les doublons sont bloqués avant l’importation.
                </p>
              </div>
              <button
                type="button"
                onClick={() => downloadExcelImportTemplate(importType)}
                className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                <Download className="h-4 w-4 text-[#1D4ED8]" />
                <span>Télécharger le modèle Excel ({currentSchema.label})</span>
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
              {(Object.keys(IMPORT_SCHEMAS) as ExcelImportType[]).map((t) => {
                const s = IMPORT_SCHEMAS[t];
                const active = importType === t;
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => {
                      setImportType(t);
                      if (t !== 'factures_clients') {
                        setInvoiceFormItems([]);
                        setInvoiceFormIgnoredSheets([]);
                        setInvoiceFormFiles([]);
                      }
                      if (parsedSheet) {
                        setColumnMapping(autoDetectColumnMapping(t, parsedSheet.headers));
                      }
                    }}
                    className={`rounded-md border px-3 py-2 text-xs font-medium text-center transition-colors ${
                      active
                        ? 'border-[#0F1E36] bg-[#0F1E36] text-white'
                        : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100'
                    }`}
                  >
                    {s.label}
                  </button>
                );
              })}
            </div>

            <div className="rounded border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-xs text-slate-700">
              <strong>{currentSchema.label} :</strong> {currentSchema.description}
            </div>
          </div>

          {/* Étape 2 : Choix du fichier (glisser-déposer + multi-fichiers) */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setIsDraggingImport(true);
            }}
            onDragLeave={() => setIsDraggingImport(false)}
            onDrop={async (e) => {
              e.preventDefault();
              setIsDraggingImport(false);
              if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                await processReportImportFiles(e.dataTransfer.files);
              }
            }}
            className={`rounded-lg border-2 border-dashed p-5 space-y-3 transition-colors ${
              isDraggingImport
                ? 'border-[#1D4ED8] bg-blue-50/70'
                : 'border-slate-300 bg-white'
            }`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-base font-semibold text-slate-900">
                2. Sélectionner ou glisser-déposer votre fichier Excel (.xlsx, .xls ou .csv)
              </h2>
              <span className="text-xs text-slate-600">
                Mode détecté :{' '}
                <strong
                  className={
                    invoiceFormItems.length > 0
                      ? 'text-emerald-700'
                      : parsedSheet
                      ? 'text-[#1D4ED8]'
                      : 'text-slate-700'
                  }
                >
                  {invoiceFormItems.length > 0
                    ? 'Modèle facture'
                    : parsedSheet
                    ? 'Tableau registre'
                    : 'En attente d’un fichier'}
                </strong>
                {(invoiceFormSheets.length > 0 || parsedSheet?.sheetName) && (
                  <span className="ml-2 text-slate-500">
                    · Feuille :{' '}
                    <strong className="text-slate-800">
                      {invoiceFormItems.length > 0
                        ? invoiceFormSheets.join(', ')
                        : parsedSheet?.sheetName}
                    </strong>
                  </span>
                )}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-4">
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-md bg-[#0F1E36] px-4 py-2 text-sm font-medium text-white hover:bg-[#1a2f52]">
                <Upload className="h-4 w-4" />
                <span>
                  {importType === 'factures_clients'
                    ? 'Choisir un ou plusieurs fichiers Excel...'
                    : 'Choisir un fichier Excel...'}
                </span>
                <input
                  type="file"
                  multiple
                  accept=".xlsx,.xls,.csv"
                  onChange={handleExcelFileUpload}
                  className="hidden"
                />
              </label>
              {importFileName && (
                <div className="flex flex-wrap items-center gap-3 text-xs font-medium text-slate-700">
                  <span>
                    {invoiceFormItems.length > 0 ? (
                      <>
                        Fichier(s) : <strong>{importFileName}</strong> ({invoiceFormItems.length}{' '}
                        facture(s) modèle détectée(s))
                      </>
                    ) : (
                      <>
                        Fichier actif : <strong>{importFileName}</strong> ({parsedSheet?.rows.length || 0}{' '}
                        lignes)
                      </>
                    )}
                  </span>
                  {invoiceFormItems.length === 0 && parsedSheet && parsedSheet.sheetNames.length > 1 && (
                    <label className="inline-flex items-center gap-1.5">
                      <span className="text-slate-500">Feuille :</span>
                      <select
                        value={parsedSheet.sheetName}
                        onChange={(e) => handleSheetSelect(e.target.value)}
                        className="rounded border border-slate-300 bg-white px-2 py-1 text-xs"
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

            {importType === 'factures_clients' && invoiceFormItems.length === 0 && (
              <div className="flex flex-wrap gap-4 border-t border-slate-100 pt-3 text-xs text-slate-700">
                <label className="inline-flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={groupInvoicesByNumber}
                    onChange={(e) => setGroupInvoicesByNumber(e.target.checked)}
                    className="rounded border-slate-300"
                  />
                  <span>Regrouper les lignes ayant le même N° Facture (multi-lignes + lien Campagnes/BC)</span>
                </label>
                <label className="inline-flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={createPaymentsForPaidRows}
                    onChange={(e) => setCreatePaymentsForPaidRows(e.target.checked)}
                    className="rounded border-slate-300"
                  />
                  <span>Générer un encaissement validé si Statut = « Payée »</span>
                </label>
              </div>
            )}
          </div>

          {/* Mode 1 : Modèle facture détecté */}
          {importType === 'factures_clients' && invoiceFormItems.length > 0 && (
            <div key={`report-form-${reportSessionKey}`} className="rounded-lg border border-slate-200 bg-white p-5">
              <InvoiceModelPreviewPanel
                items={invoiceFormItems}
                onChangeItems={setInvoiceFormItems}
                ignoredSheets={invoiceFormIgnoredSheets}
                fileCount={invoiceFormFiles.length}
                onCancelFormMode={resetReportImportState}
                onImportSuccess={resetReportImportState}
              />
            </div>
          )}

          {/* Étape 3 : Correspondance des colonnes (Mode tableau registre uniquement) */}
          {invoiceFormItems.length === 0 && parsedSheet && (
            <div key={`report-mapping-${reportSessionKey}`} className="rounded-lg border border-slate-200 bg-white p-5 space-y-4">
              <div>
                <h2 className="text-base font-semibold text-slate-900">
                  3. Correspondance des colonnes (détection automatique française)
                </h2>
                <p className="mt-1 text-xs text-slate-500">
                  Vérifiez que chaque champ du logiciel correspond à la bonne colonne de votre fichier Excel.
                </p>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {currentSchema.fields.map((field) => (
                  <div key={`${reportSessionKey}-${field.key}`} className="rounded border border-slate-200 bg-slate-50 p-2.5">
                    <label className="block text-xs font-semibold text-slate-800">
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
          )}

          {/* Étape 4 : Prévisualisation, détection d'erreurs & validation finale */}
          {invoiceFormItems.length === 0 && parsedSheet && (
            <div className="rounded-lg border border-slate-200 bg-white p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-slate-900">
                    4. Validation avant importation
                  </h2>
                  <div className="mt-1 flex flex-wrap items-center gap-4 text-xs">
                    <span className="inline-flex items-center gap-1 font-semibold text-emerald-700">
                      <CheckCircle2 className="h-4 w-4" />
                      {importStats.valides.length} valide(s)
                    </span>
                    <span className="inline-flex items-center gap-1 font-semibold text-amber-700">
                      <AlertTriangle className="h-4 w-4" />
                      {importStats.doublons.length} doublon(s) bloqué(s)
                    </span>
                    <span className="inline-flex items-center gap-1 font-semibold text-red-700">
                      <AlertTriangle className="h-4 w-4" />
                      {importStats.erreurs.length} erreur(s)
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {(importStats.erreurs.length > 0 || importStats.doublons.length > 0) && (
                    <button
                      type="button"
                      onClick={() => downloadImportErrorsExcel(validationResults, importType)}
                      className="inline-flex items-center gap-1.5 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-100"
                    >
                      <Download className="h-3.5 w-3.5" />
                      <span>Télécharger le rapport d’erreurs (.xlsx)</span>
                    </button>
                  )}

                  <button
                    type="button"
                    disabled={isImporting || importStats.valides.length === 0}
                    onClick={handleConfirmImport}
                    className="inline-flex items-center gap-2 rounded-md bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                  >
                    <CheckCircle2 className="h-4 w-4" />
                    <span>
                      {isImporting
                        ? 'Importation en cours...'
                        : `Importer ${importStats.valides.length} ligne(s) valide(s)`}
                    </span>
                  </button>
                </div>
              </div>

              <div className="max-h-96 overflow-auto rounded border border-slate-200">
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 border-b border-slate-200 bg-slate-50 font-semibold text-slate-600">
                    <tr>
                      <th className="px-3 py-2">Ligne</th>
                      <th className="px-3 py-2">Statut</th>
                      <th className="px-3 py-2">Contrôle / Détail</th>
                      {currentSchema.fields.slice(0, 5).map((f) => (
                        <th key={f.key} className="px-3 py-2">
                          {f.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {validationResults.map((row) => (
                      <tr
                        key={`${reportSessionKey}-${row.rowIndex}`}
                        className={
                          row.status === 'erreur'
                            ? 'bg-red-50/50'
                            : row.status === 'doublon'
                            ? 'bg-amber-50/50'
                            : 'hover:bg-slate-50'
                        }
                      >
                        <td className="px-3 py-2 text-slate-500 tabular-nums">{row.rowIndex}</td>
                        <td className="px-3 py-2 font-semibold whitespace-nowrap">
                          {row.status === 'valide' ? (
                            <span className="text-emerald-700">Valide</span>
                          ) : row.status === 'doublon' ? (
                            <span className="text-amber-700">Doublon</span>
                          ) : (
                            <span className="text-red-700">Erreur</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-slate-700">{row.message}</td>
                        {currentSchema.fields.slice(0, 5).map((f) => (
                          <td
                            key={f.key}
                            className={`px-3 py-2 ${f.isTextProtected ? 'font-mono' : ''}`}
                          >
                            {row.mapped[f.key] || '—'}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
