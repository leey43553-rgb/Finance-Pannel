import * as XLSX from 'xlsx';
import { createId, db, recordAudit } from '../db/database';
import type {
  Campaign,
  ClientFiscalSnapshot,
  CompanyProfile,
  CompanySettings,
  Contact,
  CustomerInvoice,
  Expense,
  IncomingCheque,
  IncomingChequeStatus,
  InvoiceLine,
  LedgerEntry,
  OutgoingCheque,
  OutgoingChequeStatus,
  Payment,
  PaymentAllocation,
  PaymentMethod,
  PurchaseOrder,
  SupplierInvoice,
} from '../db/types';
import {
  computeBcRecuInvoicingStatus,
  parseDocumentNumberParts,
  suggestCampaignStatus,
} from '../utils/documentHelpers';
import { computeInvoiceDocumentTotals } from '../utils/finance';
import { convertToBaseDzd, parseMoneyInputToCentimes } from '../utils/money';
import { buildIssuerSnapshot } from './documentActions';
import {
  buildInvoiceModelWorkbook,
  downloadInvoiceModelExcel,
  type ExportInvoiceModelParams,
  type ParsedInvoiceClientInfo,
  type ParsedInvoiceCompanyFiscal,
  type ParsedInvoiceLine,
  type ParsedInvoiceSheet,
  type ParsedInvoiceTotals,
  parseInvoiceSheet,
  parseWorkbook,
  scanWorkbooksForInvoiceForms,
  type WorkbookInvoiceScanResult,
} from './import/parseInvoiceModel';

export {
  buildInvoiceModelWorkbook,
  downloadInvoiceModelExcel,
  parseInvoiceSheet,
  parseWorkbook,
  scanWorkbooksForInvoiceForms,
};
export type {
  ExportInvoiceModelParams,
  ParsedInvoiceClientInfo,
  ParsedInvoiceCompanyFiscal,
  ParsedInvoiceLine,
  ParsedInvoiceSheet,
  ParsedInvoiceTotals,
  WorkbookInvoiceScanResult,
};

export interface ExcelColumnDef {
  header: string;
  key: string;
  type?: 'text' | 'number' | 'date';
}

export function exportReportToExcel(params: {
  title: string;
  companyName: string;
  filterSummary: string;
  columns: ExcelColumnDef[];
  rows: Array<Record<string, string | number>>;
  totalsRow?: Record<string, string | number>;
  fileName: string;
}): void {
  const aoa: Array<Array<string | number>> = [
    [params.companyName || 'Gestion Financière'],
    [params.title],
    [`Édité le : ${new Date().toLocaleDateString('fr-FR')}${params.filterSummary ? ` · ${params.filterSummary}` : ''}`],
    [],
    params.columns.map((c) => c.header),
  ];

  const dataStartRowIdx = aoa.length;
  for (const row of params.rows) {
    aoa.push(params.columns.map((c) => row[c.key] ?? ''));
  }

  if (params.totalsRow) {
    aoa.push(params.columns.map((c) => params.totalsRow?.[c.key] ?? ''));
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);

  // Conserver les colonnes texte (ex : N° Chèque, N° Facture, NIF, Téléphone) au format texte '@'
  const textColIndices = params.columns
    .map((c, idx) => (c.type === 'text' ? idx : -1))
    .filter((idx) => idx >= 0);

  for (let r = dataStartRowIdx; r < aoa.length; r += 1) {
    for (const c of textColIndices) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = ws[addr];
      if (cell) {
        cell.t = 's';
        cell.v = String(cell.v ?? '');
        cell.z = '@';
      }
    }
  }

  ws['!cols'] = params.columns.map((col, idx) => {
    let maxLen = col.header.length;
    for (let r = dataStartRowIdx; r < aoa.length; r += 1) {
      const val = String(aoa[r][idx] ?? '');
      if (val.length > maxLen) maxLen = val.length;
    }
    return { wch: Math.min(45, Math.max(12, maxLen + 3)) };
  });

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Rapport');
  XLSX.writeFile(wb, params.fileName.endsWith('.xlsx') ? params.fileName : `${params.fileName}.xlsx`);
}

// ============================================================================
// IMPORTATION EXCEL (Détection française, mapping manuel, zéros initiaux, doublons)
// ============================================================================

export type ExcelImportType =
  | 'clients'
  | 'fournisseurs'
  | 'factures_clients'
  | 'factures_fournisseurs'
  | 'depenses'
  | 'cheques_recus'
  | 'cheques_emis';

export interface ImportFieldDef {
  key: string;
  label: string;
  required?: boolean;
  aliases: string[];
  isTextProtected?: boolean;
}

export interface ImportSchemaDef {
  type: ExcelImportType;
  label: string;
  description: string;
  templateFileName: string;
  fields: ImportFieldDef[];
  exampleRows: Array<Record<string, string>>;
}

