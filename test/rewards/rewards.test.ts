import { expect } from 'chai'
import { constants, BigNumber } from 'ethers'
import { BigNumber as BN } from 'bignumber.js'

import { NetworkFixture } from '../lib/fixtures'

import { Curation } from '../../build/types/Curation'
import { EpochManager } from '../../build/types/EpochManager'
import { GraphToken } from '../../build/types/GraphToken'
import { RewardsManager } from '../../build/types/RewardsManager'
import { IStaking } from '../../build/types/IStaking'

import {
  advanceBlocks,
  deriveChannelKey,
  getAccounts,
  randomHexBytes,
  latestBlock,
  toBN,
  toGRT,
  formatGRT,
  Account,
  advanceToNextEpoch,
  provider,
  advanceBlock,
} from '../lib/testHelpers'

const MAX_PPM = 1000000

const { HashZero, WeiPerEther } = constants

const toRound = (n: BigNumber) => formatGRT(n.add(toGRT('0.5'))).split('.')[0]

describe('Rewards', () => {
  let delegator: Account
  let governor: Account
  let curator1: Account
  let curator2: Account
  let indexer1: Account
  let indexer2: Account
  let oracle: Account
  let assetHolder: Account

  let fixture: NetworkFixture

  let grt: GraphToken
  let curation: Curation
  let epochManager: EpochManager
  let staking: IStaking
  let rewardsManager: RewardsManager

  // Derive some channel keys for each indexer used to sign attestations
  const channelKey1 = deriveChannelKey()
  const channelKey2 = deriveChannelKey()

  const subgraphDeploymentID1 = randomHexBytes()
  const subgraphDeploymentID2 = randomHexBytes()

  const allocationID1 = channelKey1.address
  const allocationID2 = channelKey2.address

  const metadata = HashZero

  const ISSUANCE_RATE_PERIODS = 4 // blocks required to issue 800 GRT rewards
  const ISSUANCE_PER_BLOCK = toBN('200000000000000000000') // 200 GRT every block

  // Core formula that gets accumulated rewards per signal for a period of time
  const getRewardsPerSignal = (k: BN, t: BN, s: BN): string => {
    if (s.eq(0)) {
      return '0'
    }
    return k.times(t).div(s).toPrecision(18).toString()
  }

  // Tracks the accumulated rewards as totalSignalled or supply changes across snapshots
  class RewardsTracker {
    totalSignalled = BigNumber.from(0)
    lastUpdatedBlock = BigNumber.from(0)
    accumulated = BigNumber.from(0)

    static async create() {
      const tracker = new RewardsTracker()
      await tracker.snapshot()
      return tracker
    }

    async snapshot() {
      this.accumulated = this.accumulated.add(await this.accrued())
      this.totalSignalled = await grt.balanceOf(curation.address)
      this.lastUpdatedBlock = await latestBlock()
      return this
    }

    async elapsedBlocks() {
      const currentBlock = await latestBlock()
      return currentBlock.sub(this.lastUpdatedBlock)
    }

    async accrued() {
      const nBlocks = await this.elapsedBlocks()
      return this.accruedByElapsed(nBlocks)
    }

    async accruedByElapsed(nBlocks: BigNumber | number) {
      const n = getRewardsPerSignal(
        new BN(ISSUANCE_PER_BLOCK.toString()),
        new BN(nBlocks.toString()),
        new BN(this.totalSignalled.toString()),
      )
      return toGRT(n)
    }
  }

  // Test accumulated rewards per signal
  const shouldGetNewRewardsPerSignal = async (nBlocks = ISSUANCE_RATE_PERIODS) => {
    // -- t0 --
    const tracker = await RewardsTracker.create()

    // Jump
    await advanceBlocks(nBlocks)

    // -- t1 --

    // Contract calculation
    const contractAccrued = await rewardsManager.getNewRewardsPerSignal()
    // Local calculation
    const expectedAccrued = await tracker.accrued()

    // Check
    expect(toRound(expectedAccrued)).eq(toRound(contractAccrued))
    return expectedAccrued
  }

  before(async function () {
    ;[delegator, governor, curator1, curator2, indexer1, indexer2, oracle, assetHolder] =
      await getAccounts()

    fixture = new NetworkFixture()
    ;({ grt, curation, epochManager, staking, rewardsManager } = await fixture.load(
      governor.signer,
    ))

    // 200 GRT per block
    await rewardsManager.connect(governor.signer).setIssuancePerBlock(ISSUANCE_PER_BLOCK)

    // Distribute test funds
    for (const wallet of [indexer1, indexer2, curator1, curator2, assetHolder]) {
      await grt.connect(governor.signer).mint(wallet.address, toGRT('1000000'))
      await grt.connect(wallet.signer).approve(staking.address, toGRT('1000000'))
      await grt.connect(wallet.signer).approve(curation.address, toGRT('1000000'))
    }
  })

  beforeEach(async function () {
    await fixture.setUp()
  })

  afterEach(async function () {
    await fixture.tearDown()
  })

  describe('configuration', function () {
    describe('issuance per block update', function () {
      it('reject set issuance per block if unauthorized', async function () {
        const tx = rewardsManager.connect(indexer1.signer).setIssuancePerBlock(toGRT('1.025'))
        await expect(tx).revertedWith('Only Controller governor')
      })

      it('should set issuance rate to minimum allowed (0)', async function () {
        const newIssuancePerBlock = toGRT('0')
        await rewardsManager.connect(governor.signer).setIssuancePerBlock(newIssuancePerBlock)
        expect(await rewardsManager.issuancePerBlock()).eq(newIssuancePerBlock)
      })

      it('should set issuance rate', async function () {
        const newIssuancePerBlock = toGRT('100.025')
        await rewardsManager.connect(governor.signer).setIssuancePerBlock(newIssuancePerBlock)
        expect(await rewardsManager.issuancePerBlock()).eq(newIssuancePerBlock)
        expect(await rewardsManager.accRewardsPerSignalLastBlockUpdated()).eq(await latestBlock())
      })
    })

    describe('subgraph availability service', function () {
      it('reject set subgraph oracle if unauthorized', async function () {
        const tx = rewardsManager
          .connect(indexer1.signer)
          .setSubgraphAvailabilityOracle(oracle.address)
        await expect(tx).revertedWith('Only Controller governor')
      })

      it('should set subgraph oracle if governor', async function () {
        await rewardsManager.connect(governor.signer).setSubgraphAvailabilityOracle(oracle.address)
        expect(await rewardsManager.subgraphAvailabilityOracle()).eq(oracle.address)
      })

      it('reject to deny subgraph if not the oracle', async function () {
        const tx = rewardsManager.setDenied(subgraphDeploymentID1, true)
        await expect(tx).revertedWith('Caller must be the subgraph availability oracle')
      })

      it('should deny subgraph', async function () {
        await rewardsManager.connect(governor.signer).setSubgraphAvailabilityOracle(oracle.address)

        const tx = rewardsManager.connect(oracle.signer).setDenied(subgraphDeploymentID1, true)
        const blockNum = await latestBlock()
        await expect(tx)
          .emit(rewardsManager, 'RewardsDenylistUpdated')
          .withArgs(subgraphDeploymentID1, blockNum.add(1))
        expect(await rewardsManager.isDenied(subgraphDeploymentID1)).eq(true)
      })

      it('reject deny subgraph w/ many if not the oracle', async function () {
        const deniedSubgraphs = [subgraphDeploymentID1, subgraphDeploymentID2]
        const tx = rewardsManager
          .connect(oracle.signer)
          .setDeniedMany(deniedSubgraphs, [true, true])
        await expect(tx).revertedWith('Caller must be the subgraph availability oracle')
      })

      it('should deny subgraph w/ many', async function () {
        await rewardsManager.connect(governor.signer).setSubgraphAvailabilityOracle(oracle.address)

        const deniedSubgraphs = [subgraphDeploymentID1, subgraphDeploymentID2]
        await rewardsManager.connect(oracle.signer).setDeniedMany(deniedSubgraphs, [true, true])
        expect(await rewardsManager.isDenied(subgraphDeploymentID1)).eq(true)
        expect(await rewardsManager.isDenied(subgraphDeploymentID2)).eq(true)
      })
    })
  })

  context('issuing rewards', async function () {
    beforeEach(async function () {
      // 5% minute rate (4 blocks)
      await rewardsManager.connect(governor.signer).setIssuancePerBlock(ISSUANCE_PER_BLOCK)
    })

    describe('getNewRewardsPerSignal', function () {
      it('accrued per signal when no tokens signalled', async function () {
        // When there is no tokens signalled no rewards are accrued
        await advanceToNextEpoch(epochManager)
        const accrued = await rewardsManager.getNewRewardsPerSignal()
        expect(accrued).eq(0)
      })

      it('accrued per signal when tokens signalled', async function () {
        // Update total signalled
        const tokensToSignal = toGRT('1000')
        await curation.connect(curator1.signer).mint(subgraphDeploymentID1, tokensToSignal, 0)

        // Check
        await shouldGetNewRewardsPerSignal()
      })

      it('accrued per signal when signalled tokens w/ many subgraphs', async function () {
        // Update total signalled
        await curation.connect(curator1.signer).mint(subgraphDeploymentID1, toGRT('1000'), 0)

        // Check
        await shouldGetNewRewardsPerSignal()

        // Update total signalled
        await curation.connect(curator2.signer).mint(subgraphDeploymentID2, toGRT('250'), 0)

        // Check
        await shouldGetNewRewardsPerSignal()
      })
    })

    describe('updateAccRewardsPerSignal', function () {
      it('update the accumulated rewards per signal state', async function () {
        // Update total signalled
        await curation.connect(curator1.signer).mint(subgraphDeploymentID1, toGRT('1000'), 0)
        // Snapshot
        const tracker = await RewardsTracker.create()

        // Update
        await rewardsManager.updateAccRewardsPerSignal()
        const contractAccrued = await rewardsManager.accRewardsPerSignal()

        // Check
        const expectedAccrued = await tracker.accrued()
        expect(toRound(expectedAccrued)).eq(toRound(contractAccrued))
      })

      it('update the accumulated rewards per signal state after many blocks', async function () {
        // Update total signalled
        await curation.connect(curator1.signer).mint(subgraphDeploymentID1, toGRT('1000'), 0)
        // Snapshot
        const tracker = await RewardsTracker.create()

        // Jump
        await advanceBlocks(ISSUANCE_RATE_PERIODS)

        // Update
        await rewardsManager.updateAccRewardsPerSignal()
        const contractAccrued = await rewardsManager.accRewardsPerSignal()

        // Check
        const expectedAccrued = await tracker.accrued()
        expect(toRound(expectedAccrued)).eq(toRound(contractAccrued))
      })
    })

    describe('getAccRewardsForSubgraph', function () {
      it('accrued for each subgraph', async function () {
        // Curator1 - Update total signalled
        const signalled1 = toGRT('1500')
        await curation.connect(curator1.signer).mint(subgraphDeploymentID1, signalled1, 0)
        const tracker1 = await RewardsTracker.create()

        // Curator2 - Update total signalled
        const signalled2 = toGRT('500')
        await curation.connect(curator2.signer).mint(subgraphDeploymentID2, signalled2, 0)

        // Snapshot
        const tracker2 = await RewardsTracker.create()
        await tracker1.snapshot()

        // Jump
        await advanceBlocks(ISSUANCE_RATE_PERIODS)

        // Snapshot
        await tracker1.snapshot()
        await tracker2.snapshot()

        // Calculate rewards
        const rewardsPerSignal1 = await tracker1.accumulated
        const rewardsPerSignal2 = await tracker2.accumulated
        const expectedRewardsSG1 = rewardsPerSignal1.mul(signalled1).div(WeiPerEther)
        const expectedRewardsSG2 = rewardsPerSignal2.mul(signalled2).div(WeiPerEther)

        // Get rewards from contract
        const contractRewardsSG1 = await rewardsManager.getAccRewardsForSubgraph(
          subgraphDeploymentID1,
        )
        const contractRewardsSG2 = await rewardsManager.getAccRewardsForSubgraph(
          subgraphDeploymentID2,
        )

        // Check
        expect(toRound(expectedRewardsSG1)).eq(toRound(contractRewardsSG1))
        expect(toRound(expectedRewardsSG2)).eq(toRound(contractRewardsSG2))
      })
    })

    describe('onSubgraphSignalUpdate', function () {
      it('update the accumulated rewards for subgraph state', async function () {
        // Update total signalled
        const signalled1 = toGRT('1500')
        await curation.connect(curator1.signer).mint(subgraphDeploymentID1, signalled1, 0)
        // Snapshot
        const tracker1 = await RewardsTracker.create()

        // Jump
        await advanceBlocks(ISSUANCE_RATE_PERIODS)

        // Update
        await rewardsManager.onSubgraphSignalUpdate(subgraphDeploymentID1)

        // Check
        const contractRewardsSG1 = (await rewardsManager.subgraphs(subgraphDeploymentID1))
          .accRewardsForSubgraph
        const rewardsPerSignal1 = await tracker1.accrued()
        const expectedRewardsSG1 = rewardsPerSignal1.mul(signalled1).div(WeiPerEther)
        expect(toRound(expectedRewardsSG1)).eq(toRound(contractRewardsSG1))

        const contractAccrued = await rewardsManager.accRewardsPerSignal()
        const expectedAccrued = await tracker1.accrued()
        expect(toRound(expectedAccrued)).eq(toRound(contractAccrued))

        const contractBlockUpdated = await rewardsManager.accRewardsPerSignalLastBlockUpdated()
        const expectedBlockUpdated = await latestBlock()
        expect(expectedBlockUpdated).eq(contractBlockUpdated)
      })
    })

    describe('getAccRewardsPerAllocatedToken', function () {
      it('accrued per allocated token', async function () {
        // Update total signalled
        const signalled1 = toGRT('1500')
        await curation.connect(curator1.signer).mint(subgraphDeploymentID1, signalled1, 0)

        // Allocate
        const tokensToAllocate = toGRT('12500')
        await staking.connect(indexer1.signer).stake(tokensToAllocate)
        await staking
          .connect(indexer1.signer)
          .allocateFrom(
            indexer1.address,
            subgraphDeploymentID1,
            tokensToAllocate,
            allocationID1,
            metadata,
            await channelKey1.generateProof(indexer1.address),
          )

        // Jump
        await advanceBlocks(ISSUANCE_RATE_PERIODS)

        // Check
        const sg1 = await rewardsManager.subgraphs(subgraphDeploymentID1)
        // We trust this function because it was individually tested in previous test
        const accRewardsForSubgraphSG1 = await rewardsManager.getAccRewardsForSubgraph(
          subgraphDeploymentID1,
        )
        const accruedRewardsSG1 = accRewardsForSubgraphSG1.sub(sg1.accRewardsForSubgraphSnapshot)
        const expectedRewardsAT1 = accruedRewardsSG1.mul(WeiPerEther).div(tokensToAllocate)
        const contractRewardsAT1 = (
          await rewardsManager.getAccRewardsPerAllocatedToken(subgraphDeploymentID1)
        )[0]
        expect(expectedRewardsAT1).eq(contractRewardsAT1)
      })
    })

    describe('onSubgraphAllocationUpdate', function () {
      it('update the accumulated rewards for allocated tokens state', async function () {
        // Update total signalled
        const signalled1 = toGRT('1500')
        await curation.connect(curator1.signer).mint(subgraphDeploymentID1, signalled1, 0)

        // Allocate
        const tokensToAllocate = toGRT('12500')
        await staking.connect(indexer1.signer).stake(tokensToAllocate)
        await staking
          .connect(indexer1.signer)
          .allocateFrom(
            indexer1.address,
            subgraphDeploymentID1,
            tokensToAllocate,
            allocationID1,
            metadata,
            await channelKey1.generateProof(indexer1.address),
          )

        // Jump
        await advanceBlocks(ISSUANCE_RATE_PERIODS)

        // Prepare expected results
        const expectedSubgraphRewards = toGRT('1400') // 7 blocks since signaling to when we do getAccRewardsForSubgraph
        const expectedRewardsAT = toGRT('0.08') // allocated during 5 blocks: 1000 GRT, divided by 12500 allocated tokens

        // Update
        await rewardsManager.onSubgraphAllocationUpdate(subgraphDeploymentID1)

        // Check on demand results saved
        const subgraph = await rewardsManager.subgraphs(subgraphDeploymentID1)
        const contractSubgraphRewards = await rewardsManager.getAccRewardsForSubgraph(
          subgraphDeploymentID1,
        )
        const contractRewardsAT = subgraph.accRewardsPerAllocatedToken

        expect(toRound(expectedSubgraphRewards)).eq(toRound(contractSubgraphRewards))
        expect(toRound(expectedRewardsAT.mul(1000))).eq(toRound(contractRewardsAT.mul(1000)))
      })
    })

    describe('getRewards', function () {
      it('calculate rewards using the subgraph signalled + allocated tokens', async function () {
        // Update total signalled
        const signalled1 = toGRT('1500')
        await curation.connect(curator1.signer).mint(subgraphDeploymentID1, signalled1, 0)

        // Allocate
        const tokensToAllocate = toGRT('12500')
        await staking.connect(indexer1.signer).stake(tokensToAllocate)
        await staking
          .connect(indexer1.signer)
          .allocateFrom(
            indexer1.address,
            subgraphDeploymentID1,
            tokensToAllocate,
            allocationID1,
            metadata,
            await channelKey1.generateProof(indexer1.address),
          )

        // Jump
        await advanceBlocks(ISSUANCE_RATE_PERIODS)

        // Rewards
        const contractRewards = await rewardsManager.getRewards(allocationID1)

        // We trust using this function in the test because we tested it
        // standalone in a previous test
        const contractRewardsAT1 = (
          await rewardsManager.getAccRewardsPerAllocatedToken(subgraphDeploymentID1)
        )[0]

        const expectedRewards = contractRewardsAT1.mul(tokensToAllocate).div(WeiPerEther)
        expect(expectedRewards).eq(contractRewards)
      })
    })

    describe('takeRewards', function () {
      interface DelegationParameters {
        indexingRewardCut: BigNumber
        queryFeeCut: BigNumber
        cooldownBlocks: number
      }

      async function setupIndexerAllocation() {
        // Setup
        await epochManager.setEpochLength(10)

        // Update total signalled
        const signalled1 = toGRT('1500')
        await curation.connect(curator1.signer).mint(subgraphDeploymentID1, signalled1, 0)

        // Allocate
        const tokensToAllocate = toGRT('12500')
        await staking.connect(indexer1.signer).stake(tokensToAllocate)
        await staking
          .connect(indexer1.signer)
          .allocateFrom(
            indexer1.address,
            subgraphDeploymentID1,
            tokensToAllocate,
            allocationID1,
            metadata,
            await channelKey1.generateProof(indexer1.address),
          )
      }

      async function setupIndexerAllocationSignalingAfter() {
        // Setup
        await epochManager.setEpochLength(10)

        // Allocate
        const tokensToAllocate = toGRT('12500')
        await staking.connect(indexer1.signer).stake(tokensToAllocate)
        await staking
          .connect(indexer1.signer)
          .allocateFrom(
            indexer1.address,
            subgraphDeploymentID1,
            tokensToAllocate,
            allocationID1,
            metadata,
            await channelKey1.generateProof(indexer1.address),
          )

        // Update total signalled
        const signalled1 = toGRT('1500')
        await curation.connect(curator1.signer).mint(subgraphDeploymentID1, signalled1, 0)
      }

      async function setupIndexerAllocationWithDelegation(
        tokensToDelegate: BigNumber,
        delegationParams: DelegationParameters,
      ) {
        const tokensToAllocate = toGRT('12500')

        // Setup
        await epochManager.setEpochLength(10)

        // Transfer some funds from the curator, I don't want to mint new tokens
        await grt.connect(curator1.signer).transfer(delegator.address, tokensToDelegate)
        await grt.connect(delegator.signer).approve(staking.address, tokensToDelegate)

        // Stake and set delegation parameters
        await staking.connect(indexer1.signer).stake(tokensToAllocate)
        await staking
          .connect(indexer1.signer)
          .setDelegationParameters(
            delegationParams.indexingRewardCut,
            delegationParams.queryFeeCut,
            delegationParams.cooldownBlocks,
          )

        // Delegate
        await staking.connect(delegator.signer).delegate(indexer1.address, tokensToDelegate)

        // Update total signalled
        const signalled1 = toGRT('1500')
        await curation.connect(curator1.signer).mint(subgraphDeploymentID1, signalled1, 0)

        // Allocate
        await staking
          .connect(indexer1.signer)
          .allocateFrom(
            indexer1.address,
            subgraphDeploymentID1,
            tokensToAllocate,
            allocationID1,
            metadata,
            await channelKey1.generateProof(indexer1.address),
          )
      }

      it('should distribute rewards on closed allocation and stake', async function () {
        // Align with the epoch boundary
        await advanceToNextEpoch(epochManager)
        // Setup
        await setupIndexerAllocation()

        // Jump
        await advanceToNextEpoch(epochManager)

        // Before state
        const beforeTokenSupply = await grt.totalSupply()
        const beforeIndexer1Stake = await staking.getIndexerStakedTokens(indexer1.address)
        const beforeIndexer1Balance = await grt.balanceOf(indexer1.address)
        const beforeStakingBalance = await grt.balanceOf(staking.address)

        // All the rewards in this subgraph go to this allocation.
        // Rewards per token will be (issuancePerBlock * nBlocks) / allocatedTokens
        // The first snapshot is after allocating, that is 2 blocks after the signal is minted.
        // The final snapshot is when we close the allocation, that happens 9 blocks after signal is minted.
        // So the rewards will be ((issuancePerBlock * 7) / allocatedTokens) * allocatedTokens
        const expectedIndexingRewards = toGRT('1400')

        // Close allocation. At this point rewards should be collected for that indexer
        const tx = await staking
          .connect(indexer1.signer)
          .closeAllocation(allocationID1, randomHexBytes())
        const receipt = await tx.wait()
        const event = rewardsManager.interface.parseLog(receipt.logs[1]).args
        expect(event.indexer).eq(indexer1.address)
        expect(event.allocationID).eq(allocationID1)
        expect(event.epoch).eq(await epochManager.currentEpoch())
        expect(toRound(event.amount)).eq(toRound(expectedIndexingRewards))

        // After state
        const afterTokenSupply = await grt.totalSupply()
        const afterIndexer1Stake = await staking.getIndexerStakedTokens(indexer1.address)
        const afterIndexer1Balance = await grt.balanceOf(indexer1.address)
        const afterStakingBalance = await grt.balanceOf(staking.address)

        // Check that rewards are put into indexer stake
        const expectedIndexerStake = beforeIndexer1Stake.add(expectedIndexingRewards)
        const expectedTokenSupply = beforeTokenSupply.add(expectedIndexingRewards)
        // Check stake should have increased with the rewards staked
        expect(toRound(afterIndexer1Stake)).eq(toRound(expectedIndexerStake))
        // Check indexer balance remains the same
        expect(afterIndexer1Balance).eq(beforeIndexer1Balance)
        // Check indexing rewards are kept in the staking contract
        expect(toRound(afterStakingBalance)).eq(
          toRound(beforeStakingBalance.add(expectedIndexingRewards)),
        )
        // Check that tokens have been minted
        expect(toRound(afterTokenSupply)).eq(toRound(expectedTokenSupply))
      })

      it('does not revert with an underflow if the minimum signal changes', async function () {
        // Align with the epoch boundary
        await advanceToNextEpoch(epochManager)
        // Setup
        await setupIndexerAllocation()

        await rewardsManager.connect(governor.signer).setMinimumSubgraphSignal(toGRT(14000))

        // Jump
        await advanceToNextEpoch(epochManager)

        // Close allocation. At this point rewards should be collected for that indexer
        const tx = staking.connect(indexer1.signer).closeAllocation(allocationID1, randomHexBytes())
        await expect(tx)
          .emit(rewardsManager, 'RewardsAssigned')
          .withArgs(indexer1.address, allocationID1, await epochManager.currentEpoch(), toBN(0))
      })

      it('does not revert with an underflow if the minimum signal changes, and signal came after allocation', async function () {
        // Align with the epoch boundary
        await advanceToNextEpoch(epochManager)
        // Setup
        await setupIndexerAllocationSignalingAfter()

        await rewardsManager.connect(governor.signer).setMinimumSubgraphSignal(toGRT(14000))

        // Jump
        await advanceToNextEpoch(epochManager)

        // Close allocation. At this point rewards should be collected for that indexer
        const tx = staking.connect(indexer1.signer).closeAllocation(allocationID1, randomHexBytes())
        await expect(tx)
          .emit(rewardsManager, 'RewardsAssigned')
          .withArgs(indexer1.address, allocationID1, await epochManager.currentEpoch(), toBN(0))
      })

      it('does not revert if signal was already under minimum', async function () {
        await rewardsManager.connect(governor.signer).setMinimumSubgraphSignal(toGRT(2000))
        // Align with the epoch boundary
        await advanceToNextEpoch(epochManager)
        // Setup
        await setupIndexerAllocation()

        // Jump
        await advanceToNextEpoch(epochManager)
        // Close allocation. At this point rewards should be collected for that indexer
        const tx = staking.connect(indexer1.signer).closeAllocation(allocationID1, randomHexBytes())

        await expect(tx)
          .emit(rewardsManager, 'RewardsAssigned')
          .withArgs(indexer1.address, allocationID1, await epochManager.currentEpoch(), toBN(0))
      })

      it('should distribute rewards on closed allocation and send to destination', async function () {
        const destinationAddress = randomHexBytes(20)
        await staking.connect(indexer1.signer).setRewardsDestination(destinationAddress)

        // Align with the epoch boundary
        await advanceToNextEpoch(epochManager)
        // Setup
        await setupIndexerAllocation()

        // Jump
        await advanceToNextEpoch(epochManager)

        // Before state
        const beforeTokenSupply = await grt.totalSupply()
        const beforeIndexer1Stake = await staking.getIndexerStakedTokens(indexer1.address)
        const beforeDestinationBalance = await grt.balanceOf(destinationAddress)
        const beforeStakingBalance = await grt.balanceOf(staking.address)

        // All the rewards in this subgraph go to this allocation.
        // Rewards per token will be (issuancePerBlock * nBlocks) / allocatedTokens
        // The first snapshot is after allocating, that is 2 blocks after the signal is minted.
        // The final snapshot is when we close the allocation, that happens 9 blocks after signal is minted.
        // So the rewards will be ((issuancePerBlock * 7) / allocatedTokens) * allocatedTokens
        const expectedIndexingRewards = toGRT('1400')

        // Close allocation. At this point rewards should be collected for that indexer
        const tx = await staking
          .connect(indexer1.signer)
          .closeAllocation(allocationID1, randomHexBytes())
        const receipt = await tx.wait()
        const event = rewardsManager.interface.parseLog(receipt.logs[1]).args
        expect(event.indexer).eq(indexer1.address)
        expect(event.allocationID).eq(allocationID1)
        expect(event.epoch).eq(await epochManager.currentEpoch())
        expect(toRound(event.amount)).eq(toRound(expectedIndexingRewards))

        // After state
        const afterTokenSupply = await grt.totalSupply()
        const afterIndexer1Stake = await staking.getIndexerStakedTokens(indexer1.address)
        const afterDestinationBalance = await grt.balanceOf(destinationAddress)
        const afterStakingBalance = await grt.balanceOf(staking.address)

        // Check that rewards are properly assigned
        const expectedIndexerStake = beforeIndexer1Stake
        const expectedTokenSupply = beforeTokenSupply.add(expectedIndexingRewards)
        // Check stake should not have changed
        expect(toRound(afterIndexer1Stake)).eq(toRound(expectedIndexerStake))
        // Check indexing rewards are received by the rewards destination
        expect(toRound(afterDestinationBalance)).eq(
          toRound(beforeDestinationBalance.add(expectedIndexingRewards)),
        )
        // Check indexing rewards were not sent to the staking contract
        expect(afterStakingBalance).eq(beforeStakingBalance)
        // Check that tokens have been minted
        expect(toRound(afterTokenSupply)).eq(toRound(expectedTokenSupply))
      })

      it('should distribute rewards on closed allocation w/delegators', async function () {
        // Setup
        const delegationParams = {
          indexingRewardCut: toBN('823000'), // 82.30%
          queryFeeCut: toBN('80000'), // 8%
          cooldownBlocks: 5,
        }
        const tokensToDelegate = toGRT('2000')

        // Align with the epoch boundary
        await advanceToNextEpoch(epochManager)
        // Setup the allocation and delegators
        await setupIndexerAllocationWithDelegation(tokensToDelegate, delegationParams)

        // Jump
        await advanceToNextEpoch(epochManager)

        // Before state
        const beforeTokenSupply = await grt.totalSupply()
        const beforeDelegationPool = await staking.delegationPools(indexer1.address)
        const beforeIndexer1Stake = await staking.getIndexerStakedTokens(indexer1.address)

        // Close allocation. At this point rewards should be collected for that indexer
        await staking.connect(indexer1.signer).closeAllocation(allocationID1, randomHexBytes())

        // After state
        const afterTokenSupply = await grt.totalSupply()
        const afterDelegationPool = await staking.delegationPools(indexer1.address)
        const afterIndexer1Stake = await staking.getIndexerStakedTokens(indexer1.address)

        // Check that rewards are put into indexer stake (only indexer cut)
        // Check that rewards are put into delegators pool accordingly

        // All the rewards in this subgraph go to this allocation.
        // Rewards per token will be (issuancePerBlock * nBlocks) / allocatedTokens
        // The first snapshot is after allocating, that is 1 block after the signal is minted.
        // The final snapshot is when we close the allocation, that happens 4 blocks after signal is minted.
        // So the rewards will be ((issuancePerBlock * 3) / allocatedTokens) * allocatedTokens
        const expectedIndexingRewards = toGRT('600')
        // Calculate delegators cut
        const indexerRewards = delegationParams.indexingRewardCut
          .mul(expectedIndexingRewards)
          .div(toBN(MAX_PPM))
        // Calculate indexer cut
        const delegatorsRewards = expectedIndexingRewards.sub(indexerRewards)
        // Check
        const expectedIndexerStake = beforeIndexer1Stake.add(indexerRewards)
        const expectedDelegatorsPoolTokens = beforeDelegationPool.tokens.add(delegatorsRewards)
        const expectedTokenSupply = beforeTokenSupply.add(expectedIndexingRewards)
        expect(toRound(afterIndexer1Stake)).eq(toRound(expectedIndexerStake))
        expect(toRound(afterDelegationPool.tokens)).eq(toRound(expectedDelegatorsPoolTokens))
        // Check that tokens have been minted
        expect(toRound(afterTokenSupply)).eq(toRound(expectedTokenSupply))
      })

      it('should deny rewards if subgraph on denylist', async function () {
        // Setup
        await rewardsManager
          .connect(governor.signer)
          .setSubgraphAvailabilityOracle(governor.address)
        await rewardsManager.connect(governor.signer).setDenied(subgraphDeploymentID1, true)
        await setupIndexerAllocation()

        // Jump
        await advanceToNextEpoch(epochManager)

        // Close allocation. At this point rewards should be collected for that indexer
        const tx = staking.connect(indexer1.signer).closeAllocation(allocationID1, randomHexBytes())
        await expect(tx)
          .emit(rewardsManager, 'RewardsDenied')
          .withArgs(indexer1.address, allocationID1, await epochManager.currentEpoch())
      })
    })
  })

  describe('edge scenarios', function () {
    it('close allocation on a subgraph that no longer have signal', async function () {
      // Update total signalled
      const signalled1 = toGRT('1500')
      await curation.connect(curator1.signer).mint(subgraphDeploymentID1, signalled1, 0)

      // Allocate
      const tokensToAllocate = toGRT('12500')
      await staking.connect(indexer1.signer).stake(tokensToAllocate)
      await staking
        .connect(indexer1.signer)
        .allocateFrom(
          indexer1.address,
          subgraphDeploymentID1,
          tokensToAllocate,
          allocationID1,
          metadata,
          await channelKey1.generateProof(indexer1.address),
        )

      // Jump
      await advanceToNextEpoch(epochManager)

      // Remove all signal from the subgraph
      const curatorShares = await curation.getCuratorSignal(curator1.address, subgraphDeploymentID1)
      await curation.connect(curator1.signer).burn(subgraphDeploymentID1, curatorShares, 0)

      // Close allocation. At this point rewards should be collected for that indexer
      await staking.connect(indexer1.signer).closeAllocation(allocationID1, randomHexBytes())
    })
  })

  describe('multiple allocations', function () {
    it('two allocations in the same block with a GRT burn in the middle should succeed', async function () {
      // If rewards are not monotonically increasing, this can trigger
      // a subtraction overflow error as seen in mainnet tx:
      // 0xb6bf7bbc446720a7409c482d714aebac239dd62e671c3c94f7e93dd3a61835ab
      await advanceToNextEpoch(epochManager)

      // Setup
      await epochManager.setEpochLength(10)

      // Update total signalled
      const signalled1 = toGRT('1500')
      await curation.connect(curator1.signer).mint(subgraphDeploymentID1, signalled1, 0)

      // Stake
      const tokensToStake = toGRT('12500')
      await staking.connect(indexer1.signer).stake(tokensToStake)

      // Allocate simultaneously, burning in the middle
      const tokensToAlloc = toGRT('5000')
      await provider().send('evm_setAutomine', [false])
      const tx1 = await staking
        .connect(indexer1.signer)
        .allocateFrom(
          indexer1.address,
          subgraphDeploymentID1,
          tokensToAlloc,
          allocationID1,
          metadata,
          await channelKey1.generateProof(indexer1.address),
        )
      const tx2 = await grt.connect(indexer1.signer).burn(toGRT(1))
      const tx3 = await staking
        .connect(indexer1.signer)
        .allocateFrom(
          indexer1.address,
          subgraphDeploymentID1,
          tokensToAlloc,
          allocationID2,
          metadata,
          await channelKey2.generateProof(indexer1.address),
        )

      await provider().send('evm_mine', [])
      await provider().send('evm_setAutomine', [true])

      await expect(tx1).emit(staking, 'AllocationCreated')
      await expect(tx2).emit(grt, 'Transfer')
      await expect(tx3).emit(staking, 'AllocationCreated')
    })
    it('two simultanous-similar allocations should get same amount of rewards', async function () {
      await advanceToNextEpoch(epochManager)

      // Setup
      await epochManager.setEpochLength(10)

      // Update total signalled
      const signalled1 = toGRT('1500')
      await curation.connect(curator1.signer).mint(subgraphDeploymentID1, signalled1, 0)

      // Stake
      const tokensToStake = toGRT('12500')
      await staking.connect(indexer1.signer).stake(tokensToStake)

      // Allocate simultaneously
      const tokensToAlloc = toGRT('5000')
      const tx1 = await staking.populateTransaction.allocateFrom(
        indexer1.address,
        subgraphDeploymentID1,
        tokensToAlloc,
        allocationID1,
        metadata,
        await channelKey1.generateProof(indexer1.address),
      )
      const tx2 = await staking.populateTransaction.allocateFrom(
        indexer1.address,
        subgraphDeploymentID1,
        tokensToAlloc,
        allocationID2,
        metadata,
        await channelKey2.generateProof(indexer1.address),
      )
      await staking.connect(indexer1.signer).multicall([tx1.data, tx2.data])

      // Jump
      await advanceToNextEpoch(epochManager)

      // Close allocations simultaneously
      const tx3 = await staking.populateTransaction.closeAllocation(allocationID1, randomHexBytes())
      const tx4 = await staking.populateTransaction.closeAllocation(allocationID2, randomHexBytes())
      const tx5 = await staking.connect(indexer1.signer).multicall([tx3.data, tx4.data])

      // Both allocations should receive the same amount of rewards
      const receipt = await tx5.wait()
      const event1 = rewardsManager.interface.parseLog(receipt.logs[1]).args
      const event2 = rewardsManager.interface.parseLog(receipt.logs[5]).args
      expect(event1.amount).eq(event2.amount)
    })
  })

  describe('rewards progression when collecting query fees', function () {
    it('collect query fees with two subgraphs and one allocation', async function () {
      async function getRewardsAccrual(subgraphs) {
        const [sg1, sg2] = await Promise.all(
          subgraphs.map((sg) => rewardsManager.getAccRewardsForSubgraph(sg)),
        )
        return {
          sg1,
          sg2,
          all: sg1.add(sg2),
        }
      }

      // set curation percentage
      await staking.setCurationPercentage(100000)

      // allow the asset holder
      const tokensToCollect = toGRT('10000')
      await staking.connect(governor.signer).setAssetHolder(assetHolder.address, true)

      // signal in two subgraphs in the same block
      const subgraphs = [subgraphDeploymentID1, subgraphDeploymentID2]
      for (const sub of subgraphs) {
        await curation.connect(curator1.signer).mint(sub, toGRT('1500'), 0)
      }

      // snapshot block before any accrual (we substract 1 because accrual starts after the first mint happens)
      const b1 = await epochManager.blockNum().then((x) => x.toNumber() - 1)

      // allocate
      const tokensToAllocate = toGRT('12500')
      await staking
        .connect(indexer1.signer)
        .multicall([
          await staking.populateTransaction.stake(tokensToAllocate).then((tx) => tx.data),
          await staking.populateTransaction
            .allocateFrom(
              indexer1.address,
              subgraphDeploymentID1,
              tokensToAllocate,
              allocationID1,
              metadata,
              await channelKey1.generateProof(indexer1.address),
            )
            .then((tx) => tx.data),
        ])

      // move time fwd
      await advanceBlock()

      // collect funds into staking for that sub
      await staking.connect(assetHolder.signer).collect(tokensToCollect, allocationID1)

      // check rewards diff
      await rewardsManager.getRewards(allocationID1).then(formatGRT)

      await advanceBlock()
      const accrual = await getRewardsAccrual(subgraphs)
      const b2 = await epochManager.blockNum().then((x) => x.toNumber())

      // round comparison because there is a small precision error due to dividing and accrual per signal
      expect(toRound(accrual.all)).eq(toRound(ISSUANCE_PER_BLOCK.mul(b2 - b1)))
    })
  })
})
