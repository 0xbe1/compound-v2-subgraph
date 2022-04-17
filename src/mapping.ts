import { Address, BigInt, BigDecimal, log, ethereum } from "@graphprotocol/graph-ts"
import {
  Comptroller,
  MarketListed,
  NewCollateralFactor,
  NewLiquidationIncentive,
} from "../generated/Comptroller/Comptroller"
import { AccrueInterest, CToken, LiquidateBorrow } from "../generated/Comptroller/CToken"
import { CToken as CTokenTemplate } from "../generated/templates"
import { ERC20 } from "../generated/Comptroller/ERC20"
import {
  Mint,
  Redeem,
  Borrow as BorrowEvent,
  RepayBorrow,
  Transfer,
} from "../generated/templates/CToken/CToken"
import { Borrow, Deposit, LendingProtocol, Liquidate, Market, Repay, Token, Withdraw } from "../generated/schema"
import { BIGDECIMAL_ZERO, BIGINT_ZERO, LendingType, mantissaFactor, mantissaFactorBD, mantissaFactorBI, Network, ProtocolType, RiskType } from "./constants"

let comptrollerAddr = Address.fromString("0x3d9819210A31b4961b30EF54bE2aeD79B9c9Cd3B")
let ethAddr = Address.fromString("0x0000000000000000000000000000000000000000")
let cETHAddr = Address.fromString("0x4ddc2d193948926d02f9b1fe9e1daa0718270ed5")
let daiAddr = Address.fromString("0x89d24a6b4ccb1b6faa2625fe562bdd9a23260359")
let compAddr = "0xc00e94cb662c3520282e6f5717214004a7f26888"

// 
//
// event.params.cToken: The address of the market (token) to list
export function handleMarketListed(event: MarketListed): void {
  CTokenTemplate.create(event.params.cToken);

  let cTokenAddr = event.params.cToken
  let cToken = Token.load(cTokenAddr.toHexString())
  if (cToken != null) {
    return
  }
  // this is a new cToken, a new underlying token, and a new market

  //
  // create cToken
  //
  let cTokenContract = CToken.bind(event.params.cToken)
  
  // get underlying token
  let underlyingTokenAddr: Address

  // if we cannot fetch the underlying token of a non-cETH cToken
  // then fail early
  if (cTokenAddr == cETHAddr) {
    underlyingTokenAddr = ethAddr
  } else {
    let underlyingTokenAddrResult = cTokenContract.try_underlying()
    if (underlyingTokenAddrResult.reverted) {
      log.warning("[handleMarketListed] could not fetch underlying token of cToken: {}", [cTokenAddr.toHexString()])
      return
    }
    underlyingTokenAddr = underlyingTokenAddrResult.value
  }

  cToken = new Token(cTokenAddr.toHexString())
  if (cTokenAddr == cETHAddr) {
    cToken.name = "Compound Ether"
    cToken.symbol = "cETH"
    cToken.decimals = 18
  } else {
    cToken.name = getOrElse<string>(cTokenContract.try_name(), "unknown")
    cToken.symbol = getOrElse<string>(cTokenContract.try_symbol(), "unknown")
    cToken.decimals = getOrElse<BigInt>(cTokenContract.try_decimals(), BIGINT_ZERO).toI32()
  }
  cToken.save()
  
  //
  // create underlying token
  //
  let underlyingToken = new Token(underlyingTokenAddr.toHexString())
  if (underlyingTokenAddr == ethAddr) { // don't want to call CEther contract, hardcode instead
    underlyingToken.name = "Ether"
    underlyingToken.symbol = "ETH"
    underlyingToken.decimals = 18
  } else if (underlyingTokenAddr == daiAddr) { // this is a DSToken that doesn't have name and symbol, hardcode instead
    underlyingToken.name = "Dai Stablecoin v1.0 (DAI)"
    underlyingToken.symbol = "DAI"
    underlyingToken.decimals = 18
  } else {
    let underlyingTokenContract = ERC20.bind(underlyingTokenAddr)
    underlyingToken.name = getOrElse<string>(underlyingTokenContract.try_name(), "unknown")
    underlyingToken.symbol = getOrElse<string>(underlyingTokenContract.try_symbol(), "unknown")
    underlyingToken.decimals = getOrElse<i32>(underlyingTokenContract.try_decimals(), 0)
  }
  underlyingToken.save()

  //
  // create market
  //
  let market = new Market(cTokenAddr.toHexString())
  let protocol = getOrCreateProtocol()
  market.name = cToken.name
  market.protocol = protocol.id
  market.inputTokens = [underlyingToken.id]
  market.inputTokenBalances = [BIGINT_ZERO]
  market.inputTokenPricesUSD = [BIGDECIMAL_ZERO]
  market.outputToken = cToken.id
  // TODO: market.rewardTokens
  market.createdTimestamp = event.block.timestamp
  market.createdBlockNumber = event.block.number
  market.isActive = true
  market.canUseAsCollateral = true
  market.canBorrowFrom = true
  market.liquidationPenalty = protocol._liquidationIncentive
  market.save()
}

