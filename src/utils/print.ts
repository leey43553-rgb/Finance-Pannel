import html2canvas from 'html2canvas';
import { jsPDF } from 'jspdf';
import type {
  CompanyProfile,
  CompanySettings,
  PrintPaperSize,
  PrintSettings,
} from '../db/types';
import { DEVELOPER_BRAND } from '../constants/branding';

export type PrintableDocCategory =
  | 'facture'
  | 'proforma'
  | 'bc_emis'
  | 'facture_fournisseur'
  | 'rapport';

const FILENAME_PREFIX: Record<PrintableDocCategory, string> = {
  facture: 'Facture',
  proforma: 'Proforma',
  bc_emis: 'Bon_Commande',
  facture_fournisseur: 'Facture_Fournisseur',
  rapport: 'Rapport',
};

const PAPER_DIMENSIONS_MM: Record<PrintPaperSize, { width: number; height: number }> = {
  A4: { width: 210, height: 297 },
  A5: { width: 148, height: 210 },
  Letter: { width: 215.9, height: 279.4 },
};

export function resolvePaperDimensionsMm(
  paperSize: PrintPaperSize = 'A4',
  landscape = false
): { widthMm: number; heightMm: number } {
  const base = PAPER_DIMENSIONS_MM[paperSize] || PAPER_DIMENSIONS_MM.A4;
  return landscape
    ? { widthMm: base.height, heightMm: base.width }
    : { widthMm: base.width, heightMm: base.height };
}

