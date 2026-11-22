import Dexie, { type Table } from 'dexie';
import { APP_VERSION, DEVELOPER_BRAND } from '../constants/branding';
import {
  buildDefaultGravurePubProfile,
  buildDefaultVistaDigitalProfile,
  DEFAULT_VISTA_LOGO_DATA_URL,
  GRAVURE_PUB_PROFILE_ID,
  VISTA_DIGITAL_PROFILE_ID,
} from '../constants/companyPresets';
import { DEFAULT_CURRENCIES } from '../utils/money';
import type {
  AuditAction,
  AuditLog,
  BankAccount,
  Campaign,
  ChequeBook,
  ChequeLeaf,
  CompanyProfile,
  CompanySettings,
  Contact,
  CustomerInvoice,
  DocumentAttachment,
  Expense,
  ExpenseCategory,
  IncomingCheque,
  LedgerEntry,
  OutgoingCheque,
  Payment,
  PaymentAllocation,
  PrintSettings,
  Proforma,
  PurchaseOrder,
  SupplierInvoice,
} from './types';

export const DEFAULT_PRINT_SETTINGS: PrintSettings = {
  defaultPrinterName: '',
  paperSize: 'A4',
  orientation: 'portrait',
  margins: 'none',
  color: true,
  copies: 1,
  fitToPage: true,
  previewBeforePrint: true,
  silentPrint: false,
};

export const DEFAULT_EXPENSE_CATEGORIES: Omit<ExpenseCategory, 'createdAt'>[] = [
  { id: 'cat-loyer', name: 'Loyer & charges', color: '#1e40af', isDefault: true },
  { id: 'cat-salaires', name: 'Salaires & charges sociales', color: '#047857', isDefault: true },
  { id: 'cat-fournitures', name: 'Fournitures & consommables', color: '#b45309', isDefault: true },
  { id: 'cat-transport', name: 'Transport & carburant', color: '#4338ca', isDefault: true },
  { id: 'cat-telecom', name: 'Télécom & Internet', color: '#0f766e', isDefault: true },
  { id: 'cat-impots', name: 'Impôts & taxes', color: '#b91c1c', isDefault: true },
  { id: 'cat-prestations', name: 'Prestations & sous-traitance', color: '#6d28d9', isDefault: true },
  { id: 'cat-autres', name: 'Autres dépenses', color: '#475569', isDefault: true },
];

export function createDefaultSettings(): CompanySettings {
  const now = new Date().toISOString();
  return {
    id: 'company_settings',
    companyName: '',
    logoDataUrl: '',
    address: '',
    phone: '',
    email: '',
    nif: '',
    nis: '',
    rc: '',
    ai: '',
    activeCompanyProfileId: VISTA_DIGITAL_PROFILE_ID,
    companyScopeFilter: 'all',
    defaultCurrency: 'DZD',
    enabledCurrencies: DEFAULT_CURRENCIES,
    defaultTvaRate: 19,
    invoicePrefix: 'FAC-',
    invoiceNextSeq: 1,
    supplierInvoicePrefix: 'FF-',
    supplierInvoiceNextSeq: 1,
    cashOpeningBalanceCentimes: 0,
    cashOpeningDate: now.slice(0, 10),
    backupFolder: '',
    uiMode: 'simple',
    onboardingCompleted: false,
    developerBrand: DEVELOPER_BRAND,
    appVersion: APP_VERSION,
    isDemoDataLoaded: false,
    printSettings: { ...DEFAULT_PRINT_SETTINGS },
    updatedAt: now,
  };
}

export function buildDefaultProfileFromSettings(s: CompanySettings): CompanyProfile {
  const vista = buildDefaultVistaDigitalProfile();
  const isPlaceholder =
    !s.companyName ||
    s.companyName === 'Entreprise principale' ||
    s.companyName === 'SARL Numidia Services (Démo)';
  if (isPlaceholder) {
    return vista;
  }
  const now = new Date().toISOString();
  return {
    id: s.activeCompanyProfileId || 'profile_default',
    name: s.companyName,
    logoDataUrl: s.logoDataUrl || '',
    address: s.address || '',
    city: 'Alger',
    phone: s.phone || '',
    email: s.email || '',
    nif: s.nif || '',
    nis: s.nis || '',
    rc: s.rc || '',
    ai: s.ai || '',
    primaryColor: '#FF33CC',
    accentColor: '#6B2FA0',
    signatureLabel: 'SERVICE COMMERCIAL',
    applyThemeToApp: true,
    footerNote: '',
    isDefault: true,
    createdAt: now,
    updatedAt: now,
  };
}

