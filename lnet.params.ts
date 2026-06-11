export const lnetParams = {
  url: process.env.LNET_RPC ?? 'http://<ip-de-tu-nodo-lnet>',
  nodeAddress: process.env.NODE_ADDRESS ?? '0x...', // writer node de lnet
  expirationSeconds: 86_400, // ventana de validez de la tx (+24h desde el envío)
  // trustedForwarder del modelo de gas LNet (BaseRelayRecipient):
  //   local / open-protestnet = 0xa4B5eE2906090ce2cDbf5dfff944db26f397037D
  //   mainnet                  = 0xEAA5420AF59305c5ecacCB38fcDe70198001d147
  trustedForwarder:
    process.env.TRUSTED_FORWARDER ?? '0xEAA5420AF59305c5ecacCB38fcDe70198001d147',
};
