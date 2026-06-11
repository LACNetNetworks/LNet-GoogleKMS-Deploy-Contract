# LNet-GoogleKMS-Deploy-Contract

Despliega e interactúa con un contrato `Storage` en **lnet** firmando con
**Google Cloud KMS** (clave secp256k1) en lugar de claves privadas locales,
respetando el modelo de gas de LNet vía `@lacchain/gas-model-provider`.

## Estructura

```
.
├── contracts/Storage.sol        # store()/retrieve()
├── lnet.params.ts               # url / nodeAddress / expirationSeconds
├── kms-lnet-signer.ts           # KmsLnetSigner + firma del digest contra KMS
├── tasks/deploy-storage.ts      # tasks: check-deployer, deploy-storage, store, retrieve
├── test/kms-signer.test.ts      # test de firma contra Google KMS
├── hardhat.config.ts
├── package.json
└── tsconfig.json
```

## Instalación

```bash
npm install
cp .env.example .env   # completa los valores
npx hardhat compile
```

## Variables de entorno

| Var | Descripción |
|-----|-------------|
| `LNET_RPC` | RPC del nodo lnet |
| `NODE_ADDRESS` | Writer node que aprueba las tx (gas model) |
| `TRUSTED_FORWARDER` | Forwarder del gas model (BaseRelayRecipient) |
| `KMS_PROJECT` | Proyecto de GCP |
| `KMS_LOCATION` | Región del key ring (p.ej. `global`) |
| `KMS_KEYRING` | Nombre del key ring |
| `KMS_KEY` | Nombre de la crypto key |
| `KMS_KEY_VERSION` | Versión de la clave (default `1`) |
| `GOOGLE_APPLICATION_CREDENTIALS` | JSON de la service account (ADC) |
| `DEPLOYER_ADDRESS` | Opcional; si se define, se valida contra la clave de KMS |

## Tasks

### `check-deployer` — muestra la address de la clave de KMS

```bash
npx hardhat check-deployer --network lnet
```
```
clave de KMS     = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
DEPLOYER_ADDRESS = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
✅ Coinciden
```

### `deploy-storage` — deploy + `store` inicial (firma con KMS)

`--value` es opcional (default `42`).

```bash
npx hardhat deploy-storage --value 666 --network lnet
```
```
🔐 Clave de KMS verificada → 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
Desplegando Storage firmando con Google Cloud KMS...
trustedForwarder: 0xEAA5420AF59305c5ecacCB38fcDe70198001d147
✅ Storage desplegado en: 0xB5a5a13e21d1AE08f83574644a27a09D7221cc47
store(666) ok — retrieve(): 666
```

### `store` — escribir en un Storage existente (firma con KMS)

```bash
npx hardhat store --address 0xB5a5a13e21d1AE08f83574644a27a09D7221cc47 --value 123 --network lnet
```

### `retrieve` — leer (sólo provider, no firma ni gasta)

```bash
npx hardhat retrieve --address 0xB5a5a13e21d1AE08f83574644a27a09D7221cc47 --network lnet
```

## Google Cloud KMS

[Cloud KMS](https://cloud.google.com/kms) guarda la clave privada en un
HSM/software gestionado por Google y la usa **sin exponerla**: la clave nunca
sale de KMS. Le pasamos el digest de la transacción y nos devuelve la firma, de
modo que el proyecto firma en lnet **sin manejar claves privadas locales**.

### Crear la clave

KMS soporta secp256k1 (la curva de Ethereum) con el algoritmo
`EC_SIGN_SECP256K1_SHA256`:

```bash
gcloud kms keyrings create lnet-keyring --location=global

gcloud kms keys create lnet-signer \
  --location=global \
  --keyring=lnet-keyring \
  --purpose=asymmetric-signing \
  --default-algorithm=ec-sign-secp256k1-sha256

# La service account necesita firmar y leer la clave pública:
gcloud kms keys add-iam-policy-binding lnet-signer \
  --location=global --keyring=lnet-keyring \
  --member="serviceAccount:tu-sa@tu-proyecto.iam.gserviceaccount.com" \
  --role="roles/cloudkms.signerVerifier"
```

> **Cómo funciona la firma.** KMS no rehashea ni firma la tx completa (a
> diferencia del plugin `ethsign` de OpenBao): sólo firma un **digest de 32
> bytes** y devuelve la firma en **DER**. Por eso el signer:
> 1. construye la tx legacy con `chainId: 0` (Homestead/pre-EIP155) y el sufijo
>    `nodeAddress + expiration` del gas model ya incluido en `data`;
> 2. calcula su `keccak256` y se lo manda a KMS (en el campo `digest.sha256`,
>    que sólo indica la longitud — KMS firma el digest tal cual);
> 3. parsea el DER a `(r, s)`, normaliza a **low-s** (EIP-2) y prueba ambas
>    paridades para recuperar el `v ∈ {27, 28}`;
> 4. ensambla y devuelve el RLP firmado.
>
> La address se deriva de la clave pública de KMS (`getPublicKey` → punto EC →
> `keccak256` → últimos 20 bytes).

### Test

```bash
npm test              # corre test/kms-signer.test.ts contra KMS real
```

El test verifica, firmando contra Google KMS real:
1. la clave de KMS deriva una address Ethereum válida;
2. el `from` recuperado de la tx firmada coincide con esa address;
3. `chainId == 0` y la `data` lleva el sufijo `nodeAddress + expiration` (gas model);
4. la firma es `low-s` (EIP-2).

Si KMS no está configurado/accesible, el test se salta (no falla) con un aviso.

## Notas

- La address se deriva de la clave de KMS; `check-deployer` la imprime y, si
  `DEPLOYER_ADDRESS` está definida, valida que coincidan (aborta antes de
  enviar nada si no coinciden).
- La `expiration` se renueva (+24h) en cada ejecución.
- Autenticación vía **Application Default Credentials**: apunta
  `GOOGLE_APPLICATION_CREDENTIALS` al JSON de una service account con el rol
  `roles/cloudkms.signerVerifier`, o usa `gcloud auth application-default login`.
```
