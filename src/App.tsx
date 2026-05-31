/**
 * App.tsx — SPL Token Manager
 * Payer = wallet conectada (Phantom). No se usa Keypair como payer.
 *
 * Dependencias:
 *   npm install @solana/web3.js @solana/spl-token @solana/spl-token-metadata
 *   npm install @solana/wallet-adapter-react @solana/wallet-adapter-react-ui
 *   npm install @solana/wallet-adapter-wallets
 */

import { useState, useMemo } from "react"
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  Keypair,
  type TransactionSignature,
} from "@solana/web3.js"
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  ExtensionType,
  getMintLen,
  TYPE_SIZE,
  LENGTH_SIZE,
  createInitializeMetadataPointerInstruction,
  createInitializeMintInstruction,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  getAccount,
  getMint,
  createMintToInstruction,
  createTransferInstruction,
  createApproveInstruction,
  createRevokeInstruction,
  createSetAuthorityInstruction,
  AuthorityType,
  createBurnInstruction,
  createCloseAccountInstruction,
  createFreezeAccountInstruction,
  createThawAccountInstruction,
} from "@solana/spl-token"
import {
  createInitializeInstruction,
  pack,
  type TokenMetadata,
} from "@solana/spl-token-metadata"
import {
  ConnectionProvider,
  WalletProvider,
  useWallet,
  useConnection,
} from "@solana/wallet-adapter-react"
import { WalletModalProvider, WalletMultiButton } from "@solana/wallet-adapter-react-ui"
import { PhantomWalletAdapter } from "@solana/wallet-adapter-wallets"
import "@solana/wallet-adapter-react-ui/styles.css"

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTES Y HELPERS
// ─────────────────────────────────────────────────────────────────────────────
const DEVNET_URL = "https://api.devnet.solana.com"
const DECIMALS   = 9

const toBase  = (n: number, d = DECIMALS) => BigInt(Math.round(n * 10 ** d))
const short   = (s: string) => (s ? s.slice(0, 8) + "…" + s.slice(-6) : "—")
const toPub   = (s: string) => new PublicKey(s.trim())
const txLink  = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`
const accLink = (addr: string) => `https://solscan.io/account/${addr}?cluster=devnet`

// Envía una transacción firmada por la wallet conectada y espera confirmación
async function sendTx(
  connection: Connection,
  tx: Transaction,
  publicKey: PublicKey,
  sendTransaction: (tx: Transaction, conn: Connection, opts?: { signers?: Keypair[] }) => Promise<TransactionSignature>,
  extraSigners: Keypair[] = []
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
  tx.recentBlockhash = blockhash
  tx.feePayer = publicKey

  // Firmas adicionales (ej. el mintKeypair al crear un mint)
  if (extraSigners.length) tx.partialSign(...extraSigners)

  const sig = await sendTransaction(tx, connection, { signers: extraSigners.length ? [] : undefined })
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed")
  return sig
}

// ─────────────────────────────────────────────────────────────────────────────
// TIPOS
// ─────────────────────────────────────────────────────────────────────────────
interface TxResult {
  ok: boolean
  lines: { label: string; value: string; link?: string }[]
}

// Contexto de wallet que se pasa a todas las funciones SPL
interface WalletCtx {
  connection: Connection
  publicKey: PublicKey
  sendTransaction: (tx: Transaction, conn: Connection, opts?: { signers?: Keypair[] }) => Promise<TransactionSignature>
}

const TABS = [
  { id: "create",    label: "Crear Mint"  },
  { id: "ata",       label: "ATA"         },
  { id: "mint",      label: "Mintear"     },
  { id: "transfer",  label: "Transferir"  },
  { id: "delegate",  label: "Delegado"    },
  { id: "authority", label: "Autoridad"   },
  { id: "burn",      label: "Quemar"      },
  { id: "freeze",    label: "Freeze/Thaw" },
  { id: "close",     label: "Cerrar"      },
] as const
type TabId = typeof TABS[number]["id"]

// ─────────────────────────────────────────────────────────────────────────────
// FUNCIONES SPL
// Todas reciben WalletCtx — la wallet conectada es el payer y el authority.
// ─────────────────────────────────────────────────────────────────────────────