//
//
// event.params.cToken:
// event.params.oldCollateralFactorMantissa:
// event.params.newCollateralFactorMantissa:
export function handleNewCollateralFactor(event: NewCollateralFactor): void {
  let marketID = event.params.cToken.toHexString()
  let market = Market.load(marketID)
  if (market == null) {
    log.warning("[handleNewCollateralFactor] Market not found: {}", [marketID])
    return
  }
  let collateralFactor = convertMantissaToRatio(event.params.newCollateralFactorMantissa)
  market.maximumLTV = collateralFactor
  market.liquidationThreshold = collateralFactor
  market.save()
}

//
//
// event.params.oldLiquidationIncentiveMantissa
// event.params.newLiquidationIncentiveMantissa
export function handleNewLiquidationIncentive(
  event: NewLiquidationIncentive
): void {
  let protocol = getOrCreateProtocol()
  let liquidationIncentive = convertMantissaToRatio(event.params.newLiquidationIncentiveMantissa)
  protocol._liquidationIncentive = liquidationIncentive
  protocol.save()

  for (let i = 0; i < protocol.markets.length; i++) {
    let market = Market.load(protocol.markets[i])
    if (!market) {
      log.warning("[handleNewLiquidationIncentive] Market not found: {}", [protocol.markets[i]])
      // best effort
      continue
    }
    market.liquidationPenalty = liquidationIncentive
    market.save()
  }
}

//
//
// event.params
// - minter
// - mintAmount: The amount of underlying assets to mint
// - mintTokens: The amount of cTokens minted
export function handleMint(event: Mint): void {
  let marketID = event.address.toHexString()
  let market = Market.load(marketID)
  if (!market) {
    log.warning("[handleMint] Market not found: {}", [marketID])
    return
  }
  if (market.inputTokens.length < 1) {
    log.warning("[handleMint] Market {} has no input tokens", [marketID])
    return
  }

  let depositID = event.transaction.hash
    .toHexString()
    .concat('-')
    .concat(event.transactionLogIndex.toString())
  let deposit = new Deposit(depositID)
  let protocol = getOrCreateProtocol()
  deposit.hash = event.transaction.hash.toHexString()
  deposit.logIndex = event.transactionLogIndex.toI32()
  deposit.protocol = protocol.id
  deposit.to = marketID
  deposit.from = event.params.minter.toHexString()
  deposit.blockNumber = event.block.number
  deposit.timestamp = event.block.timestamp
  deposit.market = marketID
  deposit.asset = market.inputTokens[0]
  deposit.amount = event.params.mintAmount
  // " Amount of token deposited in USD "
  // TODO: amountUSD: BigDecimal!
  deposit.save()
}

//
//
// event.params
// - redeemer
// - redeemAmount
// - redeemTokens
export function handleRedeem(event: Redeem): void {
  let marketID = event.address.toHexString()
  let market = Market.load(marketID)
  if (!market) {
    log.warning("[handleRedeem] Market not found: {}", [marketID])
    return
  }
  if (market.inputTokens.length < 1) {
    log.warning("[handleRedeem] Market {} has no input tokens", [marketID])
    return
  }

  let withdrawID = event.transaction.hash
  .toHexString()
  .concat('-')
  .concat(event.transactionLogIndex.toString())
  let withdraw = new Withdraw(withdrawID)
  let protocol = getOrCreateProtocol()
  withdraw.hash = event.transaction.hash.toHexString()
  withdraw.logIndex = event.transactionLogIndex.toI32()
  withdraw.protocol = protocol.id
  withdraw.to = event.params.redeemer.toHexString()
  withdraw.from = marketID
  withdraw.blockNumber = event.block.number
  withdraw.timestamp = event.block.timestamp
  withdraw.market = marketID
  withdraw.asset = market.inputTokens[0]
  withdraw.amount = event.params.redeemAmount
  // " Amount of token withdrawn in USD "
  // TODO: amountUSD: BigDecimal!
  withdraw.save()
}

