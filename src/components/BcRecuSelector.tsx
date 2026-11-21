import React, { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Paperclip, Search, X } from 'lucide-react';
import { db } from '../db/database';
import type { PurchaseOrder } from '../db/types';
import { formatDateFr } from '../utils/documentHelpers';
import { formatMoney } from '../utils/money';

interface BcRecuSelectorProps {
  clientId: string;
  bcNumber: string;
  linkedBcRecuId?: string;
  onChange: (val: {
    bcNumber: string;
    linkedBcRecuId?: string;
    campaignId?: string;
    campaignRef?: string;
    startDate?: string;
    endDate?: string;
  }) => void;
  onPreviewAttachment?: (bcId: string) => void;
}

export const BcRecuSelector: React.FC<BcRecuSelectorProps> = ({
  clientId,
  bcNumber,
  linkedBcRecuId,
  onChange,
  onPreviewAttachment,
}) => {
  const bcList = useLiveQuery(
    () =>
      db.purchaseOrders
        .filter((po) => po.direction === 'bc_recu' && !po.deletedAt)
        .toArray(),
    [],
    []
  );
  const [open, setOpen] = useState(false);

  const clientBcs = useMemo(() => {
    const q = bcNumber.trim().toLowerCase();
    return bcList
      .filter((po) => {
        if (clientId && po.contactId !== clientId) return false;
        if (!q) return true;
        return (
          po.poNumber.toLowerCase().includes(q) ||
          po.campaignRef.toLowerCase().includes(q)
        );
      })
      .sort((a, b) => b.issueDate.localeCompare(a.issueDate))
      .slice(0, 8);
  }, [bcList, clientId, bcNumber]);

  const selectedBc = useMemo(
    () => bcList.find((po) => po.id === linkedBcRecuId),
    [bcList, linkedBcRecuId]
  );

  const handleSelect = (po: PurchaseOrder) => {
    onChange({
      bcNumber: po.poNumber,
      linkedBcRecuId: po.id,
      campaignId: po.campaignId,
      campaignRef: po.campaignRef,
      startDate: po.campaignStartDate,
      endDate: po.campaignEndDate,
    });
    setOpen(false);
  };

  return (
    <div className="relative">
      <div className="relative flex items-center gap-1.5">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400" />
          <input
            type="text"
            value={bcNumber}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 180)}
            onChange={(e) => {
              onChange({
                bcNumber: e.target.value,
                linkedBcRecuId: undefined,
              });
              setOpen(true);
            }}
            placeholder="Ex : 38/26/RL (ou choisir un BC reçu)"
            className="w-full rounded-md border border-slate-300 py-2 pr-7 pl-8 text-sm"
          />
          {bcNumber && (
            <button
              type="button"
              onClick={() => onChange({ bcNumber: '', linkedBcRecuId: undefined })}
              className="absolute right-2 top-2.5 rounded p-0.5 text-slate-400 hover:text-slate-600"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {selectedBc && (selectedBc.attachmentsCount || 0) > 0 && onPreviewAttachment && (
          <button
            type="button"
            onClick={() => onPreviewAttachment(selectedBc.id)}
            title={`Voir le document joint au BC ${selectedBc.poNumber}`}
            className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-slate-50 px-2.5 py-2 text-xs font-medium text-[#1D4ED8] hover:bg-blue-50 shrink-0"
          >
            <Paperclip className="h-3.5 w-3.5" />
            <span>{selectedBc.attachmentsCount}</span>
          </button>
        )}
      </div>

      {open && clientBcs.length > 0 && (
        <div className="absolute z-30 mt-1 w-full rounded-md border border-slate-200 bg-white shadow-lg overflow-hidden">
          {clientBcs.map((po) => (
            <button
              key={po.id}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                handleSelect(po);
              }}
              className="flex w-full items-center justify-between px-3 py-2 text-left text-xs hover:bg-slate-50"
            >
              <div className="min-w-0">
                <span className="font-semibold text-slate-900">{po.poNumber}</span>
                {po.campaignRef && (
                  <span className="ml-2 text-slate-600">· {po.campaignRef}</span>
                )}
                <div className="text-[11px] text-slate-400">
                  Reçu le {formatDateFr(po.issueDate)}
                </div>
              </div>
              <div className="ml-2 flex items-center gap-2 shrink-0">
                {(po.attachmentsCount || 0) > 0 && (
                  <Paperclip className="h-3 w-3 text-[#1D4ED8]" />
                )}
                {po.totalTtcCentimes > 0 && (
                  <span className="font-medium text-slate-700 tabular-nums">
                    {formatMoney(po.totalTtcCentimes, po.currency)}
                  </span>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
