import html2canvas from 'html2canvas';
import { jsPDF } from 'jspdf';

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

function sanitizeSegment(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[/\\:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
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
 * Découpe une capture canvas haute résolution en tranches exactes au format A4
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

export function triggerBrowserPrint(): {
  ok: boolean;
  blockedByIframe?: boolean;
  error?: string;
} {
  if (typeof window === 'undefined' || typeof window.print !== 'function') {
    return { ok: false, error: 'Impression navigateur indisponible.' };
  }

  let beforePrintFired = false;
  const onBeforePrint = () => {
    beforePrintFired = true;
  };
  window.addEventListener('beforeprint', onBeforePrint);
  const startedAt = Date.now();
  try {
    window.print();
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
    window.removeEventListener('beforeprint', onBeforePrint);
  }
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

  // Neutraliser les ombres Tailwind v4 (--tw-shadow utilise oklab) et les CSS oklch dans les <style>
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

  // Annuler d'éventuels zooms CSS (ex: zoom 75% dans la modale) sur les ancêtres du document cloné
  let ancestor: HTMLElement | null = clonedRoot.parentElement;
  while (ancestor) {
    ancestor.style.transform = 'none';
    ancestor.style.zoom = '1';
    ancestor = ancestor.parentElement;
  }
  clonedRoot.style.transform = 'none';

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
  options?: { landscape?: boolean }
): Promise<{ fileName: string; pageCount: number; blobSize: number }> {
  const svgToPngMap = await waitForImagesAndFonts(element);

  const landscape = Boolean(options?.landscape);
  const pageWidthMm = landscape ? 297 : 210;
  const pageHeightMm = landscape ? 210 : 297;
  const safeFileName = fileName.endsWith('.pdf') ? fileName : `${fileName}.pdf`;

  // Si le document contient plusieurs feuilles A4 explicites (.print-a4-sheet), capturer page par page
  const explicitSheets = Array.from(element.querySelectorAll<HTMLElement>('.print-a4-sheet'));
  const targets = explicitSheets.length > 0 ? explicitSheets : [element];

  const pdf = new jsPDF({
    orientation: landscape ? 'landscape' : 'portrait',
    unit: 'mm',
    format: 'a4',
    compress: true,
  });

  let isFirstPage = true;
  let pageCount = 0;

  for (const target of targets) {
    const canvas = await html2canvas(target, {
      scale: 2,
      useCORS: false,
      allowTaint: false,
      backgroundColor: '#ffffff',
      logging: false,
      scrollX: 0,
      scrollY: 0,
      onclone: (doc, cloned) => {
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
        pdf.addPage('a4', landscape ? 'landscape' : 'portrait');
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

  const blob = triggerPdfDownload(pdf, safeFileName);
  return { fileName: safeFileName, pageCount, blobSize: blob.size };
}

export async function printCurrentViewAsPdf(
  defaultFileName = 'document-gestion-financiere.pdf',
  options?: {
    companyName?: string;
    landscape?: boolean;
    rawLayout?: boolean;
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
  // Niveau 1 : Electron natif (webContents.printToPDF + dialogue Enregistrer sous...)
  if (window.electronAPI && typeof window.electronAPI.printToPDF === 'function') {
    try {
      const res = await window.electronAPI.printToPDF({
        defaultFileName,
        companyName: options?.companyName,
        landscape: options?.landscape,
        rawLayout: options?.rawLayout,
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

  // Niveau 2 : Navigateur / Aperçu iframe -> jsPDF + html2canvas 100 % hors-ligne (jamais d'échec silencieux)
  if (options?.element) {
    try {
      const pdfResult = await exportElementToPdfBlobAndDownload(options.element, defaultFileName, {
        landscape: options.landscape,
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
