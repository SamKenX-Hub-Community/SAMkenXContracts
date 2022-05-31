import { task } from 'hardhat/config'
import '@nomiclabs/hardhat-ethers'
import { cliOpts } from '../../cli/defaults'
import { readConfig, writeConfig } from '../../cli/config'
import YAML from 'yaml'

import { Scalar, YAMLMap } from 'yaml/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import fs from 'fs'
import inquirer from 'inquirer'

interface Contract {
  name: string
  initParams: ContractInitParam[]
}

interface GeneralParam {
  contract: string // contract where the param is defined
  name: string // name of the parameter
}

interface ContractInitParam {
  name: string // as declared in config.yml
  type: 'number' | 'BigNumber' // as returned by the contract
  getter?: string // name of function to get the value from the contract. Defaults to 'name'
  format?: 'number' // some parameters are stored in different formats than what the contract reports.
}

const epochManager: Contract = {
  name: 'EpochManager',
  initParams: [
    { name: 'lengthInBlocks', type: 'BigNumber', getter: 'epochLength', format: 'number' },
  ],
}

const curation: Contract = {
  name: 'Curation',
  initParams: [
    { name: 'reserveRatio', type: 'number', getter: 'defaultReserveRatio' },
    { name: 'curationTaxPercentage', type: 'number' },
    { name: 'minimumCurationDeposit', type: 'BigNumber' },
  ],
}

const disputeManager: Contract = {
  name: 'DisputeManager',
  initParams: [
    { name: 'minimumDeposit', type: 'BigNumber' },
    { name: 'fishermanRewardPercentage', type: 'number' },
    { name: 'idxSlashingPercentage', type: 'number' },
    { name: 'qrySlashingPercentage', type: 'number' },
  ],
}

const staking: Contract = {
  name: 'Staking',
  initParams: [
    { name: 'minimumIndexerStake', type: 'BigNumber' },
    { name: 'thawingPeriod', type: 'number' },
    { name: 'protocolPercentage', type: 'number' },
    { name: 'curationPercentage', type: 'number' },
    { name: 'channelDisputeEpochs', type: 'number' },
    { name: 'maxAllocationEpochs', type: 'number' },
    { name: 'delegationUnbondingPeriod', type: 'number' },
    { name: 'delegationRatio', type: 'number' },
    { name: 'rebateAlphaNumerator', type: 'number', getter: 'alphaNumerator' },
    { name: 'rebateAlphaDenominator', type: 'number', getter: 'alphaDenominator' },
  ],
}

const rewardsManager: Contract = {
  name: 'RewardsManager',
  initParams: [{ name: 'issuanceRate', type: 'BigNumber' }],
}

const contractList: Contract[] = [epochManager, curation, disputeManager, staking, rewardsManager]

const generalParams: GeneralParam[] = [
  {
    contract: 'DisputeManager',
    name: 'arbitrator',
  },
  {
    contract: 'Controller',
    name: 'governor',
  },
  {
    contract: 'AllocationExchange',
    name: 'authority',
  },
]

task('update-config', 'Update graph config parameters with onchain data')
  .addParam('graphConfig', cliOpts.graphConfig.description, cliOpts.graphConfig.default)
  .addFlag('dryRun', "Only print the changes, don't write them to the config file")
  .setAction(async (taskArgs, hre) => {
    const networkName = hre.network.name
    const configFile = taskArgs.graphConfig
    const dryRun = taskArgs.dryRun

    if (!fs.existsSync(configFile)) {
      throw new Error(`Could not find config file: ${configFile}`)
    }

    console.log('## Update graph config ##')
    console.log(`Network: ${networkName}`)
    console.log(`Config file: ${configFile}\n`)

    // Prompt to avoid accidentally overwriting the config file with data from another network
    if (!configFile.includes(networkName)) {
      const res = await inquirer.prompt({
        name: 'confirm',
        type: 'confirm',
        default: false,
        message: `Config file ${configFile} doesn't match 'graph.<networkName>.yml'. Are you sure you want to continue?`,
      })
      if (!res.confirm) {
        return
      }
    }

    const graphConfig = readConfig(configFile, true)

    // general parameters
    console.log(`> General`)
    for (const param of generalParams) {
      await updateGeneralParams(hre, param, graphConfig)
    }

    // contracts parameters
    for (const contract of contractList) {
      console.log(`> ${contract.name}`)
      await updateContractParams(hre, contract, graphConfig)
    }

    if (dryRun) {
      console.log('\n Dry run enabled, printing changes to console (no files updated)\n')
      console.log(graphConfig.toString())
    } else {
      writeConfig(configFile, graphConfig.toString())
    }
  })

const updateGeneralParams = async (
  hre: HardhatRuntimeEnvironment,
  param: GeneralParam,
  config: YAML.Document.Parsed,
) => {
  const value = await hre.contracts[param.contract][param.name]()
  const updated = updateItem(config, `general/${param.name}`, value)
  if (updated) {
    console.log(`\t- Updated ${param.name} to ${value}`)
  }
}

const updateContractParams = async (
  hre: HardhatRuntimeEnvironment,
  contract: Contract,
  config: YAML.Document.Parsed,
) => {
  for (const param of contract.initParams) {
    let value = await hre.contracts[contract.name][param.getter ?? param.name]()
    if (param.type === 'BigNumber') {
      if (param.format === 'number') {
        value = value.toNumber()
      } else {
        value = value.toString()
      }
    }

    const updated = updateItem(config, `contracts/${contract.name}/init/${param.name}`, value)
    if (updated) {
      console.log(`\t- Updated ${param.name} to ${value}`)
    }
  }
}

// YAML helper functions
const getNode = (doc: YAML.Document.Parsed, path: string[]): YAMLMap => {
  try {
    let node: YAMLMap
    for (const p of path) {
      node = node === undefined ? doc.get(p) : node.get(p)
    }
    return node
  } catch (error) {
    throw new Error(`Could not find node: ${path}.`)
  }
}

const getItem = (node: YAMLMap, key: string): Scalar => {
  if (!node.has(key)) {
    throw new Error(`Could not find item: ${key}.`)
  }
  return node.get(key, true) as Scalar
}

// eslint-disable-next-line  @typescript-eslint/no-explicit-any
const updateItem = (doc: YAML.Document.Parsed, path: string, value: any): boolean => {
  const splitPath = path.split('/')
  const itemKey = splitPath.pop()

  const node = getNode(doc, splitPath)
  const item = getItem(node, itemKey)

  const updated = item.value !== value
  item.value = value
  return updated
}
