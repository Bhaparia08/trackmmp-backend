/**
 * Seed script: historical invoices
 * Run: node scripts/seed_historical_invoices.js
 *
 * Normalisation rules applied:
 *  - Dates: "8th January 2024" → "2024-01-08"
 *  - Status: received/recieved/recevied → "received", pending → "pending",
 *            cancelled → "cancelled", partially … → "partial"
 *  - Currency: $ → USD, INR/₹ → INR, Euro → EUR
 *  - Entity: SG/blank → "sg", IN/INDIA/Indian → "in"
 *  - European amounts: "$1.221,26" → 1221.26, "$77,25" → 77.25
 *  - US amounts: "$13,018.60" → 13018.60
 *  - Rows with no data (blank invoice number) → skipped
 *  - AM/2025/074/077 → stored as "AM/2025/074" (compound number)
 */

// Can be run standalone:  node scripts/seed_historical_invoices.js
// Or called from init.js: require('./scripts/seed_historical_invoices').seed(db)

/* ── helpers ──────────────────────────────────────────────────────────────── */

const MONTHS = {
  january:1,february:2,march:3,april:4,may:5,june:6,
  july:7,august:8,september:9,october:10,november:11,december:12,
  jan:1,feb:2,mar:3,apr:4,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12,
};

function parseDate(raw) {
  if (!raw || !raw.trim()) return null;
  const s = raw.trim()
    .replace(/(\d+)(st|nd|rd|th)/gi, '$1')  // remove ordinal suffixes
    .replace(/[-–]/g, ' ')
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ');

  // Try YYYY-MM-DD directly
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // patterns: "8 January 2024", "January 8 2024", "9 Jan 2026", "2 april 2026"
  const parts = s.split(' ').filter(Boolean);
  if (parts.length >= 3) {
    let day, month, year;
    // detect which part is numeric day, which is month name, which is year
    for (let i = 0; i < parts.length; i++) {
      if (/^\d{4}$/.test(parts[i])) { year = parseInt(parts[i]); }
      else if (/^\d{1,2}$/.test(parts[i]) && !day) { day = parseInt(parts[i]); }
      else if (MONTHS[parts[i].toLowerCase()]) { month = MONTHS[parts[i].toLowerCase()]; }
    }
    if (day && month && year) {
      return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    }
  }
  return null;
}

function parseAmount(raw, currency) {
  if (!raw || !raw.trim() || raw.trim() === '-') return 0;
  let s = raw.trim()
    .replace(/^\$|USD|INR|₹|Euro|EUR/gi,'')
    .trim();

  // European notation: "1.221,26" or "77,25" (comma is decimal, period is thousands)
  // US notation: "13,018.60" (comma is thousands, period is decimal)
  // Heuristic: if string has both . and , and , appears AFTER ., → US notation
  //            if string has both . and , and . appears AFTER , → European notation
  //            if string has only , with exactly 2 decimals after → European decimal
  //            if string has only , as thousands separator → US
  const hasDot   = s.includes('.');
  const hasComma = s.includes(',');

  if (hasDot && hasComma) {
    const lastDot   = s.lastIndexOf('.');
    const lastComma = s.lastIndexOf(',');
    if (lastComma > lastDot) {
      // European: e.g. "1.221,26" → remove dots, replace comma with dot
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      // US: e.g. "13,018.60" → remove commas
      s = s.replace(/,/g, '');
    }
  } else if (hasComma && !hasDot) {
    // Could be European decimal ("77,25") or US thousands ("1,500")
    const parts = s.split(',');
    if (parts.length === 2 && parts[1].length <= 2) {
      // "77,25" → European decimal
      s = s.replace(',', '.');
    } else {
      // "1,500" → US thousands
      s = s.replace(/,/g, '');
    }
  }
  // else only dots or neither → parse as-is

  const n = parseFloat(s);
  return isNaN(n) ? 0 : Math.round(n * 100) / 100;
}

function parseCurrency(raw) {
  if (!raw) return 'USD';
  const s = raw.trim().toUpperCase();
  if (s.includes('INR') || s.includes('₹')) return 'INR';
  if (s.includes('EUR') || s.includes('EURO')) return 'EUR';
  return 'USD';
}

