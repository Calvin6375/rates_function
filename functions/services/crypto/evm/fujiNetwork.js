/**
 * @fileoverview Avalanche Fuji C-Chain configuration (testnet only).
 */

const {getAddress} = require("ethers");
const config = require("../../../config");

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

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
function getFujiNetwork() {
  const fuji = config.avalancheFuji;
  const rail = config.cryptoRail;
  return {
    name: fuji.name,
    network: fuji.network,
    blockchain: fuji.blockchain,
    chainLabel: fuji.chainLabel,
    chainId: Number(process.env.AVALANCHE_FUJI_CHAIN_ID || fuji.chainId),
    rpcUrl: String(process.env.AVALANCHE_FUJI_RPC_URL || fuji.rpcUrl),
    usdcContract: normalizeAddress(
        process.env.AVALANCHE_FUJI_USDC_CONTRACT || fuji.usdcContract,
    ),
    nativeToken: fuji.nativeToken,
    usdcDecimals: Number(fuji.usdcDecimals),
    confirmations: Math.max(
        1,
        Number(process.env.CRYPTO_CONFIRMATIONS || rail.confirmations) || 1,
    ),
    treasuryAddress: normalizeAddress(
        process.env.CRYPTO_TREASURY_ADDRESS || rail.treasuryAddress,
    ),
  };
}

/**
 * @param {string} address
 * @returns {string}
 */
function normalizeAddress(address) {
  return String(address || "").toLowerCase();
}

/**
 * @param {string} address
 * @returns {boolean}
 */
function isValidEvmAddress(address) {
  if (!address || typeof address !== "string") return false;
  try {
    const checksummed = getAddress(address);
    return checksummed.toLowerCase() !== ZERO_ADDRESS;
  } catch (_err) {
    return false;
  }
}

/**
 * @param {string} address
 * @returns {boolean}
 */
function isTreasuryAddress(address) {
  const treasury = normalizeAddress(getFujiNetwork().treasuryAddress);
  return normalizeAddress(address) === treasury;
}

/**
 * ERC-20 Transfer event topic0.
 * keccak256("Transfer(address,address,uint256)")
 */
const TRANSFER_EVENT_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const ERC20_TRANSFER_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
];

module.exports = {
  ZERO_ADDRESS,
  TRANSFER_EVENT_TOPIC,
  ERC20_TRANSFER_ABI,
  getFujiNetwork,
  normalizeAddress,
  isValidEvmAddress,
  isTreasuryAddress,
};
