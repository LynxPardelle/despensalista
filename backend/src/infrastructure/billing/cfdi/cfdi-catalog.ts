export interface FiscalCatalogEntry {
  code: string;
  label: string;
  individual: boolean;
  organization: boolean;
}

export interface CfdiUseCatalogEntry extends FiscalCatalogEntry {
  regimes: readonly string[];
}

// Anexo 20, SAT: c_RegimenFiscal (v1, rev. 0) and c_UsoCFDI (v2, rev. 0).
// http://omawww.sat.gob.mx/tramitesyservicios/Paginas/documentos/catCFDI_V_4_20261106.xls
// The income invoice request excludes the uses for payroll and payment receipts.
const generalExpenseRegimes = [
  '601',
  '603',
  '606',
  '612',
  '620',
  '621',
  '622',
  '623',
  '624',
  '625',
  '626',
] as const;
const personalDeductionRegimes = [
  '605',
  '606',
  '607',
  '608',
  '611',
  '612',
  '614',
  '615',
  '625',
] as const;

export const cfdiCatalog: {
  regimes: readonly FiscalCatalogEntry[];
  uses: readonly CfdiUseCatalogEntry[];
} = {
  regimes: [
    {
      code: '601',
      label: 'General de Ley Personas Morales',
      individual: false,
      organization: true,
    },
    {
      code: '603',
      label: 'Personas Morales con Fines no Lucrativos',
      individual: false,
      organization: true,
    },
    {
      code: '605',
      label: 'Sueldos y Salarios e Ingresos Asimilados a Salarios',
      individual: true,
      organization: false,
    },
    {
      code: '606',
      label: 'Arrendamiento',
      individual: true,
      organization: false,
    },
    {
      code: '607',
      label: 'Régimen de Enajenación o Adquisición de Bienes',
      individual: true,
      organization: false,
    },
    {
      code: '608',
      label: 'Demás ingresos',
      individual: true,
      organization: false,
    },
    {
      code: '610',
      label:
        'Residentes en el Extranjero sin Establecimiento Permanente en México',
      individual: true,
      organization: true,
    },
    {
      code: '611',
      label: 'Ingresos por Dividendos (socios y accionistas)',
      individual: true,
      organization: false,
    },
    {
      code: '612',
      label: 'Personas Físicas con Actividades Empresariales y Profesionales',
      individual: true,
      organization: false,
    },
    {
      code: '614',
      label: 'Ingresos por intereses',
      individual: true,
      organization: false,
    },
    {
      code: '615',
      label: 'Régimen de los ingresos por obtención de premios',
      individual: true,
      organization: false,
    },
    {
      code: '616',
      label: 'Sin obligaciones fiscales',
      individual: true,
      organization: false,
    },
    {
      code: '620',
      label:
        'Sociedades Cooperativas de Producción que optan por diferir sus ingresos',
      individual: false,
      organization: true,
    },
    {
      code: '621',
      label: 'Incorporación Fiscal',
      individual: true,
      organization: false,
    },
    {
      code: '622',
      label: 'Actividades Agrícolas, Ganaderas, Silvícolas y Pesqueras',
      individual: false,
      organization: true,
    },
    {
      code: '623',
      label: 'Opcional para Grupos de Sociedades',
      individual: false,
      organization: true,
    },
    {
      code: '624',
      label: 'Coordinados',
      individual: false,
      organization: true,
    },
    {
      code: '625',
      label:
        'Régimen de las Actividades Empresariales con ingresos a través de Plataformas Tecnológicas',
      individual: true,
      organization: false,
    },
    {
      code: '626',
      label: 'Régimen Simplificado de Confianza',
      individual: true,
      organization: true,
    },
  ],
  uses: [
    {
      code: 'G01',
      label: 'Adquisición de mercancías',
      individual: true,
      organization: true,
      regimes: generalExpenseRegimes,
    },
    {
      code: 'G02',
      label: 'Devoluciones, descuentos o bonificaciones',
      individual: true,
      organization: true,
      regimes: [...generalExpenseRegimes, '616'],
    },
    {
      code: 'G03',
      label: 'Gastos en general',
      individual: true,
      organization: true,
      regimes: generalExpenseRegimes,
    },
    {
      code: 'I01',
      label: 'Construcciones',
      individual: true,
      organization: true,
      regimes: generalExpenseRegimes,
    },
    {
      code: 'I02',
      label: 'Mobiliario y equipo de oficina por inversiones',
      individual: true,
      organization: true,
      regimes: generalExpenseRegimes,
    },
    {
      code: 'I03',
      label: 'Equipo de transporte',
      individual: true,
      organization: true,
      regimes: generalExpenseRegimes,
    },
    {
      code: 'I04',
      label: 'Equipo de computo y accesorios',
      individual: true,
      organization: true,
      regimes: generalExpenseRegimes,
    },
    {
      code: 'I05',
      label: 'Dados, troqueles, moldes, matrices y herramental',
      individual: true,
      organization: true,
      regimes: generalExpenseRegimes,
    },
    {
      code: 'I06',
      label: 'Comunicaciones telefónicas',
      individual: true,
      organization: true,
      regimes: generalExpenseRegimes,
    },
    {
      code: 'I07',
      label: 'Comunicaciones satelitales',
      individual: true,
      organization: true,
      regimes: generalExpenseRegimes,
    },
    {
      code: 'I08',
      label: 'Otra maquinaria y equipo',
      individual: true,
      organization: true,
      regimes: generalExpenseRegimes,
    },
    {
      code: 'D01',
      label: 'Honorarios médicos, dentales y gastos hospitalarios',
      individual: true,
      organization: false,
      regimes: personalDeductionRegimes,
    },
    {
      code: 'D02',
      label: 'Gastos médicos por incapacidad o discapacidad',
      individual: true,
      organization: false,
      regimes: personalDeductionRegimes,
    },
    {
      code: 'D03',
      label: 'Gastos funerales',
      individual: true,
      organization: false,
      regimes: personalDeductionRegimes,
    },
    {
      code: 'D04',
      label: 'Donativos',
      individual: true,
      organization: false,
      regimes: personalDeductionRegimes,
    },
    {
      code: 'D05',
      label:
        'Intereses reales efectivamente pagados por créditos hipotecarios (casa habitación)',
      individual: true,
      organization: false,
      regimes: personalDeductionRegimes,
    },
    {
      code: 'D06',
      label: 'Aportaciones voluntarias al SAR',
      individual: true,
      organization: false,
      regimes: personalDeductionRegimes,
    },
    {
      code: 'D07',
      label: 'Primas por seguros de gastos médicos',
      individual: true,
      organization: false,
      regimes: personalDeductionRegimes,
    },
    {
      code: 'D08',
      label: 'Gastos de transportación escolar obligatoria',
      individual: true,
      organization: false,
      regimes: personalDeductionRegimes,
    },
    {
      code: 'D09',
      label:
        'Depósitos en cuentas para el ahorro, primas que tengan como base planes de pensiones',
      individual: true,
      organization: false,
      regimes: personalDeductionRegimes,
    },
    {
      code: 'D10',
      label: 'Pagos por servicios educativos (colegiaturas)',
      individual: true,
      organization: false,
      regimes: personalDeductionRegimes,
    },
    {
      code: 'S01',
      label: 'Sin efectos fiscales',
      individual: true,
      organization: true,
      regimes: [
        '601',
        '603',
        '605',
        '606',
        '607',
        '608',
        '610',
        '611',
        '612',
        '614',
        '615',
        '616',
        '620',
        '621',
        '622',
        '623',
        '624',
        '625',
        '626',
      ],
    },
  ],
};
