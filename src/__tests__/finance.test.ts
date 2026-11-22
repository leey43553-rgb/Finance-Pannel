import { describe, expect, it } from 'vitest';
import type { LedgerEntry, Payment, PaymentAllocation } from '../db/types';
import { findDuplicateChequeNumbers, generateChequeSerialSequence } from '../utils/cheque';
import {
  computeContactAccountSummary,
  computeInvoiceDocumentTotals,
  computeInvoicePaidCentimes,
  computeInvoiceRemainingCentimes,
  computeInvoiceStatus,
  computeLedgerTotals,
  computePaymentUnallocatedCentimes,
  shouldCreateImmediateLedgerEntryForExpense,
} from '../utils/finance';
import {
  computeInvoiceLineTotals,
  formatMoney,
  parseMoneyInputToCentimes,
} from '../utils/money';

describe('Règles monétaires en centimes et formatage fr-DZ', () => {
  it('formate les centimes entiers sans flottants au format algérien', () => {
    expect(formatMoney(123456750, 'DZD')).toBe('1 234 567,50 DA');
    expect(formatMoney(0, 'DZD')).toBe('0,00 DA');
    expect(formatMoney(-50025, 'EUR')).toBe('-500,25 €');
  });

  it('parse proprement les saisies utilisateur avec virgule ou point et arrondi demi-supérieur', () => {
    expect(parseMoneyInputToCentimes('100 000,00')).toBe(10000000);
    expect(parseMoneyInputToCentimes('1234.565')).toBe(123457);
    expect(parseMoneyInputToCentimes('1234.564')).toBe(123456);
  });
});

describe('TVA et totaux de factures', () => {
  it('calcule exactement HT 100 000,00 -> TVA 19 000,00 -> TTC 119 000,00', () => {
    const line = computeInvoiceLineTotals({
      quantity: 1,
      unitPriceCentimes: 10000000,
      discountPercent: 0,
      tvaRate: 19,
    });
    expect(line.htCentimes).toBe(10000000);
    expect(line.tvaCentimes).toBe(1900000);
    expect(line.ttcCentimes).toBe(11900000);
    expect(formatMoney(line.htCentimes)).toBe('100 000,00 DA');
    expect(formatMoney(line.tvaCentimes)).toBe('19 000,00 DA');
    expect(formatMoney(line.ttcCentimes)).toBe('119 000,00 DA');
  });

  it('calcule une facture multi-lignes avec remise et taux de TVA différents', () => {
    const doc = computeInvoiceDocumentTotals([
      {
        quantity: 2,
        unitPriceCentimes: 5000000, // 50 000 DA
        discountPercent: 10, // -10% -> 90 000 DA HT
        tvaRate: 19, // 17 100 DA TVA
      },
      {
        quantity: 1,
        unitPriceCentimes: 1000000, // 10 000 DA HT
        discountPercent: 0,
        tvaRate: 9, // 900 DA TVA
      },
    ]);
    expect(doc.totalHtCentimes).toBe(10000000);
    expect(doc.totalTvaCentimes).toBe(1800000);
    expect(doc.totalTtcCentimes).toBe(11800000);
  });
});

describe('Paiements partiels, ventilation multi-factures, avances et solde client', () => {
  const payments: Payment[] = [
    {
      id: 'p1',
      direction: 'entrant',
      contactId: 'c1',
      date: '2026-10-10',
      amountCentimes: 15000000, // 150 000 DA
      currency: 'DZD',
      exchangeRate: 1,
      baseDzdAmountCentimes: 15000000,
      method: 'virement',
      bankAccountId: 'b1',
      reference: 'VIR-1',
      notes: '',
      isAdvance: false,
      status: 'valide',
      createdAt: '2026-10-10T10:00:00Z',
      updatedAt: '2026-10-10T10:00:00Z',
    },
    {
      id: 'p2',
      direction: 'entrant',
      contactId: 'c1',
      date: '2026-10-20',
      amountCentimes: 5000000, // 50 000 DA (avance pure)
      currency: 'DZD',
      exchangeRate: 1,
      baseDzdAmountCentimes: 5000000,
      method: 'especes',
      bankAccountId: null,
      reference: 'AV-1',
      notes: '',
      isAdvance: true,
      status: 'valide',
      createdAt: '2026-10-20T10:00:00Z',
      updatedAt: '2026-10-20T10:00:00Z',
    },
  ];

  // p1 (150 000 DA) réparti sur inv1 (119 000 DA intégral) et inv2 (31 000 DA partiel sur 100 000 DA)
  const allocations: PaymentAllocation[] = [
    {
      id: 'a1',
      paymentId: 'p1',
      invoiceType: 'client',
      invoiceId: 'inv1',
      amountCentimes: 11900000,
      createdAt: '2026-10-10T10:00:00Z',
    },
    {
      id: 'a2',
      paymentId: 'p1',
      invoiceType: 'client',
      invoiceId: 'inv2',
      amountCentimes: 3100000,
      createdAt: '2026-10-10T10:00:00Z',
    },
  ];

  it('calcule le montant payé, le reste dû et le statut automatique des factures', () => {
    const validIds = new Set(['p1', 'p2']);
    const paid1 = computeInvoicePaidCentimes('inv1', allocations, validIds);
    const paid2 = computeInvoicePaidCentimes('inv2', allocations, validIds);

    expect(paid1).toBe(11900000);
    expect(computeInvoiceRemainingCentimes(11900000, paid1, 'impayee')).toBe(0);
    expect(
      computeInvoiceStatus({
        storedStatus: 'impayee',
        totalTtcCentimes: 11900000,
        paidCentimes: paid1,
        dueDate: '2026-10-01',
        referenceDate: '2026-11-15',
      })
    ).toBe('payee');

    expect(paid2).toBe(3100000);
    expect(computeInvoiceRemainingCentimes(10000000, paid2, 'impayee')).toBe(6900000);
    expect(
      computeInvoiceStatus({
        storedStatus: 'impayee',
        totalTtcCentimes: 10000000,
        paidCentimes: paid2,
        dueDate: '2026-12-30',
        referenceDate: '2026-11-15',
      })
    ).toBe('partielle');

    expect(
      computeInvoiceStatus({
        storedStatus: 'impayee',
        totalTtcCentimes: 10000000,
        paidCentimes: paid2,
        dueDate: '2026-11-01',
        referenceDate: '2026-11-15',
      })
    ).toBe('en_retard');
  });

  it('calcule correctement le solde non alloué (avance) et le relevé client complet', () => {
    expect(computePaymentUnallocatedCentimes(payments[0], allocations)).toBe(0);
    expect(computePaymentUnallocatedCentimes(payments[1], allocations)).toBe(5000000);

    const summary = computeContactAccountSummary({
      contactId: 'c1',
      direction: 'client',
      invoices: [
        {
          id: 'inv1',
          contactId: 'c1',
          totalTtcCentimes: 11900000,
          baseDzdTtcCentimes: 11900000,
          status: 'payee',
        },
        {
          id: 'inv2',
          contactId: 'c1',
          totalTtcCentimes: 10000000,
          baseDzdTtcCentimes: 10000000,
          status: 'partielle',
        },
      ],
      payments,
      allocations,
    });

    expect(summary.totalInvoicedBaseDzd).toBe(21900000);
    expect(summary.totalAllocatedToInvoicesBaseDzd).toBe(15000000);
    expect(summary.totalUnpaidBaseDzd).toBe(6900000);
    expect(summary.totalPaymentsReceivedBaseDzd).toBe(20000000);
    expect(summary.availableAdvanceBaseDzd).toBe(5000000);
  });
});

describe('Chéquiers : zéros initiaux et unicité par banque', () => {
  it('génère un carnet entier en conservant les zéros initiaux', () => {
    const serials = generateChequeSerialSequence('0012345', 25);
    expect(serials).toHaveLength(25);
    expect(serials[0]).toBe('0012345');
    expect(serials[24]).toBe('0012369');
  });

  it('détecte les numéros déjà utilisés sur la même banque même après annulation', () => {
    const duplicates = findDuplicateChequeNumbers(['0012345', '0012350'], ['0012349', '0012350', '0012351']);
    expect(duplicates).toEqual(['0012350']);
  });
});

describe('Absence de double comptage entre dépense, chèque et grand livre', () => {
  it('empêche une dépense payée par chèque de générer une écriture immédiate dans le grand livre', () => {
    expect(shouldCreateImmediateLedgerEntryForExpense('especes')).toBe(true);
    expect(shouldCreateImmediateLedgerEntryForExpense('virement')).toBe(true);
    expect(shouldCreateImmediateLedgerEntryForExpense('carte')).toBe(true);
    expect(shouldCreateImmediateLedgerEntryForExpense('cheque')).toBe(false);
  });

  it('additionne uniquement les mouvements valides du grand livre', () => {
    const entries: LedgerEntry[] = [
      {
        id: 'l1',
        date: '2026-11-01',
        direction: 'entree',
        sourceType: 'solde_ouverture',
        sourceId: 'open',
        bankAccountId: 'b1',
        label: 'Ouverture',
        amountCentimes: 50000000,
        currency: 'DZD',
        exchangeRate: 1,
        baseDzdAmountCentimes: 50000000,
        status: 'valide',
        createdAt: '2026-11-01T00:00:00Z',
      },
      {
        id: 'l2',
        date: '2026-11-02',
        direction: 'sortie',
        sourceType: 'cheque_emis_encaisse',
        sourceId: 'chq1',
        bankAccountId: 'b1',
        label: 'Loyer par chèque encaissé',
        amountCentimes: 12000000,
        currency: 'DZD',
        exchangeRate: 1,
        baseDzdAmountCentimes: 12000000,
        status: 'valide',
        createdAt: '2026-11-02T00:00:00Z',
      },
      {
        id: 'l3',
        date: '2026-11-03',
        direction: 'sortie',
        sourceType: 'depense',
        sourceId: 'exp_cancelled',
        bankAccountId: null,
        label: 'Annulée',
        amountCentimes: 5000000,
        currency: 'DZD',
        exchangeRate: 1,
        baseDzdAmountCentimes: 5000000,
        status: 'annule',
        createdAt: '2026-11-03T00:00:00Z',
      },
    ];

    const totals = computeLedgerTotals(entries);
    expect(totals.totalInflowsBaseDzd).toBe(50000000);
    expect(totals.totalOutflowsBaseDzd).toBe(12000000);
    expect(totals.netBalanceBaseDzd).toBe(38000000);
  });
});

import * as XLSX from 'xlsx';
import {
  autoDetectColumnMapping,
  normalizeImportedDate,
  parseExcelBuffer,
  validateImportRows,
} from '../services/excelService';

