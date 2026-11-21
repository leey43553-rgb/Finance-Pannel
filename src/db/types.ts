export type UIMode = 'simple' | 'avance';

export type ContactType = 'client' | 'fournisseur' | 'les_deux';

export type PaymentMethod = 'especes' | 'cheque' | 'virement' | 'carte';

export type StoredInvoiceStatus = 'impayee' | 'partielle' | 'payee' | 'annulee';
export type ComputedInvoiceStatus = StoredInvoiceStatus | 'en_retard';

export type ChequeLeafStatus =
  | 'disponible'
  | 'prepare'
  | 'remis'
  | 'depose'
  | 'en_attente'
  | 'encaisse'
  | 'rejete'
  | 'annule';

export type OutgoingChequeStatus =
  | 'prepare'
  | 'remis'
  | 'depose'
  | 'en_attente'
  | 'encaisse'
  | 'rejete'
  | 'annule';

export type IncomingChequeStatus =
  | 'recu'
  | 'depose'
  | 'en_attente'
  | 'encaisse'
  | 'rejete'
  | 'annule';

export interface CurrencyConfig {
  code: string; // e.g., 'DZD', 'EUR', 'USD', 'GBP'
  name: string; // e.g., 'Dinar algérien'
  symbol: string; // e.g., 'DA', '€', '$', '£'
  rateToDzd: number; // Taux indicatif manuel vers DZD (1 pour DZD)
  enabled: boolean;
}

