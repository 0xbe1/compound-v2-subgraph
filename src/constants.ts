import { Address, BigDecimal, BigInt } from "@graphprotocol/graph-ts";

////////////////////////
///// Schema Enums /////
////////////////////////

// The enum values are derived from Coingecko slugs (converted to uppercase
// and replaced hyphens with underscores for Postgres enum compatibility)
export namespace Network {
  export const ARBITRUM = "ARBITRUM_ONE";
  export const AVALANCHE = "AVALANCHE";
  export const AURORA = "AURORA";
  export const BSC = "BINANCE_SMART_CHAIN";
  export const CELO = "CELO";
  export const CRONOS = "CRONOS";
  export const ETHEREUM = "ETHEREUM";
  export const FANTOM = "FANTOM";
  export const HARMONY = "HARMONY_SHARD_0";
  export const MOONBEAM = "MOONBEAM";
  export const MOONRIVER = "MOONRIVER";
  export const OPTIMISM = "OPTIMISTIC_ETHEREUM";
  export const POLYGON = "POLYGON_POS";
  export const XDAI = "XDAI";
}

export namespace ProtocolType {
  export const EXCHANGE = "EXCHANGE";
  export const LENDING = "LENDING";
  export const YIELD = "YIELD";
  export const BRIDGE = "BRIDGE";
  export const GENERIC = "GENERIC";
}

export namespace LendingType {
  export const CDP = "CDP"
  export const POOLED = "POOLED"
}

export namespace RiskType {
  export const GLOBAL = "GLOBAL"
  export const ISOLATED = "ISOLATED"
}

export namespace RewardTokenType {
  export const DEPOSIT = "DEPOSIT";
  export const BORROW = "BORROW";
}

//////////////////////////////
///// Ethereum Addresses /////
//////////////////////////////

// export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
// export const ETH_ADDRESS = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

export let comptrollerAddr = Address.fromString("0x3d9819210A31b4961b30EF54bE2aeD79B9c9Cd3B")
export let cETHAddr = Address.fromString("0x4ddc2d193948926d02f9b1fe9e1daa0718270ed5")
export let cUSDCAddr = Address.fromString('0x39aa39c021dfbae8fac545936693ac917d5e7563')
export let ethAddr = Address.fromString("0x0000000000000000000000000000000000000000")
export let daiAddr = Address.fromString("0x89d24a6b4ccb1b6faa2625fe562bdd9a23260359")

////////////////////////
///// Type Helpers /////
////////////////////////

export const DEFAULT_DECIMALS = 18;

export const USDC_DECIMALS = 6;
export const USDC_DENOMINATOR = BigDecimal.fromString("1000000");

export const BIGINT_ZERO = BigInt.fromI32(0);
export const BIGINT_ONE = BigInt.fromI32(1);
export const BIGINT_TWO = BigInt.fromI32(2);
export const BIGINT_THOUSAND = BigInt.fromI32(1000);
export const BIGINT_MAX = BigInt.fromString(
  "115792089237316195423570985008687907853269984665640564039457584007913129639935",
);

export const INT_ZERO = 0 as i32;
export const INT_ONE = 1 as i32;
export const INT_TWO = 2 as i32;

export const BIGDECIMAL_ZERO = new BigDecimal(BIGINT_ZERO);
export const BIGDECIMAL_ONE = new BigDecimal(BIGINT_ONE);
export const BIGDECIMAL_HUNDRED = new BigDecimal(BigInt.fromI32(100));

export const MAX_UINT = BigInt.fromI32(2).times(BigInt.fromI32(255));

/////////////////////
///// Date/Time /////
/////////////////////

export const SECONDS_PER_DAY = 60 * 60 * 24; // 86400
export const MS_PER_DAY = new BigDecimal(BigInt.fromI32(24 * 60 * 60 * 1000));
export const DAYS_PER_YEAR = new BigDecimal(BigInt.fromI32(365));
export const MS_PER_YEAR = DAYS_PER_YEAR.times(new BigDecimal(BigInt.fromI32(24 * 60 * 60 * 1000)));

/////////////////////////////
///// Protocol Specific /////
/////////////////////////////

export const COMPTROLLER_ADDRESS = "0x3d9819210A31b4961b30EF54bE2aeD79B9c9Cd3B";

/////////////////////////////
/////        Math       /////
/////////////////////////////

export const mantissaFactor = 18
export const cTokenDecimals = 8
export const mantissaFactorBD = exponentToBigDecimal(mantissaFactor)
export const cTokenDecimalsBD = exponentToBigDecimal(cTokenDecimals)
export const mantissaFactorBI = exponentToBigInt(mantissaFactor)
export const cTokenDecimalsBI = exponentToBigInt(cTokenDecimals)

// n => 10^n
export function exponentToBigDecimal(decimals: i32): BigDecimal {
    let bd = BIGDECIMAL_ONE
    let ten = BigDecimal.fromString('10')
    for (let i = 0; i < decimals; i++) {
        bd = bd.times(ten)
    }
    return bd
}

export function exponentToBigInt(decimals: i32): BigInt {
  let res = BIGINT_ONE
  let ten = BigInt.fromI32(10)
  for (let i = 0; i < decimals; i++) {
    res = res.times(ten)
  }
  return res
}

export const BLOCKS_PER_DAY = BigInt.fromI32(6570)