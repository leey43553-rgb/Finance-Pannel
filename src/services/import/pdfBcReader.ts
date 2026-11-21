import { createId } from '../../db/database';
import type { CompanyProfile } from '../../db/types';
import { parseBcExcelWorkbook } from './excelBcParser';
import {
  parsePurchaseOrder,
  type ParsedPurchaseOrder,
  type PositionedTextItem,
} from './parsePurchaseOrder';

export interface OcrLineOutput {
  text: string;
  confidence?: number; // 0..100
  bbox?: { x0: number; y0: number; x1: number; y1: number };
}

export interface OcrRecognitionResult {
  text: string;
  confidence?: number; // 0..100
  lines?: OcrLineOutput[];
}

export interface OcrEngineAdapter {
  recognizeImage: (
    imageSource: HTMLCanvasElement | Blob | string,
    onProgress?: (pct: number) => void
  ) => Promise<OcrRecognitionResult>;
  terminate?: () => Promise<void>;
}

export interface BcFileLike {
  name: string;
  type?: string;
  size?: number;
  arrayBuffer: () => Promise<ArrayBuffer>;
}

export interface BcImportReadItem {
  id: string;
  fileName: string;
  sheetName?: string;
  fileType: 'pdf' | 'image' | 'excel';
  mimeType: string;
  sizeBytes: number;
  rawBuffer: ArrayBuffer;
  parsed: ParsedPurchaseOrder;
}

export function resolveLocalAssetUrl(relativePath: string): string {
  const clean = relativePath.replace(/^\/+/, '');
  if (typeof window !== 'undefined' && window.location?.href) {
    // Strip any hash/query from base href so "./ocr/..." always resolves next to index.html
    const baseHref = window.location.href.split('#')[0].split('?')[0];
    return new URL(clean, baseHref).href;
  }
  return `./${clean}`;
}

async function getPdfJs() {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = resolveLocalAssetUrl('pdfjs/pdf.worker.min.mjs');
  return pdfjs;
}

/**
 * Améliore le contraste d'un canvas en niveaux de gris avant l'OCR Tesseract.
 */
export function preprocessCanvasForOcr(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  const { width, height } = canvas;
  if (width === 0 || height === 0) return canvas;

  const imgData = ctx.getImageData(0, 0, width, height);
  const d = imgData.data;

  // Passe 1 : niveaux de gris + bornes min/max (5e–95e percentiles approximés par histogramme)
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) {
    const lum = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
    d[i] = d[i + 1] = d[i + 2] = lum;
    hist[lum] += 1;
  }

  const totalPixels = width * height;
  let acc = 0;
  let lo = 0;
  let hi = 255;
  for (let v = 0; v < 256; v += 1) {
    acc += hist[v];
    if (acc >= totalPixels * 0.02) {
      lo = v;
      break;
    }
  }
  acc = 0;
  for (let v = 255; v >= 0; v -= 1) {
    acc += hist[v];
    if (acc >= totalPixels * 0.05) {
      hi = v;
      break;
    }
  }

  const span = Math.max(24, hi - lo);
  for (let i = 0; i < d.length; i += 4) {
    let v = ((d[i] - lo) * 255) / span;
    if (v < 0) v = 0;
    if (v > 255) v = 255;
    // Légère accentuation du contraste autour des traits sombres
    const adjusted = v > 215 ? 255 : Math.round(v);
    d[i] = d[i + 1] = d[i + 2] = adjusted;
  }

  ctx.putImageData(imgData, 0, 0);
  return canvas;
}

export async function renderPdfPagesForPreview(
  buffer: ArrayBuffer,
  scale = 1.6
): Promise<Array<{ pageNumber: number; width: number; height: number; dataUrl: string }>> {
  const pdfjs = await getPdfJs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer.slice(0)) }).promise;
  const pages: Array<{ pageNumber: number; width: number; height: number; dataUrl: string }> = [];

  for (let p = 1; p <= doc.numPages; p += 1) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport, canvas }).promise;
    }
    pages.push({
      pageNumber: p,
      width: canvas.width,
      height: canvas.height,
      dataUrl: canvas.toDataURL('image/png'),
    });
  }

  return pages;
}

