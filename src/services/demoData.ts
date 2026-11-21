import {
  buildDefaultGravurePubProfile,
  buildDefaultVistaDigitalProfile,
  GRAVURE_PUB_PROFILE_ID,
  VISTA_DIGITAL_PROFILE_ID,
} from '../constants/companyPresets';
import { db, DEFAULT_EXPENSE_CATEGORIES, ensureDatabaseInitialized, recordAudit } from '../db/database';
import { generateChequeSerialSequence } from '../utils/cheque';
import { computeInvoiceDocumentTotals } from '../utils/finance';
import { buildIssuerSnapshot } from './documentActions';

export async function loadDemoData(): Promise<void> {
  const settings = await ensureDatabaseInitialized();
  const now = new Date().toISOString();

  // S'assurer que SARL VISTA DIGITAL et SARL GRAVURE PUB existent
  const existingVista = await db.companyProfiles.get(VISTA_DIGITAL_PROFILE_ID);
  const existingGravure = await db.companyProfiles.get(GRAVURE_PUB_PROFILE_ID);
  const vista = existingVista || buildDefaultVistaDigitalProfile(now);
  const gravure = existingGravure || buildDefaultGravurePubProfile(now);

  const bankBnaId = 'demo_bank_bna';
  const bankCpaId = 'demo_bank_cpa';
  const starClientId = 'demo_contact_star';
  const client1Id = 'demo_contact_c1';
  const client2Id = 'demo_contact_c2';
  const supplier1Id = 'demo_contact_s1';
  const both1Id = 'demo_contact_b1';

  const bookId = 'demo_chequebook_1';
  const serials = generateChequeSerialSequence('0012345', 25);
  const leaves = serials.map((num, idx) => ({
    id: `demo_leaf_${idx + 1}`,
    chequeBookId: bookId,
    bankAccountId: bankBnaId,
    chequeNumber: num,
    status: (idx === 0 ? 'encaisse' : idx === 1 ? 'remis' : 'disponible') as
      | 'encaisse'
      | 'remis'
      | 'disponible',
    outgoingChequeId: idx === 0 ? 'demo_ochq_1' : idx === 1 ? 'demo_ochq_2' : undefined,
    createdAt: now,
  }));

  // Facture modèle exacte 078/26 : SARL VISTA DIGITAL -> SARL STAR ADVERTISING
  const inv078Totals = computeInvoiceDocumentTotals([
    {
      id: 'l_078_1',
      description:
        'Impression & pose habillage façade publicitaire grand format\nCampagne CMP Coke Summer — Panneau LED & Bâche microperforée\nFormat : 15 × 10 m · Alger Centre',
      quantity: 150,
      unit: 'm²',
      unitPriceCentimes: 350000, // 3 500,00 DA
      discountPercent: 0,
      tvaRate: 19,
    },
  ]);

  const invGravureTotals = computeInvoiceDocumentTotals([
    {
      id: 'l_grav_1',
      description:
        'Habillage totem lumineux & découpe lettres relief PMMA\nSite Hydra — Face A + Face B',
      quantity: 2,
      unit: 'u',
      unitPriceCentimes: 9500000, // 95 000,00 DA
      discountPercent: 0,
      tvaRate: 19,
    },
  ]);

  const inv2Totals = computeInvoiceDocumentTotals([
    {
      id: 'l2',
      description: 'Location Unipol 12×4 m — Autoroute Est\nCampagne T4 2026',
      quantity: 2,
      unit: 'mois',
      unitPriceCentimes: 14500000, // 145 000,00 DA
      discountPercent: 5,
      tvaRate: 19,
    },
  ]);

  const supInv1Totals = computeInvoiceDocumentTotals([
    {
      id: 'sl1',
      description: 'Lot bâche PVC backlite & encre UV grand format',
      quantity: 10,
      unit: 'u',
      unitPriceCentimes: 1850000, // 18 500,00 DA
      discountPercent: 0,
      tvaRate: 19,
    },
  ]);

  await db.transaction(
    'rw',
    [
      db.settings,
      db.companyProfiles,
      db.contacts,
      db.campaigns,
      db.purchaseOrders,
      db.proformas,
      db.bankAccounts,
      db.chequeBooks,
      db.chequeLeaves,
      db.customerInvoices,
      db.supplierInvoices,
      db.payments,
      db.paymentAllocations,
      db.expenseCategories,
      db.expenses,
      db.incomingCheques,
      db.outgoingCheques,
      db.ledgerEntries,
      db.auditLogs,
    ],
    async () => {
      if (!existingVista) await db.companyProfiles.put(vista);
      if (!existingGravure) await db.companyProfiles.put(gravure);

      const useVistaIdentity =
        !settings.companyName ||
        settings.companyName === 'SARL Numidia Services (Démo)' ||
        settings.companyName === 'Entreprise principale';

      await db.settings.put({
        ...settings,
        activeCompanyProfileId: settings.activeCompanyProfileId || VISTA_DIGITAL_PROFILE_ID,
        companyScopeFilter: settings.companyScopeFilter || 'all',
        ...(useVistaIdentity
          ? {
              companyName: vista.name,
              logoDataUrl: vista.logoDataUrl,
              address: vista.address,
              phone: vista.phone,
              email: vista.email,
              nif: vista.nif,
              nis: vista.nis,
              rc: vista.rc,
              ai: vista.ai,
            }
          : {}),
        cashOpeningBalanceCentimes: 35000000,
        cashOpeningDate: '2026-01-01',
        invoiceNextSeq: 79,
        supplierInvoiceNextSeq: 2,
        onboardingCompleted: true,
        isDemoDataLoaded: true,
        updatedAt: now,
      });

      await db.contacts.bulkPut([
        {
          id: starClientId,
          type: 'client',
          name: 'Direction Marketing',
          company: 'SARL STAR ADVERTISING',
          address: '14 Rue Didouche Mourad, Alger Centre',
          postalCode: '16000',
          city: 'Alger',
          phone: '021 63 45 12',
          email: 'facturation@star-advertising.dz',
          nif: '001116098841281',
          nis: '',
          rc: '0988412 B11',
          ai: '16288053024',
          notes: 'Client modèle Excel N°078/26',
          archived: false,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: client1Id,
          type: 'client',
          name: 'Karim Benali',
          company: 'EURL Maghreb Bâtiment (Démo)',
          address: 'Cité 1200 Logements, Bab Ezzouar, Alger',
          postalCode: '16024',
          city: 'Alger',
          phone: '0550 12 34 56',
          email: 'k.benali@maghreb-batiment.example',
          nif: '002016011223344',
          nis: '002016011223300',
          rc: '16/00-0112233B20',
          ai: '16240112233',
          notes: 'Client historique — règlement à 30 jours',
          archived: false,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: client2Id,
          type: 'client',
          name: 'Nadia Mansouri',
          company: 'SPA Hydra Logistique (Démo)',
          address: 'Route de Dar El Beïda, Alger',
          postalCode: '16033',
          city: 'Alger',
          phone: '0661 45 78 90',
          email: 'comptabilite@hydra-logistique.example',
          nif: '001816055443322',
          nis: '001816055443300',
          rc: '16/00-0554433B18',
          ai: '16240554433',
          notes: '',
          archived: false,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: supplier1Id,
          type: 'fournisseur',
          name: 'Sofiane Khelifi',
          company: 'SARL Méca Import (Démo)',
          address: 'Zone d’activité Rouïba, Alger',
          postalCode: '16012',
          city: 'Alger',
          phone: '0770 88 99 11',
          email: 'ventes@meca-import.example',
          nif: '001716077889900',
          nis: '001716077889911',
          rc: '16/00-0778899B17',
          ai: '16240778899',
          notes: 'Fournisseur matières impression',
          archived: false,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: both1Id,
          type: 'les_deux',
          name: 'Yacine Haddad',
          company: 'SNC El Djazaïr Fournitures (Démo)',
          address: 'Blida Centre, Wilaya de Blida',
          postalCode: '09000',
          city: 'Blida',
          phone: '0552 33 44 55',
          email: 'contact@eldjazair-fournitures.example',
          nif: '002109033445566',
          nis: '002109033445500',
          rc: '09/00-0334455B21',
          ai: '09010334455',
          notes: 'Client et fournisseur de consommables',
          archived: false,
          createdAt: now,
          updatedAt: now,
        },
      ]);

      await db.campaigns.put({
        id: 'demo_cmp_coke',
        name: 'CMP Coke Summer',
        clientId: starClientId,
        startDate: '2026-07-05',
        endDate: '2026-09-05',
        status: 'terminee',
        notes: 'Campagne estivale grand format Alger',
        createdAt: now,
        updatedAt: now,
      });

      await db.purchaseOrders.put({
        id: 'demo_bc_38_26',
        direction: 'bc_recu',
        poNumber: '38/26/RL',
        companyProfileId: vista.id,
        issuerSnapshot: buildIssuerSnapshot(vista),
        contactId: starClientId,
        issueDate: '2026-07-01',
        campaignId: 'demo_cmp_coke',
        campaignRef: 'CMP Coke Summer',
        campaignStartDate: '2026-07-05',
        campaignEndDate: '2026-09-05',
        showCampaignOnPrint: true,
        currency: 'DZD',
        exchangeRate: 1,
        description: 'Habillage façade & campagne été',
        lines: inv078Totals.lines,
        totalHtCentimes: inv078Totals.totalHtCentimes,
        totalTvaCentimes: inv078Totals.totalTvaCentimes,
        totalTtcCentimes: inv078Totals.totalTtcCentimes,
        baseDzdTtcCentimes: inv078Totals.totalTtcCentimes,
        status: 'facture',
        linkedInvoiceIds: ['demo_cinv_078'],
        linkedProformaIds: [],
        notes: 'BC reçu du client SARL STAR ADVERTISING',
        createdAt: now,
        updatedAt: now,
      });

      await db.bankAccounts.bulkPut([
        {
          id: bankBnaId,
          bankName: 'SGA',
          accountName: 'Société Générale Algérie (SARL VISTA DIGITAL)',
          accountNumber: '02100007113003342211',
          rib: '021 00007113 00334 22 11',
          currency: 'DZD',
          openingBalanceCentimes: 245000000,
          openingDate: '2026-01-01',
          notes: 'Compte courant principal',
          active: true,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: bankCpaId,
          bankName: 'Fransabank',
          accountName: 'Fransabank El Djazaïr (SARL VISTA DIGITAL)',
          accountNumber: '03501602220200002080',
          rib: '035 01602 2202000020 80',
          currency: 'DZD',
          openingBalanceCentimes: 98000000,
          openingDate: '2026-01-01',
          notes: 'Compte secondaire',
          active: true,
          createdAt: now,
          updatedAt: now,
        },
      ]);

      await db.chequeBooks.put({
        id: bookId,
        bankAccountId: bankBnaId,
        startSerial: '0012345',
        count: 25,
        notes: 'Carnet SGA principal',
        createdAt: now,
      });

      await db.chequeLeaves.bulkPut(leaves);

      await db.customerInvoices.bulkPut([
        {
          id: 'demo_cinv_078',
          invoiceNumber: '078/26',
          companyProfileId: vista.id,
          issuerSnapshot: buildIssuerSnapshot(vista),
          clientId: starClientId,
          clientSnapshot: {
            company: 'SARL STAR ADVERTISING',
            name: 'Direction Marketing',
            address: '14 Rue Didouche Mourad, Alger Centre',
            postalCode: '16000',
            city: 'Alger',
            phone: '021 63 45 12',
            email: 'facturation@star-advertising.dz',
            nif: '001116098841281',
            rc: '0988412 B11',
            ai: '16288053024',
          },
          issueDate: '2026-08-20',
          dueDate: '2026-09-19',
          bcNumber: '38/26/RL',
          linkedBcRecuId: 'demo_bc_38_26',
          campaignId: 'demo_cmp_coke',
          campaignRef: 'CMP Coke Summer',
          campaignStartDate: '2026-07-05',
          campaignEndDate: '2026-09-05',
          showCampaignOnPrint: true,
          currency: 'DZD',
          exchangeRate: 1,
          description: 'Campagne CMP Coke Summer — SARL STAR ADVERTISING',
          lines: inv078Totals.lines,
          totalHtCentimes: inv078Totals.totalHtCentimes,
          totalTvaCentimes: inv078Totals.totalTvaCentimes,
          totalTtcCentimes: inv078Totals.totalTtcCentimes,
          baseDzdTtcCentimes: inv078Totals.totalTtcCentimes,
          status: 'impayee',
          notes: '',
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'demo_cinv_grav_1',
          invoiceNumber: '001/26',
          companyProfileId: gravure.id,
          issuerSnapshot: buildIssuerSnapshot(gravure),
          clientId: client1Id,
          clientSnapshot: {
            company: 'EURL Maghreb Bâtiment (Démo)',
            name: 'Karim Benali',
            address: 'Cité 1200 Logements, Bab Ezzouar, Alger',
            postalCode: '16024',
            city: 'Alger',
            phone: '0550 12 34 56',
            email: 'k.benali@maghreb-batiment.example',
            nif: '002016011223344',
            rc: '16/00-0112233B20',
            ai: '16240112233',
          },
          issueDate: '2026-10-15',
          dueDate: '2026-11-14',
          bcNumber: 'BC-442/26',
          campaignRef: 'Signalétique Hydra',
          showCampaignOnPrint: true,
          currency: 'DZD',
          exchangeRate: 1,
          description: 'Totems lumineux & découpe relief',
          lines: invGravureTotals.lines,
          totalHtCentimes: invGravureTotals.totalHtCentimes,
          totalTvaCentimes: invGravureTotals.totalTvaCentimes,
          totalTtcCentimes: invGravureTotals.totalTtcCentimes,
          baseDzdTtcCentimes: invGravureTotals.totalTtcCentimes,
          status: 'partielle',
          notes: '',
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'demo_cinv_2',
          invoiceNumber: '077/26',
          companyProfileId: vista.id,
          issuerSnapshot: buildIssuerSnapshot(vista),
          clientId: client2Id,
          issueDate: '2026-08-10',
          dueDate: '2026-09-10',
          bcNumber: 'BC-819/26',
          campaignRef: 'Réseau Autoroute Est',
          showCampaignOnPrint: true,
          currency: 'DZD',
          exchangeRate: 1,
          description: 'Location Unipol 12×4 m',
          lines: inv2Totals.lines,
          totalHtCentimes: inv2Totals.totalHtCentimes,
          totalTvaCentimes: inv2Totals.totalTvaCentimes,
          totalTtcCentimes: inv2Totals.totalTtcCentimes,
          baseDzdTtcCentimes: inv2Totals.totalTtcCentimes,
          status: 'impayee',
          notes: '',
          createdAt: now,
          updatedAt: now,
        },
      ]);

      await db.supplierInvoices.put({
        id: 'demo_sinv_1',
        invoiceNumber: 'FF-2026-0001',
        supplierRef: 'MI-908/2026',
        supplierId: supplier1Id,
        issueDate: '2026-10-20',
        dueDate: '2026-11-20',
        currency: 'DZD',
        exchangeRate: 1,
        description: 'Bâche PVC & consommables impression',
        lines: supInv1Totals.lines,
        totalHtCentimes: supInv1Totals.totalHtCentimes,
        totalTvaCentimes: supInv1Totals.totalTvaCentimes,
        totalTtcCentimes: supInv1Totals.totalTtcCentimes,
        baseDzdTtcCentimes: supInv1Totals.totalTtcCentimes,
        status: 'payee',
        notes: '',
        createdAt: now,
        updatedAt: now,
      });

      await db.payments.bulkPut([
        {
          id: 'demo_pay_1',
          direction: 'entrant',
          contactId: client1Id,
          date: '2026-10-25',
          amountCentimes: 10000000, // 100 000,00 DA
          currency: 'DZD',
          exchangeRate: 1,
          baseDzdAmountCentimes: 10000000,
          method: 'virement',
          bankAccountId: bankBnaId,
          reference: 'VIR-SGA-8821',
          notes: 'Acompte sur facture 001/26',
          isAdvance: false,
          status: 'valide',
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'demo_pay_2',
          direction: 'sortant',
          contactId: supplier1Id,
          date: '2026-10-28',
          amountCentimes: supInv1Totals.totalTtcCentimes,
          currency: 'DZD',
          exchangeRate: 1,
          baseDzdAmountCentimes: supInv1Totals.totalTtcCentimes,
          method: 'cheque',
          bankAccountId: bankBnaId,
          chequeId: 'demo_ochq_1',
          reference: 'CHQ 0012345',
          notes: 'Règlement intégral FF-2026-0001',
          isAdvance: false,
          status: 'valide',
          createdAt: now,
          updatedAt: now,
        },
      ]);

      await db.paymentAllocations.bulkPut([
        {
          id: 'demo_alloc_1',
          paymentId: 'demo_pay_1',
          invoiceType: 'client',
          invoiceId: 'demo_cinv_grav_1',
          amountCentimes: 10000000,
          createdAt: now,
        },
        {
          id: 'demo_alloc_2',
          paymentId: 'demo_pay_2',
          invoiceType: 'fournisseur',
          invoiceId: 'demo_sinv_1',
          amountCentimes: supInv1Totals.totalTtcCentimes,
          createdAt: now,
        },
      ]);

      await db.outgoingCheques.bulkPut([
        {
          id: 'demo_ochq_1',
          bankAccountId: bankBnaId,
          chequeBookId: bookId,
          chequeLeafId: 'demo_leaf_1',
          chequeNumber: '0012345',
          beneficiary: 'SARL Méca Import (Démo)',
          contactId: supplier1Id,
          issueDate: '2026-10-28',
          amountCentimes: supInv1Totals.totalTtcCentimes,
          currency: 'DZD',
          exchangeRate: 1,
          baseDzdAmountCentimes: supInv1Totals.totalTtcCentimes,
          purpose: 'Règlement facture fournisseur MI-908/2026',
          linkedType: 'fournisseur_facture',
          linkedId: 'demo_sinv_1',
          clearingDate: '2026-11-02',
          status: 'encaisse',
          notes: '',
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'demo_ochq_2',
          bankAccountId: bankBnaId,
          chequeBookId: bookId,
          chequeLeafId: 'demo_leaf_2',
          chequeNumber: '0012346',
          beneficiary: 'Propriétaire Atelier Bouzareah',
          issueDate: '2026-11-05',
          amountCentimes: 12000000,
          currency: 'DZD',
          exchangeRate: 1,
          baseDzdAmountCentimes: 12000000,
          purpose: 'Loyer atelier novembre 2026',
          linkedType: 'depense',
          linkedId: 'demo_exp_2',
          status: 'remis',
          notes: 'Chèque remis, en attente d’encaissement',
          createdAt: now,
          updatedAt: now,
        },
      ]);

      await db.incomingCheques.put({
        id: 'demo_ichq_1',
        clientId: client2Id,
        issuerBank: 'BEA',
        chequeNumber: '0077891',
        chequeDate: '2026-11-10',
        entryDate: '2026-11-11',
        amountCentimes: 15000000,
        currency: 'DZD',
        exchangeRate: 1,
        baseDzdAmountCentimes: 15000000,
        targetBankAccountId: bankCpaId,
        depositDate: '2026-11-12',
        status: 'depose',
        allocatedInvoiceIds: ['demo_cinv_2'],
        notes: 'En attente de compensation',
        createdAt: now,
        updatedAt: now,
      });

      await db.expenses.bulkPut([
        {
          id: 'demo_exp_1',
          date: '2026-11-03',
          beneficiary: 'Station Naftal Bouzareah',
          categoryId: 'cat-transport',
          categoryName: 'Transport & carburant',
          description: 'Carburant équipes pose panneaux',
          amountCentimes: 1850000,
          currency: 'DZD',
          exchangeRate: 1,
          baseDzdAmountCentimes: 1850000,
          paymentMethod: 'especes',
          bankAccountId: null,
          reference: 'BON-NAF-112',
          notes: '',
          status: 'valide',
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'demo_exp_2',
          date: '2026-11-05',
          beneficiary: 'Propriétaire Atelier Bouzareah',
          categoryId: 'cat-loyer',
          categoryName: 'Loyer & charges',
          description: 'Loyer mensuel atelier novembre 2026',
          amountCentimes: 12000000,
          currency: 'DZD',
          exchangeRate: 1,
          baseDzdAmountCentimes: 12000000,
          paymentMethod: 'cheque',
          bankAccountId: bankBnaId,
          chequeLeafId: 'demo_leaf_2',
          outgoingChequeId: 'demo_ochq_2',
          reference: 'CHQ 0012346',
          notes: 'Payé par chèque — non débité tant que non encaissé',
          status: 'valide',
          createdAt: now,
          updatedAt: now,
        },
      ]);

      await db.ledgerEntries.bulkPut([
        {
          id: 'demo_led_open_cash',
          date: '2026-01-01',
          direction: 'entree',
          sourceType: 'solde_ouverture',
          sourceId: 'cash_opening',
          bankAccountId: null,
          label: 'Solde d’ouverture Caisse espèces',
          amountCentimes: 35000000,
          currency: 'DZD',
          exchangeRate: 1,
          baseDzdAmountCentimes: 35000000,
          status: 'valide',
          createdAt: now,
        },
        {
          id: 'demo_led_open_bna',
          date: '2026-01-01',
          direction: 'entree',
          sourceType: 'solde_ouverture',
          sourceId: bankBnaId,
          bankAccountId: bankBnaId,
          label: 'Solde d’ouverture SGA',
          amountCentimes: 245000000,
          currency: 'DZD',
          exchangeRate: 1,
          baseDzdAmountCentimes: 245000000,
          status: 'valide',
          createdAt: now,
        },
        {
          id: 'demo_led_open_cpa',
          date: '2026-01-01',
          direction: 'entree',
          sourceType: 'solde_ouverture',
          sourceId: bankCpaId,
          bankAccountId: bankCpaId,
          label: 'Solde d’ouverture Fransabank',
          amountCentimes: 98000000,
          currency: 'DZD',
          exchangeRate: 1,
          baseDzdAmountCentimes: 98000000,
          status: 'valide',
          createdAt: now,
        },
        {
          id: 'demo_led_pay_1',
          date: '2026-10-25',
          direction: 'entree',
          sourceType: 'paiement_client',
          sourceId: 'demo_pay_1',
          bankAccountId: bankBnaId,
          contactId: client1Id,
          label: 'Virement reçu EURL Maghreb Bâtiment (001/26)',
          amountCentimes: 10000000,
          currency: 'DZD',
          exchangeRate: 1,
          baseDzdAmountCentimes: 10000000,
          status: 'valide',
          createdAt: now,
        },
        {
          id: 'demo_led_ochq_1',
          date: '2026-11-02',
          direction: 'sortie',
          sourceType: 'cheque_emis_encaisse',
          sourceId: 'demo_ochq_1',
          bankAccountId: bankBnaId,
          contactId: supplier1Id,
          label: 'Chèque émis encaissé 0012345 — SARL Méca Import',
          amountCentimes: supInv1Totals.totalTtcCentimes,
          currency: 'DZD',
          exchangeRate: 1,
          baseDzdAmountCentimes: supInv1Totals.totalTtcCentimes,
          status: 'valide',
          createdAt: now,
        },
        {
          id: 'demo_led_exp_1',
          date: '2026-11-03',
          direction: 'sortie',
          sourceType: 'depense',
          sourceId: 'demo_exp_1',
          bankAccountId: null,
          label: 'Dépense espèces — Carburant équipes pose panneaux',
          amountCentimes: 1850000,
          currency: 'DZD',
          exchangeRate: 1,
          baseDzdAmountCentimes: 1850000,
          status: 'valide',
          createdAt: now,
        },
      ]);
    }
  );

  await recordAudit({
    action: 'CREATION',
    entityType: 'donnees_demo',
    entityId: 'demo_dataset',
    summary: 'Chargement des données de démonstration (SARL VISTA DIGITAL & SARL GRAVURE PUB)',
  });
}