function parseEntity(raw) {
  if (!raw) return 'sg';
  const s = raw.trim().toUpperCase();
  if (s === 'IN' || s.includes('INDIA') || s === 'INDIAN') return 'in';
  return 'sg';
}

function parseStatus(raw) {
  if (!raw || !raw.trim()) return 'pending';
  const s = raw.trim().toLowerCase();
  if (s.startsWith('partial')) return 'partial';
  if (s === 'received' || s === 'recieved' || s === 'recevied' || s === 'received ') return 'received';
  if (s === 'cancelled' || s === 'canceled') return 'cancelled';
  return 'pending';
}

function parseInvNumber(raw) {
  if (!raw || !raw.trim()) return null;
  // Handle "AM/2025/074/077" → take first part
  return raw.trim().split('/').slice(0,3).join('/');
}

/* ── raw data ─────────────────────────────────────────────────────────────── */

// Format: [invoice_number, client_name, issue_date, payment_date, amount_raw, currency_raw, status_raw, entity_raw, notes]
const RAW_2024 = [
  ['AM/2024/001','Exness (SC) Ltd (Dec)','8th January 2024','22nd January 2024','820$','USD','Received','SG',''],
  ['AM/2024/002','Shuhari Tech Ventures Private Limited (Dec)','17th January 2024','2nd February 2024','4240 INR','INR','Pending','IN',''],
  ['AM/2024/003','Moneycat Financing Inc. (Moneycat PH)(Oct)','23rd January 2024','8th February 2024','340$','USD','Received','IN',''],
  ['AM/2024/004','Moneycat Financing Inc. (Moneycat PH)(Nov)','23rd January 2024','8th February 2024','70$','USD','Received','IN',''],
  ['AM/2024/005','Moneycat Financing Inc. (Moneycat PH Dec)','23rd January 2024','8th February 2024','1235$','USD','Received','IN',''],
  ['AM/2024/006','Lendtop Company Limited (Moneycat VN)(Sep)','23rd January 2024','8th February 2024','30$','USD','Pending','IN',''],
  ['AM/2024/007','Lendtop Company Limited (Moneycat VN)(Oct)','23rd January 2024','8th February 2024','10$','USD','Pending','IN',''],
  ['AM/2024/008','Lendtop Company Limited (Moneycat VN)(Dec)','23rd January 2024','8th February 2024','10$','USD','Pending','IN',''],
  ['AM/2024/009','Monolith App (Portugal) Sociedade Unipessoal Lda (Token)','23rd January 2024','8th February 2024','187$','USD','Pending','SG',''],
  ['AM/2024/010','Naumard LTD','5th February 2024','20th February 2024','200$','USD','Received','SG',''],
  ['AM/2024/011','Exness (SC) Ltd (Jan)','12th Feb 2024','28th February 2024','460$','USD','Received','SG',''],
  ['AM/2024/012','Moneycat Financing Inc. (Moneycat PH Jan)','12th Feb 2024','28th February 2024','104$','USD','Pending','SG',''],
  ['AM/2024/013','Fabiano Ricardo de Mello Oliveira (Hike) (November)','19th Feb 2024','04th March 2024','52$','USD','Pending','SG',''],
  ['AM/2024/014','Advanced Software Decisions Limited (Adkey) (Jan)','26th February 2024','11th March 2024','1750$','USD','Cancelled','SG',''],
  ['AM/2024/015','Exness (SC) Ltd (Feb)','7th March 2024','23rd March 2024','670$','USD','Received','SG',''],
  ['AM/2024/016','Exness (SC) Ltd (Feb)','20th March 2024','5th April 2024','80$','USD','Cancelled','SG',''],
  ['AM/2024/017','Exmo Exchange Ltd.','20th March 2024','5th April 2024','84$','USD','Pending','SG',''],
  ['AM/2024/018','Exmo Exchange Ltd.','20th March 2024','5th April 2024','250$','USD','Pending','SG',''],
  ['AM/2024/019','Advanced Software Decisions Limited (Adkey) (Jan)','28th March 2024','12th April 2024','299$','USD','Received','SG',''],
  ['AM/2024/020','Digido Finance Corp. (nov23, Feb24, Mar24)','18th April 2024','3rd May 2024','237$','USD','Received','SG',''],
  ['AM/2024/021','Diginfluenz Pvt Ltd (Niyo Global) (March 2024)','18th April 2024','3rd May 2024','12000 INR','INR','Received','IN','GST 2160, Total 14160'],
  ['AM/2024/022','Advanced Software Decisions Limited (Adkey) (March)','3rd May 2024','22nd May 2024','386.5$','USD','Received','SG',''],
  ['AM/2024/023','Exness (SC) Ltd (March & April)','3rd May 2024','22nd May 2024','710$','USD','Received','SG',''],
  ['AM/2024/024','APAD LLC','21st May 2024','5th June 2024','1500$','USD','Received','SG',''],
  ['AM/2024/025','Monolith App (Portugal) Sociedade Unipessoal Lda (Token)','24th May 2024','24th May 2024','624$','USD','Received','IN',''],
  ['AM/2024/026','Monolith App (Portugal) Sociedade Unipessoal Lda (Token)','24th May 2024','24th May 2024','187$','USD','Received','IN',''],
  ['AM/2024/027','Fabiano Ricardo de Mello Oliveira (Hike) (April)','04th June 2024','19th June 2024','828$','USD','Received','SG',''],
  ['AM/2024/028','APAD LLC','12th June 2024','26th June 2024','2325$','USD','Received','SG',''],
  ['AM/2024/029','TechSolutions Group N.V. (22Bet) (April)','12th June 2024','26th June 2024','140$','USD','Pending','SG',''],
  ['AM/2024/030','FINANCE TECHNOLOGIES INC. (Pitacash)(May)','1st July 2024','15th July 2024','70$','USD','Received','SG',''],
  ['AM/2024/031','Fabiano Ricardo de Mello Oliveira (Hike) (May)','1st July 2024','15th July 2024','636.98$','USD','Cancelled','SG',''],
  ['AM/2024/032','Adcanopus Digital Media Private Limited (May 2024)','3rd July 2024','17th July 2024','12531 INR','INR','Received','SG','GST 2256, Total 14787 INR'],
  ['AM/2024/033','Advanced Software Decisions Limited (Adkey) (March)','3rd July 2024','17th July 2024','64$','USD','Pending','SG',''],
  ['AM/2024/034','APAD LLC','9th July 2024','24th July 2024','6625$','USD','Received','SG',''],
  ['AM/2024/035','Greyhat LLC (Supernova) (June)','24th July 2024','09th August 2024','150$','USD','Received','SG',''],
  ['AM/2024/036','Fabiano Ricardo de Mello Oliveira (Hike) (June)','29th July 2024','14th August 2024','1560$','USD','Cancelled','SG',''],
  ['AM/2024/037','Magictap Solutions Private Limited','09th August 2024','24th August 2024','85208 INR','INR','Received','IN','GST 15337.44, Total 100545.44 INR'],
  ['AM/2024/038','Adcanopus Digital Media Private Limited (June 2024)','09th August 2024','24th August 2024','12047.88 INR','INR','Received','IN','GST 2168.61, Total 14216.49 INR'],
  ['AM/2024/039','Fabiano Ricardo de Mello Oliveira (Hike) (May)','13th August 2024','27th August 2024','828.28$','USD','Received','SG',''],
  ['AM/2024/040','Fabiano Ricardo de Mello Oliveira (Hike) (June)','13th August 2024','27th August 2024','1368.98$','USD','Received','SG',''],
  ['AM/2024/041','Exness (SC) Ltd (May)','26th August 2024','10th September 2024','90$','USD','Received','SG',''],
  ['AM/2024/042','Exness (SC) Ltd (June)','26th August 2024','10th September 2024','60$','USD','Received','SG',''],
  ['AM/2024/043','Exness (SC) Ltd (July)','26th August 2024','10th September 2024','210$','USD','Received','SG',''],
  ['AM/2024/044','Fabiano Ricardo de Mello Oliveira (Hike) (July)','27th August 2024','11th September 2024','1760$','USD','Received','SG',''],
  ['AM/2024/045','Exness (SC) Ltd (August)','02nd September 2024','16th September 2024','250$','USD','Received','SG',''],
  ['AM/2024/046','Value Leaf Services India Pvt Ltd (July)','06th September 2024','20th September 2024','6270 INR','INR','Received','IN','GST 1128.60, Total 7398.60 INR'],
  ['AM/2024/047','Greyhat LLC (Supernova) (July & August)','1st October 2024','15th October 2024','363$','USD','Pending','SG',''],
  ['AM/2024/048','Value Leaf Services India Pvt Ltd (August)','3rd October 2024','17th October 2024','4200 INR','INR','Received','IN','GST 756.00, Total 4956.00 INR'],
  ['AM/2024/049','Value Leaf Services India Pvt Ltd (September)','5th November 2024','20th November 2024','8100 INR','INR','Received','IN','GST 1458.00, Total 9558.00 INR'],
  ['AM/2024/050','Kreon Financial Services Limited (Stucred) (October)','5th November 2024','20th November 2024','7200 INR','INR','Received','IN','GST 1296.00, Total 8496.00 INR'],
  ['AM/2024/051','MobSuccess SAS (Farly)(September)','5th November 2024','20th November 2024','190$','USD','Cancelled','SG',''],
  ['AM/2024/052','Exness (SC) Ltd (November)','3rd December 2024','3rd January 2025','610$','USD','Received','SG',''],
  ['AM/2024/053','APAD LLC (Appgrade)','3rd December 2024','3rd January 2025','1038$','USD','Received','SG',''],
  ['AM/2024/054','FOREGON S.A. (Boosterads)','3rd December 2024','3rd January 2025','215$','USD','Pending','SG',''],
  ['AM/2024/055','Nordvpn','10th December 2024','10th January 2025','1050$','USD','Received','SG',''],
  ['AM/2024/056','Value Leaf Services India Pvt Ltd (July)','10th December 2024','10th January 2025','1050 INR','INR','Received','IN','GST 189.00, Total 1139 INR'],
  ['AM/2024/057','APAD LLC (Appgrade)','16th December 2024','16th January 2025','1070$','USD','Received','SG',''],
  ['AM/2024/058','SW3 International LLC (Adaction/Adgrowth BR)','19th December 2024','19th January 2025','3478.5$','USD','Received','SG',''],
  ['AM/2024/059','BITCOINFORME SL (Bit2me)','23rd December 2024','23rd January 2025','200 Euro','EUR','Received','SG',''],
  ['AM/2024/060','Value Leaf Services India Pvt Ltd (December)','27th December 2024','27th January 2025','1400 INR','INR','Received','IN','GST 252.00, Total 1652 INR'],
];

