import { Address, BigInt, BigDecimal, log, ethereum } from "@graphprotocol/graph-ts"
import {
  Comptroller,
  MarketListed,
  NewCollateralFactor,
  NewLiquidationIncentive,
  NewPriceOracle,
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
import { BIGDECIMAL_ONE, BIGDECIMAL_ZERO, BIGINT_ZERO, cETHAddr, comptrollerAddr, cUSDCAddr, daiAddr, ethAddr, exponentToBigDecimal, LendingType, mantissaFactor, mantissaFactorBD, mantissaFactorBI, Network, ProtocolType, RiskType } from "./constants"
import { PriceOracle } from "../generated/templates/CToken/PriceOracle"
import { PriceOracle2 } from "../generated/templates/CToken/PriceOracle2"

//
//
// event.params
// - oldPriceOracle
// - newPriceOracle
export function handleNewPriceOracle(event: NewPriceOracle): void {
  let protocol = getOrCreateProtocol();
  protocol._priceOracle = event.params.newPriceOracle.toHexString();
  protocol.save();
}

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

  //
  // update protocol
  //
  let marketIDs = protocol._marketIDs
  marketIDs.push(market.id)
  protocol._marketIDs = marketIDs
  protocol.save()
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

  for (let i = 0; i < protocol._marketIDs.length; i++) {
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
  let underlyingToken = Token.load(market.inputTokens[0])
  if (!underlyingToken) {
    log.warning("[handleMint] Failed to load underlying token: {}", [market.inputTokens[0]])
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
  deposit.amountUSD = market.inputTokenPricesUSD[0].times(event.params.mintAmount.toBigDecimal().div(exponentToBigDecimal(underlyingToken.decimals)))
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
  let underlyingToken = Token.load(market.inputTokens[0])
  if (!underlyingToken) {
    log.warning("[handleRedeem] Failed to load underlying token: {}", [market.inputTokens[0]])
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
  withdraw.amountUSD = market.inputTokenPricesUSD[0].times(event.params.redeemAmount.toBigDecimal().div(exponentToBigDecimal(underlyingToken.decimals)))
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
  let underlyingToken = Token.load(market.inputTokens[0])
  if (!underlyingToken) {
    log.warning("[handleBorrow] Failed to load underlying token: {}", [market.inputTokens[0]])
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
  borrow.amountUSD = market.inputTokenPricesUSD[0].times(event.params.borrowAmount.toBigDecimal().div(exponentToBigDecimal(underlyingToken.decimals)))
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
    log.warning("[handleRepayBorrow] Market not found: {}", [marketID])
    return
  }
  if (market.inputTokens.length < 1) {
    log.warning("[handleRepayBorrow] Market {} has no input tokens", [marketID])
    return
  }
  let underlyingToken = Token.load(market.inputTokens[0])
  if (!underlyingToken) {
    log.warning("[handleRepayBorrow] Failed to load underlying token: {}", [market.inputTokens[0]])
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
  repay.amountUSD = market.inputTokenPricesUSD[0].times(event.params.repayAmount.toBigDecimal().div(exponentToBigDecimal(underlyingToken.decimals)))
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
  let underlyingToken = Token.load(market.inputTokens[0])
  if (!underlyingToken) {
    log.warning("[handleLiquidateBorrow] Failed to load underlying token: {}", [market.inputTokens[0]])
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
  liquidate.amountUSD = market.inputTokenPricesUSD[0].times(event.params.repayAmount.toBigDecimal().div(exponentToBigDecimal(underlyingToken.decimals)))
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

  // TODO: confirm unit
  let underlyingAmount = exchangeRateResult.value.times(event.params.amount).div(mantissaFactorBI)

  // check if the Transfer is FROM a CToken contract, or TO a CToken contract
  // - FROM a CToken contract, it is a mint. Need to plus deposit
  // - TO a CToken contract, it is a redeem. Need to minus deposit
  let isMint = event.params.from.toHexString() == marketID

  if (isMint) {
    market.inputTokenBalances[0] = market.inputTokenBalances[0].plus(underlyingAmount)
    // TODO: update totalVolumeUSD
    // market.totalVolumeUSD = market.totalVolumeUSD.plus(market.inputTokenPricesUSD[0].times(underlyingAmount))
  } else {
    market.inputTokenBalances[0] = market.inputTokenBalances[0].minus(underlyingAmount)
  }

  market.outputTokenSupply = getOrElse<BigInt>(cTokenContract.try_totalSupply(), BIGINT_ZERO)

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

// This function is called whenever mint, redeem, borrow, repay, liquidateBorrow happens
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
  let underlyingToken = Token.load(market.inputTokens[0])
  if (!underlyingToken) {
    log.warning("[accrueInterest] Underlying token not found: {}", [market.inputTokens[0]])
    return
  }

  market.inputTokenPricesUSD[0] = getTokenPriceUSD(marketAddress, Address.fromString(market.inputTokens[0]), underlyingToken.decimals, blockNumber)

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

function getTokenPriceUSD(cTokenAddr: Address, underlyingAddr: Address, underlyingDecimals: i32, blockNumber: i32): BigDecimal {
  // After block 10678764 price is calculated based on USD instead of ETH
  if (blockNumber > 10678764) {
      return getTokenPrice(
        blockNumber,
        cTokenAddr,
        underlyingAddr,
        underlyingDecimals,
      )
  } else {
    let usdPriceInEth = getTokenPrice(
      blockNumber,
      cUSDCAddr,
        Address.fromString('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),
        6
      )

    if (cTokenAddr == cETHAddr) {
      return BIGDECIMAL_ONE.div(usdPriceInEth).truncate(underlyingDecimals)
    } else {
      let tokenPriceEth = getTokenPrice(
        blockNumber,
        cTokenAddr,
        underlyingAddr,
        underlyingDecimals,
      )
      
      return tokenPriceEth.truncate(underlyingDecimals).div(usdPriceInEth).truncate(underlyingDecimals)
    }
  }
}

// Used for all cERC20 contracts
// Either USD or ETH price is returned
function getTokenPrice(
  blockNumber: i32,
  cTokenAddr: Address,
  underlyingAddr: Address,
  underlyingDecimals: i32,
): BigDecimal {
  let protocol = getOrCreateProtocol()
  let oracleAddress = Address.fromString(protocol._priceOracle)
  let priceOracle1Address = Address.fromString('02557a5e05defeffd4cae6d83ea3d173b272c904')

  /* PriceOracle2 is used at the block the Comptroller starts using it.
   * see here https://etherscan.io/address/0x3d9819210a31b4961b30ef54be2aed79b9c9cd3b#events
   * Search for event topic 0xd52b2b9b7e9ee655fcb95d2e5b9e0c9f69e7ef2b8e9d2d0ea78402d576d22e22,
   * and see block 7715908.
   *
   * This must use the cToken address.
   *
   * Note this returns the value without factoring in token decimals and wei, so we must divide
   * the number by (ethDecimals - tokenDecimals) and again by the mantissa.
   * USDC would be 10 ^ ((18 - 6) + 18) = 10 ^ 30
   *
   * Note that they deployed 3 different PriceOracles at the beginning of the Comptroller,
   * and that they handle the decimals different, which can break the subgraph. So we actually
   * defer to Oracle 1 before block 7715908, which works,
   * until this one is deployed, which was used for 121 days */
  if (blockNumber > 7715908) {
    let mantissaDecimalFactor = 18 - underlyingDecimals + 18
    let bdFactor = exponentToBigDecimal(mantissaDecimalFactor)
    let oracle2 = PriceOracle2.bind(oracleAddress)
    let tryPrice = oracle2.try_getUnderlyingPrice(cTokenAddr)

    return tryPrice.reverted
      ? BIGDECIMAL_ZERO
      : tryPrice.value.toBigDecimal().div(bdFactor)

    /* PriceOracle(1) is used (only for the first ~100 blocks of Comptroller. Annoying but we must
     * handle this. We use it for more than 100 blocks, see reason at top of if statement
     * of PriceOracle2.
     *
     * This must use the token address, not the cToken address.
     *
     * Note this returns the value already factoring in token decimals and wei, therefore
     * we only need to divide by the mantissa, 10^18 */
  } else {
    let oracle1 = PriceOracle.bind(priceOracle1Address)
    return oracle1
      .getPrice(underlyingAddr)
      .toBigDecimal()
      .div(mantissaFactorBD)
  }
}


function getOrElse<T>(result: ethereum.CallResult<T>, defaultValue: T): T {
  if (result.reverted) {
    return defaultValue
  }
  return result.value
}
