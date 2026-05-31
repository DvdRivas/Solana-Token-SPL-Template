# SPL Token CLI — Token-2022 desde terminal

Guía de referencia para crear y administrar tokens SPL usando el programa **Token-2022** (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`) desde la línea de comandos.

> Todos los comandos de esta guía usan `--program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`. Si lo omites, el CLI usará el programa SPL clásico y las operaciones sobre cuentas Token-2022 fallarán o devolverán resultados vacíos.

---

## Instalación de Dependencias

```bash
# Dependencias
sudo apt-get update && \
sudo apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  git \
  build-essential \
  pkg-config \
  libssl-dev \
  sudo \
  tini

# Rust
curl --proto '=https' --tlsv1.2 https://sh.rustup.rs -sSf | sh -s -- -y

source "$HOME/.cargo/env"

# Solana
curl --proto '=https' --tlsv1.2 -sSfL https://solana-install.solana.workers.dev | bash

export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

# NVM 
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh | bash

export NVM_DIR="$HOME/.nvm"

[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# Node
nvm install node

nvm use node

# Configuracion de Solana
solana config set --url https://api.devnet.solana.com

# Crear una Wallet 
solana-keygen new --no-bip39-passphrase --outfile ~/.config/solana/id.json
```

El keypair en `~/.config/solana/id.json` es quien firma y paga todas las operaciones. Asegúrate de que tenga SOL:

```bash
solana balance
```

---

## Alias recomendado

Para no repetir `--program-id` en cada comando, define un alias en tu sesión:

```bash
alias spl2="spl-token --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
```

Desde ese punto puedes usar `spl2` en lugar de `spl-token --program-id TokenzQ...` en todos los comandos de esta guía.

---

## Flujo completo

```
1. create-token          → crea el Mint
2. initialize-metadata   → agrega nombre, símbolo y URI al Mint
3. create-account        → crea la ATA del operador
4. mint                  → acuña tokens en esa ATA
5. transfer              → envía tokens a otras wallets
```

Las operaciones de consulta (`balance`, `accounts`, `address`, `account-info`) no modifican estado y pueden usarse en cualquier momento.

---

## 1. Crear el Mint

Crea la cuenta del mint bajo Token-2022. Con `--enable-metadata` habilita la extensión de metadata embebida (equivalente a `MetadataPointer` + `TokenMetadata`).

```bash
spl-token create-token \
  --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb \
  --enable-metadata
```

Salida esperada:
```
Creating token 52RBGd2ZZj5wLK6RfRUiWX72Vb3hYcHjEVn4VFG4XEn5 under program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
To initialize metadata inside the mint, please run
  `spl-token initialize-metadata 52RBGd2ZZj5wLK6RfRUiWX72Vb3hYcHjEVn4VFG4XEn5 <NAME> <SYMBOL> <URI>`
Address:   52RBGd2ZZj5wLK6RfRUiWX72Vb3hYcHjEVn4VFG4XEn5
Decimals:  9
Signature: 2vTRthtVEVNma5CmXih3DcL...
```

**Guarda el `Address` — es el Mint Address. Lo usarás en todos los comandos siguientes.**

Opciones útiles:

```bash
# Especificar decimals (default: 9)
spl-token create-token --program-id TokenzQ... --enable-metadata --decimals 6

# Sin freeze authority (no se podrán congelar cuentas nunca)
spl-token create-token --program-id TokenzQ... --enable-metadata --disable-freeze-authority
```

---

## 2. Inicializar metadata

Escribe el nombre, símbolo y URI directamente en la cuenta del mint. Debe ejecutarse **inmediatamente después** de `create-token` y antes de cualquier otra operación.

```bash
spl-token initialize-metadata \
  <MINT_ADDRESS> \
  "<NOMBRE>" \
  "<SÍMBOLO>" \
  "<URI>"
```

Ejemplo con los datos de este proyecto:
```bash
spl-token initialize-metadata \
  52RBGd2ZZj5wLK6RfRUiWX72Vb3hYcHjEVn4VFG4XEn5 \
  "TestingToken" \
  "TTK" \
  "https://arweave.net/tu-metadata.json"
```

Salida esperada:
```
Signature: 37M2o3guVqdzc2zzAcdZhdg6p7jtw5A41XCuSatxi5kHh...
```

**Sobre la URI:** debe apuntar a un JSON accesible públicamente con el siguiente formato (estándar Metaplex):

```json
{
  "name": "TestingToken",
  "symbol": "TTK",
  "image": "https://tu-imagen.png",
  "description": "Descripción del token"
}
```

En producción sube ese JSON a Arweave o IPFS y usa la URL permanente. Una URL de GitHub puede cambiar o desaparecer.

---

## 3. Crear Token Account (ATA)

Crea la Associated Token Account para la wallet activa (la que está en `~/.config/solana/id.json`). Es la cuenta que guardará los tokens.

```bash
spl-token create-account \
  <MINT_ADDRESS> \
  --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
```

Ejemplo:
```bash
spl-token create-account \
  52RBGd2ZZj5wLK6RfRUiWX72Vb3hYcHjEVn4VFG4XEn5 \
  --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
```

Salida esperada:
```
Creating account 7Xh5gNTbGgQSW7pzLFDfiE3xSCqjr2CEUF7VVvrdU7qH
Signature: 34iUzryV6UDftGjjtuDcPXAa99Ub362u...
```

**Guarda también esta ATA (`7Xh5...`). Es la cuenta que recibirá los tokens minteados.**

Para crear la ATA de otra wallet (no la activa):
```bash
spl-token create-account \
  <MINT_ADDRESS> \
  --owner <WALLET_DESTINO> \
  --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
```

---

## 4. Mintear tokens

Acuña nuevos tokens hacia una ATA existente. Solo puede ejecutarlo el **mint authority** (por defecto, la wallet activa).

```bash
spl-token mint \
  <MINT_ADDRESS> \
  <CANTIDAD_EN_UNIDADES_BASE> \
  <ATA_DESTINO> \
  --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
```

### ⚠️ Cantidad en unidades base

La cantidad se expresa en **unidades base**, no en tokens legibles. Con `decimals = 9`:

| Quieres mintear | Valor a pasar |
|---|---|
| 1 token | `1000000000` |
| 100 tokens | `100000000000` |
| 1000 tokens | `1000000000000` |

Fórmula: `cantidad_legible × 10^decimals`

**Error frecuente del proyecto:** se pasó `200000000000` esperando 200 tokens, pero con `decimals = 9` eso son **200,000 tokens**. El CLI mostró `Minting 18446744073.709553` porque el valor desbordó el límite máximo de `u64`. Siempre verifica la cantidad antes de ejecutar.

Ejemplo correcto para mintear 1000 tokens (con 9 decimales):
```bash
spl-token mint \
  52RBGd2ZZj5wLK6RfRUiWX72Vb3hYcHjEVn4VFG4XEn5 \
  1000000000000 \
  7Xh5gNTbGgQSW7pzLFDfiE3xSCqjr2CEUF7VVvrdU7qH \
  --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
```

Salida esperada:
```
Minting 1000 tokens
  Token: 52RBGd2ZZj5wLK6RfRUiWX72Vb3hYcHjEVn4VFG4XEn5
  Recipient: 7Xh5gNTbGgQSW7pzLFDfiE3xSCqjr2CEUF7VVvrdU7qH
Signature: 4x1C9DbRmitqrh4PEGoJZ...
```

---

## 5. Transferir tokens

Envía tokens a otra wallet. Usa la **wallet destino** (no su ATA). Con `--fund-recipient` el CLI crea automáticamente la ATA del destinatario si no existe, pagada por el emisor.

```bash
spl-token transfer \
  <MINT_ADDRESS> \
  <CANTIDAD_LEGIBLE> \
  <WALLET_DESTINO> \
  --fund-recipient \
  --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
```

Ejemplo:
```bash
spl-token transfer \
  52RBGd2ZZj5wLK6RfRUiWX72Vb3hYcHjEVn4VFG4XEn5 \
  200 \
  85DeTbK7vtGtFKvuGsunEBBjRroABdXYDrKFg9kt28aa \
  --fund-recipient \
  --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
```

Salida esperada:
```
Transfer 200 tokens
  Sender: 7Xh5gNTbGgQSW7pzLFDfiE3xSCqjr2CEUF7VVvrdU7qH
  Recipient: 85DeTbK7vtGtFKvuGsunEBBjRroABdXYDrKFg9kt28aa
  Recipient associated token account: <ATA creada>
Signature: 2XE6sGcoC2b5F9gYCcj5o9Qmt...
```

A diferencia del `mint`, aquí la cantidad es **legible** (200 tokens reales, no unidades base).

---

## Consultas

### Ver balance de una ATA específica

```bash
spl-token balance \
  --address <ATA_ADDRESS> \
  --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
```

Ejemplo:
```bash
spl-token balance \
  --address 2xH27TgKWidPyxXTgFjeg8JQStbrPC5iDryYxDZFD6dY \
  --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
# 400
```

> Pasa la **ATA**, no la wallet. Si pasas la wallet obtendrás un error o resultado vacío.

---

### Ver todas las ATAs de una wallet

```bash
spl-token accounts \
  --owner <WALLET_ADDRESS> \
  --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
```

Ejemplo:
```bash
spl-token accounts \
  --owner 9QRCnvghiw2V72vKoPKG9QA4JcdXrGHTRtj8f8tvk4VM \
  --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
```

Salida esperada:
```
Token                                         Balance
---------------------------------------------------------------
52RBGd2ZZj5wLK6RfRUiWX72Vb3hYcHjEVn4VFG4XEn5  400
```

**Nota conocida:** si ves `Unsupported account program: spl-token-2022` en la columna de balance, significa que el CLI está mostrando la ATA pero no puede interpretarla sin el `--program-id` correcto. Usa `spl-token balance --address <ATA>` para ese caso.

---

### Calcular la dirección ATA de una wallet

```bash
spl-token address \
  --verbose \
  --token <MINT_ADDRESS> \
  --owner <WALLET_ADDRESS> \
  --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
```

Ejemplo:
```bash
spl-token address \
  --verbose \
  --token 52RBGd2ZZj5wLK6RfRUiWX72Vb3hYcHjEVn4VFG4XEn5 \
  --owner 9QRCnvghiw2V72vKoPKG9QA4JcdXrGHTRtj8f8tvk4VM \
  --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
```

> `--verbose` es obligatorio en versiones recientes del CLI. Sin él obtendrás el error `error: The following required arguments were not provided: --verbose`.

---

### Ver información de una ATA

```bash
spl-token account-info \
  <ATA_ADDRESS> \
  --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
```

Muestra: mint asociado, owner, balance, delegado, estado (frozen o no) y close authority.

---

### Ver información del Mint

```bash
solana account <MINT_ADDRESS>
```

Confirma que la cuenta existe, su owner es `TokenzQ...` y su balance de SOL (rent). Para ver los datos del mint parseados:

```bash
spl-token display <MINT_ADDRESS> \
  --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
```

---

## Operaciones adicionales

### Quemar tokens

```bash
spl-token burn \
  <ATA_ADDRESS> \
  <CANTIDAD_LEGIBLE> \
  --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
```

### Aprobar delegado

```bash
spl-token approve \
  <ATA_ADDRESS> \
  <CANTIDAD> \
  <DELEGATE_ADDRESS> \
  --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
```

### Revocar delegado

```bash
spl-token revoke \
  <ATA_ADDRESS> \
  --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
```

### Congelar una cuenta

```bash
spl-token freeze \
  <ATA_ADDRESS> \
  --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
```

### Descongelar una cuenta

```bash
spl-token thaw \
  <ATA_ADDRESS> \
  --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
```

### Cambiar o revocar una autoridad

```bash
# Cambiar mint authority
spl-token authorize \
  <MINT_ADDRESS> \
  mint \
  <NUEVA_WALLET> \
  --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb

# Revocar mint authority (irreversible — supply queda fijo)
spl-token authorize \
  <MINT_ADDRESS> \
  mint \
  --disable \
  --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
```

Tipos de autoridad disponibles en `authorize`: `mint`, `freeze`, `owner`, `close`.

### Cerrar una Token Account

La cuenta debe tener balance 0. El SOL del rent se devuelve a la wallet activa.

```bash
spl-token close \
  --address <ATA_ADDRESS> \
  --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
```

---

## Errores frecuentes

### `Process error: Invalid mint account <ADDRESS>`

El CLI no puede validar el mint porque está intentando leerlo con el programa SPL clásico. Asegúrate de pasar `--program-id TokenzQ...` en el comando.

### `spl-token accounts` devuelve `None` con `--owner`

Sin `--program-id`, el CLI filtra solo cuentas del programa clásico. Agrega el flag:
```bash
spl-token accounts --owner <WALLET> --program-id TokenzQ...
```

### `Unsupported account program: spl-token-2022` en el listado

El CLI reconoce que existe la ATA pero no la puede leer en ese contexto. Usa `spl-token balance --address <ATA>` directamente para obtener el balance.

### `error: The following required arguments were not provided: --verbose`

El subcomando `address` requiere `--verbose` explícitamente:
```bash
spl-token address --verbose --token <MINT> --owner <WALLET> --program-id TokenzQ...
```

### El mint muestra cantidades absurdas al mintear

Ejemplo: pasaste `200000000000` esperando 200 tokens, pero el CLI minteó `18446744073.709553`. Eso es un desbordamiento de `u64`. La cantidad que pasas a `spl-token mint` siempre son **unidades base**:

```
tokens_legibles × 10^decimals = unidades_base

200 tokens × 10^9 = 200_000_000_000  ← correcto
```

`200000000000` son 200,000 tokens (con 9 decimales), no 200. Verifica siempre antes de ejecutar.

### `Could not find token account <ADDRESS>`

Estás pasando la wallet como parámetro donde se espera una ATA. Usa `spl-token address --verbose` para calcular la ATA correcta primero.

---

## Referencia rápida

| Operación | Recibe | Notas |
|---|---|---|
| `create-token` | — | Guarda el Mint Address |
| `initialize-metadata` | Mint, nombre, símbolo, URI | Ejecutar justo después de create-token |
| `create-account` | Mint | Crea ATA de la wallet activa |
| `mint` | Mint, cantidad en unidades base, ATA | Cantidad ≠ tokens legibles |
| `transfer` | Mint, cantidad legible, wallet destino | Usa `--fund-recipient` siempre |
| `balance` | ATA (no wallet) | Con `--address` |
| `accounts` | Wallet | Con `--owner` y `--program-id` |
| `address` | Mint + wallet | Requiere `--verbose` |
| `account-info` | ATA | Con `--program-id` |
| `burn` | ATA, cantidad legible | |
| `approve` | ATA, cantidad, delegate | |
| `revoke` | ATA | |
| `freeze` / `thaw` | ATA | Requiere freeze authority |
| `authorize` | Mint o ATA, tipo | `--disable` para revocar |
| `close` | ATA con balance 0 | Recupera SOL del rent |

---

## Referencias

- [SPL Token Basics — Solana Docs](https://solana.com/es/docs/tokens/basics)
- [Token Extensions Metadata — Solana Docs](https://solana.com/docs/tokens/extensions/metadata)
- [spl-token CLI reference — spl.solana.com](https://spl.solana.com/token)
- [Solscan Devnet](https://solscan.io/?cluster=devnet)
- [Solana Explorer Devnet](https://explorer.solana.com/?cluster=devnet)