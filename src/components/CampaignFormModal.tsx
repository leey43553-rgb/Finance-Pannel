import React, { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Check, X } from 'lucide-react';
import { db } from '../db/database';
import type { Campaign, CampaignStatus } from '../db/types';
import { saveCampaign } from '../services/documentActions';
import { computeCampaignDuration, suggestCampaignStatus } from '../utils/documentHelpers';
import { useAppStore } from '../store/useAppStore';

interface CampaignFormModalProps {
  open: boolean;
  existingCampaign?: Campaign;
  preselectedClientId?: string;
  onClose: () => void;
  onSaved?: (saved: Campaign) => void;
}

export const CampaignFormModal: React.FC<CampaignFormModalProps> = ({
  open,
  existingCampaign,
  preselectedClientId,
  onClose,
  onSaved,
}) => {
  const pushToast = useAppStore((s) => s.pushToast);
  const contacts = useLiveQuery(
    () => db.contacts.filter((c) => !c.deletedAt).toArray(),
    [],
    []
  );
  const profiles = useLiveQuery(
    () => db.companyProfiles.filter((p) => !p.deletedAt).toArray(),
    [],
    []
  );
  const settings = useLiveQuery(() => db.settings.get('company_settings'));

  const [name, setName] = useState('');
  const [clientId, setClientId] = useState('');
  const [companyProfileId, setCompanyProfileId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [status, setStatus] = useState<CampaignStatus>('en_cours');
  const [statusManuallyEdited, setStatusManuallyEdited] = useState(false);
  const [notes, setNotes] = useState('');
  const [propagateToLinkedDocs, setPropagateToLinkedDocs] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError('');
    const activeProf =
      profiles.find((p) => p.id === settings?.activeCompanyProfileId) ||
      profiles.find((p) => p.isDefault) ||
      profiles[0];

    if (existingCampaign) {
      setName(existingCampaign.name);
      setClientId(existingCampaign.clientId);
      setCompanyProfileId(existingCampaign.companyProfileId || activeProf?.id || '');
      setStartDate(existingCampaign.startDate || '');
      setEndDate(existingCampaign.endDate || '');
      setStatus(existingCampaign.status);
      setStatusManuallyEdited(true);
      setNotes(existingCampaign.notes || '');
      setPropagateToLinkedDocs(true);
    } else {
      setName('');
      setClientId(preselectedClientId || '');
      setCompanyProfileId(activeProf?.id || '');
      setStartDate('');
      setEndDate('');
      setStatus('en_cours');
      setStatusManuallyEdited(false);
      setNotes('');
      setPropagateToLinkedDocs(true);
    }
  }, [open, existingCampaign, preselectedClientId]);

  const clientOptions = useMemo(
    () =>
      contacts.filter(
        (c) => (!c.archived || c.id === clientId) && (c.type === 'client' || c.type === 'les_deux')
      ),
    [contacts, clientId]
  );

  const duration = useMemo(
    () => computeCampaignDuration(startDate, endDate),
    [startDate, endDate]
  );

  if (!open) return null;

  const handleDatesChange = (nextStart: string, nextEnd: string) => {
    setStartDate(nextStart);
    setEndDate(nextEnd);
    if (!existingCampaign && !statusManuallyEdited && status !== 'annulee' && nextStart && nextEnd) {
      setStatus(suggestCampaignStatus(nextStart, nextEnd));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!duration.valid) {
      setError(duration.label);
      return;
    }
    setBusy(true);
    try {
      const clientChanged =
        Boolean(existingCampaign) && existingCampaign?.clientId !== clientId;
      const saved = await saveCampaign({
        existingId: existingCampaign?.id,
        name,
        clientId,
        companyProfileId: companyProfileId || undefined,
        startDate,
        endDate,
        status,
        notes,
        propagateToLinkedDocs: Boolean(existingCampaign && propagateToLinkedDocs),
        propagateClient: Boolean(existingCampaign && propagateToLinkedDocs && clientChanged),
      });
      pushToast({
        type: 'success',
        title: existingCampaign ? 'Campagne mise à jour' : 'Campagne créée',
        message: saved.name,
      });
      onSaved?.(saved);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
      <div className="w-full max-w-lg rounded-lg border border-slate-200 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 bg-[#0F1E36] px-6 py-4 text-white">
          <h2 className="text-base font-semibold">
            {existingCampaign ? `Modifier « ${existingCampaign.name} »` : 'Nouvelle campagne'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-slate-300 hover:bg-slate-800 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {error}
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-slate-700">Nom de la campagne *</label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ex : CMP Coke Summer"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-medium text-slate-700">Client *</label>
              <select
                required
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
              >
                <option value="">— Sélectionner un client —</option>
                {clientOptions.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.company || c.name}
                  </option>
                ))}
              </select>
            </div>

            {profiles.length > 0 && (
              <div>
                <label className="block text-xs font-medium text-slate-700">
                  Société associée
                </label>
                <select
                  value={companyProfileId}
                  onChange={(e) => setCompanyProfileId(e.target.value)}
                  className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
                >
                  <option value="">— Aucune / Par défaut —</option>
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-700">
                Date de début (optionnel)
              </label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => handleDatesChange(e.target.value, endDate)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700">
                Date de fin (optionnel)
              </label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => handleDatesChange(startDate, e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
          </div>

          <div
            className={`rounded-md border px-3 py-2 text-xs ${
              duration.valid
                ? 'border-slate-200 bg-slate-50 text-slate-700'
                : 'border-red-200 bg-red-50 text-red-700'
            }`}
          >
            {!duration.valid
              ? duration.label
              : startDate && endDate
              ? `Durée calculée : ${duration.label} (${duration.days} jours)`
              : 'Dates non définies (vous pourrez les compléter plus tard)'}
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700">Statut</label>
            <select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value as CampaignStatus);
                setStatusManuallyEdited(true);
              }}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              <option value="prevue">Prévue</option>
              <option value="en_cours">En cours</option>
              <option value="terminee">Terminée</option>
              <option value="annulee">Annulée</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700">Notes</label>
            <textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </div>

          {existingCampaign && (
            <label className="flex cursor-pointer items-center gap-2 rounded-md border border-blue-200 bg-blue-50/70 px-3 py-2 text-xs text-slate-800">
              <input
                type="checkbox"
                checked={propagateToLinkedDocs}
                onChange={(e) => setPropagateToLinkedDocs(e.target.checked)}
              />
              <span>Appliquer aussi aux documents liés (BC, proformas, factures)</span>
            </label>
          )}

          <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700"
            >
              Annuler
            </button>
            <button
              type="submit"
              disabled={busy || !duration.valid}
              className="inline-flex items-center gap-1.5 rounded-md bg-[#0F1E36] px-4 py-2 text-xs font-medium text-white hover:bg-[#1a2f52] disabled:opacity-60"
            >
              <Check className="h-3.5 w-3.5" />
              <span>{busy ? 'Enregistrement...' : 'Enregistrer'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
