# SPL Token Manager — Token-2022

Herramienta para crear y administrar tokens SPL usando el programa **Token-2022** (Token Extensions) de Solana. Incluye dos modos de uso:

- **`spl-token-basics.ts`** — script Node.js con `Keypair` local, útil para scripts, bots o pruebas desde terminal
- **`App.tsx`** — interfaz React que conecta con Phantom (o cualquier wallet adapter), donde el usuario firma desde su wallet

Ambos archivos implementan las mismas 11 operaciones. La diferencia es quién firma: un `Keypair` en memoria (script) o la wallet del usuario (React).

---

## Instalación

```bash
# Desde la carpeta raiz ejecutar
npm install
```

### El archivo vite.config.ts fue modificado de la siguiente manera:

```ts
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { nodePolyfills } from "vite-plugin-node-polyfills"

export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({
      include: ["buffer", "process"],
      globals: { Buffer: true, global: true, process: true },
    }),
  ],
})
```

---

## Conceptos que debes conocer

### Mint vs Token Account vs ATA

```
Mint (52RBGd...)          ← define el token: supply, decimals, autoridades
  │
  ├── ATA de wallet A (7Xh5...)   ← guarda el balance de A para este mint
  └── ATA de wallet B (2xH2...)   ← guarda el balance de B para este mint
```

- Un **Mint** es único por token. Su dirección es el identificador del token.
- Una **Token Account** guarda tokens de un único mint para un único owner.
- Una **ATA** (Associated Token Account) es la token account estándar: su dirección se calcula determinísticamente a partir de `owner + TOKEN_2022_PROGRAM_ID + mint`.

### Unidades base vs tokens legibles

Los tokens se almacenan en **unidades base** (enteros). Con `decimals = 9`, un token legible equivale a `1_000_000_000` unidades base.

```ts
// La conversión está encapsulada en ambos archivos:
const toBase = (tokens: number, decimals = 9) =>
  BigInt(Math.round(tokens * 10 ** decimals))

toBase(1)    // → 1_000_000_000n
toBase(0.5)  // →   500_000_000n
```

Siempre trabaja con tokens legibles en las funciones — la conversión es interna.

### Token-2022 vs Token clásico

Este proyecto usa exclusivamente `TOKEN_2022_PROGRAM_ID`. La diferencia principal en la práctica:

| | Token clásico | Token-2022 |
|---|---|---|
| Program ID | `TokenkegQfe…` | `TokenzQdBN…` |
| Metadata embebida | ❌ (requiere Metaplex) | ✅ (MetadataPointer + TokenMetadata) |
| Extensiones | ❌ | ✅ (freeze default, transfer fee, etc.) |

> Siempre pasa `TOKEN_2022_PROGRAM_ID` explícitamente en cada llamada a `@solana/spl-token`. Si lo omites, usará el programa clásico y fallará silenciosamente.

---

## Funciones disponibles

### 0. `getATA` / `getATAInfo`

Calcula o verifica la ATA de una wallet para un mint.

```ts
// Cálculo local puro — sin red, instantáneo
const ata: PublicKey = getATA(mintAddress, ownerWallet)

// Verificación on-chain — consulta si existe y cuál es el balance
const { ata, exists, balance } = await getATAInfo(connection, mintAddress, ownerWallet)
```

**Cuándo usarlo:** antes de transferir, para saber si necesitas crear la ATA destino. En `transferTokens` ya está integrado automáticamente.

---

### 1. `createTokenMintWithMetadata`

Crea el Mint y embebe nombre, símbolo y URI directamente en la cuenta del mint usando las extensiones `MetadataPointer` + `TokenMetadata`. También crea la ATA del payer en la misma transacción.

```ts
// spl-token-basics.ts (Keypair)
const { mintAddress, payerATA, metadata } = await createTokenMintWithMetadata(
  connection,
  payer,          // Keypair — paga el rent y es mint/freeze authority
  {
    name:    "Testing Token",
    symbol:  "TTK",
    logoUrl: "https://arweave.net/tu-metadata.json",
    decimals: 9,  // opcional, default 9
  }
)
```

```ts
// App.tsx (wallet adapter) — equivalente interno
const result = await fnCreateMint(ctx, name, symbol, logoUrl, decimals)
// ctx = { connection, publicKey, sendTransaction } — de useWallet()
```

