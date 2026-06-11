import { createPublicKey } from 'crypto';
import { KeyManagementServiceClient } from '@google-cloud/kms';
import {
  AbiCoder,
  AbstractSigner,
  Provider,
  Signature,
  Transaction,
  TransactionRequest,
  TypedDataDomain,
  TypedDataField,
  assertArgument,
  computeAddress,
  getAddress,
  getBigInt,
  getBytes,
  recoverAddress,
  resolveAddress,
  resolveProperties,
  toBeHex,
} from 'ethers';

/** Orden del grupo de secp256k1 (para el chequeo low-s de EIP-2). */
const SECP256K1_N = BigInt(
  '0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141',
);

export interface KmsConfig {
  /**
   * Nombre completo del recurso de la versión de la clave en Cloud KMS:
   *   projects/<p>/locations/<l>/keyRings/<kr>/cryptoKeys/<k>/cryptoKeyVersions/<v>
   * La clave debe ser del tipo EC_SIGN_SECP256K1_SHA256.
   */
  keyName: string;
}

/** Construye el resource name de KMS a partir de sus partes. */
export function kmsKeyName(parts: {
  project: string;
  location: string;
  keyRing: string;
  key: string;
  version?: string;
}): string {
  const { project, location, keyRing, key, version = '1' } = parts;
  return (
    `projects/${project}/locations/${location}/keyRings/${keyRing}` +
    `/cryptoKeys/${key}/cryptoKeyVersions/${version}`
  );
}

/** Convierte un valor numérico de ethers a string decimal. */
function toDecString(v: unknown, fallback: bigint = 0n): string {
  if (v == null) return fallback.toString();
  return getBigInt(v as any).toString();
}

// Un único cliente por proceso: la autenticación es por ADC (Application
// Default Credentials), no por keyName, así que se reutiliza para todo.
let _client: KeyManagementServiceClient | undefined;
function client(): KeyManagementServiceClient {
  if (!_client) _client = new KeyManagementServiceClient();
  return _client;
}

/**
 * Parsea una firma ECDSA en DER (`SEQUENCE { INTEGER r, INTEGER s }`) a
 * sus enteros r y s. KMS devuelve la firma en este formato.
 */
function derToRS(der: Uint8Array): { r: bigint; s: bigint } {
  let off = 0;
  const readInt = (): bigint => {
    assertArgument(der[off++] === 0x02, 'DER: se esperaba INTEGER', 'der', der);
    const len = der[off++];
    const bytes = der.subarray(off, off + len);
    off += len;
    return BigInt('0x' + Buffer.from(bytes).toString('hex'));
  };
  assertArgument(der[off++] === 0x30, 'DER: se esperaba SEQUENCE', 'der', der);
  off++; // longitud de la secuencia (las firmas de 256 bits caben en 1 byte)
  const r = readInt();
  const s = readInt();
  return { r, s };
}

/**
 * Lee la clave pública de KMS (PEM/SPKI), extrae el punto EC sin comprimir
 * y deriva la address Ethereum. El campo `pem` codifica la clave pública en
 * SubjectPublicKeyInfo; los últimos 65 bytes del DER son `0x04 || X || Y`.
 */
export async function kmsGetAddress(cfg: KmsConfig): Promise<string> {
  const [pub] = await client().getPublicKey({ name: cfg.keyName });
  if (!pub.pem) throw new Error('KMS no devolvió la clave pública (pem vacío)');

  const der = createPublicKey(pub.pem).export({ format: 'der', type: 'spki' });
  const point = der.subarray(der.length - 65); // 0x04 || X(32) || Y(32)
  assertArgument(
    point[0] === 0x04,
    'la clave pública de KMS no es un punto EC sin comprimir',
    'pem',
    pub.pem,
  );
  return computeAddress('0x' + Buffer.from(point).toString('hex'));
}

/**
 * Firma un digest de 32 bytes con KMS y devuelve {r, s} (con s ya normalizado
 * a low-s, EIP-2).
 *
 * KMS no rehashea: el campo `digest.sha256` es sólo la etiqueta de longitud
 * (32 bytes). Le pasamos el keccak256 de la tx tal cual y KMS lo firma con
 * ECDSA sobre secp256k1 — el mismo digest que espera Ethereum.
 */
