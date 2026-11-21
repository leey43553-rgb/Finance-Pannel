import type { CompanySettings, InvoiceLine, OutdoorCatalogConfig } from '../db/types';
import { centimesToInputString, computeInvoiceLineTotals, parseMoneyInputToCentimes } from './money';

export const DEFAULT_OUTDOOR_CATALOG: OutdoorCatalogConfig = {
  serviceTypes: [
    'Location panneau publicitaire',
    'Affichage écran LED',
    'Impression numérique bâche / vinyle',
    'Pose & dépose',
    'Habillage façade / vitrine',
    'Création graphique',
    'Éclairage & maintenance',
  ],
  panelTypes: [
    'Unipol 12×4 m',
    'Panneau 4×3 m',
    'Panneau 6×3 m',
    'Panneau 8×3 m',
    'Totem 2×1 m',
    'Écran LED extérieur 6×3 m',
    'Sucette MUPI 1,2×1,8 m',
    'Bâche grand format',
  ],
  faces: ['Face A', 'Face B', 'Recto / Verso', '360°', 'Écran complet'],
  locations: [
    'Alger Centre',
    'Autoroute Est-Ouest',
    'Rocade Sud Alger',
    'Oran — Rond-point',
    'Constantine',
    'Sétif',
    'Annaba',
  ],
};

export function getEffectiveOutdoorCatalog(settings?: CompanySettings | null): OutdoorCatalogConfig {
  const custom = settings?.outdoorCatalog;
  if (!custom) return DEFAULT_OUTDOOR_CATALOG;
  return {
    serviceTypes:
      custom.serviceTypes?.length > 0 ? custom.serviceTypes : DEFAULT_OUTDOOR_CATALOG.serviceTypes,
    panelTypes:
      custom.panelTypes?.length > 0 ? custom.panelTypes : DEFAULT_OUTDOOR_CATALOG.panelTypes,
    faces: custom.faces?.length > 0 ? custom.faces : DEFAULT_OUTDOOR_CATALOG.faces,
    locations:
      custom.locations?.length > 0 ? custom.locations : DEFAULT_OUTDOOR_CATALOG.locations,
  };
}

export type GuidedPricingUnit = 'mois' | 'm2' | 'u' | 'forfait' | 'jour' | 'ml';

export interface SmartEditableLine {
  id: string;
  lineMode: 'libre' | 'guidee';
  description: string;
  quantityText: string;
  unit: string;
  unitPriceText: string;
  discountText: string;
  tvaRateText: string;
  // Champs saisie guidée
  serviceType: string;
  panelType: string;
  location: string;
  face: string;
  widthText: string;
  heightText: string;
  panelCountText: string;
  durationValueText: string;
  durationUnit: 'mois' | 'jours';
  pricingUnit: GuidedPricingUnit;
  manualTotalLocked: boolean;
  manualHtText: string;
  manualDesignationEdited: boolean;
}

export function parsePositiveDecimal(raw: string, fallback = 0): number {
  const cleaned = String(raw ?? '')
    .trim()
    .replace(/\s|\u00A0|\u202F/g, '')
    .replace(',', '.');
  if (!cleaned) return fallback;
  const val = parseFloat(cleaned);
  return Number.isFinite(val) && val >= 0 ? val : fallback;
}

export function formatDecimalFr(val: number): string {
  if (!Number.isFinite(val)) return '0';
  const rounded = Math.round(val * 100) / 100;
  return String(rounded).replace('.', ',');
}

export function parsePanelDimensionsFromLabel(label: string): {
  widthM?: number;
  heightM?: number;
} {
  const match = label.match(/(\d+(?:[.,]\d+)?)\s*[x×*]\s*(\d+(?:[.,]\d+)?)/i);
  if (!match) return {};
  const w = parseFloat(match[1].replace(',', '.'));
  const h = parseFloat(match[2].replace(',', '.'));
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return {};
  return { widthM: w, heightM: h };
}

export function computeSurfaceM2(widthM?: number, heightM?: number): number {
  const w = Number(widthM || 0);
  const h = Number(heightM || 0);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return 0;
  return Math.round(w * h * 100) / 100;
}

export function pricingUnitToInvoiceUnit(pricingUnit: GuidedPricingUnit): string {
  if (pricingUnit === 'm2') return 'm²';
  return pricingUnit;
}

export function invoiceUnitToPricingUnit(unit?: string): GuidedPricingUnit {
  if (unit === 'm²' || unit === 'm2') return 'm2';
  if (unit === 'mois' || unit === 'jour' || unit === 'u' || unit === 'forfait' || unit === 'ml') {
    return unit;
  }
  return 'mois';
}

