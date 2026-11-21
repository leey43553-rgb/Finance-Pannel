import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import * as XLSX from 'xlsx';
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  CheckCircle2,
  FileCheck2,
  FileSpreadsheet,
  FileText,
  FolderPlus,
  Image as ImageIcon,
  Loader2,
  Plus,
  Printer,
  Trash2,
  Upload,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { createId, db } from '../db/database';
import type {
  BcEmisStatus,
  BcRecuStatus,
  PurchaseOrder,
  PurchaseOrderDirection,
} from '../db/types';
import {
  computeDraftTotals,
  createInitialImportedBcDraft,
  ensureBcCampaignSaved,
  extractCounterpartyFromParsedBc,
  findDuplicatePurchaseOrder,
  matchContactForBc,
  parseDecimalOptional,
  parseMoneyOptionalCentimes,
  saveImportedPurchaseOrder,
  type EditableImportedBcDraft,
  type SaveImportedBcResult,
} from '../services/import/bcImportSaveService';
import {
  readBcImportFile,
  renderPdfPagesForPreview,
  type BcImportReadItem,
} from '../services/import/pdfBcReader';
import { useAppStore } from '../store/useAppStore';
import { centimesToInputString, formatMoney } from '../utils/money';

interface PurchaseOrderImportModalProps {
  open: boolean;
  defaultDirection?: PurchaseOrderDirection;
  onClose: () => void;
  onSaved?: (saved: PurchaseOrder) => void;
  onCreateProforma?: (po: PurchaseOrder) => void;
  onCreateInvoice?: (po: PurchaseOrder) => void;
  onPrintBcEmis?: (po: PurchaseOrder) => void;
}

interface PreviewState {
  loading: boolean;
  error?: string;
  pdfPages: Array<{ pageNumber: number; width: number; height: number; dataUrl: string }>;
  imageUrl?: string;
  excelRows?: string[][];
}

const ACCEPTED_EXTENSIONS = /\.(pdf|png|jpe?g|webp|xlsx|xls)$/i;