export class GestionFinanciereDB extends Dexie {
  settings!: Table<CompanySettings, string>;
  companyProfiles!: Table<CompanyProfile, string>;
  contacts!: Table<Contact, string>;
  bankAccounts!: Table<BankAccount, string>;
  chequeBooks!: Table<ChequeBook, string>;
  chequeLeaves!: Table<ChequeLeaf, string>;
  customerInvoices!: Table<CustomerInvoice, string>;
  supplierInvoices!: Table<SupplierInvoice, string>;
  campaigns!: Table<Campaign, string>;
  purchaseOrders!: Table<PurchaseOrder, string>;
  proformas!: Table<Proforma, string>;
  documentAttachments!: Table<DocumentAttachment, string>;
  payments!: Table<Payment, string>;
  paymentAllocations!: Table<PaymentAllocation, string>;
  expenseCategories!: Table<ExpenseCategory, string>;
  expenses!: Table<Expense, string>;
  incomingCheques!: Table<IncomingCheque, string>;
  outgoingCheques!: Table<OutgoingCheque, string>;
  ledgerEntries!: Table<LedgerEntry, string>;
  auditLogs!: Table<AuditLog, string>;

  constructor() {
    super('GestionFinanciereDB');
    this.version(1).stores({
      settings: 'id',
      contacts: 'id, type, name, company, archived',
      bankAccounts: 'id, bankName, currency, active',
      chequeBooks: 'id, bankAccountId, createdAt',
      chequeLeaves: 'id, chequeBookId, bankAccountId, &[bankAccountId+chequeNumber], status',
      customerInvoices: 'id, invoiceNumber, clientId, issueDate, dueDate, status',
      supplierInvoices: 'id, invoiceNumber, supplierId, issueDate, dueDate, status',
      payments: 'id, direction, contactId, date, method, bankAccountId, status',
      paymentAllocations: 'id, paymentId, invoiceType, invoiceId',
      expenseCategories: 'id, name',
      expenses: 'id, date, categoryId, beneficiary, paymentMethod, bankAccountId, status',
      incomingCheques: 'id, clientId, chequeNumber, entryDate, status, targetBankAccountId',
      outgoingCheques: 'id, bankAccountId, chequeBookId, chequeNumber, issueDate, status',
      ledgerEntries: 'id, date, direction, sourceType, sourceId, bankAccountId, status',
      auditLogs: 'id, timestamp, action, entityType, entityId',
    });

    this.version(2)
      .stores({
        settings: 'id',
        companyProfiles: 'id, name, isDefault, deletedAt',
        contacts: 'id, type, name, company, archived, deletedAt',
        bankAccounts: 'id, bankName, currency, active, deletedAt',
        chequeBooks: 'id, bankAccountId, createdAt, deletedAt',
        chequeLeaves: 'id, chequeBookId, bankAccountId, &[bankAccountId+chequeNumber], status',
        customerInvoices:
          'id, invoiceNumber, clientId, companyProfileId, campaignId, linkedBcRecuId, proformaId, issueDate, dueDate, status, deletedAt',
        supplierInvoices: 'id, invoiceNumber, supplierId, issueDate, dueDate, status, deletedAt',
        campaigns: 'id, clientId, startDate, endDate, status, deletedAt',
        purchaseOrders:
          'id, direction, poNumber, contactId, companyProfileId, campaignId, issueDate, status, deletedAt',
        proformas:
          'id, proformaNumber, clientId, companyProfileId, campaignId, linkedBcRecuId, issueDate, validUntil, status, deletedAt',
        documentAttachments: 'id, parentType, parentId, createdAt',
        payments: 'id, direction, contactId, date, method, bankAccountId, status, deletedAt',
        paymentAllocations: 'id, paymentId, invoiceType, invoiceId',
        expenseCategories: 'id, name',
        expenses: 'id, date, categoryId, beneficiary, paymentMethod, bankAccountId, status, deletedAt',
        incomingCheques: 'id, clientId, chequeNumber, entryDate, status, targetBankAccountId, deletedAt',
        outgoingCheques: 'id, bankAccountId, chequeBookId, chequeNumber, issueDate, status, deletedAt',
        ledgerEntries: 'id, date, direction, sourceType, sourceId, bankAccountId, status',
        auditLogs: 'id, timestamp, action, entityType, entityId',
      })
      .upgrade(async (tx) => {
        const settingsTable = tx.table('settings');
        const profileTable = tx.table('companyProfiles');
        const existingSettings = (await settingsTable.get('company_settings')) as
          | CompanySettings
          | undefined;
        const profileCount = await profileTable.count();
        if (existingSettings && profileCount === 0) {
          const prof = buildDefaultProfileFromSettings(existingSettings);
          await profileTable.put(prof);
          if (!existingSettings.activeCompanyProfileId) {
            await settingsTable.update('company_settings', {
              activeCompanyProfileId: prof.id,
            });
          }
        }
      });

    this.version(3)
      .stores({
        settings: 'id',
        companyProfiles: 'id, name, isDefault, deletedAt',
        contacts: 'id, type, name, company, archived, deletedAt',
        bankAccounts: 'id, bankName, currency, active, deletedAt',
        chequeBooks: 'id, bankAccountId, createdAt, deletedAt',
        chequeLeaves: 'id, chequeBookId, bankAccountId, &[bankAccountId+chequeNumber], status',
        customerInvoices:
          'id, invoiceNumber, clientId, companyProfileId, campaignId, linkedBcRecuId, proformaId, issueDate, dueDate, status, deletedAt',
        supplierInvoices: 'id, invoiceNumber, supplierId, issueDate, dueDate, status, deletedAt',
        campaigns: 'id, clientId, startDate, endDate, status, deletedAt',
        purchaseOrders:
          'id, direction, poNumber, contactId, companyProfileId, campaignId, issueDate, status, deletedAt',
        proformas:
          'id, proformaNumber, clientId, companyProfileId, campaignId, linkedBcRecuId, issueDate, validUntil, status, deletedAt',
        documentAttachments: 'id, parentType, parentId, createdAt',
        payments: 'id, direction, contactId, date, method, bankAccountId, status, deletedAt',
        paymentAllocations: 'id, paymentId, invoiceType, invoiceId',
        expenseCategories: 'id, name',
        expenses: 'id, date, categoryId, beneficiary, paymentMethod, bankAccountId, status, deletedAt',
        incomingCheques: 'id, clientId, chequeNumber, entryDate, status, targetBankAccountId, deletedAt',
        outgoingCheques: 'id, bankAccountId, chequeBookId, chequeNumber, issueDate, status, deletedAt',
        ledgerEntries: 'id, date, direction, sourceType, sourceId, bankAccountId, status',
        auditLogs: 'id, timestamp, action, entityType, entityId',
      })
      .upgrade(async (tx) => {
        // Migration non destructive : conserve toutes les données et remplace uniquement les profils fictifs génériques
        const profileTable = tx.table('companyProfiles');
        const settingsTable = tx.table('settings');
        const allProfiles = (await profileTable.toArray()) as CompanyProfile[];
        const onlyPlaceholder =
          allProfiles.length === 0 ||
          allProfiles.every(
            (p) =>
              p.id === 'profile_default' &&
              (!p.name ||
                p.name === 'Entreprise principale' ||
                p.name === 'SARL Numidia Services (Démo)')
          );
        if (onlyPlaceholder) {
          if (allProfiles.some((p) => p.id === 'profile_default')) {
            await profileTable.delete('profile_default');
          }
          const vista = buildDefaultVistaDigitalProfile();
          const gravure = buildDefaultGravurePubProfile();
          await profileTable.bulkPut([vista, gravure]);
          await settingsTable.update('company_settings', {
            activeCompanyProfileId: VISTA_DIGITAL_PROFILE_ID,
            companyScopeFilter: 'all',
            companyName: vista.name,
            logoDataUrl: vista.logoDataUrl,
            address: vista.address,
            phone: vista.phone,
            email: vista.email,
            nif: vista.nif,
            nis: vista.nis,
            rc: vista.rc,
            ai: vista.ai,
          });
        }
      });
  }
}

