# Little John

Little John is a local Robinhood Chain MCP application and interactive CLI. It
reads assets and contracts, constructs USDG / Stock Token exchange decisions,
requests the directly confirmed transaction in Robinhood Wallet, and records
received hashes and actual transaction results locally.

The current support projection is in [Product Policy](https://github.com/stelis-dev/littlejohn-mcp/blob/main/docs/PRODUCT_POLICY.md#current-support).
Exchange actions are implemented. Robinhood Wallet transaction and replacement
behavior is not qualified. The package makes no executable or receipt-verified
support claim.
Data signing supports personal messages and EIP-712 typed data through direct
App controls and interactive CLI. Its Robinhood Wallet and per-Host physical
qualification is incomplete.

## Install from source

Use Node.js satisfying the package's `engines` field. From a repository checkout:

```sh
npm ci
LITTLEJOHN_RELEASE_OUTPUT=/absolute/path/littlejohn-mcp.tgz npm run release:check
npm install --global /absolute/path/littlejohn-mcp.tgz
littlejohn --help
```

The release check creates the tarball only after its automated package checks
pass. It does not publish to npm or qualify a physical Wallet. SQLite is an npm
dependency; a separate SQLite server or command-line installation is unnecessary.
Its native addon installation remains part of the npm install. An installation
error must be resolved before starting the program.

## Connect an MCP Host

Configure a local stdio server named `littlejohn` in the Host's MCP settings:

```json
{
  "mcpServers": {
    "littlejohn": {
      "command": "littlejohn",
      "args": []
    }
  }
}
```

Use the installed executable's absolute path if the Host does not inherit the
shell's executable search path. No website, public server, browser login, or
navigable loopback page is needed. The no-argument process serves MCP; CLI
commands use the same local backend and Wallet session.

For an optional RPC endpoint, add `LITTLEJOHN_RPC_URL` to that server's environment.
Omitting it uses Runtime's public default. Do not set an empty string. A supplied
URL must pass the current HTTPS configuration admission; failure does not switch
to another provider. Keep URLs containing credentials in the Host's secure
configuration rather than command arguments. The standard setup field is in
[server.json](https://github.com/stelis-dev/littlejohn-mcp/blob/main/server.json).

`LITTLEJOHN_DATA_DIR` selects a different local profile directory.
`LITTLEJOHN_WALLETCONNECT_PROJECT_ID` overrides the Wallet adapter's project ID.
All processes sharing a profile must use the same configuration. The backend
uses its fixed loopback port; a foreign owner is an error, not a reason to select
another port. Complete configuration behavior belongs to
[Architecture](https://github.com/stelis-dev/littlejohn-mcp/blob/main/docs/ARCHITECTURE.md#local-process-model).

## Use the application

In an App-capable Host, ask for the desired asset read or transaction decision
in ordinary language. Select the Stock Token, pool, sent or received quantity,
exact/maximum/minimum conditions, fee caps and execution deadline. Token units
are distinct from underlying shares. Little John does not choose missing
transaction-critical conditions silently.

Use the App's direct control to request the displayed transaction in the Wallet.
The Wallet separately asks for approval. A model-visible tool cannot authorize
that request. A Host without direct App controls remains unable to authorize a
transaction; the CLI is an independent interface.

The CLI exposes its complete current syntax through `littlejohn --help`:

- `littlejohn wallet connect` presents the connection decision and pairing QR.
- `littlejohn uniswap-v4 list-pools <stock-token-address>` lists the packaged
  candidates that remain in the current official asset snapshot. This is not a
  liquidity or best-route claim.
- `littlejohn exchange start ...` constructs a new decision and asks for one
  interactive `y` before requesting it in the Wallet. Both input and output must
  be a TTY; flags, redirected input and JSON output cannot confirm a transaction.
- `littlejohn exchange replace-fees ...` constructs a new decision from the
  independently read pending request. `exchange start --replaces <hash> ...`
  selects a new supported transaction at that observed nonce. Neither replays a
  saved request or guarantees acceptance or inclusion.
- `littlejohn activity get <hash> --address <address>` and `activity list
  --address <address>` read local records only. `activity inspect <hash>
  --address <address>` explicitly rechecks the chain within a finite wait.

Each required token or router allowance is a separate decision and Wallet
request. Finishing an approval does not automatically send the next transaction.

Terminal QR presentation and its current profile limitation are documented in
[Architecture](https://github.com/stelis-dev/littlejohn-mcp/blob/main/docs/ARCHITECTURE.md#current-state).
`littlejohn wallet connect` uses the QR renderer from the installed package.

## Sign data

Ask an App-capable Host to create a signing decision for the exact message or
typed data. Inspect the complete data and domain, then use the direct control
and approve separately in the Wallet. A verified signature appears only in that
App result panel, with explicit copy and dismissal controls. The Host can observe
this private result. Closing the panel does not revoke the signature or erase
copies outside Little John.

For CLI, put the payload in a user-owned JSON file. For example, this synthetic
message grants no application action:

```json
{"kind":"personal","encoding":"utf8","value":"Little John signing check. This message grants no action."}
```

Run `littlejohn signing start --active --file message.json` and read the complete
decision before answering `y`. The output must also be an interactive terminal.
An `address` selector and the exact read/discard syntax are described by
`littlejohn --help`. A hex message explicitly uses `"encoding":"hex"`; a text
value starting with `0x` remains text. Typed input uses `"kind":"typed_data"`
with `types`, `primaryType`, `domain` and `message`; integer values are exact
decimal strings. It declares `EIP712Domain` explicitly and uses a distinct
message type. A supplied domain chain must be Robinhood Chain.

An existing send-only session needs explicit disconnect/connect approval for
the additional signing methods. Missing permission never triggers automatic
reconnection. This feature does not submit signatures to services, broadcast
transactions or create ledger entries. Its verification profile is a 65-byte
secp256k1 signature; contract-account signature validation is unavailable.
Late responses are discarded and unknown delivery never triggers another request.
No signature cache, durable signature record or later signature-retrieval command
exists. CLI scrollback and user-owned input files or copies are outside product
disposal control. Exact signing authority and result meaning remain in
[Transaction Policy](https://github.com/stelis-dev/littlejohn-mcp/blob/main/docs/TRANSACTION_POLICY.md#data-signing).

## Results and local state

A returned hash is not execution success. Records distinguish included success,
revert, observed pending, not found and unavailable reads. Actual request and
effect comparisons remain separate from execution status. Missing evidence never
becomes a matching result. A revert still consumes gas.

Stopping a wait cannot cancel a delivered Wallet request. A hash observed later
during the original bounded SDK lifetime is recorded without a new network
lookup. An explicit query or a later transaction command can reconcile known
hashes. No timer, restart or completed approval resends a financial request.

Transaction decisions, unsigned requests and grants are temporary memory.
The execution ledger begins only with a received hash and its pre-send comparison
reference. It stores actual results, not a reusable transaction or full Review.
An expired or consumed transaction View cannot be reopened. Unrelated read
snapshots and durable Wallet-management operations retain their own lifetimes.

Default profile locations follow the operating system's application-state
directory. Owner-only files include the product database, separate WalletConnect
restoration store and local control credential. Do not treat an incompatible
profile as an automatic migration or erase it merely to bypass a startup error.

Exact authority and result meanings are defined by
[Transaction Policy](https://github.com/stelis-dev/littlejohn-mcp/blob/main/docs/TRANSACTION_POLICY.md). Third-party notices and licenses
are included in the distributed package.
