import React, { useEffect, useState } from 'react';
import {
  Building2,
  CheckCircle2,
  Database,
  Download,
  Edit3,
  FolderOpen,
  History,
  Plus,
  Printer,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldCheck,
  Star,
  Trash2,
  Upload,
} from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { DEVELOPER_BRAND } from '../constants/branding';
import {
  buildDefaultGravurePubProfile,
  buildDefaultVistaDigitalProfile,
  COLOR_PRESETS,
  GRAVURE_PUB_PROFILE_ID,
  VISTA_DIGITAL_PROFILE_ID,
} from '../constants/companyPresets';
import { db, DEFAULT_PRINT_SETTINGS, ensureDatabaseInitialized, recordAudit } from '../db/database';
import type {
  CompanyProfile,
  CurrencyConfig,
  PrintMarginMode,
  PrintOrientation,
  PrintPaperSize,
  PrintSettings,
} from '../db/types';
import { DEFAULT_OUTDOOR_CATALOG, getEffectiveOutdoorCatalog } from '../utils/guidedLineHelpers';
import {
  exportFullBackupJson,
  restoreFromBackupJson,
  triggerBrowserJsonDownload,
  verifyAndParseBackupJson,
} from '../services/backup';
import { clearDemoData, loadDemoData } from '../services/demoData';
import { saveCompanyProfile, setActiveCompanyProfile } from '../services/documentActions';
import {
  listAllTrashItems,
  permanentlyDeleteFromTrash,
  restoreFromTrash,
  type TrashItemSummary,
} from '../services/trashService';
import { useAppStore } from '../store/useAppStore';
import type { ElectronBackupFile, ElectronPrinterInfo } from '../types/electron';
import { buildPrintTestHtml, printWithSettings } from '../utils/print';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { SafeDeleteDialog } from '../components/SafeDeleteDialog';
import { useUiMode } from '../hooks/useUiMode';

type SettingsTab =
  | 'entreprise'
  | 'societes'
  | 'fiscalite'
  | 'impression'
  | 'sauvegardes'
  | 'corbeille'
  | 'donnees';