**Orden interno de instrucciones (obligatorio):**
1. `SystemProgram.createAccount` — crea la cuenta del mint con el rent calculado
2. `createInitializeMetadataPointerInstruction` — apunta la metadata al propio mint
3. `createInitializeMintInstruction` — inicializa decimales y autoridades
4. `createInitializeInstruction` — escribe nombre, símbolo y URI

> El rent se calcula para el tamaño total: `mintLen + metadataLen`. Si lo calculas solo para `mintLen`, la transacción fallará porque la cuenta no tiene lamports suficientes para el espacio adicional de metadata.

**Sobre la URI:** puede ser una URL directa de imagen o un JSON off-chain con el formato Metaplex:
```json
{
  "name": "Testing Token",
  "symbol": "TTK",
  "image": "https://tu-imagen.png"
}
```
En producción sube el JSON a Arweave o IPFS y usa esa URL como `logoUrl`.

---

### 2. `createTokenAccount`

Crea una ATA para cualquier wallet. Si ya existe, la devuelve sin error.

```ts
const tokenAccount = await createTokenAccount(
  connection,
  payer,           // quien paga la creación
  mintAddress,
  ownerWallet      // dueño de la nueva cuenta
)
```

En `App.tsx` esto está integrado dentro de `fnTransferTokens` — si la ATA destino no existe, se crea en la misma transacción.

---

### 3. `mintTokens` / `fnMintTokens`

Acuña nuevos tokens. Solo el **mint authority** puede ejecutar esta operación.

```ts
// spl-token-basics.ts
await mintTokens(
  connection,
  payer,          // fee payer
  mintAddress,
  destinationATA, // ATA que recibe los tokens (debe existir)
  payer,          // mint authority (Keypair que firma)
  1000            // tokens legibles
)

// App.tsx
await fnMintTokens(ctx, mintAddress, destATA, 1000)
// ctx.publicKey debe ser el mint authority
```

> Si revocaste el mint authority con `setTokenAuthority(..., null)`, esta operación fallará permanentemente. El supply queda fijo para siempre.

---

### 4. `transferTokens` / `fnTransferTokens`

Mueve tokens entre wallets. Pasa la **wallet destino**, no su ATA — la función deriva y crea la ATA automáticamente si no existe.

```ts
// spl-token-basics.ts
await transferTokens(
  connection,
  payer,
  mintAddress,
  sourceOwner,       // Keypair dueño del origen
  destinationWallet, // PublicKey de la wallet destino (NO la ATA)
  200
)

// App.tsx
await fnTransferTokens(ctx, mintAddress, destinationWallet, 200)
// La ATA origen se deriva de ctx.publicKey + mintAddress
// La ATA destino se crea si no existe (instrucción incluida en la tx)
```

---

### 5. `approveDelegate` / `fnApproveDelegate`

Autoriza a otra dirección a mover hasta `amount` tokens desde tu ATA, sin ceder la propiedad. Solo puedes tener un delegado activo a la vez.

```ts
// spl-token-basics.ts
await approveDelegate(
  connection, payer,
  tokenAccountAddress, // tu ATA
  delegateAddress,     // quien recibe el permiso
  owner,               // dueño de la ATA (firma)
  100                  // máximo que puede mover
)

// App.tsx
await fnApproveDelegate(ctx, ataAddress, delegateAddress, 100)
```

---

### 6. `revokeDelegate` / `fnRevokeDelegate`

Elimina al delegado actual y resetea el allowance a cero.

```ts
// spl-token-basics.ts
await revokeDelegate(connection, payer, tokenAccountAddress, owner)

// App.tsx
await fnRevokeDelegate(ctx, ataAddress)
```

---

### 7. `setTokenAuthority` / `fnSetAuthority`

Cambia o revoca una autoridad del mint o de una token account.

```ts
// spl-token-basics.ts
await setTokenAuthority(
  connection, payer,
  mintAddress,              // o una token account
  AuthorityType.MintTokens, // tipo a modificar
  currentAuthority,         // Keypair que firma el cambio
  newAuthority              // PublicKey nueva, o null para revocar
)

// App.tsx
await fnSetAuthority(ctx, mintAddress, "MintTokens", newAuthAddress)
// newAuthAddress = "" o null → revoca permanentemente
```

**Tipos de autoridad disponibles:**

