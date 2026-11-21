import React, { useId } from 'react';
import { Copy, Lock, Plus, RefreshCw, SlidersHorizontal, Sparkles, Trash2, Unlock } from 'lucide-react';
import type { InvoiceLine, OutdoorCatalogConfig } from '../db/types';
import { computeCampaignDuration } from '../utils/documentHelpers';
import {
  computeGuidedLineValues,
  computeSurfaceM2,
  createDefaultEditableLine,
  DEFAULT_OUTDOOR_CATALOG,
  formatDecimalFr,
  generateGuidedLineDescription,
  type GuidedPricingUnit,
  parsePanelDimensionsFromLabel,
  parsePositiveDecimal,
  pricingUnitToInvoiceUnit,
  type SmartEditableLine,
} from '../utils/guidedLineHelpers';
import { centimesToInputString, formatMoney, parseMoneyInputToCentimes } from '../utils/money';
import { createId } from '../db/database';

interface SmartLineEditorProps {
  title: string;
  lines: SmartEditableLine[];
  computedLines: InvoiceLine[];
  currency: string;
  defaultTva: number;
  showAdvancedFields: boolean;
  catalog?: OutdoorCatalogConfig;
  campaignStartDate?: string;
  campaignEndDate?: string;
  minLines?: number;
  allowDiscount?: boolean;
  onChange: (nextLines: SmartEditableLine[]) => void;
}

const PRICING_UNIT_LABELS: Array<{ value: GuidedPricingUnit; label: string }> = [
  { value: 'mois', label: 'Par mois' },
  { value: 'm2', label: 'Par m²' },
  { value: 'jour', label: 'Par jour' },
  { value: 'u', label: 'À l’unité' },
  { value: 'ml', label: 'Par ml' },
  { value: 'forfait', label: 'Forfait' },
];

