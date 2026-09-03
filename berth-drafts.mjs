// Confirmed berth limits carried forward from completed port-call reports.
// A blank result intentionally requires the operator to confirm and enter it.
const normalize = value => String(value || '')
  .toUpperCase()
  .replace(/\s+/g, '')
  .replace(/#/g, '')
  .replace(/[^A-Z0-9()]/g, '');

const limits = new Map([
  ['OP6', '10.20M'], ['JSTT3', '11.25M'], ['OTK(S)', '11.30M'],
  ['P64', '11.00M'], ['CTK', '10.30M'], ['P63', '11.00M'],
  ['JSTTSP5', '12.35M'], ['SBTS1', '14.40M'], ['UTT', '10.30M'],
  ['SK3', '11.80M'], ['P22', '11.00M'], ['P42', '10.20M'], ['NLB1', '12.70M'],
]);

export function maxDraftForBerth(berth) {
  return limits.get(normalize(berth)) || '';
}