export const IMPORT_SCHEMAS: Record<ExcelImportType, ImportSchemaDef> = {
  clients: {
    type: 'clients',
    label: 'Clients',
    description: 'Importer une liste de clients avec leurs coordonnées et identifiants fiscaux.',
    templateFileName: 'modele-import-clients.xlsx',
    fields: [
      { key: 'company', label: 'Société / Raison sociale', aliases: ['societe', 'entreprise', 'raison sociale', 'client'] },
      { key: 'name', label: 'Nom du contact', required: true, aliases: ['nom', 'contact', 'nom complet', 'responsable'] },
      { key: 'phone', label: 'Téléphone', aliases: ['telephone', 'tel', 'mobile', 'gsm'], isTextProtected: true },
      { key: 'email', label: 'Email', aliases: ['email', 'mail', 'courriel'] },
      { key: 'address', label: 'Adresse', aliases: ['adresse', 'wilaya', 'ville'] },
      { key: 'nif', label: 'NIF', aliases: ['nif'], isTextProtected: true },
      { key: 'nis', label: 'NIS', aliases: ['nis'], isTextProtected: true },
      { key: 'rc', label: 'RC', aliases: ['rc', 'registre de commerce'], isTextProtected: true },
      { key: 'ai', label: 'AI', aliases: ['ai', 'article imposition'], isTextProtected: true },
      { key: 'notes', label: 'Notes', aliases: ['notes', 'observations', 'remarque'] },
    ],
    exampleRows: [
      {
        company: 'SARL Atlas Construction',
        name: 'Amine Ziani',
        phone: '0550112233',
        email: 'contact@atlas-const.example',
        address: 'Dar El Beïda, Alger',
        nif: '002216099887766',
        nis: '002216099887700',
        rc: '16/00-0998877B22',
        ai: '16240998877',
        notes: 'Client B2B',
      },
    ],
  },
  fournisseurs: {
    type: 'fournisseurs',
    label: 'Fournisseurs',
    description: 'Importer une liste de fournisseurs et prestataires.',
    templateFileName: 'modele-import-fournisseurs.xlsx',
    fields: [
      { key: 'company', label: 'Société / Raison sociale', aliases: ['societe', 'entreprise', 'raison sociale', 'fournisseur'] },
      { key: 'name', label: 'Nom du contact', required: true, aliases: ['nom', 'contact', 'nom complet'] },
      { key: 'phone', label: 'Téléphone', aliases: ['telephone', 'tel', 'mobile'], isTextProtected: true },
      { key: 'email', label: 'Email', aliases: ['email', 'mail'] },
      { key: 'address', label: 'Adresse', aliases: ['adresse', 'ville', 'wilaya'] },
      { key: 'nif', label: 'NIF', aliases: ['nif'], isTextProtected: true },
      { key: 'nis', label: 'NIS', aliases: ['nis'], isTextProtected: true },
      { key: 'rc', label: 'RC', aliases: ['rc'], isTextProtected: true },
      { key: 'ai', label: 'AI', aliases: ['ai'], isTextProtected: true },
      { key: 'notes', label: 'Notes', aliases: ['notes', 'observations'] },
    ],
    exampleRows: [
      {
        company: 'EURL Équipements Pro',
        name: 'Rachid Toumi',
        phone: '0661778899',
        email: 'achats@equipements-pro.example',
        address: 'Zone Industrielle Rouïba, Alger',
        nif: '001916044556677',
        nis: '001916044556600',
        rc: '16/00-0445566B19',
        ai: '16240445566',
        notes: 'Matériel industriel',
      },
    ],
  },
  factures_clients: {
    type: 'factures_clients',
    label: 'Factures clients',
    description:
      'Importer des factures clients (une ou plusieurs lignes par N° Facture, N° BC, Campagne, Qté/P.U. ou HT/TTC).',
    templateFileName: 'modele-import-factures-clients.xlsx',
    fields: [
      { key: 'invoiceNumber', label: 'N° Facture', required: true, aliases: ['n facture', 'numero facture', 'no facture', 'facture', 'ref facture'], isTextProtected: true },
      { key: 'clientName', label: 'Client', required: true, aliases: ['client', 'nom client', 'societe', 'tiers', 'raison sociale'] },
      { key: 'issueDate', label: 'Date', required: true, aliases: ['date', 'date facture', 'date emission'] },
      { key: 'dueDate', label: 'Date d’échéance', aliases: ['echeance', 'date echeance', 'date d echeance', 'date decheance'] },
      { key: 'bcNumber', label: 'N° BC', aliases: ['n bc', 'numero bc', 'no bc', 'bc', 'bon de commande', 'ref bc'], isTextProtected: true },
      { key: 'campaignRef', label: 'Campagne / Réf.', aliases: ['campagne ref', 'campagne', 'nom campagne', 'reference', 'ref', 'projet'] },
      { key: 'campaignStartDate', label: 'Début campagne', aliases: ['debut campagne', 'date debut', 'debut', 'du'] },
      { key: 'campaignEndDate', label: 'Fin campagne', aliases: ['fin campagne', 'date fin', 'fin', 'au'] },
      { key: 'description', label: 'Désignation / Description', aliases: ['designation description', 'designation', 'description', 'libelle', 'objet', 'prestation'] },
      { key: 'quantity', label: 'Qté', aliases: ['qte', 'quantite', 'qty', 'nombre'] },
      { key: 'unit', label: 'Unité', aliases: ['unite', 'unites', 'unit', 'u'] },
      { key: 'unitPrice', label: 'Prix unitaire HT', aliases: ['pu ht', 'p u ht', 'prix unitaire ht', 'prix unitaire', 'pu'] },
      { key: 'htAmount', label: 'Montant HT', aliases: ['montant ht', 'ht', 'total ht', 'net ht'] },
      { key: 'tvaRate', label: 'Taux TVA (%)', aliases: ['taux tva', 'taux de tva', 'tva %', 'pourcentage tva'] },
      { key: 'tvaAmount', label: 'Montant TVA', aliases: ['tva', 'montant tva', 'total tva'] },
      { key: 'ttcAmount', label: 'Montant TTC', aliases: ['ttc', 'montant ttc', 'total ttc'] },
      { key: 'status', label: 'Statut', aliases: ['statut', 'etat', 'reglee', 'paiement'] },
      { key: 'currency', label: 'Devise', aliases: ['devise', 'monnaie'] },
      { key: 'exchangeRate', label: 'Taux de change', aliases: ['taux de change', 'taux', 'cours'] },
      { key: 'clientNif', label: 'NIF client', aliases: ['nif client', 'nif'], isTextProtected: true },
      { key: 'clientAddress', label: 'Adresse client', aliases: ['adresse client', 'adresse'] },
      { key: 'notes', label: 'Notes', aliases: ['notes', 'remarque', 'observations'] },
    ],
    exampleRows: [
      {
        invoiceNumber: '081/26',
        clientName: 'SARL Atlas Construction',
        issueDate: '2026-11-01',
        dueDate: '2026-12-01',
        bcNumber: '38/26/RL',
        campaignRef: 'Campagne Lancement Hiver',
        campaignStartDate: '2026-11-05',
        campaignEndDate: '2026-12-05',
        description: 'Location panneau Unipol 12×4 m — Alger Centre (1 mois)',
        quantity: '2',
        unit: 'mois',
        unitPrice: '150000,00',
        htAmount: '300000,00',
        tvaRate: '19',
        tvaAmount: '57000,00',
        ttcAmount: '357000,00',
        status: 'Impayée',
        currency: 'DZD',
        exchangeRate: '1',
        clientNif: '002216099887766',
        clientAddress: 'Dar El Beïda, Alger',
        notes: 'Ligne 1 sur 2 (même N° Facture regroupé automatiquement)',
      },
      {
        invoiceNumber: '081/26',
        clientName: 'SARL Atlas Construction',
        issueDate: '2026-11-01',
        dueDate: '2026-12-01',
        bcNumber: '38/26/RL',
        campaignRef: 'Campagne Lancement Hiver',
        campaignStartDate: '2026-11-05',
        campaignEndDate: '2026-12-05',
        description: 'Impression et pose bâche frontlit 48 m²',
        quantity: '48',
        unit: 'm²',
        unitPrice: '2000,00',
        htAmount: '96000,00',
        tvaRate: '19',
        tvaAmount: '18240,00',
        ttcAmount: '114240,00',
        status: 'Impayée',
        currency: 'DZD',
        exchangeRate: '1',
        clientNif: '',
        clientAddress: '',
        notes: 'Ligne 2 sur 2',
      },
    ],
  },
  factures_fournisseurs: {
    type: 'factures_fournisseurs',
    label: 'Factures fournisseurs',
    description: 'Importer des factures fournisseurs avec référence fournisseur et TVA.',
    templateFileName: 'modele-import-factures-fournisseurs.xlsx',
    fields: [
      { key: 'invoiceNumber', label: 'N° Facture interne', required: true, aliases: ['n° facture', 'numero facture', 'n facture', 'facture'], isTextProtected: true },
      { key: 'supplierRef', label: 'Référence fournisseur', aliases: ['reference fournisseur', 'ref fournisseur', 'n facture fournisseur'], isTextProtected: true },
      { key: 'supplierName', label: 'Fournisseur', required: true, aliases: ['fournisseur', 'nom fournisseur', 'societe'] },
      { key: 'issueDate', label: 'Date', required: true, aliases: ['date', 'date facture'] },
      { key: 'dueDate', label: 'Date d’échéance', aliases: ['echeance', 'date echeance'] },
      { key: 'description', label: 'Description', aliases: ['description', 'libelle', 'objet'] },
      { key: 'htAmount', label: 'Montant HT', required: true, aliases: ['montant ht', 'ht', 'total ht'] },
      { key: 'tvaRate', label: 'Taux TVA (%)', aliases: ['taux tva', 'tva %'] },
      { key: 'tvaAmount', label: 'Montant TVA', aliases: ['tva', 'montant tva'] },
      { key: 'ttcAmount', label: 'Montant TTC', aliases: ['ttc', 'montant ttc'] },
      { key: 'currency', label: 'Devise', aliases: ['devise'] },
      { key: 'exchangeRate', label: 'Taux de change', aliases: ['taux de change', 'taux'] },
      { key: 'notes', label: 'Notes', aliases: ['notes'] },
    ],
    exampleRows: [
      {
        invoiceNumber: 'FF-2026-0101',
        supplierRef: 'F-785/26',
        supplierName: 'EURL Équipements Pro',
        issueDate: '2026-11-02',
        dueDate: '2026-12-02',
        description: 'Achat outillage',
        htAmount: '50000,00',
        tvaRate: '19',
        tvaAmount: '9500,00',
        ttcAmount: '59500,00',
        currency: 'DZD',
        exchangeRate: '1',
        notes: '',
      },
    ],
  },
  depenses: {
    type: 'depenses',
    label: 'Dépenses',
    description: 'Importer des dépenses (en espèces, virement ou carte — ou liées à un chèque).',
    templateFileName: 'modele-import-depenses.xlsx',
    fields: [
      { key: 'date', label: 'Date', required: true, aliases: ['date', 'date depense'] },
      { key: 'beneficiary', label: 'Bénéficiaire', required: true, aliases: ['beneficiaire', 'paye a', 'fournisseur', 'tiers'] },
      { key: 'category', label: 'Catégorie', aliases: ['categorie', 'poste', 'nature'] },
      { key: 'description', label: 'Description', required: true, aliases: ['description', 'libelle', 'motif', 'objet'] },
      { key: 'amount', label: 'Montant', required: true, aliases: ['montant', 'ttc', 'somme'] },
      { key: 'currency', label: 'Devise', aliases: ['devise'] },
      { key: 'exchangeRate', label: 'Taux de change', aliases: ['taux de change', 'taux'] },
      { key: 'paymentMethod', label: 'Mode de paiement', aliases: ['mode de paiement', 'mode', 'paiement', 'reglement'] },
      { key: 'bankName', label: 'Banque', aliases: ['banque', 'compte bancaire', 'compte'] },
      { key: 'reference', label: 'Référence', aliases: ['reference', 'ref', 'n piece'], isTextProtected: true },
      { key: 'notes', label: 'Notes', aliases: ['notes'] },
    ],
    exampleRows: [
      {
        date: '2026-11-04',
        beneficiary: 'Algérie Télécom',
        category: 'Internet & téléphone',
        description: 'Abonnement fibre optique bureau',
        amount: '4500,00',
        currency: 'DZD',
        exchangeRate: '1',
        paymentMethod: 'especes',
        bankName: '',
        reference: 'FAC-AT-441',
        notes: '',
      },
    ],
  },
  cheques_recus: {
    type: 'cheques_recus',
    label: 'Chèques reçus',
    description: 'Importer des chèques reçus des clients (numéro conservé en texte avec zéros initiaux).',
    templateFileName: 'modele-import-cheques-recus.xlsx',
    fields: [
      { key: 'clientName', label: 'Client', required: true, aliases: ['client', 'nom client', 'emetteur'] },
      { key: 'issuerBank', label: 'Banque émettrice', required: true, aliases: ['banque', 'banque emettrice'] },
      { key: 'chequeNumber', label: 'N° Chèque', required: true, aliases: ['n° cheque', 'n cheque', 'numero cheque', 'cheque'], isTextProtected: true },
      { key: 'entryDate', label: 'Date d’entrée', required: true, aliases: ['date entree', 'date d entree', 'date reception', 'date'] },
      { key: 'chequeDate', label: 'Date du chèque', aliases: ['date cheque', 'date du cheque'] },
      { key: 'amount', label: 'Montant', required: true, aliases: ['montant', 'somme'] },
      { key: 'currency', label: 'Devise', aliases: ['devise'] },
      { key: 'exchangeRate', label: 'Taux de change', aliases: ['taux de change', 'taux'] },
      { key: 'invoiceNumber', label: 'N° Facture payée', aliases: ['n° facture', 'facture', 'facture payee'], isTextProtected: true },
      { key: 'status', label: 'Statut', aliases: ['statut', 'etat'] },
      { key: 'notes', label: 'Notes', aliases: ['notes'] },
    ],
    exampleRows: [
      {
        clientName: 'SARL Atlas Construction',
        issuerBank: 'BEA',
        chequeNumber: '0045123',
        entryDate: '2026-11-06',
        chequeDate: '2026-11-05',
        amount: '119000,00',
        currency: 'DZD',
        exchangeRate: '1',
        invoiceNumber: 'FAC-2026-0101',
        status: 'recu',
        notes: '',
      },
    ],
  },
  cheques_emis: {
    type: 'cheques_emis',
    label: 'Chèques émis',
    description: 'Importer des chèques émis (banque, numéro texte avec zéros, bénéficiaire, date de sortie, objet).',
    templateFileName: 'modele-import-cheques-emis.xlsx',
    fields: [
      { key: 'bankName', label: 'Banque', required: true, aliases: ['banque', 'compte bancaire', 'compte'] },
      { key: 'chequeNumber', label: 'N° Chèque', required: true, aliases: ['n° cheque', 'n cheque', 'numero cheque', 'cheque'], isTextProtected: true },
      { key: 'beneficiary', label: 'Bénéficiaire', required: true, aliases: ['beneficiaire', 'destinataire', 'ordre de'] },
      { key: 'issueDate', label: 'Date de sortie', required: true, aliases: ['date sortie', 'date de sortie', 'date emission', 'date'] },
      { key: 'amount', label: 'Montant', required: true, aliases: ['montant', 'somme'] },
      { key: 'currency', label: 'Devise', aliases: ['devise'] },
      { key: 'exchangeRate', label: 'Taux de change', aliases: ['taux de change', 'taux'] },
      { key: 'purpose', label: 'Objet / Motif', required: true, aliases: ['objet', 'motif', 'pour', 'description'] },
      { key: 'status', label: 'Statut', aliases: ['statut', 'etat'] },
      { key: 'notes', label: 'Notes', aliases: ['notes'] },
    ],
    exampleRows: [
      {
        bankName: 'BNA',
        chequeNumber: '0012399',
        beneficiary: 'EURL Équipements Pro',
        issueDate: '2026-11-08',
        amount: '59500,00',
        currency: 'DZD',
        exchangeRate: '1',
        purpose: 'Règlement outillage atelier',
        status: 'remis',
        notes: '',
      },
    ],
  },
};