const RAW_2025_P1 = [
  // Row 1: note: invoice date says 27th Dec 2025 but it's the first 2025 invoice — likely Dec 2024
  ['AM/2025/062','Boosterads (FOREGON S.A.)','27th Dec 2024','27th Feb 2025','56.50$','USD','Received','SG',''],
  ['AM/2025/063','MobUpps','9th Jan 2025','9th Feb 2025','205$','USD','Received','SG',''],
  ['AM/2025/064','Nutson Inc (Cheele)','14th Jan 2025','14th Feb 2025','207$','USD','Received','SG',''],
  ['AM/2025/065','Fabiano Ricardo (Hike)','9th Jan 2025','9th Feb 2025','437.06$','USD','Received','SG',''],
  ['AM/2025/066','Adcanopus (Tax ID: B-38-4109636-1)','21st Jan 2025','31st Jan 2025','3120$','USD','Pending','SG',''],
  ['AM/2025/067','Greyhat LLC (Supernova)','21st Jan 2025','31st Jan 2025','42$','USD','Pending','SG',''],
  ['AM/2025/068','Boosterads (FOREGON S.A.)','3rd Feb 2025','25th Feb 2025','344.80$','USD','Received','SG',''],
  ['AM/2025/069','GRADIENTT.TECH LTD (GRADIENTT)','3rd Feb 2025','25th Feb 2025','98$','USD','Pending','SG',''],
  ['AM/2025/070','Fabiano Ricardo (Hike)','5th Feb 2025','28th Feb 2025','852.13$','USD','Received','SG',''],
  ['AM/2025/071','IVT Communication F2c LLC (Click2money)','11th Feb 2025','5th Mar 2025','936.86$','USD','Received','SG',''],
  ['AM/2025/072','One Engine Media Works PTE. LTD','12th Feb 2025','5th Mar 2025','1041$','USD','Pending','SG',''],
  ['AM/2025/073','Nordvpn (Jan)','10th Feb 2025','5th March 2025','3180$','USD','Received','SG',''],
  ['AM/2025/074','APAD LLC (Appgrade)','10th Feb 2025','5th March 2025','461$','USD','Received','SG',''],
  ['AM/2025/075','Nordvpn (Dec)','10th Feb 2025','5th March 2025','2470$','USD','Received','SG',''],
  ['AM/2025/076','Boosterads (FOREGON S.A.)','1st March 2025','15th March 2025','139.75$','USD','Received','SG',''],
  ['AM/2025/077','IVT Communication F2c LLC (Click2money)','10th March 2025','25th March 2025','451.44$','USD','Received','SG',''],
  ['AM/2025/078','Nordvpn (Feb)','10th March 2025','30th March 2025','830$','USD','Received','SG',''],
  ['AM/2025/079','Ava Trade Markets Limited','10th March 2025','15th March 2025','1500$','USD','Received','SG',''],
  ['AM/2025/080','Digido Finance Corp.','11th March 2025','11th April 2025','140$','USD','Received','SG',''],
  ['AM/2025/081','GRADIENTT.TECH LTD (GRADIENTT)','20th March 2025','31st March 2025','1054.50$','USD','Received','SG',''],
  ['AM/2025/082','Zenmobile','27th Feb 2025','31st March 2025','92$','USD','Pending','SG',''],
  ['AM/2025/083','Boosterads (FOREGON S.A.)','25th March 2025','25th April 2025','128$','USD','Received','SG',''],
  ['AM/2025/084','Mobupps','25th March 2025','25th April 2025','7465$','USD','Received','SG',''],
  ['AM/2025/085','One Engine Media Works PTE. LTD','26th March 2025','25th April 2025','420$','USD','Received','SG',''],
  ['AM/2025/086','Mobisaturn','26th March 2025','25th April 2025','643$','USD','Received','SG',''],
  ['AM/2025/087','Intellectads','26th March 2025','25th April 2025','168$','USD','Pending','SG',''],
  ['AM/2025/088','Fabiano Ricardo (Hike)','1st April 2025','20th April 2025','8866.75$','USD','partial','SG','Partially received 5000, balance outstanding'],
  ['AM/2025/089','Nordvpn s.a.','10th April 2025','10th May 2025','2090$','USD','Received','SG',''],
  ['AM/2025/090','Digido Finance Corp.','10th April 2025','10th May 2025','308$','USD','Received','SG',''],
  ['AM/2025/091','FORESYTE, INC.','10th April 2025','10th May 2025','150$','USD','Pending','SG',''],
  ['AM/2025/092','Mobupps (March)','29th April 2025','15th May 2025','13018.60$','USD','Received','SG',''],
  ['AM/2025/093','Adcanopus (Feb)','29th April 2025','15th May 2025','780$','USD','Pending','SG',''],
  ['AM/2025/094','Adcanopus (March)','29th April 2025','15th May 2025','910$','USD','Pending','SG',''],
  ['AM/2025/095','GRADIENTT.TECH LTD (GRADIENTT)','30th April 2025','20th May 2025','522$','USD','Received','SG',''],
  ['AM/2025/096','Mobisaturn','29th April 2025','29th May 2025','2002$','USD','Received','SG',''],
  ['AM/2025/097','Nordvpn s.a.','14th May 2025','14th June 2025','1610$','USD','Received','SG',''],
  ['AM/2025/098','One Engine Media Works PTE. LTD','29th April 2025','29th May 2025','420$','USD','Received','SG',''],
  ['AM/2025/099','IVT Communication F2c LLC (Click2money)','20th May 2025','20th June 2025','642.88$','USD','Received','SG',''],
  ['AM/2025/100','Digido Finance Corp.','20th May 2025','20th June 2025','280$','USD','Pending','SG',''],
  ['AM/2025/101','FORESYTE','6th May 2025','6th June 2025','200$','USD','Pending','SG',''],
  ['AM/2025/102','Mobisummer','12th May 2025','12th June 2025','95.96$','USD','Pending','SG',''],
  ['AM/2025/103','GRADIENTT','20th May 2025','20th June 2025','44$','USD','Received','SG',''],
  ['AM/2025/104','Tomiko LLC','20th May 2025','20th June 2025','144$','USD','Pending','SG',''],
  ['AM/2025/105','MEDIALINKS','28th May 2025','28th June 2025','540$','USD','Received','SG',''],
  ['AM/2025/106','Fabiano Ricardo (Hike)','29th May 2025','29th June 2025','6289.24$','USD','Pending','SG',''],
  ['AM/2025/107','Fabiano Ricardo (Hike)','29th May 2025','29th June 2025','522.34$','USD','Pending','SG',''],
  ['AM/2025/108','Fabiano Ricardo (Hike)','29th May 2025','29th May 2025','36$','USD','Pending','SG',''],
  ['AM/2025/109','IVT Communication F2c LLC (Click2money)','9th June 2025','9th July 2025','484.59$','USD','Received','SG',''],
  ['AM/2025/110','Mobupps','29th May 2025','29th June 2025','11793.20$','USD','Received','SG',''],
  ['AM/2025/111','Nordvpn (May)','9th June 2025','9th July 2025','3870$','USD','Received','SG',''],
  ['AM/2025/112','Mobupps','25th June 2025','25th July 2025','8602.40$','USD','Received','SG',''],
  ['AM/2025/113','GRADIENTT.TECH LTD (GRADIENTT)','20th June 2025','20th July 2025','1300$','USD','Received','SG',''],
  ['AM/2025/114','IVT Communication F2c LLC (Click2money)','3rd July 2025','3rd Aug 2025','785.17$','USD','Received','SG',''],
  ['AM/2025/115','Nordvpn (June)','11th July 2025','11th Aug 2025','6060$','USD','Received','SG',''],
  ['AM/2025/116','MEDIALINKS','10th July 2025','10th Aug 2025','41.30$','USD','Pending','SG',''],
  ['AM/2025/117','OJO7 LLC','15th July 2025','15th Aug 2025','276.93$','USD','Received','SG',''],
  ['AM/2025/118','IVT Communication F2c LLC (Click2money)','23rd July 2025','23rd August 2025','743.84$','USD','Pending','SG',''],
  ['AM/2025/119','GRADIENTT.TECH LTD','23rd July 2025','23rd August 2025','1484.02$','USD','Received','SG',''],
  ['AM/2025/120','Mobupps','29th July 2025','20th August 2025','15789.70$','USD','partial','SG','Partially received, balance $9496'],
  ['AM/2025/121','Nordvpn (July)','8th August 2025','8th Sept 2025','10140$','USD','Received','SG',''],
  ['AM/2025/122','Adgrowth (SW3 International LLC)','11th Aug 2025','11th Sept 2025','152.80$','USD','Pending','SG',''],
  ['AM/2025/123','Mobisaturn','19th August 2025','19th Sept 2025','55575.64','INR','Received','IN',''],
  ['AM/2025/124','Mobisaturn','19th August 2025','19th Sept 2025','25323.31','INR','Received','IN',''],
  ['AM/2025/125','OJO7 LLC','20th Aug 2025','20th Sept 2025','1221.26$','USD','Received','SG',''],
  ['AM/2025/126','Travelstart Online Travel','20th Aug 2025','20th Sept 2025','168$','USD','Pending','SG',''],
  ['AM/2025/127','Affluxo Global B.V.','20th Aug 2025','20th Sept 2025','5188.25$','USD','Received','SG',''],
  ['AM/2025/128','IVT Communication F2c LLC (Click2money)','21st Aug 2025','21st Sept 2025','295.59$','USD','Pending','SG',''],
  ['AM/2025/129','Digido','9th June 2025','9th July 2025','84$','USD','Pending','SG',''],
  ['AM/2025/130','Nordvpn (August)','9th Sept 2025','8th October 2025','10550$','USD','Received','SG',''],
  ['AM/2025/131','Adgrowth (SW3 International LLC)','12th Sept 2025','12th October 2025','276$','USD','Pending','SG',''],
  ['AM/2025/132','Mobupps','3rd Sept 2025','3rd October 2025','1469.95$','USD','Received','SG',''],
  ['AM/2025/133','OJO7','18th Sept 2025','18th October 2025','832.32$','USD','Received','SG',''],
  ['AM/2025/134','IVT Communication F2c LLC (Click2money)','19th Sept 2025','19th October 2025','531.28$','USD','Pending','SG',''],
  ['AM/2025/135','Zorka Mobi Ltd.','24th Sept 2025','24th October 2025','288$','USD','Pending','SG',''],
  ['AM/2025/136','GRADIENTT.TECH LTD','29th Sept 2025','29th October 2025','77.25$','USD','Pending','SG',''],
  ['AM/2025/137','Mobisaturn','29th Sept 2025','29th October 2025','39331.81','INR','Received','IN',''],
  ['AM/2025/138','One Engine Media Works PTE. LTD','29th Sept 2025','29th October 2025','160$','USD','Pending','SG',''],
  ['AM/2025/139','Mobupps','29th Sept 2025','29th October 2025','447.63$','USD','Received','SG',''],
  ['AM/2025/140','Nordvpn','9th October 2025','9th November 2025','7300$','USD','Received','SG',''],
  ['AM/2025/141','Adgrowth','10th October 2025','10th November 2025','170.00$','USD','Pending','SG',''],
  ['AM/2025/142','OJO7','17th October 2025','17th November 2025','848.88$','USD','Pending','SG',''],
  ['AM/2025/143','Click2money','23rd October 2025','19th November 2025','400.41$','USD','Pending','SG',''],
  ['AM/2025/144','Affluxo Global B.V.','4th Nov 2025','4th Dec 2025','343$','USD','Received','SG',''],
  ['AM/2025/145','Supernova','5th Nov 2025','5th Dec 2025','248$','USD','Pending','SG',''],
  ['AM/2025/146','Catalyst (IPE PUBLICIDADE)','4th Nov 2025','4th Dec 2025','974.85$','USD','Pending','SG',''],
  ['AM/2025/147','Nordvpn','8th Nov 2025','8th Dec 2025','8290$','USD','Received','SG',''],
  ['AM/2025/148','One Engine Media Works PTE. LTD','14th Nov 2025','14th Dec 2025','80$','USD','Pending','SG',''],
  ['AM/2025/149','OJO7 LLC','14th Nov 2025','14th Dec 2025','1335.73$','USD','Pending','SG',''],
];

