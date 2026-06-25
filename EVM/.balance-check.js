const { ethers } = require('ethers');
const fs = require('fs');
require('dotenv').config({ path: '.env' });

const chains = [
  { name: 'baseSepolia', rpc: process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org', id: 84532 },
  { name: 'bscTestnet',  rpc: process.env.BSC_TESTNET_RPC_URL  || 'https://bsc-testnet-rpc.publicnode.com', id: 97 },
];

(async () => {
  const pk = process.env.PRIVATE_KEY.startsWith('0x') ? process.env.PRIVATE_KEY : '0x'+process.env.PRIVATE_KEY;
  for (const c of chains) {
    const provider = new ethers.JsonRpcProvider(c.rpc, c.id);
    const w = new ethers.Wallet(pk, provider);
    const bal = await provider.getBalance(w.address);
    console.log(`${c.name}: ${w.address} -> ${ethers.formatEther(bal)} native`);
  }
})();
