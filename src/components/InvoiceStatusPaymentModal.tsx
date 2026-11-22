import React, { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Check, CreditCard, X } from 'lucide-react';
import { db } from '../db/database';
import type { CustomerInvoice, PaymentMethod } from '../db/types';
import { recordInvoiceStatusPayment } from '../services/financeActions';
import { computePaymentUnallocatedCentimes } from '../utils/finance';
import {
  centimesToInputString,
  formatMoney,
  parseMoneyInputToCentimes,
} from '../utils/money';
import { useAppStore } from '../store/useAppStore';

interface InvoiceStatusPaymentModalProps {
  open: boolean;
  invoice: CustomerInvoice | null;
  targetStatus: 'payee' | 'partielle';
  remainingCentimes: number;
  onClose: () => void;
  onSaved?: () => void;
}

export const InvoiceStatusPaymentModal: React.FC<InvoiceStatusPaymentModalProps> = ({
  open,
  invoice,
  targetStatus,
  remainingCentimes,
  onClose,
  onSaved,
}) => {
  const pushToast = useAppStore((s) => s.pushToast);
  const bankAccounts = useLiveQuery(
    () => db.bankAccounts.filter((b) => !b.deletedAt && b.active).toArray(),
    [],
    []
  );
  const incomingCheques = useLiveQuery(
    () => db.incomingCheques.filter((c) => !c.deletedAt).toArray(),
    [],
    []
  );
  const payments = useLiveQuery(
    () => db.payments.filter((p) => !p.deletedAt).toArray(),
    [],
    []
  );
  const allocations = useLiveQuery(() => db.paymentAllocations.toArray(), [], []);

  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [amountText, setAmountText] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('virement');
  const [bankAccountId, setBankAccountId] = useState('');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');

  const [chequeChoice, setChequeChoice] = useState<'new' | 'existing'>('new');
  const [existingChequeId, setExistingChequeId] = useState('');
  const [chequeNumber, setChequeNumber] = useState('');
  const [issuerBank, setIssuerBank] = useState('');
  const [chequeDate, setChequeDate] = useState(new Date().toISOString().slice(0, 10));

  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const clientCheques = useMemo(() => {
    if (!invoice) return [];
    const payMap = new Map(payments.map((p) => [p.id, p]));
    return incomingCheques
      .filter((c) => {
        if (c.clientId !== invoice.clientId) return false;
        if (c.status === 'rejete' || c.status === 'annule') return false;
        if (c.linkedPaymentId) {
          const linked = payMap.get(c.linkedPaymentId);
          if (!linked || linked.status !== 'valide') return false;
          const avail = computePaymentUnallocatedCentimes(linked, allocations);
          return avail > 0;
        }
        return true;
      })
      .map((c) => {
        let availableCentimes = c.amountCentimes;
        if (c.linkedPaymentId) {
          const linked = payMap.get(c.linkedPaymentId);
          if (linked) {
            availableCentimes = computePaymentUnallocatedCentimes(linked, allocations);
          }
        }
        return { cheque: c, availableCentimes };
      });
  }, [invoice, incomingCheques, payments, allocations]);

  useEffect(() => {
    if (!open || !invoice) return;
    const today = new Date().toISOString().slice(0, 10);
    setDate(today);
    setChequeDate(today);
    setError('');
    setMethod('virement');
    setReference('');
    setNotes('');
    setChequeNumber('');
    setIssuerBank('');
    setChequeChoice('new');
    setExistingChequeId(clientCheques[0]?.cheque.id || '');
    setBankAccountId(bankAccounts[0]?.id || '');

    if (targetStatus === 'payee') {
      setAmountText(centimesToInputString(remainingCentimes));
    } else {
      const half = Math.max(100, Math.round(remainingCentimes / 2));
      setAmountText(centimesToInputString(Math.min(half, Math.max(0, remainingCentimes - 1))));
    }
  }, [open, invoice?.id, targetStatus, remainingCentimes]);

  useEffect(() => {
    if (!open || bankAccountId || bankAccounts.length === 0) return;
    setBankAccountId(bankAccounts[0].id);
  }, [open, bankAccounts, bankAccountId]);

  if (!open || !invoice) return null;

  const parsedAmount = parseMoneyInputToCentimes(amountText);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (Number.isNaN(parsedAmount) || parsedAmount <= 0) {
      setError('Veuillez saisir un montant valide supérieur à zéro.');
      return;
    }
    if (parsedAmount > remainingCentimes) {
      setError('Le montant saisi dépasse le reste à payer sur cette facture.');
      return;
    }
    if (targetStatus === 'partielle' && parsedAmount >= remainingCentimes) {
      setError(
        'Pour un paiement partiel, le montant doit être inférieur au reste à payer (sinon choisissez « Payée »).'
      );
      return;
    }

    if (method === 'cheque' && chequeChoice === 'existing' && !existingChequeId) {
      setError('Veuillez choisir un chèque reçu existant ou créer un nouveau chèque.');
      return;
    }
    if (method === 'cheque' && chequeChoice === 'new' && !chequeNumber.trim()) {
      setError('Veuillez saisir le numéro du chèque.');
      return;
    }

    setBusy(true);
    try {
      await recordInvoiceStatusPayment({
        invoiceId: invoice.id,
        date,
        amountCentimes: parsedAmount,
        method,
        bankAccountId: method === 'especes' ? null : bankAccountId || null,
        reference,
        notes,
        ...(method === 'cheque' && chequeChoice === 'existing'
          ? { existingChequeId }
          : method === 'cheque'
          ? {
              chequeNumber: chequeNumber.trim(),
              issuerBank: issuerBank.trim(),
              chequeDate,
            }
          : {}),
      });

      const isNowFullyPaid = parsedAmount >= remainingCentimes;
      pushToast({
        type: 'success',
        title: isNowFullyPaid ? 'Facture marquée payée' : 'Paiement partiel enregistré',
        message: `${invoice.invoiceNumber} — ${formatMoney(parsedAmount, invoice.currency)}`,
      });
      onSaved?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Impossible d’enregistrer le paiement.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
      <div className="w-full max-w-lg rounded-lg border border-slate-200 bg-white shadow-xl overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-200 bg-[#0F1E36] px-5 py-3.5 text-white">
          <div className="flex items-center gap-2">
            <CreditCard className="h-4 w-4 text-emerald-300" />
            <h3 className="text-sm font-semibold">
              {targetStatus === 'payee'
                ? `Régler la facture ${invoice.invoiceNumber}`
                : `Paiement partiel / avance — ${invoice.invoiceNumber}`}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-slate-300 hover:bg-slate-800 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {error}
            </div>
          )}

          <div className="rounded-md bg-slate-50 border border-slate-200 px-3 py-2 text-xs flex items-center justify-between">
            <span className="text-slate-600">Reste à payer sur la facture</span>
            <strong className="text-sm text-slate-900 tabular-nums">
              {formatMoney(remainingCentimes, invoice.currency)}
            </strong>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-medium text-slate-700">Date de paiement *</label>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                required
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700">
                Montant ({invoice.currency}) *
              </label>
              <input
                type="text"
                value={amountText}
                onChange={(e) => setAmountText(e.target.value)}
                required
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-right font-semibold tabular-nums"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700">Mode *</label>
              <select
                value={method}
                onChange={(e) => setMethod(e.target.value as PaymentMethod)}
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
              >
                <option value="especes">Espèces</option>
                <option value="virement">Virement</option>
                <option value="cheque">Chèque</option>
                <option value="versement">Versement</option>
              </select>
            </div>

            {method !== 'especes' && (
              <div>
                <label className="block text-xs font-medium text-slate-700">Compte bancaire</label>
                <select
                  value={bankAccountId}
                  onChange={(e) => setBankAccountId(e.target.value)}
                  className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
                >
                  <option value="">— Compte par défaut —</option>
                  {bankAccounts.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.bankName} — {b.accountName}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {method === 'cheque' && (
            <div className="rounded-lg border border-amber-200 bg-amber-50/70 p-3.5 space-y-3">
              <div className="flex flex-wrap items-center gap-3 text-xs font-medium">
                <label className="inline-flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    checked={chequeChoice === 'new'}
                    onChange={() => setChequeChoice('new')}
                  />
                  <span>Créer un nouveau chèque reçu</span>
                </label>
                <label className="inline-flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    checked={chequeChoice === 'existing'}
                    onChange={() => setChequeChoice('existing')}
                    disabled={clientCheques.length === 0}
                  />
                  <span className={clientCheques.length === 0 ? 'text-slate-400' : ''}>
                    Chèque reçu existant ({clientCheques.length})
                  </span>
                </label>
              </div>

              {chequeChoice === 'existing' ? (
                <div>
                  <label className="block text-xs text-slate-700">Choisir un chèque reçu *</label>
                  <select
                    value={existingChequeId}
                    onChange={(e) => {
                      const id = e.target.value;
                      setExistingChequeId(id);
                      const found = clientCheques.find((c) => c.cheque.id === id);
                      if (found) {
                        const maxPay = Math.min(remainingCentimes, found.availableCentimes);
                        setAmountText(centimesToInputString(maxPay));
                      }
                    }}
                    className="mt-1 w-full rounded border border-slate-300 bg-white px-2.5 py-2 text-xs"
                  >
                    <option value="">— Sélectionner —</option>
                    {clientCheques.map(({ cheque, availableCentimes }) => (
                      <option key={cheque.id} value={cheque.id}>
                        N° {cheque.chequeNumber} · {cheque.issuerBank} · Dispo{' '}
                        {formatMoney(availableCentimes, cheque.currency)} ({cheque.status})
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                  <div>
                    <label className="block text-xs text-slate-700">N° chèque *</label>
                    <input
                      type="text"
                      value={chequeNumber}
                      onChange={(e) => setChequeNumber(e.target.value)}
                      placeholder="0012345"
                      className="mt-1 w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-700">Banque</label>
                    <input
                      type="text"
                      value={issuerBank}
                      onChange={(e) => setIssuerBank(e.target.value)}
                      placeholder="BNA, BEA, AGB..."
                      className="mt-1 w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-700">Date chèque</label>
                    <input
                      type="date"
                      value={chequeDate}
                      onChange={(e) => setChequeDate(e.target.value)}
                      className="mt-1 w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-sm"
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-medium text-slate-700">Référence</label>
              <input
                type="text"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="N° reçu, bordereau..."
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-xs"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700">Notes</label>
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Optionnel"
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-xs"
              />
            </div>
          </div>

          <div className="flex justify-end gap-2 border-t border-slate-200 pt-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              Annuler
            </button>
            <button
              type="submit"
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
            >
              <Check className="h-3.5 w-3.5" />
              <span>{busy ? 'Enregistrement…' : 'Enregistrer le paiement'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
