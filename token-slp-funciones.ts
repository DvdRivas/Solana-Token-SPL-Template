/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║         SPL Token Basics — Token-2022 (TokenExtensions)         ║
 * ║   Basado en: https://solana.com/es/docs/tokens/basics           ║
 * ║   Metadata:  https://solana.com/docs/tokens/extensions/metadata ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * Instalación:
 *   npm install @solana/web3.js @solana/spl-token @solana/spl-token-metadata
 *   npm install -D typescript ts-node @types/node
 *
 * Ejecución:
 *   npx ts-node spl-token-basics.ts
 */

import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  getAccount,
  getMint,
  getTokenMetadata,
  mintTo,
  transfer,
  approve,
  revoke,
  setAuthority,
  AuthorityType,
  burn,
  closeAccount,
  freezeAccount,
  thawAccount,
  // Para crear mint con metadata embebida
  ExtensionType,
  getMintLen,
  TYPE_SIZE,
  LENGTH_SIZE,
  createInitializeMetadataPointerInstruction,
  createInitializeMintInstruction,
} from "@solana/spl-token";

import {
  createInitializeInstruction,
  pack,
  type TokenMetadata,
} from "@solana/spl-token-metadata";

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURACIÓN GLOBAL
// ─────────────────────────────────────────────────────────────────────────────
const DEVNET_URL = "https://api.devnet.solana.com";
const DECIMALS   = 9;

/** Convierte tokens legibles a unidades base según los decimales del mint */
const toBase = (tokens: number, decimals: number = DECIMALS) =>
  BigInt(Math.round(tokens * 10 ** decimals));

const section = (title: string) =>
  console.log(`\n${"─".repeat(60)}\n  ${title}\n${"─".repeat(60)}`);

// ─────────────────────────────────────────────────────────────────────────────
// TIPOS
// ─────────────────────────────────────────────────────────────────────────────

/** Datos mínimos que el usuario debe proveer para crear un token */
export interface TokenConfig {
  name:     string;  // ej. "Testing Token"
  symbol:   string;  // ej. "TTK"
  logoUrl:  string;  // URL pública de la imagen (PNG/SVG recomendado)
  decimals?: number; // default: 9
}

/** Resultado de createTokenMintWithMetadata */
export interface MintResult {
  mintAddress:  PublicKey;
  payerATA:     PublicKey;
  metadata:     TokenMetadata;
}

// ─────────────────────────────────────────────────────────────────────────────
// 0. GET ATA — obtener la dirección ATA de una wallet para un mint
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Calcula la dirección ATA (Associated Token Account) de forma determinística.
 * No requiere conexión a la red — es un cálculo local puro.
 *
 * La ATA se deriva de: PDA( owner + TOKEN_2022_PROGRAM_ID + mint )
 *
 * @param mintAddress   Dirección del mint
 * @param ownerWallet   Dirección de la wallet dueña
 * @returns             Dirección de la ATA (puede o no existir on-chain aún)
 */
