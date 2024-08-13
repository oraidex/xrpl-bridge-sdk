import { CwXrplClient } from "@oraichain/xrpl-bridge-contracts-sdk";
import { Operation } from "@oraichain/xrpl-bridge-contracts-sdk/build/CwXrpl.types";
import XRPLRpcClient from "src/client/xrpl_rpc";
import { BridgeSigners, XrplClient } from "src/type";
import { Signer, SubmittableTransaction } from "xrpl";
import {
  buildSignerListSetTxForMultiSigning,
  buildTicketCreateTxForMultiSigning,
  buildToXRPLXRPLOriginatedTokenTransferPaymentTxForMultiSigning,
  buildTrustSetTxForMultiSigning,
} from "./orai_to_xrpl_operation_tx";

export default class OraiToXrpl {
  constructor(
    protected readonly cwXrplClient: CwXrplClient,
    protected readonly xrplClient: XrplClient,
    protected readonly bridgeXRPLAddress: string
  ) {}

  async processPendingOperations() {
    let pendingOps = await this.cwXrplClient.pendingOperations({});
    if (pendingOps.operations.length == 0) {
      console.log("No pending operations to process");
      return;
    }

    let bridgeSigners = await this.getBridgeSigners();

    // todo: get bridge signer
    for (let operation of pendingOps.operations) {
      await this.signOrSubmitOperation(operation, bridgeSigners);
    }
  }

  async getBridgeSigners(): Promise<BridgeSigners> {
    const [xrplWeights, xrplWeightsQuorum] =
      await this.getBridgeXRPLSignerAccountsWithWeights();
    const contractConfig = await this.cwXrplClient.config();

    const xrplPubKeys: { [account: string]: string } = {};
    const oraiToXRPLAccount: { [account: string]: string } = {};
    for (const relayer of contractConfig.relayers) {
      // TODO: convert xrpl address to xrpl account
      const xrplAcc = relayer.xrpl_address;
      // TODO: convert xrpl pubkey to  account pubkey
      const accPubKey = relayer.xrpl_pub_key;

      xrplPubKeys[xrplAcc] = accPubKey;
      oraiToXRPLAccount[relayer.cosmos_address] = xrplAcc;
    }

    return {
      XRPLWeights: xrplWeights,
      XRPLWeightsQuorum: xrplWeightsQuorum,
      XRPLPubKeys: xrplPubKeys,
      OraiToXRPLAccount: oraiToXRPLAccount,
    };
  }

  async getBridgeXRPLSignerAccountsWithWeights(): Promise<
    [
      {
        [account: string]: number;
      },
      number
    ]
  > {
    const accountInfo = await XRPLRpcClient.accountInfo(
      this.xrplClient.client,
      this.bridgeXRPLAddress
    );
    const signerList = accountInfo.result.signer_lists;
    if (signerList.length != 1) {
      throw new Error("received unexpected length of the signer list");
    }
    const signerData = accountInfo.result.signer_lists[0];
    const weightsQuorum = signerData.SignerQuorum;
    const accountWights: { [account: string]: number } = {};
    for (let signerEntry of signerData.SignerEntries) {
      accountWights[signerEntry.SignerEntry.Account] =
        signerEntry.SignerEntry.SignerWeight;
    }

    return [accountWights, weightsQuorum];
  }

  async signOrSubmitOperation(
    operation: Operation,
    bridgeSigners: BridgeSigners
  ) {
    const valid = this.preValidateOperation(operation);

    if (!valid) {
      console.log("Operation is invalid", operation);
      return;
    }
    console.log(
      `Pre-validation of the operation passed, operation is valid, operation, ${operation})`
    );

    const [tx, quorumIsReached] = await this.buildSubmittableTransaction(
      operation,
      bridgeSigners
    );

    if (!quorumIsReached) {
      await this.registerTxSignature(operation);
      return;
    }

    // submit tx to XRPL chain
    const txRes = await this.xrplClient.client.submit(tx, {
      wallet: this.xrplClient.wallet,
    });

    //TODO: verify txRes result
  }

  // preValidateOperation checks if the operation is valid, and it makes sense to submit the corresponding transaction
  // or the operation should be canceled with the `invalid` state. For now the main purpose of the function is to filter
  // out the `AllocateTickets` operation with the invalid sequence.
  async preValidateOperation(operation: Operation): Promise<boolean> {
    // no need to check if the current relayer has already provided the signature
    // this check prevents the state when relayer votes and then changes its vote because of different current state
    for (const signature of operation.signatures) {
      if (signature.relayer_cosmos_address == this.xrplClient.relayerAddr) {
        return true;
      }
    }

    // currently we validate only the allocate tickets operation with not zero sequence
    if (
      !("allocate_tickets" in operation.operation_type) ||
      operation.operation_type.allocate_tickets.number == 0 ||
      operation.account_sequence == 0
    ) {
      return true;
    }

    let bridgeXRPLAccInfo = await XRPLRpcClient.accountInfo(
      this.xrplClient.client,
      this.bridgeXRPLAddress
    );
    // sequence is valid
    if (
      bridgeXRPLAccInfo.result.account_data.Sequence ==
      operation.account_sequence
    ) {
      return true;
    }
    console.log(
      `Invalid bridge account sequence, expected ${bridgeXRPLAccInfo.result.account_data.Sequence}, inOperation ${operation.account_sequence}`
    );
    console.log("Sending invalid tx evidence");
    await this.cwXrplClient.saveEvidence({
      evidence: {
        xrpl_transaction_result: {
          transaction_result: "invalid",
          account_sequence: operation.account_sequence,
        },
      },
    });

    return false;
  }