export async function clearDemoData(): Promise<void> {
  const settings = await ensureDatabaseInitialized();
  const now = new Date().toISOString();

  await db.transaction(
    'rw',
    [
      db.settings,
      db.contacts,
      db.campaigns,
      db.purchaseOrders,
      db.proformas,
      db.bankAccounts,
      db.chequeBooks,
      db.chequeLeaves,
      db.customerInvoices,
      db.supplierInvoices,
      db.payments,
      db.paymentAllocations,
      db.expenseCategories,
      db.expenses,
      db.incomingCheques,
      db.outgoingCheques,
      db.ledgerEntries,
      db.auditLogs,
    ],
    async () => {
      await Promise.all([
        db.contacts.where('id').startsWith('demo_').delete(),
        db.campaigns.where('id').startsWith('demo_').delete(),
        db.purchaseOrders.where('id').startsWith('demo_').delete(),
        db.proformas.where('id').startsWith('demo_').delete(),
        db.bankAccounts.where('id').startsWith('demo_').delete(),
        db.chequeBooks.where('id').startsWith('demo_').delete(),
        db.chequeLeaves.where('id').startsWith('demo_').delete(),
        db.customerInvoices.where('id').startsWith('demo_').delete(),
        db.supplierInvoices.where('id').startsWith('demo_').delete(),
        db.payments.where('id').startsWith('demo_').delete(),
        db.paymentAllocations.where('id').startsWith('demo_').delete(),
        db.expenses.where('id').startsWith('demo_').delete(),
        db.incomingCheques.where('id').startsWith('demo_').delete(),
        db.outgoingCheques.where('id').startsWith('demo_').delete(),
        db.ledgerEntries.where('id').startsWith('demo_').delete(),
      ]);

      const catCount = await db.expenseCategories.count();
      if (catCount === 0) {
        await db.expenseCategories.bulkPut(
          DEFAULT_EXPENSE_CATEGORIES.map((c) => ({ ...c, createdAt: now }))
        );
      }

      const remainingClientInvoices = await db.customerInvoices.count();
      const remainingSupplierInvoices = await db.supplierInvoices.count();

      await db.settings.put({
        ...settings,
        cashOpeningBalanceCentimes:
          settings.cashOpeningBalanceCentimes === 35000000 ? 0 : settings.cashOpeningBalanceCentimes,
        invoiceNextSeq: remainingClientInvoices === 0 ? 1 : settings.invoiceNextSeq,
        supplierInvoiceNextSeq: remainingSupplierInvoices === 0 ? 1 : settings.supplierInvoiceNextSeq,
        isDemoDataLoaded: false,
        updatedAt: now,
      });
    }
  );

  await recordAudit({
    action: 'ANNULATION',
    entityType: 'donnees_demo',
    entityId: 'demo_dataset',
    summary: 'Suppression des données de démonstration',
  });
}
