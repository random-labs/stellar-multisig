// @flow

import StellarSdk from 'stellar-sdk';

import {
    getHintFromSignature,
    getHintFromSigner
} from './hints';

import {
    getTransactionHashRaw
} from './sign';

import type {
    AccountInfo,
    Signer,
    SignerTypeEnum,
    ThresholdCategory,
    xdr$DecoratedSignature
} from 'stellar-sdk';

import type {
    signatureHint
} from './hints';

export opaque type pubKey = string;
export type signature = xdr$DecoratedSignature;

/**
 */

export type signatureWeights = {[string]: number};

export type signers = {
    hints: {[signatureHint]: Set<string>},
    keys: {[string]: signatureWeights},
    isEmpty: boolean
};

export class TooManySignatures extends Error {};

/**
 * Returns the source account for an operation
 *
 * @private
 * @param   {StellarSdk.Operation}      op
 * @param   {StellarSdk.Transaction}    tx
 * @returns {pubKey}
 */

const getOperationSourceAccount = (
    op: StellarSdk.Operation,
    tx: StellarSdk.Transaction
): pubKey => (op.source ? op.source : tx.source);

/**
 * Returns the source accounts for a transaction
 *
 * @param {StellarSdk.Transaction}  tx
 * @returns {Set<pubKey>}
 */

const getTransactionSourceAccounts = (
    tx: StellarSdk.Transaction
): Set<pubKey> =>
    new Set(tx.operations.map((op) => getOperationSourceAccount(op, tx)));

/**
 * Returns the threshold category of an operation
 *
 * @private
 * @param   {StellarSdk.Operation}  op
 * @returns {ThresholdCategory}
 */

const getOperationCategory = (
    op: StellarSdk.Operation
): ThresholdCategory => {
    if (op.type === 'setOptions') {
        if (
            op.masterWeight ||
            op.lowThreshold ||
            op.medThreshold ||
            op.highThreshold ||
            op.signer
        ) {
            return 'high_threshold';
        }
    } else if (
        op.type === 'allowTrust' ||
        op.type === 'bumpSequence' ||
        op.type === 'inflation'
    ) {
        return 'low_threshold';
    }

    return 'med_threshold';
};

/**
 * Gets the required signing threshold for each source account in a transaction
 *
 * @param   {StellarSdk.Transaction}    tx
 * @param   {Array<AccountInfo>}        accounts
 * @returns {signatureWeights}
 */

const getThresholds = (
    tx: StellarSdk.Transaction,
    accounts: Array<AccountInfo>
): signatureWeights => {

    const thresholds: signatureWeights = {};
    const accountMap: {[string]: AccountInfo} = {};

    accounts.forEach((account) => {
        thresholds[account.id] = 1;
        accountMap[account.id] = account;
    });

    //
    //  handle transaction envelope source account
    //

    const accountThresholds = accountMap[tx.source].thresholds;
    const txThreshold = accountThresholds.low_threshold;
    thresholds[tx.source] = Math.max(thresholds[tx.source], txThreshold);

    tx.operations.forEach((op) => {
        const source = getOperationSourceAccount(op, tx);
        const category = getOperationCategory(op);

        const accountThresholds = accountMap[source].thresholds;
        const opThreshold = accountThresholds[category];

        thresholds[source] = Math.max(thresholds[source], opThreshold);

        if (op.type === 'setOptions') {
            if ('lowThreshold' in op) {
                accountThresholds.low_threshold = op.lowThreshold;
            }

            if ('medThreshold' in op) {
                accountThresholds.med_threshold = op.medThreshold;
            }

            if ('highThreshold' in op) {
                accountThresholds.high_threshold = op.highThreshold;
            }
        }
    });

    return thresholds;
};

/**
 * Gets the thresholds for when a source account rejects a transaction
 *
 * @param   {Array<AccountInfo>}    accounts
 * @param   {signatureWeights}      thresholds
 * @returns {signatureWeights}
 */

const getRejectionThresholds = (
    accounts: Array<AccountInfo>,
    thresholds: signatureWeights
): signatureWeights => {

    const totals: signatureWeights = {};
    accounts.forEach((account) => {
        const t: number = thresholds[account.id];
        totals[account.id] = account.signers
            .map(signer => signer.weight)
            .reduce((a, b) => a + b, -t);
    });

    return totals;
};

/**
 *
 * @param   {StellarSdk.Transaction}    tx
 * @param   {Array<AccountInfo>}        accounts
 * @param                               type
 * @returns {signers}
 */

