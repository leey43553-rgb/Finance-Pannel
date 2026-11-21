import React, { useEffect, useMemo } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowDownLeft,
  ArrowUpRight,
  BookOpen,
  Building2,
  ClipboardList,
  FileCheck2,
  FileInput,
  FileSpreadsheet,
  FileText,
  HelpCircle,
  Info,
  Landmark,
  LayoutDashboard,
  Megaphone,
  PieChart,
  Receipt,
  Settings,
  Truck,
  Users,
  Wallet,
  AlertCircle,
  X,
} from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { APP_NAME, APP_VERSION, DEVELOPER_BRAND } from '../constants/branding';
import { db, recordAudit } from '../db/database';
import { setActiveCompanyProfile } from '../services/documentActions';
import { useAppStore } from '../store/useAppStore';

interface NavItem {
  to: string;
  label: string;
  icon: React.FC<{ className?: string }>;
}

const MAIN_NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Tableau de bord', icon: LayoutDashboard },
  { to: '/tresorerie', label: 'Trésorerie', icon: Wallet },
  { to: '/recettes', label: 'Recettes', icon: ArrowDownLeft },
  { to: '/depenses', label: 'Dépenses', icon: ArrowUpRight },
  { to: '/factures-clients', label: 'Factures clients', icon: FileText },
  { to: '/proformas', label: 'Proformas', icon: FileCheck2 },
  { to: '/bons-de-commande', label: 'Bons de commande', icon: ClipboardList },
  { to: '/factures-fournisseurs', label: 'Factures fournisseurs', icon: Receipt },
  { to: '/clients', label: 'Clients', icon: Users },
  { to: '/campagnes', label: 'Campagnes', icon: Megaphone },
  { to: '/fournisseurs', label: 'Fournisseurs', icon: Truck },
  { to: '/banques', label: 'Banques & comptes', icon: Landmark },
  { to: '/cheques-recus', label: 'Chèques reçus', icon: FileInput },
  { to: '/cheques-emis', label: 'Chèques émis', icon: FileSpreadsheet },
  { to: '/rapports', label: 'Rapports', icon: PieChart },
  { to: '/parametres', label: 'Paramètres', icon: Settings },
];

const SIMPLE_NAV_ORDER = [
  '/',
  '/factures-clients',
  '/proformas',
  '/bons-de-commande',
  '/clients',
  '/campagnes',
  '/depenses',
  '/cheques-recus',
  '/cheques-emis',
  '/rapports',
  '/parametres',
];

const ADVANCED_ONLY_ROUTES = new Set([
  '/tresorerie',
  '/recettes',
  '/factures-fournisseurs',
  '/fournisseurs',
  '/banques',
]);

const ROUTE_TITLES: Record<string, string> = {
  '/': 'Tableau de bord',
  '/tresorerie': 'Trésorerie, Journaux & Grand livre',
  '/recettes': 'Recettes & Paiements reçus',
  '/depenses': 'Dépenses',
  '/factures-clients': 'Factures clients',
  '/proformas': 'Factures Proforma',
  '/bons-de-commande': 'Bons de commande (Reçus & Émis)',
  '/factures-fournisseurs': 'Factures fournisseurs',
  '/clients': 'Clients',
  '/campagnes': 'Campagnes publicitaires',
  '/fournisseurs': 'Fournisseurs',
  '/banques': 'Banques & comptes',
  '/cheques-recus': 'Chèques reçus',
  '/cheques-emis': 'Chèques émis & Chéquiers',
  '/rapports': 'Rapports & Exports',
  '/parametres': 'Paramètres',
  '/aide': 'Aide & Prise en main',
  '/a-propos': 'À propos',
};

