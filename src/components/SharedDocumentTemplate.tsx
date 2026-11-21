import React from 'react';
import type {
  ClientFiscalSnapshot,
  CompanyProfile,
  CompanySettings,
  Contact,
  InvoiceLine,
} from '../db/types';
import {
  computeCampaignDuration,
  computeTemplatePageChunks,
  formatDateFr,
} from '../utils/documentHelpers';
import {
  formatMoney,
  formatMoneyNumberOnly,
  formatQuantityFr,
} from '../utils/money';
import { amountCentimesToFrenchWords } from '../utils/numberToFrenchWords';

export type SharedDocumentKind = 'facture' | 'proforma' | 'bc_emis' | 'facture_fournisseur';

interface SharedDocumentTemplateProps {
  docKind: SharedDocumentKind;
  docNumber: string;
  issueDate: string;
  dueDate?: string;
  bcNumber?: string;
  supplierRef?: string;
  campaignRef?: string;
  campaignStartDate?: string;
  campaignEndDate?: string;
  showCampaignOnPrint?: boolean;
  // Proforma specific
  validityDays?: number;
  validUntil?: string;
  paymentConditions?: string;
  deliveryDelay?: string;
  // Parties
  profile?: CompanyProfile;
  settings?: CompanySettings;
  contact?: Contact;
  clientSnapshot?: ClientFiscalSnapshot;
  // Lignes & totaux
  currency: string;
  lines: InvoiceLine[];
  totalHtCentimes: number;
  totalTvaCentimes: number;
  totalTtcCentimes: number;
  paidCentimes?: number;
  remainingCentimes?: number;
  amountInWordsOverride?: string;
  notes?: string;
  unpriced?: boolean;
}

const DOC_TITLES: Record<SharedDocumentKind, string> = {
  facture: 'FACTURE',
  proforma: 'FACTURE PROFORMA',
  bc_emis: 'BON DE COMMANDE',
  facture_fournisseur: 'FACTURE FOURNISSEUR',
};

const AMOUNT_PHRASE_PREFIX: Record<SharedDocumentKind, string> = {
  facture: 'Arrêtée la présente facture à la somme de',
  proforma: 'Arrêtée la présente facture proforma à la somme de',
  bc_emis: 'Arrêté le présent bon de commande à la somme de',
  facture_fournisseur: 'Arrêtée la présente facture à la somme de',
};

function sanitizeHexColor(hex: string | undefined, fallback: string): string {
  const raw = (hex || '').trim();
  if (/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/.test(raw)) {
    return raw;
  }
  return fallback;
}