//
//
// event.params
// - borrower
// - borrowAmount
// - accountBorrows
// - totalBorrows
export function handleBorrow(event: BorrowEvent): void {
  let marketID = event.address.toHexString()
  let market = Market.load(marketID)
  if (!market) {
    log.warning("[handleBorrow] Market not found: {}", [marketID])
    return
  }
  if (market.inputTokens.length < 1) {
    log.warning("[handleBorrow] Market {} has no input tokens", [marketID])
    return
  }

  let borrowID = event.transaction.hash
  .toHexString()
  .concat('-')
  .concat(event.transactionLogIndex.toString())
  let borrow = new Borrow(borrowID)
  let protocol = getOrCreateProtocol()
  borrow.hash = event.transaction.hash.toHexString()
  borrow.logIndex = event.transactionLogIndex.toI32()
  borrow.protocol = protocol.id
  borrow.to = event.params.borrower.toHexString()
  borrow.from = marketID
  borrow.blockNumber = event.block.number
  borrow.timestamp = event.block.timestamp
  borrow.market = marketID
  borrow.asset = market.inputTokens[0]
  borrow.amount = event.params.borrowAmount
  // " Amount of token borrowed in USD "
  // TODO: amountUSD: BigDecimal
  borrow.save()
}

//
//
// event.params
// - payer
// - borrower
// - repayAmount
// - accountBorrows
// - totalBorrows
export function handleRepayBorrow(event: RepayBorrow): void {
  let marketID = event.address.toHexString()
  let market = Market.load(marketID)
  if (!market) {
    log.warning("[handleRepay] Market not found: {}", [marketID])
    return
  }
  if (market.inputTokens.length < 1) {
    log.warning("[handleRepay] Market {} has no input tokens", [marketID])
    return
  }

  let repayID = event.transaction.hash
  .toHexString()
  .concat('-')
  .concat(event.transactionLogIndex.toString())
  let repay = new Repay(repayID)
  let protocol = getOrCreateProtocol()
  repay.hash = event.transaction.hash.toHexString()
  repay.logIndex = event.transactionLogIndex.toI32()
  repay.protocol = protocol.id
  repay.to = marketID
  repay.from = event.params.payer.toHexString()
  repay.blockNumber = event.block.number
  repay.timestamp = event.block.timestamp
  repay.market = marketID
  repay.asset = market.inputTokens[0]
  repay.amount = event.params.repayAmount
  // " Amount of token repaid in USD "
  // TODO: amountUSD: BigDecimal
  repay.save()
}

//
//
// event.params
// - liquidator
// - borrower
// - repayAmount
// - cTokenCollateral
// - seizeTokens
export function handleLiquidateBorrow(event: LiquidateBorrow): void {
  let marketID = event.address.toHexString()
  let market = Market.load(marketID)
  if (!market) {
    log.warning("[handleLiquidateBorrow] Market not found: {}", [marketID])
    return
  }
  if (market.inputTokens.length < 1) {
    log.warning("[handleLiquidateBorrow] Market {} has no input tokens", [marketID])
    return
  }

  let liquidateID = event.transaction.hash
  .toHexString()
  .concat('-')
  .concat(event.transactionLogIndex.toString())
  let liquidate = new Liquidate(liquidateID)
  let protocol = getOrCreateProtocol()
  liquidate.hash = event.transaction.hash.toHexString()
  liquidate.logIndex = event.transactionLogIndex.toI32()
  liquidate.protocol = protocol.id
  liquidate.to = marketID
  liquidate.from = event.params.liquidator.toHexString()
  liquidate.blockNumber = event.block.number
  liquidate.timestamp = event.block.timestamp
  liquidate.market = marketID
  liquidate.asset = market.inputTokens[0]
  liquidate.amount = event.params.repayAmount
  // " Amount of token liquidated in USD "
  // TODO: amountUSD: BigDecimal
  // " Amount of profit from liquidation in USD "
  // TODO: profitUSD: BigDecimal
  liquidate.save()
}

//
//
// event.params:
// - from
// - to
// - amount
export function handleTransfer(event: Transfer): void {
  let marketID = event.address.toHexString()
  let market = Market.load(marketID)
  if (!market) {
    log.warning("[handleTransfer] Market not found: {}", [marketID])
    return
  }
  if (market.inputTokens.length < 1) {
    log.warning("[handleTransfer] Market {} has no input tokens", [marketID])
    return
  }
  let underlyingToken = Token.load(market.inputTokens[0])
  if (!underlyingToken) {
    log.warning("[handleTransfer] Underlying token not found: {}", [market.inputTokens[0]])
    return
  }

  let cTokenContract = CToken.bind(event.address)
  
  let exchangeRateResult = cTokenContract.try_exchangeRateStored()
  if (exchangeRateResult.reverted) {
    log.warning("[handleTransfer] Failed to get exchangeRateStored of Market {}", [marketID])
    // TODO: leverage memorized exchange rate?
    return
  }

  let underlyingAmount = exchangeRateResult.value.times(event.params.amount).div(mantissaFactorBI)

  // check if the Transfer is FROM a CToken contract, or TO a CToken contract
  // - FROM a CToken contract, it is a mint. Need to plus deposit
  // - TO a CToken contract, it is a redeem. Need to minus deposit
  let isMint = event.params.from.toHexString() == marketID

  if (isMint) {
    market.inputTokenBalances[0] = market.inputTokenBalances[0].plus(underlyingAmount)
    // TODO: update totalVolumeUSD
  } else {
    market.inputTokenBalances[0] = market.inputTokenBalances[0].minus(underlyingAmount)
  }

  // TODO: inputTokenPricesUSD

  market.outputTokenSupply = getOrElse<BigInt>(cTokenContract.try_totalSupply(), BIGINT_ZERO)

  // TODO: outputTokenPriceUSD

  let underlyingSupplyUSD = market.inputTokenBalances[0].toBigDecimal().times(market.inputTokenPricesUSD[0])
  market.totalValueLockedUSD = underlyingSupplyUSD
  market.totalDepositUSD = underlyingSupplyUSD

  market.save()
}