const getSigners = (
    tx: StellarSdk.Transaction,
    accounts: Array<AccountInfo>,
    type: SignerTypeEnum
): signers => {

    const signers: signers = {
        hints: {},
        keys: {},
        isEmpty: true
    };

    const add = (signer: Signer, accountId: pubKey) => {
        const hint = getHintFromSigner(signer);
        if (!((hint: any) in signers.hints)) {
            signers.hints[hint] = new Set();
        }

        const {key, weight} = signer;
        signers.hints[hint].add(key);

        if (!(key in signers.keys)) {
            signers.keys[key] = {};
        }
        signers.keys[key][accountId] = weight;
        signers.isEmpty = false;
    };

    accounts.forEach((account) => {
        account.signers
        .filter((signer) => signer.type !== 'preauth_tx')
        .filter((signer) => signer.type === type)
        .forEach((signer) => {
            add(signer, account.id);
        });
    });

    //  if any op is adding/modifying a signer, apply it to its source account

    if (type === 'ed25519_public_key') {
        tx.operations
        .filter((op) =>
            (op.type === 'setOptions') && op.signer &&
            (op.signer.type !== 'preAuthTx') && (op.signer.weight !== 0)
        )
        .forEach((op) => {
            const account = getOperationSourceAccount(op, tx);
            add(op.signer, account);
        });
    }

    return signers;
};

/**
 * @private
 * @param weights
 * @param signer
 */

const updateSigningWeights = (
    weights: signatureWeights,
    signer: signatureWeights,
): void => {

    Object.keys(signer).forEach((id) => {
        if (id in weights) {
            weights[id] += signer[id];
        } else {
            weights[id]  = signer[id];
        }
    });
};

/**
 * Validates a signature and returns the key that signed it, if any
 *
 * @param {Buffer} txHash
 * @param signers
 * @param {signature} signature
 * @return {string | null}
 */

const validateSignature = (
    txHash: Buffer,
    signers: signers,
    signature: signature
): string | null => {

    const hint = getHintFromSignature(signature);
    const keys = signers.hints[hint];
    if (!keys) {
        return null;
    }

    for (let key of keys) {
        if (key[0] === 'G') {
            const keypair = StellarSdk.Keypair.fromPublicKey(key);
            const sig = signature.signature();
            if (keypair.verify(txHash, sig)) {
                return key;
            }
        }

        else if (key[0] === 'X') {
            const preimage = signature.signature();
            const hashx = StellarSdk.hash(preimage);
            const hashxKey = StellarSdk.StrKey.encodeSha256Hash(hashx);
            if (hashxKey === key) {
                return key;
            }
        }
    }

    return null;
};

/**
 *
 * @param weights
 * @param signers
 * @param signingKey
 */

const addSignatureToWeights = (
    weights: signatureWeights,
    signers: signers,
    signingKey: string
): void => {
    const signer = signers.keys[signingKey];
    updateSigningWeights(weights, signer);
};

/**
 * Checks the signature weights accumulated so far, to see if enough weight has
 * been added that the signers have approved the transaction.
 *
 * @param weights
 * @param thresholds
 * @return {boolean}
 */

const hasEnoughApprovals = (
    weights: signatureWeights,
    thresholds: signatureWeights
): boolean =>
    Object.keys(thresholds).every((key) => weights[key] >= thresholds[key]);

/**
 * Checks the signature rejection weights accumulated so far, to see if enough
 * weight have been added that the signers have rejected the transaction, i.e.
 * it cannot be approved by the other signers.
 *
 * @param weights
 * @param rejects
 * @return {boolean}
 */

const hasEnoughRejections = (
    weights: signatureWeights,
    rejects: signatureWeights
): boolean =>
    Object.keys(rejects).every((key) => weights[key] > rejects[key]);

/**
 *
 * @param tx
 * @param networkId
 * @param accounts
 * @param signatures
 * @param preAuth
 * @return {boolean}
 * @throws {TooManySignatures}
 */

const isApproved = (
    tx: StellarSdk.Transaction,
    networkId: Buffer,
    accounts: Array<AccountInfo>,
    signatures: Array<signature>,
    preAuth?: Array<string>
): boolean => {

    const txHash = getTransactionHashRaw(tx, networkId);

    const hashXSigners = getSigners(tx, accounts, 'sha256_hash');
    const ed25519Signers = getSigners(tx, accounts, 'ed25519_public_key');
    const thresholds = getThresholds(tx, accounts);
    const weights = {};

    let isDone = false;

    if (preAuth) {
        for (let signingKey of preAuth) {
            if (isDone) {
                return true;
            }

            addSignatureToWeights(weights, ed25519Signers, signingKey);
            isDone = hasEnoughApprovals(weights, thresholds);
        }
    }

    let signaturesUsed = 0;

    const checkSignatures = (signers: signers) => {

        if (signers.isEmpty) {
            return;
        }

        for (let [index, signature] of signatures.entries()) {
            if (isDone) {
                break;
            }

            const signingKey = validateSignature(txHash, signers, signature);
            if (signingKey) {
                addSignatureToWeights(weights, signers, signingKey);
                isDone = hasEnoughApprovals(weights, thresholds);
                signaturesUsed |= (1 << index);
            }
        }
    };

    checkSignatures(hashXSigners);
    checkSignatures(ed25519Signers);

    const allSignatures = (1 << signatures.length) - 1;
    if (signaturesUsed !== allSignatures) {
        throw new TooManySignatures();
    }

    return isDone;
};

export {
    addSignatureToWeights,
    getRejectionThresholds,
    getSigners,
    getThresholds,
    getTransactionSourceAccounts,

    validateSignature,
    isApproved,
    hasEnoughApprovals,
    hasEnoughRejections
}