export function generateGuidedLineDescription(params: {
  serviceType?: string;
  panelType?: string;
  location?: string;
  face?: string;
  widthM?: number;
  heightM?: number;
  surfaceM2?: number;
  panelCount?: number;
  durationValue?: number;
  durationUnit?: 'mois' | 'jours';
  pricingUnit?: GuidedPricingUnit;
}): string {
  const service = (params.serviceType || '').trim();
  const panel = (params.panelType || '').trim();
  const location = (params.location || '').trim();
  const face = (params.face || '').trim();
  const w = Number(params.widthM || 0);
  const h = Number(params.heightM || 0);
  const surface =
    params.surfaceM2 && params.surfaceM2 > 0 ? params.surfaceM2 : computeSurfaceM2(w, h);
  const count = Number(params.panelCount || 0);
  const duration = Number(params.durationValue || 0);
  const durationUnit = params.durationUnit || 'mois';

  const titleParts: string[] = [];
  if (service) titleParts.push(service);
  if (panel) titleParts.push(panel);

  let line1 = titleParts.join(' — ') || 'Prestation publicitaire';
  if (location) {
    line1 += ` — ${location}`;
  }
  if (face) {
    line1 += ` (${face})`;
  }

  const detailParts: string[] = [];
  if (w > 0 && h > 0) {
    detailParts.push(`Format : ${formatDecimalFr(w)} × ${formatDecimalFr(h)} m (${formatDecimalFr(surface)} m²)`);
  } else if (surface > 0) {
    detailParts.push(`Surface : ${formatDecimalFr(surface)} m²`);
  }
  if (count > 0) {
    detailParts.push(`Quantité : ${formatDecimalFr(count)} ${count > 1 ? 'unités' : 'unité'}`);
  }
  if (duration > 0 && (params.pricingUnit === 'mois' || params.pricingUnit === 'jour' || !params.pricingUnit)) {
    const unitWord =
      durationUnit === 'mois' ? 'mois' : duration > 1 ? 'jours' : 'jour';
    detailParts.push(`Durée : ${formatDecimalFr(duration)} ${unitWord}`);
  }

  return detailParts.length > 0 ? `${line1}\n${detailParts.join(' · ')}` : line1;
}

export function computeGuidedLineValues(params: {
  serviceType?: string;
  panelType?: string;
  location?: string;
  face?: string;
  widthM?: number;
  heightM?: number;
  panelCount?: number;
  durationValue?: number;
  durationUnit?: 'mois' | 'jours';
  pricingUnit: GuidedPricingUnit;
  unitPriceCentimes: number;
  discountPercent: number;
  tvaRate: number;
  manualTotalLocked?: boolean;
  manualHtCentimes?: number;
}): {
  surfaceM2: number;
  quantity: number;
  unit: string;
  htCentimes: number;
  tvaCentimes: number;
  ttcCentimes: number;
} {
  const surfaceM2 = computeSurfaceM2(params.widthM, params.heightM);
  const panelCount = Math.max(0, params.panelCount ?? 1);
  const durationVal = Math.max(0, params.durationValue ?? 1);
  const durationUnit = params.durationUnit || 'mois';

  let quantity = 1;
  switch (params.pricingUnit) {
    case 'mois': {
      const months =
        durationUnit === 'mois'
          ? durationVal
          : Math.round((durationVal / 30) * 100) / 100;
      quantity = Math.round(panelCount * months * 100) / 100;
      break;
    }
    case 'jour': {
      const days = durationUnit === 'jours' ? durationVal : durationVal * 30;
      quantity = Math.round(panelCount * days * 100) / 100;
      break;
    }
    case 'm2': {
      const unitSurface = surfaceM2 > 0 ? surfaceM2 : 1;
      quantity = Math.round(unitSurface * panelCount * 100) / 100;
      break;
    }
    case 'ml': {
      const len = params.widthM && params.widthM > 0 ? params.widthM : 1;
      quantity = Math.round(len * panelCount * 100) / 100;
      break;
    }
    case 'u': {
      quantity = panelCount;
      break;
    }
    case 'forfait': {
      quantity = 1;
      break;
    }
  }

  const unit = pricingUnitToInvoiceUnit(params.pricingUnit);
  const totals = computeInvoiceLineTotals({
    quantity,
    unitPriceCentimes: params.unitPriceCentimes,
    discountPercent: params.discountPercent,
    tvaRate: params.tvaRate,
    manualTotalLocked: params.manualTotalLocked,
    lockedHtCentimes: params.manualHtCentimes,
  });

  return {
    surfaceM2,
    quantity,
    unit,
    ...totals,
  };
}

export function createDefaultEditableLine(
  id: string,
  defaultTva: number,
  options?: {
    lineMode?: 'libre' | 'guidee';
    description?: string;
    unit?: string;
    unitPriceText?: string;
  }
): SmartEditableLine {
  const mode = options?.lineMode || 'libre';
  return {
    id,
    lineMode: mode,
    description: options?.description || '',
    quantityText: '1',
    unit: options?.unit || (mode === 'guidee' ? 'mois' : 'u'),
    unitPriceText: options?.unitPriceText || '0,00',
    discountText: '0',
    tvaRateText: String(defaultTva),
    serviceType: DEFAULT_OUTDOOR_CATALOG.serviceTypes[0],
    panelType: '',
    location: '',
    face: '',
    widthText: '',
    heightText: '',
    panelCountText: '1',
    durationValueText: '1',
    durationUnit: 'mois',
    pricingUnit: invoiceUnitToPricingUnit(options?.unit || 'mois'),
    manualTotalLocked: false,
    manualHtText: '0,00',
    manualDesignationEdited: false,
  };
}