| Tipo | Aplica a | Controla |
|---|---|---|
| `MintTokens` | Mint | Quién puede acuñar nuevos tokens |
| `FreezeAccount` | Mint | Quién puede congelar/descongelar cuentas |
| `AccountOwner` | Token Account | Dueño de la cuenta (puede transferir/quemar) |
| `CloseAccount` | Token Account | Quién puede cerrar la cuenta |

> Pasar `null` como nueva autoridad es **irreversible**. Si revocas `MintTokens`, el supply queda fijo para siempre.

---

### 8. `burnTokens` / `fnBurnTokens`

Destruye tokens de una ATA, reduciendo el supply total del mint.

```ts
// spl-token-basics.ts
await burnTokens(connection, payer, tokenAccountAddress, mintAddress, owner, 50)

// App.tsx
const { newSupply, newBalance, sig } = await fnBurnTokens(ctx, ata, mintAddress, 50)
```

> Para cerrar una token account (paso 9), primero debes quemar o transferir todos los tokens hasta que el balance sea 0.

---

### 9. `closeTokenAccount` / `fnCloseAccount`

Cierra la token account y devuelve el SOL del rent al destino indicado.

```ts
// Requisito: balance == 0
// spl-token-basics.ts
await closeTokenAccount(
  connection, payer,
  tokenAccountAddress,
  solDestination,  // recibe el rent recuperado
  owner
)

// App.tsx
await fnCloseAccount(ctx, ataAddress, solDestinationAddress)
```

---

### 10. `freezeTokenAccount` / `fnFreezeAccount`

Congela una token account. Una cuenta congelada no puede recibir, transferir ni quemar tokens.

```ts
// spl-token-basics.ts
await freezeTokenAccount(connection, payer, tokenAccountAddress, mintAddress, freezeAuthority)

// App.tsx — ctx.publicKey debe ser el freeze authority
await fnFreezeAccount(ctx, ataAddress, mintAddress)
```

> Solo funciona si el mint tiene una `freezeAuthority` asignada. Si fue revocada, ninguna cuenta puede congelarse.

---

### 11. `thawTokenAccount` / `fnThawAccount`

Descongela una token account, restaurando su operación normal.

```ts
// spl-token-basics.ts
await thawTokenAccount(connection, payer, tokenAccountAddress, mintAddress, freezeAuthority)

// App.tsx
await fnThawAccount(ctx, ataAddress, mintAddress)
```

---

## Flujo completo de ejemplo

```
1. createTokenMintWithMetadata  → mintAddress, payerATA
2. mintTokens                   → acuña tokens en payerATA
3. transferTokens               → envía tokens a otra wallet
4. approveDelegate              → autoriza a un tercero
5. revokeDelegate               → cancela la autorización
6. setTokenAuthority            → cambia o revoca autoridades
7. burnTokens                   → destruye tokens
8. freezeTokenAccount           → congela una cuenta
9. thawTokenAccount             → descongela
10. closeTokenAccount           → cierra y recupera SOL
```

---

## Diferencias entre `spl-token-basics.ts` y `App.tsx`

| Aspecto | `spl-token-basics.ts` | `App.tsx` |
|---|---|---|
| Entorno | Node.js (terminal) | Browser (React) |
| Payer / firmante | `Keypair` en memoria | Wallet del usuario (Phantom) |
| Firma | `sendAndConfirmTransaction` | `sendTransaction` del wallet adapter |
| Contexto | `Connection` + `Keypair` | `WalletCtx` (`connection` + `publicKey` + `sendTransaction`) |
| `mintKp` (crear mint) | firma como signer extra | `tx.partialSign(mintKp)` antes de `sendTransaction` |
| Uso recomendado | Scripts, bots, CI/CD, tests | dApps con usuarios |

### El tipo `WalletCtx` en App.tsx

Todas las funciones `fn*` de `App.tsx` reciben este objeto en lugar de un `Keypair`:

```ts
interface WalletCtx {
  connection:      Connection
  publicKey:       PublicKey
  sendTransaction: (tx, conn, opts?) => Promise<TransactionSignature>
}
```

Se obtiene con el hook `useWalletCtx()`:

```ts
function useWalletCtx(): WalletCtx | null {
  const { connection } = useConnection()
  const { publicKey, sendTransaction } = useWallet()
  if (!publicKey) return null
  return { connection, publicKey, sendTransaction }
}
```