describe('Import Excel : détection en-têtes français, zéros initiaux et doublons', () => {
  it('détecte automatiquement les colonnes françaises des factures et chèques', () => {
    const invMap = autoDetectColumnMapping('factures_clients', [
      'Date',
      'N° Facture',
      'N° BC',
      'Campagne',
      'Client',
      'Montant HT',
      'TVA',
      'TTC',
    ]);
    expect(invMap.issueDate).toBe('Date');
    expect(invMap.invoiceNumber).toBe('N° Facture');
    expect(invMap.bcNumber).toBe('N° BC');
    expect(invMap.campaignRef).toBe('Campagne');
    expect(invMap.clientName).toBe('Client');
    expect(invMap.htAmount).toBe('Montant HT');
    expect(invMap.tvaAmount).toBe('TVA');
    expect(invMap.ttcAmount).toBe('TTC');

    const chqMap = autoDetectColumnMapping('cheques_emis', [
      'Banque',
      'N° chèque',
      'Bénéficiaire',
      'Date de sortie',
      'Montant',
      'Objet',
    ]);
    expect(chqMap.bankName).toBe('Banque');
    expect(chqMap.chequeNumber).toBe('N° chèque');
    expect(chqMap.beneficiary).toBe('Bénéficiaire');
    expect(chqMap.issueDate).toBe('Date de sortie');
    expect(chqMap.amount).toBe('Montant');
    expect(chqMap.purpose).toBe('Objet');
  });

  it('préserve les zéros initiaux des numéros de chèques à la lecture Excel', async () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['Banque', 'N° Chèque', 'Bénéficiaire', 'Date de sortie', 'Montant', 'Objet'],
      ['BNA', '0012345', 'SARL Test', '15/11/2026', '50 000,00', 'Loyer'],
    ]);
    ws['B2'] = { t: 's', v: '0012345', z: '@' };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Chèques');
    const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;

    const parsed = await parseExcelBuffer(out);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]['N° Chèque']).toBe('0012345');
    expect(normalizeImportedDate(parsed.rows[0]['Date de sortie'])).toBe('2026-11-15');
  });

  it('bloque les doublons de chèques émis sur une même banque et signale les erreurs', () => {
    const validated = validateImportRows({
      type: 'cheques_emis',
      rows: [
        {
          Banque: 'BNA',
          'N° Chèque': '0012345',
          Bénéficiaire: 'Fournisseur A',
          'Date de sortie': '2026-11-15',
          Montant: '25000,00',
          Objet: 'Achat',
        },
        {
          Banque: 'BNA',
          'N° Chèque': '0012399',
          Bénéficiaire: 'Fournisseur B',
          'Date de sortie': '2026-11-15',
          Montant: '30000,00',
          Objet: 'Transport',
        },
        {
          Banque: 'BNA',
          'N° Chèque': '0012399',
          Bénéficiaire: 'Fournisseur B bis',
          'Date de sortie': '2026-11-16',
          Montant: '10000,00',
          Objet: 'Doublon fichier',
        },
      ],
      mapping: {
        bankName: 'Banque',
        chequeNumber: 'N° Chèque',
        beneficiary: 'Bénéficiaire',
        issueDate: 'Date de sortie',
        amount: 'Montant',
        purpose: 'Objet',
      },
      ctx: {
        contacts: [],
        customerInvoices: [],
        supplierInvoices: [],
        expenses: [],
        incomingCheques: [],
        outgoingCheques: [],
        chequeLeafKeys: new Set(['bank_bna::0012345']),
        bankAccounts: [{ id: 'bank_bna', bankName: 'BNA', accountName: 'Compte principal' }],
        defaultTvaRate: 19,
        defaultCurrency: 'DZD',
      },
    });

    expect(validated[0].status).toBe('doublon');
    expect(validated[1].status).toBe('valide');
    expect(validated[2].status).toBe('doublon');
  });
});

import { amountCentimesToFrenchWords } from '../utils/numberToFrenchWords';
import {
  compareDocumentNumbers,
  computeBcRecuInvoicingStatus,
  computeCampaignDuration,
  computeNextSequenceNumber,
  getEffectiveProformaStatus,
  suggestCampaignStatus,
} from '../utils/documentHelpers';
import type { CustomerInvoice, PurchaseOrder } from '../db/types';

describe('Étape 5 : Montant en lettres, numérotation intelligente, campagnes, proformas et BC reçus', () => {
  it('convertit les montants en centimes en lettres françaises', () => {
    expect(amountCentimesToFrenchWords(0, 'DZD')).toBe('zéro Dinar Algérien');
    expect(amountCentimesToFrenchWords(123456750, 'DZD')).toBe(
      'un million deux cent trente-quatre mille cinq cent soixante-sept Dinars Algériens et cinquante centimes'
    );
    expect(amountCentimesToFrenchWords(62475000, 'DZD')).toBe(
      'six cent vingt-quatre mille sept cent cinquante Dinars Algériens'
    );
  });

  it('calcule les numéros séquentiels intelligents sans jamais réutiliser un numéro et réinitialise au changement d’année', () => {
    const existing = [
      { number: '078/26', date: '2026-10-01', companyProfileId: 'soc1' },
      { number: '079/26', date: '2026-10-15', companyProfileId: 'soc1' },
      { number: '005/26', date: '2026-10-20', companyProfileId: 'soc2' },
    ];
    expect(
      computeNextSequenceNumber({
        kind: 'facture_client',
        existingNumbers: existing,
        yearFull: 2026,
        companyProfileId: 'soc1',
      })
    ).toBe('080/26');
    expect(
      computeNextSequenceNumber({
        kind: 'facture_client',
        existingNumbers: existing,
        yearFull: 2027,
        companyProfileId: 'soc1',
      })
    ).toBe('001/27');
    expect(
      computeNextSequenceNumber({
        kind: 'proforma',
        existingNumbers: [{ number: 'PF N°011/26', date: '2026-11-01', companyProfileId: 'soc1' }],
        yearFull: 2026,
        companyProfileId: 'soc1',
      })
    ).toBe('PF N°012/26');
    expect(compareDocumentNumbers('078/26', '079/26')).toBeLessThan(0);
    expect(compareDocumentNumbers('150/26', '001/27')).toBeLessThan(0);
  });

  it('calcule la durée et le statut suggéré d’une campagne', () => {
    const dur = computeCampaignDuration('2026-07-05', '2026-09-05');
    expect(dur.valid).toBe(true);
    expect(dur.label).toBe('2 mois');
    expect(suggestCampaignStatus('2026-07-05', '2026-09-05', '2026-06-01')).toBe('prevue');
    expect(suggestCampaignStatus('2026-07-05', '2026-09-05', '2026-08-01')).toBe('en_cours');
    expect(suggestCampaignStatus('2026-07-05', '2026-09-05', '2026-10-01')).toBe('terminee');
  });

  it('détecte l’expiration des proformas et la facturation partielle/totale des BC reçus', () => {
    expect(
      getEffectiveProformaStatus({ status: 'envoye', validUntil: '2026-10-01' }, '2026-10-15')
    ).toBe('expire');
    expect(
      getEffectiveProformaStatus(
        { status: 'envoye', validUntil: '2026-10-01', convertedInvoiceId: 'inv1' },
        '2026-10-15'
      )
    ).toBe('facture');

    const bc = {
      id: 'bc1',
      direction: 'bc_recu',
      poNumber: 'BC-100',
      contactId: 'c1',
      issueDate: '2026-10-01',
      totalHtCentimes: 10000000,
      totalTvaCentimes: 1900000,
      totalTtcCentimes: 11900000,
      currency: 'DZD',
      exchangeRate: 1,
      status: 'recu',
      lines: [],
      notes: '',
      createdAt: '',
      updatedAt: '',
    } as unknown as PurchaseOrder;

    expect(computeBcRecuInvoicingStatus({ bc, linkedInvoices: [] })).toBe('recu');
    expect(
      computeBcRecuInvoicingStatus({
        bc,
        linkedInvoices: [{ totalTtcCentimes: 5000000, status: 'impayee' } as CustomerInvoice],
      })
    ).toBe('partiellement_facture');
    expect(
      computeBcRecuInvoicingStatus({
        bc,
        linkedInvoices: [{ totalTtcCentimes: 11900000, status: 'payee' } as CustomerInvoice],
      })
    ).toBe('facture');
  });
});

import {
  computeGuidedLineValues,
  computeSurfaceM2,
  generateGuidedLineDescription,
  parsePanelDimensionsFromLabel,
} from '../utils/guidedLineHelpers';

describe('Étape 6 : Saisie guidée publicité extérieure, surfaces et montant HT verrouillé', () => {
  it('extrait les dimensions depuis un libellé de panneau et calcule la surface en m²', () => {
    expect(parsePanelDimensionsFromLabel('Unipol 12×4 m')).toEqual({ widthM: 12, heightM: 4 });
    expect(parsePanelDimensionsFromLabel('Sucette MUPI 1,2×1,8 m')).toEqual({
      widthM: 1.2,
      heightM: 1.8,
    });
    expect(computeSurfaceM2(4, 3)).toBe(12);
    expect(computeSurfaceM2(1.2, 1.8)).toBe(2.16);
  });

  it('calcule les montants en centimes entiers selon le mode de tarification (mois, m², jour)', () => {
    const monthly = computeGuidedLineValues({
      panelCount: 2,
      durationValue: 2,
      durationUnit: 'mois',
      pricingUnit: 'mois',
      unitPriceCentimes: 15000000, // 150 000 DA / mois
      discountPercent: 0,
      tvaRate: 19,
    });
    expect(monthly.quantity).toBe(4);
    expect(monthly.unit).toBe('mois');
    expect(monthly.htCentimes).toBe(60000000);
    expect(monthly.tvaCentimes).toBe(11400000);
    expect(monthly.ttcCentimes).toBe(71400000);

    const perSqm = computeGuidedLineValues({
      widthM: 4,
      heightM: 3,
      panelCount: 2,
      pricingUnit: 'm2',
      unitPriceCentimes: 250000, // 2 500 DA / m²
      discountPercent: 0,
      tvaRate: 19,
    });
    expect(perSqm.surfaceM2).toBe(12);
    expect(perSqm.quantity).toBe(24);
    expect(perSqm.unit).toBe('m²');
    expect(perSqm.htCentimes).toBe(6000000);

    const dailyLed = computeGuidedLineValues({
      panelCount: 1,
      durationValue: 15,
      durationUnit: 'jours',
      pricingUnit: 'jour',
      unitPriceCentimes: 2000000, // 20 000 DA / jour
      discountPercent: 0,
      tvaRate: 19,
    });
    expect(dailyLed.quantity).toBe(15);
    expect(dailyLed.unit).toBe('jour');
    expect(dailyLed.htCentimes).toBe(30000000);
  });

  it('préserve un montant HT verrouillé manuellement et recalcule TVA/TTC sans dérive', () => {
    const doc = computeInvoiceDocumentTotals([
      {
        description: 'Campagne forfaitaire négociée',
        quantity: 4,
        unit: 'mois',
        unitPriceCentimes: 15000000, // 600 000 DA théorique
        discountPercent: 0,
        tvaRate: 19,
        manualTotalLocked: true,
        htCentimes: 48000000, // 480 000 DA négocié
      },
    ]);
    expect(doc.totalHtCentimes).toBe(48000000);
    expect(doc.totalTvaCentimes).toBe(9120000);
    expect(doc.totalTtcCentimes).toBe(57120000);
  });

  it('génère une désignation multi-lignes claire en français', () => {
    const desc = generateGuidedLineDescription({
      serviceType: 'Location panneau publicitaire',
      panelType: 'Unipol 12×4 m',
      location: 'Alger Centre',
      face: 'Face A',
      widthM: 12,
      heightM: 4,
      panelCount: 2,
      durationValue: 2,
      durationUnit: 'mois',
      pricingUnit: 'mois',
    });
    expect(desc).toContain('Location panneau publicitaire — Unipol 12×4 m — Alger Centre (Face A)');
    expect(desc).toContain('Format : 12 × 4 m (48 m²)');
    expect(desc).toContain('Quantité : 2 unités');
    expect(desc).toContain('Durée : 2 mois');
  });
});

