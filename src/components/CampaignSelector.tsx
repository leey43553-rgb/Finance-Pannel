import React, { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Plus, Search, X } from 'lucide-react';
import { db } from '../db/database';
import type { Campaign } from '../db/types';
import { saveCampaign } from '../services/documentActions';
import { formatDateFr } from '../utils/documentHelpers';
import { useAppStore } from '../store/useAppStore';

interface CampaignSelectorProps {
  clientId: string;
  campaignId?: string;
  campaignRef: string;
  onChange: (selection: {
    campaignId?: string;
    campaignRef: string;
    startDate?: string;
    endDate?: string;
  }) => void;
  placeholder?: string;
}

export const CampaignSelector: React.FC<CampaignSelectorProps> = ({
  clientId,
  campaignId,
  campaignRef,
  onChange,
  placeholder = 'Rechercher ou créer une campagne (ex: CMP Coke Summer)...',
}) => {
  const pushToast = useAppStore((s) => s.pushToast);
  const allCampaigns = useLiveQuery(
    () => db.campaigns.filter((c) => !c.deletedAt).toArray(),
    [],
    []
  );

  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [quickCreateOpen, setQuickCreateOpen] = useState(false);
  const [qStart, setQStart] = useState('');
  const [qEnd, setQEnd] = useState('');
  const [creating, setCreating] = useState(false);

  const suggestions = useMemo(() => {
    const q = campaignRef.trim().toLowerCase();
    return allCampaigns
      .filter((c) => {
        if (clientId && c.clientId !== clientId) return false;
        if (!q) return true;
        return c.name.toLowerCase().includes(q);
      })
      .sort((a, b) => b.startDate.localeCompare(a.startDate))
      .slice(0, 8);
  }, [allCampaigns, clientId, campaignRef]);

  const exactMatchExists = useMemo(() => {
    const q = campaignRef.trim().toLowerCase();
    if (!q) return true;
    return allCampaigns.some(
      (c) =>
        (!clientId || c.clientId === clientId) &&
        c.name.trim().toLowerCase() === q
    );
  }, [allCampaigns, clientId, campaignRef]);

  const handleSelectCampaign = (c: Campaign) => {
    onChange({
      campaignId: c.id,
      campaignRef: c.name,
      startDate: c.startDate,
      endDate: c.endDate,
    });
    setDropdownOpen(false);
  };

  const handleQuickCreate = async () => {
    if (!clientId) {
      pushToast({
        type: 'warning',
        title: 'Client requis',
        message: 'Sélectionnez d’abord un client pour créer sa campagne.',
      });
      return;
    }
    if (!campaignRef.trim()) return;
    setCreating(true);
    try {
      const created = await saveCampaign({
        name: campaignRef.trim(),
        clientId,
        startDate: qStart,
        endDate: qEnd,
      });
      onChange({
        campaignId: created.id,
        campaignRef: created.name,
        startDate: created.startDate,
        endDate: created.endDate,
      });
      setQuickCreateOpen(false);
      setDropdownOpen(false);
      pushToast({
        type: 'success',
        title: 'Campagne créée',
        message:
          created.startDate && created.endDate
            ? `${created.name} (${formatDateFr(created.startDate)} → ${formatDateFr(created.endDate)})`
            : created.name,
      });
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Impossible de créer la campagne',
        message: err instanceof Error ? err.message : 'Erreur',
      });
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="relative">
      <div className="relative flex items-center">
        <Search className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-slate-400" />
        <input
          type="text"
          value={campaignRef}
          onFocus={() => setDropdownOpen(true)}
          onBlur={() => setTimeout(() => setDropdownOpen(false), 180)}
          onChange={(e) => {
            onChange({
              campaignId: undefined,
              campaignRef: e.target.value,
            });
            setDropdownOpen(true);
          }}
          placeholder={placeholder}
          className="w-full rounded-md border border-slate-300 py-2 pr-8 pl-8 text-sm focus:border-[#1D4ED8] focus:outline-none"
        />
        {(campaignId || campaignRef) && (
          <button
            type="button"
            onClick={() => {
              onChange({ campaignId: undefined, campaignRef: '' });
              setQuickCreateOpen(false);
            }}
            className="absolute right-2 rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            title="Effacer la campagne"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {dropdownOpen && (suggestions.length > 0 || (campaignRef.trim() && !exactMatchExists)) && (
        <div className="absolute z-30 mt-1 w-full rounded-md border border-slate-200 bg-white shadow-lg overflow-hidden">
          {suggestions.map((c) => (
            <button
              key={c.id}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                handleSelectCampaign(c);
              }}
              className={`flex w-full items-center justify-between px-3 py-2 text-left text-xs hover:bg-slate-50 ${
                c.id === campaignId ? 'bg-blue-50 font-semibold text-[#0F1E36]' : 'text-slate-800'
              }`}
            >
              <span className="truncate font-medium">{c.name}</span>
              <span className="ml-2 shrink-0 text-[11px] text-slate-500 tabular-nums">
                {formatDateFr(c.startDate)} → {formatDateFr(c.endDate)}
              </span>
            </button>
          ))}

          {campaignRef.trim() && !exactMatchExists && (
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                setQuickCreateOpen(true);
                setDropdownOpen(false);
              }}
              className="flex w-full items-center gap-1.5 border-t border-slate-100 bg-slate-50 px-3 py-2 text-left text-xs font-medium text-[#1D4ED8] hover:bg-blue-50"
            >
              <Plus className="h-3.5 w-3.5 shrink-0" />
              <span>Créer la campagne « {campaignRef.trim()} »</span>
            </button>
          )}
        </div>
      )}

      {quickCreateOpen && (
        <div className="mt-2 rounded-md border border-blue-200 bg-blue-50/70 p-3 space-y-2">
          <div className="flex items-center justify-between text-xs font-semibold text-[#0F1E36]">
            <span>Nouvelle campagne : {campaignRef.trim()}</span>
            <button
              type="button"
              onClick={() => setQuickCreateOpen(false)}
              className="text-slate-500 hover:text-slate-800"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[11px] text-slate-600">Date début (optionnel)</label>
              <input
                type="date"
                value={qStart}
                onChange={(e) => setQStart(e.target.value)}
                className="mt-0.5 w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs"
              />
            </div>
            <div>
              <label className="block text-[11px] text-slate-600">Date fin (optionnel)</label>
              <input
                type="date"
                value={qEnd}
                onChange={(e) => setQEnd(e.target.value)}
                className="mt-0.5 w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs"
              />
            </div>
          </div>
          <div className="flex justify-end">
            <button
              type="button"
              disabled={creating}
              onClick={handleQuickCreate}
              className="inline-flex items-center gap-1 rounded bg-[#0F1E36] px-3 py-1 text-xs font-medium text-white hover:bg-[#1a2f52]"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>{creating ? 'Création...' : 'Créer la campagne'}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
