/**
 * Transaction webhook sender for Jet-Accept Payments
 *
 * This script monitors TON blockchain transactions for a specific wallet address
 * and detects Jet-Accept related transactions and send webhook notifications.
 * You can modify webhook content and delivery logic as needed.
 * Currently, it sends a POST request to the specified URL with the transaction details { hash, time, orderId }.
 * Also this script creates flag files to prevent duplicate notifications and log sended messages into them.
 *
 * Usage:
 *   npx tsx webhook.ts <wallet_address> <webhook_url>
 *
 * Arguments:
 *   wallet_address - The TON wallet address to monitor
 *   webhook_url    - URL where transaction notifications will be sent
 *
 * Example:
 *   npx tsx webhook.ts EQB...xyz http://your-webhook-url.com/endpoint
 *
 * The script will:
 * 1. Fetch recent transactions for the specified wallet
 * 2. Look for messages containing "jet-accept"
 * 3. Extract order numbers from matching transactions
 * 4. Send webhook notifications for new transactions
 * 5. Create flag files to prevent duplicate notifications
 */

const TONCENTER_API_BASE = "https://toncenter.com/api/v2";
const fs = require("fs");
const path = require("path");

const TARGET_WALLET_ADDRESS = process.argv[2];
const WEBHOOK_URI = process.argv[3];
const API_LIMIT = 20;
const FLAGS_DIR = path.join(__dirname, "wh_delivery_log");

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
        `${TONCENTER_API_BASE}/getTransactions?address=${address}&limit=${API_LIMIT}`
      );
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const data = await response.json();
      return data.result;
    } catch (error) {
      retryCount++;
      if (retryCount === maxRetries) {
        throw new Error(
          `Failed to fetch transactions after ${maxRetries} retries`
        );
      }
      console.log(`Retry attempt ${retryCount}/${maxRetries}`);
      await new Promise((resolve) => setTimeout(resolve, 1000 * retryCount)); // Exponential backoff
    }
  }
}

async function findJetAcceptTransactions(address: string) {
  try {
    const transactions = await fetchTransactions(address);

    for (const tx of transactions) {
      let message = "";

      if (tx.in_msg?.message) {
        message = tx.in_msg.message;
      }

      if (tx.out_msgs && tx.out_msgs.length > 0) {
        for (const outMsg of tx.out_msgs) {
          if (outMsg.message) {
            if (message) message += " | ";
            message += outMsg.message;
          }
        }
      }

      if (message.toLowerCase().includes("jet-accept")) {
        const orderMatch = message.match(/Jet-accept\.com #([^:]+)/i);
        const orderId = orderMatch ? orderMatch[1] : null;

        const sanitizedHash = sanitizeFilename(tx.transaction_id.hash);
        const flagPath = path.join(FLAGS_DIR, sanitizedHash);

        if (!fs.existsSync(flagPath)) {
          const webhook = {
            hash: tx.transaction_id.hash,
            time: new Date(tx.utime * 1000).toISOString(),
            orderId,
          };

          // Send webhook
          try {
            const response = await fetch(WEBHOOK_URI, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify(webhook),
            });

            if (!response.ok) {
              throw new Error(`HTTP error! status: ${response.status}`);
            }

            // Create flag file
            fs.writeFileSync(flagPath, JSON.stringify(webhook, null, 2));
            console.log(
              `Webhook sent successfully for transaction ${webhook.hash}`
            );
          } catch (error) {
            console.error(
              `Failed to send webhook for transaction ${webhook.hash}:`,
              error
            );
          }
        }
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

console.log(`Searching transactions for address: ${TARGET_WALLET_ADDRESS}`);
findJetAcceptTransactions(TARGET_WALLET_ADDRESS).catch(console.error);