import { resolveInvoiceRowAmounts } from '../services/excelService';

describe('Étape 7 : Import Excel avancé des factures clients (multi-feuilles, regroupement, Qté×PU / TTC)', () => {
  it('lit n’importe quelle feuille nommée dans un classeur Excel multi-feuilles', async () => {
    const wb = XLSX.utils.book_new();
    const ws1 = XLSX.utils.aoa_to_sheet([
      ['N° Facture', 'Client', 'Date', 'Montant HT'],
      ['001/26', 'Client 1', '2026-10-01', '50000,00'],
    ]);
    const ws2 = XLSX.utils.aoa_to_sheet([
      ['N° Facture', 'Client', 'Date', 'Montant HT'],
      ['015/26', 'Client 2', '2026-11-01', '120000,00'],
    ]);
    XLSX.utils.book_append_sheet(wb, ws1, 'Octobre');
    XLSX.utils.book_append_sheet(wb, ws2, 'Novembre');
    const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;

    const first = await parseExcelBuffer(out);
    expect(first.sheetNames).toEqual(['Octobre', 'Novembre']);
    expect(first.sheetName).toBe('Octobre');
    expect(first.rows[0]['N° Facture']).toBe('001/26');

    const second = await parseExcelBuffer(out, 'Novembre');
    expect(second.sheetName).toBe('Novembre');
    expect(second.rows[0]['N° Facture']).toBe('015/26');
  });

  it('détecte les colonnes françaises étendues et calcule HT depuis Qté×PU ou depuis TTC', () => {
    const map = autoDetectColumnMapping('factures_clients', [
      'N° Facture',
      'Client',
      'Date',
      'Qté',
      'Unité',
      'P.U. HT',
      'Début campagne',
      'Fin campagne',
      'Statut',
    ]);
    expect(map.quantity).toBe('Qté');
    expect(map.unit).toBe('Unité');
    expect(map.unitPrice).toBe('P.U. HT');
    expect(map.campaignStartDate).toBe('Début campagne');
    expect(map.campaignEndDate).toBe('Fin campagne');
    expect(map.status).toBe('Statut');

    const fromQtyPu = resolveInvoiceRowAmounts(
      { quantity: '3', unit: 'mois', unitPrice: '150 000,00', tvaRate: '19' },
      19
    );
    expect(fromQtyPu.valid).toBe(true);
    expect(fromQtyPu.htCentimes).toBe(45000000);
    expect(fromQtyPu.unit).toBe('mois');

    const fromTtc = resolveInvoiceRowAmounts({ ttcAmount: '119 000,00', tvaRate: '19' }, 19);
    expect(fromTtc.valid).toBe(true);
    expect(fromTtc.htCentimes).toBe(10000000);
  });

  it('regroupe plusieurs lignes ayant le même N° Facture sans les bloquer comme doublons, tout en bloquant celles déjà en base', () => {
    const existingInv = {
      id: 'inv_old',
      invoiceNumber: '001/26',
    } as CustomerInvoice;

    const validated = validateImportRows({
      type: 'factures_clients',
      rows: [
        {
          'N° Facture': '002/26',
          Client: 'Cevital',
          Date: '2026-11-10',
          Description: 'Panneau 12x4 Alger',
          Qté: '2',
          'P.U. HT': '100000,00',
        },
        {
          'N° Facture': '002/26',
          Client: '',
          Date: '',
          Description: 'Impression bâche',
          Qté: '1',
          'P.U. HT': '45000,00',
        },
        {
          'N° Facture': '001/26',
          Client: 'Cevital',
          Date: '2026-11-11',
          Description: 'Déjà importée',
          Qté: '1',
          'P.U. HT': '50000,00',
        },
      ],
      mapping: {
        invoiceNumber: 'N° Facture',
        clientName: 'Client',
        issueDate: 'Date',
        description: 'Description',
        quantity: 'Qté',
        unitPrice: 'P.U. HT',
      },
      options: { groupInvoicesByNumber: true },
      ctx: {
        contacts: [],
        customerInvoices: [existingInv],
        supplierInvoices: [],
        expenses: [],
        incomingCheques: [],
        outgoingCheques: [],
        chequeLeafKeys: new Set<string>(),
        bankAccounts: [],
        defaultTvaRate: 19,
        defaultCurrency: 'DZD',
      },
    });

    expect(validated[0].status).toBe('valide');
    expect(validated[1].status).toBe('valide');
    expect(validated[1].mapped.clientName).toBe('Cevital');
    expect(validated[1].message).toContain('002/26');
    expect(validated[2].status).toBe('doublon');
  });
});

import {
  buildPdfFileName,
  computePdfPageSlices,
  printCurrentViewAsPdf,
  triggerBrowserPrint,
} from '../utils/print';

describe('Correctif PDF A4 (Étape 1) : Noms de fichiers, découpage multi-pages et impression iframe/Electron', () => {
  it('construit un nom de fichier PDF propre sans caractères interdits', () => {
    expect(buildPdfFileName('facture', '078/26', 'SARL STAR ADVERTISING')).toBe(
      'Facture_078-26_SARL-STAR-ADVERTISING.pdf'
    );
    expect(buildPdfFileName('proforma', 'PF N°012/26', 'Société Générale / Élan')).toBe(
      'Proforma_PF-N°012-26_Societe-Generale-Elan.pdf'
    );
  });

  it('découpe proprement un canvas long en pages A4 sans créer de dernière page quasi vide', () => {
    const onePage = computePdfPageSlices(1588, 2246, 210, 297);
    expect(onePage).toHaveLength(1);
    expect(onePage[0].yPx).toBe(0);

    const twoPages = computePdfPageSlices(1000, 2500, 210, 297);
    expect(twoPages).toHaveLength(2);
    expect(twoPages[0].yPx).toBe(0);
    expect(twoPages[0].heightPx).toBe(1414);
    expect(twoPages[1].yPx).toBe(1414);
    expect(twoPages[1].heightPx).toBe(1086);
  });

  it('détecte un blocage de window.print() dans une iframe sandboxée et retourne le message français attendu', () => {
    const originalWindow = (globalThis as { window?: unknown }).window;
    const listeners = new Map<string, Array<() => void>>();
    const mockWindow = {
      self: { id: 'child' },
      top: { id: 'parent' },
      print: () => {
        // Simule Chromium en iframe sandboxée : retour immédiat sans déclencher beforeprint
      },
      addEventListener: (ev: string, cb: () => void) => {
        const list = listeners.get(ev) || [];
        list.push(cb);
        listeners.set(ev, list);
      },
      removeEventListener: (ev: string, cb: () => void) => {
        const list = (listeners.get(ev) || []).filter((x) => x !== cb);
        listeners.set(ev, list);
      },
    };
    (globalThis as { window?: unknown }).window = mockWindow;
    try {
      const res = triggerBrowserPrint();
      expect(res.ok).toBe(false);
      expect(res.blockedByIframe).toBe(true);
      expect(res.error).toBe("Ouvrez l'application dans un onglet séparé pour imprimer");
    } finally {
      (globalThis as { window?: unknown }).window = originalWindow;
    }
  });

  it('utilise window.electronAPI.printToPDF dans Electron et remonte toute erreur sans échec silencieux', async () => {
    const originalWindow = (globalThis as { window?: unknown }).window;
    let calledOptions: Record<string, unknown> | undefined;
    (globalThis as { window?: unknown }).window = {
      electronAPI: {
        isElectron: true,
        printToPDF: async (opts: Record<string, unknown>) => {
          calledOptions = opts;
          return { ok: true, filePath: 'C:\\Users\\Demo\\Documents\\Facture_078-26_SARL-STAR-ADVERTISING.pdf' };
        },
      },
    };
    try {
      const okRes = await printCurrentViewAsPdf('Facture_078-26_SARL-STAR-ADVERTISING.pdf', {
        companyName: 'SARL VISTA DIGITAL',
        rawLayout: true,
      });
      expect(okRes.ok).toBe(true);
      expect(okRes.method).toBe('electron');
      expect(calledOptions?.defaultFileName).toBe('Facture_078-26_SARL-STAR-ADVERTISING.pdf');
      expect(calledOptions?.rawLayout).toBe(true);

      (globalThis as { window: { electronAPI: { printToPDF: () => Promise<unknown> } } }).window.electronAPI.printToPDF =
        async () => ({ ok: false, error: 'Disque plein' });
      const errRes = await printCurrentViewAsPdf('Facture_078-26_SARL-STAR-ADVERTISING.pdf');
      expect(errRes.ok).toBe(false);
      expect(errRes.error).toBe('Disque plein');
    } finally {
      (globalThis as { window?: unknown }).window = originalWindow;
    }
  });
});

import {
  buildDefaultGravurePubProfile,
  buildDefaultVistaDigitalProfile,
  COLOR_PRESETS,
  GRAVURE_PUB_PROFILE_ID,
  VISTA_DIGITAL_PROFILE_ID,
} from '../constants/companyPresets';
import {
  computeTemplatePageChunks,
  getEffectiveCampaignStatus,
  resolveEffectiveCompanyProfile,
} from '../utils/documentHelpers';
import { formatMoneyNumberOnly, formatQuantityFr } from '../utils/money';

