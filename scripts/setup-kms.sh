#!/usr/bin/env bash
#
# Aprovisiona la clave de firma secp256k1 en Google Cloud KMS para PRODUCCIÓN
# y deriva su address Ethereum.
#
# IMPORTANTE: secp256k1 (EC_SIGN_SECP256K1_SHA256) en Cloud KMS es **HSM-only**:
#   - no existe a nivel de protección SOFTWARE;
#   - la location debe ser una región con Cloud HSM (NO `global`).
#
# Requisitos: gcloud autenticado con rol Cloud KMS Admin sobre el proyecto, y
# permiso para asignar IAM sobre la clave. El script es idempotente.
#
# Uso:
#   PROJECT=mi-proyecto \
#   SA_EMAIL=signer@mi-proyecto.iam.gserviceaccount.com \
#   LOCATION=us-east1 \
#     ./scripts/setup-kms.sh
#
set -euo pipefail

# ── Parámetros (override por entorno) ───────────────────────────────────────
PROJECT="${PROJECT:?define PROJECT (id del proyecto GCP)}"
SA_EMAIL="${SA_EMAIL:?define SA_EMAIL (service account que firma)}"
LOCATION="${LOCATION:-us-east1}"   # región con Cloud HSM; NO uses 'global'
KEYRING="${KEYRING:-lnet-prod}"
KEY="${KEY:-lnet-signer}"
VERSION="${VERSION:-1}"
ALGO="ec-sign-secp256k1-sha256"

echo "▶ Proyecto=$PROJECT  Location=$LOCATION  KeyRing=$KEYRING  Key=$KEY  SA=$SA_EMAIL"

# ── 1. Habilitar la API de Cloud KMS ─────────────────────────────────────────
gcloud services enable cloudkms.googleapis.com --project "$PROJECT"

# ── 2. KeyRing (idempotente) ─────────────────────────────────────────────────
gcloud kms keyrings create "$KEYRING" \
  --location "$LOCATION" --project "$PROJECT" \
  2>/dev/null || echo "  keyring '$KEYRING' ya existe — ok"

# ── 3. Clave secp256k1 protegida por HSM (idempotente) ───────────────────────
gcloud kms keys create "$KEY" \
  --location "$LOCATION" --keyring "$KEYRING" --project "$PROJECT" \
  --purpose asymmetric-signing \
  --default-algorithm "$ALGO" \
  --protection-level hsm \
  2>/dev/null || echo "  key '$KEY' ya existe — ok"

# ── 4. IAM: la SA sólo necesita firmar y leer la clave pública ───────────────
gcloud kms keys add-iam-policy-binding "$KEY" \
  --location "$LOCATION" --keyring "$KEYRING" --project "$PROJECT" \
  --member "serviceAccount:$SA_EMAIL" \
  --role roles/cloudkms.signerVerifier

# ── 5. Resource name + derivación de la address Ethereum ─────────────────────
KEY_NAME="projects/$PROJECT/locations/$LOCATION/keyRings/$KEYRING/cryptoKeys/$KEY/cryptoKeyVersions/$VERSION"
echo
echo "✅ Clave lista. Configura el .env con:"
echo "   KMS_PROJECT=$PROJECT"
echo "   KMS_LOCATION=$LOCATION"
echo "   KMS_KEYRING=$KEYRING"
echo "   KMS_KEY=$KEY"
echo "   KMS_KEY_VERSION=$VERSION"
echo "   (KEY_NAME completo: $KEY_NAME)"

# Deriva la address Ethereum de la clave pública (mismo cálculo que kmsGetAddress)
if command -v node >/dev/null 2>&1 && [ -d node_modules/ethers ]; then
  PEM="$(gcloud kms keys versions get-public-key "$VERSION" \
    --location "$LOCATION" --keyring "$KEYRING" --key "$KEY" --project "$PROJECT" \
    --output-file /dev/stdout)"
  ADDR="$(printf '%s' "$PEM" | node -e '
    const { createPublicKey } = require("crypto");
    const { computeAddress } = require("ethers");
    let pem = "";
    process.stdin.on("data", (d) => (pem += d)).on("end", () => {
      const der = createPublicKey(pem).export({ format: "der", type: "spki" });
      const point = der.subarray(der.length - 65); // 0x04 || X || Y
      console.log(computeAddress("0x" + Buffer.from(point).toString("hex")));
    });
  ')"
  echo
  echo "🔑 Address Ethereum de la clave = $ADDR"
  echo "   (pégala en DEPLOYER_ADDRESS para que check-deployer la valide)"
else
  echo
  echo "ℹ️  Corre 'npm install && npm run check' para ver la address Ethereum de la clave."
fi