Si `publicKey` es null (wallet no conectada), retorna `null` y los botones se deshabilitan automáticamente con `disabled={!ctx}`.

---

## Cómo adaptar a tu propio proyecto

### Opción 1: Usar solo una función en un componente existente

```tsx
import { useWallet, useConnection } from "@solana/wallet-adapter-react"
import { Transaction, Keypair } from "@solana/web3.js"
import {
  TOKEN_2022_PROGRAM_ID,
  createMintToInstruction,
} from "@solana/spl-token"

function MiComponente() {
  const { connection } = useConnection()
  const { publicKey, sendTransaction } = useWallet()

  const mintear = async () => {
    if (!publicKey) return

    const tx = new Transaction().add(
      createMintToInstruction(
        mintAddress,    // PublicKey del mint
        destinoATA,     // PublicKey de la ATA destino
        publicKey,      // mint authority
        1_000_000_000n, // 1 token con 9 decimals
        [],
        TOKEN_2022_PROGRAM_ID
      )
    )

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
    tx.recentBlockhash = blockhash
    tx.feePayer = publicKey

    const sig = await sendTransaction(tx, connection)
    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight })
    console.log("Signature:", sig)
  }

  return <button onClick={mintear}>Mintear</button>
}
```

### Opción 2: Agregar una nueva pestaña a App.tsx (ejemplo)

1. Agrega el id al array `TABS`:
```ts
const TABS = [
  ...
  { id: "airdrop", label: "Airdrop" },
] as const
```

2. Escribe la función SPL con `WalletCtx`:
```ts
async function fnAirdrop(ctx: WalletCtx, destino: string): Promise<string> {
  // lógica con ctx.connection, ctx.publicKey, ctx.sendTransaction
}
```

3. Crea el panel React:
```tsx
function PanelAirdrop() {
  const ctx = useWalletCtx()
  const [dest, setDest] = useState("")
  const { result, loading, run } = useAction()

  const handle = () => run(async () => {
    if (!ctx) throw new Error("Conecta tu wallet primero")
    const sig = await fnAirdrop(ctx, dest)
    return {
      ok: true,
      lines: [{ label: "Signature", value: sig, link: txLink(sig) }],
    }
  })

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Airdrop</h2>
      <label style={css.label}>Destino</label>
      <input style={css.input} value={dest} onChange={e => setDest(e.target.value)} />
      <button style={css.btn("#4CAF50", loading || !ctx)} disabled={loading || !ctx} onClick={handle}>
        {loading ? "Procesando…" : "Ejecutar"}
      </button>
      <ResultBox result={result} />
    </div>
  )
}
```

4. Regístralo en el mapa de paneles:
```ts
const PANELS: Record<TabId, React.FC> = {
  ...
  airdrop: PanelAirdrop,
}
```

### Opción 3: Vibe Coding