// 1. Crear Mint con metadata embebida (MetadataPointer + TokenMetadata)
async function fnCreateMint(
  ctx: WalletCtx,
  name: string, symbol: string, logoUrl: string, decimals: number
): Promise<{ mintAddress: string; payerATA: string; sig: string }> {
  const { connection, publicKey, sendTransaction } = ctx
  const mintKp = Keypair.generate()

  const metadata: TokenMetadata = {
    mint: mintKp.publicKey,
    name, symbol,
    uri: logoUrl,
    additionalMetadata: [],
  }
  const mintLen  = getMintLen([ExtensionType.MetadataPointer])
  const metaLen  = TYPE_SIZE + LENGTH_SIZE + pack(metadata).length
  const lamports = await connection.getMinimumBalanceForRentExemption(mintLen + metaLen)

  // ATA del payer para este mint
  const ataAddress = getAssociatedTokenAddressSync(
    mintKp.publicKey, publicKey, false,
    TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  )

  const tx = new Transaction().add(
    // Crear cuenta del mint
    SystemProgram.createAccount({
      fromPubkey: publicKey,
      newAccountPubkey: mintKp.publicKey,
      space: mintLen,
      lamports,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    // Inicializar MetadataPointer
    createInitializeMetadataPointerInstruction(
      mintKp.publicKey, publicKey, mintKp.publicKey, TOKEN_2022_PROGRAM_ID
    ),
    // Inicializar Mint
    createInitializeMintInstruction(
      mintKp.publicKey, decimals, publicKey, publicKey, TOKEN_2022_PROGRAM_ID
    ),
    // Escribir metadata
    createInitializeInstruction({
      programId: TOKEN_2022_PROGRAM_ID,
      metadata: mintKp.publicKey,
      updateAuthority: publicKey,
      mint: mintKp.publicKey,
      mintAuthority: publicKey,
      name, symbol, uri: logoUrl,
    }),
    // Crear ATA del payer
    createAssociatedTokenAccountInstruction(
      publicKey, ataAddress, publicKey, mintKp.publicKey,
      TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
    )
  )

  // mintKp firma como extra (la wallet firma como payer/feePayer)
  const sig = await sendTx(connection, tx, publicKey, sendTransaction, [mintKp])

  return {
    mintAddress: mintKp.publicKey.toBase58(),
    payerATA:    ataAddress.toBase58(),
    sig,
  }
}

// 0. Calcular ATA localmente (sin red)
function fnGetATA(mintAddress: string, ownerWallet: string): string {
  return getAssociatedTokenAddressSync(
    toPub(mintAddress), toPub(ownerWallet), false,
    TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  ).toBase58()
}

// 0b. Verificar ATA on-chain
async function fnGetATAInfo(
  connection: Connection, mintAddress: string, ownerWallet: string
): Promise<{ ata: string; exists: boolean; balance?: number; frozen?: boolean }> {
  const ata = fnGetATA(mintAddress, ownerWallet)
  try {
    const acct     = await getAccount(connection, toPub(ata), "confirmed", TOKEN_2022_PROGRAM_ID)
    const mintInfo = await getMint(connection, toPub(mintAddress), "confirmed", TOKEN_2022_PROGRAM_ID)
    return { ata, exists: true, balance: Number(acct.amount) / 10 ** mintInfo.decimals, frozen: acct.isFrozen }
  } catch {
    return { ata, exists: false }
  }
}

// 3. Mintear tokens
async function fnMintTokens(
  ctx: WalletCtx, mintAddress: string, destATA: string, amount: number
): Promise<string> {
  const { connection, publicKey, sendTransaction } = ctx
  const tx = new Transaction().add(
    createMintToInstruction(
      toPub(mintAddress), toPub(destATA), publicKey,
      toBase(amount), [], TOKEN_2022_PROGRAM_ID
    )
  )
  return sendTx(connection, tx, publicKey, sendTransaction)
}

// 4. Transferir tokens (crea ATA destino si no existe)
async function fnTransferTokens(
  ctx: WalletCtx, mintAddress: string, destWallet: string, amount: number
): Promise<{ destATA: string; sig: string }> {
  const { connection, publicKey, sendTransaction } = ctx

  const srcATA = getAssociatedTokenAddressSync(
    toPub(mintAddress), publicKey, false,
    TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  )
  const dstATA = getAssociatedTokenAddressSync(
    toPub(mintAddress), toPub(destWallet), false,
    TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  )

  const tx = new Transaction()

  // Crear ATA destino si no existe
  try {
    await getAccount(connection, dstATA, "confirmed", TOKEN_2022_PROGRAM_ID)
  } catch {
    tx.add(createAssociatedTokenAccountInstruction(
      publicKey, dstATA, toPub(destWallet), toPub(mintAddress),
      TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
    ))
  }

  tx.add(createTransferInstruction(
    srcATA, dstATA, publicKey, toBase(amount), [], TOKEN_2022_PROGRAM_ID
  ))

  const sig = await sendTx(connection, tx, publicKey, sendTransaction)
  return { destATA: dstATA.toBase58(), sig }
}

// 5. Aprobar delegado
async function fnApproveDelegate(
  ctx: WalletCtx, ata: string, delegateAddr: string, amount: number
): Promise<string> {
  const { connection, publicKey, sendTransaction } = ctx
  const tx = new Transaction().add(
    createApproveInstruction(
      toPub(ata), toPub(delegateAddr), publicKey,
      toBase(amount), [], TOKEN_2022_PROGRAM_ID
    )
  )
  return sendTx(connection, tx, publicKey, sendTransaction)
}

// 6. Revocar delegado
async function fnRevokeDelegate(ctx: WalletCtx, ata: string): Promise<string> {
  const { connection, publicKey, sendTransaction } = ctx
  const tx = new Transaction().add(
    createRevokeInstruction(toPub(ata), publicKey, [], TOKEN_2022_PROGRAM_ID)
  )
  return sendTx(connection, tx, publicKey, sendTransaction)
}

// 7. Cambiar / revocar autoridad
const AUTHORITY_MAP: Record<string, AuthorityType> = {
  MintTokens:    AuthorityType.MintTokens,
  FreezeAccount: AuthorityType.FreezeAccount,
  AccountOwner:  AuthorityType.AccountOwner,
  CloseAccount:  AuthorityType.CloseAccount,
}

async function fnSetAuthority(
  ctx: WalletCtx, accountOrMint: string, type: string, newAuth: string | null
): Promise<string> {
  const { connection, publicKey, sendTransaction } = ctx
  const tx = new Transaction().add(
    createSetAuthorityInstruction(
      toPub(accountOrMint), publicKey, AUTHORITY_MAP[type],
      newAuth ? toPub(newAuth) : null, [], TOKEN_2022_PROGRAM_ID
    )
  )
  return sendTx(connection, tx, publicKey, sendTransaction)
}

// 8. Quemar tokens
async function fnBurnTokens(
  ctx: WalletCtx, ata: string, mintAddress: string, amount: number
): Promise<{ newSupply: number; newBalance: number; sig: string }> {
  const { connection, publicKey, sendTransaction } = ctx
  const tx = new Transaction().add(
    createBurnInstruction(
      toPub(ata), toPub(mintAddress), publicKey,
      toBase(amount), [], TOKEN_2022_PROGRAM_ID
    )
  )
  const sig      = await sendTx(connection, tx, publicKey, sendTransaction)
  const mintInfo = await getMint(connection, toPub(mintAddress), "confirmed", TOKEN_2022_PROGRAM_ID)
  const acct     = await getAccount(connection, toPub(ata), "confirmed", TOKEN_2022_PROGRAM_ID)
  return {
    newSupply:  Number(mintInfo.supply) / 10 ** mintInfo.decimals,
    newBalance: Number(acct.amount)     / 10 ** mintInfo.decimals,
    sig,
  }
}

// 10. Congelar cuenta
async function fnFreezeAccount(
  ctx: WalletCtx, ata: string, mintAddress: string
): Promise<string> {
  const { connection, publicKey, sendTransaction } = ctx
  const tx = new Transaction().add(
    createFreezeAccountInstruction(
      toPub(ata), toPub(mintAddress), publicKey, [], TOKEN_2022_PROGRAM_ID
    )
  )
  return sendTx(connection, tx, publicKey, sendTransaction)
}

// 11. Descongelar cuenta
async function fnThawAccount(
  ctx: WalletCtx, ata: string, mintAddress: string
): Promise<string> {
  const { connection, publicKey, sendTransaction } = ctx
  const tx = new Transaction().add(
    createThawAccountInstruction(
      toPub(ata), toPub(mintAddress), publicKey, [], TOKEN_2022_PROGRAM_ID
    )
  )
  return sendTx(connection, tx, publicKey, sendTransaction)
}

// 9. Cerrar token account
async function fnCloseAccount(
  ctx: WalletCtx, ata: string, solDest: string
): Promise<string> {
  const { connection, publicKey, sendTransaction } = ctx
  const tx = new Transaction().add(
    createCloseAccountInstruction(
      toPub(ata), toPub(solDest), publicKey, [], TOKEN_2022_PROGRAM_ID
    )
  )
  return sendTx(connection, tx, publicKey, sendTransaction)
}

// ─────────────────────────────────────────────────────────────────────────────
// ESTILOS
// ─────────────────────────────────────────────────────────────────────────────
const css = {
  page: {
    maxWidth: 860, margin: "0 auto", padding: "20px",
    fontFamily: "Arial, sans-serif", fontSize: 14,
  } as React.CSSProperties,

  header: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    marginBottom: 24, padding: "10px 14px",
    backgroundColor: "#f5f5f5", borderRadius: 8,
  } as React.CSSProperties,

  tabBar: {
    display: "flex", gap: 4, marginBottom: 0,
    borderBottom: "2px solid #ddd", flexWrap: "wrap" as const,
  },

  tab: (active: boolean): React.CSSProperties => ({
    padding: "8px 16px",
    backgroundColor: active ? "#1976d2" : "transparent",
    color: active ? "white" : "#333",
    border: "none", borderRadius: "4px 4px 0 0",
    cursor: "pointer", fontSize: 13,
    fontWeight: active ? "bold" : "normal",
    transition: "all 0.2s",
  }),

  card: {
    backgroundColor: "white", padding: 20,
    borderRadius: "0 4px 8px 8px",
    boxShadow: "0 2px 6px rgba(0,0,0,0.08)", marginBottom: 16,
  } as React.CSSProperties,

  label: {
    display: "block", marginBottom: 6,
    fontWeight: "bold" as const, fontSize: 13, color: "#444",
  },

  input: {
    width: "100%", padding: "9px 10px",
    border: "1px solid #ddd", borderRadius: 4,
    fontSize: 14, boxSizing: "border-box" as const, marginBottom: 12,
  },

  select: {
    width: "100%", padding: "9px 10px",
    border: "1px solid #ddd", borderRadius: 4,
    fontSize: 14, boxSizing: "border-box" as const,
    marginBottom: 12, backgroundColor: "white",
  } as React.CSSProperties,

  hint: {
    fontSize: 11, color: "#888", marginTop: -8, marginBottom: 12, display: "block" as const,
  },

  btn: (color = "#1976d2", disabled = false): React.CSSProperties => ({
    padding: "10px 20px",
    backgroundColor: disabled ? "#ccc" : color,
    color: "white", border: "none", borderRadius: 4,
    fontSize: 14, cursor: disabled ? "not-allowed" : "pointer",
    marginRight: 8, marginTop: 4,
  }),

  row: { display: "flex", gap: 8, flexWrap: "wrap" as const },

  result: (ok: boolean): React.CSSProperties => ({
    marginTop: 16, padding: "10px 14px",
    backgroundColor: ok ? "#e8f5e9" : "#ffebee",
    borderLeft: `4px solid ${ok ? "#388e3c" : "#c62828"}`,
    borderRadius: "0 4px 4px 0", fontSize: 13, lineHeight: 1.8,
  }),
}

// ─────────────────────────────────────────────────────────────────────────────
// HOOK: useAction
// ─────────────────────────────────────────────────────────────────────────────
function useAction() {
  const [result, setResult] = useState<TxResult | null>(null)
  const [loading, setLoading] = useState(false)

  const run = async (fn: () => Promise<TxResult>) => {
    setLoading(true)
    setResult(null)
    try {
      setResult(await fn())
    } catch (e: unknown) {
      setResult({
        ok: false,
        lines: [{ label: "Error", value: e instanceof Error ? e.message : String(e) }],
      })
    } finally {
      setLoading(false)
    }
  }

  return { result, loading, run }
}

// ─────────────────────────────────────────────────────────────────────────────
// ResultBox
// ─────────────────────────────────────────────────────────────────────────────
function ResultBox({ result }: { result: TxResult | null }) {
  if (!result) return null
  return (
    <div style={css.result(result.ok)}>
      <strong>{result.ok ? "✅ Éxito" : "❌ Error"}</strong>
      {result.lines.map((l, i) => (
        <div key={i}>
          <strong>{l.label}:</strong>{" "}
          {l.link
            ? <a href={l.link} target="_blank" rel="noreferrer" style={{ color: "#1565c0" }}>{l.value}</a>
            : l.value}
        </div>
      ))}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// HOOK: useWalletCtx — agrupa el contexto de wallet para pasarlo a las fn*
// ─────────────────────────────────────────────────────────────────────────────
function useWalletCtx(): WalletCtx | null {
  const { connection } = useConnection()
  const { publicKey, sendTransaction } = useWallet()
  if (!publicKey) return null
  return { connection, publicKey, sendTransaction }
}

// ─────────────────────────────────────────────────────────────────────────────
// PANELES
// ─────────────────────────────────────────────────────────────────────────────

function PanelCreate() {
  const ctx = useWalletCtx()
  const [name, setName]         = useState("")
  const [symbol, setSymbol]     = useState("")
  const [logo, setLogo]         = useState("")
  const [decimals, setDecimals] = useState("9")
  const { result, loading, run } = useAction()

  const handle = () => run(async () => {
    if (!ctx) throw new Error("Conecta tu wallet primero")
    if (!name || !symbol || !logo) throw new Error("Nombre, símbolo y logo son requeridos")
    const r = await fnCreateMint(ctx, name, symbol, logo, parseInt(decimals) || 9)
    return {
      ok: true,
      lines: [
        { label: "Nombre",    value: name },
        { label: "Símbolo",   value: symbol },
        { label: "Mint",      value: short(r.mintAddress), link: accLink(r.mintAddress) },
        { label: "ATA payer", value: short(r.payerATA),    link: accLink(r.payerATA) },
        { label: "Signature", value: r.sig.slice(0, 40) + "…", link: txLink(r.sig) },
      ],
    }
  })

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Crear Token Mint con Metadata</h2>
      <label style={css.label}>Nombre del token</label>
      <input style={css.input} value={name} onChange={e => setName(e.target.value)} placeholder="Testing Token" />
      <label style={css.label}>Símbolo</label>
      <input style={css.input} value={symbol} onChange={e => setSymbol(e.target.value)} placeholder="TTK" />
      <label style={css.label}>URL del logo</label>
      <input style={css.input} value={logo} onChange={e => setLogo(e.target.value)} placeholder="https://..." />
      <small style={css.hint}>URL de imagen o JSON off-chain. En producción usa Arweave / IPFS.</small>
      <label style={css.label}>Decimals</label>
      <input style={css.input} value={decimals} onChange={e => setDecimals(e.target.value)} type="number" min="0" max="9" placeholder="9" />
      <button style={css.btn("#4CAF50", loading || !ctx)} disabled={loading || !ctx} onClick={handle}>
        {loading ? "Creando…" : "Crear Mint + Metadata"}
      </button>
      <ResultBox result={result} />
    </div>
  )
}

function PanelATA() {
  const { connection } = useConnection()
  const [mint, setMint]   = useState("")
  const [owner, setOwner] = useState("")
  const { result, loading, run } = useAction()

  const handleLocal = () => run(async () => {
    const ata = fnGetATA(mint, owner)
    return {
      ok: true,
      lines: [
        { label: "Mint",        value: short(mint) },
        { label: "Owner",       value: short(owner) },
        { label: "ATA (local)", value: ata, link: accLink(ata) },
      ],
    }
  })

  const handleOnChain = () => run(async () => {
    const r = await fnGetATAInfo(connection, mint, owner)
    const lines: TxResult["lines"] = [
      { label: "ATA",    value: r.ata, link: accLink(r.ata) },
      { label: "Existe", value: r.exists ? "Sí" : "No" },
    ]
    if (r.exists) {
      lines.push({ label: "Balance", value: `${r.balance} tokens` })
      lines.push({ label: "Frozen",  value: r.frozen ? "Sí ❄️" : "No" })
    } else {
      lines.push({ label: "Info", value: "Se creará automáticamente al recibir tokens" })
    }
    return { ok: true, lines }
  })

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Associated Token Account</h2>
      <label style={css.label}>Mint Address</label>
      <input style={css.input} value={mint} onChange={e => setMint(e.target.value)} placeholder="52RBGd2ZZj5wLK6Rf..." />
      <label style={css.label}>Owner Wallet</label>
      <input style={css.input} value={owner} onChange={e => setOwner(e.target.value)} placeholder="9QRCnvghiw2V72vK..." />
      <div style={css.row}>
        <button style={css.btn("#1976d2", loading)} disabled={loading} onClick={handleLocal}>Calcular ATA</button>
        <button style={css.btn("#607d8b", loading)} disabled={loading} onClick={handleOnChain}>
          {loading ? "Consultando…" : "Verificar on-chain"}
        </button>
      </div>
      <ResultBox result={result} />
    </div>
  )
}

function PanelMint() {
  const ctx = useWalletCtx()
  const [mint, setMint]     = useState("")
  const [dest, setDest]     = useState("")
  const [amount, setAmount] = useState("")
  const { result, loading, run } = useAction()

  const handle = () => run(async () => {
    if (!ctx) throw new Error("Conecta tu wallet primero")
    if (!mint || !dest || !amount) throw new Error("Todos los campos son requeridos")
    const sig = await fnMintTokens(ctx, mint, dest, parseFloat(amount))
    return {
      ok: true,
      lines: [
        { label: "Cantidad",    value: `${amount} tokens` },
        { label: "Destino ATA", value: short(dest) },
        { label: "Signature",   value: sig.slice(0, 40) + "…", link: txLink(sig) },
      ],
    }
  })

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Mintear Tokens</h2>
      <label style={css.label}>Mint Address</label>
      <input style={css.input} value={mint} onChange={e => setMint(e.target.value)} placeholder="52RBGd2ZZj5wLK6Rf..." />
      <label style={css.label}>ATA destino</label>
      <input style={css.input} value={dest} onChange={e => setDest(e.target.value)} placeholder="7Xh5gNTbGgQSW7pz..." />
      <label style={css.label}>Cantidad</label>
      <input style={css.input} value={amount} onChange={e => setAmount(e.target.value)} type="number" min="0" placeholder="1000" />
      <button style={css.btn("#1976d2", loading || !ctx)} disabled={loading || !ctx} onClick={handle}>
        {loading ? "Minteando…" : "Mintear Tokens"}
      </button>
      <ResultBox result={result} />
    </div>
  )
}

