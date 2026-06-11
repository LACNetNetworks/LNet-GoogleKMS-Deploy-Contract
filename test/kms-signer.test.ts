import { expect } from 'chai';
import { AbiCoder, Transaction, getAddress, isAddress } from 'ethers';
import { LacchainProvider } from '@lacchain/gas-model-provider';
import {
  KmsConfig,
  KmsLnetSigner,
  kmsGetAddress,
  kmsKeyName,
} from '../kms-lnet-signer';

const NODE_ADDRESS = '0xd00e6624a73f88b39f82ab34e8bf2b4d226fd768';
const EXPIRATION = 1893456000; // fijo para aserciones deterministas

function kmsConfigFromEnv(): KmsConfig | null {
  const { KMS_PROJECT, KMS_LOCATION, KMS_KEYRING, KMS_KEY } = process.env;
  if (!KMS_PROJECT || !KMS_LOCATION || !KMS_KEYRING || !KMS_KEY) return null;
  return {
    keyName: kmsKeyName({
      project: KMS_PROJECT,
      location: KMS_LOCATION,
      keyRing: KMS_KEYRING,
      key: KMS_KEY,
      version: process.env.KMS_KEY_VERSION ?? '1',
    }),
  };
}

describe('KmsLnetSigner contra Google Cloud KMS (secp256k1)', function () {
  this.timeout(30_000);

  const cfg = kmsConfigFromEnv();
  let address: string | undefined;

  before(async function () {
    if (!cfg) {
      console.warn(
        '\n  ⚠️  KMS no configurado — define KMS_PROJECT/KMS_LOCATION/KMS_KEYRING/KMS_KEY\n' +
          '      y GOOGLE_APPLICATION_CREDENTIALS para correr este test.\n',
      );
      this.skip();
      return;
    }
    try {
      address = await kmsGetAddress(cfg);
    } catch (e) {
      console.warn(`\n  ⚠️  KMS no accesible: ${(e as Error).message}\n`);
      this.skip();
    }
  });

  it('deriva una address Ethereum válida de la clave de KMS', () => {
    expect(isAddress(address!)).to.equal(true);
  });

  it('firma una tx y el from recuperado coincide con la clave de KMS', async () => {
    const provider = new LacchainProvider('http://127.0.0.1:1'); // no se usa
    const signer = new KmsLnetSigner(
      cfg!,
      address!,
      provider,
      NODE_ADDRESS,
      EXPIRATION,
    );

    // tx totalmente poblada -> signTransaction no toca el provider
    const tx = {
      to: '0x1111111111111111111111111111111111111111',
      nonce: 0,
      gasLimit: 100_000n,
      gasPrice: 0,
      value: 0n,
      data: '0x60fe47b1000000000000000000000000000000000000000000000000000000000000002a',
      type: 0,
    };

    const raw = await signer.signTransaction(tx);
    const parsed = Transaction.from(raw);

    // 1) Recuperación: el firmante es la clave de KMS
    expect(getAddress(parsed.from!)).to.equal(getAddress(address!));

    // 2) Gas model: chainId 0 (Homestead, pre-EIP155)
    expect(parsed.chainId).to.equal(0n);

    // 3) Gas model: data lleva nodeAddress + expiration al final
    const suffix = AbiCoder.defaultAbiCoder()
      .encode(['address', 'uint256'], [NODE_ADDRESS, EXPIRATION])
      .substring(2);
    expect(parsed.data.endsWith(suffix)).to.equal(true);

    // 4) low-s (EIP-2)
    const N = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');
    expect(BigInt(parsed.signature!.s) <= N / 2n).to.equal(true);
  });
});
