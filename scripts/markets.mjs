// Markets tracked by the dashboard.
//
// bis   – REF_AREA code in the BIS central bank policy rate dataset (WS_CBPOL)
// fred  – FRED series id for the 10-year government bond yield (monthly average,
//         sourced by FRED from the OECD Main Economic Indicators). null where
//         no reliable free series exists.
export const REGIONS = [
  { id: 'americas', name: 'Americas' },
  { id: 'europe', name: 'Europe' },
  { id: 'apac', name: 'Asia-Pacific' },
  { id: 'mea', name: 'Middle East & Africa' },
];

export const MARKETS = [
  { id: 'US', name: 'United States', region: 'americas', bank: 'Federal Reserve', bis: 'US', fred: 'IRLTLT01USM156N' },
  { id: 'CA', name: 'Canada', region: 'americas', bank: 'Bank of Canada', bis: 'CA', fred: 'IRLTLT01CAM156N' },
  { id: 'MX', name: 'Mexico', region: 'americas', bank: 'Banco de México', bis: 'MX', fred: 'IRLTLT01MXM156N' },
  { id: 'BR', name: 'Brazil', region: 'americas', bank: 'Banco Central do Brasil', bis: 'BR', fred: null },

  { id: 'EA', name: 'Euro Area', region: 'europe', bank: 'European Central Bank', bis: 'XM', fred: 'IRLTLT01EZM156N' },
  { id: 'GB', name: 'United Kingdom', region: 'europe', bank: 'Bank of England', bis: 'GB', fred: 'IRLTLT01GBM156N' },
  { id: 'CH', name: 'Switzerland', region: 'europe', bank: 'Swiss National Bank', bis: 'CH', fred: 'IRLTLT01CHM156N' },
  { id: 'SE', name: 'Sweden', region: 'europe', bank: 'Sveriges Riksbank', bis: 'SE', fred: 'IRLTLT01SEM156N' },
  { id: 'NO', name: 'Norway', region: 'europe', bank: 'Norges Bank', bis: 'NO', fred: 'IRLTLT01NOM156N' },

  { id: 'JP', name: 'Japan', region: 'apac', bank: 'Bank of Japan', bis: 'JP', fred: 'IRLTLT01JPM156N' },
  { id: 'CN', name: 'China', region: 'apac', bank: "People's Bank of China", bis: 'CN', fred: null },
  { id: 'IN', name: 'India', region: 'apac', bank: 'Reserve Bank of India', bis: 'IN', fred: 'INDIRLTLT01STM' },
  { id: 'KR', name: 'South Korea', region: 'apac', bank: 'Bank of Korea', bis: 'KR', fred: 'IRLTLT01KRM156N' },
  { id: 'AU', name: 'Australia', region: 'apac', bank: 'Reserve Bank of Australia', bis: 'AU', fred: 'IRLTLT01AUM156N' },
  { id: 'NZ', name: 'New Zealand', region: 'apac', bank: 'Reserve Bank of New Zealand', bis: 'NZ', fred: 'IRLTLT01NZM156N' },
  { id: 'HK', name: 'Hong Kong SAR', region: 'apac', bank: 'Hong Kong Monetary Authority', bis: 'HK', fred: null },

  { id: 'ZA', name: 'South Africa', region: 'mea', bank: 'South African Reserve Bank', bis: 'ZA', fred: 'IRLTLT01ZAM156N' },
  { id: 'SA', name: 'Saudi Arabia', region: 'mea', bank: 'Saudi Central Bank', bis: 'SA', fred: null },
];
