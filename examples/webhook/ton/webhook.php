<?php
/**
 * Transaction webhook sender for Jet-Accept Payments
 * 
 * This script monitors TON blockchain transactions for a specific wallet address
 * and detects Jet-Accept related transactions and send webhook notifications.
 * 
 * Usage:
 *   php webhook.php <wallet_address> <webhook_url>
 */

const TONCENTER_API_BASE = "https://toncenter.com/api/v2";
const API_LIMIT = 20;
const FLAGS_DIR = __DIR__ . "/wh_delivery_log";

if (!isset($argv[1]) || !isset($argv[2])) {
    die("Usage: php webhook.php <wallet_address> <webhook_url>\n");
}

$TARGET_WALLET_ADDRESS = $argv[1];
$WEBHOOK_URI = $argv[2];

if (!file_exists(FLAGS_DIR)) {
    mkdir(FLAGS_DIR, 0777, true);
}

function sanitizeFilename($filename) {
    return preg_replace('/[<>:"\/\\|?*\x00-\x1F]/', '_', $filename);
}

function fetchTransactions($address) {
    $maxRetries = 10;
    $retryCount = 0;

    while ($retryCount < $maxRetries) {
        $ch = curl_init();
        curl_setopt($ch, CURLOPT_URL, TONCENTER_API_BASE . "/getTransactions?address={$address}&limit=" . API_LIMIT);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);

        $response = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        if ($httpCode === 200) {
            $data = json_decode($response, true);
            return $data['result'];
        }

        $retryCount++;
        if ($retryCount === $maxRetries) {
            throw new Exception("Failed to fetch transactions after {$maxRetries} retries");
        }
        echo "Retry attempt {$retryCount}/{$maxRetries}\n";
        sleep($retryCount); // Exponential backoff
    }
}

function findJetAcceptTransactions($address) {
    try {
        $transactions = fetchTransactions($address);

        foreach ($transactions as $tx) {
            $message = "";

            if (isset($tx['in_msg']['message'])) {
                $message = $tx['in_msg']['message'];
            }

            if (isset($tx['out_msgs']) && !empty($tx['out_msgs'])) {
                foreach ($tx['out_msgs'] as $outMsg) {
                    if (isset($outMsg['message'])) {
                        $message .= ($message ? " | " : "") . $outMsg['message'];
                    }
                }
            }

            if (stripos($message, 'jet-accept') !== false) {
                preg_match('/Jet-accept\.com #([^:]+)/i', $message, $orderMatch);
                $orderId = $orderMatch ? $orderMatch[1] : null;

                $sanitizedHash = sanitizeFilename($tx['transaction_id']['hash']);
                $flagPath = FLAGS_DIR . '/' . $sanitizedHash;

                if (!file_exists($flagPath)) {
                    $webhook = [
                        'hash' => $tx['transaction_id']['hash'],
                        'time' => date('c', $tx['utime']),
                        'orderId' => $orderId
                    ];

                    // Send webhook
                    $ch = curl_init($WEBHOOK_URI);
                    curl_setopt($ch, CURLOPT_POST, 1);
                    curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($webhook));
                    curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/json']);
                    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);

                    $response = curl_exec($ch);
                    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
                    curl_close($ch);

                    if ($httpCode === 200) {
                        file_put_contents($flagPath, json_encode($webhook, JSON_PRETTY_PRINT));
                        echo "Webhook sent successfully for transaction {$webhook['hash']}\n";
                    } else {
                        echo "Failed to send webhook for transaction {$webhook['hash']}: HTTP {$httpCode}\n";
                    }
                }
            }
        }
    } catch (Exception $e) {
        echo "Error fetching transactions: " . $e->getMessage() . "\n";
    }
}

echo "Searching transactions for address: {$TARGET_WALLET_ADDRESS}\n";
findJetAcceptTransactions($TARGET_WALLET_ADDRESS);