export const db = new GestionFinanciereDB();

export function createId(prefix = 'id'): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export async function ensureDatabaseInitialized(): Promise<CompanySettings> {
  const existing = await db.settings.get('company_settings');
  const now = new Date().toISOString();

  const catCount = await db.expenseCategories.count();
  if (catCount === 0) {
    await db.expenseCategories.bulkPut(
      DEFAULT_EXPENSE_CATEGORIES.map((c) => ({ ...c, createdAt: now }))
    );
  }

  let settingsRecord = existing;
  if (!settingsRecord) {
    settingsRecord = createDefaultSettings();
    await db.settings.put(settingsRecord);
  } else if (settingsRecord.developerBrand !== DEVELOPER_BRAND) {
    settingsRecord = { ...settingsRecord, developerBrand: DEVELOPER_BRAND };
    await db.settings.put(settingsRecord);
  }

  // S'assurer que les deux sociétés par défaut existent si la table ne contient aucun profil personnalisé
  const allProfiles = await db.companyProfiles.filter((p) => !p.deletedAt).toArray();
  const isPlaceholderOnly =
    allProfiles.length === 0 ||
    (allProfiles.length === 1 &&
      allProfiles[0].id === 'profile_default' &&
      (!allProfiles[0].name ||
        allProfiles[0].name === 'Entreprise principale' ||
        allProfiles[0].name === 'SARL Numidia Services (Démo)'));

  if (isPlaceholderOnly) {
    if (allProfiles.length === 1 && allProfiles[0].id === 'profile_default') {
      await db.companyProfiles.delete('profile_default');
    }
    const vista = buildDefaultVistaDigitalProfile(now);
    const gravure = buildDefaultGravurePubProfile(now);
    await db.companyProfiles.bulkPut([vista, gravure]);

    const shouldSyncSettings =
      !settingsRecord.companyName ||
      settingsRecord.companyName === 'SARL Numidia Services (Démo)' ||
      settingsRecord.companyName === 'Entreprise principale';

    settingsRecord = {
      ...settingsRecord,
      activeCompanyProfileId: VISTA_DIGITAL_PROFILE_ID,
      companyScopeFilter: settingsRecord.companyScopeFilter || 'all',
      ...(shouldSyncSettings
        ? {
            companyName: vista.name,
            logoDataUrl: vista.logoDataUrl,
            address: vista.address,
            phone: vista.phone,
            email: vista.email,
            nif: vista.nif,
            nis: vista.nis,
            rc: vista.rc,
            ai: vista.ai,
          }
        : {}),
      updatedAt: now,
    };
    await db.settings.put(settingsRecord);
  } else if (!allProfiles.some((p) => p.id === GRAVURE_PUB_PROFILE_ID) && allProfiles.every((p) => p.id === VISTA_DIGITAL_PROFILE_ID)) {
    await db.companyProfiles.put(buildDefaultGravurePubProfile(now));
  }

  // Migrer automatiquement d'anciens logos SVG utf8 vers base64 pour compatibilité PDF/canvas hors-ligne
  for (const prof of allProfiles) {
    if (
      prof.id === VISTA_DIGITAL_PROFILE_ID &&
      prof.logoDataUrl &&
      prof.logoDataUrl.startsWith('data:image/svg+xml;utf8,')
    ) {
      await db.companyProfiles.update(prof.id, {
        logoDataUrl: DEFAULT_VISTA_LOGO_DATA_URL,
        updatedAt: now,
      });
    }
  }
  if (
    settingsRecord.logoDataUrl &&
    settingsRecord.logoDataUrl.startsWith('data:image/svg+xml;utf8,')
  ) {
    settingsRecord = {
      ...settingsRecord,
      logoDataUrl: DEFAULT_VISTA_LOGO_DATA_URL,
      updatedAt: now,
    };
    await db.settings.put(settingsRecord);
  }

  if (!settingsRecord.printSettings) {
    settingsRecord = {
      ...settingsRecord,
      printSettings: { ...DEFAULT_PRINT_SETTINGS },
      updatedAt: now,
    };
    await db.settings.put(settingsRecord);
  }

  return settingsRecord;
}

export async function recordAudit(params: {
  action: AuditAction;
  entityType: string;
  entityId: string;
  summary: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
  actor?: string;
}): Promise<void> {
  const entry: AuditLog = {
    id: createId('aud'),
    timestamp: new Date().toISOString(),
    actor: params.actor || 'Utilisateur local',
    action: params.action,
    entityType: params.entityType,
    entityId: params.entityId,
    summary: params.summary,
    beforeJson: params.before !== undefined ? JSON.stringify(params.before) : undefined,
    afterJson: params.after !== undefined ? JSON.stringify(params.after) : undefined,
    reason: params.reason,
  };
  await db.auditLogs.put(entry);
}
