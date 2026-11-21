import React, { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import * as XLSX from 'xlsx';
import { Download, Eye, FileText, Loader2, RefreshCw, Trash2, Upload, X } from 'lucide-react';
import { db } from '../db/database';
import type { DocumentAttachment } from '../db/types';
import {
  addAttachmentToPurchaseOrder,
  removeAttachment,
  replaceAttachmentFile,
} from '../services/documentActions';
import { dataUrlToUint8Array } from '../services/import/bcImportSaveService';
import { renderPdfPagesForPreview } from '../services/import/pdfBcReader';
import { useAppStore } from '../store/useAppStore';

interface AttachmentPreviewModalProps {
  open: boolean;
  parentId: string;
  parentType?: 'bc_recu' | 'bc_emis';
  title: string;
  readOnly?: boolean;
  onClose: () => void;
}

const MAX_RECOMMENDED_BYTES = 10 * 1024 * 1024;

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('Impossible de lire le fichier.'));
    };
    reader.onerror = () => reject(new Error('Erreur de lecture du fichier.'));
    reader.readAsDataURL(file);
  });
}

export function triggerAttachmentDownload(att: DocumentAttachment): void {
  const link = document.createElement('a');
  link.href = att.dataUrl;
  link.download = att.fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

export const AttachmentPreviewModal: React.FC<AttachmentPreviewModalProps> = ({
  open,
  parentId,
  parentType = 'bc_recu',
  title,
  readOnly = false,
  onClose,
}) => {
  const pushToast = useAppStore((s) => s.pushToast);
  const attachments = useLiveQuery(
    () =>
      parentId
        ? db.documentAttachments.where('parentId').equals(parentId).toArray()
        : Promise.resolve([] as DocumentAttachment[]),
    [parentId],
    []
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [renderedPdfPages, setRenderedPdfPages] = useState<
    Array<{ pageNumber: number; dataUrl: string }>
  >([]);
  const [excelGrid, setExcelGrid] = useState<string[][] | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const activeAttachment =
    attachments.find((a) => a.id === selectedId) || attachments[0] || null;

  const isPdfAtt = Boolean(
    activeAttachment &&
      (activeAttachment.mimeType.includes('pdf') ||
        activeAttachment.fileName.toLowerCase().endsWith('.pdf'))
  );
  const isExcelAtt = Boolean(
    activeAttachment && /\.(xlsx|xls)$/i.test(activeAttachment.fileName)
  );

  useEffect(() => {
    let cancelled = false;
    setRenderedPdfPages([]);
    setExcelGrid(null);
    if (!open || !activeAttachment) return;

    if (isPdfAtt) {
      setPreviewLoading(true);
      try {
        const bytes = dataUrlToUint8Array(activeAttachment.dataUrl);
        const ab = bytes.slice().buffer;
        renderPdfPagesForPreview(ab, 1.45)
          .then((pages) => {
            if (!cancelled) setRenderedPdfPages(pages);
          })
          .catch(() => {
            if (!cancelled) setRenderedPdfPages([]);
          })
          .finally(() => {
            if (!cancelled) setPreviewLoading(false);
          });
      } catch {
        setPreviewLoading(false);
      }
    } else if (isExcelAtt) {
      try {
        const bytes = dataUrlToUint8Array(activeAttachment.dataUrl);
        const wb = XLSX.read(bytes, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        if (ws) {
          const rows = XLSX.utils.sheet_to_json(ws, {
            header: 1,
            raw: false,
            defval: '',
          }) as string[][];
          setExcelGrid(rows.slice(0, 60));
        }
      } catch {
        setExcelGrid(null);
      }
    }

    return () => {
      cancelled = true;
    };
  }, [open, activeAttachment?.id, isPdfAtt, isExcelAtt]);

  if (!open) return null;

  const handleAddFiles = async (files: FileList | null) => {
    if (!files || !parentId) return;
    for (const file of Array.from(files)) {
      if (file.size > MAX_RECOMMENDED_BYTES) {
        pushToast({
          type: 'warning',
          title: 'Fichier volumineux (> 10 Mo)',
          message: `« ${file.name} » fait ${(file.size / (1024 * 1024)).toFixed(1)} Mo.`,
        });
      }
      const dataUrl = await readFileAsDataUrl(file);
      const saved = await addAttachmentToPurchaseOrder({
        parentId,
        parentType,
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
        dataUrl,
      });
      setSelectedId(saved.id);
    }
    pushToast({ type: 'success', title: 'Document(s) ajouté(s)' });
  };

  const handleReplace = async (attId: string, file?: File) => {
    if (!file) return;
    if (file.size > MAX_RECOMMENDED_BYTES) {
      pushToast({
        type: 'warning',
        title: 'Fichier volumineux (> 10 Mo)',
        message: `« ${file.name} » dépasse 10 Mo.`,
      });
    }
    const dataUrl = await readFileAsDataUrl(file);
    await replaceAttachmentFile({
      attachmentId: attId,
      fileName: file.name,
      mimeType: file.type || 'application/octet-stream',
      sizeBytes: file.size,
      dataUrl,
    });
    pushToast({ type: 'success', title: 'Document remplacé', message: file.name });
  };

  const handleDelete = async (att: DocumentAttachment) => {
    await removeAttachment(att.id);
    if (selectedId === att.id) setSelectedId(null);
    pushToast({ type: 'info', title: 'Document retiré', message: att.fileName });
  };

  const isPdf = (att: DocumentAttachment) =>
    att.mimeType.includes('pdf') || att.fileName.toLowerCase().endsWith('.pdf');
  const isImage = (att: DocumentAttachment) =>
    att.mimeType.startsWith('image/') ||
    /\.(png|jpe?g|webp|gif)$/i.test(att.fileName);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4">
      <div className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 bg-[#0F1E36] px-6 py-3.5 text-white">
          <div className="flex items-center gap-2">
            <Eye className="h-4 w-4" />
            <h3 className="text-sm font-semibold">{title}</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-slate-300 hover:bg-slate-800 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid flex-1 min-h-0 grid-cols-1 md:grid-cols-12">
          {/* Liste des pièces jointes */}
          <div className="border-r border-slate-200 bg-slate-50 p-4 md:col-span-4 space-y-3 overflow-y-auto">
            {!readOnly && (
              <label className="flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed border-slate-300 bg-white px-3 py-2.5 text-xs font-medium text-slate-700 hover:border-[#1D4ED8] hover:text-[#1D4ED8]">
                <Upload className="h-4 w-4" />
                <span>Ajouter PDF / Image</span>
                <input
                  type="file"
                  multiple
                  accept=".pdf,image/png,image/jpeg,image/webp"
                  onChange={(e) => handleAddFiles(e.target.files)}
                  className="hidden"
                />
              </label>
            )}

            {attachments.length === 0 ? (
              <div className="rounded border border-slate-200 bg-white p-4 text-center text-xs text-slate-500">
                Aucun fichier joint pour ce document.
              </div>
            ) : (
              <div className="space-y-2">
                {attachments.map((att) => {
                  const active = activeAttachment?.id === att.id;
                  return (
                    <div
                      key={att.id}
                      onClick={() => setSelectedId(att.id)}
                      className={`cursor-pointer rounded-md border p-2.5 text-xs transition-colors ${
                        active
                          ? 'border-[#1D4ED8] bg-blue-50'
                          : 'border-slate-200 bg-white hover:bg-slate-50'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-semibold text-slate-900">
                            {att.fileName}
                          </div>
                          <div className="mt-0.5 text-[11px] text-slate-500">
                            {(att.sizeBytes / 1024).toFixed(0)} Ko
                          </div>
                        </div>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedId(att.id);
                          }}
                          className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] text-slate-700 hover:bg-slate-100"
                        >
                          <Eye className="h-3 w-3" />
                          <span>Ouvrir</span>
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            triggerAttachmentDownload(att);
                          }}
                          className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] text-slate-700 hover:bg-slate-100"
                        >
                          <Download className="h-3 w-3" />
                          <span>Télécharger</span>
                        </button>
                        {!readOnly && (
                          <>
                            <label
                              onClick={(e) => e.stopPropagation()}
                              className="inline-flex cursor-pointer items-center gap-1 rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] text-slate-700 hover:bg-slate-100"
                            >
                              <RefreshCw className="h-3 w-3" />
                              <span>Remplacer</span>
                              <input
                                type="file"
                                accept=".pdf,image/png,image/jpeg,image/webp"
                                onChange={(e) => handleReplace(att.id, e.target.files?.[0])}
                                className="hidden"
                              />
                            </label>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDelete(att);
                              }}
                              className="inline-flex items-center gap-1 rounded border border-red-200 bg-white px-2 py-0.5 text-[11px] text-red-600 hover:bg-red-50"
                            >
                              <Trash2 className="h-3 w-3" />
                              <span>Supprimer</span>
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Zone d'aperçu */}
          <div className="flex flex-col items-center justify-start bg-slate-100 p-4 md:col-span-8 overflow-auto min-h-[420px] max-h-[76vh]">
            {!activeAttachment ? (
              <div className="my-auto text-center text-xs text-slate-500">
                <FileText className="mx-auto mb-2 h-8 w-8 text-slate-400" />
                Sélectionnez un fichier pour l’afficher ici.
              </div>
            ) : isImage(activeAttachment) ? (
              <img
                src={activeAttachment.dataUrl}
                alt={activeAttachment.fileName}
                className="max-h-[72vh] max-w-full rounded border border-slate-300 bg-white object-contain shadow-sm"
              />
            ) : isPdf(activeAttachment) ? (
              previewLoading ? (
                <div className="my-auto flex items-center gap-2 text-xs text-slate-600">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Chargement du PDF…</span>
                </div>
              ) : renderedPdfPages.length > 0 ? (
                <div className="w-full space-y-3">
                  {renderedPdfPages.map((pg) => (
                    <img
                      key={pg.pageNumber}
                      src={pg.dataUrl}
                      alt={`${activeAttachment.fileName} page ${pg.pageNumber}`}
                      className="mx-auto max-w-full rounded border border-slate-300 bg-white shadow-sm"
                    />
                  ))}
                </div>
              ) : (
                <iframe
                  src={activeAttachment.dataUrl}
                  title={activeAttachment.fileName}
                  className="h-[70vh] w-full rounded border border-slate-300 bg-white"
                />
              )
            ) : excelGrid ? (
              <div className="w-full overflow-x-auto rounded border border-slate-300 bg-white p-2 shadow-sm">
                <table className="w-full border-collapse text-[11px]">
                  <tbody>
                    {excelGrid.map((row, rIdx) => (
                      <tr key={rIdx}>
                        {row.slice(0, 10).map((cell, cIdx) => (
                          <td
                            key={cIdx}
                            className="border border-slate-200 px-2 py-1 text-slate-700 whitespace-pre-wrap"
                          >
                            {cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="my-auto rounded-lg border border-slate-200 bg-white p-6 text-center space-y-3">
                <FileText className="mx-auto h-10 w-10 text-slate-400" />
                <div className="text-sm font-medium text-slate-800">
                  {activeAttachment.fileName}
                </div>
                <button
                  type="button"
                  onClick={() => triggerAttachmentDownload(activeAttachment)}
                  className="inline-flex items-center gap-1.5 rounded bg-[#0F1E36] px-4 py-2 text-xs font-medium text-white"
                >
                  <Download className="h-3.5 w-3.5" />
                  <span>Télécharger le fichier</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