export const SmartLineEditor: React.FC<SmartLineEditorProps> = ({
  title,
  lines,
  computedLines,
  currency,
  defaultTva,
  showAdvancedFields,
  catalog = DEFAULT_OUTDOOR_CATALOG,
  campaignStartDate,
  campaignEndDate,
  minLines = 1,
  allowDiscount = true,
  onChange,
}) => {
  const uid = useId();
  const serviceListId = `srv-${uid}`;
  const panelListId = `pnl-${uid}`;
  const locationListId = `loc-${uid}`;
  const faceListId = `fce-${uid}`;

  const campaignDur = computeCampaignDuration(campaignStartDate, campaignEndDate);
  const hasCampaignDuration = Boolean(
    campaignStartDate && campaignEndDate && campaignDur.valid && campaignDur.days > 0
  );

  const getSuggestedCampaignDuration = (): { valueText: string; unit: 'mois' | 'jours' } => {
    if (!hasCampaignDuration) return { valueText: '1', unit: 'mois' };
    if (campaignDur.monthsFloat >= 1 && Number.isInteger(campaignDur.monthsFloat)) {
      return { valueText: String(campaignDur.monthsFloat), unit: 'mois' };
    }
    return { valueText: String(campaignDur.days), unit: 'jours' };
  };

  const applyGuidedUpdate = (
    lineId: string,
    patch: Partial<SmartEditableLine>,
    options?: { forceRegenerateDescription?: boolean }
  ) => {
    onChange(
      lines.map((line) => {
        if (line.id !== lineId) return line;
        const next: SmartEditableLine = { ...line, ...patch };

        if (next.lineMode === 'guidee') {
          const w = parsePositiveDecimal(next.widthText, 0);
          const h = parsePositiveDecimal(next.heightText, 0);
          const count = parsePositiveDecimal(next.panelCountText, 1);
          const durVal = parsePositiveDecimal(next.durationValueText, 1);
          const unitPrice = parseMoneyInputToCentimes(next.unitPriceText);
          const safeUnitPrice = Number.isNaN(unitPrice) ? 0 : unitPrice;
          const disc = parsePositiveDecimal(next.discountText, 0);
          const tva = parsePositiveDecimal(next.tvaRateText, 0);
          const manualHt = parseMoneyInputToCentimes(next.manualHtText);
          const safeManualHt = Number.isNaN(manualHt) ? 0 : manualHt;

          const guided = computeGuidedLineValues({
            serviceType: next.serviceType,
            panelType: next.panelType,
            location: next.location,
            face: next.face,
            widthM: w > 0 ? w : undefined,
            heightM: h > 0 ? h : undefined,
            panelCount: count,
            durationValue: durVal,
            durationUnit: next.durationUnit,
            pricingUnit: next.pricingUnit,
            unitPriceCentimes: safeUnitPrice,
            discountPercent: disc,
            tvaRate: tva,
            manualTotalLocked: next.manualTotalLocked,
            manualHtCentimes: safeManualHt,
          });

          next.quantityText = formatDecimalFr(guided.quantity);
          next.unit = guided.unit;
          if (!next.manualTotalLocked) {
            next.manualHtText = centimesToInputString(guided.htCentimes);
          }

          if (options?.forceRegenerateDescription || !next.manualDesignationEdited) {
            next.description = generateGuidedLineDescription({
              serviceType: next.serviceType,
              panelType: next.panelType,
              location: next.location,
              face: next.face,
              widthM: w > 0 ? w : undefined,
              heightM: h > 0 ? h : undefined,
              surfaceM2: guided.surfaceM2,
              panelCount: count,
              durationValue: durVal,
              durationUnit: next.durationUnit,
              pricingUnit: next.pricingUnit,
            });
            if (options?.forceRegenerateDescription) {
              next.manualDesignationEdited = false;
            }
          }
        }

        return next;
      })
    );
  };

  const switchLineMode = (line: SmartEditableLine, targetMode: 'libre' | 'guidee') => {
    if (line.lineMode === targetMode) return;
    if (targetMode === 'libre') {
      applyGuidedUpdate(line.id, { lineMode: 'libre' });
      return;
    }

    const durSuggest = getSuggestedCampaignDuration();
    const shouldGenerateDesc = !line.description.trim();
    applyGuidedUpdate(
      line.id,
      {
        lineMode: 'guidee',
        durationValueText: line.durationValueText || durSuggest.valueText,
        durationUnit: hasCampaignDuration ? durSuggest.unit : line.durationUnit,
        manualDesignationEdited: !shouldGenerateDesc,
      },
      { forceRegenerateDescription: shouldGenerateDesc }
    );
  };

  const addLine = (mode: 'libre' | 'guidee') => {
    const base = createDefaultEditableLine(createId('line'), defaultTva, { lineMode: mode });
    if (mode === 'guidee') {
      const durSuggest = getSuggestedCampaignDuration();
      base.durationValueText = durSuggest.valueText;
      base.durationUnit = durSuggest.unit;
      base.pricingUnit = durSuggest.unit === 'jours' ? 'jour' : 'mois';
      base.unit = pricingUnitToInvoiceUnit(base.pricingUnit);
      base.description = generateGuidedLineDescription({
        serviceType: base.serviceType,
        panelCount: 1,
        durationValue: parsePositiveDecimal(base.durationValueText, 1),
        durationUnit: base.durationUnit,
        pricingUnit: base.pricingUnit,
      });
    }
    onChange([...lines, base]);
  };

  const duplicateLine = (line: SmartEditableLine) => {
    onChange([...lines, { ...line, id: createId('line') }]);
  };

  const removeLine = (lineId: string) => {
    if (lines.length <= minLines) return;
    onChange(lines.filter((l) => l.id !== lineId));
  };

  const libreIndices = lines
    .map((l, idx) => (l.lineMode === 'libre' ? idx : -1))
    .filter((idx) => idx >= 0);
  const guidedIndices = lines
    .map((l, idx) => (l.lineMode === 'guidee' ? idx : -1))
    .filter((idx) => idx >= 0);

  return (
    <div className="space-y-3">
      <datalist id={serviceListId}>
        {catalog.serviceTypes.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
      <datalist id={panelListId}>
        {catalog.panelTypes.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>
      <datalist id={locationListId}>
        {catalog.locations.map((loc) => (
          <option key={loc} value={loc} />
        ))}
      </datalist>
      <datalist id={faceListId}>
        {catalog.faces.map((f) => (
          <option key={f} value={f} />
        ))}
      </datalist>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => addLine('libre')}
            className="inline-flex items-center gap-1.5 rounded border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>Ajouter une ligne</span>
          </button>
          <button
            type="button"
            onClick={() => addLine('guidee')}
            className="inline-flex items-center gap-1.5 rounded border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-medium text-[#1D4ED8] hover:bg-blue-100"
          >
            <Sparkles className="h-3.5 w-3.5" />
            <span>+ Ligne guidée (publicité)</span>
          </button>
        </div>
      </div>

      {/* Lignes en saisie libre (tableau compact classique conservé) */}
      {libreIndices.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-200 bg-slate-50 font-semibold text-slate-600">
              <tr>
                <th className="px-2.5 py-2">Désignation (multi-lignes)</th>
                <th className="w-20 px-2 py-2 text-right">Qté</th>
                <th className="w-24 px-2 py-2">Unité</th>
                <th className="w-32 px-2 py-2 text-right">Prix unitaire HT</th>
                {showAdvancedFields && (
                  <>
                    {allowDiscount && <th className="w-20 px-2 py-2 text-right">Remise %</th>}
                    <th className="w-20 px-2 py-2 text-right">TVA %</th>
                    <th className="w-28 px-2.5 py-2 text-right">Total HT</th>
                  </>
                )}
                <th className="w-28 px-2.5 py-2 text-right">Total TTC</th>
                <th className="w-24 px-2 py-2 text-right">Mode / Act.</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {libreIndices.map((index) => {
                const line = lines[index];
                const comp = computedLines[index];
                return (
                  <tr key={line.id} className="align-top bg-white">
                    <td className="p-1.5">
                      <textarea
                        rows={2}
                        value={line.description}
                        onChange={(e) =>
                          applyGuidedUpdate(line.id, { description: e.target.value })
                        }
                        placeholder="Titre de la prestation&#10;Détails (support, lieu, dimensions...)"
                        className="w-full rounded border border-slate-200 px-2 py-1.5 text-xs focus:border-[#1D4ED8] focus:outline-none"
                      />
                    </td>
                    <td className="p-1.5">
                      <input
                        type="text"
                        value={line.quantityText}
                        onChange={(e) =>
                          applyGuidedUpdate(line.id, { quantityText: e.target.value })
                        }
                        className="w-full rounded border border-slate-200 px-2 py-1.5 text-right text-xs tabular-nums"
                      />
                    </td>
                    <td className="p-1.5">
                      <select
                        value={line.unit}
                        onChange={(e) => applyGuidedUpdate(line.id, { unit: e.target.value })}
                        className="w-full rounded border border-slate-200 bg-white px-1.5 py-1.5 text-xs"
                      >
                        <option value="u">u</option>
                        <option value="m²">m²</option>
                        <option value="mois">mois</option>
                        <option value="jour">jour</option>
                        <option value="forfait">forfait</option>
                        <option value="ml">ml</option>
                      </select>
                    </td>
                    <td className="p-1.5">
                      <input
                        type="text"
                        value={line.unitPriceText}
                        onChange={(e) =>
                          applyGuidedUpdate(line.id, { unitPriceText: e.target.value })
                        }
                        className="w-full rounded border border-slate-200 px-2 py-1.5 text-right text-xs tabular-nums"
                      />
                    </td>
                    {showAdvancedFields && (
                      <>
                        {allowDiscount && (
                          <td className="p-1.5">
                            <input
                              type="text"
                              value={line.discountText}
                              onChange={(e) =>
                                applyGuidedUpdate(line.id, { discountText: e.target.value })
                              }
                              className="w-full rounded border border-slate-200 px-2 py-1.5 text-right text-xs tabular-nums"
                            />
                          </td>
                        )}
                        <td className="p-1.5">
                          <input
                            type="text"
                            value={line.tvaRateText}
                            onChange={(e) =>
                              applyGuidedUpdate(line.id, { tvaRateText: e.target.value })
                            }
                            className="w-full rounded border border-slate-200 px-2 py-1.5 text-right text-xs tabular-nums"
                          />
                        </td>
                        <td className="px-2.5 py-2 text-right font-medium text-slate-700 tabular-nums whitespace-nowrap">
                          {formatMoney(comp?.htCentimes || 0, currency)}
                        </td>
                      </>
                    )}
                    <td className="px-2.5 py-2 text-right font-semibold text-slate-900 tabular-nums whitespace-nowrap">
                      {formatMoney(comp?.ttcCentimes || 0, currency)}
                    </td>
                    <td className="p-1.5 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-0.5">
                        <button
                          type="button"
                          onClick={() => switchLineMode(line, 'guidee')}
                          className="rounded border border-blue-200 bg-blue-50 px-1.5 py-1 text-[10px] font-semibold text-[#1D4ED8] hover:bg-blue-100"
                          title="Passer cette ligne en saisie guidée (publicité)"
                        >
                          Guidée
                        </button>
                        <button
                          type="button"
                          onClick={() => duplicateLine(line)}
                          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                          title="Dupliquer la ligne"
                        >
                          <Copy className="h-3.5 w-3.5" />
                        </button>
                        {lines.length > minLines && (
                          <button
                            type="button"
                            onClick={() => removeLine(line.id)}
                            className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
                            aria-label="Supprimer la ligne"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Lignes en saisie guidée (affichage structuré métier publicité extérieure) */}
      {guidedIndices.map((index) => {
        const line = lines[index];
        const comp = computedLines[index];
        const w = parsePositiveDecimal(line.widthText, 0);
        const h = parsePositiveDecimal(line.heightText, 0);
        const surface = computeSurfaceM2(w, h);
        const durSuggest = getSuggestedCampaignDuration();

        return (
          <div
            key={line.id}
            className="rounded-lg border border-blue-200 bg-blue-50/30 p-3.5 space-y-3"
          >
            {/* En-tête de ligne guidée */}
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-blue-100 pb-2">
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1 rounded bg-[#0F1E36] px-2 py-0.5 text-[11px] font-semibold text-white">
                  <SlidersHorizontal className="h-3 w-3" />
                  Ligne {index + 1} · Saisie guidée
                </span>
                {hasCampaignDuration && (
                  <button
                    type="button"
                    onClick={() =>
                      applyGuidedUpdate(line.id, {
                        durationValueText: durSuggest.valueText,
                        durationUnit: durSuggest.unit,
                      })
                    }
                    className="rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
                  >
                    Durée campagne ({campaignDur.label})
                  </button>
                )}
              </div>

              <div className="flex items-center gap-2">
                <div className="inline-flex rounded border border-slate-300 bg-white p-0.5 text-[11px]">
                  <button
                    type="button"
                    onClick={() => switchLineMode(line, 'libre')}
                    className="rounded px-2 py-0.5 font-medium text-slate-600 hover:bg-slate-100"
                  >
                    Saisie libre
                  </button>
                  <button
                    type="button"
                    className="rounded bg-[#1D4ED8] px-2 py-0.5 font-semibold text-white"
                  >
                    Saisie guidée
                  </button>
                </div>

                <button
                  type="button"
                  onClick={() => duplicateLine(line)}
                  className="rounded p-1 text-slate-500 hover:bg-white hover:text-slate-800"
                  title="Dupliquer la ligne"
                >
                  <Copy className="h-3.5 w-3.5" />
                </button>
                {lines.length > minLines && (
                  <button
                    type="button"
                    onClick={() => removeLine(line.id)}
                    className="rounded p-1 text-slate-500 hover:bg-red-50 hover:text-red-600"
                    aria-label="Supprimer la ligne"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>

            {/* Paramètres publicité extérieure */}
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-4">
              <div>
                <label className="block text-[11px] font-medium text-slate-700">
                  Type de prestation
                </label>
                <input
                  type="text"
                  list={serviceListId}
                  value={line.serviceType}
                  onChange={(e) => applyGuidedUpdate(line.id, { serviceType: e.target.value })}
                  placeholder="Ex : Location panneau"
                  className="mt-0.5 w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium text-slate-700">
                  Support / Format
                </label>
                <input
                  type="text"
                  list={panelListId}
                  value={line.panelType}
                  onChange={(e) => {
                    const val = e.target.value;
                    const parsedDims = parsePanelDimensionsFromLabel(val);
                    const patch: Partial<SmartEditableLine> = { panelType: val };
                    if (parsedDims.widthM && parsedDims.heightM) {
                      patch.widthText = formatDecimalFr(parsedDims.widthM);
                      patch.heightText = formatDecimalFr(parsedDims.heightM);
                    }
                    applyGuidedUpdate(line.id, patch);
                  }}
                  placeholder="Ex : Unipol 12×4 m"
                  className="mt-0.5 w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium text-slate-700">
                  Emplacement / Ville
                </label>
                <input
                  type="text"
                  list={locationListId}
                  value={line.location}
                  onChange={(e) => applyGuidedUpdate(line.id, { location: e.target.value })}
                  placeholder="Ex : Alger Centre"
                  className="mt-0.5 w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium text-slate-700">Face</label>
                <input
                  type="text"
                  list={faceListId}
                  value={line.face}
                  onChange={(e) => applyGuidedUpdate(line.id, { face: e.target.value })}
                  placeholder="Ex : Face A"
                  className="mt-0.5 w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
                />
              </div>
            </div>

            {/* Dimensions, quantités, durée & tarification */}
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-6">
              <div>
                <label className="block text-[11px] font-medium text-slate-700">
                  Largeur (m)
                </label>
                <input
                  type="text"
                  value={line.widthText}
                  onChange={(e) => applyGuidedUpdate(line.id, { widthText: e.target.value })}
                  placeholder="4"
                  className="mt-0.5 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-right text-xs tabular-nums"
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium text-slate-700">
                  Hauteur (m)
                </label>
                <input
                  type="text"
                  value={line.heightText}
                  onChange={(e) => applyGuidedUpdate(line.id, { heightText: e.target.value })}
                  placeholder="3"
                  className="mt-0.5 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-right text-xs tabular-nums"
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium text-slate-700">
                  Surface calc.
                </label>
                <div className="mt-0.5 rounded border border-slate-200 bg-slate-100 px-2 py-1.5 text-right text-xs font-semibold text-slate-700 tabular-nums">
                  {surface > 0 ? `${formatDecimalFr(surface)} m²` : '—'}
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-medium text-slate-700">
                  Nb panneaux / u
                </label>
                <input
                  type="text"
                  value={line.panelCountText}
                  onChange={(e) => applyGuidedUpdate(line.id, { panelCountText: e.target.value })}
                  className="mt-0.5 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-right text-xs tabular-nums"
                />
              </div>

              <div className="col-span-2 grid grid-cols-2 gap-1.5">
                <div>
                  <label className="block text-[11px] font-medium text-slate-700">Durée</label>
                  <input
                    type="text"
                    value={line.durationValueText}
                    onChange={(e) =>
                      applyGuidedUpdate(line.id, { durationValueText: e.target.value })
                    }
                    className="mt-0.5 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-right text-xs tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-700">Unité</label>
                  <select
                    value={line.durationUnit}
                    onChange={(e) =>
                      applyGuidedUpdate(line.id, {
                        durationUnit: e.target.value as 'mois' | 'jours',
                      })
                    }
                    className="mt-0.5 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-xs"
                  >
                    <option value="mois">mois</option>
                    <option value="jours">jours</option>
                  </select>
                </div>
              </div>
            </div>

            {/* Prix unitaire, base de tarification, remise/TVA, total HT manuel */}
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-6 items-end">
              <div>
                <label className="block text-[11px] font-medium text-slate-700">
                  Facturer par
                </label>
                <select
                  value={line.pricingUnit}
                  onChange={(e) =>
                    applyGuidedUpdate(line.id, {
                      pricingUnit: e.target.value as GuidedPricingUnit,
                    })
                  }
                  className="mt-0.5 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-xs"
                >
                  {PRICING_UNIT_LABELS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-medium text-slate-700">
                  Qté facturée
                </label>
                <div className="mt-0.5 rounded border border-slate-200 bg-slate-100 px-2 py-1.5 text-right text-xs font-medium text-slate-800 tabular-nums">
                  {line.quantityText} {line.unit}
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-medium text-slate-700">
                  Prix unitaire HT
                </label>
                <input
                  type="text"
                  value={line.unitPriceText}
                  onChange={(e) => applyGuidedUpdate(line.id, { unitPriceText: e.target.value })}
                  className="mt-0.5 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-right text-xs tabular-nums"
                />
              </div>

              {showAdvancedFields ? (
                <>
                  {allowDiscount ? (
                    <div>
                      <label className="block text-[11px] font-medium text-slate-700">
                        Remise %
                      </label>
                      <input
                        type="text"
                        value={line.discountText}
                        onChange={(e) =>
                          applyGuidedUpdate(line.id, { discountText: e.target.value })
                        }
                        className="mt-0.5 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-right text-xs tabular-nums"
                      />
                    </div>
                  ) : (
                    <div />
                  )}
                  <div>
                    <label className="block text-[11px] font-medium text-slate-700">TVA %</label>
                    <input
                      type="text"
                      value={line.tvaRateText}
                      onChange={(e) =>
                        applyGuidedUpdate(line.id, { tvaRateText: e.target.value })
                      }
                      className="mt-0.5 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-right text-xs tabular-nums"
                    />
                  </div>
                </>
              ) : (
                <div className="sm:col-span-2" />
              )}

              <div>
                <div className="flex items-center justify-between">
                  <label className="block text-[11px] font-medium text-slate-700">Total HT</label>
                  <button
                    type="button"
                    onClick={() =>
                      applyGuidedUpdate(line.id, {
                        manualTotalLocked: !line.manualTotalLocked,
                        manualHtText: centimesToInputString(comp?.htCentimes || 0),
                      })
                    }
                    className={`inline-flex items-center gap-0.5 text-[10px] font-medium ${
                      line.manualTotalLocked ? 'text-amber-700' : 'text-slate-500 hover:text-slate-800'
                    }`}
                    title={
                      line.manualTotalLocked
                        ? 'Revenir au calcul automatique'
                        : 'Saisir un montant HT forfaitaire négocié'
                    }
                  >
                    {line.manualTotalLocked ? (
                      <>
                        <Lock className="h-2.5 w-2.5" />
                        <span>Auto</span>
                      </>
                    ) : (
                      <>
                        <Unlock className="h-2.5 w-2.5" />
                        <span>Forcer</span>
                      </>
                    )}
                  </button>
                </div>
                {line.manualTotalLocked ? (
                  <input
                    type="text"
                    value={line.manualHtText}
                    onChange={(e) => applyGuidedUpdate(line.id, { manualHtText: e.target.value })}
                    className="mt-0.5 w-full rounded border border-amber-400 bg-amber-50 px-2 py-1.5 text-right text-xs font-semibold tabular-nums"
                  />
                ) : (
                  <div className="mt-0.5 rounded border border-slate-200 bg-white px-2 py-1.5 text-right text-xs font-semibold text-slate-800 tabular-nums">
                    {formatMoney(comp?.htCentimes || 0, currency)}
                  </div>
                )}
              </div>
            </div>

            {/* Désignation générée + Total TTC */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-12 items-end pt-1">
              <div className="sm:col-span-9">
                <div className="flex items-center justify-between">
                  <label className="block text-[11px] font-medium text-slate-700">
                    Désignation sur document (générée automatiquement, modifiable)
                  </label>
                  {line.manualDesignationEdited && (
                    <button
                      type="button"
                      onClick={() =>
                        applyGuidedUpdate(line.id, {}, { forceRegenerateDescription: true })
                      }
                      className="inline-flex items-center gap-1 text-[11px] font-medium text-[#1D4ED8] hover:underline"
                    >
                      <RefreshCw className="h-3 w-3" />
                      <span>Régénérer le libellé</span>
                    </button>
                  )}
                </div>
                <textarea
                  rows={2}
                  value={line.description}
                  onChange={(e) =>
                    onChange(
                      lines.map((x) =>
                        x.id === line.id
                          ? { ...x, description: e.target.value, manualDesignationEdited: true }
                          : x
                      )
                    )
                  }
                  className="mt-0.5 w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
                />
              </div>

              <div className="sm:col-span-3 rounded border border-slate-200 bg-white px-3 py-2 text-right">
                <div className="text-[10px] font-medium uppercase tracking-wide text-slate-500">
                  Total TTC ligne
                </div>
                <div className="text-sm font-bold text-[#0F1E36] tabular-nums">
                  {formatMoney(comp?.ttcCentimes || 0, currency)}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};
