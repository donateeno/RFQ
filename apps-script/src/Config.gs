/**
 * RFQ Price Approval — configuration.
 *
 * Everything a supervisor/admin may want to change lives in the APP_* sheets
 * (APP_Settings, APP_Channels, APP_Users). The values below are only the
 * defaults written by setupApp() the first time.
 */

var APP_NAME = 'RFQ Price Approval';

var SHEET = {
  REQUESTS: 'APP_Requests',
  PRODUCTS: 'APP_Products',
  CHANNELS: 'APP_Channels',
  USERS: 'APP_Users',
  SETTINGS: 'APP_Settings',
  LOG: 'APP_Log'
};

/** Column order of each APP_ sheet. Code reads by header name, so admins may reorder. */
var HEADERS = {};
HEADERS[SHEET.REQUESTS] = [
  'ReqId', 'BatchId', 'Channel', 'Brand', 'Customer', 'Project', 'Note',
  'ProductKey', 'ProductName', 'Qty', 'NormalPrice', 'SpecialPrice',
  'Disc1', 'Disc2', 'Disc3',
  'Cost', 'NetIncVat', 'NetExVat', 'Gain', 'MU', 'Indicator',
  'Status', 'StartDate', 'EndDate', 'Requester', 'RequestedAt',
  'DecidedBy', 'DecidedAt', 'DecisionComment', 'Flags', 'Source'
];
HEADERS[SHEET.PRODUCTS] = ['Brand', 'Key', 'Name', 'Cost', 'NormalPrice', 'Source', 'UpdatedAt'];
HEADERS[SHEET.CHANNELS] = [
  'ChannelId', 'Name', 'Brand', 'IdPrefix', 'Formula',
  'Disc1Label', 'Disc1Default', 'Disc1Editable',
  'Disc2Label', 'Disc2Default', 'Disc2Editable',
  'Disc3Label', 'Disc3Default', 'Disc3Editable',
  'Active', 'Description'
];
HEADERS[SHEET.USERS] = ['Email', 'Name', 'Role', 'Active'];
HEADERS[SHEET.SETTINGS] = ['Key', 'Value', 'Description'];
HEADERS[SHEET.LOG] = ['At', 'User', 'Action', 'ReqIds', 'Detail'];

var ROLE = { SALES: 'SALES', SUPERVISOR: 'SUPERVISOR', ADMIN: 'ADMIN' };

var STATUS = {
  PENDING: 'Pending',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
  CLOSED: 'Closed' // legacy rows that expired without a decision
};

var INDICATOR = {
  OKAY: 'OKAY',
  LOW: 'LOW',
  VERY_LOW: 'VERY LOW',
  LOSS: 'ขาดทุน',
  NO_COST: 'NO COST'
};

/**
 * Formulas (copied from the existing _CalEngine sheets):
 *  MULTIPLY      Net(incl VAT) = Special × (1−D1) × (1−D2) × (1−D3)            [GT EVE, GT FOSTER, BT FOSTER]
 *  GP_ON_NORMAL  Net(incl VAT) = Normal × (1−D1)(1−D2)(1−D3) − (Normal − Special) [BT EVE]
 */
var FORMULA = { MULTIPLY: 'MULTIPLY', GP_ON_NORMAL: 'GP_ON_NORMAL' };

var DEFAULT_SETTINGS = [
  ['VAT_RATE', 0.07, 'VAT used to convert net price to ex-VAT'],
  ['MU_LOSS_BELOW', 0.18, '%MU below this = ขาดทุน'],
  ['MU_VERY_LOW_MAX', 0.20, '%MU up to this = VERY LOW'],
  ['MU_LOW_MAX', 0.25, '%MU up to this = LOW (above = OKAY)'],
  ['DEFAULT_VALIDITY_DAYS', 30, 'Default days between start and end date'],
  ['MAX_VALIDITY_DAYS', 90, 'Longest validity a requester may choose'],
  ['ALLOWED_DOMAIN', 'eve.co.th', 'Only emails from this domain may use the app'],
  ['NOTIFY_EMAILS', '', 'Extra emails (comma separated) told about new requests. Supervisors/Admins in APP_Users are always notified.'],
  ['PRODUCT_SOURCE_SPREADSHEET_ID', '', 'Spreadsheet holding _Cost&Price and _CalDummy. Blank = this spreadsheet.'],
  ['LEGACY_BT_SPREADSHEET_ID', '1cXsyFStsrDcZ2NUrSMlmn7F8kpBDhTZA6oUE-MxJXYM', 'RFQ PriceGroup BT file, used by importLegacy()']
];

var BT_GP = 0.278304; // BT GP + MKT fee, from "Pricing Calculation RFQ.BT"

var DEFAULT_CHANNELS = [
  ['GT_EVE', 'GT – EVE', 'EVE', 'GT.', FORMULA.MULTIPLY,
    'ส่วนลด GP', 0.18, true, 'ส่วนลด 2', 0, true, 'ส่วนลด 3', 0, true, true,
    'ร้านค้า / โครงการ GT สินค้า EVE'],
  ['GT_FOSTER', 'GT – FOSTER', 'FOSTER', 'GT.FOSTER.', FORMULA.MULTIPLY,
    'ส่วนลด GP', 0.18, true, 'ส่วนลด 2', 0, true, 'ส่วนลด 3', 0, true, true,
    'ร้านค้า / โครงการ GT สินค้า FOSTER (ใช้ Foster Code)'],
  ['BT_EVE', 'บุญถาวร – EVE', 'EVE', 'BT.', FORMULA.GP_ON_NORMAL,
    'GP + MKT FEE (BT)', BT_GP, false, '', 0, false, '', 0, false, true,
    'บุญถาวร สินค้า EVE — GP คิดจากราคาขายปกติ แล้วหักส่วนต่างราคาพิเศษ'],
  ['BT_FOSTER', 'บุญถาวร – FOSTER', 'FOSTER', 'BTFOSTER.', FORMULA.MULTIPLY,
    'GP + MKT FEE (BT)', BT_GP, false, '', 0, false, '', 0, false, true,
    'บุญถาวร สินค้า FOSTER (ใช้ Foster Code)']
];

var DEFAULT_USERS = [
  ['akrawat@eve.co.th', 'Akrawat', ROLE.ADMIN, true],
  ['pak.m@eve.co.th', 'Pak', ROLE.SUPERVISOR, true]
];

var TIMEZONE = 'Asia/Bangkok';