async function createOfflineTesseractAdapter(): Promise<OcrEngineAdapter> {
  const { createWorker, OEM } = await import('tesseract.js');
  let activeProgressCb: ((pct: number) => void) | undefined;

  const worker = await createWorker(['fra', 'eng'], OEM.LSTM_ONLY, {
    workerPath: resolveLocalAssetUrl('ocr/worker.min.js'),
    corePath: resolveLocalAssetUrl('ocr/tesseract-core'),
    langPath: resolveLocalAssetUrl('ocr/lang-data'),
    workerBlobURL: false,
    cacheMethod: 'none',
    gzip: true,
    logger: (msg: { status?: string; progress?: number }) => {
      if (activeProgressCb && typeof msg.progress === 'number') {
        const weight =
          msg.status === 'recognizing text'
            ? 25 + Math.round(msg.progress * 75)
            : Math.round(msg.progress * 25);
        activeProgressCb(Math.max(0, Math.min(100, weight)));
      }
    },
  });

  return {
    recognizeImage: async (imageSource, onProgress) => {
      activeProgressCb = onProgress;
      try {
        const res = await worker.recognize(imageSource, {}, { text: true, blocks: true });
        const lines: OcrLineOutput[] = [];
        const blocks = res.data.blocks || [];
        for (const blk of blocks) {
          for (const para of blk.paragraphs || []) {
            for (const line of para.lines || []) {
              const t = (line.text || '').trim();
              if (!t) continue;
              lines.push({
                text: t,
                confidence: line.confidence,
                bbox: line.bbox,
              });
            }
          }
        }
        return {
          text: res.data.text || '',
          confidence: res.data.confidence,
          lines,
        };
      } finally {
        activeProgressCb = undefined;
      }
    },
    terminate: async () => {
      await worker.terminate();
    },
  };
}

function ocrResultsToPositionedItems(
  pageResults: Array<{ page: number; res: OcrRecognitionResult }>
): PositionedTextItem[] | string[] {
  const items: PositionedTextItem[] = [];
  let hasAnyBbox = false;

  for (const { page, res } of pageResults) {
    if (res.lines && res.lines.length > 0) {
      res.lines.forEach((ln, idx) => {
        const conf =
          typeof ln.confidence === 'number'
            ? ln.confidence / 100
            : typeof res.confidence === 'number'
            ? res.confidence / 100
            : 0.65;
        if (ln.bbox) hasAnyBbox = true;
        items.push({
          str: ln.text,
          x: ln.bbox ? ln.bbox.x0 : 0,
          y: ln.bbox ? ln.bbox.y0 : idx * 24,
          width: ln.bbox ? Math.max(10, ln.bbox.x1 - ln.bbox.x0) : ln.text.length * 8,
          height: ln.bbox ? Math.max(10, ln.bbox.y1 - ln.bbox.y0) : 14,
          page,
          confidence: conf,
        });
      });
    }
  }

  if (items.length > 0 && hasAnyBbox) {
    return items;
  }

  if (items.length > 0) {
    return items;
  }

  return pageResults.flatMap(({ res }) =>
    (res.text || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

async function imageBufferToCanvas(buffer: ArrayBuffer, mimeType: string): Promise<HTMLCanvasElement> {
  const blob = new Blob([buffer], { type: mimeType || 'image/png' });
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Image illisible ou corrompue.'));
      el.src = url;
    });
    const minWidth = 1400;
    const scale = img.naturalWidth > 0 && img.naturalWidth < minWidth ? Math.min(2.5, minWidth / img.naturalWidth) : 1;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    }
    return preprocessCanvasForOcr(canvas);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export interface PdfTextExtractorResult {
  items: PositionedTextItem[];
  charCount: number;
  numPages: number;
  renderPageForOcr: (pageNum: number, scale?: number) => Promise<HTMLCanvasElement>;
}

export async function extractPdfTextWithPdfJs(buffer: ArrayBuffer): Promise<PdfTextExtractorResult> {
  const pdfjs = await getPdfJs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer.slice(0)) }).promise;
  const items: PositionedTextItem[] = [];
  let charCount = 0;

  for (let p = 1; p <= doc.numPages; p += 1) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    for (const raw of content.items) {
      if (!('str' in raw)) continue;
      const str = String(raw.str || '');
      charCount += str.replace(/\s+/g, '').length;
      const tx = raw.transform || [1, 0, 0, 1, 0, 0];
      const x = Number(tx[4]) || 0;
      const yBottomUp = Number(tx[5]) || 0;
      const yTopDown = viewport.height - yBottomUp;
      const h = Math.abs(Number(raw.height)) || Math.abs(Number(tx[3])) || 10;
      items.push({
        str,
        x,
        y: yTopDown,
        width: Number(raw.width) || 0,
        height: h,
        page: p,
        confidence: 0.96,
      });
    }
  }

  return {
    items,
    charCount,
    numPages: doc.numPages,
    renderPageForOcr: async (pageNum: number, scale = 2.5) => {
      const page = await doc.getPage(pageNum);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport, canvas }).promise;
      }
      return preprocessCanvasForOcr(canvas);
    },
  };
}

/**
 * Lit un fichier BC (PDF texte, PDF scanné via OCR, JPG/PNG via OCR, ou Excel modèle)
 * 100% hors-ligne et retourne un ou plusieurs ParsedPurchaseOrder prêts pour la prévisualisation.
 */