const RAW_2025_P2_AND_2026 = [
  ['AM/2025/150','Adgrowth (SW3 International LLC)','18th Nov 2025','18th Dec 2025','46.90$','USD','Pending','SG','Oct'],
  ['AM/2025/151','Value Leaf Services India Pvt Ltd','10th Nov 2025','10th Dec 2025','12220','INR','Pending','IN','GST 2199.60, Total 14319.60 INR'],
  ['AM/2025/152','Gowithmedia (1DEGREE)','25th Nov 2025','25th Dec 2025','305$','USD','Pending','SG',''],
  ['AM/2025/153','GRADIENTT.TECH LTD','28th Nov 2025','28th Dec 2025','47.25$','USD','Pending','SG',''],
  ['AM/2025/154','Affluxo Global B.V.','25th Nov 2025','25th Dec 2025','294$','USD','Received','SG',''],
  ['AM/2025/155','Nordvpn s.a.','11th Dec 2025','11th Jan 2026','4250$','USD','Pending','SG',''],
  ['AM/2025/156','Adgrowth (SW3 International LLC)','12th Dec 2025','12th Jan 2026','63$','USD','Pending','SG','Nov'],
  ['AM/2025/157','OJO7 LLC','10th Dec 2025','10th Jan 2026','1010.65$','USD','Pending','SG',''],
  ['AM/2025/158','Catalyst (IPE PUBLICIDADE PROMOCAO E MARKETING LTDA)','10th Dec 2025','10th Jan 2026','4000$','USD','Received','SG',''],
  ['AM/2025/159','Tomiko LLC','22nd Dec 2025','22nd Jan 2026','90$','USD','Pending','SG',''],
  ['AM/2025/160','GRADIENTT.TECH LTD','23rd Dec 2025','23rd Jan 2026','170.54$','USD','Pending','SG',''],
  ['AM/2025/161','Zorka Mobi Ltd.','22nd Dec 2025','22nd Dec 2026','190$','USD','Pending','SG',''],
  ['AM/2026/162','Gowithmedia (1DEGREE)','9th Jan 2026','9th Feb 2026','266$','USD','Pending','SG',''],
  ['AM/2026/163','Catalyst (IPE PUBLICIDADE PROMOCAO E MARKETING LTDA)','9th Jan 2026','9th Feb 2026','7215.80$','USD','Received','SG',''],
  ['AM/2026/164','Nordvpn s.a.','13th Jan 2026','13th Feb 2026','5650$','USD','Received','SG',''],
  ['AM/2026/165','Adgrowth (SW3 International LLC)','15th Jan 2026','15th Feb 2026','2290.88$','USD','Pending','SG',''],
  ['AM/2026/166','OJO7 LLC','16th Jan 2026','16th Feb 2026','1158.58$','USD','Pending','SG',''],
  ['AM/2026/167','Catalyst (IPE PUBLICIDADE PROMOCAO E MARKETING LTDA)','3rd Feb 2026','3rd Mar 2026','6391.80$','USD','Received','SG',''],
  ['AM/2026/168','Nordvpn s.a.','9th Feb 2026','9th Mar 2026','4640$','USD','Received','SG',''],
  ['AM/2026/169','IVT COMMUNICATIONS FZC LLC (C2M / afinaaff)','27th Jan 2026','27th Feb 2026','372$','USD','Pending','SG',''],
  ['AM/2026/170','OJO7 LLC','16th Feb 2026','16th Mar 2026','1176$','USD','Pending','SG',''],
  ['AM/2026/171','TechWave B.V. (22bet)','16th Feb 2026','16th Mar 2026','1146$','USD','Pending','SG',''],
  ['AM/2026/172','Nordvpn s.a.','13th Jan 2026','13th Feb 2026','2330$','USD','Received','SG',''],
  ['AM/2026/173','Catalyst (IPE PUBLICIDADE PROMOCAO E MARKETING LTDA)','2nd April 2026','2nd May 2026','5404$','USD','Pending','SG',''],
  ['AM/2026/174','TechWave B.V. (22bet)','18th Mar 2026','18th Apr 2026','280$','USD','Pending','SG',''],
  ['AM/2026/175','Adgrowth (SW3 International LLC)','','','','USD','Pending','SG',''],
  ['AM/2026/176','Nordvpn s.a.','13th April 2026','4th May 2026','2810$','USD','Pending','SG',''],
  ['AM/2026/177','Supernova (Greyhat LLC)','','','','USD','Pending','SG',''],
];