function hexToRgba(hex: string, alpha: number): string {
  let clean = hex.replace('#', '');
  if (clean.length === 3) {
    clean = clean
      .split('')
      .map((ch) => ch + ch)
      .join('');
  }
  if (clean.length !== 6) {
    return `rgba(107, 47, 160, ${alpha})`;
  }
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function formatDocumentBadgeTitle(docKind: SharedDocumentKind, docNumber: string): string {
  const num = (docNumber || '').trim();
  if (docKind === 'proforma' && /^(PF\s*)?N°/i.test(num)) {
    return `${DOC_TITLES[docKind]} ${num}`;
  }
  if (docKind === 'bc_emis' && /^(BC\s*)?N°/i.test(num)) {
    return `${DOC_TITLES[docKind]} ${num}`;
  }
  return `${DOC_TITLES[docKind]} N°${num}`;
}

function capitalizeFirstFrench(text: string): string {
  const trimmed = (text || '').trim();
  if (!trimmed) return '';
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function formatDateHyphenFr(isoDate?: string): string {
  if (!isoDate) return '—';
  const parts = isoDate.split('-');
  if (parts.length !== 3) return isoDate;
  return `${parts[2]}-${parts[1]}-${parts[0]}`;
}

function stripBcPrefix(docNumber: string): string {
  return (docNumber || '')
    .trim()
    .replace(/^(?:BON\s+DE\s+COMMANDE\s+N[°ºo.]?|BC\s*N[°ºo.]?|N[°ºo.]?)\s*/i, '')
    .trim();
}

export const SharedDocumentTemplate: React.FC<SharedDocumentTemplateProps> = ({
  docKind,
  docNumber,
  issueDate,
  dueDate,
  bcNumber,
  supplierRef,
  campaignRef,
  campaignStartDate,
  campaignEndDate,
  showCampaignOnPrint = true,
  validityDays,
  validUntil,
  paymentConditions,
  deliveryDelay,
  profile,
  settings,
  contact,
  clientSnapshot,
  currency,
  lines,
  totalHtCentimes,
  totalTvaCentimes,
  totalTtcCentimes,
  paidCentimes,
  remainingCentimes,
  amountInWordsOverride,
  notes,
  unpriced,
}) => {
  const companyName = profile?.name || settings?.companyName || 'SARL VISTA DIGITAL';
  const logoUrl = profile?.logoDataUrl || settings?.logoDataUrl || '';
  const companyAddr = profile?.address || settings?.address || '';
  const companyPostal = profile?.postalCode || '';
  const companyCity = profile?.city || 'Alger';
  const companyPhone = profile?.phone || settings?.phone || '';
  const companyFax = profile?.fax || '';
  const companyEmail = profile?.email || settings?.email || '';
  const rc = profile?.rc || settings?.rc || '';
  const nif = profile?.nif || settings?.nif || '';
  const nis = profile?.nis || settings?.nis || '';
  const ai = profile?.ai || settings?.ai || '';
  const bankInfo = profile?.bankInfo || '';
  const rib = profile?.rib || '';
  const footerNote = profile?.footerNote || '';
  const signatureDataUrl = profile?.signatureDataUrl || '';
  const signatureLabel = (profile?.signatureLabel || 'SERVICE COMMERCIAL').trim();

  const primaryColor = sanitizeHexColor(profile?.primaryColor, '#FF33CC');
  const accentColor = sanitizeHexColor(profile?.accentColor, '#6B2FA0');

  const partyCompany = clientSnapshot?.company || contact?.company || contact?.name || 'Client';
  const partyContact = clientSnapshot?.name || contact?.name || '';
  const partyAddr = clientSnapshot?.address || contact?.address || '';
  const partyPostal = clientSnapshot?.postalCode || contact?.postalCode || '';
  const partyCity = clientSnapshot?.city || contact?.city || '';
  const partyPhone = clientSnapshot?.phone || contact?.phone || '';
  const partyEmail = clientSnapshot?.email || contact?.email || '';
  const partyRc = clientSnapshot?.rc || contact?.rc || '';
  const partyAi = clientSnapshot?.ai || contact?.ai || '';
  const partyNif = clientSnapshot?.nif || contact?.nif || '';
  const partyNis = clientSnapshot?.nis || contact?.nis || '';

  const campaignDur = computeCampaignDuration(campaignStartDate, campaignEndDate);
  const hasCampaignBanner =
    showCampaignOnPrint !== false &&
    Boolean(campaignRef?.trim() || (campaignStartDate && campaignEndDate));

  const uniqueRates = Array.from(new Set(lines.map((l) => l.tvaRate).filter((r) => Number.isFinite(r))));
  const tvaRateLabel = uniqueRates.length === 1 ? `${uniqueRates[0]}%` : '';

  const computedWords = amountCentimesToFrenchWords(totalTtcCentimes, currency);
  const displayAmountWords = capitalizeFirstFrench(
    amountInWordsOverride?.trim() ? amountInWordsOverride : computedWords
  );

  const hasFiscalIds = Boolean(rc || nif || nis || ai);
  const hasFooterNotes = Boolean(
    notes?.trim() || (docKind === 'proforma' && (paymentConditions || deliveryDelay))
  );

  const chunks = computeTemplatePageChunks(lines, {
    hasCampaignBanner,
    hasFooterNotes,
  });
  const totalPages = chunks.length;

  const partyBlockLabel =
    docKind === 'bc_emis' || docKind === 'facture_fournisseur' ? 'Fournisseur :' : 'Client :';

  const docBadgeText = formatDocumentBadgeTitle(docKind, docNumber);
  const referenceLine = bcNumber?.trim()
    ? `Ref bc : ${bcNumber.trim()}`
    : supplierRef?.trim()
      ? `Réf. fournisseur : ${supplierRef.trim()}`
      : '';

  const headerAddressParts = [
    companyAddr,
    [companyPostal, companyCity]
      .filter((part) => part && !companyAddr.toLowerCase().includes(part.toLowerCase()))
      .join(' '),
  ]
    .filter(Boolean)
    .join(', ');

  const headerTelParts = [
    companyPhone ? `Tél : ${companyPhone}` : '',
    companyFax ? `Fax : ${companyFax}` : '',
  ]
    .filter(Boolean)
    .join(' / ');

  const bankFooterText = [bankInfo, rib ? `RIB : ${rib}` : ''].filter(Boolean).join(' — ');
  const contactFooterText = [
    companyName,
    companyAddr,
    companyPhone ? `Tél : ${companyPhone}` : '',
    companyEmail,
  ]
    .filter(Boolean)
    .join(' · ');

  const isUnpricedBc =
    docKind === 'bc_emis' &&
    (Boolean(unpriced) ||
      (totalHtCentimes === 0 &&
        totalTtcCentimes === 0 &&
        lines.every((l) => l.unitPriceCentimes === 0 && (l.htCentimes ?? 0) === 0)));

  if (docKind === 'bc_emis') {
    const cleanBcNum = stripBcPrefix(docNumber) || docNumber;
    const bcFiscalParts = [
      rc ? `RC : ${rc}` : '',
      nif ? `NIF: ${nif}` : '',
      ai ? `AI: ${ai}` : '',
      nis ? `NIS: ${nis}` : '',
    ].filter(Boolean);
    const bcFooterLine = [
      companyEmail ? `Email: ${companyEmail}` : '',
      companyPhone ? `Tel: ${companyPhone}` : '',
    ]
      .filter(Boolean)
      .join(' / ');
    const bcPartyAddress = [
      partyAddr,
      [partyPostal, partyCity]
        .filter((part) => part && !partyAddr.toLowerCase().includes(part.toLowerCase()))
        .join(' '),
    ]
      .filter(Boolean)
      .join(', ');

    return (
      <div
        style={{
          fontFamily: "'Segoe UI', Arial, Helvetica, sans-serif",
          color: '#1E293B',
          backgroundColor: 'transparent',
        }}
      >
        {chunks.map((chunk, idx) => {
          const isFirstPage = idx === 0;
          const isLastPage = idx === totalPages - 1;
          const needFillerRows = isFirstPage && totalPages === 1 && chunk.lines.length <= 3;

          return (
            <div
              key={`bc-sheet-${idx}`}
              className="print-a4-sheet"
              style={{
                width: '210mm',
                minHeight: '296mm',
                backgroundColor: '#FFFFFF',
                color: '#1E293B',
                boxSizing: 'border-box',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                boxShadow: '0 8px 28px rgba(15, 23, 42, 0.16)',
                position: 'relative',
                overflow: 'hidden',
              }}
            >
              <div style={{ padding: '11mm 14mm 6mm 14mm', flex: '1 1 auto' }}>
                {/* 1. EN-TÊTE : Logo gauche + Coordonnées société à droite */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    justifyContent: 'space-between',
                    gap: '12px',
                    paddingBottom: '8px',
                  }}
                >
                  <div style={{ maxWidth: '52%', display: 'flex', alignItems: 'center' }}>
                    {logoUrl ? (
                      <img
                        src={logoUrl}
                        alt={companyName}
                        style={{
                          maxHeight: '24mm',
                          maxWidth: '78mm',
                          width: 'auto',
                          height: 'auto',
                          objectFit: 'contain',
                          display: 'block',
                        }}
                      />
                    ) : (
                      <div
                        style={{
                          fontSize: '20px',
                          fontWeight: 800,
                          color: accentColor,
                          letterSpacing: '0.4px',
                        }}
                      >
                        {companyName}
                      </div>
                    )}
                  </div>

                  <div
                    style={{
                      maxWidth: '45%',
                      textAlign: 'right',
                      fontSize: '9px',
                      lineHeight: 1.48,
                      color: '#475569',
                    }}
                  >
                    <div style={{ fontWeight: 700, fontSize: '9.8px', color: accentColor }}>
                      {companyName}
                    </div>
                    {headerAddressParts && <div>{headerAddressParts}</div>}
                    {companyEmail && <div>Email : {companyEmail}</div>}
                    {headerTelParts && <div>{headerTelParts}</div>}
                  </div>
                </div>

                {/* 2. BANDE FISCALE ENCADRÉE COULEUR PRIMAIRE */}
                {bcFiscalParts.length > 0 && (
                  <div
                    style={{
                      border: `1.8px solid ${primaryColor}`,
                      padding: '4.5px 10px',
                      textAlign: 'center',
                      fontSize: '9.3px',
                      fontWeight: 600,
                      color: '#1E293B',
                      backgroundColor: '#FFFFFF',
                      marginBottom: '9px',
                    }}
                  >
                    {bcFiscalParts.join(' - ')}
                  </div>
                )}

                {/* 3. LIEU & DATE SOUS LA BANDE FISCALE */}
                <div
                  style={{
                    textAlign: 'right',
                    fontSize: '10.8px',
                    fontWeight: 700,
                    color: '#111827',
                    marginBottom: '12px',
                  }}
                >
                  {companyCity} le : {formatDateHyphenFr(issueDate)}
                </div>

                {/* 4. BLOC TITRE GRIS À GAUCHE + BLOC FOURNISSEUR ENCADRÉ ROSE À DROITE */}
                {isFirstPage ? (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'stretch',
                      justifyContent: 'space-between',
                      gap: '14px',
                      marginBottom: '14px',
                    }}
                  >
                    <div
                      style={{
                        width: '43%',
                        border: '1.5px solid #94A3B8',
                        backgroundColor: '#F1F5F9',
                        padding: '10px 14px',
                        display: 'flex',
                        flexDirection: 'column',
                        justifyContent: 'center',
                      }}
                    >
                      <div
                        style={{
                          fontSize: '13.5px',
                          fontWeight: 800,
                          color: '#0F172A',
                          letterSpacing: '0.2px',
                        }}
                      >
                        Bon de commande n° {cleanBcNum}
                      </div>
                      {dueDate && (
                        <div style={{ marginTop: '4px', fontSize: '9px', color: '#475569' }}>
                          Livraison souhaitée : {formatDateHyphenFr(dueDate)}
                        </div>
                      )}
                      {hasCampaignBanner && (
                        <div style={{ marginTop: '3px', fontSize: '9px', color: accentColor, fontWeight: 600 }}>
                          {campaignRef ? `Objet : ${campaignRef}` : ''}
                        </div>
                      )}
                    </div>

                    <div
                      style={{
                        width: '55%',
                        border: `1.8px solid ${primaryColor}`,
                        backgroundColor: '#FFFFFF',
                        padding: '8px 12px',
                        fontSize: '9.8px',
                        lineHeight: 1.52,
                        color: '#1E293B',
                      }}
                    >
                      <div>
                        <span style={{ fontWeight: 700, color: accentColor }}>Fournisseur : </span>
                        <span style={{ fontWeight: 800, color: '#0F172A' }}>{partyCompany}</span>
                      </div>
                      {partyContact && partyContact !== partyCompany && (
                        <div>
                          <span style={{ fontWeight: 700, color: accentColor }}>Contact : </span>
                          <span>{partyContact}</span>
                        </div>
                      )}
                      {bcPartyAddress && (
                        <div>
                          <span style={{ fontWeight: 700, color: accentColor }}>Adresse : </span>
                          <span>{bcPartyAddress}</span>
                        </div>
                      )}
                      {partyEmail && (
                        <div>
                          <span style={{ fontWeight: 700, color: accentColor }}>Email : </span>
                          <span>{partyEmail}</span>
                        </div>
                      )}
                      {partyPhone && (
                        <div>
                          <span style={{ fontWeight: 700, color: accentColor }}>Tél : </span>
                          <span>{partyPhone}</span>
                        </div>
                      )}
                      {(partyNif || partyRc) && (
                        <div style={{ fontSize: '8.8px', color: '#475569', marginTop: '2px' }}>
                          {[partyRc ? `RC : ${partyRc}` : '', partyNif ? `NIF : ${partyNif}` : '']
                            .filter(Boolean)
                            .join(' · ')}
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div
                    style={{
                      marginBottom: '10px',
                      padding: '5px 10px',
                      border: `1px solid ${primaryColor}`,
                      fontSize: '9.5px',
                      display: 'flex',
                      justifyContent: 'space-between',
                    }}
                  >
                    <strong>Bon de commande n° {cleanBcNum} (Suite)</strong>
                    <span>Fournisseur : {partyCompany}</span>
                  </div>
                )}

                {/* 5. TABLEAU DES LIGNES ENCADRÉ ROSE : N° | Désignation | Quantité | Prix u | Total */}
                <table
                  style={{
                    width: '100%',
                    borderCollapse: 'collapse',
                    fontSize: '10px',
                    border: `1.8px solid ${primaryColor}`,
                  }}
                >
                  <thead>
                    <tr
                      style={{
                        backgroundColor: hexToRgba(primaryColor, 0.09),
                        color: '#0F172A',
                        fontSize: '10px',
                        fontWeight: 800,
                      }}
                    >
                      <th
                        style={{
                          width: '34px',
                          padding: '7px 5px',
                          textAlign: 'center',
                          borderBottom: `1.5px solid ${primaryColor}`,
                          borderRight: `1px solid ${primaryColor}`,
                        }}
                      >
                        N°
                      </th>
                      <th
                        style={{
                          padding: '7px 9px',
                          textAlign: 'left',
                          borderBottom: `1.5px solid ${primaryColor}`,
                          borderRight: `1px solid ${primaryColor}`,
                        }}
                      >
                        Désignation
                      </th>
                      <th
                        style={{
                          width: '78px',
                          padding: '7px 7px',
                          textAlign: 'center',
                          borderBottom: `1.5px solid ${primaryColor}`,
                          borderRight: `1px solid ${primaryColor}`,
                        }}
                      >
                        Quantité
                      </th>
                      <th
                        style={{
                          width: '86px',
                          padding: '7px 8px',
                          textAlign: 'right',
                          borderBottom: `1.5px solid ${primaryColor}`,
                          borderRight: `1px solid ${primaryColor}`,
                        }}
                      >
                        Prix u
                      </th>
                      <th
                        style={{
                          width: '96px',
                          padding: '7px 8px',
                          textAlign: 'right',
                          borderBottom: `1.5px solid ${primaryColor}`,
                        }}
                      >
                        Total
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {chunk.lines.map((line, lineIdx) => {
                      const globalIdx = chunk.startIndex + lineIdx + 1;
                      const descParts = (line.description || '').split('\n');
                      const mainTitle = descParts[0] || '';
                      const subLines = descParts.slice(1).filter((s) => s.length > 0);
                      const lineHasPrice = line.unitPriceCentimes > 0 || (line.htCentimes ?? 0) > 0;
                      const hideQtyCell = isUnpricedBc && line.quantity <= 0;
                      const qtyText = hideQtyCell
                        ? ''
                        : line.quantity > 0
                        ? `${formatQuantityFr(line.quantity)}${
                            line.unit && line.unit !== 'u' ? ` ${line.unit}` : ''
                          }`
                        : '';
                      const puText =
                        isUnpricedBc || line.unitPriceCentimes <= 0
                          ? ''
                          : formatMoneyNumberOnly(line.unitPriceCentimes);
                      const totalText =
                        isUnpricedBc || (!lineHasPrice && (line.htCentimes ?? 0) <= 0)
                          ? ''
                          : formatMoneyNumberOnly(line.htCentimes);

                      return (
                        <tr
                          key={line.id || `bc-line-${globalIdx}`}
                          style={{ verticalAlign: 'top', backgroundColor: '#FFFFFF' }}
                        >
                          <td
                            style={{
                              padding: '7px 5px',
                              textAlign: 'center',
                              borderTop: `1px solid ${hexToRgba(primaryColor, 0.45)}`,
                              borderRight: `1px solid ${primaryColor}`,
                              fontVariantNumeric: 'tabular-nums',
                              fontWeight: 600,
                            }}
                          >
                            {globalIdx}
                          </td>
                          <td
                            style={{
                              padding: '7px 9px',
                              borderTop: `1px solid ${hexToRgba(primaryColor, 0.45)}`,
                              borderRight: `1px solid ${primaryColor}`,
                            }}
                          >
                            <div style={{ fontWeight: 700, color: '#0F172A', lineHeight: 1.38 }}>
                              {mainTitle}
                            </div>
                            {subLines.length > 0 && (
                              <div
                                style={{
                                  marginTop: '2px',
                                  fontSize: '9.4px',
                                  lineHeight: 1.4,
                                  color: '#334155',
                                  whiteSpace: 'pre-line',
                                }}
                              >
                                {subLines.join('\n')}
                              </div>
                            )}
                          </td>
                          <td
                            style={{
                              padding: '7px 7px',
                              textAlign: 'center',
                              borderTop: `1px solid ${hexToRgba(primaryColor, 0.45)}`,
                              borderRight: `1px solid ${primaryColor}`,
                              fontVariantNumeric: 'tabular-nums',
                            }}
                          >
                            {qtyText}
                          </td>
                          <td
                            style={{
                              padding: '7px 8px',
                              textAlign: 'right',
                              borderTop: `1px solid ${hexToRgba(primaryColor, 0.45)}`,
                              borderRight: `1px solid ${primaryColor}`,
                              fontVariantNumeric: 'tabular-nums',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {puText}
                          </td>
                          <td
                            style={{
                              padding: '7px 8px',
                              textAlign: 'right',
                              fontWeight: 700,
                              borderTop: `1px solid ${hexToRgba(primaryColor, 0.45)}`,
                              fontVariantNumeric: 'tabular-nums',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {totalText}
                          </td>
                        </tr>
                      );
                    })}

                    {needFillerRows && (
                      <tr style={{ height: '38mm', backgroundColor: '#FFFFFF' }}>
                        <td
                          style={{
                            borderTop: `1px solid ${hexToRgba(primaryColor, 0.3)}`,
                            borderRight: `1px solid ${primaryColor}`,
                          }}
                        />
                        <td
                          style={{
                            borderTop: `1px solid ${hexToRgba(primaryColor, 0.3)}`,
                            borderRight: `1px solid ${primaryColor}`,
                          }}
                        />
                        <td
                          style={{
                            borderTop: `1px solid ${hexToRgba(primaryColor, 0.3)}`,
                            borderRight: `1px solid ${primaryColor}`,
                          }}
                        />
                        <td
                          style={{
                            borderTop: `1px solid ${hexToRgba(primaryColor, 0.3)}`,
                            borderRight: `1px solid ${primaryColor}`,
                          }}
                        />
                        <td
                          style={{
                            borderTop: `1px solid ${hexToRgba(primaryColor, 0.3)}`,
                          }}
                        />
                      </tr>
                    )}
                  </tbody>
                </table>

                {/* 6. TOTAUX BAS-DROITE + ARRÊTÉ À + CACHET */}
                {isLastPage ? (
                  <>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        justifyContent: 'space-between',
                        gap: '16px',
                        marginTop: '14px',
                      }}
                    >
                      <div style={{ width: '56%', paddingTop: '2px' }}>
                        <div style={{ fontSize: '9.8px', fontWeight: 600, color: '#1E293B' }}>
                          {AMOUNT_PHRASE_PREFIX.bc_emis} :
                        </div>
                        <div
                          style={{
                            marginTop: '4px',
                            minHeight: '18px',
                            fontSize: '10.2px',
                            fontWeight: 700,
                            color: '#0F172A',
                            lineHeight: 1.45,
                            padding: '5px 8px',
                            borderLeft: `3px solid ${primaryColor}`,
                            backgroundColor: hexToRgba(primaryColor, 0.05),
                          }}
                        >
                          {!isUnpricedBc && totalTtcCentimes > 0 ? displayAmountWords : ''}
                        </div>

                        {notes?.trim() && (
                          <div style={{ marginTop: '8px', fontSize: '9px', color: '#475569' }}>
                            <strong style={{ color: accentColor }}>Conditions / Notes :</strong> {notes}
                          </div>
                        )}
                      </div>

                      <div
                        style={{
                          width: '40%',
                          border: `1.8px solid ${primaryColor}`,
                          fontSize: '10px',
                          fontVariantNumeric: 'tabular-nums',
                          backgroundColor: '#FFFFFF',
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            padding: '5.5px 10px',
                            borderBottom: `1px solid ${primaryColor}`,
                          }}
                        >
                          <span style={{ fontWeight: 700 }}>Total HT</span>
                          <strong style={{ minWidth: '40px', textAlign: 'right' }}>
                            {isUnpricedBc ? '' : formatMoneyNumberOnly(totalHtCentimes)}
                          </strong>
                        </div>
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            padding: '5.5px 10px',
                            borderBottom: `1px solid ${primaryColor}`,
                          }}
                        >
                          <span style={{ fontWeight: 700 }}>
                            TVA{' '}
                            {isUnpricedBc || !tvaRateLabel || tvaRateLabel === '0%'
                              ? '19 %'
                              : tvaRateLabel.replace('%', ' %')}
                          </span>
                          <strong style={{ minWidth: '40px', textAlign: 'right' }}>
                            {isUnpricedBc ? '' : formatMoneyNumberOnly(totalTvaCentimes)}
                          </strong>
                        </div>
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            padding: '6.5px 10px',
                            backgroundColor: hexToRgba(primaryColor, 0.12),
                            fontWeight: 800,
                            fontSize: '10.8px',
                          }}
                        >
                          <span>Total TTC</span>
                          <span style={{ minWidth: '40px', textAlign: 'right' }}>
                            {isUnpricedBc ? '' : formatMoneyNumberOnly(totalTtcCentimes)}
                          </span>
                        </div>
                      </div>
                    </div>

                    <div
                      style={{
                        marginTop: '22px',
                        display: 'flex',
                        justifyContent: 'flex-end',
                      }}
                    >
                      <div style={{ width: '48%', textAlign: 'center' }}>
                        <div
                          style={{
                            fontSize: '10px',
                            fontWeight: 700,
                            color: accentColor,
                            textTransform: 'uppercase',
                            letterSpacing: '0.4px',
                          }}
                        >
                          {signatureLabel}
                        </div>
                        {signatureDataUrl ? (
                          <img
                            src={signatureDataUrl}
                            alt="Cachet et signature"
                            style={{
                              maxHeight: '24mm',
                              maxWidth: '60mm',
                              width: 'auto',
                              height: 'auto',
                              objectFit: 'contain',
                              margin: '6px auto 0 auto',
                              display: 'block',
                            }}
                          />
                        ) : (
                          <div style={{ height: '20mm' }} />
                        )}
                      </div>
                    </div>
                  </>
                ) : (
                  <div
                    style={{
                      marginTop: '10px',
                      textAlign: 'right',
                      fontSize: '9.5px',
                      fontStyle: 'italic',
                      color: '#64748B',
                    }}
                  >
                    Suite sur la page suivante (Page {idx + 2}/{totalPages})…
                  </div>
                )}
              </div>

              {/* 7. BANDEAU PIED DE PAGE PLEINE LARGEUR COULEUR PRIMAIRE TEXTE BLANC GRAS */}
              <div style={{ marginTop: 'auto' }}>
                {totalPages > 1 && (
                  <div
                    style={{
                      padding: '0 14mm 3px 14mm',
                      textAlign: 'right',
                      fontSize: '8px',
                      fontWeight: 600,
                      color: '#64748B',
                    }}
                  >
                    Page {idx + 1}/{totalPages}
                  </div>
                )}
                <div
                  style={{
                    width: '100%',
                    backgroundColor: primaryColor,
                    color: '#FFFFFF',
                    fontWeight: 700,
                    fontSize: '9.5px',
                    textAlign: 'center',
                    padding: '6.5px 14mm',
                    letterSpacing: '0.2px',
                  }}
                >
                  {bcFooterLine || companyName}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div
      style={{
        fontFamily: "'Segoe UI', Arial, Helvetica, sans-serif",
        color: '#222222',
        backgroundColor: 'transparent',
      }}
    >
      {chunks.map((chunk, idx) => {
        const isFirstPage = idx === 0;
        const isLastPage = idx === totalPages - 1;
        const needFillerRows = isFirstPage && totalPages === 1 && chunk.lines.length <= 3;

        return (
          <div
            key={`sheet-${idx}`}
            className="print-a4-sheet"
            style={{
              width: '210mm',
              minHeight: '296mm',
              backgroundColor: '#FFFFFF',
              color: '#222222',
              boxSizing: 'border-box',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'space-between',
              boxShadow: '0 8px 28px rgba(15, 23, 42, 0.16)',
              position: 'relative',
              overflow: 'hidden',
            }}
          >
            {/* Contenu principal (avec marges A4 12mm haut/bas, 14mm gauche/droite) */}
            <div style={{ padding: '11mm 14mm 6mm 14mm', flex: '1 1 auto' }}>
              {/* 1. EN-TÊTE : Logo gauche + Coordonnées société grises à droite */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  justifyContent: 'space-between',
                  gap: '12px',
                  paddingBottom: '6px',
                }}
              >
                <div style={{ maxWidth: '55%', display: 'flex', alignItems: 'center', gap: '10px' }}>
                  {logoUrl ? (
                    <img
                      src={logoUrl}
                      alt={companyName}
                      style={{
                        maxHeight: '22mm',
                        maxWidth: '75mm',
                        width: 'auto',
                        height: 'auto',
                        objectFit: 'contain',
                        display: 'block',
                      }}
                    />
                  ) : (
                    <div
                      style={{
                        fontSize: '19px',
                        fontWeight: 800,
                        color: accentColor,
                        letterSpacing: '0.4px',
                        lineHeight: 1.15,
                      }}
                    >
                      {companyName}
                    </div>
                  )}
                </div>

                <div
                  style={{
                    maxWidth: '43%',
                    textAlign: 'right',
                    fontSize: '8.8px',
                    lineHeight: 1.45,
                    color: '#666666',
                  }}
                >
                  {logoUrl && (
                    <div style={{ fontWeight: 700, fontSize: '9.5px', color: accentColor, marginBottom: '1px' }}>
                      {companyName}
                    </div>
                  )}
                  {headerAddressParts && <div>{headerAddressParts}</div>}
                  {headerTelParts && <div>{headerTelParts}</div>}
                  {companyEmail && <div>{companyEmail}</div>}
                </div>
              </div>

              {/* 2. BANDE FISCALE (sous l'en-tête) */}
              {hasFiscalIds && (
                <div
                  style={{
                    border: `1px solid ${accentColor}`,
                    backgroundColor: hexToRgba(primaryColor, 0.06),
                    borderRadius: '3px',
                    padding: '4.5px 10px',
                    marginBottom: '11px',
                    display: 'flex',
                    justifyContent: 'space-between',
                    flexWrap: 'wrap',
                    gap: '6px 14px',
                    fontSize: '9px',
                    fontWeight: 600,
                    color: '#2B2B2B',
                  }}
                >
                  {rc && (
                    <span>
                      <strong style={{ color: accentColor }}>RC N° :</strong> {rc}
                    </span>
                  )}
                  {nif && (
                    <span>
                      <strong style={{ color: accentColor }}>NIF N° :</strong> {nif}
                    </span>
                  )}
                  {nis && (
                    <span>
                      <strong style={{ color: accentColor }}>NIS :</strong> {nis}
                    </span>
                  )}
                  {ai && (
                    <span>
                      <strong style={{ color: accentColor }}>AI N° :</strong> {ai}
                    </span>
                  )}
                </div>
              )}

              {/* 3. TITRE DOCUMENT + REF BC + DATE */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '10px',
                  marginBottom: isFirstPage ? '12px' : '8px',
                }}
              >
                <div
                  style={{
                    border: `1.5px solid ${primaryColor}`,
                    backgroundColor: hexToRgba(primaryColor, 0.09),
                    color: primaryColor,
                    borderRadius: '5px',
                    padding: '6px 14px',
                    fontSize: '13.5px',
                    fontWeight: 800,
                    letterSpacing: '0.35px',
                    textTransform: 'uppercase',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {docBadgeText}
                </div>

                <div
                  style={{
                    flex: '1 1 auto',
                    textAlign: 'center',
                    fontSize: '10.5px',
                    fontWeight: 700,
                    color: '#222222',
                  }}
                >
                  {referenceLine || (!isFirstPage ? `Suite — Page ${idx + 1}/${totalPages}` : '')}
                </div>

                <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <div style={{ fontSize: '11px', fontWeight: 700, color: '#222222' }}>
                    {companyCity} le {formatDateFr(issueDate)}
                  </div>
                  {isFirstPage && dueDate && docKind !== 'proforma' && (
                    <div style={{ fontSize: '8.8px', color: '#666666', marginTop: '1px' }}>
                      Échéance : {formatDateFr(dueDate)}
                    </div>
                  )}
                  {isFirstPage && docKind === 'proforma' && validUntil && (
                    <div style={{ fontSize: '8.8px', color: '#666666', marginTop: '1px' }}>
                      Valable jusqu’au {formatDateFr(validUntil)}
                      {validityDays ? ` (${validityDays} j)` : ''}
                    </div>
                  )}
                </div>
              </div>

              {/* 4. BLOC IDENTITÉ CLIENT & IDENTIFIANTS FISCAUX (page 1 complète, compact ensuite) */}
              {isFirstPage ? (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    justifyContent: 'space-between',
                    gap: '16px',
                    marginBottom: '10px',
                  }}
                >
                  {/* Gauche : Identifiants fiscaux du client / fournisseur */}
                  <div
                    style={{
                      width: '43%',
                      fontSize: '9.5px',
                      lineHeight: 1.6,
                      color: '#333333',
                      paddingTop: '4px',
                    }}
                  >
                    {partyRc && (
                      <div>
                        <span style={{ fontWeight: 700, color: accentColor }}>RC : </span>
                        <span>{partyRc}</span>
                      </div>
                    )}
                    {partyAi && (
                      <div>
                        <span style={{ fontWeight: 700, color: accentColor }}>AI : </span>
                        <span>{partyAi}</span>
                      </div>
                    )}
                    {partyNif && (
                      <div>
                        <span style={{ fontWeight: 700, color: accentColor }}>NIF : </span>
                        <span>{partyNif}</span>
                      </div>
                    )}
                    {partyNis && (
                      <div>
                        <span style={{ fontWeight: 700, color: accentColor }}>NIS : </span>
                        <span>{partyNis}</span>
                      </div>
                    )}
                  </div>

                  {/* Droite : Bloc Client : avec labels soulignés en couleur primaire */}
                  <div
                    style={{
                      width: '55%',
                      borderLeft: `2px solid ${hexToRgba(accentColor, 0.35)}`,
                      paddingLeft: '12px',
                      fontSize: '10px',
                      lineHeight: 1.58,
                      color: '#222222',
                    }}
                  >
                    <div
                      style={{
                        fontSize: '10.8px',
                        fontWeight: 800,
                        color: accentColor,
                        marginBottom: '3px',
                      }}
                    >
                      {partyBlockLabel}
                    </div>

                    <div>
                      <span
                        style={{
                          fontWeight: 700,
                          color: primaryColor,
                          textDecoration: 'underline',
                        }}
                      >
                        NOM :
                      </span>{' '}
                      <span style={{ fontWeight: 700, color: '#111111' }}>{partyCompany}</span>
                    </div>

                    {partyContact && partyContact !== partyCompany && (
                      <div>
                        <span
                          style={{
                            fontWeight: 700,
                            color: primaryColor,
                            textDecoration: 'underline',
                          }}
                        >
                          Contact :
                        </span>{' '}
                        <span>{partyContact}</span>
                      </div>
                    )}

                    {partyAddr && (
                      <div>
                        <span
                          style={{
                            fontWeight: 700,
                            color: primaryColor,
                            textDecoration: 'underline',
                          }}
                        >
                          Adresse :
                        </span>{' '}
                        <span>{partyAddr}</span>
                      </div>
                    )}

                    {partyPostal && (
                      <div>
                        <span
                          style={{
                            fontWeight: 700,
                            color: primaryColor,
                            textDecoration: 'underline',
                          }}
                        >
                          Code postal :
                        </span>{' '}
                        <span>{partyPostal}</span>
                      </div>
                    )}

                    {partyCity && (
                      <div>
                        <span
                          style={{
                            fontWeight: 700,
                            color: primaryColor,
                            textDecoration: 'underline',
                          }}
                        >
                          Ville :
                        </span>{' '}
                        <span>{partyCity}</span>
                      </div>
                    )}

                    {partyPhone && (
                      <div>
                        <span
                          style={{
                            fontWeight: 700,
                            color: primaryColor,
                            textDecoration: 'underline',
                          }}
                        >
                          Tel &amp; Fax :
                        </span>{' '}
                        <span>{partyPhone}</span>
                      </div>
                    )}

                    {partyEmail && (
                      <div>
                        <span
                          style={{
                            fontWeight: 700,
                            color: primaryColor,
                            textDecoration: 'underline',
                          }}
                        >
                          Email :
                        </span>{' '}
                        <span>{partyEmail}</span>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div
                  style={{
                    marginBottom: '8px',
                    padding: '4px 10px',
                    borderRadius: '3px',
                    backgroundColor: hexToRgba(accentColor, 0.05),
                    border: `1px solid ${hexToRgba(accentColor, 0.2)}`,
                    fontSize: '9.5px',
                    display: 'flex',
                    justifyContent: 'space-between',
                    color: '#333333',
                  }}
                >
                  <span>
                    <strong style={{ color: accentColor }}>{partyBlockLabel}</strong> {partyCompany}
                  </span>
                  {referenceLine && <span>{referenceLine}</span>}
                </div>
              )}

              {/* 5. BANDEAU CAMPAGNE (discret et élégant) */}
              {isFirstPage && hasCampaignBanner && (
                <div
                  style={{
                    borderLeft: `4px solid ${primaryColor}`,
                    backgroundColor: hexToRgba(primaryColor, 0.06),
                    padding: '5px 10px',
                    marginBottom: '10px',
                    fontSize: '9.8px',
                    color: '#222222',
                  }}
                >
                  <strong style={{ color: accentColor }}>
                    {campaignRef ? `Campagne : ${campaignRef}` : 'Période de campagne'}
                  </strong>
                  {campaignStartDate && campaignEndDate && (
                    <span>
                      {' '}
                      — du {formatDateFr(campaignStartDate)} au {formatDateFr(campaignEndDate)}
                      {campaignDur.valid && campaignDur.days > 0 ? ` (${campaignDur.label})` : ''}
                    </span>
                  )}
                </div>
              )}

              {/* 6. TABLEAU DES PRESTATIONS */}
              <table
                style={{
                  width: '100%',
                  borderCollapse: 'collapse',
                  fontSize: '10px',
                  border: `1px solid ${accentColor}`,
                }}
              >
                <thead>
                  <tr
                    style={{
                      backgroundColor: accentColor,
                      color: '#FFFFFF',
                      fontSize: '9.8px',
                      fontWeight: 700,
                    }}
                  >
                    <th
                      style={{
                        width: '32px',
                        padding: '6.5px 5px',
                        textAlign: 'center',
                        borderRight: '1px solid rgba(255,255,255,0.22)',
                      }}
                    >
                      N°
                    </th>
                    <th
                      style={{
                        padding: '6.5px 8px',
                        textAlign: 'left',
                        borderRight: '1px solid rgba(255,255,255,0.22)',
                      }}
                    >
                      Désignation
                    </th>
                    <th
                      style={{
                        width: '62px',
                        padding: '6.5px 6px',
                        textAlign: 'right',
                        borderRight: '1px solid rgba(255,255,255,0.22)',
                      }}
                    >
                      Quantité
                    </th>
                    <th
                      style={{
                        width: '50px',
                        padding: '6.5px 6px',
                        textAlign: 'center',
                        borderRight: '1px solid rgba(255,255,255,0.22)',
                      }}
                    >
                      Unité
                    </th>
                    <th
                      style={{
                        width: '84px',
                        padding: '6.5px 8px',
                        textAlign: 'right',
                        borderRight: '1px solid rgba(255,255,255,0.22)',
                      }}
                    >
                      Prix HT
                    </th>
                    <th
                      style={{
                        width: '92px',
                        padding: '6.5px 8px',
                        textAlign: 'right',
                      }}
                    >
                      Total
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {chunk.lines.map((line, lineIdx) => {
                    const globalIdx = chunk.startIndex + lineIdx + 1;
                    const descParts = (line.description || '').split('\n');
                    const mainTitle = descParts[0] || '';
                    const subLines = descParts.slice(1).filter((s) => s.length > 0);
                    const rowBg = lineIdx % 2 === 1 ? '#FAFAFC' : '#FFFFFF';

                    return (
                      <tr
                        key={line.id || `line-${globalIdx}`}
                        style={{
                          backgroundColor: rowBg,
                          verticalAlign: 'top',
                        }}
                      >
                        <td
                          style={{
                            padding: '6.5px 5px',
                            textAlign: 'center',
                            color: '#555555',
                            borderTop: '1px solid #E2E8F0',
                            borderRight: '1px solid #E2E8F0',
                            fontVariantNumeric: 'tabular-nums',
                          }}
                        >
                          {globalIdx}
                        </td>
                        <td
                          style={{
                            padding: '6.5px 8px',
                            borderTop: '1px solid #E2E8F0',
                            borderRight: '1px solid #E2E8F0',
                          }}
                        >
                          <div
                            style={{
                              fontWeight: 700,
                              color: primaryColor,
                              fontSize: '10.2px',
                              lineHeight: 1.35,
                            }}
                          >
                            {mainTitle}
                          </div>
                          {subLines.length > 0 && (
                            <div
                              style={{
                                marginTop: '2px',
                                fontSize: '9.4px',
                                lineHeight: 1.4,
                                color: '#333333',
                                whiteSpace: 'pre-line',
                              }}
                            >
                              {subLines.join('\n')}
                            </div>
                          )}
                        </td>
                        <td
                          style={{
                            padding: '6.5px 6px',
                            textAlign: 'right',
                            color: '#222222',
                            borderTop: '1px solid #E2E8F0',
                            borderRight: '1px solid #E2E8F0',
                            fontVariantNumeric: 'tabular-nums',
                          }}
                        >
                          {formatQuantityFr(line.quantity)}
                        </td>
                        <td
                          style={{
                            padding: '6.5px 6px',
                            textAlign: 'center',
                            color: '#333333',
                            borderTop: '1px solid #E2E8F0',
                            borderRight: '1px solid #E2E8F0',
                          }}
                        >
                          {line.unit || 'u'}
                        </td>
                        <td
                          style={{
                            padding: '6.5px 8px',
                            textAlign: 'right',
                            color: '#222222',
                            borderTop: '1px solid #E2E8F0',
                            borderRight: '1px solid #E2E8F0',
                            fontVariantNumeric: 'tabular-nums',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {formatMoneyNumberOnly(line.unitPriceCentimes)}
                        </td>
                        <td
                          style={{
                            padding: '6.5px 8px',
                            textAlign: 'right',
                            fontWeight: 700,
                            color: '#111111',
                            borderTop: '1px solid #E2E8F0',
                            fontVariantNumeric: 'tabular-nums',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {formatMoneyNumberOnly(line.htCentimes)}
                        </td>
                      </tr>
                    );
                  })}

                  {/* Espace structuré sur les factures courtes comme dans le modèle Excel */}
                  {needFillerRows && (
                    <tr style={{ height: '34mm', backgroundColor: '#FFFFFF' }}>
                      <td style={{ borderTop: '1px solid #E2E8F0', borderRight: '1px solid #E2E8F0' }} />
                      <td style={{ borderTop: '1px solid #E2E8F0', borderRight: '1px solid #E2E8F0' }} />
                      <td style={{ borderTop: '1px solid #E2E8F0', borderRight: '1px solid #E2E8F0' }} />
                      <td style={{ borderTop: '1px solid #E2E8F0', borderRight: '1px solid #E2E8F0' }} />
                      <td style={{ borderTop: '1px solid #E2E8F0', borderRight: '1px solid #E2E8F0' }} />
                      <td style={{ borderTop: '1px solid #E2E8F0' }} />
                    </tr>
                  )}
                </tbody>
              </table>

              {/* 7 & 8. TOTAUX + MONTANT EN LETTRES + SIGNATURE (sur la dernière page) */}
              {isLastPage ? (
                <>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      justifyContent: 'space-between',
                      gap: '14px',
                      marginTop: '12px',
                    }}
                  >
                    {/* Gauche : Montant en lettres + conditions */}
                    <div style={{ width: '55%', paddingTop: '2px' }}>
                      <div style={{ fontSize: '9.8px', color: '#333333', marginBottom: '3px' }}>
                        {AMOUNT_PHRASE_PREFIX[docKind]} :
                      </div>
                      <div
                        style={{
                          fontSize: '10.4px',
                          fontWeight: 700,
                          color: '#111111',
                          lineHeight: 1.45,
                          padding: '6px 9px',
                          borderRadius: '3px',
                          backgroundColor: hexToRgba(primaryColor, 0.05),
                          borderLeft: `3px solid ${primaryColor}`,
                        }}
                      >
                        {displayAmountWords}
                      </div>

                      {docKind === 'proforma' && (paymentConditions || deliveryDelay) && (
                        <div style={{ marginTop: '7px', fontSize: '9.2px', color: '#333333', lineHeight: 1.45 }}>
                          {paymentConditions && (
                            <div>
                              <strong style={{ color: accentColor }}>Conditions de paiement :</strong>{' '}
                              {paymentConditions}
                            </div>
                          )}
                          {deliveryDelay && (
                            <div>
                              <strong style={{ color: accentColor }}>Délai de réalisation :</strong>{' '}
                              {deliveryDelay}
                            </div>
                          )}
                        </div>
                      )}

                      {notes?.trim() && (
                        <div style={{ marginTop: '6px', fontSize: '9.2px', color: '#444444' }}>
                          <strong style={{ color: accentColor }}>Note :</strong> {notes}
                        </div>
                      )}
                    </div>

                    {/* Droite : Boîte TOTAL HT / TVA / TOTAL TTC */}
                    <div
                      style={{
                        width: '42%',
                        border: `1px solid ${accentColor}`,
                        borderRadius: '4px',
                        overflow: 'hidden',
                        fontSize: '10.2px',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          padding: '5.5px 10px',
                          borderBottom: '1px solid #E2E8F0',
                          backgroundColor: '#FFFFFF',
                        }}
                      >
                        <span style={{ fontWeight: 600, color: '#333333' }}>TOTAL HT</span>
                        <strong style={{ color: '#111111' }}>
                          {formatMoney(totalHtCentimes, currency)}
                        </strong>
                      </div>

                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          padding: '5.5px 10px',
                          borderBottom: '1px solid #E2E8F0',
                          backgroundColor: '#FFFFFF',
                        }}
                      >
                        <span style={{ fontWeight: 600, color: '#333333' }}>
                          TVA {tvaRateLabel}
                        </span>
                        <strong style={{ color: '#111111' }}>
                          {formatMoney(totalTvaCentimes, currency)}
                        </strong>
                      </div>

                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          padding: '7px 10px',
                          backgroundColor: primaryColor,
                          color: '#FFFFFF',
                          fontWeight: 800,
                          fontSize: '11.2px',
                        }}
                      >
                        <span>TOTAL TTC</span>
                        <span>{formatMoney(totalTtcCentimes, currency)}</span>
                      </div>

                      {typeof paidCentimes === 'number' && paidCentimes > 0 && (
                        <>
                          <div
                            style={{
                              display: 'flex',
                              justifyContent: 'space-between',
                              padding: '4.5px 10px',
                              borderTop: '1px solid #E2E8F0',
                              color: '#047857',
                              fontSize: '9.5px',
                            }}
                          >
                            <span>Déjà encaissé</span>
                            <strong>{formatMoney(paidCentimes, currency)}</strong>
                          </div>
                          <div
                            style={{
                              display: 'flex',
                              justifyContent: 'space-between',
                              padding: '4.5px 10px',
                              borderTop: '1px solid #E2E8F0',
                              color: (remainingCentimes || 0) > 0 ? '#B91C1C' : '#047857',
                              fontSize: '9.5px',
                            }}
                          >
                            <span>Reste à payer</span>
                            <strong>{formatMoney(remainingCentimes || 0, currency)}</strong>
                          </div>
                        </>
                      )}
                    </div>
                  </div>

                  {/* 9. ZONE SIGNATURE / CACHET */}
                  <div
                    style={{
                      marginTop: '18px',
                      display: 'flex',
                      alignItems: 'flex-start',
                      justifyContent: docKind === 'proforma' ? 'space-between' : 'center',
                      gap: '20px',
                    }}
                  >
                    {docKind === 'proforma' && (
                      <div
                        style={{
                          width: '46%',
                          minHeight: '24mm',
                          border: '1px dashed #CBD5E1',
                          borderRadius: '4px',
                          padding: '8px 10px',
                          textAlign: 'center',
                          fontSize: '9.5px',
                          color: '#555555',
                        }}
                      >
                        <div style={{ fontWeight: 700, color: '#222222' }}>
                          Bon pour accord — Signature et cachet du client
                        </div>
                      </div>
                    )}

                    <div
                      style={{
                        width: docKind === 'proforma' ? '46%' : '52%',
                        textAlign: 'center',
                        paddingTop: '4px',
                      }}
                    >
                      <div
                        style={{
                          fontSize: '10.5px',
                          fontWeight: 700,
                          color: accentColor,
                          letterSpacing: '0.5px',
                          textTransform: 'uppercase',
                        }}
                      >
                        {signatureLabel}
                      </div>
                      {signatureDataUrl ? (
                        <img
                          src={signatureDataUrl}
                          alt="Cachet et signature"
                          style={{
                            maxHeight: '22mm',
                            maxWidth: '58mm',
                            width: 'auto',
                            height: 'auto',
                            objectFit: 'contain',
                            margin: '4px auto 0 auto',
                            display: 'block',
                          }}
                        />
                      ) : (
                        <div style={{ height: '18mm' }} />
                      )}
                    </div>
                  </div>
                </>
              ) : (
                <div
                  style={{
                    marginTop: '10px',
                    textAlign: 'right',
                    fontSize: '9.5px',
                    fontStyle: 'italic',
                    color: '#555555',
                  }}
                >
                  Suite sur la page suivante (Page {idx + 2}/{totalPages})…
                </div>
              )}
            </div>

            {/* 10. PIED DE PAGE FIXE SUR CHAQUE PAGE + BARRE DÉGRADÉE FINALE */}
            <div style={{ marginTop: 'auto' }}>
              <div style={{ padding: '0 14mm 4px 14mm' }}>
                <div
                  style={{
                    borderTop: `1px solid ${accentColor}`,
                    paddingTop: '5px',
                    textAlign: 'center',
                  }}
                >
                  {bankFooterText && (
                    <div
                      style={{
                        fontSize: '8.5px',
                        fontWeight: 700,
                        color: '#222222',
                        lineHeight: 1.35,
                      }}
                    >
                      {bankFooterText}
                    </div>
                  )}
                  {contactFooterText && (
                    <div
                      style={{
                        fontSize: '8px',
                        color: '#555555',
                        marginTop: '1.5px',
                        lineHeight: 1.35,
                      }}
                    >
                      {contactFooterText}
                    </div>
                  )}
                  {footerNote && (
                    <div
                      style={{
                        fontSize: '7.8px',
                        color: '#666666',
                        marginTop: '1.5px',
                      }}
                    >
                      {footerNote}
                    </div>
                  )}
                  <div
                    style={{
                      textAlign: 'right',
                      fontSize: '8px',
                      fontWeight: 600,
                      color: '#666666',
                      marginTop: '2px',
                    }}
                  >
                    Page {idx + 1}/{totalPages}
                  </div>
                </div>
              </div>

              {/* Barre dégradée 3mm aux couleurs de la société */}
              <div
                style={{
                  height: '3mm',
                  width: '100%',
                  background: `linear-gradient(90deg, ${primaryColor} 0%, ${accentColor} 100%)`,
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
};
