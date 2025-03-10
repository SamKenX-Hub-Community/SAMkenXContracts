import { expect } from 'chai'
import hre from 'hardhat'
import { getItemValue } from '../../../cli/config'
import GraphChain from '../../../gre/helpers/chain'

describe('Staking configuration', () => {
  const {
    graphConfig,
    contracts: { Staking, Controller, DisputeManager, AllocationExchange },
    chainId,
  } = hre.graph()
  let contractName: string
  if (GraphChain.isL2(chainId)) {
    contractName = 'L2Staking'
  } else {
    contractName = 'L1Staking'
  }

  it('should be controlled by Controller', async function () {
    const controller = await Staking.controller()
    expect(controller).eq(Controller.address)
  })

  it('should allow DisputeManager to slash indexers', async function () {
    const isSlasher = await Staking.slashers(DisputeManager.address)
    expect(isSlasher).eq(true)
  })

  it('should allow AllocationExchange to collect query fees', async function () {
    const allowed = await Staking.assetHolders(AllocationExchange.address)
    expect(allowed).eq(true)
  })

  it('minimumIndexerStake should match "minimumIndexerStake" in the config file', async function () {
    const value = await Staking.minimumIndexerStake()
    const expected = getItemValue(graphConfig, `contracts/${contractName}/init/minimumIndexerStake`)
    expect(value).eq(expected)
  })

  it('thawingPeriod should match "thawingPeriod" in the config file', async function () {
    const value = await Staking.thawingPeriod()
    const expected = getItemValue(graphConfig, `contracts/${contractName}/init/thawingPeriod`)
    expect(value).eq(expected)
  })

  it('protocolPercentage should match "protocolPercentage" in the config file', async function () {
    const value = await Staking.protocolPercentage()
    const expected = getItemValue(graphConfig, `contracts/${contractName}/init/protocolPercentage`)
    expect(value).eq(expected)
  })

  it('curationPercentage should match "curationPercentage" in the config file', async function () {
    const value = await Staking.curationPercentage()
    const expected = getItemValue(graphConfig, `contracts/${contractName}/init/curationPercentage`)
    expect(value).eq(expected)
  })

  it('channelDisputeEpochs should match "channelDisputeEpochs" in the config file', async function () {
    const value = await Staking.channelDisputeEpochs()
    const expected = getItemValue(
      graphConfig,
      `contracts/${contractName}/init/channelDisputeEpochs`,
    )
    expect(value).eq(expected)
  })

  it('maxAllocationEpochs should match "maxAllocationEpochs" in the config file', async function () {
    const value = await Staking.maxAllocationEpochs()
    const expected = getItemValue(graphConfig, `contracts/${contractName}/init/maxAllocationEpochs`)
    expect(value).eq(expected)
  })

  it('delegationUnbondingPeriod should match "delegationUnbondingPeriod" in the config file', async function () {
    const value = await Staking.delegationUnbondingPeriod()
    const expected = getItemValue(
      graphConfig,
      `contracts/${contractName}/init/delegationUnbondingPeriod`,
    )
    expect(value).eq(expected)
  })

  it('delegationRatio should match "delegationRatio" in the config file', async function () {
    const value = await Staking.delegationRatio()
    const expected = getItemValue(graphConfig, `contracts/${contractName}/init/delegationRatio`)
    expect(value).eq(expected)
  })

  it('alphaNumerator should match "rebateAlphaNumerator" in the config file', async function () {
    const value = await Staking.alphaNumerator()
    const expected = getItemValue(
      graphConfig,
      `contracts/${contractName}/init/rebateAlphaNumerator`,
    )
    expect(value).eq(expected)
  })

  it('alphaDenominator should match "rebateAlphaDenominator" in the config file', async function () {
    const value = await Staking.alphaDenominator()
    const expected = getItemValue(
      graphConfig,
      `contracts/${contractName}/init/rebateAlphaDenominator`,
    )
    expect(value).eq(expected)
  })

  it('delegationTaxPercentage should match the configured value in config file', async function () {
    const value = await Staking.delegationTaxPercentage()
    expect(value).eq(5000) // hardcoded as it's set with a function call rather than init parameter
  })
})