function PanelTransfer() {
  const ctx = useWalletCtx()
  const [mint, setMint]     = useState("")
  const [dest, setDest]     = useState("")
  const [amount, setAmount] = useState("")
  const { result, loading, run } = useAction()

  const handle = () => run(async () => {
    if (!ctx) throw new Error("Conecta tu wallet primero")
    if (!mint || !dest || !amount) throw new Error("Todos los campos son requeridos")
    const r = await fnTransferTokens(ctx, mint, dest, parseFloat(amount))
    return {
      ok: true,
      lines: [
        { label: "Cantidad",       value: `${amount} tokens` },
        { label: "Destino wallet", value: short(dest) },
        { label: "Destino ATA",    value: short(r.destATA), link: accLink(r.destATA) },
        { label: "Signature",      value: r.sig.slice(0, 40) + "…", link: txLink(r.sig) },
      ],
    }
  })

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Transferir Tokens</h2>
      <label style={css.label}>Mint Address</label>
      <input style={css.input} value={mint} onChange={e => setMint(e.target.value)} placeholder="52RBGd2ZZj5wLK6Rf..." />
      <label style={css.label}>Wallet destino</label>
      <input style={css.input} value={dest} onChange={e => setDest(e.target.value)} placeholder="85DeTbK7vtGtFKvu..." />
      <small style={css.hint}>Pega la wallet, no la ATA — se resuelve automáticamente.</small>
      <label style={css.label}>Cantidad</label>
      <input style={css.input} value={amount} onChange={e => setAmount(e.target.value)} type="number" min="0" placeholder="200" />
      <button style={css.btn("#2196F3", loading || !ctx)} disabled={loading || !ctx} onClick={handle}>
        {loading ? "Transfiriendo…" : "Transferir"}
      </button>
      <ResultBox result={result} />
    </div>
  )
}

