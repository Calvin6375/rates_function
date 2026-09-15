/**
 * @fileoverview Avalanche C-Chain mainnet configuration.
 */

const {normalizeAddress} = require("./fujiNetwork");
const config = require("../../../config");

/**
 * @returns {{
 *   name: string,
 *   network: string,
 *   blockchain: string,
 *   chainLabel: string,
 *   chainId: number,
 *   rpcUrl: string,
 *   usdcContract: string,
 *   nativeToken: string,
 *   usdcDecimals: number,
 *   confirmations: number,
 *   treasuryAddress: string,
 * }}
 */
function getAvalancheNetwork() {
  const avalanche = config.avalanche;
  const rail = config.cryptoRail;
  return {
    name: avalanche.name,
    network: avalanche.network,
    blockchain: avalanche.blockchain,
    chainLabel: avalanche.chainLabel,
    chainId: Number(process.env.AVALANCHE_CHAIN_ID || avalanche.chainId),
    rpcUrl: String(process.env.AVALANCHE_RPC_URL || avalanche.rpcUrl),
    usdcContract: normalizeAddress(
        process.env.AVALANCHE_USDC_CONTRACT || avalanche.usdcContract,
    ),
    nativeToken: avalanche.nativeToken,
    usdcDecimals: Number(avalanche.usdcDecimals),
    confirmations: Math.max(
        1,
        Number(process.env.CRYPTO_CONFIRMATIONS || rail.confirmations) || 1,
    ),
    treasuryAddress: normalizeAddress(
        process.env.CRYPTO_TREASURY_ADDRESS || rail.treasuryAddress,
    ),
  };
}

module.exports = {
  getAvalancheNetwork,
};
