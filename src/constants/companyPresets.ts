import type { CompanyProfile } from '../db/types';

export const VISTA_DIGITAL_PROFILE_ID = 'prof_vista_digital';
export const GRAVURE_PUB_PROFILE_ID = 'prof_gravure_pub';

export interface ColorPreset {
  id: string;
  label: string;
  primaryColor: string;
  accentColor: string;
}

export const COLOR_PRESETS: ColorPreset[] = [
  {
    id: 'vista',
    label: 'Rose / Violet / Blanc (VISTA DIGITAL)',
    primaryColor: '#FF33CC',
    accentColor: '#6B2FA0',
  },
  {
    id: 'gravure',
    label: 'Orange / Bleu / Blanc (GRAVURE PUB)',
    primaryColor: '#FF7A1A',
    accentColor: '#1F3A93',
  },
  {
    id: 'marine',
    label: 'Bleu marine / Blanc',
    primaryColor: '#0F1E36',
    accentColor: '#1D4ED8',
  },
  {
    id: 'vert',
    label: 'Vert / Blanc',
    primaryColor: '#059669',
    accentColor: '#065F46',
  },
  {
    id: 'rouge',
    label: 'Rouge / Gris / Blanc',
    primaryColor: '#DC2626',
    accentColor: '#334155',
  },
];

// Logo SVG hors-ligne par défaut pour SARL VISTA DIGITAL (remplaçable par l'utilisateur)
const VISTA_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 72" width="220" height="72">
  <defs>
    <linearGradient id="vg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#FF33CC"/>
      <stop offset="100%" stop-color="#6B2FA0"/>
    </linearGradient>
  </defs>
  <rect x="2" y="6" width="58" height="58" rx="12" fill="url(#vg)"/>
  <path d="M16 20 L31 50 L46 20" fill="none" stroke="#FFFFFF" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="48" cy="20" r="3.5" fill="#FFFFFF"/>
  <text x="72" y="34" font-family="Segoe UI, Arial, sans-serif" font-size="22" font-weight="800" fill="#6B2FA0" letter-spacing="0.5">VISTA</text>
  <text x="72" y="54" font-family="Segoe UI, Arial, sans-serif" font-size="17" font-weight="700" fill="#FF33CC" letter-spacing="2.2">DIGITAL</text>
</svg>`;

function svgToBase64DataUrl(svg: string): string {
  const bytes = new TextEncoder().encode(svg);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

export const DEFAULT_VISTA_LOGO_DATA_URL = svgToBase64DataUrl(VISTA_SVG);

export function buildDefaultVistaDigitalProfile(now = new Date().toISOString()): CompanyProfile {
  return {
    id: VISTA_DIGITAL_PROFILE_ID,
    name: 'SARL VISTA DIGITAL',
    logoDataUrl: DEFAULT_VISTA_LOGO_DATA_URL,
    address: '32 Rue Beauséjour, Bouzareah, Alger – Algérie',
    postalCode: '16011',
    city: 'Alger',
    phone: '023 79 54 86 / 0554 76 29 08 / 028 51 13 48',
    fax: '',
    email: 'contact@vistadigital.pub / VistaDigital13@gmail.com',
    nif: '001616101139795',
    nis: '001616110284058',
    rc: '16b1011397-00/16',
    ai: '16119136307',
    rib: '',
    bankInfo:
      'Compte SGA : 021 00007113 00334 22 11 - Compte Fransabank : 035 01602 2202000020 80',
    primaryColor: '#FF33CC',
    accentColor: '#6B2FA0',
    footerNote: '',
    signatureDataUrl: '',
    signatureLabel: 'SERVICE COMMERCIAL',
    applyThemeToApp: true,
    isDefault: true,
    createdAt: now,
    updatedAt: now,
  };
}

export function buildDefaultGravurePubProfile(now = new Date().toISOString()): CompanyProfile {
  return {
    id: GRAVURE_PUB_PROFILE_ID,
    name: 'SARL GRAVURE PUB',
    logoDataUrl: '',
    address: '',
    postalCode: '',
    city: 'Alger',
    phone: '',
    fax: '',
    email: '',
    nif: '',
    nis: '',
    rc: '',
    ai: '',
    rib: '',
    bankInfo: '',
    primaryColor: '#FF7A1A',
    accentColor: '#1F3A93',
    footerNote: '',
    signatureDataUrl: '',
    signatureLabel: 'SERVICE COMMERCIAL',
    applyThemeToApp: true,
    isDefault: false,
    createdAt: now,
    updatedAt: now,
  };
}