export const Layout: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const settings = useLiveQuery(() => db.settings.get('company_settings'));
  const companyProfiles = useLiveQuery(
    () => db.companyProfiles.filter((p) => !p.deletedAt).toArray(),
    [],
    []
  );
  const { backupWarning, setBackupWarning, pushToast } = useAppStore();

  const currentTitle = ROUTE_TITLES[location.pathname] || 'Gestion Financière';
  const uiMode = settings?.uiMode || 'simple';
  const scopeFilter = settings?.companyScopeFilter || 'all';

  const activeProfile = useMemo(
    () =>
      companyProfiles.find((p) => p.id === settings?.activeCompanyProfileId) ||
      companyProfiles.find((p) => p.isDefault) ||
      companyProfiles[0],
    [companyProfiles, settings?.activeCompanyProfileId]
  );

  const useCompanyTheme = activeProfile?.applyThemeToApp !== false;
  const themePrimary = useCompanyTheme ? activeProfile?.primaryColor || '#FF33CC' : '#1D4ED8';
  const themeAccent = useCompanyTheme ? activeProfile?.accentColor || '#6B2FA0' : '#1D4ED8';

  useEffect(() => {
    if (uiMode === 'simple' && ADVANCED_ONLY_ROUTES.has(location.pathname)) {
      navigate('/', { replace: true });
    }
  }, [uiMode, location.pathname, navigate]);

  const visibleNavItems = useMemo(() => {
    if (uiMode === 'avance') return MAIN_NAV_ITEMS;
    const itemMap = new Map(MAIN_NAV_ITEMS.map((item) => [item.to, item]));
    return SIMPLE_NAV_ORDER.map((path) => itemMap.get(path)).filter((x): x is NavItem => Boolean(x));
  }, [uiMode]);

  const handleToggleUiMode = async (targetMode: 'simple' | 'avance') => {
    if (!settings || uiMode === targetMode) return;
    await db.settings.update('company_settings', {
      uiMode: targetMode,
      updatedAt: new Date().toISOString(),
    });
    await recordAudit({
      action: 'MODIFICATION',
      entityType: 'parametres',
      entityId: 'uiMode',
      summary: `Basculement vers le mode ${targetMode === 'simple' ? 'Simple' : 'Avancé'}`,
    });
    if (targetMode === 'simple' && ADVANCED_ONLY_ROUTES.has(location.pathname)) {
      navigate('/', { replace: true });
    }
    pushToast({
      type: 'info',
      title: targetMode === 'simple' ? 'Mode Simple activé' : 'Mode Avancé activé',
      message:
        targetMode === 'simple'
          ? 'Affichage épuré pour les opérations courantes.'
          : 'Toutes les options fiscales, multi-devises et journaux sont affichés.',
    });
  };

  const handleSwitchCompany = async (profileId: string) => {
    if (!profileId || profileId === activeProfile?.id) return;
    await setActiveCompanyProfile(profileId);
    const target = companyProfiles.find((p) => p.id === profileId);
    pushToast({
      type: 'success',
      title: 'Société active changée',
      message: target?.name || '',
    });
  };

  const handleScopeChange = async (nextScope: 'active' | 'all') => {
    if (scopeFilter === nextScope) return;
    await db.settings.update('company_settings', {
      companyScopeFilter: nextScope,
      updatedAt: new Date().toISOString(),
    });
  };

  return (
    <div className="flex min-h-screen min-w-[1100px] bg-slate-50 text-slate-900 print:block print:min-w-0 print:bg-white">
      {/* Barre latérale */}
      <aside
        className="no-print flex w-64 shrink-0 flex-col bg-[#0F1E36] text-slate-100"
        style={
          useCompanyTheme
            ? { borderRight: `3px solid ${themePrimary}` }
            : undefined
        }
      >
        {/* Identité logicielle et sélecteur de société active */}
        <div className="border-b border-slate-800/80 px-4 py-3.5 space-y-2.5">
          <div className="flex items-center gap-3">
            {activeProfile?.logoDataUrl || settings?.logoDataUrl ? (
              <img
                src={activeProfile?.logoDataUrl || settings?.logoDataUrl}
                alt={activeProfile?.name || settings?.companyName || 'Logo entreprise'}
                className="h-9 w-11 shrink-0 rounded bg-white object-contain p-0.5"
              />
            ) : (
              <div className="flex h-9 w-11 shrink-0 items-center justify-center rounded bg-slate-800 text-slate-200">
                <Building2 className="h-5 w-5" />
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-white">
                Gestion Financière
              </div>
              <div className="flex items-center gap-1.5 truncate text-[11px] text-slate-300">
                <span
                  className="inline-block h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: themePrimary }}
                />
                <span className="truncate">
                  {activeProfile?.name || settings?.companyName || 'Entreprise non configurée'}
                </span>
              </div>
            </div>
          </div>

          {companyProfiles.length > 0 && (
            <div className="space-y-1.5">
              <select
                aria-label="Société active"
                value={activeProfile?.id || ''}
                onChange={(e) => handleSwitchCompany(e.target.value)}
                className="w-full rounded border border-slate-700 bg-slate-900/90 px-2.5 py-1.5 text-xs font-medium text-white focus:outline-none"
                style={useCompanyTheme ? { borderColor: themeAccent } : undefined}
              >
                {companyProfiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>

              <div className="grid grid-cols-2 gap-1 rounded bg-slate-900/70 p-0.5 text-[10px]">
                <button
                  type="button"
                  onClick={() => handleScopeChange('active')}
                  className={`rounded px-1.5 py-1 font-medium transition-colors truncate ${
                    scopeFilter === 'active'
                      ? 'text-white shadow-xs'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                  style={
                    scopeFilter === 'active'
                      ? { backgroundColor: themeAccent }
                      : undefined
                  }
                >
                  Société active
                </button>
                <button
                  type="button"
                  onClick={() => handleScopeChange('all')}
                  className={`rounded px-1.5 py-1 font-medium transition-colors truncate ${
                    scopeFilter === 'all'
                      ? 'text-white shadow-xs'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                  style={
                    scopeFilter === 'all'
                      ? { backgroundColor: themeAccent }
                      : undefined
                  }
                >
                  Toutes les sociétés
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Navigation principale filtrée selon Mode simple / Mode avancé */}
        <nav className="flex-1 overflow-y-auto px-3 py-3" aria-label="Menu principal">
          <ul className="space-y-0.5">
            {visibleNavItems.map((item) => {
              const Icon = item.icon;
              return (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.to === '/'}
                    style={({ isActive }) =>
                      isActive
                        ? {
                            backgroundColor: themeAccent,
                            boxShadow: useCompanyTheme
                              ? `inset 3px 0 0 ${themePrimary}`
                              : undefined,
                          }
                        : undefined
                    }
                    className={({ isActive }) =>
                      `flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors whitespace-nowrap shrink-0 ${
                        isActive
                          ? 'text-white'
                          : 'text-slate-200 hover:bg-slate-800/70 hover:text-white'
                      }`
                    }
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className="truncate">{item.label}</span>
                  </NavLink>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* Liens utilitaires bas de barre */}
        <div className="border-t border-slate-800/80 px-3 py-3">
          <ul className="space-y-0.5">
            <li>
              <NavLink
                to="/aide"
                style={({ isActive }) =>
                  isActive ? { backgroundColor: themeAccent } : undefined
                }
                className={({ isActive }) =>
                  `flex items-center gap-3 rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                    isActive
                      ? 'text-white'
                      : 'text-slate-300 hover:bg-slate-800/70 hover:text-white'
                  }`
                }
              >
                <HelpCircle className="h-4 w-4 shrink-0" />
                <span>Aide</span>
              </NavLink>
            </li>
            <li>
              <NavLink
                to="/a-propos"
                style={({ isActive }) =>
                  isActive ? { backgroundColor: themeAccent } : undefined
                }
                className={({ isActive }) =>
                  `flex items-center gap-3 rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                    isActive
                      ? 'text-white'
                      : 'text-slate-300 hover:bg-slate-800/70 hover:text-white'
                  }`
                }
              >
                <Info className="h-4 w-4 shrink-0" />
                <span>À propos</span>
              </NavLink>
            </li>
          </ul>
        </div>
      </aside>

      {/* Zone de contenu principale */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Barre supérieure */}
        <header
          className="no-print flex h-14 shrink-0 items-center justify-between gap-6 border-b border-slate-200 bg-white px-6"
          style={
            useCompanyTheme
              ? { borderTop: `3px solid ${themeAccent}` }
              : undefined
          }
        >
          <div className="flex items-center gap-3 min-w-0">
            <h1 className="truncate text-lg font-semibold text-slate-900">{currentTitle}</h1>
            {activeProfile && (
              <span
                className="hidden sm:inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-[11px] font-semibold shrink-0"
                style={{
                  borderColor: `${themeAccent}55`,
                  backgroundColor: `${themePrimary}12`,
                  color: themeAccent,
                }}
              >
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ backgroundColor: themePrimary }}
                />
                <span>{activeProfile.name}</span>
              </span>
            )}
          </div>

          {uiMode === 'avance' ? (
            <div className="flex items-center gap-4 text-xs text-slate-500 whitespace-nowrap shrink-0">
              <span>Devise : {settings?.defaultCurrency || 'DZD'}</span>
              <span aria-hidden="true">·</span>
              <span>TVA par défaut : {settings?.defaultTvaRate ?? 19} %</span>
            </div>
          ) : (
            <div className="text-xs text-slate-400 whitespace-nowrap shrink-0">
              {scopeFilter === 'active'
                ? `Filtre : ${activeProfile?.name || 'Société active'}`
                : 'Affichage toutes sociétés'}
            </div>
          )}

          <div className="flex items-center gap-2 rounded-md bg-slate-100 p-1 shrink-0">
            <button
              type="button"
              onClick={() => handleToggleUiMode('simple')}
              className={`rounded px-3 py-1 text-xs font-medium transition-colors whitespace-nowrap ${
                uiMode === 'simple'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Mode simple
            </button>
            <button
              type="button"
              onClick={() => handleToggleUiMode('avance')}
              className={`rounded px-3 py-1 text-xs font-medium transition-colors whitespace-nowrap ${
                uiMode === 'avance'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Mode avancé
            </button>
          </div>
        </header>

        {/* Alerte d'échec de sauvegarde automatique */}
        {backupWarning && (
          <div className="no-print flex items-center justify-between gap-4 border-b border-red-200 bg-red-50 px-6 py-2.5 text-sm text-red-800">
            <div className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4 shrink-0 text-red-600" />
              <span>{backupWarning}</span>
            </div>
            <button
              type="button"
              onClick={() => setBackupWarning(null)}
              className="rounded p-1 text-red-600 hover:bg-red-100"
              aria-label="Fermer l’avertissement"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* Contenu de la page */}
        <main className="flex-1 overflow-y-auto p-6 print:overflow-visible print:p-0">
          <Outlet />
        </main>

        {/* Pied de page permanent */}
        <footer className="no-print flex shrink-0 items-center justify-between border-t border-slate-200 bg-white px-6 py-2.5 text-xs text-slate-500">
          <div className="flex items-center gap-2">
            <span className="font-medium text-slate-700">{APP_NAME}</span>
            <span aria-hidden="true">·</span>
            <span>Version {APP_VERSION}</span>
            <span aria-hidden="true">·</span>
            <span>{DEVELOPER_BRAND}</span>
          </div>
          <div className="flex items-center gap-3">
            <span>Outil de gestion financière hors-ligne (non certifié comptable)</span>
            <span aria-hidden="true">·</span>
            <NavLink to="/aide" className="inline-flex items-center gap-1 hover:text-slate-800">
              <BookOpen className="h-3.5 w-3.5" />
              <span>Aide</span>
            </NavLink>
          </div>
        </footer>
      </div>
    </div>
  );
};