  // TODO
  async buildSubmittableTransaction(
    operation: Operation,
    bridgeSigners: BridgeSigners
  ): Promise<[SubmittableTransaction, boolean]> {
    const txSigners: Signer[] = [];
    let signedWeight = 0;
    let signingThresholdIsReached = false;

    for (const signature of operation.signatures) {
      if (
        !(signature.relayer_cosmos_address in bridgeSigners.OraiToXRPLAccount)
      ) {
        console.log(
          `Found unknown signer, oraiAddress: ${signature.relayer_cosmos_address}`
        );
        continue;
      }
      const xrplAcc =
        bridgeSigners.OraiToXRPLAccount[signature.relayer_cosmos_address];
      if (!(xrplAcc in bridgeSigners.XRPLPubKeys)) {
        console.log(
          `Found orai signer address without pub key in the contract, xrplAddress: ${xrplAcc})`
        );
        continue;
      }
      const xrplPubKey = bridgeSigners.XRPLPubKeys[xrplAcc];

      if (!(xrplAcc in bridgeSigners.XRPLWeights)) {
        console.log(
          `Found orai signer address without weight, xrplAddress: ${xrplAcc})`
        );
        continue;
      }
      const xrplAccWeight = bridgeSigners.XRPLWeights[xrplAcc];

      const txSigner: Signer = {
        Signer: {
          Account: xrplAcc,
          TxnSignature: signature.signature,
          SigningPubKey: xrplPubKey,
        },
      };

      const tx = await this.buildXRPLTxFromOperation(operation);
      // TODO: add signer into tx and validate

      txSigners.push(txSigner);
      signedWeight += xrplAccWeight;
      // the fewer signatures we use the less fee we pay
      if (signedWeight >= bridgeSigners.XRPLWeightsQuorum) {
        signingThresholdIsReached = true;
        break;
      }
    }

    // quorum is not reached
    if (!signingThresholdIsReached) {
      return [undefined, false];
    }
    // build tx one more time to be sure that it is not affected
    const tx = await this.buildXRPLTxFromOperation(operation);

    // TODO: add signer into tx and validate

    return [tx, true];
  }

  // TODO
  async registerTxSignature(operation: Operation) {
    const tx = this.buildXRPLTxFromOperation(operation);
    // TODO: sign and submit signatures to contract bridge
  }

  async buildXRPLTxFromOperation(operation: Operation) {
    switch (true) {
      case this.isAllocateTicketsOperation(operation):
        return buildTicketCreateTxForMultiSigning(
          this.bridgeXRPLAddress,
          operation
        );
      case this.isTrustSetOperation(operation):
        return buildTrustSetTxForMultiSigning(
          this.bridgeXRPLAddress,
          operation
        );
      case this.isCosmosToXRPLTransferOperation(operation):
        return buildToXRPLXRPLOriginatedTokenTransferPaymentTxForMultiSigning(
          this.bridgeXRPLAddress,
          operation
        );
      case this.isRotateKeysOperation(operation):
        return buildSignerListSetTxForMultiSigning(
          this.bridgeXRPLAddress,
          operation
        );
      default:
      // handle default case if needed
    }
  }

  isAllocateTicketsOperation(operation: Operation): boolean {
    return (
      "allocate_tickets" in operation.operation_type &&
      operation.operation_type.allocate_tickets.number > 0
    );
  }

  isTrustSetOperation(operation: Operation): boolean {
    return (
      "trust_set" in operation.operation_type &&
      operation.operation_type.trust_set.issuer != "" &&
      operation.operation_type.trust_set.currency != ""
    );
  }

  isCosmosToXRPLTransferOperation(operation: Operation): boolean {
    return (
      "cosmos_to_xrpl_transfer" in operation.operation_type &&
      operation.operation_type.cosmos_to_xrpl_transfer.issuer != "" &&
      operation.operation_type.cosmos_to_xrpl_transfer.currency != "" &&
      operation.operation_type.cosmos_to_xrpl_transfer.amount != "0" &&
      operation.operation_type.cosmos_to_xrpl_transfer.recipient != ""
    );
  }

  isRotateKeysOperation(operation: Operation): boolean {
    return (
      "rotate_keys" in operation.operation_type &&
      operation.operation_type.rotate_keys.new_relayers.length != 0 &&
      operation.operation_type.rotate_keys.new_evidence_threshold > 0
    );
  }
}