El objetivo de este repositorio es servir como punto de partida proporcionando un template funcional de la creación e interacción de tokens-spl. Por ende, puede ser porporcionado como contexto y antecedente a cualquier modelo de lenguaje que genere código (GPT, Claude, DeepSeek, Qwen, MinMax, Kimi, etc.) de tal manera que facilite la integración en tu propio proyecto. Para hacerlo considera compartir el **App.tsx**. Recuerda que tambien puedes proporcionar la documentación oficial: [Token-SPL](https://github.com/solana-foundation/solana-com/tree/main/apps/docs/content/docs/es/tokens/basics).

## ¿Cómo Cambiar a Mainnet?

```ts
// App.tsx — cambiar la constante al inicio
const MAINNET_URL = "https://api.mainnet-beta.solana.com"

// O con un RPC privado (recomendado en producción)
const RPC_URL = "https://rpc.helius.xyz/?api-key=TU_API_KEY"
```

```ts
// spl-token-basics.ts
const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed")
```

> En mainnet no existe `requestAirdrop`. El payer debe tener SOL real.


## Patrones reutilizables

### `useAction` — manejo de estado async

```ts
// Disponible en App.tsx, cópialo a cualquier componente
function useAction() {
  const [result, setResult] = useState<TxResult | null>(null)
  const [loading, setLoading] = useState(false)

  const run = async (fn: () => Promise<TxResult>) => {
    setLoading(true)
    setResult(null)
    try {
      setResult(await fn())
    } catch (e) {
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
```

Uso:
```tsx
const { result, loading, run } = useAction()

<button disabled={loading} onClick={() => run(async () => {
  const sig = await fnMintTokens(ctx, mint, ata, 100)
  return { ok: true, lines: [{ label: "Sig", value: sig }] }
})}>
  {loading ? "Minteando…" : "Mintear"}
</button>

<ResultBox result={result} />
```

### `sendTx` — enviar transacción con wallet adapter

```ts
// La función central que abstrae el flujo de firma con Phantom
async function sendTx(
  connection: Connection,
  tx: Transaction,
  publicKey: PublicKey,
  sendTransaction: WalletCtx["sendTransaction"],
  extraSigners: Keypair[] = []  // para mintKp u otros co-firmantes que NO son la wallet
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
  tx.recentBlockhash = blockhash
  tx.feePayer = publicKey

  if (extraSigners.length) tx.partialSign(...extraSigners)

  const sig = await sendTransaction(tx, connection)
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed")
  return sig
}
```

`extraSigners` es necesario cuando la transacción requiere firmas adicionales además de la wallet, como al crear un mint (el `mintKp` debe firmar para aceptar que su cuenta sea creada).

---

## ⚠️ Consideraciones importantes para producción

### Datos redundantes que conviene fijar

El código actual está pensado para **crear** y **operar** un token desde la misma interfaz. Una vez que el token ya existe, hay dos datos que el usuario tendría que escribir en cada operación:

- **El Mint Address** — siempre el mismo para tu token
- **La ATA del operador** — siempre la misma para la wallet que administra el token

Repetirlos en cada formulario es propenso a errores y mala experiencia. La solución es definirlos como constantes al inicio del archivo:

```ts
// App.tsx — definir arriba junto a DEVNET_URL
const MINT_ADDRESS = "52RBGd2ZZj5wLK6RfRUiWX72Vb3hYcHjEVn4VFG4XEn5"
const ADMIN_ATA    = "7Xh5gNTbGgQSW7pzLFDfiE3xSCqjr2CEUF7VVvrdU7qH"
```

Y luego usarlos directamente en los paneles que los necesitan, eliminando esos campos del formulario:

```tsx
// PanelMint — ya no pide el mint ni la ATA, solo la cantidad
function PanelMint() {
  const ctx = useWalletCtx()
  const [amount, setAmount] = useState("")
  const { result, loading, run } = useAction()

  const handle = () => run(async () => {
    if (!ctx) throw new Error("Conecta tu wallet primero")
    const sig = await fnMintTokens(ctx, MINT_ADDRESS, ADMIN_ATA, parseFloat(amount))
    return { ok: true, lines: [{ label: "Signature", value: sig, link: txLink(sig) }] }
  })

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Mintear Tokens</h2>
      <label style={css.label}>Cantidad</label>
      <input style={css.input} value={amount} onChange={e => setAmount(e.target.value)} type="number" />
      <button style={css.btn("#1976d2", loading || !ctx)} disabled={loading || !ctx} onClick={handle}>
        {loading ? "Minteando…" : "Mintear Tokens"}
      </button>
      <ResultBox result={result} />
    </div>
  )
}
```

Lo mismo aplica para `PanelBurn`, `PanelFreeze`, `PanelDelegate` y `PanelAuthority` — todos operan siempre sobre el mismo mint y la misma ATA del administrador.

`PanelTransfer` sí necesita que el usuario escriba la wallet destino, pero el mint puede fijarse:

```ts
// fnTransferTokens ya no necesita recibir mintAddress como parámetro
await fnTransferTokens(ctx, MINT_ADDRESS, destinationWallet, amount)
```

---

### Separar la pestaña "Crear Mint" del flujo de administración

La pestaña **Crear Mint** tiene sentido durante el setup inicial, pero no debería estar visible en el flujo de operación diario de un token ya desplegado. Considera eliminarla o moverla a una ruta separada una vez que el token está creado:

```tsx
// Opción simple: ocultar la pestaña con una variable de entorno
const TOKEN_YA_CREADO = import.meta.env.VITE_MINT_ADDRESS !== undefined

const TABS = [
  ...(!TOKEN_YA_CREADO ? [{ id: "create", label: "Crear Mint" }] : []),
  { id: "mint",     label: "Mintear"    },
  { id: "transfer", label: "Transferir" },
  // ...resto de tabs
] as const
```

---

### Variables de entorno en lugar de constantes hardcodeadas

En lugar de escribir las direcciones directamente en el código fuente, usa variables de entorno de Vite. Esto evita exponer direcciones en repositorios públicos y facilita tener configuraciones distintas para devnet y mainnet:

```bash
# .env.development
VITE_MINT_ADDRESS=52RBGd2ZZj5wLK6RfRUiWX72Vb3hYcHjEVn4VFG4XEn5
VITE_ADMIN_ATA=7Xh5gNTbGgQSW7pzLFDfiE3xSCqjr2CEUF7VVvrdU7qH
VITE_RPC_URL=https://api.devnet.solana.com

# .env.production
VITE_MINT_ADDRESS=<mint real en mainnet>
VITE_ADMIN_ATA=<ata real en mainnet>
VITE_RPC_URL=https://rpc.helius.xyz/?api-key=TU_API_KEY
```

```ts
// App.tsx
const MINT_ADDRESS = import.meta.env.VITE_MINT_ADDRESS ?? ""
const ADMIN_ATA    = import.meta.env.VITE_ADMIN_ATA    ?? ""
const RPC_URL      = import.meta.env.VITE_RPC_URL      ?? "https://api.devnet.solana.com"
```

Agrega `.env.production` a `.gitignore` para no exponer las claves en el repositorio.

---

### Validar que la wallet conectada sea la autoridad correcta

El código actual no verifica que quien conecta la wallet sea efectivamente el mint authority o el freeze authority. En producción conviene agregar esa comprobación antes de mostrar los paneles sensibles:

```tsx
function AppInner() {
  const { publicKey } = useWallet()

  const esAdmin = publicKey?.toBase58() === import.meta.env.VITE_ADMIN_WALLET

  return (
    <div style={css.page}>
      {/* ... header y tabs ... */}

      {!esAdmin && publicKey && (
        <div style={{ padding: "10px", backgroundColor: "#fff3e0", borderRadius: 4, marginBottom: 12 }}>
          ⚠️ Esta wallet no es el administrador del token. Las operaciones de mint, freeze y autoridad fallarán.
        </div>
      )}

      <div style={css.card}>
        <Panel />
      </div>
    </div>
  )
}
```

---

### El `decimals` de cada operación debe coincidir con el del mint

Todas las funciones usan `DECIMALS = 9` como default. Si creaste el token con un número de decimales distinto (por ejemplo 6, como USDC), las cantidades calculadas serán incorrectas:

```ts
// ❌ Incorrecto si tu token tiene 6 decimals
fnMintTokens(ctx, MINT_ADDRESS, ADMIN_ATA, 1000)
// → mintea 1_000_000_000_000_000n unidades base (1 billón de tokens reales)

// ✅ Correcto
const TOKEN_DECIMALS = 6
fnMintTokens(ctx, MINT_ADDRESS, ADMIN_ATA, 1000, TOKEN_DECIMALS)
// → mintea 1_000_000_000n unidades base (1000 tokens reales)
```

La forma más segura es leer los decimales directamente del mint al inicializar la app:

```ts
const mintInfo = await getMint(connection, toPub(MINT_ADDRESS), "confirmed", TOKEN_2022_PROGRAM_ID)
const TOKEN_DECIMALS = mintInfo.decimals  // fuente de verdad on-chain
```


## Referencias

- [SPL Token Basics — Solana Docs](https://solana.com/es/docs/tokens/basics)
- [Token Extensions Metadata — Solana Docs](https://solana.com/docs/tokens/extensions/metadata)
- [Wallet Adapter — repositorio oficial](https://github.com/solana-labs/wallet-adapter)
- [Solscan Devnet](https://solscan.io/?cluster=devnet)
- [Solana Explorer Devnet](https://explorer.solana.com/?cluster=devnet)

- [SPL Token Basics — Solana Docs](https://solana.com/es/docs/tokens/basics)
- [Token Extensions Metadata — Solana Docs](https://solana.com/docs/tokens/extensions/metadata)
- [Wallet Adapter — repositorio oficial](https://github.com/solana-labs/wallet-adapter)
- [Solscan Devnet](https://solscan.io/?cluster=devnet)
- [Solana Explorer Devnet](https://explorer.solana.com/?cluster=devnet)