export async function readBcImportFile(params: {
  file: BcFileLike;
  companyProfiles?: CompanyProfile[];
  onProgress?: (pct: number, message: string) => void;
  ocrEngine?: OcrEngineAdapter;
  pdfExtractorOverride?: (buffer: ArrayBuffer) => Promise<PdfTextExtractorResult>;
}): Promise<BcImportReadItem[]> {
  const { file, companyProfiles = [], onProgress } = params;
  const lower = file.name.toLowerCase();
  const buffer = await file.arrayBuffer();
  const mimeType =
    file.type ||
    (lower.endsWith('.pdf')
      ? 'application/pdf'
      : lower.endsWith('.png')
      ? 'image/png'
      : /\.jpe?g$/.test(lower)
      ? 'image/jpeg'
      : 'application/octet-stream');

  // 1. EXCEL (.xlsx, .xls)
  if (/\.(xlsx|xls)$/i.test(lower)) {
    onProgress?.(35, 'Lecture du classeur Excel…');
    const sheets = parseBcExcelWorkbook(buffer, companyProfiles);
    onProgress?.(100, 'Lecture terminée');
    if (sheets.length === 0) {
      throw new Error(
        `Aucune feuille au format « Bon de commande » détectée dans « ${file.name} » (titre « Bon de commande n°… » absent).`
      );
    }
    return sheets.map((s) => ({
      id: createId('bc_imp'),
      fileName: file.name,
      sheetName: s.sheetName,
      fileType: 'excel' as const,
      mimeType,
      sizeBytes: file.size || buffer.byteLength,
      rawBuffer: buffer,
      parsed: s.parsed,
    }));
  }

  // 2. PDF (couche texte ou fallback OCR)
  if (lower.endsWith('.pdf') || mimeType.includes('pdf')) {
    onProgress?.(15, 'Lecture du PDF…');
    const extractor = params.pdfExtractorOverride || extractPdfTextWithPdfJs;
    const pdfData = await extractor(buffer);

    if (pdfData.charCount >= 20) {
      onProgress?.(85, 'Analyse des champs du bon de commande…');
      const parsed = parsePurchaseOrder(pdfData.items, {
        companyProfiles,
        isScannedOcr: false,
      });
      onProgress?.(100, 'Lecture terminée');
      return [
        {
          id: createId('bc_imp'),
          fileName: file.name,
          fileType: 'pdf',
          mimeType: 'application/pdf',
          sizeBytes: file.size || buffer.byteLength,
          rawBuffer: buffer,
          parsed,
        },
      ];
    }

    // Fallback OCR sur PDF scanné (< 20 caractères)
    onProgress?.(10, 'PDF scanné détecté — initialisation OCR hors-ligne…');
    const ownEngine = !params.ocrEngine;
    const engine = params.ocrEngine || (await createOfflineTesseractAdapter());
    const pageResults: Array<{ page: number; res: OcrRecognitionResult }> = [];
    try {
      const totalPages = Math.max(1, pdfData.numPages);
      for (let p = 1; p <= totalPages; p += 1) {
        const canvas = await pdfData.renderPageForOcr(p, 2.5);
        const res = await engine.recognizeImage(canvas, (pagePct) => {
          const globalPct = Math.round(((p - 1) / totalPages) * 100 + pagePct / totalPages);
          onProgress?.(globalPct, `Lecture du document… ${globalPct} %`);
        });
        pageResults.push({ page: p, res });
      }
    } finally {
      if (ownEngine && engine.terminate) {
        await engine.terminate();
      }
    }

    const ocrInput = ocrResultsToPositionedItems(pageResults);
    const parsed = parsePurchaseOrder(ocrInput, {
      companyProfiles,
      isScannedOcr: true,
    });
    onProgress?.(100, 'Lecture terminée');
    return [
      {
        id: createId('bc_imp'),
        fileName: file.name,
        fileType: 'pdf',
        mimeType: 'application/pdf',
        sizeBytes: file.size || buffer.byteLength,
        rawBuffer: buffer,
        parsed,
      },
    ];
  }

  // 3. IMAGE (JPG / PNG / WEBP) -> OCR
  if (/\.(png|jpe?g|webp)$/i.test(lower) || mimeType.startsWith('image/')) {
    onProgress?.(10, 'Préparation de l’image pour OCR hors-ligne…');
    const canvas = await imageBufferToCanvas(buffer, mimeType);
    const ownEngine = !params.ocrEngine;
    const engine = params.ocrEngine || (await createOfflineTesseractAdapter());
    let ocrRes: OcrRecognitionResult;
    try {
      ocrRes = await engine.recognizeImage(canvas, (pct) => {
        onProgress?.(pct, `Lecture du document… ${pct} %`);
      });
    } finally {
      if (ownEngine && engine.terminate) {
        await engine.terminate();
      }
    }

    const ocrInput = ocrResultsToPositionedItems([{ page: 1, res: ocrRes }]);
    const parsed = parsePurchaseOrder(ocrInput, {
      companyProfiles,
      isScannedOcr: true,
    });
    onProgress?.(100, 'Lecture terminée');
    return [
      {
        id: createId('bc_imp'),
        fileName: file.name,
        fileType: 'image',
        mimeType,
        sizeBytes: file.size || buffer.byteLength,
        rawBuffer: buffer,
        parsed,
      },
    ];
  }

  throw new Error(
    `Format non pris en charge pour « ${file.name} ». Utilisez PDF, JPG, PNG, XLSX ou XLS.`
  );
}