export interface CompanyProfile {
  id: string;
  name: string;
  logoDataUrl: string;
  address: string;
  postalCode?: string;
  city?: string;
  phone: string;
  fax?: string;
  email: string;
  nif: string;
  nis: string;
  rc: string;
  ai: string;
  rib?: string;
  bankInfo?: string;
  primaryColor: string;
  accentColor: string;
  footerNote?: string;
  signatureDataUrl?: string;
  signatureLabel?: string;
  applyThemeToApp?: boolean;
  isDefault: boolean;
  deletedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ClientFiscalSnapshot {
  company: string;
  name: string;
  address: string;
  postalCode?: string;
  city?: string;
  phone?: string;
  email?: string;
  nif?: string;
  nis?: string;
  rc?: string;
  ai?: string;
}

export interface OutdoorCatalogConfig {
  serviceTypes: string[];
  panelTypes: string[];
  faces: string[];
  locations: string[];
}

export interface CompanySettings {
  id: 'company_settings';
  companyName: string;
  logoDataUrl: string;
  address: string;
  phone: string;
  email: string;
  nif: string;
  nis: string;
  rc: string;
  ai: string;
  activeCompanyProfileId?: string;
  companyScopeFilter?: 'active' | 'all';
  defaultCurrency: string;
  enabledCurrencies: CurrencyConfig[];
  defaultTvaRate: number; // Ex: 19
  invoicePrefix: string; // Ex: 'FAC-'
  invoiceNextSeq: number;
  supplierInvoicePrefix: string; // Ex: 'FF-'
  supplierInvoiceNextSeq: number;
  cashOpeningBalanceCentimes: number;
  cashOpeningDate: string;
  backupFolder: string;
  uiMode: UIMode;
  onboardingCompleted: boolean;
  developerBrand: string;
  appVersion: string;
  isDemoDataLoaded: boolean;
  outdoorCatalog?: OutdoorCatalogConfig;
  updatedAt: string;
}

export interface Contact {
  id: string;
  type: ContactType;
  name: string;
  company: string;
  address: string;
  postalCode?: string;
  city?: string;
  phone: string;
  email: string;
  nif: string;
  nis: string;
  rc: string;
  ai: string;
  notes: string;
  archived: boolean;
  deletedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface BankAccount {
  id: string;
  bankName: string;
  accountName: string;
  accountNumber: string;
  rib: string;
  currency: string;
  openingBalanceCentimes: number;
  openingDate: string;
  notes: string;
  active: boolean;
  deletedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChequeBook {
  id: string;
  bankAccountId: string;
  startSerial: string; // Conservé en texte avec zéros initiaux, ex: '0012345'
  count: number;
  notes: string;
  deletedAt?: string;
  createdAt: string;
}

export interface ChequeLeaf {
  id: string;
  chequeBookId: string;
  bankAccountId: string;
  chequeNumber: string; // Texte avec zéros initiaux
  status: ChequeLeafStatus;
  outgoingChequeId?: string;
  createdAt: string;
}

export interface InvoiceLine {
  id: string;
  description: string;
  quantity: number;
  unit?: string; // Ex: 'u', 'm²', 'mois', 'jour', 'forfait', 'ml'
  unitPriceCentimes: number;
  discountPercent: number; // 0 à 100
  tvaRate: number; // Ex: 19, 9, 0
  htCentimes: number;
  tvaCentimes: number;
  ttcCentimes: number;
  // Champs optionnels pour la saisie guidée (Étape 6)
  lineMode?: 'libre' | 'guidee';
  serviceType?: string;
  panelType?: string;
  location?: string;
  face?: string;
  widthM?: number;
  heightM?: number;
  surfaceM2?: number;
  panelCount?: number;
  durationValue?: number;
  durationUnit?: 'mois' | 'jours';
  pricingUnit?: 'mois' | 'm2' | 'u' | 'forfait' | 'jour' | 'ml';
  manualTotalLocked?: boolean;
  manualDesignationEdited?: boolean;
}

export interface CustomerInvoice {
  id: string;
  invoiceNumber: string;
  companyProfileId?: string;
  issuerSnapshot?: Partial<CompanyProfile>;
  clientId: string;
  clientSnapshot?: ClientFiscalSnapshot;
  issueDate: string;
  dueDate: string;
  bcNumber: string;
  linkedBcRecuId?: string;
  proformaId?: string;
  campaignId?: string;
  campaignRef: string;
  campaignStartDate?: string;
  campaignEndDate?: string;
  showCampaignOnPrint?: boolean;
  currency: string;
  exchangeRate: number; // Taux figé au moment de la facture
  description: string;
  lines: InvoiceLine[];
  totalHtCentimes: number;
  totalTvaCentimes: number;
  totalTtcCentimes: number;
  baseDzdTtcCentimes: number;
  status: StoredInvoiceStatus;
  cancelReason?: string;
  cancelledAt?: string;
  isImported?: boolean;
  importedFromFile?: string;
  amountInWordsOverride?: string;
  notes: string;
  deletedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SupplierInvoice {
  id: string;
  invoiceNumber: string;
  supplierRef: string;
  supplierId: string;
  issueDate: string;
  dueDate: string;
  currency: string;
  exchangeRate: number;
  description: string;
  lines: InvoiceLine[];
  totalHtCentimes: number;
  totalTvaCentimes: number;
  totalTtcCentimes: number;
  baseDzdTtcCentimes: number;
  status: StoredInvoiceStatus;
  cancelReason?: string;
  cancelledAt?: string;
  notes: string;
  deletedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type CampaignStatus = 'prevue' | 'en_cours' | 'terminee' | 'annulee';

export interface Campaign {
  id: string;
  name: string;
  clientId: string;
  startDate: string;
  endDate: string;
  status: CampaignStatus;
  notes: string;
  deletedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type PurchaseOrderDirection = 'bc_recu' | 'bc_emis';

export type BcRecuStatus = 'recu' | 'en_cours' | 'partiellement_facture' | 'facture' | 'annule';
export type BcEmisStatus = 'brouillon' | 'envoye' | 'recu' | 'facture' | 'annule';

export interface PurchaseOrder {
  id: string;
  direction: PurchaseOrderDirection;
  poNumber: string; // Ex: 'BC N°001/26' pour bc_emis, ou texte libre '38/26/RL' pour bc_recu
  companyProfileId?: string;
  issuerSnapshot?: Partial<CompanyProfile>;
  contactId: string; // clientId si bc_recu, supplierId si bc_emis
  issueDate: string; // date réception (bc_recu) ou date émission (bc_emis)
  expectedDate?: string;
  campaignId?: string;
  campaignRef: string;
  campaignStartDate?: string;
  campaignEndDate?: string;
  showCampaignOnPrint?: boolean;
  currency: string;
  exchangeRate: number;
  description: string;
  lines: InvoiceLine[];
  totalHtCentimes: number;
  totalTvaCentimes: number;
  totalTtcCentimes: number;
  baseDzdTtcCentimes: number;
  status: BcRecuStatus | BcEmisStatus;
  linkedInvoiceIds?: string[];
  linkedProformaIds?: string[];
  convertedExpenseId?: string;
  attachmentsCount?: number;
  amountInWordsOverride?: string;
  delivery?: string;
  paymentTerms?: string;
  tags?: string[];
  isImported?: boolean;
  importedFromFile?: string;
  unpriced?: boolean;
  notes: string;
  cancelReason?: string;
  deletedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentAttachment {
  id: string;
  parentType: 'bc_recu' | 'bc_emis';
  parentId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  dataUrl: string;
  createdAt: string;
}

export type ProformaStatus =
  | 'brouillon'
  | 'envoye'
  | 'accepte'
  | 'refuse'
  | 'expire'
  | 'facture';

export interface Proforma {
  id: string;
  proformaNumber: string; // Ex: 'PF N°001/26'
  companyProfileId?: string;
  issuerSnapshot?: Partial<CompanyProfile>;
  clientId: string;
  clientSnapshot?: ClientFiscalSnapshot;
  issueDate: string;
  validityDays: number;
  validUntil: string;
  paymentConditions: string;
  deliveryDelay: string;
  bcNumber: string;
  linkedBcRecuId?: string;
  campaignId?: string;
  campaignRef: string;
  campaignStartDate?: string;
  campaignEndDate?: string;
  showCampaignOnPrint?: boolean;
  currency: string;
  exchangeRate: number;
  description: string;
  lines: InvoiceLine[];
  totalHtCentimes: number;
  totalTvaCentimes: number;
  totalTtcCentimes: number;
  baseDzdTtcCentimes: number;
  status: ProformaStatus;
  convertedInvoiceId?: string;
  amountInWordsOverride?: string;
  notes: string;
  cancelReason?: string;
  deletedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Payment {
  id: string;
  direction: 'entrant' | 'sortant';
  contactId: string;
  date: string;
  amountCentimes: number;
  currency: string;
  exchangeRate: number;
  baseDzdAmountCentimes: number;
  method: PaymentMethod;
  bankAccountId: string | null; // null = Caisse espèces
  chequeId?: string;
  reference: string;
  notes: string;
  isAdvance: boolean;
  status: 'valide' | 'annule';
  cancelReason?: string;
  cancelledAt?: string;
  deletedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentAllocation {
  id: string;
  paymentId: string;
  invoiceType: 'client' | 'fournisseur';
  invoiceId: string;
  amountCentimes: number;
  deletedInvoiceLabel?: string; // Ex: 'Facture supprimée' si facture placée en corbeille/supprimée
  createdAt: string;
}

export interface ExpenseCategory {
  id: string;
  name: string;
  color: string;
  isDefault: boolean;
  createdAt: string;
}

export interface Expense {
  id: string;
  date: string;
  beneficiary: string;
  contactId?: string;
  categoryId: string;
  categoryName: string;
  description: string;
  amountCentimes: number;
  currency: string;
  exchangeRate: number;
  baseDzdAmountCentimes: number;
  paymentMethod: PaymentMethod;
  bankAccountId: string | null;
  chequeLeafId?: string;
  outgoingChequeId?: string;
  reference: string;
  notes: string;
  status: 'valide' | 'annule';
  cancelReason?: string;
  cancelledAt?: string;
  deletedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface IncomingCheque {
  id: string;
  clientId: string;
  issuerBank: string;
  chequeNumber: string; // Texte avec zéros initiaux
  chequeDate: string;
  entryDate: string;
  amountCentimes: number;
  currency: string;
  exchangeRate: number;
  baseDzdAmountCentimes: number;
  targetBankAccountId: string | null;
  depositDate?: string;
  clearingDate?: string;
  status: IncomingChequeStatus;
  linkedPaymentId?: string;
  allocatedInvoiceIds: string[];
  notes: string;
  cancelReason?: string;
  cancelledAt?: string;
  deletedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface OutgoingCheque {
  id: string;
  bankAccountId: string;
  chequeBookId: string;
  chequeLeafId: string;
  chequeNumber: string;
  beneficiary: string;
  contactId?: string;
  issueDate: string;
  amountCentimes: number;
  currency: string;
  exchangeRate: number;
  baseDzdAmountCentimes: number;
  purpose: string;
  linkedType: 'fournisseur_facture' | 'depense' | 'paiement' | 'autre';
  linkedId?: string;
  clearingDate?: string;
  status: OutgoingChequeStatus;
  notes: string;
  cancelReason?: string;
  cancelledAt?: string;
  deletedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type LedgerSourceType =
  | 'paiement_client'
  | 'paiement_fournisseur'
  | 'depense'
  | 'cheque_recu_encaisse'
  | 'cheque_emis_encaisse'
  | 'solde_ouverture';

export interface LedgerEntry {
  id: string;
  date: string;
  direction: 'entree' | 'sortie';
  sourceType: LedgerSourceType;
  sourceId: string;
  bankAccountId: string | null; // null = Caisse espèces
  contactId?: string;
  label: string;
  amountCentimes: number; // Toujours positif, le sens est porté par direction
  currency: string;
  exchangeRate: number;
  baseDzdAmountCentimes: number;
  status: 'valide' | 'annule';
  createdAt: string;
}

export type AuditAction =
  | 'CREATION'
  | 'MODIFICATION'
  | 'ANNULATION'
  | 'SUPPRESSION'
  | 'RESTAURATION'
  | 'ENCAISSEMENT'
  | 'SAUVEGARDE'
  | 'IMPORT';

export interface AuditLog {
  id: string;
  timestamp: string;
  actor: string;
  action: AuditAction;
  entityType: string;
  entityId: string;
  summary: string;
  beforeJson?: string;
  afterJson?: string;
  reason?: string;
}