export function invoiceLineToEditable(line: InvoiceLine, newId?: string): SmartEditableLine {
  const mode: 'libre' | 'guidee' = line.lineMode === 'guidee' ? 'guidee' : 'libre';
  const pricingUnit = line.pricingUnit || invoiceUnitToPricingUnit(line.unit);
  return {
    id: newId || line.id,
    lineMode: mode,
    description: line.description || '',
    quantityText: String(line.quantity ?? 1),
    unit: line.unit || 'u',
    unitPriceText: centimesToInputString(line.unitPriceCentimes || 0),
    discountText: String(line.discountPercent ?? 0),
    tvaRateText: String(line.tvaRate ?? 19),
    serviceType: line.serviceType || DEFAULT_OUTDOOR_CATALOG.serviceTypes[0],
    panelType: line.panelType || '',
    location: line.location || '',
    face: line.face || '',
    widthText: line.widthM ? formatDecimalFr(line.widthM) : '',
    heightText: line.heightM ? formatDecimalFr(line.heightM) : '',
    panelCountText: String(line.panelCount ?? 1),
    durationValueText: String(line.durationValue ?? 1),
    durationUnit: line.durationUnit || 'mois',
    pricingUnit,
    manualTotalLocked: Boolean(line.manualTotalLocked),
    manualHtText: centimesToInputString(line.htCentimes || 0),
    manualDesignationEdited: Boolean(line.manualDesignationEdited),
  };
}

export function editableToInvoiceLineInput(
  line: SmartEditableLine
): Partial<InvoiceLine> & {
  id: string;
  description: string;
  quantity: number;
  unit: string;
  unitPriceCentimes: number;
  discountPercent: number;
  tvaRate: number;
} {
  const unitPriceCentimes = parseMoneyInputToCentimes(line.unitPriceText);
  const safeUnitPrice = Number.isNaN(unitPriceCentimes) ? 0 : unitPriceCentimes;
  const discountPercent = parsePositiveDecimal(line.discountText, 0);
  const tvaRate = parsePositiveDecimal(line.tvaRateText, 0);

  if (line.lineMode === 'guidee') {
    const widthM = parsePositiveDecimal(line.widthText, 0);
    const heightM = parsePositiveDecimal(line.heightText, 0);
    const panelCount = parsePositiveDecimal(line.panelCountText, 1);
    const durationValue = parsePositiveDecimal(line.durationValueText, 1);
    const manualHt = parseMoneyInputToCentimes(line.manualHtText);
    const safeManualHt = Number.isNaN(manualHt) ? 0 : manualHt;

    const guided = computeGuidedLineValues({
      serviceType: line.serviceType,
      panelType: line.panelType,
      location: line.location,
      face: line.face,
      widthM: widthM > 0 ? widthM : undefined,
      heightM: heightM > 0 ? heightM : undefined,
      panelCount,
      durationValue,
      durationUnit: line.durationUnit,
      pricingUnit: line.pricingUnit,
      unitPriceCentimes: safeUnitPrice,
      discountPercent,
      tvaRate,
      manualTotalLocked: line.manualTotalLocked,
      manualHtCentimes: safeManualHt,
    });

    return {
      id: line.id,
      description: line.description,
      quantity: guided.quantity,
      unit: guided.unit,
      unitPriceCentimes: safeUnitPrice,
      discountPercent,
      tvaRate,
      htCentimes: guided.htCentimes,
      tvaCentimes: guided.tvaCentimes,
      ttcCentimes: guided.ttcCentimes,
      lineMode: 'guidee',
      serviceType: line.serviceType || undefined,
      panelType: line.panelType || undefined,
      location: line.location || undefined,
      face: line.face || undefined,
      widthM: widthM > 0 ? widthM : undefined,
      heightM: heightM > 0 ? heightM : undefined,
      surfaceM2: guided.surfaceM2 > 0 ? guided.surfaceM2 : undefined,
      panelCount,
      durationValue,
      durationUnit: line.durationUnit,
      pricingUnit: line.pricingUnit,
      manualTotalLocked: line.manualTotalLocked,
      manualDesignationEdited: line.manualDesignationEdited,
    };
  }

  const quantity = parsePositiveDecimal(line.quantityText, 0);
  return {
    id: line.id,
    description: line.description,
    quantity,
    unit: line.unit || 'u',
    unitPriceCentimes: safeUnitPrice,
    discountPercent,
    tvaRate,
    lineMode: 'libre',
  };
}
