const REGIONS = [
  { region: "Butembo", regionCode: "Bbbb" },
  { region: "China", regionCode: "Cnnn" },
];

const REGION_CODE_MAP = { Butembo: "Bbbb", China: "Cnnn" };
const VALID_REGIONS = REGIONS.map((r) => r.region);
const VALID_REGION_CODES = REGIONS.map((r) => r.regionCode);

function isValidRegionPair(region, regionCode) {
  return REGION_CODE_MAP[region] === regionCode;
}

module.exports = {
  REGIONS,
  REGION_CODE_MAP,
  VALID_REGIONS,
  VALID_REGION_CODES,
  isValidRegionPair,
};