describe('Deux sociétés (VISTA DIGITAL & GRAVURE PUB) et pagination modèle Excel A4', () => {
  it('fournit les profils par défaut VISTA DIGITAL (rose/violet) et GRAVURE PUB (orange/bleu)', () => {
    const vista = buildDefaultVistaDigitalProfile('2026-08-20T00:00:00Z');
    const gravure = buildDefaultGravurePubProfile('2026-08-20T00:00:00Z');

    expect(vista.id).toBe(VISTA_DIGITAL_PROFILE_ID);
    expect(vista.name).toBe('SARL VISTA DIGITAL');
    expect(vista.primaryColor).toBe('#FF33CC');
    expect(vista.accentColor).toBe('#6B2FA0');
    expect(vista.rc).toBe('16b1011397-00/16');
    expect(vista.nif).toBe('001616101139795');
    expect(vista.logoDataUrl.startsWith('data:image/svg+xml;base64,')).toBe(true);
    const decodedSvg = atob(vista.logoDataUrl.replace('data:image/svg+xml;base64,', ''));
    expect(decodedSvg).toContain('#FF33CC');
    expect(decodedSvg).toContain('#6B2FA0');
    expect(decodedSvg).toContain('VISTA');

    expect(gravure.id).toBe(GRAVURE_PUB_PROFILE_ID);
    expect(gravure.name).toBe('SARL GRAVURE PUB');
    expect(gravure.primaryColor).toBe('#FF7A1A');
    expect(gravure.accentColor).toBe('#1F3A93');
    expect(COLOR_PRESETS).toHaveLength(5);
  });

  it('résout le profil effectif en conservant le snapshot même si la société est supprimée', () => {
    const vista = buildDefaultVistaDigitalProfile('2026-08-20T00:00:00Z');
    const emptyMap = new Map();
    const resolvedFromSnapshot = resolveEffectiveCompanyProfile({
      companyProfileId: vista.id,
      issuerSnapshot: { name: 'SARL VISTA DIGITAL', primaryColor: '#FF33CC', accentColor: '#6B2FA0' },
      profileMap: emptyMap,
    });
    expect(resolvedFromSnapshot?.name).toBe('SARL VISTA DIGITAL');
    expect(resolvedFromSnapshot?.primaryColor).toBe('#FF33CC');
  });

  it('formate les nombres du tableau sans symbole monétaire et découpe proprement les longues factures en feuilles A4', () => {
    expect(formatMoneyNumberOnly(52500000)).toBe('525 000,00');
    expect(formatMoneyNumberOnly(350000)).toBe('3 500,00');
    expect(formatQuantityFr(150)).toBe('150');
    expect(formatQuantityFr(12.5)).toBe('12,5');

    const singleChunk = computeTemplatePageChunks([
      {
        id: 'l1',
        description: 'Location Panneaux\nFormat 12x4 m',
        quantity: 150,
        unit: 'm²',
        unitPriceCentimes: 350000,
        discountPercent: 0,
        tvaRate: 19,
        htCentimes: 52500000,
        tvaCentimes: 9975000,
        ttcCentimes: 62475000,
      },
    ]);
    expect(singleChunk).toHaveLength(1);
    expect(singleChunk[0].lines).toHaveLength(1);

    const manyLines = Array.from({ length: 18 }, (_, i) => ({
      id: `line-${i + 1}`,
      description: `Prestation affichage N°${i + 1}\nEmplacement Alger Centre`,
      quantity: 1,
      unit: 'u',
      unitPriceCentimes: 1000000,
      discountPercent: 0,
      tvaRate: 19,
      htCentimes: 1000000,
      tvaCentimes: 190000,
      ttcCentimes: 1190000,
    }));
    const multiChunks = computeTemplatePageChunks(manyLines);
    expect(multiChunks.length).toBeGreaterThan(1);
    const totalPreserved = multiChunks.reduce((sum, c) => sum + c.lines.length, 0);
    expect(totalPreserved).toBe(18);
    expect(multiChunks[1].startIndex).toBe(multiChunks[0].lines.length);
  });
});

import {
  buildInvoiceModelWorkbook,
  parseInvoiceSheet,
  readInvoiceExcelBuffer,
  scanWorkbooksForInvoiceForms,
} from '../services/import/parseInvoiceModel';
import {
  buildEditableInvoiceItems,
  buildExportParamsFromCustomerInvoice,
  processInvoiceImportFiles,
  validateInvoiceModelItems,
} from '../services/excelService';