export function getATA(
  mintAddress:  PublicKey,
  ownerWallet:  PublicKey
): PublicKey {
  const ata = getAssociatedTokenAddressSync(
    mintAddress,
    ownerWallet,
    false,                     // allowOwnerOffCurve
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  console.log("🔍 ATA calculada (sin llamada a red)");
  console.log("   Mint  :", mintAddress.toBase58());
  console.log("   Owner :", ownerWallet.toBase58());
  console.log("   ATA   :", ata.toBase58());

  return ata;
}

/**
 * Verifica si la ATA ya existe on-chain y devuelve su balance.
 * Útil para mostrarle al usuario el estado de su cuenta.
 */
export async function getATAInfo(
  connection:  Connection,
  mintAddress: PublicKey,
  ownerWallet: PublicKey
): Promise<{ ata: PublicKey; exists: boolean; balance?: number }> {
  const ata = getATA(mintAddress, ownerWallet);

  try {
    const account = await getAccount(
      connection, ata, "confirmed", TOKEN_2022_PROGRAM_ID
    );
    const mintInfo = await getMint(
      connection, mintAddress, "confirmed", TOKEN_2022_PROGRAM_ID
    );
    const balance = Number(account.amount) / 10 ** mintInfo.decimals;

    console.log("   ✅ ATA existe on-chain");
    console.log("   Balance:", balance, "tokens");
    console.log("   Frozen :", account.isFrozen);

    return { ata, exists: true, balance };
  } catch {
    console.log("   ⚠️  ATA aún no existe on-chain (se creará al recibir tokens)");
    return { ata, exists: false };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. CREATE TOKEN MINT CON METADATA EMBEBIDA
// https://solana.com/docs/tokens/basics/create-mint
// https://solana.com/docs/tokens/extensions/metadata
//
// Crea el Mint y almacena nombre, símbolo y logo directamente en la cuenta
// del mint usando MetadataPointer + TokenMetadata (Token-2022).
//
// El usuario solo necesita proveer: name, symbol, logoUrl
// El resto (payer, mint authority, freeze authority) se deriva del keypair.
//
// Equivale a:
//   spl-token create-token --enable-metadata
//   spl-token initialize-metadata <mint> <name> <symbol> <uri>
// ─────────────────────────────────────────────────────────────────────────────
export async function createTokenMintWithMetadata(
  connection: Connection,
  payer: Keypair,
  config: TokenConfig
): Promise<MintResult> {
  const decimals = config.decimals ?? DECIMALS;
  const mintKeypair = Keypair.generate();

  // La URI del metadata apunta a un JSON off-chain con el logo.
  // Seguimos el estándar Metaplex: https://solana.com/docs/tokens/metaplex#off-chain-metadata-format
  // Si el usuario solo da una URL de imagen, construimos el JSON en memoria.
  // En producción esto debería subirse a Arweave, IPFS o similar.
  const metadata: TokenMetadata = {
    mint:            mintKeypair.publicKey,
    name:            config.name,
    symbol:          config.symbol,
    uri:             config.logoUrl,  // URL directa o JSON off-chain
    additionalMetadata: [],
  };

  // 1a. Calcular tamaño del mint SIN metadata (para CreateAccount)
  const mintLen = getMintLen([ExtensionType.MetadataPointer]);

  // 1b. Calcular tamaño MÁXIMO incluyendo metadata (para el rent)
  const metadataLen = TYPE_SIZE + LENGTH_SIZE + pack(metadata).length;
  const totalLen    = mintLen + metadataLen;

  const mintLamports = await connection.getMinimumBalanceForRentExemption(totalLen);

  // 1c. Construir la transacción en 4 instrucciones obligatorias (orden exacto):
  //   i.   CreateAccount          — crea la cuenta del mint
  //   ii.  InitializeMetadataPointer — apunta la metadata al propio mint
  //   iii. InitializeMint         — define decimales y autoridades
  //   iv.  InitializeTokenMetadata — escribe nombre, símbolo y uri
  const tx = new Transaction().add(
    // i. Crear la cuenta del mint on-chain
    SystemProgram.createAccount({
      fromPubkey:      payer.publicKey,
      newAccountPubkey: mintKeypair.publicKey,
      space:           mintLen,
      lamports:        mintLamports,
      programId:       TOKEN_2022_PROGRAM_ID,
    }),

    // ii. Inicializar MetadataPointer (apunta al propio mint)
    createInitializeMetadataPointerInstruction(
      mintKeypair.publicKey, // mint
      payer.publicKey,       // authority que puede actualizar el pointer
      mintKeypair.publicKey, // metadataAddress = el propio mint
      TOKEN_2022_PROGRAM_ID
    ),

    // iii. Inicializar el Mint (decimales, mint authority, freeze authority)
    createInitializeMintInstruction(
      mintKeypair.publicKey,
      decimals,
      payer.publicKey, // mint authority
      payer.publicKey, // freeze authority
      TOKEN_2022_PROGRAM_ID
    ),

    // iv. Escribir la metadata en el mint
    createInitializeInstruction({
      programId:       TOKEN_2022_PROGRAM_ID,
      metadata:        mintKeypair.publicKey,
      updateAuthority: payer.publicKey,
      mint:            mintKeypair.publicKey,
      mintAuthority:   payer.publicKey,
      name:            metadata.name,
      symbol:          metadata.symbol,
      uri:             metadata.uri,
    })
  );

  const signature = await sendAndConfirmTransaction(
    connection, tx, [payer, mintKeypair], { commitment: "confirmed" }
  );

  // Crear ATA del payer automáticamente
  const payerTokenAccount = await getOrCreateAssociatedTokenAccount(
    connection, payer, mintKeypair.publicKey, payer.publicKey,
    false, "confirmed", { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID
  );

  // Verificar metadata guardada on-chain
  const onChainMeta = await getTokenMetadata(connection, mintKeypair.publicKey);

  console.log("✅ Mint con metadata creado:", mintKeypair.publicKey.toBase58());
  console.log("   Nombre  :", onChainMeta?.name);
  console.log("   Símbolo :", onChainMeta?.symbol);
  console.log("   Logo URI:", onChainMeta?.uri);
  console.log("   Decimals:", decimals);
  console.log("   ATA payer:", payerTokenAccount.address.toBase58());
  console.log("   Signature:", signature);

  return {
    mintAddress: mintKeypair.publicKey,
    payerATA:    payerTokenAccount.address,
    metadata,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. CREATE TOKEN ACCOUNT (ATA) — crear si no existe
// https://solana.com/docs/tokens/basics/create-token-account
// ─────────────────────────────────────────────────────────────────────────────
export async function createTokenAccount(
  connection:  Connection,
  payer:       Keypair,
  mintAddress: PublicKey,
  owner:       PublicKey   // wallet dueña de la cuenta
) {
  const tokenAccount = await getOrCreateAssociatedTokenAccount(
    connection, payer, mintAddress, owner,
    false, "confirmed", { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID
  );

  const info = await getAccount(
    connection, tokenAccount.address, "confirmed", TOKEN_2022_PROGRAM_ID
  );

  console.log("✅ Token Account:", tokenAccount.address.toBase58());
  console.log("   Owner (wallet):", info.owner.toBase58());
  console.log("   Balance       :", info.amount.toString());

  return tokenAccount;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. MINT TOKENS
// https://solana.com/docs/tokens/basics/mint-tokens
// ─────────────────────────────────────────────────────────────────────────────
export async function mintTokens(
  connection:     Connection,
  payer:          Keypair,
  mintAddress:    PublicKey,
  destinationATA: PublicKey,
  mintAuthority:  Keypair,
  amount:         number,        // tokens legibles (ej: 1000)
  decimals:       number = DECIMALS
): Promise<string> {
  const sig = await mintTo(
    connection, payer, mintAddress, destinationATA,
    mintAuthority, toBase(amount, decimals), [],
    { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID
  );

  const info = await getAccount(
    connection, destinationATA, "confirmed", TOKEN_2022_PROGRAM_ID
  );

  console.log(`✅ Minteados ${amount} tokens`);
  console.log("   Nuevo saldo:", Number(info.amount) / 10 ** decimals);
  console.log("   Signature  :", sig);

  return sig;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. TRANSFER TOKENS
// https://solana.com/docs/tokens/basics/transfer-tokens
//
// Si la ATA del destinatario no existe, se crea automáticamente (--fund-recipient).
// El usuario solo necesita la wallet destino, no su ATA.
// ─────────────────────────────────────────────────────────────────────────────
export async function transferTokens(
  connection:        Connection,
  payer:             Keypair,
  mintAddress:       PublicKey,
  sourceOwner:       Keypair,
  destinationWallet: PublicKey,  // wallet del destinatario (no su ATA)
  amount:            number,
  decimals:          number = DECIMALS
): Promise<string> {
  const sourceATA = await getOrCreateAssociatedTokenAccount(
    connection, payer, mintAddress, sourceOwner.publicKey,
    false, "confirmed", { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID
  );
  const destATA = await getOrCreateAssociatedTokenAccount(
    connection, payer, mintAddress, destinationWallet,
    false, "confirmed", { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID
  );

  const sig = await transfer(
    connection, payer, sourceATA.address, destATA.address,
    sourceOwner, toBase(amount, decimals), [],
    { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID
  );

  console.log(`✅ Transferidos ${amount} tokens`);
  console.log("   De (wallet) :", sourceOwner.publicKey.toBase58());
  console.log("   A  (wallet) :", destinationWallet.toBase58());
  console.log("   A  (ATA)    :", destATA.address.toBase58());
  console.log("   Signature   :", sig);

  return sig;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. APPROVE DELEGATE
// https://solana.com/docs/tokens/basics/approve-delegate
// ─────────────────────────────────────────────────────────────────────────────
export async function approveDelegate(
  connection:          Connection,
  payer:               Keypair,
  tokenAccountAddress: PublicKey,
  delegateAddress:     PublicKey,
  owner:               Keypair,
  amount:              number,
  decimals:            number = DECIMALS
): Promise<string> {
  const sig = await approve(
    connection, payer, tokenAccountAddress, delegateAddress,
    owner, toBase(amount, decimals), [],
    { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID
  );

  const info = await getAccount(
    connection, tokenAccountAddress, "confirmed", TOKEN_2022_PROGRAM_ID
  );

  console.log(`✅ Delegado aprobado por ${amount} tokens`);
  console.log("   Delegate  :", info.delegate?.toBase58());
  console.log("   Allowance :", info.delegatedAmount.toString());
  console.log("   Signature :", sig);

  return sig;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. REVOKE DELEGATE
// https://solana.com/docs/tokens/basics/revoke-delegate
// ─────────────────────────────────────────────────────────────────────────────
export async function revokeDelegate(
  connection:          Connection,
  payer:               Keypair,
  tokenAccountAddress: PublicKey,
  owner:               Keypair
): Promise<string> {
  const sig = await revoke(
    connection, payer, tokenAccountAddress, owner, [],
    { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID
  );

  const info = await getAccount(
    connection, tokenAccountAddress, "confirmed", TOKEN_2022_PROGRAM_ID
  );

  console.log("✅ Delegado revocado");
  console.log("   Delegate ahora:", info.delegate?.toBase58() ?? "ninguno");
  console.log("   Signature     :", sig);

  return sig;
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. SET AUTHORITY
// https://solana.com/docs/tokens/basics/set-authority
//
// Tipos disponibles:
//   AuthorityType.MintTokens    → quien puede mintear
//   AuthorityType.FreezeAccount → quien puede congelar cuentas
//   AuthorityType.AccountOwner  → dueño de la token account
//   AuthorityType.CloseAccount  → quien puede cerrar la cuenta
// ─────────────────────────────────────────────────────────────────────────────
export async function setTokenAuthority(
  connection:        Connection,
  payer:             Keypair,
  accountOrMint:     PublicKey,
  authorityType:     AuthorityType,
  currentAuthority:  Keypair,
  newAuthority:      PublicKey | null  // null = revocar permanentemente
): Promise<string> {
  const sig = await setAuthority(
    connection, payer, accountOrMint, currentAuthority,
    authorityType, newAuthority, [],
    { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID
  );

  console.log(`✅ Autoridad [${AuthorityType[authorityType]}] actualizada`);
  console.log("   Nueva auth :", newAuthority?.toBase58() ?? "REVOCADA");
  console.log("   Signature  :", sig);

  return sig;
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. BURN TOKENS
// https://solana.com/docs/tokens/basics/burn-tokens
// ─────────────────────────────────────────────────────────────────────────────
export async function burnTokens(
  connection:          Connection,
  payer:               Keypair,
  tokenAccountAddress: PublicKey,
  mintAddress:         PublicKey,
  owner:               Keypair,
  amount:              number,
  decimals:            number = DECIMALS
): Promise<string> {
  const sig = await burn(
    connection, payer, tokenAccountAddress, mintAddress,
    owner, toBase(amount, decimals), [],
    { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID
  );

  const mintInfo = await getMint(
    connection, mintAddress, "confirmed", TOKEN_2022_PROGRAM_ID
  );
  const acct = await getAccount(
    connection, tokenAccountAddress, "confirmed", TOKEN_2022_PROGRAM_ID
  );

  console.log(`✅ Quemados ${amount} tokens`);
  console.log("   Supply restante :", Number(mintInfo.supply) / 10 ** decimals);
  console.log("   Balance restante:", Number(acct.amount) / 10 ** decimals);
  console.log("   Signature       :", sig);

  return sig;
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. CLOSE TOKEN ACCOUNT
// https://solana.com/docs/tokens/basics/close-account
//
// La cuenta debe tener balance 0. El SOL del rent se devuelve al payer.
// ─────────────────────────────────────────────────────────────────────────────
export async function closeTokenAccount(
  connection:          Connection,
  payer:               Keypair,
  tokenAccountAddress: PublicKey,
  solDestination:      PublicKey,
  owner:               Keypair
): Promise<string> {
  const sig = await closeAccount(
    connection, payer, tokenAccountAddress, solDestination, owner, [],
    { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID
  );

  console.log("✅ Token Account cerrada:", tokenAccountAddress.toBase58());
  console.log("   SOL devuelto a:", solDestination.toBase58());
  console.log("   Signature     :", sig);

  return sig;
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. FREEZE ACCOUNT
// https://solana.com/docs/tokens/basics/freeze-account
// ─────────────────────────────────────────────────────────────────────────────
export async function freezeTokenAccount(
  connection:          Connection,
  payer:               Keypair,
  tokenAccountAddress: PublicKey,
  mintAddress:         PublicKey,
  freezeAuthority:     Keypair
): Promise<string> {
  const sig = await freezeAccount(
    connection, payer, tokenAccountAddress, mintAddress, freezeAuthority, [],
    { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID
  );

  const info = await getAccount(
    connection, tokenAccountAddress, "confirmed", TOKEN_2022_PROGRAM_ID
  );

  console.log("✅ Cuenta congelada:", tokenAccountAddress.toBase58());
  console.log("   Estado         :", info.isFrozen ? "FROZEN" : "INITIALIZED");
  console.log("   Signature      :", sig);

  return sig;
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. THAW ACCOUNT
// https://solana.com/docs/tokens/basics/thaw-account
// ─────────────────────────────────────────────────────────────────────────────
export async function thawTokenAccount(
  connection:          Connection,
  payer:               Keypair,
  tokenAccountAddress: PublicKey,
  mintAddress:         PublicKey,
  freezeAuthority:     Keypair
): Promise<string> {
  const sig = await thawAccount(
    connection, payer, tokenAccountAddress, mintAddress, freezeAuthority, [],
    { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID
  );

  const info = await getAccount(
    connection, tokenAccountAddress, "confirmed", TOKEN_2022_PROGRAM_ID
  );

  console.log("✅ Cuenta descongelada:", tokenAccountAddress.toBase58());
  console.log("   Estado           :", info.isFrozen ? "FROZEN" : "INITIALIZED");
  console.log("   Signature        :", sig);

  return sig;
}

// ═════════════════════════════════════════════════════════════════════════════
//  EJEMPLO DE USO — flujo completo con las funciones nuevas
// ═════════════════════════════════════════════════════════════════════════════
async function main() {
  const connection = new Connection(DEVNET_URL, "confirmed");

  // Solo se necesita el keypair del creador.
  // En producción carga desde archivo:
  // const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync("keypair.json","utf8"))));
  const payer     = Keypair.generate();
  const recipient = Keypair.generate();
  const delegate  = Keypair.generate();
  const newAuth   = Keypair.generate();

  console.log("Payer    :", payer.publicKey.toBase58());
  console.log("Recipient:", recipient.publicKey.toBase58());

  // Airdrop
  const airdrop = await connection.requestAirdrop(payer.publicKey, 2 * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(airdrop);
  console.log("Airdrop ✓");

  // ── 0. Calcular ATA antes de que exista (sin red) ─────────────────────────
  section("0a. getATA — cálculo local (no necesita red)");
  // Usamos una mint de ejemplo; en la práctica usarías mintResult.mintAddress
  const exampleMint = Keypair.generate().publicKey;
  getATA(exampleMint, payer.publicKey);

  // ── 1. Crear Mint con metadata embebida ───────────────────────────────────
  section("1. createTokenMintWithMetadata");
  const { mintAddress, payerATA } = await createTokenMintWithMetadata(
    connection,
    payer,
    {
      name:    "Testing Token",  // nombre del token
      symbol:  "TTK",            // símbolo (máx. 10 chars recomendado)
      logoUrl: "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png",
      // ☝️ En producción sube tu imagen a Arweave/IPFS y pon la URL aquí.
      // O sube un JSON con { name, symbol, image } y pon la URL del JSON.
      decimals: 9,
    }
  );

  // ── 0b. Verificar ATA recién creada ───────────────────────────────────────
  section("0b. getATAInfo — verificar ATA on-chain");
  await getATAInfo(connection, mintAddress, payer.publicKey);

  // ── 2. Crear ATA del recipient ────────────────────────────────────────────
  section("2. createTokenAccount");
  const recipientATA = await createTokenAccount(
    connection, payer, mintAddress, recipient.publicKey
  );

  // ── 3. Mintear 1000 tokens al payer ───────────────────────────────────────
  section("3. mintTokens");
  await mintTokens(
    connection, payer, mintAddress,
    payerATA,  // ATA del payer (ya creada en el paso 1)
    payer,     // mint authority
    1000
  );

  // ── 4. Transferir 200 tokens al recipient ─────────────────────────────────
  section("4. transferTokens");
  // Solo necesitas la wallet destino — la función resuelve la ATA sola
  await transferTokens(
    connection, payer, mintAddress,
    payer,               // owner del origen
    recipient.publicKey, // wallet destino (no la ATA)
    200
  );

  // ── 5. Aprobar delegado por 100 tokens ────────────────────────────────────
  section("5. approveDelegate");
  await approveDelegate(
    connection, payer, payerATA,
    delegate.publicKey, payer, 100
  );

  // ── 6. Revocar delegado ───────────────────────────────────────────────────
  section("6. revokeDelegate");
  await revokeDelegate(connection, payer, payerATA, payer);

  // ── 7a. Cambiar freeze authority ──────────────────────────────────────────
  section("7a. setAuthority — cambiar FreezeAccount");
  await setTokenAuthority(
    connection, payer, mintAddress,
    AuthorityType.FreezeAccount,
    payer,               // autoridad actual
    newAuth.publicKey    // nueva autoridad
  );

  // ── 7b. Revocar mint authority (supply queda fijo para siempre) ───────────
  section("7b. setAuthority — revocar MintTokens");
  await setTokenAuthority(
    connection, payer, mintAddress,
    AuthorityType.MintTokens,
    payer, null  // null = revocar permanentemente
  );

  // ── 8. Quemar 50 tokens ───────────────────────────────────────────────────
  section("8. burnTokens");
  await burnTokens(connection, payer, payerATA, mintAddress, payer, 50);

  // ── 10. Congelar cuenta ───────────────────────────────────────────────────
  section("10. freezeTokenAccount");
  // Airdrop extra para newAuth (necesita SOL para firmar)
  const a2 = await connection.requestAirdrop(newAuth.publicKey, LAMPORTS_PER_SOL);
  await connection.confirmTransaction(a2);
  await freezeTokenAccount(connection, payer, payerATA, mintAddress, newAuth);

  // ── 11. Descongelar cuenta ────────────────────────────────────────────────
  section("11. thawTokenAccount");
  await thawTokenAccount(connection, payer, payerATA, mintAddress, newAuth);

  // ── 9. Cerrar cuenta (debe tener balance 0) ───────────────────────────────
  // Quemar el balance restante: 1000 - 200 (transfer) - 50 (burn) = 750
  section("8b. burnTokens — vaciar antes de cerrar");
  await burnTokens(connection, payer, payerATA, mintAddress, payer, 750);

  section("9. closeTokenAccount");
  await closeTokenAccount(
    connection, payer, payerATA,
    payer.publicKey, // el SOL del rent vuelve al payer
    payer
  );

  console.log("\n✅ Flujo completo finalizado.");
}

main().catch(console.error);