export function handleAccrueInterest(event: AccrueInterest): void {
  accrueInterest(event.address, event.block.number.toI32(), event.block.timestamp.toI32())
}

function getOrCreateProtocol(): LendingProtocol {
  let protocol = LendingProtocol.load(comptrollerAddr.toHexString())
  if (!protocol) {
    protocol = new LendingProtocol(comptrollerAddr.toHexString())
    protocol.name = "Compound V2"
    protocol.slug = "compound-v2"
    protocol.schemaVersion = "1.1.0"
    protocol.subgraphVersion = "1.0.0"
    protocol.methodologyVersion = "1.0.0"
    protocol.network = Network.ETHEREUM
    protocol.type = ProtocolType.LENDING
    protocol.lendingType = LendingType.POOLED
    protocol.riskType = RiskType.GLOBAL

    let comptroller = Comptroller.bind(comptrollerAddr)
    protocol._liquidationIncentive = convertMantissaToRatio(comptroller.liquidationIncentiveMantissa())
    protocol.save()
  }
  return protocol
}

function accrueInterest(marketAddress: Address, blockNumber: i32, blockTimestamp: i32): void {
  let marketID = marketAddress.toHexString()
  let market = Market.load(marketID)
  if (!market) {
    log.warning("[accrueInterest] Market not found: {}", [marketID])
    return
  }
  if (market._accuralBlockNumber >= blockNumber) {
    return
  }

  let cTokenContract = CToken.bind(marketAddress)

  let totalBorrowsResult = cTokenContract.try_totalBorrows()
  if (totalBorrowsResult.reverted) {
    log.warning("[accrueInterest] Failed to get totalBorrows of Market {}", [marketID])
  } else {
    let totalBorrows = totalBorrowsResult.value
    // TODO: turn into USD
  }

  let supplyRatePerBlockResult = cTokenContract.try_supplyRatePerBlock()
  if (supplyRatePerBlockResult.reverted) {
    log.warning("[accrueInterest] Failed to get supplyRatePerBlock of Market {}", [marketID])
  } else {
    market.depositRate = convertRatePerBlockToAPY(supplyRatePerBlockResult.value)
  }

  let borrowRatePerBlockResult = cTokenContract.try_borrowRatePerBlock()
  if (borrowRatePerBlockResult.reverted) {
    log.warning("[accrueInterest] Failed to get borrowRatePerBlock of Market {}", [marketID])
  } else {
    market.variableBorrowRate = convertRatePerBlockToAPY(borrowRatePerBlockResult.value)
  }
  market._accuralBlockNumber = blockNumber
  market.save()
}

function convertRatePerBlockToAPY(ratePerBlock: BigInt): BigDecimal {
  return ratePerBlock.times(BigInt.fromI32(365 * 6570)).toBigDecimal().div(mantissaFactorBD).truncate(mantissaFactor)
  // // TODO: compound each day
  // // Formula: check out "Calculating the APY Using Rate Per Block" section https://compound.finance/docs/rate-per-block
  // let a = ratePerBlock.times(BLOCKS_PER_DAY).plus(mantissaFactorBI)
  // let b = mantissaFactorBI
  // // cap by 255 to avoid u8 overflow, 255 + 110 = 365
  // return pow(a, b, 255).times(pow(a, b, 110)).minus(BIGDECIMAL_ONE).times(BIGDECIMAL_HUNDRED)
}

// (a/b)^n, where n ranges [0, 255]
// function pow(a: BigInt, b: BigInt, n: u8): BigDecimal {
//   return a.pow(n).toBigDecimal().div(b.pow(n).toBigDecimal())
// }

// TODO: verify this is correct
function convertMantissaToRatio(mantissa: BigInt): BigDecimal {
  return mantissa.toBigDecimal().div(BigDecimal.fromString("1000000000000000000"))
}

function getOrElse<T>(result: ethereum.CallResult<T>, defaultValue: T): T {
  if (result.reverted) {
    return defaultValue
  }
  return result.value
}
