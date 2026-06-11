import { task, types } from 'hardhat/config';
import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { getAddress } from 'ethers';
import { LacchainProvider } from '@lacchain/gas-model-provider';
import { KmsConfig, KmsLnetSigner, kmsGetAddress, kmsKeyName } from '../kms-lnet-signer';
import { lnetParams } from '../lnet.params';

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

/** Lee las env de KMS y arma su config (resource name de la versión de clave). */
function kmsConfig(): KmsConfig {
  const project = process.env.KMS_PROJECT;
  const location = process.env.KMS_LOCATION;
  const keyRing = process.env.KMS_KEYRING;
  const key = process.env.KMS_KEY;
  if (!project) throw new Error('Falta KMS_PROJECT en el entorno');
  if (!location) throw new Error('Falta KMS_LOCATION en el entorno');
  if (!keyRing) throw new Error('Falta KMS_KEYRING en el entorno');
  if (!key) throw new Error('Falta KMS_KEY en el entorno');

  return {
    keyName: kmsKeyName({
      project,
      location,
      keyRing,
      key,
      version: process.env.KMS_KEY_VERSION ?? '1',
    }),
  };
}

/**
 * Construye el signer respaldado por KMS. La address se deriva de la clave
 * pública de KMS; si DEPLOYER_ADDRESS está definida, se valida que coincida.
 */
async function buildKmsSigner(_hre: HardhatRuntimeEnvironment) {
  const cfg = kmsConfig();
  const address = await kmsGetAddress(cfg);

  const expected = process.env.DEPLOYER_ADDRESS;
  if (expected && getAddress(expected) !== getAddress(address)) {
    throw new Error(
      `DEPLOYER_ADDRESS no coincide con la clave de KMS.\n` +
        `  DEPLOYER_ADDRESS = ${getAddress(expected)}\n` +
        `  clave de KMS     = ${getAddress(address)}`,
    );
  }
  console.log(`🔐 Clave de KMS verificada → ${getAddress(address)}`);

  // Expiration fresca en cada ejecución (no la del arranque del proceso)
  const expiration = Math.floor(Date.now() / 1000) + lnetParams.expirationSeconds;
  const provider = new LacchainProvider(lnetParams.url);

  return new KmsLnetSigner(cfg, address, provider, lnetParams.nodeAddress, expiration);
}

// ───────────────────────────────────────────────────────────────────────────
// Tasks
// ───────────────────────────────────────────────────────────────────────────

task('check-deployer', 'Muestra la address de la clave de KMS y la valida contra DEPLOYER_ADDRESS')
  .setAction(async () => {
    const cfg = kmsConfig();
    const address = await kmsGetAddress(cfg);
    console.log(`clave de KMS     = ${getAddress(address)}`);

    const expected = process.env.DEPLOYER_ADDRESS;
    if (!expected) {
      console.log('DEPLOYER_ADDRESS no definida — nada que comparar.');
      return;
    }
    const ok = getAddress(address) === getAddress(expected);
    console.log(`DEPLOYER_ADDRESS = ${getAddress(expected)}`);
    console.log(ok ? '✅ Coinciden' : '❌ NO coinciden');
    if (!ok) process.exitCode = 1;
  });

task('deploy-storage', 'Despliega el contrato Storage firmando con Google Cloud KMS')
  .addOptionalParam('value', 'Valor inicial a guardar tras el deploy', 42, types.int)
  .setAction(async (taskArgs, hre) => {
    const { ethers } = hre;

    const signer = await buildKmsSigner(hre);
    const Storage = await ethers.getContractFactory('Storage', signer);

    console.log('Desplegando Storage firmando con Google Cloud KMS...');
    console.log('trustedForwarder:', lnetParams.trustedForwarder);
    const storage = await Storage.deploy(lnetParams.trustedForwarder);

    // En el gas model el address se obtiene del receipt, no de contract.address
    const receipt = await storage.deploymentTransaction()?.wait();
    const address = receipt?.contractAddress ?? (await storage.getAddress());
    console.log('✅ Storage desplegado en:', address);

    // Inicializa el valor (cada tx vuelve a pedir firma a KMS)
    const deployed = storage.attach(address);
    await (await deployed.store(taskArgs.value)).wait();
    console.log(`store(${taskArgs.value}) ok — retrieve():`, (await deployed.retrieve()).toString());

    return address;
  });

task('store', 'Llama a store() de un Storage existente firmando con Google Cloud KMS')
  .addParam('address', 'Dirección del contrato Storage ya desplegado', undefined, types.string)
  .addParam('value', 'Valor uint256 a guardar', undefined, types.int)
  .setAction(async (taskArgs, hre) => {
    const { ethers } = hre;

    const signer = await buildKmsSigner(hre);
    const storage = await ethers.getContractAt('Storage', taskArgs.address, signer);

    console.log(`retrieve() actual: ${(await storage.retrieve()).toString()}`);

    console.log(`Enviando store(${taskArgs.value}) — firma con Google Cloud KMS...`);
    const receipt = await (await storage.store(taskArgs.value)).wait();
    console.log('✅ tx confirmada:', receipt?.hash);

    console.log('retrieve() nuevo:', (await storage.retrieve()).toString());
  });

task('retrieve', 'Lee retrieve() de un Storage existente (no firma, no gasta nada)')
  .addParam('address', 'Dirección del contrato Storage', undefined, types.string)
  .setAction(async (taskArgs, hre) => {
    const { ethers } = hre;

    // Sólo provider: las llamadas view no requieren signer ni KMS
    const provider = new LacchainProvider(lnetParams.url);
    const storage = await ethers.getContractAt('Storage', taskArgs.address, provider);

    const value = await storage.retrieve();
    console.log(`retrieve() @ ${taskArgs.address}:`, value.toString());

    return value;
  });
