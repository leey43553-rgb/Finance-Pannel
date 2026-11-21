import React, { useEffect, useState } from 'react';
import { AlertTriangle, Trash2, X } from 'lucide-react';
import {
  inspectLinksBeforeDelete,
  restoreFromTrash,
  softDeleteEntity,
  type LinkedCheckResult,
  type TrashEntityType,
} from '../services/trashService';
import { useAppStore } from '../store/useAppStore';

interface SafeDeleteDialogProps {
  open: boolean;
  entityType: TrashEntityType;
  entityId: string;
  entityLabel: string;
  onClose: () => void;
  onDeleted?: () => void;
}

export const SafeDeleteDialog: React.FC<SafeDeleteDialogProps> = ({
  open,
  entityType,
  entityId,
  entityLabel,
  onClose,
  onDeleted,
}) => {
  const pushToast = useAppStore((s) => s.pushToast);
  const [check, setCheck] = useState<LinkedCheckResult | null>(null);
  const [keepPaymentsAsAdvance, setKeepPaymentsAsAdvance] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !entityId) {
      setCheck(null);
      return;
    }
    setKeepPaymentsAsAdvance(true);
    inspectLinksBeforeDelete(entityType, entityId).then(setCheck);
  }, [open, entityType, entityId]);

  if (!open) return null;

  const handleConfirm = async () => {
    setBusy(true);
    try {
      const res = await softDeleteEntity({
        entityType,
        id: entityId,
        keepPaymentsAsAdvance,
      });
      onClose();
      onDeleted?.();
      pushToast({
        type: 'info',
        title: `${res.label} déplacé dans la corbeille`,
        message: 'Restaurable pendant 8 secondes ou depuis Paramètres → Corbeille.',
        undoLabel: 'Annuler',
        durationMs: 8000,
        onUndo: async () => {
          await restoreFromTrash(entityType, entityId);
          pushToast({
            type: 'success',
            title: 'Élément restauré',
            message: res.label,
          });
        },
      });
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Suppression impossible',
        message: err instanceof Error ? err.message : 'Erreur inconnue',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-6 shadow-xl space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <AlertTriangle className="h-5 w-5 shrink-0 text-red-600" />
            <h3 className="text-base font-semibold text-slate-900">
              Supprimer « {entityLabel} » ?
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="text-xs leading-relaxed text-slate-600">
          Cet élément sera placé dans la <strong>Corbeille</strong> (Paramètres → Corbeille) et pourra être restauré à tout moment.
        </p>

        {check?.hasLinks && (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-950 space-y-1.5">
            <div className="font-semibold">Éléments liés détectés :</div>
            <ul className="list-disc pl-4 space-y-0.5">
              {check.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
            <p className="pt-1 text-[11px] text-amber-800">
              Si vous continuez, les documents liés seront conservés avec la mention « Facture supprimée » ou détachés proprement.
            </p>
          </div>
        )}

        {check?.hasInvoicePayments && (
          <label className="flex items-start gap-2.5 rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-800 cursor-pointer">
            <input
              type="checkbox"
              checked={keepPaymentsAsAdvance}
              onChange={(e) => setKeepPaymentsAsAdvance(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              <strong>Conserver les paiements comme avance client</strong> : les règlements encaissés restent crédités sur le compte du client (recommandé).
            </span>
          </label>
        )}

        <div className="flex justify-end gap-2.5 pt-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            Annuler
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-4 py-2 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-60"
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span>{check?.hasLinks ? 'Supprimer quand même' : 'Mettre à la corbeille'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