export async function kmsSignDigest(
  cfg: KmsConfig,
  digest: Uint8Array,
): Promise<{ r: bigint; s: bigint }> {
  const [resp] = await client().asymmetricSign({
    name: cfg.keyName,
    digest: { sha256: digest },
  });
  if (!resp.signature) throw new Error('KMS no devolvió firma');

  let { r, s } = derToRS(Buffer.from(resp.signature as Uint8Array));
  if (s > SECP256K1_N / 2n) s = SECP256K1_N - s; // low-s (EIP-2)
  return { r, s };
}

/**
 * Signer del modelo de gas de LNet que delega la firma a Google Cloud KMS en
 * lugar de usar una clave privada local. La clave privada nunca sale de KMS:
 * aquí construimos la tx legacy (chainId 0, Homestead/pre-EIP155) con el
 * sufijo del gas model en `data`, calculamos su keccak256 y se lo mandamos a
 * KMS para que lo firme; luego ensamblamos el RLP firmado.
 *
 * Extiende AbstractSigner (no Wallet) para poder exponer la address derivada
 * de la clave pública de KMS.
 */
export class KmsLnetSigner extends AbstractSigner {
  readonly accountAddress: string;

  constructor(
    private kms: KmsConfig,
    accountAddress: string,
    provider: Provider,
    private nodeAddress: string,
    private expirationTime: number,
  ) {
    super(provider);
    this.accountAddress = getAddress(accountAddress);
  }

  get address(): string {
    return this.accountAddress;
  }

  async getAddress(): Promise<string> {
    return this.accountAddress;
  }

  connect(provider: Provider): KmsLnetSigner {
    return new KmsLnetSigner(
      this.kms,
      this.accountAddress,
      provider,
      this.nodeAddress,
      this.expirationTime,
    );
  }

  async signTransaction(tx: TransactionRequest): Promise<string> {
    // Resuelve to/from (ENS o Addressable -> address)
    const { to, from } = await resolveProperties({
      to: tx.to ? resolveAddress(tx.to, this.provider!) : undefined,
      from: tx.from ? resolveAddress(tx.from, this.provider!) : undefined,
    });
    if (to != null) tx.to = to;
    if (from != null) {
      assertArgument(
        getAddress(from as string) === this.accountAddress,
        'transaction from address mismatch',
        'tx.from',
        from,
      );
    }

    // Inyecta nodeAddress + expiration (modelo de gas LNet) en la data
    const data =
      (tx.data ?? '0x') +
      AbiCoder.defaultAbiCoder()
        .encode(['address', 'uint256'], [this.nodeAddress, this.expirationTime])
        .substring(2);

    // Tx legacy con chainId 0 -> firma Homestead (pre-EIP155, v∈{27,28})
    const unsigned = Transaction.from({
      type: 0,
      chainId: 0,
      to: (tx.to as string) || null,
      nonce: Number(toDecString(tx.nonce)),
      gasLimit: getBigInt(tx.gasLimit ?? 90_000n),
      gasPrice: getBigInt(tx.gasPrice ?? 0n),
      value: getBigInt(tx.value ?? 0n),
      data,
    });

    // KMS firma el keccak256 de la tx sin firmar
    const digest = getBytes(unsigned.unsignedHash);
    const { r, s } = await kmsSignDigest(this.kms, digest);

    // KMS no devuelve el recovery id: probamos ambas paridades y nos quedamos
    // con la que recupera nuestra address.
    let signature: Signature | undefined;
    for (const yParity of [0, 1] as const) {
      const cand = Signature.from({
        r: toBeHex(r, 32),
        s: toBeHex(s, 32),
        v: 27 + yParity,
      });
      if (getAddress(recoverAddress(digest, cand)) === this.accountAddress) {
        signature = cand;
        break;
      }
    }
    if (!signature) {
      throw new Error('la firma de KMS no recupera la address esperada');
    }

    unsigned.signature = signature;
    const signedTransaction = unsigned.serialized;

    // Salvaguarda: el firmante recuperado del RLP debe ser nuestra address
    const parsed = Transaction.from(signedTransaction);
    assertArgument(
      parsed.from != null && getAddress(parsed.from) === this.accountAddress,
      'la tx firmada por KMS no recupera a la address esperada',
      'signedTransaction',
      signedTransaction,
    );

    return signedTransaction;
  }

  async signMessage(): Promise<string> {
    throw new Error('signMessage no implementado para KmsLnetSigner');
  }

  async signTypedData(
    _domain: TypedDataDomain,
    _types: Record<string, TypedDataField[]>,
    _value: Record<string, any>,
  ): Promise<string> {
    throw new Error('signTypedData no implementado para KmsLnetSigner');
  }
}