function sanitizeSegment(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[/\\:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function escapeHtml(raw: string | undefined | null): string {
  if (!raw) return '';
  return String(raw)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Construit un nom de fichier PDF propre et lisible.
 * Ex: buildPdfFileName('facture', '078/26', 'SARL STAR ADVERTISING')
 *     -> "Facture_078-26_SARL-STAR-ADVERTISING.pdf"
 */
export function buildPdfFileName(
  kind: PrintableDocCategory,
  docNumber: string,
  partyName?: string
): string {
  const prefix = FILENAME_PREFIX[kind] || 'Document';
  const cleanNum = sanitizeSegment(docNumber || '001');
  const cleanParty = partyName ? sanitizeSegment(partyName) : '';
  const parts = [prefix, cleanNum, cleanParty].filter(Boolean);
  return `${parts.join('_')}.pdf`;
}

export interface PdfPageSlice {
  yPx: number;
  heightPx: number;
  widthMm: number;
  heightMm: number;
}

/**
 * Découpe une capture canvas haute résolution en tranches exactes au format papier
 * afin de répartir proprement un document long sur plusieurs pages PDF.
 */
export function computePdfPageSlices(
  canvasWidthPx: number,
  canvasHeightPx: number,
  pageWidthMm = 210,
  pageHeightMm = 297
): PdfPageSlice[] {
  if (canvasWidthPx <= 0 || canvasHeightPx <= 0) {
    return [];
  }
  const pxPerPage = Math.max(1, Math.floor((canvasWidthPx * pageHeightMm) / pageWidthMm));
  const slices: PdfPageSlice[] = [];
  let yPx = 0;

  while (yPx < canvasHeightPx) {
    const remaining = canvasHeightPx - yPx;
    const heightPx = Math.min(pxPerPage, remaining);
    // Évite une page quasi vide (< 6 px de bordure résiduelle)
    if (slices.length > 0 && heightPx < 6) {
      break;
    }
    const heightMm = Number(((heightPx * pageWidthMm) / canvasWidthPx).toFixed(3));
    slices.push({
      yPx,
      heightPx,
      widthMm: pageWidthMm,
      heightMm,
    });
    yPx += heightPx;
  }

  return slices;
}

export function isInsideIframe(): boolean {
  try {
    return typeof window !== 'undefined' && window.self !== window.top;
  } catch {
    return true;
  }
}

export function triggerBrowserPrint(targetWindow?: Window): {
  ok: boolean;
  blockedByIframe?: boolean;
  error?: string;
} {
  const win = targetWindow || (typeof window !== 'undefined' ? window : undefined);
  if (!win || typeof win.print !== 'function') {
    return { ok: false, error: 'Impression navigateur indisponible.' };
  }

  let beforePrintFired = false;
  const onBeforePrint = () => {
    beforePrintFired = true;
  };
  win.addEventListener('beforeprint', onBeforePrint);
  const startedAt = Date.now();
  try {
    win.print();
    const elapsedMs = Date.now() - startedAt;
    if (!beforePrintFired && isInsideIframe() && elapsedMs < 150) {
      return {
        ok: false,
        blockedByIframe: true,
        error: "Ouvrez l'application dans un onglet séparé pour imprimer",
      };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      blockedByIframe: isInsideIframe(),
      error: isInsideIframe()
        ? "Ouvrez l'application dans un onglet séparé pour imprimer"
        : err instanceof Error
          ? err.message
          : 'Impossible d’ouvrir la boîte de dialogue d’impression.',
    };
  } finally {
    win.removeEventListener('beforeprint', onBeforePrint);
  }
}

/**
 * Supprime dans le DOM cloné tout ce qui n'appartient pas au document cible
 * (barre latérale, en-tête app, filtres, autres cartes, modale sombre, toasts).
 * Garantit que le PDF capturé ne contient QUE le document sélectionné.
 */
export function isolateElementForPdfClone(
  clonedDoc: Document,
  clonedTarget: HTMLElement
): void {
  const body = clonedDoc.body;
  if (!body) return;

  const ancestorSet = new Set<HTMLElement>();
  let curr: HTMLElement | null = clonedTarget;
  while (curr) {
    ancestorSet.add(curr);
    if (curr === body) break;
    curr = curr.parentElement;
  }

  // Supprimer tous les nœuds frères hors de la chaîne menant à clonedTarget
  for (const ancestor of ancestorSet) {
    if (ancestor === clonedTarget) continue;
    const children = Array.from(ancestor.childNodes);
    for (const child of children) {
      if (child.nodeType === 1) {
        const el = child as HTMLElement;
        if (ancestorSet.has(el)) continue;
        // Conserver les balises <style> ou <link> éventuelles dans le body
        if (el.tagName === 'STYLE' || el.tagName === 'LINK') continue;
        el.parentNode?.removeChild(el);
      } else if (child.nodeType === 3) {
        child.parentNode?.removeChild(child);
      }
    }

    // Neutraliser les contraintes visuelles des conteneurs parents (modale, scroll, zoom, position fixed/offscreen)
    ancestor.style.position = 'static';
    ancestor.style.left = 'auto';
    ancestor.style.top = 'auto';
    ancestor.style.right = 'auto';
    ancestor.style.bottom = 'auto';
    ancestor.style.transform = 'none';
    ancestor.style.zoom = '1';
    ancestor.style.margin = '0';
    ancestor.style.padding = '0';
    ancestor.style.width = 'auto';
    ancestor.style.maxWidth = 'none';
    ancestor.style.height = 'auto';
    ancestor.style.maxHeight = 'none';
    ancestor.style.overflow = 'visible';
    ancestor.style.background = '#ffffff';
    ancestor.style.backgroundColor = '#ffffff';
    ancestor.style.boxShadow = 'none';
    ancestor.style.border = 'none';
  }

  if (clonedDoc.documentElement) {
    clonedDoc.documentElement.style.background = '#ffffff';
    clonedDoc.documentElement.style.backgroundColor = '#ffffff';
    clonedDoc.documentElement.style.margin = '0';
    clonedDoc.documentElement.style.padding = '0';
  }
  clonedTarget.style.transform = 'none';
  clonedTarget.style.zoom = '1';
}

async function svgImageToPngDataUrl(img: HTMLImageElement): Promise<string | null> {
  if (typeof document === 'undefined') return null;
  try {
    const w = Math.max(img.naturalWidth || img.width || 220, 220);
    const h = Math.max(img.naturalHeight || img.height || 72, 72);
    const scale = 3;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const pngUrl = canvas.toDataURL('image/png');
    return pngUrl.startsWith('data:image/png') ? pngUrl : null;
  } catch {
    return null;
  }
}

async function waitForImagesAndFonts(root: HTMLElement): Promise<Map<string, string>> {
  const svgToPngMap = new Map<string, string>();

  try {
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      await Promise.race([
        document.fonts.ready,
        new Promise<void>((resolve) => setTimeout(resolve, 1200)),
      ]);
    }
  } catch {
    // Polices système prêtes
  }

  const images = Array.from(root.querySelectorAll('img'));
  await Promise.all(
    images.map(async (img) => {
      const src = img.getAttribute('src') || '';
      if (!src) return;

      if (!img.complete) {
        await new Promise<void>((resolve) => {
          const done = () => resolve();
          img.addEventListener('load', done, { once: true });
          img.addEventListener('error', done, { once: true });
          setTimeout(done, 2000);
        });
      }

      if (typeof img.decode === 'function') {
        try {
          await img.decode();
        } catch {
          // Image déjà décodée ou SVG inline
        }
      }

      if (src.startsWith('data:image/svg+xml') && !svgToPngMap.has(src)) {
        const pngUrl = await svgImageToPngDataUrl(img);
        if (pngUrl) {
          svgToPngMap.set(src, pngUrl);
        }
      }
    })
  );

  return svgToPngMap;
}

const UNSUPPORTED_COLOR_FN_RE = /(?:oklch|oklab|lab|lch|color-mix|color)\s*\(/i;

function replaceUnsupportedColorFunctions(
  input: string,
  convertToken: (expr: string) => string
): string {
  if (!input || !UNSUPPORTED_COLOR_FN_RE.test(input)) return input;

  let out = '';
  let i = 0;
  const len = input.length;

  while (i < len) {
    const slice = input.slice(i);
    const match = slice.match(/^(oklch|oklab|lab|lch|color-mix|color)\s*\(/i);
    if (match) {
      let depth = 0;
      let j = i + match[0].length - 1;
      for (; j < len; j += 1) {
        const ch = input[j];
        if (ch === '(') depth += 1;
        else if (ch === ')') {
          depth -= 1;
          if (depth === 0) {
            j += 1;
            break;
          }
        }
      }
      const token = input.slice(i, j);
      out += convertToken(token);
      i = j;
    } else {
      out += input[i];
      i += 1;
    }
  }

  return out;
}

/**
 * html2canvas 1.4.1 ne sait pas analyser oklch()/oklab()/color-mix() injectés par Tailwind v4.
 * On convertit toute fonction couleur moderne dans les feuilles de style et styles calculés du clone.
 */
function sanitizeClonedNodeColors(
  clonedDoc: Document,
  clonedRoot: HTMLElement,
  svgToPngMap: Map<string, string>
): void {
  const view = clonedDoc.defaultView;
  if (!view) return;
  const probeCanvas = clonedDoc.createElement('canvas');
  probeCanvas.width = 1;
  probeCanvas.height = 1;
  const ctx = probeCanvas.getContext('2d');
  if (!ctx) return;

  const convertToken = (expr: string): string => {
    try {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = 'rgba(0, 0, 0, 0)';
      ctx.fillStyle = expr;
      const resolved = ctx.fillStyle;
      if (typeof resolved === 'string' && !UNSUPPORTED_COLOR_FN_RE.test(resolved)) {
        return resolved;
      }
    } catch {
      // Ignorer jeton non résoluble
    }
    return '#111827';
  };

  const sanitizeValue = (val: string): string =>
    replaceUnsupportedColorFunctions(val, convertToken);

  const styleTags = Array.from(clonedDoc.querySelectorAll('style'));
  for (const styleTag of styleTags) {
    if (styleTag.textContent && UNSUPPORTED_COLOR_FN_RE.test(styleTag.textContent)) {
      styleTag.textContent = sanitizeValue(styleTag.textContent);
    }
  }

  const overrideStyle = clonedDoc.createElement('style');
  overrideStyle.textContent = `
    *, *::before, *::after {
      --tw-shadow: 0 0 #0000 !important;
      --tw-ring-shadow: 0 0 #0000 !important;
      --tw-inset-shadow: 0 0 #0000 !important;
      --tw-inset-ring-shadow: 0 0 #0000 !important;
    }
    .print-a4-sheet {
      box-shadow: none !important;
      margin-bottom: 0 !important;
    }
  `;
  clonedDoc.head?.appendChild(overrideStyle);

  // Remplacer les logos SVG par leur version PNG base64 pré-rasterisée (zéro SVG quirk / CORS)
  if (svgToPngMap.size > 0) {
    const clonedImages = Array.from(clonedRoot.querySelectorAll('img'));
    for (const img of clonedImages) {
      const src = img.getAttribute('src') || '';
      const png = svgToPngMap.get(src);
      if (png) {
        img.setAttribute('src', png);
      }
    }
  }

  const colorProps = [
    'color',
    'backgroundColor',
    'backgroundImage',
    'borderTopColor',
    'borderRightColor',
    'borderBottomColor',
    'borderLeftColor',
    'outlineColor',
    'textDecorationColor',
    'boxShadow',
    'textShadow',
    'fill',
    'stroke',
    'caretColor',
    'columnRuleColor',
  ] as const;

  const nodesToSanitize: HTMLElement[] = [];
  if (clonedDoc.documentElement) nodesToSanitize.push(clonedDoc.documentElement);
  if (clonedDoc.body) nodesToSanitize.push(clonedDoc.body);
  nodesToSanitize.push(clonedRoot, ...Array.from(clonedRoot.querySelectorAll<HTMLElement>('*')));

  for (const el of nodesToSanitize) {
    const cs = view.getComputedStyle(el);
    for (const prop of colorProps) {
      const rawVal = cs[prop];
      if (typeof rawVal === 'string' && UNSUPPORTED_COLOR_FN_RE.test(rawVal)) {
        (el.style as unknown as Record<string, string>)[prop] = sanitizeValue(rawVal);
      }
    }
  }
}

function triggerPdfDownload(pdf: jsPDF, safeFileName: string): Blob {
  const blob = pdf.output('blob');
  if (!blob || blob.size === 0) {
    throw new Error('Le fichier PDF généré est vide.');
  }

  if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = safeFileName;
    link.rel = 'noopener';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } else {
    pdf.save(safeFileName);
  }

  return blob;
}

export async function exportElementToPdfBlobAndDownload(
  element: HTMLElement,
  fileName: string,
  options?: { landscape?: boolean; paperSize?: PrintPaperSize }
): Promise<{ fileName: string; pageCount: number; blobSize: number }> {
  const svgToPngMap = await waitForImagesAndFonts(element);

  const landscape = Boolean(options?.landscape);
  const paperSize: PrintPaperSize = options?.paperSize || 'A4';
  const { widthMm: pageWidthMm, heightMm: pageHeightMm } = resolvePaperDimensionsMm(
    paperSize,
    landscape
  );
  const safeFileName = fileName.endsWith('.pdf') ? fileName : `${fileName}.pdf`;

  const explicitSheets = Array.from(element.querySelectorAll<HTMLElement>('.print-a4-sheet'));
  const targets = explicitSheets.length > 0 ? explicitSheets : [element];

  const jsPdfFormat = paperSize === 'A5' ? 'a5' : paperSize === 'Letter' ? 'letter' : 'a4';
  const pdf = new jsPDF({
    orientation: landscape ? 'landscape' : 'portrait',
    unit: 'mm',
    format: jsPdfFormat,
    compress: true,
  });

  let isFirstPage = true;
  let pageCount = 0;

  // Conteneur isolé hors écran afin de ne jamais capturer de modale, barre latérale ou zoom CSS
  const existingHost = document.getElementById('pdf-isolated-host');
  if (existingHost) existingHost.remove();

  const isolatedHost = document.createElement('div');
  isolatedHost.id = 'pdf-isolated-host';
  isolatedHost.style.position = 'fixed';
  isolatedHost.style.left = '-10000px';
  isolatedHost.style.top = '0';
  isolatedHost.style.background = '#ffffff';
  isolatedHost.style.backgroundColor = '#ffffff';
  isolatedHost.style.zIndex = '-1';
  isolatedHost.style.pointerEvents = 'none';
  isolatedHost.style.margin = '0';
  isolatedHost.style.padding = '0';
  document.body.appendChild(isolatedHost);

  try {
    for (const target of targets) {
      isolatedHost.innerHTML = '';
      const clonedTarget = target.cloneNode(true) as HTMLElement;
      clonedTarget.style.transform = 'none';
      clonedTarget.style.zoom = '1';
      clonedTarget.style.margin = '0';
      clonedTarget.style.boxShadow = 'none';
      if (!clonedTarget.style.width && target.offsetWidth > 0) {
        clonedTarget.style.width = `${target.offsetWidth}px`;
      }
      isolatedHost.appendChild(clonedTarget);

      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      );

      const canvas = await html2canvas(clonedTarget, {
        scale: 2,
        useCORS: false,
        allowTaint: false,
        backgroundColor: '#ffffff',
        logging: false,
        scrollX: 0,
        scrollY: 0,
        onclone: (doc, cloned) => {
          isolateElementForPdfClone(doc, cloned);
          sanitizeClonedNodeColors(doc, cloned, svgToPngMap);
        },
      });

      const slices = computePdfPageSlices(
        canvas.width,
        canvas.height,
        pageWidthMm,
        pageHeightMm
      );

      if (slices.length === 0) {
        throw new Error('La zone capturée pour le PDF est vide.');
      }

      for (const slice of slices) {
        if (!isFirstPage) {
          pdf.addPage(jsPdfFormat, landscape ? 'landscape' : 'portrait');
        }
        isFirstPage = false;
        pageCount += 1;

        const sliceCanvas = document.createElement('canvas');
        sliceCanvas.width = canvas.width;
        sliceCanvas.height = slice.heightPx;
        const ctx = sliceCanvas.getContext('2d');
        if (!ctx) {
          throw new Error('Contexte graphique 2D indisponible pour la génération PDF.');
        }
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, sliceCanvas.width, sliceCanvas.height);
        ctx.drawImage(
          canvas,
          0,
          slice.yPx,
          canvas.width,
          slice.heightPx,
          0,
          0,
          canvas.width,
          slice.heightPx
        );

        const imgData = sliceCanvas.toDataURL('image/png');
        pdf.addImage(imgData, 'PNG', 0, 0, slice.widthMm, slice.heightMm, undefined, 'FAST');
      }
    }
  } finally {
    isolatedHost.remove();
  }

  const blob = triggerPdfDownload(pdf, safeFileName);
  return { fileName: safeFileName, pageCount, blobSize: blob.size };
}

export function captureElementAsStandaloneHtml(
  element: HTMLElement | null | undefined,
  printSettings?: PrintSettings
): string | undefined {
  if (!element || typeof document === 'undefined') return undefined;
  const paper = printSettings?.paperSize || 'A4';
  const orientation = printSettings?.orientation || 'portrait';
  const marginCss =
    printSettings?.margins === 'none'
      ? '0'
      : printSettings?.margins === 'minimum'
        ? '6mm'
        : '12mm';

  const styles = Array.from(document.querySelectorAll('style'))
    .map((s) => `<style>${s.textContent || ''}</style>`)
    .join('\n');

  const clone = element.cloneNode(true) as HTMLElement;
  clone.style.transform = 'none';
  clone.style.zoom = '1';

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <title>Document imprimable</title>
  ${styles}
  <style>
    @page { size: ${paper} ${orientation}; margin: ${marginCss}; }
    html, body { background: #ffffff !important; margin: 0; padding: 0; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
    .no-print { display: none !important; }
  </style>
</head>
<body style="background:#ffffff;">
  ${clone.outerHTML}
</body>
</html>`;
}

export function buildStandaloneReportHtml(params: {
  title: string;
  filterSummary: string;
  columns: Array<{ key: string; header: string; type?: string }>;
  rows: Array<Record<string, string | number>>;
  totalsRow?: Record<string, string | number> | null;
  summaryCards?: Array<{ label: string; value: string; tone?: string }>;
  settings?: CompanySettings;
  profile?: CompanyProfile;
  printSettings?: PrintSettings;
}): string {
  const companyName = params.profile?.name || params.settings?.companyName || 'Gestion Financière';
  const logo = params.profile?.logoDataUrl || params.settings?.logoDataUrl || '';
  const address = params.profile?.address || params.settings?.address || '';
  const nif = params.profile?.nif || params.settings?.nif || '';
  const nis = params.profile?.nis || params.settings?.nis || '';
  const rc = params.profile?.rc || params.settings?.rc || '';
  const ai = params.profile?.ai || params.settings?.ai || '';
  const fiscalLine = [
    nif ? `NIF : ${nif}` : '',
    nis ? `NIS : ${nis}` : '',
    rc ? `RC : ${rc}` : '',
    ai ? `AI : ${ai}` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  const ps = params.printSettings;
  const paper = ps?.paperSize || 'A4';
  const orientation = ps?.orientation || 'portrait';
  const marginCss =
    ps?.margins === 'none' ? '8mm' : ps?.margins === 'minimum' ? '6mm' : '12mm';

  const cardsHtml =
    params.summaryCards && params.summaryCards.length > 0
      ? `<div class="cards">${params.summaryCards
          .map((c) => {
            const color =
              c.tone === 'green'
                ? '#047857'
                : c.tone === 'red'
                  ? '#b91c1c'
                  : c.tone === 'amber'
                    ? '#b45309'
                    : '#0f172a';
            return `<div class="card"><div class="card-label">${escapeHtml(c.label)}</div><div class="card-val" style="color:${color}">${escapeHtml(c.value)}</div></div>`;
          })
          .join('')}</div>`
      : '';

  const theadHtml = `<tr>${params.columns
    .map((c) => `<th>${escapeHtml(c.header)}</th>`)
    .join('')}</tr>`;

  const tbodyHtml =
    params.rows.length === 0
      ? `<tr><td colspan="${Math.max(1, params.columns.length)}" style="text-align:center;padding:18px;color:#64748b;">Aucune donnée correspondante aux filtres sélectionnés.</td></tr>`
      : params.rows
          .map(
            (row) =>
              `<tr>${params.columns
                .map((col) => {
                  const val = row[col.key] ?? '';
                  const isNum = col.type === 'number' || String(val).endsWith('DA');
                  return `<td${isNum ? ' class="num"' : ''}>${escapeHtml(String(val))}</td>`;
                })
                .join('')}</tr>`
          )
          .join('');

  const tfootHtml = params.totalsRow
    ? `<tfoot><tr>${params.columns
        .map(
          (col) =>
            `<td class="num">${escapeHtml(String(params.totalsRow?.[col.key] ?? ''))}</td>`
        )
        .join('')}</tr></tfoot>`
    : '';

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(params.title)}</title>
  <style>
    @page { size: ${paper} ${orientation}; margin: ${marginCss}; }
    * { box-sizing: border-box; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
    body { font-family: "Segoe UI", Arial, sans-serif; color: #0f172a; background: #ffffff; margin: 0; padding: 14px; font-size: 11px; }
    .header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #cbd5e1; padding-bottom: 12px; margin-bottom: 14px; }
    .brand { display: flex; gap: 12px; align-items: flex-start; }
    .logo { width: 52px; height: 52px; object-fit: contain; border: 1px solid #e2e8f0; border-radius: 4px; padding: 3px; background: #fff; }
    .company-name { font-size: 14px; font-weight: 700; margin: 0 0 2px 0; }
    .meta { font-size: 10px; color: #475569; margin: 1px 0; }
    .title-box { text-align: right; }
    .report-title { font-size: 13px; font-weight: 700; color: #0F1E36; }
    .cards { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin-bottom: 14px; }
    .card { border: 1px solid #cbd5e1; border-radius: 4px; background: #f8fafc; padding: 8px 10px; }
    .card-label { font-size: 10px; color: #64748b; }
    .card-val { font-size: 12px; font-weight: 700; margin-top: 3px; font-variant-numeric: tabular-nums; }
    table { width: 100%; border-collapse: collapse; border: 1px solid #cbd5e1; }
    th, td { border-bottom: 1px solid #e2e8f0; padding: 6px 8px; text-align: left; }
    thead th { background: #f1f5f9; font-weight: 700; color: #334155; border-bottom: 1px solid #cbd5e1; }
    tfoot td { background: #f1f5f9; font-weight: 700; border-top: 2px solid #94a3b8; }
    .num { font-variant-numeric: tabular-nums; }
    .footer { display: flex; justify-content: space-between; margin-top: 14px; padding-top: 8px; border-top: 1px solid #e2e8f0; font-size: 9px; color: #64748b; }
  </style>
</head>
<body>
  <div class="header">
    <div class="brand">
      ${logo ? `<img class="logo" src="${escapeHtml(logo)}" alt="${escapeHtml(companyName)}" />` : ''}
      <div>
        <div class="company-name">${escapeHtml(companyName)}</div>
        ${address ? `<div class="meta">${escapeHtml(address)}</div>` : ''}
        ${fiscalLine ? `<div class="meta">${escapeHtml(fiscalLine)}</div>` : ''}
      </div>
    </div>
    <div class="title-box">
      <div class="report-title">${escapeHtml(params.title)}</div>
      <div class="meta">Édité le ${new Date().toLocaleDateString('fr-FR')}</div>
      <div class="meta">${escapeHtml(params.filterSummary)}</div>
    </div>
  </div>
  ${cardsHtml}
  <table>
    <thead>${theadHtml}</thead>
    <tbody>${tbodyHtml}</tbody>
    ${tfootHtml}
  </table>
  <div class="footer">
    <span>${escapeHtml(companyName)} — Édité hors-ligne le ${new Date().toLocaleDateString('fr-FR')}</span>
    <span>${escapeHtml(DEVELOPER_BRAND)}</span>
  </div>
</body>
</html>`;
}

export function buildPrintTestHtml(
  settings?: CompanySettings,
  profile?: CompanyProfile,
  printSettings?: PrintSettings
): string {
  const ps = printSettings || settings?.printSettings;
  const companyName = profile?.name || settings?.companyName || 'Gestion Financière';
  const paper = ps?.paperSize || 'A4';
  const orientation = ps?.orientation || 'portrait';
  const marginsLabel =
    ps?.margins === 'none'
      ? 'Aucune marge'
      : ps?.margins === 'minimum'
        ? 'Marges minimum'
        : 'Marges normales';

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <title>Test d'impression — ${escapeHtml(companyName)}</title>
  <style>
    @page { size: ${paper} ${orientation}; margin: ${ps?.margins === 'none' ? '0' : '12mm'}; }
    * { box-sizing: border-box; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
    body { font-family: "Segoe UI", Arial, sans-serif; color: #0f172a; background: #fff; padding: 18mm; margin: 0; }
    .box { border: 2px solid #0F1E36; border-radius: 8px; padding: 20px; }
    h1 { font-size: 18px; margin: 0 0 8px 0; color: #0F1E36; }
    p { font-size: 12px; color: #334155; margin: 4px 0; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 16px; }
    .item { background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 6px; padding: 10px; font-size: 12px; }
    .swatches { display: flex; gap: 8px; margin-top: 14px; }
    .swatch { height: 22px; flex: 1; border-radius: 4px; color: #fff; font-size: 10px; font-weight: 700; display: flex; align-items: center; justify-content: center; }
  </style>
</head>
<body>
  <div class="box">
    <h1>Page de test d’impression — ${escapeHtml(companyName)}</h1>
    <p>Document de vérification édité hors-ligne le ${new Date().toLocaleString('fr-FR')}.</p>
    <div class="grid">
      <div class="item"><strong>Imprimante :</strong> ${escapeHtml(ps?.defaultPrinterName || 'Imprimante par défaut du système')}</div>
      <div class="item"><strong>Format & orientation :</strong> ${escapeHtml(paper)} · ${orientation === 'landscape' ? 'Paysage' : 'Portrait'}</div>
      <div class="item"><strong>Marges :</strong> ${escapeHtml(marginsLabel)}</div>
      <div class="item"><strong>Couleur & copies :</strong> ${ps?.color === false ? 'Noir & blanc' : 'Couleur'} · ${ps?.copies || 1} copie(s)</div>
    </div>
    <div class="swatches">
      <div class="swatch" style="background:${escapeHtml(profile?.primaryColor || '#FF33CC')}">Couleur principale</div>
      <div class="swatch" style="background:${escapeHtml(profile?.accentColor || '#6B2FA0')}">Couleur accent</div>
      <div class="swatch" style="background:#0F1E36">En-tête</div>
    </div>
  </div>
</body>
</html>`;
}

export async function printHtmlInHiddenFrame(htmlContent: string): Promise<{
  ok: boolean;
  blockedByIframe?: boolean;
  error?: string;
}> {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return { ok: false, error: 'Environnement navigateur indisponible.' };
  }

  return new Promise((resolve) => {
    const iframe = document.createElement('iframe');
    iframe.style.position = 'fixed';
    iframe.style.right = '0';
    iframe.style.bottom = '0';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = '0';
    iframe.style.visibility = 'hidden';

    const cleanup = () => {
      setTimeout(() => {
        iframe.remove();
      }, 1500);
    };

    iframe.onload = () => {
      try {
        const win = iframe.contentWindow;
        if (!win) {
          cleanup();
          resolve({ ok: false, error: 'Fenêtre d’impression indisponible.' });
          return;
        }
        win.focus();
        const res = triggerBrowserPrint(win);
        cleanup();
        resolve(res);
      } catch (err) {
        cleanup();
        resolve({
          ok: false,
          blockedByIframe: isInsideIframe(),
          error:
            err instanceof Error
              ? err.message
              : "Impossible de lancer l’impression dans ce navigateur.",
        });
      }
    };

    iframe.srcdoc = htmlContent;
    document.body.appendChild(iframe);
  });
}

export async function printWithSettings(options: {
  printRoute?: string;
  htmlContent?: string;
  printSettings?: PrintSettings;
  onNavigatePreview?: (route: string) => void;
}): Promise<{
  ok: boolean;
  blockedByIframe?: boolean;
  error?: string;
}> {
  if (window.electronAPI?.isElectron && typeof window.electronAPI.printDirect === 'function') {
    try {
      const res = await window.electronAPI.printDirect({
        printRoute: options.printRoute,
        htmlContent: options.htmlContent,
        printSettings: options.printSettings,
      });
      if (!res.ok) {
        return { ok: false, error: res.error || 'Aucune imprimante disponible ou impression annulée.' };
      }
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Erreur lors de l’impression Electron.',
      };
    }
  }

  if (options.htmlContent) {
    return printHtmlInHiddenFrame(options.htmlContent);
  }

  if (options.printRoute && options.onNavigatePreview) {
    const sep = options.printRoute.includes('?') ? '&' : '?';
    options.onNavigatePreview(`${options.printRoute}${sep}autoPrint=1`);
    return { ok: true };
  }

  return triggerBrowserPrint();
}

export async function printCurrentViewAsPdf(
  defaultFileName = 'document-gestion-financiere.pdf',
  options?: {
    companyName?: string;
    landscape?: boolean;
    rawLayout?: boolean;
    paperSize?: PrintPaperSize;
    printRoute?: string;
    htmlContent?: string;
    element?: HTMLElement | null;
    fallbackPrintRoute?: string;
    onNavigateFallback?: (route: string) => void;
  }
): Promise<{
  ok: boolean;
  canceled?: boolean;
  filePath?: string;
  fileName?: string;
  pageCount?: number;
  blobSize?: number;
  method?: 'electron' | 'jspdf' | 'print_route' | 'window_print';
  error?: string;
}> {
  // Niveau 1 : Electron natif (fenêtre cachée isolée + dialogue Enregistrer sous...)
  if (window.electronAPI && typeof window.electronAPI.printToPDF === 'function') {
    try {
      const res = await window.electronAPI.printToPDF({
        defaultFileName,
        companyName: options?.companyName,
        landscape: options?.landscape,
        rawLayout: options?.rawLayout,
        paperSize: options?.paperSize,
        printRoute: options?.printRoute || options?.fallbackPrintRoute,
        htmlContent: options?.htmlContent,
      });
      if (res.canceled) return { ok: true, canceled: true, method: 'electron' };
      if (!res.ok) {
        return {
          ok: false,
          method: 'electron',
          error: res.error || 'Erreur lors de la génération PDF dans Electron.',
        };
      }
      return { ok: true, filePath: res.filePath, method: 'electron' };
    } catch (err) {
      return {
        ok: false,
        method: 'electron',
        error: err instanceof Error ? err.message : 'Erreur Electron printToPDF.',
      };
    }
  }

  // Niveau 2 : Navigateur / Aperçu iframe -> jsPDF + html2canvas isolé 100 % hors-ligne
  if (options?.element) {
    try {
      const pdfResult = await exportElementToPdfBlobAndDownload(options.element, defaultFileName, {
        landscape: options.landscape,
        paperSize: options.paperSize,
      });
      return {
        ok: true,
        method: 'jspdf',
        fileName: pdfResult.fileName,
        pageCount: pdfResult.pageCount,
        blobSize: pdfResult.blobSize,
      };
    } catch (err) {
      return {
        ok: false,
        method: 'jspdf',
        error:
          err instanceof Error
            ? `Échec de la génération PDF : ${err.message}`
            : 'Échec de la génération PDF.',
      };
    }
  }

  // Niveau 3 : Route d'impression dédiée ou window.print() uniquement si aucun élément PDF n'est fourni
  if (options?.fallbackPrintRoute && options.onNavigateFallback) {
    options.onNavigateFallback(options.fallbackPrintRoute);
    return { ok: true, method: 'print_route' };
  }

  const printRes = triggerBrowserPrint();
  if (!printRes.ok) {
    return {
      ok: false,
      method: 'window_print',
      error: printRes.error || 'L’impression directe est bloquée dans cet aperçu.',
    };
  }
  return { ok: true, method: 'window_print' };
}