const ALL_ROWS = [...RAW_2024, ...RAW_2025_P1, ...RAW_2025_P2_AND_2026];

/* ── exported seed function (called from init.js migration) ──────────────── */
function seed(db) {
  const insert = db.prepare(`
    INSERT OR REPLACE INTO historical_invoices
      (invoice_number, client_name, entity, issue_date, payment_date, amount, currency, status, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let ok = 0, skipped = 0;

  const run = db.transaction(() => {
    for (const [inv_no, client, issue_raw, pay_raw, amt_raw, curr_raw, status_raw, entity_raw, notes] of ALL_ROWS) {
      const invoice_number = parseInvNumber(inv_no);
      if (!invoice_number) { skipped++; continue; }

      const currency     = parseCurrency(curr_raw + ' ' + (amt_raw || ''));
      const amount       = parseAmount(amt_raw, currency);
      const entity       = parseEntity(entity_raw);
      const status       = parseStatus(status_raw);
      const issue_date   = parseDate(issue_raw);
      const payment_date = parseDate(pay_raw);

      insert.run(invoice_number, client, entity, issue_date, payment_date, amount, currency, status, notes || '');
      ok++;
    }
  });

  run();
  console.log(`[seed] historical_invoices: inserted/replaced ${ok}, skipped ${skipped}`);
  return ok;
}

module.exports = { seed };

/* ── standalone: node scripts/seed_historical_invoices.js ───────────────── */
if (require.main === module) {
  require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
  const db = require('../db/init');
  seed(db);
  const count = db.prepare('SELECT COUNT(*) AS c FROM historical_invoices').get().c;
  console.log(`[seed] Total rows in historical_invoices: ${count}`);
}