function PanelDelegate() {
  const ctx = useWalletCtx()
  const [ata, setAta]           = useState("")
  const [delegate, setDelegate] = useState("")
  const [amount, setAmount]     = useState("")
  const { result, loading, run } = useAction()

  const handleApprove = () => run(async () => {
    if (!ctx) throw new Error("Conecta tu wallet primero")
    if (!ata || !delegate || !amount) throw new Error("Todos los campos son requeridos")
    const sig = await fnApproveDelegate(ctx, ata, delegate, parseFloat(amount))
    return {
      ok: true,
      lines: [
        { label: "ATA",       value: short(ata) },
        { label: "Delegado",  value: short(delegate) },
        { label: "Allowance", value: `${amount} tokens` },
        { label: "Signature", value: sig.slice(0, 40) + "…", link: txLink(sig) },
      ],
    }
  })

  const handleRevoke = () => run(async () => {
    if (!ctx) throw new Error("Conecta tu wallet primero")
    if (!ata) throw new Error("ATA es requerida")
    const sig = await fnRevokeDelegate(ctx, ata)
    return {
      ok: true,
      lines: [
        { label: "ATA",       value: short(ata) },
        { label: "Delegado",  value: "Revocado" },
        { label: "Signature", value: sig.slice(0, 40) + "…", link: txLink(sig) },
      ],
    }
  })

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Aprobar / Revocar Delegado</h2>
      <label style={css.label}>Token Account (ATA)</label>
      <input style={css.input} value={ata} onChange={e => setAta(e.target.value)} placeholder="7Xh5gNTbGgQSW7pz..." />
      <label style={css.label}>Dirección del delegado</label>
      <input style={css.input} value={delegate} onChange={e => setDelegate(e.target.value)} placeholder="..." />
      <label style={css.label}>Cantidad a delegar</label>
      <input style={css.input} value={amount} onChange={e => setAmount(e.target.value)} type="number" min="0" placeholder="100" />
      <div style={css.row}>
        <button style={css.btn("#1976d2", loading || !ctx)} disabled={loading || !ctx} onClick={handleApprove}>
          {loading ? "Procesando…" : "Aprobar Delegado"}
        </button>
        <button style={css.btn("#607d8b", loading || !ctx)} disabled={loading || !ctx} onClick={handleRevoke}>
          Revocar Delegado
        </button>
      </div>
      <ResultBox result={result} />
    </div>
  )
}