describe('Mode 1 Import & Export Excel (« Modèle facture » type 078 STAR ADVERTISING)', () => {
  function buildStarAdvertisingWorkbookBuffer(): ArrayBuffer {
    const ws: XLSX.WorkSheet = {
      B6: {
        t: 's',
        v: 'RC: 16b1011397-00/16 - NIF: 001616101139795 - AI: 16124303069 - NIS: 00161610113979500',
      },
      C8: { t: 's', v: 'FACTURE N°078/26' },
      G8: { t: 's', v: 'Alger le 20/08/2026' },
      C10: { t: 's', v: 'Ref bc : 38/26/RL' },
      F10: { t: 's', v: 'Client :' },
      F11: { t: 's', v: 'NOM :' },
      G11: { t: 's', v: 'SARL STAR ADVERTISING' },
      C12: { t: 's', v: 'RC 0988412 B11' },
      F12: { t: 's', v: 'Adresse :' },
      G12: { t: 's', v: 'LOT N°8 etage 4 sidi yahya' },
      C13: { t: 's', v: 'AI 16288053024' },
      F13: { t: 's', v: 'Code postal:' },
      G13: { t: 's', v: '16000' },
      H13: { t: 's', v: 'Ville :' },
      I13: { t: 's', v: 'ALGER' },
      C14: { t: 's', v: 'NIF 001116098841281' },
      B17: { t: 's', v: 'N°' },
      D17: { t: 's', v: 'Désignation' },
      F17: { t: 's', v: 'Quantité ' },
      G17: { t: 's', v: 'Unité ' },
      H17: { t: 's', v: 'Prix Ht ' },
      I17: { t: 's', v: 'Total' },
      C18: { t: 's', v: `CMP Coke Summer${' '.repeat(100)}Imression (Changement de visuel)` },
      F18: { t: 's', v: '150 m²' },
      G18: { t: 'n', v: 1 },
      H18: { t: 'n', v: 3500 },
      I18: { t: 'n', f: 'H18*150', v: 525000 },
      B20: { t: 'n', v: 1 },
      C20: { t: 's', v: '* Unipol, 5 juillet face à la CNAS ( Face A&B)' },
      H25: { t: 's', v: 'TOTAL  HT ' },
      I25: { t: 'n', v: 525000 },
      H26: { t: 's', v: 'TVA19%' },
      I26: { t: 'n', v: 99750 },
      H27: { t: 's', v: 'TOTAL TTC' },
      I27: { t: 'n', v: 624750 },
      '!ref': 'A1:I30',
    };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Feuil2');
    return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  }

  it('auto-détecte et extrait fidèlement le modèle « 078 STAR ADVERSTISING.xlsx » sans aucune erreur', () => {
    const buffer = buildStarAdvertisingWorkbookBuffer();
    const scan = scanWorkbooksForInvoiceForms([
      { fileName: '078 STAR ADVERSTISING.xlsx', buffer },
    ]);

    expect(scan.mode).toBe('form');
    expect(scan.invoices).toHaveLength(1);

    const inv = scan.invoices[0];
    expect(inv.sheet).toBe('Feuil2');
    expect(inv.kind).toBe('facture');
    expect(inv.number).toBe('078/26');
    expect(inv.year).toBe(2026);
    expect(inv.date).toBe('2026-08-20');
    expect(inv.city).toBe('Alger');
    expect(inv.refBc).toBe('38/26/RL');
    expect(inv.company).toEqual({
      rc: '16b1011397-00/16',
      nif: '001616101139795',
      ai: '16124303069',
      nis: '00161610113979500',
    });
    expect(inv.client).toEqual({
      name: 'SARL STAR ADVERTISING',
      address: 'LOT N°8 etage 4 sidi yahya',
      postalCode: '16000',
      city: 'ALGER',
      phone: '',
      email: '',
      rc: '0988412 B11',
      ai: '16288053024',
      nif: '001116098841281',
      nis: '',
    });
    expect(inv.lines).toEqual([
      {
        title: 'CMP Coke Summer',
        description: 'Imression (Changement de visuel)\n* Unipol, 5 juillet face à la CNAS ( Face A&B)',
        qty: 150,
        unit: 'm²',
        unitPrice: 3500,
        total: 525000,
      },
    ]);
    expect(inv.totals).toEqual({
      ht: 525000,
      vatRate: 19,
      vat: 99750,
      ttc: 624750,
    });
    expect(inv.issues).toEqual([]);
  });

  it('conserve le mode tableau registre lorsqu’aucune feuille ne commence par FACTURE N°', () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['N° Facture', 'Client', 'Date', 'Montant HT'],
      ['010/26', 'Cevital', '2026-09-01', '100000'],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Registre');
    const buffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;

    const scan = scanWorkbooksForInvoiceForms([{ fileName: 'registre.xlsx', buffer }]);
    expect(scan.mode).toBe('table');
    expect(scan.invoices).toHaveLength(0);
  });

  it('importe plusieurs feuilles factures d’un même classeur tout en ignorant les feuilles annexes', () => {
    const wb1 = readInvoiceExcelBuffer(buildStarAdvertisingWorkbookBuffer());
    const ws1 = wb1.Sheets.Feuil2;
    const ws2 = {
      ...ws1,
      C8: { t: 's', v: 'FACTURE N°079/26' },
      G8: { t: 's', v: 'Alger le 25/08/2026' },
      G11: { t: 's', v: 'SARL AUTRE CLIENT' },
    } as XLSX.WorkSheet;
    const wsNotes = XLSX.utils.aoa_to_sheet([['Notes internes'], ['Rappel campagne']]);

    const multiWb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(multiWb, ws1, 'Facture 078');
    XLSX.utils.book_append_sheet(multiWb, ws2, 'Facture 079');
    XLSX.utils.book_append_sheet(multiWb, wsNotes, 'Notes');
    const buffer = XLSX.write(multiWb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;

    const scan = scanWorkbooksForInvoiceForms([{ fileName: 'lot-aout.xlsx', buffer }]);
    expect(scan.mode).toBe('form');
    expect(scan.invoices.map((i) => i.number)).toEqual(['078/26', '079/26']);
    expect(scan.ignoredSheets).toHaveLength(1);
    expect(scan.ignoredSheets[0].sheetName).toBe('Notes');
  });

  it('associe automatiquement la société par NIF et détecte les doublons sur (numéro + année + société)', () => {
    const vista = buildDefaultVistaDigitalProfile('2026-08-20T00:00:00Z');
    const gravure = buildDefaultGravurePubProfile('2026-08-20T00:00:00Z');
    const scan = scanWorkbooksForInvoiceForms([
      { fileName: '078 STAR ADVERSTISING.xlsx', buffer: buildStarAdvertisingWorkbookBuffer() },
    ]);

    const items = buildEditableInvoiceItems({
      parsedInvoices: scan.invoices,
      profiles: [vista, gravure],
      fallbackCompanyProfileId: vista.id,
    });
    expect(items[0].companyProfileId).toBe(VISTA_DIGITAL_PROFILE_ID);
    expect(items[0].companyMatchedByNif).toBe(true);
    expect(items[0].campaignName).toBe('CMP Coke Summer');

    const existingVistaSameYear = [
      {
        id: 'inv_existing',
        invoiceNumber: '078/26',
        issueDate: '2026-08-20',
        companyProfileId: VISTA_DIGITAL_PROFILE_ID,
      } as CustomerInvoice,
    ];
    const dupCheck = validateInvoiceModelItems({
      items,
      existingInvoices: existingVistaSameYear,
      profiles: [vista, gravure],
      contacts: [],
      purchaseOrders: [],
    });
    expect(dupCheck[0].status).toBe('doublon');
    expect(dupCheck[0].isDuplicate).toBe(true);

    // Changement de société : même N°/année sur GRAVURE PUB autorisé
    const otherCompanyCheck = validateInvoiceModelItems({
      items: [{ ...items[0], companyProfileId: GRAVURE_PUB_PROFILE_ID }],
      existingInvoices: existingVistaSameYear,
      profiles: [vista, gravure],
      contacts: [],
      purchaseOrders: [],
    });
    expect(otherCompanyCheck[0].isDuplicate).toBe(false);
  });

  it('assure l’aller-retour complet Export Excel Modèle facture -> Ré-import fidèle', () => {
    const vista = buildDefaultVistaDigitalProfile('2026-08-20T00:00:00Z');
    const invoice = {
      id: 'cinv_rt',
      invoiceNumber: '078/26',
      companyProfileId: vista.id,
      clientId: 'c1',
      clientSnapshot: {
        company: 'SARL STAR ADVERTISING',
        address: 'LOT N°8 etage 4 sidi yahya',
        postalCode: '16000',
        city: 'ALGER',
        phone: '0550123456',
        email: 'contact@star.dz',
        rc: '0988412 B11',
        ai: '16288053024',
        nif: '001116098841281',
        nis: '001116098841200',
      },
      issueDate: '2026-08-20',
      dueDate: '2026-09-19',
      bcNumber: '38/26/RL',
      campaignRef: 'CMP Coke Summer',
      currency: 'DZD',
      exchangeRate: 1,
      description: 'CMP Coke Summer',
      lines: [
        {
          id: 'l1',
          description: 'CMP Coke Summer\nImression (Changement de visuel)\n* Unipol, 5 juillet face à la CNAS ( Face A&B)',
          quantity: 150,
          unit: 'm²',
          unitPriceCentimes: 350000,
          discountPercent: 0,
          tvaRate: 19,
          htCentimes: 52500000,
          tvaCentimes: 9975000,
          ttcCentimes: 62475000,
        },
      ],
      totalHtCentimes: 52500000,
      totalTvaCentimes: 9975000,
      totalTtcCentimes: 62475000,
      baseDzdTtcCentimes: 62475000,
      status: 'impayee',
      notes: '',
      createdAt: '',
      updatedAt: '',
    } as CustomerInvoice;

    const exportParams = buildExportParamsFromCustomerInvoice({ invoice, profile: vista });
    const wb = buildInvoiceModelWorkbook(exportParams);
    const outBuf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
    const reReadWb = readInvoiceExcelBuffer(outBuf);
    const reParsed = parseInvoiceSheet(reReadWb.Sheets[reReadWb.SheetNames[0]], reReadWb.SheetNames[0]);

    expect(reParsed).not.toBeNull();
    expect(reParsed!.issues).toEqual([]);
    expect(reParsed!.number).toBe('078/26');
    expect(reParsed!.date).toBe('2026-08-20');
    expect(reParsed!.refBc).toBe('38/26/RL');
    expect(reParsed!.company.nif).toBe(vista.nif);
    expect(reParsed!.company.rc).toBe(vista.rc);
    expect(reParsed!.client.name).toBe('SARL STAR ADVERTISING');
    expect(reParsed!.client.nif).toBe('001116098841281');
    expect(reParsed!.lines[0]).toEqual({
      title: 'CMP Coke Summer',
      description: 'Imression (Changement de visuel)\n* Unipol, 5 juillet face à la CNAS ( Face A&B)',
      qty: 150,
      unit: 'm²',
      unitPrice: 3500,
      total: 525000,
    });
    expect(reParsed!.totals).toEqual({
      ht: 525000,
      vatRate: 19,
      vat: 99750,
      ttc: 624750,
    });
  });

  it('passe par la fonction exacte de la boîte de dialogue (processInvoiceImportFiles) sur les octets bruts d’un .xlsx réel -> 1 facture 078/26, TTC 624750, 0 erreur', async () => {
    const vista = buildDefaultVistaDigitalProfile('2026-08-20T00:00:00Z');
    const gravure = buildDefaultGravurePubProfile('2026-08-20T00:00:00Z');

    // Génère les octets réels d'un fichier .xlsx (Uint8Array -> ArrayBuffer, exactement comme File.arrayBuffer())
    const rawU8 = new Uint8Array(buildStarAdvertisingWorkbookBuffer());
    const realXlsxBytes = rawU8.buffer.slice(rawU8.byteOffset, rawU8.byteOffset + rawU8.byteLength);

    const result = await processInvoiceImportFiles({
      files: [{ fileName: '078 STAR ADVERSTISING.xlsx', buffer: realXlsxBytes }],
      profiles: [vista, gravure],
      fallbackCompanyProfileId: vista.id,
      existingInvoices: [],
      contacts: [],
      purchaseOrders: [],
    });

    expect(result.mode).toBe('form');
    expect(result.sheetNames).toEqual(['Feuil2']);
    expect(result.activeSheetName).toBe('Feuil2');
    expect(result.parsedSheet).toBeNull();
    expect(result.columnMapping).toEqual({});
    expect(result.formItems).toHaveLength(1);
    expect(result.validatedFormItems).toHaveLength(1);

    const first = result.validatedFormItems[0];
    expect(first.item.number).toBe('078/26');
    expect(first.item.totals.ttc).toBe(624750);
    expect(first.blockingErrors).toEqual([]);
    expect(first.warnings).toEqual([]);
    expect(first.isDuplicate).toBe(false);
    expect(first.status).toBe('valide');
  });

  it('mappe automatiquement les 22 en-têtes exacts du tableau registre (insensible à la casse, accents, espaces et apostrophes)', () => {
    const exactHeaders = [
      'N° Facture',
      'Client',
      'Date',
      'Date d’échéance',
      'N° BC',
      'Campagne / Réf.',
      'Début campagne',
      'Fin campagne',
      'Désignation / Description',
      'Qté',
      'Unité',
      'Prix unitaire HT',
      'Montant HT',
      'Taux TVA (%)',
      'Montant TVA',
      'Montant TTC',
      'Statut',
      'Devise',
      'Taux de change',
      'NIF client',
      'Adresse client',
      'Notes',
    ];
    const mapping = autoDetectColumnMapping('factures_clients', exactHeaders);

    expect(mapping).toEqual({
      invoiceNumber: 'N° Facture',
      clientName: 'Client',
      issueDate: 'Date',
      dueDate: 'Date d’échéance',
      bcNumber: 'N° BC',
      campaignRef: 'Campagne / Réf.',
      campaignStartDate: 'Début campagne',
      campaignEndDate: 'Fin campagne',
      description: 'Désignation / Description',
      quantity: 'Qté',
      unit: 'Unité',
      unitPrice: 'Prix unitaire HT',
      htAmount: 'Montant HT',
      tvaRate: 'Taux TVA (%)',
      tvaAmount: 'Montant TVA',
      ttcAmount: 'Montant TTC',
      status: 'Statut',
      currency: 'Devise',
      exchangeRate: 'Taux de change',
      clientNif: 'NIF client',
      clientAddress: 'Adresse client',
      notes: 'Notes',
    });

    // Variantes sans accents / apostrophe droite / casse différente
    const relaxed = autoDetectColumnMapping('factures_clients', [
      'n° facture',
      'client',
      'date',
      "date d'echeance",
      'campagne / ref.',
      'designation / description',
      'qte',
      'unite',
      'prix unitaire ht',
      'montant ht',
      'taux tva (%)',
      'montant tva',
      'montant ttc',
    ]);
    expect(relaxed.dueDate).toBe("date d'echeance");
    expect(relaxed.campaignRef).toBe('campagne / ref.');
    expect(relaxed.description).toBe('designation / description');
    expect(relaxed.tvaRate).toBe('taux tva (%)');
    expect(relaxed.unit).toBe('unite');
  });

  it('accepte les dates Excel natives (numériques/Date), 20/08/2026, 2026-08-20 et 20/08/26', async () => {
    expect(normalizeImportedDate('20/08/2026')).toBe('2026-08-20');
    expect(normalizeImportedDate('2026-08-20')).toBe('2026-08-20');
    expect(normalizeImportedDate('20/08/26')).toBe('2026-08-20');

    // Cellules avec vraie date Excel numérique (numFmt m/d/yy et dd/mm/yyyy)
    const ws = XLSX.utils.aoa_to_sheet([
      ['N° Facture', 'Client', 'Date', 'Date d’échéance', 'Montant HT'],
      ['078/26', 'SARL STAR ADVERTISING', new Date(Date.UTC(2026, 7, 20)), '20/09/2026', 525000],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Factures');
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;

    const parsed = await parseExcelBuffer(buf);
    expect(parsed.rows).toHaveLength(1);
    expect(normalizeImportedDate(parsed.rows[0]['Date'])).toBe('2026-08-20');
    expect(normalizeImportedDate(parsed.rows[0]['Date d’échéance'])).toBe('2026-09-20');
  });

  it('importe la fixture tableau « Factures » (078/26, 1 ligne + lignes vides) via processInvoiceImportFiles -> 1 facture valide, 0 erreur', async () => {
    const vista = buildDefaultVistaDigitalProfile('2026-08-20T00:00:00Z');
    const gravure = buildDefaultGravurePubProfile('2026-08-20T00:00:00Z');

    const ws = XLSX.utils.aoa_to_sheet([
      [
        'N° Facture',
        'Client',
        'Date',
        'N° BC',
        'Désignation / Description',
        'Qté',
        'Unité',
        'Prix unitaire HT',
        'Montant HT',
        'Taux TVA (%)',
        'Montant TVA',
        'Montant TTC',
      ],
      [
        '078/26',
        'SARL STAR ADVERTISING',
        '20/08/2026',
        '38/26/RL',
        'CMP Coke Summer — Impression et pose',
        150,
        'm²',
        3500,
        525000,
        19,
        99750,
        624750,
      ],
      // Lignes vides résiduelles typiques d'un classeur Excel formaté
      ['', '', '', '', '', '', '', '', '', '', '', ''],
      ['', '', '', '', '', '', '', '', '', '', '', ''],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Factures');
    const buffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;

    const prepared = await processInvoiceImportFiles({
      files: [{ fileName: 'factures-star.xlsx', buffer }],
      profiles: [vista, gravure],
      fallbackCompanyProfileId: vista.id,
      existingInvoices: [],
      contacts: [],
      purchaseOrders: [],
    });

    expect(prepared.mode).toBe('table');
    expect(prepared.activeSheetName).toBe('Factures');
    expect(prepared.parsedSheet).not.toBeNull();
    expect(prepared.parsedSheet!.rows).toHaveLength(1);
    expect(prepared.columnMapping.invoiceNumber).toBe('N° Facture');
    expect(prepared.columnMapping.clientName).toBe('Client');
    expect(prepared.columnMapping.issueDate).toBe('Date');
    expect(prepared.columnMapping.bcNumber).toBe('N° BC');
    expect(prepared.columnMapping.quantity).toBe('Qté');
    expect(prepared.columnMapping.unit).toBe('Unité');
    expect(prepared.columnMapping.unitPrice).toBe('Prix unitaire HT');
    expect(prepared.columnMapping.htAmount).toBe('Montant HT');
    expect(prepared.columnMapping.tvaRate).toBe('Taux TVA (%)');
    expect(prepared.columnMapping.tvaAmount).toBe('Montant TVA');
    expect(prepared.columnMapping.ttcAmount).toBe('Montant TTC');

    const validated = validateImportRows({
      type: 'factures_clients',
      rows: prepared.parsedSheet!.rows,
      mapping: prepared.columnMapping,
      options: { groupInvoicesByNumber: true },
      ctx: {
        contacts: [],
        customerInvoices: [],
        supplierInvoices: [],
        expenses: [],
        incomingCheques: [],
        outgoingCheques: [],
        chequeLeafKeys: new Set<string>(),
        bankAccounts: [],
        defaultTvaRate: 19,
        defaultCurrency: 'DZD',
      },
    });

    expect(validated).toHaveLength(1);
    expect(validated[0].rowIndex).toBe(2);
    expect(validated[0].status).toBe('valide');
    expect(validated[0].mapped.invoiceNumber).toBe('078/26');
    expect(validated[0].mapped.clientName).toBe('SARL STAR ADVERTISING');
    expect(validated[0].mapped.htAmount).toBe('525000');
    expect(validated[0].mapped.ttcAmount).toBe('624750');
  });

  it('remplace complètement l’état entre deux fichiers séquentiels (Fichier A 7 lignes -> Fichier B 1 ligne Factures)', async () => {
    const vista = buildDefaultVistaDigitalProfile('2026-08-20T00:00:00Z');
    const gravure = buildDefaultGravurePubProfile('2026-08-20T00:00:00Z');

    // Fichier A : 7 lignes invalides (lignes 2 à 8) sur feuille "Ancien"
    const wsA = XLSX.utils.aoa_to_sheet([
      ['ColA', 'ColB', 'ColC'],
      ['a1', '', ''],
      ['a2', '', ''],
      ['a3', '', ''],
      ['a4', '', ''],
      ['a5', '', ''],
      ['a6', '', ''],
      ['a7', '', ''],
    ]);
    const wbA = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wbA, wsA, 'Ancien');
    const bufA = XLSX.write(wbA, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;

    // Fichier B : 1 seule ligne valide (ligne 2) sur feuille "Factures"
    const wsB = XLSX.utils.aoa_to_sheet([
      ['N° Facture', 'Client', 'Date', 'N° BC', 'Qté', 'Unité', 'Prix unitaire HT', 'Montant HT', 'Taux TVA (%)', 'Montant TVA', 'Montant TTC'],
      ['078/26', 'SARL STAR ADVERTISING', '20/08/2026', '38/26/RL', 150, 'm²', 3500, 525000, 19, 99750, 624750],
    ]);
    const wbB = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wbB, wsB, 'Factures');
    const bufB = XLSX.write(wbB, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;

    const ctx = {
      contacts: [],
      customerInvoices: [],
      supplierInvoices: [],
      expenses: [],
      incomingCheques: [],
      outgoingCheques: [],
      chequeLeafKeys: new Set<string>(),
      bankAccounts: [],
      defaultTvaRate: 19,
      defaultCurrency: 'DZD',
    };

    const resA = await processInvoiceImportFiles({
      files: [{ fileName: 'ancien-7-erreurs.xlsx', buffer: bufA }],
      profiles: [vista, gravure],
      fallbackCompanyProfileId: vista.id,
      existingInvoices: [],
      contacts: [],
      purchaseOrders: [],
    });
    const valA = validateImportRows({
      type: 'factures_clients',
      rows: resA.parsedSheet!.rows,
      mapping: resA.columnMapping,
      options: { groupInvoicesByNumber: true },
      ctx,
    });
    expect(valA).toHaveLength(7);
    expect(valA.filter((r) => r.status === 'erreur')).toHaveLength(7);

    // Sélection du Fichier B juste après : doit produire uniquement 1 ligne valide, 0 erreur
    const resB = await processInvoiceImportFiles({
      files: [{ fileName: 'facture-078.xlsx', buffer: bufB }],
      profiles: [vista, gravure],
      fallbackCompanyProfileId: vista.id,
      existingInvoices: [],
      contacts: [],
      purchaseOrders: [],
    });
    const valB = validateImportRows({
      type: 'factures_clients',
      rows: resB.parsedSheet!.rows,
      mapping: resB.columnMapping,
      options: { groupInvoicesByNumber: true },
      ctx,
    });

    expect(resB.mode).toBe('table');
    expect(resB.activeSheetName).toBe('Factures');
    expect(resB.parsedSheet!.rows).toHaveLength(1);
    expect(valB).toHaveLength(1);
    expect(valB.filter((r) => r.status === 'valide')).toHaveLength(1);
    expect(valB.filter((r) => r.status === 'erreur')).toHaveLength(0);
    expect(valB[0].mapped.invoiceNumber).toBe('078/26');
  });
});

describe('Étape 1 — Moteur de lecture Bons de Commande (PDF texte, OCR scan, Excel)', () => {
  it('analyse fidèlement la fixture texte « 004 EPE Hydro Canal SPA.pdf » en BC émis avec quantités/prix vides', async () => {
    const { buildDefaultGravurePubProfile, buildDefaultVistaDigitalProfile } = await import(
      '../constants/companyPresets'
    );
    const { parsePurchaseOrder } = await import('../services/import/parsePurchaseOrder');

    const profiles = [buildDefaultVistaDigitalProfile(), buildDefaultGravurePubProfile()];
    const fixtureText =
      "SAFEX- les pins maritimes , mohammadia Alger | Email: vistadigital13@hotmail.com | Tel: 023 79 54 86 /87 - 0553 59 12 09 - 0552 21 36 22 | RC : 16B1011397-00/16 - NIF: 001616101139795 - AI: 16119136307 | Alger le : 15-02-2026 | Client: EPE HYDRO CANAL SPA | Adresse: Route Nationale n°05 EL MOHAMMADIA - ALGER | Email: drc.hydrocanal@yahoo.com | Tél: 023 75 73 41 | Bon de commande n° 004/26 | N° | Désignation | Quantité | Prix u | Total | 1 Fouilles pour realiser un scole en bêton pour implanter un unipole d'affichage | dim: 2m50 x 3m x 2m40 | 2 fourniture de 25 metre cube de beton | Total HT | TVA 19 % | Total TTC | Arrêté le présent bon de commande à la somme de :";

    const parsed = parsePurchaseOrder(fixtureText, { companyProfiles: profiles });

    expect(parsed.direction).toBe('emis');
    expect(parsed.matchedCompanyProfileId).toBe(profiles[0].id);
    expect(parsed.number).toBe('004/26');
    expect(parsed.year).toBe(2026);
    expect(parsed.date).toBe('2026-02-15');
    expect(parsed.city).toBe('Alger');

    expect(parsed.issuer.nif).toBe('001616101139795');
    expect(parsed.issuer.rc).toBe('16B1011397-00/16');
    expect(parsed.issuer.ai).toBe('16119136307');
    expect(parsed.issuer.email).toBe('vistadigital13@hotmail.com');

    expect(parsed.party.name).toBe('EPE HYDRO CANAL SPA');
    expect(parsed.party.address).toBe('Route Nationale n°05 EL MOHAMMADIA - ALGER');
    expect(parsed.party.email).toBe('drc.hydrocanal@yahoo.com');
    expect(parsed.party.phone).toBe('023 75 73 41');

    expect(parsed.lines).toHaveLength(2);
    expect(parsed.lines[0].title).toBe(
      "Fouilles pour realiser un scole en bêton pour implanter un unipole d'affichage"
    );
    expect(parsed.lines[0].description).toBe('dim: 2m50 x 3m x 2m40');
    expect(parsed.lines[0].qty).toBeNull();
    expect(parsed.lines[0].unitPrice).toBeNull();
    expect(parsed.lines[0].total).toBeNull();
    expect(parsed.lines[1].title).toBe('fourniture de 25 metre cube de beton');
    expect(parsed.lines[1].qty).toBeNull();
    expect(parsed.totals).toBeNull();
  });

  it('regroupe les éléments positionnés (x, y) PDF, extrait les unités (25 m³) et détecte un BC reçu chiffré', async () => {
    const { buildDefaultVistaDigitalProfile } = await import('../constants/companyPresets');
    const { parsePurchaseOrder } = await import('../services/import/parsePurchaseOrder');

    const vista = buildDefaultVistaDigitalProfile();
    const items = [
      { str: 'SARL STAR ADVERTISING', x: 30, y: 40, width: 180, height: 14, page: 1 },
      { str: 'RC : 0988412 B11 - NIF : 001116098841281', x: 30, y: 60, width: 220, height: 10, page: 1 },
      { str: 'Bon de commande n° 38/26/RL', x: 30, y: 95, width: 180, height: 12, page: 1 },
      { str: 'Alger le 15 février 2026', x: 350, y: 95, width: 150, height: 11, page: 1 },
      { str: 'Fournisseur : SARL VISTA DIGITAL', x: 280, y: 120, width: 220, height: 11, page: 1 },
      { str: 'N°', x: 30, y: 160, width: 20, height: 10, page: 1 },
      { str: 'Désignation', x: 80, y: 160, width: 180, height: 10, page: 1 },
      { str: 'Quantité', x: 290, y: 160, width: 50, height: 10, page: 1 },
      { str: 'Prix u', x: 370, y: 160, width: 60, height: 10, page: 1 },
      { str: 'Total', x: 460, y: 160, width: 70, height: 10, page: 1 },
      { str: '1', x: 32, y: 185, width: 10, height: 10, page: 1 },
      { str: 'Habillage façade bâche', x: 80, y: 185, width: 160, height: 10, page: 1 },
      { str: '25 m³', x: 295, y: 185, width: 35, height: 10, page: 1 },
      { str: '10 000,00', x: 370, y: 185, width: 55, height: 10, page: 1 },
      { str: '250 000,00', x: 460, y: 185, width: 65, height: 10, page: 1 },
      { str: 'avec pose nocturne', x: 80, y: 202, width: 140, height: 10, page: 1 },
      { str: 'Total HT', x: 370, y: 240, width: 60, height: 10, page: 1 },
      { str: '250 000,00', x: 460, y: 240, width: 65, height: 10, page: 1 },
      { str: 'TVA 19 %', x: 370, y: 258, width: 60, height: 10, page: 1 },
      { str: '47 500,00', x: 460, y: 258, width: 65, height: 10, page: 1 },
      { str: 'Total TTC', x: 370, y: 276, width: 60, height: 10, page: 1 },
      { str: '297 500,00', x: 460, y: 276, width: 65, height: 10, page: 1 },
    ];

    const parsed = parsePurchaseOrder(items, { companyProfiles: [vista] });
    expect(parsed.direction).toBe('recu');
    expect(parsed.matchedCompanyProfileId).toBe(vista.id);
    expect(parsed.number).toBe('38/26/RL');
    expect(parsed.year).toBe(2026);
    expect(parsed.date).toBe('2026-02-15');
    expect(parsed.city).toBe('Alger');
    expect(parsed.issuer.name).toBe('SARL STAR ADVERTISING');
    expect(parsed.issuer.nif).toBe('001116098841281');
    expect(parsed.lines).toHaveLength(1);
    expect(parsed.lines[0].qty).toBe(25);
    expect(parsed.lines[0].unit).toBe('m³');
    expect(parsed.lines[0].unitPrice).toBe(10000);
    expect(parsed.lines[0].total).toBe(250000);
    expect(parsed.lines[0].description).toBe('avec pose nocturne');
    expect(parsed.totals).toEqual({ ht: 250000, vatRate: 19, vat: 47500, ttc: 297500 });
  });

  it('bascule en OCR hors-ligne sur PDF scanné (< 20 caractères) et signale l’avertissement scan', async () => {
    const { buildDefaultVistaDigitalProfile } = await import('../constants/companyPresets');
    const { readBcImportFile } = await import('../services/import/pdfBcReader');

    const vista = buildDefaultVistaDigitalProfile();
    const fakePdfBuffer = new TextEncoder().encode('%PDF-1.4 fake scan').buffer;

    const results = await readBcImportFile({
      file: {
        name: 'scan-bc-client.pdf',
        type: 'application/pdf',
        size: 1200,
        arrayBuffer: async () => fakePdfBuffer,
      },
      companyProfiles: [vista],
      pdfExtractorOverride: async () => ({
        items: [],
        charCount: 4, // < 20 caractères -> déclenche OCR
        numPages: 1,
        renderPageForOcr: async () => ({} as HTMLCanvasElement),
      }),
      ocrEngine: {
        recognizeImage: async (_src, onProgress) => {
          onProgress?.(100);
          return {
            text: '',
            confidence: 68,
            lines: [
              { text: 'SARL CLIENT SCAN', confidence: 72, bbox: { x0: 20, y0: 20, x1: 200, y1: 36 } },
              { text: 'Bon de commande n° 109/26', confidence: 64, bbox: { x0: 20, y0: 55, x1: 220, y1: 70 } },
              { text: 'Alger le 12-03-2026', confidence: 66, bbox: { x0: 20, y0: 80, x1: 180, y1: 95 } },
            ],
          };
        },
      },
    });

    expect(results).toHaveLength(1);
    expect(results[0].parsed.isScannedOcr).toBe(true);
    expect(results[0].parsed.warnings).toContain(
      "Lecture automatique d'un scan : vérifiez chaque champ"
    );
    expect(results[0].parsed.number).toBe('109/26');
    expect(results[0].parsed.date).toBe('2026-03-12');
    expect(results[0].parsed.confidence.number).toBeCloseTo(0.64, 2);
  });

  it('analyse un classeur Excel modèle Bon de Commande (mode formulaire)', async () => {
    const XLSX = await import('xlsx');
    const { buildDefaultVistaDigitalProfile } = await import('../constants/companyPresets');
    const { parseBcExcelWorkbook } = await import('../services/import/excelBcParser');

    const vista = buildDefaultVistaDigitalProfile();
    const ws = XLSX.utils.aoa_to_sheet([
      ['RC : 16B1011397-00/16 - NIF: 001616101139795 - AI: 16119136307'],
      ['BON DE COMMANDE N° 004/26', '', '', 'Alger le : 15-02-2026'],
      ['Client :', 'EPE HYDRO CANAL SPA'],
      ['Adresse :', 'Route Nationale n°05 EL MOHAMMADIA - ALGER'],
      ['N°', 'Désignation', 'Quantité', 'Prix u', 'Total'],
      [1, 'Fouilles unipole', '', '', ''],
      ['', 'dim: 2m50 x 3m x 2m40', '', '', ''],
      [2, 'Béton 25 m³', '', '', ''],
      ['', '', '', 'TOTAL HT', ''],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'BC 004');
    const buffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;

    const sheets = parseBcExcelWorkbook(buffer, [vista]);
    expect(sheets).toHaveLength(1);
    const parsed = sheets[0].parsed;
    expect(parsed.direction).toBe('emis');
    expect(parsed.number).toBe('004/26');
    expect(parsed.date).toBe('2026-02-15');
    expect(parsed.party.name).toBe('EPE HYDRO CANAL SPA');
    expect(parsed.lines).toHaveLength(2);
    expect(parsed.lines[0].title).toBe('Fouilles unipole');
    expect(parsed.lines[0].description).toBe('dim: 2m50 x 3m x 2m40');
    expect(parsed.lines[0].qty).toBeNull();
    expect(parsed.lines[0].unitPrice).toBeNull();
    expect(parsed.totals).toBeNull();
  });
});

describe('Import Bon de Commande — Stage 2 (brouillon, contacts, doublons, séquence, modèle A4, 100% hors-ligne)', () => {
  it('convertit le BC modèle 004 EPE Hydro Canal SPA en brouillon non chiffré sans inventer de 0', async () => {
    const { buildDefaultVistaDigitalProfile } = await import('../constants/companyPresets');
    const { parsePurchaseOrder } = await import('../services/import/parsePurchaseOrder');
    const { createInitialImportedBcDraft, computeDraftTotals } = await import(
      '../services/import/bcImportSaveService'
    );

    const vista = buildDefaultVistaDigitalProfile();
    const parsed = parsePurchaseOrder(
      [
        'RC : 16B1011397-00/16 - NIF: 001616101139795 - AI: 16119136307',
        'Alger le : 15-02-2026',
        'Bon de commande n° 004/26',
        'Client : EPE HYDRO CANAL SPA',
        'Adresse : Route Nationale n°05 EL MOHAMMADIA - ALGER',
        'N°   Désignation   Quantité   Prix u   Total',
        "1   Fouilles pour realiser un scole en bêton pour implanter un unipole d'affichage",
        'dim: 2m50 x 3m x 2m40',
        '2   fourniture de 25 metre cube de beton',
        'Total HT',
        'TVA 19 %',
        'Total TTC',
      ].join('\n'),
      { companyProfiles: [vista] }
    );

    const draft = createInitialImportedBcDraft({
      parsed,
      companyProfiles: [vista],
      existingContacts: [],
      defaultCurrency: 'DZD',
    });

    expect(draft.direction).toBe('bc_emis');
    expect(draft.companyProfileId).toBe(vista.id);
    expect(draft.poNumber).toBe('004/26');
    expect(draft.issueDate).toBe('2026-02-15');
    expect(draft.party.name).toBe('EPE HYDRO CANAL SPA');
    expect(draft.lines).toHaveLength(2);
    expect(draft.lines[0].qtyText).toBe('');
    expect(draft.lines[0].unitPriceText).toBe('');
    expect(draft.lines[0].totalText).toBe('');

    const totals = computeDraftTotals(draft);
    expect(totals.unpriced).toBe(true);
    expect(totals.htCentimes).toBe(0);
    expect(totals.ttcCentimes).toBe(0);
  });

  it('associe un contact par NIF puis RC puis nom similaire et détecte les doublons N° BC + année + contact', async () => {
    const { matchContactForBc, findDuplicatePurchaseOrder } = await import(
      '../services/import/bcImportSaveService'
    );

    const contacts = [
      {
        id: 'c-star',
        type: 'client' as const,
        name: 'SARL STAR ADVERTISING',
        company: 'SARL STAR ADVERTISING',
        address: 'Sidi Yahya Alger',
        phone: '021000000',
        email: '',
        nif: '001116098841281',
        nis: '',
        rc: '0988412 B11',
        ai: '16288053024',
        notes: '',
        archived: false,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ];

    expect(
      matchContactForBc({
        direction: 'bc_recu',
        party: { name: 'Autre libellé', nif: '001116098841281', rc: '' },
        existingContacts: contacts,
      }).matchReason
    ).toBe('nif');

    expect(
      matchContactForBc({
        direction: 'bc_recu',
        party: { name: 'Autre libellé', nif: '', rc: '0988412B11' },
        existingContacts: contacts,
      }).matchReason
    ).toBe('rc');

    expect(
      matchContactForBc({
        direction: 'bc_recu',
        party: { name: 'Star Advertising', nif: '', rc: '' },
        existingContacts: contacts,
      }).matchReason
    ).toBe('name');

    const dup = findDuplicatePurchaseOrder({
      direction: 'bc_recu',
      poNumber: 'BC N° 38/26/RL',
      issueDate: '2026-02-15',
      contactId: 'c-star',
      existingOrders: [
        {
          id: 'po-1',
          direction: 'bc_recu',
          poNumber: '38/26/RL',
          contactId: 'c-star',
          issueDate: '2026-02-10',
          campaignRef: 'CMP',
          currency: 'DZD',
          exchangeRate: 1,
          description: '',
          lines: [],
          totalHtCentimes: 0,
          totalTvaCentimes: 0,
          totalTtcCentimes: 0,
          baseDzdTtcCentimes: 0,
          status: 'recu',
          notes: '',
          attachmentsCount: 1,
          createdAt: '',
          updatedAt: '',
        },
      ],
    });
    expect(dup?.id).toBe('po-1');
  });

  it('maintient la numérotation automatique au-dessus des BC importés et préserve les octets en pièce jointe', async () => {
    const { computeNextSequenceNumber } = await import('../utils/documentHelpers');
    const { arrayBufferToDataUrl, dataUrlToUint8Array } = await import(
      '../services/import/bcImportSaveService'
    );

    const next = computeNextSequenceNumber({
      kind: 'bc_emis',
      yearFull: 2026,
      existingNumbers: [
        { number: '004/26', date: '2026-02-15', companyProfileId: 'vista' },
        { number: 'BC N°012/26', date: '2026-03-01', companyProfileId: 'vista' },
      ],
      companyProfileId: 'vista',
    });
    expect(next).toBe('BC N°013/26');

    const original = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52, 0, 255, 17, 42]);
    const dataUrl = arrayBufferToDataUrl(original.buffer, 'application/pdf');
    expect(dataUrl.startsWith('data:application/pdf;base64,')).toBe(true);
    const decoded = dataUrlToUint8Array(dataUrl);
    expect(Array.from(decoded)).toEqual(Array.from(original));
  });

  it('génère le modèle A4 du BC émis aux couleurs du profil et laisse vides les cellules sans prix', async () => {
    const React = await import('react');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { buildDefaultVistaDigitalProfile } = await import('../constants/companyPresets');
    const { SharedDocumentTemplate } = await import('../components/SharedDocumentTemplate');

    const vista = buildDefaultVistaDigitalProfile();
    const html = renderToStaticMarkup(
      React.createElement(SharedDocumentTemplate, {
        docKind: 'bc_emis',
        docNumber: '004/26',
        issueDate: '2026-02-15',
        profile: vista,
        contact: {
          id: 'sup-hydro',
          type: 'fournisseur',
          name: 'EPE HYDRO CANAL SPA',
          company: 'EPE HYDRO CANAL SPA',
          address: 'Route Nationale n°05 EL MOHAMMADIA - ALGER',
          phone: '023 75 73 41',
          email: 'drc.hydrocanal@yahoo.com',
          nif: '',
          nis: '',
          rc: '',
          ai: '',
          notes: '',
          archived: false,
          createdAt: '',
          updatedAt: '',
        },
        currency: 'DZD',
        unpriced: true,
        lines: [
          {
            id: 'l1',
            description:
              "Fouilles pour realiser un scole en bêton pour implanter un unipole d'affichage\ndim: 2m50 x 3m x 2m40",
            quantity: 0,
            unit: 'u',
            unitPriceCentimes: 0,
            discountPercent: 0,
            tvaRate: 0,
            htCentimes: 0,
            tvaCentimes: 0,
            ttcCentimes: 0,
          },
        ],
        totalHtCentimes: 0,
        totalTvaCentimes: 0,
        totalTtcCentimes: 0,
      })
    );

    expect(html).toContain('Bon de commande n° 004/26');
    expect(html).toContain('Alger le : 15-02-2026');
    expect(html).toContain('EPE HYDRO CANAL SPA');
    expect(html).toContain('Fournisseur :');
    expect(html).toContain('#FF33CC');
    expect(html).toContain('Email: contact@vistadigital.pub');
    expect(html).toContain('TVA 19 %');
    expect(html).not.toContain('0,00');
  });

  it('embarque tous les fichiers OCR et PDF.js localement sans URL CDN distante', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const root = process.cwd();

    expect(fs.existsSync(path.join(root, 'public/ocr/lang-data/fra.traineddata.gz'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'public/ocr/lang-data/eng.traineddata.gz'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'public/ocr/worker.min.js'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'public/ocr/tesseract-core'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'public/pdfjs/pdf.worker.min.mjs'))).toBe(true);

    const readerSource = fs.readFileSync(
      path.join(root, 'src/services/import/pdfBcReader.ts'),
      'utf8'
    );
    expect(readerSource).not.toMatch(/https?:\/\//i);
  });
});

describe('Mise à jour complète — Statuts factures, Chèques/avances, Campagnes, Isolation PDF et Impression', () => {
  it('Part 1 : calcule correctement les statuts Payée / Partielle / Non payée / En retard / Annulée', () => {
    expect(
      computeInvoiceStatus({
        storedStatus: 'impayee',
        totalTtcCentimes: 11900000,
        paidCentimes: 0,
        dueDate: '2026-12-31',
        referenceDate: '2026-08-20',
      })
    ).toBe('impayee');

    expect(
      computeInvoiceStatus({
        storedStatus: 'impayee',
        totalTtcCentimes: 11900000,
        paidCentimes: 5000000,
        dueDate: '2026-12-31',
        referenceDate: '2026-08-20',
      })
    ).toBe('partielle');

    expect(
      computeInvoiceStatus({
        storedStatus: 'partielle',
        totalTtcCentimes: 11900000,
        paidCentimes: 11900000,
        dueDate: '2026-08-01',
        referenceDate: '2026-08-20',
      })
    ).toBe('payee');

    expect(
      computeInvoiceStatus({
        storedStatus: 'impayee',
        totalTtcCentimes: 11900000,
        paidCentimes: 5000000,
        dueDate: '2026-08-01',
        referenceDate: '2026-08-20',
      })
    ).toBe('en_retard');

    expect(
      computeInvoiceStatus({
        storedStatus: 'annulee',
        totalTtcCentimes: 11900000,
        paidCentimes: 0,
        dueDate: '2026-08-01',
        referenceDate: '2026-08-20',
      })
    ).toBe('annulee');
  });

  it('Part 2 : comptabilise les chèques d’avance en attente et les paiements versement dans le compte client', () => {
    const summary = computeContactAccountSummary({
      contactId: 'cli-1',
      direction: 'client',
      invoices: [
        {
          id: 'inv-1',
          contactId: 'cli-1',
          totalTtcCentimes: 20000000,
          baseDzdTtcCentimes: 20000000,
          status: 'impayee',
        },
      ],
      payments: [
        {
          id: 'pay-1',
          direction: 'entrant',
          contactId: 'cli-1',
          date: '2026-08-10',
          amountCentimes: 5000000,
          currency: 'DZD',
          exchangeRate: 1,
          baseDzdAmountCentimes: 5000000,
          method: 'versement',
          bankAccountId: 'bank-1',
          reference: 'VIR-01',
          notes: '',
          isAdvance: true,
          status: 'valide',
          createdAt: '',
          updatedAt: '',
        },
      ],
      allocations: [],
      incomingCheques: [
        {
          id: 'chq-adv',
          clientId: 'cli-1',
          status: 'en_attente',
          isAdvance: true,
          allocatedInvoiceIds: [],
          baseDzdAmountCentimes: 8000000,
        },
        {
          id: 'chq-rej',
          clientId: 'cli-1',
          status: 'rejete',
          isAdvance: true,
          allocatedInvoiceIds: [],
          baseDzdAmountCentimes: 3000000,
        },
      ],
    });

    expect(summary.totalInvoicedBaseDzd).toBe(20000000);
    expect(summary.totalUnpaidBaseDzd).toBe(20000000);
    expect(summary.pendingAdvanceChequesBaseDzd).toBe(8000000);
    // 50 000 DA paiement non affecté + 80 000 DA chèque d'avance en attente (hors chèque rejeté)
    expect(summary.availableAdvanceBaseDzd).toBe(13000000);
  });

  it('Part 3 : autorise les campagnes sans dates imposées et respecte le statut choisi manuellement', () => {
    expect(computeCampaignDuration('', '')).toEqual({
      valid: true,
      days: 0,
      monthsFloat: 0,
      label: '—',
    });
    expect(suggestCampaignStatus('', '')).toBe('prevue');
    expect(
      getEffectiveCampaignStatus(
        { startDate: '2026-01-01', endDate: '2026-01-31', status: 'en_cours' },
        '2026-08-20'
      )
    ).toBe('en_cours');
  });

  it('Part 4 : isolateElementForPdfClone supprime barre latérale/modale/frères et buildStandaloneReportHtml reste 100% hors-ligne', async () => {
    const {
      isolateElementForPdfClone,
      buildStandaloneReportHtml,
      resolvePaperDimensionsMm,
    } = await import('../utils/print');

    const removedNodes: string[] = [];
    const makeNode = (id: string, tagName = 'DIV') => ({
      id,
      nodeType: 1,
      tagName,
      style: {} as Record<string, string>,
      parentElement: null as unknown,
      parentNode: null as unknown,
      childNodes: [] as unknown[],
    });

    const body = makeNode('body', 'BODY');
    const sidebar = makeNode('sidebar', 'ASIDE');
    const modalBackdrop = makeNode('modal', 'DIV');
    const modalToolbar = makeNode('toolbar', 'DIV');
    const targetDoc = makeNode('doc-a4', 'DIV');
    const toast = makeNode('toast', 'DIV');

    const attach = (parent: ReturnType<typeof makeNode>, child: ReturnType<typeof makeNode>) => {
      child.parentElement = parent;
      child.parentNode = {
        removeChild: (n: ReturnType<typeof makeNode>) => {
          removedNodes.push(n.id);
          parent.childNodes = parent.childNodes.filter((c) => c !== n);
        },
      };
      parent.childNodes.push(child);
    };

    attach(body, sidebar);
    attach(body, modalBackdrop);
    attach(body, toast);
    attach(modalBackdrop, modalToolbar);
    attach(modalBackdrop, targetDoc);

    const fakeDoc = {
      body: body as unknown as HTMLElement,
      documentElement: makeNode('html', 'HTML') as unknown as HTMLElement,
    } as unknown as Document;

    isolateElementForPdfClone(fakeDoc, targetDoc as unknown as HTMLElement);

    expect(removedNodes).toContain('sidebar');
    expect(removedNodes).toContain('toast');
    expect(removedNodes).toContain('toolbar');
    expect(removedNodes).not.toContain('doc-a4');
    expect(modalBackdrop.childNodes).toEqual([targetDoc]);
    expect(body.childNodes).toEqual([modalBackdrop]);
    expect(modalBackdrop.style.background).toBe('#ffffff');
    expect(modalBackdrop.style.transform).toBe('none');

    const reportHtml = buildStandaloneReportHtml({
      title: 'Factures impayées',
      filterSummary: 'Période : 2026-01-01 → 2026-12-31',
      columns: [
        { key: 'num', header: 'N°' },
        { key: 'total', header: 'Total TTC', type: 'number' },
      ],
      rows: [{ num: '078/26', total: '624 750,00 DA' }],
      totalsRow: { num: 'TOTAL', total: '624 750,00 DA' },
      summaryCards: [{ label: 'Reste dû', value: '624 750,00 DA', tone: 'red' }],
    });

    expect(reportHtml).toContain('Factures impayées');
    expect(reportHtml).toContain('078/26');
    expect(reportHtml).toContain('624 750,00 DA');
    expect(reportHtml).not.toMatch(/https?:\/\//i);

    expect(resolvePaperDimensionsMm('A4', false)).toEqual({ widthMm: 210, heightMm: 297 });
    expect(resolvePaperDimensionsMm('A4', true)).toEqual({ widthMm: 297, heightMm: 210 });
    expect(resolvePaperDimensionsMm('A5', false)).toEqual({ widthMm: 148, heightMm: 210 });
  });

  it('Part 5 : fournit les paramètres d’impression par défaut et le HTML de test hors-ligne', async () => {
    const { DEFAULT_PRINT_SETTINGS } = await import('../db/database');
    const { buildPrintTestHtml } = await import('../utils/print');

    expect(DEFAULT_PRINT_SETTINGS).toEqual({
      defaultPrinterName: '',
      paperSize: 'A4',
      orientation: 'portrait',
      margins: 'none',
      color: true,
      copies: 1,
      fitToPage: true,
      previewBeforePrint: true,
      silentPrint: false,
    });

    const testHtml = buildPrintTestHtml(undefined, undefined, {
      ...DEFAULT_PRINT_SETTINGS,
      defaultPrinterName: 'HP LaserJet Pro',
      orientation: 'landscape',
      copies: 2,
    });
    expect(testHtml).toContain('HP LaserJet Pro');
    expect(testHtml).toContain('Paysage');
    expect(testHtml).toContain('2 copie(s)');
    expect(testHtml).not.toMatch(/https?:\/\//i);
  });
});




