/**
 * Pricing engine — the same maths as the _CalEngine sheets.
 *
 *   Net incl. VAT  (per channel formula, see FORMULA in Config.gs)
 *   Net ex VAT  = Net incl. VAT ÷ (1 + VAT)
 *   Gain        = Net ex VAT − Cost
 *   %MU         = Gain ÷ Net ex VAT          (margin on the net selling price)
 *   Indicator   < 18% ขาดทุน | ≤ 20% VERY LOW | ≤ 25% LOW | > 25% OKAY
 *
 * Pure functions: no sheet access, so they can be unit-tested outside Apps Script.
 */

/**
 * @param {{normalPrice:?number, specialPrice:number, discounts:number[], cost:?number}} input
 * @param {{formula:string}} channel
 * @param {{VAT_RATE:number, MU_LOSS_BELOW:number, MU_VERY_LOW_MAX:number, MU_LOW_MAX:number}} settings
 */
function calcPricing_(input, channel, settings) {
  var special = Number(input.specialPrice);
  var normal = input.normalPrice === null || input.normalPrice === undefined ? null : Number(input.normalPrice);
  var keep = (input.discounts || []).reduce(function (acc, d) { return acc * (1 - (Number(d) || 0)); }, 1);

  var netInc;
  if (channel.formula === FORMULA.GP_ON_NORMAL && normal !== null && normal > 0) {
    netInc = normal * keep - (normal - special);
  } else {
    netInc = special * keep;
  }
  var netEx = netInc / (1 + settings.VAT_RATE);
  var cost = input.cost === null || input.cost === undefined || input.cost === '' ? null : Number(input.cost);

  var result = {
    netIncVat: round_(netInc, 2),
    netExVat: round_(netEx, 2),
    cost: cost === null ? null : round_(cost, 2),
    gain: null,
    mu: null,
    indicator: INDICATOR.NO_COST
  };
  if (cost === null || !(cost > 0)) return result;

  result.gain = round_(netEx - cost, 2);
  result.mu = netEx > 0 ? round_((netEx - cost) / netEx, 4) : -1;
  result.indicator = indicatorFor_(result.mu, settings);
  return result;
}

function indicatorFor_(mu, s) {
  if (mu === null || mu === undefined) return INDICATOR.NO_COST;
  if (mu < s.MU_LOSS_BELOW) return INDICATOR.LOSS;
  if (mu <= s.MU_VERY_LOW_MAX) return INDICATOR.VERY_LOW;
  if (mu <= s.MU_LOW_MAX) return INDICATOR.LOW;
  return INDICATOR.OKAY;
}

/** Warnings shown to the supervisor next to a line. */
function flagsFor_(line, product) {
  var flags = [];
  if (!product) flags.push('สินค้าไม่อยู่ในฐานข้อมูล');
  else if (!(product.cost > 0)) flags.push('ไม่มีต้นทุน');
  if (line.normalPrice > 0 && line.specialPrice > line.normalPrice) flags.push('ราคาพิเศษสูงกว่าราคาปกติ');
  return flags;
}
