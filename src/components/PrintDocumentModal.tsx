import React, { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download, ExternalLink, FileSpreadsheet, Loader2, Printer, X, ZoomIn } from 'lucide-react';
import type { CompanyProfile, CompanySettings } from '../db/types';
import { useAppStore } from '../store/useAppStore';
import { printCurrentViewAsPdf, triggerBrowserPrint } from '../utils/print';

interface PrintDocumentModalProps {
  open: boolean;
  title: string;
  fileName: string;
  settings?: CompanySettings;
  companyProfile?: CompanyProfile;
  rawLayout?: boolean;
  fallbackPrintRoute?: string;
  onExportExcel?: () => void;
  onClose: () => void;
  children: React.ReactNode;
}

type ZoomLevel = 'fit' | '100' | '75';

export const PrintDocumentModal: React.FC<PrintDocumentModalProps> = ({
  open,
  title,
  fileName,
  settings,
  companyProfile,
  rawLayout = false,
  fallbackPrintRoute,
  onExportExcel,
  onClose,
  children,
}) => {
  const navigate = useNavigate();
  const pushToast = useAppStore((s) => s.pushToast);
  const sheetRef = useRef<HTMLDivElement>(null);
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);
  const [zoom, setZoom] = useState<ZoomLevel>('fit');

  if (!open) return null;

  const isElectron = Boolean(window.electronAPI?.isElectron);
  const companyName = companyProfile?.name || settings?.companyName || 'Entreprise';
  const accentColor = companyProfile?.accentColor || '#0F1E36';

  const handleExportPdf = async () => {
    setIsGeneratingPdf(true);
    try {
      if (!isElectron && !sheetRef.current) {
        throw new Error('Élément A4 du document introuvable.');
      }

      const res = await printCurrentViewAsPdf(fileName, {
        companyName,
        rawLayout,
        element: sheetRef.current,
      });

      if (!res.ok) {
        pushToast({
          type: 'error',
          title: 'Impossible de générer le PDF',
          message: res.error || 'Erreur lors de la création du fichier PDF.',
        });
        return;
      }

      if (res.canceled) return;

      if (res.method === 'electron') {
        pushToast({
          type: 'success',
          title: 'PDF enregistré',
          message: res.filePath || fileName,
          undoLabel: res.filePath ? 'Ouvrir le dossier' : undefined,
          onUndo: res.filePath
            ? () => {
                window.electronAPI?.openFolder(res.filePath!);
              }
            : undefined,
        });
      } else if (res.method === 'jspdf') {
        pushToast({
          type: 'success',
          title: 'PDF A4 téléchargé',
          message: `${res.fileName || fileName} généré hors-ligne (${res.pageCount || 1} page(s)).`,
        });
      }
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Erreur lors de l’export PDF',
        message: err instanceof Error ? err.message : 'Erreur inconnue lors de la génération PDF.',
      });
    } finally {
      setIsGeneratingPdf(false);
    }
  };

  const handlePrint = async () => {
    try {
      if (isElectron && window.electronAPI?.printDirect) {
        const res = await window.electronAPI.printDirect();
        if (!res.ok) {
          pushToast({
            type: 'error',
            title: 'Impression impossible',
            message: res.error || 'Erreur lors de l’envoi vers l’imprimante.',
          });
        }
        return;
      }

      if (fallbackPrintRoute) {
        onClose();
        navigate(`${fallbackPrintRoute}?autoPrint=1`);
        return;
      }

      const printRes = triggerBrowserPrint();
      if (!printRes.ok) {
        pushToast({
          type: 'warning',
          title: 'Impression bloquée',
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

  const scaleClass =
    zoom === '75' ? 'scale-[0.75] origin-top' : zoom === '100' ? 'scale-100 origin-top' : 'w-full max-w-[210mm]';

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-slate-900/70 p-3 sm:p-4 print:static print:bg-white print:p-0">
      {/* Barre d’actions supérieure */}
      <div className="no-print mx-auto mb-3 flex w-full max-w-5xl flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-4 py-2.5 shadow-md">
        <div className="flex items-center gap-3 min-w-0">
          <span className="truncate text-sm font-semibold text-slate-900">{title}</span>
          <div className="hidden sm:flex items-center gap-1 rounded-md bg-slate-100 p-0.5 text-[11px]">
            <ZoomIn className="ml-1.5 mr-0.5 h-3.5 w-3.5 text-slate-500" />
            {(
              [
                { id: 'fit', label: 'Ajuster' },
                { id: '100', label: '100%' },
                { id: '75', label: '75%' },
              ] as const
            ).map((z) => (
              <button
                key={z.id}
                type="button"
                onClick={() => setZoom(z.id)}
                className={`rounded px-2 py-0.5 font-medium ${
                  zoom === z.id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
                }`}
              >
                {z.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={isGeneratingPdf}
            onClick={handleExportPdf}
            className="inline-flex items-center gap-2 rounded-md px-3.5 py-1.5 text-xs font-semibold text-white shadow-sm hover:opacity-90 disabled:opacity-60"
            style={{ backgroundColor: accentColor }}
          >
            {isGeneratingPdf ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            <span>{isGeneratingPdf ? 'Génération du PDF…' : 'Exporter PDF (A4)'}</span>
          </button>

          {onExportExcel && (
            <button
              type="button"
              onClick={onExportExcel}
              className="inline-flex items-center gap-1.5 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-800 hover:bg-emerald-100"
            >
              <FileSpreadsheet className="h-3.5 w-3.5" />
              <span>Exporter Excel (.xlsx)</span>
            </button>
          )}

          <button
            type="button"
            onClick={handlePrint}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            <Printer className="h-3.5 w-3.5" />
            <span>Imprimer</span>
          </button>

          {fallbackPrintRoute && !isElectron && (
            <button
              type="button"
              onClick={() => {
                onClose();
                navigate(fallbackPrintRoute);
              }}
              title="Ouvrir la vue d’impression plein écran"
              className="hidden md:inline-flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-100"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              <span>Vue A4</span>
            </button>
          )}

          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-slate-300 bg-white p-1.5 text-slate-600 hover:bg-slate-50"
            aria-label="Fermer l’aperçu"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Zone de prévisualisation A4 */}
      <div className="mx-auto flex w-full max-w-5xl flex-1 justify-center overflow-auto rounded-lg bg-slate-800/35 p-4 sm:p-6 print:block print:overflow-visible print:bg-white print:p-0">
        <div className={`${scaleClass} transition-transform`}>
          <div
            ref={sheetRef}
            className={`print-area mx-auto print:shadow-none ${
              rawLayout ? 'w-[210mm] bg-transparent' : 'w-[210mm] bg-white p-10 shadow-2xl'
            }`}
          >
            {!rawLayout && (
              <div className="mb-6 flex items-start justify-between border-b border-slate-300 pb-5">
                <div className="flex items-start gap-4">
                  {(companyProfile?.logoDataUrl || settings?.logoDataUrl) && (
                    <img
                      src={companyProfile?.logoDataUrl || settings?.logoDataUrl}
                      alt={companyName}
                      className="h-16 w-16 object-contain"
                    />
                  )}
                  <div>
                    <h1 className="text-lg font-bold text-slate-900">{companyName}</h1>
                    {(companyProfile?.address || settings?.address) && (
                      <p className="text-xs text-slate-600">
                        {companyProfile?.address || settings?.address}
                      </p>
                    )}
                    <p className="mt-1 text-xs text-slate-600">
                      {[
                        companyProfile?.phone || settings?.phone,
                        companyProfile?.email || settings?.email,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                    <p className="mt-1 text-[11px] text-slate-500">
                      {[
                        (companyProfile?.nif || settings?.nif)
                          ? `NIF : ${companyProfile?.nif || settings?.nif}`
                          : '',
                        (companyProfile?.nis || settings?.nis)
                          ? `NIS : ${companyProfile?.nis || settings?.nis}`
                          : '',
                        (companyProfile?.rc || settings?.rc)
                          ? `RC : ${companyProfile?.rc || settings?.rc}`
                          : '',
                        (companyProfile?.ai || settings?.ai)
                          ? `AI : ${companyProfile?.ai || settings?.ai}`
                          : '',
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  </div>
                </div>

                <div className="text-right">
                  <div className="text-xs text-slate-500">
                    Édité le {new Date().toLocaleDateString('fr-FR')}
                  </div>
                </div>
              </div>
            )}

            <div>{children}</div>
          </div>
        </div>
      </div>
    </div>
  );
};