function PanelAuthority() {
  const ctx = useWalletCtx()
  const [account, setAccount] = useState("")
  const [type, setType]       = useState("MintTokens")
  const [newAuth, setNewAuth] = useState("")
  const { result, loading, run } = useAction()

  const handle = () => run(async () => {
    if (!ctx) throw new Error("Conecta tu wallet primero")
    if (!account) throw new Error("Cuenta o mint es requerido")
    const sig = await fnSetAuthority(ctx, account, type, newAuth.trim() || null)
    const isRevoke = !newAuth.trim()
    return {
      ok: true,
      lines: [
        { label: "Tipo",       value: type },
        { label: "Nueva auth", value: isRevoke ? "⚠️ Revocada permanentemente" : short(newAuth) },
        { label: "Signature",  value: sig.slice(0, 40) + "…", link: txLink(sig) },
      ],
    }
  })

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Cambiar / Revocar Autoridad</h2>
      <label style={css.label}>Mint o Token Account</label>
      <input style={css.input} value={account} onChange={e => setAccount(e.target.value)} placeholder="52RBGd2ZZj5wLK6Rf..." />
      <label style={css.label}>Tipo de autoridad</label>
      <select style={css.select} value={type} onChange={e => setType(e.target.value)}>
        <option value="MintTokens">MintTokens — quien puede mintear</option>
        <option value="FreezeAccount">FreezeAccount — quien puede congelar</option>
        <option value="AccountOwner">AccountOwner — dueño de la token account</option>
        <option value="CloseAccount">CloseAccount — quien puede cerrar</option>
      </select>
      <label style={css.label}>Nueva autoridad</label>
      <input style={css.input} value={newAuth} onChange={e => setNewAuth(e.target.value)} placeholder="Dejar vacío para revocar permanentemente" />
      <button style={css.btn("#FF9800", loading || !ctx)} disabled={loading || !ctx} onClick={handle}>
        {loading ? "Actualizando…" : "Actualizar Autoridad"}
      </button>
      <ResultBox result={result} />
    </div>
  )
}