export const PurchaseOrderImportModal: React.FC<PurchaseOrderImportModalProps> = ({
  open,
  onClose,
  onSaved,
  onCreateProforma,
  onCreateInvoice,
  onPrintBcEmis,
}) => {
  const pushToast = useAppStore((s) => s.pushToast);
  const settings = useLiveQuery(() => db.settings.get('company_settings'));
  const companyProfiles = useLiveQuery(
    () => db.companyProfiles.filter((p) => !p.deletedAt).toArray(),
    [],
    []
  );
  const contacts = useLiveQuery(
    () => db.contacts.filter((c) => !c.deletedAt).toArray(),
    [],
    []
  );
  const existingPurchaseOrders = useLiveQuery(
    () => db.purchaseOrders.filter((p) => !p.deletedAt).toArray(),
    [],
    []
  );

  const readTokenRef = useRef(0);
  const [items, setItems] = useState<BcImportReadItem[]>([]);
  const [drafts, setDrafts] = useState<Record<string, EditableImportedBcDraft>>({});
  const [savedResults, setSavedResults] = useState<Record<string, SaveImportedBcResult>>({});
  const [activeItemId, setActiveItemId] = useState<string>('');
  const [isDragging, setIsDragging] = useState(false);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [linkingCampaign, setLinkingCampaign] = useState(false);
  const [progressPct, setProgressPct] = useState(0);
  const [progressLabel, setProgressLabel] = useState('');
  const [fileErrors, setFileErrors] = useState<string[]>([]);
  const [zoom, setZoom] = useState(1);
  const [preview, setPreview] = useState<PreviewState>({
    loading: false,
    pdfPages: [],
  });

  const activeFallbackProfile = useMemo(
    () =>
      companyProfiles.find((p) => p.id === settings?.activeCompanyProfileId) ||
      companyProfiles.find((p) => p.isDefault) ||
      companyProfiles[0],
    [companyProfiles, settings?.activeCompanyProfileId]
  );

  const resetState = useCallback(() => {
    readTokenRef.current += 1;
    setItems([]);
    setDrafts({});
    setSavedResults({});
    setActiveItemId('');
    setIsDragging(false);
    setReading(false);
    setSaving(false);
    setProgressPct(0);
    setProgressLabel('');
    setFileErrors([]);
    setZoom(1);
    setPreview({ loading: false, pdfPages: [] });
  }, []);

  useEffect(() => {
    if (open) {
      resetState();
    }
  }, [open, resetState]);

  const activeItem = useMemo(
    () => items.find((it) => it.id === activeItemId) || items[0] || null,
    [items, activeItemId]
  );
  const activeDraft = activeItem ? drafts[activeItem.id] || null : null;
  const activeSaved = activeItem ? savedResults[activeItem.id] || null : null;

  // Rendu de l'aperçu du document original dans le panneau de gauche
  useEffect(() => {
    if (!open || !activeItem) {
      setPreview({ loading: false, pdfPages: [] });
      return;
    }

    let cancelled = false;
    let objectUrlToRevoke: string | null = null;

    const loadPreview = async () => {
      if (activeItem.fileType === 'image') {
        const blob = new Blob([activeItem.rawBuffer], {
          type: activeItem.mimeType || 'image/png',
        });
        const url = URL.createObjectURL(blob);
        objectUrlToRevoke = url;
        setPreview({ loading: false, pdfPages: [], imageUrl: url });
        return;
      }

      if (activeItem.fileType === 'excel') {
        try {
          const wb = XLSX.read(activeItem.rawBuffer, { type: 'array' });
          const sheetName = activeItem.sheetName || wb.SheetNames[0];
          const ws = wb.Sheets[sheetName];
          const rows = ws
            ? (XLSX.utils.sheet_to_json(ws, { header: 1, raw: false }) as unknown[][])
                .slice(0, 45)
                .map((r) => (Array.isArray(r) ? r.slice(0, 10).map((c) => String(c ?? '')) : []))
            : [];
          if (!cancelled) {
            setPreview({ loading: false, pdfPages: [], excelRows: rows });
          }
        } catch (err) {
          if (!cancelled) {
            setPreview({
              loading: false,
              pdfPages: [],
              error: err instanceof Error ? err.message : 'Aperçu Excel impossible.',
            });
          }
        }
        return;
      }

      // PDF
      setPreview({ loading: true, pdfPages: [] });
      try {
        const pages = await renderPdfPagesForPreview(activeItem.rawBuffer, 1.5);
        if (!cancelled) {
          setPreview({ loading: false, pdfPages: pages });
        }
      } catch (err) {
        if (!cancelled) {
          setPreview({
            loading: false,
            pdfPages: [],
            error: err instanceof Error ? err.message : 'Aperçu PDF impossible.',
          });
        }
      }
    };

    void loadPreview();

    return () => {
      cancelled = true;
      if (objectUrlToRevoke) {
        URL.revokeObjectURL(objectUrlToRevoke);
      }
    };
  }, [open, activeItem]);

  const totalsInfo = useMemo(
    () => (activeDraft ? computeDraftTotals(activeDraft) : null),
    [activeDraft]
  );

  const duplicateMatch = useMemo(() => {
    if (!activeDraft || activeSaved) return undefined;
    return findDuplicatePurchaseOrder({
      direction: activeDraft.direction,
      poNumber: activeDraft.poNumber,
      issueDate: activeDraft.issueDate,
      contactId: activeDraft.selectedContactId || undefined,
      existingOrders: existingPurchaseOrders,
    });
  }, [activeDraft, activeSaved, existingPurchaseOrders]);

  const autoMatchedContactInfo = useMemo(() => {
    if (!activeDraft) return null;
    if (activeDraft.selectedContactId) {
      const c = contacts.find((x) => x.id === activeDraft.selectedContactId);
      return c ? { contact: c, reason: 'selected' as const } : null;
    }
    const m = matchContactForBc({
      direction: activeDraft.direction,
      party: activeDraft.party,
      existingContacts: contacts,
    });
    return m.contact ? { contact: m.contact, reason: m.matchReason } : null;
  }, [activeDraft, contacts]);

  const contactOptions = useMemo(() => {
    if (!activeDraft) return [];
    return contacts.filter((c) => {
      if (c.archived && c.id !== activeDraft.selectedContactId) return false;
      if (activeDraft.direction === 'bc_recu') {
        return c.type === 'client' || c.type === 'les_deux';
      }
      return c.type === 'fournisseur' || c.type === 'les_deux';
    });
  }, [contacts, activeDraft]);

  if (!open) return null;

  const updateActiveDraft = (
    updater: (prev: EditableImportedBcDraft) => EditableImportedBcDraft
  ) => {
    if (!activeItem) return;
    setDrafts((prev) => {
      const cur = prev[activeItem.id];
      if (!cur) return prev;
      return { ...prev, [activeItem.id]: updater(cur) };
    });
  };

  const handleFilesSelected = async (fileList: FileList | File[]) => {
    const validFiles = Array.from(fileList).filter((f) => ACCEPTED_EXTENSIONS.test(f.name));
    if (validFiles.length === 0) {
      pushToast({
        type: 'warning',
        title: 'Format non pris en charge',
        message: 'Sélectionnez un fichier PDF, JPG, PNG, XLSX ou XLS.',
      });
      return;
    }

    const token = ++readTokenRef.current;
    setReading(true);
    setFileErrors([]);
    setProgressPct(5);
    setProgressLabel(`Lecture du document… 5 %`);

    const collected: BcImportReadItem[] = [];
    const errs: string[] = [];

    try {
      for (let idx = 0; idx < validFiles.length; idx += 1) {
        if (readTokenRef.current !== token) return;
        const f = validFiles[idx];
        try {
          const parsedList = await readBcImportFile({
            file: f,
            companyProfiles,
            onProgress: (pct, msg) => {
              if (readTokenRef.current !== token) return;
              const overall = Math.round(((idx + pct / 100) / validFiles.length) * 100);
              setProgressPct(overall);
              setProgressLabel(
                msg.startsWith('Lecture du document')
                  ? `Lecture du document… ${overall} %`
                  : `${msg} (${overall} %)`
              );
            },
          });
          collected.push(...parsedList);
        } catch (err) {
          errs.push(`${f.name} : ${err instanceof Error ? err.message : 'Lecture impossible'}`);
        }
      }

      if (readTokenRef.current !== token) return;

      if (collected.length > 0) {
        const newDrafts: Record<string, EditableImportedBcDraft> = {};
        for (const item of collected) {
          newDrafts[item.id] = createInitialImportedBcDraft({
            parsed: item.parsed,
            companyProfiles,
            existingContacts: contacts,
            defaultCurrency: settings?.defaultCurrency || 'DZD',
            fallbackProfileId: activeFallbackProfile?.id,
          });
        }
        setItems((prev) => [...prev, ...collected]);
        setDrafts((prev) => ({ ...prev, ...newDrafts }));
        setActiveItemId(collected[0].id);
      }
      setFileErrors(errs);
      if (errs.length > 0) {
        pushToast({
          type: 'warning',
          title: 'Certains fichiers n’ont pas pu être lus',
          message: errs[0],
        });
      }
    } finally {
      if (readTokenRef.current === token) {
        setReading(false);
      }
    }
  };

  const handleDirectionSwitch = (nextDir: PurchaseOrderDirection) => {
    if (!activeItem || !activeDraft) return;
    const nextParty = extractCounterpartyFromParsedBc(activeItem.parsed, nextDir);
    const matched = matchContactForBc({
      direction: nextDir,
      party: nextParty,
      existingContacts: contacts,
    });
    updateActiveDraft((prev) => ({
      ...prev,
      direction: nextDir,
      status: nextDir === 'bc_recu' ? 'recu' : 'brouillon',
      selectedContactId: matched.contact?.id || '',
      party: nextParty.name || nextParty.nif || nextParty.rc ? nextParty : prev.party,
      createOrLinkCampaign: nextDir === 'bc_recu' ? prev.createOrLinkCampaign : false,
    }));
  };

  const handleSelectExistingContact = (contactId: string) => {
    updateActiveDraft((prev) => {
      if (!contactId) {
        const fallback = activeItem
          ? extractCounterpartyFromParsedBc(activeItem.parsed, prev.direction)
          : prev.party;
        return { ...prev, selectedContactId: '', party: fallback };
      }
      const c = contacts.find((x) => x.id === contactId);
      if (!c) return { ...prev, selectedContactId: contactId };
      return {
        ...prev,
        selectedContactId: contactId,
        party: {
          name: c.company || c.name,
          address: c.address || prev.party.address,
          email: c.email || prev.party.email,
          phone: c.phone || prev.party.phone,
          fax: prev.party.fax,
          rc: c.rc || prev.party.rc,
          nif: c.nif || prev.party.nif,
          ai: c.ai || prev.party.ai,
          nis: c.nis || prev.party.nis,
        },
      };
    });
  };

  const handleLineFieldChange = (
    lineId: string,
    field: 'title' | 'description' | 'qtyText' | 'unit' | 'unitPriceText' | 'totalText',
    val: string
  ) => {
    updateActiveDraft((prev) => ({
      ...prev,
      lines: prev.lines.map((ln) => {
        if (ln.id !== lineId) return ln;
        const next = { ...ln, [field]: val };
        if (field === 'qtyText' || field === 'unitPriceText') {
          const q = parseDecimalOptional(next.qtyText);
          const puC = parseMoneyOptionalCentimes(next.unitPriceText);
          if (q !== null && puC !== null) {
            next.totalText = centimesToInputString(Math.round(q * puC));
          } else if (!next.unitPriceText.trim() && !next.qtyText.trim()) {
            next.totalText = '';
          }
        }
        return next;
      }),
    }));
  };

  const handleAddLine = () => {
    updateActiveDraft((prev) => ({
      ...prev,
      lines: [
        ...prev.lines,
        {
          id: createId('bcl'),
          title: '',
          description: '',
          qtyText: '',
          unit: '',
          unitPriceText: '',
          totalText: '',
        },
      ],
    }));
  };

  const handleRemoveLine = (lineId: string) => {
    updateActiveDraft((prev) => ({
      ...prev,
      lines: prev.lines.filter((l) => l.id !== lineId),
    }));
  };

  const handleSaveActiveBc = async () => {
    if (!activeItem || !activeDraft) return;
    setSaving(true);
    try {
      const result = await saveImportedPurchaseOrder({
        draft: activeDraft,
        sourceFile: {
          fileName: activeItem.fileName,
          mimeType: activeItem.mimeType,
          sizeBytes: activeItem.sizeBytes,
          rawBuffer: activeItem.rawBuffer,
        },
      });
      setSavedResults((prev) => ({ ...prev, [activeItem.id]: result }));
      onSaved?.(result.purchaseOrder);
      pushToast({
        type: 'success',
        title: `BC ${result.purchaseOrder.poNumber} enregistré`,
        message: `${
          result.contactCreated ? 'Nouveau tiers créé · ' : ''
        }Fichier original joint (${activeItem.fileName}).`,
      });
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Enregistrement impossible',
        message: err instanceof Error ? err.message : 'Erreur inconnue.',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleCreateOrLinkCampaignNow = async () => {
    if (!activeItem || !activeDraft || activeDraft.direction !== 'bc_recu') return;
    setLinkingCampaign(true);
    try {
      const title =
        activeDraft.campaignRef.trim() ||
        activeDraft.lines[0]?.title.trim() ||
        `Campagne BC ${activeDraft.poNumber}`;
      let contactId = activeSaved?.contact.id || activeDraft.selectedContactId;
      if (!contactId) {
        const { contact } = await import('../services/import/bcImportSaveService').then((m) =>
          m.ensureBcContactSaved({
            direction: 'bc_recu',
            selectedContactId: activeDraft.selectedContactId,
            party: activeDraft.party,
          })
        );
        contactId = contact.id;
      }
      const campaign = await ensureBcCampaignSaved({
        clientId: contactId,
        campaignId: activeDraft.campaignId,
        campaignRef: title,
        startDate: activeDraft.campaignStartDate || undefined,
        endDate: activeDraft.campaignEndDate || undefined,
        fallbackDate: activeDraft.issueDate,
      });
      if (campaign) {
        updateActiveDraft((prev) => ({
          ...prev,
          selectedContactId: contactId,
          campaignId: campaign.id,
          campaignRef: campaign.name,
          campaignStartDate: prev.campaignStartDate || campaign.startDate,
          campaignEndDate: prev.campaignEndDate || campaign.endDate,
          createOrLinkCampaign: true,
        }));
        if (activeSaved) {
          await db.purchaseOrders.update(activeSaved.purchaseOrder.id, {
            campaignId: campaign.id,
            campaignRef: campaign.name,
            campaignStartDate: campaign.startDate,
            campaignEndDate: campaign.endDate,
            updatedAt: new Date().toISOString(),
          });
          setSavedResults((prev) => ({
            ...prev,
            [activeItem.id]: {
              ...activeSaved,
              campaign,
              purchaseOrder: {
                ...activeSaved.purchaseOrder,
                campaignId: campaign.id,
                campaignRef: campaign.name,
              },
            },
          }));
        }
        pushToast({
          type: 'success',
          title: 'Campagne associée',
          message: campaign.name,
        });
      }
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Campagne impossible',
        message: err instanceof Error ? err.message : 'Erreur inconnue.',
      });
    } finally {
      setLinkingCampaign(false);
    }
  };

  const inputHighlightClass = (confField: string, value?: string | null) => {
    const empty = !value || !value.trim();
    if (empty) {
      return 'border-orange-400 bg-orange-50/40 focus:border-orange-500';
    }
    const c = activeItem?.parsed.confidence[confField];
    if (activeItem?.parsed.isScannedOcr && typeof c === 'number' && c > 0 && c < 0.72) {
      return 'border-amber-400 bg-amber-50/70 focus:border-amber-500';
    }
    return 'border-slate-300 bg-white focus:border-[#1D4ED8]';
  };

  const hasSavedAll = items.length > 0 && items.every((it) => Boolean(savedResults[it.id]));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-3 sm:p-4">
      <div className="flex h-[94vh] w-full max-w-[1440px] flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-2xl">
        {/* En-tête */}
        <div className="flex items-center justify-between border-b border-slate-200 bg-[#0F1E36] px-5 py-3 text-white shrink-0">
          <div className="flex items-center gap-2.5">
            <Upload className="h-4 w-4" />
            <div>
              <h2 className="text-sm font-semibold">
                Importer un bon de commande (PDF, Scan/Image, Excel)
              </h2>
              <p className="text-[11px] text-slate-300">
                100 % hors-ligne — prévisualisation côte à côte, correction libre & pièce jointe conservée
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-slate-300 hover:bg-white/10 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Zone dépôt + barre multi-fichiers */}
        <div className="border-b border-slate-200 bg-slate-50 px-5 py-3 space-y-2.5 shrink-0">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setIsDragging(false);
                if (e.dataTransfer.files?.length) {
                  void handleFilesSelected(e.dataTransfer.files);
                }
              }}
              className={`flex-1 min-w-[280px] rounded-lg border-2 border-dashed px-4 py-2.5 text-center transition-colors ${
                isDragging
                  ? 'border-[#1D4ED8] bg-blue-50/70'
                  : 'border-slate-300 bg-white hover:border-slate-400'
              }`}
            >
              <div className="flex flex-wrap items-center justify-center gap-2 text-xs text-slate-700">
                <Upload className="h-4 w-4 text-slate-400" />
                <span>Glissez-déposez un ou plusieurs BC (PDF, JPG, PNG, XLSX, XLS), ou</span>
                <label className="cursor-pointer font-semibold text-[#1D4ED8] hover:underline">
                  parcourir vos fichiers
                  <input
                    type="file"
                    multiple
                    accept=".pdf,image/jpeg,image/png,image/webp,.xlsx,.xls"
                    onChange={(e) => {
                      if (e.target.files?.length) {
                        void handleFilesSelected(e.target.files);
                      }
                      e.target.value = '';
                    }}
                    className="hidden"
                  />
                </label>
              </div>
            </div>

            {items.length > 0 && (
              <button
                type="button"
                onClick={resetState}
                className="text-xs font-medium text-slate-500 hover:text-red-600 whitespace-nowrap"
              >
                Vider la sélection
              </button>
            )}
          </div>

          {reading && (
            <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 space-y-1.5">
              <div className="flex items-center justify-between text-xs font-semibold text-[#0F1E36]">
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-[#1D4ED8]" />
                  <span>{progressLabel || `Lecture du document… ${progressPct} %`}</span>
                </span>
                <span className="tabular-nums">{progressPct} %</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-blue-100">
                <div
                  className="h-full bg-[#1D4ED8] transition-all duration-150"
                  style={{ width: `${Math.max(4, progressPct)}%` }}
                />
              </div>
            </div>
          )}

          {fileErrors.length > 0 && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 space-y-0.5">
              {fileErrors.map((err, i) => (
                <div key={i}>{err}</div>
              ))}
            </div>
          )}

          {items.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {items.map((it) => {
                const active = it.id === activeItem?.id;
                const saved = Boolean(savedResults[it.id]);
                const Icon =
                  it.fileType === 'excel'
                    ? FileSpreadsheet
                    : it.fileType === 'image'
                    ? ImageIcon
                    : FileText;
                return (
                  <button
                    key={it.id}
                    type="button"
                    onClick={() => setActiveItemId(it.id)}
                    className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap ${
                      active
                        ? 'border-[#0F1E36] bg-[#0F1E36] text-white'
                        : saved
                        ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
                        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-100'
                    }`}
                  >
                    {saved ? (
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                    ) : (
                      <Icon className="h-3.5 w-3.5 shrink-0" />
                    )}
                    <span className="max-w-[180px] truncate">
                      {it.fileName}
                      {it.sheetName ? ` (${it.sheetName})` : ''}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Corps principal : Vue partagée côte à côte */}
        {!activeItem || !activeDraft ? (
          <div className="flex flex-1 flex-col items-center justify-center p-10 text-center text-slate-500">
            <FileText className="h-12 w-12 text-slate-300" />
            <p className="mt-3 text-sm font-medium text-slate-700">
              Aucun document chargé pour le moment
            </p>
            <p className="mt-1 max-w-md text-xs text-slate-500">
              Déposez un bon de commande PDF (texte ou scanné), une photo JPG/PNG ou un fichier
              Excel modèle pour lancer la lecture automatique 100 % hors-ligne.
            </p>
          </div>
        ) : (
          <div className="grid flex-1 min-h-0 grid-cols-1 lg:grid-cols-12">
            {/* PANNEAU GAUCHE : Document original avec zoom */}
            <div className="flex flex-col min-h-0 border-b lg:border-b-0 lg:border-r border-slate-200 bg-slate-100 lg:col-span-5">
              <div className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-2 text-xs">
                <span className="font-semibold text-slate-700 truncate">
                  Document original — {activeItem.fileName}
                  {activeItem.sheetName ? ` (${activeItem.sheetName})` : ''}
                </span>
                {activeItem.fileType !== 'excel' && (
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => setZoom((z) => Math.max(0.6, Number((z - 0.15).toFixed(2))))}
                      title="Zoom arrière"
                      className="rounded border border-slate-200 p-1 text-slate-600 hover:bg-slate-100"
                    >
                      <ZoomOut className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setZoom(1)}
                      className="rounded border border-slate-200 px-2 py-0.5 text-[11px] font-medium tabular-nums text-slate-700 hover:bg-slate-100"
                    >
                      {Math.round(zoom * 100)} %
                    </button>
                    <button
                      type="button"
                      onClick={() => setZoom((z) => Math.min(2.2, Number((z + 0.15).toFixed(2))))}
                      title="Zoom avant"
                      className="rounded border border-slate-200 p-1 text-slate-600 hover:bg-slate-100"
                    >
                      <ZoomIn className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
              </div>

              <div className="flex-1 overflow-auto p-3 space-y-3">
                {preview.loading && (
                  <div className="flex h-64 items-center justify-center gap-2 text-xs text-slate-500">
                    <Loader2 className="h-4 w-4 animate-spin text-[#1D4ED8]" />
                    <span>Rendu des pages du document…</span>
                  </div>
                )}

                {preview.error && (
                  <div className="rounded border border-red-200 bg-red-50 p-3 text-xs text-red-700">
                    {preview.error}
                  </div>
                )}

                {!preview.loading && activeItem.fileType === 'pdf' && preview.pdfPages.length > 0 && (
                  <div className="space-y-3">
                    {preview.pdfPages.map((pg) => (
                      <div
                        key={pg.pageNumber}
                        className="mx-auto rounded border border-slate-300 bg-white shadow-sm overflow-hidden"
                        style={{ width: `${Math.round(zoom * 100)}%` }}
                      >
                        <img
                          src={pg.dataUrl}
                          alt={`Page ${pg.pageNumber}`}
                          className="w-full h-auto block"
                        />
                        {preview.pdfPages.length > 1 && (
                          <div className="border-t border-slate-100 bg-slate-50 px-2 py-0.5 text-right text-[10px] text-slate-500">
                            Page {pg.pageNumber} / {preview.pdfPages.length}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {!preview.loading && activeItem.fileType === 'image' && preview.imageUrl && (
                  <div className="mx-auto" style={{ width: `${Math.round(zoom * 100)}%` }}>
                    <img
                      src={preview.imageUrl}
                      alt={activeItem.fileName}
                      className="w-full h-auto rounded border border-slate-300 bg-white shadow-sm"
                    />
                  </div>
                )}

                {!preview.loading && activeItem.fileType === 'excel' && preview.excelRows && (
                  <div className="overflow-auto rounded border border-slate-300 bg-white">
                    <table className="w-full border-collapse text-[11px]">
                      <tbody>
                        {preview.excelRows.map((row, rIdx) => (
                          <tr key={rIdx} className={rIdx === 0 ? 'bg-slate-100 font-semibold' : ''}>
                            <td className="border border-slate-200 bg-slate-50 px-1.5 py-1 text-center text-[10px] text-slate-400">
                              {rIdx + 1}
                            </td>
                            {row.map((cell, cIdx) => (
                              <td
                                key={cIdx}
                                className="border border-slate-200 px-2 py-1 text-slate-800 whitespace-pre-wrap"
                              >
                                {cell}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>

            {/* PANNEAU DROIT : Formulaire BC pré-rempli et modifiable */}
            <div className="flex flex-col min-h-0 overflow-y-auto p-5 space-y-4 lg:col-span-7">
              {activeItem.parsed.isScannedOcr && (
                <div className="flex items-start gap-2.5 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2.5 text-xs text-amber-900">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                  <div>
                    <div className="font-semibold">
                      Lecture automatique d’un scan : vérifiez chaque champ
                    </div>
                    <div className="text-[11px] text-amber-800">
                      Les champs en jaune indiquent une confiance OCR modérée ; les champs en orange
                      sont vides et doivent être complétés si besoin.
                    </div>
                  </div>
                </div>
              )}

              {duplicateMatch && (
                <div className="flex items-start gap-2.5 rounded-lg border border-red-300 bg-red-50 px-4 py-2.5 text-xs text-red-900">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
                  <div>
                    <div className="font-semibold">
                      Doublon potentiel détecté : le BC N° {duplicateMatch.poNumber} existe déjà (
                      {duplicateMatch.issueDate})
                    </div>
                    <div className="text-[11px] text-red-700">
                      Vérifiez le numéro avant d’enregistrer si ce document a déjà été importé.
                    </div>
                  </div>
                </div>
              )}

              {activeSaved && (
                <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-3.5 space-y-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-emerald-900">
                    <span className="inline-flex items-center gap-1.5 font-semibold">
                      <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                      <span>
                        BC « {activeSaved.purchaseOrder.poNumber} » enregistré (tag Importé · fichier
                        original joint)
                      </span>
                    </span>
                    <span className="text-[11px] text-emerald-700">
                      {activeSaved.contactCreated
                        ? `Tiers créé : ${activeSaved.contact.company || activeSaved.contact.name}`
                        : `Tiers associé : ${activeSaved.contact.company || activeSaved.contact.name}`}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {activeSaved.purchaseOrder.direction === 'bc_recu' && (
                      <>
                        <button
                          type="button"
                          disabled={linkingCampaign}
                          onClick={handleCreateOrLinkCampaignNow}
                          className="inline-flex items-center gap-1.5 rounded-md border border-emerald-400 bg-white px-3 py-1.5 text-xs font-medium text-emerald-800 hover:bg-emerald-100"
                        >
                          <FolderPlus className="h-3.5 w-3.5" />
                          <span>
                            {activeSaved.campaign
                              ? `Campagne liée : ${activeSaved.campaign.name}`
                              : 'Créer / associer la campagne'}
                          </span>
                        </button>
                        {onCreateProforma && (
                          <button
                            type="button"
                            onClick={() => onCreateProforma(activeSaved.purchaseOrder)}
                            className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-100"
                          >
                            <FileCheck2 className="h-3.5 w-3.5 text-[#1D4ED8]" />
                            <span>Créer le proforma</span>
                          </button>
                        )}
                        {onCreateInvoice && (
                          <button
                            type="button"
                            onClick={() => onCreateInvoice(activeSaved.purchaseOrder)}
                            className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
                          >
                            <FileText className="h-3.5 w-3.5" />
                            <span>Créer la facture</span>
                          </button>
                        )}
                      </>
                    )}
                    {activeSaved.purchaseOrder.direction === 'bc_emis' && onPrintBcEmis && (
                      <button
                        type="button"
                        onClick={() => onPrintBcEmis(activeSaved.purchaseOrder)}
                        className="inline-flex items-center gap-1.5 rounded-md bg-[#0F1E36] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#1a2f52]"
                      >
                        <Printer className="h-3.5 w-3.5" />
                        <span>Aperçu & PDF A4</span>
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* Sens + Société émettrice/destinataire */}
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-2.5">
                <div className="flex items-center gap-1 rounded-md border border-slate-200 bg-white p-1">
                  <button
                    type="button"
                    onClick={() => handleDirectionSwitch('bc_recu')}
                    className={`inline-flex items-center gap-1 rounded px-2.5 py-1 text-xs font-semibold whitespace-nowrap ${
                      activeDraft.direction === 'bc_recu'
                        ? 'bg-[#0F1E36] text-white'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    <ArrowDownLeft className="h-3.5 w-3.5" />
                    <span>BC reçu (client)</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDirectionSwitch('bc_emis')}
                    className={`inline-flex items-center gap-1 rounded px-2.5 py-1 text-xs font-semibold whitespace-nowrap ${
                      activeDraft.direction === 'bc_emis'
                        ? 'bg-[#0F1E36] text-white'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    <ArrowUpRight className="h-3.5 w-3.5" />
                    <span>BC émis (fournisseur)</span>
                  </button>
                </div>

                {companyProfiles.length > 0 && (
                  <div className="flex items-center gap-2 text-xs">
                    <span className="font-medium text-slate-600">Notre société :</span>
                    <select
                      value={activeDraft.companyProfileId}
                      onChange={(e) =>
                        updateActiveDraft((prev) => ({ ...prev, companyProfileId: e.target.value }))
                      }
                      className="rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-800"
                    >
                      {companyProfiles.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>

              {/* Numéro, Date, Ville, Statut */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-4 text-xs">
                <div>
                  <label className="block font-medium text-slate-700">N° BC *</label>
                  <input
                    type="text"
                    value={activeDraft.poNumber}
                    onChange={(e) =>
                      updateActiveDraft((prev) => ({ ...prev, poNumber: e.target.value }))
                    }
                    placeholder="Non trouvé — à compléter"
                    className={`mt-1 w-full rounded border px-2.5 py-1.5 text-xs font-mono font-semibold ${inputHighlightClass(
                      'number',
                      activeDraft.poNumber
                    )}`}
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700">Date *</label>
                  <input
                    type="date"
                    value={activeDraft.issueDate}
                    onChange={(e) =>
                      updateActiveDraft((prev) => ({ ...prev, issueDate: e.target.value }))
                    }
                    className={`mt-1 w-full rounded border px-2.5 py-1.5 text-xs ${inputHighlightClass(
                      'date',
                      activeDraft.issueDate
                    )}`}
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700">Ville</label>
                  <input
                    type="text"
                    value={activeDraft.city}
                    onChange={(e) =>
                      updateActiveDraft((prev) => ({ ...prev, city: e.target.value }))
                    }
                    placeholder="Alger..."
                    className={`mt-1 w-full rounded border px-2.5 py-1.5 text-xs ${inputHighlightClass(
                      'city',
                      activeDraft.city
                    )}`}
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700">Statut</label>
                  <select
                    value={activeDraft.status}
                    onChange={(e) =>
                      updateActiveDraft((prev) => ({
                        ...prev,
                        status: e.target.value as BcRecuStatus | BcEmisStatus,
                      }))
                    }
                    className="mt-1 w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
                  >
                    {activeDraft.direction === 'bc_recu' ? (
                      <>
                        <option value="recu">Reçu</option>
                        <option value="en_cours">En cours</option>
                        <option value="facture">Facturé</option>
                      </>
                    ) : (
                      <>
                        <option value="brouillon">Brouillon</option>
                        <option value="envoye">Envoyé</option>
                        <option value="recu">Réceptionné</option>
                      </>
                    )}
                  </select>
                </div>
              </div>

              {/* Tiers (Client ou Fournisseur) */}
              <div className="rounded-lg border border-slate-200 bg-white p-3.5 space-y-3 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold text-slate-800">
                    {activeDraft.direction === 'bc_recu'
                      ? 'Client (émetteur du BC)'
                      : 'Fournisseur (destinataire du BC)'}
                  </span>
                  {autoMatchedContactInfo ? (
                    <span className="rounded bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                      Tiers existant associé : {autoMatchedContactInfo.contact.company || autoMatchedContactInfo.contact.name}
                    </span>
                  ) : (
                    <span className="rounded bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-[#1D4ED8]">
                      Nouveau {activeDraft.direction === 'bc_recu' ? 'client' : 'fournisseur'} créé à l’enregistrement
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600">
                      Associer à une fiche existante
                    </label>
                    <select
                      value={activeDraft.selectedContactId}
                      onChange={(e) => handleSelectExistingContact(e.target.value)}
                      className="mt-0.5 w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
                    >
                      <option value="">
                        — Créer / détecter automatiquement ({activeDraft.party.name || 'Nouveau'}) —
                      </option>
                      {contactOptions.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.company ? `${c.company} (${c.name || 'Contact'})` : c.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600">
                      Nom / Raison sociale *
                    </label>
                    <input
                      type="text"
                      value={activeDraft.party.name}
                      onChange={(e) =>
                        updateActiveDraft((prev) => ({
                          ...prev,
                          party: { ...prev.party, name: e.target.value },
                        }))
                      }
                      placeholder="Non trouvé — à compléter"
                      className={`mt-0.5 w-full rounded border px-2.5 py-1.5 text-xs font-semibold ${inputHighlightClass(
                        activeDraft.direction === 'bc_emis' ? 'partyName' : 'issuerName',
                        activeDraft.party.name
                      )}`}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block text-[11px] font-medium text-slate-600">Adresse</label>
                    <input
                      type="text"
                      value={activeDraft.party.address}
                      onChange={(e) =>
                        updateActiveDraft((prev) => ({
                          ...prev,
                          party: { ...prev.party, address: e.target.value },
                        }))
                      }
                      placeholder="Non trouvé — à compléter"
                      className={`mt-0.5 w-full rounded border px-2.5 py-1.5 text-xs ${inputHighlightClass(
                        'partyAddress',
                        activeDraft.party.address
                      )}`}
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600">Téléphone</label>
                    <input
                      type="text"
                      value={activeDraft.party.phone}
                      onChange={(e) =>
                        updateActiveDraft((prev) => ({
                          ...prev,
                          party: { ...prev.party, phone: e.target.value },
                        }))
                      }
                      className={`mt-0.5 w-full rounded border px-2.5 py-1.5 text-xs ${inputHighlightClass(
                        'partyPhone',
                        activeDraft.party.phone
                      )}`}
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600">Email</label>
                    <input
                      type="email"
                      value={activeDraft.party.email}
                      onChange={(e) =>
                        updateActiveDraft((prev) => ({
                          ...prev,
                          party: { ...prev.party, email: e.target.value },
                        }))
                      }
                      className={`mt-0.5 w-full rounded border px-2.5 py-1.5 text-xs ${inputHighlightClass(
                        'partyEmail',
                        activeDraft.party.email
                      )}`}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600">RC</label>
                    <input
                      type="text"
                      value={activeDraft.party.rc}
                      onChange={(e) =>
                        updateActiveDraft((prev) => ({
                          ...prev,
                          party: { ...prev.party, rc: e.target.value },
                        }))
                      }
                      className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-xs"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600">NIF</label>
                    <input
                      type="text"
                      value={activeDraft.party.nif}
                      onChange={(e) =>
                        updateActiveDraft((prev) => ({
                          ...prev,
                          party: { ...prev.party, nif: e.target.value },
                        }))
                      }
                      className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-xs"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600">AI</label>
                    <input
                      type="text"
                      value={activeDraft.party.ai}
                      onChange={(e) =>
                        updateActiveDraft((prev) => ({
                          ...prev,
                          party: { ...prev.party, ai: e.target.value },
                        }))
                      }
                      className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-xs"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600">NIS</label>
                    <input
                      type="text"
                      value={activeDraft.party.nis}
                      onChange={(e) =>
                        updateActiveDraft((prev) => ({
                          ...prev,
                          party: { ...prev.party, nis: e.target.value },
                        }))
                      }
                      className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-xs"
                    />
                  </div>
                </div>
              </div>

              {/* Campagne, Livraison & Paiement */}
              <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-3.5 space-y-2.5 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold text-slate-800">Campagne & Conditions</span>
                  {activeDraft.direction === 'bc_recu' && (
                    <label className="inline-flex items-center gap-1.5 text-xs text-slate-700 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={activeDraft.createOrLinkCampaign}
                        onChange={(e) =>
                          updateActiveDraft((prev) => ({
                            ...prev,
                            createOrLinkCampaign: e.target.checked,
                          }))
                        }
                      />
                      <span>Créer / associer la campagne à l’enregistrement</span>
                    </label>
                  )}
                </div>

                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-4">
                  <div className="sm:col-span-2">
                    <label className="block text-[11px] font-medium text-slate-600">
                      Campagne / Objet
                    </label>
                    <input
                      type="text"
                      value={activeDraft.campaignRef}
                      onChange={(e) =>
                        updateActiveDraft((prev) => ({ ...prev, campaignRef: e.target.value }))
                      }
                      placeholder="Nom de campagne ou objet du BC"
                      className="mt-0.5 w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600">Début</label>
                    <input
                      type="date"
                      value={activeDraft.campaignStartDate}
                      onChange={(e) =>
                        updateActiveDraft((prev) => ({ ...prev, campaignStartDate: e.target.value }))
                      }
                      className="mt-0.5 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-xs"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600">Fin</label>
                    <input
                      type="date"
                      value={activeDraft.campaignEndDate}
                      onChange={(e) =>
                        updateActiveDraft((prev) => ({ ...prev, campaignEndDate: e.target.value }))
                      }
                      className="mt-0.5 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-xs"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block text-[11px] font-medium text-slate-600">
                      Livraison / Délai
                    </label>
                    <input
                      type="text"
                      value={activeDraft.delivery}
                      onChange={(e) =>
                        updateActiveDraft((prev) => ({ ...prev, delivery: e.target.value }))
                      }
                      className="mt-0.5 w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block text-[11px] font-medium text-slate-600">
                      Conditions de paiement
                    </label>
                    <input
                      type="text"
                      value={activeDraft.paymentTerms}
                      onChange={(e) =>
                        updateActiveDraft((prev) => ({ ...prev, paymentTerms: e.target.value }))
                      }
                      className="mt-0.5 w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
                    />
                  </div>
                </div>
              </div>

              {/* Tableau des lignes éditables */}
              <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
                <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-3.5 py-2">
                  <span className="text-xs font-semibold text-slate-800">
                    Lignes du bon de commande ({activeDraft.lines.length})
                  </span>
                  <button
                    type="button"
                    onClick={handleAddLine}
                    className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100"
                  >
                    <Plus className="h-3 w-3" />
                    <span>Ajouter une ligne</span>
                  </button>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold text-slate-600">
                      <tr>
                        <th className="px-2 py-1.5 w-9 text-center">N°</th>
                        <th className="px-2 py-1.5">Désignation & détails</th>
                        <th className="px-2 py-1.5 w-20 text-right">Qté</th>
                        <th className="px-2 py-1.5 w-16 text-center">Unité</th>
                        <th className="px-2 py-1.5 w-24 text-right">Prix U.</th>
                        <th className="px-2 py-1.5 w-24 text-right">Total</th>
                        <th className="px-2 py-1.5 w-8" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {activeDraft.lines.length === 0 ? (
                        <tr>
                          <td colSpan={7} className="px-3 py-4 text-center text-slate-500">
                            Aucune ligne. Cliquez sur « Ajouter une ligne » pour saisir les articles.
                          </td>
                        </tr>
                      ) : (
                        activeDraft.lines.map((line, idx) => (
                          <tr key={line.id} className="align-top">
                            <td className="px-2 py-2 text-center text-slate-500 tabular-nums">
                              {idx + 1}
                            </td>
                            <td className="px-2 py-1.5 space-y-1">
                              <input
                                type="text"
                                value={line.title}
                                onChange={(e) =>
                                  handleLineFieldChange(line.id, 'title', e.target.value)
                                }
                                placeholder="Intitulé de la prestation"
                                className="w-full rounded border border-slate-300 px-2 py-1 text-xs font-semibold"
                              />
                              <textarea
                                rows={2}
                                value={line.description}
                                onChange={(e) =>
                                  handleLineFieldChange(line.id, 'description', e.target.value)
                                }
                                placeholder="Dimensions, localisation, détails..."
                                className="w-full rounded border border-slate-200 px-2 py-1 text-[11px] text-slate-700"
                              />
                            </td>
                            <td className="px-2 py-1.5">
                              <input
                                type="text"
                                value={line.qtyText}
                                onChange={(e) =>
                                  handleLineFieldChange(line.id, 'qtyText', e.target.value)
                                }
                                placeholder="—"
                                className="w-full rounded border border-slate-300 px-2 py-1 text-right text-xs tabular-nums"
                              />
                            </td>
                            <td className="px-2 py-1.5">
                              <input
                                type="text"
                                value={line.unit}
                                onChange={(e) =>
                                  handleLineFieldChange(line.id, 'unit', e.target.value)
                                }
                                placeholder="u / m²"
                                className="w-full rounded border border-slate-300 px-1.5 py-1 text-center text-xs"
                              />
                            </td>
                            <td className="px-2 py-1.5">
                              <input
                                type="text"
                                value={line.unitPriceText}
                                onChange={(e) =>
                                  handleLineFieldChange(line.id, 'unitPriceText', e.target.value)
                                }
                                placeholder="—"
                                className="w-full rounded border border-slate-300 px-2 py-1 text-right text-xs tabular-nums"
                              />
                            </td>
                            <td className="px-2 py-1.5">
                              <input
                                type="text"
                                value={line.totalText}
                                onChange={(e) =>
                                  handleLineFieldChange(line.id, 'totalText', e.target.value)
                                }
                                placeholder="—"
                                className="w-full rounded border border-slate-300 px-2 py-1 text-right text-xs font-semibold tabular-nums"
                              />
                            </td>
                            <td className="px-2 py-2 text-center">
                              <button
                                type="button"
                                onClick={() => handleRemoveLine(line.id)}
                                title="Supprimer cette ligne"
                                className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Totaux, TVA, Arrêté & Notes */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 text-xs">
                <div className="space-y-2">
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600">
                      Arrêté à la somme de (optionnel)
                    </label>
                    <input
                      type="text"
                      value={activeDraft.amountInWordsOverride}
                      onChange={(e) =>
                        updateActiveDraft((prev) => ({
                          ...prev,
                          amountInWordsOverride: e.target.value,
                        }))
                      }
                      className="mt-0.5 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600">Notes</label>
                    <textarea
                      rows={2}
                      value={activeDraft.notes}
                      onChange={(e) =>
                        updateActiveDraft((prev) => ({ ...prev, notes: e.target.value }))
                      }
                      className="mt-0.5 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
                    />
                  </div>
                </div>

                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-600">Taux TVA (%)</span>
                    <input
                      type="text"
                      value={activeDraft.vatRateText}
                      onChange={(e) =>
                        updateActiveDraft((prev) => ({ ...prev, vatRateText: e.target.value }))
                      }
                      className="w-16 rounded border border-slate-300 bg-white px-2 py-0.5 text-right text-xs tabular-nums"
                    />
                  </div>
                  {totalsInfo && !totalsInfo.unpriced ? (
                    <>
                      <div className="flex justify-between">
                        <span className="text-slate-600">Total HT</span>
                        <span className="font-semibold tabular-nums">
                          {formatMoney(totalsInfo.htCentimes, activeDraft.currency)}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-600">TVA ({totalsInfo.vatRate} %)</span>
                        <span className="font-semibold tabular-nums">
                          {formatMoney(totalsInfo.tvaCentimes, activeDraft.currency)}
                        </span>
                      </div>
                      <div className="flex justify-between border-t border-slate-200 pt-1.5 text-sm font-bold text-[#0F1E36]">
                        <span>Total TTC</span>
                        <span className="tabular-nums">
                          {formatMoney(totalsInfo.ttcCentimes, activeDraft.currency)}
                        </span>
                      </div>
                    </>
                  ) : (
                    <div className="rounded border border-slate-200 bg-white px-2.5 py-2 text-center text-[11px] text-slate-500">
                      Montants vides (bon de commande non chiffré)
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Pied de page */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-5 py-3 shrink-0">
          <div className="text-[11px] text-slate-500">
            {items.length > 0 ? (
              <span>
                {Object.keys(savedResults).length} / {items.length} document(s) enregistré(s) · Le
                fichier original est conservé en pièce jointe locale.
              </span>
            ) : (
              <span>Formats acceptés : PDF (texte ou scan), JPG, PNG, XLSX, XLS.</span>
            )}
          </div>
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100"
            >
              {hasSavedAll ? 'Terminer' : 'Fermer'}
            </button>
            {activeItem && activeDraft && !activeSaved && (
              <button
                type="button"
                disabled={saving}
                onClick={handleSaveActiveBc}
                className="inline-flex items-center gap-1.5 rounded-md bg-[#0F1E36] px-4 py-2 text-xs font-semibold text-white hover:bg-[#1a2f52] disabled:opacity-60"
              >
                {saving ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Check className="h-3.5 w-3.5" />
                )}
                <span>{saving ? 'Enregistrement…' : 'Enregistrer le BC'}</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
