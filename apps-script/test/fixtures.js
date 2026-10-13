/**
 * Synthetic data shaped exactly like the real sheets (column positions match the
 * production file) but with made-up costs, so no real cost data lives in the repo.
 */
'use strict';

const BT_ID = '1cXsyFStsrDcZ2NUrSMlmn7F8kpBDhTZA6oUE-MxJXYM';

function day(offset) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return d;
}
function ddmmyy(d) {
  return String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getFullYear() % 100).padStart(2, '0');
}

const COST_PRICE = [
  ["EVE's Model", 'ราคาต้นทุนนำเข้า/หน่วย', 'Promotion Price', '', 'MODEL NAME', 'COST', 'GT HOTPRICE', '', 'REF. CODE', 'MODEL DESCRIPTION', 'SMGCOST', 'Retail Price'],
  ['HC-DEMO-90', 7000, 19990, '', 'HC-DEMO-90', 7100, 18990, '', '1144061', 'S1000 SINK 440x500 1RH/B', 3300, 7590],
  ['SINK-DEMO 760/510', 3000, 7990, '', 'SET-A + SET-B', 5200, 8990, '', '2451090', 'GHOST HOOD 90 cm', 60000, 147590],
  ['FAUCET-DEMO', 1500, 3990, '', '#N/A', '', '', '', '1129000', 'S1000 SINK 290x500', 2700, 6390],
  ['NOCOST-ITEM', '', 2990, '', '', '', '', '', '', '', '', '']
];

const CAL_DUMMY = [
  ['DUMMY SET NAME', 'SKUs1', 'COST1', 'SKUs2', 'COST2', 'SKUs3', 'COST3', 'SKUs4', 'COST4', 'SKUs5', 'COST5', 'Total Cost', '', 'PRICE1', 'PRICE2', 'PRICE3', 'PRICE4', 'PRICE5', 'TOTAL PRICE'],
  ['HC-DEMO-90 + FAUCET-DEMO', 'HC-DEMO-90', 7000, 'FAUCET-DEMO', 1500, 'NON', 0, 'NON', 0, 'NON', 0, 8500, '', 19990, 3990, '', '', '', 23980],
  ['#N/A', '', '', '', '', '', '', '', '', '', '', '#N/A', '', '', '', '', '', '', '#N/A']
];

function gtHeader(fosterCode) {
  return ['Req. Id.', 'เริ่มโปรฯ', 'สิ้นสุดโปร', 'ชื่อคู่ค้า / ร้านค้า', 'สาขา / ชื่อโครงการ', fosterCode ? 'Foster Code' : 'หมายเหตุ / #Tag', 'ชื่อสินค้า',
    'ขายปกติ', 'ราคาขายพิเศษสุทธิ', 'ส่วนลด GP', 'ส่วนลด 2', 'ส่วนลด 3', '%MU Indicator', '', 'STATUS', 'Decision Date', 'Approved By', 'Requester', 'Request Date'];
}

function gtEve() {
  const old = day(-120), recent = day(-5);
  return [
    gtHeader(false),
    // approved long ago, text dates like the real sheet
    ['GT.0001', ddmmyy(old), ddmmyy(day(-90)), 'ต.สุขภัณฑ์', 'โครงการหน้าร้าน', '78 ชุดส่งครั้งเดียว', 'HC-DEMO-90', 18990, 16990, 0.18, 0, 0, 'OKAY', '', 'Approve', day(-119), 'pak.m@eve.co.th', 'akrawat@eve.co.th', old],
    // undecided but still valid -> Pending
    ['GT.0002', recent, ddmmyy(day(25)), 'CSC', 'โครงการหน้าร้าน', '', 'SINK-DEMO 760/510', 7990, 6990, 0.2, 0.1, '', 'OKAY', '', '', '', '', 'sales1@eve.co.th', recent],
    // undecided and expired; discounts typed as 800%/300% by mistake -> Closed + converted
    ['GT.0003', old, ddmmyy(day(-90)), 'ต.สุขภัณฑ์', 'โครงการเอส เอ็นเอส', 'โครงการต่อเนื่อง', 'FAUCET-DEMO', '', 3500, 8, 3, 0, 'OKAY', '', '', '', '', 'natthawat@eve.co.th', ddmmyy(old)],
    // unknown product, invalid start text ("#VALUE!" in real sheet)
    ['GT.0004', '#VALUE!', '#VALUE!', 'เลอ', 'Online', '', 'MYSTERY ITEM', 9990, 15184, 0.25, 0, 0, 'OKAY', '', 'Approve', day(-100), 'pak.m@eve.co.th', 'akrawat@eve.co.th', ddmmyy(day(-101))],
    ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '']
  ];
}

function gtFoster() {
  const d = day(-3);
  return [
    gtHeader(true),
    ['GT.FOSTER.0001', ddmmyy(d), ddmmyy(day(27)), 'ปาริชาติ', 'โชว์รูมอีฟนวมินทร์', '2451090', 'GHOST HOOD 90 cm', 147590, 120000, 0.18, 0, 0, 'OKAY', '', 'Approve', day(-2), 'pak.m@eve.co.th', 'araya.k@eve.co.th', d]
  ];
}

function btEve() {
  return [
    ['Req. Id.', 'เริ่มโปรฯ', 'สิ้นสุดโปร', 'ชื่อโปรฯ / Tagline', 'สาขา', 'Remark', 'ชื่อสินค้า', 'ขายปกติ', 'ราคาขายพิเศษสุทธิ', '%MU Indicator', '', 'STATUS', 'Decision Date', 'Approved By', 'Requester'],
    ['BT.0001', day(-10), day(20), 'Flash sale', 'รัชดา', '', 'HC-DEMO-90', 18990, 16990, 'OKAY', '', 'Approve', day(-9), 'akrawat@eve.co.th', 'akrawat@eve.co.th']
  ];
}

function btFoster() {
  return [
    ['Req. Id.', 'เริ่มโปรฯ', 'สิ้นสุดโปร', 'ชื่อโปรฯ / Tagline', 'สาขา', 'Ref.Code', 'ชื่อสินค้า', 'ขายปกติ', 'ราคาขายพิเศษสุทธิ', '%MU Indicator', '', 'STATUS', 'Decision Date', 'Approved By', 'Requester', '#Tag'],
    ['BTFOSTER.0001', day(-1), day(29), 'TEST', 'บางนา', '1129000', 'S1000 SINK 290x500', 6390, 6300, 'OKAY', '', 'Pending', '', '', 'sales1@eve.co.th', 'ลูกค้าเก่า']
  ];
}

/** Seeds the source sheets and runs setupApp() as the owner. */
function seed(env, opts) {
  opts = opts || {};
  env.active.addSheet('_Cost&Price', COST_PRICE);
  env.active.addSheet('_CalDummy', CAL_DUMMY);
  env.active.addSheet('GT.EVE_RFQ', gtEve());
  env.active.addSheet('GT.FOSTER_RFQ', gtFoster());
  const bt = env.addBook(BT_ID);
  bt.addSheet('BT.EVE_RFQ', btEve());
  bt.addSheet('BT.FOSTER_RFQ', btFoster());
  env.call('akrawat@eve.co.th', 'setupApp');
  if (opts.import) env.call('akrawat@eve.co.th', 'importLegacy');
  return env;
}

module.exports = { seed, day, ddmmyy, BT_ID };