function PanelBurn() {
  const ctx = useWalletCtx()
  const [ata, setAta]       = useState("")
  const [mint, setMint]     = useState("")
  const [amount, setAmount] = useState("")
  const { result, loading, run } = useAction()

  const handle = () => run(async () => {
    if (!ctx) throw new Error("Conecta tu wallet primero")
    if (!ata || !mint || !amount) throw new Error("Todos los campos son requeridos")
    const r = await fnBurnTokens(ctx, ata, mint, parseFloat(amount))
    return {
      ok: true,
      lines: [
        { label: "Quemados",         value: `${amount} tokens` },
        { label: "Supply restante",  value: `${r.newSupply} tokens` },
        { label: "Balance restante", value: `${r.newBalance} tokens` },
        { label: "Signature",        value: r.sig.slice(0, 40) + "…", link: txLink(r.sig) },
      ],
    }
  })

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Quemar Tokens</h2>
      <label style={css.label}>Token Account (ATA)</label>
      <input style={css.input} value={ata} onChange={e => setAta(e.target.value)} placeholder="7Xh5gNTbGgQSW7pz..." />
      <label style={css.label}>Mint Address</label>
      <input style={css.input} value={mint} onChange={e => setMint(e.target.value)} placeholder="52RBGd2ZZj5wLK6Rf..." />
      <label style={css.label}>Cantidad a quemar</label>
      <input style={css.input} value={amount} onChange={e => setAmount(e.target.value)} type="number" min="0" placeholder="50" />
      <button style={css.btn("#f44336", loading || !ctx)} disabled={loading || !ctx} onClick={handle}>
        {loading ? "Quemando…" : "Quemar Tokens"}
      </button>
      <ResultBox result={result} />
    </div>
  )
}