export function downloadExcelImportTemplate(type: ExcelImportType): void {
  const schema = IMPORT_SCHEMAS[type];
  const headers = schema.fields.map((f) => f.label);
  const aoa: string[][] = [
    headers,
    ...schema.exampleRows.map((row) => schema.fields.map((f) => row[f.key] ?? '')),
  ];

  const ws = XLSX.utils.aoa_to_sheet(aoa);

  // Forcer format texte '@' sur les colonnes à zéros initiaux (N° chèque, téléphone, NIF...)
  const protectedCols = schema.fields
    .map((f, idx) => (f.isTextProtected ? idx : -1))
    .filter((i) => i >= 0);

  for (let r = 1; r <= schema.exampleRows.length + 25; r += 1) {
    for (const c of protectedCols) {
      const addr = XLSX.utils.encode_cell({ r, c });
      if (!ws[addr]) {
        ws[addr] = { t: 's', v: '', z: '@' };
      } else {
        ws[addr].t = 's';
        ws[addr].v = String(ws[addr].v ?? '');
        ws[addr].z = '@';
      }
    }
  }

  ws['!cols'] = headers.map((h) => ({ wch: Math.max(16, h.length + 5) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, schema.label.slice(0, 31));
  XLSX.writeFile(wb, schema.templateFileName);
}

export function normalizeHeaderText(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/%/g, ' % ')
    .replace(/[°º'’`"_.,/\\()\-:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function autoDetectColumnMapping(
  type: ExcelImportType,
  headers: string[]
): Record<string, string> {
  const schema = IMPORT_SCHEMAS[type];
  const mapping: Record<string, string> = {};
  const normalizedHeaders = headers.map((h) => ({
    raw: h,
    norm: normalizeHeaderText(h),
    noSpace: normalizeHeaderText(h).replace(/\s+/g, ''),
  }));
  const usedHeaders = new Set<string>();

  // Passe 1 : correspondances exactes prioritaires (en ignorant casse, accents, espaces, apostrophes)
  for (const field of schema.fields) {
    const labelNorm = normalizeHeaderText(field.label);
    const aliasNorms = [labelNorm, ...field.aliases.map(normalizeHeaderText)].filter(Boolean);
    const aliasNoSpaces = aliasNorms.map((a) => a.replace(/\s+/g, ''));

    const exact = normalizedHeaders.find(
      (h) =>
        !usedHeaders.has(h.raw) &&
        (aliasNorms.includes(h.norm) || aliasNoSpaces.includes(h.noSpace))
    );
    if (exact) {
      mapping[field.key] = exact.raw;
      usedHeaders.add(exact.raw);
    }
  }

  // Passe 2 : correspondances partielles pour les champs restants (mots >= 3 caractères uniquement)
  for (const field of schema.fields) {
    if (mapping[field.key]) continue;
    const labelNorm = normalizeHeaderText(field.label);
    const aliasNorms = [labelNorm, ...field.aliases.map(normalizeHeaderText)].filter(
      (a) => a.length >= 3
    );

    const partial = normalizedHeaders.find(
      (h) =>
        !usedHeaders.has(h.raw) &&
        h.norm.length >= 3 &&
        aliasNorms.some((a) => h.norm.includes(a) || a.includes(h.norm))
    );
    if (partial) {
      mapping[field.key] = partial.raw;
      usedHeaders.add(partial.raw);
    }
  }

  return mapping;
}

export function normalizeImportedDate(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;

  // ISO YYYY-MM-DD ou YYYY/MM/DD
  const iso = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (iso) {
    const year = iso[1];
    const month = iso[2].padStart(2, '0');
    const day = iso[3].padStart(2, '0');
    if (Number(month) >= 1 && Number(month) <= 12 && Number(day) >= 1 && Number(day) <= 31) {
      return `${year}-${month}-${day}`;
    }
  }

  // FR DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY ou année sur 2 chiffres DD/MM/YY
  const fr = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/);
  if (fr) {
    const day = fr[1].padStart(2, '0');
    const month = fr[2].padStart(2, '0');
    const year = fr[3].length === 2 ? `20${fr[3]}` : fr[3];
    const dNum = Number(day);
    const mNum = Number(month);
    if (mNum >= 1 && mNum <= 12 && dNum >= 1 && dNum <= 31) {
      return `${year}-${month}-${day}`;
    }
  }

  // Numéro de série Excel (jours depuis 1899-12-30)
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const serial = Math.floor(Number(s));
    if (serial > 20000 && serial < 80000) {
      const utc = new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
      if (!Number.isNaN(utc.getTime())) {
        return utc.toISOString().slice(0, 10);
      }
    }
  }

  return null;
}

export function normalizeChequeNumberValue(raw: string): string {
  return raw.trim();
}

export interface ParsedExcelSheet {
  headers: string[];
  rows: Array<Record<string, string>>;
  sheetName: string;
  sheetNames: string[];
}

function readCellTextOrIsoDate(cell: XLSX.CellObject | undefined): string {
  if (!cell || cell.v === undefined || cell.v === null) return '';

  // Date JS native (si cellDates)
  if (cell.t === 'd' && cell.v instanceof Date && !Number.isNaN(cell.v.getTime())) {
    const y = cell.v.getFullYear();
    const m = String(cell.v.getMonth() + 1).padStart(2, '0');
    const d = String(cell.v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  // Véritable date Excel numérique formatée en date (ex: serial 46254 avec format jj/mm/aaaa ou m/d/yy)
  if (cell.t === 'n' && typeof cell.v === 'number') {
    const fmt = typeof cell.z === 'string' ? cell.z : '';
    const isDateFmt = fmt ? XLSX.SSF.is_date(fmt) : false;
    if (isDateFmt && cell.v > 20000 && cell.v < 80000) {
      const p = XLSX.SSF.parse_date_code(cell.v);
      if (p && p.y >= 1990 && p.m >= 1 && p.m <= 12 && p.d >= 1 && p.d <= 31) {
        return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
      }
    }
  }

  // cell.w préserve le texte affiché exact (ex: zéros initiaux "0012345")
  return String(cell.w ?? cell.v ?? '').trim();
}

export async function parseExcelBuffer(
  buffer: ArrayBuffer,
  requestedSheetName?: string
): Promise<ParsedExcelSheet> {
  const wb = XLSX.read(buffer, { type: 'array', cellText: true, cellNF: true });
  if (wb.SheetNames.length === 0) {
    throw new Error('Le fichier Excel ne contient aucune feuille.');
  }
  const sheetName =
    requestedSheetName && wb.SheetNames.includes(requestedSheetName)
      ? requestedSheetName
      : wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  const ref = sheet['!ref'];
  if (!ref) {
    throw new Error(`La feuille Excel « ${sheetName} » est vide.`);
  }

  const range = XLSX.utils.decode_range(ref);

  // Détecter la ligne d'en-tête réelle (première ligne contenant au moins 2 cellules non vides)
  let headerRowIdx = range.s.r;
  for (let r = range.s.r; r <= Math.min(range.e.r, range.s.r + 15); r += 1) {
    let nonEmpty = 0;
    for (let c = range.s.c; c <= range.e.c; c += 1) {
      const addr = XLSX.utils.encode_cell({ r, c });
      if (readCellTextOrIsoDate(sheet[addr] as XLSX.CellObject | undefined)) {
        nonEmpty += 1;
      }
    }
    if (nonEmpty >= 2) {
      headerRowIdx = r;
      break;
    }
  }

  // Conserver uniquement les colonnes ayant un en-tête ou des données en dessous
  const activeCols: number[] = [];
  for (let c = range.s.c; c <= range.e.c; c += 1) {
    let colHasContent = false;
    for (let r = headerRowIdx; r <= range.e.r; r += 1) {
      const addr = XLSX.utils.encode_cell({ r, c });
      if (readCellTextOrIsoDate(sheet[addr] as XLSX.CellObject | undefined)) {
        colHasContent = true;
        break;
      }
    }
    if (colHasContent) activeCols.push(c);
  }

  const headers: string[] = [];
  const colToHeader = new Map<number, string>();
  const seenHeaders = new Set<string>();
  for (const c of activeCols) {
    const addr = XLSX.utils.encode_cell({ r: headerRowIdx, c });
    const cell = sheet[addr] as XLSX.CellObject | undefined;
    const baseHeader = readCellTextOrIsoDate(cell) || `Colonne ${c + 1}`;
    let h = baseHeader;
    let suffix = 2;
    while (seenHeaders.has(h)) {
      h = `${baseHeader} (${suffix})`;
      suffix += 1;
    }
    seenHeaders.add(h);
    headers.push(h);
    colToHeader.set(c, h);
  }

  // Les lignes de données commencent sur la ligne APRÈS la ligne d'en-tête ; ignorer les lignes vides
  const rows: Array<Record<string, string>> = [];
  for (let r = headerRowIdx + 1; r <= range.e.r; r += 1) {
    const rowObj: Record<string, string> = {};
    let hasValue = false;
    for (const c of activeCols) {
      const header = colToHeader.get(c)!;
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = sheet[addr] as XLSX.CellObject | undefined;
      const val = readCellTextOrIsoDate(cell);
      if (val) hasValue = true;
      rowObj[header] = val;
    }
    if (hasValue) rows.push(rowObj);
  }

  if (rows.length === 0) {
    throw new Error(`Aucune ligne de données trouvée sous la ligne d’en-tête dans « ${sheetName} ».`);
  }

  return { headers, rows, sheetName, sheetNames: wb.SheetNames };
}

export interface ValidatedImportRow {
  rowIndex: number; // Ligne Excel 1-indexed (2 = première ligne sous en-tête)
  status: 'valide' | 'doublon' | 'erreur';
  message: string;
  raw: Record<string, string>;
  mapped: Record<string, string>;
}

export interface ValidationContext {
  contacts: Contact[];
  customerInvoices: CustomerInvoice[];
  supplierInvoices: SupplierInvoice[];
  expenses: Expense[];
  incomingCheques: IncomingCheque[];
  outgoingCheques: OutgoingCheque[];
  chequeLeafKeys: Set<string>; // `${bankAccountId}::${chequeNumber}`
  bankAccounts: Array<{ id: string; bankName: string; accountName: string }>;
  defaultTvaRate: number;
  defaultCurrency: string;
}

export interface ResolvedInvoiceRowAmount {
  valid: boolean;
  error?: string;
  quantity: number;
  unit?: string;
  unitPriceCentimes: number;
  htCentimes: number;
  tvaRate: number;
  manualTotalLocked: boolean;
}

export function resolveInvoiceRowAmounts(
  m: Record<string, string>,
  defaultTvaRate: number
): ResolvedInvoiceRowAmount {
  const tvaRateRaw = m.tvaRate ? Number(m.tvaRate.replace(',', '.').replace('%', '').trim()) : defaultTvaRate;
  const tvaRate =
    Number.isFinite(tvaRateRaw) && tvaRateRaw >= 0 && tvaRateRaw <= 100
      ? tvaRateRaw
      : defaultTvaRate;

  let quantity = 1;
  if (m.quantity) {
    const q = Number(m.quantity.replace(/\s+/g, '').replace(',', '.'));
    if (!Number.isFinite(q) || q <= 0) {
      return {
        valid: false,
        error: `Quantité invalide (« ${m.quantity} »).`,
        quantity: 1,
        unitPriceCentimes: 0,
        htCentimes: 0,
        tvaRate,
        manualTotalLocked: false,
      };
    }
    quantity = q;
  }

  const unit = m.unit?.trim() || undefined;
  const hasPu = Boolean(m.unitPrice);
  const puCentimes = hasPu ? parseMoneyInputToCentimes(m.unitPrice) : 0;
  if (hasPu && (Number.isNaN(puCentimes) || puCentimes <= 0)) {
    return {
      valid: false,
      error: `Prix unitaire invalide (« ${m.unitPrice} »).`,
      quantity,
      unit,
      unitPriceCentimes: 0,
      htCentimes: 0,
      tvaRate,
      manualTotalLocked: false,
    };
  }

  const hasHt = Boolean(m.htAmount);
  const htRawCentimes = hasHt ? parseMoneyInputToCentimes(m.htAmount) : 0;
  if (hasHt && (Number.isNaN(htRawCentimes) || htRawCentimes <= 0)) {
    return {
      valid: false,
      error: `Montant HT invalide (« ${m.htAmount} »).`,
      quantity,
      unit,
      unitPriceCentimes: 0,
      htCentimes: 0,
      tvaRate,
      manualTotalLocked: false,
    };
  }

  const hasTtc = Boolean(m.ttcAmount);
  const ttcRawCentimes = hasTtc ? parseMoneyInputToCentimes(m.ttcAmount) : 0;
  if (hasTtc && (Number.isNaN(ttcRawCentimes) || ttcRawCentimes <= 0)) {
    return {
      valid: false,
      error: `Montant TTC invalide (« ${m.ttcAmount} »).`,
      quantity,
      unit,
      unitPriceCentimes: 0,
      htCentimes: 0,
      tvaRate,
      manualTotalLocked: false,
    };
  }

  if (hasHt && htRawCentimes > 0) {
    const unitPriceCentimes =
      hasPu && puCentimes > 0
        ? puCentimes
        : Math.round(htRawCentimes / quantity);
    const theoretical = Math.round(quantity * unitPriceCentimes);
    const manualTotalLocked = theoretical !== htRawCentimes;
    return {
      valid: true,
      quantity,
      unit,
      unitPriceCentimes,
      htCentimes: htRawCentimes,
      tvaRate,
      manualTotalLocked,
    };
  }

  if (hasPu && puCentimes > 0) {
    const computedHt = Math.round(quantity * puCentimes);
    return {
      valid: true,
      quantity,
      unit,
      unitPriceCentimes: puCentimes,
      htCentimes: computedHt,
      tvaRate,
      manualTotalLocked: false,
    };
  }

  if (hasTtc && ttcRawCentimes > 0) {
    const tvaParsed = m.tvaAmount ? parseMoneyInputToCentimes(m.tvaAmount) : NaN;
    const computedHt =
      !Number.isNaN(tvaParsed) && tvaParsed >= 0 && tvaParsed < ttcRawCentimes
        ? ttcRawCentimes - tvaParsed
        : Math.round(ttcRawCentimes / (1 + tvaRate / 100));
    const unitPriceCentimes = Math.round(computedHt / quantity);
    const theoretical = Math.round(quantity * unitPriceCentimes);
    return {
      valid: true,
      quantity,
      unit,
      unitPriceCentimes,
      htCentimes: computedHt,
      tvaRate,
      manualTotalLocked: theoretical !== computedHt,
    };
  }

  return {
    valid: false,
    error: 'Indiquez le Montant HT, le couple (Qté × Prix unitaire HT) ou le Montant TTC.',
    quantity,
    unit,
    unitPriceCentimes: 0,
    htCentimes: 0,
    tvaRate,
    manualTotalLocked: false,
  };
}

export function validateImportRows(params: {
  type: ExcelImportType;
  rows: Array<Record<string, string>>;
  mapping: Record<string, string>;
  ctx: ValidationContext;
  options?: {
    groupInvoicesByNumber?: boolean;
  };
}): ValidatedImportRow[] {
  const { type, rows, mapping, ctx, options } = params;
  const groupInvoicesByNumber = options?.groupInvoicesByNumber ?? true;
  const schema = IMPORT_SCHEMAS[type];

  const getMapped = (raw: Record<string, string>): Record<string, string> => {
    const res: Record<string, string> = {};
    for (const f of schema.fields) {
      const col = mapping[f.key];
      res[f.key] = col ? String(raw[col] ?? '').trim() : '';
    }
    return res;
  };

  // Ensembles de déduplication (base existante + lignes déjà vues dans le fichier)
  const existingContacts = new Set(
    ctx.contacts.filter((c) => !c.deletedAt).map((c) => normalizeHeaderText(`${c.company}|${c.name}`))
  );
  const existingClientInvNums = new Set(
    ctx.customerInvoices
      .filter((i) => !i.deletedAt)
      .map((i) => i.invoiceNumber.trim().toLowerCase())
  );
  const existingSupplierInvNums = new Set(
    ctx.supplierInvoices
      .filter((i) => !i.deletedAt)
      .map((i) => i.invoiceNumber.trim().toLowerCase())
  );
  const existingExpenseKeys = new Set(
    ctx.expenses
      .filter((e) => e.status === 'valide' && !e.deletedAt)
      .map((e) => `${e.date}|${normalizeHeaderText(e.beneficiary)}|${e.amountCentimes}|${normalizeHeaderText(e.description)}`)
  );
  const existingIncomingChequeKeys = new Set(
    ctx.incomingCheques
      .filter((c) => !c.deletedAt)
      .map((c) => `${normalizeHeaderText(c.issuerBank)}|${c.chequeNumber.trim()}`)
  );
  const existingOutgoingChequeKeys = new Set<string>([
    ...ctx.chequeLeafKeys,
    ...ctx.outgoingCheques
      .filter((c) => !c.deletedAt)
      .map((c) => `${c.bankAccountId}::${c.chequeNumber.trim()}`),
  ]);

  const seenBatch = new Set<string>();
  const batchFirstClientInvoice = new Map<string, Record<string, string>>();
  const results: ValidatedImportRow[] = [];

  rows.forEach((raw, idx) => {
    const rowIndex = idx + 2;
    const m = getMapped(raw);

    // Héritage des champs d'en-tête si regroupement de lignes d'une même facture client
    let isGroupedContinuation = false;
    if (type === 'factures_clients' && groupInvoicesByNumber && m.invoiceNumber) {
      const numKey = m.invoiceNumber.trim().toLowerCase();
      const firstRow = batchFirstClientInvoice.get(numKey);
      if (firstRow) {
        isGroupedContinuation = true;
        if (!m.clientName) m.clientName = firstRow.clientName;
        if (!m.issueDate) m.issueDate = firstRow.issueDate;
        if (!m.dueDate) m.dueDate = firstRow.dueDate;
        if (!m.bcNumber) m.bcNumber = firstRow.bcNumber;
        if (!m.campaignRef) m.campaignRef = firstRow.campaignRef;
        if (!m.campaignStartDate) m.campaignStartDate = firstRow.campaignStartDate;
        if (!m.campaignEndDate) m.campaignEndDate = firstRow.campaignEndDate;
        if (!m.currency) m.currency = firstRow.currency;
        if (!m.exchangeRate) m.exchangeRate = firstRow.exchangeRate;
        if (!m.status) m.status = firstRow.status;
      }
    }

    // 1. Champs obligatoires (diagnostic détaillé en français)
    const missingDetails = schema.fields
      .filter((f) => f.required && !m[f.key])
      .map((f) => {
        const mappedCol = mapping[f.key];
        return mappedCol
          ? `${f.label} (cellule vide dans colonne « ${mappedCol} »)`
          : `${f.label} (colonne non trouvée / non associée)`;
      });
    if (missingDetails.length > 0) {
      results.push({
        rowIndex,
        status: 'erreur',
        message: `Champ(s) obligatoire(s) manquant(s) : ${missingDetails.join(', ')}.`,
        raw,
        mapped: m,
      });
      return;
    }

    if (type === 'clients' || type === 'fournisseurs') {
      const key = normalizeHeaderText(`${m.company}|${m.name}`);
      if (existingContacts.has(key) || seenBatch.has(key)) {
        results.push({
          rowIndex,
          status: 'doublon',
          message: `Contact déjà existant (${m.company || m.name}).`,
          raw,
          mapped: m,
        });
        return;
      }
      seenBatch.add(key);
      results.push({ rowIndex, status: 'valide', message: 'Prêt à importer', raw, mapped: m });
      return;
    }

    if (type === 'factures_clients' || type === 'factures_fournisseurs') {
      const dateIso = normalizeImportedDate(m.issueDate);
      if (!dateIso) {
        results.push({
          rowIndex,
          status: 'erreur',
          message: `Date invalide (« ${m.issueDate} »). Utilisez AAAA-MM-JJ ou JJ/MM/AAAA.`,
          raw,
          mapped: m,
        });
        return;
      }
      if (m.dueDate && !normalizeImportedDate(m.dueDate)) {
        results.push({
          rowIndex,
          status: 'erreur',
          message: `Date d’échéance invalide (« ${m.dueDate} »).`,
          raw,
          mapped: m,
        });
        return;
      }
      if (type === 'factures_clients') {
        if (m.campaignStartDate && !normalizeImportedDate(m.campaignStartDate)) {
          results.push({
            rowIndex,
            status: 'erreur',
            message: `Date début campagne invalide (« ${m.campaignStartDate} »).`,
            raw,
            mapped: m,
          });
          return;
        }
        if (m.campaignEndDate && !normalizeImportedDate(m.campaignEndDate)) {
          results.push({
            rowIndex,
            status: 'erreur',
            message: `Date fin campagne invalide (« ${m.campaignEndDate} »).`,
            raw,
            mapped: m,
          });
          return;
        }
      }

      const resolved = resolveInvoiceRowAmounts(m, ctx.defaultTvaRate);
      if (!resolved.valid) {
        results.push({
          rowIndex,
          status: 'erreur',
          message: resolved.error || 'Montant invalide.',
          raw,
          mapped: m,
        });
        return;
      }

      const numKey = m.invoiceNumber.trim().toLowerCase();
      const targetSet = type === 'factures_clients' ? existingClientInvNums : existingSupplierInvNums;

      if (type === 'factures_clients' && groupInvoicesByNumber) {
        if (targetSet.has(numKey)) {
          results.push({
            rowIndex,
            status: 'doublon',
            message: `Facture N° ${m.invoiceNumber} déjà présente dans la base.`,
            raw,
            mapped: m,
          });
          return;
        }
        if (!batchFirstClientInvoice.has(numKey)) {
          batchFirstClientInvoice.set(numKey, { ...m });
          results.push({ rowIndex, status: 'valide', message: 'Prêt à importer', raw, mapped: m });
        } else {
          results.push({
            rowIndex,
            status: 'valide',
            message: `Ligne regroupée sur la facture ${m.invoiceNumber}`,
            raw,
            mapped: m,
          });
        }
        return;
      }

      if (targetSet.has(numKey) || seenBatch.has(numKey)) {
        results.push({
          rowIndex,
          status: 'doublon',
          message: `Numéro de facture déjà existant (${m.invoiceNumber}).`,
          raw,
          mapped: m,
        });
        return;
      }
      seenBatch.add(numKey);
      results.push({ rowIndex, status: 'valide', message: 'Prêt à importer', raw, mapped: m });
      return;
    }

    if (type === 'depenses') {
      const dateIso = normalizeImportedDate(m.date);
      if (!dateIso) {
        results.push({
          rowIndex,
          status: 'erreur',
          message: `Date invalide (« ${m.date} »).`,
          raw,
          mapped: m,
        });
        return;
      }
      const amt = parseMoneyInputToCentimes(m.amount);
      if (Number.isNaN(amt) || amt <= 0) {
        results.push({
          rowIndex,
          status: 'erreur',
          message: `Montant invalide (« ${m.amount} »).`,
          raw,
          mapped: m,
        });
        return;
      }
      const key = `${dateIso}|${normalizeHeaderText(m.beneficiary)}|${amt}|${normalizeHeaderText(m.description)}`;
      if (existingExpenseKeys.has(key) || seenBatch.has(key)) {
        results.push({
          rowIndex,
          status: 'doublon',
          message: 'Dépense identique déjà enregistrée.',
          raw,
          mapped: m,
        });
        return;
      }
      seenBatch.add(key);
      results.push({ rowIndex, status: 'valide', message: 'Prêt à importer', raw, mapped: m });
      return;
    }

    if (type === 'cheques_recus') {
      const entryIso = normalizeImportedDate(m.entryDate);
      if (!entryIso) {
        results.push({
          rowIndex,
          status: 'erreur',
          message: `Date d’entrée invalide (« ${m.entryDate} »).`,
          raw,
          mapped: m,
        });
        return;
      }
      const chqIso = m.chequeDate ? normalizeImportedDate(m.chequeDate) : entryIso;
      if (!chqIso) {
        results.push({
          rowIndex,
          status: 'erreur',
          message: `Date du chèque invalide (« ${m.chequeDate} »).`,
          raw,
          mapped: m,
        });
        return;
      }
      const amt = parseMoneyInputToCentimes(m.amount);
      if (Number.isNaN(amt) || amt <= 0) {
        results.push({
          rowIndex,
          status: 'erreur',
          message: `Montant invalide (« ${m.amount} »).`,
          raw,
          mapped: m,
        });
        return;
      }
      const chqNum = normalizeChequeNumberValue(m.chequeNumber);
      const key = `${normalizeHeaderText(m.issuerBank)}|${chqNum}`;
      if (existingIncomingChequeKeys.has(key) || seenBatch.has(key)) {
        results.push({
          rowIndex,
          status: 'doublon',
          message: `Chèque reçu N° ${chqNum} (${m.issuerBank}) déjà enregistré.`,
          raw,
          mapped: m,
        });
        return;
      }
      seenBatch.add(key);
      results.push({ rowIndex, status: 'valide', message: 'Prêt à importer', raw, mapped: m });
      return;
    }

    if (type === 'cheques_emis') {
      const issueIso = normalizeImportedDate(m.issueDate);
      if (!issueIso) {
        results.push({
          rowIndex,
          status: 'erreur',
          message: `Date de sortie invalide (« ${m.issueDate} »).`,
          raw,
          mapped: m,
        });
        return;
      }
      const amt = parseMoneyInputToCentimes(m.amount);
      if (Number.isNaN(amt) || amt <= 0) {
        results.push({
          rowIndex,
          status: 'erreur',
          message: `Montant invalide (« ${m.amount} »).`,
          raw,
          mapped: m,
        });
        return;
      }
      const bankNorm = normalizeHeaderText(m.bankName);
      const matchedBank = ctx.bankAccounts.find(
        (b) =>
          normalizeHeaderText(b.bankName) === bankNorm ||
          normalizeHeaderText(b.accountName) === bankNorm ||
          normalizeHeaderText(`${b.bankName} ${b.accountName}`).includes(bankNorm)
      );
      if (!matchedBank) {
        results.push({
          rowIndex,
          status: 'erreur',
          message: `Banque introuvable (« ${m.bankName} »). Créez d’abord ce compte dans Banques & comptes.`,
          raw,
          mapped: m,
        });
        return;
      }

      const chqNum = normalizeChequeNumberValue(m.chequeNumber);
      const dupKey = `${matchedBank.id}::${chqNum}`;
      if (existingOutgoingChequeKeys.has(dupKey) || seenBatch.has(dupKey)) {
        results.push({
          rowIndex,
          status: 'doublon',
          message: `N° de chèque ${chqNum} déjà existant ou réservé sur ${matchedBank.bankName} (jamais réutilisable).`,
          raw,
          mapped: m,
        });
        return;
      }
      seenBatch.add(dupKey);
      results.push({ rowIndex, status: 'valide', message: 'Prêt à importer', raw, mapped: m });
    }
  });

  return results;
}

export function downloadImportErrorsExcel(rows: ValidatedImportRow[], type: ExcelImportType): void {
  const schema = IMPORT_SCHEMAS[type];
  const problemRows = rows.filter((r) => r.status !== 'valide');
  const missingColumnsHint = schema.fields
    .filter((f) => f.required)
    .map((f) => f.label)
    .join(', ');
  const headers = [
    'Ligne Excel',
    'Statut',
    'Explication détaillée (en français)',
    'Colonnes obligatoires attendues',
    ...schema.fields.map((f) => f.label),
  ];
  const aoa: Array<Array<string | number>> = [
    headers,
    ...problemRows.map((r) => [
      r.rowIndex,
      r.status === 'doublon' ? 'Doublon' : 'Erreur',
      r.message,
      missingColumnsHint,
      ...schema.fields.map((f) => r.mapped[f.key] ?? ''),
    ]),
  ];

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = headers.map((h) => ({ wch: Math.max(18, h.length + 4) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Erreurs import');
  XLSX.writeFile(wb, `erreurs-import-${type}.xlsx`);
}

function parsePaymentMethod(raw: string): PaymentMethod {
  const n = normalizeHeaderText(raw);
  if (n.includes('cheque')) return 'cheque';
  if (n.includes('virement')) return 'virement';
  if (n.includes('carte')) return 'carte';
  return 'especes';
}

function parseIncomingStatus(raw: string): IncomingChequeStatus {
  const n = normalizeHeaderText(raw);
  if (n.includes('encaisse')) return 'encaisse';
  if (n.includes('depose')) return 'depose';
  if (n.includes('attente')) return 'en_attente';
  if (n.includes('rejet')) return 'rejete';
  if (n.includes('annul')) return 'annule';
  return 'recu';
}

function parseOutgoingStatus(raw: string): OutgoingChequeStatus {
  const n = normalizeHeaderText(raw);
  if (n.includes('encaisse')) return 'encaisse';
  if (n.includes('depose')) return 'depose';
  if (n.includes('attente')) return 'en_attente';
  if (n.includes('prepare')) return 'prepare';
  if (n.includes('rejet')) return 'rejete';
  if (n.includes('annul')) return 'annule';
  return 'remis';
}

function isPaidStatusText(raw: string): boolean {
  const n = normalizeHeaderText(raw);
  if (!n) return false;
  if (n.includes('impay')) return false;
  return (
    n === 'payee' ||
    n === 'paye' ||
    n === 'reglee' ||
    n === 'regle' ||
    n === 'soldee' ||
    n === 'oui' ||
    n === 'paid'
  );
}

export async function executeValidatedImport(params: {
  type: ExcelImportType;
  validRows: ValidatedImportRow[];
  settings: CompanySettings;
  companyProfileId?: string;
  fileName?: string;
  groupByInvoiceNumber?: boolean;
  createMissingCampaigns?: boolean;
  createPaymentsForPaidRows?: boolean;
}): Promise<{
  importedCount: number;
  invoicesCreatedCount?: number;
  campaignsCreatedCount?: number;
  paymentsCreatedCount?: number;
}> {
  const {
    type,
    validRows,
    settings,
    companyProfileId,
    fileName,
    groupByInvoiceNumber = true,
    createMissingCampaigns = true,
    createPaymentsForPaidRows = false,
  } = params;
  if (validRows.length === 0) {
    throw new Error('Aucune ligne valide à importer.');
  }

  const now = new Date().toISOString();
  let invoicesCreatedCount = 0;
  let campaignsCreatedCount = 0;
  let paymentsCreatedCount = 0;

  await db.transaction(
    'rw',
    [
      db.contacts,
      db.customerInvoices,
      db.supplierInvoices,
      db.campaigns,
      db.purchaseOrders,
      db.payments,
      db.paymentAllocations,
      db.expenses,
      db.expenseCategories,
      db.incomingCheques,
      db.outgoingCheques,
      db.bankAccounts,
      db.ledgerEntries,
      db.companyProfiles,
    ],
    async () => {
      const contacts = (await db.contacts.toArray()).filter((c) => !c.deletedAt);
      const bankAccounts = (await db.bankAccounts.toArray()).filter((b) => !b.deletedAt);
      const categories = await db.expenseCategories.toArray();
      const customerInvoices = (await db.customerInvoices.toArray()).filter((i) => !i.deletedAt);
      const campaigns = (await db.campaigns.toArray()).filter((c) => !c.deletedAt);
      const purchaseOrders = (await db.purchaseOrders.toArray()).filter((p) => !p.deletedAt);
      const companyProfiles = (await db.companyProfiles.toArray()).filter((p) => !p.deletedAt);
      const effectiveProfileId =
        companyProfileId ||
        settings.activeCompanyProfileId ||
        companyProfiles.find((p) => p.isDefault)?.id ||
        companyProfiles[0]?.id;
      const effectiveProfile = companyProfiles.find((p) => p.id === effectiveProfileId);
      const issuerSnapshot = buildIssuerSnapshot(effectiveProfile);

      const findOrCreateContact = async (
        label: string,
        role: 'client' | 'fournisseur',
        extras?: { nif?: string; address?: string }
      ): Promise<Contact> => {
        const norm = normalizeHeaderText(label);
        const found = contacts.find(
          (c) =>
            normalizeHeaderText(c.company) === norm ||
            normalizeHeaderText(c.name) === norm
        );
        if (found) return found;

        const created: Contact = {
          id: createId('cnt'),
          type: role,
          name: label.trim(),
          company: label.trim(),
          address: extras?.address?.trim() || '',
          phone: '',
          email: '',
          nif: extras?.nif?.trim() || '',
          nis: '',
          rc: '',
          ai: '',
          notes: 'Créé automatiquement lors d’un import Excel',
          archived: false,
          createdAt: now,
          updatedAt: now,
        };
        await db.contacts.put(created);
        contacts.push(created);
        return created;
      };

      const findBank = (rawName: string): string | null => {
        if (!rawName.trim()) return null;
        const norm = normalizeHeaderText(rawName);
        const b = bankAccounts.find(
          (x) =>
            normalizeHeaderText(x.bankName) === norm ||
            normalizeHeaderText(x.accountName) === norm ||
            normalizeHeaderText(`${x.bankName} ${x.accountName}`).includes(norm)
        );
        return b ? b.id : null;
      };

      if (type === 'clients' || type === 'fournisseurs') {
        const records: Contact[] = validRows.map((r) => ({
          id: createId('cnt'),
          type: type === 'clients' ? 'client' : 'fournisseur',
          name: r.mapped.name,
          company: r.mapped.company,
          address: r.mapped.address,
          phone: r.mapped.phone,
          email: r.mapped.email,
          nif: r.mapped.nif,
          nis: r.mapped.nis,
          rc: r.mapped.rc,
          ai: r.mapped.ai,
          notes: r.mapped.notes,
          archived: false,
          createdAt: now,
          updatedAt: now,
        }));
        await db.contacts.bulkPut(records);
      } else if (type === 'factures_clients') {
        const groups = new Map<string, ValidatedImportRow[]>();
        validRows.forEach((r, idx) => {
          const key = groupByInvoiceNumber
            ? r.mapped.invoiceNumber.trim().toLowerCase()
            : `${r.mapped.invoiceNumber.trim().toLowerCase()}__row_${idx}`;
          const arr = groups.get(key) || [];
          arr.push(r);
          groups.set(key, arr);
        });

        const invs: CustomerInvoice[] = [];
        const autoPayments: Payment[] = [];
        const autoAllocations: PaymentAllocation[] = [];
        const autoLedger: LedgerEntry[] = [];
        const touchedBcIds = new Set<string>();

        for (const groupRows of groups.values()) {
          const head = groupRows[0].mapped;
          const firstNonEmpty = (key: string): string => {
            for (const row of groupRows) {
              if (row.mapped[key]?.trim()) return row.mapped[key].trim();
            }
            return '';
          };

          const invoiceNumber = head.invoiceNumber.trim();
          const clientName = firstNonEmpty('clientName');
          const clientNif = firstNonEmpty('clientNif');
          const clientAddress = firstNonEmpty('clientAddress');
          const client = await findOrCreateContact(clientName, 'client', {
            nif: clientNif,
            address: clientAddress,
          });
          const clientSnapshot: ClientFiscalSnapshot = {
            name: client.name,
            company: client.company,
            address: client.address,
            nif: client.nif,
            nis: client.nis,
            rc: client.rc,
            ai: client.ai,
          };

          const issueDate = normalizeImportedDate(firstNonEmpty('issueDate'))!;
          const dueRaw = firstNonEmpty('dueDate');
          const dueDate = dueRaw ? normalizeImportedDate(dueRaw) || issueDate : issueDate;
          const bcNumber = firstNonEmpty('bcNumber');
          const campaignRef = firstNonEmpty('campaignRef');
          const rawStart = firstNonEmpty('campaignStartDate');
          const rawEnd = firstNonEmpty('campaignEndDate');
          let campaignStartDate = rawStart ? normalizeImportedDate(rawStart) || undefined : undefined;
          let campaignEndDate = rawEnd ? normalizeImportedDate(rawEnd) || undefined : undefined;

          let campaignId: string | undefined;
          if (campaignRef) {
            const normCamp = normalizeHeaderText(campaignRef);
            let matchedCamp = campaigns.find(
              (c) => c.clientId === client.id && normalizeHeaderText(c.name) === normCamp
            );
            if (!matchedCamp && createMissingCampaigns) {
              const sDate = campaignStartDate || '';
              const eDate =
                campaignEndDate && (!sDate || campaignEndDate >= sDate) ? campaignEndDate : '';
              const createdCamp: Campaign = {
                id: createId('cmp'),
                name: campaignRef,
                clientId: client.id,
                startDate: sDate,
                endDate: eDate,
                status: sDate && eDate ? suggestCampaignStatus(sDate, eDate) : 'en_cours',
                notes: `Créée lors de l’import Excel (${invoiceNumber})`,
                createdAt: now,
                updatedAt: now,
              };
              await db.campaigns.put(createdCamp);
              campaigns.push(createdCamp);
              campaignsCreatedCount += 1;
              matchedCamp = createdCamp;
            }
            if (matchedCamp) {
              campaignId = matchedCamp.id;
              if (!campaignStartDate) campaignStartDate = matchedCamp.startDate;
              if (!campaignEndDate) campaignEndDate = matchedCamp.endDate;
            }
          }

          let linkedBcRecuId: string | undefined;
          if (bcNumber) {
            const normBc = normalizeHeaderText(bcNumber);
            const matchedBc = purchaseOrders.find(
              (p) => p.direction === 'bc_recu' && normalizeHeaderText(p.poNumber) === normBc
            );
            if (matchedBc) {
              linkedBcRecuId = matchedBc.id;
              touchedBcIds.add(matchedBc.id);
            }
          }

          const rawLines = groupRows.map((row, lineIdx) => {
            const rm = row.mapped;
            const resolved = resolveInvoiceRowAmounts(rm, settings.defaultTvaRate);
            return {
              id: createId('line'),
              description:
                rm.description ||
                (groupRows.length > 1
                  ? `${invoiceNumber} — Ligne ${lineIdx + 1}`
                  : `Facture ${invoiceNumber}`),
              quantity: resolved.quantity,
              unit: resolved.unit,
              unitPriceCentimes: resolved.unitPriceCentimes,
              discountPercent: 0,
              tvaRate: resolved.tvaRate,
              manualTotalLocked: resolved.manualTotalLocked,
              htCentimes: resolved.htCentimes,
              lineMode: 'libre' as const,
            };
          });

          const calc = computeInvoiceDocumentTotals(rawLines);
          const currency = (firstNonEmpty('currency') || settings.defaultCurrency || 'DZD').toUpperCase();
          const exStr = firstNonEmpty('exchangeRate');
          const exRateRaw = exStr ? Number(exStr.replace(',', '.')) : 1;
          const exchangeRate = currency === 'DZD' ? 1 : Math.max(0.0001, exRateRaw || 1);
          const baseDzdTtcCentimes = convertToBaseDzd(calc.totalTtcCentimes, exchangeRate);

          const statusRaw = firstNonEmpty('status');
          const markAsPaid = createPaymentsForPaidRows && isPaidStatusText(statusRaw);
          const invoiceId = createId('cinv');
          const combinedDesc =
            firstNonEmpty('description') || `Import Excel (${invoiceNumber})`;
          const notes = groupRows
            .map((r) => r.mapped.notes.trim())
            .filter(Boolean)
            .join(' · ');

          const invRecord: CustomerInvoice = {
            id: invoiceId,
            invoiceNumber,
            companyProfileId: effectiveProfileId,
            issuerSnapshot,
            clientId: client.id,
            clientSnapshot,
            issueDate,
            dueDate,
            bcNumber,
            linkedBcRecuId,
            campaignId,
            campaignRef,
            campaignStartDate,
            campaignEndDate,
            showCampaignOnPrint: Boolean(campaignRef),
            currency,
            exchangeRate,
            description: combinedDesc,
            lines: calc.lines,
            totalHtCentimes: calc.totalHtCentimes,
            totalTvaCentimes: calc.totalTvaCentimes,
            totalTtcCentimes: calc.totalTtcCentimes,
            baseDzdTtcCentimes,
            status: markAsPaid ? 'payee' : 'impayee',
            isImported: true,
            importedFromFile: fileName || 'Import Excel',
            notes,
            createdAt: now,
            updatedAt: now,
          };
          invs.push(invRecord);
          customerInvoices.push(invRecord);
          invoicesCreatedCount += 1;

          if (markAsPaid && calc.totalTtcCentimes > 0) {
            const paymentId = createId('pay');
            const targetBankId = bankAccounts[0]?.id ?? null;
            autoPayments.push({
              id: paymentId,
              direction: 'entrant',
              contactId: client.id,
              date: issueDate,
              amountCentimes: calc.totalTtcCentimes,
              currency,
              exchangeRate,
              baseDzdAmountCentimes: baseDzdTtcCentimes,
              method: targetBankId ? 'virement' : 'especes',
              bankAccountId: targetBankId,
              reference: `Import ${invoiceNumber}`,
              notes: `Règlement automatique lors de l’import de ${invoiceNumber}`,
              isAdvance: false,
              status: 'valide',
              createdAt: now,
              updatedAt: now,
            });
            autoAllocations.push({
              id: createId('alloc'),
              paymentId,
              invoiceType: 'client',
              invoiceId,
              amountCentimes: calc.totalTtcCentimes,
              createdAt: now,
            });
            autoLedger.push({
              id: createId('led'),
              date: issueDate,
              direction: 'entree',
              sourceType: 'paiement_client',
              sourceId: paymentId,
              bankAccountId: targetBankId,
              contactId: client.id,
              label: `Encaissement importé ${invoiceNumber} — ${client.company || client.name}`,
              amountCentimes: calc.totalTtcCentimes,
              currency,
              exchangeRate,
              baseDzdAmountCentimes: baseDzdTtcCentimes,
              status: 'valide',
              createdAt: now,
            });
            paymentsCreatedCount += 1;
          }
        }

        await db.customerInvoices.bulkPut(invs);
        if (autoPayments.length) await db.payments.bulkPut(autoPayments);
        if (autoAllocations.length) await db.paymentAllocations.bulkPut(autoAllocations);
        if (autoLedger.length) await db.ledgerEntries.bulkPut(autoLedger);

        // Mettre à jour les BC reçus liés
        for (const bcId of touchedBcIds) {
          const bc = purchaseOrders.find((p) => p.id === bcId);
          if (!bc) continue;
          const linkedInvs = customerInvoices.filter((i) => i.linkedBcRecuId === bcId && !i.deletedAt);
          const nextIds = Array.from(new Set(linkedInvs.map((i) => i.id)));
          const nextStatus = computeBcRecuInvoicingStatus({
            bc,
            linkedInvoices: linkedInvs,
          });
          await db.purchaseOrders.update(bcId, {
            linkedInvoiceIds: nextIds,
            status: nextStatus,
            updatedAt: now,
          } as Partial<PurchaseOrder>);
        }
      } else if (type === 'factures_fournisseurs') {
        const invs: SupplierInvoice[] = [];
        for (const r of validRows) {
          const m = r.mapped;
          const supplier = await findOrCreateContact(m.supplierName, 'fournisseur');
          const supplierId = supplier.id;
          const issueDate = normalizeImportedDate(m.issueDate)!;
          const dueDate = m.dueDate ? normalizeImportedDate(m.dueDate) || issueDate : issueDate;
          const resolved = resolveInvoiceRowAmounts(m, settings.defaultTvaRate);
          const calc = computeInvoiceDocumentTotals([
            {
              id: createId('line'),
              description: m.description || `Facture ${m.invoiceNumber}`,
              quantity: resolved.quantity,
              unit: resolved.unit,
              unitPriceCentimes: resolved.unitPriceCentimes,
              discountPercent: 0,
              tvaRate: resolved.tvaRate,
              manualTotalLocked: resolved.manualTotalLocked,
              htCentimes: resolved.htCentimes,
            },
          ]);
          const currency = (m.currency || settings.defaultCurrency || 'DZD').toUpperCase();
          const exRateRaw = m.exchangeRate ? Number(m.exchangeRate.replace(',', '.')) : 1;
          const exchangeRate = currency === 'DZD' ? 1 : Math.max(0.0001, exRateRaw || 1);

          invs.push({
            id: createId('sinv'),
            invoiceNumber: m.invoiceNumber,
            supplierRef: m.supplierRef,
            supplierId,
            issueDate,
            dueDate,
            currency,
            exchangeRate,
            description: m.description || `Import Excel (${m.invoiceNumber})`,
            lines: calc.lines,
            totalHtCentimes: calc.totalHtCentimes,
            totalTvaCentimes: calc.totalTvaCentimes,
            totalTtcCentimes: calc.totalTtcCentimes,
            baseDzdTtcCentimes: convertToBaseDzd(calc.totalTtcCentimes, exchangeRate),
            status: 'impayee',
            notes: m.notes,
            createdAt: now,
            updatedAt: now,
          });
        }
        await db.supplierInvoices.bulkPut(invs);
      } else if (type === 'depenses') {
        const expRecords: Expense[] = [];
        const ledRecords: LedgerEntry[] = [];

        for (const r of validRows) {
          const m = r.mapped;
          const dateIso = normalizeImportedDate(m.date)!;
          const amt = parseMoneyInputToCentimes(m.amount);
          const currency = (m.currency || settings.defaultCurrency || 'DZD').toUpperCase();
          const exRateRaw = m.exchangeRate ? Number(m.exchangeRate.replace(',', '.')) : 1;
          const exchangeRate = currency === 'DZD' ? 1 : Math.max(0.0001, exRateRaw || 1);
          const baseDzd = convertToBaseDzd(amt, exchangeRate);
          const method = parsePaymentMethod(m.paymentMethod);
          const bankId = method === 'especes' ? null : findBank(m.bankName);

          const catName = m.category || 'Autres charges';
          const catNorm = normalizeHeaderText(catName);
          let cat = categories.find((c) => normalizeHeaderText(c.name) === catNorm);
          if (!cat) {
            cat = {
              id: createId('cat'),
              name: catName,
              color: '#475569',
              isDefault: false,
              createdAt: now,
            };
            await db.expenseCategories.put(cat);
            categories.push(cat);
          }

          const expId = createId('exp');
          expRecords.push({
            id: expId,
            date: dateIso,
            beneficiary: m.beneficiary,
            categoryId: cat.id,
            categoryName: cat.name,
            description: m.description,
            amountCentimes: amt,
            currency,
            exchangeRate,
            baseDzdAmountCentimes: baseDzd,
            paymentMethod: method,
            bankAccountId: bankId,
            reference: m.reference,
            notes: m.notes,
            status: 'valide',
            createdAt: now,
            updatedAt: now,
          });

          // Règle anti-doublon : une dépense par chèque n'écrit pas au grand livre immédiatement
          if (method !== 'cheque') {
            ledRecords.push({
              id: createId('led'),
              date: dateIso,
              direction: 'sortie',
              sourceType: 'depense',
              sourceId: expId,
              bankAccountId: bankId,
              label: `Dépense — ${m.beneficiary} : ${m.description}`,
              amountCentimes: amt,
              currency,
              exchangeRate,
              baseDzdAmountCentimes: baseDzd,
              status: 'valide',
              createdAt: now,
            });
          }
        }
        await db.expenses.bulkPut(expRecords);
        if (ledRecords.length) await db.ledgerEntries.bulkPut(ledRecords);
      } else if (type === 'cheques_recus') {
        const chqRecords: IncomingCheque[] = [];
        const ledRecords: LedgerEntry[] = [];

        for (const r of validRows) {
          const m = r.mapped;
          const client = await findOrCreateContact(m.clientName, 'client');
          const clientId = client.id;
          const entryDate = normalizeImportedDate(m.entryDate)!;
          const chequeDate = m.chequeDate ? normalizeImportedDate(m.chequeDate) || entryDate : entryDate;
          const amt = parseMoneyInputToCentimes(m.amount);
          const currency = (m.currency || settings.defaultCurrency || 'DZD').toUpperCase();
          const exRateRaw = m.exchangeRate ? Number(m.exchangeRate.replace(',', '.')) : 1;
          const exchangeRate = currency === 'DZD' ? 1 : Math.max(0.0001, exRateRaw || 1);
          const baseDzd = convertToBaseDzd(amt, exchangeRate);
          const status = parseIncomingStatus(m.status);
          const linkedInv = m.invoiceNumber
            ? customerInvoices.find(
                (i) => i.invoiceNumber.trim().toLowerCase() === m.invoiceNumber.trim().toLowerCase()
              )
            : undefined;
          const targetBankId = bankAccounts[0]?.id || null;

          const id = createId('ichq');
          chqRecords.push({
            id,
            clientId,
            issuerBank: m.issuerBank,
            chequeNumber: normalizeChequeNumberValue(m.chequeNumber),
            chequeDate,
            entryDate,
            amountCentimes: amt,
            currency,
            exchangeRate,
            baseDzdAmountCentimes: baseDzd,
            targetBankAccountId: targetBankId,
            clearingDate: status === 'encaisse' ? entryDate : undefined,
            status,
            allocatedInvoiceIds: linkedInv ? [linkedInv.id] : [],
            notes: m.notes,
            createdAt: now,
            updatedAt: now,
          });

          if (status === 'encaisse') {
            ledRecords.push({
              id: createId('led'),
              date: entryDate,
              direction: 'entree',
              sourceType: 'cheque_recu_encaisse',
              sourceId: id,
              bankAccountId: targetBankId,
              contactId: clientId,
              label: `Chèque reçu encaissé ${m.chequeNumber} — ${m.clientName}`,
              amountCentimes: amt,
              currency,
              exchangeRate,
              baseDzdAmountCentimes: baseDzd,
              status: 'valide',
              createdAt: now,
            });
          }
        }
        await db.incomingCheques.bulkPut(chqRecords);
        if (ledRecords.length) await db.ledgerEntries.bulkPut(ledRecords);
      } else if (type === 'cheques_emis') {
        const chqRecords: OutgoingCheque[] = [];
        const ledRecords: LedgerEntry[] = [];

        for (const r of validRows) {
          const m = r.mapped;
          const bankId = findBank(m.bankName)!;
          const issueDate = normalizeImportedDate(m.issueDate)!;
          const amt = parseMoneyInputToCentimes(m.amount);
          const currency = (m.currency || settings.defaultCurrency || 'DZD').toUpperCase();
          const exRateRaw = m.exchangeRate ? Number(m.exchangeRate.replace(',', '.')) : 1;
          const exchangeRate = currency === 'DZD' ? 1 : Math.max(0.0001, exRateRaw || 1);
          const baseDzd = convertToBaseDzd(amt, exchangeRate);
          const status = parseOutgoingStatus(m.status);
          const chqNum = normalizeChequeNumberValue(m.chequeNumber);
          const id = createId('ochq');

          chqRecords.push({
            id,
            bankAccountId: bankId,
            chequeBookId: '',
            chequeLeafId: '',
            chequeNumber: chqNum,
            beneficiary: m.beneficiary,
            issueDate,
            amountCentimes: amt,
            currency,
            exchangeRate,
            baseDzdAmountCentimes: baseDzd,
            purpose: m.purpose,
            linkedType: 'autre',
            clearingDate: status === 'encaisse' ? issueDate : undefined,
            status,
            notes: m.notes,
            createdAt: now,
            updatedAt: now,
          });

          if (status === 'encaisse') {
            ledRecords.push({
              id: createId('led'),
              date: issueDate,
              direction: 'sortie',
              sourceType: 'cheque_emis_encaisse',
              sourceId: id,
              bankAccountId: bankId,
              label: `Chèque émis encaissé ${chqNum} — ${m.beneficiary} (${m.purpose})`,
              amountCentimes: amt,
              currency,
              exchangeRate,
              baseDzdAmountCentimes: baseDzd,
              status: 'valide',
              createdAt: now,
            });
          }
        }
        await db.outgoingCheques.bulkPut(chqRecords);
        if (ledRecords.length) await db.ledgerEntries.bulkPut(ledRecords);
      }
    }
  );

  await recordAudit({
    action: 'IMPORT',
    entityType: type,
    entityId: 'excel_import',
    summary:
      type === 'factures_clients'
        ? `Import Excel (${IMPORT_SCHEMAS[type].label}) : ${invoicesCreatedCount} facture(s) (${validRows.length} ligne(s)) depuis ${fileName || 'Excel'}`
        : `Import Excel (${IMPORT_SCHEMAS[type].label}) : ${validRows.length} ligne(s) importée(s)`,
  });

  return {
    importedCount: validRows.length,
    invoicesCreatedCount: type === 'factures_clients' ? invoicesCreatedCount : undefined,
    campaignsCreatedCount: type === 'factures_clients' ? campaignsCreatedCount : undefined,
    paymentsCreatedCount: type === 'factures_clients' ? paymentsCreatedCount : undefined,
  };
}

// ============================================================================
// MODE 1 : IMPORT / EXPORT « MODÈLE FACTURE » (1 facture par feuille Excel)
// ============================================================================

export interface InvoiceModelEditableItem {
  id: string;
  fileName: string;
  sheet: string;
  kind: 'facture' | 'proforma';
  number: string;
  year: number | null;
  date: string;
  city: string;
  refBc: string;
  company: ParsedInvoiceCompanyFiscal;
  companyProfileId: string;
  companyMatchedByNif: boolean;
  client: ParsedInvoiceClientInfo;
  lines: ParsedInvoiceLine[];
  totals: ParsedInvoiceTotals;
  issues: string[];
  campaignName: string;
  createCampaign: boolean;
  excluded?: boolean;
}

export interface ValidatedInvoiceModelItem {
  item: InvoiceModelEditableItem;
  status: 'valide' | 'alerte' | 'doublon' | 'erreur';
  blockingErrors: string[];
  warnings: string[];
  isDuplicate: boolean;
  duplicateReason?: string;
  matchedClient?: Contact;
  matchedBc?: PurchaseOrder;
  matchedCompanyProfile?: CompanyProfile;
}

function normalizeDigits(raw?: string): string {
  return (raw || '').replace(/\D+/g, '');
}

function normalizeCodeToken(raw?: string): string {
  return (raw || '').replace(/[\s\-/.]+/g, '').toLowerCase();
}

export function extractInvoiceYearForDedup(invoiceNumber: string, issueDate?: string): number {
  const parsed = parseDocumentNumberParts(invoiceNumber || '');
  if (parsed && Number.isFinite(parsed.yearTwoDigits)) {
    return 2000 + parsed.yearTwoDigits;
  }
  const yr = parseInt((issueDate || '').slice(0, 4), 10);
  return Number.isFinite(yr) && yr > 1900 ? yr : new Date().getFullYear();
}

export function matchCompanyProfileByFiscal(
  company: ParsedInvoiceCompanyFiscal,
  profiles: CompanyProfile[],
  fallbackProfileId?: string
): { profile?: CompanyProfile; matchedByNif: boolean } {
  const targetNif = normalizeDigits(company.nif);
  if (targetNif) {
    const byNif = profiles.find((p) => !p.deletedAt && normalizeDigits(p.nif) === targetNif);
    if (byNif) return { profile: byNif, matchedByNif: true };
  }
  const targetRc = normalizeCodeToken(company.rc);
  if (targetRc) {
    const byRc = profiles.find((p) => !p.deletedAt && normalizeCodeToken(p.rc) === targetRc);
    if (byRc) return { profile: byRc, matchedByNif: true };
  }
  const fallback =
    profiles.find((p) => p.id === fallbackProfileId && !p.deletedAt) ||
    profiles.find((p) => p.isDefault && !p.deletedAt) ||
    profiles.find((p) => !p.deletedAt);
  return { profile: fallback, matchedByNif: false };
}

export function matchClientContactForInvoice(
  client: ParsedInvoiceClientInfo,
  contacts: Contact[]
): Contact | undefined {
  const active = contacts.filter((c) => !c.deletedAt);
  const targetNif = normalizeDigits(client.nif);
  if (targetNif) {
    const byNif = active.find((c) => normalizeDigits(c.nif) === targetNif);
    if (byNif) return byNif;
  }
  const targetRc = normalizeCodeToken(client.rc);
  if (targetRc) {
    const byRc = active.find((c) => normalizeCodeToken(c.rc) === targetRc);
    if (byRc) return byRc;
  }
  const targetName = normalizeHeaderText(client.name);
  if (targetName) {
    return active.find(
      (c) =>
        normalizeHeaderText(c.company) === targetName ||
        normalizeHeaderText(c.name) === targetName
    );
  }
  return undefined;
}

export function buildEditableInvoiceItems(params: {
  parsedInvoices: Array<ParsedInvoiceSheet & { fileName: string }>;
  profiles: CompanyProfile[];
  fallbackCompanyProfileId?: string;
}): InvoiceModelEditableItem[] {
  return params.parsedInvoices.map((inv, idx) => {
    const companyMatch = matchCompanyProfileByFiscal(
      inv.company,
      params.profiles,
      params.fallbackCompanyProfileId
    );
    const firstTitle = (inv.lines[0]?.title || '').trim();
    return {
      id: `impm_${idx}_${createId('f')}`,
      fileName: inv.fileName,
      sheet: inv.sheet,
      kind: inv.kind,
      number: inv.number,
      year: inv.year,
      date: inv.date || '',
      city: inv.city,
      refBc: inv.refBc,
      company: { ...inv.company },
      companyProfileId: companyMatch.profile?.id || '',
      companyMatchedByNif: companyMatch.matchedByNif,
      client: { ...inv.client },
      lines: inv.lines.map((l) => ({ ...l })),
      totals: { ...inv.totals },
      issues: [...inv.issues],
      campaignName: firstTitle,
      createCampaign: Boolean(firstTitle),
      excluded: false,
    };
  });
}

export function validateInvoiceModelItems(params: {
  items: InvoiceModelEditableItem[];
  existingInvoices: CustomerInvoice[];
  profiles: CompanyProfile[];
  contacts: Contact[];
  purchaseOrders: PurchaseOrder[];
}): ValidatedInvoiceModelItem[] {
  const existingKeys = new Set<string>();
  for (const inv of params.existingInvoices) {
    if (inv.deletedAt) continue;
    const yr = extractInvoiceYearForDedup(inv.invoiceNumber, inv.issueDate);
    const profKey = inv.companyProfileId || '';
    existingKeys.add(`${inv.invoiceNumber.trim().toLowerCase()}::${yr}::${profKey}`);
  }

  const seenBatchKeys = new Set<string>();

  return params.items.map((item) => {
    const blockingErrors: string[] = [];
    const warnings: string[] = [];

    const numClean = item.number.trim();
    if (!numClean) {
      blockingErrors.push(
        'Numéro de facture manquant : aucune valeur après l’étiquette « FACTURE N°... ».'
      );
    }
    if (!item.date || !/^\d{4}-\d{2}-\d{2}$/.test(item.date)) {
      blockingErrors.push(
        'Date introuvable ou invalide : cellule « Alger le JJ/MM/AAAA » non détectée près du titre.'
      );
    }
    if (!item.client.name.trim()) {
      blockingErrors.push(
        'Client introuvable : étiquette « NOM : » absente ou cellule à sa droite vide.'
      );
    }
    if (item.lines.length === 0) {
      blockingErrors.push(
        'Aucune ligne détectée sous l’en-tête « Désignation / Quantité / Prix Ht / Total ».'
      );
    }

    const effectiveYear = item.year ?? extractInvoiceYearForDedup(numClean, item.date);
    const matchedCompanyProfile = params.profiles.find(
      (p) => !p.deletedAt && p.id === item.companyProfileId
    );
    const matchedClient = matchClientContactForInvoice(item.client, params.contacts);
    const matchedBc = item.refBc.trim()
      ? params.purchaseOrders.find(
          (p) =>
            !p.deletedAt &&
            p.direction === 'bc_recu' &&
            normalizeHeaderText(p.poNumber) === normalizeHeaderText(item.refBc)
        )
      : undefined;

    for (const issue of item.issues) {
      const lower = issue.toLowerCase();
      if (
        lower.includes('date introuvable') ||
        lower.includes('nom du client introuvable') ||
        lower.includes('aucune ligne') ||
        lower.includes('tableau des lignes introuvable')
      ) {
        continue;
      }
      warnings.push(issue);
    }

    // Vérifier aussi la cohérence HT/TVA/TTC en direct après édition utilisateur
    const sumLines = Math.round(item.lines.reduce((s, l) => s + Number(l.total || 0), 0) * 100) / 100;
    if (item.lines.length > 0 && Math.abs(item.totals.ht - sumLines) > 0.01) {
      const msg = `TOTAL HT (${item.totals.ht}) différent de la somme des lignes (${sumLines}).`;
      if (!warnings.some((w) => w.includes('TOTAL HT'))) {
        warnings.push(msg);
      }
    }
    const expectedTtc = Math.round((item.totals.ht + item.totals.vat) * 100) / 100;
    if (Math.abs(item.totals.ttc - expectedTtc) > 0.05) {
      warnings.push(`TOTAL TTC (${item.totals.ttc}) différent de HT + TVA (${expectedTtc}).`);
    }
    if (item.company.nif && !item.companyMatchedByNif && matchedCompanyProfile) {
      warnings.push(
        `NIF émetteur Excel (${item.company.nif}) non reconnu automatiquement — société sélectionnée : ${matchedCompanyProfile.name}.`
      );
    }

    const dedupKey = `${numClean.toLowerCase()}::${effectiveYear}::${item.companyProfileId || ''}`;
    let isDuplicate = false;
    let duplicateReason: string | undefined;
    if (numClean && !item.excluded) {
      if (existingKeys.has(dedupKey)) {
        isDuplicate = true;
        duplicateReason = `Doublon : la facture N° ${numClean} (${effectiveYear}) existe déjà pour ${matchedCompanyProfile?.name || 'cette société'}.`;
      } else if (seenBatchKeys.has(dedupKey)) {
        isDuplicate = true;
        duplicateReason = `Doublon dans ce lot : la facture N° ${numClean} (${effectiveYear}) apparaît plusieurs fois pour la même société.`;
      } else {
        seenBatchKeys.add(dedupKey);
      }
    }

    let status: ValidatedInvoiceModelItem['status'] = 'valide';
    if (blockingErrors.length > 0) status = 'erreur';
    else if (isDuplicate) status = 'doublon';
    else if (warnings.length > 0) status = 'alerte';

    return {
      item,
      status,
      blockingErrors,
      warnings,
      isDuplicate,
      duplicateReason,
      matchedClient,
      matchedBc,
      matchedCompanyProfile,
    };
  });
}

export interface PrepareInvoiceImportResult {
  mode: 'form' | 'table';
  sheetNames: string[];
  activeSheetName: string;
  fileNames: string[];
  formItems: InvoiceModelEditableItem[];
  validatedFormItems: ValidatedInvoiceModelItem[];
  ignoredSheets: Array<{ fileName: string; sheetName: string; reason: string }>;
  parsedSheet: ParsedExcelSheet | null;
  columnMapping: Record<string, string>;
}

/**
 * Fonction unique appelée par la boîte de dialogue d'importation (et les tests) dès qu'un ou
 * plusieurs fichiers Excel sont sélectionnés.
 * 1) Appelle parseInvoiceSheet() sur CHAQUE feuille de CHAQUE fichier en priorité.
 * 2) Dès qu'une feuille correspond à un « Modèle facture », retourne mode = 'form' sans jamais
 *    lancer l'analyseur tableau registre ni la validation par colonnes.
 * 3) Uniquement si aucune feuille ne contient « FACTURE N°... », bascule sur le mode tableau registre.
 */
export async function processInvoiceImportFiles(params: {
  files: Array<{ fileName: string; buffer: ArrayBuffer }>;
  profiles: CompanyProfile[];
  fallbackCompanyProfileId?: string;
  existingInvoices: CustomerInvoice[];
  contacts: Contact[];
  purchaseOrders: PurchaseOrder[];
}): Promise<PrepareInvoiceImportResult> {
  if (params.files.length === 0) {
    throw new Error('Aucun fichier Excel sélectionné.');
  }

  // Étape 1 : Tester parseInvoiceSheet() sur chaque feuille de chaque fichier
  const scan = scanWorkbooksForInvoiceForms(params.files);
  if (scan.mode === 'form') {
    const formItems = buildEditableInvoiceItems({
      parsedInvoices: scan.invoices,
      profiles: params.profiles,
      fallbackCompanyProfileId: params.fallbackCompanyProfileId,
    });
    const validatedFormItems = validateInvoiceModelItems({
      items: formItems,
      existingInvoices: params.existingInvoices,
      profiles: params.profiles,
      contacts: params.contacts,
      purchaseOrders: params.purchaseOrders,
    });
    const invoiceSheetNames = scan.invoices.map((inv) => inv.sheet).filter(Boolean);
    return {
      mode: 'form',
      sheetNames: invoiceSheetNames.length > 0 ? invoiceSheetNames : scan.sheetNames,
      activeSheetName: (invoiceSheetNames[0] || scan.sheetNames[0] || '').trim(),
      fileNames: params.files.map((f) => f.fileName),
      formItems,
      validatedFormItems,
      ignoredSheets: scan.ignoredSheets,
      parsedSheet: null,
      columnMapping: {},
    };
  }

  // Étape 2 : Repli en mode tableau registre uniquement si aucune feuille n'est une facture modèle
  const first = params.files[0];
  const parsedSheet = await parseExcelBuffer(first.buffer);
  const columnMapping = autoDetectColumnMapping('factures_clients', parsedSheet.headers);
  return {
    mode: 'table',
    sheetNames: parsedSheet.sheetNames,
    activeSheetName: parsedSheet.sheetName,
    fileNames: [first.fileName],
    formItems: [],
    validatedFormItems: [],
    ignoredSheets: [],
    parsedSheet,
    columnMapping,
  };
}

export function downloadInvoiceModelErrorsExcel(params: {
  validatedItems: ValidatedInvoiceModelItem[];
  ignoredSheets?: Array<{ fileName: string; sheetName: string; reason: string }>;
}): void {
  const rows: Array<Array<string | number>> = [];
  for (const v of params.validatedItems) {
    if (v.status === 'valide') continue;
    const reasons = [
      ...v.blockingErrors,
      ...(v.duplicateReason ? [v.duplicateReason] : []),
      ...v.warnings,
    ].join(' | ');
    const labelsHint = [
      !v.item.number ? 'FACTURE N°...' : '',
      !v.item.date ? 'Ville le JJ/MM/AAAA' : '',
      !v.item.client.name ? 'NOM :' : '',
      v.item.lines.length === 0 ? 'Désignation / Prix Ht / Total' : '',
      v.item.issues.length || v.warnings.length ? 'TOTAL HT / TVA / TOTAL TTC' : '',
    ]
      .filter(Boolean)
      .join(', ');

    rows.push([
      v.item.fileName,
      v.item.sheet,
      v.status === 'doublon' ? 'Doublon' : v.status === 'alerte' ? 'Avertissement' : 'Erreur',
      v.item.number || 'Non trouvé',
      v.item.date || 'Non trouvée',
      v.item.client.name || 'Non trouvé',
      reasons,
      labelsHint || 'Vérifier les cellules de totaux / doublon',
    ]);
  }

  for (const ign of params.ignoredSheets || []) {
    rows.push([
      ign.fileName,
      ign.sheetName,
      'Feuille ignorée',
      '—',
      '—',
      '—',
      ign.reason,
      'Cellule « FACTURE N°... »',
    ]);
  }

  const headers = [
    'Fichier',
    'Feuille',
    'Statut',
    'N° Facture détecté',
    'Date détectée',
    'Client détecté',
    'Pourquoi (explication détaillée en français)',
    'Cellules / Étiquettes concernées',
  ];
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  ws['!cols'] = [
    { wch: 28 },
    { wch: 16 },
    { wch: 15 },
    { wch: 16 },
    { wch: 14 },
    { wch: 26 },
    { wch: 52 },
    { wch: 34 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Erreurs import factures');
  XLSX.writeFile(wb, 'erreurs-import-factures-modele.xlsx');
}

function addDaysIso(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return isoDate;
  return new Date(d.getTime() + days * 86400000).toISOString().slice(0, 10);
}

export async function executeInvoiceModelImport(params: {
  validatedItems: ValidatedInvoiceModelItem[];
  settings: CompanySettings;
}): Promise<{
  invoicesCreatedCount: number;
  clientsCreatedCount: number;
  campaignsCreatedCount: number;
  bcsLinkedCount: number;
}> {
  const ready = params.validatedItems.filter(
    (v) =>
      !v.item.excluded &&
      v.blockingErrors.length === 0 &&
      !v.isDuplicate
  );
  if (ready.length === 0) {
    throw new Error('Aucune facture prête à importer.');
  }

  const now = new Date().toISOString();
  let invoicesCreatedCount = 0;
  let clientsCreatedCount = 0;
  let campaignsCreatedCount = 0;
  let bcsLinkedCount = 0;

  await db.transaction(
    'rw',
    [
      db.contacts,
      db.customerInvoices,
      db.campaigns,
      db.purchaseOrders,
      db.companyProfiles,
    ],
    async () => {
      const contacts = (await db.contacts.toArray()).filter((c) => !c.deletedAt);
      const customerInvoices = (await db.customerInvoices.toArray()).filter((i) => !i.deletedAt);
      const campaigns = (await db.campaigns.toArray()).filter((c) => !c.deletedAt);
      const purchaseOrders = (await db.purchaseOrders.toArray()).filter((p) => !p.deletedAt);
      const companyProfiles = (await db.companyProfiles.toArray()).filter((p) => !p.deletedAt);
      const touchedBcIds = new Set<string>();
      const newInvoices: CustomerInvoice[] = [];

      for (const v of ready) {
        const it = v.item;

        // 1. Société émettrice (par choix/NIF)
        const profile =
          companyProfiles.find((p) => p.id === it.companyProfileId) ||
          companyProfiles.find((p) => p.id === params.settings.activeCompanyProfileId) ||
          companyProfiles.find((p) => p.isDefault) ||
          companyProfiles[0];
        const issuerSnapshot = buildIssuerSnapshot(profile);

        // 2. Client : matching NIF -> RC -> Nom, sinon création avec toutes les infos fiscales
        let client = matchClientContactForInvoice(it.client, contacts);
        if (!client) {
          client = {
            id: createId('cnt'),
            type: 'client',
            name: it.client.name.trim(),
            company: it.client.name.trim(),
            address: it.client.address.trim(),
            postalCode: it.client.postalCode.trim(),
            city: it.client.city.trim(),
            phone: it.client.phone.trim(),
            email: it.client.email.trim(),
            nif: it.client.nif.trim(),
            nis: it.client.nis.trim(),
            rc: it.client.rc.trim(),
            ai: it.client.ai.trim(),
            notes: `Client créé depuis l’import Excel (${it.fileName})`,
            archived: false,
            createdAt: now,
            updatedAt: now,
          };
          await db.contacts.put(client);
          contacts.push(client);
          clientsCreatedCount += 1;
        } else {
          // Compléter uniquement les champs vides si le client existait sans toutes ses mentions fiscales
          const patch: Partial<Contact> = {};
          if (!client.nif && it.client.nif) patch.nif = it.client.nif.trim();
          if (!client.rc && it.client.rc) patch.rc = it.client.rc.trim();
          if (!client.ai && it.client.ai) patch.ai = it.client.ai.trim();
          if (!client.nis && it.client.nis) patch.nis = it.client.nis.trim();
          if (!client.address && it.client.address) patch.address = it.client.address.trim();
          if (!client.postalCode && it.client.postalCode) patch.postalCode = it.client.postalCode.trim();
          if (!client.city && it.client.city) patch.city = it.client.city.trim();
          if (!client.phone && it.client.phone) patch.phone = it.client.phone.trim();
          if (!client.email && it.client.email) patch.email = it.client.email.trim();
          if (Object.keys(patch).length > 0) {
            patch.updatedAt = now;
            await db.contacts.update(client.id, patch);
            client = { ...client, ...patch };
          }
        }

        const clientSnapshot: ClientFiscalSnapshot = {
          company: it.client.name.trim() || client.company || client.name,
          name: client.name,
          address: it.client.address.trim() || client.address,
          postalCode: it.client.postalCode.trim() || client.postalCode,
          city: it.client.city.trim() || client.city,
          phone: it.client.phone.trim() || client.phone,
          email: it.client.email.trim() || client.email,
          nif: it.client.nif.trim() || client.nif,
          nis: it.client.nis.trim() || client.nis,
          rc: it.client.rc.trim() || client.rc,
          ai: it.client.ai.trim() || client.ai,
        };

        // 3. Lier Ref BC à un BC reçu existant si trouvé
        const refBc = it.refBc.trim();
        let linkedBcRecuId: string | undefined;
        if (refBc) {
          const normBc = normalizeHeaderText(refBc);
          const matchedBc = purchaseOrders.find(
            (p) => p.direction === 'bc_recu' && normalizeHeaderText(p.poNumber) === normBc
          );
          if (matchedBc) {
            linkedBcRecuId = matchedBc.id;
            touchedBcIds.add(matchedBc.id);
            bcsLinkedCount += 1;
          }
        }

        // 4. Campagne depuis le titre de la 1ère ligne si activé
        const campName = it.campaignName.trim();
        let campaignId: string | undefined;
        let campaignRef = campName;
        let campaignStartDate: string | undefined;
        let campaignEndDate: string | undefined;

        if (it.createCampaign && campName) {
          const normCamp = normalizeHeaderText(campName);
          let matchedCamp = campaigns.find(
            (c) => c.clientId === client!.id && normalizeHeaderText(c.name) === normCamp
          );
          if (!matchedCamp) {
            matchedCamp = {
              id: createId('cmp'),
              name: campName,
              clientId: client.id,
              startDate: '',
              endDate: '',
              status: 'en_cours',
              notes: `Campagne créée lors de l’import de la facture ${it.number}`,
              createdAt: now,
              updatedAt: now,
            };
            await db.campaigns.put(matchedCamp);
            campaigns.push(matchedCamp);
            campaignsCreatedCount += 1;
          }
          campaignId = matchedCamp.id;
          campaignRef = matchedCamp.name;
          campaignStartDate = matchedCamp.startDate;
          campaignEndDate = matchedCamp.endDate;
        }

        // 5. Lignes & totaux exacts en centimes entiers
        const vatRate = Number.isFinite(it.totals.vatRate) ? it.totals.vatRate : 19;
        const invoiceLines: InvoiceLine[] = it.lines.map((l) => {
          const fullDesc = l.description.trim()
            ? `${l.title.trim()}\n${l.description.trim()}`
            : l.title.trim() || 'Prestation';
          const unitPriceCentimes = Math.round(l.unitPrice * 100);
          const htCentimes = Math.round(l.total * 100);
          const tvaCentimes = Math.round((htCentimes * vatRate) / 100);
          const ttcCentimes = htCentimes + tvaCentimes;
          return {
            id: createId('line'),
            description: fullDesc,
            quantity: l.qty,
            unit: l.unit || 'u',
            unitPriceCentimes,
            discountPercent: 0,
            tvaRate: vatRate,
            htCentimes,
            tvaCentimes,
            ttcCentimes,
            lineMode: 'libre',
            manualTotalLocked: true,
          };
        });

        const totalHtCentimes = Math.round(it.totals.ht * 100);
        const totalTvaCentimes = Math.round(it.totals.vat * 100);
        const totalTtcCentimes = Math.round(it.totals.ttc * 100);

        const invRecord: CustomerInvoice = {
          id: createId('cinv'),
          invoiceNumber: it.number.trim(),
          companyProfileId: profile?.id,
          issuerSnapshot,
          clientId: client.id,
          clientSnapshot,
          issueDate: it.date,
          dueDate: addDaysIso(it.date, 30),
          bcNumber: refBc,
          linkedBcRecuId,
          campaignId,
          campaignRef,
          campaignStartDate,
          campaignEndDate,
          showCampaignOnPrint: Boolean(campaignRef),
          currency: 'DZD',
          exchangeRate: 1,
          description: it.lines[0]?.title || `Facture ${it.number}`,
          lines: invoiceLines,
          totalHtCentimes,
          totalTvaCentimes,
          totalTtcCentimes,
          baseDzdTtcCentimes: totalTtcCentimes,
          status: 'impayee',
          isImported: true,
          importedFromFile: `${it.fileName} (${it.sheet})`,
          notes: it.city ? `Fait à ${it.city}` : '',
          createdAt: now,
          updatedAt: now,
        };

        newInvoices.push(invRecord);
        customerInvoices.push(invRecord);
        invoicesCreatedCount += 1;
      }

      if (newInvoices.length > 0) {
        await db.customerInvoices.bulkPut(newInvoices);
      }

      for (const bcId of touchedBcIds) {
        const bc = purchaseOrders.find((p) => p.id === bcId);
        if (!bc) continue;
        const linkedInvs = customerInvoices.filter((i) => i.linkedBcRecuId === bcId && !i.deletedAt);
        const nextIds = Array.from(new Set(linkedInvs.map((i) => i.id)));
        const nextStatus = computeBcRecuInvoicingStatus({ bc, linkedInvoices: linkedInvs });
        await db.purchaseOrders.update(bcId, {
          linkedInvoiceIds: nextIds,
          status: nextStatus,
          updatedAt: now,
        } as Partial<PurchaseOrder>);
      }
    }
  );

  await recordAudit({
    action: 'IMPORT',
    entityType: 'factures_clients',
    entityId: 'invoice_model_import',
    summary: `Import Excel (Modèle facture) : ${invoicesCreatedCount} facture(s), ${clientsCreatedCount} client(s) créé(s), ${campaignsCreatedCount} campagne(s)`,
  });

  return {
    invoicesCreatedCount,
    clientsCreatedCount,
    campaignsCreatedCount,
    bcsLinkedCount,
  };
}

/**
 * Exporte une facture client au format exact « Modèle facture » (.xlsx) afin de pouvoir
 * la ré-importer fidèlement dans le logiciel (aller-retour complet).
 */
export function buildExportParamsFromCustomerInvoice(params: {
  invoice: CustomerInvoice;
  profile?: Partial<CompanyProfile>;
  contact?: Contact;
}): ExportInvoiceModelParams {
  const { invoice, profile, contact } = params;
  const snap = invoice.clientSnapshot;
  const uniqueRates = Array.from(new Set(invoice.lines.map((l) => l.tvaRate)));
  const vatRate = uniqueRates.length === 1 ? uniqueRates[0] : 19;

  return {
    kind: 'facture',
    number: invoice.invoiceNumber,
    issueDate: invoice.issueDate,
    city: profile?.city || 'Alger',
    refBc: invoice.bcNumber || '',
    company: {
      name: profile?.name,
      address: profile?.address,
      phone: profile?.phone,
      email: profile?.email,
      rc: profile?.rc,
      nif: profile?.nif,
      ai: profile?.ai,
      nis: profile?.nis,
      bankInfo: profile?.bankInfo,
    },
    client: {
      name: snap?.company || contact?.company || contact?.name || 'Client',
      address: snap?.address || contact?.address || '',
      postalCode: snap?.postalCode || contact?.postalCode || '',
      city: snap?.city || contact?.city || '',
      phone: snap?.phone || contact?.phone || '',
      email: snap?.email || contact?.email || '',
      rc: snap?.rc || contact?.rc || '',
      ai: snap?.ai || contact?.ai || '',
      nif: snap?.nif || contact?.nif || '',
      nis: snap?.nis || contact?.nis || '',
    },
    lines: invoice.lines.map((l) => {
      const parts = (l.description || '').split('\n');
      return {
        title: parts[0] || '',
        description: parts.slice(1).join('\n'),
        qty: l.quantity,
        unit: l.unit || 'u',
        unitPrice: l.unitPriceCentimes / 100,
        total: l.htCentimes / 100,
      };
    }),
    totals: {
      ht: invoice.totalHtCentimes / 100,
      vatRate,
      vat: invoice.totalTvaCentimes / 100,
      ttc: invoice.totalTtcCentimes / 100,
    },
  };
}

export function exportCustomerInvoiceToModelExcel(params: {
  invoice: CustomerInvoice;
  profile?: Partial<CompanyProfile>;
  contact?: Contact;
}): void {
  const exportParams = buildExportParamsFromCustomerInvoice(params);
  downloadInvoiceModelExcel(exportParams);
}
