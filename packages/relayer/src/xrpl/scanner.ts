import { XrplTransactionAndMetadataWrap } from "src/type";
import { Client } from "xrpl";
import XRPLRpcClient from "./xrpl_rpc";

export default class XRPLScanner {
  minLedger: number;
  constructor(
    protected readonly client: Client,
    protected readonly account: string,
    minLedger: number = -1
  ) {
    this.minLedger = minLedger;
  }

  async scanTransactions(): Promise<XrplTransactionAndMetadataWrap[]> {
    const txs: XrplTransactionAndMetadataWrap[] = [];
    let marker = undefined;
    let lastLedger = -1;
    while (true) {
      const accountTxResult = await XRPLRpcClient.accountTransactions(
        this.client,
        this.account,
        this.minLedger,
        -1,
        marker
      );

      // we accept the transaction from the validated ledger only
      if (accountTxResult.result.validated) {
        for (const tx of accountTxResult.result.transactions) {
          let txWithMetadata: XrplTransactionAndMetadataWrap = {
            transaction: tx.tx_json,
            metadata: typeof tx.meta != "string" ? tx.meta : undefined,
            hash: tx.hash,
          };
          txs.push(txWithMetadata);
          lastLedger = Math.max(lastLedger, tx.ledger_index);
        }
      }
      if (!accountTxResult.result.marker) {
        break;
      }
      marker = accountTxResult.result.marker;
    }
    this.minLedger = lastLedger;

    return txs;
  }
}

(async () => {
  const client = new Client("wss://s.altnet.rippletest.net:51233");
  await client.connect();
  const multisigAddr = "rK6GUy3ki2DFxbqe6CyZiSNZvgiUmDBPZU";
  let scanner = new XRPLScanner(client, multisigAddr);
  await scanner.scanTransactions();
  await client.disconnect();
})();