function PanelFreeze() {
  const ctx = useWalletCtx()
  const [ata, setAta]   = useState("")
  const [mint, setMint] = useState("")
  const { result, loading, run } = useAction()

  const handleFreeze = () => run(async () => {
    if (!ctx) throw new Error("Conecta tu wallet primero")
    if (!ata || !mint) throw new Error("ATA y Mint son requeridos")
    const sig = await fnFreezeAccount(ctx, ata, mint)
    return {
      ok: true,
      lines: [
        { label: "ATA",       value: short(ata) },
        { label: "Estado",    value: "FROZEN ❄️" },
        { label: "Signature", value: sig.slice(0, 40) + "…", link: txLink(sig) },
      ],
    }
  })

  const handleThaw = () => run(async () => {
    if (!ctx) throw new Error("Conecta tu wallet primero")
    if (!ata || !mint) throw new Error("ATA y Mint son requeridos")
    const sig = await fnThawAccount(ctx, ata, mint)
    return {
      ok: true,
      lines: [
        { label: "ATA",       value: short(ata) },
        { label: "Estado",    value: "INITIALIZED ✅" },
        { label: "Signature", value: sig.slice(0, 40) + "…", link: txLink(sig) },
      ],
    }
  })

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Congelar / Descongelar Cuenta</h2>
      <label style={css.label}>Token Account (ATA)</label>
      <input style={css.input} value={ata} onChange={e => setAta(e.target.value)} placeholder="7Xh5gNTbGgQSW7pz..." />
      <label style={css.label}>Mint Address</label>
      <input style={css.input} value={mint} onChange={e => setMint(e.target.value)} placeholder="52RBGd2ZZj5wLK6Rf..." />
      <div style={css.row}>
        <button style={css.btn("#1565c0", loading || !ctx)} disabled={loading || !ctx} onClick={handleFreeze}>
          {loading ? "Procesando…" : "Congelar ❄️"}
        </button>
        <button style={css.btn("#607d8b", loading || !ctx)} disabled={loading || !ctx} onClick={handleThaw}>
          Descongelar
        </button>
      </div>
      <ResultBox result={result} />
    </div>
  )
}

