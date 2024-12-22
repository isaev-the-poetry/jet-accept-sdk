/**
 * Ethereum Transaction webhook sender for Jet-Accept Payments 
 *  
 * This script monitors Ethereum transactions for a specific wallet address
 * and detects Jet-Accept related transactions and send webhook notifications.
 * You can modify webhook content and delivery logic as needed.
 * Currently, it sends a POST request to the specified URL with the transaction details { hash, time, orderId }.
 * Also this script creates flag files to prevent duplicate notifications and log sended messages into them.
 * 
 *  * **(important) becasue of ERC20 narrowness, this scripts can detect only raw ETH transfers. 
 * ERC20 tokens not supports any mechanism to attach tracking data (ex orderId) with transactions.*
 * ps: etherscan_api_key is free, you can simply obtain it after registration
 *
 * Usage:
 *   npx tsx webhook.ts <wallet_address> <webhook_url> <etherscan_api_key>
 * 
 * Example:
 *   npx tsx webhook.ts 0x1234... http://your-webhook-url.com/endpoint YOURAPIKEY
 */

import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';

const ETHERSCAN_API_BASE = "https://api.etherscan.io/api";
const FLAGS_DIR = path.join(__dirname, "eth_delivery_log");

const TARGET_WALLET_ADDRESS = process.argv[2]?.toLowerCase();
const WEBHOOK_URI = process.argv[3];
const ETHERSCAN_API_KEY = process.argv[4];
const API_LIMIT = 20;

function sanitizeFilename(filename: string): string {
  return filename.replace(/[<>:"\/\\|?*\x00-\x1F]/g, "_");
}

if (!fs.existsSync(FLAGS_DIR)) {
  fs.mkdirSync(FLAGS_DIR);
}

async function fetchTransactions(address: string) {
  const maxRetries = 10;
  let retryCount = 0;

  while (retryCount < maxRetries) {
    try {
      const response = await fetch(
        `${ETHERSCAN_API_BASE}?module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&sort=desc&apikey=${ETHERSCAN_API_KEY}`
      );

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      return data.result.slice(0, API_LIMIT);
    } catch (error) {
      retryCount++;
      if (retryCount === maxRetries) {
        throw new Error(`Failed to fetch transactions after ${maxRetries} retries`);
      }
      console.log(`Retry attempt ${retryCount}/${maxRetries}`);
      await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
    }
  }
}

async function findJetAcceptTransactions(address: string) {
  try {
    const transactions = await fetchTransactions(address);

    for (const tx of transactions) {
      // Skip if not receiving transaction
      if (tx.to?.toLowerCase() !== address.toLowerCase()) {
        continue;
      }

      try {
        // Try to decode input data
        const inputData = tx.input;
        if (inputData === '0x') continue;

        let message = '';
        try {
          // Remove '0x' prefix and convert hex to string
          message = ethers.toUtf8String('0x' + inputData.slice(2));
        } catch (e) {
          continue; // Skip if can't decode
        }

        // Check if this is a Jet-Accept transaction
        if (message.includes('Order:') || message.includes('jet-accept.com')) {
          const orderMatch = message.match(/Order: ([^:]+)/);
          const orderId = orderMatch ? orderMatch[1].trim() : null;

          const sanitizedHash = sanitizeFilename(tx.hash);
          const flagPath = path.join(FLAGS_DIR, sanitizedHash);

          if (!fs.existsSync(flagPath)) {
            const webhook = {
              hash: tx.hash,
              time: new Date(parseInt(tx.timeStamp) * 1000).toISOString(),
              orderId,
              value: ethers.formatEther(tx.value),
            };

            try {
              const response = await fetch(WEBHOOK_URI, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify(webhook),
              });

              if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
              }

              fs.writeFileSync(flagPath, JSON.stringify(webhook, null, 2));
              console.log(`Webhook sent successfully for transaction ${webhook.hash}`);
            } catch (error) {
              console.error(`Failed to send webhook for transaction ${webhook.hash}:`, error);
            }
          }
        }
      } catch (error) {
        console.error(`Error processing transaction ${tx.hash}:`, error);
        continue;
      }
    }
  } catch (error) {
    console.error("Error fetching transactions:", error);
  }
}

if (!TARGET_WALLET_ADDRESS) {
  console.error("Please provide a wallet address as an argument");
  process.exit(1);
}
if (!WEBHOOK_URI) {
  console.error("Please provide a webhook uri as an argument");
  process.exit(1);
}
if (!ETHERSCAN_API_KEY) {
  console.error("Please provide an Etherscan API key as an argument");
  process.exit(1);
}

console.log(`Searching transactions for address: ${TARGET_WALLET_ADDRESS}`);
findJetAcceptTransactions(TARGET_WALLET_ADDRESS).catch(console.error);

// Set up polling interval (every 30 seconds)
setInterval(() => {
  findJetAcceptTransactions(TARGET_WALLET_ADDRESS).catch(console.error);
}, 30000);