export const SettingsPage: React.FC = () => {
  const { isSimple } = useUiMode();
  const settings = useLiveQuery(() => db.settings.get('company_settings'));
  const companyProfiles = useLiveQuery(
    () => db.companyProfiles.filter((p) => !p.deletedAt).toArray(),
    [],
    []
  );
  const auditLogs = useLiveQuery(() =>
    db.auditLogs.orderBy('timestamp').reverse().limit(100).toArray()
  );
  const pushToast = useAppStore((s) => s.pushToast);

  const [activeTab, setActiveTab] = useState<SettingsTab>('entreprise');

  // Formulaire Entreprise active
  const [companyName, setCompanyName] = useState('');
  const [logoDataUrl, setLogoDataUrl] = useState('');
  const [address, setAddress] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [nif, setNif] = useState('');
  const [nis, setNis] = useState('');
  const [rc, setRc] = useState('');
  const [ai, setAi] = useState('');
  const [developerBrand, setDeveloperBrand] = useState('');

  // Gestion multi-sociétés ("Mes sociétés")
  const [editingProfileId, setEditingProfileId] = useState<string | undefined>(undefined);
  const [profileFormOpen, setProfileFormOpen] = useState(false);
  const [pName, setPName] = useState('');
  const [pLogo, setPLogo] = useState('');
  const [pSignature, setPSignature] = useState('');
  const [pSignatureLabel, setPSignatureLabel] = useState('SERVICE COMMERCIAL');
  const [pAddress, setPAddress] = useState('');
  const [pPostalCode, setPPostalCode] = useState('');
  const [pCity, setPCity] = useState('');
  const [pPhone, setPPhone] = useState('');
  const [pFax, setPFax] = useState('');
  const [pEmail, setPEmail] = useState('');
  const [pNif, setPNif] = useState('');
  const [pNis, setPNis] = useState('');
  const [pRc, setPRc] = useState('');
  const [pAi, setPAi] = useState('');
  const [pRib, setPRib] = useState('');
  const [pBankInfo, setPBankInfo] = useState('');
  const [pPrimaryColor, setPPrimaryColor] = useState('#FF33CC');
  const [pAccentColor, setPAccentColor] = useState('#6B2FA0');
  const [pFooterNote, setPFooterNote] = useState('');
  const [pApplyThemeToApp, setPApplyThemeToApp] = useState(true);
  const [pIsDefault, setPIsDefault] = useState(false);
  const [deleteProfileTarget, setDeleteProfileTarget] = useState<{
    id: string;
    label: string;
  } | null>(null);

  // Corbeille
  const [trashItems, setTrashItems] = useState<TrashItemSummary[]>([]);
  const [permDeleteTarget, setPermDeleteTarget] = useState<TrashItemSummary | null>(null);

  // Fiscalité & Devises
  const [defaultCurrency, setDefaultCurrency] = useState('DZD');
  const [currencies, setCurrencies] = useState<CurrencyConfig[]>([]);
  const [defaultTvaRate, setDefaultTvaRate] = useState('19');
  const [invoicePrefix, setInvoicePrefix] = useState('FAC-');
  const [invoiceNextSeq, setInvoiceNextSeq] = useState('1');
  const [supplierInvoicePrefix, setSupplierInvoicePrefix] = useState('FF-');
  const [supplierInvoiceNextSeq, setSupplierInvoiceNextSeq] = useState('1');
  const [newCurrCode, setNewCurrCode] = useState('');
  const [newCurrName, setNewCurrName] = useState('');
  const [newCurrSymbol, setNewCurrSymbol] = useState('');
  const [newCurrRate, setNewCurrRate] = useState('1');

  // Sauvegardes
  const [backupFolder, setBackupFolder] = useState('');
  const [electronBackups, setElectronBackups] = useState<ElectronBackupFile[]>([]);
  const [pendingRestoreJson, setPendingRestoreJson] = useState<string | null>(null);
  const [pendingRestoreInfo, setPendingRestoreInfo] = useState<{
    companyName: string;
    exportedAt: string;
    recordCount: number;
  } | null>(null);

  // Catalogue saisie guidée
  const [catServices, setCatServices] = useState('');
  const [catPanels, setCatPanels] = useState('');
  const [catFaces, setCatFaces] = useState('');
  const [catLocations, setCatLocations] = useState('');

  // Réglages d'impression
  const [printPrinterName, setPrintPrinterName] = useState(DEFAULT_PRINT_SETTINGS.defaultPrinterName);
  const [printPaperSize, setPrintPaperSize] = useState<PrintPaperSize>(DEFAULT_PRINT_SETTINGS.paperSize);
  const [printOrientation, setPrintOrientation] = useState<PrintOrientation>(DEFAULT_PRINT_SETTINGS.orientation);
  const [printMargins, setPrintMargins] = useState<PrintMarginMode>(DEFAULT_PRINT_SETTINGS.margins);
  const [printColor, setPrintColor] = useState(DEFAULT_PRINT_SETTINGS.color);
  const [printCopies, setPrintCopies] = useState(String(DEFAULT_PRINT_SETTINGS.copies));
  const [printFitToPage, setPrintFitToPage] = useState(DEFAULT_PRINT_SETTINGS.fitToPage);
  const [printPreviewBefore, setPrintPreviewBefore] = useState(DEFAULT_PRINT_SETTINGS.previewBeforePrint);
  const [printSilent, setPrintSilent] = useState(DEFAULT_PRINT_SETTINGS.silentPrint);
  const [systemPrinters, setSystemPrinters] = useState<ElectronPrinterInfo[]>([]);
  const [loadingPrinters, setLoadingPrinters] = useState(false);

  // Confirmations
  const [confirmClearDemo, setConfirmClearDemo] = useState(false);

  useEffect(() => {
    if (!settings) return;
    setCompanyName(settings.companyName);
    setLogoDataUrl(settings.logoDataUrl);
    setAddress(settings.address);
    setPhone(settings.phone);
    setEmail(settings.email);
    setNif(settings.nif);
    setNis(settings.nis);
    setRc(settings.rc);
    setAi(settings.ai);
    setDeveloperBrand(DEVELOPER_BRAND);
    setDefaultCurrency(settings.defaultCurrency);
    setCurrencies(settings.enabledCurrencies);
    setDefaultTvaRate(String(settings.defaultTvaRate));
    setInvoicePrefix(settings.invoicePrefix);
    setInvoiceNextSeq(String(settings.invoiceNextSeq));
    setSupplierInvoicePrefix(settings.supplierInvoicePrefix);
    setSupplierInvoiceNextSeq(String(settings.supplierInvoiceNextSeq));
    setBackupFolder(settings.backupFolder);
    const cat = getEffectiveOutdoorCatalog(settings);
    setCatServices(cat.serviceTypes.join('\n'));
    setCatPanels(cat.panelTypes.join('\n'));
    setCatFaces(cat.faces.join('\n'));
    setCatLocations(cat.locations.join('\n'));
    const ps = settings.printSettings ?? DEFAULT_PRINT_SETTINGS;
    setPrintPrinterName(ps.defaultPrinterName || '');
    setPrintPaperSize(ps.paperSize || 'A4');
    setPrintOrientation(ps.orientation || 'portrait');
    setPrintMargins(ps.margins || 'none');
    setPrintColor(ps.color !== false);
    setPrintCopies(String(ps.copies || 1));
    setPrintFitToPage(ps.fitToPage !== false);
    setPrintPreviewBefore(ps.previewBeforePrint !== false);
    setPrintSilent(Boolean(ps.silentPrint));
  }, [settings]);

  const refreshSystemPrinters = async () => {
    if (!window.electronAPI?.getPrinters) return;
    setLoadingPrinters(true);
    try {
      const res = await window.electronAPI.getPrinters();
      if (res.ok && Array.isArray(res.printers)) {
        setSystemPrinters(res.printers);
      }
    } finally {
      setLoadingPrinters(false);
    }
  };

  const refreshElectronBackups = async (folder?: string) => {
    if (!window.electronAPI?.isElectron) return;
    const res = await window.electronAPI.listBackups(folder ?? backupFolder);
    if (res.ok) {
      setElectronBackups(res.backups || []);
      if (!backupFolder && res.directory) {
        setBackupFolder(res.directory);
      }
    }
  };

  const refreshTrash = async () => {
    const list = await listAllTrashItems();
    setTrashItems(list);
  };

  useEffect(() => {
    if (activeTab === 'sauvegardes' && window.electronAPI?.isElectron) {
      refreshElectronBackups();
    }
    if (activeTab === 'impression' && window.electronAPI?.isElectron) {
      refreshSystemPrinters();
    }
    if (activeTab === 'corbeille') {
      refreshTrash();
    }
  }, [activeTab]);

  if (!settings) {
    return <div className="p-6 text-sm text-slate-500">Chargement des paramètres...</div>;
  }

  const handleSaveCompany = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!companyName.trim()) {
      pushToast({ type: 'error', title: 'Champ obligatoire', message: 'Le nom de l’entreprise est requis.' });
      return;
    }
    const before = { companyName: settings.companyName, nif: settings.nif, rc: settings.rc };
    await db.settings.update('company_settings', {
      companyName: companyName.trim(),
      logoDataUrl,
      address: address.trim(),
      phone: phone.trim(),
      email: email.trim(),
      nif: nif.trim(),
      nis: nis.trim(),
      rc: rc.trim(),
      ai: ai.trim(),
      developerBrand: DEVELOPER_BRAND,
      updatedAt: new Date().toISOString(),
    });
    await recordAudit({
      action: 'MODIFICATION',
      entityType: 'parametres',
      entityId: 'entreprise',
      summary: `Mise à jour des informations de l’entreprise (${companyName.trim()})`,
      before,
      after: { companyName: companyName.trim(), nif: nif.trim(), rc: rc.trim() },
    });
    pushToast({ type: 'success', title: 'Paramètres enregistrés' });
  };

  const parseCatalogLines = (raw: string): string[] =>
    Array.from(
      new Set(
        raw
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
      )
    );

  const handleSaveCatalog = async (e: React.FormEvent) => {
    e.preventDefault();
    const nextCatalog = {
      serviceTypes: parseCatalogLines(catServices),
      panelTypes: parseCatalogLines(catPanels),
      faces: parseCatalogLines(catFaces),
      locations: parseCatalogLines(catLocations),
    };
    await db.settings.update('company_settings', {
      outdoorCatalog: nextCatalog,
      updatedAt: new Date().toISOString(),
    });
    await recordAudit({
      action: 'MODIFICATION',
      entityType: 'parametres',
      entityId: 'catalogue_publicite',
      summary: 'Mise à jour du catalogue de saisie guidée (prestations, formats, emplacements)',
    });
    pushToast({
      type: 'success',
      title: 'Catalogue enregistré',
      message: 'Vos listes personnalisées sont immédiatement actives dans les factures, proformas et BC.',
    });
  };

  const handleResetCatalog = async () => {
    setCatServices(DEFAULT_OUTDOOR_CATALOG.serviceTypes.join('\n'));
    setCatPanels(DEFAULT_OUTDOOR_CATALOG.panelTypes.join('\n'));
    setCatFaces(DEFAULT_OUTDOOR_CATALOG.faces.join('\n'));
    setCatLocations(DEFAULT_OUTDOOR_CATALOG.locations.join('\n'));
    await db.settings.update('company_settings', {
      outdoorCatalog: DEFAULT_OUTDOOR_CATALOG,
      updatedAt: new Date().toISOString(),
    });
    pushToast({ type: 'info', title: 'Catalogue réinitialisé par défaut' });
  };

  const handleLogoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 1024 * 1024 * 2) {
      pushToast({ type: 'error', title: 'Fichier trop volumineux', message: 'Taille maximale : 2 Mo.' });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setLogoDataUrl(reader.result);
      }
    };
    reader.readAsDataURL(file);
  };

  const openProfileForm = (prof?: CompanyProfile) => {
    setEditingProfileId(prof?.id);
    setPName(prof?.name || '');
    setPLogo(prof?.logoDataUrl || '');
    setPSignature(prof?.signatureDataUrl || '');
    setPSignatureLabel(prof?.signatureLabel || 'SERVICE COMMERCIAL');
    setPAddress(prof?.address || '');
    setPPostalCode(prof?.postalCode || '');
    setPCity(prof?.city || '');
    setPPhone(prof?.phone || '');
    setPFax(prof?.fax || '');
    setPEmail(prof?.email || '');
    setPNif(prof?.nif || '');
    setPNis(prof?.nis || '');
    setPRc(prof?.rc || '');
    setPAi(prof?.ai || '');
    setPRib(prof?.rib || '');
    setPBankInfo(prof?.bankInfo || '');
    setPPrimaryColor(prof?.primaryColor || '#FF33CC');
    setPAccentColor(prof?.accentColor || '#6B2FA0');
    setPFooterNote(prof?.footerNote || '');
    setPApplyThemeToApp(prof?.applyThemeToApp ?? true);
    setPIsDefault(Boolean(prof?.isDefault));
    setProfileFormOpen(true);
  };

  const handleProfileImageUpload = (
    e: React.ChangeEvent<HTMLInputElement>,
    setter: (dataUrl: string) => void
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 1024 * 1024 * 2) {
      pushToast({ type: 'error', title: 'Fichier trop volumineux', message: 'Taille maximale : 2 Mo.' });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') setter(reader.result);
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const handleResetProfileColors = () => {
    if (editingProfileId === GRAVURE_PUB_PROFILE_ID) {
      const def = buildDefaultGravurePubProfile();
      setPPrimaryColor(def.primaryColor);
      setPAccentColor(def.accentColor);
    } else if (editingProfileId === VISTA_DIGITAL_PROFILE_ID) {
      const def = buildDefaultVistaDigitalProfile();
      setPPrimaryColor(def.primaryColor);
      setPAccentColor(def.accentColor);
    } else {
      setPPrimaryColor('#FF33CC');
      setPAccentColor('#6B2FA0');
    }
  };

  const handleSaveProfileForm = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const saved = await saveCompanyProfile({
        existingId: editingProfileId,
        name: pName,
        logoDataUrl: pLogo,
        signatureDataUrl: pSignature,
        signatureLabel: pSignatureLabel,
        address: pAddress,
        postalCode: pPostalCode,
        city: pCity,
        phone: pPhone,
        fax: pFax,
        email: pEmail,
        nif: pNif,
        nis: pNis,
        rc: pRc,
        ai: pAi,
        rib: pRib,
        bankInfo: pBankInfo,
        primaryColor: pPrimaryColor,
        accentColor: pAccentColor,
        footerNote: pFooterNote,
        applyThemeToApp: pApplyThemeToApp,
        isDefault: pIsDefault || companyProfiles.length === 0,
      });
      setProfileFormOpen(false);
      pushToast({
        type: 'success',
        title: editingProfileId ? 'Société mise à jour' : 'Société ajoutée',
        message: saved.name,
      });
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Erreur',
        message: err instanceof Error ? err.message : 'Erreur',
      });
    }
  };

  const handleRestoreTrashItem = async (item: TrashItemSummary) => {
    await restoreFromTrash(item.entityType, item.id);
    await refreshTrash();
    pushToast({
      type: 'success',
      title: 'Élément restauré',
      message: `${item.typeLabel} : ${item.title}`,
    });
  };

  const handlePermanentDeleteConfirm = async () => {
    if (!permDeleteTarget) return;
    const target = permDeleteTarget;
    setPermDeleteTarget(null);
    await permanentlyDeleteFromTrash(target.entityType, target.id);
    await refreshTrash();
    pushToast({
      type: 'info',
      title: 'Supprimé définitivement',
      message: target.title,
    });
  };

  const handleSaveFiscal = async (e: React.FormEvent) => {
    e.preventDefault();
    const tva = Number(defaultTvaRate.replace(',', '.'));
    const nextSeq = parseInt(invoiceNextSeq, 10);
    const nextSupSeq = parseInt(supplierInvoiceNextSeq, 10);

    if (!Number.isFinite(tva) || tva < 0 || tva > 100) {
      pushToast({ type: 'error', title: 'TVA invalide', message: 'Le taux de TVA doit être entre 0 et 100 %.' });
      return;
    }
    if (!Number.isInteger(nextSeq) || nextSeq < 1 || !Number.isInteger(nextSupSeq) || nextSupSeq < 1) {
      pushToast({
        type: 'error',
        title: 'Séquence invalide',
        message: 'Les numéros de séquence doivent être des entiers positifs.',
      });
      return;
    }

    await db.settings.update('company_settings', {
      defaultCurrency,
      enabledCurrencies: currencies.map((c) =>
        c.code === defaultCurrency ? { ...c, enabled: true, rateToDzd: c.code === 'DZD' ? 1 : c.rateToDzd } : c
      ),
      defaultTvaRate: tva,
      invoicePrefix: invoicePrefix.trim() || 'FAC-',
      invoiceNextSeq: nextSeq,
      supplierInvoicePrefix: supplierInvoicePrefix.trim() || 'FF-',
      supplierInvoiceNextSeq: nextSupSeq,
      updatedAt: new Date().toISOString(),
    });

    await recordAudit({
      action: 'MODIFICATION',
      entityType: 'parametres',
      entityId: 'fiscalite',
      summary: `Mise à jour TVA (${tva}%), devise (${defaultCurrency}) et numérotation`,
    });

    pushToast({ type: 'success', title: 'Paramètres fiscaux et devises enregistrés' });
  };

  const handleAddCurrency = () => {
    const code = newCurrCode.trim().toUpperCase();
    const name = newCurrName.trim();
    const symbol = newCurrSymbol.trim() || code;
    const rate = Number(newCurrRate.replace(',', '.'));

    if (!/^[A-Z]{3}$/.test(code)) {
      pushToast({ type: 'error', title: 'Code devise invalide', message: 'Utilisez un code ISO à 3 lettres (ex: MAD, TND, CHF).' });
      return;
    }
    if (!name) {
      pushToast({ type: 'error', title: 'Nom requis', message: 'Indiquez le nom de la devise.' });
      return;
    }
    if (!Number.isFinite(rate) || rate <= 0) {
      pushToast({ type: 'error', title: 'Taux invalide', message: 'Le taux indicatif vers DZD doit être supérieur à 0.' });
      return;
    }
    if (currencies.some((c) => c.code === code)) {
      pushToast({ type: 'error', title: 'Devise existante', message: `La devise ${code} existe déjà.` });
      return;
    }

    setCurrencies((prev) => [...prev, { code, name, symbol, rateToDzd: rate, enabled: true }]);
    setNewCurrCode('');
    setNewCurrName('');
    setNewCurrSymbol('');
    setNewCurrRate('1');
  };

  const handleExportBackup = async () => {
    try {
      const { json } = await exportFullBackupJson();
      const stamp = new Date().toISOString().slice(0, 10);

      if (window.electronAPI?.isElectron) {
        const res = await window.electronAPI.saveBackup(json, 'manual', backupFolder);
        if (!res.ok) {
          pushToast({ type: 'error', title: 'Échec de la sauvegarde', message: res.error });
          return;
        }
        await refreshElectronBackups();
        pushToast({
          type: 'success',
          title: 'Sauvegarde enregistrée',
          message: res.fileName || 'Fichier JSON écrit sur le disque.',
        });
      } else {
        triggerBrowserJsonDownload(json, `gestion-financiere-sauvegarde-${stamp}.json`);
        pushToast({
          type: 'success',
          title: 'Sauvegarde téléchargée',
          message: `Fichier gestion-financiere-sauvegarde-${stamp}.json généré.`,
        });
      }

      await recordAudit({
        action: 'SAUVEGARDE',
        entityType: 'systeme',
        entityId: 'manual_backup',
        summary: 'Sauvegarde manuelle complète exportée',
      });
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Erreur lors de la sauvegarde',
        message: err instanceof Error ? err.message : 'Erreur inconnue.',
      });
    }
  };

  const prepareRestoreFromText = async (raw: string) => {
    const check = await verifyAndParseBackupJson(raw);
    if (!check.valid || !check.pkg) {
      pushToast({ type: 'error', title: 'Fichier de sauvegarde invalide', message: check.error });
      return;
    }
    setPendingRestoreJson(raw);
    setPendingRestoreInfo({
      companyName: check.pkg.companyName,
      exportedAt: check.pkg.exportedAt,
      recordCount: check.pkg.recordCount,
    });
  };

  const handleBrowserFileRestore = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      if (typeof reader.result === 'string') {
        await prepareRestoreFromText(reader.result);
      }
    };
    reader.readAsText(file, 'utf-8');
    e.target.value = '';
  };

  const handleElectronRestorePick = async (filePath = '') => {
    if (!window.electronAPI?.restoreBackup) return;
    const res = await window.electronAPI.restoreBackup(filePath);
    if (res.canceled) return;
    if (!res.ok || !res.jsonContent) {
      pushToast({ type: 'error', title: 'Lecture impossible', message: res.error });
      return;
    }
    await prepareRestoreFromText(res.jsonContent);
  };

  const confirmRestore = async () => {
    if (!pendingRestoreJson) return;
    const res = await restoreFromBackupJson(pendingRestoreJson);
    setPendingRestoreJson(null);
    setPendingRestoreInfo(null);
    if (!res.ok) {
      pushToast({ type: 'error', title: 'Restauration annulée', message: res.error });
      return;
    }
    await ensureDatabaseInitialized();
    pushToast({
      type: 'success',
      title: 'Restauration réussie',
      message: `${res.recordCount} enregistrements restaurés (${res.companyName}).`,
    });
  };

  const handleSelectBackupFolder = async () => {
    if (!window.electronAPI?.selectFolder) return;
    const res = await window.electronAPI.selectFolder(backupFolder);
    if (res.ok && res.directory) {
      setBackupFolder(res.directory);
      await db.settings.update('company_settings', {
        backupFolder: res.directory,
        updatedAt: new Date().toISOString(),
      });
      await refreshElectronBackups(res.directory);
      pushToast({ type: 'success', title: 'Dossier de sauvegarde mis à jour', message: res.directory });
    }
  };

  const handleLoadDemo = async () => {
    await loadDemoData();
    pushToast({
      type: 'success',
      title: 'Données de démonstration chargées',
      message: 'Des données fictives algériennes ont été ajoutées pour tester l’application.',
    });
  };

  const handleClearDemo = async () => {
    setConfirmClearDemo(false);
    await clearDemoData();
    pushToast({
      type: 'info',
      title: 'Données de démonstration supprimées',
      message: 'Seules les données réelles saisies par votre entreprise sont conservées.',
    });
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      {/* Onglets */}
      <div className="flex flex-wrap items-center gap-1 rounded-lg border border-slate-200 bg-white p-1">
        {(
          [
            { id: 'entreprise' as const, label: 'Entreprise & Logo', icon: Building2 },
            { id: 'societes' as const, label: `Mes sociétés (${companyProfiles.length})`, icon: Star },
            { id: 'fiscalite' as const, label: isSimple ? 'TVA & Numérotation' : 'Devises, TVA & Numérotation', icon: ShieldCheck },
            { id: 'impression' as const, label: 'Impression', icon: Printer },
            { id: 'sauvegardes' as const, label: 'Sauvegardes & Restauration', icon: Database },
            { id: 'corbeille' as const, label: 'Corbeille', icon: Trash2 },
            { id: 'donnees' as const, label: isSimple ? 'Données démo' : 'Données démo & Journal d’audit', icon: History },
          ]
        ).map((tab) => {
          const Icon = tab.icon;
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`inline-flex items-center gap-2 rounded-md px-3.5 py-2 text-xs font-medium transition-colors whitespace-nowrap ${
                active ? 'bg-[#0F1E36] text-white' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
              }`}
            >
              <Icon className="h-4 w-4" />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* Onglet 1 : Entreprise */}
      {activeTab === 'entreprise' && (
        <form onSubmit={handleSaveCompany} className="rounded-lg border border-slate-200 bg-white p-6 space-y-6">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Identité de l’entreprise</h2>
            <p className="mt-1 text-sm text-slate-500">
              Aucune donnée n’est figée dans le logiciel : modifiez ces champs à tout moment.
            </p>
          </div>

          <div className="flex items-center gap-5 rounded-lg border border-slate-200 bg-slate-50 p-4">
            {logoDataUrl ? (
              <img
                src={logoDataUrl}
                alt="Logo entreprise"
                className="h-16 w-16 rounded border border-slate-200 bg-white object-contain p-1"
              />
            ) : (
              <div className="flex h-16 w-16 items-center justify-center rounded border border-dashed border-slate-300 bg-white text-slate-400">
                <Building2 className="h-7 w-7" />
              </div>
            )}
            <div className="space-y-1.5">
              <div className="text-sm font-medium text-slate-800">Logo officiel (affiché sur factures et PDF)</div>
              <div className="flex items-center gap-3">
                <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100">
                  <Upload className="h-3.5 w-3.5" />
                  <span>Importer une image</span>
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/svg+xml"
                    onChange={handleLogoUpload}
                    className="hidden"
                  />
                </label>
                {logoDataUrl && (
                  <button
                    type="button"
                    onClick={() => setLogoDataUrl('')}
                    className="text-xs font-medium text-red-600 hover:underline"
                  >
                    Supprimer le logo
                  </button>
                )}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-slate-700">Nom / Raison sociale *</label>
              <input
                type="text"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700">Téléphone</label>
              <input
                type="text"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-slate-700">Adresse complète</label>
              <input
                type="text"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700">NIF</label>
              <input
                type="text"
                value={nif}
                onChange={(e) => setNif(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm tabular-nums"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700">NIS</label>
              <input
                type="text"
                value={nis}
                onChange={(e) => setNis(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm tabular-nums"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700">Registre de Commerce (RC)</label>
              <input
                type="text"
                value={rc}
                onChange={(e) => setRc(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700">Article d’imposition (AI)</label>
              <input
                type="text"
                value={ai}
                onChange={(e) => setAi(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm tabular-nums"
              />
            </div>
            {settings.uiMode === 'avance' && (
              <div className="sm:col-span-2">
                <label className="block text-sm font-medium text-slate-700">
                  Marque éditeur affichée en pied de page
                </label>
                <input
                  type="text"
                  value={developerBrand}
                  onChange={(e) => setDeveloperBrand(e.target.value)}
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
            )}
          </div>

          <div className="flex justify-end border-t border-slate-200 pt-4">
            <button
              type="submit"
              className="inline-flex items-center gap-2 rounded-md bg-[#0F1E36] px-5 py-2 text-sm font-medium text-white hover:bg-[#1a2f52]"
            >
              <Save className="h-4 w-4" />
              <span>Enregistrer les informations</span>
            </button>
          </div>
        </form>
      )}

      {activeTab === 'entreprise' && (
        <form onSubmit={handleSaveCatalog} className="rounded-lg border border-slate-200 bg-white p-6 space-y-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Catalogue des prestations publicitaires (Saisie guidée)
              </h2>
              <p className="mt-1 text-xs text-slate-500">
                Personnalisez les listes suggérées lors de la saisie guidée sur vos factures, proformas et bons de commande (une entrée par ligne).
              </p>
            </div>
            <button
              type="button"
              onClick={handleResetCatalog}
              className="inline-flex items-center gap-1.5 rounded border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span>Valeurs par défaut</span>
            </button>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-medium text-slate-700">
                Types de prestation
              </label>
              <textarea
                rows={5}
                value={catServices}
                onChange={(e) => setCatServices(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-xs leading-relaxed"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700">
                Supports & Formats (ex : Unipol 12×4 m)
              </label>
              <textarea
                rows={5}
                value={catPanels}
                onChange={(e) => setCatPanels(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-xs leading-relaxed"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700">
                Emplacements / Villes fréquents
              </label>
              <textarea
                rows={4}
                value={catLocations}
                onChange={(e) => setCatLocations(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-xs leading-relaxed"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700">Faces</label>
              <textarea
                rows={4}
                value={catFaces}
                onChange={(e) => setCatFaces(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-xs leading-relaxed"
              />
            </div>
          </div>

          <div className="flex justify-end border-t border-slate-200 pt-4">
            <button
              type="submit"
              className="inline-flex items-center gap-2 rounded-md bg-[#0F1E36] px-5 py-2 text-sm font-medium text-white hover:bg-[#1a2f52]"
            >
              <Save className="h-4 w-4" />
              <span>Enregistrer le catalogue</span>
            </button>
          </div>
        </form>
      )}

      {/* Onglet : Mes sociétés (multi-profils d'en-tête PDF/factures) */}
      {activeTab === 'societes' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white p-5">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Profils d’entités / Mes sociétés
              </h2>
              <p className="mt-0.5 text-xs text-slate-500">
                Configurez vos sociétés (SARL VISTA DIGITAL, SARL GRAVURE PUB, etc.) : logo, cachet, couleurs du modèle facture, coordonnées bancaires et fiscalité.
              </p>
            </div>
            <button
              type="button"
              onClick={() => openProfileForm()}
              className="inline-flex items-center gap-2 rounded-md bg-[#0F1E36] px-4 py-2 text-sm font-medium text-white hover:bg-[#1a2f52]"
            >
              <Plus className="h-4 w-4" />
              <span>Ajouter une société</span>
            </button>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {companyProfiles.map((prof) => {
              const isActive =
                settings.activeCompanyProfileId === prof.id ||
                (!settings.activeCompanyProfileId && prof.isDefault);
              return (
                <div
                  key={prof.id}
                  className={`rounded-lg border p-5 space-y-3 bg-white ${
                    isActive ? 'ring-2 ring-offset-1' : 'border-slate-200'
                  }`}
                  style={isActive ? { borderColor: prof.accentColor || '#6B2FA0' } : undefined}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3">
                      {prof.logoDataUrl ? (
                        <img
                          src={prof.logoDataUrl}
                          alt={prof.name}
                          className="h-12 w-20 rounded border border-slate-200 object-contain p-1 bg-white"
                        />
                      ) : (
                        <div className="flex h-12 w-16 items-center justify-center rounded border border-slate-200 bg-slate-50 text-slate-400">
                          <Building2 className="h-5 w-5" />
                        </div>
                      )}
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-sm font-bold text-slate-900">{prof.name}</h3>
                          {isActive && (
                            <span
                              className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-semibold text-white"
                              style={{ backgroundColor: prof.accentColor || '#6B2FA0' }}
                            >
                              <CheckCircle2 className="h-3 w-3" />
                              Société active
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 text-xs text-slate-600">
                          {prof.address || 'Adresse non renseignée'}
                        </div>
                        <div className="mt-1 text-[11px] text-slate-500">
                          {[
                            prof.nif ? `NIF: ${prof.nif}` : '',
                            prof.rc ? `RC: ${prof.rc}` : '',
                            prof.ai ? `AI: ${prof.ai}` : '',
                          ]
                            .filter(Boolean)
                            .join(' · ') || 'Identifiants fiscaux à compléter'}
                        </div>
                        {prof.bankInfo && (
                          <div className="mt-0.5 text-[11px] text-slate-500 truncate max-w-xs" title={prof.bankInfo}>
                            {prof.bankInfo}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3">
                    <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
                      <span
                        className="inline-block h-3.5 w-3.5 rounded border border-slate-300"
                        title="Couleur principale"
                        style={{ backgroundColor: prof.primaryColor || '#FF33CC' }}
                      />
                      <span
                        className="inline-block h-3.5 w-3.5 rounded border border-slate-300"
                        title="Couleur secondaire"
                        style={{ backgroundColor: prof.accentColor || '#6B2FA0' }}
                      />
                      <span>Couleurs facture & app</span>
                    </div>

                    <div className="flex items-center gap-1.5">
                      {!isActive && (
                        <button
                          type="button"
                          onClick={async () => {
                            await setActiveCompanyProfile(prof.id);
                            pushToast({
                              type: 'success',
                              title: 'Société active modifiée',
                              message: prof.name,
                            });
                          }}
                          className="rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                        >
                          Activer
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => openProfileForm(prof)}
                        className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                      >
                        <Edit3 className="h-3 w-3" />
                        <span>Modifier</span>
                      </button>
                      {companyProfiles.length > 1 && (
                        <button
                          type="button"
                          onClick={() =>
                            setDeleteProfileTarget({ id: prof.id, label: prof.name })
                          }
                          className="rounded p-1 text-red-600 hover:bg-red-50"
                          title="Supprimer"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {profileFormOpen && (
            <form
              onSubmit={handleSaveProfileForm}
              className="rounded-lg border border-slate-200 bg-white p-6 space-y-5"
            >
              <div className="flex items-center justify-between border-b border-slate-200 pb-3">
                <h3 className="text-sm font-semibold text-slate-900">
                  {editingProfileId ? 'Modifier la société' : 'Nouvelle société'}
                </h3>
                <button
                  type="button"
                  onClick={() => setProfileFormOpen(false)}
                  className="text-xs text-slate-500 hover:text-slate-900"
                >
                  Fermer
                </button>
              </div>

              {/* Logo + Cachet/Signature */}
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="flex items-center gap-4 rounded-lg border border-slate-200 bg-slate-50 p-3.5">
                  {pLogo ? (
                    <img
                      src={pLogo}
                      alt="Logo"
                      className="h-14 w-24 rounded border border-slate-200 bg-white object-contain p-1"
                    />
                  ) : (
                    <div className="flex h-14 w-20 items-center justify-center rounded border border-dashed border-slate-300 bg-white text-slate-400">
                      <Building2 className="h-6 w-6" />
                    </div>
                  )}
                  <div className="space-y-1.5">
                    <div className="text-xs font-semibold text-slate-800">
                      Logo société (PNG, JPG, SVG)
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="inline-flex cursor-pointer items-center gap-1.5 rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100">
                        <Upload className="h-3.5 w-3.5" />
                        <span>{pLogo ? 'Changer' : 'Importer'}</span>
                        <input
                          type="file"
                          accept="image/png,image/jpeg,image/webp,image/svg+xml"
                          onChange={(e) => handleProfileImageUpload(e, setPLogo)}
                          className="hidden"
                        />
                      </label>
                      {pLogo && (
                        <button
                          type="button"
                          onClick={() => setPLogo('')}
                          className="text-xs font-medium text-red-600 hover:underline"
                        >
                          Supprimer
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-4 rounded-lg border border-slate-200 bg-slate-50 p-3.5">
                  {pSignature ? (
                    <img
                      src={pSignature}
                      alt="Cachet et signature"
                      className="h-14 w-24 rounded border border-slate-200 bg-white object-contain p-1"
                    />
                  ) : (
                    <div className="flex h-14 w-20 items-center justify-center rounded border border-dashed border-slate-300 bg-white text-[10px] text-slate-400 text-center px-1">
                      Cachet (optionnel)
                    </div>
                  )}
                  <div className="space-y-1.5">
                    <div className="text-xs font-semibold text-slate-800">
                      Cachet / signature (optionnel)
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="inline-flex cursor-pointer items-center gap-1.5 rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100">
                        <Upload className="h-3.5 w-3.5" />
                        <span>{pSignature ? 'Changer' : 'Importer'}</span>
                        <input
                          type="file"
                          accept="image/png,image/jpeg,image/webp,image/svg+xml"
                          onChange={(e) => handleProfileImageUpload(e, setPSignature)}
                          className="hidden"
                        />
                      </label>
                      {pSignature && (
                        <button
                          type="button"
                          onClick={() => setPSignature('')}
                          className="text-xs font-medium text-red-600 hover:underline"
                        >
                          Supprimer
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* Palette couleurs & prévisualisation en direct */}
              <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-xs font-semibold text-slate-800">
                      Charte graphique & Couleurs du document PDF
                    </div>
                    <div className="text-[11px] text-slate-500">
                      Choisissez vos couleurs personnalisées ou appliquez une palette prête à l’emploi.
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleResetProfileColors}
                    className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
                  >
                    <RotateCcw className="h-3 w-3" />
                    <span>Réinitialiser les couleurs</span>
                  </button>
                </div>

                <div className="flex flex-wrap items-center gap-5">
                  <div>
                    <label className="block text-xs font-medium text-slate-700">
                      Couleur principale (titre, total TTC, labels)
                    </label>
                    <div className="mt-1 flex items-center gap-2">
                      <input
                        type="color"
                        value={pPrimaryColor}
                        onChange={(e) => setPPrimaryColor(e.target.value)}
                        className="h-9 w-14 cursor-pointer rounded border border-slate-300 p-0.5 bg-white"
                      />
                      <span className="font-mono text-xs text-slate-600">{pPrimaryColor}</span>
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700">
                      Couleur secondaire (tableau, bordure fiscale)
                    </label>
                    <div className="mt-1 flex items-center gap-2">
                      <input
                        type="color"
                        value={pAccentColor}
                        onChange={(e) => setPAccentColor(e.target.value)}
                        className="h-9 w-14 cursor-pointer rounded border border-slate-300 p-0.5 bg-white"
                      />
                      <span className="font-mono text-xs text-slate-600">{pAccentColor}</span>
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[11px] font-medium text-slate-500">Palettes rapides :</span>
                  {COLOR_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => {
                        setPPrimaryColor(preset.primaryColor);
                        setPAccentColor(preset.accentColor);
                      }}
                      className="inline-flex items-center gap-1.5 rounded border border-slate-300 bg-white px-2 py-1 text-[11px] text-slate-700 hover:bg-slate-100"
                    >
                      <span
                        className="inline-block h-3 w-3 rounded-sm border border-slate-200"
                        style={{ backgroundColor: preset.primaryColor }}
                      />
                      <span
                        className="inline-block h-3 w-3 rounded-sm border border-slate-200"
                        style={{ backgroundColor: preset.accentColor }}
                      />
                      <span>{preset.label}</span>
                    </button>
                  ))}
                </div>

                {/* Mini-aperçu en direct de l'en-tête facture */}
                <div className="rounded border border-slate-200 bg-white p-3 shadow-xs">
                  <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                    Aperçu en direct de l’en-tête facture
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2.5">
                      {pLogo ? (
                        <img
                          src={pLogo}
                          alt="Aperçu logo"
                          className="h-9 max-w-[120px] object-contain"
                        />
                      ) : (
                        <span className="text-xs font-bold" style={{ color: pAccentColor }}>
                          {pName || 'Nom société'}
                        </span>
                      )}
                    </div>
                    <div className="text-right text-[10px] text-slate-500 leading-tight">
                      <div>{pAddress || 'Adresse société'}</div>
                      <div>{pEmail || 'email@societe.dz'}</div>
                      <div>{pPhone || '023 00 00 00'}</div>
                    </div>
                  </div>
                  <div
                    className="mt-2 rounded-sm px-2.5 py-1 text-[10px] flex flex-wrap justify-between gap-2 border"
                    style={{
                      borderColor: pAccentColor,
                      backgroundColor: `${pPrimaryColor}10`,
                      color: '#333333',
                    }}
                  >
                    <span>RC N° : {pRc || '—'}</span>
                    <span>NIF N° : {pNif || '—'}</span>
                    <span>NIS : {pNis || '—'}</span>
                    <span>AI N° : {pAi || '—'}</span>
                  </div>
                  <div className="mt-2 flex items-center justify-between">
                    <span
                      className="inline-block rounded-sm px-2.5 py-1 text-xs font-bold"
                      style={{
                        backgroundColor: `${pPrimaryColor}14`,
                        border: `1.5px solid ${pPrimaryColor}`,
                        color: pPrimaryColor,
                      }}
                    >
                      FACTURE N°078/26
                    </span>
                    <span
                      className="rounded-sm px-2.5 py-1 text-[10px] font-bold text-white"
                      style={{ backgroundColor: pAccentColor }}
                    >
                      Désignation · Quantité · Total HT
                    </span>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-700">
                    Nom / Raison sociale *
                  </label>
                  <input
                    type="text"
                    required
                    value={pName}
                    onChange={(e) => setPName(e.target.value)}
                    className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700">Adresse</label>
                  <input
                    type="text"
                    value={pAddress}
                    onChange={(e) => setPAddress(e.target.value)}
                    className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-xs font-medium text-slate-700">Code postal</label>
                    <input
                      type="text"
                      value={pPostalCode}
                      onChange={(e) => setPPostalCode(e.target.value)}
                      className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700">Ville (fait à…)</label>
                    <input
                      type="text"
                      value={pCity}
                      onChange={(e) => setPCity(e.target.value)}
                      placeholder="Alger"
                      className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-xs font-medium text-slate-700">Téléphone(s)</label>
                    <input
                      type="text"
                      value={pPhone}
                      onChange={(e) => setPPhone(e.target.value)}
                      className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700">Fax</label>
                    <input
                      type="text"
                      value={pFax}
                      onChange={(e) => setPFax(e.target.value)}
                      className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700">Email(s)</label>
                  <input
                    type="text"
                    value={pEmail}
                    onChange={(e) => setPEmail(e.target.value)}
                    placeholder="contact@societe.dz"
                    className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700">NIF</label>
                  <input
                    type="text"
                    value={pNif}
                    onChange={(e) => setPNif(e.target.value)}
                    className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700">NIS</label>
                  <input
                    type="text"
                    value={pNis}
                    onChange={(e) => setPNis(e.target.value)}
                    className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700">RC</label>
                  <input
                    type="text"
                    value={pRc}
                    onChange={(e) => setPRc(e.target.value)}
                    className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700">AI</label>
                  <input
                    type="text"
                    value={pAi}
                    onChange={(e) => setPAi(e.target.value)}
                    className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-700">
                    Comptes bancaires affichés en pied de facture (ligne complète)
                  </label>
                  <input
                    type="text"
                    value={pBankInfo}
                    onChange={(e) => setPBankInfo(e.target.value)}
                    placeholder="Ex : Compte SGA : 021 ... - Compte Fransabank : 035 ..."
                    className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700">RIB (optionnel)</label>
                  <input
                    type="text"
                    value={pRib}
                    onChange={(e) => setPRib(e.target.value)}
                    className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700">
                    Libellé zone signature
                  </label>
                  <input
                    type="text"
                    value={pSignatureLabel}
                    onChange={(e) => setPSignatureLabel(e.target.value)}
                    placeholder="SERVICE COMMERCIAL"
                    className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-700">
                    Mention complémentaire pied de page (optionnel)
                  </label>
                  <input
                    type="text"
                    value={pFooterNote}
                    onChange={(e) => setPFooterNote(e.target.value)}
                    placeholder="Ex : Merci pour votre confiance."
                    className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>
                <div className="sm:col-span-2 flex flex-wrap gap-6 pt-1">
                  <label className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={pApplyThemeToApp}
                      onChange={(e) => setPApplyThemeToApp(e.target.checked)}
                    />
                    <span>Appliquer les couleurs de cette société à l’interface</span>
                  </label>
                  <label className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={pIsDefault}
                      onChange={(e) => setPIsDefault(e.target.checked)}
                    />
                    <span>Définir comme société active / par défaut</span>
                  </label>
                </div>
              </div>

              <div className="flex justify-end gap-2 border-t border-slate-200 pt-3">
                <button
                  type="button"
                  onClick={() => setProfileFormOpen(false)}
                  className="rounded-md border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700"
                >
                  Annuler
                </button>
                <button
                  type="submit"
                  className="rounded-md bg-[#0F1E36] px-4 py-2 text-xs font-medium text-white hover:bg-[#1a2f52]"
                >
                  Enregistrer la société
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      {/* Onglet 2 : Devises & Fiscalité */}
      {activeTab === 'fiscalite' && (
        <form onSubmit={handleSaveFiscal} className="rounded-lg border border-slate-200 bg-white p-6 space-y-6">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Devises, TVA & Numérotation</h2>
            <p className="mt-1 text-sm text-slate-500">
              Les taux de change indicatifs servent de valeur par défaut ; chaque opération conserve son propre taux historique.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {!isSimple && (
              <div>
                <label className="block text-sm font-medium text-slate-700">Devise principale</label>
                <select
                  value={defaultCurrency}
                  onChange={(e) => setDefaultCurrency(e.target.value)}
                  className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
                >
                  {currencies.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.code} — {c.name} ({c.symbol})
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-slate-700">TVA par défaut (%)</label>
              <input
                type="text"
                value={defaultTvaRate}
                onChange={(e) => setDefaultTvaRate(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm tabular-nums"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700">Préfixe factures clients</label>
              <input
                type="text"
                value={invoicePrefix}
                onChange={(e) => setInvoicePrefix(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700">Prochain N° facture client</label>
              <input
                type="number"
                min={1}
                value={invoiceNextSeq}
                onChange={(e) => setInvoiceNextSeq(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm tabular-nums"
              />
            </div>
            {!isSimple && (
              <>
                <div>
                  <label className="block text-sm font-medium text-slate-700">Préfixe factures fournisseurs</label>
                  <input
                    type="text"
                    value={supplierInvoicePrefix}
                    onChange={(e) => setSupplierInvoicePrefix(e.target.value)}
                    className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700">Prochain N° facture fournisseur</label>
                  <input
                    type="number"
                    min={1}
                    value={supplierInvoiceNextSeq}
                    onChange={(e) => setSupplierInvoiceNextSeq(e.target.value)}
                    className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm tabular-nums"
                  />
                </div>
              </>
            )}
          </div>

          {!isSimple && (
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-slate-800">Devises disponibles</h3>
            <div className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                  <tr>
                    <th className="px-4 py-2.5">Active</th>
                    <th className="px-4 py-2.5">Code</th>
                    <th className="px-4 py-2.5">Nom</th>
                    <th className="px-4 py-2.5">Symbole</th>
                    <th className="px-4 py-2.5 text-right">Taux manuel vers DZD</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {currencies.map((c) => (
                    <tr key={c.code} className="hover:bg-slate-50">
                      <td className="px-4 py-2">
                        <input
                          type="checkbox"
                          checked={c.enabled || c.code === defaultCurrency}
                          disabled={c.code === defaultCurrency}
                          onChange={(e) =>
                            setCurrencies((prev) =>
                              prev.map((item) =>
                                item.code === c.code ? { ...item, enabled: e.target.checked } : item
                              )
                            )
                          }
                        />
                      </td>
                      <td className="px-4 py-2 font-medium text-slate-900">{c.code}</td>
                      <td className="px-4 py-2 text-slate-700">{c.name}</td>
                      <td className="px-4 py-2 text-slate-700">{c.symbol}</td>
                      <td className="px-4 py-2 text-right">
                        <input
                          type="number"
                          step="0.01"
                          min="0.0001"
                          disabled={c.code === 'DZD'}
                          value={c.rateToDzd}
                          onChange={(e) => {
                            const val = parseFloat(e.target.value);
                            setCurrencies((prev) =>
                              prev.map((item) =>
                                item.code === c.code
                                  ? { ...item, rateToDzd: Number.isFinite(val) ? val : 1 }
                                  : item
                              )
                            );
                          }}
                          className="w-28 rounded border border-slate-300 px-2 py-1 text-right text-sm tabular-nums disabled:bg-slate-100"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Ajout d'une devise supplémentaire */}
            <div className="flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
              <div>
                <label className="block text-xs text-slate-600">Code (3 lettres)</label>
                <input
                  type="text"
                  maxLength={3}
                  value={newCurrCode}
                  onChange={(e) => setNewCurrCode(e.target.value.toUpperCase())}
                  placeholder="CHF"
                  className="mt-1 w-20 rounded border border-slate-300 bg-white px-2.5 py-1.5 text-sm"
                />
              </div>
              <div className="flex-1 min-w-[150px]">
                <label className="block text-xs text-slate-600">Nom</label>
                <input
                  type="text"
                  value={newCurrName}
                  onChange={(e) => setNewCurrName(e.target.value)}
                  placeholder="Franc suisse"
                  className="mt-1 w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-600">Symbole</label>
                <input
                  type="text"
                  value={newCurrSymbol}
                  onChange={(e) => setNewCurrSymbol(e.target.value)}
                  placeholder="CHF"
                  className="mt-1 w-20 rounded border border-slate-300 bg-white px-2.5 py-1.5 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-600">Taux vers DZD</label>
                <input
                  type="text"
                  value={newCurrRate}
                  onChange={(e) => setNewCurrRate(e.target.value)}
                  className="mt-1 w-24 rounded border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-right tabular-nums"
                />
              </div>
              <button
                type="button"
                onClick={handleAddCurrency}
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100"
              >
                <Plus className="h-4 w-4" />
                <span>Ajouter devise</span>
              </button>
            </div>
          </div>
          )}

          <div className="flex justify-end border-t border-slate-200 pt-4">
            <button
              type="submit"
              className="inline-flex items-center gap-2 rounded-md bg-[#0F1E36] px-5 py-2 text-sm font-medium text-white hover:bg-[#1a2f52]"
            >
              <Save className="h-4 w-4" />
              <span>Enregistrer les réglages fiscaux</span>
            </button>
          </div>
        </form>
      )}

      {/* Onglet : Configuration de l'impression */}
      {activeTab === 'impression' && (() => {
        const currentFormPrintSettings: PrintSettings = {
          defaultPrinterName: printPrinterName.trim(),
          paperSize: printPaperSize,
          orientation: printOrientation,
          margins: printMargins,
          color: printColor,
          copies: Math.max(1, Math.min(99, parseInt(printCopies, 10) || 1)),
          fitToPage: printFitToPage,
          previewBeforePrint: printPreviewBefore,
          silentPrint: printSilent,
        };
        const activeProfile =
          companyProfiles.find((p) => p.id === settings.activeCompanyProfileId) ||
          companyProfiles.find((p) => p.isDefault) ||
          companyProfiles[0];

        const handleSavePrintSettings = async (e: React.FormEvent) => {
          e.preventDefault();
          await db.settings.update('company_settings', {
            printSettings: currentFormPrintSettings,
            updatedAt: new Date().toISOString(),
          });
          await recordAudit({
            action: 'MODIFICATION',
            entityType: 'parametres',
            entityId: 'impression',
            summary: `Configuration impression (${currentFormPrintSettings.paperSize}, ${currentFormPrintSettings.orientation}, ${currentFormPrintSettings.copies} copie(s))`,
          });
          pushToast({
            type: 'success',
            title: 'Réglages d’impression enregistrés',
            message: `${currentFormPrintSettings.paperSize} · ${
              currentFormPrintSettings.orientation === 'landscape' ? 'Paysage' : 'Portrait'
            } · ${currentFormPrintSettings.copies} copie(s).`,
          });
        };

        const handleTestPrint = async () => {
          const htmlContent = buildPrintTestHtml(
            settings,
            activeProfile,
            currentFormPrintSettings
          );
          const res = await printWithSettings({
            htmlContent,
            printSettings: currentFormPrintSettings,
          });
          if (!res.ok) {
            pushToast({
              type: res.blockedByIframe ? 'warning' : 'error',
              title: res.blockedByIframe
                ? 'Impression bloquée par l’aperçu'
                : 'Test d’impression impossible',
              message:
                res.error ||
                "Ouvrez l'application dans un onglet séparé ou utilisez l'export PDF.",
            });
          } else {
            pushToast({
              type: 'success',
              title: 'Test d’impression envoyé',
              message: window.electronAPI?.isElectron
                ? 'La page de test a été transmise à l’imprimante.'
                : 'Boîte de dialogue d’impression ouverte.',
            });
          }
        };

        return (
          <form
            onSubmit={handleSavePrintSettings}
            className="rounded-lg border border-slate-200 bg-white p-6 space-y-6"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-slate-900">
                  Configuration de l’impression
                </h2>
                <p className="mt-1 text-sm text-slate-500">
                  Ces paramètres s’appliquent aux factures, proformas, bons de commande, relevés et rapports.
                </p>
              </div>
              <button
                type="button"
                onClick={handleTestPrint}
                className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                <Printer className="h-4 w-4 text-[#0F1E36]" />
                <span>Test d’impression</span>
              </button>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <div className="flex items-center justify-between">
                  <label className="block text-sm font-medium text-slate-700">
                    Imprimante par défaut
                  </label>
                  {window.electronAPI?.isElectron && (
                    <button
                      type="button"
                      onClick={refreshSystemPrinters}
                      disabled={loadingPrinters}
                      className="inline-flex items-center gap-1 text-xs font-medium text-[#1D4ED8] hover:underline disabled:opacity-50"
                    >
                      <RefreshCw className={`h-3 w-3 ${loadingPrinters ? 'animate-spin' : ''}`} />
                      <span>Actualiser les imprimantes</span>
                    </button>
                  )}
                </div>
                {window.electronAPI?.isElectron ? (
                  <select
                    value={printPrinterName}
                    onChange={(e) => setPrintPrinterName(e.target.value)}
                    className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
                  >
                    <option value="">Imprimante par défaut du système Windows</option>
                    {systemPrinters.map((p) => (
                      <option key={p.name} value={p.name}>
                        {p.displayName || p.name}
                        {p.isDefault ? ' (Système par défaut)' : ''}
                      </option>
                    ))}
                  </select>
                ) : (
                  <div className="mt-1 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                    En mode navigateur Web, le choix de l’imprimante physique s’effectue dans la boîte de dialogue d’impression du navigateur. Dans l’application Windows (.exe), la liste complète des imprimantes installées apparaît automatiquement ici.
                  </div>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700">Format papier</label>
                <select
                  value={printPaperSize}
                  onChange={(e) => setPrintPaperSize(e.target.value as PrintPaperSize)}
                  className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
                >
                  <option value="A4">A4 (210 × 297 mm)</option>
                  <option value="A5">A5 (148 × 210 mm)</option>
                  <option value="Letter">Letter (216 × 279 mm)</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700">Orientation</label>
                <select
                  value={printOrientation}
                  onChange={(e) => setPrintOrientation(e.target.value as PrintOrientation)}
                  className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
                >
                  <option value="portrait">Portrait</option>
                  <option value="landscape">Paysage</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700">Marges</label>
                <select
                  value={printMargins}
                  onChange={(e) => setPrintMargins(e.target.value as PrintMarginMode)}
                  className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
                >
                  <option value="none">Aucune marge (modèles A4 plein bord)</option>
                  <option value="minimum">Minimum</option>
                  <option value="default">Normales</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700">
                  Nombre de copies
                </label>
                <input
                  type="number"
                  min={1}
                  max={99}
                  value={printCopies}
                  onChange={(e) => setPrintCopies(e.target.value)}
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm tabular-nums"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4 sm:grid-cols-2">
              <label className="flex items-center gap-2.5 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={printColor}
                  onChange={(e) => setPrintColor(e.target.checked)}
                />
                <span>Impression en couleur</span>
              </label>

              <label className="flex items-center gap-2.5 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={printFitToPage}
                  onChange={(e) => setPrintFitToPage(e.target.checked)}
                />
                <span>Ajuster automatiquement à la page</span>
              </label>

              <label className="flex items-center gap-2.5 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={printPreviewBefore}
                  onChange={(e) => setPrintPreviewBefore(e.target.checked)}
                />
                <span>Afficher l’aperçu avant impression</span>
              </label>

              <label className="flex items-center gap-2.5 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={printSilent}
                  onChange={(e) => setPrintSilent(e.target.checked)}
                />
                <span>Impression silencieuse (sans fenêtre système, si supporté)</span>
              </label>
            </div>

            <div className="flex items-center justify-between border-t border-slate-200 pt-4">
              <button
                type="button"
                onClick={() => {
                  setPrintPrinterName(DEFAULT_PRINT_SETTINGS.defaultPrinterName);
                  setPrintPaperSize(DEFAULT_PRINT_SETTINGS.paperSize);
                  setPrintOrientation(DEFAULT_PRINT_SETTINGS.orientation);
                  setPrintMargins(DEFAULT_PRINT_SETTINGS.margins);
                  setPrintColor(DEFAULT_PRINT_SETTINGS.color);
                  setPrintCopies(String(DEFAULT_PRINT_SETTINGS.copies));
                  setPrintFitToPage(DEFAULT_PRINT_SETTINGS.fitToPage);
                  setPrintPreviewBefore(DEFAULT_PRINT_SETTINGS.previewBeforePrint);
                  setPrintSilent(DEFAULT_PRINT_SETTINGS.silentPrint);
                }}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-slate-900"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                <span>Réinitialiser par défaut</span>
              </button>

              <button
                type="submit"
                className="inline-flex items-center gap-2 rounded-md bg-[#0F1E36] px-5 py-2 text-sm font-medium text-white hover:bg-[#1a2f52]"
              >
                <Save className="h-4 w-4" />
                <span>Enregistrer les réglages d’impression</span>
              </button>
            </div>
          </form>
        );
      })()}

      {/* Onglet 3 : Sauvegardes & Restauration */}
      {activeTab === 'sauvegardes' && (
        <div className="space-y-6">
          <div className="rounded-lg border border-slate-200 bg-white p-6 space-y-4">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Sauvegarde & Restauration complète (JSON)
              </h2>
              <p className="mt-1 text-sm text-slate-500">
                Inclut toutes vos écritures, factures, chèques, paramètres et votre logo. Une sauvegarde de sécurité est créée automatiquement avant chaque restauration.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={handleExportBackup}
                className="inline-flex items-center gap-2 rounded-md bg-[#0F1E36] px-4 py-2 text-sm font-medium text-white hover:bg-[#1a2f52]"
              >
                <Download className="h-4 w-4" />
                <span>Créer une sauvegarde maintenant</span>
              </button>

              {window.electronAPI?.isElectron ? (
                <button
                  type="button"
                  onClick={() => handleElectronRestorePick('')}
                  className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  <Upload className="h-4 w-4" />
                  <span>Restaurer depuis un fichier...</span>
                </button>
              ) : (
                <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
                  <Upload className="h-4 w-4" />
                  <span>Restaurer un fichier JSON...</span>
                  <input
                    type="file"
                    accept=".json,application/json"
                    onChange={handleBrowserFileRestore}
                    className="hidden"
                  />
                </label>
              )}
            </div>
          </div>

          {window.electronAPI?.isElectron ? (
            <div className="rounded-lg border border-slate-200 bg-white p-6 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-slate-900">
                    Sauvegardes automatiques (30 dernières conservées)
                  </h3>
                  <p className="text-xs text-slate-500">Dossier actif : {backupFolder}</p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleSelectBackupFolder}
                    className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    <FolderOpen className="h-3.5 w-3.5" />
                    <span>Changer de dossier</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => refreshElectronBackups()}
                    className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    <span>Actualiser</span>
                  </button>
                </div>
              </div>

              {electronBackups.length === 0 ? (
                <div className="rounded border border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
                  Aucune sauvegarde trouvée dans ce dossier pour le moment.
                </div>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-slate-200">
                  <table className="w-full text-left text-sm">
                    <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                      <tr>
                        <th className="px-4 py-2">Fichier</th>
                        <th className="px-4 py-2">Type</th>
                        <th className="px-4 py-2">Date</th>
                        <th className="px-4 py-2 text-right">Taille</th>
                        <th className="px-4 py-2 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {electronBackups.map((b) => (
                        <tr key={b.filePath} className="hover:bg-slate-50">
                          <td className="px-4 py-2 font-medium text-slate-800">{b.fileName}</td>
                          <td className="px-4 py-2 text-slate-600">
                            {b.kind === 'auto' ? 'Automatique' : 'Manuelle'}
                          </td>
                          <td className="px-4 py-2 text-slate-600 tabular-nums">
                            {new Date(b.modifiedAt).toLocaleString('fr-FR')}
                          </td>
                          <td className="px-4 py-2 text-right text-slate-600 tabular-nums">
                            {(b.sizeBytes / 1024).toFixed(1)} Ko
                          </td>
                          <td className="px-4 py-2 text-right">
                            <button
                              type="button"
                              onClick={() => handleElectronRestorePick(b.filePath)}
                              className="text-xs font-medium text-[#1D4ED8] hover:underline"
                            >
                              Restaurer
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ) : (
            <div className="rounded-lg border border-slate-200 bg-white p-5 text-sm text-slate-600">
              <strong>Note sur l’application Windows (.exe) :</strong> lorsque le logiciel tourne en mode bureau Electron, une sauvegarde automatique est enregistrée automatiquement à l’ouverture et à la fermeture dans <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">Documents\GestionFinanciere\Sauvegardes</code>.
            </div>
          )}
        </div>
      )}

      {/* Onglet : Corbeille */}
      {activeTab === 'corbeille' && (
        <div className="rounded-lg border border-slate-200 bg-white p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold text-slate-900">Corbeille</h2>
              <p className="mt-1 text-xs text-slate-500">
                Les éléments supprimés sont conservés ici. Vous pouvez les restaurer à tout moment ou les effacer définitivement.
              </p>
            </div>
            <button
              type="button"
              onClick={refreshTrash}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              <span>Actualiser</span>
            </button>
          </div>

          {trashItems.length === 0 ? (
            <div className="rounded border border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-500">
              La corbeille est vide.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 bg-slate-50 font-semibold text-slate-600">
                  <tr>
                    <th className="px-3 py-2.5">Type</th>
                    <th className="px-3 py-2.5">Élément</th>
                    <th className="px-3 py-2.5">Supprimé le</th>
                    <th className="px-3 py-2.5 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {trashItems.map((item) => (
                    <tr key={`${item.entityType}-${item.id}`} className="hover:bg-slate-50">
                      <td className="px-3 py-2 font-medium text-slate-700">{item.typeLabel}</td>
                      <td className="px-3 py-2">
                        <div className="font-semibold text-slate-900">{item.title}</div>
                        {item.subtitle && (
                          <div className="text-[11px] text-slate-500">{item.subtitle}</div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-slate-500 tabular-nums">
                        {new Date(item.deletedAt).toLocaleString('fr-FR')}
                      </td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => handleRestoreTrashItem(item)}
                            className="inline-flex items-center gap-1 rounded border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100"
                          >
                            <RotateCcw className="h-3 w-3" />
                            <span>Restaurer</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => setPermDeleteTarget(item)}
                            className="inline-flex items-center gap-1 rounded border border-red-200 bg-white px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-50"
                          >
                            <Trash2 className="h-3 w-3" />
                            <span>Supprimer définitivement</span>
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Onglet 4 : Données démo & Journal d'audit */}
      {activeTab === 'donnees' && (
        <div className="space-y-6">
          <div className="rounded-lg border border-slate-200 bg-white p-6 space-y-4">
            <div>
              <h2 className="text-base font-semibold text-slate-900">Données de démonstration fictives</h2>
              <p className="mt-1 text-sm text-slate-500">
                Chargez un jeu complet de données fictives algériennes (BNA, CPA, chéquier 0012345, factures, paiements partiels, dépenses) pour découvrir ou tester l’application.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={handleLoadDemo}
                className="inline-flex items-center gap-2 rounded-md bg-[#0F1E36] px-4 py-2 text-sm font-medium text-white hover:bg-[#1a2f52]"
              >
                <Database className="h-4 w-4" />
                <span>
                  {settings.isDemoDataLoaded
                    ? 'Recharger les données de démonstration'
                    : 'Charger des données de démonstration'}
                </span>
              </button>
              <button
                type="button"
                onClick={() => setConfirmClearDemo(true)}
                className="inline-flex items-center gap-2 rounded-md border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50"
              >
                <Trash2 className="h-4 w-4" />
                <span>Supprimer les données de démonstration</span>
              </button>
            </div>
          </div>

          {!isSimple && (
            <div className="rounded-lg border border-slate-200 bg-white p-6 space-y-4">
              <div>
                <h3 className="text-base font-semibold text-slate-900">
                  Journal d’audit des opérations (100 dernières actions)
                </h3>
                <p className="mt-1 text-sm text-slate-500">
                  Historique horodaté des créations, modifications, annulations et restaurations.
                </p>
              </div>

              {!auditLogs || auditLogs.length === 0 ? (
                <div className="text-sm text-slate-500">Aucune entrée enregistrée.</div>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-slate-200">
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-slate-200 bg-slate-50 font-semibold text-slate-600">
                      <tr>
                        <th className="px-3 py-2">Date & heure</th>
                        <th className="px-3 py-2">Action</th>
                        <th className="px-3 py-2">Objet</th>
                        <th className="px-3 py-2">Résumé</th>
                        <th className="px-3 py-2">Motif</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {auditLogs.map((log) => (
                        <tr key={log.id} className="hover:bg-slate-50">
                          <td className="px-3 py-2 text-slate-600 tabular-nums whitespace-nowrap">
                            {new Date(log.timestamp).toLocaleString('fr-FR')}
                          </td>
                          <td className="px-3 py-2 font-medium text-slate-800">{log.action}</td>
                          <td className="px-3 py-2 text-slate-600">{log.entityType}</td>
                          <td className="px-3 py-2 text-slate-800">{log.summary}</td>
                          <td className="px-3 py-2 text-slate-500">{log.reason || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Dialogues de confirmation */}
      <ConfirmDialog
        open={Boolean(pendingRestoreInfo)}
        title="Confirmer la restauration de sauvegarde"
        description={
          pendingRestoreInfo
            ? `Vous êtes sur le point de restaurer la sauvegarde « ${pendingRestoreInfo.companyName} » datée du ${new Date(
                pendingRestoreInfo.exportedAt
              ).toLocaleString('fr-FR')} (${pendingRestoreInfo.recordCount} enregistrements). Une sauvegarde de sécurité de vos données actuelles sera créée automatiquement avant le remplacement.`
            : ''
        }
        confirmLabel="Restaurer maintenant"
        variant="primary"
        onConfirm={confirmRestore}
        onCancel={() => {
          setPendingRestoreJson(null);
          setPendingRestoreInfo(null);
        }}
      />

      <ConfirmDialog
        open={confirmClearDemo}
        title="Supprimer les données de démonstration ?"
        description="Toutes les écritures marquées comme démonstration seront retirées de la base locale. Vos propres données saisies seront conservées."
        confirmLabel="Supprimer la démo"
        variant="danger"
        onConfirm={handleClearDemo}
        onCancel={() => setConfirmClearDemo(false)}
      />

      <ConfirmDialog
        open={Boolean(permDeleteTarget)}
        title="Supprimer définitivement ?"
        description={
          permDeleteTarget
            ? `« ${permDeleteTarget.title} » (${permDeleteTarget.typeLabel}) sera effacé définitivement de la base locale. Cette action est irréversible.`
            : ''
        }
        confirmLabel="Supprimer définitivement"
        variant="danger"
        onConfirm={handlePermanentDeleteConfirm}
        onCancel={() => setPermDeleteTarget(null)}
      />

      <SafeDeleteDialog
        open={Boolean(deleteProfileTarget)}
        entityType="companyProfile"
        entityId={deleteProfileTarget?.id || ''}
        entityLabel={deleteProfileTarget?.label || ''}
        onClose={() => setDeleteProfileTarget(null)}
      />
    </div>
  );
};