function PanelClose() {
  const ctx = useWalletCtx()
  const [ata, setAta]   = useState("")
  const [dest, setDest] = useState("")
  const { result, loading, run } = useAction()

  const handle = () => run(async () => {
    if (!ctx) throw new Error("Conecta tu wallet primero")
    if (!ata || !dest) throw new Error("ATA y wallet destino son requeridas")
    const sig = await fnCloseAccount(ctx, ata, dest)
    return {
      ok: true,
      lines: [
        { label: "ATA cerrada",    value: short(ata) },
        { label: "SOL devuelto a", value: short(dest) },
        { label: "Signature",      value: sig.slice(0, 40) + "…", link: txLink(sig) },
      ],
    }
  })

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Cerrar Token Account</h2>
      <label style={css.label}>Token Account (ATA) a cerrar</label>
      <input style={css.input} value={ata} onChange={e => setAta(e.target.value)} placeholder="7Xh5gNTbGgQSW7pz..." />
      <small style={css.hint}>La cuenta debe tener balance 0 para poder cerrarse.</small>
      <label style={css.label}>Wallet que recibe el SOL del rent</label>
      <input style={css.input} value={dest} onChange={e => setDest(e.target.value)} placeholder="wallet destino..." />
      <button style={css.btn("#757575", loading || !ctx)} disabled={loading || !ctx} onClick={handle}>
        {loading ? "Cerrando…" : "Cerrar Cuenta"}
      </button>
      <ResultBox result={result} />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// APP INNER
// ─────────────────────────────────────────────────────────────────────────────
const PANELS: Record<TabId, React.FC> = {
  create:    PanelCreate,
  ata:       PanelATA,
  mint:      PanelMint,
  transfer:  PanelTransfer,
  delegate:  PanelDelegate,
  authority: PanelAuthority,
  burn:      PanelBurn,
  freeze:    PanelFreeze,
  close:     PanelClose,
}

function AppInner() {
  const { publicKey } = useWallet()
  const [activeTab, setActiveTab] = useState<TabId>("create")
  const Panel = PANELS[activeTab]

  return (
    <div style={css.page}>
      <div style={css.header}>
        <h2 style={{ margin: 0, fontSize: 18 }}>🪙 SPL Token Manager</h2>
        <WalletMultiButton />
      </div>

      <div style={{ marginBottom: 16, padding: "8px 12px", backgroundColor: "#f5f5f5", borderRadius: 4, fontSize: 13 }}>
        <strong>Wallet:</strong>{" "}
        {publicKey
          ? <span style={{ color: "#388e3c" }}>✅ {publicKey.toBase58().slice(0, 20)}…</span>
          : <span style={{ color: "#f57c00" }}>⚠️ No conectada — haz click en Select Wallet</span>
        }
      </div>

      <div style={css.tabBar}>
        {TABS.map(t => (
          <button key={t.id} style={css.tab(activeTab === t.id)} onClick={() => setActiveTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      <div style={css.card}>
        <Panel />
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// APP ROOT
// ─────────────────────────────────────────────────────────────────────────────
export default function App() {
  const wallets = useMemo(() => [new PhantomWalletAdapter()], [])

  return (
    <ConnectionProvider endpoint={DEVNET_URL}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <AppInner />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  )
}